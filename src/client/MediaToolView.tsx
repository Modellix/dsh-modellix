import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
  Button,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";

import { useDialogA11y, useExternalDialogGate } from "./a11y.js";
import {
  safeResourceHref,
  type DesignJobWire,
  type DesignResourceWire,
} from "./contracts.js";
import type { DesignDrawerController } from "./DesignDrawer.js";
import { DesignResultPreview } from "./DesignResultPreview.js";
import { designDiagnosticMessageKey } from "./design-presentation.js";
import { handleResultTabKeyDown } from "./result-tabs.js";
import { useResourceState, type ModellixTranslate } from "./shared.js";

interface MediaToolResult {
  readonly operation: "generate" | "get_result";
  readonly status?: string;
  readonly modelId?: string;
  readonly jobId?: string;
  readonly found?: boolean;
  readonly resources?: readonly MediaToolResource[];
  readonly diagnostic?: MediaToolDiagnostic;
  readonly job?: {
    readonly jobId: string;
    readonly modelId: string;
    readonly status: string;
    readonly resources: readonly MediaToolResource[];
    readonly diagnostic?: MediaToolDiagnostic;
  };
}

interface MediaToolDiagnostic {
  readonly code: string;
  readonly message: string;
}

interface MediaToolResource {
  readonly kind: "image" | "video" | "audio";
  readonly url: string;
  readonly expiresAt?: string;
}

export type ModellixMediaToolViewProps = PropsRuntime<"tool.call.toolview"> &
  PropsLocale<"modellix"> & {
    readonly drawer: DesignDrawerController;
  };

