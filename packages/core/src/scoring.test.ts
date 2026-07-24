import assert from "node:assert/strict";
import { test } from "node:test";
import { DIFFICULTY_XP, scoreGuess, scoreMultiSelect } from "./scoring.ts";
import { recordCompletedDay, emptyPlayerState } from "./daily.ts";
import { latestTrophy, levelForXp, trophiesEarned, trophiesUnlockedBetween, xpToClearLevel } from "./levels.ts";
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

test("correct guess earns the full staggered difficulty XP", () => {
  assert.equal(scoreGuess(q, "FRA", adjacency).verdict, "correct");
  assert.equal(scoreGuess(q, "FRA", adjacency).points, DIFFICULTY_XP.medium); // 400
  assert.equal(scoreGuess({ ...q, difficulty: "easy" }, "FRA", adjacency).points, 200);
  assert.equal(scoreGuess({ ...q, difficulty: "hard" }, "FRA", adjacency).points, 600);
});

test("neighbor guess is recognized but earns 0 points by default", () => {
  const r = scoreGuess(q, "ESP", adjacency);
  assert.equal(r.verdict, "neighbor");
  assert.equal(r.points, 0);
});

test("far guess earns nothing", () => {
  const r = scoreGuess(q, "JPN", adjacency);
  assert.equal(r.verdict, "wrong");
  assert.equal(r.points, 0);
});

test("multi-select: exact match = full, subset = partial, extras dilute, none = wrong", () => {
  const accepted = ["IND", "BGD"];
  assert.equal(scoreMultiSelect(accepted, ["IND", "BGD"], "hard").verdict, "correct");
  assert.equal(scoreMultiSelect(accepted, ["IND", "BGD"], "hard").points, DIFFICULTY_XP.hard);
  assert.equal(scoreMultiSelect(accepted, ["BGD"], "hard").points, Math.round(DIFFICULTY_XP.hard * 0.5));
  assert.equal(scoreMultiSelect(accepted, ["BGD", "PAK"], "hard").points, Math.round(DIFFICULTY_XP.hard / 3));
  assert.equal(scoreMultiSelect(accepted, ["PAK"], "hard").verdict, "wrong");
});

test("streak continues on consecutive local days, resets on a gap", () => {
  let s = emptyPlayerState();
  s = recordCompletedDay(s, "2026-07-24", ["correct", "wrong", "correct"], 1000);
  assert.equal(s.streak, 1);
  s = recordCompletedDay(s, "2026-07-25", ["correct", "correct", "correct"], 1500);
  assert.equal(s.streak, 2);
  s = recordCompletedDay(s, "2026-07-28", ["wrong", "wrong", "wrong"], 0); // 2-day gap
  assert.equal(s.streak, 1);
  assert.equal(s.xp, 2500);
});

test("leveling: starts at level 1, fills and rolls over per the curve", () => {
  assert.equal(xpToClearLevel(1), 1000);
  assert.equal(xpToClearLevel(2), 1500);

  const l0 = levelForXp(0);
  assert.equal(l0.level, 1);
  assert.equal(l0.progress, 0);

  const l999 = levelForXp(999);
  assert.equal(l999.level, 1);
  assert.equal(l999.xpIntoLevel, 999);

  const l1000 = levelForXp(1000);
  assert.equal(l1000.level, 2);
  assert.equal(l1000.xpIntoLevel, 0);
  assert.equal(l1000.xpForNext, 1500);

  const l2500 = levelForXp(2500); // clears L1 (1000) + L2 (1500)
  assert.equal(l2500.level, 3);
  assert.equal(l2500.xpIntoLevel, 0);
});

test("trophies unlock at level thresholds and accumulate", () => {
  assert.equal(latestTrophy(1)?.name, "Noob"); // everyone starts as a Noob
  assert.equal(latestTrophy(2)?.name, "Noob");
  assert.equal(latestTrophy(3)?.name, "Wanderer");
  assert.equal(latestTrophy(5)?.name, "Explorer");
  assert.equal(latestTrophy(50)?.name, "Legend");
  assert.equal(trophiesEarned(1).length, 1); // just Noob
  assert.deepEqual(trophiesUnlockedBetween(1, 5).map((t) => t.name), ["Wanderer", "Explorer"]);
});
