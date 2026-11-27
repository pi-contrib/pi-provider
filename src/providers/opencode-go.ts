import { execFileSync } from "node:child_process";
import {
  type ClassifierAnswer,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierOptions,
  type ClassifierResult,
  createProvider,
} from "@earendil-works/pi-ai/compat";

const PROVIDER = "opencode-go-classifiers";
const BASE_URL = "https://opencode.ai/inference/go/v1";
const API = "system-one-go";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

class ProviderError extends Error {}

const MODELS = [
  { id: "jev-1.14", name: "Jev 1.14", contextWindow: 32000 },
  { id: "gemini-decision-1", name: "Gemini Decision 1", contextWindow: 262144 },
  {
    id: "gpt-6-luna-decision",
    name: "GPT-6 Luna Decision",
    contextWindow: 1050000,
  },
].map(({ id, name, contextWindow }) => ({
  type: "classifier" as const,
  provider: PROVIDER,
  baseUrl: BASE_URL,
  id,
  name,
  api: API,
  input: ["text"] as ("text" | "image")[],
  cost: COST,
  contextWindow,
}));

/** Read Pi's Go credential without copying it into another credential store. */
export function goKey(): string | undefined {
  try {
    return (
      execFileSync(
        "pi",
        ["auth", "print-api-key", "--provider", "opencode-go"],
        {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderError(`System One returned invalid ${label}`);
  }
  return value;
}

function answer(
  question: ClassifierContext["questions"][string],
  value: unknown,
  id: string,
): ClassifierAnswer {
  if (!record(value))
    throw new ProviderError(`System One returned no answer for ${id}`);
  if (question.type === "choice") {
    if (
      (value.type !== undefined && value.type !== "choice") ||
      typeof value.choice !== "string"
    ) {
      throw new ProviderError(`System One returned invalid choice for ${id}`);
    }
    const probabilities = value.probabilities ?? {};
    if (!record(probabilities))
      throw new ProviderError(
        `System One returned invalid probabilities for ${id}`,
      );
    return {
      type: "choice",
      choice: value.choice,
      probabilities: Object.fromEntries(
        Object.entries(probabilities).map(([key, probability]) => [
          key,
          number(probability, `probability for ${id}`),
        ]),
      ),
      confidence: number(value.confidence ?? 0, `confidence for ${id}`),
    };
  }
  if (question.type === "score") {
    if (value.type !== undefined && value.type !== "score") {
      throw new ProviderError(`System One returned invalid score for ${id}`);
    }
    return {
      type: "score",
      score: number(value.score, `score for ${id}`),
      confidence: number(value.confidence ?? 0, `confidence for ${id}`),
    };
  }
  if (
    value.type !== undefined &&
    value.type !== "noul" &&
    value.type !== "bool"
  ) {
    throw new ProviderError(`System One returned invalid bool for ${id}`);
  }
  return {
    type: "bool",
    probability: number(
      value.noul ?? value.probability,
      `probability for ${id}`,
    ),
  };
}

export async function classify(
  model: ClassifierModel<typeof API>,
  context: ClassifierContext,
  options?: ClassifierOptions,
): Promise<ClassifierResult> {
  const result: ClassifierResult = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "stop",
    timestamp: Date.now(),
  };
  try {
    if (options?.signal?.aborted)
      throw new ProviderError("OpenCode Go classification aborted");
    if (context.images?.length)
      throw new ProviderError("OpenCode Go classifiers do not support images");
    if (!options?.apiKey)
      throw new ProviderError(
        "No OpenCode Go key; use /login or set OPENCODE_API_KEY",
      );
    // System One's boolean question is called "noul" on the wire, but "bool" in Pi.
    const questions = Object.fromEntries(
      Object.entries(context.questions).map(([id, question]) => [
        id,
        question.type === "bool" ? { ...question, type: "noul" } : question,
      ]),
    );
    const payload = { model: model.id, state: context.state, questions };
    const body = (await options.onPayload?.(payload, model)) ?? payload;
    const headers = new Headers();
    for (const [name, value] of Object.entries({
      ...model.headers,
      ...options.headers,
    })) {
      if (value !== null && value !== undefined) headers.set(name, value);
    }
    headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${options.apiKey}`);
    const response = await (options.fetch ?? fetch)(
      `${model.baseUrl.replace(/\/+$/u, "")}/systemone`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
    await options.onResponse?.(
      {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      },
      model,
    );
    if (!response.ok)
      throw new ProviderError(`System One returned HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (!record(data) || !record(data.answers))
      throw new ProviderError("System One returned invalid answers");
    const answers = data.answers;
    if (record(data.usage)) {
      const input = number(data.usage.input_tokens ?? 0, "input usage");
      const output = number(data.usage.output_tokens ?? 0, "output usage");
      result.usage = {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { ...COST, total: 0 },
      };
    }
    result.answers = Object.fromEntries(
      Object.entries(context.questions).map(([id, question]) => [
        id,
        answer(question, answers[id], id),
      ]),
    );
  } catch (error) {
    result.stopReason = options?.signal?.aborted ? "aborted" : "error";
    // Never reflect arbitrary network exception text: it may contain credentials or request data.
    result.errorMessage =
      result.stopReason === "aborted"
        ? "OpenCode Go classification aborted"
        : error instanceof ProviderError
          ? error.message
          : "OpenCode Go classification failed";
  }
  return result;
}

export function createOpenCodeGoProvider(
  readGoKey: () => string | undefined = goKey,
) {
  return createProvider({
    id: PROVIDER,
    name: "OpenCode Go classifiers",
    baseUrl: BASE_URL,
    models: MODELS,
    auth: {
      apiKey: {
        name: "OpenCode Go key",
        async login(interaction) {
          return {
            type: "api_key",
            key: await interaction.prompt({
              type: "secret",
              message: "Enter OpenCode API key",
            }),
          };
        },
        async resolve({ credential, ctx }) {
          const stored = credential?.key;
          if (stored)
            return {
              auth: { apiKey: stored },
              source: "opencode-go-classifiers credential",
            };
          const environment = await ctx.env("OPENCODE_API_KEY");
          if (environment)
            return {
              auth: { apiKey: environment },
              source: "OPENCODE_API_KEY",
            };
          const inherited = readGoKey();
          return inherited
            ? { auth: { apiKey: inherited }, source: "opencode-go credential" }
            : undefined;
        },
      },
    },
    classifiers: { [API]: { classify } },
  });
}
