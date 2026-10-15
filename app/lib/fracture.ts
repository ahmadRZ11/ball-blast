/*
 * Procedural glass fracture for the torus ring (scene units = css px, ring centred at the
 * origin in the XY plane, +Z toward the camera).
 *
 *  - buildCracks(): jagged stress-fracture polylines on the ring's camera-facing surface
 *    as one LineSegments geometry. Each vertex carries `a_t`, the tension at which that
 *    bit of crack appears, so one uniform grows every crack progressively on the GPU.
 *  - buildShards(): the torus VOLUME cut into irregular solid wedges. Cuts around the ring
 *    are jagged and unevenly spaced, and each slice is split into 2–4 pieces around the
 *    tube's cross-section. Shards share their cut surfaces with their neighbours, so
 *    together they rebuild the ring exactly: swapping ring → shards at the break is seamless.
 */

import * as THREE from "three";

const TAU = Math.PI * 2;

/** Small deterministic PRNG so the fracture pattern is stable for a given ring size. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Point on/in the torus: θ around the ring, φ around the tube, r distance from the tube's core. */
function torusPoint(theta: number, phi: number, r: number, major: number, out: THREE.Vector3) {
  const ring = major + r * Math.cos(phi);
  return out.set(Math.cos(theta) * ring, Math.sin(theta) * ring, r * Math.sin(phi));
}

export const CRACK_START = 0.6; // tension where the first crack appears
export const CRACK_END = 1.9; // tension where the last crack starts

