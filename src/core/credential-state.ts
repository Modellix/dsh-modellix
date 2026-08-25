export type CredentialSource = "local" | "env" | null;
export type CredentialVerification =
  | "unknown"
  | "unverified"
  | "valid"
  | "invalid";

export interface CredentialDescriptor {
  readonly configured: boolean;
  readonly source: CredentialSource;
  readonly writable: boolean;
  /** Opaque Host descriptor revision. It must never be derived from the Key. */
  readonly revision: string | null;
  /** Plugin-owned monotonic generation used to reject stale results. */
  readonly credentialEpoch: number;
}

export interface InvalidCredentialEpoch {
  readonly credentialEpoch: number;
  readonly openedAt: number;
}

export interface CredentialState {
  readonly descriptor: CredentialDescriptor;
  readonly verification: CredentialVerification;
  readonly invalidEpoch: InvalidCredentialEpoch | null;
}

export interface UnauthorizedTransition {
  readonly state: CredentialState;
  readonly stale: boolean;
  readonly shouldOpenModal: boolean;
}

export interface VerificationTransition {
  readonly state: CredentialState;
  readonly stale: boolean;
}

export interface CredentialMutationResult<T> {
  readonly value: T;
  readonly previousEpoch: number;
  readonly credentialEpoch: number;
}

export class CredentialEpochConflictError extends Error {
  readonly expectedEpoch: number;
  readonly actualEpoch: number;

  constructor(expectedEpoch: number, actualEpoch: number) {
    super(
      `Credential epoch conflict: expected ${expectedEpoch}, current ${actualEpoch}`,
    );
    this.name = "CredentialEpochConflictError";
    this.expectedEpoch = expectedEpoch;
    this.actualEpoch = actualEpoch;
  }
}

export function createCredentialState(
  descriptor: CredentialDescriptor = missingCredentialDescriptor(0),
): CredentialState {
  const normalized = normalizeCredentialDescriptor(descriptor);
  return {
    descriptor: normalized,
    verification: normalized.configured ? "unverified" : "unknown",
    invalidEpoch: null,
  };
}

export function missingCredentialDescriptor(
  credentialEpoch: number,
  writable = false,
): CredentialDescriptor {
  assertEpoch(credentialEpoch);
  return {
    configured: false,
    source: null,
    writable,
    revision: null,
    credentialEpoch,
  };
}

export function normalizeCredentialDescriptor(
  descriptor: CredentialDescriptor,
): CredentialDescriptor {
  assertEpoch(descriptor.credentialEpoch);
  if (!descriptor.configured) {
    if (descriptor.source !== null || descriptor.revision !== null) {
      throw new TypeError("Missing Credential descriptors cannot expose source or revision");
    }
    return missingCredentialDescriptor(descriptor.credentialEpoch, descriptor.writable);
  }
  if (descriptor.source !== "local" && descriptor.source !== "env") {
    throw new TypeError("Configured Credential must have a local or env source");
  }
  if (descriptor.source === "env" && descriptor.writable) {
    throw new TypeError("Environment Credential descriptors are read-only");
  }
  if (descriptor.source === "local" && !descriptor.writable) {
    throw new TypeError("Local Credential descriptors must be writable");
  }
  assertRevision(descriptor.revision);
  return { ...descriptor };
}

/**
 * Applies a Host descriptor read. A changed revision or plugin epoch invalidates
 * earlier verification, while a same-revision refresh preserves it.
 */
export function applyCredentialDescriptor(
  state: CredentialState,
  descriptor: CredentialDescriptor,
): CredentialState {
  const next = normalizeCredentialDescriptor(descriptor);
  const sameCredential =
    state.descriptor.configured === next.configured &&
    state.descriptor.source === next.source &&
    state.descriptor.revision === next.revision &&
    state.descriptor.credentialEpoch === next.credentialEpoch;

  if (sameCredential) {
    return { ...state, descriptor: next };
  }

  return {
    descriptor: next,
    verification: next.configured ? "unverified" : "unknown",
    invalidEpoch: null,
  };
}

