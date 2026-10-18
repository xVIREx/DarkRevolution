import * as THREE from 'three';
import { glowTexture } from './sprites3d';

const matCache = new Map<string, THREE.ShaderMaterial>();

/** Shared additive ribbon material (TrailRenderer-like: fades with age, soft across the width). */
export function trailMaterial(color: THREE.ColorRepresentation, intensity = 1.6, tex: THREE.Texture | null = null): THREE.ShaderMaterial {
  const c = new THREE.Color(color);
  const key = `${c.getHexString()}|${intensity}|${tex?.uuid ?? ''}`;
  let m = matCache.get(key);
  if (m) return m;
  m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: c }, uInt: { value: intensity }, uMap: { value: tex ?? glowTexture() }, uHasMap: { value: tex ? 1 : 0 } },
    vertexShader: `
      attribute float aAge;
      attribute float aSide;
      varying float vAge;
      varying float vSide;
      void main() {
        vAge = aAge; vSide = aSide;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uInt; uniform sampler2D uMap; uniform float uHasMap;
      varying float vAge; varying float vSide;
      void main() {
        float a = pow(clamp(1.0 - vAge, 0.0, 1.0), 1.6);
        float across;
        if (uHasMap > 0.5) across = texture2D(uMap, vec2(vAge, vSide * 0.5 + 0.5)).a;
        else across = smoothstep(1.0, 0.0, abs(vSide));
        vec3 col = uColor * uInt * a * across;
        // hot white core near the head
        col += vec3(1.0) * a * a * smoothstep(0.6, 0.0, abs(vSide)) * 0.35 * uInt;
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  matCache.set(key, m);
  return m;
}

/** Camera-facing ribbon following a moving point. */
export class Ribbon {
  readonly mesh: THREE.Mesh;
  private pts: { p: THREE.Vector3; t: number }[] = [];
  private pos: Float32Array;
  private age: Float32Array;
  private geo: THREE.BufferGeometry;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();

  constructor(material: THREE.Material, private readonly max = 24, public width = 10, public life = 350, private readonly minStep = 6) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 2 * 3);
    this.age = new Float32Array(max * 2);
    const side = new Float32Array(max * 2);
    for (let i = 0; i < max; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    const idx: number[] = [];
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  reset(): void {
    this.pts.length = 0;
    this.geo.setDrawRange(0, 0);
  }

  /** push the current head position (world) and rebuild against the camera */
  update(head: THREE.Vector3, now: number, camPos: THREE.Vector3, widthScale = 1): void {
    const pts = this.pts;
    const last = pts[0];
    if (!last || last.p.distanceToSquared(head) > this.minStep * this.minStep) {
      pts.unshift({ p: head.clone(), t: now });
      if (pts.length > this.max) pts.length = this.max;
    } else {
      last.p.copy(head);
    }
    while (pts.length > 1 && now - pts[pts.length - 1].t > this.life) pts.pop();
    const n = pts.length;
    if (n < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    const w = this.width * widthScale;
    for (let i = 0; i < n; i++) {
      const p = pts[i].p;
      const a = pts[Math.max(0, i - 1)].p;
      const b = pts[Math.min(n - 1, i + 1)].p;
      const tan = this.tmpA.subVectors(a, b);
      if (tan.lengthSq() < 1e-6) tan.set(1, 0, 0);
      const view = this.tmpB.subVectors(camPos, p);
      const side = this.tmpC.crossVectors(tan, view).normalize();
      const k = i === 0 ? 0 : Math.min(1, (now - pts[i].t) / this.life);
      const ww = w * (1 - k * 0.6) * 0.5;
      const o = i * 6;
      this.pos[o] = p.x - side.x * ww; this.pos[o + 1] = p.y - side.y * ww; this.pos[o + 2] = p.z - side.z * ww;
      this.pos[o + 3] = p.x + side.x * ww; this.pos[o + 4] = p.y + side.y * ww; this.pos[o + 5] = p.z + side.z * ww;
      this.age[i * 2] = this.age[i * 2 + 1] = k;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aAge as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
  }
}
