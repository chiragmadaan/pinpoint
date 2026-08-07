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
  /** Optional one-liner about the subject, shown on the reveal (see Question.fact). */
  fact?: string;
  /** Exact English Wikipedia article title (from the Wikidata sitelink). Differs from the label
   *  whenever the label is ambiguous ("Kan" -> "Kan (river)"); used for the fact lookup. */
  article?: string;
}

/** A question before difficulty is assigned. `hardness` (0=easy..1=hard) overrides the default
 * obscurity+clue-weight scoring when set. `sitelinks` gates the easy tier for person questions
 * (pageviews overrate athletes; sitelinks = encyclopedic-household-name check). Both are transient
 * (stripped before the question ships). */
export type Candidate = Omit<Question, "difficulty"> & {
  hardness?: number;
  sitelinks?: number;
  /** The thing the clue is about (person/river/brand/...). Kept through assembly so the reveal fact
   *  can be enriched from Wikipedia for only the questions that actually made the calendar, then
   *  stripped before write. Absent for country-attribute clues, whose subject IS the answer. */
  subject?: string;
  /** Wikipedia article title to look the fact up under; falls back to `subject`. Transient. */
  article?: string;
  /** Route this single question to the bonus pool regardless of its clue type (see PlaceLeak). */
  bonusOnly?: boolean;
};

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

/**
 * Does the clue name a well-known place inside its own answer country? `leaksCountryName` only
 * catches the country's own name, so "Tokyo International Film Festival" -> Japan sailed through:
 * the question degrades to "where is Tokyo?". Festivals and clubs are usually named after the city
 * that hosts them, so this is structural rather than incidental.
 *
 * Short names are ignored (a 3-letter city would match inside unrelated words), and the caller
 * decides which clue types to run this on — for `capital`/`locate`, naming the place IS the question.
 */
export function matchedPlaceName(text: string, places: string[]): string | null {
  const t = text.toLowerCase();
  let best: string | null = null;
  for (const place of places) {
    const p = place.toLowerCase();
    if (p.length < 4 || !t.includes(p)) continue;
    if (!new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) continue;
    if (!best || place.length > best.length) best = place; // prefer the most specific match
  }
  return best;
}

export function leaksPlaceName(text: string, places: string[]): boolean {
  return matchedPlaceName(text, places) !== null;
}

/**
 * Is a place name so close to its country's name that mentioning it hands over the answer?
 * "Casbah of Algiers" -> Algeria was slipping through: `leaksCountryName` needs a 4-character common
 * prefix and algiers/algeria share only 3 (they diverge at position 4), while the place filter rated
 * Algiers a mere partial hint on 522k views/yr. Together that shipped a HARD question with the
 * answer nearly spelled out in it.
 *
 * A 3-character prefix would be far too loose in general — chile/china also share 3 — but this is
 * only ever asked about a place we already know is INSIDE that country, and Chile is not in China.
 * That containment is what makes the looser threshold safe.
 */
export function resemblesCountryName(place: string, countryName: string): boolean {
  const p = place.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
  const c = countryName.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
  for (const pw of p) {
    for (const cw of c) {
      if (pw.length >= 4 && cw.length >= 4 && commonPrefixLen(pw, cw) >= 3) return true;
    }
  }
  return false;
}

/**
 * Collapse a language label to its base so regional/standard variants group together: "British
 * English" & "American English" -> "English", "Standard Chinese"/"Mandarin Chinese" -> "Chinese",
 * "Modern Standard Arabic" -> "Arabic". Feeding this to buildUniqueValue makes a language official
 * in more than one country resolve as shared and get dropped — so we never ask "British English is
 * an official language of which country? -> Brunei" when a player would reasonably answer the UK.
 */
