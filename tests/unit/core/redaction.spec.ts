import { describe, expect, it } from "vitest";

import {
  REDACTED,
  redactForLog,
  redactHeaders,
  redactUrl,
} from "../../../src/core/redaction.js";

describe("redaction", () => {
  it("removes sensitive headers without exposing a derived identifier", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer synthetic-secret",
        Cookie: "session=synthetic-secret",
        "Set-Cookie": "session=synthetic-secret",
        Accept: "application/json",
      }),
    ).toEqual({
      Authorization: REDACTED,
      Cookie: REDACTED,
      "Set-Cookie": REDACTED,
      Accept: "application/json",
    });
  });

  it("strips complete query, fragment, and userinfo from URLs", () => {
    expect(
      redactUrl(
        "https://user:pass@cdn.example.test/result.png?signature=secret#preview",
      ),
    ).toBe("https://cdn.example.test/result.png");
  });

  it("recursively redacts Secret-shaped fields and URL queries", () => {
    const value = redactForLog({
      apiKey: "synthetic-key",
      credentialEpoch: 4,
      nested: {
        access_token: "synthetic-token",
        resultUrl: "https://cdn.example.test/result?sig=synthetic-signature",
      },
      headers: {
        authorization: "Bearer synthetic-key",
        accept: "application/json",
      },
    });

    expect(value).toEqual({
      apiKey: REDACTED,
      credentialEpoch: 4,
      headers: {
        accept: "application/json",
        authorization: REDACTED,
      },
      nested: {
        access_token: REDACTED,
        resultUrl: "https://cdn.example.test/result",
      },
    });
    expect(JSON.stringify(value)).not.toContain("synthetic-key");
    expect(JSON.stringify(value)).not.toContain("synthetic-token");
    expect(JSON.stringify(value)).not.toContain("synthetic-signature");
  });

  it("does not copy Error messages or stacks", () => {
    expect(redactForLog(new Error("candidate synthetic-key leaked"))).toEqual({
      name: "Error",
      message: REDACTED,
    });
  });

  it("bounds cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(redactForLog(cyclic)).toEqual({ self: "[CIRCULAR]" });
  });
});
