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
  canGenerateDesign,
  designOutcomeTransition,
  isDesignFieldValueValid,
  isMissingDesignParameter,
  selectedDesignModel,
  type DesignOutcomeTransition,
} from "./design-state.js";
import {
  designDiagnosticMessageKey,
  designFieldDisabledMessageKey,
  designModelUnavailableMessageKey,
  designNoticeMessageKey,
  jsonParameterIssueMessageKey,
  parseJsonParameterText,
  type JsonParameterIssue,
} from "./design-presentation.js";
import { DesignResultPreview } from "./DesignResultPreview.js";
import {
  BusyStatus,
  CredentialModal,
  ErrorNotice,
  formatClientValue,
  useResourceState,
  type ModellixTranslate,
} from "./shared.js";
import type { DesignController, SettingsController } from "./store.js";
import { useDialogA11y, useExternalDialogGate } from "./a11y.js";
import {
  type CredentialDialogCoordinator,
  type CredentialDialogSnapshot,
  credentialDialogCoordinatorFor,
  useCredentialDialogSnapshot,
} from "./credential-dialog.js";

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
  const [outcomeAnnouncement, setOutcomeAnnouncement] = useState("");
  const gatePresented = useRef(false);
  const credentialDialogOwner = `design:${useId()}`;
  const credentialDialogs = credentialDialogCoordinatorFor(settingsController);
  const credentialDialog = useCredentialDialogSnapshot(credentialDialogs);
  const credentialOpen = credentialDialog.activeOwner === credentialDialogOwner;
  const credentialRecovery =
    credentialOpen && credentialDialog.recoveryToken !== null;
  const previousOutcome = useRef<
    Pick<DesignSnapshotWire, "proposal" | "jobs"> | null
  >(null);
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

  useEffect(
    () => () => credentialDialogs.release(credentialDialogOwner),
    [credentialDialogOwner, credentialDialogs],
  );

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
    if (settings.credential.writable) {
      credentialDialogs.open(credentialDialogOwner);
    }
  }, [credentialDialogOwner, credentialDialogs, settings, snapshot?.credentialReady]);

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

  useEffect(() => {
    if (state.pending !== null) setOutcomeAnnouncement("");
  }, [state.pending]);

  useEffect(() => {
    setOutcomeAnnouncement("");
  }, [t]);

  useEffect(() => {
    if (snapshot === null) return;
    const transition = designOutcomeTransition(previousOutcome.current, snapshot);
    previousOutcome.current = {
      proposal: snapshot.proposal,
      jobs: snapshot.jobs,
    };
    const announcement = designOutcomeText(transition, t);
    if (announcement !== null) setOutcomeAnnouncement(announcement);
  }, [snapshot?.jobs, snapshot?.proposal, t]);

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
      (field) => field.required && isMissingDesignParameter(parameters, field.path),
    ) ?? true;
  const submitting = state.pending === "submit";
  const interactionBusy = state.pending !== null;
  const selectedModel = selectedDesignModel(snapshot);
  const canGenerate = canGenerateDesign({
    snapshot,
    draft,
    invalidFieldCount: invalidFields.size,
    missingRequired,
    interactionBusy,
  });
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
                  onClick={() => credentialDialogs.openCredential(credentialDialogOwner)}
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
              <strong>{t("notice")}: </strong>{t(designNoticeMessageKey(snapshot.notice))}
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
              aria-describedby={
                selectedModel?.available === false ? "mdlx-design-model-status" : undefined
              }
              disabled={interactionBusy || !snapshot.enabled || snapshot.models.length === 0}
              onChange={(event) => {
                const modelId = event.currentTarget.value;
                if (modelId !== "") void controller.selectModel(modelId);
              }}
            >
              <option value="" disabled>{t("chooseModel")}</option>
              {snapshot.selectedModelId !== null &&
                !visibleModels.some((model) => model.id === snapshot.selectedModelId) && (
                  <option
                    value={snapshot.selectedModelId}
                    disabled={selectedModel?.available === false}
                  >
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
            {selectedModel?.available === false && (
              <span id="mdlx-design-model-status" className="mdlx-error" role="status">
                {selectedModel.unavailableReason === null
                  ? t("modelUnavailable")
                  : t(designModelUnavailableMessageKey(selectedModel.unavailableReason))}
              </span>
            )}
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
                      invalid={invalidFields.has(field.path)}
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
                          invalid={invalidFields.has(field.path)}
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
                <p id="mdlx-assistant-paid-notice" className="mdlx-help">
                  {t("assistantPaidNotice")}
                </p>
              </div>
              <textarea
                id="mdlx-assistant-instruction"
                className="mdlx-textarea mdlx-textarea-small"
                value={instruction}
                maxLength={8_000}
                placeholder={t("assistantPlaceholder")}
                aria-labelledby="mdlx-assistant-title"
                aria-describedby="mdlx-assistant-paid-notice"
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
                    void controller.propose(request, parameters).then((accepted) => {
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
            <ProposalCard
              snapshot={snapshot}
              parameters={parameters}
              controller={controller}
              t={t}
            />
          )}

          {draft !== null && (
            <div className="mdlx-generate-block">
              <p className="mdlx-help">{t("paidNotice")}</p>
              {missingRequired && (
                <p className="mdlx-error">{t("requiredMissing")}</p>
              )}
              {invalidFields.size > 0 && (
                <p className="mdlx-error">{t("parametersInvalid")}</p>
              )}
              <div className="mdlx-actions">
                <Button
                  type="button"
                  variant={
                    snapshot.credentialReady && snapshot.proposal === null
                      ? "primary"
                      : "outline"
                  }
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
          <div className="mdlx-live" role="status" aria-live="polite">
            {outcomeAnnouncement}
          </div>
        </section>

        <DesignResults
          snapshot={snapshot}
          dateLocale={t("dateLocale")}
          dialogCoordinator={credentialDialogs}
          dialog={credentialDialog}
          t={t}
        />
      </div>

      {settings !== null && (
        <CredentialModal
          open={credentialOpen}
          mandatory
          title={
            settings.credential.configured ? t("replaceKey") : t("onboardingTitle")
          }
          description={
            credentialRecovery
              ? settings.credential.configured
                ? t("errorKeyInvalid")
                : t("keyRequired")
              : t("onboardingDescription")
          }
          busy={settingsState.pending === "replace-credential"}
          errorCode={
            settingsState.errorOperation === "replace-credential"
              ? settingsState.errorCode
              : null
          }
          onSave={(apiKey) =>
            settingsController.replaceCredential(
              apiKey,
              settings.credential.credentialEpoch,
              settings.services,
            )
          }
          onSaved={() => {
            credentialDialogs.completeCredential(credentialDialogOwner);
            void controller.load();
          }}
          onCancel={() => credentialDialogs.dismissCredential(credentialDialogOwner)}
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
  invalid,
  disabled,
  onChange,
  onValidityChange,
  t,
}: {
  field: DesignFieldWire;
  value: ClientJsonValue | undefined;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: ClientJsonValue | undefined) => void;
  onValidityChange: (valid: boolean) => void;
  t: ModellixTranslate;
}): ReactNode {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const locked = disabled || field.disabledReason !== null;
  const jsonControl =
    field.widget === "json" || field.kind === "array" || field.kind === "object";
  const describedBy = `${helpId}${invalid && !jsonControl ? ` ${errorId}` : ""}`;
  const commit = (next: ClientJsonValue | undefined): void => {
    onValidityChange(isDesignFieldValueValid(field, next));
    onChange(next);
  };
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
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          const selectedIndex = event.currentTarget.value;
          commit(
            selectedIndex === ""
              ? undefined
              : field.options[Number(selectedIndex)]?.value,
          );
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
      <label className="mdlx-switch-target" htmlFor={id}>
        <input
          id={id}
          className="mdlx-switch"
          type="checkbox"
          role="switch"
          checked={value === true}
          disabled={locked}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => commit(event.currentTarget.checked)}
        />
      </label>
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
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          const text = event.currentTarget.value;
          if (text === "") commit(undefined);
          else {
            const parsed = Number(text);
            if (Number.isFinite(parsed)) commit(parsed);
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
        validate={(candidate) => isDesignFieldValueValid(field, candidate)}
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
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => commit(event.currentTarget.value)}
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
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => commit(event.currentTarget.value)}
      />
    );
  }
  return (
    <div className="mdlx-parameter">
      {label}
      {control}
      <span id={helpId} className="mdlx-help">
        {field.disabledReason === null
          ? field.description ?? (locked ? t("fieldUnavailable") : "")
          : t(designFieldDisabledMessageKey(field.disabledReason))}
      </span>
      {invalid && !jsonControl && (
        <span id={errorId} className="mdlx-error">{t("invalidParameter")}</span>
      )}
    </div>
  );
}

