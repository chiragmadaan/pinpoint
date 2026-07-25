import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advance,
  currentQuestion,
  isBonusQuestion,
  isComplete,
  selectCountry,
  sessionVerdicts,
  sessionXp,
  startSession,
  submitGuess,
  timeUp,
} from "./game.ts";
import type { DailyPuzzle } from "./types.ts";

const puzzle: DailyPuzzle = {
  date: "2026-08-01",
  questions: [
    { id: "e", clueType: "locate", difficulty: "easy", prompt: "Locate France", answerIso: "FRA", acceptedIso: ["FRA"] },
    { id: "m", clueType: "capital", difficulty: "medium", prompt: "Capital is Tokyo?", answerIso: "JPN", acceptedIso: ["JPN"] },
    { id: "h", clueType: "nickname", difficulty: "hard", prompt: "Pirate Republic?", answerIso: "BHS", acceptedIso: ["BHS"] },
  ],
};
const adjacency = { FRA: ["ESP"], JPN: [], BHS: [] };

test("full 3-question session: phases, staggered xp, verdicts", () => {
  let s = startSession(puzzle);
  assert.equal(currentQuestion(s)?.id, "e");

  s = submitGuess(selectCountry(s, "FRA"), adjacency); // Q1 easy correct -> 250
  assert.equal(s.phase, "revealed");
  s = advance(s);
  assert.equal(currentQuestion(s)?.id, "m");

  s = submitGuess(selectCountry(s, "CHN"), adjacency); // Q2 wrong -> 0
  s = advance(s);

  s = submitGuess(selectCountry(s, "BHS"), adjacency); // Q3 hard correct -> 750
  s = advance(s);

  assert.ok(isComplete(s));
  assert.deepEqual(sessionVerdicts(s), ["correct", "wrong", "correct"]);
  assert.equal(sessionXp(s), 200 + 0 + 600);
});

test("bonus unlocks only after acing all 3 mandatory questions", () => {
  const bonus = { id: "b", clueType: "tld" as const, difficulty: "hard" as const, prompt: "bonus", answerIso: "NZL", acceptedIso: ["NZL"] };
  const withBonus = { ...puzzle, bonus };

  let s = startSession(withBonus);
  s = advance(submitGuess(selectCountry(s, "FRA"), adjacency)); // Q1 correct
  s = advance(submitGuess(selectCountry(s, "JPN"), adjacency)); // Q2 correct
  s = submitGuess(selectCountry(s, "BHS"), adjacency); // Q3 correct
  s = advance(s);
  assert.ok(isBonusQuestion(s));
  assert.equal(currentQuestion(s)?.id, "b");
  s = advance(submitGuess(selectCountry(s, "NZL"), adjacency));
  assert.ok(isComplete(s));

  let s2 = startSession(withBonus);
  s2 = advance(submitGuess(selectCountry(s2, "CHN"), adjacency)); // Q1 wrong
  s2 = advance(submitGuess(selectCountry(s2, "JPN"), adjacency));
  s2 = advance(submitGuess(selectCountry(s2, "BHS"), adjacency)); // Q3 revealed -> advance
  assert.ok(isComplete(s2));
  assert.ok(!isBonusQuestion(s2));
});

test("timeUp records a miss when nothing selected, else submits the selection", () => {
  let s = startSession(puzzle);
  s = timeUp(s, adjacency); // no selection -> miss
  assert.equal(s.phase, "revealed");
  assert.equal(s.results.at(-1)!.verdict, "wrong");
  assert.equal(s.results.at(-1)!.guessIso, "");
  const s2 = timeUp(selectCountry(startSession(puzzle), "FRA"), adjacency); // FRA is Q1's answer
  assert.equal(s2.results.at(-1)!.verdict, "correct");
});

test("select/submit are ignored outside the question phase", () => {
  let s = startSession(puzzle);
  s = submitGuess(s, adjacency); // nothing selected -> no-op
  assert.equal(s.phase, "question");
  s = submitGuess(selectCountry(s, "FRA"), adjacency); // now revealed
  const afterReveal = selectCountry(s, "DEU"); // ignored in reveal phase
  assert.equal(afterReveal.selected, "FRA");
});
