# Debug: rasterize one exported sprite-mesh frame to PNG to verify reconstruction.
import sys, json
from PIL import Image
d = sys.argv[1]; frames = json.load(open(f"{d}/{sys.argv[2]}.json"))
outs = []
for fi in map(int, sys.argv[4].split(',')):
    f = frames[fi]; tex = Image.open(f"{d}/{f['t']}").convert('RGBA'); W, H = tex.size
    v, uv, idx = f['v'], f['uv'], f['i']
    xs, ys = v[0::2], v[1::2]; x0, y1 = min(xs), max(ys)
    img = Image.new('RGBA', (int(max(xs) - x0) + 1, int(y1 - min(ys)) + 1))
    # vertices form axis-aligned quads (4 verts each): paste the UV rect into the position rect
    for q in range(0, len(xs), 4):
        px = xs[q:q+4]; py = ys[q:q+4]; us = uv[2*q:2*q+8:2]; vs = uv[2*q+1:2*q+8:2]
        box = (round(min(us) * W), round((1 - max(vs)) * H), round(max(us) * W), round((1 - min(vs)) * H))
        tile = tex.crop(box).resize((round(max(px) - min(px)), round(max(py) - min(py))))
        img.alpha_composite(tile, (round(min(px) - x0), round(y1 - max(py))))
    outs.append(img)
sheet = Image.new('RGBA', (sum(i.width for i in outs), max(i.height for i in outs)), (20, 20, 40, 255))
x = 0
for i in outs: sheet.alpha_composite(i, (x, 0)); x += i.width
sheet.save(sys.argv[3])
