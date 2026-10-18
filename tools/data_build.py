"""Build data/*.json (ships, npcs, maps, lasers) from the extracted client XML plus
well-known DarkOrbit values, then merge research/*.json on top (research overrides
stat guesses; sheet mapping always comes from the client).

Run: .venv/bin/python -I tools/data_build.py
"""
import os
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import json, os, re, sys
import xml.etree.ElementTree as ET

BASE = REPO
XML = f'{BASE}/extracted/xml'
OUT = f'{BASE}/data'
RESEARCH = f'{BASE}/research'
SHEETS = set(json.load(open(f'{BASE}/extracted/sheets/index.json')))


def parse_xml(path):
    txt = open(path, encoding='utf-8-sig', errors='replace').read()
    txt = re.sub(r'<\?xml[^>]*\?>', '', txt).strip()
    return ET.fromstring(txt)


# ----------------------------------------------------------------------------- lib_ships
def load_lib_ships():
    root = parse_xml(f'{XML}/lib_ships.txt')
    templates = {}
    for t in root.iter('template'):
        d = t.find('display2D')
        templates[t.get('id')] = d.get('srcKey') if d is not None else None
    assets = {}
    order = []
    for a in root.findall('asset'):
        src = None
        tpl = None
        d = a.find('display2D')
        if d is not None:
            src = d.get('srcKey')
        ref = a.find('reference')
        if ref is not None:
            m = re.search(r'id==(\S+)', ref.get('selector', ''))
            if m:
                tpl = m.group(1)
                src = templates.get(tpl, src)
            for r in ref.findall('replace'):
                if r.get('selector') == 'display2D':
                    attrs = r.get('attributes').split(',')
                    vals = r.get('values').split(',')
                    if 'srcKey' in attrs:
                        src = vals[attrs.index('srcKey')]
        aid = a.get('id')
        if aid not in assets:
            order.append(aid)
        assets[aid] = dict(id=aid, comment=a.get('comment'), template=tpl, src=src)
    return assets, order


# ----------------------------------------------------------------------------- ships
# (hp, speed, lasers, generators, extras, cargo, guess)
B = {
    'phoenix':   (4000, 320, 1, 1, 1, 100, False),
    'yamato':    (8000, 340, 2, 2, 1, 200, False),
    'leonov':    (64000, 360, 6, 6, 1, 500, False),
    'defcom':    (12000, 340, 3, 5, 2, 300, False),
    'liberator': (16000, 330, 4, 6, 2, 400, False),
    'piranha':   (64000, 360, 6, 8, 2, 600, False),
    'nostromo':  (120000, 340, 7, 10, 2, 700, False),
    'vengeance': (180000, 380, 10, 10, 2, 1000, False),
    'bigboy':    (160000, 260, 8, 15, 3, 700, False),
    'goliath':   (256000, 300, 15, 15, 3, 1500, False),
    'skill':     (256000, 300, 15, 16, 3, 1500, False),   # solace/spectrum/sentinel/venom/diminisher
    'aegis':     (275000, 300, 10, 15, 3, 1500, False),
    'citadel':   (470000, 240, 7, 20, 4, 2000, False),
    'spearhead': (100000, 370, 5, 12, 3, 750, False),
    'pusat':     (150000, 370, 12, 12, 2, 1000, True),
    'goliath-x': (256000, 300, 15, 16, 3, 1500, True),
    'cyborg':    (256000, 300, 15, 16, 3, 1500, True),
    'hammerclaw': (300000, 300, 15, 16, 3, 1500, True),
    'tartarus':  (256000, 310, 15, 16, 3, 1500, True),
    'mimesis':   (256000, 310, 15, 16, 3, 1500, True),
    'centurion': (300000, 280, 15, 16, 3, 1500, True),
    'hecate':    (225000, 340, 14, 15, 3, 1500, True),
    'disruptor': (250000, 300, 15, 16, 3, 1500, True),
    'berserker': (275000, 300, 15, 16, 3, 1500, True),
    'zephyr':    (240000, 340, 14, 16, 3, 1500, True),
    'solaris':   (220000, 340, 14, 16, 3, 1500, True),
    'keres':     (240000, 320, 15, 16, 3, 1500, True),
    'retiarus':  (256000, 300, 15, 16, 3, 1500, True),
    'orcus':     (275000, 300, 15, 16, 3, 1500, True),
    'tempest':   (256000, 320, 15, 16, 3, 1500, True),
    'basilisk':  (256000, 300, 15, 16, 3, 1500, True),
    'holo':      (256000, 300, 15, 16, 3, 1500, True),
    'police':    (1000000, 600, 20, 20, 5, 5000, True),
    'admin':     (1000000, 600, 20, 20, 5, 5000, True),
}
PLUS = {  # "plus" upgrades: +1 laser +1 gen +10% hp (guess)
    'goliath-plus': 'goliath', 'citadel-plus': 'citadel', 'liberator-plus': 'liberator',
    'solace-plus': 'skill', 'solaris-plus': 'solaris', 'pusat-plus': 'pusat',
    'hecate-plus': 'hecate', 'hammerclaw-plus': 'hammerclaw', 'spearhead-plus': 'spearhead',
    'tartarus-plus': 'tartarus', 'spectrum-plus': 'skill',
}


