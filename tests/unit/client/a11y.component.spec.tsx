// @vitest-environment jsdom

import { useRef, type ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSecretInput,
  useDialogA11y,
  useExternalDialogGate,
} from "../../../src/client/a11y.js";

function TestDialog({
  open,
  mandatory,
  onEscape,
}: {
  readonly open: boolean;
  readonly mandatory: boolean;
  readonly onEscape: () => void;
}): ReactNode {
  const container = useRef<HTMLDivElement | null>(null);
  useDialogA11y({
    open,
    container,
    initialFocusSelector: "[data-initial]",
    mandatory,
    onEscape,
  });
  if (!open) return null;
  return (
    <div ref={container} role="dialog" tabIndex={-1}>
      <button type="button" data-initial="">First action</button>
      <button type="button">Last action</button>
    </div>
  );
}

function GatedTestDialog({ requestedOpen }: { readonly requestedOpen: boolean }): ReactNode {
  const open = useExternalDialogGate(requestedOpen);
  const container = useRef<HTMLDivElement | null>(null);
  useDialogA11y({
    open,
    container,
    initialFocusSelector: "[data-initial]",
    mandatory: false,
    onEscape: () => undefined,
  });
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Plugin dialog">
      <div ref={container} data-mdlx-dialog-surface="" tabIndex={-1}>
        <button type="button" data-initial="">Plugin action</button>
      </div>
    </div>
  );
}

function ExternalDialog(): ReactNode {
  return (
    <div role="dialog" aria-modal="true" aria-label="Host dialog">
      <button type="button" autoFocus>Host action</button>
    </div>
  );
}

function mountOutsideApplication(): {
  readonly trigger: HTMLButtonElement;
  readonly appRoot: HTMLElement;
  readonly portal: HTMLElement;
} {
  document.body.innerHTML = [
    '<main id="root"><button id="trigger" type="button">Open</button></main>',
    '<div id="modal-portal"></div>',
  ].join("");
  const trigger = document.getElementById("trigger");
  const appRoot = document.getElementById("root");
  const portal = document.getElementById("modal-portal");
  if (
    !(trigger instanceof HTMLButtonElement) ||
    !(appRoot instanceof HTMLElement) ||
    !(portal instanceof HTMLElement)
  ) {
    throw new Error("test DOM was not created");
  }
  return { trigger, appRoot, portal };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});

