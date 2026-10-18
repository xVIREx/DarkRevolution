#!/usr/bin/env python3
"""Extract DarkOrbit AudioClips from the Unity bundles and encode them as Ogg Vorbis
into client/public/assets/audio/{sfx,music}/, then write audio.json.

Run: .venv/bin/python tools/audio_extract.py   (needs ffmpeg with libvorbis on PATH)
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile
import UnityPy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BT = os.path.expanduser("~/darkorbit-client/extracted/DarkOrbit_Version0.1.4/DarkOrbit_Data/StreamingAssets/aa/BuildTarget/")
OUT = os.path.join(ROOT, "client/public/assets/audio")
MAPS = os.path.join(ROOT, "extracted/xml/maps-config.txt")
FFMPEG = shutil.which("ffmpeg") or os.path.expanduser("~/.local/bin/ffmpeg")

# Semantic event -> clip. Names come from the Unity addressable paths (Assets/Res/Audios/Sounds/<group>/<clip>.mp3).
# Laser ammo -> clip is inferred (game.txt gives soundIDs 0/9/10/11/13 for x1..x4/SAB, but the id->clip
# table is compiled into IL2CPP code and not recoverable as data); groups with _0/_1/_2 variants are listed
# under "variants" so the client can randomise.
EVENTS = {
    "laser_x1": "combatSounds_laser0_0",      # LCB-10 red (soundID 0)
    "laser_x2": "combatSounds_laser1_0",      # MCB-25 blue (soundID 9)   - guessed
    "laser_x3": "combatSounds_laser5_0",      # MCB-50 green (soundID 10) - guessed
    "laser_x4": "combatSounds_laser7_0",      # UCB-100 white (soundID 11) - guessed
    "laser_sab": "combatSounds_absorber0",    # SAB-50 absorber (soundID 13)
    "laser_rsb": "combatSounds_laser2_0",     # RSB-75 - guessed (heavy single shot)
    "laser_pulse": "combatSounds_pulse",      # pulse laser (soundID 32)
    "laser_npc_hitac": "combatSounds_hitac_mothership_cannon_shot",
    "rocket": "combatSounds_rocket1_0",
    "rocket_hit": "damageSounds_rocketDamage0_0",
    "explosion": "damageSounds_explosion1_0",
    "explosion_small": "damageSounds_explosion0_0",
    "explosion_big": "damageSounds_explosion2_0",
    "smartbomb": "damageSounds_smartbomb0",
    "emp": "damageSounds_emp",
    "instashield": "damageSounds_instashield0",
    "hit": "damageSounds_rocketDamage0_1",
    "jump": "portalSounds_portalJump0",
    "jump_done": "portalSounds_portalDone",
    "click": "uiSounds_select0",
    "select": "uiSounds_select1",
    "slot_move": "uiSounds_slotMove",
    "out_of_range": "uiSounds_outOfRange",
    "cooldown": "uiSounds_cooldownExceeded",
    "rocket_load": "uiSounds_rocketLoad",
    "rockets_loaded": "uiSounds_rocketsLoaded",
    "shield_selected": "uiSounds_shieldSelected",
    "hint": "uiSounds_showHint",
    "achievement": "uiSounds_new_achievement",
    "collect": "miscSounds_ploepp",
    "levelup": "miscSounds_levelUp",
    "repair_start": "miscSounds_repair_start",
    "repair": "miscSounds_repair",
    "engine": "miscSounds_engine0",
    "warning": "voiceSounds_voice_warning",
    "access_denied": "voiceSounds_voice_accessDenied",
    "voice_ready": "voiceSounds_voice_ready",
    "voice_activate": "voiceSounds_voice_activate",
    "voice_standby": "voiceSounds_voice_standby",
    "quest_finished": "questSounds_quest_finished",
    "quest_failed": "questSounds_quest_failed",
    "subquest_finished": "questSounds_quest_subquest_finished",
    "ambience": "ambience_ambience_loop_0",
    "triple_kill": "miscSounds_tripleKill",
    "unstoppable": "miscSounds_unstoppable",
    "godlike": "miscSounds_godlike",
    "pet_activate": "petSounds_activation",
    "pet_deactivate": "petSounds_deactivation",
    "pet_destroyed": "petSounds_destruction",
}

# maps-config music="N" -> track clip (inferred from which maps use each id)
MUSIC_IDS = {
    "0": "track0_track",              # default / GGs / invasions / misc
    "1": "trackMMO_track",            # 1-x
    "2": "trackEIC_track",            # 2-x
    "3": "trackVRU_track",            # 3-x
    "4": "trackBattlemap_track",      # 4-x, Tiered Arena
    "5": "trackPirate_track",         # 5-x, Devolarium Attack
    "8": "trackRZone_track",          # R-Zones, WarGames
    "9": "track_tunnelOfTerror_track",# Trial of Terror, Experiment Zones, Gauntlet of Plutus
    "10": "trackBL_track",            # 1-BL..3-BL
}


def encode(wav_bytes, dst, music):
    with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
        tf.write(wav_bytes); tf.flush()
        q = "3" if music else "4"
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", tf.name, "-map_metadata", "-1",
                        "-c:a", "libvorbis", "-q:a", q, dst], check=True)


def main():
    os.makedirs(f"{OUT}/sfx", exist_ok=True); os.makedirs(f"{OUT}/music", exist_ok=True)
    allsfx, tracks, lengths = {}, {}, {}
    for pattern, music in (("music_assets_all_*.bundle", True), ("sound_assets_all_*.bundle", False)):
        for f in glob.glob(BT + pattern):
            for o in UnityPy.load(f).objects:
                if o.type.name != "AudioClip":
                    continue
                c = o.read(); name = c.m_Name
                wav = next(iter(c.samples.values()))
                rel = f"{'music' if music else 'sfx'}/{name}.ogg"
                encode(wav, os.path.join(OUT, rel), music)
                (tracks if music else allsfx)[name] = rel
                lengths[name] = round(float(c.m_Length), 3)
                print(rel, file=sys.stderr)

    # variant groups: foo_0, foo_1, foo_2 -> foo
    variants = {}
    for n in sorted(allsfx):
        m = re.match(r"(.+\d)_(\d)$", n)
        if m:
            variants.setdefault(m.group(1), []).append(allsfx[n])
    variants = {k: v for k, v in variants.items() if len(v) > 1}

    sfx = {k: allsfx[v] for k, v in EVENTS.items() if v in allsfx}
    by_map = {}
    for m in re.finditer(r"<map\b[^>]*>", open(MAPS, encoding="utf-8").read()):
        mid = re.search(r'\bid="(\d+)"', m.group(0)); mu = re.search(r'music="(\d+)"', m.group(0))
        if mid and mu and MUSIC_IDS.get(mu.group(1)) in tracks:
            by_map[mid.group(1)] = tracks[MUSIC_IDS[mu.group(1)]]
    out = {
        "sfx": sfx,
        "variants": variants,
        "all": dict(sorted(allsfx.items())),
        "music": {
            "default": tracks["track0_track"],
            "combat": tracks.get("trackCombat_track"),
            "byMusicId": {k: tracks[v] for k, v in MUSIC_IDS.items() if v in tracks},
            "byMap": by_map,
            "tracks": dict(sorted(tracks.items())),
        },
        "lengths": lengths,
    }
    json.dump(out, open(f"{OUT}/audio.json", "w"), indent=1)


if __name__ == "__main__":
    main()