export function canonicalizeLanguage(label: string): string {
  const qualifier = /^(british|american|standard|modern|classical|literary|swiss|austrian|brazilian|european|castilian|mandarin|written|spoken|old|middle)\s+/i;
  let s = label.trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(qualifier, "");
  }
  // Synonyms that prefix-stripping alone can't merge (Wikidata labels China's official language
  // "Putonghua" but Singapore's "Standard Chinese" -> both must collapse so "Chinese" is dropped).
  const synonyms: Record<string, string> = { putonghua: "Chinese", mandarin: "Chinese", cantonese: "Chinese" };
  return synonyms[s.toLowerCase()] ?? s;
}

/**
 * Wikidata descriptions that carry no information for a player. Wikidata descriptions are
 * DISAMBIGUATORS, not facts, so most of the geographic/taxonomic ones are either contentless
 * ("species of mammal") or merely restate the answer we just revealed ("river in Russia"). Those
 * are rejected here; the Wikipedia opening sentence (see summaries.ts) is the real fact source and
 * this is only the fallback.
 */
const USELESS_DESC =
  /^(human|wikimedia (list|disambiguation)|country|sovereign state|taxon|scientific article|given name|family name|surname|species|subspecies|genus|family|breed|variety)\b/i;
/** ...and descriptions that are just "<kind> in <place>" — they name the answer instead of teaching. */
const RESTATES_ANSWER =
  /^(river|city|town|village|municipality|commune|mountain|lake|island|province|region|district|state|county|settlement|human settlement|capital|dish|food|drink|festival|holiday|company|enterprise|business|band|song|album|film)\b.{0,30}\b(in|of|from)\b/i;

/**
 * Format the reveal one-liner: "<subject> — <description>." Returns undefined when the description
 * is missing or contentless, so the UI simply shows no fact rather than something useless.
 */
export function formatFact(subject: string, desc: string | undefined): string | undefined {
  const d = (desc ?? "").trim().replace(/\s+/g, " ");
  if (d.length < 12 || d.length > 160) return undefined;
  if (USELESS_DESC.test(d) || RESTATES_ANSWER.test(d)) return undefined;
  const body = d.charAt(0).toUpperCase() + d.slice(1);
  // Subjects are often lowercase common nouns (genres, currencies: "bachata", "balboa").
  const head = subject.charAt(0).toUpperCase() + subject.slice(1);
  return `${head} — ${body}${/[.!?]$/.test(body) ? "" : "."}`;
}

/**
 * Capitalise the first letter of a prompt. Some subjects are lowercase common nouns and lead their
 * template ("haori is traditional dress in which country?"), which then starts mid-sentence. Only
 * the first character is touched — "the music genre bachata" must stay lowercase mid-sentence,
 * since those genuinely are common nouns.
 */
