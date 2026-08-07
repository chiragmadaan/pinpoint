import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "@pinpoint/core";
import {
  assembleCalendar,
  assignDifficulty,
  buildUniqueValue,
  expandTerritories,
  canonicalizeLanguage,
  withCategory,
  computeObscurity,
  flagEmoji,
  isSensitiveText,
  leaksCountryName,
  leaksPlaceName,
} from "./build.ts";

test("leaksPlaceName catches a clue naming a city in its own answer country", () => {
  const japan = ["Tokyo", "Osaka", "Kyoto"];
  // The real bug: this question degrades to "where is Tokyo?".
  assert.equal(leaksPlaceName("Tokyo International Film Festival", japan), true);
  assert.equal(leaksPlaceName("SK Slavia Prague", ["Prague", "Brno"]), true);
  // Unrelated clues survive.
  assert.equal(leaksPlaceName("Cannes Film Festival", japan), false);
  assert.equal(leaksPlaceName("sushi", japan), false);
  // Substrings must not trigger: "Osaka" inside a longer word is not a place mention.
  assert.equal(leaksPlaceName("Osakabe clan chronicles", ["Osaka"]), false);
  // Very short names are ignored — they collide with ordinary words too easily.
  assert.equal(leaksPlaceName("The old town", ["Old"]), false);
});

test("withCategory names the kind of thing, without repeating a category already in the name", () => {
  // "Which country is Alexa Internet from?" reads like a person — brand and nationality share that
  // template, so the category is what tells them apart.
  assert.equal(withCategory("company", "Alexa Internet"), "the company Alexa Internet");
  assert.equal(withCategory("music genre", "bachata"), "the music genre bachata");
  assert.equal(withCategory("sport", "Lethwei"), "the sport Lethwei");
  // Already self-describing -> leave alone (no "the company Ford Motor Company").
  assert.equal(withCategory("company", "Ford Motor Company"), "Ford Motor Company");
  assert.equal(withCategory("music genre", "Chicago blues genre"), "Chicago blues genre");
  assert.equal(withCategory("dish", "Pizza dishes"), "Pizza dishes"); // plural form too
});

test("canonicalizeLanguage collapses variants so multi-country languages get deduped away", () => {
  assert.equal(canonicalizeLanguage("British English"), "English");
  assert.equal(canonicalizeLanguage("American English"), "English");
  assert.equal(canonicalizeLanguage("Standard Chinese"), "Chinese");
  assert.equal(canonicalizeLanguage("Mandarin Chinese"), "Chinese");
  assert.equal(canonicalizeLanguage("Putonghua"), "Chinese"); // China's Wikidata label -> merges with "Chinese"
  assert.equal(canonicalizeLanguage("Modern Standard Arabic"), "Arabic");
  assert.equal(canonicalizeLanguage("Hungarian"), "Hungarian"); // unique language unchanged
  // Two English variants now collide -> buildUniqueValue drops them as shared (not unique to a country).
  const out = buildUniqueValue(
    [
      { iso: "GBR", value: canonicalizeLanguage("British English") },
      { iso: "BRN", value: canonicalizeLanguage("American English") },
      { iso: "HUN", value: canonicalizeLanguage("Hungarian") },
    ],
    new Set(["GBR", "BRN", "HUN"]),
    "language",
    (v) => `${v}?`,
    (iso) => iso,
  );
  assert.deepEqual(out.map((q) => q.answerIso), ["HUN"]); // only the single-country language survives
});

test("flagEmoji maps alpha-2 to a flag emoji", () => {
  assert.equal(flagEmoji("FR"), "🇫🇷");
  assert.equal(flagEmoji("JP"), "🇯🇵");
  assert.equal(flagEmoji("XYZ"), undefined);
  assert.equal(flagEmoji(undefined), undefined);
});

