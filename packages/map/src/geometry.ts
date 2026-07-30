import type { Geometry, LonLat, Projection, Ring, Viewport } from "./types.ts";

/**
 * Equirectangular (plate carrée) projection. Chosen deliberately: the tap math is trivial and
 * exactly invertible, which is what a "tap the country" game needs. It's dependency-free (no d3),
 * so the Playable bundle stays tiny. A prettier projection (Natural Earth) can be swapped in later
 * behind this same Projection interface — nothing else in the codebase depends on the internals.
 */
export function equirectangular(vp: Viewport): Projection {
  const { width, height } = vp;
  return {
    forward([lon, lat]) {
      return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
    },
    inverse([x, y]) {
      return [(x / width) * 360 - 180, 90 - (y / height) * 180];
    },
  };
}

/** Ray-casting point-in-ring test on [lon,lat] coordinates. */
export function pointInRing(pt: LonLat, ring: Ring): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring AND not inside any hole. */
function pointInPolygon(pt: LonLat, rings: Ring[]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !pointInRing(pt, outer)) return false;
  return !holes.some((h) => pointInRing(pt, h));
}

export function pointInGeometry(pt: LonLat, geom: Geometry): boolean {
  if (geom.type === "Polygon") return pointInPolygon(pt, geom.coordinates);
  return geom.coordinates.some((poly) => pointInPolygon(pt, poly));
}

/** Signed area of a ring (planar shoelace). Sign encodes winding order. */
export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [xi, yi] = ring[i]!;
    const [xn, yn] = ring[(i + 1) % ring.length]!;
    a += xi * yn - xn * yi;
  }
  return a / 2;
}

/**
 * The largest outer ring of a geometry by absolute area — i.e. the main landmass. Label placement
 * uses this so a country's name sits on its mainland instead of being averaged out into the ocean
 * by far-flung islands (the reason "United States of America" drifted to the top-left).
 */
export function largestOuterRing(geom: Geometry): Ring | null {
  if (geom.type === "Polygon") return geom.coordinates[0] ?? null;
  let best: Ring | null = null;
  let bestArea = -1;
  for (const poly of geom.coordinates) {
    const outer = poly[0];
    if (!outer) continue;
    const a = Math.abs(ringArea(outer));
    if (a > bestArea) {
      bestArea = a;
      best = outer;
    }
  }
  return best;
}

/** Area-weighted centroid of a planar polygon ring (falls back to the vertex mean if degenerate). */
export function polygonCentroidXY(pts: [number, number][]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [xi, yi] = pts[i]!;
    const [xn, yn] = pts[(i + 1) % pts.length]!;
    const cross = xi * yn - xn * yi;
    a += cross;
    cx += (xi + xn) * cross;
    cy += (yi + yn) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    let mx = 0;
    let my = 0;
    for (const [x, y] of pts) {
      mx += x;
      my += y;
    }
    return [mx / pts.length, my / pts.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Lon/lat bounding box of a geometry: [minLon, minLat, maxLon, maxLat]. */
export function geometryBounds(geom: Geometry): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const rings: Ring[] = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

/** Shortest distance from planar point `p` to the segment `a`-`b` (same units as the inputs). */
export function pointToSegmentDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Min distance from projected point `p` to `geom`, measured in the projected (pixel) space: every
 * lon/lat vertex is mapped through `project` first. Returns 0 when `p` is inside the geometry
 * (within the outer ring and not in a hole). This is the basis of pixel-accurate, zoom-aware tap
 * snapping — unlike centroid distance, it stays correct for archipelago nations (whose centroid
 * sits in open ocean) and for tight island clusters.
 */
export function projectedDistanceToGeometry(
  p: [number, number],
  geom: Geometry,
  project: (ll: LonLat) => [number, number],
): number {
  const polys: Ring[][] = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best = Infinity;
  for (const rings of polys) {
    const projected = rings.map((r) => r.map(project));
    const [outer, ...holes] = projected;
    if (!outer) continue;
    // The equirectangular projection is affine, so ray-casting on projected coords is exact.
    if (pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h))) return 0;
    for (const ring of projected) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = pointToSegmentDistance(p, ring[j]!, ring[i]!);
        if (d < best) best = d;
      }
    }
  }
  return best;
}
