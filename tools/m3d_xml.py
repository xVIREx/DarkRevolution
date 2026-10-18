"""Resolve DarkOrbit lib_*.txt asset XML (templates/reference/replace/append) into flat records.

resolve(file) -> list of dict(id, comment, display2D attrs, mesh attrs (primary 3D mesh), rim)
"""
import os
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import copy, re, xml.etree.ElementTree as ET

XML = REPO + '/extracted/xml'


def _parse(path):
    txt = open(path, encoding='utf-8', errors='replace').read()
    txt = re.sub(r'<\?xml[^>]*\?>', '', txt)
    txt = re.sub(r'&(?!amp;|lt;|gt;|quot;|apos;|#)', '&amp;', txt)
    return ET.fromstring(txt if txt.strip().startswith('<assets') else '<assets>' + txt + '</assets>')


def _select(root, sel):
    """child-combinator path like 'display3D>mesh' or 'this'; returns list of elements"""
    if sel in ('this', ''):
        return [root]
    cur = [root]
    for part in sel.split('>'):
        part = part.strip()
        nxt = []
        for c in cur:
            nxt += [e for e in c if e.tag == part]
        cur = nxt
    return cur


class Lib:
    def __init__(self, *files):
        self.templates, self.shaders, self.assets = {}, {}, []
        for f in files:
            r = _parse(f'{XML}/{f}')
            for e in r:
                if e.tag == 'template':
                    self.templates[e.get('id')] = e
                elif e.tag == 'shader':
                    self.shaders[e.get('id')] = e
                elif e.tag == 'asset':
                    self.assets.append(e)

    def expand(self, el, depth=0):
        """return a deep copy with all <reference selector="template WHERE id==X"> expanded in place"""
        out = ET.Element(el.tag, dict(el.attrib))
        for ch in el:
            if ch.tag == 'reference':
                sel = ch.get('selector', '')
                m = re.match(r'(template|shader)\s+WHERE\s+id\s*==\s*(\S+)', sel)
                if not m:
                    continue
                kind, tid = m.groups()
                if kind == 'shader':
                    sh = self.shaders.get(tid)
                    if sh is not None:
                        for s in sh:
                            out.append(copy.deepcopy(s))
                    continue
                t = self.templates.get(tid)
                if t is None or depth > 20:
                    continue
                inst = self.expand(t, depth + 1)
                for op in ch:
                    self._apply(inst, op)
                for k, v in inst.attrib.items():
                    out.attrib.setdefault(k, v)
                for c in inst:
                    out.append(c)
            else:
                out.append(self.expand(ch, depth + 1))
        return out

    def _apply(self, inst, op):
        sel = op.get('selector', 'this')
        targets = _select(inst, sel)
        if op.tag == 'replace':
            attrs = [a.strip() for a in op.get('attributes', '').split(',')]
            vals = op.get('values', '').split(',')
            if len(vals) < len(attrs):
                vals += [''] * (len(attrs) - len(vals))
            for t in targets:
                for a, v in zip(attrs, vals):
                    t.set(a, v.strip())
        elif op.tag == 'append':
            w = ET.Element('w')
            for c in op:
                w.append(c)
            ex = list(self.expand(w))   # resolves <reference> children (shaders / templates)
            for t in targets:
                for c in ex:
                    t.append(copy.deepcopy(c))
                for k, v in op.attrib.items():
                    if k != 'selector':
                        t.set(k, v)

    def resolve(self):
        recs = []
        for a in self.assets:
            e = self.expand(a)
            d2 = e.find('display2D')
            d3 = e.find('display3D')
            rec = {'id': a.get('id'), 'comment': a.get('comment'),
                   'd2': dict(d2.attrib) if d2 is not None else {}, 'mesh': None, 'rim': None, 'meshes': []}
            if d3 is not None:
                meshes = [m for m in d3.iter('mesh') if m.get('geometry')]
                base = {k: v for k, v in d3.attrib.items()}
                if meshes:
                    for m in meshes:
                        mm = dict(m.attrib)
                        if 'visualSize' not in mm and 'visualSize' in base:
                            mm['visualSize'] = base['visualSize']
                        rim = m.find('.//rimLight')
                        mm['_rim'] = dict(rim.attrib) if rim is not None else None
                        rec['meshes'].append(mm)
                    rec['mesh'] = rec['meshes'][0]
                elif base.get('geometry'):
                    rim = d3.find('.//rimLight')
                    base['_rim'] = dict(rim.attrib) if rim is not None else None
                    rec['mesh'] = base
                    rec['meshes'] = [base]
                rec['d3'] = base
                if rec['mesh']:
                    rec['rim'] = rec['mesh'].pop('_rim', None)
                    if rec['rim'] is None:
                        r = d3.find('.//rimLight')
                        rec['rim'] = dict(r.attrib) if r is not None else None
            recs.append(rec)
        return recs


if __name__ == '__main__':
    import sys, json
    recs = Lib(*(sys.argv[1:] or ['lib_ships.txt'])).resolve()
    print(len(recs), sum(1 for r in recs if r['mesh']))
    for r in recs[:5] + [r for r in recs if r['d2'].get('srcKey') in ('ship84', 'ship_goliath-exalted', 'ship_kristallin_pink')]:
        print(json.dumps({k: r[k] for k in ('id', 'd2', 'mesh', 'rim')}))
