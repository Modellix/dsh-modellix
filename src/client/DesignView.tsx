import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import {
  Button,
  IconRightUpOutline14,
  Input,
  Modal,
  StateDot,
  type StateDotState,
} from "@deepseek-ai/dsh-client-ui-primitives";

import type {
  ClientJsonValue,
  DesignFieldWire,
  DesignJobWire,
  DesignResourceWire,
  DesignSnapshotWire,
} from "./contracts.js";
import {
  BusyStatus,
  CredentialModal,
  ErrorNotice,
  formatClientValue,
  useResourceState,
  type ModellixTranslate,
} from "./shared.js";
import type { DesignController, SettingsController } from "./store.js";
import { useDialogA11y } from "./a11y.js";

export type ModellixDesignProps = PropsRuntime<"conversation.view"> &
  PropsLocale<"modellix"> & {
    readonly controller: DesignController;
    readonly settingsController: SettingsController;
  };

export function ModellixDesignView({
  controller,
  settingsController,
  t,
}: ModellixDesignProps): ReactNode {
  const state = useResourceState(controller.store);
  const settingsState = useResourceState(settingsController.store);
  const snapshot = state.data;
  const settings = settingsState.data;
  const [parameters, setParameters] = useState<
    Readonly<Record<string, ClientJsonValue>>
  >({});
  const [instruction, setInstruction] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [modelKind, setModelKind] = useState<"all" | "image" | "video" | "audio">("all");
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [credentialOpen, setCredentialOpen] = useState(false);
  const gatePresented = useRef(false);
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    const models = snapshot?.models ?? [];
    return models.filter((model) =>
      (modelKind === "all" || model.kind === modelKind) &&
      (query === "" || `${model.label}\n${model.id}`.toLocaleLowerCase().includes(query)));
  }, [modelKind, modelQuery, snapshot?.models]);

  useEffect(() => {
    const abort = new AbortController();
    void controller.load(abort.signal);
    return () => abort.abort();
  }, [controller]);

  useEffect(() => {
    if (
      snapshot?.credentialReady !== false ||
      settingsController.store.getSnapshot().status !== "idle"
    ) {
      return;
    }
    const abort = new AbortController();
    void settingsController.load(abort.signal);
    return () => abort.abort();
  }, [settingsController, snapshot?.credentialReady]);

  useEffect(() => {
    const draft = snapshot?.draft;
    if (draft === null || draft === undefined) {
      setParameters({});
      setInvalidFields(new Set());
      return;
    }
    setParameters(draft.parameters);
    setInvalidFields(new Set());
  }, [snapshot?.draft?.draftRevision, snapshot?.draft?.irContractHash]);

  useEffect(() => {
    if (
      snapshot?.credentialReady !== false ||
      settings === null ||
      settings.onboarding.status === "active" ||
      gatePresented.current
    ) {
      return;
    }
    gatePresented.current = true;
    if (settings.credential.writable) setCredentialOpen(true);
  }, [settings, snapshot?.credentialReady]);

  useEffect(() => {
    if (
      snapshot === null ||
      !snapshot.jobs.some((job) => job.status === "running")
    ) {
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void controller.load(abort.signal);
    }, 5_000);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [controller, snapshot]);

  const updateParameter = useCallback(
    (path: string, value: ClientJsonValue | undefined): void => {
      setParameters((current) => {
        const next = { ...current };
        if (value === undefined) delete next[path];
        else next[path] = value;
        return next;
      });
    },
    [],
  );
  const setFieldValidity = useCallback((path: string, valid: boolean): void => {
    setInvalidFields((current) => {
      const next = new Set(current);
      if (valid) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (snapshot === null) {
    return (
      <div className="mdlx-design">
        <div className="mdlx-empty" role="status" aria-live="polite">
          <span>{state.status === "error" ? t("errorGeneric") : t("loading")}</span>
          {state.status === "error" && (
            <Button type="button" variant="outline" onClick={() => { void controller.load(); }}>
              {t("retry")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const draft = snapshot.draft;
  const promptPath = draft?.primaryInputPath ?? null;
  const promptValue =
    promptPath !== null && typeof parameters[promptPath] === "string"
      ? parameters[promptPath]
      : "";
  const missingRequired =
    draft?.fields.some(
      (field) => field.required && isMissingParameter(parameters, field.path),
    ) ?? true;
  const submitting = state.pending === "submit";
  const interactionBusy = state.pending !== null;
  const canGenerate =
    snapshot.enabled &&
    snapshot.credentialReady &&
    draft !== null &&
    invalidFields.size === 0 &&
    !missingRequired &&
    !interactionBusy;
  const supplementalFields = draft?.fields.filter(
    (field) => field.path !== draft.primaryInputPath,
  ) ?? [];
  const requiredFields = supplementalFields.filter((field) => field.required);
  const optionalFields = supplementalFields.filter((field) => !field.required);

  return (
    <div className="mdlx-design">
      <div className="mdlx-design-shell">
        <section className="mdlx-design-pane" aria-labelledby="mdlx-design-title">
          <header className="mdlx-heading">
            <h2 id="mdlx-design-title">{t("designTitle")}</h2>
            <p className="mdlx-muted">{t("designDescription")}</p>
          </header>

          {!snapshot.enabled && <div className="mdlx-info">{t("designDisabled")}</div>}
          {!snapshot.credentialReady && (
            <div className="mdlx-info">
              <p>{t("keyRequired")}</p>
              {settings?.credential.writable === true && (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => setCredentialOpen(true)}
                >
                  {t("configureToContinue")}
                </Button>
              )}
              {settings?.credential.source === "env" && (
                <p className="mdlx-muted">{t("envReadonly")}</p>
              )}
            </div>
          )}
          {snapshot.notice !== null && (
            <div className="mdlx-info" role="status">
              <strong>{t("notice")}: </strong>{snapshot.notice}
            </div>
          )}

          <div className="mdlx-field">
            <label className="mdlx-label" htmlFor="mdlx-design-model">
              {t("modelLabel")}
            </label>
            <div className="mdlx-model-tools">
              <Input
                className="mdlx-input"
                value={modelQuery}
                maxLength={512}
                placeholder={t("modelSearchPlaceholder")}
                aria-label={t("modelSearchLabel")}
                disabled={interactionBusy || !snapshot.enabled}
                onChange={(event) => setModelQuery(event.currentTarget.value)}
              />
              <select
                className="mdlx-select"
                value={modelKind}
                aria-label={t("modelCategoryLabel")}
                disabled={interactionBusy || !snapshot.enabled}
                onChange={(event) => {
                  setModelKind(event.currentTarget.value as typeof modelKind);
                }}
              >
                <option value="all">{t("modelCategoryAll")}</option>
                <option value="image">{t("modelCategoryImage")}</option>
                <option value="video">{t("modelCategoryVideo")}</option>
                <option value="audio">{t("modelCategoryAudio")}</option>
              </select>
              <Button
                type="button"
                variant="outline"
                disabled={interactionBusy || !snapshot.enabled || !snapshot.credentialReady}
                aria-busy={state.pending === "refresh-design"}
                onClick={() => { void controller.refreshCatalog(); }}
              >
                {state.pending === "refresh-design" ? t("modelRefreshing") : t("modelRefresh")}
              </Button>
            </div>
            <select
              id="mdlx-design-model"
              className="mdlx-select"
              value={snapshot.selectedModelId ?? ""}
              disabled={interactionBusy || !snapshot.enabled || snapshot.models.length === 0}
              onChange={(event) => {
                const modelId = event.currentTarget.value;
                if (modelId !== "") void controller.selectModel(modelId);
              }}
            >
              <option value="" disabled>{t("chooseModel")}</option>
              {snapshot.selectedModelId !== null &&
                !visibleModels.some((model) => model.id === snapshot.selectedModelId) && (
                  <option value={snapshot.selectedModelId}>
                    {snapshot.models.find((model) => model.id === snapshot.selectedModelId)?.label ??
                      snapshot.selectedModelId}
                  </option>
                )}
              {visibleModels.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.label}{model.featured ? " ★" : ""}
                </option>
              ))}
            </select>
            {snapshot.models.length === 0 ? (
              <span className="mdlx-help">{t("noModels")}</span>
            ) : visibleModels.length === 0 && (
              <span className="mdlx-help">{t("noMatchingModels")}</span>
            )}
          </div>

          {draft !== null && promptPath !== null && (
            <div className="mdlx-field">
              <label className="mdlx-label" htmlFor="mdlx-design-prompt">
                {t("promptLabel")} <span className="mdlx-required">{t("required")}</span>
              </label>
              <textarea
                id="mdlx-design-prompt"
                className="mdlx-textarea"
                value={promptValue}
                maxLength={fieldAtPath(draft.fields, promptPath)?.maxLength ?? undefined}
                placeholder={t("promptPlaceholder")}
                disabled={interactionBusy}
                onChange={(event) => updateParameter(promptPath, event.currentTarget.value)}
              />
            </div>
          )}

          {draft !== null && (
            <section className="mdlx-design-scroll" aria-labelledby="mdlx-parameters-title">
              <div className="mdlx-heading">
                <h3 id="mdlx-parameters-title">{t("parametersTitle")}</h3>
              </div>
              <div className="mdlx-parameter-list">
                {requiredFields.map((field) => (
                    <DesignParameterField
                      key={field.path}
                      field={field}
                      value={parameters[field.path]}
                      disabled={interactionBusy}
                      onChange={(value) => updateParameter(field.path, value)}
                      onValidityChange={(valid) => setFieldValidity(field.path, valid)}
                      t={t}
                    />
                  ))}
                {optionalFields.length > 0 && (
                  <details className="mdlx-advanced">
                    <summary>{t("advancedParameters", { count: optionalFields.length })}</summary>
                    <div className="mdlx-parameter-list">
                      {optionalFields.map((field) => (
                        <DesignParameterField
                          key={field.path}
                          field={field}
                          value={parameters[field.path]}
                          disabled={interactionBusy}
                          onChange={(value) => updateParameter(field.path, value)}
                          onValidityChange={(valid) => setFieldValidity(field.path, valid)}
                          t={t}
                        />
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </section>
          )}

          {draft !== null && (
            <section className="mdlx-card" aria-labelledby="mdlx-assistant-title">
              <div className="mdlx-heading">
                <h3 id="mdlx-assistant-title">{t("assistantTitle")}</h3>
                <p className="mdlx-help">{t("assistantPaidNotice")}</p>
              </div>
              <textarea
                className="mdlx-textarea mdlx-textarea-small"
                value={instruction}
                maxLength={8_000}
                placeholder={t("assistantPlaceholder")}
                disabled={interactionBusy}
                onChange={(event) => setInstruction(event.currentTarget.value)}
              />
              <div className="mdlx-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={interactionBusy || instruction.trim().length === 0}
                  aria-busy={state.pending === "propose"}
                  onClick={() => {
                    const request = instruction.trim();
                    if (request === "") return;
                    void controller.propose(request).then((accepted) => {
                      if (accepted) setInstruction("");
                    });
                  }}
                >
                  {state.pending === "propose" ? t("proposing") : t("propose")}
                </Button>
              </div>
            </section>
          )}

          {snapshot.proposal !== null && (
            <ProposalCard snapshot={snapshot} controller={controller} t={t} />
          )}

          {draft !== null && (
            <div className="mdlx-generate-block">
              <p className="mdlx-help">{t("paidNotice")}</p>
              {(missingRequired || invalidFields.size > 0) && (
                <p className="mdlx-error">{t("requiredMissing")}</p>
              )}
              <div className="mdlx-actions">
                <Button
                  type="button"
                  variant="primary"
                  disabled={!canGenerate}
                  aria-busy={submitting}
                  onClick={() => { void controller.submit(parameters); }}
                >
                  {submitting ? t("generating") : t("generate")}
                </Button>
              </div>
            </div>
          )}

          <ErrorNotice code={state.errorCode} t={t} />
          <BusyStatus
            busy={interactionBusy}
            text={operationText(state.pending, t)}
          />
        </section>

        <DesignResults snapshot={snapshot} t={t} />
      </div>

      {settings !== null && (
        <CredentialModal
          open={credentialOpen}
          mandatory
          title={t("onboardingTitle")}
          description={t("onboardingDescription")}
          busy={settingsState.pending === "replace-credential"}
          errorCode={settingsState.errorCode}
          onSave={(apiKey) =>
            settingsController.replaceCredential(
              apiKey,
              settings.credential.credentialEpoch,
              settings.services,
            )
          }
          onSaved={() => {
            setCredentialOpen(false);
            void controller.load();
          }}
          onCancel={() => setCredentialOpen(false)}
          laterLabel="later"
          t={t}
        />
      )}
    </div>
  );
}

function DesignParameterField({
  field,
  value,
  disabled,
  onChange,
  onValidityChange,
  t,
}: {
  field: DesignFieldWire;
  value: ClientJsonValue | undefined;
  disabled: boolean;
  onChange: (value: ClientJsonValue | undefined) => void;
  onValidityChange: (valid: boolean) => void;
  t: ModellixTranslate;
}): ReactNode {
  const id = useId();
  const helpId = `${id}-help`;
  const locked = disabled || field.disabledReason !== null;
  const label = (
    <label className="mdlx-label" htmlFor={id}>
      {field.label}
      <span className={field.required ? "mdlx-required" : "mdlx-muted"}>
        {field.required ? t("required") : t("optional")}
      </span>
    </label>
  );
  let control: ReactNode;
  if (field.widget === "select" || field.kind === "enum") {
    const selected = field.options.findIndex((option) => option.value === value);
    control = (
      <select
        id={id}
        className="mdlx-select"
        value={selected < 0 ? "" : String(selected)}
        disabled={locked}
        aria-describedby={helpId}
        onChange={(event) => {
          const index = Number(event.currentTarget.value);
          onChange(field.options[index]?.value);
        }}
      >
        <option value="">—</option>
        {field.options.map((option, index) => (
          <option key={`${field.path}-${index}`} value={String(index)}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (field.widget === "switch" || field.kind === "boolean") {
    control = (
      <input
        id={id}
        className="mdlx-switch"
        type="checkbox"
        role="switch"
        checked={value === true}
        disabled={locked}
        aria-describedby={helpId}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    );
  } else if (field.kind === "number" || field.kind === "integer") {
    control = (
      <input
        id={id}
        className="mdlx-native-input"
        type="number"
        value={typeof value === "number" ? String(value) : ""}
        min={field.minimum ?? undefined}
        max={field.maximum ?? undefined}
        step={field.step ?? (field.kind === "integer" ? 1 : "any")}
        disabled={locked}
        aria-describedby={helpId}
        onChange={(event) => {
          const text = event.currentTarget.value;
          if (text === "") onChange(undefined);
          else {
            const parsed = Number(text);
            if (Number.isFinite(parsed)) onChange(parsed);
          }
        }}
      />
    );
  } else if (
    field.widget === "json" ||
    field.kind === "array" ||
    field.kind === "object"
  ) {
    control = (
      <JsonParameter
        id={id}
        value={value}
        disabled={locked}
        describedBy={helpId}
        onChange={onChange}
        onValidityChange={onValidityChange}
        t={t}
      />
    );
  } else if (field.widget === "textarea") {
    control = (
      <textarea
        id={id}
        className="mdlx-textarea mdlx-textarea-small"
        value={typeof value === "string" ? value : ""}
        maxLength={field.maxLength ?? undefined}
        disabled={locked}
        aria-describedby={helpId}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        className="mdlx-input"
        value={typeof value === "string" ? value : ""}
        maxLength={field.maxLength ?? undefined}
        disabled={locked}
        aria-describedby={helpId}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  return (
    <div className="mdlx-parameter">
      {label}
      {control}
      <span id={helpId} className="mdlx-help">
        {field.disabledReason ?? field.description ?? (locked ? t("fieldUnavailable") : "")}
      </span>
    </div>
  );
}

function JsonParameter({
  id,
  value,
  disabled,
  describedBy,
  onChange,
  onValidityChange,
  t,
}: {
  id: string;
  value: ClientJsonValue | undefined;
  disabled: boolean;
  describedBy: string;
  onChange: (value: ClientJsonValue | undefined) => void;
  onValidityChange: (valid: boolean) => void;
  t: ModellixTranslate;
}): ReactNode {
  const errorId = `${id}-json-error`;
  const [text, setText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value === undefined ? "" : JSON.stringify(value, null, 2));
  }, [value]);
  return (
    <>
      <textarea
        id={id}
        className="mdlx-textarea mdlx-textarea-small mdlx-code"
        value={text}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={`${describedBy}${invalid ? ` ${errorId}` : ""}`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (next.trim() === "") {
            setInvalid(false);
            onValidityChange(true);
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(next);
            if (!isClientJsonValue(parsed)) throw new Error("invalid JSON value");
            setInvalid(false);
            onValidityChange(true);
            onChange(parsed);
          } catch {
            setInvalid(true);
            onValidityChange(false);
          }
        }}
      />
      {invalid && <span id={errorId} className="mdlx-error">{t("invalidJson")}</span>}
    </>
  );
}

function ProposalCard({
  snapshot,
  controller,
  t,
}: {
  snapshot: DesignSnapshotWire;
  controller: DesignController;
  t: ModellixTranslate;
}): ReactNode {
  const proposal = snapshot.proposal;
  if (proposal === null) return null;
  const busy = controller.store.getSnapshot().pending !== null;
  return (
    <section className="mdlx-proposal" aria-labelledby="mdlx-proposal-title">
      <div className="mdlx-heading">
        <h3 id="mdlx-proposal-title">{t("proposalTitle")}</h3>
        <p className="mdlx-muted">{proposal.summary}</p>
      </div>
      <ul className="mdlx-change-list">
        {proposal.changes.map((change) => (
          <li className="mdlx-change" key={change.path}>
            <strong>{change.label}</strong>
            <span className="mdlx-code">
              {formatClientValue(change.before)} → {formatClientValue(change.after)}
            </span>
          </li>
        ))}
      </ul>
      {proposal.conflicts.length > 0 && (
        <div className="mdlx-error">
          <strong>{t("conflicts")}</strong>
          <ul>
            {proposal.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}
          </ul>
        </div>
      )}
      <div className="mdlx-actions">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => { void controller.rejectProposal(proposal.proposalId); }}
        >
          {t("rejectProposal")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={busy || proposal.conflicts.length > 0}
          onClick={() => { void controller.applyProposal(proposal.proposalId); }}
        >
          {t("applyProposal")}
        </Button>
      </div>
    </section>
  );
}

function DesignResults({
  snapshot,
  t,
}: {
  snapshot: DesignSnapshotWire;
  t: ModellixTranslate;
}): ReactNode {
  const groups = useMemo(() => {
    const running: DesignJobWire[] = [];
    const succeeded: DesignJobWire[] = [];
    const diagnostics: DesignJobWire[] = [];
    for (const job of snapshot.jobs) {
      if (job.status === "running") running.push(job);
      else if (job.status === "succeeded") succeeded.push(job);
      else diagnostics.push(job);
    }
    return { running, succeeded, diagnostics };
  }, [snapshot.jobs]);
  const empty = snapshot.jobs.length === 0;
  return (
    <section className="mdlx-design-pane" aria-labelledby="mdlx-results-title">
      <header className="mdlx-heading">
        <h2 id="mdlx-results-title">{t("resultsTitle")}</h2>
      </header>
      {empty ? (
        <div className="mdlx-empty">{t("noResults")}</div>
      ) : (
        <div className="mdlx-design-scroll">
          <ResultSection title={t("runningTitle")} jobs={groups.running} t={t} />
          <ResultSection title={t("succeededTitle")} jobs={groups.succeeded} t={t} />
          <ResultSection title={t("diagnosticsTitle")} jobs={groups.diagnostics} t={t} />
        </div>
      )}
    </section>
  );
}

function ResultSection({
  title,
  jobs,
  t,
}: {
  title: string;
  jobs: readonly DesignJobWire[];
  t: ModellixTranslate;
}): ReactNode {
  if (jobs.length === 0) return null;
  return (
    <section className="mdlx-result-section">
      <h3>{title}</h3>
      <ul className="mdlx-result-list">
        {jobs.map((job) => <ResultCard key={job.jobId} job={job} t={t} />)}
      </ul>
    </section>
  );
}

function ResultCard({
  job,
  t,
}: {
  job: DesignJobWire;
  t: ModellixTranslate;
}): ReactNode {
  const status = jobStatus(job.status, t);
  const created = formatTime(job.createdAt);
  const dot: StateDotState =
    job.status === "succeeded"
      ? "done"
      : job.status === "running"
        ? "ongoing"
        : job.status === "failed"
          ? "error"
          : "warning";
  return (
    <li className="mdlx-result-card">
      <div className="mdlx-result-head">
        <div className="mdlx-status-copy">
          <StateDot state={dot} />
          <strong>{status}</strong>
        </div>
        <span className="mdlx-muted">{t("jobCreated", { time: created })}</span>
      </div>
      <span className="mdlx-muted">{t("jobModel", { model: job.modelId })}</span>
      {job.resources.length > 0 && job.status !== "expired" && (
        <div className="mdlx-resource-list">
          {job.resources.map((resource) => (
            <ResultResource key={resource.id} resource={resource} t={t} />
          ))}
        </div>
      )}
      {job.diagnostic !== null && (
        <div className="mdlx-error">
          <strong className="mdlx-code">{job.diagnostic.code}</strong>
          <p>{job.diagnostic.message}</p>
          {job.diagnostic.retryable && <p>{t("diagnosticRetryable")}</p>}
        </div>
      )}
    </li>
  );
}

function ResultResource({
  resource,
  t,
}: {
  resource: DesignResourceWire;
  t: ModellixTranslate;
}): ReactNode {
  const [imageOpen, setImageOpen] = useState(false);
  const imageDialogRef = useRef<HTMLDivElement | null>(null);
  const closeImage = useCallback(() => setImageOpen(false), []);
  useDialogA11y({
    open: imageOpen,
    container: imageDialogRef,
    initialFocusSelector: "[data-mdlx-initial-focus]",
    mandatory: false,
    onEscape: closeImage,
  });
  return (
    <>
      <article className="mdlx-resource">
      {resource.kind === "image" ? (
        <img
          className="mdlx-media"
          src={resource.url}
          alt={t("generatedPreview")}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : resource.kind === "video" ? (
        <video
          className="mdlx-media"
          src={resource.url}
          controls
          playsInline
          preload="metadata"
        />
      ) : (
        <audio
          className="mdlx-media mdlx-media-audio"
          src={resource.url}
          controls
          preload="metadata"
        />
      )}
      <div className="mdlx-actions mdlx-actions-start">
        {resource.kind === "image" && (
          <button
            type="button"
            className="mdlx-safe-link mdlx-link-button"
            onClick={() => setImageOpen(true)}
          >
            {t("openImage")}
          </button>
        )}
        <a
          className="mdlx-safe-link"
          href={resource.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          download
        >
          {t("download")} <IconRightUpOutline14 size={14} />
        </a>
      </div>
      {resource.expiresAt !== null && (
        <span className="mdlx-help">
          {t("expiresAt", { time: formatTime(resource.expiresAt) })}
        </span>
      )}
      </article>
      {resource.kind === "image" && (
        <Modal
          open={imageOpen}
          title={t("imageViewerTitle")}
          closeLabel={t("close")}
          onClose={closeImage}
          headless
          className="mdlx-modal mdlx-image-modal"
        >
          <div ref={imageDialogRef} className="mdlx-modal-content" tabIndex={-1}>
            <div className="mdlx-heading">
              <h2 className="mdlx-modal-title">{t("imageViewerTitle")}</h2>
            </div>
            <img
              className="mdlx-image-full"
              src={resource.url}
              alt={t("generatedPreview")}
              referrerPolicy="no-referrer"
            />
            <div className="mdlx-actions">
              <Button
                type="button"
                variant="outline"
                data-mdlx-initial-focus=""
                onClick={closeImage}
              >
                {t("close")}
              </Button>
              <a
                className="mdlx-safe-link"
                href={resource.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                download
              >
                {t("download")} <IconRightUpOutline14 size={14} />
              </a>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function fieldAtPath(
  fields: readonly DesignFieldWire[],
  path: string,
): DesignFieldWire | undefined {
  return fields.find((field) => field.path === path);
}

function isMissingParameter(
  parameters: Readonly<Record<string, ClientJsonValue>>,
  path: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(parameters, path)) return true;
  const value = parameters[path];
  if (value === null || value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

function isClientJsonValue(value: unknown, depth = 0): value is ClientJsonValue {
  if (depth > 10) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 4_096 && value.every((item) => isClientJsonValue(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  return Object.entries(value).every(
    ([, item]) => isClientJsonValue(item, depth + 1),
  );
}

function operationText(
  operation: ReturnType<DesignController["store"]["getSnapshot"]>["pending"],
  t: ModellixTranslate,
): string {
  if (operation === "propose") return t("proposing");
  if (operation === "submit") return t("generating");
  return operation === null ? "" : t("loading");
}

function jobStatus(
  status: DesignJobWire["status"],
  t: ModellixTranslate,
): string {
  switch (status) {
    case "running":
      return t("running");
    case "succeeded":
      return t("succeeded");
    case "failed":
      return t("failed");
    case "canceled":
      return t("canceled");
    case "submit-unknown":
      return t("unknown");
    case "expired":
      return t("expired");
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
