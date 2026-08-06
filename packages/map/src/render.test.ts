import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STYLE, fillForTesting as fillFor } from "./render.ts";

const S = DEFAULT_STYLE;

test("fill colours reflect selection and reveal state", () => {
  assert.equal(fillFor("FRA", {}, S), S.land);
  assert.equal(fillFor("FRA", { selected: "FRA" }, S), S.selected);
  assert.equal(fillFor("FRA", { correct: "FRA", guess: "DEU" }, S), S.correct);
  assert.equal(fillFor("DEU", { correct: "FRA", guess: "DEU" }, S), S.wrong);
  assert.equal(fillFor("ESP", { correct: "FRA", guess: "DEU" }, S), S.land);
});

test("a multi-answer clue highlights EVERY accepted country, not just the canonical one", () => {
  // "One of the top 5 by X" accepts several answers, so all of them must read as correct.
  const state = { correct: ["FRA", "DEU", "ITA"], guess: "ESP" };
  for (const iso of ["FRA", "DEU", "ITA"]) assert.equal(fillFor(iso, state, S), S.correct, `${iso} should be green`);
  assert.equal(fillFor("ESP", state, S), S.wrong);
  assert.equal(fillFor("PRT", state, S), S.land);
});

test("guessing one of several accepted answers shows correct, not wrong", () => {
  // Regression: with a single `correct` the guess was painted wrong whenever it !== correct, so a
  // player who picked an accepted alternative saw red.
  const state = { correct: ["FRA", "DEU"], guess: "DEU" };
  assert.equal(fillFor("DEU", state, S), S.correct);
});

test("correct takes precedence over selection", () => {
  assert.equal(fillFor("FRA", { correct: ["FRA"], selected: "FRA" }, S), S.correct);
});
