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
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PuzzleCalendar, Question } from "@pinpoint/core";
import { buildCandidates } from "./generate.ts";
import { matchedPlaceName, resemblesCountryName } from "./build.ts";
import { diffDrift, leakPolicyChecks, structuralChecks, STRUCTURAL_CHECK_NAMES, type Finding } from "./checks.ts";

const url = (p: string) => new URL(p, import.meta.url);

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function main() {
  const startedAt = Date.now();
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
  const structuralMs = Date.now() - startedAt;

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
    const { all, allowed, placesByIso, placeFame, nameOf } = build;
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
    // Naming a place in your own country is not itself a defect — the policy TIERS it. Check the
    // tiering instead (flagging every leak reported the policy working as 49 failures).
    const exempt = new Set(["capital", "locate", "birthplace", "nationality"]);
    findings.push(
      ...leakPolicyChecks({
        main: days.flatMap((p) => p.questions).filter((q) => !exempt.has(q.clueType)),
        bonus: days.flatMap((p) => (p.bonus ? [p.bonus] : [])),
        leakedPlace: (q) => matchedPlaceName(q.prompt, placesByIso.get(q.answerIso) ?? []),
        fameOf: (place) => placeFame.get(place) ?? 0,
        resembles: (place, iso) => resemblesCountryName(place, nameOf(iso)),
      }),
    );
    }
  }

  // ---- write the report ------------------------------------------------------------------------
  const ms = Date.now() - startedAt;
  const dur = (n: number) => (n < 1000 ? `${n} ms` : n < 60_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.floor(n / 60_000)} m ${Math.round((n % 60_000) / 1000)} s`);
  const named = (name: string) => findings.filter((f) => f.check === name);
  const icon = (l: Finding["level"]) => (l === "FAIL" ? "\u2716" : l === "WARN" ? "\u26a0" : "\u00b7");

  const lines: string[] = [];
  lines.push(`# Pinpoint content validation`, "");
  lines.push(`- Run: ${new Date().toISOString()}`);
  lines.push(`- Calendar: ${days.length} days (${days[0]?.date} to ${days.at(-1)?.date}), ${shipped.length} questions`);
  lines.push(`- Mode: ${wantDrift ? "structural + drift" : "structural only"}`);
  lines.push(`- Duration: **${dur(ms)}**${wantDrift ? ` (structural ${dur(structuralMs)}, drift ${dur(ms - structuralMs)})` : ""}`, "");

  const fails = findings.filter((f) => f.level === "FAIL");
  const warns = findings.filter((f) => f.level === "WARN");
  lines.push(`## Summary`, "");
  lines.push(`| | |`, `|---|---|`);
  lines.push(`| Failures | ${fails.length} |`, `| Warnings | ${warns.length} |`);
  lines.push(`| Structural checks | ${STRUCTURAL_CHECK_NAMES.length - new Set(findings.map((f) => f.check)).size >= 0 ? "" : ""}${STRUCTURAL_CHECK_NAMES.filter((n) => named(n).length === 0).length}/${STRUCTURAL_CHECK_NAMES.length} passed |`, "");

  // Pool utilisation, from the stats the generator persists — answers "how much runway is left?"
  // without re-running the pipeline (which is what it used to take).
  try {
    const st = JSON.parse(await readFile(url("../../../data/generation-stats.json"), "utf8")) as {
      generatedAt: string;
      pool: { total: number; mandatory: number; bonus: number };
      used: { mandatory: number; bonus: number };
      spare: { mandatory: number; bonus: number };
      bindingConstraint: string;
    };
    const pct = (used: number, total: number) => (total ? Math.round((used / total) * 100) : 0);
    lines.push(`## Pool utilisation`, "");
    lines.push(`_Generated ${st.generatedAt}._`, "");
    lines.push(`| Pool | Total | Used | Spare | Utilisation |`, `|---|---|---|---|---|`);
    lines.push(`| Mandatory | ${st.pool.mandatory} | ${st.used.mandatory} | ${st.spare.mandatory} | ${pct(st.used.mandatory, st.pool.mandatory)}% |`);
    lines.push(`| Bonus | ${st.pool.bonus} | ${st.used.bonus} | ${st.spare.bonus} | ${pct(st.used.bonus, st.pool.bonus)}% |`);
    lines.push("", `Binding constraint: **${st.bindingConstraint}** — this is the pool that caps calendar length.`, "");
  } catch {
    lines.push(`## Pool utilisation`, "", `_No data/generation-stats.json — run \`pnpm content:gen\`._`, "");
  }

  lines.push(`## Structural checks`, "");
  for (const name of STRUCTURAL_CHECK_NAMES) {
    const hits = named(name);
    if (hits.length === 0) lines.push(`- \u2713 ${name}`);
    else for (const f of hits) lines.push(`- ${icon(f.level)} **${name}** — ${f.detail}`);
  }
  // "calendar covers today" only appears when it fires, so it isn't in the fixed name list.
  for (const f of named("calendar covers today")) lines.push(`- ${icon(f.level)} **calendar covers today** — ${f.detail}`);
  lines.push("");

  const driftFindings = findings.filter((f) => !STRUCTURAL_CHECK_NAMES.includes(f.check as never) && f.check !== "calendar covers today");
  lines.push(`## Content drift`, "");
  if (!wantDrift) lines.push(`_Skipped. Run \`PINPOINT_NO_CACHE=1 pnpm validate --drift\` to re-check every source._`);
  else if (driftFindings.length === 0) lines.push(`- \u2713 no drift detected`);
  else for (const f of driftFindings) lines.push(`- ${icon(f.level)} **${f.check}** — ${f.detail}`);
  lines.push("");

  const reportPath = new URL("../../../validation-report.md", import.meta.url);
  await writeFile(reportPath, lines.join("\n"));

  // Console stays a one-liner: the detail lives in the report, which is what a 20-minute run needs.
  const where = fileURLToPath(reportPath);
  console.log(
    `\nValidation ${fails.length === 0 ? "OK" : "FOUND ISSUES"} — ${fails.length} failed, ${warns.length} warnings, ${dur(ms)}\n` +
      `Report: ${where}\n`,
  );
  // Report-only by design: never fail the caller.
}

main().catch((e) => {
  console.error(e);
});
