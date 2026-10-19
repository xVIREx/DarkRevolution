#!/usr/bin/env python3
"""Edit recorded frame sequences into the trailer. Usage: python edit.py [full|short] [--preview]
Frames: frames/<clip>/fNNNNNN.jpg (exact 60 fps game time). Cards: cards/*.png (transparent 1920x1080).
Beat grid: trackBL ~107 BPM -> beat 0.56 s, bar 2.24 s; music offset chosen so cuts land on beats."""
import os, subprocess, sys, glob, json

ROOT = os.path.dirname(os.path.abspath(__file__))
FR = os.path.join(ROOT, 'frames')
CL = os.path.join(ROOT, 'clips')
OUT = os.path.join(ROOT, 'out')
CARDS = os.path.join(ROOT, 'cards')
MUSIC = os.path.join(ROOT, '..', 'client', 'public', 'assets', 'audio', 'music', 'trackBL_track.ogg')
SFX = os.path.join(ROOT, '..', 'client', 'public', 'assets', 'audio', 'sfx')
FPS = 60
B = 0.56          # beat
BAR = 4 * B
os.makedirs(CL, exist_ok=True); os.makedirs(OUT, exist_ok=True)
NICE = ['nice', '-n', '10']


def nframes(clip):
    return len(glob.glob(os.path.join(FR, clip, 'f*.jpg')))


def piece(clip, start, dur):
    """(clip, start seconds, duration seconds) -> list of frame paths (clamped)"""
    n = nframes(clip)
    a = int(round(start * FPS)); k = int(round(dur * FPS))
    if n == 0:
        raise SystemExit(f'no frames for {clip}')
    return [os.path.join(FR, clip, 'f%06d.jpg' % min(n - 1, max(0, a + i))) for i in range(k)]


def lt(card, a, b, slide=True):
    return dict(card=card, a=a, b=b, slide=slide)


def render_segment(name, frames, overlays=(), vf_pre='', flashes=(), fade_in=None, fade_out=None, split=None):
    """frames: list of jpg paths (or for split: (left_frames, right_frames)). Writes clips/<name>.mp4 (intermediate)."""
    out = os.path.join(CL, name + '.mp4')
    dur = (len(frames) if not split else len(split[0])) / FPS
    inputs = []; filt = []
    def concat_file(fl, tag):
        p = os.path.join(CL, f'{name}_{tag}.ffconcat')
        with open(p, 'w') as f:
            f.write('ffconcat version 1.0\n')
            for x in fl:
                f.write(f"file '{x}'\nduration {1/FPS:.9f}\n")
            f.write(f"file '{fl[-1]}'\n")
        return p
    if split:
        inputs += ['-f', 'concat', '-safe', '0', '-i', concat_file(split[0], 'L'), '-f', 'concat', '-safe', '0', '-i', concat_file(split[1], 'R')]
        filt.append(f'[0:v]fps={FPS},crop=960:1080:480:0[l];[1:v]fps={FPS},crop=960:1080:480:0[r];[l][r]hstack=2,format=rgb24,drawbox=x=957:y=0:w=6:h=1080:color=white@0.85:t=fill,setsar=1[base]')
        nin = 2
    else:
        inputs += ['-f', 'concat', '-safe', '0', '-i', concat_file(frames, 'v')]
        pre = f'fps={FPS},setsar=1' + (',' + vf_pre if vf_pre else '') + ',format=rgb24'
        filt.append(f'[0:v]{pre}[base]')
        nin = 1
    cur = 'base'
    for i, o in enumerate(overlays):
        inputs += ['-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.3f}', '-i', os.path.join(CARDS, o['card'] + '.png')]
        a, b = o['a'], o['b']
        fo = max(a + 0.3, b - 0.3)
        if o.get('nofade'):
            filt.append(f'[{nin}:v]format=rgba[o{i}]')
        else:
            filt.append(f'[{nin}:v]format=rgba,fade=in:st={a:.3f}:d=0.3:alpha=1,fade=out:st={fo:.3f}:d=0.3:alpha=1[o{i}]')
        x = f"'-80*max(0,1-(t-{a:.3f})/0.4)'" if o.get('slide') else '0'
        filt.append(f"[{cur}][o{i}]overlay=x={x}:y=0:format=rgb:enable='between(t,{a:.3f},{b:.3f})'[v{i}]")
        cur = f'v{i}'; nin += 1
    post = []
    for t in flashes:
        post.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=white@0.75:t=fill:enable='between(t,{t:.4f},{t+0.034:.4f})'")
        post.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=white@0.35:t=fill:enable='between(t,{t+0.034:.4f},{t+0.084:.4f})'")
    if fade_in:
        post.append(f'fade=in:st=0:d={fade_in[0]}:color={fade_in[1]}')
    if fade_out:
        post.append(f'fade=out:st={dur - fade_out[0]:.3f}:d={fade_out[0]}:color={fade_out[1]}')
    post.append('format=yuv420p')
    filt.append(f'[{cur}]' + ','.join(post) + '[vout]')
    cmd = NICE + ['ffmpeg', '-y', '-v', 'error'] + inputs + ['-filter_complex', ';'.join(filt), '-map', '[vout]',
                  '-t', f'{dur:.4f}', '-r', str(FPS), '-c:v', 'libx264', '-preset', 'fast', '-crf', '12', '-pix_fmt', 'yuv420p', out]
    subprocess.run(cmd, check=True)
    return out, dur


