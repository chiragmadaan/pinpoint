// Self-contained vector world map: renders country polygons to a Canvas and hit-tests taps.
// NO map tiles, NO Street View, NO external calls, NO d3 dependency -> tiny + Playables-safe.
//
// Pure, tested pieces:  geometry.ts (projection + polygon math), hittest.ts (tap -> country).
// DOM glue (createWorldMap) is below: it adds a pan/zoom view transform on top of the base
// projection and distinguishes a tap (select) from a drag (pan). The game's two-tap
// "select then Guess" flow lives in the app.

export * from "./types.ts";
export * from "./geometry.ts";
export * from "./hittest.ts";
export * from "./render.ts";
export * from "./topojson.ts";

import { equirectangular, geometryBounds } from "./geometry.ts";
import { resolveTap, type HitOptions } from "./hittest.ts";
import { DEFAULT_STYLE, drawMap, type MapStyle, type RenderState } from "./render.ts";
import type { Iso3, MapFeature, Projection } from "./types.ts";

export interface WorldMapOptions {
  canvas: HTMLCanvasElement;
  features: MapFeature[];
  /** Fired when the user taps a country (SELECTION only — submission is the app's Guess button). */
  onSelect: (iso: Iso3 | null) => void;
  hit?: HitOptions;
  style?: MapStyle;
  /** Max zoom factor (default 8). */
  maxZoom?: number;
}

export interface WorldMap {
  render(): void;
  highlight(iso: Iso3 | null): void;
  /** Show the outcome. `correctIso` may be several countries when the clue accepts any of them. */
  reveal(guessIso: Iso3, correctIso: Iso3 | Iso3[]): void;
  /** Zoom by a factor around the map centre (for ＋/－ buttons). >1 zooms in, <1 zooms out. */
  zoomBy(factor: number): void;
  /** Toggle country-name labels (the "names" aid). */
  setLabels(enabled: boolean): void;
  /** Clear selection + reveal state AND reset the zoom/pan to the full world view. */
  reset(): void;
  destroy(): void;
}

