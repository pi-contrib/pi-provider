import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenCodeGoProvider } from "./providers/opencode-go.ts";

const provider = createOpenCodeGoProvider(() => undefined);
const models = provider.getAllModels();
const model = models[0];
const questions = {
  choice: {
    type: "choice",
    instructions: "Pick",
    criteria: { yes: "yes", no: "no" },
  },
  score: { type: "score", instructions: "Rate", criteria: ["low", "high"] },
  bool: {
    type: "bool",
    instructions: "Agree?",
    criteria: { true: "yes", false: "no" },
  },
};
const context = { state: { text: "hello" }, questions };
const answers = {
  choice: {
    type: "choice",
    choice: "yes",
    probabilities: { yes: 0.8, no: 0.2 },
    confidence: 0.9,
  },
  score: { type: "score", score: 0.6, confidence: 0.7 },
  bool: { type: "noul", noul: 0.85 },
};
function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "x-request-id": "123" },
  });
}
function request(
  fetch = async () =>
    response({ answers, usage: { input_tokens: 7, output_tokens: 3 } }),
  extras = {},
) {
  return provider.classify(model, context, {
    apiKey: "test-secret",
    fetch,
    ...extras,
  });
}

test("registers only three text-only classifiers under a separate provider", () => {
  assert.equal(provider.id, "opencode-go-classifiers");
  assert.equal(provider.getModels().length, 0);
  assert.deepEqual(
    models.map((item) => [item.id, item.type, item.contextWindow]),
    [
      ["jev-1.14", "classifier", 32000],
      ["gemini-decision-1", "classifier", 262144],
      ["gpt-6-luna-decision", "classifier", 1050000],
    ],
  );
  assert.ok(
    models.every(
      (item) => item.api === "system-one-go" && item.input.join() === "text",
    ),
  );
});

test("authentication prefers stored key, then environment, then inherited Go key, with no cache", async () => {
  let inherited = "go-one";
  let calls = 0;
  const auth = createOpenCodeGoProvider(() => {
    calls++;
    return inherited;
  }).auth.apiKey;
  let environment;
  const ctx = { env: async () => environment };
  const resolve = (credential) =>
    auth.resolve({ credential, ctx, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(await resolve({ type: "api_key", key: "separate" }), {
    auth: { apiKey: "separate" },
    source: "opencode-go-classifiers credential",
  });
  assert.equal(calls, 0);
  environment = "from-env";
  assert.equal((await resolve())?.auth.apiKey, "from-env");
  assert.equal(calls, 0);
  environment = undefined;
  assert.equal((await resolve())?.auth.apiKey, "go-one");
  inherited = "go-two";
  assert.equal((await resolve())?.auth.apiKey, "go-two");
  inherited = undefined;
  assert.equal(await resolve(), undefined);
  assert.equal(calls, 3);
  const login = await auth.login({ prompt: async () => "explicit" });
  assert.deepEqual(login, { type: "api_key", key: "explicit" });
});

test("sends System One payload, forwards hooks and signal, and maps all answer types and usage", async () => {
  const signal = new AbortController().signal;
  const hooks = [];
  const result = await request(
    async (url, init) => {
      assert.equal(url, "https://opencode.ai/inference/go/v1/systemone");
      assert.equal(init.method, "POST");
      assert.equal(init.signal, signal);
      assert.equal(init.headers.get("authorization"), "Bearer test-secret");
      assert.equal(init.headers.get("content-type"), "application/json");
      assert.equal(init.headers.get("x-pi-test"), "yes");
      assert.deepEqual(JSON.parse(init.body), {
        model: model.id,
        state: context.state,
        questions: { ...questions, bool: { ...questions.bool, type: "noul" } },
        trace: true,
      });
      return response({
        answers,
        usage: { input_tokens: 7, output_tokens: 3 },
      });
    },
    {
      signal,
      onPayload: (payload) => {
        hooks.push("payload");
        return { ...payload, trace: true };
      },
      onResponse: (res) => {
        hooks.push(`response:${res.status}`);
      },
      headers: { Authorization: "Bearer wrong-key", "X-Pi-Test": "yes" },
    },
  );
  assert.deepEqual(hooks, ["payload", "response:200"]);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers, {
    choice: {
      type: "choice",
      choice: "yes",
      probabilities: { yes: 0.8, no: 0.2 },
      confidence: 0.9,
    },
    score: { type: "score", score: 0.6, confidence: 0.7 },
    bool: { type: "bool", probability: 0.85 },
  });
  assert.deepEqual(result.usage, {
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("accepts the alternate boolean field and defaults optional confidence and probabilities", async () => {
  const result = await request(async () =>
    response({
      answers: {
        choice: { choice: "no" },
        score: { score: 0 },
        bool: { probability: 0 },
      },
    }),
  );
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers, {
    choice: { type: "choice", choice: "no", probabilities: {}, confidence: 0 },
    score: { type: "score", score: 0, confidence: 0 },
    bool: { type: "bool", probability: 0 },
  });
  assert.equal(result.usage, undefined);
});

test("rejects incomplete and malformed answers without partial success", async () => {
  for (const bad of [
    { ...answers, bool: undefined },
    { ...answers, score: { score: "bad" } },
    { ...answers, choice: { choice: "yes", probabilities: { yes: "bad" } } },
    { ...answers, bool: { probability: "bad" } },
  ]) {
    const result = await request(async () => response({ answers: bad }));
    assert.equal(result.stopReason, "error");
    assert.deepEqual(result.answers, {});
    assert.match(result.errorMessage, /^System One returned /);
  }
});

test("reports HTTP errors, network errors, cancellation, and missing auth safely", async () => {
  const http = await request(async () =>
    response({ secret: "never echo me" }, 403),
  );
  assert.equal(http.stopReason, "error");
  assert.equal(http.errorMessage, "System One returned HTTP 403");
  const network = await request(async () => {
    throw new Error("System One returned test-secret and private body");
  });
  assert.equal(network.stopReason, "error");
  assert.equal(network.errorMessage, "OpenCode Go classification failed");
  const controller = new AbortController();
  controller.abort();
  const aborted = await request(
    async () => {
      throw controller.signal.reason;
    },
    { signal: controller.signal },
  );
  assert.equal(aborted.stopReason, "aborted");
  assert.equal(aborted.errorMessage, "OpenCode Go classification aborted");
  const noKey = await provider.classify(model, context);
  assert.equal(noKey.stopReason, "error");
  assert.match(noKey.errorMessage, /No OpenCode Go key/);
  const images = await provider.classify(
    model,
    {
      ...context,
      images: [{ type: "image", data: "", mimeType: "image/png" }],
    },
    { apiKey: "test" },
  );
  assert.equal(images.stopReason, "error");
  assert.match(images.errorMessage, /do not support images/);
});
