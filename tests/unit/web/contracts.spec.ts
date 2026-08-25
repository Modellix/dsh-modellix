import { describe, expect, it } from "vitest";

import {
  ModellixWebContractError,
  buildFetchRequest,
  buildSearchRequest,
  parseFetchResponse,
  parseSearchResponse,
} from "../../../src/web/contracts.js";

function searchEnvelope(overrides: Record<string, unknown> = {}): object {
  return {
    query: "current weather",
    depth: "standard",
    answer: "A short answer",
    results: [
      {
        title: "First source",
        url: "https://example.com/first",
        content: "Full first result text",
        summary: "First summary",
        score: 0.9,
        published_at: "2026-08-25",
        favicon: null,
      },
      {
        title: "Second source",
        url: "https://example.com/second",
        content: "Second fallback snippet",
        summary: null,
        score: 0.8,
        published_at: null,
        favicon: "https://example.com/favicon.ico",
      },
    ],
    warnings: [],
    billing: { sku: "web-search.standard", amount_usd: 0.01 },
    request_id: "request-search-1",
    ...overrides,
  };
}

function fetchEnvelope(overrides: Record<string, unknown> = {}): object {
  return {
    results: [
      {
        url: "https://example.com/article",
        title: "Article",
        content: "Readable article content",
      },
    ],
    failed_results: [],
    billing: { sku: "web-fetch", success_count: 1, amount_usd: 0.002 },
    request_id: "request-fetch-1",
    ...overrides,
  };
}

describe("Modellix Web wire contracts", () => {
  it("maps the Harness search input to the fixed standard-depth API request", () => {
    expect(buildSearchRequest("  a query  ", 8)).toEqual({
      query: "  a query  ",
      depth: "standard",
      max_results: 8,
    });
    expect(buildSearchRequest("query", undefined).max_results).toBe(5);
  });

  it.each([
    ["", 5],
    ["   ", 5],
    ["query", 0],
    ["query", 21],
    ["query", 1.5],
  ] as const)("rejects invalid search input %#", (query, maxResults) => {
    expect(() => buildSearchRequest(query, maxResults)).toThrow(
      ModellixWebContractError,
    );
  });

  it("normalizes a single public Fetch URL and rejects unsafe URL forms", () => {
    expect(buildFetchRequest("https://example.com")).toEqual({
      urls: ["https://example.com/"],
    });
    expect(() => buildFetchRequest("file:///etc/passwd")).toThrow(
      ModellixWebContractError,
    );
    expect(() => buildFetchRequest("https://user@example.com/")).toThrow(
      ModellixWebContractError,
    );
  });

  it("maps search answer and sources without forwarding billing-only fields", () => {
    const parsed = parseSearchResponse(JSON.stringify(searchEnvelope()), 8);

    expect(parsed).toEqual({
      requestId: "request-search-1",
      result: {
        content: "A short answer",
        truncated: false,
        sources: [
          {
            url: "https://example.com/first",
            title: "First source",
            snippet: "First summary",
            publishedAt: "2026-08-25",
          },
          {
            url: "https://example.com/second",
            title: "Second source",
            snippet: "Second fallback snippet",
          },
        ],
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("amount_usd");
    expect(JSON.stringify(parsed)).not.toContain("favicon");
    expect(JSON.stringify(parsed)).not.toContain("score");
  });

  it("caps over-returned search sources and marks the result truncated", () => {
    const parsed = parseSearchResponse(JSON.stringify(searchEnvelope()), 1);

    expect(parsed.result.sources).toHaveLength(1);
    expect(parsed.result.truncated).toBe(true);
  });

  it.each([
    "not json",
    JSON.stringify(searchEnvelope({ depth: "rich" })),
    JSON.stringify(searchEnvelope({ request_id: "unsafe request id" })),
    JSON.stringify(searchEnvelope({ results: "not-an-array" })),
    JSON.stringify(
      searchEnvelope({ billing: { sku: "web-search.rich", amount_usd: 0.01 } }),
    ),
  ])("rejects a malformed Search response %#", (payload) => {
    expect(() => parseSearchResponse(payload, 5)).toThrow(
      ModellixWebContractError,
    );
  });

  it("maps a successful single-URL Fetch result to the required Harness shape", () => {
    const parsed = parseFetchResponse(JSON.stringify(fetchEnvelope()));

    expect(parsed).toEqual({
      kind: "success",
      requestId: "request-fetch-1",
      result: {
        url: "https://example.com/article",
        statusCode: 200,
        body: { kind: "text", content: "Readable article content" },
        truncated: false,
      },
    });
  });

  it("keeps failed_results distinct from a successful Fetch result", () => {
    const parsed = parseFetchResponse(
      JSON.stringify(
        fetchEnvelope({
          results: [],
          failed_results: [
            { url: "https://example.com/article", error: "upstream timeout" },
          ],
          billing: { sku: "web-fetch", success_count: 0, amount_usd: 0 },
        }),
      ),
    );

    expect(parsed).toEqual({ kind: "failure", requestId: "request-fetch-1" });
  });

  it.each([
    JSON.stringify(fetchEnvelope({ results: [], failed_results: [] })),
    JSON.stringify(
      fetchEnvelope({
        results: [],
        failed_results: [
          { url: "https://example.com/one", error: "one" },
          { url: "https://example.com/two", error: "two" },
        ],
        billing: { sku: "web-fetch", success_count: 0, amount_usd: 0 },
      }),
    ),
    JSON.stringify(
      fetchEnvelope({
        billing: { sku: "web-fetch", success_count: 0, amount_usd: 0 },
      }),
    ),
  ])("rejects an inconsistent single-URL Fetch envelope %#", (payload) => {
    expect(() => parseFetchResponse(payload)).toThrow(
      ModellixWebContractError,
    );
  });
});
