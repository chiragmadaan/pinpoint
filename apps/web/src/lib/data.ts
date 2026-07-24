import type { Adjacency, PuzzleCalendar } from "@pinpoint/core";
import { topojsonToFeatures, type MapFeature } from "@pinpoint/map";

const base = import.meta.env.BASE_URL;

/** Load the pre-generated daily calendar (static asset — no backend). */
export async function loadCalendar(): Promise<PuzzleCalendar> {
  const res = await fetch(base + "questions.json");
  return (await res.json()) as PuzzleCalendar;
}

/** Load country adjacency (iso3 -> bordering iso3[]) for neighbor partial-credit. */
export async function loadAdjacency(): Promise<Adjacency> {
  try {
    const res = await fetch(base + "adjacency.json");
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as Adjacency;
  } catch {
    return {};
  }
}

interface GeoJsonFeature {
  id: string; // ISO alpha-3 in this dataset
  properties?: { name?: string };
  geometry: MapFeature["geometry"];
}
interface GeoJsonFC {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

/**
 * Real country shapes. `countries.geo.json` is a FeatureCollection already keyed by ISO alpha-3
 * (feature.id), so it maps straight onto our MapFeature[] — no numeric-code table needed.
 * Falls back to the rectangular sample set if the file is missing.
 */
export async function loadFeatures(): Promise<MapFeature[]> {
  try {
    const res = await fetch(base + "countries.geo.json");
    if (!res.ok) throw new Error(String(res.status));
    const fc = (await res.json()) as GeoJsonFC;
    return fc.features.map((f) => ({ iso: f.id, name: f.properties?.name, geometry: f.geometry }));
  } catch {
    const res = await fetch(base + "sample-features.json");
    return (await res.json()) as MapFeature[];
  }
}

/**
 * PROD path. world-atlas `countries-110m.json` keys by NUMERIC ISO id, so pass a numeric->alpha-3
 * map (generate one from Wikidata in tools/content-gen). Drop the atlas file in apps/web/public/.
 *
 *   const topo = await (await fetch(base + "countries-110m.json")).json();
 *   const features = featuresFromTopoJSON(topo, numericToAlpha3);
 */
export function featuresFromTopoJSON(
  topology: unknown,
  numericToAlpha3: Record<string, string>,
): MapFeature[] {
  return topojsonToFeatures(topology as never, "countries", {
    getIso: (g) => numericToAlpha3[String(g.id)] ?? String(g.id),
  });
}
