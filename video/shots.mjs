// Scripted gameplay shots. Usage: node shots.mjs <shot> [<shot>...]   (see SHOTS below)
import { launch, login, launchGame, waitAssets, me, ents, wait, setHud, zoomTo, cheat, sleep, Recorder, S } from './lib.mjs';

// in-page autopilot: lock nearest matching NPC, approach, lasers on, rockets
async function installAuto(page) {
  await page.evaluate(() => {
    window.__auto = {
      filter: null, approach: 480, rockets: true, lastRocket: 0, rsbEvery: 0, lastRsb: 0, ammo: 'x4', exclude: null,
      tick() {
        const g = window.__game, E = g.ents, me = E.me(); if (!me) return;
        let t = E.selectedId ? E.views.get(E.selectedId) : null;
        if (!t || t.snap.hp <= 0) {
          let best = null, bd = 1e18;
          for (const v of E.views.values()) {
            if (v.snap.k !== 'n' || v.snap.hp <= 0) continue;
            if (this.filter && !this.filter.test(v.snap.n)) continue;
            if (this.exclude && this.exclude.test(v.snap.n)) continue;
            const d = (v.x - me.x) ** 2 + (v.y - me.y) ** 2; if (d < bd) { bd = d; best = v; }
          }
          if (!best) return;
          g.select(best.snap.id); t = best;
        }
        if (!g.isAttacking()) g.startAttack();
        const dx = t.x - me.x, dy = t.y - me.y, d = Math.hypot(dx, dy) || 1;
        if (d > this.approach) g.moveTo(t.x - (dx / d) * this.approach * 0.6, t.y - (dy / d) * this.approach * 0.6);
        const now = performance.now();
        if (this.rsbEvery && now - this.lastRsb > this.rsbEvery) { this.lastRsb = now; g.setAmmo('rsb'); setTimeout(() => g.setAmmo(this.ammo), 1200); }
        if (this.rockets && now - this.lastRocket > 1100) { this.lastRocket = now; g.fireRocket(); }
      },
    };
  });
}
const autoTick = (page) => page.evaluate(() => window.__auto.tick());
const ev = (page, fn, a) => page.evaluate(fn, a);

async function setup(page, { hud = 'full', dmg = 1, ship = null, design = null, faction = 'mmo', name = 'Rustacean', renderer = '3d' } = {}) {
  await login(page, { name, faction, renderer });
  await launchGame(page);
  await cheat(page, dmg);
  if (ship) await ev(page, ([s, d]) => window.__game.setShip(s, d || undefined), [ship, design]);
  await setHud(page, hud);
  await installAuto(page);
  await waitAssets(page, 2500);
}

async function warpAndSettle(page, map, extra = 1.5) {
  await ev(page, (m) => window.__game.warp(m), map);
  await page.waitForFunction((m) => window.__game.map?.id === m && window.__game.ents.me(), map, { polling: 200, timeout: 60000 });
  await waitAssets(page, 1500);
  await wait(page, extra);
}

