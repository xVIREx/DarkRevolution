/** Renderer selection: 3D (default) or classic 2D sprites. `?r=2d` / `?r=3d` in the URL or localStorage `do.renderer`. */
export type RendererMode = '2d' | '3d';

const KEY = 'do.renderer';

export function rendererMode(): RendererMode {
  try {
    const q = new URLSearchParams(window.location.search).get('r');
    if (q === '2d' || q === '3d') return q;
  } catch { /* ignore */ }
  try {
    const s = window.localStorage.getItem(KEY);
    if (s === '2d' || s === '3d') return s;
  } catch { /* ignore */ }
  // no WebGL2 -> 2D
  try {
    const c = document.createElement('canvas');
    if (!c.getContext('webgl2')) return '2d';
  } catch { return '2d'; }
  return '3d';
}

/** Persist the choice and reload (the renderer is chosen at boot). Settings UI can call this. */
export function setRendererMode(m: RendererMode, reload = true): void {
  try { window.localStorage.setItem(KEY, m); } catch { /* ignore */ }
  if (!reload) return;
  const u = new URL(window.location.href);
  u.searchParams.delete('r');
  window.location.href = u.toString();
}

(window as unknown as { __setRenderer?: (m: RendererMode) => void }).__setRenderer = (m) => setRendererMode(m);

/** "3D graphics" checkbox in the Settings window (reloads into the chosen renderer). */
export function registerRendererToggle(add: (t: { label: string; get(): boolean; set(v: boolean): void }) => void): void {
  add({
    label: '3D graphics (modern client)',
    get: () => rendererMode() === '3d',
    set: (v) => setRendererMode(v ? '3d' : '2d'),
  });
}
