import { describe, expect, it } from "vitest";

import {
  isCredentialInvalidError,
  toModellixError,
  type ModellixErrorCode,
} from "../../../src/core/errors.js";

const context = {
  service: "design" as const,
  subsystem: "generation",
  operation: "submit",
  credentialEpoch: 3,
  taskId: "task-public-1",
};

describe("stable error mapping", () => {
  it.each<[number, ModellixErrorCode, boolean]>([
    [400, "MODELLIX_BAD_REQUEST", false],
    [401, "MODELLIX_API_KEY_INVALID", false],
    [402, "MODELLIX_BILLING_BLOCKED", false],
    [403, "MODELLIX_POLICY_BLOCKED", false],
    [404, "MODELLIX_RESOURCE_NOT_FOUND", false],
    [408, "MODELLIX_TIMEOUT", true],
    [429, "MODELLIX_RATE_LIMITED", true],
    [500, "MODELLIX_SERVER_ERROR", true],
    [504, "MODELLIX_TIMEOUT", true],
  ])("maps HTTP %i to %s", (status, code, retryable) => {
    const error = toModellixError(context, {
      kind: "http",
      status,
      requestId: "request-1",
      retryAfterMs: status === 429 ? 500 : null,
    });

    expect(error).toMatchObject({
      version: 1,
      code,
      httpStatus: status,
      retryable,
      credentialEpoch: 3,
      requestId: "request-1",
      taskId: "task-public-1",
    });
    expect(error.messageKey).toMatch(/^modellix\.error\./);
  });

  it("keeps candidate rejection separate from the stored Credential", () => {
    const error = toModellixError(context, { kind: "candidate-invalid" });

    expect(error.code).toBe("MODELLIX_CANDIDATE_KEY_INVALID");
    expect(isCredentialInvalidError(error)).toBe(false);
  });

  it("distinguishes submit uncertainty from a server failure", () => {
    const error = toModellixError(context, { kind: "submit-unknown" });

    expect(error).toMatchObject({
      code: "MODELLIX_SUBMIT_UNKNOWN",
      retryable: false,
      httpStatus: null,
    });
  });

  it("drops malformed correlation IDs instead of reflecting them", () => {
    const error = toModellixError(
      { ...context, taskId: "unsafe\nvalue" },
      {
        kind: "http",
        status: 500,
        requestId: "unsafe request value",
      },
    );

    expect(error.requestId).toBeNull();
    expect(error.taskId).toBeNull();
  });

  it("does not classify policy or billing failures as invalid Key", () => {
    for (const status of [402, 403, 429]) {
      expect(
        isCredentialInvalidError(
          toModellixError(context, { kind: "http", status }),
        ),
      ).toBe(false);
    }
  });
});
