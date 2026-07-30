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
  isSensitiveText,
  pvFame,
  type CountryMeta,
  type PersonEntry,
} from "./build.ts";
import { pageviews } from "./pageviews.ts";
import { sparql } from "./wikidata.ts";

const url = (p: string) => new URL(p, import.meta.url);

/**
 * Disputed / unrecognised territories excluded as ANSWERS. A tap-the-country daily can't assert a
 * territorial side without risking bans/controversy, so these never become the correct answer.
 * Keyed by ISO alpha-3 (Wikidata P298): Palestine, Taiwan, Western Sahara, Kosovo. See design doc.
 */
const DISPUTED_ISO = new Set(["PSE", "TWN", "ESH", "XKX", "XKK"]);

/** Peaks whose country attribution depends on a disputed border (e.g. Serbia's highest point only if
 *  Kosovo is counted as Serbia). Excluded from highest-point questions. */
const DISPUTED_PEAKS = new Set(["Velika Rudoka", "Đeravica", "Daravica", "Deravica"]);

/**
 * On the map (so tappable) but NOT used as quiz answers: obscure micro-states and non-sovereign
 * territories that a mass audience can't reasonably place. We added the 1:50m micro-states so they'd
 * render/snap, but only the recognizable *sovereign* ones (Singapore, Monaco, Vatican, San Marino,
 * Andorra, Liechtenstein, Bahrain, Maldives, Mauritius, Barbados) should be asked about — everything
 * else here stays visible but unasked (keeps recognizability + avoids obscure-question flooding).
 */
const NON_ANSWER_ISO = new Set([
  // obscure sovereign micro-states
  "FSM", "MHL", "TON", "WSM", "NRU", "KIR", "PLW", "SYC", "STP", "COM", "CPV",
  "VCT", "LCA", "KNA", "GRD", "DMA", "ATG",
  // non-sovereign territories (and China-sensitive HK/Macao)
  "MNP", "VIR", "GUM", "ASM", "SGS", "IOT", "SHN", "PCN", "AIA", "CYM", "VGB", "TCA",
  "MSR", "JEY", "GGY", "IMN", "NIU", "COK", "ABW", "CUW", "SPM", "WLF", "MAF", "BLM",
  "PYF", "ALA", "FRO", "MAC", "HKG", "HMD", "NFK", "SXM",
]);

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

// Sitelinks is now only a cheap PRE-FILTER to bound the candidate set per country; PAGEVIEWS decide
// actual recognizability downstream. So keep this low (a light "has some documentation" bar) and let
// pageviews cut — a high sitelinks bar was zeroing out ~160 countries and excluding pageview-famous
// but less-encyclopedic people.
const FAME_MIN = 30;
const PER_COUNTRY = 40;
// Birth-only, bounded per country — the fast pattern (a births+deaths UNION timed out).
const peopleQuery = (qid: string) => `
SELECT ?personLabel ?sl WHERE {
  ?person wdt:P31 wd:Q5; wdt:P19 ?pl. ?pl wdt:P17 wd:${qid}.
  ?person wikibase:sitelinks ?sl. FILTER(?sl >= ${FAME_MIN})
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?sl) LIMIT ${PER_COUNTRY}`;

