import assert from "node:assert/strict";
import { test } from "node:test";
import { equirectangular } from "./geometry.ts";
import { resolveLonLat, resolveTap } from "./hittest.ts";
import type { MapFeature } from "./types.ts";

// Two big square "countries" and one tiny one, in lon/lat space.
const BIG_WEST: MapFeature = {
  iso: "AAA",
  geometry: { type: "Polygon", coordinates: [[[-40, 10], [-20, 10], [-20, 30], [-40, 30], [-40, 10]]] },
};
const BIG_EAST: MapFeature = {
  iso: "BBB",
  geometry: { type: "Polygon", coordinates: [[[20, 10], [40, 10], [40, 30], [20, 30], [20, 10]]] },
};
const TINY: MapFeature = {
  iso: "TNY",
  geometry: { type: "Polygon", coordinates: [[[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2], [0, 0]]] },
};
const FEATURES = [BIG_WEST, BIG_EAST, TINY];

test("tap inside a country resolves to that country", () => {
  assert.equal(resolveLonLat([-30, 20], FEATURES), "AAA");
  assert.equal(resolveLonLat([30, 20], FEATURES), "BBB");
});

test("tap near a micro-nation snaps to it within tolerance", () => {
  // ~100km east of the tiny country's centroid — not inside any polygon.
  assert.equal(resolveLonLat([1, 0.1], FEATURES, { snapKm: 600 }), "TNY");
});

test("tap in open ocean with snapping disabled returns null", () => {
  assert.equal(resolveLonLat([0, -80], FEATURES, { snapKm: 0 }), null);
});

test("projection round-trips and resolveTap maps a pixel to the right country", () => {
  const proj = equirectangular({ width: 360, height: 180 });
  // lon=-30,lat=20 -> pixel; feed pixel back through resolveTap.
  const [px, py] = proj.forward([-30, 20]);
  assert.equal(resolveTap(px, py, proj, FEATURES), "AAA");
});
