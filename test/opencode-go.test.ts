import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthContext,
  type AuthEvent,
  type ClassifierContext,
  type ClassifierModel,
  type Credential,
  createModels,
  InMemoryCredentialStore,
  PI_ATTRIBUTION,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
  createOpenCodeGoProvider,
  OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
} from "../src/providers/opencode-go.ts";

const provider = createOpenCodeGoProvider({
  readGoCredential: () => undefined,
});
const models = provider.getAllModels?.() ?? [];
const model = models[0] as ClassifierModel<"typesafe-system-one">;

const questions: ClassifierContext["questions"] = {
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

const context: ClassifierContext = { state: { text: "hello" }, questions };

const wireAnswers = {
  choice: {
    type: "choice",
    choice: "yes",
    probabilities: { yes: 0.8, no: 0.2 },
    confidence: 0.9,
  },
  score: { type: "score", score: 0.6, confidence: 0.7 },
  bool: { type: "noul", noul: 0.85 },
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-123" },
  });
}

function makeAuthContext(
  envMap: Record<string, string | undefined>,
): AuthContext {
  return {
    env: async (name) => envMap[name],
    fileExists: async () => false,
  };
}

function makeInteraction(
  promptResult: string | (() => Promise<string>),
  signal = new AbortController().signal,
): { interaction: ProviderAuthInteraction; events: AuthEvent[] } {
  const events: AuthEvent[] = [];
  const interaction: ProviderAuthInteraction = {
    signal,
    notify(event) {
      events.push(event);
    },
    async prompt() {
      return typeof promptResult === "function"
        ? await promptResult()
        : promptResult;
    },
  };
  return { interaction, events };
}

test("registers only three text-only typesafe-system-one classifiers", () => {
  assert.equal(provider.id, OPENCODE_GO_CLASSIFIERS_PROVIDER_ID);
  assert.equal(provider.name, "OpenCode Go Classifiers");
  assert.equal(provider.getModels().length, 0);
  assert.deepEqual(
    models.map((item) => [
      item.id,
      item.type,
      item.api,
      item.type === "classifier" ? item.contextWindow : undefined,
    ]),
    [
      ["jev-1.14", "classifier", "typesafe-system-one", 32000],
      ["gemini-decision-1", "classifier", "typesafe-system-one", 262144],
      ["gpt-6-luna-decision", "classifier", "typesafe-system-one", 1050000],
    ],
  );
  assert.ok(
    models.every(
      (item) =>
        item.baseUrl === "https://opencode.ai/inference/go/v1" &&
        item.input.join() === "text",
    ),
  );
});

test("auth prefers override key, then opencode-go credential, then OPENCODE_API_KEY without caching", async () => {
  let storedGo: Credential | undefined = {
    type: "api_key",
    key: "go-one",
  };
  let calls = 0;
  const auth = createOpenCodeGoProvider({
    readGoCredential: () => {
      calls++;
      return storedGo;
    },
  }).auth.apiKey;
  assert.ok(auth);

  const envMap: Record<string, string | undefined> = {
    OPENCODE_API_KEY: "from-env",
  };
  const ctx = makeAuthContext(envMap);
  const signal = AbortSignal.timeout(1000);

  // 1. Separate override credential wins over both opencode-go and env.
  assert.deepEqual(
    await auth.resolve({
      credential: { type: "api_key", key: "  separate  " },
      ctx,
      signal,
    }),
    {
      auth: { apiKey: "separate" },
      source: "opencode-go-classifiers credential",
    },
  );
  assert.equal(calls, 0);

  // 2. Stored opencode-go credential wins over OPENCODE_API_KEY.
  assert.deepEqual(await auth.resolve({ ctx, signal }), {
    auth: { apiKey: "go-one" },
    source: "stored by opencode-go",
  });
  assert.deepEqual(await auth.check?.({ ctx, signal }), {
    type: "api_key",
    source: "stored by opencode-go",
  });

  // Updates are observed live (no cache).
  storedGo = { type: "api_key", key: "go-two" };
  assert.equal((await auth.resolve({ ctx, signal }))?.auth.apiKey, "go-two");

  // 3. Falls back to OPENCODE_API_KEY when opencode-go has no stored key.
  storedGo = undefined;
  assert.deepEqual(await auth.resolve({ ctx, signal }), {
    auth: { apiKey: "from-env" },
    source: "OPENCODE_API_KEY",
  });
  assert.deepEqual(await auth.check?.({ ctx, signal }), {
    type: "api_key",
    source: "OPENCODE_API_KEY",
  });

  // 4. Returns undefined when nothing is configured.
  envMap.OPENCODE_API_KEY = undefined;
  assert.equal(await auth.resolve({ ctx, signal }), undefined);
  assert.equal(await auth.check?.({ ctx, signal }), undefined);
  assert.equal(calls, 7);
});

