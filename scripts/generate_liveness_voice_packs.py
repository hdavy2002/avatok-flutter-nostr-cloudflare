#!/usr/bin/env python3
"""Generate the Liveness V3 "Ava" voice packs with ElevenLabs multilingual TTS.

Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md §1 ("Voice language packs") + §4-A.4
("Instruction-state model for voice packs"). Ava talks the user through the live
face check with 15 short pre-recorded lines, keyed by an INSTRUCTION ENUM (never a
hardcoded filename). One nice female "Ava" voice, SAME voice id across every
language (ElevenLabs multilingual v2 speaks the localized text in that voice).

The 15 clips + the English lines are the source of truth in
`app/assets/liveness_voice/en/MANIFEST.md`; this script parses the filename→line
table out of that MANIFEST so the two never drift. It writes AAC `.m4a` (mono,
~64 kbps — a 15-clip pack stays under ~1 MB) into per-language subfolders of a
build dir, ready to:

  * BUNDLE the `en/` folder into the APK at `app/assets/liveness_voice/en/`
    (English must always work offline — Constitution law 10), and
  * UPLOAD every other language folder to R2 at
    `voice-packs/liveness/<lang>/<file>` (served from
    https://blossom.avatok.ai/voice-packs/liveness/<lang>/<file>, matching
    kVoicePackCdnBase in app/lib/features/identity/liveness_v3/voice_packs.dart).

Filenames MUST match `LivenessPackManifest` in voice_packs.dart exactly (same 15
names in every language; only the folder changes).

--------------------------------------------------------------------------------
USAGE
--------------------------------------------------------------------------------
  export ELEVENLABS_API_KEY=sk_...            # required
  # optional: override the pinned female "Ava" voice
  export ELEVENLABS_VOICE_ID=<voice_id>

  # all launch languages (en es fr de pt hi ar id) into ./build/liveness_voice/
  python3 scripts/generate_liveness_voice_packs.py

  # just a couple of languages, custom out dir
  python3 scripts/generate_liveness_voice_packs.py --langs en es --out /tmp/vp

  # English on-screen lines are in the MANIFEST; non-English lines are read from
  # this script's LOCALIZED map (kept in sync with LivenessStrings in
  # voice_packs.dart). Languages without a localized line fall back to the English
  # text spoken in the target language's voice (multilingual TTS still localizes
  # pronunciation) — the app also falls back to on-device TTS at runtime, so a
  # missing translation never blocks the flow.

Encoding: ElevenLabs returns MP3; we transcode to `.m4a` (AAC) with ffmpeg if it
is on PATH (recommended, matches the manifest). Pass --keep-mp3 to also keep the
raw MP3, or --no-ffmpeg to write `.m4a` containers straight from the MP3 bytes is
NOT done — without ffmpeg we write `.mp3` and warn (the app manifest expects m4a).

This script only WRITES a build dir; it never uploads or touches the app assets.
The owner copies en/ into the app and uploads the rest to R2.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# ── Constants ─────────────────────────────────────────────────────────────────

# Pinned female "Ava" voice. Default = "Rachel" (a warm, clear female ElevenLabs
# preset voice id, stable across the account). Override with ELEVENLABS_VOICE_ID.
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"  # Rachel (female)
MODEL_ID = "eleven_multilingual_v2"
TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"

# Launch languages (must match LivenessStrings.supported in voice_packs.dart).
ALL_LANGS = ["en", "es", "fr", "de", "pt", "hi", "ar", "id"]

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = REPO_ROOT / "app" / "assets" / "liveness_voice" / "en" / "MANIFEST.md"

# Localized on-screen/spoken lines. Mirrors LivenessStrings in voice_packs.dart —
# keyed by the manifest FILENAME so we don't need the Dart enum here. Only the
# languages with translations in the app are filled; the rest fall back to the
# English text (multilingual TTS still localizes the delivery, and the runtime
# fallback chain covers any gap). KEEP IN SYNC with voice_packs.dart LivenessStrings.
LOCALIZED: dict[str, dict[str, str]] = {
    "es": {
        "intro.m4a": "Hola, soy Ava. Apoya el teléfono para que vea tu cara.",
        "move_closer.m4a": "Acércate un poco.",
        "move_back.m4a": "Aléjate un poco.",
        "face_left.m4a": "Gira la cabeza a la izquierda.",
        "face_right.m4a": "Gira la cabeza a la derecha.",
        "look_up.m4a": "Mira un poco hacia arriba.",
        "look_down.m4a": "Mira un poco hacia abajo.",
        "good.m4a": "Perfecto.",
        "hold_still.m4a": "No te muevas — estoy grabando.",
        "face_not_found.m4a": "Coloca tu cara en el recuadro.",
        "low_light.m4a": "Ve a un lugar con más luz.",
        "remove_glasses.m4a": "Quítate las gafas, por favor.",
        "only_one_person.m4a": "Asegúrate de estar solo en la imagen.",
        "camera_blocked.m4a": "Algo cubre la cámara.",
        "done.m4a": "¡Listo! Estoy comprobando.",
    },
    "fr": {
        "intro.m4a": "Bonjour, je suis Ava. Posez votre téléphone pour que je voie votre visage.",
        "move_closer.m4a": "Approchez-vous un peu.",
        "move_back.m4a": "Reculez un peu.",
        "face_left.m4a": "Tournez la tête à gauche.",
        "face_right.m4a": "Tournez la tête à droite.",
        "look_up.m4a": "Regardez un peu vers le haut.",
        "look_down.m4a": "Regardez un peu vers le bas.",
        "good.m4a": "Parfait.",
        "hold_still.m4a": "Ne bougez plus — j'enregistre.",
        "face_not_found.m4a": "Placez votre visage dans le cadre.",
        "low_light.m4a": "Allez dans un endroit plus lumineux.",
        "remove_glasses.m4a": "Veuillez retirer vos lunettes.",
        "only_one_person.m4a": "Assurez-vous d'être seul dans l'image.",
        "camera_blocked.m4a": "Quelque chose couvre la caméra.",
        "done.m4a": "C'est fait ! Je vérifie maintenant.",
    },
    "de": {
        "intro.m4a": "Hallo, ich bin Ava. Stell dein Handy auf, damit ich dein Gesicht sehe.",
        "move_closer.m4a": "Komm ein bisschen näher.",
        "move_back.m4a": "Geh ein bisschen zurück.",
        "face_left.m4a": "Dreh den Kopf nach links.",
        "face_right.m4a": "Dreh den Kopf nach rechts.",
        "look_up.m4a": "Schau etwas nach oben.",
        "look_down.m4a": "Schau etwas nach unten.",
        "good.m4a": "Perfekt.",
        "hold_still.m4a": "Halt still — ich nehme auf.",
        "face_not_found.m4a": "Bring dein Gesicht ins Bild.",
        "low_light.m4a": "Geh an einen helleren Ort.",
        "remove_glasses.m4a": "Bitte nimm die Brille ab.",
        "only_one_person.m4a": "Sorge dafür, dass nur du im Bild bist.",
        "camera_blocked.m4a": "Etwas verdeckt die Kamera.",
        "done.m4a": "Fertig! Ich prüfe das jetzt.",
    },
    # pt / hi / ar / id: no in-app translations yet — English text spoken in the
    # target-language voice (multilingual v2). Add maps here as translations land.
}


# ── MANIFEST parsing (filename → English line, the source of truth) ───────────

def parse_manifest(path: Path) -> "list[tuple[str, str]]":
    """Parse the markdown table in MANIFEST.md into [(filename, english_line)]."""
    if not path.exists():
        sys.exit(f"ERROR: manifest not found at {path}")
    rows: list[tuple[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if len(cells) < 3:
            continue
        _instruction, filename, english = cells[0], cells[1], cells[2]
        # Skip the header + separator rows.
        if filename in ("filename", "") or set(filename) <= {"-", ":"}:
            continue
        if not filename.endswith(".m4a"):
            continue
        rows.append((filename, english))
    if len(rows) != 15:
        print(f"WARNING: expected 15 clips in the manifest, parsed {len(rows)}.",
              file=sys.stderr)
    return rows


def line_for(lang: str, filename: str, english: str) -> str:
    if lang == "en":
        return english
    return LOCALIZED.get(lang, {}).get(filename, english)


# ── ElevenLabs TTS ────────────────────────────────────────────────────────────

def synthesize(api_key: str, voice_id: str, text: str) -> bytes:
    """Call ElevenLabs TTS → MP3 bytes. Raises on non-200."""
    payload = {
        "text": text,
        "model_id": MODEL_ID,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75,
                           "style": 0.0, "use_speaker_boost": True},
    }
    import json as _json
    req = urllib.request.Request(
        TTS_URL.format(voice_id=voice_id),
        data=_json.dumps(payload).encode("utf-8"),
        headers={
            "xi-api-key": api_key,
            "content-type": "application/json",
            "accept": "audio/mpeg",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (trusted host)
        return resp.read()


# ── Encoding (MP3 → m4a via ffmpeg) ───────────────────────────────────────────

def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def mp3_to_m4a(mp3_bytes: bytes, dest_m4a: Path) -> None:
    """Transcode MP3 bytes → AAC .m4a (mono, 64 kbps) with ffmpeg."""
    proc = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", "pipe:0", "-ac", "1", "-b:a", "64k", "-c:a", "aac",
         "-movflags", "+faststart", str(dest_m4a)],
        input=mp3_bytes, capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode('utf-8', 'ignore')[:400]}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Generate Liveness V3 Ava voice packs.")
    ap.add_argument("--langs", nargs="*", default=ALL_LANGS,
                    help=f"languages to build (default: {' '.join(ALL_LANGS)})")
    ap.add_argument("--out", default=str(REPO_ROOT / "build" / "liveness_voice"),
                    help="output build dir (per-language subfolders written here)")
    ap.add_argument("--voice-id", default=os.environ.get("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID),
                    help="ElevenLabs female voice id (pinned Ava voice)")
    ap.add_argument("--keep-mp3", action="store_true", help="also keep raw .mp3 files")
    ap.add_argument("--no-ffmpeg", action="store_true",
                    help="skip transcode; write .mp3 (app manifest expects .m4a — warns)")
    args = ap.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        sys.exit("ERROR: set ELEVENLABS_API_KEY in the environment.")

    for lang in args.langs:
        if lang not in ALL_LANGS:
            sys.exit(f"ERROR: unsupported language '{lang}'. Supported: {' '.join(ALL_LANGS)}")

    use_ffmpeg = not args.no_ffmpeg and have_ffmpeg()
    if not use_ffmpeg and not args.no_ffmpeg:
        print("WARNING: ffmpeg not found on PATH — writing .mp3 instead of .m4a. "
              "The app manifest expects .m4a; install ffmpeg or use --no-ffmpeg "
              "knowingly.", file=sys.stderr)

    clips = parse_manifest(MANIFEST_PATH)
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    total_ok = 0
    total = 0
    for lang in args.langs:
        lang_dir = out_root / lang
        lang_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n=== {lang} → {lang_dir} (voice {args.voice_id}) ===")
        for filename, english in clips:
            total += 1
            text = line_for(lang, filename, english)
            try:
                mp3 = synthesize(api_key, args.voice_id, text)
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "ignore")[:300]
                print(f"  ! {filename}: HTTP {e.code} {body}", file=sys.stderr)
                continue
            except Exception as e:  # noqa: BLE001
                print(f"  ! {filename}: {e}", file=sys.stderr)
                continue

            if use_ffmpeg:
                dest = lang_dir / filename  # .m4a
                try:
                    mp3_to_m4a(mp3, dest)
                except Exception as e:  # noqa: BLE001
                    print(f"  ! {filename}: transcode failed: {e}", file=sys.stderr)
                    continue
                if args.keep_mp3:
                    (lang_dir / filename.replace(".m4a", ".mp3")).write_bytes(mp3)
            else:
                dest = lang_dir / filename.replace(".m4a", ".mp3")
                dest.write_bytes(mp3)

            total_ok += 1
            print(f"  ✓ {dest.name}  ({text!r})")

    print(f"\nDone: {total_ok}/{total} clips written to {out_root}.")
    print("Next: copy en/ → app/assets/liveness_voice/en/  and upload the other "
          "language folders to R2 at voice-packs/liveness/<lang>/<file>.")
    return 0 if total_ok == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
