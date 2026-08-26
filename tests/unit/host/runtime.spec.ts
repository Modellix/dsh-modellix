import type { Context } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";
import { SettingsConflictError, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODELLIX_CREDENTIAL_REF,
  beginLlmMaterialization,
  createDefaultConfig,
  migrateConfig,
  type PluginConfig,
} from "../../../src/core/index.js";
import {
  EMPTY_LLM_ROUTE_LEDGER,
  MODELLIX_LLM_PROVENANCE_FIELD,
  planLlmRouteMaterialization,
} from "../../../src/llm/index.js";
import { ModellixRuntime, type ModellixRuntimeState } from "../../../src/host/runtime.js";

vi.mock("@deepseek-ai/dsh-anonymous-user-id", () => ({
  getOrCreateAnonymousUserId: () => "00000000-0000-4000-8000-000000000001",
}));

const MODEL = { id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol" } as const;
const VALIDATE_URL = "https://api.modellix.ai/api/v1/apikey/validate";
const CATALOG_URL = "https://llm.modellix.ai/v1/models";
const DESIGN_CATALOG_URL = "https://api.modellix.ai/api/v1/models";
const DESIGN_SCHEMA_URL = "https://www.modellix.ai/models/openai/gpt-image-2/api_schema";
const DESIGN_PLANNER_URL = "https://llm.modellix.ai/v1/chat/completions";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModellixRuntime Host contracts", () => {
  it("initializes without a Secret and exposes only write-safe Credential metadata", async () => {
    const harness = new RuntimeHarness({ config: configWith({ llm: false }) });
    installFetch(rejectUnexpectedFetch);
    await ModellixRuntime.create(harness.context);

    const state = await harness.state();
    expect(state).toMatchObject({
      version: 1,
      settingsRevision: 0,
      services: { design: true, llm: false, web: true },
      credential: {
        configured: false,
        source: null,
        writable: true,
        revision: null,
        credentialEpoch: 0,
        verification: "unknown",
        invalidEpoch: null,
      },
      onboarding: { status: "active", recoveryPending: false, recoveryRequestId: null },
      llm: { health: "disabled", modelCount: 0, refreshedAt: null },
    });
    expect(JSON.stringify(state)).not.toContain("apiKey");

    await harness.dispose();
  });

  it("issues a fresh non-secret recovery request only for explicit capability actions", async () => {
    const harness = new RuntimeHarness({ config: configWith({ llm: false }) });
    installFetch(rejectUnexpectedFetch);
    await ModellixRuntime.create(harness.context);

    expect((await harness.state()).onboarding.recoveryRequestId).toBeNull();
    await harness.rpcValue("design/read", {
      version: 1,
      sessionId: "session-recovery",
    });
    expect((await harness.state()).onboarding.recoveryRequestId).toBeNull();

    await harness.rpcValue("design/refresh", {
      version: 1,
      sessionId: "session-recovery",
    });
    const first = (await harness.state()).onboarding.recoveryRequestId;
    expect(first).toMatch(/^recovery_[a-f0-9]{32}$/u);
    expect(JSON.stringify(await harness.state())).not.toMatch(/api.?key|authorization/iu);

    await harness.rpcValue("design/refresh", {
      version: 1,
      sessionId: "session-recovery",
    });
    const second = (await harness.state()).onboarding.recoveryRequestId;
    expect(second).toMatch(/^recovery_[a-f0-9]{32}$/u);
    expect(second).not.toBe(first);

    await harness.dispose();
  });

  it("returns Design failures as safe business envelopes", async () => {
    const harness = new RuntimeHarness({ config: configWith({ llm: false }) });
    installFetch(rejectUnexpectedFetch);
    await ModellixRuntime.create(harness.context);

    const result = await harness.rpcValue<unknown>("design/unsupported", { version: 1 });
    expect(result).toEqual({
      version: 1,
      accepted: false,
      error: { code: "MODELLIX_DESIGN_INPUT_INVALID" },
    });
    expect(JSON.stringify(result)).not.toContain("Unknown Design endpoint");

    await harness.dispose();
  });

  it("preserves submit-unknown over a billed planner HTTP 5xx status", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: false, credentialEpoch: 1 }),
      credential: "unit-test-planner-key",
    });
    let plannerPosts = 0;
    installFetch(async (input, init) => {
      const url = String(input);
      if (url.startsWith(DESIGN_CATALOG_URL)) {
        return jsonResponse({
          data: {
            items: [{
              provider: "openai",
              model_id: "gpt-image-2",
              display_name: "GPT Image 2",
              category: "image",
            }],
            page: 1,
            page_size: 100,
            total: 1,
          },
        });
      }
      if (url === DESIGN_SCHEMA_URL) {
        return jsonResponse({
          servers: [{ url: "https://api.modellix.ai/api/v1/openai/gpt-image-2" }],
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["prompt"],
                    properties: { prompt: { type: "string", minLength: 1 } },
                  },
                },
              },
            },
          },
        });
      }
      if (url === DESIGN_PLANNER_URL && init?.method === "POST") {
        plannerPosts += 1;
        return jsonResponse({ error: "temporary" }, 503);
      }
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    const selected = await harness.rpcValue<{
      readonly state: {
        readonly draft: {
          readonly draftRevision: number;
          readonly irContractHash: string;
        } | null;
      };
    }>("design/select-model", {
      version: 1,
      sessionId: "session-planner-unknown",
      modelId: "openai/gpt-image-2",
    });
    expect(selected.state.draft).not.toBeNull();
    const proposed = await harness.rpcValue<unknown>("design/propose", {
      version: 1,
      sessionId: "session-planner-unknown",
      modelId: "openai/gpt-image-2",
      draftRevision: selected.state.draft?.draftRevision,
      irContractHash: selected.state.draft?.irContractHash,
      parameters: { "/prompt": "A bounded test prompt" },
      instruction: "Make it cinematic",
    });

    expect(proposed).toEqual({
      version: 1,
      accepted: false,
      error: { code: "MODELLIX_SUBMIT_UNKNOWN" },
    });
    expect(plannerPosts).toBe(1);
    await harness.dispose();
  });

  it("preserves submit-unknown when a billed planner POST is aborted after dispatch", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: false, credentialEpoch: 1 }),
      credential: "unit-test-planner-abort-key",
    });
    const abort = new AbortController();
    let plannerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      plannerStarted = resolve;
    });
    let plannerPosts = 0;
    installFetch(async (input, init) => {
      const url = String(input);
      if (url.startsWith(DESIGN_CATALOG_URL)) {
        return jsonResponse({
          data: {
            items: [{
              provider: "openai",
              model_id: "gpt-image-2",
              display_name: "GPT Image 2",
              category: "image",
            }],
            page: 1,
            page_size: 100,
            total: 1,
          },
        });
      }
      if (url === DESIGN_SCHEMA_URL) {
        return jsonResponse({
          servers: [{ url: "https://api.modellix.ai/api/v1/openai/gpt-image-2" }],
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["prompt"],
                    properties: { prompt: { type: "string", minLength: 1 } },
                  },
                },
              },
            },
          },
        });
      }
      if (url === DESIGN_PLANNER_URL && init?.method === "POST") {
        plannerPosts += 1;
        plannerStarted();
        return new Promise<Response>((_resolve, reject) => {
          const rejectAbort = (): void => reject(
            init.signal?.reason ?? new DOMException("aborted", "AbortError"),
          );
          if (init.signal?.aborted === true) rejectAbort();
          else init.signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    const selected = await harness.rpcValue<{
      readonly state: {
        readonly draft: {
          readonly draftRevision: number;
          readonly irContractHash: string;
        } | null;
      };
    }>("design/select-model", {
      version: 1,
      sessionId: "session-planner-abort",
      modelId: "openai/gpt-image-2",
    });
    const proposed = harness.rpc("design/propose", {
      version: 1,
      sessionId: "session-planner-abort",
      modelId: "openai/gpt-image-2",
      draftRevision: selected.state.draft?.draftRevision,
      irContractHash: selected.state.draft?.irContractHash,
      parameters: { "/prompt": "A bounded test prompt" },
      instruction: "Make it cinematic",
    }, abort.signal);
    await started;
    abort.abort();

    await expect(proposed).resolves.toEqual({
      ok: true,
      value: {
        version: 1,
        accepted: false,
        error: { code: "MODELLIX_SUBMIT_UNKNOWN" },
      },
    });
    expect(plannerPosts).toBe(1);
    await harness.dispose();
  });

  it("ignores the synchronous commit event from its own set/unset and advances exactly one epoch", async () => {
    const harness = new RuntimeHarness({ config: configWith({ llm: false }) });
    installFetch(async (input) => {
      if (String(input) === VALIDATE_URL) {
        return jsonResponse({ data: { is_valid: true } });
      }
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    const saved = await harness.rpcValue<{ accepted: boolean; state: ModellixRuntimeState }>(
      "credential/save",
      {
        version: 1,
        apiKey: "unit-test-candidate",
        expectedCredentialEpoch: 0,
        services: { design: true, llm: false, web: true },
      },
    );
    expect(saved.accepted).toBe(true);
    expect(saved.state.credential.credentialEpoch).toBe(1);
    expect(harness.credentials.referenceEvents).toBe(1);
    expect(harness.settings.config.credentialEpoch).toBe(1);

    const removed = await harness.rpcValue<{ accepted: boolean; state: ModellixRuntimeState }>(
      "credential/remove",
      { version: 1, expectedCredentialEpoch: 1 },
    );
    expect(removed.accepted).toBe(true);
    expect(removed.state.credential.credentialEpoch).toBe(2);
    expect(removed.state.credential.configured).toBe(false);
    expect(harness.credentials.referenceEvents).toBe(2);
    expect(harness.settings.config.credentialEpoch).toBe(2);

    // A self event is consumed synchronously while the mutation guard is set;
    // there must be no delayed second generation hidden behind the RPC result.
    await harness.settings.drainWatchers();
    await Promise.resolve();
    expect(harness.settings.config.credentialEpoch).toBe(2);

    await harness.dispose();
  });

  it("treats external Credential commit events as eventually-consistent epoch changes", async () => {
    const harness = new RuntimeHarness({ config: configWith({ llm: false }) });
    installFetch(rejectUnexpectedFetch);
    await ModellixRuntime.create(harness.context);

    harness.credentials.externalSet("external-unit-test-key");
    // The fixed Harness provider does not await async listeners. The write is
    // committed now, while the runtime's Settings generation follows later.
    expect(harness.settings.config.credentialEpoch).toBe(0);
    await vi.waitFor(() => {
      expect(harness.settings.config.credentialEpoch).toBe(1);
    });
    expect((await harness.state()).credential).toMatchObject({
      configured: true,
      credentialEpoch: 1,
    });

    harness.credentials.externalSet("rotated-external-unit-test-key");
    harness.credentials.externalUnset();
    await vi.waitFor(() => {
      expect(harness.settings.config.credentialEpoch).toBe(3);
    });
    expect((await harness.state()).credential).toMatchObject({
      configured: false,
      credentialEpoch: 3,
    });
    expect(harness.credentials.referenceEvents).toBe(3);

    await harness.dispose();
  });

  it("accounts for a live external Credential deletion only once across restart", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: false, credentialEpoch: 5, onboarding: "completed" }),
      credential: "configured-before-external-delete",
    });
    installFetch(rejectUnexpectedFetch);
    await ModellixRuntime.create(harness.context);

    harness.credentials.externalUnset();
    await vi.waitFor(() => {
      expect(harness.settings.config.credentialEpoch).toBe(6);
      expect(harness.settings.config.onboarding.status).toBe("active");
    });
    await harness.dispose();

    await harness.restartContext();
    await ModellixRuntime.create(harness.context);
    expect(await harness.state()).toMatchObject({
      credential: { configured: false, credentialEpoch: 6 },
      onboarding: { status: "active" },
    });

    await harness.dispose();
  });

  it("reconciles an externally toggled LLM route live in both directions", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: false, credentialEpoch: 4 }),
      credential: "configured-unit-test-key",
    });
    const fetchSpy = installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    harness.settings.pushExternalConfig(configWith({
      llm: true,
      credentialEpoch: 4,
      base: harness.settings.config,
    }));
    await vi.waitFor(async () => {
      expect((await harness.state()).llm).toMatchObject({ health: "ready", modelCount: 1 });
    });
    expect(harness.settings.llmRoute).toMatchObject({
      apiKeyEnv: MODELLIX_CREDENTIAL_REF,
      baseURL: "https://llm.modellix.ai/v1",
      retryPolicy: { mode: "normal", maxRetries: 0 },
      models: [MODEL],
    });
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("created");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(harness.settings.runtimeMutations.slice(0, 3)).toEqual([
      "modellix",
      "llm-pi-ai",
      "modellix",
    ]);

    harness.settings.pushExternalConfig(configWith({
      llm: false,
      credentialEpoch: 4,
      base: harness.settings.config,
    }));
    await vi.waitFor(async () => {
      expect((await harness.state()).llm.health).toBe("disabled");
      expect(harness.settings.config.llmOwnership.route.ownership).toBe("none");
    });
    expect(harness.settings.llmRoute).toBeUndefined();

    await harness.dispose();
  });

  it("does not enter ready until every catalog model resolves through ctx.llm", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: true, credentialEpoch: 6 }),
      credential: "configured-unit-test-key",
    });
    const registryGate = harness.llm.blockNextResolution();
    installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    await registryGate.started;
    expect((await harness.state()).llm.health).not.toBe("ready");
    expect(harness.settings.llmRoute).toMatchObject({ models: [MODEL] });
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("none");

    registryGate.release();
    await vi.waitFor(async () => {
      expect((await harness.state()).llm).toMatchObject({ health: "ready", modelCount: 1 });
    });
    expect(harness.llm.resolveCalls).toBe(1);
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("created");

    await harness.dispose();
  });

  it("rolls back materialized Settings when the public LLM registry cannot resolve the model", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: true, credentialEpoch: 7 }),
      credential: "configured-unit-test-key",
    });
    harness.llm.rejectExactModels = true;
    installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    await vi.waitFor(async () => {
      expect((await harness.state()).llm.health).toBe("error");
      expect(harness.settings.llmRoute).toBeUndefined();
    });
    expect(harness.llm.resolveCalls).toBeGreaterThan(1);
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("none");
    expect(harness.loggerErrors).toEqual([]);

    await harness.dispose();
  });

  it("restores the exact pre-materialization route when the ownership ledger write fails", async () => {
    const secret = "unit-test-credential-must-not-escape";
    const previousRoute = {
      models: [{ id: "user/manual-model", label: "Preserve me" }],
      userHeaderPolicy: "preserve",
    };
    const harness = new RuntimeHarness({
      config: configWith({ llm: true, credentialEpoch: 11 }),
      credential: secret,
      llmRoute: previousRoute,
    });
    harness.settings.failConfigMutationOnAttempt = 2;
    installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    await vi.waitFor(async () => {
      expect((await harness.state()).llm.health).toBe("error");
    });
    const state = await harness.state();
    expect(harness.settings.llmRoute).toEqual(previousRoute);
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("none");
    expect(harness.settings.runtimeMutations.filter((namespace) => namespace === "llm-pi-ai"))
      .toHaveLength(2);
    expect(harness.loggerErrors).toEqual([]);
    expect(JSON.stringify({
      state,
      config: harness.settings.config,
      route: harness.settings.llmRoute,
      mutations: harness.settings.runtimeMutations,
      logs: harness.loggerErrors,
    })).not.toContain(secret);

    await harness.dispose();
  });

  it("stays non-ready and emits only a fixed diagnostic when ledger write and rollback both fail", async () => {
    const secret = "unit-test-double-failure-credential";
    const harness = new RuntimeHarness({
      config: configWith({ llm: true, credentialEpoch: 12 }),
      credential: secret,
    });
    harness.settings.failConfigMutationOnAttempt = 2;
    harness.settings.failLlmMutationOnAttempt = 2;
    installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    await vi.waitFor(async () => {
      expect((await harness.state()).llm.health).toBe("error");
      expect(harness.loggerErrors).toHaveLength(1);
    });
    const state = await harness.state();
    expect(state.llm.health).not.toBe("ready");
    expect(harness.settings.llmRoute).toMatchObject({ models: [MODEL] });
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("none");
    expect(harness.loggerErrors).toEqual([[
      "MODELLIX_LLM_OWNERSHIP_ROLLBACK_FAILED: failed to restore the previous LLM settings snapshot",
    ]]);
    expect(JSON.stringify({
      state,
      config: harness.settings.config,
      route: harness.settings.llmRoute,
      mutations: harness.settings.runtimeMutations,
      logs: harness.loggerErrors,
    })).not.toContain(secret);

    await harness.dispose();
  });

  it("recovers a crash after route write without claiming the uncommitted route or user drift", async () => {
    const secret = "unit-test-crash-recovery-credential";
    const operationId = "llm_interrupted_materialization_13";
    const planned = planLlmRouteMaterialization(
      undefined,
      [MODEL],
      EMPTY_LLM_ROUTE_LEDGER,
    );
    const interrupted = beginLlmMaterialization(
      configWith({ llm: true, credentialEpoch: 13 }),
      {
        operationId,
        startedAt: 13_000,
        expectedLlmSettingsRevision: 0,
        previousRouteFingerprint: emptyRouteFingerprint(),
        targetRouteOwnership: planned.ledger,
      },
    );
    const userRoute = {
      ...planned.route,
      userHeaderPolicy: "keep-me",
      models: [{ ...MODEL, name: "User-chosen label" }],
    };
    const harness = new RuntimeHarness({
      config: interrupted,
      credential: secret,
      llmRoute: userRoute,
      llmProvenance: operationId,
    });
    installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    await vi.waitFor(async () => {
      expect((await harness.state()).llm.health).toBe("error");
    });
    const state = await harness.state();
    expect(harness.settings.config.llmOwnership.materializationRecovery)
      .toMatchObject({ operationId: "llm_interrupted_materialization_13" });
    expect(harness.settings.config.llmOwnership.route).toMatchObject({ ownership: "none" });
    expect(harness.settings.llmRoute).toEqual(userRoute);
    expect(harness.loggerErrors).toContainEqual([
      "MODELLIX_LLM_MATERIALIZATION_RECOVERY_FAILED: pending ownership remains unresolved",
    ]);
    expect(JSON.stringify({
      state,
      config: harness.settings.config,
      route: harness.settings.llmRoute,
      warnings: harness.loggerWarnings,
      errors: harness.loggerErrors,
    })).not.toContain(secret);

    await harness.dispose();
  });

  it("commits exact planned ownership when the interrupted route CAS is proven", async () => {
    const operationId = "llm_interrupted_exact_route_15";
    const planned = planLlmRouteMaterialization(
      undefined,
      [MODEL],
      EMPTY_LLM_ROUTE_LEDGER,
    );
    const interrupted = beginLlmMaterialization(
      configWith({ llm: true, credentialEpoch: 15 }),
      {
        operationId,
        startedAt: 15_000,
        expectedLlmSettingsRevision: 0,
        previousRouteFingerprint: emptyRouteFingerprint(),
        targetRouteOwnership: planned.ledger,
      },
    );
    const harness = new RuntimeHarness({
      config: interrupted,
      credential: "unit-test-exact-route-credential",
      llmRoute: planned.route,
      llmProvenance: operationId,
    });
    installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });

    await ModellixRuntime.create(harness.context);
    await vi.waitFor(async () => {
      expect((await harness.state()).llm.health).toBe("ready");
    });

    expect(harness.settings.config.llmOwnership.materializationRecovery).toBeNull();
    expect(harness.settings.config.llmOwnership.route).toEqual(planned.ledger);
    expect(harness.settings.llmRoute).toEqual(planned.route);
    expect(harness.settings.llmProvenance).toBeUndefined();
    expect(harness.loggerWarnings).toContainEqual([
      "MODELLIX_LLM_MATERIALIZATION_RECOVERED: exact pending route ownership was committed",
    ]);

    await harness.dispose();
  });

  it("replays safely when the crash happened after the marker but before the route write", async () => {
    const operationId = "llm_interrupted_before_route_14";
    const interrupted = beginLlmMaterialization(
      configWith({ llm: true, credentialEpoch: 14 }),
      {
        operationId,
        startedAt: 14_000,
        expectedLlmSettingsRevision: 0,
        previousRouteFingerprint: emptyRouteFingerprint(),
        targetRouteOwnership: planLlmRouteMaterialization(
          undefined,
          [MODEL],
          EMPTY_LLM_ROUTE_LEDGER,
        ).ledger,
      },
    );
    const harness = new RuntimeHarness({
      config: interrupted,
      credential: "unit-test-before-route-credential",
    });
    installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);

    await vi.waitFor(async () => {
      expect((await harness.state()).llm.health).toBe("ready");
    });
    expect(harness.settings.config.llmOwnership.materializationRecovery).toBeNull();
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("created");
    expect(harness.settings.llmRoute).toMatchObject({ models: [MODEL] });

    await harness.dispose();
  });

  it.each([
    ["completed", "llm"],
    ["active", "llm"],
    ["deferred", "llm"],
    ["active", "settings"],
    ["deferred", "settings"],
  ] as const)(
    "reconciles a post-unset %s-onboarding removal after a transient %s failure",
    async (onboarding, failureKind) => {
      const planned = planLlmRouteMaterialization(undefined, [MODEL], EMPTY_LLM_ROUTE_LEDGER);
      const interruptedConfig = configWith({
        llm: false,
        credentialEpoch: 7,
        onboarding,
        base: {
          ...createDefaultConfig(),
          llmOwnership: {
            ...createDefaultConfig().llmOwnership,
            route: planned.ledger,
          },
        },
      });
      const harness = new RuntimeHarness({
        config: interruptedConfig,
        credential: "configured-before-interruption",
        llmRoute: planned.route,
      });
      installFetch(rejectUnexpectedFetch);
      await ModellixRuntime.create(harness.context);

      // One independent downstream write fails after Credential unset. Recovery
      // must reuse the confirmed mutation epoch without replaying unset.
      if (failureKind === "llm") {
        harness.settings.failNextLlmMutation = true;
      } else {
        harness.settings.failConfigMutationOnAttempt =
          harness.settings.configMutationAttempts + 1;
      }
      const failed = await harness.rpc(
        "credential/remove",
        { version: 1, expectedCredentialEpoch: 7 },
      );
      expect(failed).toMatchObject({ ok: false, error: { code: "internal" } });
      expect(harness.credentials.value).toBeUndefined();
      const recoveredInProcess = await harness.state();
      expect(recoveredInProcess).toMatchObject({
        credential: { configured: false, credentialEpoch: 8 },
        onboarding: { status: "active", recoveryPending: false, recoveryRequestId: null },
        llm: { health: "disabled" },
      });
      expect(harness.settings.config).toMatchObject({
        credentialEpoch: 8,
        onboarding: { status: "active" },
        llmOwnership: { route: { ownership: "none" } },
      });
      expect(harness.settings.llmRoute).toBeUndefined();
      expect(harness.credentials.unsetCalls).toBe(1);
      await harness.dispose();

      await harness.restartContext();
      await ModellixRuntime.create(harness.context);
      const recovered = await harness.state();
      expect(recovered).toMatchObject({
        credential: { configured: false, credentialEpoch: 8 },
        onboarding: { status: "active", recoveryPending: false, recoveryRequestId: null },
        llm: { health: "disabled" },
      });
      expect(harness.settings.config.llmOwnership.route.ownership).toBe("none");
      expect(harness.settings.llmRoute).toBeUndefined();
      expect(harness.credentials.unsetCalls).toBe(1);

      await harness.dispose();
    },
  );

  it("reconciles an unset that committed before its provider acknowledgement failed", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: false, credentialEpoch: 11 }),
      credential: "configured-before-uncertain-unset",
    });
    installFetch(rejectUnexpectedFetch);
    await ModellixRuntime.create(harness.context);
    harness.credentials.failNextUnsetAfterCommit = true;

    const removed = await harness.rpcValue<{ accepted: boolean; state: ModellixRuntimeState }>(
      "credential/remove",
      { version: 1, expectedCredentialEpoch: 11 },
    );

    expect(removed.accepted).toBe(true);
    expect(removed.state).toMatchObject({
      credential: { configured: false, credentialEpoch: 12 },
      onboarding: { status: "active", recoveryPending: false },
    });
    expect(harness.settings.config).toMatchObject({
      credentialEpoch: 12,
      onboarding: { status: "active" },
    });
    expect(harness.credentials.unsetCalls).toBe(1);
    await harness.dispose();

    await harness.restartContext();
    await ModellixRuntime.create(harness.context);
    expect(await harness.state()).toMatchObject({
      credential: { configured: false, credentialEpoch: 12 },
      onboarding: { status: "active", recoveryPending: false },
    });
    expect(harness.credentials.unsetCalls).toBe(1);

    await harness.dispose();
  });

  it("aborts an in-flight startup refresh and performs no Settings write after unload", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: true, credentialEpoch: 2 }),
      credential: "configured-unit-test-key",
    });
    let catalogStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      catalogStarted = resolve;
    });
    installFetch(async (input, init) => {
      if (String(input) !== CATALOG_URL) return rejectUnexpectedFetch(input);
      catalogStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new DOMException("stopped", "AbortError"));
        if (init?.signal?.aborted === true) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    await ModellixRuntime.create(harness.context);
    await started;
    expect(harness.settings.runtimeMutations).toHaveLength(0);

    await harness.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.settings.runtimeMutations).toHaveLength(0);
    expect(harness.settings.llmRoute).toBeUndefined();

    // A provider-side settings edit after the watcher disposer ran cannot
    // resurrect a background reconciliation owned by the unloaded runtime.
    harness.settings.pushExternalConfig(configWith({
      llm: false,
      credentialEpoch: 2,
      base: harness.settings.config,
    }));
    await harness.settings.drainWatchers();
    expect(harness.settings.runtimeMutations).toHaveLength(0);
  });

  it("drains a startup refresh already past the LLM Settings commit point before unload completes", async () => {
    const harness = new RuntimeHarness({
      config: configWith({ llm: true, credentialEpoch: 9 }),
      credential: "configured-unit-test-key",
    });
    const gate = harness.settings.blockNextLlmMutation();
    installFetch(async (input) => {
      if (String(input) === CATALOG_URL) return jsonResponse({ data: [MODEL] });
      return rejectUnexpectedFetch(input);
    });
    await ModellixRuntime.create(harness.context);
    await gate.started;

    let disposed = false;
    const disposal = harness.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disposed).toBe(false);

    gate.release();
    await gate.finished;
    await disposal;
    await Promise.resolve();
    expect(harness.settings.llmRoute).toMatchObject({ models: [MODEL] });
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("created");
    const writesAtDispose = harness.settings.runtimeMutations.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.settings.runtimeMutations).toHaveLength(writesAtDispose);
  });
});

