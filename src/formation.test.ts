import { describe, expect, it } from "vitest";
import { FHD_VIEWPORT, PHONE_VIEWPORT, VIEWPORT, WORLD_HEIGHT, WORLD_WIDTH } from "./config.ts";
import {
  BOSS_BOX,
  PLAYER_BOX,
  TRASH_BOX,
  type Unit,
  type V,
  boxAt,
  boundsOnScreen,
  clampCam,
  formationBounds,
  layoutFormation,
  planCamera,
  rectsOverlap,
} from "./formation.ts";

// Player clamps to 16px from the edge, so these include the true corners.
const ANCHORS: Record<string, V> = {
  centre: { x: 1100, y: 650 },
  topLeft: { x: 16, y: 16 },
  topRight: { x: WORLD_WIDTH - 16, y: 16 },
  bottomLeft: { x: 16, y: WORLD_HEIGHT - 16 },
  bottomRight: { x: WORLD_WIDTH - 16, y: WORLD_HEIGHT - 16 },
  topEdge: { x: 1100, y: 40 },
  leftEdge: { x: 30, y: 650 },
};

function crowd(anchor: V, trash: number, withBoss: boolean, spread = 30): Unit[] {
  const units: Unit[] = [];
  let id = 1;
  // Enemies arrive from roughly one side, clamped onto the map like the game does.
  const towardCentre = { x: Math.sign(1100 - anchor.x) || 1, y: Math.sign(650 - anchor.y) || 0 };
  const at = (i: number) => ({
    x: Math.min(Math.max(anchor.x + towardCentre.x * 40 + ((i * 37) % 5) * spread * 0.2, 14), WORLD_WIDTH - 14),
    y: Math.min(Math.max(anchor.y + towardCentre.y * 40 + ((i * 53) % 7) * spread * 0.2, 14), WORLD_HEIGHT - 14),
  });
  if (withBoss) units.push({ id: id++, isBoss: true, pos: at(99) });
  for (let i = 0; i < trash; i++) units.push({ id: id++, isBoss: false, pos: at(i) });
  return units;
}

function footprint(u: Unit, p: V) {
  return boxAt(p, u.isBoss ? BOSS_BOX : TRASH_BOX);
}

function inside(r: { x0: number; y0: number; x1: number; y1: number }, o: typeof r, tol = 0.5) {
  return r.x0 >= o.x0 - tol && r.y0 >= o.y0 - tol && r.x1 <= o.x1 + tol && r.y1 <= o.y1 + tol;
}

const CASES: [string, number, boolean][] = [
  ["1 grunt", 1, false],
  ["2 grunts", 2, false],
  ["3 grunts", 3, false],
  ["6 grunts", 6, false],
  ["7 grunts (all trash on the map)", 7, false],
  ["boss alone", 0, true],
  ["boss + 1", 1, true],
  ["boss + 3", 3, true],
  ["boss + 7 (whole map)", 7, true],
];

const VIEWPORTS = { "960x540": VIEWPORT, "1920x1080": FHD_VIEWPORT, "390x844": PHONE_VIEWPORT };

describe.each(Object.entries(VIEWPORTS))("encounter formation at %s", (_vpName, VP) => {
  for (const [anchorName, anchor] of Object.entries(ANCHORS)) {
    for (const [label, n, boss] of CASES) {
      it(`${label} at ${anchorName}: every enemy slotted, nothing overlaps, all readable on screen`, () => {
        const units = crowd(anchor, n, boss);
        const f = layoutFormation(units, anchor, VP);

        expect(f.overflow).toEqual([]);
        expect(f.slots.size).toBe(units.length);

        const rects = units.map((u) => footprint(u, f.slots.get(u.id)!));
        rects.push(boxAt(anchor, PLAYER_BOX));
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i], rects[j])).toBe(false);

        for (const u of units) expect(inside(footprint(u, f.slots.get(u.id)!), f.stage)).toBe(true);
        expect(inside(f.stage, { x0: 0, y0: 0, x1: WORLD_WIDTH, y1: WORLD_HEIGHT })).toBe(true);

        // Both camera modes keep every enemy footprint (body, HP, intent,
        // marker) inside the safe rect, and the camera itself stays on-map.
        const bounds = formationBounds(units, f.slots, anchor);
        for (const zoom of [{ min: VP.baseScale!, max: VP.baseScale! }, { min: VP.baseScale!, max: VP.baseScale! * 1.5 }]) {
          const cam = planCamera(bounds, VP, zoom);
          const clamped = clampCam(cam.center, cam.scale, VP);
          expect(clamped).toEqual(cam.center);
          for (const u of units) {
            const onScreen = boundsOnScreen(footprint(u, f.slots.get(u.id)!), cam.center, cam.scale, VP);
            expect(inside(onScreen, VP.safe)).toBe(true);
          }
          const body = { left: -16, right: 16, top: -16, bottom: 16 }; // player circle, clamped 16px from edges
          const p = boundsOnScreen(boxAt(anchor, body), cam.center, cam.scale, VP);
          expect(inside(p, { x0: 0, y0: 0, x1: VP.viewW, y1: VP.viewH })).toBe(true);
        }
      });
    }
  }

});

describe("encounter formation", () => {
  it("enemies stacked on one exact point still get distinct slots", () => {
    const anchor = ANCHORS.centre;
    const units: Unit[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, isBoss: i === 0, pos: { x: 1140, y: 650 } }));
    const f = layoutFormation(units, anchor, VIEWPORT);
    const keys = new Set([...f.slots.values()].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    expect(keys.size).toBe(units.length);
  });

  it("too many to place cleanly: the rest go to the overflow list, none dropped", () => {
    const anchor = ANCHORS.centre;
    const units = crowd(anchor, 40, true);
    const f = layoutFormation(units, anchor, VIEWPORT);
    expect(f.overflow.length).toBeGreaterThan(0);
    const ids = [...f.slots.keys(), ...f.overflow];
    expect(new Set(ids).size).toBe(units.length);
    expect(f.slots.has(units[0].id)).toBe(true); // boss keeps a stage slot
  });

  it("hands out slots in the same angular order enemies arrived in (no crossing paths)", () => {
    const anchor = ANCHORS.centre;
    const rel = (p: V) => Math.atan2(p.y - anchor.y, p.x - anchor.x);
    const units: Unit[] = [
      { id: 1, isBoss: false, pos: { x: 1200, y: 560 } }, // upper right
      { id: 2, isBoss: false, pos: { x: 1220, y: 650 } }, // right
      { id: 3, isBoss: false, pos: { x: 1200, y: 740 } }, // lower right
    ];
    const f = layoutFormation(units, anchor, VIEWPORT);
    const order = units.slice().sort((a, b) => rel(f.slots.get(a.id)!) - rel(f.slots.get(b.id)!)).map((u) => u.id);
    expect(order).toEqual([1, 2, 3]);
  });

  it("is deterministic for the same input", () => {
    const anchor = ANCHORS.bottomRight;
    const units = crowd(anchor, 5, true);
    const a = layoutFormation(units, anchor, VIEWPORT);
    const b = layoutFormation(units, anchor, VIEWPORT);
    expect([...a.slots.entries()]).toEqual([...b.slots.entries()]);
  });
});
