// [AUMFE-CONSULT-W2-1 2026-10-02] Our own 78-card tarot table. AstrologyAPI's tarot_predictions returns reading texts only
// (no card names), so the card NAME and one-line meaning come from here.
//
// ORDER: standard Rider-Waite-Smith: 0 Fool .. 21 World, then Wands, Cups, Swords, Pentacles (Ace..10, Page, Knight, Queen, King).
// AstrologyAPI id = index + 1 (1..78).
// TODO(verify): the id <-> card order has NOT been confirmed against the live AstrologyAPI. If its deck order differs,
//   change ONLY the order of MAJOR / the SUITS list below; every consumer reads ids through TAROT_DECK.
// yes_no_tarot ids 1..22 are the Major Arcana in the same order (id 1 = The Fool ... id 22 = The World).

export type TarotSuit = "major" | "wands" | "cups" | "swords" | "pentacles";
export interface TarotCard { id: number; name: string; suit: TarotSuit; upright: string; reversed: string }

// name | upright | reversed
const MAJOR: [string, string, string][] = [
  ["The Fool", "A fresh start and a leap of faith.", "Recklessness or fear of beginning."],
  ["The Magician", "Skill and will turn an idea into action.", "Scattered effort or misused talent."],
  ["The High Priestess", "Trust your intuition and the quiet inner voice.", "Ignored instincts or hidden motives."],
  ["The Empress", "Nurture, abundance and creative growth.", "Neglecting yourself or smothering others."],
  ["The Emperor", "Structure, authority and steady leadership.", "Rigidity or a struggle over control."],
  ["The Hierophant", "Tradition, teachers and shared values.", "Breaking from convention or blind conformity."],
  ["The Lovers", "A heartfelt bond and an honest choice.", "Misalignment or a choice avoided."],
  ["The Chariot", "Determination carries you to victory.", "Loss of direction or force without focus."],
  ["Strength", "Gentle courage and patience win the day.", "Self-doubt or a loss of composure."],
  ["The Hermit", "Withdraw and seek wisdom within.", "Isolation or refusing guidance."],
  ["Wheel of Fortune", "A turning point; cycles are changing.", "Resistance to change or a run of bad timing."],
  ["Justice", "Fairness, truth and accountability.", "Bias, dishonesty or dodged responsibility."],
  ["The Hanged Man", "Pause and see things from a new angle.", "Stalling or pointless sacrifice."],
  ["Death", "An ending that clears space for renewal.", "Clinging to what should be released."],
  ["Temperance", "Balance, patience and moderation.", "Excess or being out of balance."],
  ["The Devil", "Attachments and habits that bind you.", "Breaking free of an unhealthy hold."],
  ["The Tower", "Sudden upheaval that exposes what was unstable.", "Fear of change or a disaster narrowly avoided."],
  ["The Star", "Hope, healing and renewed faith.", "Discouragement or lost faith."],
  ["The Moon", "Uncertainty, dreams and hidden feelings.", "Confusion clearing or a fear coming into the light."],
  ["The Sun", "Joy, clarity and success.", "Temporary clouds or dampened enthusiasm."],
  ["Judgement", "A calling, reckoning and a fresh awakening.", "Self-doubt or ignoring the call."],
  ["The World", "Completion, wholeness and achievement.", "Loose ends or a goal almost reached."],
];

