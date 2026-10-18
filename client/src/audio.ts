/**
 * Web Audio: SFX with pooling/throttling + positional attenuation, and crossfading map music.
 * Everything is optional: a missing audio.json or missing files simply play nothing.
 */

const BASE = '/assets/audio/';
const STORE_KEY = 'do.audio';

interface AudioManifest {
  sfx?: Record<string, string>;
  all?: Record<string, string>;
  variants?: Record<string, string[]>;
  music?: { default?: string; combat?: string; byMap?: Record<string, string>; byMusicId?: Record<string, string>; tracks?: Record<string, string> };
}

export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
  muted: boolean;
}

interface SfxRule { minGap: number; maxVoices: number; vol: number }
const RULES: Record<string, SfxRule> = {
  default: { minGap: 50, maxVoices: 4, vol: 0.8 },
  hit: { minGap: 90, maxVoices: 3, vol: 0.5 },
  explosion: { minGap: 80, maxVoices: 4, vol: 1 },
  explosion_big: { minGap: 120, maxVoices: 3, vol: 1 },
  explosion_small: { minGap: 80, maxVoices: 4, vol: 0.9 },
  rocket_hit: { minGap: 80, maxVoices: 3, vol: 0.8 },
  out_of_range: { minGap: 1500, maxVoices: 1, vol: 0.6 },
  cooldown: { minGap: 400, maxVoices: 1, vol: 0.5 },
  click: { minGap: 40, maxVoices: 2, vol: 0.6 },
  select: { minGap: 60, maxVoices: 2, vol: 0.6 },
  warning: { minGap: 3000, maxVoices: 1, vol: 0.7 },
};
const LASER_RULE: SfxRule = { minGap: 70, maxVoices: 5, vol: 0.55 };

