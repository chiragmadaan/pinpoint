import assert from "node:assert/strict";
import { test } from "node:test";
import { equirectangular, largestOuterRing } from "./geometry.ts";
import { labelText, layoutLabels } from "./labels.ts";
import type { MapFeature } from "./types.ts";

// Stub text measurement: proportional to length × font size (no canvas needed).
const measure = (t: string, px: number) => t.length * px * 0.55;

// Do any two placed labels' boxes overlap? Used to assert legibility.
function anyOverlap(labels: { text: string; x: number; y: number; fontPx: number }[], pad = 2): boolean {
  const rects = labels.map((l) => {
    const w = measure(l.text, l.fontPx);
    return { x0: l.x - w / 2 - pad, y0: l.y - l.fontPx / 2 - pad, x1: l.x + w / 2 + pad, y1: l.y + l.fontPx / 2 + pad };
  });
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (!(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1)) return true;
    }
  }
  return false;
}

// Projected bounding box of a feature's main landmass — used to assert a label sits ON its country.
function projBbox(f: MapFeature, project: (ll: [number, number]) => [number, number]) {
  const ring = largestOuterRing(f.geometry)!;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ll of ring) {
    const [x, y] = project(ll);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

const world = equirectangular({ width: 360, height: 180 }); // ~1px/°
const zoom10 = equirectangular({ width: 3600, height: 1800 }); // ~10px/°
const zoomBig = equirectangular({ width: 7200, height: 3600 }); // ~20px/°

// USA: a big mainland plus a far-northwest island (Alaska-like). The naive all-vertex centroid gets
// dragged northwest into the ocean; the label should sit on the mainland instead.
const USA: MapFeature = {
  iso: "USA",
  name: "United States of America",
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      [[[-120, 30], [-75, 30], [-75, 48], [-120, 48], [-120, 30]]], // mainland
      [[[-160, 60], [-150, 60], [-150, 65], [-160, 65], [-160, 60]]], // "Alaska"
    ],
  },
};

test("labelText abbreviates long names but leaves short ones alone", () => {
  assert.equal(labelText("United States of America"), "USA");
  assert.equal(labelText("Democratic Republic of the Congo"), "DR Congo");
  assert.equal(labelText("India"), "India");
});

test("label anchors on the largest landmass, not the all-islands average", () => {
  const [lbl] = layoutLabels([USA], world.forward, measure);
  assert.ok(lbl, "USA should be labelled at world zoom");
  assert.equal(lbl!.text, "USA");
  // mainland projects to x∈[60,105], y∈[42,60]; the anchor must fall inside it.
  assert.ok(lbl!.x > 60 && lbl!.x < 105, `x ${lbl!.x} should be within the mainland`);
  assert.ok(lbl!.y > 42 && lbl!.y < 60, `y ${lbl!.y} should be within the mainland`);
});

test("font scales with the map zoom, the same regardless of country size", () => {
  // A much smaller country (short name, so width never constrains it) than the USA.
  const MID: MapFeature = {
    iso: "MID",
    name: "Peru",
    geometry: { type: "Polygon", coordinates: [[[0, 0], [26, 0], [26, 26], [0, 26], [0, 0]]] },
  };
  // Same country, higher zoom -> bigger font.
  const [a] = layoutLabels([USA], world.forward, measure, { zoom: 1 });
  const [b] = layoutLabels([USA], world.forward, measure, { zoom: 8 });
  assert.ok(b!.fontPx > a!.fontPx, `zoomed font ${b!.fontPx} should exceed ${a!.fontPx}`);

  // A huge country and a smaller one get the SAME font at the same zoom (no huge static labels).
  const big = layoutLabels([USA], world.forward, measure, { zoom: 4 })[0];
  const mid = layoutLabels([MID], world.forward, measure, { zoom: 4 })[0];
  assert.equal(big!.fontPx, mid!.fontPx);
});

test("a small country is culled when tiny but appears once zoomed in", () => {
  const EQG: MapFeature = {
    iso: "GNQ",
    name: "Equatorial Guinea",
    geometry: { type: "Polygon", coordinates: [[[9, 1], [12, 1], [12, 3], [9, 3], [9, 1]]] },
  };
  assert.equal(layoutLabels([EQG], world.forward, measure).length, 0, "too small at world zoom");
  const zoomed = layoutLabels([EQG], zoomBig.forward, measure);
  assert.equal(zoomed.length, 1);
  assert.equal(zoomed[0]!.text, "Eq. Guinea");
});