const RANKS = ["Ace", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Page", "Knight", "Queen", "King"] as const;

// per suit, 14 entries in RANKS order: upright | reversed
const MINOR: Record<Exclude<TarotSuit, "major">, [string, string][]> = {
  wands: [
    ["A spark of inspiration and new energy.", "A delayed start or lack of drive."],
    ["Planning ahead and choosing a direction.", "Fear of the unknown or poor planning."],
    ["Expansion; your efforts are bearing fruit.", "Delays or obstacles to growth."],
    ["Celebration, stability and a happy home.", "Instability or a postponed celebration."],
    ["Competition and friction of ideas.", "Conflict easing or avoided."],
    ["Victory and public recognition.", "Pride, or success that feels hollow."],
    ["Standing your ground against challengers.", "Feeling overwhelmed or giving way."],
    ["Swift movement and fast news.", "Delays, scattered energy or haste."],
    ["Resilience; one last push is needed.", "Exhaustion or defensiveness."],
    ["A heavy burden and too much responsibility.", "Putting down a load or learning to delegate."],
    ["An enthusiastic message and a new idea.", "Unfinished ideas or lack of commitment."],
    ["Bold, passionate action.", "Impatience or reckless haste."],
    ["Confident, warm and determined.", "Jealousy, demanding or low confidence."],
    ["Visionary leadership and charisma.", "Domineering or impulsive leadership."],
  ],
  cups: [
    ["A new feeling, love or spiritual opening.", "Emotions held back or an empty cup."],
    ["Mutual attraction and a true partnership.", "Imbalance or a break in a bond."],
    ["Friendship, joy and shared celebration.", "Excess or gossip in the circle."],
    ["Contemplation; an offer you are overlooking.", "New awareness or renewed interest."],
    ["Grief and regret, with hope still standing.", "Moving on and accepting loss."],
    ["Nostalgia, kindness and innocent joy.", "Stuck in the past."],
    ["Many options and wishful thinking.", "Clarity after confusion; a real choice."],
    ["Walking away to seek something deeper.", "Fear of leaving or drifting."],
    ["Contentment and wishes fulfilled.", "Smugness or an unmet wish."],
    ["Lasting happiness and family harmony.", "Strained relationships or false harmony."],
    ["A tender message and creative curiosity.", "Emotional immaturity or mixed signals."],
    ["Romance, charm and following the heart.", "Moodiness or unrealistic promises."],
    ["Compassion, intuition and emotional depth.", "Over-sensitivity or emotional dependence."],
    ["Emotional balance and calm wisdom.", "Moodiness or bottled-up feeling."],
  ],
  swords: [
    ["A breakthrough of clarity and truth.", "Confusion or a clouded judgement."],
    ["A hard decision and a stalemate.", "Indecision releasing; the truth surfaces."],
    ["Heartbreak and painful truth.", "Healing and letting go of hurt."],
    ["Rest, recovery and quiet reflection.", "Restlessness or burnout."],
    ["Conflict, a hollow win and tension.", "Reconciliation or lingering resentment."],
    ["Moving toward calmer waters.", "Being stuck or resisting a transition."],
    ["Strategy, stealth and acting alone.", "Coming clean or being found out."],
    ["Feeling trapped by your own thoughts.", "Freedom and a new perspective."],
    ["Anxiety and sleepless worry.", "Worry easing; reaching out for help."],
    ["A painful ending and a final low point.", "Recovery; the worst is over."],
    ["Curiosity, vigilance and sharp questions.", "Gossip or hasty words."],
    ["Ambitious, fast and direct thinking.", "Reckless words or scattered focus."],
    ["Independent, clear and honest judgement.", "Coldness or bitterness."],
    ["Intellect, fairness and authority of truth.", "Harsh or manipulative use of words."],
  ],
  pentacles: [
    ["A new opportunity in work, money or health.", "A missed chance or poor planning."],
    ["Juggling priorities with flexibility.", "Overcommitment or disorganised money."],
    ["Teamwork and skilled craftsmanship.", "Lack of teamwork or shoddy work."],
    ["Security, saving and holding on.", "Greed or fear of loss."],
    ["Hardship, worry and feeling left out.", "Recovery and help arriving."],
    ["Generosity, giving and receiving fairly.", "Debt or strings attached."],
    ["Patience; the harvest is slowly growing.", "Impatience or poor return on effort."],
    ["Diligent practice and skill-building.", "Perfectionism or lost motivation."],
    ["Self-reliance, comfort and rewards earned.", "Overworking or over-reliance on status."],
    ["Legacy, family wealth and lasting security.", "Family disputes or financial instability."],
    ["A practical start and a student mindset.", "Procrastination or lost focus."],
    ["Steady, reliable, thorough progress.", "Stagnation or boredom."],
    ["Practical care, abundance and comfort.", "Self-neglect or smothering."],
    ["Prosperity, discipline and dependable leadership.", "Greed, stubbornness or materialism."],
  ],
};

const SUIT_ORDER = ["wands", "cups", "swords", "pentacles"] as const;
const SUIT_TITLE: Record<(typeof SUIT_ORDER)[number], string> = { wands: "Wands", cups: "Cups", swords: "Swords", pentacles: "Pentacles" };

function build(): TarotCard[] {
  const out: TarotCard[] = MAJOR.map(([name, upright, reversed], i) => ({ id: i + 1, name, suit: "major", upright, reversed }));
  for (const suit of SUIT_ORDER) {
    RANKS.forEach((rank, i) => {
      const [upright, reversed] = MINOR[suit][i];
      out.push({ id: out.length + 1, name: `${rank} of ${SUIT_TITLE[suit]}`, suit, upright, reversed });
    });
  }
  return out;
}

/** 78 cards, index = id - 1. */
export const TAROT_DECK: readonly TarotCard[] = build();
export const TAROT_DECK_SIZE = 78;
export const MAJOR_ARCANA: readonly TarotCard[] = TAROT_DECK.slice(0, 22);

export function cardById(id: number): TarotCard | null {
  return Number.isInteger(id) && id >= 1 && id <= TAROT_DECK_SIZE ? TAROT_DECK[id - 1] : null;
}
/** yes_no_tarot ids 1..22 -> Major Arcana. */
export function majorById(id: number): TarotCard | null {
  return Number.isInteger(id) && id >= 1 && id <= 22 ? MAJOR_ARCANA[id - 1] : null;
}
export function meaningOf(card: TarotCard, reversed: boolean): string { return reversed ? card.reversed : card.upright; }
