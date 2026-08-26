import type { LlmRuntime } from "@deepseek-ai/dsh-llm";

import type { ModellixLlmModel } from "./catalog.js";
import { MODELLIX_LLM_PROVIDER_ID } from "./materializer.js";

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_RETRY_DELAY_MS = 10;

/** Public, non-generating LLM registry surface used for materialization backreads. */
export type LlmRegistryReader = Pick<LlmRuntime, "listProviders" | "resolveModelInfo">;

export interface LlmRegistryVerificationOptions {
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly signal?: AbortSignal;
}

/** The materialized route never became observable through the public LLM registry. */
export class LlmRegistryBackreadError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super("The Modellix LLM route was not readable from the public LLM registry", { cause });
    this.name = "LlmRegistryBackreadError";
    this.attempts = attempts;
  }
}

/**
 * Wait until llm-pi-ai has consumed its Settings update, then prove that the
 * route and every exact catalog model resolve through the public registry.
 * This reads adapter metadata only; it never resolves a Credential or starts a
 * generated/streaming request.
 */
export async function verifyLlmRegistryBackread(
  registry: LlmRegistryReader,
  models: readonly ModellixLlmModel[],
  options: LlmRegistryVerificationOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  assertPositiveSafeInteger(attempts, "attempts");
  assertNonNegativeSafeInteger(retryDelayMs, "retryDelayMs");

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      await verifySnapshot(registry, models, options.signal);
      return;
    } catch (error) {
      if (options.signal?.aborted === true) options.signal.throwIfAborted();
      lastError = error;
    }
    if (attempt < attempts) await abortableDelay(retryDelayMs, options.signal);
  }
  throw new LlmRegistryBackreadError(attempts, lastError);
}

async function verifySnapshot(
  registry: LlmRegistryReader,
  models: readonly ModellixLlmModel[],
  signal?: AbortSignal,
): Promise<void> {
  if (!registry.listProviders().some(({ id }) => id === MODELLIX_LLM_PROVIDER_ID)) {
    throw new Error("The Modellix provider route is not registered");
  }
  for (const model of models) {
    signal?.throwIfAborted();
    const resolved = await registry.resolveModelInfo(
      MODELLIX_LLM_PROVIDER_ID,
      model.id,
      signal,
    );
    if (resolved.provider !== MODELLIX_LLM_PROVIDER_ID || resolved.id !== model.id) {
      throw new Error("The Modellix provider returned mismatched exact-model metadata");
    }
  }
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (delayMs === 0) {
    await Promise.resolve();
    signal?.throwIfAborted();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("The registry backread was aborted", "AbortError"));
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}
