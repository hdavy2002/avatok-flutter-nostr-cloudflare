#!/usr/bin/env python3
"""[HF-PLAY-REVIEWER-1] Turn the Google Play reviewer test login on or off (production KV, env.TOKENS).

  ALLOW_PROD=1 python3 scripts/hf_reviewer_login.py set --phone +91XXXXXXXXXX --code 123456 --days 30
  ALLOW_PROD=1 python3 scripts/hf_reviewer_login.py clear
  ALLOW_PROD=1 python3 scripts/hf_reviewer_login.py status

Only hashes are stored (phone: sha256 of the E.164 number; code: sha256 of "hf-reviewer|<code>"), with an expiry.
The number must already have an account (create it with the normal sign-up first). Nothing is committed to the repo.
"""
import argparse, hashlib, json, os, re, subprocess, sys, time

KEY = "hf_play_reviewer_login:v1"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cf(*args):
    if os.environ.get("ALLOW_PROD") != "1":
        sys.exit("Refusing: this writes production KV. Re-run with ALLOW_PROD=1.")
    return subprocess.run([os.path.join(ROOT, "scripts", "cf.sh"), "worker", "kv", "key", *args, "--binding", "TOKENS", "--remote"],
                          capture_output=True, text=True)


def e164(raw):
    s = raw.strip()
    if s.startswith("+"):
        d = re.sub(r"\D", "", s)
        return "+" + d if 7 <= len(d) <= 15 else None
    d = re.sub(r"\D", "", s)
    if len(d) == 12 and d.startswith("91"): d = d[2:]
    if len(d) == 11 and d.startswith("0"): d = d[1:]
    return "+91" + d if re.fullmatch(r"[6-9]\d{9}", d) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["set", "clear", "status"])
    ap.add_argument("--phone"); ap.add_argument("--code"); ap.add_argument("--days", type=int, default=30)
    a = ap.parse_args()
    if a.cmd == "set":
        p = e164(a.phone or "")
        if not p: sys.exit("Bad --phone")
        if not re.fullmatch(r"\d{6}", a.code or ""): sys.exit("--code must be 6 digits")
        val = {"phoneHash": hashlib.sha256(p.encode()).hexdigest(),
               "codeHash": hashlib.sha256(f"hf-reviewer|{a.code}".encode()).hexdigest(),
               "until": int((time.time() + a.days * 86400) * 1000)}
        r = cf("put", KEY, json.dumps(val))
        print("set" if r.returncode == 0 else r.stderr, f"until {time.strftime('%Y-%m-%d', time.localtime(val['until']/1000))}")
    elif a.cmd == "clear":
        r = cf("delete", KEY)
        print("cleared" if r.returncode == 0 else r.stderr)
    else:
        r = cf("get", KEY)
        try:
            v = json.loads(r.stdout.strip().splitlines()[-1])
            print("ON until", time.strftime("%Y-%m-%d %H:%M", time.localtime(v["until"] / 1000)), "(expired)" if v["until"] < time.time() * 1000 else "")
        except Exception:
            print("OFF")


if __name__ == "__main__":
    main()
