"""Build client/public/assets/* (except sheets/, see assets_convert_sheets.py) + manifest.json.
Run: .venv/bin/python tools/assets_build.py   (after assets_convert_sheets.py)"""
import json, math, os, re, shutil, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from assets_unity import Bundle, pack, trim

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EX = os.path.join(ROOT, "extracted")
OUT = os.path.join(ROOT, "client/public/assets")
Image.MAX_IMAGE_PIXELS = None


def out(rel):
    p = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def webp(img, rel, q=85):
    img.save(out(rel), "WEBP", quality=q, method=5, alpha_quality=90)
    return rel


def png(img, rel):
    img.save(out(rel), "PNG", optimize=True)
    return rel


M = {}

# ---- sheets (already converted) -------------------------------------------------------
idx = json.load(open(os.path.join(EX, "sheets/index.json")))
M["sheets"] = {}
for k, v in sorted(idx.items()):
    if os.path.exists(os.path.join(OUT, "sheets", k + ".webp")):
        M["sheets"][k] = {"url": f"sheets/{k}.webp", **v}
# Verified visually on goliath, vengeance, piranha, leonov, nostromo, spearhead, citadel (frames 0,4,8,16,24):
# frame 0 nose points LEFT (-x), frame 8 UP (-y), frame 16 RIGHT, frame 24 DOWN.
M["rotation"] = {"frame0": math.pi, "dir": 1,
                 "note": "angle(i) = frame0 + dir*i*2pi/frames, atan2 with +y down; frame 0 faces -x, frame frames/4 faces up (-y)"}

# ---- backgrounds / planets ------------------------------------------------------------
cfg = open(os.path.join(EX, "xml/maps-config.txt"), encoding="utf-8-sig").read()
D = os.path.join(EX, "map2d/Texture2D")
M["backgrounds"] = {}
for f in sorted(os.listdir(D)):
    m = re.fullmatch(r"background(\d+)\.png", f)
    if not m:
        continue
    im = Image.open(os.path.join(D, f)).convert("RGB")
    # textures are 2048x2048 with the 2048x1276 map region (maps-config region="2048,1276") at the top
    if im.size == (2048, 2048):
        im = im.crop((0, 0, 2048, 1276))
    rel = f"bg/background{m.group(1)}.jpg"
    im.save(out(rel), "JPEG", quality=85, optimize=True, progressive=True)
    M["backgrounds"][m.group(1)] = rel

M["planets"] = {}
M["planetMeta"] = {}
PREF = ["planet", "satellite", "station", "asteroid", "asteroids", "scrap", "cubes", "trianglesYellow"]
for t in sorted(set(re.findall(r'<planet typeID="(\d+)"', cfg)), key=int):
    src = next((os.path.join(D, f"{p}{t}.png") for p in PREF if os.path.exists(os.path.join(D, f"{p}{t}.png"))), None)
    if not src:
        continue
    im = Image.open(src).convert("RGBA")
    bb = im.getchannel("A").getbbox() or (0, 0, *im.size)
    c = im.crop(bb)
    M["planets"][t] = webp(c, f"planets/{t}.webp")
    M["planetMeta"][t] = {"src": os.path.basename(src), "texSize": list(im.size), "bbox": list(bb), "w": c.width, "h": c.height}

# ---- lasers / rockets -----------------------------------------------------------------
LZ = {"red": "laser0", "blue": "laser1", "green": "laser2", "white": "laser3", "sab": "laser4", "rsb": "laser5"}
M["lasers"] = {}
for k, n in LZ.items():
    shutil.copy(os.path.join(EX, f"laser/Texture2D/{n}.png"), out(f"lasers/{n}.png"))
    M["lasers"][k] = f"lasers/{n}.png"
M["laserNote"] = "textures point along -x (head on the LEFT, like ship frame 0); rotate by (angle - pi); sab=laser4 is a cyan ring, rsb=laser5 orange"
M["rockets"] = {}
for f in os.listdir(os.path.join(EX, "rocket/Sprite")):
    if re.fullmatch(r"rocket\d+\.png", f):
        shutil.copy(os.path.join(EX, "rocket/Sprite", f), out(f"rockets/{f}"))
for k, n in {"r310": "rocket1", "plt2026": "rocket2", "plt2021": "rocket3", "plt3030": "rocket4"}.items():
    M["rockets"][k] = f"rockets/{n}.png"

# ---- portal / explosion / boxes (rendered from bundle sprite meshes) --------------------
def anim_sheet(b, clip_name, rel, sprite_prefix=None):
    for c in b.by_type("AnimationClip"):
        if c.read().m_Name != clip_name:
            continue
        sp, rate = b.clip_sprites(c)
        if not sp or (sprite_prefix and not sp[0].read().m_Name.startswith(sprite_prefix)):
            continue
        sheet, meta = pack([b.render_sprite(s) for s in sp], cols=8)
        return {"url": webp(sheet, rel), **meta, "fps": rate}
    raise SystemExit("clip not found " + clip_name)

