import {
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierResult,
  calculateCost,
  getIdentityHeaders,
  type ProviderClassifier,
} from "@earendil-works/pi-ai";

// Text-only System One adapter. Keep this local: Pi supplies pi-ai's root module to
// extensions, but its bundled resolver does not expose pi-ai/api/* subpaths.
const LABEL = "System One API";
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${LABEL} returned an invalid ${field}`);
  }
  return value;
}

function answersFor(
  value: unknown,
  context: ClassifierContext,
): ClassifierResult["answers"] {
  if (!record(value))
    throw new Error(`${LABEL} returned an unexpected response`);
  const answers: ClassifierResult["answers"] = {};
  for (const [id, question] of Object.entries(context.questions)) {
    const answer = value[id];
    if (!record(answer))
      throw new Error(`${LABEL} did not return an answer for ${id}`);
    if (question.type === "choice") {
      if (
        answer.type !== "choice" ||
        typeof answer.choice !== "string" ||
        !record(answer.probabilities)
      ) {
        throw new Error(`${LABEL} did not return a choice answer for ${id}`);
      }
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: Object.fromEntries(
          Object.entries(answer.probabilities).map(([key, value]) => [
            key,
            number(value, `probability for ${id}.${key}`),
          ]),
        ),
        confidence: number(answer.confidence, `confidence for ${id}`),
      };
    } else if (question.type === "score") {
      if (answer.type !== "score")
        throw new Error(`${LABEL} did not return a score answer for ${id}`);
      answers[id] = {
        type: "score",
        score: number(answer.score, `score for ${id}`),
        confidence: number(answer.confidence, `confidence for ${id}`),
      };
    } else {
      if (answer.type !== "noul")
        throw new Error(`${LABEL} did not return a bool answer for ${id}`);
      answers[id] = {
        type: "bool",
        probability: number(answer.noul, `probability for ${id}`),
      };
    }
  }
  return answers;
}

function usageFor(
  value: unknown,
  model: ClassifierModel<"typesafe-system-one">,
): ClassifierResult["usage"] {
  if (
    !record(value) ||
    (value.input_tokens === undefined && value.output_tokens === undefined)
  )
    return undefined;
  const tokens = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  const totalInput = tokens(value.input_tokens);
  const details = record(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined;
  const cacheRead = Math.min(tokens(details?.cached_tokens), totalInput);
  const cacheWrite = Math.min(
    tokens(details?.cache_write_tokens),
    totalInput - cacheRead,
  );
  const output = tokens(value.output_tokens);
  const usage = {
    input: totalInput - cacheRead - cacheWrite,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: totalInput + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

export const systemOneClassifier: ProviderClassifier = {
  async classify(model, context, options) {
    const result: ClassifierResult = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      answers: {},
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      if (model.api !== "typesafe-system-one")
        throw new Error(`Unsupported classifier API: ${model.api}`);
      if (context.images?.length)
        throw new Error(
          `${LABEL} does not support image input for ${model.id}`,
        );
      if (!options?.apiKey)
        throw new Error(`No API key for provider: ${model.provider}`);
      let payload: unknown = {
        model: model.id,
        state: context.state,
        questions: Object.fromEntries(
          Object.entries(context.questions).map(([id, question]) => [
            id,
            question.type === "bool" ? { ...question, type: "noul" } : question,
          ]),
        ),
      };
      const transformed = await options.onPayload?.(payload, model);
      if (transformed !== undefined) payload = transformed;
      const headers = new Headers({
        ...getIdentityHeaders(model, options.identity),
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      });
      for (const [key, value] of Object.entries(model.headers ?? {})) {
        if (value === null) headers.delete(key);
        else headers.set(key, value);
      }
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (value === null) headers.delete(key);
        else headers.set(key, value);
      }
      const timeout =
        options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(options.timeoutMs);
      const signal =
        timeout && options.signal
          ? AbortSignal.any([timeout, options.signal])
          : (timeout ?? options.signal);
      const url = new URL(
        "systemone",
        `${model.baseUrl.replace(/\/+$/u, "")}/`,
      );
      const fetcher = options.fetch ?? globalThis.fetch;
      let body: unknown;
      for (let attempt = 0; ; attempt++) {
        const response = await fetcher(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal,
        });
        await options.onResponse?.(
          {
            status: response.status,
            headers: Object.fromEntries(response.headers),
          },
          model,
        );
        if (response.ok) {
          body = await response.json();
          break;
        }
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < (options.maxRetries ?? 2)
        ) {
          // Retry transient failures without sending the same request indefinitely.
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason);
            const onAbort = () => {
              clearTimeout(timer);
              reject(signal?.reason);
            };
            const timer = setTimeout(
              () => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              },
              Math.min(1000 * 2 ** attempt, options.maxRetryDelayMs ?? 60000),
            );
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          continue;
        }
        throw new Error(
          `${LABEL} returned ${response.status}: ${await response.text()}`,
        );
      }
      if (!record(body))
        throw new Error(`${LABEL} returned an unexpected response`);
      if (typeof body.id === "string" && body.id) result.responseId = body.id;
      const usage = usageFor(
        body.usage,
        model as ClassifierModel<"typesafe-system-one">,
      );
      if (usage) result.usage = usage;
      result.answers = answersFor(body.answers, context);
    } catch (error) {
      result.stopReason = options?.signal?.aborted ? "aborted" : "error";
      result.errorMessage = `${LABEL} error: ${error instanceof Error ? error.message : String(error)}`;
    }
    return result;
  },
};
