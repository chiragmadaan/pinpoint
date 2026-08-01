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
  buildBorderQuestions,
  buildFlag,
  buildLocate,
  buildPeopleQuestions,
  buildUniqueValue,
  canonicalizeLanguage,
  isSensitiveText,
  needsQualifier,
  pvFame,
  taxonKind,
  withCategory,
  type Candidate,
  type CountryMeta,
  type PersonEntry,
} from "./build.ts";
import { pageviews } from "./pageviews.ts";
import { extract, pickFact } from "./summaries.ts";
import { QLEVER_PREFIXES, sparql } from "./wikidata.ts";

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
 * On the map (so tappable) but NOT used as quiz answers: entities a mass audience can't reasonably
 * find on the map. We added the 1:50m micro-states so they'd render/snap, but only the recognizable
 * sovereigns with a *locatable* footprint (Singapore, Andorra, Bahrain, Maldives, Mauritius,
 * Barbados) get asked about. Everything else stays visible but unasked. Excluded because they're:
 *   - too small to see/tap even at max zoom (Vatican 0.3px, Monaco 2px, San Marino 3.8px,
 *     Liechtenstein 6.8px — enclaves swallowed by their surrounding country's polygon), or
 *   - obscure sovereign micro-states, or non-sovereign territories (incl. China-sensitive HK/Macao).
 */
const NON_ANSWER_ISO = new Set([
  // recognizable but un-findable (sub-tappable enclaves) — visible on the map, just not asked
  "VAT", "MCO", "SMR", "LIE",
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
SELECT ?personLabel ?sl ?desc WHERE {
  ?person wdt:P31 wd:Q5; wdt:P19 ?pl. ?pl wdt:P17 wd:${qid}.
  ?person wikibase:sitelinks ?sl. FILTER(?sl >= ${FAME_MIN})
  OPTIONAL { ?person schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?sl) LIMIT ${PER_COUNTRY}`;

// "Which country is X from?" — people whose SINGLE citizenship is this country (multi-citizenship is
// ambiguous, so it's excluded). The easy, no-gotcha association (Gandhi→India, Mandela→South Africa).
const nationalityQuery = (qid: string) => `
SELECT ?personLabel ?sl ?desc WHERE {
  ?person wdt:P31 wd:Q5; wdt:P27 wd:${qid}; wikibase:sitelinks ?sl. FILTER(?sl >= ${FAME_MIN})
  FILTER NOT EXISTS { ?person wdt:P27 ?other. FILTER(?other != wd:${qid}) }
  OPTIONAL { ?person schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?sl) LIMIT ${PER_COUNTRY}`;

const Q_CAPITAL = `
SELECT ?iso ?capitalLabel ?enwiki WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P36 ?capital.
  ?capital rdfs:label ?capitalLabel. FILTER(LANG(?capitalLabel) = "en")
  OPTIONAL { ?wpArticle schema:about ?capital; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
}`;

const Q_CURRENCY = `
SELECT ?iso ?currencyLabel ?enwiki WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P38 ?cur.
  ?cur rdfs:label ?currencyLabel. FILTER(LANG(?currencyLabel) = "en")
  OPTIONAL { ?wpArticle schema:about ?cur; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
}`;

const Q_LANGUAGE = `
SELECT ?iso ?languageLabel ?enwiki WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P37 ?lang.
  ?lang rdfs:label ?languageLabel. FILTER(LANG(?languageLabel) = "en")
  OPTIONAL { ?wpArticle schema:about ?lang; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
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
SELECT ?iso ?peakLabel ?enwiki WHERE {
  ?country wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P610 ?peak.
  ?peak rdfs:label ?peakLabel. FILTER(LANG(?peakLabel) = "en")
  OPTIONAL { ?wpArticle schema:about ?peak; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
}`;

// UNESCO World Heritage Sites (bounded ~1,200) — clean, all inherently notable. Difficulty by fame.
const Q_WHS = `
SELECT ?siteLabel ?iso ?sl ?desc ?enwiki WHERE {
  ?site wdt:P31 wd:Q9259; wdt:P17 ?c. ?c wdt:P298 ?iso.
  ?site wikibase:sitelinks ?sl. FILTER(?sl >= 25)
  OPTIONAL { ?wpArticle schema:about ?site; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
  OPTIONAL { ?site schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

// Dishes with a country of origin (bounded). "Which country did <dish> originate in?"
const Q_DISH = `
SELECT ?dishLabel ?iso ?sl ?desc ?enwiki WHERE {
  ?dish wdt:P31 wd:Q746549; wdt:P495 ?c. ?c wdt:P298 ?iso.
  ?dish wikibase:sitelinks ?sl. FILTER(?sl >= 15)
  OPTIONAL { ?wpArticle schema:about ?dish; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
  OPTIONAL { ?dish schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

// --- Topic categories: a distinctive thing that belongs to exactly ONE country -----------------
// All follow the same shape (label + iso + sitelinks + description). buildUniqueValue drops any
// value claimed by 2+ countries, so ambiguity is filtered structurally; `sl` drives difficulty and
// `desc` becomes the reveal fact. Sitelink floors are per-topic recognizability bars.

/** Origin-of-X topics keyed on P495 (country of origin), varying only by the subject class. */
const originQuery = (classQid: string, minSitelinks: number, limit = 3000) => `
SELECT ?itemLabel ?iso ?sl ?desc ?enwiki WHERE {
  ?item wdt:P31/wdt:P279* wd:${classQid}; wdt:P495 ?c.
  ?c wdt:P298 ?iso.
  ?item wikibase:sitelinks ?sl. FILTER(?sl >= ${minSitelinks})
  OPTIONAL { ?wpArticle schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${limit}`;

const Q_GENRE = originQuery("Q188451", 15); // music genre (also covers dance styles)
const Q_SPORT = originQuery("Q349", 12); // sport (incl. martial arts)
const Q_DRINK = originQuery("Q40050", 12); // drink
// Endemic animals: P183 ("endemic to") already means single-territory, so these are inherently
// unique — the panda/lemur/kiwi class of clue. High floor: the tail is full of obscure species.
const Q_ANIMAL = `
SELECT ?itemLabel ?iso ?sl ?desc ?enwiki WHERE {
  ?item wdt:P183 ?c. ?c wdt:P298 ?iso.
  ?item wikibase:sitelinks ?sl. FILTER(?sl >= 40)
  OPTIONAL { ?wpArticle schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 3000`;

// Festivals/holidays tied to a country (P17). "Which country celebrates X?"
const Q_FESTIVAL = `
SELECT ?itemLabel ?iso ?sl ?desc ?enwiki WHERE {
  ?item wdt:P31/wdt:P279* wd:Q132241; wdt:P17 ?c.
  ?c wdt:P298 ?iso.
  ?item wikibase:sitelinks ?sl. FILTER(?sl >= 15)
  OPTIONAL { ?wpArticle schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 2000`;

// Brands run on QLever: the query spans the whole company set, which WDQS cannot finish inside its
// 60s limit (verified: repeated timeouts). QLever answers in ~4s.
// QLever dialect: explicit prefixes, and rdfs:label instead of SERVICE wikibase:label.
const Q_BRAND = `${QLEVER_PREFIXES}
SELECT ?itemLabel ?iso ?sl ?desc ?enwiki WHERE {
  VALUES ?type { wd:Q4830453 wd:Q891723 wd:Q6881511 wd:Q18388277 }
  ?item wdt:P31 ?type; wdt:P17 ?c; wikibase:sitelinks ?sl.
  FILTER(?sl >= 45)
  ?c wdt:P298 ?iso.
  ?item rdfs:label ?itemLabel. FILTER(LANG(?itemLabel) = "en")
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
} LIMIT 3000`;

// Rivers: uniqueness filtering keeps only rivers whose P17 is a single country, i.e. those flowing
// entirely within one country (the Danube, shared by 10, is dropped automatically).
const Q_RIVER = `
SELECT ?itemLabel ?iso ?sl ?desc ?enwiki WHERE {
  ?item wdt:P31/wdt:P279* wd:Q4022; wdt:P17 ?c.
  ?c wdt:P298 ?iso.
  ?item wikibase:sitelinks ?sl. FILTER(?sl >= 25)
  OPTIONAL { ?wpArticle schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 3000`;

// National anthems. Near-total country coverage, but recognizing an anthem by title is genuinely
// hard, so these are forced into the bonus pool (see BONUS_TYPES) rather than the mandatory three.
const Q_ANTHEM = `
SELECT ?itemLabel ?iso ?sl ?desc ?enwiki WHERE {
  ?c wdt:P31 wd:Q6256; wdt:P298 ?iso; wdt:P85 ?item.
  ?item wikibase:sitelinks ?sl.
  OPTIONAL { ?wpArticle schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki. }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 500`;

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

  // Topic categories, fetched sequentially (each is a heavier query; be polite to WDQS). A topic
  // that times out yields [] and is simply absent from this run rather than failing the whole build.
  const TOPIC_QUERIES: [string, string, ("wdqs" | "qlever")?][] = [
    ["genre", Q_GENRE], ["sport", Q_SPORT], ["drink", Q_DRINK], ["animal", Q_ANIMAL],
    ["festival", Q_FESTIVAL], ["river", Q_RIVER], ["anthem", Q_ANTHEM],
    ["brand", Q_BRAND, "qlever"],
  ];
  const topicRows: Record<string, Record<string, string>[]> = {};
  for (const [name, q, engine] of TOPIC_QUERIES) {
    try {
      topicRows[name] = (await sparql(`topic-${name}`, q, engine)) as Record<string, string>[];
    } catch (e) {
      console.warn(`  topic "${name}" query failed (skipped this run):`, (e as Error).message.slice(0, 80));
      topicRows[name] = [];
    }
  }

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
  /** Topic rows -> entity entries, with SITELINKS standing in for fame and the description as fact. */
  /** "Genus species" (optionally trinomial) — a scientific name, meaningless to a casual player. */
  const isBinomial = (s: string) => /^[A-Z][a-z]+ [a-z]+( [a-z]+)?$/.test(s) && !/\b(the|of|and)\b/i.test(s);

  const topicEntries = (
    name: string,
    opts: { preferCommonName?: boolean; qualify?: (display: string, desc?: string) => string | null } = {},
  ): PersonEntry[] =>
    (topicRows[name] ?? [])
      .filter((r) => r.itemLabel && r.iso && allowed.has(r.iso) && !/^Q\d+$/.test(r.itemLabel))
      .map((r) => {
        // Taxa are usually labelled by their binomial in Wikidata but titled by their common name
        // on Wikipedia ("Mellisuga helenae" -> "Bee hummingbird"), which is the answerable form.
        const display = opts.preferCommonName && r.enwiki && isBinomial(r.itemLabel!) ? r.enwiki : r.itemLabel!;
        return {
          iso: r.iso!,
          person: display,
          views: 0, // filled from pageviews below
          sitelinks: Number(r.sl ?? 0),
          fact: r.desc,
          article: r.enwiki,
          qualifier: opts.qualify?.(display, r.desc) ?? undefined,
        };
      })
      // Still a binomial => no common name exists. Those are unfair (and often plants, since
      // "endemic to" covers every taxon), so drop rather than dress them up.
      .filter((e) => !(opts.preferCommonName && isBinomial(e.person)));

  /**
   * Fame for topic entities, from PAGEVIEWS — the same signal people use.
   *
   * Sitelinks (the cheap stand-in this replaces) count how many Wikipedias have an article, which
   * bot-generated stubs inflate: the Zhizdra, a minor Russian tributary with 4.3K views/year, cleared
   * a 25-sitelink bar while the Thames didn't even reach the pool. Sitelinks stay as the query-side
   * PRE-filter that bounds the candidate set; pageviews decide what is actually recognizable.
   */
  const withViews = async (entries: PersonEntry[]): Promise<PersonEntry[]> =>
    mapPool(entries, 8, async (e) => ({ ...e, views: await pageviews(e.article ?? e.person) }));

  // Land-border graph (ships with the app) — powers the deduction-style "border" questions offline.
  const adjacency = JSON.parse(
    await readFile(url("../../../apps/web/public/adjacency.json"), "utf8"),
  ) as Record<string, string[]>;

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
      return rows.slice(0, PER_COUNTRY).map((r) => ({ iso, person: r.personLabel!, sitelinks: Number(r.sl ?? 0), fact: r.desc })); // top-20 documented/country
    } catch (e) {
      console.warn(`  people ${iso} failed: ${(e as Error).message}`);
      return [] as { iso: string; person: string; sitelinks: number; fact?: string }[];
    }
  });
  const peopleCandidates = perCountry.flat();
  console.log(`Fetching pageviews for ${peopleCandidates.length} people...`);
  let pvDone = 0;
  const birthEntries: PersonEntry[] = await mapPool(peopleCandidates, 8, async (p) => {
    if (++pvDone % 500 === 0) console.log(`  people pageviews: ${pvDone}/${peopleCandidates.length}`);
    return { iso: p.iso, person: p.person, sitelinks: p.sitelinks, fact: p.fact, views: await pageviews(p.person) };
  });

  // Nationality ("which country is X from?") — single-citizenship people, per-country, then pageviews.
  progressed = 0;
  const perCountryNat = await mapPool(targets, 2, async ({ iso, qid }) => {
    try {
      const rows = await sparql(`nationality-${qid}`, nationalityQuery(qid));
      if (++progressed % 40 === 0) console.log(`  nationality SPARQL: ${progressed}/${targets.length}`);
      return rows.slice(0, PER_COUNTRY).map((r) => ({ iso, person: r.personLabel!, sitelinks: Number(r.sl ?? 0), fact: r.desc }));
    } catch (e) {
      console.warn(`  nationality ${iso} failed: ${(e as Error).message}`);
      return [] as { iso: string; person: string; sitelinks: number; fact?: string }[];
    }
  });
  const natCandidates = perCountryNat.flat();
  console.log(`Fetching pageviews for ${natCandidates.length} nationality people...`);
  const natEntries: PersonEntry[] = await mapPool(natCandidates, 8, async (p) => ({
    iso: p.iso,
    person: p.person,
    sitelinks: p.sitelinks,
    fact: p.fact,
    views: await pageviews(p.person),
  }));

  console.log(`Fetching pageviews for ${whsRows.length} landmarks, ${dishRows.length} dishes...`);
  const landmarkEntries: PersonEntry[] = await mapPool(whsRows, 8, async (r) => ({
    iso: r.iso!,
    person: r.siteLabel!,
    fact: r.desc,
    article: r.enwiki,
    views: await pageviews(r.siteLabel!),
  }));
  const dishEntries: PersonEntry[] = await mapPool(dishRows, 8, async (r) => ({
    iso: r.iso!,
    person: r.dishLabel!,
    fact: r.desc,
    article: r.enwiki,
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
    ...buildBorderQuestions(adjacency, allowed, nameOf),
    ...buildUniqueValue(
      capRows.map((r) => ({ iso: r.iso!, value: r.capitalLabel!, article: r.enwiki })),
      allowed,
      "capital",
      (v) => `Which country's capital is ${v}?`,
      nameOf,
    ),
    // Currency: use just the UNIT (last word) so "United Arab Emirates dirham" -> "dirham";
    // shared units ("dollar", "peso", "rupee") then fail the uniqueness check and drop out.
    ...buildUniqueValue(
      // Clue shows the short form ("balboa"), but the fact must resolve the full article
      // ("Panamanian balboa") — the short form alone is a disambiguation page.
      curRows.map((r) => ({
        iso: r.iso!,
        value: r.currencyLabel!.trim().split(/\s+/).at(-1)!.toLowerCase(),
        article: r.enwiki,
      })),
      allowed,
      "currency",
      (v) => `Which country's currency is the ${v}?`,
      nameOf,
    ),
    ...buildUniqueValue(
      // Canonicalize variants (British English -> English) so a language official in >1 country
      // resolves as shared and is dropped — keeps only languages that point to a single country.
      langRows.map((r) => ({ iso: r.iso!, value: canonicalizeLanguage(r.languageLabel!), article: r.enwiki })),
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
      peakRows.filter((r) => !DISPUTED_PEAKS.has(r.peakLabel!)).map((r) => ({ iso: r.iso!, value: r.peakLabel!, article: r.enwiki })),
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
    ...buildPeopleQuestions(dishEntries, "dish", (n) => `Which country did ${withCategory("dish", n)} originate in?`, nameOf, 35_000, 1_000_000),
    // Topic categories. These reuse the entity pipeline (ambiguous-name drop, leak filter, fame ->
    // difficulty) but score fame by SITELINKS rather than pageviews — no per-item fetch for
    // thousands of items, and sitelinks track "notable thing" well for objects (vs. people, where
    // they underrate athletes). Floors mirror each query's bar; ceilings mark "world famous".
    ...buildPeopleQuestions(
      await withViews(topicEntries("genre")),
      "genre", (n) => `Which country did ${withCategory("music genre", n)} originate in?`, nameOf, 25_000, 800_000,
    ),
    ...buildPeopleQuestions(await withViews(topicEntries("sport")), "sport", (n) => `Which country did ${withCategory("sport", n)} originate in?`, nameOf, 25_000, 800_000),
    ...buildPeopleQuestions(await withViews(topicEntries("drink")), "drink", (n) => `Which country did ${withCategory("drink", n)} originate in?`, nameOf, 25_000, 800_000),
    ...buildPeopleQuestions(await withViews(topicEntries("animal", {
        preferCommonName: true,
        qualify: (display, desc) => (needsQualifier(display) ? taxonKind(desc) : null),
      })), "animal", (n) => `The ${n} is found only in which country?`, nameOf, 25_000, 800_000),
    ...buildPeopleQuestions(await withViews(topicEntries("festival")), "festival", (n) => `Which country is ${n} celebrated in?`, nameOf, 20_000, 800_000),
    ...buildPeopleQuestions(await withViews(topicEntries("brand")), "brand", (n) => `Which country is ${withCategory("company", n)} from?`, nameOf, 50_000, 2_000_000),
    ...buildPeopleQuestions(await withViews(topicEntries("river", {
        qualify: (display) => (/\briver\b/i.test(display) ? null : "river"),
      })), "river", (n) => `The ${n} flows through which country?`, nameOf, 25_000, 800_000),
    ...buildPeopleQuestions(await withViews(topicEntries("anthem")), "anthem", (n) => `"${n}" is the national anthem of which country?`, nameOf, 3_000, 200_000),
  ];

  const autoQs = assignDifficulty(auto, obscurity);
  const curated = await curatedTrivia(allowed);
  // Drop tragedy/atrocity clues (keeps the daily light) and any answer on a disputed territory.
  const all: Question[] = [...autoQs, ...curated].filter(
    (q) => !isSensitiveText(q.prompt) && !DISPUTED_ISO.has(q.answerIso),
  );

  // Obscure, near-unanswerable types move OUT of the mandatory 3 into the bonus (unlocked on 3/3).
  // Anthems join these: near-total country coverage, but recognizing one by title is too hard to
  // put in the mandatory three (player request) — perfect as the unlocked-on-3/3 bonus.
  const BONUS_TYPES = new Set(["calling-code", "tld", "highest-point", "currency", "anthem"]);
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

  const calendar: PuzzleCalendar = assembleCalendar(mandatory, todayKey(), 643, 45, 0.28, bonusPool);

  // Reveal facts: upgrade from the Wikidata description to the Wikipedia opening sentence, which is
  // written to inform rather than to disambiguate ("Species of mammal" -> "a euryhaline species of
  // oceanic dolphin found in ... the Bay of Bengal and Southeast Asia"). Done AFTER assembly so we
  // only fetch for the ~2.6k questions that actually shipped, not all 6k candidates. Falls back to
  // the (filtered) description, and to no fact at all rather than a contentless one.
  const shipped = calendar.puzzles.flatMap((p) => [...p.questions, ...(p.bonus ? [p.bonus] : [])]) as Candidate[];
  // Codes ("+43", ".nl") redirect to telephone-numbering-plan articles — technically on-topic but
  // dull and uninformative ("Telephone numbers in Austria have no standard lengths..."). No fact
  // reads better than a boring one, so skip them.
  const NO_FACT_TYPES = new Set(["calling-code", "tld"]);
  // Clues whose subject IS the answer country (locate/flag/border) draw on the country's own — or
  // its "Flag of X" — article, where naming the country is normal rather than a restatement.
  const SUBJECT_IS_ANSWER = new Set(["locate", "flag", "border"]);
  const withSubject = shipped.filter((q) => q.subject && !NO_FACT_TYPES.has(q.clueType));
  for (const q of shipped) if (NO_FACT_TYPES.has(q.clueType)) delete q.fact;
  console.log(`Fetching Wikipedia summaries for ${withSubject.length} shipped questions...`);
  let sumDone = 0;
  await mapPool(withSubject, 8, async (q) => {
    if (++sumDone % 400 === 0) console.log(`  summaries: ${sumDone}/${withSubject.length}`);
    const ex = await extract(q.article ?? q.subject!);
    const fact =
      ex &&
      pickFact(ex, {
        subject: q.subject!,
        answerName: nameOf(q.answerIso),
        subjectIsAnswer: SUBJECT_IS_ANSWER.has(q.clueType),
      });
    if (fact) q.fact = fact;
  });
  for (const q of shipped) {
    delete q.subject; // transient — never ships
    delete q.article;
  }
  const factCount = shipped.filter((q) => q.fact).length;
  console.log(`Reveal facts: ${factCount}/${shipped.length} (${Math.round((factCount / shipped.length) * 100)}%)`);

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
