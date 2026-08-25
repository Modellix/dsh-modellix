import { describe, expect, it, vi } from "vitest";

import type { FetchPort } from "../../../src/design/ports.js";
import {
  DESIGN_PLANNER_ENDPOINT,
  DESIGN_PLANNER_MODEL,
  DesignPlannerClient,
} from "../../../src/design/planner-client.js";
import { parseDesignSchema } from "../../../src/design/schema-ir.js";

const schema = parseDesignSchema({
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 1, maximum: 4, default: 1 },
    safe: { type: "boolean", default: false },
    advanced: {
      type: "object",
      properties: {
        seed: { type: "integer", minimum: 0, default: 0 },
      },
    },
  },
});

const current = {
  prompt: "A quiet lake",
  count: 1,
  safe: false,
  advanced: { seed: 0 },
} as const;

describe("DesignPlannerClient", () => {
  it("performs one fixed, non-streaming structured-output POST without leaking the key", async () => {
    const apiKey = "SENTINEL_PLANNER_API_KEY";
    const fetchMock = vi.fn<FetchPort>().mockResolvedValue(
      plannerResponse({
        set: [
          { path: "/prompt", value: "Four foxes at dusk" },
          { path: "/count", value: 4 },
        ],
        unset: [],
        needsClarification: null,
      }),
    );
    const client = new DesignPlannerClient({ fetch: fetchMock });

    await expect(
      client.plan({
        apiKey,
        schema,
        current,
        instruction: "Make four foxes at dusk",
      }),
    ).resolves.toMatchObject({
      parameters: { prompt: "Four foxes at dusk", count: 4 },
      needsClarification: null,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe(DESIGN_PLANNER_ENDPOINT);
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.redirect).toBe("error");
    const bodyText = String(call?.[1]?.body);
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body.model).toBe(DESIGN_PLANNER_MODEL);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toEqual(expect.any(Number));
    expect(body.max_tokens).toBeLessThanOrEqual(2_048);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { strict: true },
      },
    });
    expect(bodyText).not.toContain(apiKey);
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${apiKey}`,
    );

    const responseFormat = body.response_format as {
      json_schema: { schema: { properties: { set: { items: { anyOf: unknown[] } } } } };
    };
    const pathSchemas = responseFormat.json_schema.schema.properties.set.items.anyOf;
    expect(JSON.stringify(pathSchemas)).toContain("/prompt");
    expect(JSON.stringify(pathSchemas)).not.toContain("/invented");
  });

  it("returns a clarification without mutating parameters", async () => {
    const client = clientFor({
      set: [],
      unset: [],
      needsClarification: "Which aspect ratio should I use?",
    });
    await expect(plan(client)).resolves.toEqual({
      patch: { set: {}, unset: [] },
      parameters: current,
      needsClarification: "Which aspect ratio should I use?",
    });
  });

  it("blocks hallucinated paths and invalid field types after structured output", async () => {
    const hallucinatedFetch = vi.fn<FetchPort>().mockResolvedValue(
      plannerResponse({
        set: [{ path: "/invented", value: true }],
        unset: [],
        needsClarification: null,
      }),
    );
    await expect(
      plan(new DesignPlannerClient({ fetch: hallucinatedFetch })),
    ).rejects.toMatchObject({ code: "PLANNER_RESPONSE_INVALID" });
    expect(hallucinatedFetch).toHaveBeenCalledOnce();

    const invalidTypeFetch = vi.fn<FetchPort>().mockResolvedValue(
      plannerResponse({
        set: [{ path: "/count", value: "four" }],
        unset: [],
        needsClarification: null,
      }),
    );
    await expect(
      plan(new DesignPlannerClient({ fetch: invalidTypeFetch })),
    ).rejects.toMatchObject({ code: "PLANNER_RESPONSE_INVALID" });
    expect(invalidTypeFetch).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "PLANNER_UNAUTHORIZED"],
    [402, "PLANNER_BILLING_BLOCKED"],
    [403, "PLANNER_FORBIDDEN"],
    [429, "PLANNER_RATE_LIMITED"],
    [503, "PLANNER_UNAVAILABLE"],
  ] as const)("maps HTTP %i without retry to %s", async (status, code) => {
    const secret = "SENTINEL_ERROR_BODY_KEY";
    const fetchMock = vi.fn<FetchPort>().mockResolvedValue(
      new Response(secret.repeat(10_000), {
        status,
        headers: {
          "content-length": String(secret.length * 10_000),
          "content-type": "application/json",
        },
      }),
    );
    const error = await captureError(
      plan(new DesignPlannerClient({ fetch: fetchMock })),
    );
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps timeout, cancellation, and network failures without exposing causes", async () => {
    const timeoutFetch = vi
      .fn<FetchPort>()
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(
      plan(new DesignPlannerClient({ fetch: timeoutFetch })),
    ).rejects.toMatchObject({ code: "PLANNER_TIMEOUT", status: null });
    expect(timeoutFetch).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const abortFetch = vi.fn<FetchPort>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const aborted = plan(
      new DesignPlannerClient({ fetch: abortFetch }),
      controller.signal,
    );
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "PLANNER_ABORTED" });
    expect(abortFetch).toHaveBeenCalledOnce();

    const causeSecret = "SENTINEL_TRANSPORT_SECRET";
    const networkFetch = vi
      .fn<FetchPort>()
      .mockRejectedValue(new Error(`socket failed ${causeSecret}`));
    const error = await captureError(
      plan(new DesignPlannerClient({ fetch: networkFetch })),
    );
    expect(error).toMatchObject({ code: "PLANNER_UNAVAILABLE" });
    expect(String(error)).not.toContain(causeSecret);
    expect(networkFetch).toHaveBeenCalledOnce();
  });

  it("rejects oversized input and response before trusting their contents", async () => {
    const inputFetch = vi.fn<FetchPort>();
    await expect(
      new DesignPlannerClient({ fetch: inputFetch }).plan({
        apiKey: "test-key",
        schema,
        current,
        instruction: "x".repeat(70 * 1_024),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(inputFetch).not.toHaveBeenCalled();

    const responseFetch = vi.fn<FetchPort>().mockResolvedValue(
      new Response("{}", {
        headers: {
          "content-length": String(129 * 1_024),
          "content-type": "application/json",
        },
      }),
    );
    await expect(
      plan(new DesignPlannerClient({ fetch: responseFetch })),
    ).rejects.toMatchObject({ code: "PLANNER_RESPONSE_INVALID" });
    expect(responseFetch).toHaveBeenCalledOnce();
  });
});

function clientFor(result: unknown): DesignPlannerClient {
  return new DesignPlannerClient({
    fetch: vi.fn<FetchPort>().mockResolvedValue(plannerResponse(result)),
  });
}

function plan(client: DesignPlannerClient, signal?: AbortSignal) {
  return client.plan({
    apiKey: "test-key",
    schema,
    current,
    instruction: "Update the image parameters",
    ...(signal === undefined ? {} : { signal }),
  });
}

function plannerResponse(result: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(result) },
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    return error;
  }
}
