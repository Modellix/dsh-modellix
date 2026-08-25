import { describe, expect, it, vi } from "vitest";

import { DesignError } from "../../../src/design/errors.js";
import {
  ModelSchemaClient,
  extractAllowedSubmitUrl,
} from "../../../src/design/model-schema.js";
import type { FetchPort } from "../../../src/design/ports.js";

describe("ModelSchemaClient", () => {
  it("prefers public api_schema and returns its exact allowlisted server", async () => {
    const document = {
      servers: [{ url: "https://api.modellix.ai/api/v1/openai/gpt-image-2" }],
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { type: "object" } },
          },
        },
      },
    };
    const fetchMock = vi
      .fn<FetchPort>()
      .mockImplementation(async () => jsonResponse(document));
    const client = new ModelSchemaClient({ fetch: fetchMock });

    await expect(client.load("openai", "gpt-image-2")).resolves.toEqual({
      provider: "openai",
      modelId: "gpt-image-2",
      source: "public-api-schema",
      document,
      submitUrl: "https://api.modellix.ai/api/v1/openai/gpt-image-2",
    });
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe(
      "https://www.modellix.ai/models/openai/gpt-image-2/api_schema",
    );
    expect(new Headers(call?.[1]?.headers).has("authorization")).toBe(false);
    expect(new Headers(call?.[1]?.headers).has("cookie")).toBe(false);

    // api_schema currently publishes no-store; every load revalidates and raw
    // schema is not retained in the optional catalog cache.
    await client.load("openai", "gpt-image-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    "https://api.modellix.ai/api/v1/openai/gpt-image-2/async",
    "https://api.modellix.ai/api/v1/openai/another-model",
    "https://evil.example/api/v1/openai/gpt-image-2",
    "https://api.modellix.ai/api/v1/openai/gpt-image-2?token=x",
  ])("fails closed for non-exact submission endpoint %s", (url) => {
    expect(() =>
      extractAllowedSubmitUrl(
        { servers: [{ url }] },
        "openai",
        "gpt-image-2",
      ),
    ).toThrowError(DesignError);
  });

  it("reads portal schema_data only as explicit metadata fallback", async () => {
    const fetchMock = vi
      .fn<FetchPort>()
      .mockResolvedValueOnce(jsonResponse({ error: "missing" }, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            schema_data: JSON.stringify({
              type: "object",
              properties: { prompt: { type: "string" } },
            }),
          },
        }),
      );
    const client = new ModelSchemaClient({
      fetch: fetchMock,
      allowPortalDetailFallback: true,
    });

    const result = await client.load("openai", "gpt-image-2");
    expect(result).toMatchObject({
      source: "portal-detail",
      submitUrl: null,
      document: { type: "object" },
    });
    const fallbackCall = fetchMock.mock.calls[1];
    expect(String(fallbackCall?.[0])).toBe(
      "https://www.modellix.ai/portal/v1/models/gpt-image-2?provider=openai",
    );
    expect(new Headers(fallbackCall?.[1]?.headers).has("authorization")).toBe(false);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
