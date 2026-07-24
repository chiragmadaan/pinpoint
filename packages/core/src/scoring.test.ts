import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SCORE_CONFIG, scoreGuess, scoreMultiSelect } from "./scoring.ts";
import { recordCompletedDay, emptyPlayerState } from "./daily.ts";
import type { Question } from "./types.ts";

const q: Question = {
  id: "q1",
  clueType: "capital",
  difficulty: "medium",
  prompt: "Country whose capital is Paris",
  answerIso: "FRA",
  acceptedIso: ["FRA"],
};
const adjacency = { FRA: ["ESP", "DEU", "ITA", "BEL", "CHE"] };

test("correct guess earns base + speed bonus", () => {
  const r = scoreGuess(q, "FRA", 0, adjacency);
  assert.equal(r.verdict, "correct");
  assert.equal(r.points, DEFAULT_SCORE_CONFIG.base + DEFAULT_SCORE_CONFIG.maxSpeedBonus);
});

test("neighbor guess earns partial credit, no speed bonus", () => {
  const r = scoreGuess(q, "ESP", 0, adjacency);
  assert.equal(r.verdict, "neighbor");
  assert.equal(r.points, 500);
});

test("far guess earns nothing", () => {
  const r = scoreGuess(q, "JPN", 0, adjacency);
  assert.equal(r.verdict, "wrong");
  assert.equal(r.points, 0);
});

test("multi-select: exact match = full, subset = partial, extras dilute, none = wrong", () => {
  const accepted = ["IND", "BGD"];
  const base = DEFAULT_SCORE_CONFIG.base;
  assert.deepEqual(scoreMultiSelect(accepted, ["IND", "BGD"]).verdict, "correct");
  assert.equal(scoreMultiSelect(accepted, ["IND", "BGD"]).points, base);
  assert.equal(scoreMultiSelect(accepted, ["BGD"]).verdict, "partial");
  assert.equal(scoreMultiSelect(accepted, ["BGD"]).points, Math.round(base * 0.5));
  assert.equal(scoreMultiSelect(accepted, ["BGD", "PAK"]).points, Math.round(base / 3)); // 1 of 3 union
  assert.equal(scoreMultiSelect(accepted, ["PAK"]).verdict, "wrong");
});

test("streak continues on consecutive local days, resets on a gap", () => {
  let s = emptyPlayerState();
  s = recordCompletedDay(s, "2026-07-24", ["correct", "wrong", "correct"], 2000);
  assert.equal(s.streak, 1);
  s = recordCompletedDay(s, "2026-07-25", ["correct", "correct", "correct"], 3000);
  assert.equal(s.streak, 2);
  s = recordCompletedDay(s, "2026-07-28", ["wrong", "wrong", "wrong"], 0); // 2-day gap
  assert.equal(s.streak, 1);
  assert.equal(s.xp, 5000);
});
