// Wikidata SPARQL fetch with an on-disk cache. Uses Node's global fetch by default
// (what `pnpm content:gen` runs). Set PINPOINT_FETCH=curl to fetch via the curl binary instead
// (needed in sandboxes where Node can't open sockets). Cached responses make re-runs instant.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "pinpoint-content-gen/0.1 (https://pinpoint.example; dev)";
const CACHE_DIR = new URL("../.cache/", import.meta.url);

/** A flattened SPARQL row: variable name -> string value. */
export type Row = Record<string, string>;

function flatten(json: { results: { bindings: Record<string, { value: string }>[] } }): Row[] {
  return json.results.bindings.map((b) => {
    const row: Row = {};
    for (const [k, v] of Object.entries(b)) row[k] = v.value;
    return row;
  });
}

async function rawFetch(url: string): Promise<unknown> {
  if (process.env.PINPOINT_FETCH === "curl") {
    const { stdout } = await execFileP(
      "curl",
      ["-sL", "--max-time", "120", "-H", `Accept: application/sparql-results+json`, "-H", `User-Agent: ${UA}`, url],
      { maxBuffer: 128 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  }
  const res = await fetch(url, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Wikidata ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Run a named SPARQL query (cached to tools/content-gen/.cache/<name>.json). */
export async function sparql(name: string, query: string): Promise<Row[]> {
  const cacheFile = new URL(`${name}.json`, CACHE_DIR);
  if (existsSync(cacheFile)) {
    return JSON.parse(await readFile(cacheFile, "utf8")) as Row[];
  }
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const rows = flatten((await rawFetch(url)) as never);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(rows));
  return rows;
}
