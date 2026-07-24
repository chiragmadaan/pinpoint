import { emptyPlayerState, type PlayerState } from "@pinpoint/core";

const KEY = "pinpoint.player";

export function loadPlayerState(): PlayerState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PlayerState) : emptyPlayerState();
  } catch {
    return emptyPlayerState();
  }
}

export function savePlayerState(state: PlayerState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* non-fatal */
  }
}

/** Wipe saved progress (used by the dev-only reset so you can replay today's puzzle). */
export function clearPlayerState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}

// --- Dev-only flags (persisted separately so they survive a progress reset / reload) ---
const DEV_KEY = "pinpoint.dev";

export interface DevFlags {
  /** Bypass the daily 3-question limit: replay endlessly for testing. */
  unlimited: boolean;
}

export function loadDevFlags(): DevFlags {
  try {
    return { unlimited: false, ...(JSON.parse(localStorage.getItem(DEV_KEY) || "{}") as Partial<DevFlags>) };
  } catch {
    return { unlimited: false };
  }
}

export function saveDevFlags(flags: DevFlags): void {
  try {
    localStorage.setItem(DEV_KEY, JSON.stringify(flags));
  } catch {
    /* non-fatal */
  }
}
