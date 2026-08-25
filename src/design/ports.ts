export type FetchPort = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ClockPort {
  now(): number;
}

export interface SleepPort {
  sleep(delayMs: number): Promise<void>;
}

export interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface CachePort {
  read<T>(key: string): Promise<CacheEntry<T> | null>;
  write<T>(key: string, entry: CacheEntry<T>): Promise<void>;
}

export interface StoragePort {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export type DesignLogLevel = "info" | "warn";

/**
 * Design modules only emit bounded identifiers and counters. Request bodies,
 * prompts, API keys, signed resource URLs, and thrown Error objects are never
 * part of this contract.
 */
export interface DesignLogEvent {
  readonly level: DesignLogLevel;
  readonly event: string;
  readonly operation: string;
  readonly status?: number;
  readonly attempt?: number;
  readonly taskId?: string;
  readonly requestId?: string;
  readonly model?: string;
}

export interface LoggerPort {
  write(event: DesignLogEvent): void;
}

export const systemClock: ClockPort = Object.freeze({
  now: () => Date.now(),
});

export const systemSleep: SleepPort = Object.freeze({
  sleep: (delayMs: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
});
