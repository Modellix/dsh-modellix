import { WebError } from "@deepseek-ai/dsh-web";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ModellixWebFetchFailedError,
  ModellixWebProviderError,
  createModellixWebProviders,
  registerModellixWebProviders,
  type ModellixWebProviderOptions,
} from "../../../src/web/provider.js";

const USER_ID = "mdlx_u_test-user-12345678";

function searchEnvelope(): object {
  return {
    query: "query",
    depth: "standard",
    answer: null,
    results: [
      {
        title: "Source",
        url: "https://example.com/source",
        content: "Source content",
        summary: null,
        score: 1,
        published_at: null,
        favicon: null,
      },
    ],
    warnings: [],
    billing: { sku: "web-search.standard", amount_usd: 0.01 },
    request_id: "request-search-1",
  };
}

function fetchEnvelope(): object {
  return {
    results: [
      {
        url: "https://example.com/article",
        title: "Article",
        content: "Article content",
      },
    ],
    failed_results: [],
    billing: { sku: "web-fetch", success_count: 1, amount_usd: 0.002 },
    request_id: "request-fetch-1",
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(status: number, requestId = `request-${status}`): Response {
  return jsonResponse(
    { error: { code: "remote_error", message: "not reflected", request_id: requestId } },
    status,
  );
}

interface Harness {
  readonly options: ModellixWebProviderOptions;
  readonly fetchCalls: Array<{
    readonly input: string;
    readonly init?: RequestInit;
  }>;
  readonly resolveCredential: ReturnType<typeof vi.fn>;
  readonly rejected: ReturnType<typeof vi.fn>;
  setEnabled(value: boolean): void;
  setConfigured(value: boolean): void;
  setCurrentEpoch(value: number): void;
}

function createHarness(
  responder: (call: number, input: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<ModellixWebProviderOptions> = {},
): Harness {
  let enabled = true;
  let configured = true;
  let currentEpoch = 7;
  const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
  const resolveCredential = vi.fn(async () => ({
    apiKey: "test-key-only",
    credentialEpoch: currentEpoch,
  }));
  const rejected = vi.fn();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input.url;
    fetchCalls.push({ input: url, ...(init === undefined ? {} : { init }) });
    return responder(fetchCalls.length, url, init);
  };

  return {
    options: {
      isEnabled: () => enabled,
      hasCredential: () => configured,
      resolveCredential,
      getUserId: () => USER_ID,
      isCredentialEpochCurrent: (epoch) => epoch === currentEpoch,
      onCredentialRejected: rejected,
      fetchImpl,
      ...overrides,
    },
    fetchCalls,
    resolveCredential,
    rejected,
    setEnabled(value) {
      enabled = value;
    },
    setConfigured(value) {
      configured = value;
    },
    setCurrentEpoch(value) {
      currentEpoch = value;
    },
  };
}

function expectProviderError(
  value: unknown,
  code: string,
  epoch: number | null = 7,
): void {
  expect(value).toBeInstanceOf(ModellixWebProviderError);
  const error = value as ModellixWebProviderError;
  expect(error.code).toBe(code);
  expect(error.contract.credentialEpoch).toBe(epoch);
}

describe("Modellix native Web providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("available performs only cheap local switch, descriptor and identity checks", () => {
    const harness = createHarness(async () => jsonResponse(searchEnvelope()));
    const providers = createModellixWebProviders(harness.options);

    expect(providers.search.available()).toBe(true);
    expect(providers.fetch.available()).toBe(true);
    expect(harness.resolveCredential).not.toHaveBeenCalled();

    harness.setEnabled(false);
    expect(providers.search.available()).toBe(false);
    harness.setEnabled(true);
    harness.setConfigured(false);
    expect(providers.fetch.available()).toBe(false);
    expect(harness.resolveCredential).not.toHaveBeenCalled();
  });

  it("posts a standard-depth Search once and maps the response", async () => {
    const harness = createHarness(async () => jsonResponse(searchEnvelope()));
    const { search } = createModellixWebProviders(harness.options);

    await expect(search.search({ query: "query", maxResults: 8 })).resolves.toEqual({
      sources: [
        {
          url: "https://example.com/source",
          title: "Source",
          snippet: "Source content",
        },
      ],
      truncated: false,
    });
    expect(harness.fetchCalls).toHaveLength(1);
    const call = harness.fetchCalls[0];
    expect(call?.input).toBe("https://tool.modellix.ai/v1/web-search");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.redirect).toBe("manual");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      query: "query",
      depth: "standard",
      max_results: 8,
    });
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("x-mdlx-user-id")).toBe(USER_ID);
    expect(headers.get("authorization")).toBe("Bearer test-key-only");
  });

  it("resolves the Host Credential on every paid operation instead of caching it", async () => {
    let keyIndex = 0;
    const keys = ["first-test-key", "second-test-key"];
    const seenAuthorization: Array<string | null> = [];
    const harness = createHarness(async (_call, _input, init) => {
      seenAuthorization.push(new Headers(init?.headers).get("authorization"));
      return jsonResponse(searchEnvelope());
    });
    harness.resolveCredential.mockImplementation(async () => ({
      apiKey: keys[keyIndex++] ?? "unexpected-test-key",
      credentialEpoch: 7,
    }));
    const { search } = createModellixWebProviders(harness.options);

    await search.search({ query: "one", maxResults: 5 });
    await search.search({ query: "two", maxResults: 5 });

    expect(harness.resolveCredential).toHaveBeenCalledTimes(2);
    expect(seenAuthorization).toEqual([
      "Bearer first-test-key",
      "Bearer second-test-key",
    ]);
  });

  it("maps a successful single-URL Fetch with the documented compatibility semantics", async () => {
    const harness = createHarness(async () => jsonResponse(fetchEnvelope()));
    const { fetch } = createModellixWebProviders(harness.options);

    await expect(fetch.fetch({ url: "https://example.com/article" })).resolves.toEqual({
      url: "https://example.com/article",
      statusCode: 200,
      body: { kind: "text", content: "Article content" },
      truncated: false,
    });
    const call = harness.fetchCalls[0];
    expect(call?.input).toBe("https://tool.modellix.ai/v1/web-fetch");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      urls: ["https://example.com/article"],
    });
  });

  it("surfaces failed_results as a stable failure instead of a false HTTP 200", async () => {
    const harness = createHarness(async () =>
      jsonResponse({
        results: [],
        failed_results: [
          { url: "https://example.com/article", error: "remote detail" },
        ],
        billing: { sku: "web-fetch", success_count: 0, amount_usd: 0 },
        request_id: "request-fetch-failed",
      }),
    );
    const { fetch } = createModellixWebProviders(harness.options);

    const error = await fetch
      .fetch({ url: "https://example.com/article" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModellixWebFetchFailedError);
    expect((error as ModellixWebFetchFailedError).code).toBe(
      "MODELLIX_WEB_FETCH_FAILED",
    );
    expect((error as Error).message).not.toContain("remote detail");
  });

  it.each([
    [400, "MODELLIX_BAD_REQUEST"],
    [401, "MODELLIX_API_KEY_INVALID"],
    [402, "MODELLIX_BILLING_BLOCKED"],
    [429, "MODELLIX_RATE_LIMITED"],
    [500, "MODELLIX_SERVER_ERROR"],
    [503, "MODELLIX_SERVER_ERROR"],
  ] as const)("classifies HTTP %i without retrying", async (status, code) => {
    const harness = createHarness(async () => errorResponse(status));
    const { search } = createModellixWebProviders(harness.options);

    const error = await search
      .search({ query: "query", maxResults: 5 })
      .catch((caught: unknown) => caught);
    expectProviderError(error, code);
    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.rejected).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it("preserves Retry-After as structured 429 metadata", async () => {
    const harness = createHarness(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            message: "not reflected",
            request_id: "request-rate-limit",
          },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "3",
          },
        },
      ),
    );
    const { search } = createModellixWebProviders(harness.options);

    const error = await search
      .search({ query: "query", maxResults: 5 })
      .catch((caught: unknown) => caught) as ModellixWebProviderError;
    expect(error.contract).toMatchObject({
      code: "MODELLIX_RATE_LIMITED",
      requestId: "request-rate-limit",
      retryAfterMs: 3_000,
      retryable: true,
    });
  });

  it("classifies a transport failure without reflecting or retrying it", async () => {
    const harness = createHarness(async () => {
      throw new Error("authorization=Bearer should-never-be-reflected");
    });
    const { search } = createModellixWebProviders(harness.options);

    const error = await search
      .search({ query: "query", maxResults: 5 })
      .catch((caught: unknown) => caught);
    expectProviderError(error, "MODELLIX_OFFLINE");
    expect((error as Error).message).not.toContain("Bearer");
    expect(JSON.stringify((error as ModellixWebProviderError).diagnostic)).not.toContain(
      "should-never-be-reflected",
    );
    expect(harness.fetchCalls).toHaveLength(1);
  });

  it("does not let a stale 401 invalidate a newer Credential epoch", async () => {
    const harness = createHarness(async () => {
      harness.setCurrentEpoch(8);
      return errorResponse(401, "request-stale-401");
    });
    harness.resolveCredential.mockResolvedValue({
      apiKey: "old-test-key",
      credentialEpoch: 7,
    });
    const { search } = createModellixWebProviders(harness.options);

    const error = await search
      .search({ query: "query", maxResults: 5 })
      .catch((caught: unknown) => caught);
    expectProviderError(error, "MODELLIX_API_KEY_INVALID", 7);
    expect(harness.rejected).not.toHaveBeenCalled();
  });

  it("rejects every credential-bearing redirect and never follows it", async () => {
    const harness = createHarness(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/collect" },
      }),
    );
    const { search } = createModellixWebProviders(harness.options);

    const error = await search
      .search({ query: "query", maxResults: 5 })
      .catch((caught: unknown) => caught);
    expectProviderError(error, "MODELLIX_UNEXPECTED_RESPONSE");
    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.fetchCalls[0]?.init?.redirect).toBe("manual");
  });

  it.each([
    new Response("not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify(searchEnvelope()), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
  ])("rejects malformed success response %#", async (response) => {
    const harness = createHarness(async () => response.clone());
    const { search } = createModellixWebProviders(harness.options);

    const error = await search
      .search({ query: "query", maxResults: 5 })
      .catch((caught: unknown) => caught);
    expectProviderError(error, "MODELLIX_UNEXPECTED_RESPONSE");
  });

  it("stops reading a response that exceeds the configured byte boundary", async () => {
    const harness = createHarness(
      async () =>
        new Response(JSON.stringify(searchEnvelope()), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "4096",
          },
        }),
      { maxResponseBytes: 128 },
    );
    const { search } = createModellixWebProviders(harness.options);

    const error = await search
      .search({ query: "query", maxResults: 5 })
      .catch((caught: unknown) => caught);
    expectProviderError(error, "MODELLIX_UNEXPECTED_RESPONSE");
    expect(harness.fetchCalls).toHaveLength(1);
  });

  it("enforces the byte boundary even when Content-Length is absent", async () => {
    const harness = createHarness(
      async () =>
        new Response("x".repeat(512), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { maxResponseBytes: 128 },
    );
    const { search } = createModellixWebProviders(harness.options);

    const error = await search
      .search({ query: "query", maxResults: 5 })
      .catch((caught: unknown) => caught);
    expectProviderError(error, "MODELLIX_UNEXPECTED_RESPONSE");
    expect(harness.fetchCalls).toHaveLength(1);
  });

  it("maps preflight and in-flight cancellation without issuing a retry", async () => {
    const preflightHarness = createHarness(async () => jsonResponse(searchEnvelope()));
    const preflight = createModellixWebProviders(preflightHarness.options).search;
    const preflightController = new AbortController();
    preflightController.abort();
    const preflightError = await preflight
      .search({ query: "query", maxResults: 5 }, preflightController.signal)
      .catch((caught: unknown) => caught);
    expectProviderError(preflightError, "MODELLIX_CANCELED", null);
    expect(preflightHarness.fetchCalls).toHaveLength(0);

    const inFlightHarness = createHarness(async (_call, _input, init) => {
      if (init?.signal?.aborted === true) {
        throw new DOMException("aborted", "AbortError");
      }
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      return jsonResponse(searchEnvelope());
    });
    const inFlight = createModellixWebProviders(inFlightHarness.options).search;
    const inFlightController = new AbortController();
    const pending = inFlight.search(
      { query: "query", maxResults: 5 },
      inFlightController.signal,
    );
    inFlightController.abort();
    const inFlightError = await pending.catch((caught: unknown) => caught);
    expectProviderError(inFlightError, "MODELLIX_CANCELED");
    expect(inFlightHarness.fetchCalls).toHaveLength(1);
  });

  it("blocks invalid local input and switch/key races before a paid POST", async () => {
    const harness = createHarness(async () => jsonResponse(searchEnvelope()));
    const providers = createModellixWebProviders(harness.options);

    const invalid = await providers.fetch
      .fetch({ url: "file:///private" })
      .catch((caught: unknown) => caught);
    expectProviderError(invalid, "MODELLIX_BAD_REQUEST", null);
    expect(harness.fetchCalls).toHaveLength(0);

    harness.setEnabled(false);
    await expect(providers.search.search({ query: "query" })).rejects.toMatchObject({
      code: "WEB_PROVIDER_UNAVAILABLE",
    });
    harness.setEnabled(true);
    harness.resolveCredential.mockResolvedValue(null);
    await expect(providers.search.search({ query: "query" })).rejects.toMatchObject({
      code: "WEB_PROVIDER_UNAVAILABLE",
    });
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("registers both native providers and rolls back an incomplete registration", () => {
    const harness = createHarness(async () => jsonResponse(searchEnvelope()));
    const disposeSearch = vi.fn();
    const disposeFetch = vi.fn();
    const registry = {
      registerSearchProvider: vi.fn(() => disposeSearch),
      registerFetchProvider: vi.fn(() => disposeFetch),
    };

    const dispose = registerModellixWebProviders(registry, harness.options);
    expect(registry.registerSearchProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "modellix" }),
    );
    expect(registry.registerFetchProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "modellix" }),
    );
    dispose();
    expect(disposeFetch).toHaveBeenCalledTimes(1);
    expect(disposeSearch).toHaveBeenCalledTimes(1);

    const brokenRegistry = {
      registerSearchProvider: vi.fn(() => disposeSearch),
      registerFetchProvider: vi.fn(() => {
        throw new WebError("duplicate", "WEB_DUPLICATE_PROVIDER");
      }),
    };
    expect(() => registerModellixWebProviders(brokenRegistry, harness.options)).toThrow(
      WebError,
    );
    expect(disposeSearch).toHaveBeenCalledTimes(2);
  });
});
