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
): void {
  const { canvas } = ctx;
  ctx.fillStyle = style.ocean;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = style.border;

  for (const f of features) {
    ctx.beginPath();
    tracePath(ctx, f.geometry, projection);
    ctx.fillStyle = fillFor(f.iso, state, style);
    ctx.fill("evenodd");
    ctx.stroke();
  }
}
