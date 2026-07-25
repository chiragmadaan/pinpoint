import type { Verdict } from "./types.ts";

const EMOJI: Record<Verdict, string> = {
  correct: "🟩",
  neighbor: "🟨",
  wrong: "⬛",
};

export interface ShareOptions {
  /** Optional level to include, e.g. "Lv 6". */
  level?: number;
  /** Optional trophy line, e.g. "🗺️ Explorer". */
  trophy?: string;
  /** Bonus outcome: "solved" -> ⭐, "missed" -> ✩ (unlocked but wrong), undefined -> not unlocked. */
  bonus?: "solved" | "missed";
}

/**
 * Wordle-style spoiler-free share text. Contains NO country names/answers — only the result grid,
 * so it's safe to post publicly. `url` should point at the web app (the direct viral loop).
 */
export function buildShareText(
  dateKey: string,
  verdicts: Verdict[],
  streak: number,
  url: string,
  opts: ShareOptions = {},
): string {
  const bonusMark = opts.bonus === "solved" ? " ⭐" : opts.bonus === "missed" ? " ✩" : "";
  const grid = verdicts.map((v) => EMOJI[v]).join("") + bonusMark;
  const solved = verdicts.filter((v) => v === "correct").length;
  const lines = [`📍 Pinpoint ${dateKey}`, `${grid}  ${solved}/3   🔥${streak}`];
  const badge = [opts.trophy, opts.level ? `Lv ${opts.level}` : null].filter(Boolean).join("  ·  ");
  if (badge) lines.push(badge);
  lines.push(url);
  return lines.join("\n");
}
