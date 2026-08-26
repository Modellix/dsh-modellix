import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_LLM_ROUTE_LEDGER,
  LlmRouteConflictError,
  LlmSettingsMaterializer,
  MODELLIX_LLM_PROVENANCE_FIELD,
  planLlmRouteMaterialization,
  planLlmRouteRemoval,
  reconcileLlmRouteLedgerAfterInterruption,
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
    expect(preserved.ledger.ownership).toBe("adopted");

    const refreshedAgain = planLlmRouteMaterialization(
      preserved.route,
      [catalog[0]!],
      preserved.ledger,
    );
    expect(refreshedAgain.route.models.map((model) => model.id)).toEqual([
      "openai/gpt-5.6-sol",
      "anthropic/claude-sonnet-5",
    ]);
    expect(refreshedAgain.ledger.entries.some((entry) =>
      entry.kind === "model" && entry.key === "anthropic/claude-sonnet-5")).toBe(false);
  });

  it("downgrades a created route after user extension and preserves the extension on removal", () => {
    const created = planLlmRouteMaterialization(undefined, catalog);
    const extended = { ...created.route, userHeaderPolicy: "keep-me" };

    const refreshed = planLlmRouteMaterialization(extended, catalog, created.ledger);
    expect(refreshed.ledger.ownership).toBe("adopted");

    const removal = planLlmRouteRemoval(refreshed.route, refreshed.ledger);
    expect(removal).toMatchObject({
      action: "set-route",
      route: { userHeaderPolicy: "keep-me" },
    });
    expect(removal.route).not.toHaveProperty("apiKeyEnv");
  });

  it("does not claim compatible fields or models already present on an adopted route", () => {
    const existing = {
      apiKeyEnv: "MODELLIX_API_KEY",
      displayName: "Modellix",
      api: "openai-completions",
      baseURL: "https://llm.modellix.ai/v1",
      defaultInput: ["text"],
      retryPolicy: { mode: "normal", maxRetries: 0 },
      models: [{ id: "openai/gpt-5.6-sol", contextWindow: 12345 }],
      userHeaderPolicy: "keep-me",
    };
    const adopted = planLlmRouteMaterialization(existing, catalog);
    expect(adopted.ledger.ownership).toBe("adopted");

    const removal = planLlmRouteRemoval(adopted.route, adopted.ledger);
    expect(removal.action).toBe("set-route");
    expect(removal.route).toEqual(existing);
  });

  it("removes a plugin-created route only while the whole route is unchanged", () => {
    const created = planLlmRouteMaterialization(undefined, catalog);
    expect(planLlmRouteRemoval(created.route, created.ledger).action).toBe("unset-route");
    expect(planLlmRouteRemoval({ ...created.route, timeoutMs: 123 }, created.ledger).action)
      .toBe("conflict");
  });

  it("keeps only previously proven entries after an interrupted materialization", () => {
    const created = planLlmRouteMaterialization(undefined, catalog);
    expect(reconcileLlmRouteLedgerAfterInterruption(created.route, created.ledger))
      .toEqual(created.ledger);

    const userChanged = {
      ...created.route,
      userHeaderPolicy: "keep-me",
      models: created.route.models.map((model) => model.id === catalog[0]!.id
        ? { ...model, name: "User label" }
        : model),
    };
    const recovered = reconcileLlmRouteLedgerAfterInterruption(userChanged, created.ledger);
    expect(recovered.ownership).toBe("adopted");
    expect(recovered.entries.some((entry) => entry.kind === "model" && entry.key === catalog[0]!.id))
      .toBe(false);
    expect(recovered.entries.some((entry) => entry.kind === "model" && entry.key === catalog[1]!.id))
      .toBe(true);
    expect(recovered.entries.some((entry) => entry.key === "/userHeaderPolicy"))
      .toBe(false);
  });

  it("does not claim an orphan route when no ownership was committed before the crash", () => {
    const orphan = planLlmRouteMaterialization(undefined, catalog).route;
    expect(reconcileLlmRouteLedgerAfterInterruption(orphan, EMPTY_LLM_ROUTE_LEDGER))
      .toEqual(EMPTY_LLM_ROUTE_LEDGER);
  });

  it("uses the Settings revision as a CAS guard", async () => {
    const mutate = vi.fn(async () => undefined);
    const materializer = new LlmSettingsMaterializer({
      describe: async () => ({ revision: 17, value: { providers: {} }, user: { providers: {} } }),
      mutate,
    });
    const ledger = await materializer.materialize(catalog, EMPTY_LLM_ROUTE_LEDGER);
    expect(ledger.ownership).toBe("created");
    expect(mutate).toHaveBeenCalledWith([expect.objectContaining({
      op: "set",
      path: ["providers", "modellix"],
    })], 17);
  });

  it("prepares without writing and exposes the guarded apply revision", async () => {
    const mutate = vi.fn(async () => undefined);
    const materializer = new LlmSettingsMaterializer({
      describe: async () => ({ revision: 23, value: { providers: {} }, user: { providers: {} } }),
      mutate,
    });
    const prepared = await materializer.prepareMaterialization(catalog, EMPTY_LLM_ROUTE_LEDGER);

    expect(prepared.changed).toBe(true);
    expect(prepared.expectedSettingsRevision).toBe(23);
    expect(prepared.previousRouteFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.targetRouteFingerprint).toBe(prepared.ledger.appliedRouteFingerprint);
    expect(mutate).not.toHaveBeenCalled();
    await prepared.apply();
    expect(mutate).toHaveBeenCalledWith([expect.objectContaining({
      op: "set",
      path: ["providers", "modellix"],
    })], 23);
  });

  it("writes the ordinary route and recovery provenance in one guarded Settings mutation", async () => {
    const provenanceToken = "llm_atomic_materialization_1234";
    const mutate = vi.fn(async () => undefined);
    const materializer = new LlmSettingsMaterializer({
      describe: async () => ({ revision: 29, value: { providers: {} }, user: { providers: {} } }),
      mutate,
    });
    const prepared = await materializer.prepareMaterialization(
      catalog,
      EMPTY_LLM_ROUTE_LEDGER,
      provenanceToken,
    );

    await prepared.apply();

    expect(prepared.ledger.appliedRouteFingerprint).toBe(prepared.targetRouteFingerprint);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith([
      expect.objectContaining({
        op: "set",
        path: ["providers", "modellix"],
        value: expect.not.objectContaining({
          [MODELLIX_LLM_PROVENANCE_FIELD]: expect.anything(),
        }),
      }),
      {
        op: "set",
        path: [MODELLIX_LLM_PROVENANCE_FIELD],
        value: provenanceToken,
      },
    ], 29);
  });

  it("recovers only an exact pre-write or single-CAS target route", async () => {
    const provenanceToken = "llm_recovery_contract_1234";
    const plan = planLlmRouteMaterialization(undefined, catalog, EMPTY_LLM_ROUTE_LEDGER);
    let descriptor: { revision: number; value: unknown; user: unknown } = {
      revision: 0,
      value: { providers: {} },
      user: { providers: {} },
    };
    const materializer = new LlmSettingsMaterializer({
      describe: async () => descriptor,
      mutate: vi.fn(async () => undefined),
    });
    const prepared = await materializer.prepareMaterialization(
      catalog,
      EMPTY_LLM_ROUTE_LEDGER,
      provenanceToken,
    );
    const evidence = {
      previousLedger: EMPTY_LLM_ROUTE_LEDGER,
      targetLedger: plan.ledger,
      previousRouteFingerprint: prepared.previousRouteFingerprint,
      provenanceToken,
    } as const;

    await expect(materializer.recoverInterruptedMaterialization(evidence))
      .resolves.toEqual({ status: "not-applied", ledger: EMPTY_LLM_ROUTE_LEDGER });

    descriptor = {
      revision: 1,
      value: { providers: { modellix: plan.route } },
      user: {
        providers: { modellix: plan.route },
        [MODELLIX_LLM_PROVENANCE_FIELD]: provenanceToken,
      },
    };
    await expect(materializer.recoverInterruptedMaterialization(evidence))
      .resolves.toEqual({ status: "applied", ledger: plan.ledger });

    // Settings revisions restart from zero with a fresh registration; the
    // provenance field remains durable in the raw user namespace section.
    descriptor = {
      revision: 0,
      value: { providers: { modellix: plan.route } },
      user: {
        providers: { modellix: plan.route },
        [MODELLIX_LLM_PROVENANCE_FIELD]: provenanceToken,
      },
    };
    await expect(materializer.recoverInterruptedMaterialization(evidence))
      .resolves.toEqual({ status: "applied", ledger: plan.ledger });

    const driftedRoute = { ...plan.route, userHeaderPolicy: "keep-me" };
    descriptor = {
      revision: 1,
      value: { providers: { modellix: driftedRoute } },
      user: {
        providers: { modellix: driftedRoute },
        [MODELLIX_LLM_PROVENANCE_FIELD]: provenanceToken,
      },
    };
    await expect(materializer.recoverInterruptedMaterialization(evidence))
      .rejects.toThrow(/exact interrupted materialization evidence/);
  });

  it("clears only the exact committed recovery provenance token", async () => {
    let descriptor = {
      revision: 7,
      value: { providers: {} },
      user: { [MODELLIX_LLM_PROVENANCE_FIELD]: "llm_other_operation_1234" },
    };
    const mutate = vi.fn(async () => undefined);
    const materializer = new LlmSettingsMaterializer({
      describe: async () => descriptor,
      mutate,
    });

    await materializer.clearProvenance("llm_committed_operation_1234");
    expect(mutate).not.toHaveBeenCalled();

    descriptor = {
      revision: 8,
      value: { providers: {} },
      user: { [MODELLIX_LLM_PROVENANCE_FIELD]: "llm_committed_operation_1234" },
    };
    await materializer.clearProvenance("llm_committed_operation_1234");
    expect(mutate).toHaveBeenCalledWith([{
      op: "unset",
      path: [MODELLIX_LLM_PROVENANCE_FIELD],
    }], 8);
  });

  it("ignores schema-expanded effective defaults when the raw owned route is unchanged", async () => {
    const created = planLlmRouteMaterialization(undefined, catalog);
    const mutate = vi.fn(async () => undefined);
    const materializer = new LlmSettingsMaterializer({
      describe: async () => ({
        revision: 18,
        value: {
          providers: {
            modellix: {
              ...created.route,
              retryPolicy: {
                ...created.route.retryPolicy,
                retryableCodes: ["RATE_LIMIT", "SERVER"],
                backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
              },
            },
          },
        },
        base: { providers: {} },
        user: { providers: { modellix: created.route } },
      }),
      mutate,
    });

    const ledger = await materializer.materialize(catalog, created.ledger);

    expect(ledger.ownership).toBe("created");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refuses to shadow a composition-owned Modellix route", async () => {
    const route = planLlmRouteMaterialization(undefined, catalog).route;
    const materializer = new LlmSettingsMaterializer({
      describe: async () => ({
        revision: 1,
        value: { providers: { modellix: route } },
        base: { providers: { modellix: route } },
      }),
      mutate: vi.fn(async () => undefined),
    });

    await expect(materializer.materialize(catalog, EMPTY_LLM_ROUTE_LEDGER))
      .rejects.toThrow(/composition base ownership/);
  });

  it("refuses a user override layered over a composition-owned Modellix route", async () => {
    const route = planLlmRouteMaterialization(undefined, catalog).route;
    const materializer = new LlmSettingsMaterializer({
      describe: async () => ({
        revision: 2,
        value: { providers: { modellix: route } },
        base: { providers: { modellix: route } },
        user: { providers: { modellix: route } },
      }),
      mutate: vi.fn(async () => undefined),
    });

    await expect(materializer.materialize(catalog, EMPTY_LLM_ROUTE_LEDGER))
      .rejects.toThrow(/composition base ownership/);
  });
});
