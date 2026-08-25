import { describe, expect, it } from "vitest";

import {
  deriveModellixSessionId,
  deriveModellixUserId,
  isValidModellixIdentity,
} from "../../../src/core/identity.js";

describe("anonymous identity derivation", () => {
  it("is deterministic, bounded, and never returns the raw Harness ID", () => {
    const raw = "synthetic-harness-anonymous-user-123";
    const first = deriveModellixUserId(raw);
    const second = deriveModellixUserId(raw);

    expect(first).toBe(second);
    expect(first).not.toContain(raw);
    expect(first.startsWith("mdlx_u_")).toBe(true);
    expect(isValidModellixIdentity(first)).toBe(true);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it("domain-separates user and session identities", () => {
    const raw = "synthetic-stable-id";
    const user = deriveModellixUserId(raw);
    const session = deriveModellixSessionId(raw);

    expect(session.startsWith("mdlx_s_")).toBe(true);
    expect(session).not.toBe(user);
    expect(isValidModellixIdentity(session)).toBe(true);
  });

  it("changes when the source identity changes", () => {
    expect(deriveModellixUserId("user-a")).not.toBe(
      deriveModellixUserId("user-b"),
    );
  });

  it.each(["", "   "])("rejects an empty source identity", (value) => {
    expect(() => deriveModellixUserId(value)).toThrow(TypeError);
  });
});
