import { useSyncExternalStore } from "react";

import type { SettingsController } from "./store.js";

export const RECOVERY_CREDENTIAL_DIALOG_OWNER = "shell:credential-recovery";

export interface CredentialDialogSnapshot {
  readonly revision: number;
  readonly activeOwner: string | null;
  readonly recoveryToken: string | null;
  readonly dismissedRecoveryToken: string | null;
}

/**
 * Arbitrates every post-onboarding Credential editor that shares one
 * SettingsController. A current dialog keeps its lease when recovery arrives,
 * so it can upgrade in place instead of competing with the shell overlay.
 */
export class CredentialDialogCoordinator {
  readonly #listeners = new Set<() => void>();
  #snapshot: CredentialDialogSnapshot = Object.freeze({
    revision: 0,
    activeOwner: null,
    recoveryToken: null,
    dismissedRecoveryToken: null,
  });

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): CredentialDialogSnapshot => this.#snapshot;

  open(owner: string): void {
    if (this.#snapshot.activeOwner !== null) return;
    this.#publish({ activeOwner: owner });
  }

  /** Lets an explicit Credential editor adopt a queued shell recovery prompt. */
  openCredential(owner: string): void {
    if (
      this.#snapshot.activeOwner !== null &&
      this.#snapshot.activeOwner !== RECOVERY_CREDENTIAL_DIALOG_OWNER
    ) {
      return;
    }
    this.#publish({ activeOwner: owner });
  }

  presentRecovery(token: string): void {
    if (token === this.#snapshot.dismissedRecoveryToken) return;
    if (token === this.#snapshot.recoveryToken) {
      if (this.#snapshot.activeOwner === null) {
        this.#publish({ activeOwner: RECOVERY_CREDENTIAL_DIALOG_OWNER });
      }
      return;
    }
    this.#publish({
      recoveryToken: token,
      dismissedRecoveryToken: null,
      activeOwner:
        this.#snapshot.activeOwner ?? RECOVERY_CREDENTIAL_DIALOG_OWNER,
    });
  }

  clearRecovery(): void {
    if (
      this.#snapshot.recoveryToken === null &&
      this.#snapshot.dismissedRecoveryToken === null
    ) {
      return;
    }
    this.#publish({
      recoveryToken: null,
      dismissedRecoveryToken: null,
      activeOwner:
        this.#snapshot.activeOwner === RECOVERY_CREDENTIAL_DIALOG_OWNER
          ? null
          : this.#snapshot.activeOwner,
    });
  }

  /** Releases an ordinary Modal and hands a queued recovery to the shell. */
  close(owner: string): void {
    if (this.#snapshot.activeOwner !== owner) return;
    this.#publish({
      activeOwner:
        this.#snapshot.recoveryToken === null
          ? null
          : owner === RECOVERY_CREDENTIAL_DIALOG_OWNER
            ? null
            : RECOVERY_CREDENTIAL_DIALOG_OWNER,
    });
  }

  /** Closes a Credential editor and dismisses only the current recovery token. */
  dismissCredential(owner: string): void {
    if (this.#snapshot.activeOwner !== owner) return;
    this.#publish({
      activeOwner: null,
      recoveryToken: null,
      dismissedRecoveryToken:
        this.#snapshot.recoveryToken ?? this.#snapshot.dismissedRecoveryToken,
    });
  }

  completeCredential(owner: string): void {
    this.dismissCredential(owner);
  }

  release(owner: string): void {
    if (this.#snapshot.activeOwner !== owner) return;
    this.#publish({
      activeOwner:
        this.#snapshot.recoveryToken === null
          ? null
          : owner === RECOVERY_CREDENTIAL_DIALOG_OWNER
            ? null
            : RECOVERY_CREDENTIAL_DIALOG_OWNER,
    });
  }

  #publish(
    patch: Partial<Omit<CredentialDialogSnapshot, "revision">>,
  ): void {
    const next = Object.freeze({
      ...this.#snapshot,
      ...patch,
      revision: this.#snapshot.revision + 1,
    });
    if (
      next.activeOwner === this.#snapshot.activeOwner &&
      next.recoveryToken === this.#snapshot.recoveryToken &&
      next.dismissedRecoveryToken === this.#snapshot.dismissedRecoveryToken
    ) {
      return;
    }
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

const COORDINATORS = new WeakMap<SettingsController, CredentialDialogCoordinator>();

export function credentialDialogCoordinatorFor(
  controller: SettingsController,
): CredentialDialogCoordinator {
  const current = COORDINATORS.get(controller);
  if (current !== undefined) return current;
  const created = new CredentialDialogCoordinator();
  COORDINATORS.set(controller, created);
  return created;
}

export function useCredentialDialogSnapshot(
  coordinator: CredentialDialogCoordinator,
): CredentialDialogSnapshot {
  return useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
}
