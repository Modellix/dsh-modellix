import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import type { RpcResult } from "@deepseek-ai/dsh-host-apiproxy/api";
import { SettingsConflictError, settingsNamespace } from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-storage-domain";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-web";

import {
  MODELLIX_CREDENTIAL_REF,
  CredentialEpochConflictError,
  applyCredentialDescriptor,
  applyRuntimeUnauthorized,
  applyVerificationResult,
  beginOnboardingSave,
  completeOnboardingSave,
  createCredentialState,
  deferOnboarding,
  deriveModellixUserId,
  getServiceToggles,
  isCredentialInvalidError,
  markOnboardingCredentialSaved,
  setServiceToggles,
  type CredentialDescriptor,
  type CredentialState,
  type PluginConfig,
  type ServiceToggles,
} from "../core/index.js";
import { DesignError, type StoragePort } from "../design/index.js";
import {
  LlmCatalogCache,
  LlmCatalogClient,
  LlmCatalogRequestError,
  LlmRouteConflictError,
  LlmSettingsMaterializer,
  StaleLlmCatalogError,
  type LlmRouteLedger,
} from "../llm/index.js";
import { registerModellixWebProviders } from "../web/index.js";
import {
  CredentialBroker,
  CredentialValidationError,
  type HarnessCredentialPort,
} from "./credential-broker.js";
import { DesignHostController } from "./design-controller.js";
import { openDesignStorage, type ModellixDesignDomain } from "./design-storage.js";
import { registerModellixDesignTools } from "./design-tool.js";
import {
  PluginSettingsController,
  type SettingsServiceLike,
} from "./settings.js";

const RPC_CHANNEL = "/modellix";
const LLM_SETTINGS_NAMESPACE = settingsNamespace("llm-pi-ai");

export interface ModellixRuntimeState {
  readonly version: 1;
  readonly settingsRevision: number;
  readonly services: ServiceToggles;
  readonly credential: CredentialDescriptor & {
    readonly verification: CredentialState["verification"];
    readonly invalidEpoch: number | null;
  };
  readonly onboarding: {
    readonly status: PluginConfig["onboarding"]["status"];
    readonly recoveryPending: boolean;
  };
  readonly llm: {
    readonly health: "unknown" | "ready" | "missing" | "disabled" | "error" | "policy-blocked";
    readonly modelCount: number;
    readonly refreshedAt: number | null;
  };
}

interface LlmRuntimeState {
  health: ModellixRuntimeState["llm"]["health"];
  modelCount: number;
  refreshedAt: number | null;
}

/** Host composition root; every Secret-bearing operation terminates here. */
export class ModellixRuntime {
  readonly #ctx: Context;
  readonly #settings: PluginSettingsController;
  readonly #credential: CredentialBroker;
  readonly #catalog: LlmCatalogCache;
  readonly #materializer: LlmSettingsMaterializer;
  readonly #design: DesignHostController;
  readonly #designDomain: ModellixDesignDomain;
  readonly #userId: string;
  #config: PluginConfig;
  #credentialState: CredentialState;
  #llm: LlmRuntimeState = { health: "unknown", modelCount: 0, refreshedAt: null };
  #writeTail: Promise<void> = Promise.resolve();
  #designTail: Promise<void> = Promise.resolve();
  #credentialMutationInFlight = false;
  #designPollTimer: ReturnType<typeof setTimeout> | undefined;
  #disposeDesignTools: (() => void) | undefined;
  #closing = false;
  readonly #lifecycleAbort = new AbortController();

