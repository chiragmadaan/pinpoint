// Pure, framework-agnostic session state machine for one day's puzzle.
// Both apps/web and apps/playable render a thin view over this — the rules live here and are tested.

import {
  DEFAULT_SCORE_CONFIG,
  scoreGuess,
  type Adjacency,
  type ScoreConfig,
} from "./scoring.ts";
import type { DailyPuzzle, Difficulty, GuessResult, Iso3, Question, Verdict } from "./types.ts";

export type Phase = "question" | "revealed" | "done";

/** Seconds allowed per question, by difficulty — harder questions need more time to reason. */
export const TIMER_SECONDS: Record<Difficulty, number> = { easy: 20, medium: 25, hard: 30 };

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

/** Index 3 is the bonus question (unlocked only after acing the mandatory 3). */
export const isBonusQuestion = (s: Session): boolean => s.index === 3;

export function currentQuestion(s: Session): Question | null {
  if (s.phase === "done") return null;
  if (s.index < 3) return s.puzzle.questions[s.index] ?? null;
  return s.puzzle.bonus ?? null; // index 3 -> bonus
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
  const q = currentQuestion(s)!;
  const result = scoreGuess(q, s.selected, adjacency, cfg);
  return { ...s, results: [...s.results, result], phase: "revealed" };
}

/**
 * Time ran out. If a country was selected, submit it; otherwise record a miss (no guess) and reveal.
 * Anti-cheat: the countdown limits how long a player has to look the answer up.
 */
export function timeUp(s: Session, adjacency: Adjacency = {}, cfg: ScoreConfig = DEFAULT_SCORE_CONFIG): Session {
  if (s.phase !== "question") return s;
  if (s.selected != null) return submitGuess(s, adjacency, cfg);
  const q = currentQuestion(s)!;
  const result: GuessResult = { verdict: "wrong", points: 0, guessIso: "", correctIso: q.answerIso };
  return { ...s, results: [...s.results, result], phase: "revealed" };
}

/** Did the player get all three mandatory questions correct? (Gates the bonus.) */
export const acedMain = (s: Session): boolean =>
  s.results.length >= 3 && s.results.slice(0, 3).every((r) => r.verdict === "correct");

/** After the reveal, advance to the next question, unlock the bonus, or finish the day. */
export function advance(s: Session): Session {
  if (s.phase !== "revealed") return s;
  if (s.index < 2) return { ...s, index: s.index + 1, selected: null, phase: "question" };
  if (s.index === 2) {
    // Just revealed Q3: unlock the bonus only if all 3 were correct and a bonus exists.
    if (acedMain(s) && s.puzzle.bonus) return { ...s, index: 3, selected: null, phase: "question" };
    return { ...s, phase: "done", selected: null };
  }
  return { ...s, phase: "done", selected: null }; // after the bonus
}

export const sessionVerdicts = (s: Session): Verdict[] => s.results.map((r) => r.verdict);
export const sessionXp = (s: Session): number => s.results.reduce((a, r) => a + r.points, 0);
export const isComplete = (s: Session): boolean => s.phase === "done";
