import assert from "node:assert/strict";
import { test } from "node:test";
import { bearingDeg, compassPoint, equirectangular, geometryBounds, haversineKm, inViewport } from "./geometry.ts";
import { resolveTap } from "./hittest.ts";
import { wheelZoomFactor } from "./index.ts";
import type { MapFeature } from "./types.ts";

test("wheelZoomFactor: scroll direction, proportional to distance, clamped, device-normalized", () => {
  assert.ok(wheelZoomFactor(-100) > 1, "scroll up zooms in");
  assert.ok(wheelZoomFactor(100) < 1, "scroll down zooms out");
  // proportional: a bigger scroll zooms more (this is what stops touchpads over-zooming per gesture)
  assert.ok(wheelZoomFactor(-200) > wheelZoomFactor(-50), "bigger delta -> more zoom");
  // a single huge event is clamped so it can't jump the zoom
  assert.equal(wheelZoomFactor(-100000), Math.exp(0.5));
  // line-mode (mouse) deltas are scaled up so a notch still zooms meaningfully vs pixel touchpads
  assert.ok(wheelZoomFactor(-3, 1) > wheelZoomFactor(-3, 0), "line-mode notch zooms more than one pixel");
});

test("inViewport: true when a feature's box overlaps the canvas, false when off-screen", () => {
  const proj = equirectangular({ width: 360, height: 180 }); // 1px/°, no zoom
  // Viewport is only the top-left 50×50 px of that projection.
  // lon[-180,-170] -> x[0,10], lat[80,90] -> y[0,10]  => inside the 50×50 canvas.
  assert.equal(inViewport([-180, 80, -170, 90], proj.forward, 50, 50), true);
  // lon[-10,10] -> x[170,190], off the 50px-wide canvas.
  assert.equal(inViewport([-10, -10, 10, 10], proj.forward, 50, 50), false);
});

// A projection where 1px ≈ 1° makes the pixel math easy to reason about by hand.
const proj = equirectangular({ width: 360, height: 180 });

const BIG: MapFeature = {
  iso: "BIG",
  geometry: { type: "Polygon", coordinates: [[[-40, 10], [-20, 10], [-20, 30], [-40, 30], [-40, 10]]] },
};
const SMALL: MapFeature = {
  iso: "SML",
  geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
};

test("haversineKm measures great-circle distance", () => {
  assert.equal(Math.round(haversineKm([0, 0], [0, 0])), 0);
  // 1 degree of latitude is ~111 km anywhere on the globe.
  assert.ok(Math.abs(haversineKm([0, 0], [0, 1]) - 111) < 2);
  // London -> Paris is ~344 km.
  assert.ok(Math.abs(haversineKm([-0.13, 51.51], [2.35, 48.86]) - 344) < 15);
});

test("bearingDeg gives the compass direction from one point to another", () => {
  assert.equal(Math.round(bearingDeg([0, 0], [0, 10])), 0); // due north
  assert.equal(Math.round(bearingDeg([0, 0], [10, 0])), 90); // due east
  assert.equal(Math.round(bearingDeg([0, 0], [0, -10])), 180); // due south
  assert.equal(Math.round(bearingDeg([0, 0], [-10, 0])), 270); // due west
  const ne = bearingDeg([0, 0], [10, 10]); // north-east quadrant
  assert.ok(ne > 0 && ne < 90, `expected NE, got ${ne}`);
});

test("compassPoint names the bearing for screen readers", () => {
  assert.equal(compassPoint(0), "north");
  assert.equal(compassPoint(90), "east");
  assert.equal(compassPoint(225), "south-west");
  assert.equal(compassPoint(359), "north"); // wraps
});

test("a tap inside a country resolves to that country", () => {
  const [x, y] = proj.forward([-30, 20]);
  assert.equal(resolveTap(x, y, proj, [BIG, SMALL]), "BIG");
});

test("when polygons overlap, a tap resolves to the SMALLER country (micro-state over a coarse neighbour)", () => {
  // Mimics Singapore (fine) sitting inside Malaysia's coarse 1:110m polygon. The big country is
  // listed first, but the tap must pick the small enclave, not the neighbour that overlaps it.
  const COARSE: MapFeature = { iso: "MYS", geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } };
  const ENCLAVE: MapFeature = { iso: "SGP", geometry: { type: "Polygon", coordinates: [[[4, 4], [5, 4], [5, 5], [4, 5], [4, 4]]] } };
  const [x, y] = proj.forward([4.5, 4.5]); // inside both polygons
  assert.equal(resolveTap(x, y, proj, [COARSE, ENCLAVE]), "SGP");
});

