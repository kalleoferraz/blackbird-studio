#!/usr/bin/env python3
"""Check the outputs of scripts/run-all.ts against what the Bible says should happen, using PIL as an
independent decoder, and write results/report.md.

For each (library, fixture) it checks:
  decision    resized / skipped / failed matches the expectation
  size        longest side exactly 600, the other side within 1 px of the expected size
  orientation the four quadrant colours sit where a correctly oriented image has them
  metadata    no EXIF (no orientation tag, no camera or GPS data) left in the copy
  alpha       transparent stays transparent, opaque stays opaque, edges have no dark halo
  format      the copy has the original's format
"""
import json, os, sys
from PIL import Image

FIX = sys.argv[1] if len(sys.argv) > 1 else "fixtures"
RES = sys.argv[2] if len(sys.argv) > 2 else "results"
manifest = json.load(open(f"{FIX}/manifest.json"))
data = json.load(open(f"{RES}/results.json"))
env = data["env"]

COLORS = {"tl": (255, 0, 0), "tr": (0, 200, 0), "bl": (0, 0, 255), "br": (255, 255, 0)}
NO_QUADRANTS = ("grayscale", "cmyk", "alpha", "gif", "corrupt", "not_an_image", "empty", "bomb")

def has_quadrants(name):
    return not any(k in name for k in NO_QUADRANTS)

def close(a, b, tol=45):  # tolerance for JPEG noise and averaging
    return all(abs(x - y) <= tol for x, y in zip(a, b))

