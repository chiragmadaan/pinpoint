// Wikipedia pageviews as a *recognizability* signal (better than sitelinks, which measure how
// documented a thing is, not how well-known). Sums the last 12 complete months of en.wikipedia
// views for an article title, cached per title. A missing article (404) returns 0.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fetchJson } from "./wikidata.ts";

const ENDPOINT =
  "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents";
const CACHE_DIR = new URL("../.cache/pv/", import.meta.url);

function last12Months(): { start: string; end: string } {
  const now = new Date();
  const endM = new Date(now.getFullYear(), now.getMonth(), 1); // first day of current month (exclusive-ish)
  const startM = new Date(endM.getFullYear() - 1, endM.getMonth(), 1);
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}0100`;
  return { start: fmt(startM), end: fmt(endM) };
}
const WINDOW = last12Months();

const safeFile = (title: string) => title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 120) + ".json";

/** Total en.wikipedia pageviews over the last 12 months for an article title (0 if none). */
export async function pageviews(title: string): Promise<number> {
  const cacheFile = new URL(safeFile(title), CACHE_DIR);
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(await readFile(cacheFile, "utf8")) as number;
    } catch {
      /* refetch */
    }
  }
  const article = encodeURIComponent(title.replace(/ /g, "_"));
  const url = `${ENDPOINT}/${article}/monthly/${WINDOW.start}/${WINDOW.end}`;
  let total = 0;
  try {
    const json = (await fetchJson(url)) as { items?: { views: number }[] };
    total = (json.items ?? []).reduce((a, x) => a + x.views, 0);
  } catch {
    total = 0; // 404 / no article / transient -> treat as unknown (0)
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(total));
  return total;
}
