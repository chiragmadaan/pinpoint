import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "@pinpoint/core";
import {
  assembleCalendar,
  assignDifficulty,
  buildUniqueValue,
  computeObscurity,
  flagEmoji,
} from "./build.ts";

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

test("assignDifficulty splits candidates into easy/medium/hard terciles", () => {
  const countries = [
    { iso: "A", name: "A", sitelinks: 300 },
    { iso: "B", name: "B", sitelinks: 200 },
    { iso: "C", name: "C", sitelinks: 100 },
  ];
  const obscurity = computeObscurity(countries);
  const cands = ["A", "B", "C"].map((iso) => ({
    id: `locate-${iso}`,
    clueType: "locate" as const,
    prompt: `Locate ${iso}`,
    answerIso: iso,
    acceptedIso: [iso],
  }));
  const qs = assignDifficulty(cands, obscurity);
  const byIso = Object.fromEntries(qs.map((q) => [q.answerIso, q.difficulty]));
  assert.equal(byIso.A, "easy"); // most sitelinks -> least obscure -> easiest
  assert.equal(byIso.C, "hard");
});

test("assembleCalendar: no reused questions, distinct countries per day", () => {
  const mk = (id: string, iso: string, difficulty: Question["difficulty"]): Question => ({
    id, clueType: "locate", difficulty, prompt: id, answerIso: iso, acceptedIso: [iso],
  });
  const pool: Question[] = [
    mk("e1", "A", "easy"), mk("e2", "B", "easy"), mk("e3", "C", "easy"),
    mk("m1", "D", "medium"), mk("m2", "E", "medium"), mk("m3", "F", "medium"),
    mk("h1", "G", "hard"), mk("h2", "H", "hard"), mk("h3", "I", "hard"),
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
