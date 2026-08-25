import type { Context } from "@deepseek-ai/cordis";
import { SettingsConflictError, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODELLIX_CREDENTIAL_REF,
  createDefaultConfig,
  migrateConfig,
  type PluginConfig,
} from "../../../src/core/index.js";
import {
  EMPTY_LLM_ROUTE_LEDGER,
  planLlmRouteMaterialization,
} from "../../../src/llm/index.js";
import { ModellixRuntime, type ModellixRuntimeState } from "../../../src/host/runtime.js";

vi.mock("@deepseek-ai/dsh-anonymous-user-id", () => ({
  getOrCreateAnonymousUserId: () => "00000000-0000-4000-8000-000000000001",
}));

const MODEL = { id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol" } as const;
const VALIDATE_URL = "https://api.modellix.ai/api/v1/apikey/validate";
const CATALOG_URL = "https://llm.modellix.ai/v1/models";

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
      onboarding: { status: "active", recoveryPending: false },
      llm: { health: "disabled", modelCount: 0, refreshedAt: null },
    });
    expect(JSON.stringify(state)).not.toContain("apiKey");

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

  it("finishes an interrupted remove on restart without replaying the Credential mutation", async () => {
    const planned = planLlmRouteMaterialization(undefined, [MODEL], EMPTY_LLM_ROUTE_LEDGER);
    const interruptedConfig = configWith({
      llm: false,
      credentialEpoch: 7,
      onboarding: "completed",
      base: {
        ...createDefaultConfig(),
        llmOwnership: { route: planned.ledger },
      },
    });
    const harness = new RuntimeHarness({
      config: interruptedConfig,
      credential: "configured-before-interruption",
      llmRoute: planned.route,
    });
    installFetch(rejectUnexpectedFetch);
    await ModellixRuntime.create(harness.context);

    // Simulate a crash boundary after Credential unset: the independent LLM
    // Settings write fails, so plugin Settings still records the old epoch and
    // ownership ledger when the first runtime goes away.
    harness.settings.failNextLlmMutation = true;
    const failed = await harness.rpc(
      "credential/remove",
      { version: 1, expectedCredentialEpoch: 7 },
    );
    expect(failed).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(harness.credentials.value).toBeUndefined();
    expect(harness.settings.config).toMatchObject({
      credentialEpoch: 7,
      onboarding: { status: "completed" },
      llmOwnership: { route: { ownership: "created" } },
    });
    expect(harness.settings.llmRoute).toBeDefined();
    expect(harness.credentials.unsetCalls).toBe(1);
    await harness.dispose();

    await harness.restartContext();
    await ModellixRuntime.create(harness.context);
    const recovered = await harness.state();
    expect(recovered).toMatchObject({
      credential: { configured: false, credentialEpoch: 8 },
      onboarding: { status: "active", recoveryPending: false },
      llm: { health: "disabled" },
    });
    expect(harness.settings.config.llmOwnership.route.ownership).toBe("none");
    expect(harness.settings.llmRoute).toBeUndefined();
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
  }) {
    this.settings = new FakeSettings(options.config, options.llmRoute);
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
        warn: () => undefined,
        error: () => undefined,
        info: () => undefined,
      },
    };
    return context as unknown as Context;
  }
}

class FakeCredentials {
  value: string | undefined;
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
  failNextLlmMutation = false;
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

  constructor(config: PluginConfig, llmRoute?: Record<string, unknown>) {
    this.config = migrateConfig(config);
    this.#llmUser = llmRoute === undefined
      ? {}
      : { providers: { modellix: structuredClone(llmRoute) } };
  }

  get llmRoute(): Record<string, unknown> | undefined {
    const providers = asRecord(this.#llmUser.providers);
    const route = providers?.modellix;
    return asRecord(route);
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
    if (this.failNextLlmMutation) {
      this.failNextLlmMutation = false;
      throw new Error("simulated independent LLM Settings interruption");
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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
