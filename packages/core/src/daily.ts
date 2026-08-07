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

/** Parse a "YYYY-MM-DD" key as a LOCAL date, matching how dateKey() builds them. */
function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/**
 * Today's puzzle (local time), never null while the calendar has any content.
 *
 * Once the pre-generated dates run out we WRAP to the start rather than giving up. Returning null
 * here used to brick the game outright: the app fell back to `puzzles[0]`, whose date is in the
 * past, so `hasCompleted` reported that day already finished and every player — returning and brand
 * new alike — was stuck on "Come back tomorrow!" forever, with no way out.
 *
 * The wrapped puzzle is re-dated to TODAY, which is the part that matters. Replaying old *content*
 * after ~2 years is a mild cost; replaying an old *date* is what broke history, streaks and the
 * share text. Topping the calendar up is still the real answer — `pnpm validate` warns well before
 * the runway ends — but the game degrades quietly instead of dying.
 */
export function todaysPuzzle(calendar: PuzzleCalendar, now: Date = new Date()): DailyPuzzle | null {
  const key = todayKey(now);
  const exact = puzzleForDate(calendar, key);
  if (exact) return exact;

  const { puzzles } = calendar;
  if (puzzles.length === 0) return null; // genuinely nothing to serve
  const start = parseKey(puzzles[0]!.date);
  const dayOffset = Math.round((parseKey(key).getTime() - start.getTime()) / 86_400_000);
  const i = ((dayOffset % puzzles.length) + puzzles.length) % puzzles.length; // also handles before-start
  return { ...puzzles[i]!, date: key };
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

/**
 * The streak as it stands *right now*, for display. Unlike the stored `streak` (which is only
 * recomputed when a day is completed), this reflects a missed day immediately: after a gap the
 * streak is already broken (0). Keeps the header honest instead of showing a stale number that
 * then jumps down the moment you finish today's puzzle.
 *
 * NOTE: this is per-device — with no account sync, a day played on another device can't count
 * here, so cross-device play will still break the streak. That needs cloud save to fix.
 */
export function currentStreak(state: PlayerState, today: string = todayKey()): number {
  if (state.lastPlayed === null) return 0;
  if (state.lastPlayed === today) return state.streak; // already played today
  if (isConsecutiveDay(state.lastPlayed, today)) return state.streak; // last play was yesterday -> alive
  return 0; // gap -> already broken
}
