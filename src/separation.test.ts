import { describe, expect, it } from "vitest";
import { type Body, separate } from "./separation.ts";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./config.ts";

const OPTS = { padding: 6, speed: 160, worldW: WORLD_WIDTH, worldH: WORLD_HEIGHT };
const DT = 1 / 60;
const trash = (x: number, y: number): Body => ({ pos: { x, y }, bodyRadius: 14, mass: 1 });
const boss = (x: number, y: number): Body => ({ pos: { x, y }, bodyRadius: 28, mass: 2.2 });

function minGap(bodies: Body[]) {
  let worst = Infinity;
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      worst = Math.min(worst, Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) - (a.bodyRadius + b.bodyRadius + OPTS.padding));
    }
  return worst;
}

function run(bodies: Body[], frames: number) {
  for (let f = 0; f < frames; f++) separate(bodies, DT, OPTS);
}

describe("chase-time separation", () => {
  it("splits perfectly stacked enemies within a second", () => {
    const bodies = Array.from({ length: 6 }, () => trash(800, 600));
    run(bodies, 60);
    expect(minGap(bodies)).toBeGreaterThan(-0.5);
  });

  it("keeps stacked enemies on the map at every corner", () => {
    for (const [x, y] of [
      [0, 0],
      [WORLD_WIDTH, 0],
      [0, WORLD_HEIGHT],
      [WORLD_WIDTH, WORLD_HEIGHT],
    ]) {
      const bodies = [trash(x, y), trash(x, y), trash(x, y), boss(x, y)];
      run(bodies, 120);
      for (const b of bodies) {
        expect(b.pos.x).toBeGreaterThanOrEqual(b.bodyRadius);
        expect(b.pos.x).toBeLessThanOrEqual(WORLD_WIDTH - b.bodyRadius);
        expect(b.pos.y).toBeGreaterThanOrEqual(b.bodyRadius);
        expect(b.pos.y).toBeLessThanOrEqual(WORLD_HEIGHT - b.bodyRadius);
      }
      expect(minGap(bodies)).toBeGreaterThan(-0.5);
    }
  });

  it("trash yields to the boss rather than shoving it", () => {
    const b = boss(500, 500);
    const t = trash(510, 500);
    run([b, t], 30);
    expect(Math.abs(b.pos.x - 500)).toBeLessThan(Math.abs(t.pos.x - 510));
  });

  it("settles without jitter once separated", () => {
    const bodies = [trash(800, 600), trash(801, 600), trash(800, 601), boss(802, 602)];
    run(bodies, 120);
    const before = bodies.map((b) => ({ ...b.pos }));
    run(bodies, 30);
    bodies.forEach((b, i) => {
      expect(Math.hypot(b.pos.x - before[i].x, b.pos.y - before[i].y)).toBeLessThan(0.01);
    });
  });

  it("a crowd chasing the player still gets within engage range", () => {
    const player = { x: 1000, y: 600 };
    const bodies = Array.from({ length: 5 }, () => trash(1200, 600));
    let engaged = false;
    for (let f = 0; f < 300 && !engaged; f++) {
      for (const b of bodies) {
        const dx = player.x - b.pos.x;
        const dy = player.y - b.pos.y;
        const d = Math.hypot(dx, dy);
        if (d <= 40) engaged = true;
        else {
          b.pos.x += (dx / d) * 100 * DT;
          b.pos.y += (dy / d) * 100 * DT;
        }
      }
      separate(bodies, DT, OPTS);
    }
    expect(engaged).toBe(true);
  });
});
