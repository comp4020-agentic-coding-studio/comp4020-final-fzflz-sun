export interface Body {
  pos: { x: number; y: number };
  bodyRadius: number; // not "radius": that name belongs to Kaplay's rect() component
  mass: number;
}

export interface SeparationOpts {
  padding: number;
  speed: number; // max push per second, keeps resolution smooth instead of snapping
  worldW: number;
  worldH: number;
}

/**
 * Soft pairwise push-apart, mutating positions in place. Heavier bodies yield
 * less, so trash slides around the boss instead of shoving it. Exactly stacked
 * pairs split along a direction fixed by their indices, so they separate the
 * same way every frame instead of jittering.
 */
export function separate(bodies: Body[], dt: number, o: SeparationOpts) {
  const maxPush = o.speed * dt;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      const minDist = a.bodyRadius + b.bodyRadius + o.padding;
      let dx = b.pos.x - a.pos.x;
      let dy = b.pos.y - a.pos.y;
      let dist = Math.hypot(dx, dy);
      if (dist >= minDist) continue;
      if (dist < 1e-3) {
        const angle = (i * 2.399 + j * 0.713) % (Math.PI * 2);
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        dist = 1;
      } else {
        dx /= dist;
        dy /= dist;
      }
      const push = Math.min(minDist - dist, maxPush);
      const total = a.mass + b.mass;
      const pa = push * (b.mass / total);
      const pb = push * (a.mass / total);
      a.pos.x -= dx * pa;
      a.pos.y -= dy * pa;
      b.pos.x += dx * pb;
      b.pos.y += dy * pb;
    }
  }
  for (const b of bodies) {
    b.pos.x = Math.min(Math.max(b.pos.x, b.bodyRadius), o.worldW - b.bodyRadius);
    b.pos.y = Math.min(Math.max(b.pos.y, b.bodyRadius), o.worldH - b.bodyRadius);
  }
}
