import { largestOuterRing, projectedDistanceToGeometry, ringArea } from "./geometry.ts";
import type { Iso3, LonLat, MapFeature, Projection } from "./types.ts";

export interface HitOptions {
  /**
   * Snap tolerance in *screen pixels*. If a tap lands in no country but within this distance of a
   * country's border, we snap to it — this is what makes micro-nations and clustered islands
   * selectable (the core fat-finger fix). Because it's measured in pixels (not km), snapping
   * tightens automatically as you zoom in, which is what lets you separate a cluster by zooming.
   * 0 disables snapping (exact containment only).
   */
  snapPx?: number;
}

const DEFAULT_SNAP_PX = 24;

/**
 * Resolve a projected point to a country by distance to each country's *border* in the projected
 * (pixel) space. Exact containment wins (distance 0); otherwise the nearest border within
 * `tolerance` is selected, or null if nothing is close enough.
 *
 * This replaces centroid-distance snapping, which mis-fired two ways: archipelago nations have a
 * centroid out in open ocean (far from every island), and in tight clusters the nearest *centroid*
 * is often not the country your finger is actually over.
 *
 * When several polygons contain the tap (a micro-state sitting inside a coarser neighbour's
 * polygon — e.g. Singapore over Malaysia, Vatican over Italy), the SMALLEST one wins, so enclaves
 * stay selectable instead of being swallowed by the bigger country listed first.
 */
export function resolveNearest(
  tap: [number, number],
  features: MapFeature[],
  project: (ll: LonLat) => [number, number],
  tolerance: number,
): Iso3 | null {
  let inside: { iso: Iso3; area: number } | null = null; // smallest containing country
  let best: { iso: Iso3; d: number } | null = null; // nearest border within tolerance
  for (const f of features) {
    const d = projectedDistanceToGeometry(tap, f.geometry, project);
    if (d === 0) {
      const ring = largestOuterRing(f.geometry);
      const area = ring ? Math.abs(ringArea(ring)) : 0;
      if (inside === null || area < inside.area) inside = { iso: f.iso, area };
    } else if (d <= tolerance && (best === null || d < best.d)) {
      best = { iso: f.iso, d };
    }
  }
  return inside?.iso ?? best?.iso ?? null;
}

/** Resolve a canvas pixel tap to a country using the (zoom-aware) view projection. */
export function resolveTap(
  sx: number,
  sy: number,
  projection: Projection,
  features: MapFeature[],
  opts: HitOptions = {},
): Iso3 | null {
  return resolveNearest([sx, sy], features, projection.forward, opts.snapPx ?? DEFAULT_SNAP_PX);
}