export function ModellixMediaToolView({
  block,
  drawer,
  inputActions,
  sessionId,
  t,
  useInput,
}: ModellixMediaToolViewProps): ReactNode {
  const draft = useInput((state) => state.draft);
  const [tab, setTab] = useState<"preview" | "json">("preview");
  const [activeIndex, setActiveIndex] = useState(0);
  const [imageOpen, setImageOpen] = useState(false);
  const tabId = useId();
  const imageDialogRef = useRef<HTMLDivElement | null>(null);
  const isResultBlock = "kind" in block && block.kind === "tool-result";
  const parsedResult = isResultBlock ? parseMediaToolResult(block.meta) : null;
  const controller = drawer.controllerForSession(String(sessionId));
  const liveState = useResourceState(controller.store);
  const trackedJobId = mediaToolJobId(parsedResult);
  const operation = parsedResult?.operation;
  const callId = "callId" in block && typeof block.callId === "string"
    ? block.callId
    : `${String(sessionId)}:${trackedJobId ?? "pending"}`;
  useSyncExternalStore(
    drawer.subscribeMediaCards,
    drawer.getMediaCardVersion,
    drawer.getMediaCardVersion,
  );
  const parsedStatus = mediaToolStatus(parsedResult);
  const liveJob = trackedJobId === undefined
    ? undefined
    : liveState.data?.jobs.find((job) => job.jobId === trackedJobId);
  const result = resolveLiveMediaToolResult(parsedResult, liveJob, t);
  useEffect(
    () => trackedJobId === undefined
      ? undefined
      : drawer.watchJob(String(sessionId), trackedJobId, parsedStatus),
    [drawer, parsedStatus, sessionId, trackedJobId],
  );
  useEffect(
    () => trackedJobId === undefined || operation === undefined
      ? undefined
      : drawer.claimMediaCard(String(sessionId), trackedJobId, callId, operation),
    [callId, drawer, operation, sessionId, trackedJobId],
  );
  const resources = result?.operation === "get_result"
    ? result.job?.resources ?? []
    : result?.resources ?? [];
  const resourceIndex = resources.length === 0 ? 0 : activeIndex % resources.length;
  const current = resources[resourceIndex];
  const requestedImageOpen = imageOpen && current?.kind === "image";
  const imageSurfaceOpen = useExternalDialogGate(requestedImageOpen);
  const closeImage = useCallback(() => setImageOpen(false), []);
  useDialogA11y({
    open: imageSurfaceOpen,
    container: imageDialogRef,
    initialFocusSelector: "[data-mdlx-initial-focus]",
    mandatory: false,
    onEscape: closeImage,
  });
  useEffect(() => setImageOpen(false), [current?.url]);

  if (
    trackedJobId !== undefined && operation !== undefined &&
    !drawer.isMediaCardPrimary(String(sessionId), trackedJobId, callId, operation)
  ) return null;

  if (!isResultBlock) {
    return <div className="mdlx-tool-result mdlx-muted" role="status">{t("generating")}</div>;
  }
  if (result === null) {
    return <div className="mdlx-tool-result mdlx-muted" role="status">{t("noPreview")}</div>;
  }

  const status = result.operation === "get_result" ? result.job?.status : result.status;
  const modelId = result.operation === "get_result" ? result.job?.modelId : result.modelId;
  const diagnostic = result.operation === "get_result" ? result.job?.diagnostic : result.diagnostic;
  const succeeded = status === "succeeded";
  const activeTabId = `${tabId}-${tab}-tab`;
  const activePanelId = `${tabId}-${tab}-panel`;

  return (
    <>
      <article className="mdlx-tool-result">
        <div className="mdlx-result-head">
          <strong>{result.found === false ? t("resultNotFound") : mediaStatusLabel(status, t)}</strong>
          {modelId !== undefined && <span className="mdlx-muted">{modelId}</span>}
        </div>
        {succeeded && (
          <>
            <div
              className="mdlx-result-tabs"
              role="tablist"
              aria-label={t("resultViewLabel")}
              onKeyDown={handleResultTabKeyDown}
            >
              <button
                id={`${tabId}-preview-tab`}
                type="button"
                role="tab"
                aria-controls={`${tabId}-preview-panel`}
                aria-selected={tab === "preview"}
                tabIndex={tab === "preview" ? 0 : -1}
                className="mdlx-result-tab"
                onClick={() => setTab("preview")}
              >
                {t("previewTab")}
              </button>
              <button
                id={`${tabId}-json-tab`}
                type="button"
                role="tab"
                aria-controls={`${tabId}-json-panel`}
                aria-selected={tab === "json"}
                tabIndex={tab === "json" ? 0 : -1}
                className="mdlx-result-tab"
                onClick={() => setTab("json")}
              >
                {t("jsonTab")}
              </button>
            </div>
            {tab === "json" ? (
              <pre id={activePanelId} role="tabpanel" aria-labelledby={activeTabId} className="mdlx-result-json">
                {JSON.stringify(result, null, 2)}
              </pre>
            ) : (
              <div id={activePanelId} role="tabpanel" aria-labelledby={activeTabId} className="mdlx-result-panel">
                {current === undefined ? (
                  <div className="mdlx-empty mdlx-empty-compact">{t("noPreview")}</div>
                ) : (
                  <>
                    {current.kind === "image" ? (
                      <button
                        type="button"
                        className="mdlx-image-preview-button"
                        aria-label={t("openImage")}
                        onClick={() => setImageOpen(true)}
                      >
                        <DesignResultPreview resource={toWireResource(current, resourceIndex)} t={t} />
                      </button>
                    ) : (
                      <DesignResultPreview resource={toWireResource(current, resourceIndex)} t={t} />
                    )}
                    <div className="mdlx-actions mdlx-actions-start">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          const separator = draft === "" || /\s$/u.test(draft) ? "" : "\n";
                          inputActions.setDraft(`${draft}${separator}${current.url}`);
                        }}
                      >
                        {t("addUrlToChat")}
                      </Button>
                      <a className="mdlx-safe-link" href={current.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" download>
                        {t("download")}
                      </a>
                    </div>
                    {resources.length > 1 && (
                      <div className="mdlx-resource-nav" aria-label={t("resourceNavigation")}>
                        <Button type="button" variant="outline" onClick={() => setActiveIndex((resourceIndex - 1 + resources.length) % resources.length)}>{t("previousResource")}</Button>
                        <span className="mdlx-muted">{t("resourcePosition", { current: resourceIndex + 1, total: resources.length })}</span>
                        <Button type="button" variant="outline" onClick={() => setActiveIndex((resourceIndex + 1) % resources.length)}>{t("nextResource")}</Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
        {diagnostic !== undefined && (
          <div className="mdlx-error">
            <strong className="mdlx-code">{diagnostic.code}</strong>
            <p>{diagnostic.message}</p>
          </div>
        )}
      </article>
      {succeeded && current?.kind === "image" && (
        <Modal
          open={imageSurfaceOpen}
          title={t("imageViewerTitle")}
          onClose={closeImage}
          headless
          className="mdlx-modal mdlx-image-modal"
        >
          <div
            ref={imageDialogRef}
            className="mdlx-modal-content"
            data-mdlx-dialog-surface=""
            tabIndex={-1}
          >
            <div className="mdlx-heading">
              <h2 className="mdlx-modal-title">{t("imageViewerTitle")}</h2>
            </div>
            <img
              className="mdlx-image-full"
              src={current.url}
              alt={t("generatedPreview")}
              referrerPolicy="no-referrer"
            />
            <div className="mdlx-actions">
              <Button type="button" variant="outline" data-mdlx-initial-focus="" onClick={closeImage}>
                {t("close")}
              </Button>
              <a className="mdlx-safe-link" href={current.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" download>
                {t("download")}
              </a>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function mediaToolJobId(result: MediaToolResult | null): string | undefined {
  return result?.operation === "get_result" ? result.job?.jobId : result?.jobId;
}

function mediaToolStatus(result: MediaToolResult | null): string | undefined {
  return result?.operation === "get_result" ? result.job?.status : result?.status;
}

function resolveLiveMediaToolResult(
  result: MediaToolResult | null,
  liveJob: DesignJobWire | undefined,
  t: ModellixTranslate,
): MediaToolResult | null {
  if (result === null || liveJob === undefined) return result;
  const resources = liveJob.resources.map((resource) => ({
    kind: resource.kind,
    url: resource.url,
    ...(resource.expiresAt === null ? {} : { expiresAt: resource.expiresAt }),
  }));
  const diagnostic = liveJob.diagnostic === null
    ? undefined
    : {
        code: liveJob.diagnostic.code,
        message: t(designDiagnosticMessageKey(liveJob.diagnostic.code)),
      };
  if (result.operation === "generate") {
    const { diagnostic: _staleDiagnostic, ...withoutDiagnostic } = result;
    return {
      ...withoutDiagnostic,
      status: liveJob.status,
      modelId: liveJob.modelId,
      resources,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }
  return {
    ...result,
    found: true,
    job: {
      jobId: liveJob.jobId,
      modelId: liveJob.modelId,
      status: liveJob.status,
      resources,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
  };
}

function parseMediaToolResult(value: unknown): MediaToolResult | null {
  const root = record(value);
  if (root === null || root.service !== "media" ||
    (root.operation !== "generate" && root.operation !== "get_result")) return null;
  if (root.operation === "generate") {
    const status = safeText(root.status, 64);
    const modelId = safeText(root.modelId, 256);
    const jobId = safeText(root.jobId, 256);
    const diagnostic = parseDiagnostic(root.diagnostic);
    return {
      operation: "generate",
      ...(status === undefined ? {} : { status }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(jobId === undefined ? {} : { jobId }),
      resources: parseResources(root.resources),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }
  const job = record(root.job);
  const diagnostic = job === null ? undefined : parseDiagnostic(job.diagnostic);
  return {
    operation: "get_result",
    found: root.found === true,
    ...(job === null ? {} : {
      job: {
        jobId: safeText(job.jobId, 256) ?? "",
        modelId: safeText(job.modelId, 256) ?? "",
        status: safeText(job.status, 64) ?? "",
        resources: parseResources(job.resources),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      },
    }),
  };
}

function parseResources(value: unknown): readonly MediaToolResource[] {
  if (!Array.isArray(value)) return [];
  const resources: MediaToolResource[] = [];
  for (const candidate of value.slice(0, 32)) {
    const resource = record(candidate);
    if (resource === null ||
      (resource.kind !== "image" && resource.kind !== "video" && resource.kind !== "audio") ||
      typeof resource.url !== "string") continue;
    let url: string;
    try {
      url = safeResourceHref(resource.url);
    } catch {
      continue;
    }
    const expiresAt = safeText(resource.expiresAt, 128);
    resources.push({
      kind: resource.kind,
      url,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }
  return resources;
}

function parseDiagnostic(value: unknown): MediaToolDiagnostic | undefined {
  const diagnostic = record(value);
  if (diagnostic === null) return undefined;
  const code = safeText(diagnostic.code, 128);
  const message = safeText(diagnostic.message, 1024);
  return code === undefined || message === undefined ? undefined : { code, message };
}

function safeText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mediaStatusLabel(status: string | undefined, t: ModellixTranslate): string {
  switch (status) {
    case "running": return t("running");
    case "succeeded": return t("succeeded");
    case "failed": return t("failed");
    case "canceled": return t("canceled");
    case "expired": return t("expired");
    case "submit-unknown": return t("unknown");
    default: return t("unknown");
  }
}

function toWireResource(resource: MediaToolResource, index: number): DesignResourceWire {
  return {
    id: `tool-resource-${String(index)}`,
    kind: resource.kind,
    url: resource.url,
    downloadUrl: resource.url,
    expiresAt: resource.expiresAt ?? null,
  };
}
