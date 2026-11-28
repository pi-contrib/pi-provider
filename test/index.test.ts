import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { OPENCODE_GO_CLASSIFIERS_PROVIDER_ID } from "../src/providers/opencode-go.ts";

type LifecycleHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<void> | void;

async function setupSession(
  initialCredentials: Record<string, { type: "api_key"; key: string }> = {},
) {
  const credentials = new InMemoryCredentialStore();
  for (const [providerId, credential] of Object.entries(initialCredentials)) {
    await credentials.modify(providerId, async () => credential);
  }
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const registry = new ModelRegistry(runtime);

  const handlers = new Map<string, LifecycleHandler[]>();
  const registered: Provider[] = [];

  const pi = {
    registerProvider(provider: Provider) {
      registered.push(provider);
      registry.registerProvider(provider);
    },
    on(event: string, handler: LifecycleHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  } as unknown as ExtensionAPI;

  extension(pi);

  const ctx = { modelRegistry: registry } as ExtensionContext;
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler({ type: event }, ctx);
    }
  };

  return { runtime, registry, registered, emit };
}

test("extension registers opencode-go-classifiers without altering opencode-go chat models", async () => {
  const { runtime, registry, emit } = await setupSession({
    "opencode-go": { type: "api_key", key: "stored-go-key" },
  });

  await emit("session_start");
  await runtime.refresh({
    providers: [OPENCODE_GO_CLASSIFIERS_PROVIDER_ID],
    allowNetwork: false,
  });

  const goChatModels = registry.getModelsOfType("chat", "opencode-go");
  assert.ok(goChatModels.length > 0);
  assert.equal(
    registry.getModelsOfType("chat", OPENCODE_GO_CLASSIFIERS_PROVIDER_ID)
      .length,
    0,
  );

  const availableClassifiers = await registry.getAvailableOfType(
    "classifier",
    OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
  );
  assert.deepEqual(
    availableClassifiers.map((item) => item.id),
    ["jev-1.14", "gemini-decision-1", "gpt-6-luna-decision"],
  );

  const resolved = await registry.getProviderAuth(
    OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
  );
  assert.equal(resolved?.auth.apiKey, "stored-go-key");
  assert.equal(resolved?.source, "stored by opencode-go");
});

test("extension inherits live runtime opencode-go keys and cleans up on session_shutdown", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousApiKey = process.env.OPENCODE_API_KEY;
  process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-classifier-test-agent-dir";
  delete process.env.OPENCODE_API_KEY;
  t.after(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (previousApiKey === undefined) {
      delete process.env.OPENCODE_API_KEY;
    } else {
      process.env.OPENCODE_API_KEY = previousApiKey;
    }
  });

  const { runtime, registry, emit } = await setupSession();
  await emit("session_start");

  await runtime.setRuntimeApiKey("opencode-go", "live-runtime-go-key");

  const resolved = await registry.getProviderAuth(
    OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
  );
  assert.equal(resolved?.auth.apiKey, "live-runtime-go-key");

  const available = await registry.getAvailableOfType(
    "classifier",
    OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
  );
  assert.equal(available.length, 3);

  // Even while the runtime key is still on the old session, session_shutdown unbinds the registry.
  await emit("session_shutdown");

  const statusAfterShutdown = await runtime.checkAuth(
    OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
  );
  assert.equal(statusAfterShutdown, undefined);
});
