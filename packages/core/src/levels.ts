// Leveling curve. Players start at level 1. The XP bar fills within the current level; when it's
// full, the player levels up and the bar resets.
//
// XP required to CLEAR a level (advance to the next) grows linearly:
//     clear(L) = BASE + (L - 1) * STEP
// With BASE=1000, STEP=500:  L1->2 needs 1000, L2->3 needs 1500, L3->4 needs 2000, ...
// A perfect day = 200 + 400 + 600 = 1200 XP, so early levels take ~1 day and later ones take longer
// — a gentle, ever-slowing curve that keeps long-term players progressing without a hard cap.

export const LEVEL_BASE_XP = 1000;
export const LEVEL_STEP_XP = 500;

/** XP needed to clear a given level (i.e. to go from `level` to `level + 1`). */
export function xpToClearLevel(level: number): number {
  return LEVEL_BASE_XP + (Math.max(1, level) - 1) * LEVEL_STEP_XP;
}

export interface LevelProgress {
  level: number; // current level (>= 1)
  xpIntoLevel: number; // XP accumulated inside the current level
  xpForNext: number; // XP required to clear the current level
  progress: number; // 0..1 — how full the XP bar is
  totalXp: number; // lifetime XP
}

/** Resolve total lifetime XP into the player's current level + XP-bar progress. */
export function levelForXp(totalXp: number): LevelProgress {
  const total = Math.max(0, Math.floor(totalXp));
  let level = 1;
  let remaining = total;
  while (remaining >= xpToClearLevel(level)) {
    remaining -= xpToClearLevel(level);
    level++;
  }
  const xpForNext = xpToClearLevel(level);
  return { level, xpIntoLevel: remaining, xpForNext, progress: remaining / xpForNext, totalXp: total };
}

/** Precomputed cumulative XP thresholds to REACH each level (index 0 => level 1 => 0 XP). */
export function levelThresholds(maxLevel: number): number[] {
  const out = [0];
  let cum = 0;
  for (let l = 1; l < maxLevel; l++) {
    cum += xpToClearLevel(l);
    out.push(cum);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trophies: collectible milestone badges unlocked at level thresholds. Levels stay numeric and
// infinite; trophies are the themed, shareable rewards you accumulate along the way.
// ---------------------------------------------------------------------------

export interface Trophy {
  name: string;
  emoji: string;
  /** The level at which this trophy is unlocked. */
  level: number;
}

/** Ascending by unlock level. Add more milestones freely — levels are infinite, trophies are curated. */
export const TROPHIES: readonly Trophy[] = [
  { name: "Wanderer", emoji: "🧭", level: 1 },
  { name: "Explorer", emoji: "🗺️", level: 4 },
  { name: "Navigator", emoji: "⛵", level: 8 },
  { name: "Globetrotter", emoji: "🌍", level: 13 },
  { name: "Cartographer", emoji: "📐", level: 19 },
  { name: "Atlas", emoji: "🏆", level: 26 },
];

/** All trophies unlocked at or below the given level (in unlock order). */
export function trophiesEarned(level: number): Trophy[] {
  return TROPHIES.filter((t) => level >= t.level);
}

/** The most recently unlocked trophy for a level, or null if none yet. */
export function latestTrophy(level: number): Trophy | null {
  const earned = trophiesEarned(level);
  return earned.length ? earned[earned.length - 1]! : null;
}

/** Trophies unlocked by crossing from `fromLevel` to `toLevel` (for level-up celebrations). */
export function trophiesUnlockedBetween(fromLevel: number, toLevel: number): Trophy[] {
  return TROPHIES.filter((t) => t.level > fromLevel && t.level <= toLevel);
}
