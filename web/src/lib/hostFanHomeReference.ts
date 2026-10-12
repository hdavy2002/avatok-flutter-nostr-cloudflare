// [HF-HOME-HOST-FAN-1] Marketing samples only; never used for live booking or billing.
export const homeCopy = {
  heroTitle: 'Talk to your favourite social media influencers over a private phone call.',
  heroDescription: 'Book a time. We call you, call the host, and connect both calls. Neither of you sees the other’s personal number.',
} as const;
export interface CreatorPreview {
  id: string;
  name: string;
  category: string;
  rating: string;
  availability: 'Online now' | 'In 30 mins';
  rate: string;
  platform: 'Instagram' | 'YouTube';
  icon: 'beauty' | 'gaming' | 'fitness' | 'film' | 'travel' | 'music' | 'food' | 'camera';
  languages: string;
  topics: string;
  portrait?: string;
}
export const creatorPreviews: readonly CreatorPreview[] = [
  { id: 'neha', languages: 'Hindi · English', topics: 'Everyday style & beauty', name: 'Neha', category: 'Beauty & Style', rating: '4.9', availability: 'Online now', rate: '3.99', platform: 'Instagram', icon: 'beauty' },
  { id: 'arjun', languages: 'Hindi · English', topics: 'Gaming setups & favourite titles', name: 'Arjun', category: 'Gaming', rating: '4.8', availability: 'Online now', rate: '4.50', platform: 'YouTube', icon: 'gaming' },
  { id: 'meera', languages: 'English · Marathi', topics: 'Movement & everyday motivation', name: 'Meera', category: 'Fitness', rating: '4.9', availability: 'In 30 mins', rate: '3.50', platform: 'Instagram', icon: 'fitness' },
  { id: 'rohit', languages: 'Hindi · English', topics: 'Films, stories & pop culture', name: 'Rohit', category: 'Film & Culture', rating: '4.7', availability: 'Online now', rate: '3.25', platform: 'YouTube', icon: 'film' },
  { id: 'isha', name: 'Isha', category: 'Travel', rating: '4.9', availability: 'Online now', rate: '5.50', platform: 'Instagram', icon: 'travel', languages: 'Hindi · English', topics: 'Hidden gems & travel stories', portrait: '/assets/callvaal/host-fan/redesign/isha.webp' },
  { id: 'kabir', name: 'Kabir', category: 'Music', rating: '4.8', availability: 'In 30 mins', rate: '4.75', platform: 'YouTube', icon: 'music', languages: 'Hindi · Punjabi', topics: 'Playlists & life behind the music', portrait: '/assets/callvaal/host-fan/redesign/kabir.webp' },
  { id: 'sana', name: 'Sana', category: 'Food & Lifestyle', rating: '4.9', availability: 'Online now', rate: '4.25', platform: 'Instagram', icon: 'food', languages: 'English · Urdu', topics: 'Recipes & favourite comfort food', portrait: '/assets/callvaal/host-fan/redesign/sana.webp' },
  { id: 'dev', name: 'Dev', category: 'Photography', rating: '4.8', availability: 'Online now', rate: '5.00', platform: 'YouTube', icon: 'camera', languages: 'English · Bengali', topics: 'Creative ideas & photo stories', portrait: '/assets/callvaal/host-fan/redesign/dev.webp' },
];