function JsonParameter({
  id,
  value,
  disabled,
  describedBy,
  validate,
  onChange,
  onValidityChange,
  t,
}: {
  id: string;
  value: ClientJsonValue | undefined;
  disabled: boolean;
  describedBy: string;
  validate: (value: ClientJsonValue | undefined) => boolean;
  onChange: (value: ClientJsonValue | undefined) => void;
  onValidityChange: (valid: boolean) => void;
  t: ModellixTranslate;
}): ReactNode {
  const errorId = `${id}-json-error`;
  const [text, setText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  const [issue, setIssue] = useState<JsonParameterIssue | null>(null);
  useEffect(() => {
    setText(value === undefined ? "" : JSON.stringify(value, null, 2));
    setIssue(null);
  }, [value]);
  const invalid = issue !== null;
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
          const result = parseJsonParameterText(next, validate);
          if (result.status === "empty") {
            setIssue(null);
            onValidityChange(true);
            onChange(undefined);
          } else if (result.status === "valid") {
            setIssue(null);
            onValidityChange(true);
            onChange(result.value);
          } else {
            setIssue(result.issue);
            onValidityChange(false);
          }
        }}
      />
      {issue !== null && (
        <span id={errorId} className="mdlx-error">
          {t(jsonParameterIssueMessageKey(issue))}
        </span>
      )}
    </>
  );
}

