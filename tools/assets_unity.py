"""Helpers for the assets agent: render Unity Sprites (tile-packed meshes) to RGBA images,
read sprite frame lists from AnimationClips, and pack frames into grid sheets.

Sprites are rasterized from their mesh triangles (vertices * pixelsToUnits, UV into the atlas
texture), nearest-texel sampling, so tile-packed / tight-mesh sprites reassemble exactly.
"""
import os
import math
import numpy as np
import UnityPy
from PIL import Image
from UnityPy.helpers.MeshHelper import MeshHandler

BUNDLES = os.path.expanduser("~/darkorbit-client/") + "extracted/DarkOrbit_Version0.1.4/DarkOrbit_Data/StreamingAssets/aa/BuildTarget/"


class Bundle:
    def __init__(self, name):
        self.env = UnityPy.load(BUNDLES + name + ".bundle")
        self.objs = {o.path_id: o for o in self.env.objects}
        self._tex = {}

    def by_type(self, t):
        return [o for o in self.env.objects if o.type.name == t]

    def named(self, t, name):
        out = []
        for o in self.by_type(t):
            try:
                if o.read().m_Name == name:
                    out.append(o)
            except Exception:
                pass
        return out

    def texture(self, pid):
        if pid not in self._tex:
            self._tex[pid] = np.asarray(self.objs[pid].read().image.convert("RGBA"))
        return self._tex[pid]

    # ---- sprites -------------------------------------------------------------------------
    def render_sprite(self, so):
        """-> (RGBA Image, pivot_x, pivot_y) with pivot in image pixel coords (y down)."""
        s = so.read()
        mesh = MeshHandler(s.m_RD, so.version)
        mesh.process()
        ppu = s.m_PixelsToUnits
        tex = self.texture(s.m_RD.texture.path_id)
        H, W = tex.shape[:2]
        V = np.array([(v[0] * ppu, -v[1] * ppu) for v in mesh.m_Vertices], float)
        UV = np.array([(u[0] * W, (1 - u[1]) * H) for u in mesh.m_UV0], float)
        if not mesh.m_UV0 or not np.array(mesh.m_UV0).any():
            # plain (non-atlas) sprite without UVs: use UnityPy's rect crop, pivot from m_Pivot
            tr = s.m_RD.textureRect
            x0r, y0r = int(round(tr.x)), int(round(H - tr.y - tr.height))
            img = Image.fromarray(tex[y0r:y0r + int(round(tr.height)), x0r:x0r + int(round(tr.width))].copy(), "RGBA")
            r, off = s.m_Rect, s.m_RD.textureRectOffset
            g = lambda v, k: getattr(v, k, getattr(v, k.lower(), 0))
            px = g(s.m_Pivot, "X") * r.width - g(off, "X")
            py = img.height - (g(s.m_Pivot, "Y") * r.height - g(off, "Y"))
            return img, int(round(px)), int(round(py))
        flat = []
        def _f(x):
            if isinstance(x, (list, tuple)):
                for y in x: _f(y)
            else:
                flat.append(int(x))
        _f(mesh.get_triangles())
        tris = [flat[i:i + 3] for i in range(0, len(flat) - 2, 3)]
        x0, y0 = np.floor(V.min(0)).astype(int)
        x1, y1 = np.ceil(V.max(0)).astype(int)
        w, h = max(1, x1 - x0), max(1, y1 - y0)
        out = np.zeros((h, w, 4), np.uint8)
        P = V - (x0, y0)
        for a, b, c in tris:
            pa, pb, pc = P[a], P[b], P[c]
            bx0, by0 = np.floor(np.minimum(np.minimum(pa, pb), pc)).astype(int)
            bx1, by1 = np.ceil(np.maximum(np.maximum(pa, pb), pc)).astype(int)
            bx0, by0 = max(bx0, 0), max(by0, 0)
            bx1, by1 = min(bx1, w), min(by1, h)
            if bx1 <= bx0 or by1 <= by0:
                continue
            ys, xs = np.mgrid[by0:by1, bx0:bx1]
            px, py = xs + 0.5, ys + 0.5
            d = (pb[1] - pc[1]) * (pa[0] - pc[0]) + (pc[0] - pb[0]) * (pa[1] - pc[1])
            if abs(d) < 1e-9:
                continue
            l1 = ((pb[1] - pc[1]) * (px - pc[0]) + (pc[0] - pb[0]) * (py - pc[1])) / d
            l2 = ((pc[1] - pa[1]) * (px - pc[0]) + (pa[0] - pc[0]) * (py - pc[1])) / d
            l3 = 1 - l1 - l2
            m = (l1 >= -1e-4) & (l2 >= -1e-4) & (l3 >= -1e-4)
            if not m.any():
                continue
            u = l1 * UV[a, 0] + l2 * UV[b, 0] + l3 * UV[c, 0]
            v = l1 * UV[a, 1] + l2 * UV[b, 1] + l3 * UV[c, 1]
            ui = np.clip(u.astype(int), 0, W - 1)
            vi = np.clip(v.astype(int), 0, H - 1)
            out[ys[m], xs[m]] = tex[vi[m], ui[m]]
        return Image.fromarray(out, "RGBA"), int(-x0), int(-y0)

    # ---- animation -----------------------------------------------------------------------
    def clip_sprites(self, clip_obj):
        """-> (list of Sprite objects in frame order, sampleRate)."""
        tt = clip_obj.read_typetree()
        m = tt["m_ClipBindingConstant"]["pptrCurveMapping"]
        return [self.objs[p["m_PathID"]] for p in m if p["m_PathID"] in self.objs], tt["m_SampleRate"]


def pack(frames, cols=None, pad=0):
    """frames: list of (img, px, py). Cells share the pivot at the cell center.
    -> (sheet Image, meta dict {frames, cols, cw, ch})."""
    hw = max(max(px, im.width - px) for im, px, py in frames)
    hh = max(max(py, im.height - py) for im, px, py in frames)
    cw, ch = int(math.ceil(hw * 2)) + pad, int(math.ceil(hh * 2)) + pad
    n = len(frames)
    cols = cols or min(n, max(1, int(math.ceil(math.sqrt(n)))))
    rows = int(math.ceil(n / cols))
    sheet = Image.new("RGBA", (cw * cols, ch * rows))
    for i, (im, px, py) in enumerate(frames):
        ox = (i % cols) * cw + cw // 2 - px
        oy = (i // cols) * ch + ch // 2 - py
        sheet.alpha_composite(im, (int(ox), int(oy)))
    return sheet, {"frames": n, "cols": cols, "cw": cw, "ch": ch}


def trim(img):
    bb = img.getchannel("A").getbbox()
    return img.crop(bb) if bb else img
