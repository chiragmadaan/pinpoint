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

/** A question before difficulty is assigned. `hardness` (0=easy..1=hard) overrides the default
 * obscurity+clue-weight scoring when set — used by fame-ranked person questions. */
export type Candidate = Omit<Question, "difficulty"> & { hardness?: number };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// Keep the daily light: drop any question whose text evokes tragedy/atrocity. Applied to every
// question (auto + curated). "war" is intentionally NOT here — historical wars are fair game;
// atrocities are the line.
export const SENSITIVE_TERMS = [
  "genocide", "massacre", "holocaust", "atrocity", "ethnic cleansing", "war crime", "terrorist",
  "terror attack", "assassinat", "slaughter", "famine", "disaster", "catastrophe",
  "nuclear accident", "bombing", "apartheid", "slavery", "execution",
];

export function isSensitiveText(text: string): boolean {
  const t = text.toLowerCase();
  return SENSITIVE_TERMS.some((w) => t.includes(w));
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Does a clue value leak the answer via the country's name/demonym? True if any word of the value
 * matches a name word, or shares a >=4-char prefix (catches "Estonian"~"Estonia",
 * "United Arab Emirates dirham"~UAE, "Kuwait City"~Kuwait).
 */
export function leaksCountryName(value: string, countryName: string): boolean {
  const valLower = value.toLowerCase();
  const nameWords = countryName.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  const valWords = valLower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const nw of nameWords) {
    if (valLower.includes(nw)) return true; // substring anywhere (e.g. "Kinyarwanda" contains "rwanda")
    for (const vw of valWords) {
      if (commonPrefixLen(vw, nw) >= 4) return true; // demonym prefix (e.g. "Estonian" ~ "Estonia")
    }
  }
  return false;
}

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
  nameOf?: (iso: string) => string,
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
    if (nameOf && leaksCountryName(value, nameOf(iso))) continue; // clue reveals the answer -> drop
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
  tld: 0.35,
  "calling-code": 0.45,
  currency: 0.45,
  language: 0.45,
  "highest-point": 0.55,
};

/**
 * Person questions: "In which country was/did <person> born/die?". Difficulty comes from the
 * person's fame (Wikipedia sitelink count) — a household name is easy, an obscure figure is hard.
 */
export interface PersonEntry {
  iso: string;
  person: string;
  sitelinks: number;
}

export function buildPeopleQuestions(
  entries: PersonEntry[],
  clueType: ClueType,
  prompt: (person: string) => string,
  nameOf?: (iso: string) => string,
  fameRange: { floor: number; ceil: number } = { floor: 0, ceil: 150 },
): Candidate[] {
  // Reject a name shared by people from different countries (ambiguous answer).
  const isosByName = new Map<string, Set<string>>();
  const best = new Map<string, PersonEntry>(); // keep the most-famous entry per name
  for (const e of entries) {
    let set = isosByName.get(e.person);
    if (!set) isosByName.set(e.person, (set = new Set()));
    set.add(e.iso);
    const b = best.get(e.person);
    if (!b || e.sitelinks > b.sitelinks) best.set(e.person, e);
  }

  const out: Candidate[] = [];
  for (const [person, isos] of isosByName) {
    if (isos.size !== 1) continue; // same name, different countries -> drop
    if (/^Q\d+$/.test(person)) continue; // no English label available
    const e = best.get(person)!;
    if (nameOf && leaksCountryName(person, nameOf(e.iso))) continue;
    // Map sitelinks -> fame in [0,1] over the given range (people use a high floor so only true
    // household names read as "easy"; landmarks/dishes use the default lower range).
    const fame = Math.min(1, Math.max(0, (e.sitelinks - fameRange.floor) / (fameRange.ceil - fameRange.floor)));
    out.push({
      id: `${clueType}-${slug(person)}-${e.iso}`,
      clueType,
      prompt: prompt(person),
      answerIso: e.iso,
      acceptedIso: [e.iso],
      source: `wikidata:${clueType}`,
      hardness: Math.max(0.1, 1 - fame * 0.85), // famous -> easy, obscure -> hard
    });
  }
  return out;
}

/**
 * Assign easy/medium/hard by ABSOLUTE hardness across the whole pool (global terciles), so "easy"
 * means genuinely easy for a casual player (famous country/person/flag/capital) — NOT "the easiest
 * of an inherently hard category". Inherently-hard clue types (highest-point, TLD, currency…) carry
 * a high clue-weight and therefore never fall into the easy tier. Hardness = fame override, else
 * country obscurity + clue weight. Daily *variety* is handled separately by the type-cap in
 * assembleCalendar, so we don't need per-type difficulty (which wrongly made obscure peaks "easy").
 */
