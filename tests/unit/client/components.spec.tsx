// @vitest-environment jsdom

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ClientConnectionRpc,
  RpcResult,
} from "@deepseek-ai/dsh-client-connection/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", async () => {
  const React = await import("react");
  const { createPortal } = await import("react-dom");
  return {
    Button: ({
      variant,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: string }) => (
      <button data-variant={variant} {...props} />
    ),
    Input: React.forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
      ({ className, ...props }, ref) => (
        <span className={className} data-harness-input="">
          <input ref={ref} {...props} />
        </span>
      ),
    ),
    Modal: ({
      open,
      title,
      className,
      children,
    }: {
      readonly open: boolean;
      readonly title: string;
      readonly className?: string;
      readonly children?: ReactNode;
    }) => open
      ? createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={className}
          >
            {children}
          </div>,
          document.body,
        )
      : null,
    StateDot: ({ state }: { readonly state: string }) => (
      <span aria-hidden="true" data-state={state} />
    ),
    IconRightUpOutline14: ({ size }: { readonly size?: number }) => (
      <span aria-hidden="true" data-icon-size={size} />
    ),
  };
});

import { CredentialRecoveryOverlay } from "../../../src/client/CredentialRecoveryOverlay.js";
import type {
  ClientJsonValue,
  DesignFieldWire,
  DesignJobWire,
  DesignSnapshotWire,
  SettingsSnapshotWire,
} from "../../../src/client/contracts.js";
import { ModellixDesignView } from "../../../src/client/DesignView.js";
import { en, zh, type ModellixLocaleKey } from "../../../src/client/locales.js";
import { ModellixOnboarding } from "../../../src/client/Onboarding.js";
import { ModellixRpcClient } from "../../../src/client/rpc.js";
import { ModellixSettingsSection } from "../../../src/client/SettingsSection.js";
import type { ModellixTranslate } from "../../../src/client/shared.js";
import {
  DesignController,
  SettingsController,
} from "../../../src/client/store.js";

function translator(
  dictionary: Readonly<Record<ModellixLocaleKey, string>>,
): ModellixTranslate {
  return ((key: ModellixLocaleKey, params?: Record<string, unknown>): string => {
    let translated: string = dictionary[key];
    for (const [name, value] of Object.entries(params ?? {})) {
      translated = translated.replaceAll(`{${name}}`, String(value));
    }
    return translated;
  }) as ModellixTranslate;
}

const t = translator(zh);
const tEn = translator(en);

const RecoveryOverlayForTest = CredentialRecoveryOverlay as unknown as (
  props: {
    readonly controller: SettingsController;
    readonly t: ModellixTranslate;
  },
) => ReactNode;
const OnboardingForTest = ModellixOnboarding as unknown as (
  props: {
    readonly complete: () => void;
    readonly controller: SettingsController;
    readonly t: ModellixTranslate;
  },
) => ReactNode;
const SettingsSectionForTest = ModellixSettingsSection as unknown as (
  props: {
    readonly controller: SettingsController;
    readonly t: ModellixTranslate;
  },
) => ReactNode;
const DesignViewForTest = ModellixDesignView as unknown as (
  props: {
    readonly controller: DesignController;
    readonly settingsController: SettingsController;
    readonly t: ModellixTranslate;
  },
) => ReactNode;

interface RpcInvocation {
  readonly endpoint: string;
  readonly payload: unknown;
}

function testRpc(
  handler: (
    endpoint: string,
    payload: unknown,
  ) => RpcResult<unknown> | Promise<RpcResult<unknown>>,
): {
  readonly client: ModellixRpcClient;
  readonly calls: RpcInvocation[];
} {
  const calls: RpcInvocation[] = [];
  const call: ClientConnectionRpc["call"] = async (
    _channel,
    endpoint,
    payload,
  ) => {
    calls.push({ endpoint, payload });
    return handler(endpoint, payload);
  };
  return { client: new ModellixRpcClient({ call }), calls };
}

