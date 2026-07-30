import { emptyPlayerState, type PlayerState } from "@pinpoint/core";

// The hosted /dev/ build shares an origin with production, so give it a separate key — otherwise
// dev testing (grinding XP, resetting) would overwrite your real progress on the prod site.
const DEV_TOOLS = import.meta.env.DEV || import.meta.env.VITE_DEV_TOOLS === "1";
const KEY = DEV_TOOLS ? "pinpoint.player.dev" : "pinpoint.player";

export function loadPlayerState(): PlayerState {
  try {
    const raw = localStorage.getItem(KEY);
    // Merge over defaults so an older/partial save (missing a field) can't crash the app on load.
    return raw ? { ...emptyPlayerState(), ...(JSON.parse(raw) as Partial<PlayerState>) } : emptyPlayerState();
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
  /** Remove the per-question countdown so the game can be tested at a patient pace. */
  noTimer: boolean;
}

export function loadDevFlags(): DevFlags {
  const defaults: DevFlags = { unlimited: false, noTimer: false };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(DEV_KEY) || "{}") as Partial<DevFlags>) };
  } catch {
    return defaults;
  }
}

export function saveDevFlags(flags: DevFlags): void {
  try {
    localStorage.setItem(DEV_KEY, JSON.stringify(flags));
  } catch {
    /* non-fatal */
  }
}
