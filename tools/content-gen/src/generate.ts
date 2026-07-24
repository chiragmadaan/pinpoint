// Offline content generator: Wikidata SPARQL -> candidate questions -> validated -> daily calendar.
// Run locally (`pnpm content:gen`); it writes data/questions.json. No server, no runtime cost.
//
// THE HARD PART IS VALIDATION, NOT GENERATION. A question is only usable if it has exactly one
// defensible answer (or a small, explicit accepted set). Ambiguity is the #1 quality killer:
//   - rivers that border/cross multiple countries (Danube), deltas spanning two countries (Ganga)
//   - people whose birthplace's country changed over time
//   - capitals/currencies shared by multiple countries
// The pipeline below MUST drop or hand-curate anything with >1 country unless we set acceptedIso.

import { writeFile } from "node:fs/promises";
import type { Difficulty, Question, PuzzleCalendar } from "@pinpoint/core";

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

interface Row {
  countryIso: string;
  countryLabel: string;
  value: string; // capital / river / person / etc.
}

async function sparql(query: string): Promise<Row[]> {
  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "geo-quiz-content-gen/0.0 (contact@example.com)", Accept: "application/sparql-results+json" },
  });
  if (!res.ok) throw new Error(`Wikidata ${res.status}`);
  const json = (await res.json()) as { results: { bindings: Record<string, { value: string }>[] } };
  return json.results.bindings.map((b) => ({
    countryIso: b.iso?.value ?? "",
    countryLabel: b.countryLabel?.value ?? "",
    value: b.value?.value ?? "",
  }));
}

// Example: capital-of clues. Grouping by capital lets us REJECT capitals shared by >1 country.
const CAPITAL_QUERY = `
SELECT ?iso ?countryLabel ?value WHERE {
  ?country wdt:P31 wd:Q6256 ;        # instance of: country
           wdt:P298 ?iso ;           # ISO 3166-1 alpha-3
           wdt:P36 ?capital .        # capital
  ?capital rdfs:label ?value . FILTER(LANG(?value) = "en")
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

function buildCapitalQuestions(rows: Row[]): Question[] {
  const byCapital = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.countryIso || !r.value) continue;
    (byCapital.get(r.value) ?? byCapital.set(r.value, []).get(r.value)!).push(r);
  }
  const out: Question[] = [];
  for (const [capital, group] of byCapital) {
    if (group.length !== 1) continue; // AMBIGUOUS -> drop
    const r = group[0]!;
    out.push({
      id: `capital-${r.countryIso}`,
      clueType: "capital",
      difficulty: "medium",
      prompt: `Which country's capital is ${capital}?`,
      answerIso: r.countryIso,
      acceptedIso: [r.countryIso],
      source: "wikidata:P36",
    });
  }
  return out;
}

// TODO: add builders for locate/flag/river-mouth/birthplace with the same "reject ambiguous" rule.
// TODO GK clue types (Pinpoint = GK + geography). Each still needs a reliable source + validation:
//   - anthem:      "Country whose national anthem starts with 'God'"           (static)
//   - nickname:    "Country once known as the 'Pirate Republic'" -> BHS         (static, curated)
//   - superlative: "Country with the most glaciers / highest Muslim population" (TIME-SENSITIVE!)
//        -> MUST set timeSensitive:true + asOf, and be re-validated before reuse.
// TODO: difficulty ranking via population / Wikipedia pageviews to calibrate the daily arc.

/** MVP rule: ship ONLY single-answer questions. Multi-answer (e.g. Ganga delta) is full-product. */
function mvpSingleAnswerOnly(pool: Question[]): Question[] {
  return pool.filter((q) => q.acceptedIso.length === 1);
}

function assembleCalendar(pool: Question[], days: number, startDate: string): PuzzleCalendar {
  const byDiff: Record<Difficulty, Question[]> = { easy: [], medium: [], hard: [] };
  for (const q of pool) byDiff[q.difficulty].push(q);
  const puzzles: PuzzleCalendar["puzzles"] = [];
  const d = new Date(startDate + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    const pick = (arr: Question[]) => arr[i % Math.max(1, arr.length)];
    const e = pick(byDiff.easy), m = pick(byDiff.medium), h = pick(byDiff.hard);
    if (!e || !m || !h) break; // ran out of a difficulty band
    puzzles.push({ date: d.toISOString().slice(0, 10), questions: [e, m, h] });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { version: 1, puzzles };
}

async function main() {
  const capitals = buildCapitalQuestions(await sparql(CAPITAL_QUERY));
  // NOTE: needs easy + hard pools too before it can assemble real days; capitals are medium.
  const pool = mvpSingleAnswerOnly([...capitals]);
  const calendar = assembleCalendar(pool, 365, "2026-08-01");
  await writeFile(new URL("../../../data/questions.json", import.meta.url), JSON.stringify(calendar, null, 2));
  console.log(`Wrote ${calendar.puzzles.length} daily puzzles from ${pool.length} candidate questions.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
