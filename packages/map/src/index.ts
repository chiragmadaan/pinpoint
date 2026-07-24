// Self-contained vector world map: renders country polygons to a Canvas and hit-tests taps.
// NO map tiles, NO Street View, NO external calls, NO d3 dependency -> tiny + Playables-safe.
//
// Pure, tested pieces:  geometry.ts (projection + polygon math), hittest.ts (tap -> country).
// DOM glue (createWorldMap) is below; the game's two-tap "select then Guess" flow lives in the app.

export * from "./types.ts";
export * from "./geometry.ts";
export * from "./hittest.ts";
export * from "./render.ts";

import { equirectangular } from "./geometry.ts";
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
}

export interface WorldMap {
  render(): void;
  highlight(iso: Iso3 | null): void;
  reveal(guessIso: Iso3, correctIso: Iso3): void;
  destroy(): void;
}

/** DOM factory wiring pointer taps -> hit-test -> onSelect, and drawing the current state. */
export function createWorldMap(opts: WorldMapOptions): WorldMap {
  const { canvas, features, onSelect } = opts;
  const style = opts.style ?? DEFAULT_STYLE;
  let projection: Projection = equirectangular({ width: canvas.width, height: canvas.height });
  let state: RenderState = {};

  const render = () => drawMap(canvas.getContext("2d")!, features, projection, state, style);

  const onPointerDown = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const iso = resolveTap(px, py, projection, features, opts.hit);
    state = { ...state, selected: iso };
    render();
    onSelect(iso);
  };
  canvas.addEventListener("pointerdown", onPointerDown);

  return {
    render,
    highlight(iso) {
      state = { ...state, selected: iso };
      render();
    },
    reveal(guessIso, correctIso) {
      state = { selected: null, guess: guessIso, correct: correctIso };
      render();
    },
    destroy() {
      canvas.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
