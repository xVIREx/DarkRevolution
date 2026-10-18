"""Dump a prefab hierarchy (by container substring) with component details.
usage: scene_dump_prefab.py <bundle> <container-substring> [maxdepth] [--full]"""
import sys, UnityPy, json
B=sys.argv[1]; key=sys.argv[2]; maxdepth=int(sys.argv[3]) if len(sys.argv)>3 and sys.argv[3].isdigit() else 99
FULL='--full' in sys.argv
env=UnityPy.load(B)
SKIP={'m_GameObject','m_Script','m_CorrespondingSourceObject','m_PrefabInstance','m_PrefabAsset'}
def short(v,n=600):
    s=json.dumps(v,default=str); return s if len(s)<n or FULL else s[:n]+'…'
def mat_info(mp):
    try:
        m=mp.read()
    except Exception: return '?'
    tex={}
    for k,v in m.m_SavedProperties.m_TexEnvs:
        if v.m_Texture.path_id:
            try: tex[k]=v.m_Texture.read().m_Name
            except Exception: tex[k]='ext'
    sh='?'
    try: sh=m.m_Shader.read().m_Name
    except Exception: pass
    cols={k:(round(c.r,3),round(c.g,3),round(c.b,3),round(c.a,3)) for k,c in m.m_SavedProperties.m_Colors}
    fl={k:round(f,3) for k,f in m.m_SavedProperties.m_Floats}
    return f"{m.m_Name}{{sh={sh} tex={tex} col={cols} f={short(fl,300)}}}"
def comps(go,d):
    for c in go.m_Components:
        ptr=c.component if hasattr(c,'component') else c
        try: co=ptr.read()
        except Exception as e: print('  '*d+'   ? '+str(e)); continue
        t=co.object_reader.type.name
        if t=='Transform': continue
        line=t
        if t=='MeshFilter':
            try: line+=' mesh=%s'%co.m_Mesh.read().m_Name
            except Exception: line+=' mesh=<builtin/ext>'
        elif t in('MeshRenderer','ParticleSystemRenderer','SpriteRenderer','TrailRenderer','LineRenderer'):
            line+=' mats=['+'; '.join(mat_info(m) for m in co.m_Materials)+']'
            if t=='SpriteRenderer':
                try: line+=' sprite=%s'%co.m_Sprite.read().m_Name
                except Exception: pass
                try: line+=' color=%s'%short(co.object_reader.read_typetree().get('m_Color'))
                except Exception: pass
            if t in('TrailRenderer','LineRenderer'):
                tt=co.object_reader.read_typetree(); tt.pop('m_Materials',None)
                line+=' '+short({k:v for k,v in tt.items() if k not in SKIP},1500)
        elif t=='MonoBehaviour':
            try:
                tt=co.object_reader.read_typetree()
                line+='<%s> %s'%(co.m_Script.read().m_ClassName, short({k:v for k,v in tt.items() if k not in SKIP},1500))
            except Exception as e: line+=' err '+str(e)
        elif t in('ParticleSystem',) and FULL:
            line+=' '+short(co.object_reader.read_typetree(),4000)
        elif t in('LensFlare','Animator','Light'):
            try:
                tt=co.object_reader.read_typetree()
                if t=='LensFlare':
                    tt['flare']=co.m_Flare.read().m_Name if co.m_Flare.path_id else None
                line+=' '+short({k:v for k,v in tt.items() if k not in SKIP},600)
            except Exception as e: line+=' err '+str(e)
        print('  '*d+'   - '+line)
def walk(tr,d):
    go=tr.m_GameObject.read(); p=tr.m_LocalPosition; r=tr.m_LocalRotation; s=tr.m_LocalScale
    print('  '*d+f"{go.m_Name} act={go.m_IsActive} pos=({p.x:.2f},{p.y:.2f},{p.z:.2f}) q=({r.x:.3f},{r.y:.3f},{r.z:.3f},{r.w:.3f}) s=({s.x:.3f},{s.y:.3f},{s.z:.3f})")
    comps(go,d)
    if d>=maxdepth:
        if tr.m_Children: print('  '*(d+1)+f'... {len(tr.m_Children)} children'); return
    for ch in tr.m_Children: walk(ch.read(),d+1)
for path,obj in env.container.items():
    if key in path and path.endswith('.prefab'):
        print('=====',path)
        root=obj.read()
        for c in root.m_Components:
            co=(c.component if hasattr(c,'component') else c).read()
            if co.object_reader.type.name in('Transform','RectTransform'): walk(co,0)
