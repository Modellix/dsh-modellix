import { describe, expect, it } from "vitest";
import type {
  ClientConnectionRpc,
  RpcResult,
} from "@deepseek-ai/dsh-client-connection/client";

import { ModellixRpcClient } from "../../../src/client/rpc.js";
import {
  DesignController,
  SettingsController,
} from "../../../src/client/store.js";

function state(revision: number): object {
  return {
    version: 1,
    settingsRevision: revision,
    services: { design: true, llm: true, web: true },
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
    llm: { health: "missing", modelCount: 0, refreshedAt: null },
  };
}

function design(jobs: readonly unknown[] = []): object {
  return {
    version: 1,
    enabled: true,
    credentialReady: true,
    models: [
      {
        id: "openai/gpt-image-2",
        label: "GPT Image 2",
        kind: "image",
        featured: true,
        available: true,
        unavailableReason: null,
      },
    ],
    selectedModelId: "openai/gpt-image-2",
    draft: {
      modelId: "openai/gpt-image-2",
      draftRevision: 5,
      irContractHash: "schemahash1234",
      primaryInputPath: "/prompt",
      fields: [
        {
          path: "/prompt",
          label: "Prompt",
          description: null,
          kind: "string",
          widget: "textarea",
          required: true,
          options: [],
          minimum: null,
          maximum: null,
          step: null,
          maxLength: null,
          disabledReason: null,
        },
      ],
      parameters: { "/prompt": "Default" },
    },
    proposal: null,
    jobs,
    notice: null,
  };
}

