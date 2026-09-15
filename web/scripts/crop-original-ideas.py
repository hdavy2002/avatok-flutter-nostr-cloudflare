"""Lossless crops of the owner's approved mockup; no synthesis or resizing."""
import sys
from pathlib import Path
from PIL import Image

source = Image.open(sys.argv[1]).convert('RGB')
out = Path(__file__).resolve().parents[1] / 'public/assets/global-original'
out.mkdir(parents=True, exist_ok=True)
source.save(out / 'ideas-source.png')
regions = {'ideas-heading': (0, 90, 1536, 228), 'ideas-explore': (560, 856, 974, 923), 'ideas-tape': (0, 923, 1536, 1024)}
regions['ideas-header-logo'] = (83, 30, 251, 87)
regions['ideas-header-doodle'] = (0, 0, 1536, 30)
slugs = ['creator-watch-party', 'trend-breakdown-live', 'close-friends-studio', 'channel-coaching', 'learn-the-move', 'ask-me-anything-1-1', 'launch-night-live', 'taste-of-your-world']
edges = [0, 396, 772, 1140, 1536]
for i, slug in enumerate(slugs):
    column = i % 4
    regions['ideas-' + slug] = (edges[column], 228 if i < 4 else 536, edges[column + 1], 536 if i < 4 else 856)
for name, box in regions.items():
    source.crop(box).save(out / (name + '.png'), optimize=True)
    print(name, box)
