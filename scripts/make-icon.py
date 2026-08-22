# Generates src-tauri/icons/icon.png (1024x1024 RGBA) for Slovo.
# Brand: dark rounded tile + soft indigo halo + the five-bar "С" mark
# (same geometry as SlovoMark in src/components/StatusHeader.tsx), recolored
# bright so it stays readable down to the 16px taskbar/tray sizes.
from PIL import Image, ImageDraw, ImageFilter

S = 4096  # 4x supersample of 1024
OUT = 1024

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# --- tile: rounded square with a dark violet vertical gradient ---
tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
grad = Image.new("RGBA", (S, S))
top = (26, 19, 48)      # #1A1330
bottom = (15, 11, 26)   # #0F0B1A
for y in range(S):
    t = y / (S - 1)
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    for x in range(0, S, 1):
        grad.putpixel((x, y), (r, g, b, 255))
# fast column fill: reuse one row per y via paste of a 1px line
grad = Image.new("RGBA", (S, S))
for y in range(S):
    t = y / (S - 1)
    row = Image.new("RGBA", (S, 1), (
        int(top[0] + (bottom[0] - top[0]) * t),
        int(top[1] + (bottom[1] - top[1]) * t),
        int(top[2] + (bottom[2] - top[2]) * t),
        255,
    ))
    grad.paste(row, (0, y))

mask = Image.new("L", (S, S), 0)
d = ImageDraw.Draw(mask)
radius = int(S * 0.225)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
tile.paste(grad, (0, 0), mask)
img.alpha_composite(tile)

# --- soft indigo halo behind the mark (carries the shape at 16px) ---
halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(halo)
cx, cy = S // 2, S // 2
hd.ellipse([cx - S * 0.31, cy - S * 0.31, cx + S * 0.31, cy + S * 0.31], fill=(124, 92, 252, 110))
halo = halo.filter(ImageFilter.GaussianBlur(S * 0.09))
img.alpha_composite(halo)

# --- five bars of the "С" mark, SlovoMark geometry on a 24-grid ---
mark = Image.new("RGBA", (S, S), (0, 0, 0, 0))
md = ImageDraw.Draw(mark)
# scale: mark spans x=3..21.6 of 24 (width 18.6) -> 66% of icon
cell = S * 0.66 / 18.6
x0 = (S - 18.6 * cell) / 2 - 3 * cell  # so that grid x=3 maps to x0+3*cell
bars = [  # (x, y, w, h) on the 24 grid, rx = w/2
    (3, 7, 2.6, 10),
    (7, 4, 2.6, 16),
    (11, 2.5, 2.6, 19),
    (15, 4, 2.6, 16),
    (19, 7, 2.6, 10),
]
# bright indigo ramp: edges vivid, center near-white violet
colors = [(150, 117, 250), (167, 139, 250), (214, 201, 255), (167, 139, 250), (150, 117, 250)]
for (bx, by, bw, bh), color in zip(bars, colors):
    px = x0 + bx * cell
    py = by * cell + (S - 24 * cell) / 2
    md.rounded_rectangle(
        [px, py, px + bw * cell, py + bh * cell],
        radius=bw * cell / 2,
        fill=color + (255,),
    )
img.alpha_composite(mark)

img = img.resize((OUT, OUT), Image.LANCZOS)
img.save("src-tauri/icons/icon.png")
print("saved src-tauri/icons/icon.png", img.size)
