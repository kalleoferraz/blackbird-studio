#!/usr/bin/env python3
"""Generate deterministic test images for the image resizer spike.

Every orientation fixture is built so that, when displayed correctly (EXIF
orientation applied), the four quadrants are: top-left red, top-right green,
bottom-left blue, bottom-right yellow. A resizer that ignores or misapplies the
orientation produces a different quadrant layout, which the test can detect
with four pixel samples.
"""
import os, sys, json
import numpy as np
from PIL import Image, ImageOps, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "fixtures"
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(42)
T = Image.Transpose
COLORS = {"tl": (255, 0, 0), "tr": (0, 200, 0), "bl": (0, 0, 255), "br": (255, 255, 0)}

# stored = INVERSE[o](displayed); applying EXIF orientation o to stored gives displayed.
INVERSE = {
    1: None,
    2: T.FLIP_LEFT_RIGHT,
    3: T.ROTATE_180,
    4: T.FLIP_TOP_BOTTOM,
    5: T.TRANSPOSE,
    6: T.ROTATE_90,   # inverse of ROTATE_270
    7: T.TRANSVERSE,
    8: T.ROTATE_270,  # inverse of ROTATE_90
}

def displayed_image(w, h, noise=18):
    a = np.zeros((h, w, 3), dtype=np.int16)
    hh, hw = h // 2, w // 2
    a[:hh, :hw] = COLORS["tl"]; a[:hh, hw:] = COLORS["tr"]
    a[hh:, :hw] = COLORS["bl"]; a[hh:, hw:] = COLORS["br"]
    # photo-like texture so the JPEG is a realistic size
    a += rng.integers(-noise, noise + 1, size=a.shape, dtype=np.int16)
    # keep colours away from clipping extremes so tolerance checks stay simple
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")

def save_oriented(name, stored_w, stored_h, o, quality=90, **kw):
    # displayed size: orientations 5-8 swap the axes
    dw, dh = (stored_h, stored_w) if o >= 5 else (stored_w, stored_h)
    d = displayed_image(dw, dh)
    inv = INVERSE[o]
    s = d if inv is None else d.transpose(inv)
    assert s.size == (stored_w, stored_h), (name, s.size)
    exif = Image.Exif(); exif[0x0112] = o
    # also add fake GPS-ish and camera tags so we can check metadata stripping
    exif[0x010F] = "SpikeCam"; exif[0x0110] = "Model 1"
    path = os.path.join(OUT, name)
    s.save(path, "JPEG", quality=quality, exif=exif, **kw)
    # self-check the generator: PIL's own transpose must give back the displayed image
    chk = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    assert chk.size == d.size, (name, chk.size, d.size)
    return path

manifest = {}
def add(name, **info):
    manifest[name] = info

# 12 MP phone-style photos (stored 4000x3000), four orientations
for o in (1, 3, 6, 8):
    n = f"photo12mp_o{o}.jpg"
    save_oriented(n, 4000, 3000, o)
    add(n, kind="jpeg", exif_orientation=o, stored=[4000, 3000],
        displayed=[3000, 4000] if o >= 5 else [4000, 3000], expect_copy=True,
        expect_out=[450, 600] if o >= 5 else [600, 450], quadrants=True)

# all eight orientations on a small image (cheap)
for o in (2, 4, 5, 7):
    n = f"small_o{o}.jpg"
    save_oriented(n, 1200, 900, o)
    add(n, kind="jpeg", exif_orientation=o, stored=[1200, 900],
        displayed=[900, 1200] if o >= 5 else [1200, 900], expect_copy=True,
        expect_out=[450, 600] if o >= 5 else [600, 450], quadrants=True)

# size boundary cases
for n, (w, h, copy, out) in {
    "small_500x400.jpg": (500, 400, False, None),
    "exact_600x450.jpg": (600, 450, False, None),
    "over_601x400.jpg": (601, 400, True, [600, 399]),
    "over_640x480.jpg": (640, 480, True, [600, 450]),
    "tall_1000x3000.jpg": (1000, 3000, True, [200, 600]),
}.items():
    displayed_image(w, h).save(os.path.join(OUT, n), "JPEG", quality=90)
    add(n, kind="jpeg", exif_orientation=None, stored=[w, h], displayed=[w, h], expect_copy=copy, expect_out=out)

