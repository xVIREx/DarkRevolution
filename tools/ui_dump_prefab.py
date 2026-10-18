# Dump a UI prefab hierarchy: RectTransform geometry + Image/Text components (sprite, color, sliced border, text).
# usage: ui_dump_prefab.py bundle PrefabName [PrefabName...]  -> stdout
import sys, UnityPy
env = UnityPy.load(sys.argv[1])
objs = {o.path_id: o for o in env.objects}
want = set(sys.argv[2:])
script_names = {}
def sname(mb):
    pid = mb.get('m_Script', {}).get('m_PathID')
    if pid in script_names: return script_names[pid]
    n = '?'
    if pid in objs:
        try: n = objs[pid].read().m_ClassName
        except Exception: pass
    script_names[pid] = n
    return n
sprite_names = {}
def spr(ref):
    pid = ref.get('m_PathID', 0) if isinstance(ref, dict) else 0
    if not pid: return None
    if pid not in sprite_names:
        o = objs.get(pid)
        try:
            s = o.read_typetree() if o else None
            sprite_names[pid] = (s['m_Name'], tuple(round(s['m_Border'][k]) for k in 'xyzw'), (round(s['m_Rect']['width']), round(s['m_Rect']['height']))) if s else ('ext:%d' % pid,)
        except Exception as e:
            sprite_names[pid] = ('err', str(e)[:50])
    return sprite_names[pid]
def col(c):
    if not isinstance(c, dict): return ''
    return '#%02x%02x%02x%s' % (round(c['r']*255), round(c['g']*255), round(c['b']*255), '' if c['a'] >= 0.999 else '/%.2f' % c['a'])
def v2(v): return '%g,%g' % (v['x'], v['y'])
def walk(tr_obj, depth):
    tr = tr_obj.read_typetree()
    go = objs[tr['m_GameObject']['m_PathID']].read_typetree()
    ind = '  ' * depth
    geo = ''
    if 'm_AnchorMin' in tr:
        geo = f"amin={v2(tr['m_AnchorMin'])} amax={v2(tr['m_AnchorMax'])} pos={v2(tr['m_AnchoredPosition'])} size={v2(tr['m_SizeDelta'])} piv={v2(tr['m_Pivot'])}"
    act = '' if go.get('m_IsActive', 1) else ' [inactive]'
    print(f"{ind}{go['m_Name']}{act} {geo}")
    for c in go['m_Component']:
        cp = c['component']['m_PathID']
        co = objs.get(cp)
        if not co or co.type.name != 'MonoBehaviour': continue
        try: mb = co.read_typetree()
        except Exception as e:
            print(f'{ind}  <mb err>'); continue
        n = sname(mb)
        extra = []
        if 'm_Sprite' in mb:
            s = spr(mb['m_Sprite'])
            extra.append(f"sprite={s} type={mb.get('m_Type')} color={col(mb.get('m_Color'))}")
            if mb.get('m_Type') == 3: extra.append(f"fill={mb.get('m_FillMethod')} amt={mb.get('m_FillAmount')}")
        if 'm_Text' in mb or 'm_text' in mb:
            t = mb.get('m_Text', mb.get('m_text', ''))
            fd = mb.get('m_FontData', {})
            fs = fd.get('m_FontSize', mb.get('m_fontSize'))
            fc = col(mb.get('m_Color', mb.get('m_fontColor')))
            fnt = fd.get('m_Font', mb.get('m_fontAsset', {})).get('m_PathID')
            fname = ''
            if fnt and fnt in objs:
                try: fname = objs[fnt].read().m_Name
                except Exception: pass
            extra.append(f"text={t[:60]!r} size={fs} color={fc} font={fname} align={fd.get('m_Alignment', mb.get('m_textAlignment'))} style={fd.get('m_FontStyle', mb.get('m_fontStyle'))}")
        if 'm_Texture' in mb and 'm_UVRect' in mb:
            extra.append('rawimage')
        if 'm_EffectColor' in mb:
            extra.append(f"effect={col(mb['m_EffectColor'])} dist={v2(mb['m_EffectDistance'])}")
        if n in ('Image', 'Text', 'RawImage', 'Outline', 'Shadow', 'Mask', 'RectMask2D', 'TextMeshProUGUI', 'Button', 'Toggle', 'ScrollRect', 'LayoutElement', 'ContentSizeFitter') or extra:
            print(f"{ind}  - {n} {' '.join(extra)}")
        elif n not in ('?',):
            print(f"{ind}  - {n}")
    for ch in tr['m_Children']:
        walk(objs[ch['m_PathID']], depth + 1)
for o in env.objects:
    if o.type.name == 'RectTransform':
        t = o.read()
        if (not t.m_Father or t.m_Father.path_id == 0):
            n = t.m_GameObject.read().m_Name
            if n in want:
                print('#####', n); walk(o, 0)
