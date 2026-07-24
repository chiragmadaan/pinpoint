// Pure, framework-agnostic session state machine for one day's puzzle.
// Both apps/web and apps/playable render a thin view over this — the rules live here and are tested.

import {
  DEFAULT_SCORE_CONFIG,
  scoreGuess,
  type Adjacency,
  type ScoreConfig,
} from "./scoring.ts";
import type { DailyPuzzle, GuessResult, Iso3, Question, Verdict } from "./types.ts";

export type Phase = "question" | "revealed" | "done";

export interface Session {
  puzzle: DailyPuzzle;
  index: number; // 0..2
  selected: Iso3 | null; // current pick, pre-submit
  results: GuessResult[]; // one per answered question
  phase: Phase;
}

export function startSession(puzzle: DailyPuzzle): Session {
  return { puzzle, index: 0, selected: null, results: [], phase: "question" };
}

export function currentQuestion(s: Session): Question | null {
  return s.phase === "done" ? null : (s.puzzle.questions[s.index] ?? null);
}

/** Two-tap flow, step 1: select (or re-select) a country. Ignored unless we're taking a guess. */
export function selectCountry(s: Session, iso: Iso3 | null): Session {
  if (s.phase !== "question") return s;
  return { ...s, selected: iso };
}

/** Two-tap flow, step 2: submit the selected country. No-op if nothing is selected. */
export function submitGuess(
  s: Session,
  adjacency: Adjacency = {},
  cfg: ScoreConfig = DEFAULT_SCORE_CONFIG,
): Session {
  if (s.phase !== "question" || s.selected == null) return s;
  const q = s.puzzle.questions[s.index]!;
  const result = scoreGuess(q, s.selected, adjacency, cfg);
  return { ...s, results: [...s.results, result], phase: "revealed" };
}

/** After the reveal, advance to the next question or finish the day. */
export function advance(s: Session): Session {
  if (s.phase !== "revealed") return s;
  const nextIndex = s.index + 1;
  if (nextIndex >= s.puzzle.questions.length) return { ...s, phase: "done", selected: null };
  return { ...s, index: nextIndex, selected: null, phase: "question" };
}

export const sessionVerdicts = (s: Session): Verdict[] => s.results.map((r) => r.verdict);
export const sessionXp = (s: Session): number => s.results.reduce((a, r) => a + r.points, 0);
export const isComplete = (s: Session): boolean => s.phase === "done";