export function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Flag emoji from an ISO 3166-1 alpha-2 code, e.g. "FR" -> 🇫🇷. */
export function flagEmoji(alpha2: string | undefined): string | undefined {
  if (!alpha2 || alpha2.length !== 2) return undefined;
  const cc = alpha2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return undefined;
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * Recognizability from Wikipedia pageviews, log-normalized to [0,1] between a floor and ceiling.
 * Pageviews span orders of magnitude (20K–18M), so we use log10. 0 = at/below floor, 1 = at/above ceil.
 */
export function pvFame(views: number, floor: number, ceil: number): number {
  const lp = Math.log10(Math.max(1, views));
  return Math.min(1, Math.max(0, (lp - Math.log10(floor)) / (Math.log10(ceil) - Math.log10(floor))));
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
    subject: c.name, // reveal fact comes from the country's own article
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
      subject: `Flag of ${c.name}`, // Wikipedia has a per-country flag article
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
  /** Verdict for clues naming a place in their own answer country (see PlaceLeak). */
  placeLeak?: PlaceLeak,
): Candidate[] {
  const byValue = new Map<string, Set<string>>();
  const factByValue = new Map<string, string>();
  const articleByValue = new Map<string, string>();
  for (const r of rows) {
    if (!allowedIso.has(r.iso)) continue;
    let set = byValue.get(r.value);
    if (!set) byValue.set(r.value, (set = new Set()));
    set.add(r.iso);
    if (r.fact && !factByValue.has(r.value)) factByValue.set(r.value, r.fact);
    if (r.article && !articleByValue.has(r.value)) articleByValue.set(r.value, r.article);
  }
  const out: Candidate[] = [];
  for (const [value, isos] of byValue) {
    if (isos.size !== 1) continue; // shared value -> ambiguous -> drop
    const iso = [...isos][0]!;
    if (nameOf && leaksCountryName(value, nameOf(iso))) continue; // clue reveals the answer -> drop
    const leak = placeLeak?.(value, iso) ?? null;
    out.push({
      id: `${clueType}-${slug(value)}-${iso}`,
      clueType,
      prompt: sentenceCase(prompt(value)),
      answerIso: iso,
      acceptedIso: [iso],
      fact: formatFact(value, factByValue.get(value)),
      ...(leak === "easy" ? { hardness: 0.05 } : {}),
      ...(leak === "bonus" ? { bonusOnly: true } : {}),
      subject: value,
      article: articleByValue.get(value),
      source: `wikidata:${clueType}`,
    });
  }
  return out;
}

/**
 * Name the KIND of thing a clue is about, so the subject isn't mistaken for something else.
 *
 * "Which country is Alexa Internet from?" reads like a person — `brand` and `nationality` share that
 * exact template, so nothing distinguishes a company from a human. Naming the category fixes it
 * without hinting at the answer (the category comes from the clue type, not from the country).
 * Skipped when the name already says it ("Ford Motor Company" must not become "the company Ford
 * Motor Company").
 */
export function withCategory(category: string, name: string): string {
  const head = category.split(/\s+/).at(-1)!.toLowerCase(); // "music genre" -> "genre"
  // Match the whole word family from a stem, so irregular plurals count too: "dish" also matches
  // "dishes", "company" also matches "companies". The leading \b stops "sport" hitting "transport".
  const stem = head.replace(/y$/, "");
  return new RegExp(`\\b${stem}\\w*\\b`, "i").test(name) ? name : `the ${category} ${name}`;
}

/**
 * The kind of organism from a Wikidata taxon description ("species of bird" -> "bird"). Those
 * descriptions are useless as FACTS but are exactly right as a category label, which is what an
 * opaque name needs: "The bird Kagu ..." rather than "The Kagu ...".
 */
export function taxonKind(desc: string | undefined): string | null {
  const m = /^(?:species|genus|subspecies|breed) of ([a-z]+)/i.exec((desc ?? "").trim());
  if (!m) return null;
  const k = m[1]!.toLowerCase().replace(/s$/, ""); // "mammals" -> "mammal"
  return /^(bird|mammal|plant|reptile|fish|amphibian|insect|tree|flower)$/.test(k) ? k : null;
}

/**
 * Does this name leave the reader with nothing to hold onto? A single opaque word ("Zhizdra",
 * "Kagu") does; a descriptive multi-word name ("freshwater crocodile", "Hai River") already says
 * what it is, and prefixing those reads badly ("the reptile freshwater crocodile").
 */
export function needsQualifier(name: string): boolean {
  return !/\s/.test(name.trim());
}

/**
 * What to do with a clue that names a place inside its own answer country. How much the mention
 * gives away depends entirely on how famous the place is, so a blanket drop was wrong in both
 * directions — it deleted "Viña del Mar" (86K views/yr, a giveaway to nobody) while treating it the
 * same as "Tokyo" (2.5M).
 *   "easy"  - a household-name city; the question really just asks where that city is
 *   "keep"  - partly known; natural difficulty already reflects it
 *   "bonus" - obscure city: not difficulty but VARIANCE (locals answer instantly, everyone else
 *             cannot), and the optional bonus slot is where coin-flips belong
 */
export type PlaceLeak = (text: string, iso: string) => "easy" | "keep" | "bonus" | null;

/** Country names that read as "the X" in a sentence ("borders the Netherlands", not "borders Netherlands"). */
const NEEDS_ARTICLE = /^(United |Republic of|Democratic Republic|Central African|Netherlands|Philippines|Bahamas|Gambia|Maldives|Comoros|Seychelles|Czech Republic|Dominican Republic|Ivory Coast|Falkland|Marshall|Solomon|Isle of Man|Vatican)/;

/** Prefix "the" where English needs it, so generated prompts read naturally. */
export function withArticle(name: string): string {
  return NEEDS_ARTICLE.test(name) ? `the ${name}` : name;
}

/**
 * Border questions from the adjacency graph — the one clue type a player can REASON to rather than
 * recall ("borders both Spain and France" -> Andorra). Two shapes, both requiring a unique answer:
 *   - a neighbour PAIR that exactly one country touches
 *   - a country with exactly one neighbour ("the only country bordering X")
 * Needs no network: adjacency ships with the app.
 */
export function buildBorderQuestions(
  adjacency: Record<string, string[]>,
  allowedIso: Set<string>,
  nameOf: (iso: string) => string,
): Candidate[] {
  const out: Candidate[] = [];
  const byPair = new Map<string, string[]>();
  for (const [iso, neighbours] of Object.entries(adjacency)) {
    const ns = [...new Set(neighbours)].sort();
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const key = `${ns[i]}|${ns[j]}`;
        let owners = byPair.get(key);
        if (!owners) byPair.set(key, (owners = []));
        owners.push(iso);
      }
    }
  }
  for (const [key, owners] of byPair) {
    if (owners.length !== 1) continue; // several countries touch this pair -> ambiguous
    const iso = owners[0]!;
    const [a, b] = key.split("|") as [string, string];
    // Both neighbours must be real, named, answerable countries — and never name the answer itself.
    if (!allowedIso.has(iso) || !allowedIso.has(a) || !allowedIso.has(b)) continue;
    const [na, nb] = [nameOf(a), nameOf(b)];
    if (!na || !nb || na === a || nb === b) continue; // no display name -> skip
    if (leaksCountryName(`${na} ${nb}`, nameOf(iso))) continue; // e.g. "Congo" pair naming the answer
    out.push({
      id: `border-${a}-${b}-${iso}`,
      clueType: "border",
      prompt: `Which country borders both ${withArticle(na)} and ${withArticle(nb)}?`,
      answerIso: iso,
      acceptedIso: [iso],
      subject: nameOf(iso),
      source: "adjacency:pair",
    });
  }
  // "Only country bordering X" — unique when X has exactly one land neighbour.
  for (const [iso, neighbours] of Object.entries(adjacency)) {
    const ns = [...new Set(neighbours)];
    if (ns.length !== 1) continue;
    const only = ns[0]!;
    if (!allowedIso.has(iso) || !allowedIso.has(only)) continue;
    const name = nameOf(iso);
    if (!name || name === iso) continue;
    if (leaksCountryName(name, nameOf(only))) continue; // clue names the answer -> drop
    out.push({
      id: `border-only-${iso}-${only}`,
      clueType: "border",
      prompt: `Which is the only country that shares a land border with ${withArticle(name)}?`,
      answerIso: only,
      acceptedIso: [only],
      subject: nameOf(only),
      source: "adjacency:sole",
    });
  }
  return out;
}

