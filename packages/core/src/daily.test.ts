import assert from "node:assert/strict";
import { test } from "node:test";
import { currentStreak, emptyPlayerState, recordCompletedDay } from "./daily.ts";

const win: [string, string, string] = ["correct", "correct", "correct"];

test("currentStreak: a fresh player has no streak", () => {
  assert.equal(currentStreak(emptyPlayerState(), "2026-07-30"), 0);
});

test("currentStreak: shows the stored streak on a day you've already played", () => {
  let s = emptyPlayerState();
  s = recordCompletedDay(s, "2026-07-29", win, 1000);
  s = recordCompletedDay(s, "2026-07-30", win, 1000);
  assert.equal(s.streak, 2);
  assert.equal(currentStreak(s, "2026-07-30"), 2);
});

test("currentStreak: still alive the day after your last play (continuable today)", () => {
  let s = emptyPlayerState();
  s = recordCompletedDay(s, "2026-07-29", win, 1000);
  assert.equal(currentStreak(s, "2026-07-30"), 1);
});

test("currentStreak: a missed day breaks it immediately, before you play again", () => {
  let s = emptyPlayerState();
  s = recordCompletedDay(s, "2026-07-24", win, 1000);
  s = recordCompletedDay(s, "2026-07-25", win, 1000);
  assert.equal(s.streak, 2); // stored value is stale after the gap...
  assert.equal(currentStreak(s, "2026-07-28"), 0); // ...but the effective streak is already 0
});
