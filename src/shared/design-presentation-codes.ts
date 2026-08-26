export const DESIGN_NOTICE_CODES = [
  "schema-unavailable",
  "schema-invalid",
  "catalog-stale",
  "catalog-unavailable",
  "credential-reloaded",
] as const;

export type DesignNoticeCode = (typeof DESIGN_NOTICE_CODES)[number];

export const DESIGN_MODEL_UNAVAILABLE_CODES = ["removed-from-catalog"] as const;

export type DesignModelUnavailableCode =
  (typeof DESIGN_MODEL_UNAVAILABLE_CODES)[number];

export const DESIGN_FIELD_DISABLED_CODES = ["unsupported-schema-field"] as const;

export type DesignFieldDisabledCode =
  (typeof DESIGN_FIELD_DISABLED_CODES)[number];

export const DESIGN_DIAGNOSTIC_CODES = [
  "credential-changed",
  "submit-unknown",
  "generation-failed",
  "result-unavailable",
  "credential-rejected",
  "task-inaccessible",
  "rate-limited",
  "response-invalid",
  "poll-unavailable",
] as const;

export type DesignDiagnosticCode = (typeof DESIGN_DIAGNOSTIC_CODES)[number];