test("buildUniqueValue: keeps unique values, allows multi-value per country, drops shared values", () => {
  const rows = [
    { iso: "ZAF", value: "Pretoria" },
    { iso: "ZAF", value: "Cape Town" },
    { iso: "ZAF", value: "Bloemfontein" },
    { iso: "FRA", value: "Paris" },
    { iso: "XXX", value: "Shared City" },
    { iso: "YYY", value: "Shared City" }, // same value, 2 countries -> ambiguous -> dropped
  ];
  const allowed = new Set(["ZAF", "FRA", "XXX", "YYY"]);
  const qs = buildUniqueValue(rows, allowed, "capital", (v) => `Which country's capital is ${v}?`);
  assert.equal(qs.length, 4); // 3 ZAF capitals + Paris; "Shared City" dropped
  assert.equal(qs.filter((q) => q.answerIso === "ZAF").length, 3);
  assert.ok(!qs.some((q) => q.prompt.includes("Shared City")));
});

test("buildUniqueValue ignores rows for countries not in the allowed (map) set", () => {
  const rows = [{ iso: "FRA", value: "Paris" }, { iso: "ZZZ", value: "Ghostville" }];
  const qs = buildUniqueValue(rows, new Set(["FRA"]), "capital", (v) => v);
  assert.equal(qs.length, 1);
  assert.equal(qs[0]!.answerIso, "FRA");
});

test("leaksCountryName catches name words and demonym prefixes, allows distinctive clues", () => {
  assert.equal(leaksCountryName("United Arab Emirates dirham", "United Arab Emirates"), true);
  assert.equal(leaksCountryName("Estonian", "Estonia"), true); // demonym prefix
  assert.equal(leaksCountryName("Kuwait City", "Kuwait"), true);
  assert.equal(leaksCountryName("naira", "Nigeria"), false); // distinctive unit -> keep
  assert.equal(leaksCountryName("Khmer", "Cambodia"), false);
});

test("buildUniqueValue drops clues that leak the country name", () => {
  const rows = [{ iso: "ARE", value: "dirham" }, { iso: "NGA", value: "naira" }];
  const qs = buildUniqueValue(rows, new Set(["ARE", "NGA"]), "currency", (v) => v, (iso) =>
    iso === "ARE" ? "United Arab Emirates" : "Nigeria",
  );
  // "dirham" doesn't leak UAE, but let's prove the leak path with a real leak:
  const leaky = buildUniqueValue([{ iso: "EST", value: "Estonian" }], new Set(["EST"]), "language", (v) => v, () => "Estonia");
  assert.equal(qs.length, 2);
  assert.equal(leaky.length, 0);
});

test("isSensitiveText flags tragedy/atrocity but allows ordinary history", () => {
  assert.equal(isSensitiveText("Where did the XYZ genocide happen?"), true);
  assert.equal(isSensitiveText("The 1986 Chernobyl disaster occurred in which country?"), true);
  assert.equal(isSensitiveText("In which country was Einstein born?"), false);
  assert.equal(isSensitiveText("In which country was the Boer War fought?"), false); // war is allowed
});

test("assignDifficulty splits candidates into easy/medium/hard terciles", () => {
  const countries = [
    { iso: "A", name: "A", sitelinks: 300 },
    { iso: "B", name: "B", sitelinks: 200 },
    { iso: "C", name: "C", sitelinks: 100 },
  ];
  const obscurity = computeObscurity(countries);
  // Use "trivia" (not gated by EASY_COUNTRIES / locate / birthplace caps) to test the raw terciles.
  const cands = ["A", "B", "C"].map((iso) => ({
    id: `trivia-${iso}`,
    clueType: "trivia" as const,
    prompt: `trivia ${iso}`,
    answerIso: iso,
    acceptedIso: [iso],
  }));
  const qs = assignDifficulty(cands, obscurity);
  const byIso = Object.fromEntries(qs.map((q) => [q.answerIso, q.difficulty]));
  assert.equal(byIso.A, "easy"); // most sitelinks -> least obscure -> easiest
  assert.equal(byIso.C, "hard");
});