def stat_key(short):
    """Map a ship id (without 'ship_') to a stats bucket."""
    if short in PLUS:
        return None
    if short in B:
        return short
    if short in ('solace', 'spectrum', 'sentinel', 'venom', 'diminisher'):
        return 'skill'
    if short.startswith('g-') or short == 'goliath':
        return 'goliath'
    if short.startswith('v-'):
        return 'vengeance'
    if short.startswith('n-'):
        return 'nostromo'
    if short.startswith('bb-'):
        return 'bigboy'
    if short.startswith('a-'):
        return 'aegis'
    if short.startswith('c-'):
        return 'citadel'
    if short.startswith('s-'):
        return 'spearhead'
    if short == 'yamato-ronin':
        return 'yamato'
    if short == 'defcom-raven':
        return 'defcom'
    return None


NAME_FIX = {
    'ship_n-ambassador': 'Nostromo Ambassador', 'ship_n-diplomat': 'Nostromo Diplomat',
    'ship_n-envoy': 'Nostromo Envoy', 'ship_v-lightning': 'Vengeance Lightning',
    'ship_sentinel': 'Sentinel', 'ship_spectrum': 'Spectrum', 'ship_diminisher': 'Diminisher',
    'ship_solace': 'Solace', 'ship_pusat': 'Pusat', 'ship_tartarus': 'Tartarus',
    'ship_mimesis': 'Mimesis', 'ship_zephyr': 'Zephyr', 'ship_solaris': 'Solaris',
    'ship_keres': 'Keres', 'ship_admin': 'UFO (Admin)', 'ship_police': 'Police',
    'ship_g-surgeon': 'Goliath Surgeon', 'ship_g-vanquisher': 'Goliath Vanquisher',
    'ship_g-sovereign': 'Goliath Sovereign', 'ship_g-peacemaker': 'Goliath Peacemaker',
    'ship_g-enforcer': 'Goliath Enforcer', 'ship_bb-solemn': 'Bigboy Solemn',
    'ship_a-elite': 'Aegis Elite', 'ship_c-elite': 'Citadel Super Elite',
    'ship_goliath-x': 'Goliath X',
}


def title(s):
    return ' '.join(w[:1].upper() + w[1:] for w in s.replace('_', ' ').replace('-', ' ').split())


