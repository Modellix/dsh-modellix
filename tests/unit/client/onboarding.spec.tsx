import { describe, expect, it } from "vitest";

import type { SettingsSnapshotWire } from "../../../src/client/contracts.js";
import { shouldPromptOnboarding } from "../../../src/client/onboarding-state.js";

type PromptState = Pick<SettingsSnapshotWire, "credential" | "onboarding">;

function state(overrides: {
  readonly configured?: boolean;
  readonly verification?: PromptState["credential"]["verification"];
  readonly status?: PromptState["onboarding"]["status"];
  readonly recoveryPending?: boolean;
  readonly recoveryRequestId?: string | null;
  readonly writable?: boolean;
  readonly source?: PromptState["credential"]["source"];
} = {}): PromptState {
  const configured = overrides.configured ?? false;
  const writable = overrides.writable ?? true;
  return {
    credential: {
      configured,
      source: configured ? (overrides.source ?? (writable ? "local" : "env")) : null,
      writable,
      revision: configured ? "epoch:1" : null,
      credentialEpoch: configured ? 1 : 0,
      verification: overrides.verification ?? "unknown",
      invalidEpoch: null,
    },
    onboarding: {
      status: overrides.status ?? "active",
      recoveryPending: overrides.recoveryPending ?? false,
      recoveryRequestId: overrides.recoveryRequestId ?? null,
    },
  };
}

describe("Modellix onboarding prompt state", () => {
  it("prompts a fresh installation with no Credential", () => {
    expect(shouldPromptOnboarding(state())).toBe(true);
  });

  it("respects a deferred prompt until a capability requests recovery", () => {
    expect(shouldPromptOnboarding(state({ status: "deferred" }))).toBe(false);
    expect(
      shouldPromptOnboarding(
        state({ status: "deferred", recoveryPending: true }),
      ),
    ).toBe(true);
  });

  it("leaves invalid-Credential recovery to the single shell overlay", () => {
    expect(shouldPromptOnboarding(state({ configured: true }))).toBe(false);
    expect(
      shouldPromptOnboarding(
        state({ configured: true, verification: "invalid" }),
      ),
    ).toBe(false);
    expect(
      shouldPromptOnboarding(
        state({ status: "deferred", recoveryRequestId: "recovery_current" }),
      ),
    ).toBe(false);
  });

  it("leaves invalid read-only environment recovery to the shell overlay", () => {
    const invalidEnvironment = {
      configured: true,
      source: "env" as const,
      writable: false,
      verification: "invalid" as const,
    };
    expect(shouldPromptOnboarding(state(invalidEnvironment))).toBe(false);
    expect(
      shouldPromptOnboarding(
        state({ ...invalidEnvironment, status: "deferred" }),
      ),
    ).toBe(false);
  });
});
