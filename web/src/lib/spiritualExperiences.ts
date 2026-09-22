/**
 * The 13 editorial "explore spiritual experiences" topics (A4.4 / contracts §1).
 * These are discovery topics for the homepage and organiser page, NOT backend
 * category ids — each just links to a marketplace text search.
 */
export interface SpiritualTopic {
  id: string;
  title: string;
  blurb: string;
  searchTerm: string;
  organiserIdea: string;
  icon: string;
}

export const SPIRITUAL_TOPICS: readonly SpiritualTopic[] = [
  {
    id: 'satsang',
    title: 'Satsang & Spiritual Talks',
    blurb: 'Join spiritual talks and discussions from teachers and communities in India.',
    searchTerm: 'Satsang',
    organiserIdea: 'Arrange a satsang with a local teacher and open it to their extended community.',
    icon: '',
  },
  {
    id: 'bhajan-kirtan',
    title: 'Bhajan & Kirtan',
    blurb: 'Sing along or simply listen to devotional bhajans and kirtans as they happen.',
    searchTerm: 'Bhajan',
    organiserIdea: 'Bring a bhajan mandali or kirtan group online for their regular gathering.',
    icon: '',
  },
  {
    id: 'puja-archana',
    title: 'Puja & Archana',
    blurb: 'Take part in a puja or archana performed by a priest, from wherever you are.',
    searchTerm: 'Puja',
    organiserIdea: 'Arrange a puja or archana with a priest willing to broadcast the ceremony.',
    icon: '',
  },
  {
    id: 'havan-yajna',
    title: 'Havan & Yajna',
    blurb: 'Watch a havan or yajna unfold, led by a priest at a temple or home shrine.',
    searchTerm: 'Havan',
    organiserIdea: 'Coordinate with a priest or temple to broadcast an upcoming havan or yajna.',
    icon: '',
  },
  {
    id: 'aarti-darshan',
    title: 'Aarti & Darshan',
    blurb: 'Be present for an aarti as it happens at a temple or shrine.',
    searchTerm: 'Aarti',
    organiserIdea: "Partner with a temple to share their aarti timing with a wider audience.",
    icon: '',
  },
  {
    id: 'katha',
    title: 'Katha & Sacred Stories',
    blurb: 'Listen to a katha teller narrate stories from the scriptures.',
    searchTerm: 'Katha',
    organiserIdea: 'Invite a katha vachak to narrate a story session for an online audience.',
    icon: '',
  },
  {
    id: 'scripture-study',
    title: 'Scripture Study & Discussion',
    blurb: 'Study and discuss texts like the Bhagavad Gita with a teacher.',
    searchTerm: 'Bhagavad Gita',
    organiserIdea: 'Set up a recurring scripture study session with a teacher you know.',
    icon: '',
  },
  {
    id: 'mantra-japa',
    title: 'Mantra, Japa & Recitation',
    blurb: 'Join a guided session of mantra chanting, japa or recitation.',
    searchTerm: 'Mantra',
    organiserIdea: 'Offer a guided mantra or japa session led by a practitioner or teacher.',
    icon: '',
  },
  {
    id: 'yoga-pranayama',
    title: 'Yoga & Pranayama',
    blurb: 'Practise yoga and pranayama alongside a teacher, live.',
    searchTerm: 'Yoga',
    organiserIdea: "Bring a yoga or pranayama teacher's regular class online.",
    icon: '',
  },
  {
    id: 'meditation',
    title: 'Meditation & Inner Practice',
    blurb: 'Sit for a guided meditation or inner-practice session with a teacher.',
    searchTerm: 'Meditation',
    organiserIdea: 'Arrange a guided meditation session with a teacher you trust.',
    icon: '',
  },
  {
    id: 'festivals',
    title: 'Festivals & Special Observances',
    blurb: "Join festival-day observances and celebrations as they're happening.",
    searchTerm: 'Festival',
    organiserIdea: 'Help broadcast a festival-day observance your community already gathers for.',
    icon: '',
  },
  {
    id: 'pilgrimage',
    title: 'Pilgrimage & Sacred Places',
    blurb: 'See temples and sacred places through a live visit or walkthrough.',
    searchTerm: 'Temple',
    organiserIdea: "Arrange a live walkthrough of a temple or sacred place with the venue's permission.",
    icon: '',
  },
  {
    id: 'hindu-traditions',
    title: 'Learn Hindu Traditions',
    blurb: 'Learn about Hindu traditions, customs and practices from a teacher.',
    searchTerm: 'Hindu traditions',
    organiserIdea: "Offer a session explaining a tradition or custom you're knowledgeable about.",
    icon: '',
  },
] as const;

export function topicSearchHref(t: SpiritualTopic): string {
  return `/marketplace?q=${encodeURIComponent(t.searchTerm)}`;
}