def build_ships(assets, order):
    hangar = re.findall(r'<lootId>\s*([^<\s]+)\s*</lootId>', open(f'{XML}/Hangarships.txt').read())
    base_ids = list(dict.fromkeys(hangar))
    # lib_ships base ships not in the hangar (no _design_, no faction suffix _1/_2/_3)
    for aid in order:
        if aid.startswith('ship_') and '_design_' not in aid and not re.search(r'_\d$', aid) \
                and aid not in base_ids and aid != 'ship_g-admincloak':
            base_ids.append(aid)
    ships = []
    for sid in base_ids:
        a = assets.get(sid)
        if not a or a['src'] not in SHEETS:
            print('skip ship (no sheet):', sid, a and a['src'], file=sys.stderr)
            continue
        short = sid[5:]
        guess = False
        if short in PLUS:
            hp, sp, la, ge, ex, ca, _ = B[PLUS[short]]
            hp, la, ge, guess = int(hp * 1.1), la + 1, ge + 1, True
        else:
            k = stat_key(short)
            if k is None:
                print('no stats for', sid, '-> goliath guess', file=sys.stderr)
                k = 'goliath'
                guess = True
            hp, sp, la, ge, ex, ca, g = B[k]
            guess = guess or g
        name = NAME_FIX.get(sid) or a['comment'] or title(short)
        designs = []
        seen = {a['src']}
        for did in order:
            if did.startswith(sid + '_design_') or re.fullmatch(re.escape(sid) + r'_\d', did):
                d = assets[did]
                if d['src'] in SHEETS and d['src'] not in seen:
                    seen.add(d['src'])
                    designs.append(dict(id=d['src'], asset=did, name=d['comment'] or title(d['src'][5:]),
                                        sheet=d['src']))
        e = dict(id=sid, name=name, hp=hp, speed=sp, lasers=la, generators=ge, extras=ex, cargo=ca,
                 sheet=a['src'], designs=designs)
        if guess:
            e['guess'] = True
        ships.append(e)
    return ships


# ----------------------------------------------------------------------------- npcs
# key: (lib_ships asset id, display name, server npc ids, hp, shield, damage, speed, aggressive,
#       exp, honor, credits, uridium, guess)
NPC_BASE = [
    ('streuner',   '84',  '-=[ Streuner ]=-',   [1],   800,    400,    20,   280, False, 400,   2,   400,    1,  False),
    ('lordakia',   '71',  '-=[ Lordakia ]=-',   [2],   2000,   2000,   80,   320, True,  800,   4,   800,    2,  False),
    ('devolarium', '72',  '-=[ Devolarium ]=-', [3],   100000, 100000, 1200, 200, True,  6400,  32,  204800, 32, False),
    ('mordon',     '73',  '-=[ Mordon ]=-',     [4],   20000,  10000,  350,  125, False, 3200,  16,  6400,   8,  False),
    ('sibelon',    '74',  '-=[ Sibelon ]=-',    [5],   200000, 200000, 2000, 100, False, 12800, 64,  409600, 64, False),
    ('saimon',     '75',  '-=[ Saimon ]=-',     [6],   6000,   3000,   200,  320, True,  1600,  8,   1600,   4,  False),
    ('sibelonit',  '76',  '-=[ Sibelonit ]=-',  [7],   40000,  40000,  1000, 320, True,  3200,  16,  12800,  16, False),
    ('lordakium',  '77',  '-=[ Lordakium ]=-',  [8],   300000, 200000, 3500, 230, False, 25600, 128, 819200, 128, False),
    ('kristallin', '78',  '-=[ Kristallin ]=-', [9],   50000,  40000,  1200, 320, True,  6400,  32,  12800,  16, False),
    ('kristallon', '79',  '-=[ Kristallon ]=-', [10],  400000, 300000, 5000, 250, False, 51200, 256, 409600, 256, False),
    ('streuner_r', '85',  '-=[ StreuneR ]=-',   [11],  20000,  10000,  500,  220, True,  4000,  20,  6000,   10, True),
    ('cubikon',    '80',  '-=[ Cubikon ]=-',    [13],  1600000, 1200000, 0,  30,  False, 512000, 4096, 1600000, 1024, False),
    ('protegit',   '81',  '-=[ Protegit ]=-',   [12],  50000,  40000,  1000, 450, True,  6400,  16,  12800,  16, False),
    ('kucurbium',  '82',  '-=[ Kucurbium ]=-',  [],    1000000, 500000, 6000, 200, False, 100000, 500, 1000000, 500, True),
    ('interceptor', '111', '-=[ Interceptor ]=-', [58], 60000,  40000,  500,  380, True,  6000,  30,  40000,  30, True),
    ('barracuda',  '112', '-=[ Barracuda ]=-',  [59],  180000, 100000, 2000, 300, True,  20000, 100, 150000, 80, True),
    ('saboteur',   '113', '-=[ Saboteur ]=-',   [60],  200000, 150000, 2500, 350, True,  25000, 125, 200000, 100, True),
    ('annihilator', '114', '-=[ Annihilator ]=-', [61], 300000, 200000, 4000, 250, True,  40000, 200, 300000, 150, True),
    ('battleray',  '115', '-=[ Battleray ]=-',  [62],  500000, 400000, 5000, 200, True,  64000, 320, 500000, 250, True),
    ('deadly_battleray', '115', '-=[ Deadly Battleray ]=-', [121], 1000000, 800000, 8000, 220, True, 128000, 640, 1000000, 500, True),
    ('plagued_kristallin', '252', '-=[ Plagued Kristallin ]=-', [161], 60000, 50000, 1500, 320, True, 8000, 40, 16000, 20, True),
]
# boss / uber variants: (key suffix, base key, lib asset, server id, name)
BOSS = [
    ('streuner', '23', 14, 28), ('lordakia', '24', 15, 29), ('mordon', '31', 16, 30),
    ('saimon', '25', 17, 31), ('devolarium', '26', 18, 32), ('sibelonit', '27', 19, 33),
    ('sibelon', '46', 20, 34), ('lordakium', '28', 21, 35), ('kristallin', '29', 22, 36),
    ('kristallon', '35', 23, 37), ('streuner_r', '34', 24, 38),
]
UBER_ASSET = {'streuner': '36', 'lordakia': '37', 'saimon': '38', 'devolarium': '39', 'sibelonit': '40',
              'mordon': '43', 'streuner_r': '44', 'sibelon': '47', 'lordakium': '41', 'kristallin': '42',
              'kristallon': '45'}
