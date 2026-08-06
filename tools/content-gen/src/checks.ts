// Pure content checks, split out of validate.ts so they can be unit-tested with synthetic
// calendars. A validator whose checks silently stop firing is worse than no validator — it turns
// "no issues found" from information into false confidence — so each one has a fault case in
// checks.test.ts.

import type { PuzzleCalendar, Question } from "@pinpoint/core";
import { clueCategory } from "./build.ts";

export type Level = "FAIL" | "WARN" | "INFO";
export interface Finding {
  level: Level;
  check: string;
  detail: string;
}

/** Fields the pipeline uses internally and must strip before a question ships. */
export const TRANSIENT_FIELDS = ["subject", "article", "bonusOnly", "hardness", "sitelinks"];

const flatten = (cal: PuzzleCalendar): Question[] =>
  cal.puzzles.flatMap((p) => [...p.questions, ...(p.bonus ? [p.bonus] : [])]);

/** ISO-2 code a flag emoji encodes, or null when it isn't a regional-indicator pair. */
export function flagAssetCode(emoji: string | undefined): string | null {
  const cps = [...(emoji ?? "")].map((c) => c.codePointAt(0) ?? 0);
  if (cps.length !== 2 || !cps.every((c) => c >= 0x1f1e6 && c <= 0x1f1ff)) return null;
  return cps.map((c) => String.fromCharCode(c - 0x1f1e6 + 97)).join("");
}

export interface StructuralOptions {
  /** Every ISO drawn on the map — an answer that isn't drawn cannot be tapped. */
  onMap: Set<string>;
  /** Does the flag SVG for this ISO-2 code exist? Injected so the check is testable offline. */
  flagExists: (cc: string) => boolean;
  /** Today's date key, injected so tests aren't time-dependent. */
  today: string;
}

/**
 * Invariants we would otherwise re-verify by hand after every regeneration. Several exist because
 * the bug actually happened: an untappable answer (Vatican City renders 0.3px wide), transient
 * fields leaking into the shipped JSON, prompts starting lower-case.
 */
export function structuralChecks(cal: PuzzleCalendar, opts: StructuralOptions): Finding[] {
  const out: Finding[] = [];
  const days = cal.puzzles;
  const shipped = flatten(cal);
  const fail = (check: string, offenders: string[], level: Level = "FAIL", show = 6) => {
    if (offenders.length) {
      out.push({ level, check, detail: `${offenders.length} — e.g. ${offenders.slice(0, show).join(" | ")}` });
    }
  };

  fail("every day has 3 questions", days.filter((p) => p.questions.length !== 3).map((p) => p.date));
  fail(
    "difficulty order easy->medium->hard",
    days.filter((p) => p.questions.map((q) => q.difficulty).join() !== "easy,medium,hard").map((p) => p.date),
  );
  fail("every day has a bonus", days.filter((p) => !p.bonus).map((p) => p.date), "WARN");

  const ids = shipped.map((q) => q.id);
  fail("no duplicate question ids", [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]);

  fail(
    "no repeated answer country within a day",
    days
      .filter((p) => {
        const a = [...p.questions, ...(p.bonus ? [p.bonus] : [])].map((q) => q.answerIso);
        return new Set(a).size !== a.length;
      })
      .map((p) => p.date),
  );

  fail(
    "every answer is a country on the map",
    shipped.filter((q) => !opts.onMap.has(q.answerIso)).map((q) => `${q.answerIso} (${q.id})`),
  );
  fail(
    "every acceptedIso is on the map",
    shipped.flatMap((q) => q.acceptedIso.filter((i) => !opts.onMap.has(i)).map((i) => `${i} (${q.id})`)),
  );

  fail(
    "no internal fields leaked into shipped JSON",
    shipped.flatMap((q) => TRANSIENT_FIELDS.filter((k) => k in q).map((k) => `${k} on ${q.id}`)),
  );

  fail("prompts start with a capital", shipped.filter((q) => /^[a-z]/.test(q.prompt)).map((q) => q.prompt.slice(0, 40)));
  fail("timeSensitive questions carry asOf", shipped.filter((q) => q.timeSensitive && !q.asOf).map((q) => q.id), "WARN");

  fail(
    "flag questions have their SVG asset",
    shipped
      .filter((q) => q.clueType === "flag")
      .flatMap((q) => {
        const cc = flagAssetCode(q.emoji);
        return !cc || opts.flagExists(cc) ? [] : [`${q.answerIso} -> ${cc}.svg`];
      }),
  );

  fail(
    "per-day category rule (<=1 person, <=2 per category)",
    days
      .filter((p) => {
        const counts: Record<string, number> = {};
        for (const q of p.questions) {
          const c = clueCategory(q.clueType);
          counts[c] = (counts[c] ?? 0) + 1;
        }
        return (counts.person ?? 0) > 1 || Math.max(0, ...Object.values(counts)) > 2;
      })
      .map((p) => p.date),
  );

  fail(
    "dates are contiguous",
    days
      .filter((p, i) => {
        if (i === 0) return false;
        const prev = new Date(`${days[i - 1]!.date}T00:00:00Z`).getTime();
        return (new Date(`${p.date}T00:00:00Z`).getTime() - prev) / 86_400_000 !== 1;
      })
      .map((p) => p.date),
  );

  // The game silently breaks once the calendar runs out (it falls back to day 1 forever), so this
  // is the early warning rather than a post-mortem.
  const last = days.at(-1)?.date ?? "";
  const daysLeft = last
    ? Math.round((new Date(`${last}T00:00:00Z`).getTime() - new Date(`${opts.today}T00:00:00Z`).getTime()) / 86_400_000)
    : 0;
  if (!days.some((p) => p.date === opts.today)) {
    out.push({ level: "FAIL", check: "calendar covers today", detail: `today is ${opts.today}; calendar runs ${days[0]?.date} to ${last}` });
  } else if (daysLeft < 60) {
    out.push({ level: "FAIL", check: "calendar runway", detail: `only ${daysLeft} days left (ends ${last}) — regenerate` });
  } else if (daysLeft < 180) {
    out.push({ level: "WARN", check: "calendar runway", detail: `${daysLeft} days left (ends ${last})` });
  }

  return out;
}

export interface Drift {
  /** The clue still generates but now resolves to a DIFFERENT country — the fact changed. */
  changed: { question: Question; from: string; to: string }[];
  /** The clue is no longer produced: value became ambiguous, fell below a floor, or left the source. */
  vanished: Question[];
}

/**
 * Diff shipped questions against a freshly built candidate pool.
 *
 * Ids are `${clueType}-${slug(value)}-${iso}`, so the part before the last dash identifies the CLUE
 * and the suffix its answer. A changed answer therefore appears as a live prefix pointing somewhere
 * new — which is precisely the case that must not be misreported as "vanished", since a changed
 * answer means we are shipping a WRONG question rather than merely a missing one.
 */
export function diffDrift(shipped: Question[], fresh: Question[]): Drift {
  const liveIds = new Set(fresh.map((q) => q.id));
  const answerByPrefix = new Map<string, string>();
  for (const q of fresh) answerByPrefix.set(q.id.slice(0, q.id.lastIndexOf("-")), q.answerIso);

  const drift: Drift = { changed: [], vanished: [] };
  for (const q of shipped) {
    if (liveIds.has(q.id)) continue;
    const to = answerByPrefix.get(q.id.slice(0, q.id.lastIndexOf("-")));
    if (to) drift.changed.push({ question: q, from: q.answerIso, to });
    else drift.vanished.push(q);
  }
  return drift;
}