// fly a loop around the current position so aggressive NPCs start chasing us (builds a swarm)
async function gather(page, { r = 2200, laps = 1, steps = 8, dt = 2.2 } = {}) {
  const c = await me(page);
  for (let l = 0; l < laps; l++) for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    await ev(page, ({ x, y }) => window.__game.moveTo(x, y), { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    await wait(page, dt);
  }
  await ev(page, ({ x, y }) => window.__game.moveTo(x, y), c);
  await wait(page, 3);
  const es = await ents(page); const m = await me(page);
  console.log('npcs within 900:', es.filter((e) => e.k === 'n' && Math.hypot(e.x - m.x, e.y - m.y) < 900).map((e) => e.n).join(', '));
}

const smooth = (a, b, k) => a + (b - a) * (k < 0 ? 0 : k > 1 ? 1 : k * k * (3 - 2 * k));

const SHOTS = {
  // 1. login screen -> launch -> spawn at 1-1 home base (HUD visible)
  async login(page, rec) {
    await page.goto('http://localhost:8080/?r=3d');
    await page.evaluate(() => localStorage.setItem('do.login', JSON.stringify({ name: '', faction: 'mmo' })));
    await page.reload();
    await page.waitForSelector('#login button');
    await page.evaluate(() => { const i = document.querySelector('#login input'); i.value = ''; i.blur(); });
    await sleep(2500);
    await rec.start('login');
    await rec.cap(0.6);
    const name = 'Rustacean';
    for (const ch of name) { await page.evaluate((c) => { const i = document.querySelector('#login input'); i.value += c; }, ch); await rec.cap(0.08); }
    await rec.cap(0.5);
    await page.evaluate(() => document.querySelectorAll('#login .faction')[0].click());
    await rec.cap(0.5);
    await page.evaluate(() => document.querySelector('#login button').click());
    // keep capturing until the game is in (loading happens in real time, so it looks fast)
    for (let i = 0; i < 400; i++) {
      await rec.cap(0.05);
      if (await page.evaluate(() => !!(window.__game && window.__game.ents.me()))) break;
    }
    await setHud(page, 'full');
    await cheat(page, 1);
    await rec.cap(1.0);
    const m = await me(page);
    await ev(page, ({ x, y }) => window.__game.moveTo(x + 1600, y + 700), m);
    await rec.cap(3.5);
    await rec.stop();
  },

  // 2. cinematic flyby on 1-1, HUD hidden, slow zoom out
  async flyby(page, rec) {
    await setup(page, { hud: 'clean', ship: 'ship_goliath-plus' });
    await zoomTo(page, 1.5, true);
    const m = await me(page);
    await ev(page, ({ x, y }) => window.__game.moveTo(x - 600, y - 400), m);
    await wait(page, 2);
    await ev(page, ({ x, y }) => window.__game.moveTo(x + 3600, y + 1500), m);
    await wait(page, 0.6);
    await rec.start('flyby');
    const T = 9;
    await rec.cap(T, async (i, t) => { const z = smooth(1.5, 0.42, (t - 1) / (T - 1.5)); await page.evaluate((z) => { const w = window.__game.world; w.zoom = w.targetZoom = z; }, z); });
    await rec.stop();
  },

  // 3. combat with HUD (1-3: Lordakia/Saimon/Mordon) - gather a swarm first, then chain kills
  async combat(page, rec) {
    await setup(page, { hud: 'full', dmg: 0.1, ship: 'ship_goliath', design: 'ship_goliath-frost' });
    await warpAndSettle(page, 3);
    await gather(page, { r: 2600, laps: 2 });
    await ev(page, () => { window.__auto.ammo = 'x4'; window.__game.setAmmo('x4'); window.__auto.filter = /Mordon|Saimon|Lordakia/; window.__auto.approach = 380; window.__auto.rsbEvery = 4000; });
    await zoomTo(page, 0.9, true);
    await autoTick(page); await wait(page, 0.5);
    await rec.start('combat');
    let f = 0;
    await rec.cap(16, async () => { if (f++ % 10 === 0) await autoTick(page); });
    await rec.stop();
  },

  // 3b. cinematic combat (no windows, damage numbers on)
  async combat2(page, rec) {
    await setup(page, { hud: 'none', dmg: 0.1, ship: 'ship_hecate-plus' });
    await warpAndSettle(page, 11);
    await gather(page, { r: 2600, laps: 2 });
    await ev(page, () => { window.__auto.ammo = 'x4'; window.__game.setAmmo('x4'); window.__auto.filter = /Mordon|Saimon|Lordakia/; window.__auto.approach = 380; window.__auto.rsbEvery = 3500; });
    await zoomTo(page, 1.15, true);
    await autoTick(page); await wait(page, 0.5);
    await rec.start('combat2');
    let f = 0;
    await rec.cap(14, async () => { if (f++ % 10 === 0) await autoTick(page); });
    await rec.stop();
  },

  // 4a. hangar ships tab with search
  async hangar(page, rec) {
    await setup(page, { hud: 'full' });
    await ev(page, () => window.__game.toggleHangar());
    await wait(page, 0.5);
    await ev(page, () => document.querySelectorAll('.hangar-win .htab')[1].click());
    await ev(page, () => { for (const t of document.querySelectorAll('.hangar-win .panel-title')) if (/Cheats/.test(t.textContent)) t.parentElement.style.display = 'none'; });
    await wait(page, 1.0);
    await rec.start('hangar');
    await rec.cap(1.2);
    const grid = '.hangar-win .grid';
    for (let k = 0; k < 6; k++) { await ev(page, (s) => { const g = document.querySelector(s); g.scrollTop += 120; }, grid); await rec.cap(0.25); }
    await ev(page, (s) => { document.querySelector(s).scrollTop = 0; }, grid);
    const q = 'goliath';
    for (const ch of q) {
      await ev(page, (c) => { const i = document.querySelector('.hangar-win input[type=search]'); i.value += c; i.dispatchEvent(new Event('input')); }, ch);
      await rec.cap(0.1);
    }
    await rec.cap(1.0);
    // click first design card to switch ship
    await ev(page, () => { const c = document.querySelectorAll('.hangar-win .grid .card'); (c[1] || c[0])?.click(); });
    await rec.cap(1.5);
    await rec.stop();
  },

  // 4b. rapid ship switching in-world, ship centered, HUD hidden
  async ships(page, rec) {
    await setup(page, { hud: 'clean' });
    const list = [
      ['ship_goliath', 'ship_goliath-frost'], ['ship_cyborg', 'ship_cyborg-lava'], ['ship_hecate', 'ship_hecate-inferno'],
      ['ship_pusat', 'ship_pusat-lava'], ['ship_tartarus', 'ship_tartarus-dusklight'], ['ship_citadel-plus', null],
      ['ship_diminisher', 'ship_diminisher-argon'], ['ship_solaris', 'ship_solaris-frost'], ['ship_keres', null],
      ['ship_mimesis', 'mimesis-tyrannos'], ['ship_orcus', 'ship_orcus-maelstrom'], ['ship_goliath-plus', 'ship_goliath-plus-psyche'],
    ];
    // preload all models
    for (let rep = 0; rep < 2; rep++) for (const [s, d] of list) { await ev(page, ([s, d]) => window.__game.setShip(s, d || undefined), [s, d]); await wait(page, rep ? 0.5 : 1.2); }
    await waitAssets(page, 3000);
    await ev(page, ([s, d]) => window.__game.setShip(s, d || undefined), list[0]);
    const m = await me(page);
    // slow drift so the ship banks a bit
    await ev(page, ({ x, y }) => window.__game.moveTo(x + 2200, y + 300), m);
    await zoomTo(page, 3.0, true);
    await wait(page, 1);
    await rec.start('ships');
    for (let i = 0; i < list.length; i++) {
      await ev(page, ([s, d]) => window.__game.setShip(s, d || undefined), list[i]);
      await rec.cap(1.2);
    }
    await rec.stop();
  },

  // 5. drone formations
  async formations(page, rec) {
    await setup(page, { hud: 'clean', ship: 'ship_goliath', design: 'ship_goliath-sapphire' });
    await ev(page, () => window.__game.sendRaw({ t: 'formation', id: 'drill' }));
    const m = await me(page);
    await ev(page, ({ x, y }) => window.__game.moveTo(x + 3000, y + 2600), m);
    await wait(page, 9);
    await zoomTo(page, 3.4, true);
    await ev(page, ({ x, y }) => window.__game.moveTo(x + 3000, y + 3400), m);
    await wait(page, 1.5);
    await rec.start('formations');
    await rec.cap(0.8);
    for (const id of ['pincer', 'heart', 'ring', 'wheel', 'star', 'drill']) {
      await ev(page, (id) => window.__game.sendRaw({ t: 'formation', id }), id);
      await rec.cap(1.6);
    }
    await rec.stop();
  },

  // 6. jump CPU warp montage (separate short clips per map)
  async warps(page, rec) {
    await setup(page, { hud: 'clean', ship: 'ship_tartarus', design: 'ship_tartarus-dusklight' });
    const maps = [5, 9, 13, 16, 18, 29, 91, 20];
    for (const mid of maps) {
      await warpAndSettle(page, mid, 1.0);
      const m = await me(page);
      const a = Math.random() * Math.PI * 2;
      await zoomTo(page, 0.75, true);
      await ev(page, ({ x, y, a }) => window.__game.moveTo(x + Math.cos(a) * 2000, y + Math.sin(a) * 2000), { ...m, a });
      await wait(page, 0.5);
      await rec.start(`warp_${mid}`);
      await rec.cap(2.4, async (i, t) => { await page.evaluate((z) => { const w = window.__game.world; w.zoom = w.targetZoom = z; }, 0.75 - t * 0.08); });
      await rec.stop();
    }
  },

  // 7. Cubikon boss fight on 1-6
  async boss(page, rec) {
    await setup(page, { hud: 'none', dmg: 1, ship: 'ship_goliath-x', design: 'ship_goliath-x-lava' });
    await warpAndSettle(page, 18);
    const es = await ents(page);
    const m = await me(page);
    const cubs = es.filter((e) => /Cubikon/.test(e.n)).sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y));
    const c = cubs[0];
    console.log('cubikon', c);
    await ev(page, ({ x, y }) => window.__game.moveTo(x + 520, y + 260), c);
    for (let i = 0; i < 40; i++) { const p = await me(page); if (Math.hypot(p.x - c.x - 520, p.y - c.y - 260) < 60) break; await wait(page, 0.5); }
    await zoomTo(page, 0.62, true);
    await ev(page, (id) => { window.__game.setAmmo('x4'); window.__auto.ammo = 'x4'; window.__auto.approach = 650; window.__game.select(id); window.__game.startAttack(); }, c.id);
    // let protegits come out
    await wait(page, 4);
    await rec.start('boss');
    await rec.cap(7, async (i) => { if (i % 30 === 0) await ev(page, () => { window.__game.startAttack(); window.__game.fireRocket(); }); });
    // crank damage to finish cubikon, then protegits
    await cheat(page, 6);
    await ev(page, () => { window.__auto.filter = /Cubikon/; window.__auto.rsbEvery = 3200; });
    let f = 0;
    await rec.cap(6, async () => { if (f++ % 12 === 0) await autoTick(page); });
    await ev(page, () => { window.__auto.filter = /Protegit/; });
    await rec.cap(7, async () => { if (f++ % 12 === 0) await autoTick(page); });
    await rec.stop();
  },

  // 8. classic 2D renderer
  async r2d(page, rec) {
    await setup(page, { hud: 'clean', renderer: '2d', ship: 'ship_goliath', design: 'ship_goliath-frost' });
    await warpAndSettle(page, 3);
    await ev(page, () => { window.__auto.ammo = 'x4'; window.__game.setAmmo('x4'); window.__auto.filter = /Mordon|Saimon|Lordakia/; });
    for (let i = 0; i < 12; i++) { await autoTick(page); await wait(page, 0.5); }
    await rec.start('r2d');
    let f = 0;
    await rec.cap(5, async () => { if (f++ % 12 === 0) await autoTick(page); });
    await rec.stop();
  },
  async r3d(page, rec) {
    await setup(page, { hud: 'clean', renderer: '3d', ship: 'ship_goliath', design: 'ship_goliath-frost' });
    await warpAndSettle(page, 3);
    await ev(page, () => { window.__auto.ammo = 'x4'; window.__game.setAmmo('x4'); window.__auto.filter = /Mordon|Saimon|Lordakia/; });
    for (let i = 0; i < 12; i++) { await autoTick(page); await wait(page, 0.5); }
    await rec.start('r3d');
    let f = 0;
    await rec.cap(5, async () => { if (f++ % 12 === 0) await autoTick(page); });
    await rec.stop();
  },
};

const names = process.argv.slice(2);
for (const n of names) {
  if (!SHOTS[n]) { console.log('unknown shot', n, Object.keys(SHOTS)); continue; }
  const t0 = Date.now();
  const { browser, page } = await launch();
  const rec = new Recorder(page);
  try { await SHOTS[n](page, rec); } catch (e) { console.log('shot failed', n, e); }
  await page.screenshot({ path: `frames/${n}_end.jpg`, quality: 70 }).catch(() => {});
  await browser.close();
  console.log(`[shot] ${n} done in ${((Date.now() - t0) / 1000).toFixed(0)} s (S=${S})`);
}
