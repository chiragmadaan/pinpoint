// Pure transforms: raw Wikidata rows -> validated questions -> difficulty-ranked -> no-repeat calendar.
// No network here (testable). generate.ts fetches the rows and calls these.

import type { ClueType, DailyPuzzle, Difficulty, PuzzleCalendar, Question } from "@pinpoint/core";

export interface CountryMeta {
  iso: string; // alpha-3
  name: string;
  alpha2?: string;
  sitelinks: number; // Wikipedia-language count — our "fame" signal
  pop?: number;
}

export interface ValueRow {
  iso: string;
  value: string;
}

/** A question before difficulty is assigned. */
export type Candidate = Omit<Question, "difficulty">;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** Flag emoji from an ISO 3166-1 alpha-2 code, e.g. "FR" -> 🇫🇷. */
export function flagEmoji(alpha2: string | undefined): string | undefined {
  if (!alpha2 || alpha2.length !== 2) return undefined;
  const cc = alpha2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return undefined;
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Fame ranking -> obscurity in [0,1]; 0 = most famous (most sitelinks), 1 = most obscure. */
export function computeObscurity(countries: CountryMeta[]): Record<string, number> {
  const sorted = [...countries].sort((a, b) => (b.sitelinks ?? 0) - (a.sitelinks ?? 0));
  const out: Record<string, number> = {};
  sorted.forEach((c, i) => (out[c.iso] = sorted.length > 1 ? i / (sorted.length - 1) : 0));
  return out;
}

export function buildLocate(countries: CountryMeta[]): Candidate[] {
  return countries.map((c) => ({
    id: `locate-${c.iso}`,
    clueType: "locate",
    prompt: `Locate ${c.name}`,
    answerIso: c.iso,
    acceptedIso: [c.iso],
    source: "wikidata:name",
  }));
}

export function buildFlag(countries: CountryMeta[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of countries) {
    const emoji = flagEmoji(c.alpha2);
    if (!emoji) continue;
    out.push({
      id: `flag-${c.iso}`,
      clueType: "flag",
      prompt: "Which country has this flag?",
      emoji,
      answerIso: c.iso,
      acceptedIso: [c.iso],
      source: "flag-emoji",
    });
  }
  return out;
}

/**
 * Build questions from (iso, value) rows where the VALUE maps to exactly one allowed country.
 * A country may appear in several questions (e.g. South Africa's 3 capitals -> 3 questions); we only
 * reject a value that is shared by 2+ countries (ambiguous answer).
 */
export function buildUniqueValue(
  rows: ValueRow[],
  allowedIso: Set<string>,
  clueType: ClueType,
  prompt: (value: string) => string,
): Candidate[] {
  const byValue = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!allowedIso.has(r.iso)) continue;
    let set = byValue.get(r.value);
    if (!set) byValue.set(r.value, (set = new Set()));
    set.add(r.iso);
  }
  const out: Candidate[] = [];
  for (const [value, isos] of byValue) {
    if (isos.size !== 1) continue; // shared value -> ambiguous -> drop
    const iso = [...isos][0]!;
    out.push({
      id: `${clueType}-${slug(value)}-${iso}`,
      clueType,
      prompt: prompt(value),
      answerIso: iso,
      acceptedIso: [iso],
      source: `wikidata:${clueType}`,
    });
  }
  return out;
}

const CLUE_WEIGHT: Record<string, number> = {
  locate: 0,
  flag: 0.15,
  capital: 0.3,
  currency: 0.45,
  language: 0.45,
};

/** Assign easy/medium/hard by combining country obscurity with clue difficulty, split into terciles. */
export function assignDifficulty(cands: Candidate[], obscurity: Record<string, number>): Question[] {
  const scored = cands.map((c) => ({
    c,
    h: (obscurity[c.answerIso] ?? 0.5) * 0.85 + (CLUE_WEIGHT[c.clueType] ?? 0.4),
  }));
  scored.sort((a, b) => a.h - b.h);
  const n = scored.length;
  const t = Math.floor(n / 3);
  return scored.map((s, i) => {
    const difficulty: Difficulty = i < t ? "easy" : i < 2 * t ? "medium" : "hard";
    return { ...s.c, difficulty };
  });
}

// --- deterministic shuffle so re-running produces a stable calendar (nice diffs) ---
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

function parseKey(k: string): Date {
  const [y, m, d] = k.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
function fmtKey(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/**
 * Assemble a daily calendar: each day = 1 easy + 1 medium + 1 hard. No question is ever reused, no
 * country repeats within `windowDays`, and the 3 questions in a day are all different countries.
 * Stops when any tier runs dry (never silently repeats).
 */
export function assembleCalendar(
  pool: Question[],
  startDateKey: string,
  maxDays = 400,
  windowDays = 45,
): PuzzleCalendar {
  const byDiff: Record<Difficulty, Question[]> = { easy: [], medium: [], hard: [] };
  for (const q of pool) byDiff[q.difficulty].push(q);
  const rng = mulberry32(42);
  for (const d of ["easy", "medium", "hard"] as const) shuffle(byDiff[d], rng);

  const usedQ = new Set<string>();
  const recent: { iso: string; day: number }[] = [];
  const isRecent = (iso: string, day: number) => recent.some((r) => r.iso === iso && day - r.day < windowDays);
  const pick = (arr: Question[], banToday: Set<string>, day: number): Question | null => {
    for (const q of arr) if (!usedQ.has(q.id) && !banToday.has(q.answerIso) && !isRecent(q.answerIso, day)) return q;
    for (const q of arr) if (!usedQ.has(q.id) && !banToday.has(q.answerIso)) return q; // relax window
    return null;
  };

  const puzzles: DailyPuzzle[] = [];
  let dt = parseKey(startDateKey);
  for (let day = 0; day < maxDays; day++) {
    const banToday = new Set<string>();
    const picks: Question[] = [];
    for (const diff of ["easy", "medium", "hard"] as const) {
      const q = pick(byDiff[diff], banToday, day);
      if (!q) break;
      picks.push(q);
      usedQ.add(q.id);
      banToday.add(q.answerIso);
      recent.push({ iso: q.answerIso, day });
    }
    if (picks.length < 3) break; // a tier ran dry
    puzzles.push({ date: fmtKey(dt), questions: [picks[0]!, picks[1]!, picks[2]!] });
    dt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1);
  }
  return { version: 1, puzzles };
}