function rpcFrom(
  call: ClientConnectionRpc["call"],
): ModellixRpcClient {
  return new ModellixRpcClient({ call });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

describe("Modellix Client resource controllers", () => {
  it("publishes loading, ready, pending, and post-mutation settings snapshots", async () => {
    const calls: string[] = [];
    const rpc = rpcFrom(async (_channel, endpoint) => {
      calls.push(endpoint);
      return endpoint === "state/get"
        ? { ok: true, value: state(1) }
        : {
            ok: true,
            value: { version: 1, accepted: true, state: state(2) },
          };
    });
    const controller = new SettingsController(rpc);
    const observed: string[] = [];
    controller.store.subscribe(() => {
      const snapshot = controller.store.getSnapshot();
      observed.push(`${snapshot.status}:${snapshot.pending ?? "none"}`);
    });

    await expect(controller.load()).resolves.toBe(true);
    await expect(
      controller.updateToggles(
        { design: false, llm: true, web: true },
        1,
      ),
    ).resolves.toBe(true);

    expect(calls).toEqual(["state/get", "settings/toggles"]);
    expect(controller.store.getSnapshot()).toMatchObject({
      status: "ready",
      pending: null,
      errorCode: null,
      data: { settingsRevision: 2 },
    });
    expect(observed).toEqual([
      "loading:load",
      "ready:none",
      "ready:save-toggles",
      "ready:none",
    ]);
  });

  it("adopts the latest canonical state when a settings CAS conflicts", async () => {
    const rpc = rpcFrom(async (_channel, endpoint) => ({
      ok: true,
      value:
        endpoint === "state/get"
          ? state(1)
          : {
              version: 1,
              accepted: false,
              reason: "settings-changed",
              state: state(9),
            },
    }));
    const controller = new SettingsController(rpc);
    await controller.load();

    await expect(
      controller.updateToggles(
        { design: false, llm: false, web: false },
        1,
      ),
    ).resolves.toBe(false);
    expect(controller.store.getSnapshot()).toMatchObject({
      status: "error",
      errorCode: "settings-changed",
      errorOperation: "save-toggles",
      data: { settingsRevision: 9 },
    });
  });

  it("keeps uppercase stable Modellix codes and never stores Host prose", async () => {
    const rpc = rpcFrom(async () => ({
      ok: true,
      value: {
        version: 1,
        accepted: false,
        error: {
          code: "MODELLIX_UNAUTHORIZED",
          messageKey: "credential.invalid",
          message: "unsafe prose",
        },
      },
    }));
    const controller = new SettingsController(rpc);

    await expect(
      controller.replaceCredential(
        "fake-test-candidate",
        0,
        { design: true, llm: true, web: true },
      ),
    ).resolves.toBe(false);
    expect(controller.store.getSnapshot()).toEqual({
      status: "error",
      data: null,
      pending: null,
      errorCode: "MODELLIX_UNAUTHORIZED",
      errorOperation: "replace-credential",
    });
    expect(JSON.stringify(controller.store.getSnapshot())).not.toContain("unsafe prose");
  });

  it("fences late responses from an obsolete request generation", async () => {
    const first = deferred<RpcResult<unknown>>();
    const second = deferred<RpcResult<unknown>>();
    let count = 0;
    const rpc = rpcFrom(() => {
      count += 1;
      return count === 1 ? first.promise : second.promise;
    });
    const controller = new SettingsController(rpc);
    const firstLoad = controller.load();
    const secondLoad = controller.load();

    second.resolve({ ok: true, value: state(2) });
    await expect(secondLoad).resolves.toBe(true);
    first.resolve({ ok: true, value: state(1) });
    await expect(firstLoad).resolves.toBe(false);

    expect(controller.store.getSnapshot()).toMatchObject({
      status: "ready",
      data: { settingsRevision: 2 },
    });
  });

  it("restores the prior resource state after lifecycle cancellation", async () => {
    const rpc = rpcFrom(async (_channel, _endpoint, _payload, signal) =>
      new Promise<RpcResult<unknown>>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }));
    const controller = new SettingsController(rpc);
    const abort = new AbortController();
    const loading = controller.load(abort.signal);

    abort.abort();

    await expect(loading).resolves.toBe(false);
    expect(controller.store.getSnapshot()).toEqual({
      status: "idle",
      data: null,
      pending: null,
      errorCode: null,
      errorOperation: null,
    });
  });

  it("submits the current Design draft once with exact parameters", async () => {
    const payloads: unknown[] = [];
    const rpc = rpcFrom(async (_channel, endpoint, payload) => {
      payloads.push(payload);
      return { ok: true, value: design(endpoint === "design/submit" ? [] : []) };
    });
    const controller = new DesignController(rpc, "session-1");
    await controller.load();

    await expect(
      controller.submit({ "/prompt": "A precise test prompt", "/count": 2 }),
    ).resolves.toBe(true);

    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual({
      version: 1,
      sessionId: "session-1",
      modelId: "openai/gpt-image-2",
      draftRevision: 5,
      irContractHash: "schemahash1234",
      parameters: { "/prompt": "A precise test prompt", "/count": 2 },
    });
  });

  it("publishes the Design catalog refresh operation", async () => {
    const endpoints: string[] = [];
    const rpc = rpcFrom(async (_channel, endpoint) => {
      endpoints.push(endpoint);
      return { ok: true, value: design() };
    });
    const controller = new DesignController(rpc, "session-1");
    await controller.load();

    await expect(controller.refreshCatalog()).resolves.toBe(true);

    expect(endpoints).toEqual(["design/read", "design/refresh"]);
    expect(controller.store.getSnapshot()).toMatchObject({
      status: "ready",
      pending: null,
      errorCode: null,
    });
  });

  it("refuses paid Design operations for an unavailable selected model", async () => {
    const unavailable = design() as {
      models: Array<{ available: boolean; unavailableReason: string | null }>;
    };
    unavailable.models[0]!.available = false;
    unavailable.models[0]!.unavailableReason = "Removed from catalog";
    const endpoints: string[] = [];
    const rpc = rpcFrom(async (_channel, endpoint) => {
      endpoints.push(endpoint);
      return { ok: true, value: unavailable };
    });
    const controller = new DesignController(rpc, "session-1");
    await controller.load();

    await expect(controller.propose("Make it cinematic", {})).resolves.toBe(false);
    await expect(controller.submit({ "/prompt": "A test" })).resolves.toBe(false);
    expect(endpoints).toEqual(["design/read"]);
  });
});
