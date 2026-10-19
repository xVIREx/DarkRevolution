# contact sheet: python sheet.py <framesdir> [n]
import sys, os, glob
from PIL import Image
d = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 6
fs = sorted(glob.glob(os.path.join(d, 'f*.jpg')))
if not fs: print('no frames'); sys.exit()
pick = [fs[int(i * (len(fs) - 1) / (n - 1))] for i in range(n)]
cols = 3; rows = (n + cols - 1) // cols
W = Image.new('RGB', (cols * 640, rows * 360))
for i, f in enumerate(pick): W.paste(Image.open(f).resize((640, 360)), ((i % cols) * 640, (i // cols) * 360))
out = d.rstrip('/') + '_sheet.jpg'; W.save(out, quality=85); print(out, len(fs))