function url(rel: string): string {
  if (/^(https?:)?\/\//.test(rel) || rel.startsWith('/')) return rel;
  return BASE + rel.replace(/^\.?\//, '');
}

export class AudioSystem {
  private manifest: AudioManifest = {};
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private lastPlay = new Map<string, number>();
  private voices = new Map<string, number>();
  private music: { url: string; el: HTMLAudioElement; gain: GainNode } | null = null;
  private wantMusic: string | null = null;
  private mapMusic: string | null = null;
  private combat = false;
  private combatUntil = 0;
  private variantOf = new Map<string, string[]>();
  listenerX = 0;
  listenerY = 0;
  settings: AudioSettings = { master: 0.8, sfx: 0.8, music: 0.4, muted: false };
  onChange: ((s: AudioSettings) => void) | null = null;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') as Partial<AudioSettings> | null;
      if (s) this.settings = { ...this.settings, ...s };
    } catch { /* ignore */ }
    const unlock = () => {
      this.unlock();
      if (this.ctx && this.ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  async init(): Promise<void> {
    try {
      const r = await fetch(BASE + 'audio.json', { cache: 'no-cache' });
      if (r.ok) this.manifest = ((await r.json()) as AudioManifest) ?? {};
      for (const list of Object.values(this.manifest.variants ?? {})) {
        if (Array.isArray(list)) for (const u of list) this.variantOf.set(u, list);
      }
    } catch {
      this.manifest = {};
    }
  }

  private unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.sfxBus = this.ctx.createGain();
        this.musicBus = this.ctx.createGain();
        this.sfxBus.connect(this.master);
        this.musicBus.connect(this.master);
        this.master.connect(this.ctx.destination);
        this.applyVolumes();
        if (this.wantMusic) this.startMusic(this.wantMusic);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch (e) {
      console.warn('audio unlock failed', e);
    }
  }

  // ---------- settings ----------
  set(p: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...p };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
    this.applyVolumes();
    this.onChange?.(this.settings);
  }

  toggleMute(): void {
    this.set({ muted: !this.settings.muted });
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master || !this.sfxBus || !this.musicBus) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.muted ? 0 : this.settings.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.settings.music, t, 0.05);
  }

  // ---------- sfx ----------
  private buffer(rel: string): Promise<AudioBuffer | null> {
    const u = url(rel);
    let p = this.buffers.get(u);
    if (!p) {
      const ctx = this.ctx!;
      p = fetch(u)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((ab) => ctx.decodeAudioData(ab))
        .catch(() => null);
      this.buffers.set(u, p);
    }
    return p;
  }

  private sfxUrl(name: string): string | undefined {
    const rel = this.manifest.sfx?.[name] ?? this.manifest.all?.[name];
    if (!rel) return undefined;
    const vs = this.variantOf.get(rel);
    return vs && vs.length ? vs[Math.floor(Math.random() * vs.length)] : rel;
  }

  /** Play a named sfx; with x/y it is attenuated + panned relative to the listener (own ship). */
  play(name: string, x?: number, y?: number, volume = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfxBus || this.settings.muted) return;
    let rel = this.sfxUrl(name);
    if (!rel && name.startsWith('laser_')) rel = this.sfxUrl('laser_x1');
    if (!rel && (name === 'explosion_big' || name === 'explosion_small')) rel = this.sfxUrl('explosion');
    if (!rel && name === 'rocket_hit') rel = this.sfxUrl('hit');
    if (!rel && name === 'jump_done') return;
    if (!rel) return;
    const rule = name.startsWith('laser_') ? LASER_RULE : RULES[name] ?? RULES.default;
    const now = performance.now();
    if (now - (this.lastPlay.get(name) ?? -1e9) < rule.minGap) return;
    if ((this.voices.get(name) ?? 0) >= rule.maxVoices) return;

    let gain = rule.vol * volume;
    let pan = 0;
    if (x !== undefined && y !== undefined) {
      const dx = x - this.listenerX;
      const dy = y - this.listenerY;
      const d = Math.hypot(dx, dy);
      if (d > 2500) return;
      gain *= 1 / (1 + d / 700);
      pan = Math.max(-1, Math.min(1, dx / 1200));
    }
    if (gain < 0.02) return;
    this.lastPlay.set(name, now);
    this.voices.set(name, (this.voices.get(name) ?? 0) + 1);
    const release = () => this.voices.set(name, Math.max(0, (this.voices.get(name) ?? 1) - 1));
    void this.buffer(rel).then((buf) => {
      if (!buf || !this.ctx || !this.sfxBus) {
        release();
        return;
      }
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = 0.96 + Math.random() * 0.08;
        const g = this.ctx.createGain();
        g.gain.value = gain;
        let node: AudioNode = g;
        if (pan !== 0 && typeof this.ctx.createStereoPanner === 'function') {
          const p = this.ctx.createStereoPanner();
          p.pan.value = pan;
          g.connect(p);
          node = p;
        }
        src.connect(g);
        node.connect(this.sfxBus);
        src.onended = () => {
          release();
          try { node.disconnect(); g.disconnect(); } catch { /* ignore */ }
        };
        src.start();
      } catch {
        release();
      }
    });
  }

  // ---------- music ----------
  playMapMusic(mapId: number | string): void {
    const m = this.manifest.music;
    const rel = m?.byMap?.[String(mapId)] ?? m?.default;
    if (!rel) return;
    this.mapMusic = url(rel);
    this.refreshMusic();
  }

  /** Call every frame with whether we are in combat; switches to the combat track (if any) with a grace period. */
  setCombat(inCombat: boolean): void {
    const now = performance.now();
    if (inCombat) this.combatUntil = now + 8000;
    const c = now < this.combatUntil && !!this.manifest.music?.combat;
    if (c !== this.combat) {
      this.combat = c;
      this.refreshMusic();
    }
  }

  private refreshMusic(): void {
    const combat = this.manifest.music?.combat;
    this.wantMusic = this.combat && combat ? url(combat) : this.mapMusic;
    if (this.ctx && this.wantMusic) this.startMusic(this.wantMusic);
  }

  private startMusic(u: string): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    if (this.music?.url === u) return;
    const fade = 2.0;
    const t = ctx.currentTime;
    // fade out old
    if (this.music) {
      const old = this.music;
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0, t + fade);
      setTimeout(() => {
        try { old.el.pause(); old.el.src = ''; old.gain.disconnect(); } catch { /* ignore */ }
      }, fade * 1000 + 100);
      this.music = null;
    }
    try {
      const el = new Audio();
      el.src = u;
      el.loop = true;
      el.preload = 'auto';
      const src = ctx.createMediaElementSource(el);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + fade);
      src.connect(g);
      g.connect(this.musicBus);
      el.onerror = () => { /* missing file: stay silent */ };
      void el.play().catch(() => { /* autoplay or missing */ });
      this.music = { url: u, el, gain: g };
    } catch (e) {
      console.warn('music failed', e);
    }
  }
}
