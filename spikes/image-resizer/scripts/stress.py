#!/usr/bin/env python3
"""Largest allowed images (the 50 MP cap): one process per case, 2 runs each. Not part of the normal matrix."""
import json, subprocess, sys, time
files = sys.argv[1:] or ["fixtures-stress/jpeg_48mp_8000x6000.jpg", "fixtures-stress/png_35mp_7000x5000.png", "fixtures-stress/png_alpha_35mp_7000x5000.png"]
for f in files:
    for lib in ("wasm-vips", "jsquash", "jimp"):
        t0 = time.time()
        p = subprocess.run(["node", "--import", "tsx", "scripts/run-case.ts", lib, f, "results/stress", "2"], capture_output=True, text=True, timeout=300)
        try:
            d = json.loads(p.stdout.strip().split("\n")[-1])
        except Exception:
            print(f"{f.split('/')[-1]:32} {lib:10} CRASHED exit={p.returncode} {p.stderr.strip()[-160:]!r}"); continue
        r = d["runs"][0]; m = r["metrics"]
        if r["status"] == "resized":
            warm = d["runs"][1]["metrics"]["roundTripMs"] if len(d["runs"]) > 1 else None
            print(f"{f.split('/')[-1]:32} {lib:10} resized {r['output']['width']}x{r['output']['height']}  cold {m['roundTripMs']} ms  warm {warm} ms  steps {m['steps']}  peak process RSS {d['maxRssMB']} MB")
        else:
            print(f"{f.split('/')[-1]:32} {lib:10} {r['status']}: {r.get('error')}  peak RSS {d['maxRssMB']} MB")
