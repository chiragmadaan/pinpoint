// Orchestrator: fetch Wikidata -> build validated questions -> merge curated trivia ->
// assemble a no-repeat calendar -> write questions.json (data/ + apps/web/public/).
//
// Run:  pnpm content:gen                          (uses Node fetch)
//       PINPOINT_FETCH=curl pnpm content:gen      (sandboxes without Node sockets)

import { readFile, writeFile } from "node:fs/promises";
import type { PuzzleCalendar, Question } from "@pinpoint/core";
import {
  assembleCalendar,
  assignDifficulty,
  buildFlag,
  buildLocate,
  buildUniqueValue,
  computeObscurity,
  type CountryMeta,
} from "./build.ts";
import { sparql } from "./wikidata.ts";

const url = (p: string) => new URL(p, import.meta.url);

const Q_BASE = `
SELECT ?iso ?iso2 ?countryLabel ?sl ?pop WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso.
  OPTIONAL { ?country wdt:P297 ?iso2. }
  OPTIONAL { ?country wdt:P1082 ?pop. }
  ?country wikibase:sitelinks ?sl.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

const Q_CAPITAL = `
SELECT ?iso ?capitalLabel WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P36 ?capital.
  ?capital rdfs:label ?capitalLabel. FILTER(LANG(?capitalLabel) = "en")
}`;

const Q_CURRENCY = `
SELECT ?iso ?currencyLabel WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P38 ?cur.
  ?cur rdfs:label ?currencyLabel. FILTER(LANG(?currencyLabel) = "en")
}`;

const Q_LANGUAGE = `
SELECT ?iso ?languageLabel WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P37 ?lang.
  ?lang rdfs:label ?languageLabel. FILTER(LANG(?languageLabel) = "en")
}`;

async function mapIsoSet(): Promise<Set<string>> {
  const fc = JSON.parse(await readFile(url("../../../apps/web/public/countries.geo.json"), "utf8")) as {
    features: { id: string }[];
  };
  return new Set(fc.features.map((f) => f.id));
}

async function curatedTrivia(allowed: Set<string>): Promise<Question[]> {
  try {
    const raw = JSON.parse(await readFile(url("../../../data/trivia.curated.json"), "utf8")) as Question[];
    return raw.filter((q) => allowed.has(q.answerIso));
  } catch {
    return []; // optional file
  }
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main() {
  const allowed = await mapIsoSet();
  const [baseRows, capRows, curRows, langRows] = await Promise.all([
    sparql("base", Q_BASE),
    sparql("capital", Q_CAPITAL),
    sparql("currency", Q_CURRENCY),
    sparql("language", Q_LANGUAGE),
  ]);

  // De-dupe country meta to one record per ISO (that exists on our map).
  const metaMap = new Map<string, CountryMeta>();
  for (const r of baseRows) {
    if (!allowed.has(r.iso!)) continue;
    const ex = metaMap.get(r.iso!);
    if (!ex) {
      metaMap.set(r.iso!, {
        iso: r.iso!,
        name: r.countryLabel!,
        alpha2: r.iso2,
        sitelinks: Number(r.sl ?? 0),
        pop: r.pop ? Number(r.pop) : undefined,
      });
    } else if (!ex.alpha2 && r.iso2) {
      ex.alpha2 = r.iso2;
    }
  }
  const countries = [...metaMap.values()];
  const obscurity = computeObscurity(countries);

  const auto = [
    ...buildLocate(countries),
    ...buildFlag(countries),
    ...buildUniqueValue(
      capRows.map((r) => ({ iso: r.iso!, value: r.capitalLabel! })),
      allowed,
      "capital",
      (v) => `Which country's capital is ${v}?`,
    ),
    ...buildUniqueValue(
      curRows.map((r) => ({ iso: r.iso!, value: r.currencyLabel! })),
      allowed,
      "currency",
      (v) => `Which country's currency is the ${v}?`,
    ),
    ...buildUniqueValue(
      langRows.map((r) => ({ iso: r.iso!, value: r.languageLabel! })),
      allowed,
      "language",
      (v) => `${v} is an official language of which country?`,
    ),
  ];

  const autoQs = assignDifficulty(auto, obscurity);
  const curated = await curatedTrivia(allowed);
  const pool: Question[] = [...autoQs, ...curated];

  const calendar: PuzzleCalendar = assembleCalendar(pool, todayKey());

  await writeFile(url("../../../data/questions.json"), JSON.stringify(calendar));
  await writeFile(url("../../../apps/web/public/questions.json"), JSON.stringify(calendar));

  const byType: Record<string, number> = {};
  for (const q of pool) byType[q.clueType] = (byType[q.clueType] ?? 0) + 1;
  console.log(`Countries on map: ${countries.length}`);
  console.log(`Candidate questions: ${pool.length}`, byType);
  console.log(`Calendar: ${calendar.puzzles.length} days (from ${calendar.puzzles[0]?.date})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
