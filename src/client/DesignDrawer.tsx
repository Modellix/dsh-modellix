import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
  Button,
  IconCloseOutline16,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ILayout } from "@deepseek-ai/dsh-client-ui-layout/client";

import { ModellixDesignView } from "./DesignView.js";
import type { ModellixRpcClient } from "./rpc.js";
import type { DesignController, SettingsController } from "./store.js";
import { DesignController as DesignControllerImpl } from "./store.js";

interface DrawerSnapshot {
  readonly open: boolean;
  readonly sessionId: string | null;
  readonly controller: DesignController | null;
  readonly draft: string;
  readonly inputActions: DrawerInputActions | null;
}

interface DrawerInputActions {
  setDraft(text: string): void;
}

interface WatchedDesignJob {
  references: number;
  timer: number | null;
  stopped: boolean;
  unsubscribeStore: () => void;
}

interface MediaCardClaim {
  readonly operation: "generate" | "get_result";
  readonly order: number;
}

type DesignPanelLayout = Pick<ILayout, "openDetails" | "closeDetails">;

export const MODELLIX_DESIGN_SPLIT_MEDIA_QUERY = "(min-width: 1280px)";
const MODELLIX_DRAWER_EXIT_MS = 180;
const MODELLIX_ADVANCED_EDITOR_ENTRY_HIDDEN = true;

function isSplitViewport(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MODELLIX_DESIGN_SPLIT_MEDIA_QUERY).matches;
}

