# Rebuilds src-tauri/icons/icon.ico with uncompressed BMP entries (Vista-safe
# everywhere: Explorer, taskbar, tray, legacy shells). Pillow and `tauri icon`
# both emit PNG-compressed entries, which the project's original ICO did not.
import struct
from PIL import Image

SRC = "src-tauri/icons/icon.png"
OUT = "src-tauri/icons/icon.ico"
SIZES = [16, 24, 32, 48, 64, 128, 256]

src = Image.open(SRC).convert("RGBA")
images = {s: src.resize((s, s), Image.LANCZOS) for s in SIZES}

count = len(SIZES)
header = struct.pack("<HHH", 0, 1, count)
dirent_size = 16 * count
offset = 6 + dirent_size
dir_entries = []
blobs = []
for s in SIZES:
    w = h = s
    px = images[s].tobytes()  # RGBA top-down
    # BGRA rows bottom-up + monochrome AND mask (opaque where alpha>0)
    xor_rows = []
    mask_rows = []
    for y in range(h - 1, -1, -1):
        row = bytearray()
        mask = bytearray([0]) * ((w + 31) // 32 * 4)
        mask = bytearray((w + 31) // 32 * 4)
        for x in range(w):
            i = (y * w + x) * 4
            r, g, b, a = px[i], px[i + 1], px[i + 2], px[i + 3]
            row += bytes((b, g, r, a))
            if a == 0:
                mask[x // 8] |= 0x80 >> (x % 8)
        xor_rows.append(bytes(row))
        mask_rows.append(bytes(mask))
    info = struct.pack(
        "<IiiHHIIiiII",  # BITMAPINFOHEADER with height doubled
        40, w, h * 2, 1, 32, 0, len(b"".join(xor_rows)) + len(b"".join(mask_rows)),
        0, 0, 0, 0,
    )
    blob = info + b"".join(xor_rows) + b"".join(mask_rows)
    blobs.append(blob)
    dir_entries.append(struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(blob), offset))
    offset += len(blob)

with open(OUT, "wb") as f:
    f.write(header + b"".join(dir_entries) + b"".join(blobs))

check = open(OUT, "rb").read()
print(f"wrote {OUT}: {count} entries, {len(check)} bytes")
for i in range(count):
    w, h, _, _, _, bpp, size, off = struct.unpack("<BBBBHHII", check[6 + i * 16:22 + i * 16])
    kind = "PNG" if check[off:off + 4] == b"\x89PNG" else "BMP"
    print(f"  {(w or 256)}x{(h or 256)} bpp={bpp} bytes={size} {kind}")