function ProposalCard({
  snapshot,
  parameters,
  controller,
  t,
}: {
  snapshot: DesignSnapshotWire;
  parameters: Readonly<Record<string, ClientJsonValue>>;
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
        <p className="mdlx-muted">
          {t("proposalSummary", { count: proposal.changes.length })}
        </p>
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
          <p>{t("proposalConflictsSummary", { count: proposal.conflicts.length })}</p>
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
          onClick={() => { void controller.applyProposal(proposal.proposalId, parameters); }}
        >
          {t("applyProposal")}
        </Button>
      </div>
    </section>
  );
}

function DesignResults({
  snapshot,
  dateLocale,
  dialogCoordinator,
  dialog,
  t,
}: {
  snapshot: DesignSnapshotWire;
  dateLocale: string;
  dialogCoordinator: CredentialDialogCoordinator;
  dialog: CredentialDialogSnapshot;
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
          <ResultSection title={t("runningTitle")} jobs={groups.running} dateLocale={dateLocale} dialogCoordinator={dialogCoordinator} dialog={dialog} t={t} />
          <ResultSection title={t("succeededTitle")} jobs={groups.succeeded} dateLocale={dateLocale} dialogCoordinator={dialogCoordinator} dialog={dialog} t={t} />
          <ResultSection title={t("diagnosticsTitle")} jobs={groups.diagnostics} dateLocale={dateLocale} dialogCoordinator={dialogCoordinator} dialog={dialog} t={t} />
        </div>
      )}
    </section>
  );
}

