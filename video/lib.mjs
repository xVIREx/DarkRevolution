// Shared helpers for scripted gameplay recording.
// Headless Chrome (no window on the desktop) with hardware GPU WebGL (ANGLE -> Mesa/Intel).
// Deterministic capture: the page runs on a virtual clock (performance.now / rAF / timers overridden).
// The server runs its sim slowed by DO_TIME_SCALE=S; in "auto" mode the page clock advances at real*S
// (consistent with the server), while recording we step exactly 1/60 s of virtual time per captured frame,
// paced so virtual time never runs ahead of the (slowed) server. Result: perfectly smooth 60 fps at true game speed.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.dirname(new URL(import.meta.url).pathname);
export const S = Number(process.env.DO_TIME_SCALE || 0.12);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const FPS = 60;

function vtInit(S) {
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  let vt = realNow();
  let lastReal = realNow();
  let auto = true;
  const rafQ = new Map(); let rafId = 1;
  const timers = new Map(); let tid = 1000000;
  const dateBase = Date.now() - vt;
  performance.now = () => vt;
  Date.now = () => Math.round(dateBase + vt);
  window.requestAnimationFrame = (cb) => { const id = rafId++; rafQ.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { rafQ.delete(id); };
  const addT = (cb, ms, a, iv) => { const id = tid++; timers.set(id, { at: vt + Math.max(0, Number(ms) || 0), cb, a, iv }); return id; };
  window.setTimeout = (cb, ms, ...a) => addT(cb, ms, a, 0);
  window.setInterval = (cb, ms, ...a) => addT(cb, ms, a, Math.max(4, Number(ms) || 0));
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  function runTimers() {
    for (let guard = 0; guard < 1000; guard++) {
      let best = null;
      for (const [id, t] of timers) if (t.at <= vt && (!best || t.at < best[1].at)) best = [id, t];
      if (!best) return;
      const [id, t] = best;
      if (t.iv) t.at += t.iv; else timers.delete(id);
      try { typeof t.cb === 'function' ? t.cb(...t.a) : (0, eval)(t.cb); } catch (e) { console.error(e); }
    }
  }
  function frame() {
    const q = [...rafQ]; rafQ.clear();
    for (const [, cb] of q) { try { cb(vt); } catch (e) { console.error(e); } }
  }
  function advance(ms) { vt += ms; runTimers(); frame(); }
  function autoLoop() {
    realRaf(autoLoop);
    const r = realNow(); const d = Math.min(200, r - lastReal); lastReal = r;
    if (auto) advance(d * S);
  }
  realRaf(autoLoop);
  window.__vt = { setAuto(v) { auto = v; lastReal = realNow(); }, step(ms) { advance(ms); }, now: () => vt, S };
}

export async function launch({ w = 1920, h = 1080 } = {}) {
  const args = [
    '--headless=new',
    '--enable-gpu',
    '--use-angle=gl',
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ];
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.addInitScript(vtInit, S);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  const cdp = await ctx.newCDPSession(page);
  page.__cdp = cdp;
  return { browser, ctx, page };
}

/** Wait `sec` seconds of game (sim) time in auto mode. */
export async function wait(page, sec) { await sleep((sec * 1000) / S); }

/** HUD visibility: 'full' | 'none' (cinematic: no windows, keep damage numbers) | 'clean' (no windows/no dmg) */
export async function setHud(page, mode) {
  await page.evaluate((mode) => {
    let s = document.getElementById('__vidcss');
    if (!s) { s = document.createElement('style'); s.id = '__vidcss'; document.head.appendChild(s); }
    // cheat indicator ("GOD DMG xN") -> show the normal PREMIUM tag instead
    let css = '.kvi.premium{visibility:hidden;position:relative}.kvi.premium::after{content:"PREMIUM";visibility:visible;position:absolute;left:0;top:0}';
    if (mode !== 'full') css += '#hud, #actionbar, .dowin:not(.hangar-win) { display: none !important; }';
    if (mode === 'clean') css += '.dmg { display: none !important; }';
    s.textContent = css;
  }, mode);
}

export async function login(page, { name = 'Rustacean', faction = 'mmo', renderer = '3d' } = {}) {
  await page.goto(`http://localhost:8080/?r=${renderer}`);
  await page.evaluate(({ name, faction }) => localStorage.setItem('do.login', JSON.stringify({ name, faction })), { name, faction });
  await page.reload();
  await page.waitForSelector('#login button');
}

export async function launchGame(page) {
  await page.click('#login button');
  await page.waitForFunction(() => window.__game && window.__game.ents && window.__game.ents.me && window.__game.ents.me(), null, { timeout: 60000, polling: 200 });
}

export async function waitAssets(page, ms = 3000) {
  try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch { /* ignore */ }
  await sleep(ms);
}

export async function cheat(page, dmgMult = 1) {
  await page.evaluate((d) => window.__game.sendRaw({ t: 'cheat', god: true, dmgMult: d }), dmgMult);
}

export async function zoomTo(page, z, instant = false) {
  await page.evaluate(({ z, instant }) => { const w = window.__game.world; w.targetZoom = z; if (instant) w.zoom = z; }, { z, instant });
}

export async function me(page) {
  return page.evaluate(() => { const m = window.__game.ents.me(); return m ? { x: m.x, y: m.y, a: m.snap.a, hp: m.snap.hp, s: m.snap.s, map: window.__game.map?.id } : null; });
}

export async function ents(page) {
  return page.evaluate(() => [...window.__game.ents.views.values()].map((v) => ({ id: v.snap.id, k: v.snap.k, n: v.snap.n, s: v.snap.s, x: v.x, y: v.y, hp: v.snap.hp, mhp: v.snap.mhp })));
}

export class Recorder {
  constructor(page) { this.page = page; this.cdp = page.__cdp; }
  async start(name) {
    this.name = name;
    this.dir = path.join(ROOT, 'frames', name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.n = 0;
    this.pending = [];
    await this.page.evaluate(() => window.__vt.setAuto(false));
    this.realT0 = Date.now();
    this.slow = 0;
    this.tStart = Date.now();
  }
  /** capture `sec` seconds of game time (60 fps); optional per-frame callback(frameIndexInCall, t) */
  async cap(sec, onFrame) {
    const n = Math.round(sec * FPS);
    const stepMs = 1000 / FPS;
    for (let i = 0; i < n; i++) {
      const deadline = this.realT0 + (this.n * stepMs) / S;
      const now = Date.now();
      if (now < deadline) await sleep(deadline - now);
      else if (now - deadline > 50) this.slow++;
      if (onFrame) await onFrame(i, i / FPS);
      await this.page.evaluate((ms) => window.__vt.step(ms), stepMs);
      const r = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
      const file = path.join(this.dir, `f${String(this.n).padStart(6, '0')}.jpg`);
      this.pending.push(fs.promises.writeFile(file, Buffer.from(r.data, 'base64')));
      this.n++;
    }
  }
  /** game time elapsed in this clip (s) */
  get t() { return this.n / FPS; }
  async stop() {
    await Promise.all(this.pending);
    await this.page.evaluate(() => window.__vt.setAuto(true));
    const real = (Date.now() - this.tStart) / 1000;
    console.log(`[rec] ${this.name}: ${this.n} frames = ${(this.n / FPS).toFixed(2)} s game, real ${real.toFixed(1)} s, late frames ${this.slow}`);
    return this.n;
  }
}
