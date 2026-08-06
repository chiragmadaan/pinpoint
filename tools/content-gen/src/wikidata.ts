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
/**
 * QLever — an alternative public SPARQL endpoint over the same Wikidata dump, far faster on the
 * broad `P31/P279*` subclass traversals that make WDQS hit its 60s server-side timeout (the brand /
 * clothing queries fail on WDQS and return in ~1-4s here). Differences to be aware of:
 *   - prefixes are NOT auto-registered -> prepend QLEVER_PREFIXES
 *   - no `SERVICE wikibase:label` -> select rdfs:label explicitly with a LANG filter
 */
const QLEVER_ENDPOINT = "https://qlever.dev/api/wikidata";

export const QLEVER_PREFIXES = [
  "PREFIX wd: <http://www.wikidata.org/entity/>",
  "PREFIX wdt: <http://www.wikidata.org/prop/direct/>",
  "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
  "PREFIX schema: <http://schema.org/>",
  "PREFIX wikibase: <http://wikiba.se/ontology#>",
].join("\n");
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

/**
 * Fetch returning the HTTP status alongside the body, so callers can tell "this genuinely does not
 * exist" (404 — safe to cache as a permanent negative) from "the network hiccupped" (retry later).
 * Caching the two the same way silently turned transient blips into permanent missing data.
 */
export async function fetchWithStatus(url: string): Promise<{ status: number; body: string }> {
  if (process.env.PINPOINT_FETCH === "curl") {
    const { stdout } = await execFileP(
      "curl",
      ["-sL", "--max-time", "60", "-w", "\n%{http_code}", "-H", `User-Agent: ${UA}`, url],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const cut = stdout.lastIndexOf("\n");
    return { status: Number(stdout.slice(cut + 1).trim()) || 0, body: stdout.slice(0, Math.max(0, cut)) };
  }
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  return { status: res.status, body: await res.text() };
}

/** Fetch + parse with retry/back-off. WDQS throttles bursts with 429/HTML pages and empty bodies. */
export async function fetchJson(url: string): Promise<unknown> {
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

/**
 * Run a named SPARQL query, cached to tools/content-gen/.cache/<name>.json (keyed by query text).
 * `engine: "qlever"` routes to QLever for queries WDQS can't finish (see QLEVER_ENDPOINT).
 */
export async function sparql(name: string, query: string, engine: "wdqs" | "qlever" = "wdqs"): Promise<Row[]> {
  const cacheFile = new URL(`${name}.json`, CACHE_DIR);
  let stale: Row[] | null = null; // cached rows from a PREVIOUS version of this query
  // Drift detection MUST refetch: comparing fresh output against the same cached rows would always
  // report "nothing changed". PINPOINT_NO_CACHE=1 forces every query back to the source.
  const skipCache = process.env.PINPOINT_NO_CACHE === "1";
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8")) as Partial<CacheShape>;
      if (cached && Array.isArray(cached.rows)) {
        // Skipping the cache must NOT also skip the failure fallback: a full refetch hammers the
        // endpoint hardest, so it is exactly when one flaky query is most likely to take the run
        // down. Always load the cached rows as a safety net; just don't return them as a hit.
        if (cached.query === query && !skipCache) return cached.rows; // exact hit
        stale = cached.rows;
      }
    } catch {
      /* fall through to refetch */
    }
  }
  const base = engine === "qlever" ? QLEVER_ENDPOINT : ENDPOINT;
  const url = `${base}?format=json&query=${encodeURIComponent(query)}`;
  let rows: Row[];
  try {
    rows = flatten((await fetchJson(url)) as never);
  } catch (e) {
    // WDQS is flaky under load (timeouts / rate limits). Editing a query must not be able to break
    // the whole build: fall back to the previous cached rows for this name and carry on degraded —
    // the run just misses whatever the edit added (e.g. a new field), instead of producing nothing.
    if (stale) {
      console.warn(`  sparql "${name}" refetch failed — reusing stale cache (${stale.length} rows): ${(e as Error).message.slice(0, 70)}`);
      return stale;
    }
    throw e;
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ query, rows } satisfies CacheShape));
  return rows;
}
