import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyPuzzle, PuzzleCalendar } from "./types.ts";
import { currentStreak, dateKey, emptyPlayerState, hasCompleted, recordCompletedDay, todaysPuzzle } from "./daily.ts";

const win: [string, string, string] = ["correct", "correct", "correct"];

// --- calendar exhaustion -----------------------------------------------------------------------
// Running out of content must degrade, not brick. Before this, `todaysPuzzle` returned null past
// the last day and the app fell back to puzzles[0] — whose date is in the PAST, so `hasCompleted`
// reported it done and every player (returning AND new) saw "Come back tomorrow!" permanently.

const mkCal = (n: number, start = "2026-01-01"): PuzzleCalendar => {
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  return {
    version: 1,
    puzzles: Array.from({ length: n }, (_, i) => {
      const dt = new Date(y, m - 1, d + i);
      return {
        date: dateKey(dt),
        questions: [
          { id: `q${i}a`, clueType: "locate", difficulty: "easy", prompt: `day ${i} easy`, answerIso: "AAA", acceptedIso: ["AAA"] },
          { id: `q${i}b`, clueType: "capital", difficulty: "medium", prompt: `day ${i} med`, answerIso: "BBB", acceptedIso: ["BBB"] },
          { id: `q${i}c`, clueType: "flag", difficulty: "hard", prompt: `day ${i} hard`, answerIso: "CCC", acceptedIso: ["CCC"] },
        ],
      } as DailyPuzzle;
    }),
  };
};

test("todaysPuzzle returns the exact day while the calendar covers it", () => {
  const cal = mkCal(10);
  const p = todaysPuzzle(cal, new Date(2026, 0, 4));
  assert.equal(p?.date, "2026-01-04");
  assert.equal(p?.questions[0]!.prompt, "day 3 easy");
});

test("past the end, the calendar wraps instead of returning null", () => {
  const cal = mkCal(10); // 2026-01-01 .. 2026-01-10
  const p = todaysPuzzle(cal, new Date(2026, 0, 11)); // first day past the end
  assert.ok(p, "must not be null — null is what bricked the game");
  assert.equal(p!.questions[0]!.prompt, "day 0 easy"); // wrapped to the start
});

test("a wrapped puzzle is re-dated to TODAY, so streaks and history keep working", () => {
  // This is the crux: reusing day 1's content is fine, reusing its DATE is what broke everything.
  const cal = mkCal(10);
  const p = todaysPuzzle(cal, new Date(2026, 0, 25))!;
  assert.equal(p.date, "2026-01-25");

  // A player who finished the original day 1 must still be able to play the wrapped one.
  let s = recordCompletedDay(emptyPlayerState(), "2026-01-01", ["correct", "correct", "correct"], 100);
  assert.equal(hasCompleted(s, p.date), false);
  s = recordCompletedDay(s, p.date, ["correct", "correct", "correct"], 100);
  assert.equal(hasCompleted(s, p.date), true);
});

test("wrapping keeps cycling rather than sticking on one day", () => {
  const cal = mkCal(10);
  const seen = [11, 12, 13, 21, 22].map((day) => todaysPuzzle(cal, new Date(2026, 0, day))!.questions[0]!.prompt);
  assert.deepEqual(seen, ["day 0 easy", "day 1 easy", "day 2 easy", "day 0 easy", "day 1 easy"]);
});

test("a date before the calendar starts also resolves, dated today", () => {
  const cal = mkCal(10, "2026-06-01");
  const p = todaysPuzzle(cal, new Date(2026, 0, 5));
  assert.ok(p);
  assert.equal(p!.date, "2026-01-05");
});

test("an empty calendar is still null (nothing to serve)", () => {
  assert.equal(todaysPuzzle({ version: 1, puzzles: [] }, new Date(2026, 0, 1)), null);
});

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
