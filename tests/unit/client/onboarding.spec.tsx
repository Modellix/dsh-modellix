import { describe, expect, it } from "vitest";

import type { SettingsSnapshotWire } from "../../../src/client/contracts.js";
import { shouldPromptOnboarding } from "../../../src/client/onboarding-state.js";

type PromptState = Pick<SettingsSnapshotWire, "credential" | "onboarding">;

function state(overrides: {
  readonly configured?: boolean;
  readonly verification?: PromptState["credential"]["verification"];
  readonly status?: PromptState["onboarding"]["status"];
  readonly recoveryPending?: boolean;
} = {}): PromptState {
  const configured = overrides.configured ?? false;
  return {
    credential: {
      configured,
      source: configured ? "local" : null,
      writable: true,
      revision: configured ? 1 : null,
      credentialEpoch: configured ? 1 : 0,
      verification: overrides.verification ?? "unknown",
      invalidEpoch: null,
    },
    onboarding: {
      status: overrides.status ?? "active",
      recoveryPending: overrides.recoveryPending ?? false,
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

  it("does not prompt for a usable Credential and reopens for invalid state", () => {
    expect(shouldPromptOnboarding(state({ configured: true }))).toBe(false);
    expect(
      shouldPromptOnboarding(
        state({ configured: true, verification: "invalid" }),
      ),
    ).toBe(true);
  });
});