/**
 * Globally recognizable countries — the ONLY ones allowed in the "easy" slot for country-attribute
 * clues (locate/flag/capital). No auto metric identifies these (sitelinks/pageviews are compressed;
 * population makes populous-but-obscure nations look easy), so this is a curated list. Edit freely.
 */
export const EASY_COUNTRIES = new Set<string>([
  "USA", "CAN", "MEX", "BRA", "ARG", "GBR", "IRL", "FRA", "DEU", "ITA", "ESP", "PRT", "NLD", "BEL",
  "CHE", "AUT", "SWE", "NOR", "DNK", "FIN", "POL", "GRC", "RUS", "UKR", "TUR", "EGY", "ZAF", "NGA",
  "KEN", "MAR", "SAU", "ARE", "ISR", "IRN", "IND", "PAK", "CHN", "JPN", "KOR", "THA", "VNM", "IDN",
  "PHL", "AUS", "NZL",
]);

/** Clue types whose "easy" tier is gated by EASY_COUNTRIES (must resolve to a recognizable country).
 * Includes "nationality" ("which country is X from?") — famous person, but the answer country must
 * still be recognizable to be easy. */
const COUNTRY_ATTR = new Set(["locate", "flag", "capital", "nationality"]);

/** A person question is "easy" only if the person is this encyclopedically documented. Pageviews
 * overrate athletes (fan traffic); sitelinks track household-name status (icons ~280+). */
