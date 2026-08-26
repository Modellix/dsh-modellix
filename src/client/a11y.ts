import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface DialogA11yOptions {
  readonly open: boolean;
  readonly container: RefObject<HTMLElement | null>;
  readonly initialFocusSelector?: string;
  readonly mandatory: boolean;
  readonly onEscape: () => void;
}

/** Adds the focus behavior intentionally absent from the public Modal primitive. */
export function useDialogA11y(options: DialogA11yOptions): void {
  const { open, container, initialFocusSelector, mandatory, onEscape } = options;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("root");
    const previousInert = appRoot?.inert ?? false;
    if (appRoot !== null) appRoot.inert = true;

    const focusInitial = (): void => {
      const root = container.current;
      if (root === null) return;
      const preferred =
        initialFocusSelector === undefined
          ? null
          : root.querySelector<HTMLElement>(initialFocusSelector);
      const first = focusableElements(root)[0];
      (preferred ?? first ?? root).focus();
    };
    queueMicrotask(focusInitial);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!mandatory) onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const root = container.current;
      if (root === null) return;
      const items = focusableElements(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (appRoot !== null) appRoot.inert = previousInert;
      if (previouslyFocused?.isConnected === true) previouslyFocused.focus();
    };
  }, [container, initialFocusSelector, mandatory, open]);
}

export function clearSecretInput(container: HTMLElement | null): void {
  const input = container?.querySelector<HTMLInputElement>("[data-mdlx-secret]");
  if (input !== null && input !== undefined) input.value = "";
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (candidate) =>
      candidate.getAttribute("aria-hidden") !== "true" &&
      candidate.getAttribute("inert") === null,
  );
}
