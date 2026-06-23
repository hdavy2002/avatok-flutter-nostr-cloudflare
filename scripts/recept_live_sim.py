#!/usr/bin/env python3
"""Simulated AI-receptionist call — drives the EXACT Gemini Live setup the
ReceptionRoom DO uses (worker/src/do/reception_room.ts) to prove whether 'Ava'
actually answers. No prod data is touched; this only opens the upstream model
session the DO would open after a caller is handed off.
"""
import asyncio, base64, json, os, re, sys
import websockets

ENV = "/Users/davy/Documents/websites/avaTOK-2-Flutter/secrets/secret-values.env"

def gemini_key():
    for line in open(ENV):
        m = re.match(r'\s*GEMINI_API_KEY\s*=\s*"?([^"\n]+)"?', line)
        if m: return m.group(1).strip()
    sys.exit("GEMINI_API_KEY not found")

MODEL = os.environ.get("RECEPT_MODEL", "gemini-3.1-flash-live-preview")
VOICE = "Puck"
# Mirrors composeReceptionistPrompt() shape (trimmed).
SYS = ("You are Ava, the personal AI assistant answering a phone call for Davy, "
       "who did not pick up. You are an assistant — never claim to be Davy. Be warm, "
       "brief and natural. Greet the caller, say Davy is unavailable, then TAKE A "
       "MESSAGE: get the caller's name, why they called, and a callback. This call is "
       "capped at 2 minutes.")

async def main():
    key = gemini_key()
    url = ("wss://generativelanguage.googleapis.com/ws/"
           "google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent"
           f"?key={key}")
    print(f"[sim] model={MODEL} voice={VOICE}")
    print(f"[sim] dialing Gemini Live ...")
    try:
        ws = await websockets.connect(url, max_size=None, open_timeout=20)
    except Exception as e:
        print(f"[sim] CONNECT FAILED: {type(e).__name__}: {e}")
        return 2
    print("[sim] WS open — sending setup frame")
    setup = {"setup": {
        "model": f"models/{MODEL}",
        "generationConfig": {"responseModalities": ["AUDIO"],
                              "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}}},
        "systemInstruction": {"parts": [{"text": SYS}]},
        "inputAudioTranscription": {}, "outputAudioTranscription": {}}}
    await ws.send(json.dumps(setup))

    setup_ok = False; audio_bytes = 0; ava_text = []; turn_done = False; first_audio_ms = None
    import time; t0 = time.time()
    try:
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=25)
            msg = json.loads(raw) if isinstance(raw, (str, bytes)) else {}
            if "setupComplete" in msg:
                setup_ok = True
                print(f"[sim] setupComplete in {int((time.time()-t0)*1000)}ms — caller speaks now")
                # Simulate the caller's first utterance (stands in for streamed mic PCM).
                await ws.send(json.dumps({"clientContent": {
                    "turns": [{"role": "user", "parts": [{"text":
                        "Hi, this is Sam from Acme. Is Davy there? I'm calling about tomorrow's 3pm meeting — can he move it to 4?"}]}],
                    "turnComplete": True}}))
                continue
            sc = msg.get("serverContent")
            if sc:
                ot = (sc.get("outputTranscription") or {}).get("text")
                if ot: ava_text.append(ot)
                for p in ((sc.get("modelTurn") or {}).get("parts") or []):
                    data = (p.get("inlineData") or {}).get("data")
                    if data:
                        n = len(base64.b64decode(data)); audio_bytes += n
                        if first_audio_ms is None:
                            first_audio_ms = int((time.time()-t0)*1000)
                            print(f"[sim] FIRST AUDIO from Ava at {first_audio_ms}ms ({n} bytes)")
                if sc.get("turnComplete"):
                    turn_done = True; break
            if msg.get("error") or "error" in str(msg).lower()[:60]:
                print(f"[sim] server error frame: {str(msg)[:300]}")
    except asyncio.TimeoutError:
        print("[sim] (no more frames — stopping)")
    except websockets.ConnectionClosed as e:
        print(f"[sim] WS closed: code={e.code} reason={e.reason!r}")
    finally:
        try: await ws.close()
        except Exception: pass

    print("\n===== RESULT =====")
    print(f"setup_complete : {setup_ok}")
    print(f"ava_audio_bytes: {audio_bytes}  (~{audio_bytes/ (24000*2):.1f}s @24k PCM16)")
    print(f"first_audio_ms : {first_audio_ms}")
    print(f"turn_complete  : {turn_done}")
    print(f"ava_said       : {''.join(ava_text).strip()[:600] or '(no transcript)'}")
    answered = setup_ok and audio_bytes > 0
    print(f"\nVERDICT: {'✅ Ava ANSWERED — receptionist engine works' if answered else '❌ Ava did NOT answer'}")
    return 0 if answered else 1

sys.exit(asyncio.run(main()))
