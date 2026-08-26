import type { ModellixLocaleKey } from "./locales.js";

export interface ClientErrorPresentation {
  readonly messageKey: ModellixLocaleKey;
  readonly credentialFieldInvalid: boolean;
}

/** Maps stable Host/RPC codes to user-facing recovery states without exposing prose. */
export function presentClientError(code: string): ClientErrorPresentation {
  switch (code) {
    case "settings-changed":
    case "credential-changed":
      return presentation("errorConflict");
    case "MODELLIX_CANDIDATE_KEY_INVALID":
    case "MODELLIX_API_KEY_INVALID":
    case "MODELLIX_UNAUTHORIZED":
      return presentation("errorKeyInvalid", true);
    case "MODELLIX_BILLING_BLOCKED":
      return presentation("errorBilling");
    case "MODELLIX_RATE_LIMITED":
      return presentation("errorRateLimited");
    case "MODELLIX_OFFLINE":
    case "transport":
      return presentation("errorOffline");
    case "MODELLIX_TIMEOUT":
      return presentation("errorTimeout");
    case "MODELLIX_SERVER_ERROR":
      return presentation("errorServer");
    case "MODELLIX_POLICY_BLOCKED":
      return presentation("errorPolicy");
    case "MODELLIX_API_KEY_REQUIRED":
      return presentation("keyRequired");
    case "MODELLIX_DESIGN_INPUT_INVALID":
      return presentation("parametersInvalid");
    case "MODELLIX_DESIGN_SCHEMA_INVALID":
      return presentation("errorDesignSchema");
    case "MODELLIX_DESIGN_CATALOG_UNAVAILABLE":
    case "MODELLIX_DESIGN_SCHEMA_UNAVAILABLE":
      return presentation("errorServer");
    case "MODELLIX_SUBMIT_UNKNOWN":
      return presentation("errorSubmitUnknown");
    case "MODELLIX_ASSET_EXPIRED":
      return presentation("errorAssetExpired");
    default:
      return presentation("errorGeneric");
  }
}

function presentation(
  messageKey: ModellixLocaleKey,
  credentialFieldInvalid = false,
): ClientErrorPresentation {
  return { messageKey, credentialFieldInvalid };
}
