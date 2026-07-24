import { centroid, haversineKm, pointInGeometry } from "./geometry.ts";
import type { Iso3, LonLat, MapFeature, Projection } from "./types.ts";

export interface HitOptions {
  /**
   * Snap tolerance in km. If a tap lands in no country (ocean) but within this distance of a
   * country's centroid, we snap to it. This is what makes micro-nations (Singapore, Malta,
   * Vatican) selectable — the core fat-finger fix. 0 disables snapping.
   */
  snapKm?: number;
}

const DEFAULT_SNAP_KM = 600;

/** Resolve a lon/lat to a country: exact containment first, else nearest centroid within snapKm. */
export function resolveLonLat(
  pt: LonLat,
  features: MapFeature[],
  opts: HitOptions = {},
): Iso3 | null {
  for (const f of features) {
    if (pointInGeometry(pt, f.geometry)) return f.iso;
  }
  const snapKm = opts.snapKm ?? DEFAULT_SNAP_KM;
  if (snapKm <= 0) return null;

  let best: { iso: Iso3; km: number } | null = null;
  for (const f of features) {
    const km = haversineKm(pt, centroid(f.geometry));
    if (km <= snapKm && (best === null || km < best.km)) best = { iso: f.iso, km };
  }
  return best?.iso ?? null;
}

/** Resolve a canvas pixel tap to a country by inverting the projection then hit-testing. */
export function resolveTap(
  px: number,
  py: number,
  projection: Projection,
  features: MapFeature[],
  opts: HitOptions = {},
): Iso3 | null {
  return resolveLonLat(projection.inverse([px, py]), features, opts);
}
