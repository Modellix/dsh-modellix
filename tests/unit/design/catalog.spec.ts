import { describe, expect, it, vi } from "vitest";

import {
  AUTHENTICATED_CATALOG_URL,
  ModelCatalogClient,
  PUBLIC_PORTAL_CATALOG_URL,
} from "../../../src/design/catalog.js";
import { DesignError } from "../../../src/design/errors.js";
import type { CachePort, FetchPort } from "../../../src/design/ports.js";

describe("ModelCatalogClient", () => {
  it("uses the authenticated catalog with a dynamically resolved key", async () => {
    const fetchMock = vi.fn<FetchPort>().mockResolvedValue(
      jsonResponse({
        data: {
          models: [
            {
              provider: "openai",
              model_id: "gpt-image-2",
              display_name: "GPT Image 2",
              category: "image",
            },
          ],
          total: 30,
          page: 2,
          page_size: 10,
        },
      }),
    );
    const getApiKey = vi.fn<() => string>().mockReturnValue("key-current");
    const client = new ModelCatalogClient({ fetch: fetchMock, getApiKey });

    await expect(
      client.list({ category: "image", page: 2, pageSize: 10 }),
    ).resolves.toMatchObject({
      source: "authenticated-api",
      page: 2,
      pageSize: 10,
      total: 30,
      hasMore: true,
      items: [{ slug: "openai/gpt-image-2" }],
    });

    const [input, init] = requireCall(fetchMock, 0);
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(AUTHENTICATED_CATALOG_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: "image",
      page: "2",
      page_size: "10",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer key-current",
    );
    expect(getApiKey).toHaveBeenCalledOnce();
  });

  it("uses the public portal only when fallback is explicit and never sends Authorization", async () => {
    const fetchMock = vi
      .fn<FetchPort>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ provider: "acme", id: "movie", type: "video" }],
          has_more: false,
        }),
      );
    const client = new ModelCatalogClient({
      fetch: fetchMock,
      getApiKey: () => "secret-key",
      allowPublicPortalFallback: true,
    });

    const result = await client.list({ category: "video" });
    expect(result.source).toBe("public-portal");
    const [fallbackInput, fallbackInit] = requireCall(fetchMock, 1);
    expect(new URL(String(fallbackInput)).origin + new URL(String(fallbackInput)).pathname).toBe(
      PUBLIC_PORTAL_CATALOG_URL,
    );
    expect(new Headers(fallbackInit?.headers).has("authorization")).toBe(false);
  });

  it("maps the live task-type catalog to media categories and filters locally", async () => {
    const fetchMock = vi.fn<FetchPort>().mockResolvedValue(
      jsonResponse({
        models: [
          { slug: "openai/gpt-image-2", type: "text-to-image" },
          { slug: "acme/image-editor", type: "image-to-image" },
          { slug: "acme/movie", type: "text-to-video" },
          { slug: "acme/animate", type: "image-to-video" },
          { slug: "acme/restyle", type: "video-to-video" },
          { slug: "acme/voice", type: "text-to-speech" },
          { slug: "acme/transcribe", type: "speech-to-text" },
          { slug: "acme/dub", type: "speech-to-speech" },
          { slug: "acme/unsupported", type: "text-to-3d" },
        ],
      }),
    );
    const client = new ModelCatalogClient({
      fetch: fetchMock,
      getApiKey: () => "key",
    });

    await expect(client.list({ category: "video" })).resolves.toMatchObject({
      hasMore: false,
      items: [
        { slug: "acme/movie", categories: ["video"] },
        { slug: "acme/animate", categories: ["video"] },
        { slug: "acme/restyle", categories: ["video"] },
      ],
    });
  });

  it("requires a key when public fallback was not explicitly enabled", async () => {
    const client = new ModelCatalogClient({
      fetch: vi.fn<FetchPort>(),
      getApiKey: () => null,
    });
    await expect(client.list({ category: "audio" })).rejects.toMatchObject({
      code: "MISSING_API_KEY",
    });
  });

  it("bounds a stalled catalog request", async () => {
    const fetchMock = stalledFetch();
    const client = new ModelCatalogClient({
      fetch: fetchMock,
      getApiKey: () => "key",
      requestTimeoutMs: 5,
    });

    await expect(client.list({ category: "image" })).rejects.toMatchObject({
      code: "CATALOG_UNAVAILABLE",
      status: 408,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { category: "image" as const, page: 0 },
    { category: "image" as const, page: 10_001 },
    { category: "image" as const, pageSize: 101 },
  ])("rejects pagination outside its fixed bounds", async (query) => {
    const client = new ModelCatalogClient({
      fetch: vi.fn<FetchPort>(),
      getApiKey: () => "key",
    });
    await expect(client.list(query)).rejects.toBeInstanceOf(DesignError);
  });

  it("honors an optional TTL cache without resolving the key twice", async () => {
    const entries = new Map<string, { value: unknown; expiresAt: number }>();
    const cache: CachePort = {
      read: async <T>(key: string) =>
        (entries.get(key) as { value: T; expiresAt: number } | undefined) ?? null,
      write: async <T>(key: string, entry: { value: T; expiresAt: number }) => {
        entries.set(key, entry);
      },
    };
    const fetchMock = vi
      .fn<FetchPort>()
      .mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    const getApiKey = vi.fn<() => string>().mockReturnValue("key");
    const client = new ModelCatalogClient({
      fetch: fetchMock,
      getApiKey,
      cache,
      clock: { now: () => 1_000 },
    });

    await client.list({ category: "image" });
    await client.list({ category: "image" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getApiKey).toHaveBeenCalledOnce();
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requireCall(
  mock: ReturnType<typeof vi.fn<FetchPort>>,
  index: number,
): [string | URL, RequestInit | undefined] {
  const call = mock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`Missing fetch call ${index}`);
  }
  return [call[0], call[1]];
}

function stalledFetch(): ReturnType<typeof vi.fn<FetchPort>> {
  return vi.fn<FetchPort>(async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
        once: true,
      });
    }));
}
