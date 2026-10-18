"""Unity prefab hierarchy -> GLB (geometry only, named nodes, materials named after Unity materials).

Coordinate conversion Unity (left-handed, Y up) -> glTF (right-handed, Y up): negate X.
  position (x,y,z) -> (-x,y,z); normal likewise; quaternion (x,y,z,w) -> (x,-y,-z,w); winding flipped.
  UV v -> 1-v (Unity textures are bottom-up; exported images are top-down).
A wrapper node "m3d_root" rotates the prefab so the ship nose (Unity +Z) points to glTF +X.
"""
import json, math, struct
import numpy as np
from UnityPy.helpers.MeshHelper import MeshHandler

FWD_Q = [0.0, math.sin(math.pi / 4), 0.0, math.cos(math.pi / 4)]  # +90deg about Y: +Z -> +X
STATIC_Q = [0.0, 1.0, 0.0, 0.0]


def comps(go):
    out = []
    for c in go.m_Component:
        p = c.component if hasattr(c, 'component') else c[1]
        try:
            out.append(p.read())
        except Exception:
            pass
    return out


class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.j = {'asset': {'version': '2.0', 'generator': 'm3d_export (DarkOrbit Unity RE)'}, 'scene': 0,
                  'scenes': [{'nodes': [0]}], 'nodes': [], 'meshes': [], 'materials': [], 'accessors': [],
                  'bufferViews': [], 'buffers': []}
        self.mesh_cache, self.mat_cache = {}, {}

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.j['bufferViews'].append(v)
        return len(self.j['bufferViews']) - 1

    def _acc(self, arr, typ, ctype, target, minmax=False):
        bv = self._view(arr.tobytes(), target)
        a = {'bufferView': bv, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
        if minmax:
            a['min'] = [float(x) for x in arr.min(0)]
            a['max'] = [float(x) for x in arr.max(0)]
        self.j['accessors'].append(a)
        return len(self.j['accessors']) - 1

    def material(self, name, extras):
        if name in self.mat_cache:
            return self.mat_cache[name]
        self.j['materials'].append({'name': name, 'pbrMetallicRoughness': {'metallicFactor': 0.0, 'roughnessFactor': 0.6},
                                    'extras': extras})
        self.mat_cache[name] = len(self.j['materials']) - 1
        return self.mat_cache[name]

    def mesh(self, umesh, mat_ids):
        key = (umesh.object_reader.path_id, tuple(mat_ids))
        if key in self.mesh_cache:
            return self.mesh_cache[key]
        h = MeshHandler(umesh)
        h.process()
        if not h.m_Vertices:
            return None, None
        pos = np.asarray(h.m_Vertices, dtype=np.float32); pos = pos.reshape(len(h.m_Vertices), -1)[:, :3].copy()
        pos[:, 0] *= -1
        attrs = {'POSITION': self._acc(pos, 'VEC3', 5126, 34962, True)}
        if h.m_Normals is not None and len(h.m_Normals) == len(pos):
            n = np.asarray(h.m_Normals, dtype=np.float32).reshape(len(pos), -1)[:, :3].copy()
            n[:, 0] *= -1
            ln = np.linalg.norm(n, axis=1, keepdims=True)
            ln[ln == 0] = 1
            attrs['NORMAL'] = self._acc((n / ln).astype(np.float32), 'VEC3', 5126, 34962)
        if h.m_UV0 is not None and len(h.m_UV0) == len(pos):
            uv = np.asarray(h.m_UV0, dtype=np.float32).reshape(len(pos), -1)[:, :2].copy()
            uv[:, 1] = 1 - uv[:, 1]
            attrs['TEXCOORD_0'] = self._acc(uv, 'VEC2', 5126, 34962)
        if h.m_UV1 is not None and len(h.m_UV1) == len(pos):
            uv = np.asarray(h.m_UV1, dtype=np.float32).reshape(len(pos), -1)[:, :2].copy()
            uv[:, 1] = 1 - uv[:, 1]
            attrs['TEXCOORD_1'] = self._acc(uv, 'VEC2', 5126, 34962)
        prims = []
        tris = h.get_triangles()
        ntri = 0
        for i, t in enumerate(tris):
            if not len(t):
                continue
            idx = np.asarray(t, dtype=np.uint32).reshape(-1, 3)[:, [0, 2, 1]]  # flip winding
            ntri += len(idx)
            ctype, arr = (5123, idx.astype(np.uint16)) if len(pos) < 65536 else (5125, idx)
            ia = self._acc(arr.reshape(-1), 'SCALAR', ctype, 34963)
            p = {'attributes': attrs, 'indices': ia, 'mode': 4}
            if mat_ids:
                p['material'] = mat_ids[min(i, len(mat_ids) - 1)]
            prims.append(p)
        self.j['meshes'].append({'name': umesh.m_Name, 'primitives': prims})
        r = (len(self.j['meshes']) - 1, {'verts': len(pos), 'tris': ntri, 'local_pos': pos})
        self.mesh_cache[key] = r
        return r

    def save(self, path):
        self.j['buffers'] = [{'byteLength': len(self.bin)}]
        js = json.dumps(self.j, separators=(',', ':')).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        while len(self.bin) % 4:
            self.bin.append(0)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942) + bytes(self.bin))


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def export_prefab(root_tr, out_path, mat_info, skip_inactive=True, forward=True, static=False):
    """root_tr: Unity Transform of prefab root. mat_info(material)->extras dict.
    Returns info dict: nodes, materials, verts, tris, bounds (glTF space incl. m3d_root rotation)."""
    g = GLB()
    g.j['nodes'].append({'name': 'm3d_root', 'children': []})
    if static:   # props: 180deg about Y -> three.js world orientation (Unity (x,y,z) -> three (x,y,-z), same as scene agent)
        g.j['nodes'][0]['rotation'] = STATIC_Q
    elif forward:
        g.j['nodes'][0]['rotation'] = FWD_Q
    info = {'nodes': [], 'materials': [], 'verts': 0, 'tris': 0, 'skinned': 0, 'inactive': 0, 'meshNodes': []}
    world_pts = []
    R0 = qmat(STATIC_Q) if static else (qmat(FWD_Q) if forward else np.eye(3))

    def walk(tr, parent_idx, M_parent):
        go = tr.m_GameObject.read()
        if skip_inactive and not getattr(go, 'm_IsActive', True):
            info['inactive'] += 1
            return
        p, q, s = tr.m_LocalPosition, tr.m_LocalRotation, tr.m_LocalScale
        node = {'name': go.m_Name}
        T = [-p.x, p.y, p.z]
        Q = [q.x, -q.y, -q.z, q.w]
        S = [s.x, s.y, s.z]
        if any(abs(v) > 1e-7 for v in T):
            node['translation'] = T
        if abs(Q[3] - 1) > 1e-7:
            n = math.sqrt(sum(v * v for v in Q)) or 1
            node['rotation'] = [v / n for v in Q]
        if any(abs(v - 1) > 1e-7 for v in S):
            node['scale'] = S
        # world matrix (4x4) for bounds
        L = np.eye(4)
        L[:3, :3] = qmat(node.get('rotation', [0, 0, 0, 1])) * np.array(S)[None, :]
        L[:3, 3] = T
        M = M_parent @ L
        umesh, mats, skinned = None, [], False
        for c in comps(go):
            tn = c.object_reader.type.name
            if tn == 'MeshFilter' and c.m_Mesh.path_id:
                umesh = c.m_Mesh.read()
            elif tn == 'MeshRenderer':
                if getattr(c, 'm_Enabled', True):
                    mats = [m.read() for m in c.m_Materials if m.path_id]
                else:
                    umesh = None if umesh is None else umesh
                    mats = None
            elif tn == 'SkinnedMeshRenderer' and c.m_Mesh.path_id and getattr(c, 'm_Enabled', True):
                umesh = c.m_Mesh.read()
                mats = [m.read() for m in c.m_Materials if m.path_id]
                skinned = True
        idx = len(g.j['nodes'])
        g.j['nodes'].append(node)
        g.j['nodes'][parent_idx].setdefault('children', []).append(idx)
        info['nodes'].append(go.m_Name)
        if umesh is not None and mats is not None:
            mids = []
            for m in mats:
                ex = mat_info(m)
                mids.append(g.material(m.m_Name, ex))
                if m.m_Name not in [x['name'] for x in info['materials']]:
                    info['materials'].append(dict(name=m.m_Name, **ex))
            mi, st = g.mesh(umesh, mids)
            if mi is not None:
                node['mesh'] = mi
                info['verts'] += st['verts']
                info['tris'] += st['tris']
                info['skinned'] += skinned
                info['meshNodes'].append({'node': go.m_Name, 'mesh': umesh.m_Name, 'materials': [m.m_Name for m in mats],
                                          'verts': st['verts']})
                lp = st['local_pos']
                sub = lp[:: max(1, len(lp) // 4000)]
                world_pts.append((M[:3, :3] @ sub.T).T + M[:3, 3])
        for ch in tr.m_Children:
            walk(ch.read(), idx, M)

    M0 = np.eye(4)
    M0[:3, :3] = R0
    walk(root_tr, 0, M0)
    if world_pts:
        P = np.concatenate(world_pts)
        info['bounds'] = {'min': [round(float(v), 2) for v in P.min(0)], 'max': [round(float(v), 2) for v in P.max(0)]}
    g.save(out_path)
    return info
