import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_LLM_ROUTE_LEDGER,
  LlmRouteConflictError,
  LlmSettingsMaterializer,
  planLlmRouteMaterialization,
  planLlmRouteRemoval,
} from "../../../src/llm/materializer.js";

const catalog = [
  { id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol" },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
];

describe("llm-pi-ai Modellix route materialization", () => {
  it("creates a text-only route with both retry layers disabled", () => {
    const plan = planLlmRouteMaterialization(undefined, catalog);
    expect(plan.route).toMatchObject({
      apiKeyEnv: "MODELLIX_API_KEY",
      displayName: "Modellix",
      api: "openai-completions",
      baseURL: "https://llm.modellix.ai/v1",
      defaultInput: ["text"],
      retryPolicy: { mode: "normal", maxRetries: 0 },
      models: catalog,
    });
    expect(plan.ledger.ownership).toBe("created");
    expect(plan.ledger.entries.filter((entry) => entry.kind === "model")).toHaveLength(2);
  });

  it("preserves unknown fields and hand-authored model metadata", () => {
    const current = {
      apiKeyEnv: "MODELLIX_API_KEY",
      api: "openai-completions",
      baseURL: "https://llm.modellix.ai/v1",
      headers: { "x-safe-feature": "on" },
      models: [{ id: "openai/gpt-5.6-sol", contextWindow: 12345 }],
    };
    const plan = planLlmRouteMaterialization(current, catalog);
    expect(plan.route.headers).toEqual({ "x-safe-feature": "on" });
    expect(plan.route.models).toEqual([
      { id: "openai/gpt-5.6-sol", contextWindow: 12345 },
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    ]);
    expect(plan.ledger.entries.filter((entry) => entry.kind === "model").map((entry) => entry.key))
      .toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("refuses incompatible wire-affecting fields", () => {
    expect(() => planLlmRouteMaterialization({
      apiKeyEnv: "OTHER_KEY",
      models: [],
    }, catalog)).toThrow(LlmRouteConflictError);
    expect(() => planLlmRouteMaterialization({
      baseURL: "https://other.example/v1",
      models: [],
    }, catalog)).toThrow(/baseURL/);
  });

  it("updates and removes only models whose ownership fingerprint still matches", () => {
    const created = planLlmRouteMaterialization(undefined, catalog);
    const refreshed = planLlmRouteMaterialization(created.route, [catalog[0]!], created.ledger);
    expect(refreshed.route.models.map((model) => model.id)).toEqual(["openai/gpt-5.6-sol"]);

    const drifted = {
      ...created.route,
      models: created.route.models.map((model) => model.id === "anthropic/claude-sonnet-5"
        ? { ...model, contextWindow: 98765 }
        : model),
    };
    const preserved = planLlmRouteMaterialization(drifted, [catalog[0]!], created.ledger);
    expect(preserved.route.models.map((model) => model.id)).toEqual([
      "openai/gpt-5.6-sol",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("removes a plugin-created route only while the whole route is unchanged", () => {
    const created = planLlmRouteMaterialization(undefined, catalog);
    expect(planLlmRouteRemoval(created.route, created.ledger).action).toBe("unset-route");
    expect(planLlmRouteRemoval({ ...created.route, timeoutMs: 123 }, created.ledger).action)
      .toBe("conflict");
  });

  it("uses the Settings revision as a CAS guard", async () => {
    const mutate = vi.fn(async () => undefined);
    const materializer = new LlmSettingsMaterializer({
      describe: async () => ({ revision: 17, user: { providers: {} } }),
      mutate,
    });
    const ledger = await materializer.materialize(catalog, EMPTY_LLM_ROUTE_LEDGER);
    expect(ledger.ownership).toBe("created");
    expect(mutate).toHaveBeenCalledWith([expect.objectContaining({
      op: "set",
      path: ["providers", "modellix"],
    })], 17);
  });
});
