import type { Difficulty, GuessResult, Iso3, Question } from "./types.ts";

/** Adjacency: country -> land-bordering countries. Powers partial (neighbor) credit. */
export type Adjacency = Record<Iso3, Iso3[]>;

/** Staggered XP per difficulty — a correct answer is worth more the harder the question. */
export const DIFFICULTY_XP: Record<Difficulty, number> = {
  easy: 200,
  medium: 400,
  hard: 600,
};

export interface ScoreConfig {
  /** Fraction of the difficulty XP awarded for guessing a bordering country. Default 0 (no credit). */
  neighborFraction: number;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  neighborFraction: 0, // a neighbor is acknowledged ("Close — a neighbor!") but earns 0 points
};

/**
 * Score a single guess.
 * - correct  : guess is in the question's acceptedIso set  -> full difficulty XP (200/400/600)
 * - neighbor : guess borders the canonical answer          -> difficulty XP * neighborFraction (0 by default)
 * - wrong    : otherwise                                    -> 0
 */
export function scoreGuess(
  question: Question,
  guessIso: Iso3,
  adjacency: Adjacency,
  cfg: ScoreConfig = DEFAULT_SCORE_CONFIG,
): GuessResult {
  const full = DIFFICULTY_XP[question.difficulty];
  const base = { guessIso, correctIso: question.answerIso };

  if (question.acceptedIso.includes(guessIso)) {
    return { ...base, verdict: "correct", points: full };
  }

  const neighbors = adjacency[question.answerIso] ?? [];
  if (neighbors.includes(guessIso)) {
    return { ...base, verdict: "neighbor", points: Math.round(full * cfg.neighborFraction) };
  }

  return { ...base, verdict: "wrong", points: 0 };
}

// ---------------------------------------------------------------------------
// Multi-select scoring — FULL PRODUCT only (MVP ships single-answer questions).
// For clues with several correct countries (e.g. Ganga delta -> IND + BGD), the player may select
// multiple countries before submitting. Jaccard of selected vs accepted, scaled by difficulty XP:
//   - full XP if the selected set exactly matches the accepted set
//   - partial XP for a subset; wrong picks dilute the score (so "select everything" can't game it)
// ---------------------------------------------------------------------------

export type MultiVerdict = "correct" | "partial" | "wrong";

export interface MultiSelectResult {
  verdict: MultiVerdict;
  points: number;
  correctIso: Iso3[];
  selectedIso: Iso3[];
}

export function scoreMultiSelect(
  accepted: Iso3[],
  selected: Iso3[],
  difficulty: Difficulty,
): MultiSelectResult {
  const acc = new Set(accepted);
  const sel = new Set(selected);
  const intersection = [...sel].filter((x) => acc.has(x)).length;
  const union = new Set([...acc, ...sel]).size;
  const jaccard = union === 0 ? 0 : intersection / union;

  const verdict: MultiVerdict =
    jaccard === 1 ? "correct" : intersection > 0 ? "partial" : "wrong";

  return {
    verdict,
    points: Math.round(DIFFICULTY_XP[difficulty] * jaccard),
    correctIso: accepted,
    selectedIso: selected,
  };
}
