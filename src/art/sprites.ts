// Presentation-only art sample (docs/process/art.md). Imported through Vite so
// the SVGs are fingerprinted into dist/assets/ and ship in the production
// image (the Dockerfile builds from src/, not public/).
import bossSvg from "./boss.svg?raw";
import eliteSvg from "./elite.svg?raw";
import groundSvg from "./ground.svg?raw";
import gruntSvg from "./grunt.svg?raw";
import playerSvg from "./player.svg?raw";

// Rasterise above the logical size: fights zoom the camera in (up to ~2.2x)
// on a pixelDensity-2 canvas, and a 1x raster would blur. The drawn size is
// always pinned separately with sprite({ width, height }).
const RASTER = 4;

function rasterUrl(svg: string): string {
  const scaled = svg.replace(/<svg([^>]*?)\swidth="(\d+)"\s+height="(\d+)"/, (_m, pre, w, h) => `<svg${pre} width="${Number(w) * RASTER}" height="${Number(h) * RASTER}"`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(scaled)}`;
}

const ART = { player: playerSvg, grunt: gruntSvg, elite: eliteSvg, boss: bossSvg, ground: groundSvg } as const;
export type ArtName = keyof typeof ART;

export function loadArt(k: { loadSprite: (name: string, src: string) => unknown }) {
  for (const [name, svg] of Object.entries(ART)) k.loadSprite(name, rasterUrl(svg));
}

/** Roles drawn with a sprite in this sample; others keep their plain coloured square. */
export const ROLE_SPRITE: Partial<Record<string, ArtName>> = { brute: "grunt", heavy: "elite", boss: "boss" };
