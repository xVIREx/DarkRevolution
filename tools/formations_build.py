# Extract drone formation layouts from the client's game.txt (<formations>) into
# client/public/assets3d/formations.json, keyed by the server's formation ids (data/items.json).
#
# Formation space (as in the client): +x = behind the ship, y = lateral, z = vertical (3D ones).
# usedPositions maps a drone count to 1-based position ids; rotationGroup tweens spin drones
# around the ship's x axis (e.g. Drill).
import json, os, re, sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(ROOT, 'extracted/xml/game.txt')
out = os.path.join(ROOT, 'client/public/assets3d/formations.json')

text = open(src, encoding='utf-8-sig').read()
block = re.search(r'<formations>.*?</formations>', text, re.S).group(0)
tree = ET.fromstring(block)

# client formation name -> server formation id
ALIASES = {
    'doublearrow': 'double_arrow', 'doublechevron': 'chevron', 'protectionring': 'ring',
    'doublewheel': 'wheel',
}

def key_of(name):
    k = re.sub(r'[^a-z]', '', name.lower().replace(' 3d', ''))
    return ALIASES.get(k, k)

result = {}
for f in tree.findall('formation'):
    d3 = f.find('display3D')
    node = d3 if d3 is not None else f
    pl = node.find('positionsList')
    if pl is None:
        continue
    pos = []
    for part in pl.get('data', '').replace('\n', '').split(';'):
        nums = [float(v) for v in part.split(',') if v.strip()]
        if len(nums) >= 2:
            pos.append([nums[0], nums[1], nums[2] if len(nums) > 2 else 0.0])
    scale = float((node.findtext('scale') or '1').strip())
    used = {}
    for u in node.findall('usedPositions'):
        ids = [int(v) for v in (u.get('positionIDlist') or '').split(',') if v.strip()]
        used[u.get('droneCount')] = ids
    rot = []
    for g in node.findall('rotationGroup'):
        tw = g.find('tween')
        if tw is None:
            continue
        deg = float(tw.get('rotationX') or 0)
        dur = float(tw.get('duration') or 0)
        if deg and dur:
            rot.append({'ids': [int(v) for v in g.get('droneIds', '').split(',') if v.strip()],
                        'degPerSec': deg / dur})
    k = key_of(f.get('name', ''))
    if k in result:
        continue
    result[k] = {'name': f.get('name'), 'pos': pos, 'scale': scale, 'used': used, 'rot': rot}

os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump(result, open(out, 'w'), separators=(',', ':'))
print(len(result), 'formations:', ', '.join(sorted(result)), file=sys.stderr)