interface SettingsFixtureOptions {
  readonly configured?: boolean;
  readonly writable?: boolean;
  readonly source?: "local" | "env" | null;
  readonly verification?: SettingsSnapshotWire["credential"]["verification"];
  readonly invalidEpoch?: number | null;
  readonly settingsRevision?: number;
  readonly credentialEpoch?: number;
  readonly onboardingStatus?: SettingsSnapshotWire["onboarding"]["status"];
  readonly recoveryRequestId?: string | null;
  readonly services?: SettingsSnapshotWire["services"];
  readonly llm?: SettingsSnapshotWire["llm"];
}

function settingsFixture(
  options: SettingsFixtureOptions = {},
): SettingsSnapshotWire {
  const configured = options.configured ?? true;
  const writable = options.writable ?? true;
  const source = options.source ?? (configured ? (writable ? "local" : "env") : null);
  const credentialEpoch = options.credentialEpoch ?? (configured ? 2 : 0);
  return {
    version: 1,
    settingsRevision: options.settingsRevision ?? 7,
    services: options.services ?? { design: true, llm: true, web: true },
    credential: {
      configured,
      source,
      writable,
      revision: configured ? `epoch:${credentialEpoch}` : null,
      credentialEpoch,
      verification: options.verification ?? (configured ? "valid" : "unknown"),
      invalidEpoch: options.invalidEpoch ?? null,
    },
    onboarding: {
      status: options.onboardingStatus ?? (configured ? "completed" : "active"),
      recoveryPending: options.recoveryRequestId !== undefined &&
        options.recoveryRequestId !== null,
      recoveryRequestId: options.recoveryRequestId ?? null,
    },
    llm: options.llm ?? {
      health: configured ? "ready" : "missing",
      modelCount: configured ? 3 : 0,
      refreshedAt: configured ? Date.UTC(2026, 7, 26, 1, 2, 3) : null,
    },
  };
}

function field(overrides: Partial<DesignFieldWire>): DesignFieldWire {
  return {
    path: "/field",
    label: "Field",
    description: null,
    kind: "string",
    widget: "input",
    required: false,
    options: [],
    minimum: null,
    maximum: null,
    step: null,
    maxLength: null,
    disabledReason: null,
    ...overrides,
  };
}

function resourceJob(
  kind: "image" | "video" | "audio",
  index: number,
): DesignJobWire {
  const updatedAt = `2026-08-26T01:0${index}:00.000Z`;
  return {
    jobId: `job_${kind}`,
    modelId: "openai/gpt-image-2",
    status: "succeeded",
    createdAt: updatedAt,
    updatedAt,
    resources: [{
      id: `resource_${kind}`,
      kind,
      url: `https://cdn.example.test/${kind}`,
      downloadUrl: `https://cdn.example.test/${kind}?download=1`,
      expiresAt: "2026-08-27T01:00:00.000Z",
    }],
    diagnostic: null,
  };
}

function designFixture(
  overrides: Partial<DesignSnapshotWire> = {},
): DesignSnapshotWire {
  const fields: readonly DesignFieldWire[] = [
    field({
      path: "/prompt",
      label: "Prompt",
      description: "Describe the result",
      kind: "string",
      widget: "textarea",
      required: true,
      maxLength: 2_000,
    }),
    field({
      path: "/count",
      label: "Count",
      kind: "integer",
      widget: "input",
      required: true,
      minimum: 1,
      maximum: 4,
      step: 1,
    }),
    field({
      path: "/style",
      label: "Style",
      kind: "enum",
      widget: "select",
      options: [
        { label: "Natural", value: "natural" },
        { label: "Vivid", value: "vivid" },
      ],
    }),
    field({
      path: "/transparent",
      label: "Transparent",
      kind: "boolean",
      widget: "switch",
    }),
    field({
      path: "/metadata",
      label: "Metadata",
      kind: "object",
      widget: "json",
    }),
  ];
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
      {
        id: "example/video-model",
        label: "Example Video",
        kind: "video",
        featured: false,
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
      fields,
      parameters: {
        "/prompt": "",
        "/count": 1,
        "/style": "natural",
        "/transparent": false,
        "/metadata": { source: "test" },
      },
    },
    proposal: null,
    jobs: [],
    notice: null,
    ...overrides,
  };
}

