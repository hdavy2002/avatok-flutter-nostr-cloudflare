/* [HF-MERCH-STUDIO-2] Style chips, example prompts and wait lines for the AI picture panel. Swatches are drawn in CSS, no image files. */
export interface AiStyle { key: string; label: string; bg: string; mark?: string }
export const AI_STYLES: AiStyle[] = [
  { key: 'bollywood_poster', label: 'Bollywood poster', bg: 'linear-gradient(135deg,#e4572e,#f59e0b 55%,#4a1747)' },
  { key: 'madhubani', label: 'Madhubani', bg: 'radial-gradient(circle at 30% 30%,#fff1d6 0 16%,transparent 17%),radial-gradient(circle at 72% 70%,#fbbf24 0 14%,transparent 15%),linear-gradient(#d81b72,#3d2c8d)' },
  { key: 'warli', label: 'Warli', bg: 'radial-gradient(#fff 22%,transparent 24%) 0 0/9px 9px,#a4492a' },
  { key: 'kalamkari', label: 'Kalamkari', bg: 'repeating-linear-gradient(45deg,#3d2c8d 0 7px,#b45309 7px 9px,#3d2c8d 9px 16px)' },
  { key: 'pop_art', label: 'Pop art', bg: 'radial-gradient(#e4572e 32%,transparent 34%) 0 0/9px 9px,#fbbf24' },
  { key: 'truck_art', label: 'Truck art', bg: 'repeating-linear-gradient(45deg,#d81b72 0 8px,#f59e0b 8px 16px,#0e7c86 16px 24px)' },
  { key: 'watercolour', label: 'Watercolour', bg: 'radial-gradient(circle at 25% 35%,#f0a8c8 0 30%,transparent 55%),radial-gradient(circle at 75% 65%,#a9c6f0 0 30%,transparent 55%),#fffaf3' },
  { key: 'line_art', label: 'Line art', bg: 'repeating-linear-gradient(0deg,#fffaf3 0 6px,#2b1530 6px 7px)' },
  { key: 'retro_70s', label: '70s retro', bg: 'linear-gradient(#f59e0b,#ea6a12 42%,#d81b72 42%,#4a1747)' },
  { key: 'typography', label: 'Typography', bg: '#fff1d6', mark: 'Aa' },
  { key: 'clay_3d', label: '3D clay', bg: 'radial-gradient(circle at 35% 30%,#ffd1e3,#d81b72 72%)' },
  { key: 'photo_real', label: 'Photo-real', bg: 'linear-gradient(160deg,#f0d9c0,#7a4a1e)' },
];

export const ASPECTS: { key: '1:1' | '3:4' | '4:3'; label: string; w: number; h: number }[] = [
  { key: '1:1', label: 'Square', w: 22, h: 22 },
  { key: '3:4', label: 'Portrait', w: 18, h: 24 },
  { key: '4:3', label: 'Landscape', w: 26, h: 20 },
];

export const EXAMPLES = [
  'Me as a 70s Bollywood hero on a hand-painted poster',
  'My face in Madhubani art with floral borders',
  'A cute cartoon chai cup with the words "Chai first"',
  'A cricket match drawn in Warli style, white lines on a plain background',
  'A truck-art lion with bright flowers and a "Horn OK Please" banner',
  'Retro 70s sunset with "Good Vibes Only" in big letters',
];

export const WAIT_LINES = [
  'Mixing the colours…', 'Sketching your idea…', 'Painting the details…', 'Adding the finishing touches…', 'Almost there, thank you for waiting…',
];
