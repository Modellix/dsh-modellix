import { useEffect, useRef, useState, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface DocumentScrollLock {
  count: number;
  readonly html: HTMLElement;
  readonly body: HTMLElement;
  readonly htmlOverflow: string;
  readonly htmlOverscrollBehavior: string;
  readonly bodyOverflow: string;
  readonly bodyOverscrollBehavior: string;
}

const DOCUMENT_SCROLL_LOCKS = new WeakMap<Document, DocumentScrollLock>();
const APPLICATION_INERT_LOCKS = new WeakMap<HTMLElement, {
  count: number;
  readonly inert: boolean;
}>();

const MODELLIX_DIALOG_SENTINEL = "[data-mdlx-dialog-surface]";
const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

interface DialogGateDecision {
  readonly requestedOpen: boolean;
  readonly allowed: boolean;
}

export interface DialogA11yOptions {
  readonly open: boolean;
  readonly container: RefObject<HTMLElement | null>;
  readonly externalDialogOwner?: RefObject<HTMLElement | null> | undefined;
  readonly initialFocusSelector?: string;
  readonly mandatory: boolean;
  readonly onEscape: () => void;
}

/**
 * Defers a plugin dialog while another accessible modal owns the page.
 *
 * The public host API does not expose a modal coordinator. This arbitration
 * therefore uses only the ARIA modal contract and a marker owned by this
 * plugin; it does not depend on host classes or DOM structure.
 */
export function useExternalDialogGate(
  requestedOpen: boolean,
  externalDialogOwner?: RefObject<HTMLElement | null>,
): boolean {
  const [decision, setDecision] = useState<DialogGateDecision>({
    requestedOpen: false,
    allowed: false,
  });

  useEffect(() => {
    if (!requestedOpen || typeof document === "undefined") {
      setDecision((current) =>
        current.requestedOpen || current.allowed
          ? { requestedOpen: false, allowed: false }
          : current,
      );
      return;
    }

    const ownerDocument = document;
    const Observer = ownerDocument.defaultView?.MutationObserver;
    let disposed = false;
    let reconciliationQueued = false;

    const reconcile = (): void => {
      reconciliationQueued = false;
      if (disposed) return;
      const allowed = !hasVisibleExternalDialog(
        ownerDocument,
        resolveExternalDialogOwner(externalDialogOwner),
      );
      setDecision((current) =>
        current.requestedOpen && current.allowed === allowed
          ? current
          : { requestedOpen: true, allowed },
      );
    };
    const queueReconciliation = (): void => {
      if (reconciliationQueued) return;
      reconciliationQueued = true;
      queueMicrotask(reconcile);
    };

    const observer = Observer === undefined
      ? null
      : new Observer(queueReconciliation);
    observer?.observe(ownerDocument.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "aria-hidden",
        "aria-modal",
        "class",
        "hidden",
        "inert",
        "role",
        "style",
      ],
    });
    queueReconciliation();

    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [externalDialogOwner, requestedOpen]);

  return requestedOpen && decision.requestedOpen && decision.allowed;
}

/** Adds the focus behavior intentionally absent from the public Modal primitive. */
export function useDialogA11y(options: DialogA11yOptions): void {
  const {
    open,
    container,
    externalDialogOwner,
    initialFocusSelector,
    mandatory,
    onEscape,
  } = options;
  const onEscapeRef = useRef(onEscape);
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const activeBeforeOpen =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restoreTargetRef.current ??= activeBeforeOpen;
    const dialogRoot = container.current;
    const appRoot = document.getElementById("root");
    const unlockInert = lockApplicationRoot(appRoot);
    const unlockScroll = lockDocumentScroll(document);

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
      unlockInert();
      unlockScroll();
      if (
        !hasVisibleExternalDialog(
          document,
          resolveExternalDialogOwner(externalDialogOwner),
        )
      ) {
        restoreFocus(restoreTargetRef.current, dialogRoot, appRoot);
        restoreTargetRef.current = null;
      }
    };
  }, [container, externalDialogOwner, initialFocusSelector, mandatory, open]);
}

function lockApplicationRoot(appRoot: HTMLElement | null): () => void {
  if (appRoot === null) return () => undefined;
  const current = APPLICATION_INERT_LOCKS.get(appRoot);
  if (current !== undefined) {
    current.count += 1;
    return () => releaseApplicationRoot(appRoot);
  }
  APPLICATION_INERT_LOCKS.set(appRoot, { count: 1, inert: appRoot.inert === true });
  appRoot.inert = true;
  return () => releaseApplicationRoot(appRoot);
}

function releaseApplicationRoot(appRoot: HTMLElement): void {
  const current = APPLICATION_INERT_LOCKS.get(appRoot);
  if (current === undefined) return;
  current.count -= 1;
  if (current.count > 0) return;
  appRoot.inert = current.inert;
  APPLICATION_INERT_LOCKS.delete(appRoot);
}