test("locate questions never rank hard (single point of failure -> capped at medium)", () => {
  const obscurity = { A: 0, B: 0.5, C: 1 };
  const cands = ["A", "B", "C"].map((iso) => ({
    id: `locate-${iso}`,
    clueType: "locate" as const,
    prompt: `Locate ${iso}`,
    answerIso: iso,
    acceptedIso: [iso],
  }));
  const qs = assignDifficulty(cands, obscurity);
  assert.ok(!qs.some((q) => q.difficulty === "hard")); // the obscure one is capped to medium
});

test("assembleCalendar: no reused questions, distinct countries per day", () => {
  // Distinct category per tier so each day can form 3 distinct-category questions.
  const mk = (id: string, iso: string, difficulty: Question["difficulty"], clueType: Question["clueType"]): Question => ({
    id, clueType, difficulty, prompt: id, answerIso: iso, acceptedIso: [iso],
  });
  const pool: Question[] = [
    mk("e1", "A", "easy", "locate"), mk("e2", "B", "easy", "locate"), mk("e3", "C", "easy", "locate"),
    mk("m1", "D", "medium", "capital"), mk("m2", "E", "medium", "capital"), mk("m3", "F", "medium", "capital"),
    mk("h1", "G", "hard", "flag"), mk("h2", "H", "hard", "flag"), mk("h3", "I", "hard", "flag"),
  ];
  const cal = assembleCalendar(pool, "2026-08-01", 10, 45);
  assert.equal(cal.puzzles.length, 3); // 3 per tier -> 3 days
  const allIds = cal.puzzles.flatMap((p) => p.questions.map((q) => q.id));
  assert.equal(new Set(allIds).size, allIds.length); // no question reused
  for (const p of cal.puzzles) {
    assert.equal(new Set(p.questions.map((q) => q.answerIso)).size, 3); // distinct countries per day
    assert.deepEqual(
      p.questions.map((q) => q.difficulty),
      ["easy", "medium", "hard"],
    );
  }
});

test("assembleCalendar gives each day 3 distinct clue types when the pool allows", () => {
  const mk = (id: string, iso: string, difficulty: Question["difficulty"], clueType: Question["clueType"]): Question => ({
    id, clueType, difficulty, prompt: id, answerIso: iso, acceptedIso: [iso],
  });
  const pool: Question[] = [
    mk("e1", "A", "easy", "birthplace"), mk("e2", "B", "easy", "locate"),
    mk("m1", "C", "medium", "capital"), mk("m2", "D", "medium", "birthplace"),
    mk("h1", "E", "hard", "tld"), mk("h2", "F", "hard", "currency"),
  ];
  const cal = assembleCalendar(pool, "2026-08-01", 2, 45, 4);
  for (const p of cal.puzzles) {
    assert.equal(new Set(p.questions.map((q) => q.clueType)).size, 3); // no repeated clue type in a day
  }
});

test("assembleCalendar: at most one person question, and never three of any category, per day", () => {
  const mk = (id: string, iso: string, difficulty: Question["difficulty"], clueType: Question["clueType"]): Question => ({
    id, clueType, difficulty, prompt: id, answerIso: iso, acceptedIso: [iso],
  });
  const PERSON = new Set(["birthplace", "nationality", "deathplace"]);
  const cat = (t: string) => (PERSON.has(t) ? "person" : t);
  // Person clues in every tier (would pair up under the old rule); non-person alternatives too.
  const pool: Question[] = [
    mk("e1", "A", "easy", "birthplace"), mk("e2", "B", "easy", "nationality"), mk("e3", "C", "easy", "locate"),
    mk("m1", "D", "medium", "nationality"), mk("m2", "E", "medium", "birthplace"), mk("m3", "F", "medium", "capital"),
    mk("h1", "G", "hard", "birthplace"), mk("h2", "H", "hard", "nationality"), mk("h3", "I", "hard", "flag"),
  ];
  const cal = assembleCalendar(pool, "2026-08-01", 3, 45, 9);
  for (const p of cal.puzzles) {
    const counts: Record<string, number> = {};
    for (const q of p.questions) counts[cat(q.clueType)] = (counts[cat(q.clueType)] ?? 0) + 1;
    assert.ok((counts.person ?? 0) <= 1, `day ${p.date} has ${counts.person} person questions`);
    assert.ok(Math.max(...Object.values(counts)) <= 2, `day ${p.date} repeats a category 3×: ${p.questions.map((q) => q.clueType).join(",")}`);
  }
});