export function applyVerificationResult(
  state: CredentialState,
  capturedCredentialEpoch: number,
  verification: "valid" | "invalid",
): VerificationTransition {
  assertEpoch(capturedCredentialEpoch);
  if (
    capturedCredentialEpoch !== state.descriptor.credentialEpoch ||
    !state.descriptor.configured
  ) {
    return { state, stale: true };
  }

  return {
    stale: false,
    state: {
      ...state,
      verification,
      invalidEpoch:
        verification === "invalid"
          ? {
              credentialEpoch: capturedCredentialEpoch,
              openedAt: 0,
            }
          : null,
    },
  };
}

/**
 * A transient validation/network failure is intentionally a no-op. It must not
 * downgrade a previously valid Credential to invalid.
 */
export function preserveVerificationAfterTransientFailure(
  state: CredentialState,
  capturedCredentialEpoch: number,
): VerificationTransition {
  assertEpoch(capturedCredentialEpoch);
  return {
    state,
    stale: capturedCredentialEpoch !== state.descriptor.credentialEpoch,
  };
}

/**
 * Applies only an explicit customer-Credential 401. Concurrent responses from
 * the same epoch share one invalid epoch and request one Modal at most.
 */
export function applyRuntimeUnauthorized(
  state: CredentialState,
  capturedCredentialEpoch: number,
  occurredAt: number,
): UnauthorizedTransition {
  assertEpoch(capturedCredentialEpoch);
  assertTimestamp(occurredAt);

  if (
    capturedCredentialEpoch !== state.descriptor.credentialEpoch ||
    !state.descriptor.configured
  ) {
    return { state, stale: true, shouldOpenModal: false };
  }

  const alreadyOpen =
    state.verification === "invalid" &&
    state.invalidEpoch?.credentialEpoch === capturedCredentialEpoch;
  if (alreadyOpen) {
    return { state, stale: false, shouldOpenModal: false };
  }

  return {
    stale: false,
    shouldOpenModal: true,
    state: {
      ...state,
      verification: "invalid",
      invalidEpoch: {
        credentialEpoch: capturedCredentialEpoch,
        openedAt: occurredAt,
      },
    },
  };
}

/** Candidate validation never mutates the currently stored Credential state. */
export function preserveStoredCredentialAfterCandidateFailure(
  state: CredentialState,
): CredentialState {
  return state;
}

/**
 * Serializes Host Credential set/unset calls and performs plugin epoch CAS.
 * The operation closure may temporarily own a candidate Key, but the
 * coordinator never receives, records, stringifies, or exposes that value.
 */
export class CredentialMutationCoordinator {
  readonly #tailState = { promise: Promise.resolve() as Promise<void> };
  #credentialEpoch: number;

  constructor(initialCredentialEpoch: number) {
    assertEpoch(initialCredentialEpoch);
    this.#credentialEpoch = initialCredentialEpoch;
  }

  get credentialEpoch(): number {
    return this.#credentialEpoch;
  }

  run<T>(
    expectedCredentialEpoch: number,
    operation: () => Promise<T>,
  ): Promise<CredentialMutationResult<T>> {
    assertEpoch(expectedCredentialEpoch);

    const scheduled = this.#tailState.promise.then(async () => {
      if (expectedCredentialEpoch !== this.#credentialEpoch) {
        throw new CredentialEpochConflictError(
          expectedCredentialEpoch,
          this.#credentialEpoch,
        );
      }

      const value = await operation();
      const previousEpoch = this.#credentialEpoch;
      this.#credentialEpoch += 1;
      return {
        value,
        previousEpoch,
        credentialEpoch: this.#credentialEpoch,
      };
    });

    this.#tailState.promise = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  /** Advances an idle coordinator after persisted crash recovery. */
  synchronizeRecoveredEpoch(credentialEpoch: number): void {
    assertEpoch(credentialEpoch);
    if (credentialEpoch < this.#credentialEpoch) {
      throw new CredentialEpochConflictError(
        credentialEpoch,
        this.#credentialEpoch,
      );
    }
    this.#credentialEpoch = credentialEpoch;
  }
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("credentialEpoch must be a non-negative safe integer");
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("occurredAt must be a non-negative safe integer");
  }
}

function assertRevision(value: string | null): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    hasControlCharacters(value)
  ) {
    throw new TypeError("Configured Credential must have a bounded opaque revision");
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}
