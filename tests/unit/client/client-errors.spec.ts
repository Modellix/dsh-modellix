import { describe, expect, it } from "vitest";

import { presentClientError } from "../../../src/client/client-errors.js";

describe("Modellix Client error presentation", () => {
  it("marks only explicit Credential failures as field-invalid", () => {
    for (const code of [
      "MODELLIX_CANDIDATE_KEY_INVALID",
      "MODELLIX_API_KEY_INVALID",
      "MODELLIX_UNAUTHORIZED",
    ]) {
      expect(presentClientError(code)).toEqual({
        messageKey: "errorKeyInvalid",
        credentialFieldInvalid: true,
      });
    }

    for (const code of [
      "MODELLIX_BILLING_BLOCKED",
      "MODELLIX_RATE_LIMITED",
      "MODELLIX_OFFLINE",
      "MODELLIX_TIMEOUT",
      "MODELLIX_SERVER_ERROR",
      "transport",
    ]) {
      expect(presentClientError(code).credentialFieldInvalid).toBe(false);
    }
  });

  it("keeps recovery categories distinct", () => {
    expect(presentClientError("MODELLIX_BILLING_BLOCKED").messageKey).toBe(
      "errorBilling",
    );
    expect(presentClientError("MODELLIX_RATE_LIMITED").messageKey).toBe(
      "errorRateLimited",
    );
    expect(presentClientError("MODELLIX_OFFLINE").messageKey).toBe(
      "errorOffline",
    );
    expect(presentClientError("MODELLIX_TIMEOUT").messageKey).toBe(
      "errorTimeout",
    );
    expect(presentClientError("MODELLIX_SERVER_ERROR").messageKey).toBe(
      "errorServer",
    );
    expect(presentClientError("settings-changed").messageKey).toBe(
      "errorConflict",
    );
    expect(presentClientError("MODELLIX_API_KEY_REQUIRED").messageKey).toBe(
      "keyRequired",
    );
    expect(presentClientError("MODELLIX_DESIGN_INPUT_INVALID").messageKey).toBe(
      "parametersInvalid",
    );
    expect(presentClientError("MODELLIX_DESIGN_SCHEMA_INVALID").messageKey).toBe(
      "errorDesignSchema",
    );
  });
});
