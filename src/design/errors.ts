export type DesignErrorCode =
  | "INVALID_ARGUMENT"
  | "MISSING_API_KEY"
  | "CATALOG_UNAVAILABLE"
  | "SCHEMA_UNAVAILABLE"
  | "SCHEMA_INVALID"
  | "ENDPOINT_NOT_ALLOWED"
  | "PARAMETER_INVALID"
  | "SUBMIT_REJECTED"
  | "SUBMIT_UNKNOWN"
  | "TASK_READ_FAILED"
  | "UNEXPECTED_RESPONSE"
  | "STORAGE_INVALID"
  | "PLANNER_UNAUTHORIZED"
  | "PLANNER_BILLING_BLOCKED"
  | "PLANNER_FORBIDDEN"
  | "PLANNER_RATE_LIMITED"
  | "PLANNER_REJECTED"
  | "PLANNER_UNAVAILABLE"
  | "PLANNER_TIMEOUT"
  | "PLANNER_ABORTED"
  | "PLANNER_RESPONSE_INVALID";

export class DesignError extends Error {
  readonly code: DesignErrorCode;
  readonly status: number | null;

  constructor(
    code: DesignErrorCode,
    message: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DesignError";
    this.code = code;
    this.status = options.status ?? null;
  }
}
