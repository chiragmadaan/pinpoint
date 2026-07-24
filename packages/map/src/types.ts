// Minimal geo types. Kept local (no @pinpoint/core import) so this package is standalone.

/** ISO 3166-1 alpha-3, e.g. "FRA". */
export type Iso3 = string;

/** [longitude, latitude] — GeoJSON order. */
export type LonLat = [number, number];

/** A linear ring of coordinates (first != last is fine; we treat it as closed). */
export type Ring = LonLat[];

export type Geometry =
  | { type: "Polygon"; coordinates: Ring[] } // [outer, ...holes]
  | { type: "MultiPolygon"; coordinates: Ring[][] };

export interface MapFeature {
  iso: Iso3;
  name?: string;
  geometry: Geometry;
}

/** Screen pixel size of the canvas. */
export interface Viewport {
  width: number;
  height: number;
}

/** A 2D map projection with an invertible transform (pixels <-> lon/lat). */
export interface Projection {
  forward(ll: LonLat): [number, number];
  inverse(xy: [number, number]): LonLat;
}
