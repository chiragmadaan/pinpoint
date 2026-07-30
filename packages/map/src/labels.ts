import { largestOuterRing, polygonCentroidXY } from "./geometry.ts";
import type { LonLat, MapFeature } from "./types.ts";

/**
 * Display overrides for country-name labels: only names that are genuinely too long/verbose to sit
 * inside their borders. Short, unambiguous names (India, Chile, Peru…) are left alone — abbreviating
 * them buys nothing. Keyed by the exact `name` in the map data.
 */
export const LABEL_OVERRIDES: Record<string, string> = {
  "United States of America": "USA",
  "United Kingdom": "UK",
  "Democratic Republic of the Congo": "DR Congo",
  "Republic of the Congo": "Congo",
  "United Republic of Tanzania": "Tanzania",
  "Republic of Serbia": "Serbia",
  "United Arab Emirates": "UAE",
  "Central African Republic": "C.A.R.",
  "Bosnia and Herzegovina": "Bosnia & Herz.",
  "Dominican Republic": "Dominican Rep.",
  "Equatorial Guinea": "Eq. Guinea",
  "Trinidad and Tobago": "Trinidad",
  "Papua New Guinea": "Papua N.G.",
  "Czech Republic": "Czechia",
  "Solomon Islands": "Solomon Is.",
  "The Bahamas": "Bahamas",
  "Falkland Islands": "Falklands",
  "French Southern and Antarctic Lands": "Fr. S. Territories",
};

/** The text to render for a country label — the override if one exists, otherwise the name as-is. */
export function labelText(name: string): string {
  return LABEL_OVERRIDES[name] ?? name;
}

export interface PlacedLabel {
  text: string;
  /** Anchor in projected (screen) pixels — the label is drawn centred here. */
  x: number;
  y: number;
  fontPx: number;
}

export interface LabelLayoutOptions {
  /** Current map zoom factor (1 = full world). Drives font size so all labels scale together. */
  zoom?: number;
  /** Cull a landmass whose larger on-screen dimension is below this (px). */
  minSizePx?: number;
  /** Font size (px) at zoom 1; also the floor a name may shrink to before it just overflows. */
  minFontPx?: number;
  /** Font size (px) reached at max zoom. */
  maxFontPx?: number;
  /** Padding (px) added around each label box for collision checks. */
  padPx?: number;
  /** If given, labels whose anchor is off-canvas (beyond this margin) are skipped. */
  viewport?: { width: number; height: number };
}

/** Zoom at which the label font reaches `maxFontPx` (the map's mobile ceiling). */
const ZOOM_FONT_REF = 12;

/**
 * Lay out country-name labels for the current view: anchor each on its main landmass, size the font
 * to fit that landmass (so labels scale with zoom), and drop any label that would overlap a
 * higher-priority one (bigger landmass wins). Pure — takes a projection and a text-measure function,
 * so it can be unit-tested without a canvas.
 */