const EASY_PERSON_SITELINKS = 120;

const CLUE_WEIGHT: Record<string, number> = {
  locate: 0,
  flag: 0.15,
  capital: 0.3,
  tld: 0.35,
  "calling-code": 0.45,
  currency: 0.45,
  language: 0.45,
  "highest-point": 0.55,
  // Deducible from the map rather than recalled, so easier than its obscurity implies.
  border: 0.25,
  anthem: 0.7, // recognizing an anthem by title is hard -> bonus-tier
};

/**
 * Person questions: "In which country was/did <person> born/die?". Difficulty comes from the
 * person's fame (Wikipedia sitelink count) — a household name is easy, an obscure figure is hard.
 */
export interface PersonEntry {
  iso: string;
  person: string;
  views: number; // annual en.wikipedia pageviews (recognizability + difficulty)
  sitelinks?: number; // Wikipedia language count — gates the easy tier (athletes score low here)
  fact?: string; // raw Wikidata description, formatted into Question.fact on the reveal
  article?: string; // exact enwiki article title (labels are often ambiguous)
  /** Category word shown before the name in the PROMPT only ("bird" -> "The bird Kagu ..."). Kept
   *  out of the id/subject so ids stay stable and fact lookups still use the clean name. */
  qualifier?: string;
}

