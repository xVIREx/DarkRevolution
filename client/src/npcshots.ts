// Alien shot graphics (DO game.xml laserDefinitions): most aliens fire the plain red laser, these
// have their own projectile. The server sends alien shots as `x1`; the client picks the look.
const SHOTS: [RegExp, string][] = [
  [/sibelon/i, 'sibelonShot'],
  [/devolarium/i, 'devolariumShot'],
  [/lordakium/i, 'lordakiumShot'],
  [/protegit/i, 'protegitShot'],
  [/kristallin/i, 'crystal_blue'],
  [/kristallon/i, 'crystal_red'],
];

export const NPC_SHOT_KEYS = new Set(SHOTS.map((s) => s[1]));

/** Shot key for an alien by name, or null for the standard laser. */
export function npcShot(name: string | undefined): string | null {
  if (!name) return null;
  return SHOTS.find(([re]) => re.test(name))?.[1] ?? null;
}