function lockDocumentScroll(ownerDocument: Document): () => void {
  const current = DOCUMENT_SCROLL_LOCKS.get(ownerDocument);
  if (current !== undefined) {
    current.count += 1;
    return () => releaseDocumentScroll(ownerDocument);
  }
  const html = ownerDocument.documentElement;
  const body = ownerDocument.body;
  const created: DocumentScrollLock = {
    count: 1,
    html,
    body,
    htmlOverflow: html.style.overflow,
    htmlOverscrollBehavior: html.style.overscrollBehavior,
    bodyOverflow: body.style.overflow,
    bodyOverscrollBehavior: body.style.overscrollBehavior,
  };
  DOCUMENT_SCROLL_LOCKS.set(ownerDocument, created);
  html.style.overflow = "hidden";
  html.style.overscrollBehavior = "contain";
  body.style.overflow = "hidden";
  body.style.overscrollBehavior = "contain";
  return () => releaseDocumentScroll(ownerDocument);
}

function releaseDocumentScroll(ownerDocument: Document): void {
  const current = DOCUMENT_SCROLL_LOCKS.get(ownerDocument);
  if (current === undefined) return;
  current.count -= 1;
  if (current.count > 0) return;
  current.html.style.overflow = current.htmlOverflow;
  current.html.style.overscrollBehavior = current.htmlOverscrollBehavior;
  current.body.style.overflow = current.bodyOverflow;
  current.body.style.overscrollBehavior = current.bodyOverscrollBehavior;
  DOCUMENT_SCROLL_LOCKS.delete(ownerDocument);
}

export function clearSecretInput(container: HTMLElement | null): void {
  const input = container?.querySelector<HTMLInputElement>("[data-mdlx-secret]");
  if (input !== null && input !== undefined) input.value = "";
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (candidate) => isUsableFocusTarget(candidate, null),
  );
}

function restoreFocus(
  previous: HTMLElement | null,
  dialog: HTMLElement | null,
  appRoot: HTMLElement | null,
): void {
  const ownerDocument = dialog?.ownerDocument ?? previous?.ownerDocument ?? document;
  if (previous !== null && isUsableFocusTarget(previous, dialog) && focus(previous)) {
    return;
  }

  const roots = [
    ownerDocument.querySelector<HTMLElement>("main"),
    ownerDocument.querySelector<HTMLElement>('[role="main"]'),
    appRoot,
  ];
  const visited = new Set<HTMLElement>();
  for (const root of roots) {
    if (root === null || visited.has(root)) continue;
    visited.add(root);
    const fallback = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .find((candidate) => isUsableFocusTarget(candidate, dialog));
    if (fallback !== undefined && focus(fallback)) return;
  }
}

function hasVisibleExternalDialog(
  ownerDocument: Document,
  allowedOwner: HTMLElement | null = null,
): boolean {
  return [...ownerDocument.querySelectorAll<HTMLElement>(MODAL_DIALOG_SELECTOR)]
    .some(
      (candidate) =>
        candidate !== allowedOwner &&
        candidate.querySelector(MODELLIX_DIALOG_SENTINEL) === null &&
        isVisibleDialog(candidate),
    );
}

function resolveExternalDialogOwner(
  owner: RefObject<HTMLElement | null> | undefined,
): HTMLElement | null {
  return owner?.current?.closest<HTMLElement>(MODAL_DIALOG_SELECTOR) ?? null;
}

function isVisibleDialog(candidate: HTMLElement): boolean {
  if (candidate.tagName === "DIALOG" && !candidate.hasAttribute("open")) return false;
  let current: HTMLElement | null = candidate;
  while (current !== null) {
    if (
      current.hidden ||
      (current === candidate && current.inert) ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function focus(candidate: HTMLElement): boolean {
  candidate.focus({ preventScroll: true });
  return candidate.ownerDocument.activeElement === candidate;
}

function isUsableFocusTarget(
  candidate: HTMLElement,
  excludedRoot: HTMLElement | null,
): boolean {
  if (
    !candidate.isConnected ||
    candidate === candidate.ownerDocument.body ||
    excludedRoot?.contains(candidate) === true ||
    !candidate.matches(FOCUSABLE_SELECTOR) ||
    candidate.tabIndex < 0 ||
    candidate.getAttribute("aria-disabled") === "true" ||
    (candidate instanceof HTMLInputElement && candidate.type === "hidden")
  ) {
    return false;
  }

  let current: HTMLElement | null = candidate;
  while (current !== null) {
    if (
      current.hidden ||
      current.inert ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const ownerWindow: Window | null = current.ownerDocument.defaultView;
    const style: CSSStyleDeclaration | undefined = ownerWindow?.getComputedStyle(current);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}