// "Which country is X from?" — people whose SINGLE citizenship is this country (multi-citizenship is
// ambiguous, so it's excluded). The easy, no-gotcha association (Gandhi→India, Mandela→South Africa).
const nationalityQuery = (qid: string) => `
SELECT ?personLabel ?sl WHERE {
  ?person wdt:P31 wd:Q5; wdt:P27 wd:${qid}; wikibase:sitelinks ?sl. FILTER(?sl >= ${FAME_MIN})
  FILTER NOT EXISTS { ?person wdt:P27 ?other. FILTER(?other != wd:${qid}) }
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
  // On the map but not answerable: obscure micro-states / territories (still tappable, just unasked).
  return new Set(fc.features.map((f) => f.id).filter((iso) => !NON_ANSWER_ISO.has(iso)));
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
  const nameOf = (iso: string) => metaMap.get(iso)?.name ?? iso;

  // Country recognizability from POPULATION (log-normalized). Country-article pageviews do NOT
  // discriminate (Serbia 2.6M ≈ Uzbekistan 2.7M — topic curiosity, not flag/geo fame) and sitelinks
  // are flatter still. Population has real spread (1.4B → ~10K) and tracks global prominence better.
  // (Pageviews ARE used for entities below — people/landmarks/dishes — where the range makes them work.)
  const pops = countries.map((c) => c.pop).filter((p): p is number => typeof p === "number" && p > 0);
  const pFloor = Math.min(...pops);
  const pCeil = Math.max(...pops);
  const obscurity: Record<string, number> = {};
  for (const c of countries) obscurity[c.iso] = 1 - pvFame(c.pop ?? pFloor, pFloor, pCeil);

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
      if (++progressed % 40 === 0) console.log(`  people SPARQL: ${progressed}/${targets.length}`);
      return rows.slice(0, PER_COUNTRY).map((r) => ({ iso, person: r.personLabel!, sitelinks: Number(r.sl ?? 0) })); // top-20 documented/country
    } catch (e) {
      console.warn(`  people ${iso} failed: ${(e as Error).message}`);
      return [] as { iso: string; person: string; sitelinks: number }[];
    }
  });
  const peopleCandidates = perCountry.flat();
  console.log(`Fetching pageviews for ${peopleCandidates.length} people...`);
  let pvDone = 0;
  const birthEntries: PersonEntry[] = await mapPool(peopleCandidates, 8, async (p) => {
    if (++pvDone % 500 === 0) console.log(`  people pageviews: ${pvDone}/${peopleCandidates.length}`);
    return { iso: p.iso, person: p.person, sitelinks: p.sitelinks, views: await pageviews(p.person) };
  });

  // Nationality ("which country is X from?") — single-citizenship people, per-country, then pageviews.
  progressed = 0;
  const perCountryNat = await mapPool(targets, 2, async ({ iso, qid }) => {
    try {
      const rows = await sparql(`nationality-${qid}`, nationalityQuery(qid));
      if (++progressed % 40 === 0) console.log(`  nationality SPARQL: ${progressed}/${targets.length}`);
      return rows.slice(0, PER_COUNTRY).map((r) => ({ iso, person: r.personLabel!, sitelinks: Number(r.sl ?? 0) }));
    } catch (e) {
      console.warn(`  nationality ${iso} failed: ${(e as Error).message}`);
      return [] as { iso: string; person: string; sitelinks: number }[];
    }
  });
  const natCandidates = perCountryNat.flat();
  console.log(`Fetching pageviews for ${natCandidates.length} nationality people...`);
  const natEntries: PersonEntry[] = await mapPool(natCandidates, 8, async (p) => ({
    iso: p.iso,
    person: p.person,
    sitelinks: p.sitelinks,
    views: await pageviews(p.person),
  }));

  console.log(`Fetching pageviews for ${whsRows.length} landmarks, ${dishRows.length} dishes...`);
  const landmarkEntries: PersonEntry[] = await mapPool(whsRows, 8, async (r) => ({
    iso: r.iso!,
    person: r.siteLabel!,
    views: await pageviews(r.siteLabel!),
  }));
  const dishEntries: PersonEntry[] = await mapPool(dishRows, 8, async (r) => ({
    iso: r.iso!,
    person: r.dishLabel!,
    views: await pageviews(r.dishLabel!),
  }));

  // Diagnostics: how many entities survive the pageview floors.
  const surv = (arr: PersonEntry[], floor: number) => `${arr.filter((e) => e.views >= floor).length}/${arr.length}`;
  console.log(
    `floor survival — people ${surv(birthEntries, 150_000)}, nationality ${surv(natEntries, 150_000)}, landmarks ${surv(landmarkEntries, 35_000)}, dishes ${surv(dishEntries, 35_000)}`,
  );

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
      peakRows.filter((r) => !DISPUTED_PEAKS.has(r.peakLabel!)).map((r) => ({ iso: r.iso!, value: r.peakLabel! })),
      allowed,
      "highest-point",
      (v) => `${v} is the highest point of which country?`,
      nameOf,
    ),
    // Recognizability floors (annual pageviews): drop below, "easy" at the ceiling. deathplace omitted.
    ...buildPeopleQuestions(birthEntries, "birthplace", (n) => `In which country was ${n} born?`, nameOf, 150_000, 3_000_000),
    ...buildPeopleQuestions(natEntries, "nationality", (n) => `Which country is ${n} from?`, nameOf, 150_000, 3_000_000),
    // Landmarks/dishes naturally get far fewer views than people -> much lower floor (35k).
    ...buildPeopleQuestions(landmarkEntries, "landmark", (n) => `In which country is ${n}?`, nameOf, 35_000, 1_000_000),
    ...buildPeopleQuestions(dishEntries, "dish", (n) => `Which country did ${n} originate in?`, nameOf, 35_000, 1_000_000),
  ];

  const autoQs = assignDifficulty(auto, obscurity);
  const curated = await curatedTrivia(allowed);
  // Drop tragedy/atrocity clues (keeps the daily light) and any answer on a disputed territory.
  const all: Question[] = [...autoQs, ...curated].filter(
    (q) => !isSensitiveText(q.prompt) && !DISPUTED_ISO.has(q.answerIso),
  );

  // Obscure, near-unanswerable types move OUT of the mandatory 3 into the bonus (unlocked on 3/3).
  const BONUS_TYPES = new Set(["calling-code", "tld", "highest-point", "currency"]);
  const mandatory = all.filter((q) => !BONUS_TYPES.has(q.clueType));
  const bonusPool = all.filter((q) => BONUS_TYPES.has(q.clueType));

  const mDiff = { easy: 0, medium: 0, hard: 0 };
  for (const q of mandatory) mDiff[q.difficulty]++;
  console.log("mandatory pool by difficulty:", mDiff, "(calendar length = smallest tier, minus no-repeat/type-cap losses)");
  // Person share per tier — each day allows only ONE person question, so non-person supply per tier
  // (especially hard) is what bounds the calendar.
  const isPerson = (t: string) => t === "birthplace" || t === "nationality" || t === "deathplace";
  const split = { easy: [0, 0], medium: [0, 0], hard: [0, 0] } as Record<string, [number, number]>;
  for (const q of mandatory) split[q.difficulty][isPerson(q.clueType) ? 0 : 1]++;
  console.log("person / non-person per tier:", { easy: split.easy, medium: split.medium, hard: split.hard });

  const calendar: PuzzleCalendar = assembleCalendar(mandatory, todayKey(), 400, 45, 0.28, bonusPool);

  await writeFile(url("../../../data/questions.json"), JSON.stringify(calendar));
  await writeFile(url("../../../apps/web/public/questions.json"), JSON.stringify(calendar));

  const byType: Record<string, number> = {};
  for (const q of all) byType[q.clueType] = (byType[q.clueType] ?? 0) + 1;
  const withBonus = calendar.puzzles.filter((p) => p.bonus).length;
  console.log(`Countries on map: ${countries.length}`);
  console.log(`Candidates: ${all.length} (mandatory ${mandatory.length}, bonus ${bonusPool.length})`, byType);
  console.log(`Calendar: ${calendar.puzzles.length} days (${withBonus} with bonus), from ${calendar.puzzles[0]?.date}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
