# Writes a simple PNG diagram (gradient background + grid) for testing image embeds.
import struct, sys, zlib

out = sys.argv[1] if len(sys.argv) > 1 else 'dev-vault/Sample diagram.png'
w, h = 1200, 800
rows = []
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        grid = (x % 100 < 3) or (y % 100 < 3)
        if grid:
            row += bytes((170, 190, 215))
        else:
            row += bytes((235 - y * 40 // h, 242 - x * 30 // w, 250))
    rows.append(bytes(row))
raw = b''.join(rows)

def chunk(t, d):
    c = struct.pack('>I', len(d)) + t + d
    return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
open(out, 'wb').write(png)
print('wrote', out)
