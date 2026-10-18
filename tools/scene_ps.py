"""Simplify Unity ParticleSystem (+renderer) typetrees into a compact JSON emitter description
that a small three.js particle runtime can play. Units: Unity units (= DO world units), seconds,
radians. Vectors already converted to three.js handedness (z negated) where noted."""
import math

def curve_eval(keys, t):
    if not keys: return 1.0
    if t <= keys[0]['time']: return keys[0]['value']
    if t >= keys[-1]['time']: return keys[-1]['value']
    for a, b in zip(keys, keys[1:]):
        if a['time'] <= t <= b['time']:
            dt = b['time'] - a['time']
            if dt <= 0: return b['value']
            s = (t - a['time']) / dt
            m0 = a.get('outSlope', 0) * dt; m1 = b.get('inSlope', 0) * dt
            if any(map(lambda v: isinstance(v, float) and math.isinf(v), (m0, m1))):
                return a['value']
            h00 = 2*s**3 - 3*s**2 + 1; h10 = s**3 - 2*s**2 + s; h01 = -2*s**3 + 3*s**2; h11 = s**3 - s**2
            return h00*a['value'] + h10*m0 + h01*b['value'] + h11*m1
    return keys[-1]['value']

def sample(keys, n=8, mul=1.0):
    return [[round(i/(n-1), 3), round(curve_eval(keys, i/(n-1))*mul, 4)] for i in range(n)]

def mmc(c):
    """MinMaxCurve -> {min,max} constant range, or {curve:[[t,v]..]} (curve already multiplied)."""
    st = c['minMaxState']; s = c['scalar']; ms = c.get('minScalar', s)
    if st == 0: return [round(s, 4), round(s, 4)]
    if st == 3: return [round(min(ms, s), 4), round(max(ms, s), 4)]
    if st == 1:
        k = c['maxCurve']['m_Curve']
        return {"curve": sample(k, 8, s)}
    if st == 2:
        a = sample(c['minCurve']['m_Curve'], 8, s); b = sample(c['maxCurve']['m_Curve'], 8, s)
        return {"curve": [[x[0], round((x[1]+y[1])/2, 4)] for x, y in zip(a, b)], "curveMin": a, "curveMax": b}
    return [s, s]

def mmc_const(c):
    v = mmc(c)
    if isinstance(v, list): return v
    vals = [p[1] for p in v['curve']]; return [round(min(vals), 4), round(max(vals), 4)]

def col(c): return [round(c['r'], 3), round(c['g'], 3), round(c['b'], 3), round(c['a'], 3)]

def gradient(g):
    n = g['m_NumColorKeys']; na = g['m_NumAlphaKeys']
    cs = [[round(g[f'ctime{i}']/65535, 3)] + col(g[f'key{i}'])[:3] for i in range(n)]
    al = [[round(g[f'atime{i}']/65535, 3), round(g[f'key{i}']['a'], 3)] for i in range(na)]
    return {"color": cs, "alpha": al}

def mmg(c):
    st = c['minMaxState']
    if st == 0: return {"const": col(c['maxColor'])}
    if st == 1: return {"gradient": gradient(c['maxGradient'])}
    if st == 2: return {"randomBetween": [col(c['minColor']), col(c['maxColor'])]}
    if st == 3: return {"randomBetweenGradients": [gradient(c['minGradient']), gradient(c['maxGradient'])]}
    if st == 4: return {"randomFromGradient": gradient(c['maxGradient'])}
    return {"const": col(c['maxColor'])}

SHAPES = {0: "sphere", 1: "sphereShell", 2: "hemisphere", 4: "cone", 5: "box", 6: "mesh", 8: "coneShell",
          10: "circle", 12: "edge", 13: "meshRenderer", 15: "boxShell", 16: "boxEdge", 17: "donut", 18: "rectangle", 19: "sprite"}
RENDER = {0: "billboard", 1: "stretched", 2: "horizontal", 3: "vertical", 4: "mesh", 5: "none"}

def blend_of(shader_name):
    s = (shader_name or '').lower()
    if 'additive' in s or 'add' in s: return 'add'
    if 'premultiply' in s: return 'premultiplied'
    return 'alpha'

