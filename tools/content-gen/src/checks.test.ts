import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyPuzzle, PuzzleCalendar, Question } from "@pinpoint/core";
import { diffDrift, flagAssetCode, leakPolicyChecks, structuralChecks, type StructuralOptions } from "./checks.ts";

const TODAY = "2026-08-01";
const OPTS: StructuralOptions = { onMap: new Set(["AAA", "BBB", "CCC", "DDD"]), flagExists: () => true, today: TODAY };

const q = (over: Partial<Question> = {}): Question => ({
  id: over.id ?? `locate-x-${over.answerIso ?? "AAA"}`,
  clueType: "locate",
  difficulty: "easy",
  prompt: "Locate somewhere",
  answerIso: "AAA",
  acceptedIso: [over.answerIso ?? "AAA"],
  ...over,
});

/** A clean calendar of `n` contiguous days starting today: distinct countries, categories, ids. */
function calendar(n: number, mutate: (day: DailyPuzzle, i: number) => void = () => {}): PuzzleCalendar {
  const isos = ["AAA", "BBB", "CCC", "DDD"];
  const puzzles: DailyPuzzle[] = [];
  const d0 = new Date(`${TODAY}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const date = new Date(d0.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const day: DailyPuzzle = {
      date,
      questions: [
        q({ id: `locate-a${i}-AAA`, answerIso: "AAA", acceptedIso: ["AAA"], difficulty: "easy", clueType: "locate" }),
        q({ id: `capital-b${i}-BBB`, answerIso: "BBB", acceptedIso: ["BBB"], difficulty: "medium", clueType: "capital" }),
        q({ id: `flag-c${i}-CCC`, answerIso: "CCC", acceptedIso: ["CCC"], difficulty: "hard", clueType: "flag" }),
      ],
      bonus: q({ id: `tld-d${i}-DDD`, answerIso: "DDD", acceptedIso: ["DDD"], difficulty: "hard", clueType: "tld" }),
    };
    mutate(day, i);
    puzzles.push(day);
  }
  return { version: 1, puzzles };
}

const names = (f: { check: string }[]) => f.map((x) => x.check);

test("a well-formed calendar produces no findings", () => {
  assert.deepEqual(structuralChecks(calendar(400), OPTS), []);
});

test("catches a day without exactly 3 questions", () => {
  const cal = calendar(400, (d, i) => { if (i === 3) d.questions = d.questions.slice(0, 2) as never; });
  assert.ok(names(structuralChecks(cal, OPTS)).includes("every day has 3 questions"));
});

test("catches a wrong difficulty order", () => {
  const cal = calendar(400, (d, i) => { if (i === 2) d.questions.reverse(); });
  assert.ok(names(structuralChecks(cal, OPTS)).includes("difficulty order easy->medium->hard"));
});

test("warns on a missing bonus", () => {
  const cal = calendar(400, (d, i) => { if (i === 5) delete d.bonus; });
  const f = structuralChecks(cal, OPTS).find((x) => x.check === "every day has a bonus");
  assert.equal(f?.level, "WARN");
});

test("catches duplicate question ids", () => {
  const cal = calendar(400, (d, i) => { if (i === 4) d.questions[1]!.id = d.questions[0]!.id; });
  assert.ok(names(structuralChecks(cal, OPTS)).includes("no duplicate question ids"));
});

test("catches the same answer country twice in one day", () => {
  const cal = calendar(400, (d, i) => { if (i === 6) d.questions[1]!.answerIso = "AAA"; });
  assert.ok(names(structuralChecks(cal, OPTS)).includes("no repeated answer country within a day"));
});

test("catches an answer that is not drawn on the map (untappable)", () => {
  // The real case: "In which country is Vatican City?" -> VAT, which renders 0.3px wide.
  const cal = calendar(400, (d, i) => { if (i === 1) d.questions[0]!.answerIso = "VAT"; });
  assert.ok(names(structuralChecks(cal, OPTS)).includes("every answer is a country on the map"));
});

test("catches an acceptedIso that is not on the map", () => {
  const cal = calendar(400, (d, i) => { if (i === 1) d.questions[0]!.acceptedIso = ["AAA", "ZZZ"]; });
  assert.ok(names(structuralChecks(cal, OPTS)).includes("every acceptedIso is on the map"));
});

test("catches transient internal fields leaking into shipped JSON", () => {
  for (const field of ["subject", "article", "bonusOnly", "hardness", "sitelinks"]) {
    const cal = calendar(400, (d, i) => { if (i === 0) (d.questions[0] as Record<string, unknown>)[field] = "x"; });
    assert.ok(
      names(structuralChecks(cal, OPTS)).includes("no internal fields leaked into shipped JSON"),
      `${field} should be flagged`,
    );
  }
});

test("catches a lowercase prompt", () => {
  const cal = calendar(400, (d, i) => { if (i === 7) d.questions[0]!.prompt = "haori is traditional dress where?"; });
  assert.ok(names(structuralChecks(cal, OPTS)).includes("prompts start with a capital"));
});

test("warns when a timeSensitive question has no asOf", () => {
  const cal = calendar(400, (d, i) => { if (i === 0) d.questions[0]!.timeSensitive = true; });
  const f = structuralChecks(cal, OPTS).find((x) => x.check === "timeSensitive questions carry asOf");
  assert.equal(f?.level, "WARN");
});

test("catches a flag question whose SVG is missing", () => {
  const cal = calendar(400, (d, i) => { if (i === 0) d.questions[2]!.emoji = "\u{1F1EF}\u{1F1F5}"; });
  const opts = { ...OPTS, flagExists: () => false };
  assert.ok(names(structuralChecks(cal, opts)).includes("flag questions have their SVG asset"));
  // ...and passes when the asset is present.
  assert.ok(!names(structuralChecks(cal, OPTS)).includes("flag questions have their SVG asset"));
});

test("catches two person questions in one day", () => {
  const cal = calendar(400, (d, i) => {
    if (i !== 0) return;
    d.questions[0]!.clueType = "birthplace";
    d.questions[1]!.clueType = "nationality"; // different clue types, same "person" category
  });
  assert.ok(names(structuralChecks(cal, OPTS)).includes("per-day category rule (<=1 person, <=2 per category)"));
});

test("catches a gap in the date sequence", () => {
  const cal = calendar(400);
  cal.puzzles.splice(10, 1);
  assert.ok(names(structuralChecks(cal, OPTS)).includes("dates are contiguous"));
});

test("calendar runway: fails when nearly exhausted, warns when short, silent when healthy", () => {
  assert.ok(names(structuralChecks(calendar(30), OPTS)).includes("calendar runway")); // <60 days
  const short = structuralChecks(calendar(120), OPTS).find((x) => x.check === "calendar runway");
  assert.equal(short?.level, "WARN"); // <180 days
  assert.ok(!names(structuralChecks(calendar(400), OPTS)).includes("calendar runway"));
});

test("catches a calendar that no longer covers today", () => {
  const cal = calendar(400);
  cal.puzzles = cal.puzzles.slice(5); // starts in the future
  assert.ok(names(structuralChecks(cal, OPTS)).includes("calendar covers today"));
});

test("flagAssetCode decodes a flag emoji, and rejects anything else", () => {
  assert.equal(flagAssetCode("\u{1F1EF}\u{1F1F5}"), "jp");
  assert.equal(flagAssetCode("\u{1F1EB}\u{1F1F7}"), "fr");
  assert.equal(flagAssetCode("x"), null);
  assert.equal(flagAssetCode(undefined), null);
});

test("diffDrift separates a CHANGED answer from one that vanished", () => {
  const shipped = [
    q({ id: "capital-lisbon-PRT", answerIso: "PRT" }), // still generated -> not drift
    q({ id: "capital-astana-KAZ", answerIso: "KAZ" }), // renamed country -> answer changed
    q({ id: "language-xyz-AAA", answerIso: "AAA" }), // became ambiguous -> gone entirely
  ];
  const fresh = [
    q({ id: "capital-lisbon-PRT", answerIso: "PRT" }),
    q({ id: "capital-astana-BBB", answerIso: "BBB" }), // same clue, different answer
  ];
  const d = diffDrift(shipped, fresh);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0]!.from, "KAZ");
  assert.equal(d.changed[0]!.to, "BBB");
  assert.deepEqual(d.vanished.map((x) => x.id), ["language-xyz-AAA"]);
});

test("diffDrift reports nothing when the pool is unchanged", () => {
  const shipped = [q({ id: "capital-lisbon-PRT", answerIso: "PRT" })];
  assert.deepEqual(diffDrift(shipped, [...shipped]), { changed: [], vanished: [] });
});

test("leakPolicyChecks asserts the TIERING, not the presence of a leak", () => {
  const mk = (prompt: string, difficulty: Question["difficulty"], iso = "AAA") =>
    q({ id: `festival-${prompt}-${iso}`, prompt, difficulty, answerIso: iso, clueType: "festival" });
  const fame: Record<string, number> = { Bigcity: 2_000_000, Midcity: 500_000, Smalltown: 50_000 };
  const input = {
    bonus: [],
    leakedPlace: (x: Question) => Object.keys(fame).find((p) => x.prompt.includes(p)) ?? null,
    fameOf: (p: string) => fame[p] ?? 0,
    resembles: () => false,
  };

  // A household-name city makes the question easy — flagged when it isn't.
  const bad = leakPolicyChecks({ ...input, main: [mk("Bigcity Festival", "hard")] });
  assert.deepEqual(bad.map((f) => f.check), ["famous-place leaks are tiered easy"]);
  assert.deepEqual(leakPolicyChecks({ ...input, main: [mk("Bigcity Festival", "easy")] }), []);

  // An obscure city is high-variance regional knowledge -> belongs in bonus, not the main three.
  const obscure = leakPolicyChecks({ ...input, main: [mk("Smalltown Festival", "hard")] });
  assert.deepEqual(obscure.map((f) => f.check), ["obscure-place leaks are routed to bonus"]);

  // A partial hint keeps its natural difficulty — no finding either way.
  assert.deepEqual(leakPolicyChecks({ ...input, main: [mk("Midcity Festival", "hard")] }), []);
  // No leak at all -> nothing to say.
  assert.deepEqual(leakPolicyChecks({ ...input, main: [mk("Unrelated Festival", "hard")] }), []);
});

test("a place sharing its country's name is a giveaway regardless of how obscure it is", () => {
  // "Casbah of Algiers" -> Algeria: needs no geography, the answer is spelled in the clue.
  const main = [q({ id: "landmark-casbah-DZA", prompt: "In which country is Casbah of Algiers?", difficulty: "hard", answerIso: "DZA", clueType: "landmark" })];
  const f = leakPolicyChecks({
    main,
    bonus: [],
    leakedPlace: () => "Algiers",
    fameOf: () => 522_403, // only a "partial hint" on fame alone
    resembles: () => true, // ...but the name gives it away outright
  });
  assert.deepEqual(f.map((x) => x.check), ["famous-place leaks are tiered easy"]);
});