function acceptedSettings(state: SettingsSnapshotWire): RpcResult<unknown> {
  return { ok: true, value: { version: 1, accepted: true, state } };
}

function acceptedDesign(state: DesignSnapshotWire): RpcResult<unknown> {
  return { ok: true, value: state };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.documentElement.lang = "";
  vi.useRealTimers();
});

describe("Credential recovery overlay", () => {
  it("does not nag again for a dismissed request token and reopens for a new explicit request", async () => {
    let current = settingsFixture({
      verification: "invalid",
      invalidEpoch: 2,
      recoveryRequestId: "recovery_first",
    });
    const rpc = testRpc(async () => ({ ok: true, value: current }));
    const controller = new SettingsController(rpc.client);
    render(<RecoveryOverlayForTest controller={controller} t={t} />);

    expect(await screen.findByRole("dialog", { name: "更换 API Key" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await act(async () => {
      await controller.load();
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    current = {
      ...current,
      onboarding: {
        ...current.onboarding,
        recoveryRequestId: "recovery_second",
      },
    };
    await act(async () => {
      await controller.load();
    });
    expect(await screen.findByRole("dialog", { name: "更换 API Key" })).toBeTruthy();
    expect(rpc.calls.every(({ payload }) => !JSON.stringify(payload).includes("apiKey"))).toBe(true);
  });

  it("renders a missing-Key recovery gate without ever pre-filling a credential", async () => {
    const missing = settingsFixture({
      configured: false,
      source: null,
      credentialEpoch: 0,
      onboardingStatus: "deferred",
      recoveryRequestId: "recovery_missing",
    });
    const rpc = testRpc(async () => ({ ok: true, value: missing }));
    render(
      <RecoveryOverlayForTest
        controller={new SettingsController(rpc.client)}
        t={t}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "连接 Modellix" })).toBeTruthy();
    const keyInput = screen.getByLabelText("Modellix API Key") as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    expect(keyInput.value).toBe("");
  });

  it("uses a dismissible instruction dialog for a read-only environment credential", async () => {
    const readonly = settingsFixture({
      writable: false,
      source: "env",
      verification: "invalid",
      invalidEpoch: 2,
      recoveryRequestId: "recovery_env",
    });
    const rpc = testRpc(async () => ({ ok: true, value: readonly }));
    render(
      <RecoveryOverlayForTest
        controller={new SettingsController(rpc.client)}
        t={t}
      />,
    );

    expect(
      await screen.findByRole("dialog", {
        name: "Modellix API Key 需要在环境中更新",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/MODELLIX_API_KEY/u)).toBeTruthy();
    expect(screen.queryByLabelText("Modellix API Key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Credential dialog coordination", () => {
  it("keeps the Design missing-Key editor available through the shared lease", async () => {
    const missing = settingsFixture({
      configured: false,
      source: null,
      credentialEpoch: 0,
      onboardingStatus: "deferred",
    });
    const settingsRpc = testRpc(async () => ({ ok: true, value: missing }));
    const settingsController = new SettingsController(settingsRpc.client);
    const design = designFixture({ credentialReady: false });
    const designRpc = testRpc(async () => acceptedDesign(design));
    const appRoot = document.createElement("main");
    appRoot.id = "root";
    document.body.append(appRoot);
    const user = userEvent.setup();
    render(
      <>
        <DesignViewForTest
          controller={new DesignController(designRpc.client, "session_missing_key")}
          settingsController={settingsController}
          t={t}
        />
        <RecoveryOverlayForTest controller={settingsController} t={t} />
      </>,
      { container: appRoot },
    );

    expect(await screen.findByRole("dialog", { name: "连接 Modellix" })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(appRoot.inert).toBe(true);
    await user.click(screen.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(appRoot.inert).toBe(false);
    expect(screen.getByRole("button", { name: "配置 Key 后继续" }).dataset.variant).toBe(
      "primary",
    );
  });

  it("upgrades an open Settings editor for 401 recovery without stacking dialogs", async () => {
    let current = settingsFixture();
    const rpc = testRpc(async () => ({ ok: true, value: current }));
    const controller = new SettingsController(rpc.client);
    const appRoot = document.createElement("main");
    appRoot.id = "root";
    document.body.append(appRoot);
    const user = userEvent.setup();
    render(
      <>
        <SettingsSectionForTest controller={controller} t={t} />
        <RecoveryOverlayForTest controller={controller} t={t} />
      </>,
      { container: appRoot },
    );

    const trigger = await screen.findByRole("button", { name: "更换 API Key" });
    trigger.focus();
    await user.click(trigger);
    const keyInput = await screen.findByLabelText("Modellix API Key");
    await waitFor(() => expect(document.activeElement).toBe(keyInput));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(appRoot.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    current = settingsFixture({
      verification: "invalid",
      invalidEpoch: 2,
      recoveryRequestId: "recovery_settings_open",
    });
    await act(async () => {
      await controller.load();
    });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("这个 API Key 无效，请检查后重新输入。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "稍后处理" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    const save = screen.getByRole("button", { name: "保存并启用" });
    save.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(keyInput);

    await user.click(screen.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(appRoot.inert).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
  });

  it("queues recovery behind the remove confirmation and transfers one dialog lease", async () => {
    let current = settingsFixture();
    const rpc = testRpc(async () => ({ ok: true, value: current }));
    const controller = new SettingsController(rpc.client);
    const appRoot = document.createElement("main");
    appRoot.id = "root";
    document.body.append(appRoot);
    const user = userEvent.setup();
    render(
      <>
        <SettingsSectionForTest controller={controller} t={t} />
        <RecoveryOverlayForTest controller={controller} t={t} />
      </>,
      { container: appRoot },
    );

    await user.click(await screen.findByRole("button", { name: "移除 API Key" }));
    expect(screen.getByRole("dialog", { name: "移除 Modellix API Key？" })).toBeTruthy();

    current = settingsFixture({
      verification: "invalid",
      invalidEpoch: 2,
      recoveryRequestId: "recovery_while_removing",
    });
    await act(async () => {
      await controller.load();
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "更换 API Key" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByRole("dialog", { name: "更换 API Key" })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(appRoot.inert).toBe(true);

    await user.click(screen.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(appRoot.inert).toBe(false);
  });

  it("queues recovery behind an image preview and opens it after Escape closes the image", async () => {
    let currentSettings = settingsFixture();
    const settingsRpc = testRpc(async () => ({ ok: true, value: currentSettings }));
    const settingsController = new SettingsController(settingsRpc.client);
    const design = designFixture({ jobs: [resourceJob("image", 1)] });
    const designRpc = testRpc(async () => acceptedDesign(design));
    const appRoot = document.createElement("main");
    appRoot.id = "root";
    document.body.append(appRoot);
    const user = userEvent.setup();
    render(
      <>
        <DesignViewForTest
          controller={new DesignController(designRpc.client, "session_modal_queue")}
          settingsController={settingsController}
          t={t}
        />
        <RecoveryOverlayForTest controller={settingsController} t={t} />
      </>,
      { container: appRoot },
    );

    await user.click(await screen.findByRole("button", { name: "打开原图" }));
    expect(screen.getByRole("dialog", { name: "生成图片" })).toBeTruthy();

    currentSettings = settingsFixture({
      verification: "invalid",
      invalidEpoch: 2,
      recoveryRequestId: "recovery_while_viewing_image",
    });
    await act(async () => {
      await settingsController.load();
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "生成图片" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("dialog", { name: "更换 API Key" })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(appRoot.inert).toBe(true);

    await user.click(screen.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(appRoot.inert).toBe(false);
  });
});

describe("Modellix onboarding", () => {
  it("starts with all three services enabled and saves only the current fake draft", async () => {
    let current = settingsFixture({
      configured: false,
      source: null,
      credentialEpoch: 0,
      settingsRevision: 0,
      onboardingStatus: "active",
    });
    const rpc = testRpc(async (endpoint) => {
      if (endpoint === "credential/save") {
        current = settingsFixture({
          configured: true,
          credentialEpoch: 1,
          settingsRevision: 1,
          onboardingStatus: "completed",
        });
        return acceptedSettings(current);
      }
      return { ok: true, value: current };
    });
    const complete = vi.fn();
    const user = userEvent.setup();
    render(
      <OnboardingForTest
        complete={complete}
        controller={new SettingsController(rpc.client)}
        t={t}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "连接 Modellix" })).toBeTruthy();
    const switches = screen.getAllByRole("switch") as HTMLInputElement[];
    expect(switches).toHaveLength(3);
    expect(switches.every(({ checked }) => checked)).toBe(true);

    const keyInput = screen.getByLabelText("Modellix API Key") as HTMLInputElement;
    const inputRoot = keyInput.closest<HTMLElement>("[data-harness-input]");
    expect(inputRoot?.classList.contains("mdlx-input")).toBe(true);
    expect(inputRoot?.parentElement?.classList.contains("mdlx-input-row")).toBe(true);
    expect(inputRoot?.nextElementSibling).toBe(
      screen.getByRole("button", { name: "显示 API Key" }),
    );
    await user.type(keyInput, "fake-key-for-component-test");
    const visibility = screen.getByRole("button", { name: "显示 API Key" });
    await user.click(visibility);
    expect(keyInput.type).toBe("text");
    expect(visibility.getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "保存并启用" }));

    await waitFor(() => expect(complete).toHaveBeenCalled());
    const save = rpc.calls.find(({ endpoint }) => endpoint === "credential/save");
    expect(save?.payload).toMatchObject({
      apiKey: "fake-key-for-component-test",
      expectedCredentialEpoch: 0,
      services: { design: true, llm: true, web: true },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("persists the selected service defaults when the user chooses later", async () => {
    let current = settingsFixture({
      configured: false,
      source: null,
      credentialEpoch: 0,
      settingsRevision: 4,
      onboardingStatus: "active",
    });
    const rpc = testRpc(async (endpoint, payload) => {
      if (endpoint === "onboarding/defer") {
        const request = payload as { readonly services: SettingsSnapshotWire["services"] };
        current = {
          ...current,
          settingsRevision: 5,
          services: request.services,
          onboarding: {
            ...current.onboarding,
            status: "deferred",
          },
        };
        return acceptedSettings(current);
      }
      return { ok: true, value: current };
    });
    const complete = vi.fn();
    render(
      <OnboardingForTest
        complete={complete}
        controller={new SettingsController(rpc.client)}
        t={t}
      />,
    );

    await screen.findByRole("dialog", { name: "连接 Modellix" });
    fireEvent.click(screen.getByRole("switch", { name: /LLM 模型/u }));
    fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));

    await waitFor(() => expect(complete).toHaveBeenCalled());
    const deferred = rpc.calls.find(({ endpoint }) => endpoint === "onboarding/defer");
    expect(deferred?.payload).toMatchObject({
      expectedSettingsRevision: 4,
      services: { design: true, llm: false, web: true },
    });
  });
});

describe("Modellix settings", () => {
  it("shows credential/LLM health and executes toggle, refresh, and remove operations", async () => {
    let current = settingsFixture();
    const rpc = testRpc(async (endpoint, payload) => {
      if (endpoint === "settings/toggles") {
        const request = payload as { readonly services: SettingsSnapshotWire["services"] };
        current = {
          ...current,
          settingsRevision: current.settingsRevision + 1,
          services: request.services,
        };
        return acceptedSettings(current);
      }
      if (endpoint === "llm/refresh") {
        current = {
          ...current,
          llm: { health: "ready", modelCount: 4, refreshedAt: Date.now() },
        };
        return acceptedSettings(current);
      }
      if (endpoint === "credential/remove") {
        current = settingsFixture({
          configured: false,
          source: null,
          credentialEpoch: current.credential.credentialEpoch + 1,
          settingsRevision: current.settingsRevision + 1,
          onboardingStatus: "active",
          services: current.services,
        });
        return acceptedSettings(current);
      }
      return { ok: true, value: current };
    });
    render(
      <SettingsSectionForTest
        controller={new SettingsController(rpc.client)}
        t={t}
      />,
    );

    expect(await screen.findByText(/已配置，本机 Credential 管理/u)).toBeTruthy();
    expect(screen.getByText(/已验证/u)).toBeTruthy();
    expect(screen.getByText("目录可用")).toBeTruthy();
    expect(screen.getByText("可用模型：3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更换 API Key" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: /Design/u }));
    const saveButton = screen.getByRole("button", { name: "保存更改" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(rpc.calls.some(({ endpoint }) => endpoint === "settings/toggles")).toBe(true),
    );
    expect(
      rpc.calls.find(({ endpoint }) => endpoint === "settings/toggles")?.payload,
    ).toMatchObject({
      expectedSettingsRevision: 7,
      services: { design: false, llm: true, web: true },
    });

    fireEvent.click(screen.getByRole("button", { name: "刷新 LLM 模型" }));
    await waitFor(() => expect(screen.getByText("可用模型：4")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "移除 API Key" }));
    expect(
      await screen.findByRole("dialog", { name: "移除 Modellix API Key？" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(screen.getByText(/尚未配置/u)).toBeTruthy());
    expect(screen.getByRole("button", { name: "配置 API Key" })).toBeTruthy();
  });

  it("keeps an environment credential read-only and explains disabled LLM refresh", async () => {
    const current = settingsFixture({
      writable: false,
      source: "env",
      services: { design: true, llm: false, web: true },
      llm: { health: "disabled", modelCount: 0, refreshedAt: null },
    });
    const rpc = testRpc(async () => ({ ok: true, value: current }));
    render(
      <SettingsSectionForTest
        controller={new SettingsController(rpc.client)}
        t={t}
      />,
    );

    expect(await screen.findByText(/已由环境变量配置，只读/u)).toBeTruthy();
    expect(screen.getByText("环境变量提供的 Key 不能在此更换或移除。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更换 API Key" })).toBeNull();
    const refresh = screen.getByRole("button", { name: "刷新 LLM 模型" }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    expect(screen.getAllByText("LLM 功能已关闭").length).toBeGreaterThan(0);
  });

  it.each([
    { translate: t, locale: "zh-CN", browserLocale: "en-US" },
    { translate: tEn, locale: "en-US", browserLocale: "zh-CN" },
  ])(
    "formats the LLM refresh timestamp with $locale when the browser advertises $browserLocale",
    async ({ translate, locale, browserLocale }) => {
      document.documentElement.lang = browserLocale;
      const snapshot = settingsFixture();
      const rpc = testRpc(async () => ({ ok: true, value: snapshot }));
      render(
        <SettingsSectionForTest
          controller={new SettingsController(rpc.client)}
          t={translate}
        />,
      );
      const refreshedAt = snapshot.llm.refreshedAt;
      if (refreshedAt === null) throw new Error("fixture timestamp is missing");
      const formatted = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(refreshedAt));

      expect(
        await screen.findByText(translate("llmUpdated", { time: formatted })),
      ).toBeTruthy();
    },
  );
});

describe("Modellix Design view", () => {
  it("formats result history with the English UI locale on a Chinese browser", async () => {
    document.documentElement.lang = "zh-CN";
    const job = resourceJob("image", 1);
    const snapshot = designFixture({ jobs: [job] });
    const rpc = testRpc(async () => acceptedDesign(snapshot));
    const settingsRpc = testRpc(async () => ({ ok: true, value: settingsFixture() }));
    render(
      <DesignViewForTest
        controller={new DesignController(rpc.client, "session_locale")}
        settingsController={new SettingsController(settingsRpc.client)}
        t={tEn}
      />,
    );
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(job.createdAt));

    expect(
      await screen.findByText(tEn("jobCreated", { time: formatted })),
    ).toBeTruthy();
  });

  it("localizes proposal summaries and conflicts instead of rendering planner prose", async () => {
    const snapshot = designFixture({
      proposal: {
        proposalId: "proposal_conflict",
        baseDraftRevision: 5,
        summary: "2 parameter changes proposed.",
        changes: [{
          path: "/style",
          label: "Style",
          before: "natural",
          after: "vivid",
        }],
        conflicts: ["Untrusted planner clarification"],
      },
    });
    const rpc = testRpc(async () => acceptedDesign(snapshot));
    const settingsRpc = testRpc(async () => ({ ok: true, value: settingsFixture() }));
    render(
      <DesignViewForTest
        controller={new DesignController(rpc.client, "session_proposal_locale")}
        settingsController={new SettingsController(settingsRpc.client)}
        t={t}
      />,
    );

    expect(await screen.findByText("已建议 1 项参数变更。")).toBeTruthy();
    expect(
      screen.getByText("提议包含 1 项冲突，请调整指令后重新生成参数提议。"),
    ).toBeTruthy();
    expect(screen.queryByText("2 parameter changes proposed.")).toBeNull();
    expect(screen.queryByText("Untrusted planner clarification")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "应用变更" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("allows prompt-only generation and fences an immediate paid-submit double activation", async () => {
    const initial = designFixture({
      draft: {
        ...designFixture().draft!,
        fields: [designFixture().draft!.fields[0]!],
        parameters: { "/prompt": "" },
      },
    });
    let resolveSubmit: ((result: RpcResult<unknown>) => void) | undefined;
    const submitResponse = new Promise<RpcResult<unknown>>((resolve) => {
      resolveSubmit = resolve;
    });
    const rpc = testRpc(async (endpoint) => {
      if (endpoint === "design/submit") return submitResponse;
      return acceptedDesign(initial);
    });
    const settingsRpc = testRpc(async () => ({ ok: true, value: settingsFixture() }));
    const user = userEvent.setup();
    render(
      <DesignViewForTest
        controller={new DesignController(rpc.client, "session_test")}
        settingsController={new SettingsController(settingsRpc.client)}
        t={t}
      />,
    );

    const prompt = await screen.findByLabelText(/你想生成什么/u);
    const generate = screen.getByRole("button", { name: "确认并生成" }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    await user.type(prompt, "一只在窗边看雨的橘猫");
    expect(generate.disabled).toBe(false);

    act(() => {
      generate.click();
      generate.click();
    });
    await waitFor(() => expect(generate.disabled).toBe(true));
    expect(rpc.calls.filter(({ endpoint }) => endpoint === "design/submit")).toHaveLength(1);
    expect(
      rpc.calls.find(({ endpoint }) => endpoint === "design/submit")?.payload,
    ).toMatchObject({
      sessionId: "session_test",
      modelId: "openai/gpt-image-2",
      parameters: { "/prompt": "一只在窗边看雨的橘猫" },
    });

    await act(async () => {
      resolveSubmit?.(acceptedDesign({
        ...initial,
        jobs: [{
          jobId: "job_running",
          modelId: "openai/gpt-image-2",
          status: "running",
          createdAt: "2026-08-26T01:00:00.000Z",
          updatedAt: "2026-08-26T01:00:00.000Z",
          resources: [],
          diagnostic: null,
        }],
      }));
      await submitResponse;
    });
    expect(await screen.findByText("进行中")).toBeTruthy();
  });

  it("edits Schema parameters, proposes/applies changes, and presents every media result safely", async () => {
    const proposal = {
      proposalId: "proposal_test",
      baseDraftRevision: 5,
      summary: "将风格调整为鲜艳",
      changes: [{
        path: "/style",
        label: "Style",
        before: "natural" as ClientJsonValue,
        after: "vivid" as ClientJsonValue,
      }],
      conflicts: [] as readonly string[],
    };
    let current = designFixture({
      jobs: [
        resourceJob("image", 1),
        resourceJob("video", 2),
        resourceJob("audio", 3),
        {
          jobId: "job_failed",
          modelId: "openai/gpt-image-2",
          status: "failed",
          createdAt: "2026-08-26T01:04:00.000Z",
          updatedAt: "2026-08-26T01:04:00.000Z",
          resources: [],
          diagnostic: { code: "generation-failed", retryable: false },
        },
      ],
    });
    const rpc = testRpc(async (endpoint) => {
      if (endpoint === "design/propose") {
        current = { ...current, proposal };
      } else if (endpoint === "design/proposal/apply") {
        current = {
          ...current,
          proposal: null,
          draft: current.draft === null ? null : {
            ...current.draft,
            draftRevision: current.draft.draftRevision + 1,
          },
        };
      }
      return acceptedDesign(current);
    });
    const settingsRpc = testRpc(async () => ({ ok: true, value: settingsFixture() }));
    const user = userEvent.setup();
    render(
      <DesignViewForTest
        controller={new DesignController(rpc.client, "session_parameters")}
        settingsController={new SettingsController(settingsRpc.client)}
        t={t}
      />,
    );

    const prompt = await screen.findByLabelText(/你想生成什么/u);
    await user.type(prompt, "一张电影感海报");
    fireEvent.change(screen.getByLabelText(/Count/u), { target: { value: "2" } });
    await user.click(screen.getByText("高级参数（3）"));
    await user.selectOptions(screen.getByLabelText(/Style/u), "1");
    await user.click(screen.getByRole("switch", { name: /Transparent/u }));

    const metadata = screen.getByLabelText(/Metadata/u);
    fireEvent.change(metadata, { target: { value: '{"broken":' } });
    expect(screen.getByText("请输入有效的 JSON。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认并生成" }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.change(metadata, { target: { value: '{"quality":"high"}' } });
    expect(screen.queryByText("请输入有效的 JSON。")).toBeNull();

    await user.type(
      screen.getByRole("textbox", { name: "用对话调整参数" }),
      "把画面改得更鲜艳",
    );
    await user.click(screen.getByRole("button", { name: "生成参数提议" }));
    expect(await screen.findByRole("heading", { name: "待确认的参数变更" })).toBeTruthy();
    expect(screen.getByText("已建议 1 项参数变更。")).toBeTruthy();
    expect(screen.queryByText("将风格调整为鲜艳")).toBeNull();
    expect(screen.getByRole("button", { name: "应用变更" }).dataset.variant).toBe(
      "primary",
    );
    expect(screen.getByRole("button", { name: "确认并生成" }).dataset.variant).toBe(
      "outline",
    );

    await user.click(screen.getByRole("button", { name: "应用变更" }));
    await waitFor(() => expect(screen.queryByText("已建议 1 项参数变更。")).toBeNull());
    const applied = rpc.calls.find(({ endpoint }) => endpoint === "design/proposal/apply");
    expect(applied?.payload).toMatchObject({
      sessionId: "session_parameters",
      proposalId: "proposal_test",
      parameters: {
        "/prompt": "一张电影感海报",
        "/count": 2,
        "/style": "vivid",
        "/transparent": true,
        "/metadata": { quality: "high" },
      },
    });

    expect(screen.getByRole("img", { name: "生成结果预览" })).toBeTruthy();
    expect(screen.getByLabelText("生成视频结果预览")).toBeTruthy();
    expect(screen.getByLabelText("生成音频结果预览")).toBeTruthy();
    const downloads = screen.getAllByRole("link", { name: /下载结果/u });
    expect(downloads).toHaveLength(3);
    for (const link of downloads) {
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    }
    expect(screen.getByText("generation-failed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "打开原图" }));
    expect(screen.getByRole("dialog", { name: "生成图片" })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "生成结果预览" })).toHaveLength(2);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "生成图片" })).toBeNull(),
    );
  });
});
