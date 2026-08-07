import { largestOuterRing, projectedDistanceToGeometry, projectedMaxDimension, ringArea } from "./geometry.ts";
import type { Iso3, LonLat, MapFeature, Projection } from "./types.ts";

export interface HitOptions {
  /**
   * A country whose largest on-screen dimension is under this is treated as a micro-state and can
   * "magnetise" a nearby tap (see resolveNearest). Absolute cap, so nothing sizeable qualifies.
   */
  microPx?: number;
  /** How close to a micro-state's border a tap must be for it to win. */
  magnetPx?: number;
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
const DEFAULT_MICRO_PX = 40;
const DEFAULT_MAGNET_PX = 12;
/** A magnet must be this many times smaller than the country the tap landed in. */
const MAGNET_SIZE_RATIO = 5;

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
  microPx: number = DEFAULT_MICRO_PX,
  magnetPx: number = DEFAULT_MAGNET_PX,
): Iso3 | null {
  let inside: { iso: Iso3; area: number; geom: MapFeature["geometry"] } | null = null;
  let best: { iso: Iso3; d: number } | null = null; // nearest border within tolerance
  let magnet: { iso: Iso3; d: number; size: number } | null = null; // tiny country beside the tap
  for (const f of features) {
    const d = projectedDistanceToGeometry(tap, f.geometry, project);
    if (d === 0) {
      const ring = largestOuterRing(f.geometry);
      const area = ring ? Math.abs(ringArea(ring)) : 0;
      if (inside === null || area < inside.area) inside = { iso: f.iso, area, geom: f.geometry };
      continue;
    }
    if (d <= tolerance && (best === null || d < best.d)) best = { iso: f.iso, d };
    if (d <= magnetPx && (magnet === null || d < magnet.d)) {
      const size = projectedMaxDimension(f.geometry, project);
      if (size <= microPx) magnet = { iso: f.iso, d, size };
    }
  }
  // A micro-state a few pixels from the finger beats the large country the tap technically landed
  // in: at max zoom Liechtenstein is ~4x7px and fully enclosed, so containment alone made it
  // unselectable. Requires the magnet to be MUCH smaller than its container, otherwise two
  // similar-sized neighbours would steal each other's taps when zoomed out.
  // Only ever overrides CONTAINMENT. Outside every country the ordinary snap tolerance governs, so
  // magnetism cannot smuggle in a hit that snapPx (including snapPx: 0) was meant to reject.
  if (magnet && inside) {
    const containerSize = projectedMaxDimension(inside.geom, project);
    if (containerSize >= magnet.size * MAGNET_SIZE_RATIO) return magnet.iso;
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
  return resolveNearest(
    [sx, sy],
    features,
    projection.forward,
    opts.snapPx ?? DEFAULT_SNAP_PX,
    opts.microPx ?? DEFAULT_MICRO_PX,
    opts.magnetPx ?? DEFAULT_MAGNET_PX,
  );
}
