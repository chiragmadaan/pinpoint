import assert from "node:assert/strict";
import { test } from "node:test";
import { pointInGeometry } from "./geometry.ts";
import { resolveLonLat } from "./hittest.ts";
import { topojsonToFeatures } from "./topojson.ts";

// A tiny quantized topology: one square country "FRA" made of a single closed arc.
// transform maps quantized ints -> lon/lat. Arc deltas are quantized.
const topology = {
  type: "Topology" as const,
  transform: { scale: [0.001, 0.001] as [number, number], translate: [10, 40] as [number, number] },
  // absolute quantized points: (0,0)->(10,40), (10000,0)->(20,40), (10000,10000)->(20,50),
  // (0,10000)->(10,50), back to (0,0). Encoded as deltas:
  arcs: [[[0, 0], [10000, 0], [0, 10000], [-10000, 0], [0, -10000]]],
  objects: {
    countries: {
      type: "GeometryCollection" as const,
      geometries: [{ type: "Polygon" as const, arcs: [[0]], id: "250", properties: { name: "France" } }],
    },
  },
};

test("decodes a quantized TopoJSON polygon into a usable feature", () => {
  const features = topojsonToFeatures(topology, "countries", {
    getIso: (g) => (g.id === "250" ? "FRA" : String(g.id)),
  });
  assert.equal(features.length, 1);
  const f = features[0]!;
  assert.equal(f.iso, "FRA");
  assert.equal(f.name, "France");
  // The square spans lon 10..20, lat 40..50 — a point in the middle must be inside.
  assert.ok(pointInGeometry([15, 45], f.geometry));
  assert.ok(!pointInGeometry([0, 0], f.geometry));
  // and hit-testing resolves it
  assert.equal(resolveLonLat([15, 45], features, { snapKm: 0 }), "FRA");
});
