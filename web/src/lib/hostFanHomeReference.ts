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
  icon: 'beauty' | 'gaming' | 'fitness' | 'film';
}
export const creatorPreviews: readonly CreatorPreview[] = [
  { id: 'neha', name: 'Neha', category: 'Beauty & Style', rating: '4.9', availability: 'Online now', rate: '3.99', platform: 'Instagram', icon: 'beauty' },
  { id: 'arjun', name: 'Arjun', category: 'Gaming', rating: '4.8', availability: 'Online now', rate: '4.50', platform: 'YouTube', icon: 'gaming' },
  { id: 'meera', name: 'Meera', category: 'Fitness', rating: '4.9', availability: 'In 30 mins', rate: '3.50', platform: 'Instagram', icon: 'fitness' },
  { id: 'rohit', name: 'Rohit', category: 'Film & Culture', rating: '4.7', availability: 'Online now', rate: '3.25', platform: 'YouTube', icon: 'film' },
];
