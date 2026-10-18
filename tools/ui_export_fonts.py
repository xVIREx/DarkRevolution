# Export embedded TTF/OTF data of Unity Font objects: ui_export_fonts.py out_dir bundle...
import sys, os, UnityPy
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
for src in sys.argv[2:]:
    env = UnityPy.load(src)
    for o in env.objects:
        if o.type.name != 'Font': continue
        f = o.read()
        data = bytes(f.m_FontData) if f.m_FontData else b''
        if not data: print('no data', f.m_Name); continue
        ext = '.otf' if data[:4] == b'OTTO' else '.ttf'
        open(os.path.join(out, f.m_Name + ext), 'wb').write(data)
        print(f.m_Name, len(data))
