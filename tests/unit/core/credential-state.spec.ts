import { describe, expect, it } from "vitest";

import {
  CredentialEpochConflictError,
  CredentialMutationCoordinator,
  applyCredentialDescriptor,
  applyRuntimeUnauthorized,
  applyVerificationResult,
  createCredentialState,
  preserveVerificationAfterTransientFailure,
} from "../../../src/core/credential-state.js";

const localDescriptor = {
  configured: true,
  source: "local" as const,
  writable: true,
  revision: "revision-1",
  credentialEpoch: 1,
};

describe("Credential state", () => {
  it("resets verification only when descriptor identity changes", () => {
    const initial = applyVerificationResult(
      createCredentialState(localDescriptor),
      1,
      "valid",
    ).state;

    expect(applyCredentialDescriptor(initial, localDescriptor).verification).toBe(
      "valid",
    );
    expect(
      applyCredentialDescriptor(initial, {
        ...localDescriptor,
        revision: "revision-2",
        credentialEpoch: 2,
      }).verification,
    ).toBe("unverified");
  });

  it("ignores stale verification and transient failures", () => {
    const state = createCredentialState(localDescriptor);

    expect(applyVerificationResult(state, 0, "invalid")).toEqual({
      state,
      stale: true,
    });
    expect(preserveVerificationAfterTransientFailure(state, 1)).toEqual({
      state,
      stale: false,
    });
  });

  it("coalesces concurrent 401 responses into one invalid epoch", () => {
    const state = createCredentialState(localDescriptor);
    const first = applyRuntimeUnauthorized(state, 1, 10_000);
    const second = applyRuntimeUnauthorized(first.state, 1, 10_001);

    expect(first.shouldOpenModal).toBe(true);
    expect(first.state.verification).toBe("invalid");
    expect(first.state.invalidEpoch).toEqual({
      credentialEpoch: 1,
      openedAt: 10_000,
    });
    expect(second.shouldOpenModal).toBe(false);
    expect(second.state).toBe(first.state);
  });

  it("does not let a stale 401 invalidate a replacement Credential", () => {
    const replacement = createCredentialState({
      ...localDescriptor,
      revision: "revision-2",
      credentialEpoch: 2,
    });
    const result = applyRuntimeUnauthorized(replacement, 1, 10_000);

    expect(result).toEqual({
      state: replacement,
      stale: true,
      shouldOpenModal: false,
    });
  });

  it("rejects an impossible writable environment descriptor", () => {
    expect(() =>
      createCredentialState({
        configured: true,
        source: "env",
        writable: true,
        revision: "env-revision",
        credentialEpoch: 0,
      }),
    ).toThrow("Environment Credential descriptors are read-only");
  });
});

describe("CredentialMutationCoordinator", () => {
  it("serializes writes and applies epoch CAS when dequeued", async () => {
    const coordinator = new CredentialMutationCoordinator(0);
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.run(0, async () => {
      events.push("first-start");
      await firstBarrier;
      events.push("first-end");
      return "first";
    });
    const staleSecond = coordinator.run(0, async () => {
      events.push("second-ran");
      return "second";
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst?.();

    await expect(first).resolves.toEqual({
      value: "first",
      previousEpoch: 0,
      credentialEpoch: 1,
    });
    await expect(staleSecond).rejects.toBeInstanceOf(
      CredentialEpochConflictError,
    );
    expect(events).toEqual(["first-start", "first-end"]);
    expect(coordinator.credentialEpoch).toBe(1);
  });

  it("does not advance the epoch after a failed Host operation", async () => {
    const coordinator = new CredentialMutationCoordinator(4);
    await expect(
      coordinator.run(4, async () => {
        throw new Error("host write failed");
      }),
    ).rejects.toThrow("host write failed");

    expect(coordinator.credentialEpoch).toBe(4);
    await expect(coordinator.run(4, async () => "ok")).resolves.toMatchObject({
      value: "ok",
      credentialEpoch: 5,
    });
  });
});
