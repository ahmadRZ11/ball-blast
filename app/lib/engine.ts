/*
 * Ball Blast simulation engine.
 *
 * All per-ball state lives in preallocated typed arrays and is updated in place,
 * so a frame is O(n) with zero allocations. Balls only collide with the boundary
 * circle (never each other).
 *
 * Rendering is external: the WebGL scene (Three.js) reads points via fillPoints() and
 * drives the glass ring from `tension`; flash + shockwave are drawn by draw2D() on a
 * Canvas2D overlay. Without WebGL, draw2D() also draws the balls (batched into one path
 * per hue bucket, no per-ball shadowBlur) and a flat ring.
 */

const TAU = Math.PI * 2;

/** Buffer capacity / ball cap with WebGL. */
export const MAX_BALLS = 100_000;
/** Ball cap for the Canvas2D fallback (no WebGL): path rasterization holds ~60fps up to ~2-3k. */
export const FALLBACK_CAP = 2_500;
/** Blast when the balls' combined area reaches this fraction of the circle (or at the cap). */
export const FILL_RATIO = 0.85;
/** Gap between the canvas edge and the outer edge of the glass ring, in css px. */
export const RING_INSET = 6;
/** Glass tube radius as a fraction of the bounce radius (a chunky crystal ring). */
export const RING_TUBE = 0.06;

