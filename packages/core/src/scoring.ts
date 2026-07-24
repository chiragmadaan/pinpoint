import type { GuessResult, Iso3, Question } from "./types.ts";

/** Adjacency: country -> land-bordering countries. Powers partial (neighbor) credit. */
export type Adjacency = Record<Iso3, Iso3[]>;

export interface ScoreConfig {
  /** Points for a fully correct guess before speed bonus. */
  base: number;
  /** Fraction of `base` awarded for guessing a bordering country. */
  neighborFraction: number;
  /** Max additional points for answering fast. */
  maxSpeedBonus: number;
  /** Answers within this window earn a proportional slice of maxSpeedBonus. */
  speedWindowMs: number;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  base: 1000,
  neighborFraction: 0.5,
  maxSpeedBonus: 250,
  speedWindowMs: 10_000,
};

/** Linear speed bonus: full at 0ms, zero at/after speedWindowMs. */
export function speedBonus(elapsedMs: number, cfg: ScoreConfig): number {
  const frac = Math.max(0, 1 - elapsedMs / cfg.speedWindowMs);
  return Math.round(cfg.maxSpeedBonus * frac);
}

/**
 * Score a single guess.
 * - correct  : guess is in the question's acceptedIso set  -> base + speed bonus
 * - neighbor : guess borders the canonical answer          -> base * neighborFraction (no bonus)
 * - wrong    : otherwise                                    -> 0
 */
export function scoreGuess(
  question: Question,
  guessIso: Iso3,
  elapsedMs: number,
  adjacency: Adjacency,
  cfg: ScoreConfig = DEFAULT_SCORE_CONFIG,
): GuessResult {
  const base = { guessIso, correctIso: question.answerIso };

  if (question.acceptedIso.includes(guessIso)) {
    return { ...base, verdict: "correct", points: cfg.base + speedBonus(elapsedMs, cfg) };
  }

  const neighbors = adjacency[question.answerIso] ?? [];
  if (neighbors.includes(guessIso)) {
    return { ...base, verdict: "neighbor", points: Math.round(cfg.base * cfg.neighborFraction) };
  }

  return { ...base, verdict: "wrong", points: 0 };
}

// ---------------------------------------------------------------------------
// Multi-select scoring — FULL PRODUCT only (MVP ships single-answer questions).
// For clues with several correct countries (e.g. Ganga delta -> IND + BGD), the player may select
// multiple countries before submitting:
//   - full XP if the selected set exactly matches the accepted set
//   - partial XP if only a subset is selected
//   - selecting WRONG countries dilutes the score (Jaccard: |correct ∩ selected| / |correct ∪ selected|)
// so "select everything" can't game it. Exact match => Jaccard 1.0 => full base points.
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
  cfg: ScoreConfig = DEFAULT_SCORE_CONFIG,
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
    points: Math.round(cfg.base * jaccard),
    correctIso: accepted,
    selectedIso: selected,
  };
}
