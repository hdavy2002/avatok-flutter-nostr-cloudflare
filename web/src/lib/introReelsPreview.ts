// [HF-INTRO-B3] Local mock feed for /explore-intro-preview (noindex): four intro reels, one per state, so the overlay can be looked at without the API.
// Same shape as GET /api/hf/reels items of kind 'intro' (Specs/HF-INTRO-VIDEO-1-API.md). The videos are tiny placeholders under /hf-intro-preview/ (not committed; a missing file just shows the poster).
import type { ReelItem } from './hfExplore';
import { brandUrl } from './brand';

const base = { kind: 'intro' as const, platform: 'intro', url: '', embedUrl: null, thumbUrl: null, caption: '', likes: 0, comments: 0, views: 0, publishedAt: null, greenTick: true };

export const INTRO_PREVIEW_ITEMS: ReelItem[] = [
  { ...base, id: 'hfin_previewcall0001', title: 'Priya Sharma', likes: 2100, comments: 148,
    videoUrl: '/hf-intro-preview/r1.mp4', posterUrl: '/hf-intro-preview/r1.jpg',
    host: { slug: 'priya-sharma', name: 'Priya Sharma', handle: '@priyacooks', avatar: null, greenTick: true, presence: 'online', callState: 'available', ratePaise: 1200 },
    categories: [{ id: 'astrology', label: 'Astrology' }, { id: 'cooking', label: 'Cook' }], description: 'Kundli reading for marriage, career and hard phases. Hindi & English.',
    ratePaise: 1200, callOption: 'B', callState: 'available', mainAction: 'call', womenOnly: false,
    socials: [{ platform: 'youtube', handle: '@priyacooks', url: 'https://www.youtube.com/@priyacooks', followers: 12400 }, { platform: 'instagram', handle: '@priya.kundli', url: 'https://www.instagram.com/priya.kundli', followers: 8900 }],
    shareUrl: brandUrl('/r/hfin_previewcall0001') },
  { ...base, id: 'hfin_previewbusy0002', title: 'Arjun Mehta', likes: 864, comments: 52,
    videoUrl: '/hf-intro-preview/r2.mp4', posterUrl: '/hf-intro-preview/r2.jpg',
    host: { slug: 'arjun-mehta', name: 'Arjun Mehta', handle: '@arjunfit', avatar: null, greenTick: true, presence: 'busy', callState: 'on_call', ratePaise: 1500, queue: { open: true, waiting: 2 } },
    categories: [{ id: 'fitness', label: 'Fitness' }, { id: 'career', label: 'Career' }], description: 'Home workouts and job-switch advice. Ex-trainer, 6 years.',
    ratePaise: 1500, callOption: 'B', callState: 'on_call', mainAction: 'queue_or_book', womenOnly: false,
    socials: [{ platform: 'instagram', handle: '@arjun.fit', url: 'https://www.instagram.com/arjun.fit', followers: 31000 }, { platform: 'facebook', handle: 'Arjun Mehta', url: 'https://www.facebook.com/arjun.mehta.fit' }],
    shareUrl: brandUrl('/r/hfin_previewbusy0002') },
  { ...base, id: 'hfin_previewbook0003', title: 'Neha Verma', likes: 310, comments: 19,
    videoUrl: '/hf-intro-preview/r3.mp4', posterUrl: '/hf-intro-preview/r3.jpg',
    host: { slug: 'neha-verma', name: 'Neha Verma', handle: null, avatar: null, greenTick: true, presence: 'offline', callState: 'appointments', ratePaise: 1000 },
    categories: [{ id: 'listener', label: 'Listener' }, { id: 'w2w', label: 'Women-to-Women' }, { id: 'sleep', label: 'Sleep' }, { id: 'stress', label: 'Stress' }], description: 'A calm ear for a hard week. Hindi, English, Punjabi.',
    ratePaise: 1000, callOption: 'A', callState: 'appointments', mainAction: 'book', womenOnly: true,
    socials: [], shareUrl: brandUrl('/r/hfin_previewbook0003') },
  { ...base, id: 'hfin_previewwomen0004', title: 'Meera Iyer', likes: 1200, comments: 77,
    videoUrl: '/hf-intro-preview/r4.mp4', posterUrl: '/hf-intro-preview/r4.jpg',
    host: { slug: 'meera-iyer', name: 'Meera Iyer', handle: '@meeratalks', avatar: null, greenTick: true, presence: 'online', callState: 'available', ratePaise: 1800 },
    categories: [{ id: 'marriage', label: 'Marriage' }, { id: 'parenting', label: 'Parenting' }], description: 'Women-only chats on marriage, in-laws and parenting.',
    ratePaise: 1800, callOption: 'B', callState: 'available', mainAction: 'call', womenOnly: true,
    socials: [{ platform: 'youtube', handle: '@meeratalks', url: 'https://www.youtube.com/@meeratalks', followers: 5600 }],
    shareUrl: brandUrl('/r/hfin_previewwomen0004') },
];
