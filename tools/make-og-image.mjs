// Generate the social share card (og:image) at apps/web/public/og.png.
//
// Run: node tools/make-og-image.mjs
//
// Draws the real world map from the same countries.geo.json the game ships, in the game's own
// palette, so the card matches the product and needs no separate logo asset. Rendered by headless
// Chrome (already on the machine) rather than an image library, so there is no new dependency.
//
// NOTE: social scrapers cache aggressively. If you change the design, ALSO change the filename
// (og-2.png, ...) and the og:image meta tag, or existing shares will keep the old picture.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const root = new URL("../", import.meta.url);

const W = 1200;
const H = 630; // the 1.91:1 card size Facebook / Twitter / LinkedIn expect
const MAP_H = W / 2; // equirectangular is 2:1, so the map is 1200x600 inside the 630-tall card

// Game palette (packages/map/src/render.ts DEFAULT_STYLE).
const OCEAN = "#0b1e33";
const LAND = "#2b4a63";
const ACCENT = "#f2c14e";

/** GeoJSON -> SVG path data under an equirectangular projection. */
function toPath(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let d = "";
  for (const rings of polys) {
    for (const ring of rings) {
      ring.forEach(([lon, lat], i) => {
        const x = ((lon + 180) / 360) * W;
        const y = ((90 - lat) / 180) * MAP_H;
        d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      });
      d += "Z";
    }
  }
  return d;
}

const fc = JSON.parse(await readFile(new URL("apps/web/public/countries.geo.json", root), "utf8"));
const paths = fc.features.map((f) => `<path d="${toPath(f.geometry)}"/>`).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${OCEAN};
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .wrap { position: relative; width: ${W}px; height: ${H}px; }
  /* Map sits behind the text, dimmed so the wordmark stays legible. */
  svg { position: absolute; top: ${(H - MAP_H) / 2}px; left: 0; opacity: 0.55; }
  svg path { fill: ${LAND}; stroke: #12293d; stroke-width: 0.4; }
  .scrim { position: absolute; inset: 0;
           background: radial-gradient(ellipse at 50% 52%, rgba(11,30,51,0.92) 0%, rgba(11,30,51,0.62) 45%, rgba(11,30,51,0.35) 100%); }
  .content { position: absolute; inset: 0; display: flex; flex-direction: column;
             align-items: center; justify-content: center; text-align: center; }
  .title { font-size: 108px; font-weight: 800; color: #eaf2f8; letter-spacing: -2px; line-height: 1; }
  .pin { color: ${ACCENT}; }
  .tag { margin-top: 22px; font-size: 34px; font-weight: 500; color: #cfe0ee; opacity: 0.95; }
  .rule { margin-top: 30px; width: 132px; height: 5px; border-radius: 3px; background: ${ACCENT}; }
  .daily { margin-top: 26px; font-size: 23px; font-weight: 600; color: ${ACCENT};
           letter-spacing: 3.5px; text-transform: uppercase; }
</style>
<div class="wrap">
  <svg width="${W}" height="${MAP_H}" viewBox="0 0 ${W} ${MAP_H}">${paths}</svg>
  <div class="scrim"></div>
  <div class="content">
    <div class="title"><span class="pin">📍</span> Pinpoint</div>
    <div class="tag">Read a clue. Find the country.</div>
    <div class="rule"></div>
    <div class="daily">Three puzzles a day</div>
  </div>
</div>`;

const dir = await mkdtemp(join(tmpdir(), "pinpoint-og-"));
const page = join(dir, "card.html");
await writeFile(page, html);

const out = new URL("apps/web/public/og.png", root).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await execFileP(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--screenshot=${out}`,
  `--window-size=${W},${H}`,
  `--force-device-scale-factor=1`,
  `file://${page}`,
]);
console.log(`wrote ${out} (${W}x${H})`);
