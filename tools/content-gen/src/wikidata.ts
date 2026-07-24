// Wikidata SPARQL fetch with a query-aware on-disk cache + retry/back-off. Uses Node's global fetch
// by default (what `pnpm content:gen` runs). Set PINPOINT_FETCH=curl to fetch via the curl binary
// instead (needed in sandboxes where Node can't open sockets).
//
// The cache is keyed by name AND stores the exact query text, so editing a query auto-refreshes it
// (a plain name-key cache silently served stale results when queries changed — a real bug we hit).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "pinpoint-content-gen/0.1 (https://pinpoint.example; dev)";
const CACHE_DIR = new URL("../.cache/", import.meta.url);

export type Row = Record<string, string>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function flatten(json: { results: { bindings: Record<string, { value: string }>[] } }): Row[] {
  return json.results.bindings.map((b) => {
    const row: Row = {};
    for (const [k, v] of Object.entries(b)) row[k] = v.value;
    return row;
  });
}

/** Fetch raw text (curl or Node fetch). */
async function fetchText(url: string): Promise<string> {
  if (process.env.PINPOINT_FETCH === "curl") {
    const { stdout } = await execFileP(
      "curl",
      ["-sL", "--max-time", "90", "-H", `Accept: application/sparql-results+json`, "-H", `User-Agent: ${UA}`, url],
      { maxBuffer: 128 * 1024 * 1024 },
    );
    return stdout;
  }
  const res = await fetch(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": UA } });
  return res.text();
}

/** Fetch + parse with retry/back-off. WDQS throttles bursts with 429/HTML pages and empty bodies. */
async function fetchJson(url: string): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt); // linear back-off: 1.5s, 3s, 4.5s, 6s
    try {
      const text = await fetchText(url);
      const trimmed = text.trim();
      if (!trimmed) throw new Error("empty response (throttled?)");
      if (trimmed.startsWith("<")) throw new Error("HTML response (rate-limited/timeout)");
      return JSON.parse(trimmed);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface CacheShape {
  query: string;
  rows: Row[];
}

/** Run a named SPARQL query, cached to tools/content-gen/.cache/<name>.json (keyed by query text). */
export async function sparql(name: string, query: string): Promise<Row[]> {
  const cacheFile = new URL(`${name}.json`, CACHE_DIR);
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8")) as Partial<CacheShape>;
      if (cached && cached.query === query && Array.isArray(cached.rows)) return cached.rows;
    } catch {
      /* fall through to refetch */
    }
  }
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const rows = flatten((await fetchJson(url)) as never);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ query, rows } satisfies CacheShape));
  return rows;
}
