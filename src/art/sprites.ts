// Presentation-only art sample (docs/process/art.md). Imported through Vite so
// the SVGs are fingerprinted into dist/assets/ and ship in the production
// image (the Dockerfile builds from src/, not public/).
import bossSvg from "./boss.svg?raw";
import eliteSvg from "./elite.svg?raw";
import groundSvg from "./ground.svg?raw";
import groundBSvg from "./ground-b.svg?raw";
import gruntSvg from "./grunt.svg?raw";
import mageSvg from "./mage.svg?raw";
import playerSvg from "./player.svg?raw";
import swarmSvg from "./swarm.svg?raw";

// Rasterise above the logical size: fights zoom the camera in (up to ~2.2x)
// on a pixelDensity-2 canvas, and a 1x raster would blur. The drawn size is
// always pinned separately with sprite({ width, height }).
const RASTER = 4;

function rasterUrl(svg: string): string {
  const scaled = svg.replace(/<svg([^>]*?)\swidth="(\d+)"\s+height="(\d+)"/, (_m, pre, w, h) => `<svg${pre} width="${Number(w) * RASTER}" height="${Number(h) * RASTER}"`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(scaled)}`;
}

const ART = { player: playerSvg, grunt: gruntSvg, elite: eliteSvg, boss: bossSvg, mage: mageSvg, swarm: swarmSvg, ground: groundSvg, groundB: groundBSvg } as const;
export type ArtName = keyof typeof ART;

/**
 * A flat white silhouette of a unit's SVG, for the hit flash: color() on a
 * sprite multiplies and cannot brighten, so the flash draws this on top.
 * Generated from the same source (every fill and stroke made white, the
 * contact shadow dropped), so it matches the figure's exact shape.
 */
function silhouette(svg: string): string {
  return svg
    .replace(/<ellipse[^>]*fill="#000"[^>]*\/>/g, "")
    .replace(/(fill|stroke)="#[0-9a-fA-F]{3,6}"/g, '$1="#ffffff"')
    .replace(/opacity="[\d.]+"/g, 'opacity="1"');
}

const UNIT_ART = ["player", "grunt", "elite", "boss", "mage", "swarm"] as const;

export function loadArt(k: { loadSprite: (name: string, src: string) => unknown }) {
  for (const [name, svg] of Object.entries(ART)) k.loadSprite(name, rasterUrl(svg));
  for (const name of UNIT_ART) k.loadSprite(`${name}-flash`, rasterUrl(silhouette(ART[name])));
}

/** Every role now has a sprite; the map stays Partial so an unknown role still falls back to its coloured square. */
export const ROLE_SPRITE: Partial<Record<string, ArtName>> = { brute: "grunt", heavy: "elite", boss: "boss", mage: "mage", swarm: "swarm" };

/**
 * Which ground tile and flips a map cell uses. A small integer hash of the
 * cell, not (i + j) parity, so neither rows nor diagonals repeat; the same
 * cell always gets the same tile in both solo and co-op.
 */
export function groundTileFor(i: number, j: number): { sprite: ArtName; flipX: boolean; flipY: boolean } {
  let h = (i * 73856093) ^ (j * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return { sprite: h & 1 ? "groundB" : "ground", flipX: (h & 2) !== 0, flipY: (h & 4) !== 0 };
}
