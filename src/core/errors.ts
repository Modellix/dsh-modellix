export type ModellixService = "design" | "llm" | "web";

export type ModellixErrorCode =
  | "MODELLIX_CANDIDATE_KEY_INVALID"
  | "MODELLIX_API_KEY_INVALID"
  | "MODELLIX_BILLING_BLOCKED"
  | "MODELLIX_POLICY_BLOCKED"
  | "MODELLIX_RESOURCE_NOT_FOUND"
  | "MODELLIX_RATE_LIMITED"
  | "MODELLIX_CANCELED"
  | "MODELLIX_OFFLINE"
  | "MODELLIX_TIMEOUT"
  | "MODELLIX_SERVER_ERROR"
  | "MODELLIX_BAD_REQUEST"
  | "MODELLIX_SUBMIT_UNKNOWN"
  | "MODELLIX_ASSET_EXPIRED"
  | "MODELLIX_UNEXPECTED_RESPONSE";

export interface ModellixErrorContext {
  readonly service: ModellixService;
  readonly subsystem: string;
  readonly operation: string;
  readonly credentialEpoch?: number;
  readonly requestId?: string | null;
  readonly taskId?: string | null;
}

export type ModellixFailure =
  | {
      readonly kind: "http";
      readonly status: number;
      readonly requestId?: string | null;
      readonly retryAfterMs?: number | null;
    }
  | { readonly kind: "network" }
  | { readonly kind: "timeout" }
  | { readonly kind: "abort" }
  | { readonly kind: "candidate-invalid" }
  | { readonly kind: "submit-unknown" }
  | { readonly kind: "asset-expired" }
  | { readonly kind: "unexpected-response" };

export interface ModellixErrorContract {
  readonly version: 1;
  readonly service: ModellixService;
  readonly subsystem: string;
  readonly operation: string;
  readonly code: ModellixErrorCode;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly credentialEpoch: number | null;
  readonly requestId: string | null;
  readonly taskId: string | null;
  readonly retryAfterMs: number | null;
  readonly messageKey: string;
}

interface ErrorClassification {
  readonly code: ModellixErrorCode;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
}

export function toModellixError(
  context: ModellixErrorContext,
  failure: ModellixFailure,
): ModellixErrorContract {
  assertContextToken(context.subsystem, "subsystem");
  assertContextToken(context.operation, "operation");
  if (
    context.credentialEpoch !== undefined &&
    (!Number.isSafeInteger(context.credentialEpoch) || context.credentialEpoch < 0)
  ) {
    throw new TypeError("credentialEpoch must be a non-negative safe integer");
  }

  const classification = classifyFailure(failure);
  return {
    version: 1,
    service: context.service,
    subsystem: context.subsystem,
    operation: context.operation,
    code: classification.code,
    httpStatus: classification.httpStatus,
    retryable: classification.retryable,
    credentialEpoch: context.credentialEpoch ?? null,
    requestId: safeCorrelationId(
      failure.kind === "http" ? failure.requestId : context.requestId,
    ),
    taskId: safeCorrelationId(context.taskId),
    retryAfterMs: classification.retryAfterMs,
    messageKey: messageKeyFor(classification.code),
  };
}

export function isCredentialInvalidError(
  error: ModellixErrorContract,
): boolean {
  return error.code === "MODELLIX_API_KEY_INVALID";
}

export function isRetryableError(error: ModellixErrorContract): boolean {
  return error.retryable;
}

function classifyFailure(failure: ModellixFailure): ErrorClassification {
  switch (failure.kind) {
    case "candidate-invalid":
      return classification("MODELLIX_CANDIDATE_KEY_INVALID", null, false);
    case "network":
      return classification("MODELLIX_OFFLINE", null, true);
    case "timeout":
      return classification("MODELLIX_TIMEOUT", null, true);
    case "abort":
      return classification("MODELLIX_CANCELED", null, false);
    case "submit-unknown":
      return classification("MODELLIX_SUBMIT_UNKNOWN", null, false);
    case "asset-expired":
      return classification("MODELLIX_ASSET_EXPIRED", null, false);
    case "unexpected-response":
      return classification("MODELLIX_UNEXPECTED_RESPONSE", null, false);
    case "http":
      return classifyHttpFailure(failure);
  }
}

function classifyHttpFailure(
  failure: Extract<ModellixFailure, { kind: "http" }>,
): ErrorClassification {
  if (!Number.isInteger(failure.status) || failure.status < 100 || failure.status > 599) {
    return classification("MODELLIX_UNEXPECTED_RESPONSE", null, false);
  }

  switch (failure.status) {
    case 400:
    case 409:
    case 422:
      return classification("MODELLIX_BAD_REQUEST", failure.status, false);
    case 401:
      return classification("MODELLIX_API_KEY_INVALID", failure.status, false);
    case 402:
      return classification("MODELLIX_BILLING_BLOCKED", failure.status, false);
    case 403:
      return classification("MODELLIX_POLICY_BLOCKED", failure.status, false);
    case 404:
      return classification("MODELLIX_RESOURCE_NOT_FOUND", failure.status, false);
    case 408:
    case 504:
      return classification("MODELLIX_TIMEOUT", failure.status, true);
    case 429:
      return classification(
        "MODELLIX_RATE_LIMITED",
        failure.status,
        true,
        normalizeRetryAfter(failure.retryAfterMs),
      );
    default:
      return failure.status >= 500
        ? classification("MODELLIX_SERVER_ERROR", failure.status, true)
        : classification("MODELLIX_UNEXPECTED_RESPONSE", failure.status, false);
  }
}

function classification(
  code: ModellixErrorCode,
  httpStatus: number | null,
  retryable: boolean,
  retryAfterMs: number | null = null,
): ErrorClassification {
  return { code, httpStatus, retryable, retryAfterMs };
}

function normalizeRetryAfter(value: number | null | undefined): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 86_400_000
    ? Math.floor(value)
    : null;
}

function safeCorrelationId(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
    ? value
    : null;
}

function assertContextToken(value: string, field: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new TypeError(`${field} must be a stable lowercase token`);
  }
}

function messageKeyFor(code: ModellixErrorCode): string {
  return `modellix.error.${code.slice("MODELLIX_".length).toLowerCase()}`;
}