test("a placed label always stays on its own landmass, never pushed onto a neighbour (Togo & Benin)", () => {
  // Two tall, thin, adjacent countries whose horizontal labels collide if both are centred.
  const TOGO: MapFeature = { iso: "TGO", name: "Togo", geometry: { type: "Polygon", coordinates: [[[0, 4], [3, 4], [3, 11], [0, 11], [0, 4]]] } };
  const BENIN: MapFeature = { iso: "BEN", name: "Benin", geometry: { type: "Polygon", coordinates: [[[3, 4], [6, 4], [6, 11], [3, 11], [3, 4]]] } };
  const placed = layoutLabels([TOGO, BENIN], zoom10.forward, measure, { zoom: 8 });
  assert.ok(!anyOverlap(placed), "labels must not overlap");
  for (const l of placed) {
    const bb = projBbox(l.text === "Togo" ? TOGO : BENIN, zoom10.forward);
    assert.ok(l.x >= bb.minX && l.x <= bb.maxX, `${l.text} x=${l.x} must stay within its country [${bb.minX},${bb.maxX}]`);
    assert.ok(l.y >= bb.minY && l.y <= bb.maxY, `${l.text} y=${l.y} must stay within its country [${bb.minY},${bb.maxY}]`);
  }
});

test("Haiti keeps its label beside the Dominican Republic (shift toward open sea, don't drop)", () => {
  const HAI: MapFeature = { iso: "HTI", name: "Haiti", geometry: { type: "Polygon", coordinates: [[[-74, 18], [-71.5, 18], [-71.5, 20], [-74, 20], [-74, 18]]] } };
  const DOM: MapFeature = { iso: "DOM", name: "Dominican Republic", geometry: { type: "Polygon", coordinates: [[[-71.5, 17.5], [-68, 17.5], [-68, 20], [-71.5, 20], [-71.5, 17.5]]] } };
  const placed = layoutLabels([HAI, DOM], zoomBig.forward, measure, { zoom: 12 });
  const texts = placed.map((l) => l.text);
  assert.ok(texts.includes("Haiti"), "Haiti must keep its label, not be dropped");
  assert.ok(texts.includes("Dominican Rep."), "the Dominican Republic keeps its label too");
  assert.ok(!anyOverlap(placed), "labels must not overlap");
  for (const l of placed) {
    const bb = projBbox(l.text === "Haiti" ? HAI : DOM, zoomBig.forward);
    assert.ok(l.x >= bb.minX && l.x <= bb.maxX && l.y >= bb.minY && l.y <= bb.maxY, `${l.text} anchor must stay on its own country`);
  }
});

test("a small island keeps its label even when the name is wider than the island (Puerto Rico)", () => {
  const PR: MapFeature = { iso: "PRI", name: "Puerto Rico", geometry: { type: "Polygon", coordinates: [[[-67.3, 17.9], [-65.6, 17.9], [-65.6, 18.5], [-67.3, 18.5], [-67.3, 17.9]]] } };
  assert.equal(layoutLabels([PR], world.forward, measure).length, 0, "too small at world zoom");
  const zoomed = layoutLabels([PR], zoomBig.forward, measure, { zoom: 12 });
  assert.equal(zoomed.length, 1, "appears when zoomed in, overflowing into the sea");
  assert.equal(zoomed[0]!.text, "Puerto Rico");
  const bb = projBbox(PR, zoomBig.forward);
  assert.ok(zoomed[0]!.x >= bb.minX && zoomed[0]!.x <= bb.maxX, "anchor stays on the island");
});

test("when there's no on-country slot, the label is dropped — never relocated onto a neighbour", () => {
  // A small country (little vertical room) sandwiched between two others whose labels take the space.
  const N: MapFeature = { iso: "NNN", name: "Np", geometry: { type: "Polygon", coordinates: [[[0, 8], [6, 8], [6, 9], [0, 9], [0, 8]]] } };
  const T: MapFeature = { iso: "TTT", name: "Tp", geometry: { type: "Polygon", coordinates: [[[0, 6.5], [6, 6.5], [6, 7.5], [0, 7.5], [0, 6.5]]] } };
  const S: MapFeature = { iso: "SSS", name: "Sp", geometry: { type: "Polygon", coordinates: [[[0, 5], [6, 5], [6, 6], [0, 6], [0, 5]]] } };
  const placed = layoutLabels([N, T, S], zoom10.forward, measure, { zoom: 6 });
  assert.ok(!anyOverlap(placed), "no overlaps");
  for (const l of placed) {
    const f = l.text === "Np" ? N : l.text === "Tp" ? T : S;
    const bb = projBbox(f, zoom10.forward);
    assert.ok(l.x >= bb.minX && l.x <= bb.maxX && l.y >= bb.minY && l.y <= bb.maxY, `${l.text} must stay on its own country`);
  }
});