/** Bounce radius for a given square size: the glass ring (2 tubes thick) fits just inside. */
export function ringRadiusFor(size: number) {
  return (size / 2 - RING_INSET) / (1 + 2 * RING_TUBE);
}
/** At size 1x the radius is chosen so `cap` balls cover this fraction of the circle's area. */
const DENSITY = 0.8;
const BUCKETS = 12;
export const MAX_PARTICLES = MAX_BALLS; // >= 1 spark per ball, so every colour shows in the blast
/** Seconds from the blast until the next round starts (shards fly, ring reforms). */
export const BLAST_SECONDS = 2.4;
/** Once full, hold for a beat (no more spawns, glass shaking and cracking) before blasting. */
export const CRITICAL_SECONDS = 1.1;
export const BUCKET_COUNT = BUCKETS;
/** Ball speed in px per 60fps frame, as a fraction of the circle radius (keeps timing screen-independent). */
const SPEED_PER_R = 0.0095;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class Engine {
  // balls (velocity is a unit vector; speed is applied in step())
  private readonly x = new Float32Array(MAX_BALLS);
  private readonly y = new Float32Array(MAX_BALLS);
  private readonly vx = new Float32Array(MAX_BALLS);
  private readonly vy = new Float32Array(MAX_BALLS);
  private readonly bucket = new Uint8Array(MAX_BALLS);
  n = 0;

  // bucket sort scratch
  private readonly order = new Uint32Array(MAX_BALLS);
  private readonly bStart = new Uint32Array(BUCKETS + 1);
  private readonly bCursor = new Uint32Array(BUCKETS);

  // blast particles (emitted in bucket order, so pStart marks each colour's run)
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly pvx = new Float32Array(MAX_PARTICLES);
  private readonly pvy = new Float32Array(MAX_PARTICLES);
  private readonly ps = new Float32Array(MAX_PARTICLES);
  private readonly pb = new Uint8Array(MAX_PARTICLES);
  private readonly pStart = new Uint32Array(BUCKETS + 1);
  private pn = 0;

  phase: "run" | "blast" = "run";
  /** Ball count at the moment of the last blast (shown in the HUD while particles fly). */
  blastCount = 0;
  private blastT = 0;
  private criticalT = -1; // >= 0 while holding at full
  private clock = 0;

  private side = 0;
  private cx = 0;
  private cy = 0;
  private R = 0;
  private started = false;

  /** Active ball cap (<= MAX_BALLS); the blast triggers here. */
  cap = MAX_BALLS;
  /** Max blast sparks (lower for the Canvas2D fallback, which draws them on the CPU). */
  sparkBudget = MAX_PARTICLES;
  sizeScale = 1;
  speedScale = 1;

  /** Reduced motion: calmer flash / shockwave. */
  calm = false;

  onBlast?: (count: number) => void;
  onReset?: () => void;

  private readonly colors = Array.from(
    { length: BUCKETS },
    (_, i) => `hsl(${Math.round((i * 360) / BUCKETS)} 90% 62%)`,
  );

  get radius() {
    return clamp(this.R * Math.sqrt(DENSITY / this.cap) * this.sizeScale, 0.5, 8);
  }

  /** 0 → 1 progress toward the blast (count cap or area fill, whichever is closer). */
  get fill() {
    if (this.phase === "blast") return 1;
    if (this.R === 0) return 0;
    const r = this.radius;
    const byArea = (this.n * r * r) / (FILL_RATIO * this.R * this.R);
    return Math.min(1, Math.max(this.n / this.cap, byArea));
  }

  /**
   * Stress on the glass: follows fill (0 → 1) while filling, then climbs 1 → 2 through
   * the critical hold. Drives shake amplitude and crack spread.
   */
  get tension() {
    if (this.phase === "blast") return 0;
    if (this.criticalT >= 0) return 1 + Math.min(this.criticalT / CRITICAL_SECONDS, 1);
    return this.fill;
  }

  get ringRadius() {
    return this.R;
  }

  /** side: canvas size in css px; ringR: boundary radius (the canvas bleeds past it for the blast). */
  resize(side: number, ringR: number) {
    const ncx = side / 2;
    const ncy = side / 2;
    const nR = Math.max(ringR, 10);
    if (this.started && this.R > 0) {
      // keep the current state, rescaled into the new circle
      const k = nR / this.R;
      for (let i = 0; i < this.n; i++) {
        this.x[i] = ncx + (this.x[i] - this.cx) * k;
        this.y[i] = ncy + (this.y[i] - this.cy) * k;
      }
      for (let i = 0; i < this.pn; i++) {
        this.px[i] = ncx + (this.px[i] - this.cx) * k;
        this.py[i] = ncy + (this.py[i] - this.cy) * k;
      }
    }
    this.side = side;
    this.cx = ncx;
    this.cy = ncy;
    this.R = nR;

    if (!this.started) {
      this.started = true;
      this.reset();
    }
  }

  reset() {
    const a = Math.random() * TAU;
    this.n = 1;
    this.x[0] = this.cx;
    this.y[0] = this.cy;
    this.vx[0] = Math.cos(a);
    this.vy[0] = Math.sin(a);
    this.bucket[0] = (Math.random() * BUCKETS) | 0;
    this.pn = 0;
    this.phase = "run";
    this.blastT = 0;
    this.criticalT = -1;
    this.onReset?.();
  }

  /** Advance by dt (in 60fps frames). Returns the number of wall hits this step. */
  step(dt: number): number {
    this.clock += dt / 60;
    if (this.phase === "blast") {
      this.stepBlast(dt);
      return 0;
    }

    const { x, y, vx, vy, bucket, cx, cy } = this;
    const r = this.radius;
    const lim = this.R - r;
    const lim2 = lim * lim;
    const sp = this.R * SPEED_PER_R * this.speedScale * dt;
    const n0 = this.n;
    const cap = this.criticalT >= 0 ? n0 : this.cap;
    let n = n0;
    let hits = 0;

    for (let i = 0; i < n0; i++) {
      let bx = x[i] + vx[i] * sp;
      let by = y[i] + vy[i] * sp;
      const dx = bx - cx;
      const dy = by - cy;
      const d2 = dx * dx + dy * dy;

      if (d2 >= lim2) {
        // wall hit: reflect v' = v - 2(v·n)n, clamp back onto the wall, multiply
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        const dot = vx[i] * nx + vy[i] * ny;
        if (dot > 0) {
          vx[i] -= 2 * dot * nx;
          vy[i] -= 2 * dot * ny;
        }
        bx = cx + nx * lim;
        by = cy + ny * lim;
        hits++;

        if (n < cap) {
          // new ball heads inward (within ±75° of the inward normal)
          const a = Math.atan2(-ny, -nx) + (Math.random() - 0.5) * 2.6;
          x[n] = cx + nx * (lim - 0.5);
          y[n] = cy + ny * (lim - 0.5);
          vx[n] = Math.cos(a);
          vy[n] = Math.sin(a);
          bucket[n] = (bucket[i] + 1 + ((Math.random() * 2) | 0)) % BUCKETS;
          n++;
        }
      }
      x[i] = bx;
      y[i] = by;
    }
    this.n = n;

    if (this.criticalT >= 0) {
      this.criticalT += dt / 60;
      if (this.criticalT >= CRITICAL_SECONDS) this.blast();
    } else if (this.fill >= 1) {
      this.criticalT = 0;
    }
    return hits;
  }

  private sortByBucket() {
    const { bStart: s, bCursor: c, bucket, order } = this;
    s.fill(0);
    for (let i = 0; i < this.n; i++) s[bucket[i] + 1]++;
    for (let b = 0; b < BUCKETS; b++) s[b + 1] += s[b];
    c.set(s.subarray(0, BUCKETS));
    for (let i = 0; i < this.n; i++) order[c[bucket[i]]++] = i;
  }

  private blast() {
    this.sortByBucket();
    const count = this.n;
    const budget = Math.min(this.sparkBudget, MAX_PARTICLES);
    const per = clamp(Math.floor(budget / count), 1, 6);
    // over budget: sample every `stride`-th ball across ALL buckets so every colour survives
    const stride = Math.max(1, count / budget);
    const k = this.R / 340;
    let pn = 0;
    let next = 0;
    for (let b = 0; b < BUCKETS; b++) {
      this.pStart[b] = pn;
      for (let j = this.bStart[b]; j < this.bStart[b + 1] && pn < budget; j++) {
        if (j < next) continue;
        next += stride;
        const i = this.order[j];
        const ox = (this.x[i] - this.cx) / this.R;
        const oy = (this.y[i] - this.cy) / this.R;
        for (let q = 0; q < per && pn < budget; q++) {
          const a = Math.random() * TAU;
          const s = (0.4 + Math.random() * 3.2) * k;
          const out = (2 + Math.random() * 5) * k; // radial push away from the centre
          this.px[pn] = this.x[i];
          this.py[pn] = this.y[i];
          this.pvx[pn] = Math.cos(a) * s + ox * out;
          this.pvy[pn] = Math.sin(a) * s + oy * out;
          this.ps[pn] = (0.9 + Math.random() * 1.8) * Math.max(k, 0.6);
          this.pb[pn] = b;
          pn++;
        }
      }
    }
    this.pStart[BUCKETS] = pn;
    this.pn = pn;
    this.n = 0;
    this.blastCount = count;
    this.phase = "blast";
    this.blastT = 0;
    this.criticalT = -1;
    this.onBlast?.(count);
  }

  private stepBlast(dt: number) {
    this.blastT += dt / 60;
    const damp = Math.pow(0.965, dt);
    for (let i = 0; i < this.pn; i++) {
      this.px[i] += this.pvx[i] * dt;
      this.py[i] += this.pvy[i] * dt;
      this.pvx[i] *= damp;
      this.pvy[i] *= damp;
    }
    if (this.blastT >= BLAST_SECONDS) this.reset();
  }

  /**
   * Writes the visible points (balls while running, sparks while blasting) as
   * [x, y, sizeCssPx, bucket] into buf and returns the count. Used by the WebGL scene.
   */
  fillPoints(buf: Float32Array): number {
    if (this.phase === "run") {
      const { x, y, bucket } = this;
      const d = this.radius * 2;
      for (let i = 0, o = 0; i < this.n; i++, o += 4) {
        buf[o] = x[i];
        buf[o + 1] = y[i];
        buf[o + 2] = d;
        buf[o + 3] = bucket[i];
      }
      return this.n;
    }
    for (let i = 0, o = 0; i < this.pn; i++, o += 4) {
      buf[o] = this.px[i];
      buf[o + 1] = this.py[i];
      buf[o + 2] = this.ps[i];
      buf[o + 3] = this.pb[i];
    }
    return this.pn;
  }

  /** Spark opacity during the blast (1 while running). */
  get pointsAlpha() {
    if (this.phase === "run") return 1;
    const life = clamp(1 - this.blastT / BLAST_SECONDS, 0, 1);
    return life * life * (3 - 2 * life); // smoothstep fade
  }

  /**
   * Canvas2D overlay. In the 2D fallback it draws everything (balls/sparks, flat ring,
   * flash + shockwave); in WebGL mode only a soft flash (bloom + light do the rest).
   */
  draw2D(ctx: CanvasRenderingContext2D, opts: { points: boolean; ring: boolean }) {
    ctx.clearRect(0, 0, this.side, this.side);
    if (this.phase === "run") {
      if (opts.points) this.drawBalls2D(ctx);
    } else {
      if (opts.points) this.drawSparks2D(ctx);
      this.drawBlastFx(ctx, opts.ring);
    }
    if (opts.ring) this.drawRing(ctx);
  }

  private drawBalls2D(ctx: CanvasRenderingContext2D) {
    this.sortByBucket();
    const { x, y, order, bStart } = this;
    const r = this.radius;
    for (let b = 0; b < BUCKETS; b++) {
      const end = bStart[b + 1];
      if (bStart[b] === end) continue;
      ctx.fillStyle = this.colors[b];
      ctx.beginPath();
      for (let j = bStart[b]; j < end; j++) {
        const i = order[j];
        ctx.moveTo(x[i] + r, y[i]);
        ctx.arc(x[i], y[i], r, 0, TAU);
      }
      ctx.fill();
    }
  }

  private drawSparks2D(ctx: CanvasRenderingContext2D) {
    ctx.globalAlpha = this.pointsAlpha;
    for (let b = 0; b < BUCKETS; b++) {
      const end = this.pStart[b + 1];
      if (this.pStart[b] === end) continue;
      ctx.fillStyle = this.colors[b];
      ctx.beginPath();
      for (let i = this.pStart[b]; i < end; i++) {
        const s = this.ps[i];
        ctx.rect(this.px[i] - s / 2, this.py[i] - s / 2, s, s);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** White flash + expanding shockwave at the moment of the blast (toned down when calm). */
  private drawBlastFx(ctx: CanvasRenderingContext2D, shockwave: boolean) {
    const { cx, cy, R } = this;
    const t = this.blastT;
    const k = (this.calm ? 0.3 : 1) * (shockwave ? 1 : 0.45);

    if (t < 0.22) {
      ctx.fillStyle = `rgba(235,245,255,${0.55 * k * (1 - t / 0.22)})`;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.15, 0, TAU);
      ctx.fill();
    }
    if (shockwave && t < 0.7) {
      const u = t / 0.7;
      const ease = 1 - (1 - u) * (1 - u) * (1 - u);
      ctx.beginPath();
      ctx.arc(cx, cy, R * (0.1 + 1.2 * ease), 0, TAU);
      ctx.lineWidth = 2 + 8 * (1 - u);
      ctx.strokeStyle = `rgba(220,240,255,${0.75 * k * (1 - u)})`;
      ctx.stroke();
    }
  }

  /** Flat 2D boundary ring (fallback only). Shifts cyan → red and pulses near full. */
  private drawRing(ctx: CanvasRenderingContext2D) {
    if (this.phase === "blast") return;
    const t = clamp((this.fill - 0.6) / 0.4, 0, 1);
    const pulse = t > 0 ? 0.75 + 0.25 * Math.sin(this.clock * (6 + t * 10)) : 1;
    const cr = Math.round(110 + (248 - 110) * t);
    const cg = Math.round(200 + (113 - 200) * t);
    const cb = Math.round(255 + (113 - 255) * t);
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.R, 0, TAU);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.55 + 0.4 * t * pulse})`;
    ctx.shadowColor = `rgba(${cr},${cg},${cb},${0.55 * pulse})`;
    ctx.shadowBlur = 14 + 14 * t;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