P = Bundle("portals_2d_assets_all_6f2cdbe7a11036ed26c0c72991450c36")
def go_sprites(b, root_name):
    """sprites of a root GameObject's direct SpriteRenderer children: {child: sprite_obj}"""
    for o in b.by_type("GameObject"):
        g = o.read()
        if g.m_Name != root_name:
            continue
        res = {}
        tr = next(b.objs[c.component.path_id].read() for c in g.m_Component if b.objs[c.component.path_id].type.name == "Transform")
        for ch in tr.m_Children:
            cg = b.objs[b.objs[ch.path_id].read().m_GameObject.path_id].read()
            for c in cg.m_Component:
                co = b.objs.get(c.component.path_id)
                if co and co.type.name == "SpriteRenderer":
                    s = co.read().m_Sprite
                    if s.path_id in b.objs:
                        res[cg.m_Name] = b.objs[s.path_id]
        return res
ps = go_sprites(P, "portal_1_2D")
base = P.render_sprite(ps["base"])
active = P.render_sprite(ps["active"])
# portal_1: static 'base' ring + 'active' glow layer that the Animator pulses (alpha curve, 60 Hz).
# The pulse is approximated here: 24 frames, active alpha 0.25..1 (sine), so it loops at fps 24.
frames = []
for i in range(24):
    a = 0.25 + 0.75 * (0.5 - 0.5 * math.cos(2 * math.pi * i / 24))
    layer = active[0].copy()
    layer.putalpha(layer.getchannel("A").point(lambda v: int(v * a)))
    W = max(base[0].width, active[0].width) + 4
    H = max(base[0].height, active[0].height) + 4
    cv = Image.new("RGBA", (W, H))
    cx, cy = W // 2, H // 2
    cv.alpha_composite(base[0], (cx - base[1], cy - base[2]))
    cv.alpha_composite(layer, (cx - active[1], cy - active[2]))
    frames.append((cv, cx, cy))
sheet, meta = pack(frames, cols=6)
M["portal"] = {"url": webp(sheet, "fx/portal.webp"), **meta, "fps": 24,
               "note": "portal_1 base+active; active-layer pulse approximated"}
png(trim(base[0]), "fx/portal_static.png")
M["portalStatic"] = "fx/portal_static.png"
M["portalJump"] = anim_sheet(P, "portal_jump", "fx/portal_jump.webp", "portalAnim")

E = Bundle("effect_2d_assets_all_b772e8bb48afe6663ec9429f7fd65564")
M["explosion"] = anim_sheet(E, "explosion0", "fx/explosion.webp")
M["explosionSmall"] = anim_sheet(E, "explosion2", "fx/explosion_small.webp")

C = Bundle("collects_2d_assets_all_764492116d40b9b27e4bf7ffb4feccd1")
M["box"] = {}
M["boxAnim"] = {}
for k, clip in {"bonus": "box2", "cargo": "box1", "blocked": "box0"}.items():
    a = anim_sheet(C, clip, f"boxes/{clip}_anim.webp")
    M["boxAnim"][k] = a
    for cl in C.by_type("AnimationClip"):
        if cl.read().m_Name == clip:
            sp, _ = C.clip_sprites(cl)
            M["box"][k] = png(C.render_sprite(sp[0])[0], f"boxes/{clip}.png")
            break

# ---- stations ---------------------------------------------------------------------------
Bt = Bundle("2dtexture_building_assets_all_84cd6acd177118dc5068fddf063834c2")
spr = {o.read().m_Name: o for o in Bt.by_type("Sprite")}
M["stations"] = {}
M["stationParts"] = {}
for fac in ("mmo", "eic", "vru"):
    parts = {"hq": f"{fac}_hq_op_resized", "hangar": f"hangar_{fac}_op_resized_x-1",
             "repair": f"repair_{fac}_op_resized", "trade": f"{fac}_trade_x-1", "glow": f"glow_{fac}"}
    M["stationParts"][fac] = {}
    for part, n in parts.items():
        if n not in spr:
            continue
        im, px, py = Bt.render_sprite(spr[n])
        rel = webp(im, f"stations/{fac}_{part}.webp", q=90)
        M["stationParts"][fac][part] = {"url": rel, "w": im.width, "h": im.height, "px": px, "py": py}
    M["stations"][fac] = M["stationParts"][fac]["hq"]["url"]
M["stationNote"] = "stations = HQ sprite (pivot centered). Module layout (hangar/repair/trade) is server-defined in the original; parts provided separately."

# ---- minimaps ---------------------------------------------------------------------------
MD = os.path.join(EX, "minimap/Texture2D")
M["minimaps"] = {}
M["minimapsLarge"] = {}
for mid, attrs in re.findall(r'<map id="(\d+)"([^>]*)>', cfg):
    mm = re.search(r'minimap="([^"]+)"', attrs)
    key = mm.group(1) if mm else mid
    for size, dst in (("300", "minimaps"), ("700", "minimapsLarge")):
        for cand in (f"minimap-{key}-{size}.png", f"minimap-{key}.png"):
            if os.path.exists(os.path.join(MD, cand)):
                rel = f"minimap/{cand[:-4]}.png"
                if not os.path.exists(out(rel)):
                    png(Image.open(os.path.join(MD, cand)), rel)
                M[dst][mid] = rel
                break

json.dump(M, open(out("manifest.json"), "w"), indent=1)
print({k: (len(v) if isinstance(v, dict) else v) for k, v in M.items() if k != "rotation"})
