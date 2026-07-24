import type { Verdict } from "./types.ts";

const EMOJI: Record<Verdict, string> = {
  correct: "🟩",
  neighbor: "🟨",
  wrong: "⬛",
};

/**
 * Wordle-style spoiler-free share text. Contains NO country names/answers — only the result grid,
 * so it's safe to post publicly. `url` should point at the web app (the direct viral loop).
 */
export function buildShareText(
  dateKey: string,
  verdicts: Verdict[],
  streak: number,
  url: string,
): string {
  const grid = verdicts.map((v) => EMOJI[v]).join("");
  const solved = verdicts.filter((v) => v === "correct").length;
  return `🌍 Geo Quiz ${dateKey}\n${grid}  ${solved}/3   🔥${streak}\n${url}`;
}
