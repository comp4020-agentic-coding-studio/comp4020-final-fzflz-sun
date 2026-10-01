import type { Viewport } from "./formation.ts";

export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;
export const WORLD_WIDTH = 2200;
export const WORLD_HEIGHT = 1300;

// Screen area free of HUD text (top-left), side list (top-right), hint text,
// hand and buttons (bottom). Formation footprints and camera framing use it.
export const VIEWPORT: Viewport = {
  viewW: VIEW_WIDTH,
  viewH: VIEW_HEIGHT,
  worldW: WORLD_WIDTH,
  worldH: WORLD_HEIGHT,
  safe: { x0: 16, y0: 140, x1: VIEW_WIDTH - 16, y1: 384 },
};
