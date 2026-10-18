"""Convert extracted/sheets/*.png -> client/public/assets/sheets/*.webp (alpha preserved),
reordering frames into natural numeric order. The baked sheets follow the MonoBehaviour sprite
list, whose names ('1'..'32', or '...mc.N') are sorted lexicographically ('1','10','11',..,'2',..).
Order comes from tools/assets_sheet_order.json (made by tools/assets_sheet_order.py)."""
import json, os, re
from multiprocessing import Pool
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extracted/sheets"); DST = os.path.join(ROOT, "client/public/assets/sheets")
IDX = json.load(open(os.path.join(SRC, "index.json")))
ORD = json.load(open(os.path.join(ROOT, "tools/assets_sheet_order.json")))
def perm(name):
    """stored index for each natural frame, or None if order unknown."""
    names, F = ORD.get(name), IDX[name]["frames"]
    if not names or len(names) != F: return None
    nums = [re.search(r"(\d+)$", s) for s in names]
    if not all(nums): return None
    nums = [int(m.group(1)) for m in nums]
    return sorted(range(F), key=lambda i: nums[i])
SKIP = {"Replacement"}  # 1111-frame aggregate of unrelated sprites (3664x93408), not a rotation sheet
def conv(name):
    if os.path.exists(os.path.join(DST, name + ".webp")): return name, perm(name) is not None
    m = IDX[name]; F, cols, cw, ch = m["frames"], m["cols"], m["cw"], m["ch"]
    im = Image.open(os.path.join(SRC, name + ".png")).convert("RGBA")
    p = perm(name)
    if p and p != list(range(F)):
        out = Image.new("RGBA", im.size)
        for i, s in enumerate(p):
            cell = im.crop(((s % cols) * cw, (s // cols) * ch, (s % cols + 1) * cw, (s // cols + 1) * ch))
            out.paste(cell, ((i % cols) * cw, (i // cols) * ch))
        im = out
    im.save(os.path.join(DST, name + ".webp"), "WEBP", quality=85, method=4, alpha_quality=90)
    return name, p is not None
if __name__ == "__main__":
    os.makedirs(DST, exist_ok=True)
    with Pool(os.cpu_count()) as pool: res = pool.map(conv, [n for n in IDX if n not in SKIP], chunksize=4)
    print("done", len(res), "unordered:", [n for n, ok in res if not ok])