PIRATE_UBER = [('interceptor', '257', 163), ('barracuda', '255', 164), ('saboteur', '258', 165),
               ('annihilator', '254', 166), ('battleray', '256', 167)]


def pretty(key):
    return {'streuner_r': 'StreuneR'}.get(key, key.capitalize())


def build_npcs(assets):
    npcs = []
    base = {}

    def add(key, asset, name, sids, hp, sh, dmg, sp, agg, exp, hon, cr, uri, guess):
        sheet = assets[asset]['src']
        e = dict(id=key, name=name, sheet=sheet, hp=hp, shield=sh, damage=dmg, speed=sp, aggressive=agg,
                 exp=exp, honor=hon, credits=cr, uridium=uri, serverIds=sids, libId=asset)
        if guess:
            e['guess'] = True
        npcs.append(e)
        return e

    for row in NPC_BASE:
        e = add(*row)
        base[row[0]] = e
    for key, asset, sid, uber_sid in BOSS:
        b = base[key]
        add('boss_' + key, asset, f'..::{{ Boss {pretty(key)} }}::..', [sid], b['hp'] * 4, b['shield'] * 4,
            b['damage'] * 4, b['speed'], b['aggressive'], b['exp'] * 4, b['honor'] * 4, b['credits'] * 4,
            b['uridium'] * 4, True)
        add('uber_' + key, UBER_ASSET[key], f'( Uber{pretty(key)} )', [uber_sid], b['hp'] * 16,
            b['shield'] * 16, b['damage'] * 8, b['speed'], True, b['exp'] * 16, b['honor'] * 16,
            b['credits'] * 16, b['uridium'] * 16, True)
    for key, asset, sid in PIRATE_UBER:
        b = base[key]
        add('uber_' + key, asset, f'( Uber {pretty(key)} )', [sid], b['hp'] * 4, b['shield'] * 4,
            b['damage'] * 3, b['speed'], True, b['exp'] * 4, b['honor'] * 4, b['credits'] * 4,
            b['uridium'] * 4, True)
    return npcs


