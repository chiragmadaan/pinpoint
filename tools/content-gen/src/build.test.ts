import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "@pinpoint/core";
import {
  assembleCalendar,
  assignDifficulty,
  buildUniqueValue,
  canonicalizeLanguage,
  computeObscurity,
  flagEmoji,
  isSensitiveText,
  leaksCountryName,
} from "./build.ts";

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

test("assembleCalendar balances person questions into the scarce-non-person tier to maximize days", () => {
  const mk = (id: string, iso: string, difficulty: Question["difficulty"], clueType: Question["clueType"]): Question => ({
    id, clueType, difficulty, prompt: id, answerIso: iso, acceptedIso: [iso],
  });
  // Non-person is the scarce resource: easy has 2 (locate), medium 5 (capital), hard 2 (flag);
  // person (nationality) is abundant in easy & hard. Max days with ≤1 person/day = 4, but only if
  // the person question is spent in whichever tier's non-person is scarcest that day.
  const pool: Question[] = [
    ...[1, 2, 3, 4, 5].map((i) => mk(`ep${i}`, `EP${i}`, "easy", "nationality")),
    mk("en1", "EN1", "easy", "locate"), mk("en2", "EN2", "easy", "locate"),
    ...[1, 2, 3, 4, 5].map((i) => mk(`mn${i}`, `MN${i}`, "medium", "capital")),
    mk("mp1", "MP1", "medium", "nationality"),
    mk("hn1", "HN1", "hard", "flag"), mk("hn2", "HN2", "hard", "flag"),
    ...[1, 2, 3, 4, 5].map((i) => mk(`hp${i}`, `HP${i}`, "hard", "nationality")),
  ];
  const cal = assembleCalendar(pool, "2026-08-01", 10, 45, 9);
  assert.equal(cal.puzzles.length, 4, "person-placement balancing should reach the 4-day maximum");
  for (const p of cal.puzzles) {
    const persons = p.questions.filter((q) => q.clueType === "nationality").length;
    assert.ok(persons <= 1, "at most one person question per day");
    assert.equal(new Set(p.questions.map((q) => q.answerIso)).size, 3, "distinct countries per day");
  }
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
