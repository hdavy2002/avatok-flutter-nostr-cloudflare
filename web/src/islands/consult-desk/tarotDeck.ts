/* [AUMFE-CONSULT-F3-1 2026-10-02] Fallback 78-card tarot deck (array index 0..77; card IDS are the API's 1..78 = index + 1) used ONLY when the prepared file does not carry
 * deck names. Order: 22 major arcana, then Wands, Cups, Swords, Pentacles (Ace..King). It must match the worker's
 * lib/consultants/tarot_deck.ts; the desk also sends the card NAME inside `reveal.position` ("Love|The Lovers") so the
 * customer's screen never depends on this table agreeing. */
const MAJOR = ['The Fool', 'The Magician', 'The High Priestess', 'The Empress', 'The Emperor', 'The Hierophant', 'The Lovers', 'The Chariot', 'Strength', 'The Hermit', 'Wheel of Fortune', 'Justice', 'The Hanged Man', 'Death', 'Temperance', 'The Devil', 'The Tower', 'The Star', 'The Moon', 'The Sun', 'Judgement', 'The World'];
const RANKS = ['Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Page', 'Knight', 'Queen', 'King'];
const SUITS = ['Wands', 'Cups', 'Swords', 'Pentacles'];
export const FALLBACK_DECK: string[] = [...MAJOR, ...SUITS.flatMap((s) => RANKS.map((r) => `${r} of ${s}`))];
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];
/** "VI" for a major arcana, the rank number for a minor, '' when unknown. */
export function cardNumeral(cardId: number): string {
  const id = cardId - 1; // API ids are 1..78
  if (id >= 0 && id < 22) return ROMAN[id];
  if (id >= 22 && id < 78) { const r = (id - 22) % 14; return r < 10 ? String(r + 1) : ['P', 'Kn', 'Q', 'K'][r - 10]; }
  return '';
}
/** Name for an API card id (1..78). */
export function cardNameFallback(id: number): string { return FALLBACK_DECK[id - 1] ?? `Card ${id}`; }