export function layoutLabels(
  features: MapFeature[],
  project: (ll: LonLat) => [number, number],
  measure: (text: string, fontPx: number) => number,
  opts: LabelLayoutOptions = {},
): PlacedLabel[] {
  const minSizePx = opts.minSizePx ?? 24;
  const minFontPx = opts.minFontPx ?? 10;
  const maxFontPx = opts.maxFontPx ?? 20;
  const padPx = opts.padPx ?? 2;
  const vp = opts.viewport;

  // Font tracks the map's zoom (same for every country), so labels grow together as you zoom in and
  // a huge country never gets a huge static label. Reaches maxFontPx around the map's max zoom.
  const zoom = opts.zoom ?? 1;
  const zoomFont = Math.max(
    minFontPx,
    Math.min(maxFontPx, minFontPx + ((maxFontPx - minFontPx) * (zoom - 1)) / (ZOOM_FONT_REF - 1)),
  );

  type Candidate = {
    text: string;
    cx: number;
    cy: number;
    halfW: number;
    halfH: number;
    fontPx: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    footprint: number;
  };
  const candidates: Candidate[] = [];

  for (const f of features) {
    if (!f.name) continue;
    const ring = largestOuterRing(f.geometry);
    if (!ring || ring.length < 3) continue;

    // Project the main landmass and take its on-screen bounding box.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const pts: [number, number][] = [];
    for (const ll of ring) {
      const p = project(ll);
      pts.push(p);
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const wPx = maxX - minX;
    const hPx = maxY - minY;
    if (Math.max(wPx, hPx) < minSizePx) continue; // too small on screen to bother

    const [x, y] = polygonCentroidXY(pts);
    if (vp && (x < -padPx || y < -padPx || x > vp.width + padPx || y > vp.height + padPx)) continue;

    // Size to the zoom, then shrink toward the country's width (floored at the min size). A small
    // country whose name is wider than it (e.g. Puerto Rico) keeps its label and overflows into the
    // surrounding sea — the anchor is still clamped onto the country below, so it reads correctly.
    const text = labelText(f.name);
    let fontPx = zoomFont;
    let tw = measure(text, fontPx);
    const fitW = wPx * 1.1;
    if (tw > fitW && fontPx > minFontPx) {
      fontPx = Math.max(minFontPx, (fontPx * fitW) / tw);
      tw = measure(text, fontPx);
    }

    candidates.push({ text, cx: x, cy: y, halfW: tw / 2, halfH: fontPx / 2, fontPx, minX, maxX, minY, maxY, footprint: wPx * hPx });
  }

  // Bigger landmasses get label priority. A label may be nudged (vertically or horizontally) but its
  // anchor is CLAMPED to its own bbox, so it never leaves the country onto a neighbour (that's what
  // put "Togo" on Benin and "Lesotho" on South Africa). Bigger countries have room to dodge; small
  // ones barely move. If no on-country slot is free, drop it (it reappears as you zoom in).
  candidates.sort((a, b) => b.footprint - a.footprint);
  const placed: PlacedLabel[] = [];
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const c of candidates) {
    // Candidate anchor offsets: centre first, then toward the country's own edges/corners. Scaled to
    // the country's bbox and CLAMPED to it, so the anchor never leaves the country — a small country
    // (Haiti) can shift toward open sea to dodge a wide neighbour's label (Dominican Rep.) while a
    // thin one (Togo) barely moves horizontally and stays off its neighbour (Benin).
    const rx = (c.maxX - c.minX) / 2;
    const ry = (c.maxY - c.minY) / 2;
    const offs: [number, number][] = [
      [0, 0],
      [0, -ry], [0, ry], [-rx, 0], [rx, 0],
      [-rx, -ry], [rx, -ry], [-rx, ry], [rx, ry],
      [0, -ry / 2], [0, ry / 2], [-rx / 2, 0], [rx / 2, 0],
    ];
    let chosen: { x: number; y: number; box: { x0: number; y0: number; x1: number; y1: number } } | null = null;
    for (const [ox, oy] of offs) {
      const x = Math.min(c.maxX, Math.max(c.minX, c.cx + ox));
      const y = Math.min(c.maxY, Math.max(c.minY, c.cy + oy));
      const box = { x0: x - c.halfW - padPx, y0: y - c.halfH - padPx, x1: x + c.halfW + padPx, y1: y + c.halfH + padPx };
      const hit = boxes.some((o) => !(box.x1 < o.x0 || box.x0 > o.x1 || box.y1 < o.y0 || box.y0 > o.y1));
      if (!hit) {
        chosen = { x, y, box };
        break;
      }
    }
    if (!chosen) continue; // no free slot on its own landmass -> drop (reappears when zoomed)
    placed.push({ text: c.text, x: chosen.x, y: chosen.y, fontPx: c.fontPx });
    boxes.push(chosen.box);
  }
  return placed;
}