# ----------------------------------------------------------------------------- maps
FACTION = {'1': 'mmo', '2': 'eic', '3': 'vru', '4': 'none', '5': 'none'}
# classic station spots (world units)
STATIONS = {
    '1-1': [('mmo', 2000, 2000)], '2-1': [('eic', 19000, 2000)], '3-1': [('vru', 19000, 11100)],
    '1-8': [('mmo', 10500, 6550)], '2-8': [('eic', 10500, 6550)], '3-8': [('vru', 10500, 6550)],
    '4-1': [('mmo', 3000, 11000)], '4-2': [('eic', 2500, 2500)], '4-3': [('vru', 18500, 11000)],
    '4-4': [('mmo', 3500, 13100), ('eic', 33000, 5000), ('vru', 33000, 21200)],
}
# NPC spawn counts by npc key (server id -> key resolved from npcs) per map tier
COUNT = {
    'streuner': 30, 'lordakia': 25, 'mordon': 15, 'saimon': 20, 'devolarium': 8, 'sibelon': 6,
    'sibelonit': 15, 'lordakium': 6, 'kristallin': 25, 'kristallon': 6, 'streuner_r': 25,
    'cubikon': 3, 'protegit': 0, 'interceptor': 20, 'barracuda': 10, 'saboteur': 10,
    'annihilator': 6, 'battleray': 3, 'deadly_battleray': 2, 'plagued_kristallin': 6,
}
WANTED = list(range(1, 30)) + [91, 92, 93]


