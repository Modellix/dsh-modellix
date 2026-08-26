import type { SettingsSnapshotWire } from "./contracts.js";

export function shouldPromptOnboarding(
  snapshot: Pick<SettingsSnapshotWire, "credential" | "onboarding">,
): boolean {
  // Explicit capability recovery and an already-invalid Credential are owned by
  // the single shell.overlay recovery seat. Letting the onboarding seat render
  // the same state would create two dialogs (and two independent inert/focus
  // lifecycles) for one recovery request.
  if (
    snapshot.onboarding.recoveryRequestId !== null ||
    snapshot.credential.verification === "invalid"
  ) {
    return false;
  }
  if (
    !snapshot.credential.writable &&
    snapshot.onboarding.status === "deferred"
  ) {
    return false;
  }
  if (snapshot.onboarding.recoveryPending) return true;
  return !snapshot.credential.configured && snapshot.onboarding.status !== "deferred";
}
