import type { Viewport } from "./formation.ts";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./world.ts";

export { WORLD_HEIGHT, WORLD_WIDTH };

// Representative viewports for the formation tests. In the game the safe rect
// is measured from the real HTML HUD every time (main.ts measureSafe); these
// mirror what that measures at each size, rounded towards less space.
const vp = (viewW: number, viewH: number, safe: Viewport["safe"], baseScale: number): Viewport => ({
  viewW, viewH, worldW: WORLD_WIDTH, worldH: WORLD_HEIGHT, safe, baseScale,
});

/** The old fixed 960x540 canvas. */
export const VIEWPORT = vp(960, 540, { x0: 16, y0: 140, x1: 944, y1: 384 }, 1);
/** Course marking viewport, desktop. */
export const FHD_VIEWPORT = vp(1920, 1080, { x0: 8, y0: 160, x1: 1912, y1: 900 }, 2);
/** Course marking viewport, phone (portrait), with the taller phone dock. */
export const PHONE_VIEWPORT = vp(390, 844, { x0: 8, y0: 150, x1: 382, y1: 610 }, 1);