def build_maps(npcs):
    mc = parse_xml(f'{XML}/maps-config.txt')
    smt = open(f'{XML}/spacemap-config.txt', encoding='utf-8-sig').read()
    sm = ET.fromstring(smt[smt.index('<spacemap'):])

    npc_by_sid = {}
    for n in npcs:
        for s in n.get('serverIds', []):
            npc_by_sid[s] = n['id']
    spawns = {}
    for m in sm.find('npcs').findall('map'):
        spawns[int(m.get('ref'))] = [int(n.get('id')) for n in m.findall('npc')]

    gates = {}
    for j in sm.iter('jumpgate'):
        p = j.find('position')
        gates.setdefault(int(j.get('ref')), []).append(dict(
            key=int(j.get('key')), tx=float(p.get('x')), ty=float(p.get('y')),
            to=int(j.findtext('leadsToMap')), faction=j.findtext('faction')))

    maps = {}
    for m in mc.findall('map'):
        mid = int(m.get('id'))
        if mid not in WANTED:
            continue
        name = m.get('name')
        scale = float(m.get('scaleFactor') or 1)
        w, h = int(21000 * scale), int(13100 * scale)
        info = m.find('spacemapInfo')
        bg_main = None
        region = None
        bgs = []
        for b in m.iter('background'):
            bgs.append({k: b.get(k) for k in ('typeID', 'pFactor', 'layer', 'scale', 'maskID') if b.get(k)})
            if b.get('isMain') == 'true':
                bg_main = b.get('typeID')
                region = b.get('region')
        planets = [dict(type=p.get('typeID'), x=int(float(p.get('x'))), y=int(float(p.get('y'))),
                        p=int(float(p.get('pFactor') or 10)), layer=int(p.get('layer') or 0))
                   for p in m.iter('planet')]
        lens = [dict(id=l.get('id'), x=int(float(l.get('x'))), y=int(float(l.get('y'))),
                     p=int(float(l.get('pFactor') or 10)), star=l.get('star') == 'true')
                for l in m.iter('lensflare')]
        maps[mid] = dict(id=mid, name=name, faction=FACTION.get(name[0], 'none'), w=w, h=h,
                         background=bg_main, region=region, backgrounds=bgs, planets=planets,
                         lensflares=lens, type=info.get('type') if info is not None else None,
                         home=info.get('home') if info is not None and info.get('home') else None,
                         minimap=m.get('minimap') or str(mid), music=m.get('music'),
                         portals=[], stations=[], npcs=[])

    def world(mid, g):
        mp = maps[mid]
        return int(round(g['tx'] / 315 * mp['w'])), int(round(g['ty'] / 210 * mp['h']))

    for mid, mp in maps.items():
        for g in gates.get(mid, []):
            if g['to'] not in maps:
                continue
            x, y = world(mid, g)
            back = [b for b in gates.get(g['to'], []) if b['to'] == mid]
            if back:
                same = [b for b in back if b['faction'] == g['faction']] or back
                bx, by = world(g['to'], same[0])
            else:
                # one-way gate: arrive at the dest gate nearest to its map center? use center
                dm = maps[g['to']]
                bx, by = dm['w'] // 2, dm['h'] // 2
            mp['portals'].append(dict(id=g['key'], x=x, y=y, to=g['to'], tx=bx, ty=by,
                                      faction=g['faction'], oneWay=not back))
        for f, x, y in STATIONS.get(mp['name'], []):
            mp['stations'].append(dict(faction=f, x=x, y=y))
        seen = []
        for sid in spawns.get(mid, []):
            k = npc_by_sid.get(sid)
            if k and k not in seen:
                seen.append(k)
        # 4-1..4-4: client lists only Deadly Battleray; add the classic mixed set
        if mp['name'] in ('4-1', '4-2', '4-3', '4-4'):
            seen += ['kristallin', 'sibelonit', 'lordakium', 'kristallon', 'sibelon']
        for k in seen:
            if k.startswith('uber_'):
                c = 2 if mp['name'] == '4-5' else 4
            elif k.startswith('boss_'):
                c = 3 if mp['name'] == '4-5' else 4
            else:
                c = COUNT.get(k, 5)
                if mp['name'].startswith('4-'):
                    c = max(2, c // 2)
            if c:
                mp['npcs'].append(dict(id=k, count=c))
    return [maps[i] for i in WANTED if i in maps]


# ----------------------------------------------------------------------------- lasers
LASERS = {
    'ammo': [
        dict(id='x1', name='LCB-10', mult=1, color='red'),
        dict(id='x2', name='MCB-25', mult=2, color='blue'),
        dict(id='x3', name='MCB-50', mult=3, color='green'),
        dict(id='x4', name='UCB-100', mult=4, color='white'),
        dict(id='sab', name='SAB-50', mult=2, color='sab', shieldDrain=True),
        dict(id='rsb', name='RSB-75', mult=6, color='rsb', cooldown=3),
    ],
    'laserDamage': 175,
    'rockets': [
        dict(id='r310', name='R-310', damage=1000),
        dict(id='plt2026', name='PLT-2026', damage=2000),
        dict(id='plt2021', name='PLT-2021', damage=4000),
    ],
}


# ----------------------------------------------------------------------------- research merge
# research/*.json (wiki + emulator dumps) overrides guesses; sheets always stay client-derived.
SKIP_KEYS = {'by_source', 'aggressive_votes', 'field_source', 'source', 'id', 'sheet', 'designs',
             'npcs_alt', 'aliens_wiki', 'jump_gates_wiki', 'spawn_spots_wiki', 'kalaazu_id'}
NPC_ALIAS = {'streuner_r_upper': 'streuner_r', 'boss_streuner_r_upper': 'boss_streuner_r',
             'uber_streuner_r_upper': 'uber_streuner_r', 'blighted_kristallon': 'blighted_kristallon'}
SHIP_ALIAS = {'ship_ronin': 'ship_yamato-ronin', 'ship_raven': 'ship_defcom-raven',
              'ship_centurion-ship': 'ship_centurion'}
# research NPCs without a gfx id -> client lib_ships asset holding their sheet
NPC_LIB = {'streuner_soldier': '150,152', 'streuner_specialist': '149,153', 'emperor_streuner': '147',
           'blighted_kristallon': '251'}
STAT_FIELDS = ('hp', 'speed', 'lasers', 'generators', 'extras', 'cargo')


def load_research(name):
    p = f'{RESEARCH}/{name}.json'
    if not os.path.exists(p):
        return None
    return json.load(open(p))


def copy_fields(dst, src):
    for k, v in src.items():
        if k in SKIP_KEYS or v is None:
            continue
        dst[k] = v


def merge_ships(ships):
    res = load_research('ships')
    if not res:
        return 0
    by_id = {s['id']: s for s in ships}
    n = 0
    for r in res:
        sid = SHIP_ALIAS.get(r['id'], r['id'])
        s = by_id.get(sid)
        if s is None:
            print('research ship not in client:', r['id'], file=sys.stderr)
            continue
        modern = 'hp_is' in r  # modern ships: research hp is the current-wiki value
        for k in STAT_FIELDS:
            if r.get(k) is not None:
                s[k] = r[k]
        if modern and r.get('hp'):
            s['hp_current_wiki'] = r['hp']
            s['hp'] = r['hp'] - 100000   # classic ~= current wiki - 100k (research NOTES)
            s['hp_derived'] = 'current wiki - 100000'
        for k in ('hp_current_wiki', 'boosts', 'abilities', 'do_type_id', 'exp_reward', 'honor_reward'):
            if r.get(k) is not None and not (modern and k == 'hp_current_wiki'):
                s[k] = r[k]
        # design boosts, matched by sheet
        rd = {d.get('sheet'): d for d in r.get('designs') or [] if d.get('sheet')}
        for d in s['designs']:
            m = rd.get(d['sheet'])
            if m:
                for k in ('boosts', 'abilities'):
                    if m.get(k):
                        d[k] = m[k]
        s.pop('guess', None)
        s['source'] = 'research'
        n += 1
    # variants (g-*, v-*, a-*, ...) inherit researched base stats
    for s in ships:
        if s.get('source') == 'research':
            continue
        k = stat_key(s['id'][5:])
        base = by_id.get('ship_' + k) if k else None
        if base is not None and base is not s and base.get('source') == 'research':
            for f in STAT_FIELDS:
                s[f] = base[f]
            s.pop('guess', None)
            s['source'] = 'research(base ' + base['id'] + ')'
    return n


def merge_npcs(npcs, assets):
    res = load_research('npcs')
    if not res:
        return 0, 0
    by_id = {n['id']: n for n in npcs}
    merged = added = 0
    for r in res:
        nid = NPC_ALIAS.get(r['id'], r['id'])
        e = by_id.get(nid)
        if e is None:
            sheet = r.get('sheet')
            if r['id'] in NPC_LIB:
                sheet = assets[NPC_LIB[r['id']]]['src']
            if sheet not in SHEETS:
                print('research npc without sheet, skipped:', r['id'], file=sys.stderr)
                continue
            e = dict(id=nid, name=r.get('name') or nid, sheet=sheet, hp=1000, shield=0, damage=0, speed=250,
                     aggressive=False, exp=0, honor=0, credits=0, uridium=0)
            npcs.append(e)
            by_id[nid] = e
            added += 1
        else:
            merged += 1
        copy_fields(e, r)
        for k, dflt in (('hp', 1000), ('shield', 0), ('damage', 0), ('speed', 250), ('exp', 0),
                        ('honor', 0), ('credits', 0), ('uridium', 0), ('aggressive', False)):
            if e.get(k) is None:
                e[k] = dflt
        e.pop('guess', None)
        e['source'] = 'research'
    return merged, added


def merge_maps(maps, npcs):
    res = load_research('maps')
    if not res:
        return 0
    rby = {r['id']: r for r in res}
    ids = {m['id'] for m in maps}
    npc_ids = {n['id'] for n in npcs}
    n = 0
    for m in maps:
        r = rby.get(m['id'])
        if r is None:
            continue
        ow, oh = m['w'], m['h']
        if r.get('w') and r.get('h'):
            m['w'], m['h'] = r['w'], r['h']
        sx, sy = m['w'] / ow, m['h'] / oh
        if r.get('portals'):
            m['portals'] = [dict(id=p['id'], x=p['x'], y=p['y'], to=p['to'], tx=p['tx'], ty=p['ty'])
                            for p in r['portals'] if p['to'] in ids]
        else:
            for p in m['portals']:
                p['x'], p['y'] = round(p['x'] * sx), round(p['y'] * sy)
        if r.get('stations'):
            m['stations'] = [dict(faction=s['faction'], x=s['x'], y=s['y']) for s in r['stations']]
        else:
            for s in m['stations']:
                s['x'], s['y'] = round(s['x'] * sx), round(s['y'] * sy)
        if r.get('npcs'):
            spawn = {}
            for sp in r['npcs']:
                k = NPC_ALIAS.get(sp['id'], sp['id'])
                if k not in npc_ids:
                    print(f'map {m["name"]}: unmapped npc {sp["id"]} dropped', file=sys.stderr)
                    continue
                spawn[k] = max(spawn.get(k, 0), sp['count'])
            m['npcs'] = [dict(id=k, count=c) for k, c in spawn.items()]
            m['npcSource'] = 'research'
        else:
            m['npcSource'] = 'client-list+guessed-counts'
        for k in ('pvp', 'starter'):
            if k in r:
                m[k] = r[k]
        m['source'] = 'research'
        n += 1
    # arrival points must be consistent after the merge: tx/ty = paired return gate
    by = {m['id']: m for m in maps}
    for m in maps:
        for p in m['portals']:
            back = [q for q in by[p['to']]['portals'] if q['to'] == m['id']]
            if back and not any((q['x'], q['y']) == (p['tx'], p['ty']) for q in back):
                print(f'portal {m["name"]}->{p["to"]}: arrival not on a return gate', file=sys.stderr)
    return n


def merge_lasers(lasers):
    eq = load_research('equipment')
    if not eq:
        return
    def strip(x):
        if isinstance(x, list):
            return [strip(i) for i in x]
        if isinstance(x, dict):
            return {k: strip(v) for k, v in x.items() if k != 'source'}
        return x
    eq = strip(eq)
    lasers['laserDamage'] = 200   # LF-4 classic
    rmap = {a['id']: a for a in eq.get('ammo', [])}
    for a in lasers['ammo']:
        for k, v in rmap.get(a['id'], {}).items():
            if k not in ('id', 'name', 'mult', 'color'):
                a[k] = v
    have = {r['id'] for r in lasers['rockets']}
    rr = {r['id']: r for r in eq.get('rockets', [])}
    for r in lasers['rockets']:
        r.update({k: v for k, v in rr.get(r['id'], {}).items() if k != 'id'})
    lasers['rockets'] += [r for i, r in rr.items() if i not in have]
    for k in ('lasers', 'laserRange', 'rocketCooldownMs', 'shieldGenerators', 'speedGenerators', 'shieldRegen'):
        if k in eq:
            lasers['laserTypes' if k == 'lasers' else k] = eq[k]


# ----------------------------------------------------------------------------- main
def main():
    assets, order = load_lib_ships()
    ships = build_ships(assets, order)
    npcs = build_npcs(assets)
    maps = build_maps(npcs)
    lasers = json.loads(json.dumps(LASERS))
    ms = merge_ships(ships)
    mn, an = merge_npcs(npcs, assets)
    mm = merge_maps(maps, npcs)
    merge_lasers(lasers)

    # validation
    bad = [sh for s in ships for sh in [s['sheet']] + [d['sheet'] for d in s['designs']] if sh not in SHEETS]
    bad += [n['sheet'] for n in npcs if n['sheet'] not in SHEETS]
    assert not bad, bad
    assert len({n['id'] for n in npcs}) == len(npcs), 'duplicate npc id'
    npc_ids = {n['id'] for n in npcs}
    map_ids = {m['id'] for m in maps}
    for m in maps:
        for p in m['portals']:
            assert p['to'] in map_ids, (m['name'], p)
            assert 0 <= p['x'] <= m['w'] and 0 <= p['y'] <= m['h'], (m['name'], p)
        for st in m['stations']:
            assert 0 <= st['x'] <= m['w'] and 0 <= st['y'] <= m['h'], (m['name'], st)
        for sp in m['npcs']:
            assert sp['id'] in npc_ids, (m['name'], sp)

    os.makedirs(OUT, exist_ok=True)
    for fn, obj in (('ships', ships), ('npcs', npcs), ('maps', maps), ('lasers', lasers)):
        with open(f'{OUT}/{fn}.json', 'w') as f:
            json.dump(obj, f, indent=1, ensure_ascii=False)
        json.load(open(f'{OUT}/{fn}.json'))

    def cnt(lst):
        r = sum(1 for x in lst if str(x.get('source', '')).startswith('research'))
        g = sum(1 for x in lst if x.get('guess'))
        return f'{len(lst)} (research {r}, guess {g}, other {len(lst) - r - g})'
    print(f'ships={cnt(ships)} designs={sum(len(s["designs"]) for s in ships)}')
    print(f'npcs={cnt(npcs)} [merged {mn}, added from research {an}]')
    print(f'maps={cnt(maps)} portals={sum(len(m["portals"]) for m in maps)} '
          f'research-spawns={sum(1 for m in maps if m.get("npcSource") == "research")}')
    print(f'lasers: laserDamage={lasers["laserDamage"]} rockets={len(lasers["rockets"])} keys={list(lasers)}')


if __name__ == '__main__':
    main()