DARK = 'gblur=sigma=7,eq=brightness=-0.10:saturation=0.85'
DIM = 'eq=brightness=-0.06:saturation=0.9'


def ship_beats(n, each=1.2, take=B, off=0.25):
    fr = []
    for i in range(n):
        fr += piece('ships', i * each + off, take)
    return fr


def form_beats(ids=6, first=0.8, each=1.6, take=2 * B, off=0.35):
    fr = []
    for i in range(ids):
        fr += piece('formations', first + i * each + off, take)
    return fr


WARPS = [9, 13, 16, 29, 91]


def patch(a=0.0, b=999.0):
    # covers the HUD cheat tag ("GOD DMG x0.1") with the normal "PREMIUM" tag
    return dict(card='patch', a=a, b=b, slide=False, nofade=True)


def warp_beats(maps, take=2 * B, off=0.3):
    fr = []; fl = []
    for i, m in enumerate(maps):
        fl.append(len(fr) / FPS)
        fr += piece(f'warp_{m}', off, take)
    return fr, fl[1:]


def build(kind):
    segs = []   # (name, frames, kwargs)
    sfx = []    # (sfx file, time) in final timeline
    if kind == 'full':
        music_off = 21.84
        segs.append(('f00_title', piece('flyby', 0.0, 7 * B), dict(vf_pre=DARK, overlays=[lt('title', 0.25, 7 * B)], fade_in=(0.6, 'black'))))
        segs.append(('f01_login', piece('login', 0.45, 1.85) + piece('login', 2.62, 7 * B - 1.85), dict(overlays=[patch(1.85), lt('lt_browser', 2.0, 7 * B)], flashes=[1.85])))
        segs.append(('f02_flyby', piece('flyby', 1.6, 3 * BAR), dict(overlays=[lt('lt_assets', 0.5, 3 * BAR - 0.3)], fade_in=(0.25, 'white'))))
        segs.append(('f03_combat', piece('combat', 1.0, 4 * BAR), dict(overlays=[patch(), lt('lt_rust', 0.4, 3.4 * BAR)])))
        segs.append(('f04_combat2', piece('combat2', 1.5, 2 * BAR), dict(overlays=[lt('lt_combat', 0.3, 2 * BAR - 0.2)])))
        hang = piece('hangar', 0.4, 6 * B)
        segs.append(('f05_hangar', hang, dict(overlays=[patch(), lt('lt_ships', 0.3, 6 * B)])))
        sb = ship_beats(12)
        segs.append(('f06_ships', sb, dict(overlays=[lt('lt_ships', 0, 6 * B, slide=False)], flashes=[i * B for i in range(1, 12)])))
        segs.append(('f07_form', form_beats(), dict(overlays=[lt('lt_drones', 0.3, 3 * BAR - 0.3)])))
        wf, wfl = warp_beats(WARPS)
        segs.append(('f08_warps', wf, dict(overlays=[lt('lt_maps', 0.2, 5 * 2 * B - 0.3)], flashes=[0] + wfl)))
        segs.append(('f09_boss', piece('boss', 0.5, 5 * BAR), dict(overlays=[lt('lt_boss', 0.4, 2 * BAR)], flashes=[0])))
        segs.append(('f11_browser', piece('combat2', 9.0, 2 * BAR), dict(vf_pre=DARK, overlays=[lt('browser', 0.2, 2 * BAR, slide=False)])))
        segs.append(('f12_end', piece('flyby', 4.5, 3 * BAR), dict(vf_pre=DARK, overlays=[lt('end', 0.3, 3 * BAR, slide=False)], fade_out=(1.4, 'black'))))
    else:
        music_off = 27.44
        segs.append(('s00_title', piece('flyby', 0.0, BAR), dict(vf_pre=DARK, overlays=[lt('title', 0.15, BAR)], fade_in=(0.3, 'black'))))
        segs.append(('s01_flyby', piece('flyby', 2.2, 2 * BAR), dict(overlays=[lt('lt_browser', 0.4, 2 * BAR - 0.2)], fade_in=(0.2, 'white'))))
        segs.append(('s02_combat', piece('combat', 2.0, 3 * BAR), dict(overlays=[patch(), lt('lt_rust', 0.3, 3 * BAR - 0.3)])))
        segs.append(('s03_ships', ship_beats(8), dict(overlays=[lt('lt_ships', 0.2, 2 * BAR - 0.2)], flashes=[i * B for i in range(1, 8)])))
        segs.append(('s04_form', form_beats(4), dict(overlays=[lt('lt_drones', 0.2, 2 * BAR - 0.2)])))
        wf, wfl = warp_beats([5, 13, 16, 91])
        segs.append(('s05_warps', wf, dict(overlays=[lt('lt_maps', 0.2, 2 * BAR - 0.2)], flashes=[0] + wfl)))
        segs.append(('s06_boss', piece('boss', 3.0, 3 * BAR), dict(overlays=[lt('lt_boss', 0.3, 1.5 * BAR)], flashes=[0])))
        segs.append(('s08_end', piece('flyby', 4.5, 2 * BAR), dict(vf_pre=DARK, overlays=[lt('end', 0.2, 2 * BAR, slide=False)], fade_out=(1.2, 'black'))))

    files = []; t = 0.0; marks = []
    for name, fr, kw in segs:
        f, d = render_segment(name, fr, **kw)
        print(f'  {name}: {t:6.2f} -> {t + d:6.2f}  ({d:.2f}s)', flush=True)
        marks.append((name, t, d))
        if 'warps' in name:
            for x in [0] + (wfl if True else []):
                sfx.append(('portalSounds_portalJump0.ogg', t + x, 0.35))
        files.append(f); t += d
    total = t
    lst = os.path.join(CL, f'{kind}_list.txt')
    with open(lst, 'w') as fh:
        for f in files:
            fh.write(f"file '{f}'\n")
    vid = os.path.join(CL, f'{kind}_video.mp4')
    subprocess.run(NICE + ['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', vid], check=True)

    # audio: music + a few sfx
    ain = ['-ss', f'{music_off:.3f}', '-t', f'{total + 0.5:.3f}', '-i', MUSIC]
    af = [f'[0:a]afade=t=in:st=0:d=0.8,afade=t=out:st={total - 2.6:.3f}:d=2.5,volume=0.95[m]']
    mix = ['[m]']
    for i, (fn, at, vol) in enumerate(sfx):
        ain += ['-i', os.path.join(SFX, fn)]
        af.append(f'[{i + 1}:a]adelay={int(at * 1000)}|{int(at * 1000)},volume={vol}[s{i}]')
        mix.append(f'[s{i}]')
    af.append(''.join(mix) + f'amix=inputs={len(mix)}:normalize=0:duration=first,atrim=0:{total:.3f},alimiter=limit=0.95[a]')
    aud = os.path.join(CL, f'{kind}_audio.m4a')
    subprocess.run(NICE + ['ffmpeg', '-y', '-v', 'error'] + ain + ['-filter_complex', ';'.join(af), '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', aud], check=True)

    final = os.path.join(OUT, 'darkorbit_rebuilt.mp4' if kind == 'full' else 'darkorbit_rebuilt_short.mp4')
    crf = os.environ.get('CRF', '18')
    subprocess.run(NICE + ['ffmpeg', '-y', '-v', 'error', '-i', vid, '-i', aud, '-map', '0:v', '-map', '1:a',
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
                    '-g', '120', '-c:a', 'copy', '-movflags', '+faststart', '-shortest', final], check=True)
    json.dump(marks, open(os.path.join(CL, f'{kind}_marks.json'), 'w'), indent=1)
    sz = os.path.getsize(final) / 1e6
    print(f'{final}: {total:.2f}s, {sz:.1f} MB')


if __name__ == '__main__':
    for k in (sys.argv[1:] or ['full', 'short']):
        build(k)
