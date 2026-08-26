import type {
  ClientJsonValue,
  DesignDraftWire,
  DesignFieldWire,
  DesignJobWire,
  DesignModelWire,
  DesignSnapshotWire,
} from "./contracts.js";

export interface DesignOutcomeTransition {
  readonly proposalReady: boolean;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly expired: number;
}

export function selectedDesignModel(
  snapshot: Pick<DesignSnapshotWire, "models" | "selectedModelId">,
): DesignModelWire | null {
  if (snapshot.selectedModelId === null) return null;
  return snapshot.models.find((model) => model.id === snapshot.selectedModelId) ?? null;
}

export function canGenerateDesign(input: {
  readonly snapshot: DesignSnapshotWire;
  readonly draft: DesignDraftWire | null;
  readonly missingRequired: boolean;
  readonly invalidFieldCount: number;
  readonly interactionBusy: boolean;
}): boolean {
  const { snapshot, draft, missingRequired, invalidFieldCount, interactionBusy } = input;
  return snapshot.enabled &&
    snapshot.credentialReady &&
    selectedDesignModel(snapshot)?.available === true &&
    draft !== null &&
    invalidFieldCount === 0 &&
    !missingRequired &&
    !interactionBusy;
}

export function isMissingDesignParameter(
  parameters: Readonly<Record<string, ClientJsonValue>>,
  path: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(parameters, path)) return true;
  const value = parameters[path];
  if (value === null || value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

/** Validates every constraint present on the client wire; requiredness is separate. */
export function isDesignFieldValueValid(
  field: DesignFieldWire,
  value: ClientJsonValue | undefined,
): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (field.kind === "enum") {
    return field.options.some((option) => Object.is(option.value, value));
  }
  if (field.kind === "number" || field.kind === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (field.kind === "integer" && !Number.isInteger(value)) return false;
    if (field.minimum !== null && value < field.minimum) return false;
    if (field.maximum !== null && value > field.maximum) return false;
    if (field.step !== null && field.step > 0) {
      const offset = value - (field.minimum ?? 0);
      const steps = offset / field.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return false;
    }
    return true;
  }
  if (field.kind === "boolean") return typeof value === "boolean";
  if (field.kind === "array") return Array.isArray(value);
  if (field.kind === "object") {
    return typeof value === "object" && !Array.isArray(value);
  }
  if (typeof value !== "string") return false;
  return field.maxLength === null || value.length <= field.maxLength;
}

export function designOutcomeTransition(
  previous: Pick<DesignSnapshotWire, "proposal" | "jobs"> | null,
  current: Pick<DesignSnapshotWire, "proposal" | "jobs">,
): DesignOutcomeTransition {
  if (previous === null) return emptyTransition();
  const previousJobs = new Map(previous.jobs.map((job) => [job.jobId, job.status]));
  const counts = { running: 0, succeeded: 0, failed: 0, expired: 0 };
  for (const job of current.jobs) {
    if (previousJobs.get(job.jobId) === job.status) continue;
    incrementOutcome(counts, job.status);
  }
  return {
    proposalReady:
      current.proposal !== null &&
      current.proposal.proposalId !== previous.proposal?.proposalId,
    ...counts,
  };
}

function incrementOutcome(
  counts: { running: number; succeeded: number; failed: number; expired: number },
  status: DesignJobWire["status"],
): void {
  switch (status) {
    case "running":
      counts.running += 1;
      break;
    case "succeeded":
      counts.succeeded += 1;
      break;
    case "expired":
      counts.expired += 1;
      break;
    case "failed":
    case "canceled":
    case "submit-unknown":
      counts.failed += 1;
      break;
  }
}

function emptyTransition(): DesignOutcomeTransition {
  return { proposalReady: false, running: 0, succeeded: 0, failed: 0, expired: 0 };
}