test("assembleCalendar rotates the person question across slots, including person-free days", () => {
  const mk = (id: string, iso: string, difficulty: Question["difficulty"], clueType: Question["clueType"]): Question => ({
    id, clueType, difficulty, prompt: id, answerIso: iso, acceptedIso: [iso],
  });
  // Plenty of both kinds in every tier, so placement is driven by the rotation, not by scarcity.
  const nonPersonType = { easy: "locate", medium: "capital", hard: "flag" } as const;
  const pool: Question[] = [];
  for (const d of ["easy", "medium", "hard"] as const) {
    for (let i = 0; i < 20; i++) {
      pool.push(mk(`${d}-p${i}`, `${d.toUpperCase()}P${i}`, d, "nationality"));
      pool.push(mk(`${d}-n${i}`, `${d.toUpperCase()}N${i}`, d, nonPersonType[d]));
    }
  }
  const cal = assembleCalendar(pool, "2026-08-01", 12, 0, 9);
  assert.ok(cal.puzzles.length >= 8, `expected a full-ish calendar, got ${cal.puzzles.length}`);

  const slotOf = (p: (typeof cal.puzzles)[number]) =>
    p.questions.findIndex((q) => q.clueType === "nationality"); // -1 when the day has no person Q
  const slots = cal.puzzles.map(slotOf);
  // Never more than one person question per day (the redundancy rule still holds).
  for (const p of cal.puzzles) {
    assert.ok(p.questions.filter((q) => q.clueType === "nationality").length <= 1);
  }
  // The whole point of the rotation: person questions must not pile into one slot, and some days
  // must have none at all. (Before this, EVERY day had one and 72% of them sat in the hard slot.)
  assert.ok(slots.includes(-1), "expected some person-free days");
  assert.ok(new Set(slots.filter((s) => s >= 0)).size >= 2, "person questions should span >1 slot");
  const hardRun = slots.reduce((m, s, i) => (s === 2 && slots[i - 1] === 2 ? m + 1 : m), 0);
  assert.ok(hardRun < slots.length / 2, "person questions must not monopolise the hard slot");
});

test("assembleCalendar allows two of a non-person category (e.g. easy + hard Locate) when needed", () => {
  const mk = (id: string, iso: string, difficulty: Question["difficulty"], clueType: Question["clueType"]): Question => ({
    id, clueType, difficulty, prompt: id, answerIso: iso, acceptedIso: [iso],
  });
  // Only locate is available at easy & hard, so a full day must use two locates.
  const pool: Question[] = [
    mk("e1", "A", "easy", "locate"),
    mk("m1", "B", "medium", "capital"),
    mk("h1", "C", "hard", "locate"),
  ];
  const cal = assembleCalendar(pool, "2026-08-01", 1, 45, 9);
  assert.equal(cal.puzzles.length, 1);
  const types = cal.puzzles[0]!.questions.map((q) => q.clueType);
  assert.equal(types.filter((t) => t === "locate").length, 2, "two locates are allowed in one day");
});

test("expandTerritories accepts a country's dependencies — for EVERY accepted answer, not just answerIso", () => {
  const deps = { FRA: ["GUF", "NCL"], DNK: ["GRL"], USA: ["PRI"] };
  const onMap = new Set(["GUF", "NCL", "GRL", "PRI"]);
  const q = { answerIso: "ISL", acceptedIso: ["DNK", "ISL", "FRA"] } as never;
  const out = expandTerritories(q, deps, onMap);
  // Greenland must count on a multi-answer question that accepts Denmark, even though Denmark is
  // not the nominal answerIso. Before multi-answer content acceptedIso was always [answerIso], so
  // expanding only the answerIso happened to be equivalent; it no longer is.
  assert.deepEqual([...out.acceptedIso].sort(), ["DNK", "FRA", "GRL", "GUF", "ISL", "NCL"]);
  // USA is not an accepted answer, so Puerto Rico must not leak in.
  assert.ok(!out.acceptedIso.includes("PRI"));
  // The reveal shades only the real set members — not the territories that merely score as correct.
  assert.deepEqual(out.revealIso, ["DNK", "ISL", "FRA"]);
});