def simplify(t, rend=None, tex=None, shader=None, mat_tint=None):
    I = t['InitialModule']; S = t['ShapeModule']; E = t['EmissionModule']
    o = {
        "duration": round(t['lengthInSec'], 3), "loop": bool(t['looping']), "prewarm": bool(t['prewarm']),
        "delay": mmc_const(t['startDelay']), "simSpeed": t.get('simulationSpeed', 1),
        "space": ["local", "world", "custom"][t.get('moveWithTransform', 0)] if isinstance(t.get('moveWithTransform', 0), int) else "local",
        "maxParticles": I['maxNumParticles'],
        "lifetime": mmc_const(I['startLifetime']), "speed": mmc_const(I['startSpeed']),
        "size": mmc_const(I['startSize']), "rotation": mmc_const(I['startRotation']),
        "startColor": mmg(I['startColor']), "gravity": mmc_const(I['gravityModifier']),
    }
    if I.get('size3D'):
        o['sizeXYZ'] = [mmc_const(I['startSize']), mmc_const(I['startSizeY']), mmc_const(I['startSizeZ'])]
    if S['enabled']:
        sc = S['m_Scale']; po = S['m_Position']; ro = S['m_Rotation']
        o['shape'] = {"type": SHAPES.get(S['type'], str(S['type'])), "radius": round(S['radius']['value'], 3),
                      "radiusThickness": round(S.get('radiusThickness', 1), 3),
                      "angle": round(S['angle'], 3), "arc": round(S['arc']['value'], 2),
                      "scale": [round(sc['x'], 3), round(sc['y'], 3), round(sc['z'], 3)],
                      "pos": [round(po['x'], 3), round(po['y'], 3), round(-po['z'], 3)],
                      "rotDeg": [round(ro['x'], 2), round(ro['y'], 2), round(ro['z'], 2)],
                      "randomDirection": round(S.get('randomDirectionAmount', 0), 3)}
    if E['enabled']:
        o['rate'] = mmc_const(E['rateOverTime'])
        o['ratePerDistance'] = mmc_const(E['rateOverDistance'])
        o['bursts'] = [{"time": round(b['time'], 3), "count": mmc_const(b['countCurve']), "cycles": b['cycleCount'],
                        "interval": round(b['repeatInterval'], 3)} for b in E['m_Bursts']]
    if t['ColorModule']['enabled']: o['colorOverLife'] = mmg(t['ColorModule']['gradient'])
    if t['SizeModule']['enabled']: o['sizeOverLife'] = mmc(t['SizeModule']['curve'])
    if t['RotationModule']['enabled']: o['rotationOverLife'] = mmc_const(t['RotationModule']['curve'])
    V = t['VelocityModule']
    if V['enabled']:
        o['velocityOverLife'] = {"x": mmc_const(V['x']), "y": mmc_const(V['y']), "z": [-v for v in mmc_const(V['z'])][::-1],
                                 "radial": mmc_const(V['radial']) if 'radial' in V else [0, 0],
                                 "world": bool(V['inWorldSpace'])}
    F = t['ForceModule']
    if F['enabled']:
        o['force'] = {"x": mmc_const(F['x']), "y": mmc_const(F['y']), "z": [-v for v in mmc_const(F['z'])][::-1], "world": bool(F['inWorldSpace'])}
    C = t['ClampVelocityModule']
    if C['enabled']: o['limitVelocity'] = {"magnitude": mmc_const(C['magnitude']), "dampen": round(C['dampen'], 3), "drag": mmc_const(C['drag']) if 'drag' in C else [0, 0]}
    N = t['NoiseModule']
    if N['enabled']: o['noise'] = {"strength": mmc_const(N['strength']), "frequency": round(N['frequency'], 3), "scrollSpeed": mmc_const(N['scrollSpeed'])}
    U = t['UVModule']
    if U['enabled'] and U.get('mode', 0) == 0:
        o['sheet'] = {"tilesX": U['tilesX'], "tilesY": U['tilesY'], "frameOverTime": mmc(U['frameOverTime']),
                      "startFrame": mmc_const(U['startFrame']), "cycles": U['cycles'], "animation": ["wholeSheet", "singleRow"][U['animationType']] if U['animationType'] in (0, 1) else U['animationType'],
                      "rowIndex": U.get('rowIndex', 0), "timeMode": U.get('timeMode', 0), "fps": U.get('fps', 0)}
    T = t['TrailModule']
    if T['enabled']: o['trails'] = {"lifetime": mmc_const(T['lifetime']), "ratio": T['ratio'], "widthOverTrail": mmc(T['widthOverTrail']), "colorOverTrail": mmg(T['colorOverTrail'])}
    Sub = t['SubModule']
    if Sub['enabled']: o['subEmitters'] = len(Sub['subEmitters'])
    if rend is not None:
        o['render'] = RENDER.get(rend.get('m_RenderMode', 0), str(rend.get('m_RenderMode')))
        if o['render'] == 'stretched':
            o['lengthScale'] = round(rend.get('m_LengthScale', 2), 3); o['velocityScale'] = round(rend.get('m_VelocityScale', 0), 3)
            o['cameraVelocityScale'] = round(rend.get('m_CameraVelocityScale', 0), 3)
        o['sortingFudge'] = rend.get('m_SortingFudge', 0)
        o['maxParticleSize'] = round(rend.get('m_MaxParticleSize', 0.5), 3)
        o['renderAlignment'] = ["view", "world", "local", "facing", "velocity"][rend.get('m_RenderAlignment', 0)] if rend.get('m_RenderAlignment', 0) < 5 else 'view'
    o['tex'] = tex; o['shader'] = shader; o['blend'] = blend_of(shader)
    if mat_tint: o['tint'] = mat_tint
    return o
