import { describe, expect, it } from "vitest";
import {
  CARD_LIBRARY,
  type CardDef,
  type Piles,
  discardHand,
  drawHand,
  drawOne,
  endEncounterPiles,
  newPiles,
  settlePlayed,
  takeFromHand,
  totalCards,
} from "./cards.ts";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DECK = 14;
const { strike, cleave, guard, focus } = CARD_LIBRARY;
const count = (p: Piles, c: CardDef) =>
  [...p.draw, ...p.hand, ...p.discard, ...p.exhaust].filter((x) => x === c).length;

/** A full 14-card deck with `hand` already drawn. */
function withHand(hand: CardDef[], r: () => number): Piles {
  const p = newPiles(r);
  for (const c of hand) p.draw.splice(p.draw.indexOf(c), 1);
  p.hand = hand.slice();
  return p;
}

/** Same order as playCardAt: take from hand, apply effect, settle; victory is checked after. */
function play(p: Piles, idx: number, r: () => number) {
  const card = takeFromHand(p, idx)!;
  if (card.kind === "resource") drawOne(p, r);
  settlePlayed(p, card);
  return card;
}

describe("card piles", () => {
  it("lethal single-target play keeps the rest of the hand (regression)", () => {
    const r = rng(1);
    const p = withHand([strike, guard, cleave, guard], r);
    play(p, 0, r); // kills the last enemy
    endEncounterPiles(p); // victory cleanup
    expect(totalCards(p)).toBe(DECK);
    expect(p.hand).toHaveLength(0);
    expect(p.discard).toEqual([strike, guard, cleave, guard]);
  });

  it("AoE killing the last batch keeps the rest of the hand", () => {
    const r = rng(2);
    const p = withHand([guard, cleave, strike, focus], r);
    play(p, 1, r);
    endEncounterPiles(p);
    expect(totalCards(p)).toBe(DECK);
    expect(p.discard.map((c) => c.name).sort()).toEqual(["Cleave", "Focus", "Guard", "Strike"]);
  });

  it("Focus then victory: Focus is exhausted mid-fight and restored afterwards", () => {
    const r = rng(3);
    const p = withHand([focus, strike, guard, guard], r);
    play(p, 0, r);
    expect(p.exhaust).toEqual([focus]);
    expect(p.hand).toHaveLength(4); // -Focus, +1 drawn
    expect(totalCards(p)).toBe(DECK);
    play(p, p.hand.indexOf(strike), r); // lethal
    endEncounterPiles(p);
    expect(p.exhaust).toHaveLength(0);
    expect(count(p, focus)).toBe(3);
    expect(totalCards(p)).toBe(DECK);
  });

  it("an exhausted Focus stays out of every reshuffle until the fight ends", () => {
    const r = rng(4);
    const p: Piles = { draw: [], hand: [focus, strike, guard], discard: [], exhaust: [] };
    play(p, 0, r);
    for (let turn = 0; turn < 6; turn++) {
      drawHand(p, 4, r);
      expect(p.hand).not.toContain(focus);
    }
    endEncounterPiles(p);
    drawHand(p, 4, r);
    expect(p.hand).toContain(focus);
  });

  it("flee then the next fight: hand and exhaust come back, full deck available", () => {
    const r = rng(5);
    const p = withHand([focus, focus, strike, cleave], r);
    play(p, 0, r);
    play(p, 0, r);
    discardHand(p); // flee ends the turn
    endEncounterPiles(p); // then the encounter
    expect(p.exhaust).toHaveLength(0);
    expect(count(p, focus)).toBe(3);
    drawHand(p, 4, r); // next fight
    expect(p.hand).toHaveLength(4);
    expect(totalCards(p)).toBe(DECK);
  });

  it("drawHand never drops cards still in hand", () => {
    const r = rng(6);
    const p = newPiles(r);
    drawHand(p, 4, r);
    drawHand(p, 4, r);
    expect(totalCards(p)).toBe(DECK);
  });

  it("300 random fights never create or lose a card", () => {
    const r = rng(7);
    const p = newPiles(r);
    for (let fight = 0; fight < 300; fight++) {
      const turns = 1 + Math.floor(r() * 4);
      for (let t = 0; t < turns; t++) {
        drawHand(p, 4, r);
        const plays = Math.floor(r() * 5);
        for (let n = 0; n < plays && p.hand.length > 0; n++) {
          play(p, Math.floor(r() * p.hand.length), r);
          expect(totalCards(p)).toBe(DECK);
        }
        if (r() < 0.25) break; // won mid-turn: hand never discarded by end-turn
        discardHand(p);
      }
      endEncounterPiles(p);
      expect(totalCards(p)).toBe(DECK);
      expect(p.exhaust).toHaveLength(0);
      expect(p.hand).toHaveLength(0);
      expect(count(p, focus)).toBe(3);
    }
  });
});
