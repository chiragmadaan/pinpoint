import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advance,
  currentQuestion,
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
