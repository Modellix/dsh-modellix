// @vitest-environment jsdom

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", async () => {
  const { createPortal } = await import("react-dom");
  return {
    Button: ({ variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: string }) => (
      <button data-variant={variant} {...props} />
    ),
    IconRightUpOutline14: () => <span aria-hidden="true" />,
    Modal: ({ open, title, className, children }: {
      readonly open: boolean;
      readonly title: string;
      readonly className?: string;
      readonly children?: ReactNode;
    }) => open
      ? createPortal(<div role="dialog" aria-modal="true" aria-label={title} className={className}>{children}</div>, document.body)
      : null,
  };
});

import { ModellixMediaToolView } from "../../../src/client/MediaToolView.js";
import { zh, type ModellixLocaleKey } from "../../../src/client/locales.js";
import type { ModellixTranslate } from "../../../src/client/shared.js";

const t = ((key: ModellixLocaleKey, params?: Record<string, unknown>) => {
  let value: string = zh[key];
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}) as ModellixTranslate;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Modellix media Tool result view", () => {
  it("renders a safe interactive preview, appends its URL, and supports keyboard tabs", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const setDraft = vi.fn();
    const user = userEvent.setup();
    renderView({
      operation: "generate",
      service: "media",
      status: "succeeded",
      modelId: "openai/gpt-image-2",
      resources: [
        { kind: "image", url: "https://cdn.example.test/result.png" },
        { kind: "video", url: "https://cdn.example.test/result.mp4" },
      ],
    }, setDraft);

    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByRole("img", { name: "生成结果预览" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "添加 URL 到对话框" }));
    expect(setDraft).toHaveBeenCalledWith("已有上下文\nhttps://cdn.example.test/result.png");

    await user.click(screen.getByRole("button", { name: "放大图片" }));
    expect(screen.getByRole("dialog", { name: "生成图片" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "关闭" }));

    const preview = screen.getByRole("tab", { name: "预览" });
    fireEvent.keyDown(preview, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "JSON" }).textContent).toContain("gpt-image-2");
  });

  it("drops unsafe resource URLs instead of handing them to media elements", () => {
    renderView({
      operation: "generate",
      service: "media",
      status: "succeeded",
      resources: [{ kind: "image", url: "javascript:alert(1)" }],
    }, vi.fn());

    expect(screen.getByText("当前还没有可预览的媒体结果。")).toBeTruthy();
    expect(document.querySelector("img,video,audio")).toBeNull();
  });

  it.each(["running", "failed", "expired"])(
    "omits preview and JSON tabs while status is %s",
    (status) => {
      renderView({
        operation: "generate",
        service: "media",
        status,
        modelId: "openai/gpt-image-2",
        resources: [{ kind: "image", url: "https://cdn.example.test/result.png" }],
        ...(status === "failed"
          ? { diagnostic: { code: "generation-failed", message: "Failed" } }
          : {}),
      }, vi.fn());

      expect(screen.queryByRole("tab", { name: "预览" })).toBeNull();
      expect(screen.queryByRole("tab", { name: "JSON" })).toBeNull();
      expect(document.querySelector("img,video,audio")).toBeNull();
    },
  );

  it("reconciles a stale running tool block with the shared live Design job", () => {
    renderView({
      operation: "generate",
      service: "media",
      status: "running",
      jobId: "job-live",
      modelId: "minimax/speech-2.8-hd",
      resources: [],
    }, vi.fn(), {
      status: "ready",
      data: {
        version: 1,
        enabled: true,
        credentialReady: true,
        models: [],
        selectedModelId: null,
        draft: null,
        proposal: null,
        notice: null,
        jobs: [{
          jobId: "job-live",
          modelId: "minimax/speech-2.8-hd",
          status: "succeeded",
          createdAt: "2026-08-31T10:00:00.000Z",
          updatedAt: "2026-08-31T10:00:07.000Z",
          resources: [{
            id: "audio-1",
            kind: "audio",
            url: "https://cdn.example.test/voice.mp3",
            downloadUrl: "https://cdn.example.test/voice.mp3",
            expiresAt: null,
          }],
          diagnostic: null,
        }],
      },
      pending: null,
      errorCode: null,
      errorOperation: null,
    });

    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByText("生成中")).toBeNull();
    expect(document.querySelector('audio[aria-label="生成音频结果预览"]')).toBeTruthy();
    expect(screen.getByRole("tab", { name: "预览" })).toBeTruthy();
  });

  it("keeps a standalone get-result card visible", () => {
    const watchJob = vi.fn(() => () => undefined);
    renderView({
      operation: "get_result",
      service: "media",
      found: true,
      job: {
        jobId: "job-one",
        modelId: "minimax/speech-2.8-hd",
        status: "succeeded",
        resources: [{ kind: "audio", url: "https://cdn.example.test/voice.mp3" }],
      },
    }, vi.fn(), undefined, { watchJob });

    expect(screen.getByText("已完成")).toBeTruthy();
    expect(document.querySelector('audio[aria-label="生成音频结果预览"]')).toBeTruthy();
    expect(watchJob).toHaveBeenCalledWith("session-1", "job-one", "succeeded");
  });
});

function renderView(
  meta: unknown,
  setDraft: (value: string) => void,
  state: Record<string, unknown> | undefined = {
    status: "idle",
    data: null,
    pending: null,
    errorCode: null,
    errorOperation: null,
  },
  options: {
    readonly watchJob?: (...args: unknown[]) => () => void;
  } = {},
): ReturnType<typeof render> {
  const resolvedState = state ?? {
    status: "idle",
    data: null,
    pending: null,
    errorCode: null,
    errorOperation: null,
  };
  const View = ModellixMediaToolView as unknown as (props: Record<string, unknown>) => ReactNode;
  const store = {
    getSnapshot: () => resolvedState,
    subscribe: () => () => undefined,
  };
  const mediaCardListeners = new Set<() => void>();
  return render(<View
    block={{
      kind: "tool-result",
      seq: 1,
      time: 1,
      callId: "call-1",
      call: null,
      callTime: null,
      content: [],
      isError: false,
      meta,
      callView: null,
      subCalls: [],
    }}
    drawer={{
      controllerForSession: () => ({ store, load: vi.fn() }),
      watchJob: options.watchJob ?? (() => () => undefined),
      subscribeMediaCards: (listener: () => void) => {
        mediaCardListeners.add(listener);
        return () => mediaCardListeners.delete(listener);
      },
      getMediaCardVersion: () => 0,
      claimMediaCard: () => () => undefined,
      isMediaCardPrimary: () => true,
    }}
    inputActions={{ setDraft }}
    sessionId="session-1"
    t={t}
    useInput={(selector: (state: { draft: string }) => unknown) => selector({ draft: "已有上下文" })}
  />);
}