export class DesignDrawerController {
  readonly #rpc: ModellixRpcClient;
  readonly #layout: DesignPanelLayout;
  readonly #isSplitViewport: () => boolean;
  readonly #listeners = new Set<() => void>();
  readonly #controllers = new Map<string, DesignController>();
  readonly #watchedJobs = new Map<string, WatchedDesignJob>();
  readonly #mediaCardClaims = new Map<string, Map<string, MediaCardClaim>>();
  readonly #mediaCardListeners = new Set<() => void>();
  readonly #sessionReferences = new Map<string, number>();
  readonly #sessionReleaseTimers = new Map<string, number>();
  #mediaCardVersion = 0;
  #mediaCardOrder = 0;
  #snapshot: DrawerSnapshot = {
    open: false,
    sessionId: null,
    controller: null,
    draft: "",
    inputActions: null,
  };
  #trigger: HTMLElement | null = null;
  #splitActive = false;

  constructor(
    rpc: ModellixRpcClient,
    layout: DesignPanelLayout,
    splitViewport: () => boolean = isSplitViewport,
  ) {
    this.#rpc = rpc;
    this.#layout = layout;
    this.#isSplitViewport = splitViewport;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): DrawerSnapshot => this.#snapshot;

  readonly subscribeMediaCards = (listener: () => void): (() => void) => {
    this.#mediaCardListeners.add(listener);
    return () => this.#mediaCardListeners.delete(listener);
  };

  readonly getMediaCardVersion = (): number => this.#mediaCardVersion;

  claimMediaCard(
    sessionId: string,
    jobId: string,
    callId: string,
    operation: MediaCardClaim["operation"],
  ): () => void {
    const key = `${sessionId}\n${jobId}`;
    const claims = this.#mediaCardClaims.get(key) ?? new Map<string, MediaCardClaim>();
    if (claims.has(callId)) return () => undefined;
    claims.set(callId, { operation, order: this.#mediaCardOrder++ });
    this.#mediaCardClaims.set(key, claims);
    this.#publishMediaCards();
    return () => {
      const current = this.#mediaCardClaims.get(key);
      if (current?.delete(callId) !== true) return;
      if (current.size === 0) this.#mediaCardClaims.delete(key);
      this.#publishMediaCards();
    };
  }

  isMediaCardPrimary(
    sessionId: string,
    jobId: string,
    callId: string,
    operation: MediaCardClaim["operation"],
  ): boolean {
    const claims = this.#mediaCardClaims.get(`${sessionId}\n${jobId}`);
    if (claims === undefined || claims.size === 0) return true;
    let primaryCallId = callId;
    let primary: MediaCardClaim = {
      operation,
      order: Number.MAX_SAFE_INTEGER,
    };
    for (const [candidateCallId, candidate] of claims) {
      if (compareMediaCardClaims(candidate, primary) < 0) {
        primaryCallId = candidateCallId;
        primary = candidate;
      }
    }
    return primaryCallId === callId;
  }

  controllerForSession(sessionId: string): DesignController {
    const existing = this.#controllers.get(sessionId);
    if (existing !== undefined) return existing;
    const controller = new DesignControllerImpl(this.#rpc, sessionId);
    this.#controllers.set(sessionId, controller);
    return controller;
  }

  retainSession(sessionId: string): () => void {
    const pendingRelease = this.#sessionReleaseTimers.get(sessionId);
    if (pendingRelease !== undefined) {
      window.clearTimeout(pendingRelease);
      this.#sessionReleaseTimers.delete(sessionId);
    }
    this.#sessionReferences.set(
      sessionId,
      (this.#sessionReferences.get(sessionId) ?? 0) + 1,
    );
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      const remaining = Math.max(0, (this.#sessionReferences.get(sessionId) ?? 1) - 1);
      if (remaining > 0) {
        this.#sessionReferences.set(sessionId, remaining);
        return;
      }
      this.#sessionReferences.delete(sessionId);
      const timer = window.setTimeout(() => {
        this.#sessionReleaseTimers.delete(sessionId);
        if ((this.#sessionReferences.get(sessionId) ?? 0) === 0) {
          this.releaseSession(sessionId);
        }
      }, 0);
      this.#sessionReleaseTimers.set(sessionId, timer);
    };
  }

  watchJob(sessionId: string, jobId: string, initialStatus: string | undefined): () => void {
    if (initialStatus !== "running") return () => undefined;
    const key = `${sessionId}\n${jobId}`;
    const existing = this.#watchedJobs.get(key);
    if (existing !== undefined) {
      existing.references += 1;
      return () => this.#releaseJobWatch(key, existing);
    }

    const controller = this.controllerForSession(sessionId);
    const watched: WatchedDesignJob = {
      references: 1,
      timer: null,
      stopped: false,
      unsubscribeStore: () => undefined,
    };
    const liveStatus = (): string | undefined =>
      controller.store.getSnapshot().data?.jobs.find((job) => job.jobId === jobId)?.status;
    const stopWhenTerminal = (): void => {
      const status = liveStatus();
      if (status === undefined || status === "running") return;
      watched.stopped = true;
      if (watched.timer !== null) window.clearTimeout(watched.timer);
      watched.timer = null;
    };
    const poll = async (): Promise<void> => {
      watched.timer = null;
      if (watched.stopped) return;
      await controller.load();
      stopWhenTerminal();
      if (!watched.stopped && watched.references > 0) {
        watched.timer = window.setTimeout(() => { void poll(); }, 5_000);
      }
    };
    watched.unsubscribeStore = controller.store.subscribe(stopWhenTerminal);
    this.#watchedJobs.set(key, watched);
    watched.timer = window.setTimeout(() => { void poll(); }, 0);
    return () => this.#releaseJobWatch(key, watched);
  }

  open(
    sessionId: string,
    inputActions: DrawerInputActions,
    draft: string,
    trigger: HTMLElement,
  ): void {
    const controller = this.controllerForSession(sessionId);
    this.#trigger = trigger;
    this.#syncSplit(this.#isSplitViewport());
    this.#publish({ open: true, sessionId, controller, draft, inputActions });
  }

  close(restoreFocus = true): void {
    if (!this.#snapshot.open) return;
    this.#syncSplit(false);
    this.#publish({ ...this.#snapshot, open: false });
    if (restoreFocus) queueMicrotask(() => this.#trigger?.focus());
  }

  setSplitMode(enabled: boolean): void {
    if (!this.#snapshot.open) return;
    this.#syncSplit(enabled);
  }

  updateSession(sessionId: string, inputActions: DrawerInputActions, draft: string): void {
    if (this.#snapshot.sessionId !== sessionId) return;
    this.#publish({ ...this.#snapshot, inputActions, draft });
  }

  releaseSession(sessionId: string): void {
    if (this.#snapshot.sessionId !== sessionId) return;
    this.#syncSplit(false);
    this.#trigger = null;
    this.#publish({
      open: false,
      sessionId: null,
      controller: null,
      draft: "",
      inputActions: null,
    });
  }

  #releaseJobWatch(key: string, watched: WatchedDesignJob): void {
    if (this.#watchedJobs.get(key) !== watched) return;
    watched.references -= 1;
    if (watched.references > 0) return;
    watched.stopped = true;
    if (watched.timer !== null) window.clearTimeout(watched.timer);
    watched.unsubscribeStore();
    this.#watchedJobs.delete(key);
  }

  appendUrl(url: string): void {
    const actions = this.#snapshot.inputActions;
    if (actions === null) return;
    const current = this.#snapshot.draft;
    const separator = current === "" || /\s$/u.test(current) ? "" : "\n";
    const next = `${current}${separator}${url}`;
    actions.setDraft(next);
    this.#publish({ ...this.#snapshot, draft: next });
  }

  #publish(snapshot: DrawerSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #publishMediaCards(): void {
    this.#mediaCardVersion += 1;
    for (const listener of this.#mediaCardListeners) listener();
  }

  #syncSplit(enabled: boolean): void {
    if (enabled === this.#splitActive) return;
    if (enabled) {
      // Reset any pre-existing native details width so the public Harness
      // column and the Modellix overlay share the same 360px contract width.
      this.#layout.closeDetails();
      this.#layout.openDetails();
    } else {
      this.#layout.closeDetails();
    }
    this.#splitActive = enabled;
  }
}

function compareMediaCardClaims(left: MediaCardClaim, right: MediaCardClaim): number {
  const leftPriority = left.operation === "generate" ? 0 : 1;
  const rightPriority = right.operation === "generate" ? 0 : 1;
  return leftPriority - rightPriority || left.order - right.order;
}

export type ModellixDesignLauncherProps =
  PropsRuntime<"conversation.session.header.utilities"> & PropsLocale<"modellix"> & {
    readonly drawer: DesignDrawerController;
  };

export function ModellixDesignLauncher({
  drawer,
  inputActions,
  sessionId,
  t,
  useInput,
}: ModellixDesignLauncherProps): ReactNode {
  const draft = useInput((state) => state.draft);
  const snapshot = useSyncExternalStore(drawer.subscribe, drawer.getSnapshot, drawer.getSnapshot);
  const active = snapshot.open && snapshot.sessionId === String(sessionId);
  useEffect(() => {
    drawer.updateSession(String(sessionId), inputActions, draft);
  }, [draft, drawer, inputActions, sessionId]);
  useEffect(() => drawer.retainSession(String(sessionId)), [drawer, sessionId]);
  return (
    <Button
      type="button"
      variant="outline"
      className="mdlx-design-launcher"
      aria-label={t("designTitle")}
      aria-expanded={active}
      aria-controls="mdlx-design-drawer"
      onClick={(event) => {
        if (active) drawer.close();
        else drawer.open(String(sessionId), inputActions, draft, event.currentTarget);
      }}
    >
      <span className="mdlx-launcher-label">{t("designTitle")}</span>
      <span className="mdlx-launcher-compact" aria-hidden="true">M</span>
    </Button>
  );
}

export function ModellixDesignDrawer({
  drawer,
  settingsController,
  t,
}: PropsLocale<"modellix"> & {
  readonly drawer: DesignDrawerController;
  readonly settingsController: SettingsController;
}): ReactNode {
  const snapshot = useSyncExternalStore(drawer.subscribe, drawer.getSnapshot, drawer.getSnapshot);
  const [retainedSnapshot, setRetainedSnapshot] = useState<DrawerSnapshot | null>(
    snapshot.open && snapshot.controller !== null ? snapshot : null,
  );
  const [advancedEditorOpen, setAdvancedEditorOpen] = useState(false);
  useEffect(() => {
    if (snapshot.open && snapshot.controller !== null) setRetainedSnapshot(snapshot);
  }, [snapshot.controller, snapshot.open, snapshot.sessionId]);
  useEffect(() => {
    if (snapshot.open || retainedSnapshot === null) return;
    const timer = window.setTimeout(
      () => setRetainedSnapshot(null),
      MODELLIX_DRAWER_EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [retainedSnapshot, snapshot.open]);
  useEffect(() => {
    setAdvancedEditorOpen(false);
  }, [snapshot.sessionId]);
  useEffect(() => {
    if (!snapshot.open || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MODELLIX_DESIGN_SPLIT_MEDIA_QUERY);
    const sync = (): void => drawer.setSplitMode(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [drawer, snapshot.open]);
  const presentedSnapshot = snapshot.open && snapshot.controller !== null
    ? snapshot
    : retainedSnapshot;
  if (presentedSnapshot === null || presentedSnapshot.controller === null) return null;
  return (
    <div
      className="mdlx-design-drawer-viewport"
      data-closing={!snapshot.open || undefined}
    >
      <aside
        id="mdlx-design-drawer"
        className="mdlx-design-drawer"
        aria-labelledby="mdlx-design-drawer-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            drawer.close();
          }
        }}
      >
        <header
          className="mdlx-drawer-header"
          data-editor-open={advancedEditorOpen || undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mdlx-drawer-close"
            icon={<IconCloseOutline16 size={16} />}
            aria-label={`${t("close")} ${t("designTitle")}`}
            onClick={() => drawer.close()}
          />
          <div className="mdlx-heading">
            <h2 id="mdlx-design-drawer-title">{t("designTitle")}</h2>
            <p className="mdlx-muted">{t("designDescription")}</p>
          </div>
          <div
            className="mdlx-drawer-header-reveal"
            hidden={MODELLIX_ADVANCED_EDITOR_ENTRY_HIDDEN}
          >
            <div>
              <Button
                type="button"
                variant="outline"
                className="mdlx-drawer-editor-toggle"
                aria-controls="mdlx-design-editor"
                aria-expanded={advancedEditorOpen}
                onClick={(event) => {
                  const next = !advancedEditorOpen;
                  setAdvancedEditorOpen(next);
                  if (!next && event.detail > 0) event.currentTarget.blur();
                }}
              >
                {t("advancedEditor")}
              </Button>
            </div>
          </div>
        </header>
        <div className="mdlx-drawer-body">
          <ModellixDesignView
            advancedEditorOpen={advancedEditorOpen}
            controller={presentedSnapshot.controller}
            settingsController={settingsController}
            onAddUrl={(url) => drawer.appendUrl(url)}
            t={t}
          />
        </div>
      </aside>
    </div>
  );
}
