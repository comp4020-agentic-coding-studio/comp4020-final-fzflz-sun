import { describe, expect, it } from "vitest";
import { JOIN_RADIUS, selectRoster, type RosterCandidate } from "./encounter.ts";

const P = { x: 1000, y: 600 };
const at = (ref: string, dx: number, state: RosterCandidate<string>["state"] = "chasing", alive = true) => ({
  ref, alive, state, x: P.x + dx, y: P.y, engageRange: 40,
});

describe("who joins a fight", () => {
  it("no fight until a chasing enemy reaches its engage range", () => {
    expect(selectRoster([at("a", 41), at("b", 100)], P)).toBeNull();
    expect(selectRoster([at("idle", 10, "idle")], P)).toBeNull();
  });

  it("nearby chasers join; chasers beyond the join radius don't", () => {
    const r = selectRoster([at("touch", 30), at("near", JOIN_RADIUS - 1), at("far", JOIN_RADIUS + 1)], P);
    expect(r).toEqual(["touch", "near"]);
  });

  it("idle and returning enemies never join, however close", () => {
    const r = selectRoster([at("touch", 30), at("idle", 20, "idle"), at("back", 25, "returning")], P);
    expect(r).toEqual(["touch"]);
  });

  it("dead enemies never join", () => {
    expect(selectRoster([at("touch", 30), at("ghost", 20, "chasing", false)], P)).toEqual(["touch"]);
  });

  it("the join radius is 260", () => {
    expect(JOIN_RADIUS).toBe(260);
  });
});