def check_case(case):
    """Returns (verdict, notes, details). verdict: PASS, FAIL or INFO (informational fixture)."""
    name, lib = case["file"], case["lib"]
    spec = manifest[name]
    informational = spec.get("informational", False)
    notes, problems = [], []
    if case.get("crashed"):
        return ("INFO" if informational else "FAIL"), ["process crashed: " + case.get("stderr", "")[-200:].replace("\n", " ")], {}
    run = case["runs"][0]
    status = run["status"]

    if spec.get("expect_failure"):
        if status != "failed":
            problems.append(f"expected a clean failure, got {status}")
        else:
            notes.append(f"refused: {run['error']['code']}")
        return finish(problems, notes, informational, {})

    if status == "failed":
        code = run["error"]["code"]
        msg = run["error"]["message"][:90]
        if code == "unsupported_by_library":
            notes.append(f"not supported by this library ({msg})")
            return ("INFO" if informational else "NOTE"), notes, {}
        problems.append(f"failed: {code}: {msg}")
        return finish(problems, notes, informational, {})

    expect_copy = spec.get("expect_copy")
    if expect_copy is False:
        if status != "skipped": problems.append(f"expected no copy, got {status}")
        else: notes.append("skipped: " + run["reason"] if "reason" in run else "skipped")
        return finish(problems, notes, informational, {})
    if expect_copy is None:
        notes.append(f"{status}" + (f": {run.get('reason', '')}" if status == "skipped" else ""))
        return ("INFO"), notes, {}
    if status != "resized":
        problems.append(f"expected a copy, got {status}: {run.get('reason', '')}")
        return finish(problems, notes, informational, {})

    out = run["output"]
    path = os.path.join(RES, "out", lib, out["name"])
    im = Image.open(path)
    im.load()
    w, h = im.size
    ew, eh = spec["expect_out"]
    if max(w, h) != 600: problems.append(f"longest side is {max(w,h)}, not 600")
    if abs(w - ew) > 1 or abs(h - eh) > 1: problems.append(f"size {w}x{h}, expected {ew}x{eh}")
    if (w, h) != (out["width"], out["height"]): problems.append("reported size differs from the file")
    expected_name_tail = f"_{w}x{h}"
    if expected_name_tail not in out["name"]: problems.append(f"name {out['name']} does not carry {w}x{h}")
    fmt = {"JPEG": "jpeg", "PNG": "png", "WEBP": "webp"}.get(im.format, im.format)
    if fmt != spec["kind"]: problems.append(f"format {fmt}, expected {spec['kind']}")

    exif = im.getexif()
    leaked = [t for t in (0x0112, 0x010F, 0x0110, 0x8825) if t in exif]
    if leaked: problems.append(f"metadata left in copy (EXIF tags {[hex(t) for t in leaked]})")
    else: notes.append("no EXIF")

    details = {}
    if spec.get("quadrants") or has_quadrants(name):
        rgb = im.convert("RGB")
        probe = {"tl": (w * 0.25, h * 0.25), "tr": (w * 0.75, h * 0.25), "bl": (w * 0.25, h * 0.75), "br": (w * 0.75, h * 0.75)}
        bad = []
        for q, (x, y) in probe.items():
            px = rgb.getpixel((int(x), int(y)))
            if not close(px, COLORS[q], spec.get('tolerance', 45)): bad.append(f"{q}={px}")
        if bad: problems.append("orientation/colour wrong: " + ", ".join(bad))
        else: notes.append("orientation ok")

    if spec.get("alpha"):
        rgba = im.convert("RGBA")
        corner = rgba.getpixel((3, 3))[3]
        center = rgba.getpixel((w // 2, h // 2))[3]
        edge = [(r, g, b, a) for (r, g, b, a) in rgba.getdata() if 8 < a < 247]
        halo = (sum(255 - min(r, g, b) for r, g, b, a in edge) / len(edge)) if edge else 0
        details["halo"] = round(halo, 1)
        if im.mode not in ("RGBA", "LA", "P"): problems.append(f"alpha channel lost (mode {im.mode})")
        if corner != 0: problems.append(f"transparent corner has alpha {corner}")
        if center != 255: problems.append(f"opaque centre has alpha {center}")
        if halo > 20: problems.append(f"dark halo on edges (mean {halo:.0f} below white)")
        else: notes.append(f"alpha ok (halo {halo:.0f})")
    return finish(problems, notes, informational, details)

def finish(problems, notes, informational, details):
    if problems:
        return ("INFO" if informational else "FAIL"), problems + notes, details
    return "PASS", notes, details

rows = {}
for case in data["cases"]:
    verdict, notes, details = check_case(case)
    rows.setdefault(case["file"], {})[case["lib"]] = (verdict, notes, details, case)

libs = [l for l in ("wasm-vips", "jimp", "jsquash") if any(l in r for r in rows.values())]
out = []
w = out.append
w("# Image resizer spike: results\n")
w(f"Run {env['date']} on {env['platform']}, Node {env['node']}, {env['cpus']} CPU(s) ({env['cpu']}), {env['totalMemMB']} MB RAM. "
  "This is **not** the GoDaddy host: timings and memory here are a reference, and the same run must be repeated there.\n")
w("Libraries: " + ", ".join(f"{l} {env['libraries'][l]}" for l in libs) + "\n")

# summary of verdicts
w("## Correctness\n")
w("| Fixture | " + " | ".join(libs) + " |")
w("| --- | " + " | ".join("---" for _ in libs) + " |")
tot = {l: {"PASS": 0, "FAIL": 0, "INFO": 0, "NOTE": 0} for l in libs}
for name in manifest:
    cells = []
    for l in libs:
        if l not in rows.get(name, {}): cells.append("n/a"); continue
        v, notes, _, _ = rows[name][l]
        tot[l][v] += 1
        mark = {"PASS": "pass", "FAIL": "**FAIL**", "INFO": "info", "NOTE": "n/a"}[v]
        cells.append(mark)
    w(f"| `{name}` | " + " | ".join(cells) + " |")
w("| **Totals** | " + " | ".join(f"{tot[l]['PASS']} pass, {tot[l]['FAIL']} fail, {tot[l]['INFO']} info" for l in libs) + " |\n")

w("### Details for every non-pass\n")
for name in manifest:
    for l in libs:
        if l not in rows.get(name, {}): continue
        v, notes, _, _ = rows[name][l]
        if v != "PASS":
            w(f"- `{name}` / {l}: **{v}**: " + "; ".join(notes))
w("")

# timing and memory
def med(xs): xs = sorted(xs); return xs[len(xs) // 2]
w("## Time and memory\n")
w("Each case ran in its own process; run 1 starts a new worker thread and loads the library (cold), runs 2 and 3 reuse it (warm). "
  "RSS is the whole process (worker thread and WebAssembly memory included); the baseline is the process before the job (~90 MB).\n")
key = ["photo12mp_o6.jpg", "photo12mp_o1.jpg", "png_alpha_disc_3000x2000.png", "png_opaque_2400x1600.png", "progressive_2000x1500.jpg", "tall_1000x3000.jpg", "webp_2000x1500.webp"]
w("| Fixture | Library | Cold total ms | Library init ms | Warm total ms | Warm steps (ms) | CPU ms (warm) | Peak RSS MB (process) | Output bytes |")
w("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
for name in key:
    for l in libs:
        c = rows.get(name, {}).get(l)
        if not c: continue
        case = c[3]
        runs = [r for r in case.get("runs", []) if r["status"] == "resized"]
        if not runs:
            w(f"| `{name}` | {l} | n/a | | | {c[1][0] if c[1] else ''} | | | |"); continue
        cold, warm = runs[0], runs[1:] or runs[:1]
        wsteps = warm[-1]["metrics"].get("steps", {})
        w(f"| `{name}` | {l} | {cold['metrics']['roundTripMs']} | {cold['metrics']['initMs']} | {med([r['metrics']['roundTripMs'] for r in warm])} | "
          f"{', '.join(f'{k} {v}' for k, v in wsteps.items())} | {med([r['metrics']['cpuMs'] for r in warm])} | {case['maxRssMB']} | {cold['output']['bytes']} |")
w("")

# every resized case: peak over all fixtures
w("### Worst case over all fixtures\n")
w("| Library | Highest process RSS MB | Slowest cold ms | Fixture of the slowest |")
w("| --- | --- | --- | --- |")
for l in libs:
    worst_rss, slow, slow_name = 0, 0, ""
    for name in manifest:
        c = rows.get(name, {}).get(l)
        if not c: continue
        case = c[3]
        if case.get("crashed"): continue
        worst_rss = max(worst_rss, case["maxRssMB"])
        for r in case["runs"][:1]:
            if r["status"] == "resized" and r["metrics"]["roundTripMs"] > slow:
                slow, slow_name = r["metrics"]["roundTripMs"], name
    w(f"| {l} | {worst_rss} | {slow} | `{slow_name}` |")
w("")

os.makedirs(RES, exist_ok=True)
open(f"{RES}/report.md", "w").write("\n".join(out))
print("\n".join(out))
