// Content validation for the shipped calendar. REPORT ONLY — always exits 0.
//
//   pnpm validate                       structural checks only (no network, ~1s)
//   PINPOINT_NO_CACHE=1 pnpm validate --drift    also re-fetch every source and diff (~20 min)
//
// Two independent passes:
//   1. STRUCTURE — invariants we would otherwise re-check by hand after every regeneration. Several
//      of these exist because the bug actually happened: an untappable answer (Vatican City at
//      0.3px), transient fields leaking into shipped JSON, a clue naming a city in its own answer
//      country ("Tokyo International Film Festival" -> Japan).
//   2. DRIFT — rebuild the candidate pool from source and compare. Question ids encode
//      `${clueType}-${slug(value)}-${iso}`, so an answer that has changed shows up as a live
//      `clueType-value` prefix pointing at a DIFFERENT country. This needs PINPOINT_NO_CACHE=1;
//      against the cache it would compare fresh output with the same cached rows and always report
//      "no change".

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { PuzzleCalendar, Question } from "@pinpoint/core";
import { buildCandidates } from "./generate.ts";
import { matchedPlaceName } from "./build.ts";
import { diffDrift, structuralChecks, type Finding } from "./checks.ts";

const url = (p: string) => new URL(p, import.meta.url);

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function main() {
  const wantDrift = process.argv.includes("--drift");
  const cal = JSON.parse(
    await readFile(url("../../../apps/web/public/questions.json"), "utf8"),
  ) as PuzzleCalendar;
  const geo = JSON.parse(
    await readFile(url("../../../apps/web/public/countries.geo.json"), "utf8"),
  ) as { features: { id: string }[] };

  const days = cal.puzzles;
  const shipped: Question[] = days.flatMap((p) => [...p.questions, ...(p.bonus ? [p.bonus] : [])]);

  // Pass 1: structure (pure, unit-tested in checks.test.ts).
  const findings: Finding[] = structuralChecks(cal, {
    onMap: new Set(geo.features.map((f) => f.id)),
    flagExists: (cc) => existsSync(url(`../../../apps/web/public/flags/${cc}.svg`)),
    today: todayKey(),
  });
  const STRUCTURAL_CHECKS = 14;

  // Pass 2: drift against freshly fetched sources.
  if (!wantDrift) {
    findings.push({ level: "INFO", check: "drift", detail: "skipped — pass --drift (with PINPOINT_NO_CACHE=1) to re-check every source" });
  } else {
    if (process.env.PINPOINT_NO_CACHE !== "1") {
      findings.push({ level: "WARN", check: "drift", detail: "PINPOINT_NO_CACHE=1 not set — comparing against cached rows, so drift cannot be detected" });
    }
    console.log("Rebuilding candidate pool from source (this takes a while)...");
    // Report-only means report-only: a flaky source must degrade to a finding, never a stack trace.
    let build: Awaited<ReturnType<typeof buildCandidates>> | null = null;
    try {
      build = await buildCandidates();
    } catch (e) {
      findings.push({
        level: "WARN",
        check: "drift",
        detail: `could not rebuild the pool: ${(e as Error).message.slice(0, 120)} — sources may be rate-limiting; retry later`,
      });
    }
    if (build) {
    const { all, allowed, placesByIso } = build;
    const drift = diffDrift(shipped, all);

    if (drift.changed.length) {
      findings.push({
        level: "FAIL",
        check: "answers still match the source",
        detail: `${drift.changed.length} — ` +
          drift.changed.slice(0, 10).map((c) => `${c.question.prompt.slice(0, 44)} : ${c.from} -> ${c.to}`).join(" | "),
      });
    }
    if (drift.vanished.length) {
      findings.push({
        level: "WARN",
        check: "shipped questions still generated",
        detail: `${drift.vanished.length} — ` +
          drift.vanished.slice(0, 10).map((q) => `[${q.clueType}] ${q.prompt.slice(0, 44)}`).join(" | "),
      });
    }
    const notAllowed = shipped.filter((q) => !allowed.has(q.answerIso));
    if (notAllowed.length) {
      findings.push({ level: "FAIL", check: "answers still on the answerable list", detail: `${notAllowed.length} — e.g. ${notAllowed.slice(0, 6).map((q) => `${q.answerIso} (${q.id})`).join(" | ")}` });
    }
    const leaky = shipped
      .filter((q) => !["capital", "locate", "birthplace", "nationality"].includes(q.clueType))
      .filter((q) => matchedPlaceName(q.prompt, placesByIso.get(q.answerIso) ?? []));
    if (leaky.length) {
      findings.push({ level: "WARN", check: "no clue names a place in its own answer country", detail: `${leaky.length} — e.g. ${leaky.slice(0, 6).map((q) => q.prompt.slice(0, 48)).join(" | ")}` });
    }
    }
  }

  console.log(`\nPinpoint content validation — ${days.length} days, ${shipped.length} questions\n`);
  for (const level of ["FAIL", "WARN", "INFO"] as const) {
    for (const f of findings.filter((x) => x.level === level)) {
      const icon = level === "FAIL" ? "\u2716" : level === "WARN" ? "\u26a0" : "\u00b7";
      console.log(`${icon} ${level.padEnd(4)} ${f.check}\n       ${f.detail}`);
    }
  }
  const fails = findings.filter((f) => f.level === "FAIL").length;
  const warns = findings.filter((f) => f.level === "WARN").length;
  const structuralFindings = findings.filter((f) => f.level !== "INFO" && f.check !== "drift").length;
  console.log(`\n${Math.max(0, STRUCTURAL_CHECKS - structuralFindings)}/${STRUCTURAL_CHECKS} structural checks passed, ${fails} failed, ${warns} warnings`);
  console.log(fails === 0 ? "No blocking issues.\n" : "Issues above need attention.\n");
  // Report-only by design: never fail the caller.
}

main().catch((e) => {
  console.error(e);
});
