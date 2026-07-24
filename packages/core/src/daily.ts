import type { DailyPuzzle, PlayerState, PuzzleCalendar, Verdict } from "./types.ts";

/**
 * Daily boundary = LOCAL midnight (matches Wordle & GeoGuessr): Australia gets a day's puzzle
 * before California. Known, accepted tradeoff: this is exploitable by changing the device clock to
 * replay past/future days — the same exploit Wordle/GeoGuessr live with. For a shared *social*
 * daily that's fine; if we ever add competitive leaderboards, gate those server-side (post-traction).
 */
export function dateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's local date key. */
export function todayKey(now: Date = new Date()): string {
  return dateKey(now);
}

/** Look up the puzzle for a given local day, or null if the calendar doesn't cover it. */
export function puzzleForDate(calendar: PuzzleCalendar, key: string): DailyPuzzle | null {
  return calendar.puzzles.find((p) => p.date === key) ?? null;
}

/** Today's puzzle (local time). Returns null if we've run out of pre-generated content — top up. */
export function todaysPuzzle(calendar: PuzzleCalendar, now: Date = new Date()): DailyPuzzle | null {
  return puzzleForDate(calendar, todayKey(now));
}

/** Whether the player has already finished (all 3 answered) a given day. */
export function hasCompleted(state: PlayerState, key: string): boolean {
  return (state.history[key]?.length ?? 0) >= 3;
}

export function emptyPlayerState(): PlayerState {
  return { xp: 0, streak: 0, lastPlayed: null, history: {} };
}

/** Was `prev` exactly the local day before `curr`? Used to decide streak continue vs. reset. */
function isConsecutiveDay(prev: string, curr: string): boolean {
  const [py, pm, pd] = prev.split("-").map(Number) as [number, number, number];
  const next = new Date(py, pm - 1, pd);
  next.setDate(next.getDate() + 1);
  return dateKey(next) === curr;
}

/**
 * Record a completed day (all three verdicts) into player state: adds XP, updates the streak,
 * and marks the day done. Idempotent — replaying a recorded day returns state unchanged.
 */
export function recordCompletedDay(
  state: PlayerState,
  key: string,
  verdicts: Verdict[],
  xpGained: number,
): PlayerState {
  if (hasCompleted(state, key)) return state;

  let streak: number;
  if (state.lastPlayed === null) streak = 1;
  else if (isConsecutiveDay(state.lastPlayed, key)) streak = state.streak + 1;
  else if (state.lastPlayed === key) streak = state.streak;
  else streak = 1; // gap -> reset

  return {
    xp: state.xp + xpGained,
    streak,
    lastPlayed: key,
    history: { ...state.history, [key]: verdicts },
  };
}
