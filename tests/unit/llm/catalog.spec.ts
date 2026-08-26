import { describe, expect, it, vi } from "vitest";

import {
  LlmCatalogCache,
  LlmCatalogClient,
  LlmCatalogRequestError,
  StaleLlmCatalogError,
} from "../../../src/llm/catalog.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Modellix LLM catalog", () => {
  it("loads and validates full provider/name model IDs", async () => {
    let request: { input: string | URL | Request; init: RequestInit | undefined } | undefined;
    const client = new LlmCatalogClient({
      resolveCredential: async () => ({ value: "candidate-key", credentialEpoch: 4 }),
      now: () => 123,
      fetch: async (input, init) => {
        request = { input, init };
        return jsonResponse({ data: [
          { id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol" },
          { id: "anthropic/claude-sonnet-5" },
        ] });
      },
    });

    await expect(client.fetchModels()).resolves.toEqual({
      models: [
        { id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol" },
        { id: "anthropic/claude-sonnet-5" },
      ],
      credentialEpoch: 4,
      fetchedAt: 123,
    });
    expect(request?.input).toBe("https://llm.modellix.ai/v1/models");
    expect(request?.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer candidate-key");
  });

  it("classifies an explicit 401 without exposing response text", async () => {
    const client = new LlmCatalogClient({
      resolveCredential: async () => ({ value: "private", credentialEpoch: 2 }),
      fetch: async () => new Response("private upstream detail", { status: 401 }),
    });
    const error = await client.fetchModels().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LlmCatalogRequestError);
    expect((error as LlmCatalogRequestError).contract).toMatchObject({
      code: "MODELLIX_API_KEY_INVALID",
      credentialEpoch: 2,
    });
    expect(String(error)).not.toContain("private upstream detail");
  });

  it("rejects redirects, malformed IDs, empty lists, and oversized bodies", async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: "https://example.test" } }),
      jsonResponse({ data: [{ id: "missing-provider" }] }),
      jsonResponse({ data: [] }),
      jsonResponse({ data: [{ id: "openai/gpt" }] }, { headers: { "content-length": "999" } }),
    ];
    const client = new LlmCatalogClient({
      resolveCredential: async () => ({ value: "private", credentialEpoch: 1 }),
      maxResponseBytes: 100,
      fetch: async () => responses.shift()!,
    });
    for (let index = 0; index < 4; index += 1) {
      await expect(client.fetchModels()).rejects.toMatchObject({
        contract: { code: "MODELLIX_UNEXPECTED_RESPONSE" },
      });
    }
  });

  it("bounds a chunked catalog response without Content-Length", async () => {
    let canceled = false;
    const client = new LlmCatalogClient({
      resolveCredential: async () => ({ value: "private", credentialEpoch: 1 }),
      maxResponseBytes: 100,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array(80));
          stream.enqueue(new Uint8Array(80));
        },
        cancel() {
          canceled = true;
        },
      })),
    });

    await expect(client.fetchModels()).rejects.toMatchObject({
      contract: { code: "MODELLIX_UNEXPECTED_RESPONSE" },
    });
    expect(canceled).toBe(true);
  });

  it("cancels a stalled catalog body", async () => {
    let canceled = false;
    const controller = new AbortController();
    const client = new LlmCatalogClient({
      resolveCredential: async () => ({ value: "private", credentialEpoch: 1 }),
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      })),
    });
    const loading = client.fetchModels(controller.signal);

    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(canceled).toBe(true);
  });

  it("deduplicates repeated model IDs deterministically", async () => {
    const client = new LlmCatalogClient({
      resolveCredential: async () => ({ value: "private", credentialEpoch: 1 }),
      fetch: async () => jsonResponse({ data: [
        { id: "openai/gpt", name: "First" },
        { id: "openai/gpt", name: "Second" },
      ] }),
    });
    await expect(client.fetchModels()).resolves.toMatchObject({
      models: [{ id: "openai/gpt", name: "First" }],
    });
  });

  it("single-flights and caches only the requested Credential epoch", async () => {
    let now = 10;
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: "openai/gpt" }] }));
    const client = new LlmCatalogClient({
      resolveCredential: async () => ({ value: "private", credentialEpoch: 3 }),
      fetch,
      now: () => now,
    });
    const cache = new LlmCatalogCache(client, { ttlMs: 100, now: () => now });
    const [left, right] = await Promise.all([cache.get(3), cache.get(3)]);
    expect(left).toBe(right);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.get(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 111;
    await cache.get(3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a response captured after the Credential epoch changed", async () => {
    const client = new LlmCatalogClient({
      resolveCredential: async () => ({ value: "new-private", credentialEpoch: 8 }),
      fetch: async () => jsonResponse({ data: [{ id: "openai/gpt" }] }),
    });
    const cache = new LlmCatalogCache(client);
    await expect(cache.get(7)).rejects.toBeInstanceOf(StaleLlmCatalogError);
    expect(cache.peek(7)).toBeUndefined();
  });
});