type RpcResultLike =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string } };

type RpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResultLike>;

type CredentialListener = (ref: string) => unknown;
type Cleanup = () => void | Promise<void>;

class RuntimeHarness {
  readonly settings: FakeSettings;
  readonly credentials: FakeCredentials;
  readonly llm: FakeLlmRegistry;
  readonly loggerErrors: unknown[][] = [];
  readonly loggerWarnings: unknown[][] = [];
  readonly #designValues: Record<string, string> = {};
  #credentialListeners = new Set<CredentialListener>();
  #toolPreExecuteListeners = new Set<(...args: unknown[]) => unknown>();
  #cleanups: Cleanup[] = [];
  #rpcHandler: RpcHandler | undefined;
  #disposed = false;
  context: Context;

  constructor(options: {
    readonly config: PluginConfig;
    readonly credential?: string;
    readonly llmRoute?: Record<string, unknown>;
    readonly llmProvenance?: string;
  }) {
    this.settings = new FakeSettings(options.config, options.llmRoute, options.llmProvenance);
    this.llm = new FakeLlmRegistry(this.settings);
    this.credentials = new FakeCredentials(
      options.credential,
      (ref) => this.emitCredential(ref),
    );
    this.context = this.createContext();
  }

  async rpc(endpoint: string, payload: unknown, signal = new AbortController().signal): Promise<RpcResultLike> {
    if (this.#rpcHandler === undefined) throw new Error("RPC handler is not active");
    return this.#rpcHandler(endpoint, payload, signal);
  }

  async rpcValue<T>(endpoint: string, payload: unknown): Promise<T> {
    const result = await this.rpc(endpoint, payload);
    if (!result.ok) throw new Error(`RPC failed: ${result.error.code}`);
    return result.value as T;
  }

  state(): Promise<ModellixRuntimeState> {
    return this.rpcValue("state/get", { version: 1 });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const cleanups = this.#cleanups.splice(0);
    await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()));
    this.#credentialListeners.clear();
    this.#toolPreExecuteListeners.clear();
    this.#rpcHandler = undefined;
  }

  async restartContext(): Promise<void> {
    await this.dispose();
    this.#disposed = false;
    this.#credentialListeners = new Set();
    this.#toolPreExecuteListeners = new Set();
    this.#cleanups = [];
    this.#rpcHandler = undefined;
    this.context = this.createContext();
  }

  private emitCredential(ref: string): void {
    // Mirrors CredentialProvider.notifyUpdated(): listeners start
    // synchronously, returned promises are observed but not awaited.
    for (const listener of this.#credentialListeners) {
      try {
        const result = listener(ref);
        if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
      } catch {
        // The official provider contains ordinary listener failures after the
        // durable Credential commit.
      }
    }
  }

  private createContext(): Context {
    const context = {
      settings: this.settings.service,
      credentials: this.credentials.service,
      llm: this.llm.service,
      web: {
        registerSearchProvider: () => () => undefined,
        registerFetchProvider: () => () => undefined,
      },
      tools: {
        register: () => () => undefined,
      },
      connection: {
        rpc: {
          handle: (
            channel: string,
            handler: RpcHandler,
            options: { authority: string },
          ) => {
            expect(channel).toBe("/modellix");
            expect(options).toEqual({ authority: "loopback" });
            this.#rpcHandler = handler;
            return () => {
              if (this.#rpcHandler === handler) this.#rpcHandler = undefined;
            };
          },
        },
      },
      storageDomain: {
        open: async () => {
          let closed = false;
          return {
            name: "modellix_design",
            global: {
              get: () => {
                if (closed) throw new Error("domain closed");
                return { version: 1 as const, values: { ...this.#designValues } };
              },
              set: async (next: { version: 1; values: Record<string, string> }) => {
                if (closed) throw new Error("domain closed");
                for (const key of Object.keys(this.#designValues)) delete this.#designValues[key];
                Object.assign(this.#designValues, next.values);
              },
            },
            table: () => {
              throw new Error("No Design tables are declared");
            },
            close: async () => {
              closed = true;
            },
          };
        },
      },
      effect: (setup: () => void | Cleanup) => {
        const cleanup = setup();
        if (typeof cleanup === "function") this.#cleanups.push(cleanup);
        return async () => cleanup?.();
      },
      on: (event: string, listener: CredentialListener) => {
        if (event === "credentials/reference-updated") {
          this.#credentialListeners.add(listener);
          const cleanup = () => {
            this.#credentialListeners.delete(listener);
          };
          this.#cleanups.push(cleanup);
          return cleanup;
        }
        if (event === "tools/pre-execute") {
          const toolListener = listener as unknown as (...args: unknown[]) => unknown;
          this.#toolPreExecuteListeners.add(toolListener);
          const cleanup = () => {
            this.#toolPreExecuteListeners.delete(toolListener);
          };
          this.#cleanups.push(cleanup);
          return cleanup;
        }
        throw new Error(`Unexpected event registration: ${event}`);
      },
      logger: {
        warn: (...args: unknown[]) => {
          this.loggerWarnings.push(args);
        },
        error: (...args: unknown[]) => {
          this.loggerErrors.push(args);
        },
        info: () => undefined,
      },
    };
    return context as unknown as Context;
  }
}

class FakeCredentials {
  value: string | undefined;
  failNextUnsetAfterCommit = false;
  referenceEvents = 0;
  setCalls = 0;
  unsetCalls = 0;
  readonly #emit: (ref: string) => void;

  constructor(initial: string | undefined, emit: (ref: string) => void) {
    this.value = initial;
    this.#emit = emit;
  }

  get service(): Context["credentials"] {
    return {
      resolve: async () => this.value === undefined
        ? undefined
        : { value: this.value, source: "memory" },
      describe: async () => this.value === undefined
        ? { configured: false, writable: true }
        : { configured: true, source: "memory", writable: true },
      set: async (_ref: string, value: string) => {
        this.setCalls += 1;
        this.value = value;
        this.publish();
      },
      unset: async () => {
        this.unsetCalls += 1;
        if (this.value === undefined) return;
        this.value = undefined;
        this.publish();
        if (this.failNextUnsetAfterCommit) {
          this.failNextUnsetAfterCommit = false;
          throw new Error("synthetic post-commit Credential acknowledgement failure");
        }
      },
    } as unknown as Context["credentials"];
  }

  externalSet(value: string): void {
    if (this.value === value) return;
    this.value = value;
    this.publish();
  }

  externalUnset(): void {
    if (this.value === undefined) return;
    this.value = undefined;
    this.publish();
  }

  private publish(): void {
    this.referenceEvents += 1;
    this.#emit(MODELLIX_CREDENTIAL_REF);
  }

}

interface FakeWatcher {
  active: boolean;
  tail: Promise<void>;
  readonly callback: (next: PluginConfig, previous: PluginConfig) => void | Promise<void>;
}

class FakeSettings {
  config: PluginConfig;
  failConfigMutationOnAttempt: number | undefined;
  configMutationAttempts = 0;
  failNextLlmMutation = false;
  failLlmMutationOnAttempt: number | undefined;
  llmMutationAttempts = 0;
  readonly runtimeMutations: string[] = [];
  readonly #watchers = new Set<FakeWatcher>();
  #configRevision = 0;
  #llmRevision = 0;
  #llmUser: Record<string, unknown>;
  #llmMutationBlocker: {
    readonly started: () => void;
    readonly wait: Promise<void>;
    readonly finished: () => void;
  } | undefined;

  constructor(
    config: PluginConfig,
    llmRoute?: Record<string, unknown>,
    llmProvenance?: string,
  ) {
    this.config = migrateConfig(config);
    this.#llmUser = {
      ...(llmRoute === undefined
        ? {}
        : { providers: { modellix: structuredClone(llmRoute) } }),
      ...(llmProvenance === undefined
        ? {}
        : { [MODELLIX_LLM_PROVENANCE_FIELD]: llmProvenance }),
    };
  }

  get llmRoute(): Record<string, unknown> | undefined {
    const providers = asRecord(this.#llmUser.providers);
    const route = providers?.modellix;
    return asRecord(route);
  }

  get llmProvenance(): string | undefined {
    const value = this.#llmUser[MODELLIX_LLM_PROVENANCE_FIELD];
    return typeof value === "string" ? value : undefined;
  }

  blockNextLlmMutation(): {
    readonly started: Promise<void>;
    readonly finished: Promise<void>;
    readonly release: () => void;
  } {
    if (this.#llmMutationBlocker !== undefined) throw new Error("An LLM mutation is already blocked");
    let signalStarted!: () => void;
    let signalFinished!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      signalFinished = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#llmMutationBlocker = { started: signalStarted, wait, finished: signalFinished };
    return { started, finished, release };
  }

  readonly service = {
    register: <T>(namespace: string) => {
      if (namespace !== "modellix") throw new Error(`Unexpected registration: ${namespace}`);
      return {
        get: () => this.config as unknown as T,
        watch: (
          callback: (next: T, previous: T) => void | Promise<void>,
        ) => this.addWatcher(callback as unknown as FakeWatcher["callback"]),
      };
    },
    describe: () => [
      {
        ns: "modellix",
        revision: this.#configRevision,
        value: this.config,
        user: this.config,
      },
      {
        ns: "llm-pi-ai",
        revision: this.#llmRevision,
        value: structuredClone(this.#llmUser),
        user: structuredClone(this.#llmUser),
      },
    ],
    mutate: async (
      namespace: string,
      operations: readonly FakePathOperation[],
      expectedRevision?: number,
    ) => this.mutate(namespace, operations, expectedRevision),
  } as unknown as Context["settings"];

  pushExternalConfig(next: PluginConfig): void {
    const previous = this.config;
    this.config = migrateConfig(next);
    if (sameJson(previous, this.config)) return;
    this.#configRevision += 1;
    this.notify(previous, this.config);
  }

  async drainWatchers(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const tails = [...this.#watchers].map((watcher) => watcher.tail);
      await Promise.allSettled(tails);
      await Promise.resolve();
      if ([...this.#watchers].every((watcher, index) => watcher.tail === tails[index])) return;
    }
  }

  private addWatcher(callback: FakeWatcher["callback"]): () => void {
    const watcher: FakeWatcher = { active: true, tail: Promise.resolve(), callback };
    this.#watchers.add(watcher);
    return () => {
      watcher.active = false;
      this.#watchers.delete(watcher);
    };
  }

  private async mutate(
    namespace: string,
    operations: readonly FakePathOperation[],
    expectedRevision?: number,
  ): Promise<void> {
    this.runtimeMutations.push(namespace);
    if (namespace === "modellix") {
      this.configMutationAttempts += 1;
      if (this.failConfigMutationOnAttempt === this.configMutationAttempts) {
        throw new Error("simulated ownership ledger Settings interruption");
      }
      if (expectedRevision !== undefined && expectedRevision !== this.#configRevision) {
        throw new SettingsConflictError(
          settingsNamespace("modellix"),
          expectedRevision,
          this.#configRevision,
        );
      }
      const previous = this.config;
      const next = applyOperations(previous as unknown as Record<string, unknown>, operations);
      this.config = migrateConfig(next);
      if (sameJson(previous, this.config)) return;
      this.#configRevision += 1;
      this.notify(previous, this.config);
      return;
    }
    if (namespace !== "llm-pi-ai") throw new Error(`Unexpected Settings namespace: ${namespace}`);
    this.llmMutationAttempts += 1;
    if (this.failNextLlmMutation) {
      this.failNextLlmMutation = false;
      throw new Error("simulated independent LLM Settings interruption");
    }
    if (this.failLlmMutationOnAttempt === this.llmMutationAttempts) {
      throw new Error("simulated LLM Settings rollback interruption");
    }
    if (expectedRevision !== undefined && expectedRevision !== this.#llmRevision) {
      throw new SettingsConflictError(
        settingsNamespace("llm-pi-ai"),
        expectedRevision,
        this.#llmRevision,
      );
    }
    const blocker = this.#llmMutationBlocker;
    if (blocker !== undefined) {
      this.#llmMutationBlocker = undefined;
      blocker.started();
      await blocker.wait;
    }
    const next = applyOperations(this.#llmUser, operations);
    if (!sameJson(next, this.#llmUser)) {
      this.#llmUser = next;
      this.#llmRevision += 1;
    }
    blocker?.finished();
  }

  private notify(previous: PluginConfig, next: PluginConfig): void {
    for (const watcher of this.#watchers) {
      const segment = watcher.tail
        .then(async () => {
          if (!watcher.active) return;
          await watcher.callback(next, previous);
        })
        .catch(() => undefined);
      watcher.tail = segment;
    }
  }
}

class FakeLlmRegistry {
  rejectExactModels = false;
  resolveCalls = 0;
  readonly #settings: FakeSettings;
  #resolutionBlocker: {
    readonly started: () => void;
    readonly wait: Promise<void>;
  } | undefined;

  constructor(settings: FakeSettings) {
    this.#settings = settings;
  }

  get service(): Context["llm"] {
    return {
      listProviders: () => this.#settings.llmRoute === undefined
        ? []
        : [{ id: "modellix", name: "Modellix" }],
      resolveModelInfo: async (provider: string, model: string, signal?: AbortSignal) => {
        this.resolveCalls += 1;
        const blocker = this.#resolutionBlocker;
        this.#resolutionBlocker = undefined;
        if (blocker !== undefined) {
          blocker.started();
          await blocker.wait;
        }
        signal?.throwIfAborted();
        if (this.rejectExactModels) throw new Error("simulated exact-model registry miss");
        if (provider !== "modellix") throw new Error("simulated provider registry miss");
        const route = this.#settings.llmRoute;
        const models = route?.models;
        const entry = Array.isArray(models)
          ? models.find((candidate) => asRecord(candidate)?.id === model)
          : undefined;
        const record = asRecord(entry);
        if (record === undefined) throw new Error("simulated exact-model registry miss");
        return {
          provider,
          id: model,
          name: typeof record.name === "string" ? record.name : model,
        };
      },
    } as unknown as Context["llm"];
  }

  blockNextResolution(): { readonly started: Promise<void>; readonly release: () => void } {
    if (this.#resolutionBlocker !== undefined) throw new Error("An LLM registry lookup is already blocked");
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#resolutionBlocker = { started: signalStarted, wait };
    return { started, release };
  }
}

type FakePathOperation =
  | { readonly op: "set"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: readonly string[] };

function applyOperations(
  source: Record<string, unknown>,
  operations: readonly FakePathOperation[],
): Record<string, unknown> {
  let next = structuredClone(source);
  for (const operation of operations) {
    if (operation.path.length === 0) {
      next = operation.op === "set" ? requireRecord(operation.value) : {};
      continue;
    }
    next = applyNestedOperation(next, operation);
  }
  return next;
}

function applyNestedOperation(
  source: Record<string, unknown>,
  operation: FakePathOperation,
): Record<string, unknown> {
  const [head, ...rest] = operation.path;
  if (head === undefined) return source;
  const next = structuredClone(source);
  if (rest.length === 0) {
    if (operation.op === "set") next[head] = structuredClone(operation.value);
    else delete next[head];
    return next;
  }
  next[head] = applyNestedOperation(asRecord(next[head]) ?? {}, {
    ...operation,
    path: rest,
  });
  return next;
}

function configWith(options: {
  readonly llm: boolean;
  readonly credentialEpoch?: number;
  readonly onboarding?: "active" | "completed" | "deferred";
  readonly base?: PluginConfig;
}): PluginConfig {
  const base = options.base ?? createDefaultConfig();
  return migrateConfig({
    ...base,
    credentialEpoch: options.credentialEpoch ?? base.credentialEpoch,
    services: {
      ...base.services,
      llm: { ...base.services.llm, enabled: options.llm },
    },
    onboarding: {
      status: options.onboarding ?? base.onboarding.status,
      saveRecovery: null,
    },
  });
}

function installFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn(implementation) as ReturnType<typeof vi.fn<typeof fetch>>;
  vi.stubGlobal("fetch", mock);
  return mock;
}

function rejectUnexpectedFetch(input: string | URL | Request): Promise<Response> {
  return Promise.reject(new Error(`Unexpected fetch: ${String(input)}`));
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyRouteFingerprint(): string {
  return createHash("sha256").update("undefined").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new TypeError("Expected a plain object");
  return structuredClone(record);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}
