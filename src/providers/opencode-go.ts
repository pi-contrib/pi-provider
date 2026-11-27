import {
  type AuthCheck,
  type AuthResult,
  type ClassifierModel,
  type Credential,
  createProvider,
  type Provider,
} from "@earendil-works/pi-ai";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import {
  type ModelRegistry,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";

export const OPENCODE_GO_CLASSIFIERS_PROVIDER_ID = "opencode-go-classifiers";
const INHERITED_PROVIDER_ID = "opencode-go";
const ENV_VAR = "OPENCODE_API_KEY";
const BASE_URL = "https://opencode.ai/inference/go/v1";
const API = "typesafe-system-one" as const;
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODELS = [
  { id: "jev-1.14", name: "Jev 1.14", contextWindow: 32000 },
  { id: "gemini-decision-1", name: "Gemini Decision 1", contextWindow: 262144 },
  {
    id: "gpt-6-luna-decision",
    name: "GPT-6 Luna Decision",
    contextWindow: 1050000,
  },
].map(
  ({ id, name, contextWindow }): ClassifierModel<typeof API> => ({
    type: "classifier",
    provider: OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
    baseUrl: BASE_URL,
    id,
    name,
    api: API,
    input: ["text"],
    cost: COST,
    contextWindow,
  }),
) satisfies readonly ClassifierModel<typeof API>[];

export interface OpenCodeGoProviderOptions {
  /** Session model registry used to inherit live `opencode-go` auth. */
  getModelRegistry?: () =>
    | Pick<ModelRegistry, "getProviderAuth" | "getProviderAuthStatus">
    | undefined;
  /** Fallback reader for stored `opencode-go` credentials before a session binds. */
  readGoCredential?: () => Credential | undefined;
}

function defaultReadGoCredential(): Credential | undefined {
  return readStoredCredential(INHERITED_PROVIDER_ID);
}

function resolveFallbackStoredCredential(
  credential: Credential | undefined,
): AuthResult | undefined {
  if (credential?.type !== "api_key") return undefined;
  const key = credential.key?.trim();
  if (!key || key.startsWith("!")) return undefined;
  return {
    auth: { apiKey: key },
    ...(credential.env ? { env: credential.env } : {}),
    source: `${INHERITED_PROVIDER_ID} credential`,
  };
}

function checkFallbackStoredCredential(
  credential: Credential | undefined,
): AuthCheck | undefined {
  if (credential?.type !== "api_key") return undefined;
  if (!credential.key?.trim()) return undefined;
  return {
    type: "api_key",
    source: `${INHERITED_PROVIDER_ID} credential`,
  };
}

export function createOpenCodeGoProvider(
  options: OpenCodeGoProviderOptions = {},
): Provider {
  const { getModelRegistry, readGoCredential = defaultReadGoCredential } =
    options;

  return createProvider({
    id: OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
    name: "OpenCode Go classifiers",
    baseUrl: BASE_URL,
    models: MODELS,
    auth: {
      apiKey: {
        name: "OpenCode Go key",
        async login(interaction) {
          interaction.signal.throwIfAborted();
          interaction.notify({
            type: "info",
            message:
              "Tip: /login opencode-go shares one API key with both OpenCode Go chat and classifiers. Enter a key below only to set a separate override key for classifiers.",
          });
          const raw = await interaction.prompt({
            type: "secret",
            message: "Enter OpenCode API key",
          });
          interaction.signal.throwIfAborted();
          const key = raw.trim();
          if (!key) {
            throw new Error("OpenCode API key must not be empty");
          }
          return { type: "api_key", key };
        },
        async check({ credential, ctx, signal }) {
          signal.throwIfAborted();
          if (credential?.key?.trim()) {
            return {
              type: "api_key",
              source: `${OPENCODE_GO_CLASSIFIERS_PROVIDER_ID} credential`,
            };
          }
          const registry = getModelRegistry?.();
          if (registry) {
            const status = registry.getProviderAuthStatus(
              INHERITED_PROVIDER_ID,
            );
            if (status.configured) {
              return {
                type: "api_key",
                source:
                  status.source === "environment" && status.label
                    ? status.label
                    : `${INHERITED_PROVIDER_ID} credential`,
              };
            }
          } else {
            const fallback = checkFallbackStoredCredential(readGoCredential());
            if (fallback) return fallback;
          }
          const environment = (await ctx.env(ENV_VAR))?.trim();
          signal.throwIfAborted();
          return environment ? { type: "api_key", source: ENV_VAR } : undefined;
        },
        async resolve({ credential, ctx, signal }) {
          signal.throwIfAborted();
          const stored = credential?.key?.trim();
          if (stored) {
            return {
              auth: { apiKey: stored },
              ...(credential?.env ? { env: credential.env } : {}),
              source: `${OPENCODE_GO_CLASSIFIERS_PROVIDER_ID} credential`,
            };
          }
          const registry = getModelRegistry?.();
          if (registry) {
            const inherited = await registry.getProviderAuth(
              INHERITED_PROVIDER_ID,
            );
            signal.throwIfAborted();
            const apiKey = inherited?.auth.apiKey?.trim();
            if (apiKey) {
              return {
                auth: { apiKey },
                ...(inherited?.env ? { env: inherited.env } : {}),
                source:
                  inherited?.source === ENV_VAR
                    ? ENV_VAR
                    : `${INHERITED_PROVIDER_ID} credential`,
              };
            }
          } else {
            const fallback = resolveFallbackStoredCredential(
              readGoCredential(),
            );
            if (fallback) return fallback;
          }
          const environment = (await ctx.env(ENV_VAR))?.trim();
          signal.throwIfAborted();
          return environment
            ? { auth: { apiKey: environment }, source: ENV_VAR }
            : undefined;
        },
      },
    },
    classifiers: { [API]: typesafeSystemOneApi() },
  });
}
