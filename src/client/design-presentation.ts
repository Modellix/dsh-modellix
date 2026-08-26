import type {
  ClientJsonValue,
  DesignDiagnosticWire,
  DesignFieldWire,
  DesignModelWire,
  DesignResourceWire,
  DesignSnapshotWire,
} from "./contracts.js";
import type { ModellixLocaleKey } from "./locales.js";

const NOTICE_MESSAGE_KEYS = {
  "schema-unavailable": "designNoticeSchemaUnavailable",
  "schema-invalid": "designNoticeSchemaInvalid",
  "catalog-stale": "designNoticeCatalogStale",
  "catalog-unavailable": "designNoticeCatalogUnavailable",
  "credential-reloaded": "designNoticeCredentialReloaded",
} as const satisfies Record<
  NonNullable<DesignSnapshotWire["notice"]>,
  ModellixLocaleKey
>;

const MODEL_UNAVAILABLE_MESSAGE_KEYS = {
  "removed-from-catalog": "modelRemovedFromCatalog",
} as const satisfies Record<
  NonNullable<DesignModelWire["unavailableReason"]>,
  ModellixLocaleKey
>;

const FIELD_DISABLED_MESSAGE_KEYS = {
  "unsupported-schema-field": "unsupportedSchemaField",
} as const satisfies Record<
  NonNullable<DesignFieldWire["disabledReason"]>,
  ModellixLocaleKey
>;

const DIAGNOSTIC_MESSAGE_KEYS = {
  "credential-changed": "diagnosticCredentialChanged",
  "submit-unknown": "diagnosticSubmitUnknown",
  "generation-failed": "diagnosticGenerationFailed",
  "result-unavailable": "diagnosticResultUnavailable",
  "credential-rejected": "diagnosticCredentialRejected",
  "task-inaccessible": "diagnosticTaskInaccessible",
  "rate-limited": "diagnosticRateLimited",
  "response-invalid": "diagnosticResponseInvalid",
  "poll-unavailable": "diagnosticPollUnavailable",
} as const satisfies Record<DesignDiagnosticWire["code"], ModellixLocaleKey>;

const RESOURCE_PREVIEW_MESSAGE_KEYS = {
  image: "generatedPreview",
  video: "generatedVideoPreview",
  audio: "generatedAudioPreview",
} as const satisfies Record<DesignResourceWire["kind"], ModellixLocaleKey>;

export function designNoticeMessageKey(
  code: NonNullable<DesignSnapshotWire["notice"]>,
): ModellixLocaleKey {
  return NOTICE_MESSAGE_KEYS[code];
}

export function designModelUnavailableMessageKey(
  code: NonNullable<DesignModelWire["unavailableReason"]>,
): ModellixLocaleKey {
  return MODEL_UNAVAILABLE_MESSAGE_KEYS[code];
}

export function designFieldDisabledMessageKey(
  code: NonNullable<DesignFieldWire["disabledReason"]>,
): ModellixLocaleKey {
  return FIELD_DISABLED_MESSAGE_KEYS[code];
}

export function designDiagnosticMessageKey(
  code: DesignDiagnosticWire["code"],
): ModellixLocaleKey {
  return DIAGNOSTIC_MESSAGE_KEYS[code];
}

export function designResourcePreviewMessageKey(
  kind: DesignResourceWire["kind"],
): ModellixLocaleKey {
  return RESOURCE_PREVIEW_MESSAGE_KEYS[kind];
}

export type JsonParameterIssue = "syntax" | "constraint";

export function jsonParameterIssueMessageKey(
  issue: JsonParameterIssue,
): ModellixLocaleKey {
  return issue === "syntax" ? "invalidJson" : "invalidParameter";
}

export type JsonParameterParseResult =
  | { readonly status: "empty" }
  | { readonly status: "valid"; readonly value: ClientJsonValue }
  | { readonly status: "invalid"; readonly issue: JsonParameterIssue };

export function parseJsonParameterText(
  text: string,
  validate: (value: ClientJsonValue) => boolean,
): JsonParameterParseResult {
  if (text.trim() === "") return { status: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid", issue: "syntax" };
  }
  if (!isClientJsonValue(parsed) || !validate(parsed)) {
    return { status: "invalid", issue: "constraint" };
  }
  return { status: "valid", value: parsed };
}

function isClientJsonValue(value: unknown, depth = 0): value is ClientJsonValue {
  if (depth > 10) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 4_096 && value.every((item) => isClientJsonValue(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  return Object.entries(value).every(
    ([, item]) => isClientJsonValue(item, depth + 1),
  );
}