/**
 * Multiplicative zoom factor for one wheel event, proportional to how far the user scrolled and
 * normalized across devices: pixel touchpads fire many tiny events, line-mode mice a few big ones —
 * so a whole gesture zooms about the same either way (fixes touchpads zooming in far too fast).
 * Clamped so no single event can jump the zoom. deltaY < 0 (scroll up / pinch out) zooms in.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0, viewportHeight = 600): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * viewportHeight : deltaY;
  const exp = Math.max(-0.5, Math.min(0.5, -px * 0.002));
  return Math.exp(exp);
}

/** DOM factory: pan/zoomable map that reports single-tap country selection. */
export function createWorldMap(opts: WorldMapOptions): WorldMap {
  const { canvas, features, onSelect } = opts;
  const style = opts.style ?? DEFAULT_STYLE;
  const maxZoom = opts.maxZoom ?? 8;
  const base = equirectangular({ width: canvas.width, height: canvas.height });
  const byIso = new Map(features.map((f) => [f.iso, f]));
  // lon/lat bounds never change, so precompute once for per-frame viewport culling.
  const featureBounds = features.map((f) => geometryBounds(f.geometry));

  // View transform: screen = base * k + t
  let k = 1;
  let tx = 0;
  let ty = 0;
  let state: RenderState = {};
  let selectable = true; // taps select only during the question phase, not during the reveal
  let showLabels = false; // country-name labels (the "names" aid)

  const proj: Projection = {
    forward(ll) {
      const [x, y] = base.forward(ll);
      return [x * k + tx, y * k + ty];
    },
    inverse([sx, sy]) {
      return base.inverse([(sx - tx) / k, (sy - ty) / k]);
    },
  };

  function clampView(): void {
    k = Math.min(maxZoom, Math.max(1, k));
    tx = Math.min(0, Math.max(canvas.width - canvas.width * k, tx));
    ty = Math.min(0, Math.max(canvas.height - canvas.height * k, ty));
  }

  const render = () => {
    const ctx = canvas.getContext("2d");
    if (ctx) drawMap(ctx, features, proj, { ...state, labels: showLabels }, style, k, featureBounds);
  };

  const toCanvas = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };

  function zoomAround(cx: number, cy: number, factor: number): void {
    const newK = Math.min(maxZoom, Math.max(1, k * factor));
    const ratio = newK / k;
    tx = cx - (cx - tx) * ratio;
    ty = cy - (cy - ty) * ratio;
    k = newK;
    clampView();
    render();
  }

  /**
   * Compute the view transform that fits the given countries in view with padding (does NOT apply
   * it). Far-apart countries zoom OUT (down to the whole world); adjacent ones zoom IN.
   */
  function computeFit(isos: Iso3[], padding = 0.8): { k: number; tx: number; ty: number } | null {
    const feats = isos.map((i) => byIso.get(i)).filter((f): f is MapFeature => !!f);
    if (feats.length === 0) return null;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const f of feats) {
      const [a, b, c, d] = geometryBounds(f.geometry);
      minLon = Math.min(minLon, a);
      minLat = Math.min(minLat, b);
      maxLon = Math.max(maxLon, c);
      maxLat = Math.max(maxLat, d);
    }
    const [x0, y0] = base.forward([minLon, maxLat]);
    const [x1, y1] = base.forward([maxLon, minLat]);
    const bw = Math.max(1, x1 - x0);
    const bh = Math.max(1, y1 - y0);
    let nk = Math.min(maxZoom, Math.max(1, Math.min((canvas.width * padding) / bw, (canvas.height * padding) / bh)));
    let ntx = canvas.width / 2 - nk * ((x0 + x1) / 2);
    let nty = canvas.height / 2 - nk * ((y0 + y1) / 2);
    // clamp
    nk = Math.min(maxZoom, Math.max(1, nk));
    ntx = Math.min(0, Math.max(canvas.width - canvas.width * nk, ntx));
    nty = Math.min(0, Math.max(canvas.height - canvas.height * nk, nty));
    return { k: nk, tx: ntx, ty: nty };
  }

  // Animated tween of the view transform (used for reveal + reset; interactive gestures stay instant).
  let raf = 0;
  const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function animateTo(tk: number, ttx: number, tty: number, dur = 500): void {
    cancelAnimationFrame(raf);
    const sk = k;
    const stx = tx;
    const sty = ty;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const e = easeInOutCubic(p);
      k = sk + (tk - sk) * e;
      tx = stx + (ttx - stx) * e;
      ty = sty + (tty - sty) * e;
      render();
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  // --- pointer handling: 1 pointer = tap-or-pan, 2 pointers = pinch-zoom ---
  const pts = new Map<number, [number, number]>();
  let downPos: [number, number] | null = null;
  let downMoved = false;
  let pinchDist = 0;
  const TAP_SLOP = 6; // px of movement before a press becomes a pan (not a tap)

  const twoDist = (): number => {
    const a = [...pts.values()];
    return Math.hypot(a[0]![0] - a[1]![0], a[0]![1] - a[1]![1]);
  };
  const twoMid = (): [number, number] => {
    const a = [...pts.values()];
    return [(a[0]![0] + a[1]![0]) / 2, (a[0]![1] + a[1]![1]) / 2];
  };

  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId);
    const p = toCanvas(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      downPos = p;
      downMoved = false;
    } else if (pts.size === 2) {
      downMoved = true; // a two-finger gesture is never a tap
      pinchDist = twoDist();
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    const [x, y] = toCanvas(e);
    const [px, py] = pts.get(e.pointerId)!;
    pts.set(e.pointerId, [x, y]);

    if (pts.size >= 2) {
      const d = twoDist();
      if (pinchDist > 0) {
        const [mx, my] = twoMid();
        zoomAround(mx, my, d / pinchDist);
      }
      pinchDist = d;
    } else if (downPos) {
      if (Math.abs(x - downPos[0]) > TAP_SLOP || Math.abs(y - downPos[1]) > TAP_SLOP) downMoved = true;
      if (downMoved) {
        tx += x - px;
        ty += y - py;
        clampView();
        render();
      }
    }
  };

  const onUp = (e: PointerEvent) => {
    const wasSingle = pts.size === 1;
    const [x, y] = toCanvas(e);
    pts.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    if (wasSingle && !downMoved && selectable) {
      const iso = resolveTap(x, y, proj, features, opts.hit);
      state = { ...state, selected: iso };
      render();
      onSelect(iso);
    }
    if (pts.size < 2) pinchDist = 0;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [cx, cy] = toCanvas(e);
    zoomAround(cx, cy, wheelZoomFactor(e.deltaY, e.deltaMode, canvas.height));
  };

  const onDbl = (e: MouseEvent) => {
    const [cx, cy] = toCanvas(e);
    zoomAround(cx, cy, 1.8);
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDbl);

  return {
    render,
    highlight(iso) {
      state = { ...state, selected: iso };
      render();
    },
    zoomBy(factor) {
      zoomAround(canvas.width / 2, canvas.height / 2, factor);
    },
    setLabels(enabled) {
      showLabels = enabled;
      render();
    },
    reveal(guessIso, correctIso) {
      selectable = false; // no country selection while the answer is shown
      const correct = Array.isArray(correctIso) ? correctIso : [correctIso];
      state = { selected: null, guess: guessIso, correct };
      // Smoothly zoom so the guess AND every accepted answer are visible (fixes tiny-country invisibility).
      const target = computeFit(correct.includes(guessIso) ? correct : [guessIso, ...correct]);
      if (target) animateTo(target.k, target.tx, target.ty);
      else render();
    },
    reset() {
      selectable = true; // re-enable selection for the next question
      state = {};
      animateTo(1, 0, 0); // smoothly zoom back out to the full world for the next question
    },
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDbl);
    },
  };
}
