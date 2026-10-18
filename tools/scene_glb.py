"""Minimal GLB writer + Unity Mesh -> GLB conversion (shared by tools/scene_*).

Unity is left-handed (x right, y up, z forward). three.js is right-handed.
We convert every Unity vector (x,y,z) -> (x, y, -z) and reverse triangle winding.
This matches the game mapping: Unity scene z = -gameY, three z = +gameY.
"""
import json, struct
import numpy as np
from UnityPy.helpers.MeshHelper import MeshHandler

def unity_mesh_arrays(mesh):
    h = MeshHandler(mesh); h.process()
    def arr(a, n, keep):
        if not a: return None
        x = np.array(a, dtype=np.float32)
        if x.ndim == 1: x = x.reshape(n, -1)
        return x[:, :keep].copy()
    pos = np.array(h.m_Vertices, dtype=np.float32)
    if pos.ndim == 1: pos = pos.reshape(-1, 3)
    pos = pos[:, :3].copy(); n = len(pos)
    nrm = arr(h.m_Normals, n, 3)
    uv = arr(h.m_UV0, n, 2)
    subs = []
    for tris in h.get_triangles():
        subs.append(np.array(tris, dtype=np.uint32).reshape(-1, 3))
    return pos, nrm, uv, subs

def to_three(pos, nrm, uv, subs):
    pos = pos.copy(); pos[:, 2] *= -1
    if nrm is not None: nrm = nrm.copy(); nrm[:, 2] *= -1
    if uv is not None: uv = uv.copy(); uv[:, 1] = 1.0 - uv[:, 1]   # glTF uv origin top-left
    subs = [s[:, ::-1].copy() for s in subs]
    return pos, nrm, uv, subs

def write_glb(path, meshes, extras=None):
    """meshes: list of dict(name, pos, nrm, uv, subs, matname) -> one node per mesh, primitives per submesh."""
    bin_ = bytearray(); views = []; accs = []
    def add(arr, target, comp, typ, minmax=False):
        nonlocal bin_
        while len(bin_) % 4: bin_.append(0)
        b = arr.tobytes(); off = len(bin_); bin_ += b
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(b), **({"target": target} if target else {})})
        a = {"bufferView": len(views) - 1, "componentType": comp, "count": int(arr.shape[0]), "type": typ}
        if minmax: a["min"] = arr.min(0).tolist(); a["max"] = arr.max(0).tolist()
        accs.append(a); return len(accs) - 1
    gm = []; nodes = []; mats = []; matidx = {}
    for m in meshes:
        attrs = {"POSITION": add(m["pos"].astype(np.float32), 34962, 5126, "VEC3", True)}
        if m.get("nrm") is not None and len(m["nrm"]) == len(m["pos"]): attrs["NORMAL"] = add(m["nrm"].astype(np.float32), 34962, 5126, "VEC3")
        if m.get("uv") is not None and len(m["uv"]) == len(m["pos"]): attrs["TEXCOORD_0"] = add(m["uv"].astype(np.float32), 34962, 5126, "VEC2")
        prims = []
        for i, s in enumerate(m["subs"]):
            if not len(s): continue
            mn = m.get("matname", "mat") if i == 0 else f'{m.get("matname","mat")}_{i}'
            if mn not in matidx: matidx[mn] = len(mats); mats.append({"name": mn, "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}})
            prims.append({"attributes": attrs, "indices": add(s.reshape(-1).astype(np.uint32), 34963, 5125, "SCALAR"), "material": matidx[mn]})
        gm.append({"name": m["name"], "primitives": prims})
        nodes.append({"name": m["name"], "mesh": len(gm) - 1})
    g = {"asset": {"version": "2.0", "generator": "rea-testing scene_glb"}, "scene": 0,
         "scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes, "meshes": gm, "materials": mats,
         "accessors": accs, "bufferViews": views, "buffers": [{"byteLength": len(bin_)}]}
    if extras: g["asset"]["extras"] = extras
    js = json.dumps(g, separators=(",", ":")).encode()
    while len(js) % 4: js += b" "
    while len(bin_) % 4: bin_.append(0)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(bin_), 0x004E4942) + bytes(bin_)
    open(path, "wb").write(out)

def unity_pos(p): return [round(p.x, 3), round(p.y, 3), round(-p.z, 3)]
def unity_quat(q): return [round(-q.x, 6), round(-q.y, 6), round(q.z, 6), round(q.w, 6)]