export function buildPeopleQuestions(
  entries: PersonEntry[],
  clueType: ClueType,
  prompt: (person: string) => string,
  nameOf?: (iso: string) => string,
  floor = 150_000, // below this many annual pageviews -> too obscure, dropped
  ceil = 5_000_000, // at/above this -> maximally famous (easy)
  /** Verdict for clues naming a place in their own answer country (see PlaceLeak). */
  placeLeak?: PlaceLeak,
): Candidate[] {
  // Reject a name shared by people from different countries (ambiguous answer).
  const isosByName = new Map<string, Set<string>>();
  const best = new Map<string, PersonEntry>(); // keep the most-recognized entry per name
  for (const e of entries) {
    if (e.views < floor) continue; // not recognizable enough for a fair question
    let set = isosByName.get(e.person);
    if (!set) isosByName.set(e.person, (set = new Set()));
    set.add(e.iso);
    const b = best.get(e.person);
    if (!b || e.views > b.views) best.set(e.person, e);
  }

  const out: Candidate[] = [];
  for (const [person, isos] of isosByName) {
    if (isos.size !== 1) continue; // same name, different countries -> drop
    if (/^Q\d+$/.test(person)) continue; // no English label available
    const e = best.get(person)!;
    if (nameOf && leaksCountryName(person, nameOf(e.iso))) continue;
    const leak = placeLeak?.(person, e.iso) ?? null;
    const fame = pvFame(e.views, floor, ceil); // recognizability from pageviews
    out.push({
      id: `${clueType}-${slug(person)}-${e.iso}`,
      clueType,
      prompt: sentenceCase(prompt(e.qualifier ? `${e.qualifier} ${person}` : person)),
      answerIso: e.iso,
      acceptedIso: [e.iso],
      fact: formatFact(person, e.fact),
      subject: person,
      article: e.article,
      source: `wikidata:${clueType}`,
      hardness: leak === "easy" ? 0.05 : Math.max(0.1, 1 - fame * 0.85), // famous -> easy, obscure -> hard
      ...(leak === "bonus" ? { bonusOnly: true } : {}),
      sitelinks: e.sitelinks, // carried for the easy-tier gate
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
    // "Easy" locate/flag/capital only for genuinely recognizable countries (curated) — no metric
    // reliably identifies these, so a populous-but-obscure country must not slip into easy.
    if (COUNTRY_ATTR.has(s.c.clueType) && difficulty === "easy" && !EASY_COUNTRIES.has(s.c.answerIso)) {
      difficulty = "medium";
    }
    // Person questions can be "easy" only for encyclopedically-documented people (not high-traffic
    // athletes). Birthplace is already never-easy; this gates nationality's easy tier.
    if (s.c.clueType === "nationality" && difficulty === "easy" && (s.c.sitelinks ?? 0) < EASY_PERSON_SITELINKS) {
      difficulty = "medium";
    }
    const { hardness: _drop, sitelinks: _sl, ...rest } = s.c;
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
 * Category for the per-day "one question per kind" rule. Person-based clues (birthplace, nationality,
 * deathplace) all read as "which country is this person from", so they count as ONE kind — a day
 * never gets two of them. Every other clue type is its own kind. (The rule applies to the main 3;
 * the bonus is exempt.)
 */
export function clueCategory(clueType: ClueType): string {
  if (clueType === "birthplace" || clueType === "nationality" || clueType === "deathplace") return "person";
  return clueType;
}

/**
 * Assemble a daily calendar: each day = 1 easy + 1 medium + 1 hard. No question is ever reused, no
 * country repeats within `windowDays`, and the 3 questions in a day are all different countries.
 * Categories: distinct is preferred, at most one person question, and no category three times (see
 * clueCategory). Stops when any tier runs dry (never silently repeats).
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
  for (const d of ["easy", "medium", "hard"] as const) {
    shuffle(byDiff[d], rng);
    // Hand-written questions are a fraction of a percent of the pool but carry the facts worth
    // remembering ("the only non-rectangular national flag"), and each one was verified by hand.
    // Picking is first-match over a shuffled tier, so without this they compete on equal terms with
    // thousands of generated questions and simply lose: 9 of 40 missed the calendar entirely.
    // Stable partition keeps the shuffle's ordering within each group.
    const curated = byDiff[d].filter((q) => q.source?.startsWith("curated"));
    if (curated.length) {
      byDiff[d] = [...curated, ...byDiff[d].filter((q) => !q.source?.startsWith("curated"))];
    }
  }
  const bonuses = [...bonusPool];
  shuffle(bonuses, rng);

  const usedQ = new Set<string>();
  const recent: { iso: string; day: number }[] = []; // country recency
  const typeCount: Record<string, number> = {};
  const maxPerType = Math.ceil(maxDays * 3 * typeCap);
  const isRecent = (iso: string, day: number) => recent.some((r) => r.iso === iso && day - r.day < windowDays);

  const isPerson = (q: Question) => clueCategory(q.clueType) === "person";
  const isCurated = (q: Question) => q.source?.startsWith("curated") ?? false;
  const diffs = ["easy", "medium", "hard"] as const;
  type Diff = (typeof diffs)[number];

  // Pick a question of the wanted person-ness from a tier, honoring every per-day + global constraint,
  // WITHOUT committing (so a day can try several person placements). Progressive relaxation: fresh
  // category + under cap + fresh country, then drop constraints one at a time. Prefer three distinct
  // categories; allow a second of a non-person category before giving up (never two person / three of
  // one). Shuffle order (not a window) supplies variety.
  const pickTyped = (
    arr: Question[],
    wantPerson: boolean,
    banIso: Set<string>,
    catCount: Record<string, number>,
    usedToday: Set<string>,
    day: number,
  ): Question | null => {
    const ok = (q: Question) =>
      isPerson(q) === wantPerson && !usedQ.has(q.id) && !usedToday.has(q.id) && !banIso.has(q.answerIso);
    const cat = (q: Question) => clueCategory(q.clueType);
    const freshCat = (q: Question) => (catCount[cat(q)] ?? 0) === 0;
    const canRepeat = (q: Question) => (catCount[cat(q)] ?? 0) < (cat(q) === "person" ? 1 : 2);
    const underCap = (q: Question) => (typeCount[q.clueType] ?? 0) < maxPerType;
    return (
      // Curated questions skip the country-recency window and the type cap. They are a fraction of
      // a percent of the pool, individually verified, and carry the facts worth remembering — losing
      // one because France came up three weeks ago is a bad trade. Heavy repetition of a popular
      // country is acceptable; missing hand-written content is not.
      arr.find((q) => ok(q) && freshCat(q) && isCurated(q)) ??
      arr.find((q) => ok(q) && freshCat(q) && underCap(q) && !isRecent(q.answerIso, day)) ??
      arr.find((q) => ok(q) && freshCat(q) && underCap(q)) ??
      arr.find((q) => ok(q) && freshCat(q)) ??
      arr.find((q) => ok(q) && canRepeat(q) && underCap(q)) ??
      arr.find((q) => ok(q) && canRepeat(q)) ??
      null
    );
  };

  // Try to fill a day: `personTier` gets a person question, the other tiers get non-person (null =
  // a no-person day). Returns the three picks or null — no commit, so callers can try alternatives.
  const tryDay = (personTier: Diff | null, day: number): Record<Diff, Question> | null => {
    const banIso = new Set<string>();
    const catCount: Record<string, number> = {};
    const usedToday = new Set<string>();
    const picks = {} as Record<Diff, Question>;
    for (const diff of diffs) {
      const q = pickTyped(byDiff[diff], diff === personTier, banIso, catCount, usedToday, day);
      if (!q) return null;
      picks[diff] = q;
      banIso.add(q.answerIso);
      catCount[clueCategory(q.clueType)] = (catCount[clueCategory(q.clueType)] ?? 0) + 1;
      usedToday.add(q.id);
    }
    return picks;
  };

  // Remaining unused non-person questions in a tier — the resource that bounds the calendar.
  const nonPersonLeft = (arr: Question[]) =>
    arr.reduce((n, q) => n + (!usedQ.has(q.id) && !isPerson(q) ? 1 : 0), 0);

  const puzzles: DailyPuzzle[] = [];
  let dt = parseKey(startDateKey);
  for (let day = 0; day < maxDays; day++) {
    // ROTATE which slot (if any) spends the day's one person question — including person-FREE days.
    // Always sending it to the scarcest tier maximised calendar length but made the hard slot a
    // "where was X born?" on 72% of days (138 in a row); rotation trades a little length for variety.
    // Fallbacks are ordered by scarcest-non-person-first, so a day is still never left unfilled.
    const rotation: (Diff | null)[] = [null, "easy", "medium", "hard"];
    const preferred = rotation[day % rotation.length]!;
    const fallbacks = rotation
      .filter((o) => o !== preferred)
      .sort((a, b) => {
        if (a === null) return 1; // a person-free day burns three non-person questions -> try last
        if (b === null) return -1;
        return nonPersonLeft(byDiff[a]) - nonPersonLeft(byDiff[b]);
      });
    let picks: Record<Diff, Question> | null = null;
    for (const pt of [preferred, ...fallbacks]) {
      picks = tryDay(pt, day);
      if (picks) break;
    }
    if (!picks) break; // no fillable arrangement -> calendar ends

    for (const diff of diffs) {
      const q = picks[diff];
      usedQ.add(q.id);
      typeCount[q.clueType] = (typeCount[q.clueType] ?? 0) + 1;
      recent.push({ iso: q.answerIso, day });
    }
    const dayIsos = new Set(diffs.map((d) => picks![d].answerIso));
    const bonus = bonuses.find((b) => !usedQ.has(b.id) && !dayIsos.has(b.answerIso));
    const day3: DailyPuzzle = { date: fmtKey(dt), questions: [picks.easy, picks.medium, picks.hard] };
    if (bonus) {
      usedQ.add(bonus.id);
      day3.bonus = bonus;
    }
    puzzles.push(day3);
    dt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1);
  }
  return { version: 1, puzzles };
}