  static async create(ctx: Context): Promise<ModellixRuntime> {
    const settings = new PluginSettingsController(ctx.settings as unknown as SettingsServiceLike);
    const initial = settings.read().config;
    const ref = credentialRef(MODELLIX_CREDENTIAL_REF);
    const credentialPort: HarnessCredentialPort = {
      resolve: async () => ctx.credentials.resolve(ref),
      describe: async () => ctx.credentials.describe(ref),
      set: async (_ignored, value) => ctx.credentials.set(ref, value),
      unset: async () => ctx.credentials.unset(ref),
    };
    const credential = new CredentialBroker({
      credentials: credentialPort,
      initialCredentialEpoch: initial.credentialEpoch,
    });
    const designStorage = await openDesignStorage(ctx);
    const runtime = new ModellixRuntime(
      ctx,
      settings,
      credential,
      initial,
      designStorage.domain,
      designStorage.storage,
    );
    try {
      await runtime.initialize();
      return runtime;
    } catch (error) {
      await designStorage.domain.close();
      throw error;
    }
  }

  private constructor(
    ctx: Context,
    settings: PluginSettingsController,
    credential: CredentialBroker,
    initial: PluginConfig,
    designDomain: ModellixDesignDomain,
    designStorage: StoragePort,
  ) {
    this.#ctx = ctx;
    this.#settings = settings;
    this.#credential = credential;
    this.#designDomain = designDomain;
    this.#config = initial;
    this.#credentialState = createCredentialState({
      configured: false,
      source: null,
      writable: false,
      revision: null,
      credentialEpoch: initial.credentialEpoch,
    });
    this.#userId = deriveModellixUserId(String(getOrCreateAnonymousUserId()));
    const catalogClient = new LlmCatalogClient({
      resolveCredential: () => this.#credential.resolve(),
    });
    this.#catalog = new LlmCatalogCache(catalogClient);
    this.#materializer = new LlmSettingsMaterializer({
      describe: async () => {
        const descriptor = this.#ctx.settings.describe({ redactSecrets: true })
          .find((candidate) => candidate.ns === LLM_SETTINGS_NAMESPACE);
        return descriptor === undefined
          ? undefined
          : {
            revision: descriptor.revision,
            value: descriptor.value,
            ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
            ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
          };
      },
      mutate: (operations, expectedRevision) => this.#ctx.settings.mutate(
        LLM_SETTINGS_NAMESPACE,
        operations,
        expectedRevision,
      ),
    });
    this.#design = new DesignHostController({
      storage: designStorage,
      resolveCredential: () => this.#credential.resolve(),
      isCredentialEpochCurrent: (epoch) => epoch === this.#credential.credentialEpoch,
      onUnauthorized: (epoch) => {
        this.#credentialState = applyRuntimeUnauthorized(
          this.#credentialState,
          epoch,
          Date.now(),
        ).state;
      },
      isEnabled: () => this.#config.services.design.enabled,
      getLastModel: () => this.#config.services.design.lastModel,
      rememberModel: (modelId) => this.rememberDesignModel(modelId),
    });
  }

  private async initialize(): Promise<void> {
    this.#credentialState = applyCredentialDescriptor(
      this.#credentialState,
      await this.#credential.describe(),
    );
    await this.reconcileMissingCredentialState();
    this.syncDesignTools(this.#config.services.design.enabled);
    this.#ctx.effect(() => this.#settings.watch((next, previous) => {
      if (this.#closing) return undefined;
      this.#config = next;
      this.#catalog.invalidate();
      if (next.services.design.enabled !== previous.services.design.enabled) {
        this.syncDesignTools(next.services.design.enabled);
        if (next.services.design.enabled) this.scheduleDesignPoll(0);
      }
      if (
        next.services.llm.enabled !== previous.services.llm.enabled ||
        next.credentialEpoch !== previous.credentialEpoch
      ) {
        return this.enqueueWrite(() => this.reconcileLiveSettings());
      }
      return undefined;
    }), "dsh-modellix: live settings snapshot");

    this.#ctx.on("credentials/reference-updated", (updated) => {
      if (
        this.#closing || String(updated) !== MODELLIX_CREDENTIAL_REF ||
        this.#credentialMutationInFlight
      ) return;
      return this.enqueueWrite(async () => {
        const snapshot = this.#settings.read();
        const observed = await this.#credential.describe();
        const nextEpoch = Math.max(snapshot.config.credentialEpoch, this.#credential.credentialEpoch) + 1;
        this.#credential.synchronizeRecoveredEpoch(nextEpoch);
        const removedCompletedCredential =
          !observed.configured && snapshot.config.onboarding.status === "completed" &&
          snapshot.config.onboarding.saveRecovery === null;
        await this.#settings.replace({
          ...snapshot.config,
          credentialEpoch: nextEpoch,
          ...(removedCompletedCredential
            ? { onboarding: { status: "active", saveRecovery: null } }
            : {}),
        }, snapshot.revision);
        this.#config = this.#settings.read().config;
        this.#credentialState = applyCredentialDescriptor(
          this.#credentialState,
          await this.#credential.describe(),
        );
        this.#catalog.invalidate();
        this.#llm = { health: "unknown", modelCount: 0, refreshedAt: null };
        if (this.#config.services.llm.enabled && this.#credentialState.descriptor.configured) {
          await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
        }
        this.scheduleDesignPoll(0);
      });
    });

    this.#ctx.effect(() => registerModellixWebProviders(this.#ctx.web, {
      isEnabled: () => this.#config.services.web.enabled,
      hasCredential: () => this.#credentialState.descriptor.configured,
      resolveCredential: async () => {
        const hit = await this.#credential.resolve();
        return hit === undefined ? null : { apiKey: hit.value, credentialEpoch: hit.credentialEpoch };
      },
      getUserId: () => this.#userId,
      isCredentialEpochCurrent: (epoch) => epoch === this.#config.credentialEpoch,
      onCredentialRejected: async (epoch) => {
        if (epoch !== this.#config.credentialEpoch) return;
        this.#credentialState = applyRuntimeUnauthorized(
          this.#credentialState,
          epoch,
          Date.now(),
        ).state;
      },
    }), "dsh-modellix: native Web providers");

    this.#ctx.effect(() => this.#ctx.connection.rpc.handle(
      RPC_CHANNEL,
      (endpoint, payload, signal) => this.handleRpc(endpoint, payload, signal),
      { authority: "loopback" },
    ), "dsh-modellix: loopback configuration and Design RPC");

    this.#ctx.effect(() => {
      this.scheduleDesignPoll(2_000);
      return async () => {
        this.#closing = true;
        this.#lifecycleAbort.abort();
        this.#disposeDesignTools?.();
        this.#disposeDesignTools = undefined;
        if (this.#designPollTimer !== undefined) clearTimeout(this.#designPollTimer);
        await Promise.all([this.#writeTail, this.#designTail]);
        await this.#designDomain.close();
      };
    }, "dsh-modellix: Design repository and polling");

    if (!this.#config.services.llm.enabled) this.#llm.health = "disabled";
    else if (!this.#credentialState.descriptor.configured) this.#llm.health = "missing";
    else void this.enqueueWrite(
      () => this.refreshLlm(false, this.#lifecycleAbort.signal).then(() => undefined),
    ).catch(() => undefined);
  }

  private async handleRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>> {
    const operationSignal = AbortSignal.any([signal, this.#lifecycleAbort.signal]);
    if (this.#closing || operationSignal.aborted) return cancelled();
    if (!isRecord(payload) || payload.version !== 1) {
      return badRequest("Unsupported Modellix RPC version");
    }
    try {
      switch (endpoint) {
        case "state/get":
          return success(await this.state());
        case "credential/save":
          return success(await this.saveCredential(payload, operationSignal));
        case "credential/remove":
          return success(await this.removeCredential(payload));
        case "onboarding/defer":
          return success(await this.defer(payload));
        case "settings/toggles":
          return success(await this.updateToggles(payload));
        case "llm/refresh":
          return success(await this.refreshLlmRpc(operationSignal));
        default:
          if (endpoint.startsWith("design/")) {
            const snapshot = await this.enqueueDesignWrite(
              () => this.#design.handle(endpoint, payload, signal),
            );
            this.scheduleDesignPoll(5_000);
            return success(snapshot);
          }
          return badRequest("Unknown Modellix endpoint");
      }
    } catch (error) {
      if (operationSignal.aborted || isAbortFailure(error)) return cancelled();
      if (error instanceof CredentialEpochConflictError) {
        return success({
          version: 1,
          accepted: false,
          reason: "credential-changed",
          state: await this.state(),
        });
      }
      if (error instanceof SettingsConflictError) {
        return success({
          version: 1,
          accepted: false,
          reason: "settings-changed",
          state: await this.state(),
        });
      }
      if (error instanceof CredentialValidationError || error instanceof LlmCatalogRequestError) {
        return success({ version: 1, accepted: false, error: error.contract });
      }
      if (error instanceof DesignError) {
        return error.code === "INVALID_ARGUMENT" || error.code === "PARAMETER_INVALID"
          ? badRequest("The Design request is invalid")
          : internalError();
      }
      if (error instanceof StaleLlmCatalogError) {
        return success({ version: 1, accepted: false, reason: "credential-changed" });
      }
      return internalError();
    }
  }

  private async state(): Promise<ModellixRuntimeState> {
    const snapshot = this.#settings.read();
    this.#config = snapshot.config;
    this.#credentialState = applyCredentialDescriptor(
      this.#credentialState,
      await this.#credential.describe(),
    );
    const credential = this.#credentialState;
    return {
      version: 1,
      settingsRevision: snapshot.revision,
      services: getServiceToggles(this.#config),
      credential: {
        ...credential.descriptor,
        verification: credential.verification,
        invalidEpoch: credential.invalidEpoch?.credentialEpoch ?? null,
      },
      onboarding: {
        status: this.#config.onboarding.status,
        recoveryPending: this.#config.onboarding.saveRecovery !== null,
      },
      llm: { ...this.#llm },
    };
  }

  private saveCredential(payload: unknown, signal: AbortSignal): Promise<unknown> {
    const request = parseCredentialSave(payload);
    return this.enqueueWrite(async () => {
      let snapshot = this.#settings.read();
      if (this.#credential.credentialEpoch !== request.expectedCredentialEpoch) {
        return {
          version: 1,
          accepted: false,
          reason: "credential-changed",
          state: await this.state(),
        };
      }
      await this.#credential.validateCandidate(request.apiKey, signal);

      // A resubmission is the recovery protocol for the two-store write. The
      // comparison remains Host-local and neither Credential value is retained.
      if (snapshot.config.onboarding.saveRecovery !== null) {
        const recovery = snapshot.config.onboarding.saveRecovery;
        const stored = await this.#credential.resolve();
        if (stored?.value === request.apiKey) {
          let recovered = snapshot.config;
          if (recovery.phase === "credential-write-pending") {
            const recoveredEpoch = snapshot.config.credentialEpoch + 1;
            if (this.#credential.credentialEpoch > recoveredEpoch) {
              throw new CredentialEpochConflictError(
                recoveredEpoch,
                this.#credential.credentialEpoch,
              );
            }
            this.#credential.synchronizeRecoveredEpoch(recoveredEpoch);
            recovered = markOnboardingCredentialSaved(
              recovered,
              recovery.operationId,
              `epoch:${String(recoveredEpoch)}`,
            );
          }
          const completed = setServiceToggles(
            completeOnboardingSave(recovered, recovery.operationId),
            request.services,
          );
          await this.#settings.replace(completed, snapshot.revision);
          this.#config = this.#settings.read().config;
          this.#credentialState = applyCredentialDescriptor(
            this.#credentialState,
            await this.#credential.describe(),
          );
          this.#credentialState = applyVerificationResult(
            this.#credentialState,
            this.#credential.credentialEpoch,
            "valid",
          ).state;
          this.#catalog.invalidate();
          if (this.#config.services.llm.enabled) {
            await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
          }
          return { version: 1, accepted: true, state: await this.state() };
        }

        // The user deliberately supplied a different valid Key. Record any
        // already-observed mutation epoch, abandon only the non-secret intent,
        // then perform a fresh serialized save below.
        await this.#settings.replace({
          ...snapshot.config,
          credentialEpoch: this.#credential.credentialEpoch,
          onboarding: { status: "active", saveRecovery: null },
        }, snapshot.revision);
        snapshot = this.#settings.read();
      }
      this.#credentialState = applyCredentialDescriptor(
        this.#credentialState,
        await this.#credential.describe(),
      );
      const operationId = `save_${randomUUID().replaceAll("-", "")}`;
      const started = beginOnboardingSave(snapshot.config, {
        operationId,
        startedAt: Date.now(),
        intendedServices: request.services,
        expectedCredentialRevision: this.#credentialState.descriptor.revision,
      });
      await this.#settings.replace(started, snapshot.revision);

      this.#credentialMutationInFlight = true;
      let mutation: Awaited<ReturnType<CredentialBroker["set"]>>;
      try {
        mutation = await this.#credential.set(request.apiKey, request.expectedCredentialEpoch);
      } finally {
        this.#credentialMutationInFlight = false;
      }
      const confirmedCredential = await this.#credential.resolve();
      if (confirmedCredential?.value !== request.apiKey) {
        throw new Error("Credential changed before the onboarding save was confirmed");
      }

      snapshot = this.#settings.read();
      const marked = markOnboardingCredentialSaved(
        snapshot.config,
        operationId,
        `epoch:${String(mutation.credentialEpoch)}`,
      );
      const completed = completeOnboardingSave(marked, operationId);
      await this.#settings.replace(completed, snapshot.revision);
      this.#config = this.#settings.read().config;
      this.#credentialState = applyCredentialDescriptor(
        this.#credentialState,
        await this.#credential.describe(),
      );
      this.#credentialState = applyVerificationResult(
        this.#credentialState,
        mutation.credentialEpoch,
        "valid",
      ).state;
      this.#catalog.invalidate();
      if (this.#config.services.llm.enabled) {
        await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
      }
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private removeCredential(payload: unknown): Promise<unknown> {
    const expectedCredentialEpoch = parseExpectedEpoch(payload);
    return this.enqueueWrite(async () => {
      const snapshot = this.#settings.read();
      if (this.#credential.credentialEpoch !== expectedCredentialEpoch) {
        return {
          version: 1,
          accepted: false,
          reason: "credential-changed",
          state: await this.state(),
        };
      }
      this.#credentialMutationInFlight = true;
      let mutation: Awaited<ReturnType<CredentialBroker["unset"]>>;
      try {
        mutation = await this.#credential.unset(expectedCredentialEpoch);
      } finally {
        this.#credentialMutationInFlight = false;
      }
      if (await this.#credential.resolve() !== undefined) {
        throw new Error("Credential changed before removal was confirmed");
      }
      const withoutRoute = await this.#materializer.remove(toLlmLedger(snapshot.config));
      await this.#settings.replace({
        ...snapshot.config,
        credentialEpoch: mutation.credentialEpoch,
        onboarding: { status: "active", saveRecovery: null },
        llmOwnership: { route: withoutRoute },
      }, snapshot.revision);
      this.#config = this.#settings.read().config;
      this.#credentialState = applyCredentialDescriptor(
        this.#credentialState,
        await this.#credential.describe(),
      );
      this.#catalog.invalidate();
      this.#llm = { health: "missing", modelCount: 0, refreshedAt: null };
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private defer(payload: unknown): Promise<unknown> {
    const request = requireRecord(payload);
    const services = parseToggles(request);
    const expectedSettingsRevision = parseExpectedSettingsRevision(request);
    return this.enqueueWrite(async () => {
      const snapshot = this.#settings.read();
      if (snapshot.revision !== expectedSettingsRevision) {
        return { version: 1, accepted: false, reason: "settings-changed", state: await this.state() };
      }
      const next = deferOnboarding(snapshot.config, services);
      await this.#settings.replace(next, snapshot.revision);
      this.#config = this.#settings.read().config;
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private updateToggles(payload: unknown): Promise<unknown> {
    const request = requireRecord(payload);
    const services = parseToggles(request);
    const expectedSettingsRevision = parseExpectedSettingsRevision(request);
    return this.enqueueWrite(async () => {
      const snapshot = this.#settings.read();
      if (snapshot.revision !== expectedSettingsRevision) {
        return { version: 1, accepted: false, reason: "settings-changed", state: await this.state() };
      }
      let next = setServiceToggles(snapshot.config, services);
      if (!services.llm) {
        const ledger = await this.#materializer.remove(toLlmLedger(snapshot.config));
        next = { ...next, llmOwnership: { route: ledger } };
        this.#llm = { health: "disabled", modelCount: 0, refreshedAt: null };
      }
      await this.#settings.replace(next, snapshot.revision);
      this.#config = this.#settings.read().config;
      if (services.llm && this.#credentialState.descriptor.configured) {
        await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
      }
      if (services.design) this.scheduleDesignPoll(0);
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private async refreshLlmRpc(signal: AbortSignal): Promise<unknown> {
    return this.enqueueWrite(async () => {
      const result = await this.refreshLlm(true, signal);
      if (isRecord(result) && result.accepted === false) return result;
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private async reconcileLiveSettings(): Promise<void> {
    const snapshot = this.#settings.read();
    this.#config = snapshot.config;
    if (!snapshot.config.services.llm.enabled) {
      const ledger = await this.#materializer.remove(toLlmLedger(snapshot.config));
      if (!sameLlmLedger(ledger, snapshot.config.llmOwnership.route)) {
        await this.#settings.replace({
          ...snapshot.config,
          llmOwnership: { route: ledger },
        }, snapshot.revision);
        this.#config = this.#settings.read().config;
      }
      this.#llm = { health: "disabled", modelCount: 0, refreshedAt: null };
      return;
    }
    this.#credentialState = applyCredentialDescriptor(
      this.#credentialState,
      await this.#credential.describe(),
    );
    if (!this.#credentialState.descriptor.configured) {
      const ledger = await this.#materializer.remove(toLlmLedger(snapshot.config));
      if (!sameLlmLedger(ledger, snapshot.config.llmOwnership.route)) {
        await this.#settings.replace({
          ...snapshot.config,
          llmOwnership: { route: ledger },
        }, snapshot.revision);
        this.#config = this.#settings.read().config;
      }
      this.#llm = { health: "missing", modelCount: 0, refreshedAt: null };
      return;
    }
    await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
  }

  private async refreshLlm(force: boolean, signal?: AbortSignal): Promise<unknown> {
    if (!this.#config.services.llm.enabled) {
      this.#llm = { health: "disabled", modelCount: 0, refreshedAt: null };
      return { version: 1, accepted: false, reason: "disabled" };
    }
    if (!this.#credentialState.descriptor.configured) {
      this.#llm = { health: "missing", modelCount: 0, refreshedAt: null };
      return { version: 1, accepted: false, reason: "credential-missing" };
    }
    const capturedEpoch = this.#config.credentialEpoch;
    try {
      signal?.throwIfAborted();
      const catalog = await this.#catalog.get(capturedEpoch, {
        force,
        ...(signal === undefined ? {} : { signal }),
      });
      signal?.throwIfAborted();
      if (this.#closing) throw new DOMException("Plugin is stopping", "AbortError");
      if (capturedEpoch !== this.#config.credentialEpoch) throw new StaleLlmCatalogError(
        capturedEpoch,
        this.#config.credentialEpoch,
      );
      const ledger = await this.#materializer.materialize(catalog.models, toLlmLedger(this.#config));
      // Settings mutation is the commit point. It has no cancellation seam,
      // so once materialization started we must finish the companion plugin
      // ledger before reporting cancellation. The lifecycle owns this refresh
      // through #writeTail and therefore does not complete while that small
      // consistency transaction is still in flight.
      const snapshot = this.#settings.read();
      if (snapshot.config.credentialEpoch !== capturedEpoch || !snapshot.config.services.llm.enabled) {
        await this.#materializer.remove(ledger);
        throw new StaleLlmCatalogError(capturedEpoch, snapshot.config.credentialEpoch);
      }
      await this.#settings.replace({
        ...snapshot.config,
        llmOwnership: { route: ledger },
      }, snapshot.revision);
      this.#config = this.#settings.read().config;
      this.#llm = { health: "ready", modelCount: catalog.models.length, refreshedAt: catalog.fetchedAt };
      this.#credentialState = applyVerificationResult(
        this.#credentialState,
        capturedEpoch,
        "valid",
      ).state;
      if (signal?.aborted === true || this.#closing) {
        throw new DOMException("Plugin is stopping", "AbortError");
      }
      return { version: 1, accepted: true, modelCount: catalog.models.length, refreshedAt: catalog.fetchedAt };
    } catch (error) {
      if (isAbortFailure(error)) throw error;
      if (error instanceof LlmCatalogRequestError && isCredentialInvalidError(error.contract)) {
        this.#credentialState = applyRuntimeUnauthorized(
          this.#credentialState,
          capturedEpoch,
          Date.now(),
        ).state;
      }
      this.#llm = {
        health: error instanceof StaleLlmCatalogError
          ? "unknown"
          : error instanceof LlmRouteConflictError
            ? "policy-blocked"
            : "error",
        modelCount: this.#llm.modelCount,
        refreshedAt: this.#llm.refreshedAt,
      };
      throw error;
    }
  }

  /**
   * Finish an interrupted remove or an out-of-process Credential deletion.
   * The prior completed onboarding state is the non-secret evidence that one
   * Credential generation disappeared while this process was offline.
   */
  private async reconcileMissingCredentialState(): Promise<void> {
    if (this.#credentialState.descriptor.configured) return;
    const snapshot = this.#settings.read();
    const lostConfiguredCredential =
      snapshot.config.onboarding.status === "completed" &&
      snapshot.config.onboarding.saveRecovery === null;
    let ledger = toLlmLedger(snapshot.config);
    if (ledger.ownership !== "none") {
      try {
        ledger = await this.#materializer.remove(ledger);
      } catch {
        // Credential absence is authoritative even if the independently-owned
        // LLM namespace is not ready yet. Keeping the ledger makes cleanup
        // retryable on the next settings reconciliation or Host start.
      }
    }
    const nextEpoch = lostConfiguredCredential
      ? snapshot.config.credentialEpoch + 1
      : snapshot.config.credentialEpoch;
    const nextOnboarding = lostConfiguredCredential
      ? { status: "active" as const, saveRecovery: null }
      : snapshot.config.onboarding;
    if (
      nextEpoch !== snapshot.config.credentialEpoch ||
      nextOnboarding !== snapshot.config.onboarding ||
      !sameLlmLedger(ledger, snapshot.config.llmOwnership.route)
    ) {
      await this.#settings.replace({
        ...snapshot.config,
        credentialEpoch: nextEpoch,
        onboarding: nextOnboarding,
        llmOwnership: { route: ledger },
      }, snapshot.revision);
      this.#config = this.#settings.read().config;
    }
    this.#credential.synchronizeRecoveredEpoch(nextEpoch);
    this.#credentialState = applyCredentialDescriptor(
      this.#credentialState,
      await this.#credential.describe(),
    );
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#writeTail.then(operation);
    this.#writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private enqueueDesignWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#designTail.then(operation);
    this.#designTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private rememberDesignModel(modelId: string): Promise<void> {
    if (this.#closing) return Promise.resolve();
    return this.enqueueWrite(async () => {
      const snapshot = this.#settings.read();
      const recent = [
        modelId,
        ...snapshot.config.services.design.recentModels
          .filter((candidate) => candidate !== modelId),
      ].slice(0, 20);
      await this.#settings.replace({
        ...snapshot.config,
        services: {
          ...snapshot.config.services,
          design: {
            ...snapshot.config.services.design,
            lastModel: modelId,
            recentModels: recent,
          },
        },
      }, snapshot.revision);
      this.#config = this.#settings.read().config;
    });
  }

  private syncDesignTools(enabled: boolean): void {
    if (enabled && this.#disposeDesignTools === undefined) {
      this.#disposeDesignTools = registerModellixDesignTools(this.#ctx, {
        handle: (endpoint, payload, signal) => this.enqueueDesignWrite(
          () => this.#design.handle(endpoint, payload, signal),
        ),
      });
      return;
    }
    if (!enabled && this.#disposeDesignTools !== undefined) {
      this.#disposeDesignTools();
      this.#disposeDesignTools = undefined;
    }
  }

  private scheduleDesignPoll(delayMs: number): void {
    if (this.#closing || this.#designPollTimer !== undefined) return;
    this.#designPollTimer = setTimeout(() => {
      this.#designPollTimer = undefined;
      void this.enqueueDesignWrite(
        () => this.#design.pollRunning(this.#lifecycleAbort.signal),
      )
        .then((hasRunning) => {
          if (hasRunning) this.scheduleDesignPoll(5_000);
        })
        .catch(() => {
          if (!this.#closing) this.scheduleDesignPoll(15_000);
        });
    }, Math.max(0, delayMs));
  }
}

