// @vitest-environment jsdom

import { createElement, type ButtonHTMLAttributes, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", async () => {
  const React = await import("react");
  return {
    Button: ({
      variant: _variant,
      size: _size,
      icon,
      children,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: string;
      size?: string;
      icon?: ReactNode;
    }) => React.createElement("button", props, icon, children),
    IconCloseOutline16: () => React.createElement("span", { "data-close-icon": "" }),
  };
});
vi.mock("../../../src/client/DesignView.js", async () => {
  const React = await import("react");
  return {
    ModellixDesignView: ({ advancedEditorOpen }: { advancedEditorOpen?: boolean }) =>
      React.createElement("div", {
        id: "mdlx-design-editor",
        "data-editor-open": String(advancedEditorOpen),
      }),
  };
});

import {
  DesignDrawerController,
  ModellixDesignDrawer,
} from "../../../src/client/DesignDrawer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Modellix Design drawer controller", () => {
  it("keeps one session-scoped editor, appends URLs, and restores launcher focus", async () => {
    const layout = { openDetails: vi.fn(), closeDetails: vi.fn() };
    const drawer = new DesignDrawerController({} as never, layout, () => true);
    const setDraft = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const focus = vi.spyOn(trigger, "focus");

    drawer.open("session-1", { setDraft }, "现有描述", trigger);
    expect(layout.closeDetails).toHaveBeenCalledOnce();
    expect(layout.openDetails).toHaveBeenCalledOnce();
    const controller = drawer.getSnapshot().controller;
    expect(drawer.getSnapshot()).toMatchObject({ open: true, sessionId: "session-1" });
    expect(controller).not.toBeNull();

    drawer.appendUrl("https://cdn.example.test/result.png");
    expect(setDraft).toHaveBeenCalledWith("现有描述\nhttps://cdn.example.test/result.png");
    expect(drawer.getSnapshot().draft).toContain("result.png");

    drawer.close();
    await Promise.resolve();
    expect(drawer.getSnapshot().open).toBe(false);
    expect(layout.closeDetails).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledOnce();

    drawer.open("session-1", { setDraft }, "next", trigger);
    expect(drawer.getSnapshot().controller).toBe(controller);
    drawer.releaseSession("session-1");
    expect(drawer.getSnapshot()).toMatchObject({ open: false, sessionId: null, controller: null });
  });

  it("reserves the Harness details column only at the desktop split breakpoint", () => {
    const layout = { openDetails: vi.fn(), closeDetails: vi.fn() };
    const drawer = new DesignDrawerController({} as never, layout, () => false);
    const trigger = document.createElement("button");

    drawer.open("session-1", { setDraft: vi.fn() }, "", trigger);
    expect(layout.openDetails).not.toHaveBeenCalled();
    expect(layout.closeDetails).not.toHaveBeenCalled();

    drawer.setSplitMode(true);
    expect(layout.closeDetails).toHaveBeenCalledOnce();
    expect(layout.openDetails).toHaveBeenCalledOnce();

    drawer.setSplitMode(false);
    expect(layout.closeDetails).toHaveBeenCalledTimes(2);
    drawer.setSplitMode(false);
    expect(layout.closeDetails).toHaveBeenCalledTimes(2);
  });

  it("does not close during a same-session launcher remount", async () => {
    vi.useFakeTimers();
    const drawer = new DesignDrawerController(
      {} as never,
      { openDetails: vi.fn(), closeDetails: vi.fn() },
      () => true,
    );
    drawer.open(
      "session-1",
      { setDraft: vi.fn() },
      "",
      document.createElement("button"),
    );
    const releaseFirstMount = drawer.retainSession("session-1");
    releaseFirstMount();
    const releaseSecondMount = drawer.retainSession("session-1");
    await vi.runOnlyPendingTimersAsync();
    expect(drawer.getSnapshot().open).toBe(true);

    releaseSecondMount();
    await vi.runOnlyPendingTimersAsync();
    expect(drawer.getSnapshot().open).toBe(false);
  });

  it("shares one live job watcher across duplicate generate and result cards", async () => {
    vi.useFakeTimers();
    const design = vi.fn().mockResolvedValue({
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
        modelId: "openai/gpt-image-2",
        status: "succeeded",
        createdAt: "2026-08-31T10:00:00.000Z",
        updatedAt: "2026-08-31T10:00:02.000Z",
        resources: [],
        diagnostic: null,
      }],
    });
    const drawer = new DesignDrawerController(
      { design } as never,
      { openDetails: vi.fn(), closeDetails: vi.fn() },
      () => false,
    );

    const releaseGenerate = drawer.watchJob("session-1", "job-live", "running");
    const releaseResult = drawer.watchJob("session-1", "job-live", "running");
    await vi.runOnlyPendingTimersAsync();

    expect(design).toHaveBeenCalledOnce();
    expect(drawer.controllerForSession("session-1").store.getSnapshot().data?.jobs[0]?.status)
      .toBe("succeeded");

    releaseGenerate();
    releaseResult();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(design).toHaveBeenCalledOnce();
  });

  it("prefers one generate card while preserving a standalone result card", () => {
    const drawer = new DesignDrawerController(
      {} as never,
      { openDetails: vi.fn(), closeDetails: vi.fn() },
      () => false,
    );
    expect(drawer.isMediaCardPrimary("session-1", "job-1", "result-only", "get_result"))
      .toBe(true);
    const releaseResult = drawer.claimMediaCard(
      "session-1",
      "job-1",
      "result-only",
      "get_result",
    );
    expect(drawer.isMediaCardPrimary("session-1", "job-1", "result-only", "get_result"))
      .toBe(true);

    const releaseGenerate = drawer.claimMediaCard(
      "session-1",
      "job-1",
      "generate",
      "generate",
    );
    expect(drawer.isMediaCardPrimary("session-1", "job-1", "generate", "generate"))
      .toBe(true);
    expect(drawer.isMediaCardPrimary("session-1", "job-1", "result-only", "get_result"))
      .toBe(false);

    releaseGenerate();
    expect(drawer.isMediaCardPrimary("session-1", "job-1", "result-only", "get_result"))
      .toBe(true);
    releaseResult();
  });

  it("keeps the advanced editor control hidden but functional and shows icon close", async () => {
    const user = userEvent.setup();
    const drawer = new DesignDrawerController(
      {} as never,
      { openDetails: vi.fn(), closeDetails: vi.fn() },
      () => false,
    );
    drawer.open("session-1", { setDraft: vi.fn() }, "", document.createElement("button"));

    render(createElement(ModellixDesignDrawer, {
      drawer,
      settingsController: {} as never,
      locale: "zh-CN",
      t: (key: string) => ({
        designTitle: "Modellix Design",
        designDescription: "媒体设计",
        advancedEditor: "高级参数编辑器",
        close: "关闭",
      })[key] ?? key,
    } as never));

    const toggle = document.querySelector<HTMLButtonElement>(
      ".mdlx-drawer-editor-toggle",
    );
    const close = screen.getByRole("button", { name: "关闭 Modellix Design" });
    const header = toggle?.closest("header");
    expect(toggle).toBeTruthy();
    expect(toggle?.closest<HTMLElement>(".mdlx-drawer-header-reveal")?.hidden).toBe(true);
    expect(screen.queryByRole("button", { name: "高级参数编辑器" })).toBeNull();
    expect(close.querySelector("[data-close-icon]")).toBeTruthy();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(header?.hasAttribute("data-editor-open")).toBe(false);
    expect(document.querySelector("#mdlx-design-editor")?.getAttribute("data-editor-open"))
      .toBe("false");

    fireEvent.click(toggle!);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(header?.getAttribute("data-editor-open")).toBe("true");
    expect(document.querySelector("#mdlx-design-editor")?.getAttribute("data-editor-open"))
      .toBe("true");

    fireEvent.click(toggle!);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(header?.hasAttribute("data-editor-open")).toBe(false);

    await user.click(close);
    expect(drawer.getSnapshot().open).toBe(false);
  });
});
