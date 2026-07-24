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

/** Rough centroid: mean of all outer-ring vertices. Good enough for nearest-country snapping. */
export function centroid(geom: Geometry): LonLat {
  const outers: Ring[] =
    geom.type === "Polygon"
      ? [geom.coordinates[0]!]
      : geom.coordinates.map((poly) => poly[0]!).filter(Boolean);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const ring of outers) {
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
      n++;
    }
  }
  return n === 0 ? [0, 0] : [sx / n, sy / n];
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

/** Great-circle distance in km between two lon/lat points. */
export function haversineKm(a: LonLat, b: LonLat): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