test("expandTerritories skips dependencies that aren't drawn on the map", () => {
  const q = { answerIso: "FRA", acceptedIso: ["FRA"] } as never;
  const out = expandTerritories(q, { FRA: ["GUF", "ATF"] }, new Set(["GUF"]));
  assert.deepEqual(out.acceptedIso, ["FRA", "GUF"]); // ATF isn't on the map
});

test("assembleCalendar spaces questions from the same family apart", () => {
  // Six questions all sliced from one fact, plus filler so days can be completed without them.
  const fam = Array.from({ length: 6 }, (_, i) => ({
    id: `opec-${i}`, clueType: "trivia", difficulty: "easy", prompt: `q${i}`,
    answerIso: "SAU", acceptedIso: ["SAU"], source: "curated:set", family: "opec",
  })) as unknown as Question[];
  // Varied clue types: a day needs three distinct-ish categories, so single-type filler would
  // stall the calendar on day one and hide what this test is actually checking.
  const TYPES = ["capital", "flag", "river", "language", "currency", "landmark"] as const;
  const filler = Array.from({ length: 1800 }, (_, i) => ({
    id: `f-${i}`, clueType: TYPES[i % TYPES.length], difficulty: (["easy", "medium", "hard"] as const)[i % 3],
    prompt: `f${i}`, answerIso: `X${i}`, acceptedIso: [`X${i}`],
  })) as unknown as Question[];
  const cal = assembleCalendar([...fam, ...filler], "2026-01-01", 300, 45, 1, []);
  const days: number[] = [];
  cal.puzzles.forEach((p, i) => { if (p.questions.some((q) => q.family === "opec")) days.push(i); });
  assert.ok(days.length >= 2, `expected several family members placed, got ${days.length}`);
  for (let i = 1; i < days.length; i++) {
    assert.ok(days[i]! - days[i - 1]! >= 60, `family questions ${days[i - 1]} and ${days[i]} are too close`);
  }
  // Never two from the same family on one day.
  for (const p of cal.puzzles) {
    assert.ok(p.questions.filter((q) => q.family === "opec").length <= 1);
  }
});

test("family spacing also governs the bonus slot", () => {
  // Bonus questions are drawn from a separate pool, so a family constrained in the mandatory three
  // could otherwise reappear as the next day's bonus.
  const bonus = Array.from({ length: 6 }, (_, i) => ({
    id: `b-${i}`, clueType: "anthem", difficulty: "hard", prompt: `b${i}`,
    answerIso: "SAU", acceptedIso: ["SAU"], family: "opec",
  })) as unknown as Question[];
  const TYPES = ["capital", "flag", "river", "language", "currency", "landmark"] as const;
  const filler = Array.from({ length: 1800 }, (_, i) => ({
    id: `f-${i}`, clueType: TYPES[i % TYPES.length], difficulty: (["easy", "medium", "hard"] as const)[i % 3],
    prompt: `f${i}`, answerIso: `X${i}`, acceptedIso: [`X${i}`],
  })) as unknown as Question[];
  const cal = assembleCalendar(filler, "2026-01-01", 300, 45, 1, bonus);
  const days: number[] = [];
  cal.puzzles.forEach((p, i) => { if (p.bonus?.family === "opec") days.push(i); });
  assert.ok(days.length >= 2, `expected several bonus family members, got ${days.length}`);
  for (let i = 1; i < days.length; i++) assert.ok(days[i]! - days[i - 1]! >= 60);
});
