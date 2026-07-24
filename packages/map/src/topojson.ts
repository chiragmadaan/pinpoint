// Minimal TopoJSON -> MapFeature[] decoder. Dependency-free (no topojson-client) so the bundle
// stays tiny. Supports the world-atlas format: quantized `transform` + delta-encoded arcs, and
// Polygon / MultiPolygon geometries in a named GeometryCollection object.
//
// world-atlas `countries-110m.json` keys countries by NUMERIC ISO id (e.g. "250" = France) with a
// `properties.name`. Our engine keys on alpha-3, so pass `getIso` to map numeric id -> alpha-3
// (e.g. via a small lookup table). Default uses String(id) so the decoder is usable/testable alone.

import type { Geometry, Iso3, LonLat, MapFeature, Ring } from "./types.ts";

interface Topology {
  type: "Topology";
  transform?: { scale: [number, number]; translate: [number, number] };
  arcs: number[][][];
  objects: Record<string, TopoGeometryCollection>;
}
interface TopoGeometryCollection {
  type: "GeometryCollection";
  geometries: TopoGeometry[];
}
interface TopoGeometry {
  type: "Polygon" | "MultiPolygon";
  arcs: number[][] | number[][][];
  id?: string | number;
  properties?: Record<string, unknown>;
}

/** Decode all arcs to absolute [lon,lat] coordinate lists, undoing quantization if present. */
function decodeArcs(topology: Topology): LonLat[][] {
  const t = topology.transform;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      if (t) {
        x += dx!; // deltas accumulate along the arc
        y += dy!;
        return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]] as LonLat;
      }
      return [dx!, dy!] as LonLat;
    });
  });
}

/** Stitch a list of arc indices into one ring. Negative index ~i means arc i, reversed. */
function ringFromArcIndices(indices: number[], arcs: LonLat[][]): Ring {
  const ring: Ring = [];
  for (const idx of indices) {
    const arc = idx < 0 ? [...arcs[~idx]!].reverse() : arcs[idx]!;
    // drop the shared join point between consecutive arcs
    ring.push(...(ring.length ? arc.slice(1) : arc));
  }
  return ring;
}

function toGeometry(geom: TopoGeometry, arcs: LonLat[][]): Geometry {
  if (geom.type === "Polygon") {
    const rings = (geom.arcs as number[][]).map((r) => ringFromArcIndices(r, arcs));
    return { type: "Polygon", coordinates: rings };
  }
  const polys = (geom.arcs as number[][][]).map((poly) =>
    poly.map((r) => ringFromArcIndices(r, arcs)),
  );
  return { type: "MultiPolygon", coordinates: polys };
}

export interface AdapterOptions {
  /** Map a topology geometry to our alpha-3 iso. Default: String(id). */
  getIso?: (geom: { id?: string | number; properties?: Record<string, unknown> }) => Iso3;
  getName?: (geom: { id?: string | number; properties?: Record<string, unknown> }) => string | undefined;
}

/** Convert a TopoJSON topology's named object into MapFeature[]. */
export function topojsonToFeatures(
  topology: Topology,
  objectName: string,
  opts: AdapterOptions = {},
): MapFeature[] {
  const object = topology.objects[objectName];
  if (!object) throw new Error(`TopoJSON object "${objectName}" not found`);
  const arcs = decodeArcs(topology);
  const getIso = opts.getIso ?? ((g) => String(g.id ?? ""));
  const getName = opts.getName ?? ((g) => (g.properties?.name as string | undefined));
  return object.geometries.map((g) => ({
    iso: getIso(g),
    name: getName(g),
    geometry: toGeometry(g, arcs),
  }));
}