# other JPEG flavours
im = displayed_image(2000, 1500)
im.save(f"{OUT}/progressive_2000x1500.jpg", "JPEG", quality=90, progressive=True)
add("progressive_2000x1500.jpg", kind="jpeg", exif_orientation=None, stored=[2000, 1500], displayed=[2000, 1500], expect_copy=True, expect_out=[600, 450])
im.convert("L").save(f"{OUT}/grayscale_2000x1500.jpg", "JPEG", quality=90)
add("grayscale_2000x1500.jpg", kind="jpeg", exif_orientation=None, stored=[2000, 1500], displayed=[2000, 1500], expect_copy=True, expect_out=[600, 450])
im.convert("CMYK").save(f"{OUT}/cmyk_2000x1500.jpg", "JPEG", quality=90)
add("cmyk_2000x1500.jpg", kind="jpeg", exif_orientation=None, stored=[2000, 1500], displayed=[2000, 1500], expect_copy=True, expect_out=[600, 450], informational=True)

# PNG with transparency: opaque white disc on fully transparent black.
# A correct (alpha-aware) resize keeps edge pixels white with partial alpha;
# a naive one averages in the black and leaves a dark halo.
W, H = 3000, 2000
png = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(png).ellipse((W // 2 - 800, H // 2 - 800, W // 2 + 800, H // 2 + 800), fill=(255, 255, 255, 255))
png.save(f"{OUT}/png_alpha_disc_3000x2000.png")
add("png_alpha_disc_3000x2000.png", kind="png", exif_orientation=None, stored=[W, H], displayed=[W, H], expect_copy=True, expect_out=[600, 400], alpha=True)
small = png.resize((300, 200))
small.save(f"{OUT}/png_alpha_small_300x200.png")
add("png_alpha_small_300x200.png", kind="png", exif_orientation=None, stored=[300, 200], displayed=[300, 200], expect_copy=False, expect_out=None, alpha=True)
# opaque PNG (screenshot-like)
displayed_image(2400, 1600, noise=0).save(f"{OUT}/png_opaque_2400x1600.png")
add("png_opaque_2400x1600.png", kind="png", exif_orientation=None, stored=[2400, 1600], displayed=[2400, 1600], expect_copy=True, expect_out=[600, 400])

# WebP (a cover could be a WebP)
displayed_image(2000, 1500).save(f"{OUT}/webp_2000x1500.webp", "WEBP", quality=85)
add("webp_2000x1500.webp", kind="webp", exif_orientation=None, stored=[2000, 1500], displayed=[2000, 1500], expect_copy=True, expect_out=[600, 450], informational=True)

# GIFs: animated ones must be skipped (no lightweight copy, no crash)
frames = [Image.new("P", (1200, 900), i) for i in range(5)]
pal = [c for i in range(256) for c in (i, 255 - i, (i * 7) % 256)]
for f in frames: f.putpalette(pal)
frames[0].save(f"{OUT}/gif_animated_1200x900.gif", save_all=True, append_images=frames[1:], duration=100, loop=0)
add("gif_animated_1200x900.gif", kind="gif", animated=True, stored=[1200, 900], expect_copy=False, expect_out=None)
frames[0].save(f"{OUT}/gif_static_1200x900.gif")
add("gif_static_1200x900.gif", kind="gif", animated=False, stored=[1200, 900], expect_copy=None, expect_out=None, informational=True)


# Display P3 photo (the iPhone default): quadrant colours are defined in sRGB, converted to P3 and tagged with a
# P3 profile. A resizer that ignores the profile writes the raw P3 numbers, which look washed out as sRGB.
import io
from PIL import ImageCms

def display_p3_profile():
    """Display P3 (D50-adapted) as a small matrix/TRC ICC v2 profile, built by hand: no P3 profile is installed here."""
    def s15(v): return int(round(v * 65536)) & 0xFFFFFFFF
    def xyz(x, y, z): return b"XYZ \x00\x00\x00\x00" + b"".join(s15(v).to_bytes(4, "big") for v in (x, y, z))
    def text(t): return b"text\x00\x00\x00\x00" + t.encode("ascii") + b"\x00"
    def desc(t):
        b = t.encode("ascii") + b"\x00"
        return b"desc\x00\x00\x00\x00" + len(b).to_bytes(4, "big") + b + b"\x00" * 4 + b"\x00" * 4 + b"\x00\x00" + b"\x00" + b"\x00" * 67
    # sRGB transfer curve (Display P3 uses it), 1024 points
    pts = []
    for i in range(1024):
        v = i / 1023
        pts.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    curv = b"curv\x00\x00\x00\x00" + (1024).to_bytes(4, "big") + b"".join(int(round(p * 65535)).to_bytes(2, "big") for p in pts)
    tags = {
        b"desc": desc("Display P3 (spike)"),
        b"cprt": text("public domain"),
        b"wtpt": xyz(0.9642, 1.0, 0.8249),
        b"rXYZ": xyz(0.51512, 0.24120, -0.00105),
        b"gXYZ": xyz(0.29198, 0.69225, 0.04189),
        b"bXYZ": xyz(0.15710, 0.06657, 0.78407),
        b"rTRC": curv, b"gTRC": curv, b"bTRC": curv,
    }
    table, body, offset = b"", b"", 128 + 4 + 12 * len(tags)
    for sig, blob in tags.items():
        pad = (-len(blob)) % 4
        table += sig + offset.to_bytes(4, "big") + len(blob).to_bytes(4, "big")
        body += blob + b"\x00" * pad
        offset += len(blob) + pad
    size = 128 + 4 + len(table) + len(body)
    header = bytearray(128)
    header[0:4] = size.to_bytes(4, "big")
    header[8:12] = b"\x02\x20\x00\x00"          # version 2.2
    header[12:16] = b"mntr"; header[16:20] = b"RGB "; header[20:24] = b"XYZ "
    header[36:40] = b"acsp"
    header[68:80] = b"".join(s15(v).to_bytes(4, "big") for v in (0.9642, 1.0, 0.8249))  # PCS illuminant D50
    return bytes(header) + len(tags).to_bytes(4, "big") + table + body

p3 = display_p3_profile()
srgb_prof = ImageCms.createProfile("sRGB")
p3_prof = ImageCms.ImageCmsProfile(io.BytesIO(p3))
d = displayed_image(2000, 1500)
p3_img = ImageCms.profileToProfile(d, srgb_prof, p3_prof, renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode="RGB")
p3_img.save(f"{OUT}/p3_2000x1500.jpg", "JPEG", quality=90, icc_profile=p3)
add("p3_2000x1500.jpg", kind="jpeg", exif_orientation=None, stored=[2000, 1500], displayed=[2000, 1500],
    expect_copy=True, expect_out=[600, 450], quadrants=True, tolerance=30,
    note="Display P3 profile (iPhone default): a correct copy is converted to sRGB")

# bad input
src = open(f"{OUT}/photo12mp_o6.jpg", "rb").read()
open(f"{OUT}/corrupt_truncated.jpg", "wb").write(src[:120_000])
add("corrupt_truncated.jpg", kind="corrupt", expect_failure=True)
open(f"{OUT}/not_an_image.jpg", "wb").write(rng.bytes(50_000))
add("not_an_image.jpg", kind="corrupt", expect_failure=True)
open(f"{OUT}/empty.jpg", "wb").write(b"")
add("empty.jpg", kind="corrupt", expect_failure=True)
# decompression bomb style: tiny file, huge dimensions (PNG 20000x20000 of one colour)
Image.MAX_IMAGE_PIXELS = None
Image.new("L", (20000, 20000), 128).save(f"{OUT}/bomb_20000x20000.png", optimize=False, compress_level=9)
add("bomb_20000x20000.png", kind="png", stored=[20000, 20000], expect_failure=True, informational=True, note="400 MP; should be refused by a pixel cap")

json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print(f"{len(manifest)} fixtures, {total/1e6:.1f} MB")
for f in sorted(os.listdir(OUT)):
    print(f"  {os.path.getsize(os.path.join(OUT, f))/1e3:10.0f} KB  {f}")
