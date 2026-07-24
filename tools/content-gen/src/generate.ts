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
  buildPeopleQuestions,
  buildUniqueValue,
  computeObscurity,
  isSensitiveText,
  type CountryMeta,
  type PersonEntry,
} from "./build.ts";
import { sparql } from "./wikidata.ts";

const url = (p: string) => new URL(p, import.meta.url);

/** Run async fn over items with limited concurrency (be polite to WDQS). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!, i);
      }
    }),
  );
  return results;
}

const Q_BASE = `
SELECT ?iso ?iso2 ?countryLabel ?sl ?pop ?country WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso.
  OPTIONAL { ?country wdt:P297 ?iso2. }
  OPTIONAL { ?country wdt:P1082 ?pop. }
  ?country wikibase:sitelinks ?sl.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

// World-famous only: >=80 Wikipedia language editions. Nationally/niche-famous people sit far below
// this, so it filters them out. Bounded per-country (avoids the global-query timeout).
const FAME_MIN = 80;
const PER_COUNTRY = 50;
// Birth-only, bounded per country — the fast pattern (a births+deaths UNION timed out).
const peopleQuery = (qid: string) => `
SELECT ?personLabel ?sl WHERE {
  ?person wdt:P31 wd:Q5; wdt:P19 ?pl. ?pl wdt:P17 wd:${qid}.
  ?person wikibase:sitelinks ?sl. FILTER(?sl >= ${FAME_MIN})
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?sl) LIMIT ${PER_COUNTRY}`;

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

const Q_CALLING = `
SELECT ?iso ?code WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P474 ?code.
}`;

const Q_TLD = `
SELECT ?iso ?tldLabel WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P78 ?tld.
  ?tld rdfs:label ?tldLabel. FILTER(LANG(?tldLabel) = "en")
}`;

const Q_PEAK = `
SELECT ?iso ?peakLabel WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P610 ?peak.
  ?peak rdfs:label ?peakLabel. FILTER(LANG(?peakLabel) = "en")
}`;

// UNESCO World Heritage Sites (bounded ~1,200) — clean, all inherently notable. Difficulty by fame.
const Q_WHS = `
SELECT ?siteLabel ?iso ?sl WHERE {
  ?site wdt:P31 wd:Q9259; wdt:P17 ?c. ?c wdt:P298 ?iso.
  ?site wikibase:sitelinks ?sl. FILTER(?sl >= 25)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

// Dishes with a country of origin (bounded). "Which country did <dish> originate in?"
const Q_DISH = `
SELECT ?dishLabel ?iso ?sl WHERE {
  ?dish wdt:P31 wd:Q746549; wdt:P495 ?c. ?c wdt:P298 ?iso.
  ?dish wikibase:sitelinks ?sl. FILTER(?sl >= 15)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
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
  const [baseRows, capRows, curRows, langRows, callRows, tldRows, peakRows, whsRows, dishRows] = await Promise.all([
    sparql("base", Q_BASE),
    sparql("capital", Q_CAPITAL),
    sparql("currency", Q_CURRENCY),
    sparql("language", Q_LANGUAGE),
    sparql("calling", Q_CALLING),
    sparql("tld", Q_TLD),
    sparql("peak", Q_PEAK),
    sparql("whs", Q_WHS),
    sparql("dish", Q_DISH),
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
  const nameOf = (iso: string) => metaMap.get(iso)?.name ?? iso;

  // Map each ISO to its Wikidata QID (for the per-country people queries).
  const qidByIso = new Map<string, string>();
  for (const r of baseRows) {
    if (r.iso && r.country && allowed.has(r.iso) && !qidByIso.has(r.iso)) {
      qidByIso.set(r.iso, r.country.split("/").pop()!);
    }
  }

  // Fetch the world-famous people born/died in each country (bounded, cached, concurrency-limited).
  const targets = countries
    .map((c) => ({ iso: c.iso, qid: qidByIso.get(c.iso) }))
    .filter((t): t is { iso: string; qid: string } => !!t.qid);
  let progressed = 0;
  const perCountry = await mapPool(targets, 2, async ({ iso, qid }) => {
    try {
      const rows = await sparql(`people-${qid}`, peopleQuery(qid));
      if (++progressed % 25 === 0) console.log(`  people: ${progressed}/${targets.length} countries`);
      return rows.map((r) => ({ iso, person: r.personLabel!, sitelinks: Number(r.sl ?? 0) }));
    } catch (e) {
      console.warn(`  people ${iso} failed: ${(e as Error).message}`);
      return [];
    }
  });
  const birthEntries: PersonEntry[] = perCountry.flat();

  const auto = [
    ...buildLocate(countries),
    ...buildFlag(countries),
    ...buildUniqueValue(
      capRows.map((r) => ({ iso: r.iso!, value: r.capitalLabel! })),
      allowed,
      "capital",
      (v) => `Which country's capital is ${v}?`,
      nameOf,
    ),
    // Currency: use just the UNIT (last word) so "United Arab Emirates dirham" -> "dirham";
    // shared units ("dollar", "peso", "rupee") then fail the uniqueness check and drop out.
    ...buildUniqueValue(
      curRows.map((r) => ({ iso: r.iso!, value: r.currencyLabel!.trim().split(/\s+/).at(-1)!.toLowerCase() })),
      allowed,
      "currency",
      (v) => `Which country's currency is the ${v}?`,
      nameOf,
    ),
    ...buildUniqueValue(
      langRows.map((r) => ({ iso: r.iso!, value: r.languageLabel! })),
      allowed,
      "language",
      (v) => `${v} is an official language of which country?`,
      nameOf,
    ),
    ...buildUniqueValue(
      callRows.map((r) => ({ iso: r.iso!, value: r.code! })),
      allowed,
      "calling-code",
      (v) => `Which country's international dialling code is ${v}?`,
      nameOf,
    ),
    // TLD: keep only clean 2-letter ASCII ccTLDs (drops IDN TLDs like ".中國").
    ...buildUniqueValue(
      tldRows.filter((r) => /^\.[a-z]{2}$/i.test(r.tldLabel!)).map((r) => ({ iso: r.iso!, value: r.tldLabel!.toLowerCase() })),
      allowed,
      "tld",
      (v) => `Which country uses the internet domain ${v}?`,
      nameOf,
    ),
    ...buildUniqueValue(
      peakRows.map((r) => ({ iso: r.iso!, value: r.peakLabel! })),
      allowed,
      "highest-point",
      (v) => `${v} is the highest point of which country?`,
      nameOf,
    ),
    ...buildPeopleQuestions(birthEntries, "birthplace", (n) => `In which country was ${n} born?`, nameOf),
    // deathplace intentionally omitted — morbid framing; see design doc.
    ...buildPeopleQuestions(
      whsRows.map((r) => ({ iso: r.iso!, person: r.siteLabel!, sitelinks: Number(r.sl ?? 0) })),
      "landmark",
      (n) => `In which country is ${n}?`,
      nameOf,
    ),
    ...buildPeopleQuestions(
      dishRows.map((r) => ({ iso: r.iso!, person: r.dishLabel!, sitelinks: Number(r.sl ?? 0) })),
      "dish",
      (n) => `Which country did ${n} originate in?`,
      nameOf,
    ),
  ];

  const autoQs = assignDifficulty(auto, obscurity);
  const curated = await curatedTrivia(allowed);
  // Drop anything that evokes tragedy/atrocity (keeps the daily light).
  const pool: Question[] = [...autoQs, ...curated].filter((q) => !isSensitiveText(q.prompt));

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
