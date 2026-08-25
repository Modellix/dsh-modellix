import type {
  ClientJsonValue,
  DesignSnapshotWire,
  ServiceTogglesWire,
  SettingsSnapshotWire,
} from "./contracts.js";
import { ModellixClientRpcError, ModellixRpcClient } from "./rpc.js";

export type ClientOperation =
  | "load"
  | "save-onboarding"
  | "defer-onboarding"
  | "save-toggles"
  | "replace-credential"
  | "remove-credential"
  | "refresh-llm"
  | "refresh-design"
  | "select-model"
  | "propose"
  | "apply-proposal"
  | "reject-proposal"
  | "submit";

export interface ResourceState<T> {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly data: T | null;
  readonly pending: ClientOperation | null;
  readonly errorCode: string | null;
}

export interface SnapshotSource<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

class ResourceStore<T> implements SnapshotSource<ResourceState<T>> {
  #snapshot: ResourceState<T> = {
    status: "idle",
    data: null,
    pending: null,
    errorCode: null,
  };
  readonly #listeners = new Set<() => void>();

  getSnapshot = (): ResourceState<T> => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  publish(snapshot: ResourceState<T>): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

abstract class ResourceController<T> {
  readonly store = new ResourceStore<T>();
  #generation = 0;

  protected async perform(
    operation: ClientOperation,
    task: () => Promise<T>,
  ): Promise<boolean> {
    const generation = ++this.#generation;
    const previous = this.store.getSnapshot();
    this.store.publish({
      status: previous.data === null ? "loading" : previous.status,
      data: previous.data,
      pending: operation,
      errorCode: null,
    });
    try {
      const data = await task();
      if (generation !== this.#generation) return false;
      this.store.publish({
        status: "ready",
        data,
        pending: null,
        errorCode: null,
      });
      return true;
    } catch (error) {
      if (generation !== this.#generation) return false;
      const errorCode = clientErrorCode(error);
      if (errorCode === "cancelled") {
        this.store.publish({
          ...previous,
          pending: null,
          errorCode: null,
        });
        return false;
      }
      const latest =
        error instanceof ModellixClientRpcError && error.state !== null
          ? (error.state as T)
          : previous.data;
      this.store.publish({
        status: "error",
        data: latest,
        pending: null,
        errorCode,
      });
      return false;
    }
  }

  protected publishData(data: T): void {
    ++this.#generation;
    this.store.publish({
      status: "ready",
      data,
      pending: null,
      errorCode: null,
    });
  }
}

export class SettingsController extends ResourceController<SettingsSnapshotWire> {
  readonly #rpc: ModellixRpcClient;

  constructor(rpc: ModellixRpcClient) {
    super();
    this.#rpc = rpc;
  }

  load(signal?: AbortSignal): Promise<boolean> {
    return this.perform("load", () => this.#rpc.settings(signal));
  }

  saveOnboarding(
    apiKey: string,
    services: ServiceTogglesWire,
    expectedCredentialEpoch: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.perform("save-onboarding", () =>
      this.#rpc.saveOnboarding(
        apiKey,
        services,
        expectedCredentialEpoch,
        signal,
      ),
    );
  }

  async deferOnboarding(
    services: ServiceTogglesWire,
    expectedSettingsRevision: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.perform("defer-onboarding", () =>
      this.#rpc.deferOnboarding(services, expectedSettingsRevision, signal),
    );
  }

  updateToggles(
    services: ServiceTogglesWire,
    expectedSettingsRevision: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.perform("save-toggles", () =>
      this.#rpc.updateToggles(services, expectedSettingsRevision, signal),
    );
  }

  replaceCredential(
    apiKey: string,
    expectedCredentialEpoch: number,
    services: ServiceTogglesWire,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.perform("replace-credential", () =>
      this.#rpc.replaceCredential(
        apiKey,
        expectedCredentialEpoch,
        services,
        signal,
      ),
    );
  }

  removeCredential(
    expectedCredentialEpoch: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.perform("remove-credential", () =>
      this.#rpc.removeCredential(expectedCredentialEpoch, signal),
    );
  }

  async refreshLlmCatalog(signal?: AbortSignal): Promise<boolean> {
    return this.perform("refresh-llm", () => this.#rpc.refreshLlmCatalog(signal));
  }
}

export class DesignController extends ResourceController<DesignSnapshotWire> {
  readonly #rpc: ModellixRpcClient;
  readonly sessionId: string;

  constructor(rpc: ModellixRpcClient, sessionId: string) {
    super();
    this.#rpc = rpc;
    this.sessionId = sessionId;
  }

  load(signal?: AbortSignal): Promise<boolean> {
    return this.perform("load", () => this.#rpc.design(this.sessionId, signal));
  }

  refreshCatalog(signal?: AbortSignal): Promise<boolean> {
    return this.perform("refresh-design", () =>
      this.#rpc.refreshDesignCatalog(this.sessionId, signal),
    );
  }

  selectModel(modelId: string, signal?: AbortSignal): Promise<boolean> {
    return this.perform("select-model", () =>
      this.#rpc.selectDesignModel(this.sessionId, modelId, signal),
    );
  }

  propose(instruction: string, signal?: AbortSignal): Promise<boolean> {
    const draft = this.store.getSnapshot().data?.draft;
    if (draft === null || draft === undefined) return Promise.resolve(false);
    return this.perform("propose", () =>
      this.#rpc.proposeDesignParameters(
        {
          sessionId: this.sessionId,
          modelId: draft.modelId,
          instruction,
          draftRevision: draft.draftRevision,
          irContractHash: draft.irContractHash,
        },
        signal,
      ),
    );
  }

  applyProposal(proposalId: string, signal?: AbortSignal): Promise<boolean> {
    return this.perform("apply-proposal", () =>
      this.#rpc.applyDesignProposal(this.sessionId, proposalId, signal),
    );
  }

  rejectProposal(proposalId: string, signal?: AbortSignal): Promise<boolean> {
    return this.perform("reject-proposal", () =>
      this.#rpc.rejectDesignProposal(this.sessionId, proposalId, signal),
    );
  }

  submit(
    parameters: Readonly<Record<string, ClientJsonValue>>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const draft = this.store.getSnapshot().data?.draft;
    if (draft === null || draft === undefined) return Promise.resolve(false);
    return this.perform("submit", () =>
      this.#rpc.submitDesign(
        {
          sessionId: this.sessionId,
          modelId: draft.modelId,
          draftRevision: draft.draftRevision,
          irContractHash: draft.irContractHash,
          parameters,
        },
        signal,
      ),
    );
  }
}

function clientErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^(?:[a-z][a-z0-9-]{0,63}|MODELLIX_[A-Z0-9_]{1,55})$/u.test(error.code)
  ) {
    return error.code;
  }
  return "internal";
}