test("unbound check detects !command without executing it and unbound resolve does not send literal !command", async () => {
  const auth = createOpenCodeGoProvider({
    readGoCredential: () => ({ type: "api_key", key: "!op read secret" }),
  }).auth.apiKey;
  assert.ok(auth);

  const ctx = makeAuthContext({});
  const signal = AbortSignal.timeout(1000);

  assert.deepEqual(await auth.check?.({ ctx, signal }), {
    type: "api_key",
    source: "stored by opencode-go",
  });
  assert.equal(await auth.resolve({ ctx, signal }), undefined);
});

test("bound ModelRegistry inherits apiKey and env from opencode-go without inheriting chat baseUrl or headers", async () => {
  const auth = createOpenCodeGoProvider({
    getModelRegistry: () => ({
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderAuth: async () => ({
        auth: {
          apiKey: "registry-go-key",
          baseUrl: "https://chat-proxy.example.com/openai/v1",
          headers: { "x-chat-only": "1" },
        },
        env: { OPENCODE_REGION: "eu" },
        source: "stored credential",
      }),
    }),
    readGoCredential: () => {
      throw new Error("should not read disk when registry is bound");
    },
  }).auth.apiKey;
  assert.ok(auth);

  const ctx = makeAuthContext({ OPENCODE_API_KEY: "stale-env-key" });
  const signal = AbortSignal.timeout(1000);

  assert.deepEqual(await auth.check?.({ ctx, signal }), {
    type: "api_key",
    source: "stored by opencode-go",
  });
  assert.deepEqual(await auth.resolve({ ctx, signal }), {
    auth: { apiKey: "registry-go-key" },
    env: { OPENCODE_REGION: "eu" },
    source: "stored by opencode-go",
  });
});

test("login shows guidance notice, trims input, rejects blank keys, and honors abort signal", async () => {
  const auth = provider.auth.apiKey;
  assert.ok(auth?.login);

  const ok = makeInteraction("  sk-explicit  ");
  assert.deepEqual(await auth.login(ok.interaction), {
    type: "api_key",
    key: "sk-explicit",
  });
  assert.equal(ok.events.length, 1);
  assert.equal(ok.events[0]?.type, "info");
  assert.match(ok.events[0]?.message ?? "", /\/login opencode-go/);

  const blank = makeInteraction("   ");
  await assert.rejects(
    () => auth.login?.(blank.interaction) ?? Promise.resolve(),
    /must not be empty/,
  );

  const aborted = new AbortController();
  aborted.abort(new Error("cancelled"));
  const cancelled = makeInteraction("sk-unused", aborted.signal);
  await assert.rejects(
    () => auth.login?.(cancelled.interaction) ?? Promise.resolve(),
    /cancelled/,
  );
});

test("classify delegates to typesafe-system-one with identity headers, hooks, responseId, usage, and error handling", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(OPENCODE_GO_CLASSIFIERS_PROVIDER_ID, async () => ({
    type: "api_key",
    key: "test-secret",
  }));
  const runtimeModels = createModels({
    credentials,
    identity: { attribution: PI_ATTRIBUTION },
  });
  runtimeModels.setProvider(provider);

  const hooks: string[] = [];
  const result = await runtimeModels.classify(model, context, {
    fetch: async (url, init) => {
      assert.equal(
        String(url),
        "https://opencode.ai/inference/go/v1/systemone",
      );
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-secret");
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("x-opencode-client"), "pi");
      assert.equal(headers.get("x-pi-test"), "yes");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: model.id,
        state: context.state,
        questions: {
          ...questions,
          bool: { ...questions.bool, type: "noul" },
        },
        trace: true,
      });
      return jsonResponse({
        id: "gen-42",
        answers: wireAnswers,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 4 },
        },
      });
    },
    headers: { "X-Pi-Test": "yes" },
    onPayload: (payload) => {
      hooks.push("payload");
      return { ...(payload as Record<string, unknown>), trace: true };
    },
    onResponse: (res) => {
      hooks.push(`response:${res.status}`);
    },
  });

  assert.deepEqual(hooks, ["payload", "response:200"]);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.responseId, "gen-42");
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
    input: 6,
    output: 3,
    cacheRead: 4,
    cacheWrite: 0,
    totalTokens: 13,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      totalFromProvider: false,
    },
  });

  // HTTP error preserves actionable status and message without throwing.
  const httpError = await runtimeModels.classify(model, context, {
    maxRetries: 0,
    fetch: async () => jsonResponse({ error: "quota exceeded" }, 403),
  });
  assert.equal(httpError.stopReason, "error");
  assert.match(httpError.errorMessage ?? "", /403/);
  assert.match(httpError.errorMessage ?? "", /quota exceeded/);

  // Image input is rejected for text-only classifiers.
  const imageError = await runtimeModels.classify(model, {
    ...context,
    images: [{ type: "image", data: "", mimeType: "image/png" }],
  });
  assert.equal(imageError.stopReason, "error");
  assert.match(imageError.errorMessage ?? "", /image/i);

  // Aborted requests report stopReason: "aborted".
  const controller = new AbortController();
  controller.abort();
  const aborted = await runtimeModels.classify(model, context, {
    signal: controller.signal,
    fetch: async () => {
      throw controller.signal.reason;
    },
  });
  assert.equal(aborted.stopReason, "aborted");
});
