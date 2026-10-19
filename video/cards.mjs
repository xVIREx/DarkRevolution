// Render title cards / lower thirds as transparent 1920x1080 PNGs.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
const FONT = path.resolve('../client/public/assets/ui/fonts/EurostileTMed.ttf');
const css = `
@font-face { font-family: Euro; src: url(data:font/ttf;base64,${fs.readFileSync(FONT).toString('base64')}); }
html,body { margin:0; width:1920px; height:1080px; background:transparent; font-family: Euro, 'DejaVu Sans', sans-serif; color:#fff; overflow:hidden; }
.center { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
.title { font-size:150px; letter-spacing:22px; font-weight:bold; text-shadow: 0 0 40px rgba(255,120,40,.55), 0 0 4px #000; }
.title span { color:#ff7a2a; }
.sub { margin-top:18px; font-size:46px; letter-spacing:16px; color:#cfe8ff; text-shadow:0 0 20px rgba(80,180,255,.6), 0 0 3px #000; }
.rule { width:900px; height:3px; margin:28px 0 10px; background:linear-gradient(90deg, transparent, #ff7a2a, #4fc3ff, transparent); }
.small { font-size:30px; letter-spacing:6px; color:#9fb6c8; margin-top:14px; text-shadow:0 0 3px #000; }
.disc { position:absolute; bottom:60px; width:100%; text-align:center; font-size:26px; letter-spacing:3px; color:#8a9aa8; }
.lt { position:absolute; left:110px; bottom:120px; padding:18px 34px 20px 30px; border-left:6px solid #ff7a2a;
      background:linear-gradient(90deg, rgba(4,12,22,.82), rgba(4,12,22,.55) 70%, rgba(4,12,22,0)); min-width:760px; }
.lt.right { left:auto; right:110px; border-left:none; border-right:6px solid #4fc3ff; text-align:right; background:linear-gradient(270deg, rgba(4,12,22,.82), rgba(4,12,22,.55) 70%, rgba(4,12,22,0)); }
.lt .h { font-size:60px; letter-spacing:6px; font-weight:bold; text-shadow:0 0 18px rgba(255,140,60,.45); }
.lt .h b { color:#ff7a2a; }
.lt .s { font-size:30px; letter-spacing:3px; color:#bfe0ff; margin-top:6px; }
.tag { position:absolute; top:60px; left:0; width:100%; text-align:center; font-size:64px; letter-spacing:12px; font-weight:bold; text-shadow:0 0 24px rgba(79,195,255,.6), 0 0 4px #000; }
`;
const cards = {
  title: `<div class="center"><div class="title">DARK<span>ORBIT</span></div><div class="rule"></div><div class="sub">REBUILT FROM SCRATCH</div></div>`,
  browser: `<div class="center"><div class="sub" style="font-size:40px;letter-spacing:10px">THE FLASH VERSION IS GONE.</div><div class="title" style="font-size:96px;letter-spacing:10px;margin-top:20px">IT RUNS IN THE <span>BROWSER</span> AGAIN</div><div class="rule"></div><div class="small">three.js · WebGL2 · no Flash · no download</div></div>`,
  lt_rust: `<div class="lt"><div class="h">SERVER WRITTEN IN <b>RUST</b></div><div class="s">tokio + axum · authoritative 20 Hz simulation</div></div>`,
  lt_browser: `<div class="lt"><div class="h">RUNS IN YOUR <b>BROWSER</b></div><div class="s">three.js / WebGL2 client · no plugins</div></div>`,
  lt_assets: `<div class="lt right"><div class="h">ASSETS REVERSE-ENGINEERED</div><div class="s">models, maps &amp; sounds from the Unity client</div></div>`,
  lt_combat: `<div class="lt"><div class="h">CLASSIC <b>COMBAT</b></div><div class="s">lasers · drones · rockets · RSB-75</div></div>`,
  lt_ships: `<div class="lt"><div class="h"><b>81</b> SHIPS · <b>412</b> DESIGNS</div><div class="s">every ship free to fly · switch instantly</div></div>`,
  lt_drones: `<div class="lt right"><div class="h">REAL DRONE FORMATIONS</div><div class="s">Drill · Pincer · Heart · Ring · Wheel · Star</div></div>`,
  lt_maps: `<div class="lt"><div class="h"><b>32</b> MAPS · JUMP CPU</div><div class="s">1-1 to 5-3 · every faction · every sector</div></div>`,
  lt_boss: `<div class="lt right"><div class="h">BOSS FIGHTS</div><div class="s">Cubikon releases its Protegit swarm</div></div>`,
  lt_2d: `<div class="tag" style="top:auto;bottom:70px">MODERN 3D <span style="color:#ff7a2a">·</span> CLASSIC 2D</div>`,
  end: `<div class="center"><div class="title" style="font-size:120px">DARK<span>ORBIT</span></div><div class="rule"></div><div class="sub" style="font-size:40px">REBUILT FROM SCRATCH</div>
        <div class="small" style="margin-top:40px">Rust server · three.js client · plays in the browser</div></div>
        <div class="disc">Unofficial fan project — not affiliated with or endorsed by Bigpoint. DarkOrbit is a trademark of Bigpoint GmbH.</div>`,
};
const b = await chromium.launch({ channel: 'chrome', args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
for (const [k, html] of Object.entries(cards)) {
  await p.setContent(`<html><head><style>${css}</style></head><body>${html}</body></html>`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(150);
  await p.screenshot({ path: `cards/${k}.png`, omitBackground: true });
}
await b.close();
console.log('ok');
