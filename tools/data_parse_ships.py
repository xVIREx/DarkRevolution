"""Parse lib_ships.txt -> list of assets with resolved display2D srcKey."""
import os
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import re, json, sys, xml.etree.ElementTree as ET
ROOT = REPO + '/extracted'
def load():
    txt = open(f'{ROOT}/xml/lib_ships.txt', encoding='utf-8', errors='replace').read()
    txt = re.sub(r'<\?xml[^>]*\?>', '', txt)
    root = ET.fromstring(txt)
    templates = {}
    for t in root.iter('template'):
        d = t.find('display2D')
        templates[t.get('id')] = d.get('srcKey') if d is not None else None
    out = []
    for a in root.findall('asset'):
        src = None; tpl = None
        d = a.find('display2D')
        if d is not None: src = d.get('srcKey')
        ref = a.find('reference')
        if ref is not None:
            m = re.search(r'id==(\S+)', ref.get('selector', ''))
            if m:
                tpl = m.group(1); src = templates.get(tpl, src)
            for r in ref.findall('replace'):
                if r.get('selector') == 'display2D':
                    attrs = r.get('attributes').split(','); vals = r.get('values').split(',')
                    if 'srcKey' in attrs: src = vals[attrs.index('srcKey')]
        out.append(dict(id=a.get('id'), comment=a.get('comment'), template=tpl, src=src))
    return out
if __name__ == '__main__':
    sheets = set(json.load(open(f'{ROOT}/sheets/index.json')))
    for a in load():
        print(a['id'], '|', a['comment'], '|', a['template'], '|', a['src'], '|', 'OK' if a['src'] in sheets else 'MISSING')