// --- micro-state magnetism ----------------------------------------------------------------------
// A landlocked micro-state is ~4x7px even at max zoom and sits INSIDE its neighbour, so a near-miss
// lands in the big country by containment and snapping can never rescue it. Nobody aiming at
// Switzerland aims 5px from the Liechtenstein border, so a tiny country close to the tap wins.
const BIGCOUNTRY: MapFeature = {
  iso: "CHE",
  geometry: { type: "Polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]]] },
};
const MICRO: MapFeature = {
  iso: "LIE",
  geometry: { type: "Polygon", coordinates: [[[20, 20], [20.4, 20], [20.4, 20.7], [20, 20.7], [20, 20]]] },
};

test("a tap just outside a micro-state prefers it over the country containing the tap", () => {
  const [x, y] = proj.forward([19.5, 20.3]); // ~0.5px outside LIE, inside CHE
  assert.equal(resolveTap(x, y, proj, [BIGCOUNTRY, MICRO]), "LIE");
});

test("a tap inside the micro-state still resolves to it", () => {
  const [x, y] = proj.forward([20.2, 20.35]);
  assert.equal(resolveTap(x, y, proj, [BIGCOUNTRY, MICRO]), "LIE");
});

test("magnetism is local — a tap well away from the micro-state gets the big country", () => {
  const [x, y] = proj.forward([5, 5]);
  assert.equal(resolveTap(x, y, proj, [BIGCOUNTRY, MICRO]), "CHE");
});

test("magnetism does not fire for a merely-smaller neighbour, only a much smaller one", () => {
  // Two comparable countries side by side: tapping inside one must not jump to the other, which is
  // what a purely absolute size threshold would do at low zoom where everything is small on screen.
  const A: MapFeature = { iso: "AAA", geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } };
  const B: MapFeature = { iso: "BBB", geometry: { type: "Polygon", coordinates: [[[10, 0], [18, 0], [18, 10], [10, 10], [10, 0]]] } };
  const [x, y] = proj.forward([9.7, 5]); // inside A, a hair from B's border
  assert.equal(resolveTap(x, y, proj, [A, B]), "AAA");
});

test("snapPx tolerance is measured in pixels: within snaps, beyond does not", () => {
  const [x, y] = proj.forward([-1, 0.5]); // ~1px west of SMALL's border, open ocean
  assert.equal(resolveTap(x, y, proj, [BIG, SMALL], { snapPx: 24 }), "SML");
  assert.equal(resolveTap(x, y, proj, [BIG, SMALL], { snapPx: 0.5 }), null);
});

test("snapping picks the country whose BORDER is nearest, not whose CENTROID is nearest", () => {
  // WRAP is two rectangles far apart; the mean of its vertices (the old snap point) lands in the
  // ocean gap between them, right where the tap is — but its actual borders are ~18px away.
  const WRAP: MapFeature = {
    iso: "WRP",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [[[-20, -1], [-18, -1], [-18, 1], [-20, 1], [-20, -1]]],
        [[[18, -1], [20, -1], [20, 1], [18, 1], [18, -1]]],
      ],
    },
  };
  const NEAR: MapFeature = {
    iso: "NER",
    geometry: { type: "Polygon", coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] },
  };
  const [x, y] = proj.forward([0, 0]); // on WRAP's centroid, but ~1.4px from NEAR's corner
  assert.equal(resolveTap(x, y, proj, [WRAP, NEAR], { snapPx: 24 }), "NER");
});

test("an archipelago nation is selectable near any island (its centroid is in open ocean)", () => {
  const ARC: MapFeature = {
    iso: "ARC",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [[[-50, 0], [-49, 0], [-49, 1], [-50, 1], [-50, 0]]],
        [[[49, 0], [50, 0], [50, 1], [49, 1], [49, 0]]],
      ],
    },
  };
  const [x, y] = proj.forward([48, 0.5]); // ~1px west of the eastern island, open ocean
  assert.equal(resolveTap(x, y, proj, [ARC], { snapPx: 24 }), "ARC");
});

test("zooming in tightens snapping: a near-miss that snaps at world view misses when zoomed", () => {
  const world = equirectangular({ width: 360, height: 180 }); // ~1px/°
  const zoomed = equirectangular({ width: 3600, height: 1800 }); // ~10px/° (10x zoom)
  const miss: [number, number] = [-2, 0.5]; // 2° west of SMALL's border, open ocean
  const [wx, wy] = world.forward(miss); // ~2px away
  const [zx, zy] = zoomed.forward(miss); // ~20px away
  assert.equal(resolveTap(wx, wy, world, [SMALL], { snapPx: 5 }), "SML"); // 2px < 5 -> snaps
  assert.equal(resolveTap(zx, zy, zoomed, [SMALL], { snapPx: 5 }), null); // 20px > 5 -> no snap
});

test("snapPx:0 disables snapping (exact containment only)", () => {
  const [x, y] = proj.forward([-1, 0.5]); // just outside SMALL
  assert.equal(resolveTap(x, y, proj, [BIG, SMALL], { snapPx: 0 }), null);
});

test("geometryBounds returns the lon/lat extent of a feature", () => {
  assert.deepEqual(geometryBounds(BIG.geometry), [-40, 10, -20, 30]);
});
