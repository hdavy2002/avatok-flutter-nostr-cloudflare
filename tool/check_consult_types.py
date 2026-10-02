#!/usr/bin/env python3
"""[AUMFE-CONSULT-FOUNDATION-1] The Real Consultants contract lives twice (worker + web). Fail if they drift."""
import sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
a = (root / "worker/src/lib/consultants/types.ts").read_text().split("\n", 4)[4]
b = (root / "web/src/lib/consultTypes.ts").read_text().split("\n", 4)[4]
if a != b:
    print("consult types drift: edit worker/src/lib/consultants/types.ts and web/src/lib/consultTypes.ts together"); sys.exit(1)
print("consult types: in step")
