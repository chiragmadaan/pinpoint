// Core domain types shared by every surface (Playable, web, content-gen).

/** ISO 3166-1 alpha-3 country code, e.g. "FRA", "IND". Our single country identifier everywhere. */
export type Iso3 = string;

export type Difficulty = "easy" | "medium" | "hard";

/**
 * The kind of clue. Drives (a) how content-gen builds the question from Wikidata and
 * (b) UI behavior — notably whether the Guess button may show the selected country name.
 */
export type ClueType =
  // --- Geography (mostly static facts) ---
  | "locate" // "Locate France"  -> answer IS the named country
  | "capital" // "Country whose capital is Paris"
  | "flag" // "Country whose flag is <img>"
  | "river-mouth" // "Country where the Ganga meets the ocean"
  | "birthplace" // "Country where <figure> was born"
  | "deathplace" // "Country where <figure> died"
  | "nationality" // "Which country is <figure> from?" (single citizenship; the easy association)
  | "currency"
  | "language"
  | "landmark" // "In which country is <landmark>?"
  | "dish" // "Which country did <dish> originate in?"
  | "border" // "Country bordering both X and Y"
  | "outline" // "Which country has this outline?"
  | "calling-code" // "Which country's dialling code is +81?"
  | "tld" // "Which country uses the internet domain .jp?"
  | "highest-point" // "Kilimanjaro is the highest point of which country?"
  // --- General knowledge (Pinpoint = GK + geography; makes the question space ~infinite) ---
  | "anthem" // "Country whose national anthem starts with 'God'"
  | "nickname" // "Country once known as the 'Pirate Republic'"
  | "superlative" // "Country with the most glaciers" / "highest Muslim population" (TIME-SENSITIVE)
  | "trivia"; // catch-all curated GK fact tied to a country

export interface Question {
  id: string;
  clueType: ClueType;
  difficulty: Difficulty;
  /** The clue text shown to the player. */
  prompt: string;
  /** Optional media (outline etc.). MUST be public-domain / CC — never scraped photos. */
  imageUrl?: string;
  /** Optional large glyph shown as the clue — e.g. a flag emoji 🇫🇷 for flag questions. */
  emoji?: string;
  /** The canonical correct country. */
  answerIso: Iso3;
  /**
   * All countries accepted as fully correct. Usually [answerIso], but a defensible-ambiguity
   * clue may accept several (e.g. Ganga delta -> ["IND", "BGD"]). Content-gen must populate this.
   */
  acceptedIso: Iso3[];
  /** Provenance for auditing/regeneration (e.g. Wikidata Q-ids used). */
  source?: string;
  /**
   * True for facts that can change over time ("most X", "highest Y"). Time-sensitive questions
   * MUST carry `asOf` and be periodically re-validated before reuse; static facts (capital, river)
   * do not. See design doc §2.
   */
  timeSensitive?: boolean;
  /** ISO date the fact was verified — required when timeSensitive is true. */
  asOf?: string;
}

/** One day's puzzle: three questions in an easy -> medium -> hard arc, plus an optional bonus. */
export interface DailyPuzzle {
  /** Local calendar day, "YYYY-MM-DD". Defines the shared global daily. */
  date: string;
  questions: [Question, Question, Question];
  /** 4th "bonus" question (obscure/hard), unlocked only when all 3 are answered correctly. */
  bonus?: Question;
}

/** The pre-generated static calendar shipped as data/questions.json. */
export interface PuzzleCalendar {
  version: number;
  puzzles: DailyPuzzle[];
}

export type Verdict = "correct" | "neighbor" | "wrong";

export interface GuessResult {
  verdict: Verdict;
  points: number;
  /** The country the player picked. */
  guessIso: Iso3;
  /** The canonical correct country (for reveal UI). */
  correctIso: Iso3;
}

/** Locally-persisted player progress. No PII — safe for localStorage / YouTube-managed save. */
export interface PlayerState {
  xp: number;
  streak: number;
  /** UTC date "YYYY-MM-DD" of the last completed daily; used for streak continuity. */
  lastPlayed: string | null;
  /** Per-day results, keyed by date -> the 3 verdicts, so a finished day isn't replayable. */
  history: Record<string, Verdict[]>;
}
