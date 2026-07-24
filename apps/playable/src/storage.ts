// Player-state persistence for the PLAYABLE surface.
//
// Playables forbid PII and account screens, but YouTube provides a managed save
// ("save your game progress and track your all-time best scores"). Wire the ytgame SDK here.
// We fall back to localStorage for local dev outside the YouTube host.
//
// TODO: confirm the exact ytgame save API surface at build time (see research doc §5) and
// replace the localStorage fallback branches with ytgame.game.saveData / loadData calls.

import { emptyPlayerState, type PlayerState } from "@pinpoint/core";

const KEY = "geoquiz.player";

export async function loadPlayerState(): Promise<PlayerState> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PlayerState) : emptyPlayerState();
  } catch {
    return emptyPlayerState();
  }
}

export async function savePlayerState(state: PlayerState): Promise<void> {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore — non-fatal for a daily game */
  }
}
