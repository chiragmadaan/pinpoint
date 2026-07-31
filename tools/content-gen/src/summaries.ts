// Reveal facts, sourced from the English Wikipedia article about the clue's subject.
//
// We originally used Wikidata descriptions, but those are DISAMBIGUATORS, not facts — a species is
// "Species of mammal" and a river is "River in Russia", which is either contentless or just restates
// the answer. Wikipedia's opening prose is written to inform, so it actually teaches something.
//
// We cache the raw extract (not a pre-picked sentence) so the selection heuristics below can be
// changed without refetching thousands of articles.
//
// LICENCE: Wikipedia text is CC BY-SA — unlike Wikidata (CC0) it needs attribution wherever it is
// shown. The app credits it on the reveal; keep that if you keep this source.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fetchJson } from "./wikidata.ts";

const ENDPOINT = "https://en.wikipedia.org/api/rest_v1/page/summary";
const CACHE_DIR = new URL("../.cache/extract/", import.meta.url);

const safeFile = (title: string) => title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 120) + ".json";

/** Split prose into sentences. Breaks on .!? followed by a capital, so "St. Lucia" / "1.5 km" survive. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z("'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface FactContext {
  /** What the clue is about — used to resolve a leading "It ..." into a readable sentence. */
  subject: string;
  /** Display name of the answer country, so we can reject pure restatements of the answer. */
  answerName?: string;
  /** True when the subject IS the answer country (locate/flag/border). Naming it is then expected. */
  subjectIsAnswer?: boolean;
}

/**
 * Choose the first sentence that actually teaches the player something.
 *
 * Skips sentences that merely restate what the reveal already showed — the big one being
 * "Islamabad is the capital city of Pakistan" for a capital clue. Scanning past it finds the real
 * fact ("It is the country's ninth-most populous city..."), whose leading pronoun we rewrite to name
 * the subject. When the subject IS the answer (locate/flag/border) naming the country is normal, so
 * the restatement rule is relaxed for those.
 */
export function pickFact(extract: string, ctx: FactContext): string | null {
  const { subject, answerName, subjectIsAnswer } = ctx;
  for (const raw of sentences(extract).slice(0, 4)) {
    // Resolve a leading back-reference so the sentence stands alone:
    //   "It is the country's ninth-most populous city" -> "<subject> is the country's ninth-most ..."
    //   "The city has an estimated population of 8 million" -> "Baghdad has an estimated ..."
    const s = raw
      .replace(/^It (is|was|has|had|lies|sits|covers|contains|remains|serves)\b/, `${subject} $1`)
      .replace(
        /^The (?:city|town|country|island|river|region|area|nation|state) (is|was|has|had|lies|sits|covers)\b/,
        `${subject} $1`,
      );
    if (s.length < 40 || s.length > 300) continue;
    if (/^\s*(It|They|These|This|He|She|Its|Their)\b/.test(s)) continue; // unresolved pronoun
    if (/\bis the capital\b/i.test(s) && !subjectIsAnswer) continue; // the clue already said so
    if (!subjectIsAnswer && answerName) {
      const esc = answerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // A SHORT sentence that names the answer is nearly always just restating it; a longer one
      // carries real detail alongside the country name.
      if (new RegExp(`\\b${esc}\\b`, "i").test(s) && s.length < 95) continue;
    }
    return s;
  }
  return null;
}

/** Raw Wikipedia extract for an article title, cached. null when missing/disambiguation. */
export async function extract(title: string): Promise<string | null> {
  const cacheFile = new URL(safeFile(title), CACHE_DIR);
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(await readFile(cacheFile, "utf8")) as string | null;
    } catch {
      /* refetch */
    }
  }
  let out: string | null = null;
  try {
    const json = (await fetchJson(
      `${ENDPOINT}/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    )) as { extract?: string; type?: string };
    if (json.type !== "disambiguation" && json.extract) out = json.extract;
  } catch {
    out = null; // 404 / transient -> no fact rather than a bad one
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(out));
  return out;
}
