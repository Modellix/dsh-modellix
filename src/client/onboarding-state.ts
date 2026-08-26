import type { SettingsSnapshotWire } from "./contracts.js";

export function shouldPromptOnboarding(
  snapshot: Pick<SettingsSnapshotWire, "credential" | "onboarding">,
): boolean {
  if (snapshot.onboarding.recoveryPending) return true;
  if (snapshot.credential.verification === "invalid") return true;
  return !snapshot.credential.configured && snapshot.onboarding.status !== "deferred";
}
