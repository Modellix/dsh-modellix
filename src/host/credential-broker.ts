import {
  CredentialMutationCoordinator,
  MODELLIX_CREDENTIAL_REF,
  parseRetryAfter,
  readBoundedResponseJson,
  requestDeadline,
  toModellixError,
  type CredentialDescriptor,
  type CredentialMutationResult,
  type ModellixErrorContract,
} from "../core/index.js";

const VALIDATE_URL = "https://api.modellix.ai/api/v1/apikey/validate";
const MAX_VALIDATION_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface HarnessCredentialInfo {
  readonly configured: boolean;
  readonly source?: string;
  readonly writable: boolean;
}

export interface HarnessCredentialPort {
  resolve(ref: string): Promise<{ readonly value: string; readonly source: string } | undefined>;
  describe(ref: string): Promise<HarnessCredentialInfo>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

export class CredentialValidationError extends Error {
  readonly contract: ModellixErrorContract;

  constructor(contract: ModellixErrorContract) {
    super(contract.messageKey);
    this.name = "CredentialValidationError";
    this.contract = contract;
  }
}

export interface CredentialBrokerOptions {
  readonly credentials: HarnessCredentialPort;
  readonly initialCredentialEpoch: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

/** Host-only owner of candidate validation and serialized Credential writes. */
export class CredentialBroker {
  readonly #credentials: HarnessCredentialPort;
  readonly #mutations: CredentialMutationCoordinator;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;

  constructor(options: CredentialBrokerOptions) {
    this.#credentials = options.credentials;
    this.#mutations = new CredentialMutationCoordinator(options.initialCredentialEpoch);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > 10 * 60_000
    ) {
      throw new TypeError("requestTimeoutMs must be a positive safe integer no greater than ten minutes");
    }
  }

  get credentialEpoch(): number {
    return this.#mutations.credentialEpoch;
  }

  async describe(): Promise<CredentialDescriptor> {
    const info = await this.#credentials.describe(MODELLIX_CREDENTIAL_REF);
    if (!info.configured) {
      return {
        configured: false,
        source: null,
        writable: info.writable,
        revision: null,
        credentialEpoch: this.credentialEpoch,
      };
    }
    const source = info.writable ? "local" : "env";
    return {
      configured: true,
      source,
      writable: info.writable,
      // Harness exposes no revision. The plugin epoch is the concurrency token;
      // this opaque descriptor revision is deliberately non-secret.
      revision: `epoch:${String(this.credentialEpoch)}`,
      credentialEpoch: this.credentialEpoch,
    };
  }

  async resolve(): Promise<{ readonly value: string; readonly credentialEpoch: number } | undefined> {
    const resolved = await this.#credentials.resolve(MODELLIX_CREDENTIAL_REF);
    return resolved === undefined
      ? undefined
      : { value: resolved.value, credentialEpoch: this.credentialEpoch };
  }

  async validateCandidate(candidate: string, signal?: AbortSignal): Promise<void> {
    assertCandidate(candidate);
    const deadline = requestDeadline(signal, this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(VALIDATE_URL, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${candidate}`,
        },
        redirect: "manual",
        signal: deadline.signal,
      });
    } catch (error) {
      throw validationError(signal?.aborted === true || isAbortError(error) && !deadline.timedOut()
        ? "abort"
        : deadline.timedOut()
          ? "timeout"
          : "network");
    }
    if (
      response.redirected ||
      response.status === 0 ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw validationError("unexpected-response");
    }
    if (!response.ok) {
      const context = {
        service: "design" as const,
        subsystem: "credential",
        operation: "validate-candidate",
        credentialEpoch: this.credentialEpoch,
      };
      throw new CredentialValidationError(response.status === 401
        ? toModellixError(context, { kind: "candidate-invalid" })
        : toModellixError(context, {
          kind: "http",
          status: response.status,
          requestId: response.headers.get("x-request-id"),
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), this.#now()),
        }));
    }
    let value: unknown;
    try {
      value = await readBoundedResponseJson(
        response,
        MAX_VALIDATION_RESPONSE_BYTES,
        deadline.signal,
      );
    } catch (error) {
      throw validationError(
        signal?.aborted === true || isAbortError(error) && !deadline.timedOut()
          ? "abort"
          : deadline.timedOut()
            ? "timeout"
          : "unexpected-response",
      );
    }
    if (!isRecord(value) || !isRecord(value.data) || value.data.is_valid !== true) {
      throw validationError(value !== null && isRecord(value) && isRecord(value.data)
        && value.data.is_valid === false ? "candidate-invalid" : "unexpected-response");
    }
  }

  set(candidate: string, expectedCredentialEpoch: number): Promise<CredentialMutationResult<void>> {
    assertCandidate(candidate);
    return this.#mutations.run(expectedCredentialEpoch, () =>
      this.#credentials.set(MODELLIX_CREDENTIAL_REF, candidate));
  }

  unset(expectedCredentialEpoch: number): Promise<CredentialMutationResult<void>> {
    return this.#mutations.run(expectedCredentialEpoch, () =>
      this.#credentials.unset(MODELLIX_CREDENTIAL_REF));
  }

  synchronizeRecoveredEpoch(credentialEpoch: number): void {
    this.#mutations.synchronizeRecoveredEpoch(credentialEpoch);
  }
}

function assertCandidate(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || hasControlCharacters(value)) {
    throw validationError("candidate-invalid");
  }
}

function validationError(
  kind: "abort" | "timeout" | "network" | "candidate-invalid" | "unexpected-response",
): CredentialValidationError {
  return new CredentialValidationError(toModellixError({
    service: "design",
    subsystem: "credential",
    operation: "validate-candidate",
  }, { kind }));
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
