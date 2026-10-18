# Contact sheet of PNGs (for eyeballing extracted UI sprites): ui_contact.py out.png scale file...
import sys
from PIL import Image, ImageDraw
out, scale, files = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
ims = []
for f in files:
    try: ims.append((f.split('/')[-1][:-4], Image.open(f).convert('RGBA')))
    except Exception: pass
cw = 220; x = y = 0; rowh = 0; pos = []
for n, im in ims:
    w, h = int(im.width * scale), int(im.height * scale)
    w2 = max(w, 110)
    if x + w2 > 1600: x = 0; y += rowh + 14; rowh = 0
    pos.append((x, y, w, h)); x += w2 + 8; rowh = max(rowh, h)
H = y + rowh + 14
sheet = Image.new('RGBA', (1600, H), (40, 40, 48, 255))
d = ImageDraw.Draw(sheet)
for (n, im), (x, y, w, h) in zip(ims, pos):
    sheet.alpha_composite(im.resize((max(1, w), max(1, h)), Image.NEAREST), (x, y + 12))
    d.text((x, y), n[:22], fill=(255, 255, 0, 255))
sheet.save(out)