function toLlmLedger(config: PluginConfig): LlmRouteLedger {
  return {
    ownership: config.llmOwnership.route.ownership,
    appliedRouteFingerprint: config.llmOwnership.route.appliedRouteFingerprint,
    entries: config.llmOwnership.route.entries.map((entry) => ({ ...entry })),
  };
}

function sameLlmLedger(left: LlmRouteLedger, right: PluginConfig["llmOwnership"]["route"]): boolean {
  return left.ownership === right.ownership &&
    left.appliedRouteFingerprint === right.appliedRouteFingerprint &&
    JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

function parseCredentialSave(payload: unknown): {
  readonly apiKey: string;
  readonly expectedCredentialEpoch: number;
  readonly services: ServiceToggles;
} {
  const input = requireRecord(payload);
  if (typeof input.apiKey !== "string") throw new TypeError("apiKey is required");
  return {
    apiKey: input.apiKey,
    expectedCredentialEpoch: parseExpectedEpoch(input),
    services: parseToggles(input),
  };
}

function parseExpectedEpoch(payload: unknown): number {
  const input = requireRecord(payload);
  if (!Number.isSafeInteger(input.expectedCredentialEpoch) || (input.expectedCredentialEpoch as number) < 0) {
    throw new TypeError("expectedCredentialEpoch is invalid");
  }
  return input.expectedCredentialEpoch as number;
}

function parseExpectedSettingsRevision(input: Record<string, unknown>): number {
  if (!Number.isSafeInteger(input.expectedSettingsRevision) || (input.expectedSettingsRevision as number) < 0) {
    throw new TypeError("expectedSettingsRevision is invalid");
  }
  return input.expectedSettingsRevision as number;
}

function parseToggles(input: Record<string, unknown>): ServiceToggles {
  const services = isRecord(input.services) ? input.services : input;
  if (typeof services.design !== "boolean" || typeof services.llm !== "boolean" || typeof services.web !== "boolean") {
    throw new TypeError("all three service toggles are required");
  }
  return { design: services.design, llm: services.llm, web: services.web };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("payload must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function success(value: unknown): RpcResult<unknown> {
  return { ok: true, value };
}

function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: "bad-request", message, details: { issues: [] } } };
}

function cancelled(): RpcResult<unknown> {
  return { ok: false, error: { code: "cancelled", message: "The Modellix request was cancelled", details: {} } };
}

function internalError(): RpcResult<unknown> {
  return {
    ok: false,
    error: {
      code: "internal",
      message: "The Modellix operation could not be completed",
      details: {},
    },
  };
}