export function buildCracks(major: number, tube: number, count = 30) {
  const rand = rng(0xc0ffee);
  const pos: number[] = [];
  const reveal: number[] = [];
  const starts: number[] = [];
  const step = tube * 0.7;
  const lift = tube * 1.015; // just above the glass surface
  const v = new THREE.Vector3();

  // φ ∈ [0.15π, 0.85π] keeps cracks on the camera-facing half of the tube
  const push = (theta: number, phi: number) => {
    torusPoint(theta, phi, lift, major, v);
    pos.push(v.x, v.y, v.z);
  };

  const walk = (theta: number, phi: number, dir: number, len: number, t0: number, branch: boolean) => {
    for (let k = 0; k < len; k++) {
      const nTheta = theta + (dir * step * (0.5 + rand())) / major;
      const nPhi = Math.max(0.12 * Math.PI, Math.min(0.88 * Math.PI, phi + (rand() - 0.5) * 0.9));
      push(theta, phi);
      push(nTheta, nPhi);
      const a = t0 + (k / len) * 0.22;
      const b = t0 + ((k + 1) / len) * 0.22;
      reveal.push(a, b);
      if (branch && k > 1 && rand() < 0.3) walk(nTheta, nPhi, rand() < 0.5 ? dir : -dir, 2 + ((rand() * len) / 2) | 0, b, false);
      theta = nTheta;
      phi = nPhi;
    }
  };

  for (let i = 0; i < count; i++) {
    // later cracks bunch up toward the critical hold, so the build-up accelerates
    const t0 = CRACK_START + (CRACK_END - CRACK_START) * Math.pow(i / (count - 1), 0.8);
    starts.push(t0);
    walk(rand() * TAU, (0.2 + rand() * 0.6) * Math.PI, rand() < 0.5 ? -1 : 1, 6 + ((rand() * 9) | 0), t0, true);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("a_t", new THREE.Float32BufferAttribute(reveal, 1));
  return { geometry: g, starts };
}

export type Shard = {
  geometry: THREE.BufferGeometry;
  edges: THREE.EdgesGeometry;
  /** rest position (shard geometry is centred on it so it spins about its own middle) */
  center: THREE.Vector3;
  /** angle around the ring, used to stagger the break outward from the break point */
  theta: number;
};

export function buildShards(major: number, tube: number): Shard[] {
  const rand = rng(0x5eed);
  const core = tube * 0.12; // wedges almost meet at the tube's centre line

  // uneven cuts around the ring: real glass breaks into pieces of very different sizes
  const cuts: { base: number; a1: number; f1: number; p1: number; a2: number; p2: number }[] = [];
  for (let a = rand() * 0.2; a < TAU - 0.06; a += 0.06 + rand() * 0.2) {
    // each cut wanders as it goes around the tube (jagged, angled break surface)
    cuts.push({ base: a, a1: 0.012 + rand() * 0.03, f1: 1 + ((rand() * 2) | 0), p1: rand() * TAU, a2: rand() * 0.012, p2: rand() * TAU });
  }
  const cutAt = (k: number, phi: number) => {
    const c = cuts[k % cuts.length];
    const wrap = k >= cuts.length ? TAU : 0;
    return c.base + wrap + c.a1 * Math.sin(phi * c.f1 + c.p1) + c.a2 * Math.sin(phi * 3 + c.p2);
  };

  const shards: Shard[] = [];
  const v = new THREE.Vector3();

  for (let k = 0; k < cuts.length; k++) {
    // split this slice around the tube into 2–4 sectors of random widths
    const n = 2 + Math.floor(rand() * 3);
    const w = Array.from({ length: n }, () => 0.4 + rand());
    const sum = w.reduce((a, b) => a + b, 0);
    let phi0 = rand() * TAU;
    for (let s = 0; s < n; s++) {
      const phi1 = phi0 + (w[s] / sum) * TAU;
      shards.push(wedge(k, phi0, phi1));
      phi0 = phi1;
    }
  }
  return shards;

  function wedge(k: number, phiA: number, phiB: number): Shard {
    const NT = 3;
    const NP = Math.max(2, Math.ceil((phiB - phiA) / (Math.PI / 5)));
    const grid = (r: number) =>
      Array.from({ length: NT + 1 }, (_, i) =>
        Array.from({ length: NP + 1 }, (_, j) => {
          const phi = phiA + ((phiB - phiA) * j) / NP;
          const tA = cutAt(k, phi);
          const tB = cutAt(k + 1, phi);
          return torusPoint(tA + ((tB - tA) * i) / NT, phi, r, major, v).clone();
        }),
      );
    const O = grid(tube);
    const I = grid(core);

    const tris: THREE.Vector3[][] = [];
    const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
      tris.push([a, b, c], [a, c, d]);
    };
    for (let i = 0; i < NT; i++)
      for (let j = 0; j < NP; j++) {
        quad(O[i][j], O[i + 1][j], O[i + 1][j + 1], O[i][j + 1]); // outer glass surface
        quad(I[i][j], I[i + 1][j], I[i + 1][j + 1], I[i][j + 1]); // inner core face
      }
    for (let i = 0; i < NT; i++) {
      quad(O[i][0], O[i + 1][0], I[i + 1][0], I[i][0]); // break face (sector start)
      quad(O[i][NP], O[i + 1][NP], I[i + 1][NP], I[i][NP]); // break face (sector end)
    }
    for (let j = 0; j < NP; j++) {
      quad(O[0][j], O[0][j + 1], I[0][j + 1], I[0][j]); // jagged cut (slice start)
      quad(O[NT][j], O[NT][j + 1], I[NT][j + 1], I[NT][j]); // jagged cut (slice end)
    }

    // centre on the shard's middle and orient every face outward
    const center = new THREE.Vector3();
    let count = 0;
    for (const row of [...O, ...I]) {
      for (const p of row) {
        center.add(p);
        count++;
      }
    }
    center.divideScalar(count);

    const pos = new Float32Array(tris.length * 9);
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const mid = new THREE.Vector3();
    tris.forEach(([a, b, c], t) => {
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      mid.copy(a).add(b).add(c).divideScalar(3).sub(center);
      const flip = ab.cross(ac).dot(mid) < 0;
      const order = flip ? [a, c, b] : [a, b, c];
      order.forEach((p, q) => pos.set([p.x - center.x, p.y - center.y, p.z - center.z], t * 9 + q * 3));
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.computeVertexNormals(); // non-indexed → flat facets, like a cut crystal
    const theta = Math.atan2(center.y, center.x);
    return { geometry, edges: new THREE.EdgesGeometry(geometry, 35), center, theta: theta < 0 ? theta + TAU : theta };
  }
}
