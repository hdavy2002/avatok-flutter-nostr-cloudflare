import { describe, it, expect } from "vitest";
import { TAROT_DECK, MAJOR_ARCANA, cardById, majorById, meaningOf } from "./tarot_deck";

describe("tarot deck", () => {
  it("has 78 cards with ids 1..78 in order", () => {
    expect(TAROT_DECK).toHaveLength(78);
    TAROT_DECK.forEach((c, i) => expect(c.id).toBe(i + 1));
  });
  it("names are unique and every card has both meanings", () => {
    expect(new Set(TAROT_DECK.map((c) => c.name)).size).toBe(78);
    for (const c of TAROT_DECK) { expect(c.upright.length).toBeGreaterThan(5); expect(c.reversed.length).toBeGreaterThan(5); }
  });
  it("standard order: Fool first, World 22nd, then wands, cups, swords, pentacles", () => {
    expect(cardById(1)?.name).toBe("The Fool");
    expect(cardById(22)?.name).toBe("The World");
    expect(cardById(23)?.name).toBe("Ace of Wands");
    expect(cardById(37)?.name).toBe("Ace of Cups");
    expect(cardById(51)?.name).toBe("Ace of Swords");
    expect(cardById(65)?.name).toBe("Ace of Pentacles");
    expect(cardById(78)?.name).toBe("King of Pentacles");
  });
  it("major arcana are 22 and yes/no ids 1..22 only", () => {
    expect(MAJOR_ARCANA).toHaveLength(22);
    expect(majorById(1)?.name).toBe("The Fool");
    expect(majorById(22)?.name).toBe("The World");
    expect(majorById(23)).toBeNull();
    expect(majorById(0)).toBeNull();
  });
  it("cardById rejects bad ids and meaningOf honours reversal", () => {
    expect(cardById(0)).toBeNull();
    expect(cardById(79)).toBeNull();
    expect(cardById(1.5)).toBeNull();
    const c = cardById(2)!;
    expect(meaningOf(c, false)).toBe(c.upright);
    expect(meaningOf(c, true)).toBe(c.reversed);
  });
});