function ResultSection({
  title,
  jobs,
  dateLocale,
  dialogCoordinator,
  dialog,
  t,
}: {
  title: string;
  jobs: readonly DesignJobWire[];
  dateLocale: string;
  dialogCoordinator: CredentialDialogCoordinator;
  dialog: CredentialDialogSnapshot;
  t: ModellixTranslate;
}): ReactNode {
  if (jobs.length === 0) return null;
  return (
    <section className="mdlx-result-section">
      <h3>{title}</h3>
      <ul className="mdlx-result-list">
        {jobs.map((job) => (
          <ResultCard
            key={job.jobId}
            job={job}
            dateLocale={dateLocale}
            dialogCoordinator={dialogCoordinator}
            dialog={dialog}
            t={t}
          />
        ))}
      </ul>
    </section>
  );
}

function ResultCard({
  job,
  dateLocale,
  dialogCoordinator,
  dialog,
  t,
}: {
  job: DesignJobWire;
  dateLocale: string;
  dialogCoordinator: CredentialDialogCoordinator;
  dialog: CredentialDialogSnapshot;
  t: ModellixTranslate;
}): ReactNode {
  const status = jobStatus(job.status, t);
  const created = formatTime(job.createdAt, dateLocale);
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
            <ResultResource
              key={resource.id}
              resource={resource}
              dateLocale={dateLocale}
              dialogCoordinator={dialogCoordinator}
              dialog={dialog}
              t={t}
            />
          ))}
        </div>
      )}
      {job.diagnostic !== null && (
        <div className="mdlx-error">
          <strong className="mdlx-code">{job.diagnostic.code}</strong>
          <p>{t(designDiagnosticMessageKey(job.diagnostic.code))}</p>
          {job.diagnostic.retryable && <p>{t("diagnosticRetryable")}</p>}
        </div>
      )}
    </li>
  );
}

function ResultResource({
  resource,
  dateLocale,
  dialogCoordinator,
  dialog,
  t,
}: {
  resource: DesignResourceWire;
  dateLocale: string;
  dialogCoordinator: CredentialDialogCoordinator;
  dialog: CredentialDialogSnapshot;
  t: ModellixTranslate;
}): ReactNode {
  const imageDialogOwner = `design-image:${useId()}`;
  const imageOpen = dialog.activeOwner === imageDialogOwner;
  const imageSurfaceOpen = useExternalDialogGate(imageOpen);
  const imageDialogRef = useRef<HTMLDivElement | null>(null);
  const closeImage = useCallback(
    () => dialogCoordinator.close(imageDialogOwner),
    [dialogCoordinator, imageDialogOwner],
  );
  useEffect(
    () => () => dialogCoordinator.release(imageDialogOwner),
    [dialogCoordinator, imageDialogOwner],
  );
  useDialogA11y({
    open: imageSurfaceOpen,
    container: imageDialogRef,
    initialFocusSelector: "[data-mdlx-initial-focus]",
    mandatory: false,
    onEscape: closeImage,
  });
  return (
    <>
      <article className="mdlx-resource">
      <DesignResultPreview resource={resource} t={t} />
      <div className="mdlx-actions mdlx-actions-start">
        {resource.kind === "image" && (
          <button
            type="button"
            className="mdlx-safe-link mdlx-link-button"
            onClick={() => dialogCoordinator.open(imageDialogOwner)}
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
          {t("expiresAt", { time: formatTime(resource.expiresAt, dateLocale) })}
        </span>
      )}
      </article>
      {resource.kind === "image" && (
        <Modal
          open={imageSurfaceOpen}
          title={t("imageViewerTitle")}
          closeLabel={t("close")}
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

function designOutcomeText(
  transition: DesignOutcomeTransition,
  t: ModellixTranslate,
): string | null {
  const messages: string[] = [];
  if (transition.proposalReady) messages.push(t("proposalReadyAnnouncement"));
  if (transition.succeeded > 0) {
    messages.push(t("jobsSucceededAnnouncement", { count: transition.succeeded }));
  }
  if (transition.failed > 0) {
    messages.push(t("jobsFailedAnnouncement", { count: transition.failed }));
  }
  if (transition.expired > 0) {
    messages.push(t("jobsExpiredAnnouncement", { count: transition.expired }));
  }
  if (transition.running > 0) {
    messages.push(t("jobsRunningAnnouncement", { count: transition.running }));
  }
  return messages.length === 0 ? null : messages.join(" ");
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

function formatTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
