#!/usr/bin/env python3
"""One-off icon generation from the flow master logo. Run once, not part
of the build — see WORKING_ON.md for how to regenerate if the logo changes."""
import os
from PIL import Image, ImageDraw

ICONS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "public", "icons")
SRC = os.path.join(ICONS_DIR, "flow.png")

GHOST_WHITE = (249, 250, 251, 255)

def load_trimmed_logo():
    img = Image.open(SRC).convert("RGBA")
    bbox = img.getbbox()
    return img.crop(bbox)

LOGO = load_trimmed_logo()

# Transparent, tightly-cropped mark for inline UI use (header, login/register
# branding) — distinct from the padded/background-filled OS icons below,
# which need their own safe-zone padding for home-screen display.
def make_mark(max_dim, out_name):
    scale = max_dim / max(LOGO.width, LOGO.height)
    size = (int(LOGO.width * scale), int(LOGO.height * scale))
    mark = LOGO.resize(size, Image.LANCZOS)
    out_path = os.path.join(ICONS_DIR, out_name)
    mark.save(out_path)
    print(f"wrote {out_path} ({size[0]}x{size[1]})")

make_mark(256, "flow-mark.png")

def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=radius, fill=255)
    return mask

def make_icon(size, content_ratio, out_name, corner_ratio=0.0, bg=GHOST_WHITE):
    canvas = Image.new("RGBA", (size, size), bg)
    if corner_ratio > 0:
        mask = rounded_mask(size, int(size * corner_ratio))
        rounded_bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        rounded_bg.paste(canvas, (0, 0), mask)
        canvas = rounded_bg

    target_w = int(size * content_ratio)
    scale = target_w / LOGO.width
    target_h = int(LOGO.height * scale)
    logo_resized = LOGO.resize((target_w, target_h), Image.LANCZOS)

    x = (size - target_w) // 2
    y = (size - target_h) // 2
    canvas.alpha_composite(logo_resized, (x, y))

    out_path = os.path.join(ICONS_DIR, out_name)
    canvas.convert("RGB" if out_name.startswith("apple") else "RGBA").save(out_path)
    print(f"wrote {out_path} ({size}x{size})")

# "any" purpose — rounded-square, matches the previous placeholder's ~22% radius
make_icon(192, 0.72, "icon-192.png", corner_ratio=0.22)
make_icon(512, 0.72, "icon-512.png", corner_ratio=0.22)

# maskable — full-bleed square, logo kept inside Android's ~80% safe zone
make_icon(192, 0.58, "icon-maskable-192.png", corner_ratio=0.0)
make_icon(512, 0.58, "icon-maskable-512.png", corner_ratio=0.0)

# apple touch icon — iOS applies its own mask/rounding, wants an opaque square
make_icon(180, 0.72, "apple-touch-icon.png", corner_ratio=0.0)

# favicon
make_icon(32, 0.78, "favicon-32.png", corner_ratio=0.18)
make_icon(16, 0.78, "favicon-16.png", corner_ratio=0.18)

make_icon(48, 0.78, "favicon-48.png", corner_ratio=0.18)
# ICO's `sizes` list only downscales from the base image (can't upscale), so
# the base has to be the largest size wanted in the file.
fav48 = Image.open(os.path.join(ICONS_DIR, "favicon-48.png"))
fav_ico_path = os.path.join(os.path.dirname(__file__), "..", "..", "public", "favicon.ico")
fav48.save(fav_ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
print(f"wrote {fav_ico_path}")

os.remove(os.path.join(ICONS_DIR, "favicon-16.png"))
os.remove(os.path.join(ICONS_DIR, "favicon-48.png"))
print("done")
