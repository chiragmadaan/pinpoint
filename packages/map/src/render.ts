import { inViewport } from "./geometry.ts";
import { layoutLabels } from "./labels.ts";
import type { Geometry, Iso3, MapFeature, Projection } from "./types.ts";

export interface MapStyle {
  ocean: string;
  land: string;
  border: string;
  selected: string;
  correct: string;
  wrong: string;
}

export const DEFAULT_STYLE: MapStyle = {
  ocean: "#0b1e33",
  land: "#2b4a63",
  border: "#12293d",
  selected: "#f2c14e",
  correct: "#3ea672", // colorblind-safe pairing; UI should ALSO use icons, not color alone
  wrong: "#d1495b",
};

export interface RenderState {
  selected?: Iso3 | null;
  /** Set during answer reveal. */
  correct?: Iso3 | null;
  guess?: Iso3 | null;
  /** Draw country-name labels (the "names" aid). */
  labels?: boolean;
}

function tracePath(ctx: CanvasRenderingContext2D, geom: Geometry, projection: Projection): void {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      ring.forEach((ll, i) => {
        const [x, y] = projection.forward(ll);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
  }
}

function fillFor(iso: Iso3, state: RenderState, style: MapStyle): string {
  if (state.correct && iso === state.correct) return style.correct;
  if (state.guess && iso === state.guess && iso !== state.correct) return style.wrong;
  if (state.selected && iso === state.selected) return style.selected;
  return style.land;
}

/** Draw the whole map for the current interaction/reveal state. */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  features: MapFeature[],
  projection: Projection,
  state: RenderState = {},
  style: MapStyle = DEFAULT_STYLE,
  zoom = 1,
  bounds?: [number, number, number, number][], // precomputed lon/lat bbox per feature, for culling
): void {
  const { canvas } = ctx;
  ctx.fillStyle = style.ocean;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = style.border;

  for (let i = 0; i < features.length; i++) {
    // Viewport culling: skip countries whose bbox is entirely off-screen (big win when zoomed in).
    if (bounds && !inViewport(bounds[i]!, projection.forward, canvas.width, canvas.height)) continue;
    const f = features[i]!;
    ctx.beginPath();
    tracePath(ctx, f.geometry, projection);
    ctx.fillStyle = fillFor(f.iso, state, style);
    ctx.fill("evenodd");
    ctx.stroke();
  }

  if (state.labels) drawLabels(ctx, features, projection, zoom);
}

/**
 * Country-name labels. Placement/sizing/abbreviation/collision all live in the pure `layoutLabels`;
 * here we just supply canvas text measurement and paint the results (halo stroke + fill).
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  features: MapFeature[],
  projection: Projection,
  zoom: number,
): void {
  const { canvas } = ctx;
  const measure = (text: string, fontPx: number): number => {
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    return ctx.measureText(text).width;
  };
  const labels = layoutLabels(features, projection.forward, measure, {
    zoom,
    viewport: { width: canvas.width, height: canvas.height },
  });

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const l of labels) {
    ctx.font = `600 ${l.fontPx}px system-ui, sans-serif`;
    ctx.lineWidth = Math.max(2, l.fontPx / 6); // halo scales with the text so small labels stay crisp
    ctx.strokeStyle = "rgba(11,30,51,0.9)";
    ctx.strokeText(l.text, l.x, l.y);
    ctx.fillStyle = "#eaf2f8";
    ctx.fillText(l.text, l.x, l.y);
  }
}