describe("dialog accessibility behavior", () => {
  it("defers a plugin dialog mounted with an external modal and resumes it after release", async () => {
    const { portal } = mountOutsideApplication();
    const view = render(
      <>
        <ExternalDialog />
        <GatedTestDialog requestedOpen />
      </>,
      { container: portal },
    );

    expect(view.getByRole("dialog", { name: "Host dialog" })).toBeTruthy();
    expect(view.queryByRole("dialog", { name: "Plugin dialog" })).toBeNull();

    view.rerender(<GatedTestDialog requestedOpen />);
    await waitFor(() =>
      expect(view.getByRole("dialog", { name: "Plugin dialog" })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Plugin action" }),
      ),
    );
  });

  it("does not defer for an external modal that is hidden", async () => {
    const { portal } = mountOutsideApplication();
    const view = render(
      <>
        <div role="dialog" aria-modal="true" aria-label="Hidden host dialog" hidden />
        <GatedTestDialog requestedOpen />
      </>,
      { container: portal },
    );

    await waitFor(() =>
      expect(view.getByRole("dialog", { name: "Plugin dialog" })).toBeTruthy(),
    );
  });

  it("yields to an external modal that appears later without stealing its focus", async () => {
    const { portal, trigger } = mountOutsideApplication();
    trigger.focus();
    const view = render(<GatedTestDialog requestedOpen />, { container: portal });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Plugin action" }),
      ),
    );

    view.rerender(
      <>
        <GatedTestDialog requestedOpen />
        <ExternalDialog />
      </>,
    );
    const hostAction = view.getByRole("button", { name: "Host action" });
    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "Plugin dialog" })).toBeNull(),
    );
    expect(document.activeElement).toBe(hostAction);

    view.rerender(<GatedTestDialog requestedOpen />);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Plugin action" }),
      ),
    );

    view.rerender(<GatedTestDialog requestedOpen={false} />);
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus inside, traps forward and reverse Tab, inerts the app, and restores focus", async () => {
    const { trigger, appRoot, portal } = mountOutsideApplication();
    trigger.focus();
    const onEscape = vi.fn();
    const view = render(
      <TestDialog open mandatory={false} onEscape={onEscape} />,
      { container: portal },
    );

    const first = view.getByRole("button", { name: "First action" });
    const last = view.getByRole("button", { name: "Last action" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(appRoot.inert).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    view.rerender(<TestDialog open={false} mandatory={false} onEscape={onEscape} />);
    expect(appRoot.inert).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the document locked until the last overlapping dialog releases it", async () => {
    const { appRoot, portal } = mountOutsideApplication();
    document.documentElement.style.overflow = "clip";
    document.documentElement.style.overscrollBehavior = "auto";
    document.body.style.overflow = "scroll";
    document.body.style.overscrollBehavior = "none";
    const onEscape = vi.fn();
    const view = render(
      <>
        <TestDialog key="first" open mandatory={false} onEscape={onEscape} />
        <TestDialog key="second" open mandatory={false} onEscape={onEscape} />
      </>,
      { container: portal },
    );

    await waitFor(() => expect(appRoot.inert).toBe(true));
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");

    view.rerender(
      <>
        <TestDialog key="first" open={false} mandatory={false} onEscape={onEscape} />
        <TestDialog key="second" open mandatory={false} onEscape={onEscape} />
      </>,
    );
    expect(appRoot.inert).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");

    view.rerender(
      <>
        <TestDialog key="first" open={false} mandatory={false} onEscape={onEscape} />
        <TestDialog key="second" open={false} mandatory={false} onEscape={onEscape} />
      </>,
    );
    expect(appRoot.inert).toBe(false);
    expect(document.documentElement.style.overflow).toBe("clip");
    expect(document.documentElement.style.overscrollBehavior).toBe("auto");
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.body.style.overscrollBehavior).toBe("none");
  });

  it.each(["removed", "disabled"] as const)(
    "restores focus to the first visible enabled main-content control when the trigger is %s",
    async (triggerState) => {
      const { trigger, appRoot, portal } = mountOutsideApplication();
      appRoot.insertAdjacentHTML(
        "beforeend",
        [
          '<button id="hidden-fallback" type="button" hidden>Hidden</button>',
          '<button id="disabled-fallback" type="button" disabled>Disabled</button>',
          '<button id="usable-fallback" type="button">Continue</button>',
        ].join(""),
      );
      const fallback = document.getElementById("usable-fallback");
      if (!(fallback instanceof HTMLButtonElement)) {
        throw new Error("fallback control was not created");
      }
      trigger.focus();
      const view = render(
        <TestDialog open mandatory={false} onEscape={() => undefined} />,
        { container: portal },
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(
          view.getByRole("button", { name: "First action" }),
        ),
      );

      if (triggerState === "removed") trigger.remove();
      else trigger.disabled = true;
      view.rerender(
        <TestDialog open={false} mandatory={false} onEscape={() => undefined} />,
      );

      expect(document.activeElement).toBe(fallback);
    },
  );

  it("honors Escape for an ordinary dialog and suppresses it for a mandatory gate", async () => {
    const ordinary = mountOutsideApplication();
    const closeOrdinary = vi.fn();
    const ordinaryView = render(
      <TestDialog open mandatory={false} onEscape={closeOrdinary} />,
      { container: ordinary.portal },
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        ordinaryView.getByRole("button", { name: "First action" }),
      ),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeOrdinary).toHaveBeenCalledOnce();
    ordinaryView.unmount();

    cleanup();
    const mandatory = mountOutsideApplication();
    const closeMandatory = vi.fn();
    const mandatoryView = render(
      <TestDialog open mandatory onEscape={closeMandatory} />,
      { container: mandatory.portal },
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        mandatoryView.getByRole("button", { name: "First action" }),
      ),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeMandatory).not.toHaveBeenCalled();
  });

  it("focuses the dialog itself when it has no interactive descendants", async () => {
    function EmptyDialog(): ReactNode {
      const container = useRef<HTMLDivElement | null>(null);
      useDialogA11y({
        open: true,
        container,
        mandatory: true,
        onEscape: () => undefined,
      });
      return <div ref={container} role="dialog" tabIndex={-1}>No actions</div>;
    }

    const { portal } = mountOutsideApplication();
    const view = render(<EmptyDialog />, { container: portal });
    const dialog = view.getByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    dialog.blur();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
  });

  it("clears only the marked local Secret input", () => {
    const container = document.createElement("div");
    container.innerHTML = [
      '<input data-mdlx-secret value="fake-secret-draft">',
      '<input value="ordinary-value">',
    ].join("");
    const inputs = container.querySelectorAll("input");

    clearSecretInput(container);

    expect(inputs[0]?.value).toBe("");
    expect(inputs[1]?.value).toBe("ordinary-value");
    expect(() => clearSecretInput(null)).not.toThrow();
  });
});
