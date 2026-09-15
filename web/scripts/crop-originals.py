"""Reproduce exact pixel crops from the approved source PNGs; no generation.

Run: python3 web/scripts/crop-originals.py
Requires Pillow. This is a deterministic image-asset operation, not a web build.
The lossless WebPs preserve the same RGB pixels as their corresponding PNGs.
"""
import json
from pathlib import Path
from PIL import Image

script_directory = Path(__file__).resolve().parent
destination = script_directory.parent / "public" / "assets" / "global-original"
manifest = json.loads((script_directory / "global-original-crops.json").read_text())
sources = {key: Image.open(destination / name).convert("RGB")
           for key, name in manifest["sources"].items()}
for name, specification in manifest["crops"].items():
    crop = sources[specification["source"]].crop(tuple(specification["box"]))
    crop.save(destination / (name + ".png"), optimize=True)
    crop.save(destination / (name + ".webp"), lossless=True, method=6)
    print(f"{name}: {crop.width}×{crop.height}", flush=True)