export function assignDifficulty(cands: Candidate[], obscurity: Record<string, number>): Question[] {
  const scored = cands.map((c) => ({
    c,
    h: c.hardness ?? (obscurity[c.answerIso] ?? 0.5) * 0.85 + (CLUE_WEIGHT[c.clueType] ?? 0.4),
  }));
  scored.sort((a, b) => a.h - b.h);
  const n = scored.length;
  const t = Math.floor(n / 3);
  return scored.map((s, i) => {
    let difficulty: Difficulty = i < t ? "easy" : i < 2 * t ? "medium" : "hard";
    // A truly HARD question needs two failure points: derive the country from the clue AND locate it.
    // "Locate X" only tests location (one failure point), so it can never be hard — cap at medium.
    if (s.c.clueType === "locate" && difficulty === "hard") difficulty = "medium";
    // Birthplace is inherently ≥2 failure points (know the person AND derive their birth country,
    // which is often a gotcha), so it can never be "easy" — floor at medium.
    if (s.c.clueType === "birthplace" && difficulty === "easy") difficulty = "medium";
    const { hardness: _drop, ...rest } = s.c;
    return { ...rest, difficulty };
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
  typeCap = 0.28, // no clue type may exceed this share of all questions (prevents birthplace flooding)
  bonusPool: Question[] = [], // obscure "bonus" questions, one attached per day (unlocked on 3/3)
): PuzzleCalendar {
  const byDiff: Record<Difficulty, Question[]> = { easy: [], medium: [], hard: [] };
  for (const q of pool) byDiff[q.difficulty].push(q);
  const rng = mulberry32(42);
  for (const d of ["easy", "medium", "hard"] as const) shuffle(byDiff[d], rng);
  const bonuses = [...bonusPool];
  shuffle(bonuses, rng);

  const usedQ = new Set<string>();
  const recent: { iso: string; day: number }[] = []; // country recency
  const typeCount: Record<string, number> = {};
  const maxPerType = Math.ceil(maxDays * 3 * typeCap);
  const isRecent = (iso: string, day: number) => recent.some((r) => r.iso === iso && day - r.day < windowDays);

  // Progressive relaxation: distinct type today + under the type cap + fresh country, then drop
  // constraints one at a time so a slot is never left empty. Shuffle (not a window) supplies order,
  // so there's no periodic pattern.
  const pick = (arr: Question[], banIso: Set<string>, banType: Set<string>, day: number): Question | null => {
    const ok = (q: Question) => !usedQ.has(q.id) && !banIso.has(q.answerIso);
    const underCap = (q: Question) => (typeCount[q.clueType] ?? 0) < maxPerType;
    return (
      arr.find((q) => ok(q) && !banType.has(q.clueType) && underCap(q) && !isRecent(q.answerIso, day)) ??
      arr.find((q) => ok(q) && !banType.has(q.clueType) && underCap(q)) ??
      arr.find((q) => ok(q) && !banType.has(q.clueType)) ?? // distinct type today, drop cap + window
      arr.find((q) => ok(q)) ?? // last resort: any unused, new country today
      null
    );
  };

  const puzzles: DailyPuzzle[] = [];
  let dt = parseKey(startDateKey);
  for (let day = 0; day < maxDays; day++) {
    const banIso = new Set<string>();
    const banType = new Set<string>();
    const picks: Question[] = [];
    for (const diff of ["easy", "medium", "hard"] as const) {
      const q = pick(byDiff[diff], banIso, banType, day);
      if (!q) break;
      picks.push(q);
      usedQ.add(q.id);
      banIso.add(q.answerIso);
      banType.add(q.clueType);
      typeCount[q.clueType] = (typeCount[q.clueType] ?? 0) + 1;
      recent.push({ iso: q.answerIso, day });
    }
    if (picks.length < 3) break; // a tier ran dry
    // Attach a bonus question: unused, and a different country from the day's three.
    const bonus = bonuses.find((b) => !usedQ.has(b.id) && !banIso.has(b.answerIso));
    const day3: DailyPuzzle = { date: fmtKey(dt), questions: [picks[0]!, picks[1]!, picks[2]!] };
    if (bonus) {
      usedQ.add(bonus.id);
      day3.bonus = bonus;
    }
    puzzles.push(day3);
    dt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1);
  }
  return { version: 1, puzzles };
}
