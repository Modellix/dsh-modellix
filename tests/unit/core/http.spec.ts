import { describe, expect, it, vi } from "vitest";

import {
  HttpPolicyError,
  approveHttpRequest,
  approveRedirect,
  computeRetryDelay,
  executeWithRetry,
  isRetryableReadFailure,
  parseRetryAfter,
  retryAfterFromFailure,
  type HttpRetryFailure,
} from "../../../src/core/http.js";

describe("HTTP origin policy", () => {
  it.each([
    ["https://api.modellix.ai/api/v1/models", "prediction"],
    ["https://llm.modellix.ai/v1/models", "llm"],
    ["https://tool.modellix.ai/v1/web-search", "webTools"],
  ] as const)("allows fixed Modellix origin %s", (url, originName) => {
    expect(
      approveHttpRequest({ url, method: "GET", hasAuthorization: true }),
    ).toMatchObject({ originName, authorizationAllowed: true });
  });

  it("allows public Schema GET only without Authorization", () => {
    const url = "https://www.modellix.ai/models/openai/gpt-image-2/api_schema";
    expect(
      approveHttpRequest({ url, method: "GET", hasAuthorization: false }),
    ).toMatchObject({
      originName: "publicSchema",
      authorizationAllowed: false,
    });

    expect(() =>
      approveHttpRequest({ url, method: "GET", hasAuthorization: true }),
    ).toThrowError(HttpPolicyError);
    expect(() =>
      approveHttpRequest({ url, method: "POST", hasAuthorization: false }),
    ).toThrowError(HttpPolicyError);
  });

  it.each([
    "https://api.modellix.ai.evil.example/api/v1/models",
    "https://user@api.modellix.ai/api/v1/models",
    "http://api.modellix.ai/api/v1/models",
    "https://api.modellix.ai/api/v1/models#fragment",
  ])("rejects unsafe URL %s", (url) => {
    expect(() =>
      approveHttpRequest({ url, method: "GET", hasAuthorization: false }),
    ).toThrowError(HttpPolicyError);
  });

  it("rejects cross-origin redirects even between allowed origins", () => {
    expect(() =>
      approveRedirect(
        "https://api.modellix.ai/api/v1/models",
        "https://llm.modellix.ai/v1/models",
        { method: "GET", hasAuthorization: true },
      ),
    ).toThrowError("Cross-origin redirects are not allowed");
  });
});

describe("bounded retry", () => {
  it("retries read failures with Retry-After and stops at success", async () => {
    const failure: HttpRetryFailure = {
      kind: "http",
      status: 429,
      retryAfterMs: 2_000,
    };
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn<(delay: number) => Promise<void>>().mockResolvedValue();

    await expect(
      executeWithRetry(operation, {
        method: "GET",
        maxRetries: 2,
        shouldRetry: isRetryableReadFailure,
        retryAfterMs: retryAfterFromFailure,
        sleep,
        random: () => 0.5,
      }),
    ).resolves.toEqual({ value: "ok", attempts: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("never permits automatic retries for a paid POST", async () => {
    await expect(
      executeWithRetry(async () => "unused", {
        method: "POST",
        maxRetries: 1,
        shouldRetry: () => true,
      }),
    ).rejects.toThrow("Automatic retries are only allowed for GET or HEAD");
  });

  it("does not retry Abort", () => {
    expect(isRetryableReadFailure({ kind: "abort" })).toBe(false);
  });

  it("uses bounded exponential jitter without going below Retry-After", () => {
    expect(
      computeRetryDelay({
        retryIndex: 2,
        baseDelayMs: 250,
        maxDelayMs: 5_000,
        jitterRatio: 0.2,
        retryAfterMs: 2_000,
        random: 0,
      }),
    ).toBe(2_000);
  });

  it("parses both forms of Retry-After", () => {
    expect(parseRetryAfter("3", 0)).toBe(3_000);
    expect(
      parseRetryAfter("Thu, 01 Jan 1970 00:00:04 GMT", 1_000),
    ).toBe(3_000);
    expect(parseRetryAfter("not-a-date", 0)).toBeNull();
  });
});
