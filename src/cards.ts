export type CardKind = "single" | "aoe" | "guard" | "resource";
export interface CardDef {
  name: string;
  kind: CardKind;
  cost: number;
  value: number;
  blurb: string;
}

// Focus exhausts: it leaves the cycle for the rest of the current fight (so a
// 0-cost draw card can't loop with itself) and comes back when the fight ends.
export const CARD_LIBRARY = {
  strike: { name: "Strike", kind: "single", cost: 1, value: 6, blurb: "6 dmg to target" },
  cleave: { name: "Cleave", kind: "aoe", cost: 2, value: 3, blurb: "3 dmg to ALL foes" },
  guard: { name: "Guard", kind: "guard", cost: 1, value: 5, blurb: "+5 block (lasts the enemy turn)" },
  focus: { name: "Focus", kind: "resource", cost: 0, value: 1, blurb: "draw 1, +1 energy; exhausts this fight" },
} satisfies Record<string, CardDef>;

export type Rng = () => number;

export function shuffle<T>(arr: T[], rng: Rng = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildDeck(rng: Rng = Math.random): CardDef[] {
  return shuffle(
    [
      ...Array<CardDef>(5).fill(CARD_LIBRARY.strike),
      ...Array<CardDef>(3).fill(CARD_LIBRARY.cleave),
      ...Array<CardDef>(3).fill(CARD_LIBRARY.guard),
      ...Array<CardDef>(3).fill(CARD_LIBRARY.focus),
    ],
    rng
  );
}

export interface Piles {
  draw: CardDef[];
  hand: CardDef[];
  discard: CardDef[];
  exhaust: CardDef[];
}

export function newPiles(rng: Rng = Math.random): Piles {
  return { draw: buildDeck(rng), hand: [], discard: [], exhaust: [] };
}

export function totalCards(p: Piles): number {
  return p.draw.length + p.hand.length + p.discard.length + p.exhaust.length;
}

export function drawOne(p: Piles, rng: Rng = Math.random): CardDef | null {
  if (p.draw.length === 0) {
    if (p.discard.length === 0) return null;
    p.draw = shuffle(p.discard, rng);
    p.discard = [];
  }
  const card = p.draw.pop() ?? null;
  if (card) p.hand.push(card);
  return card;
}

export function discardHand(p: Piles) {
  p.discard.push(...p.hand);
  p.hand = [];
}

export function drawHand(p: Piles, size: number, rng: Rng = Math.random) {
  discardHand(p);
  while (p.hand.length < size && drawOne(p, rng)) {
    // keep drawing
  }
}

/** Takes the card out of the hand. The caller applies its effect, then calls settlePlayed. */
export function takeFromHand(p: Piles, idx: number): CardDef | null {
  if (idx < 0 || idx >= p.hand.length) return null;
  return p.hand.splice(idx, 1)[0];
}

export function settlePlayed(p: Piles, card: CardDef) {
  if (card.kind === "resource") p.exhaust.push(card);
  else p.discard.push(card);
}

/** Encounter over (win, flee or death): unplayed hand and this fight's exhausts return to discard. */
export function endEncounterPiles(p: Piles) {
  p.discard.push(...p.hand, ...p.exhaust);
  p.hand = [];
  p.exhaust = [];
}
