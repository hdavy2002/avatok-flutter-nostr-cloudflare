/** Reserved private layout fixtures. No accounts, verification, media, ratings or availability are fabricated. */
export const CREATOR_FIXTURE_PREFIX = "fixture_creator_";
export const isCreatorFixture = (uid: string) => uid.startsWith(CREATOR_FIXTURE_PREFIX);
export const CREATOR_FIXTURES = [
  { uid: "fixture_creator_anya", slug: "sample-anya-aaaa", category: "influencer", name: "Anya", tagline: "Films and everyday stories", price: 20, languages: ["Hindi", "English"], topics: ["kisi-topic-pe-baat"] },
  { uid: "fixture_creator_kabir", slug: "sample-kabir-bbbb", category: "influencer", name: "Kabir", tagline: "Cricket and friendly conversation", price: 40, languages: ["Hindi"], topics: ["bas-baat-karni-hai"] },
  { uid: "fixture_creator_meera", slug: "sample-meera-cccc", category: "celebrity", name: "Meera", tagline: "A conversation about creative work", price: 100, languages: ["English", "Tamil"], topics: ["english-mein-casual-chat"] },
] as const;
