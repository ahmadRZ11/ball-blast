/*
 * Sound effects (Web Audio API): synthesized ticks / tinks / booms, plus one recorded
 * cinematic glass hit for the shatter (public/sounds, decoded once into an AudioBuffer).
 * The AudioContext is only created inside unlock(), which must be called from a
 * user gesture (click / tap / key) so it is autoplay-policy safe.
 */

const MASTER_VOLUME = 0.5;
/** Recorded glass-break hit played at the shatter. */
const GLASS_HIT_URL = "/sounds/glass-cinematic-hit.mp3";
/** It is already mastered, so it skips the compressor and gets its own (lower) level. */
const GLASS_HIT_VOLUME = 0.55;

type AudioCtor = typeof AudioContext;

export class Sfx {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private fileOut: GainNode | null = null;
  private glassHit: AudioBuffer | null = null;
  private glassHitLoading = false;
  private muted = false;
  private nextPopAt = 0;
  private nextTinkAt = 0;

  unlock() {
    if (!this.ctx) {
      const Ctor: AudioCtor | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      const out = ctx.createGain();
      out.gain.value = this.muted ? 0 : MASTER_VOLUME;
      out.connect(comp).connect(ctx.destination);

      const len = Math.floor(ctx.sampleRate * 1.5);
      const noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      const fileOut = ctx.createGain();
      fileOut.gain.value = this.muted ? 0 : GLASS_HIT_VOLUME;
      fileOut.connect(ctx.destination);

      this.ctx = ctx;
      this.out = out;
      this.fileOut = fileOut;
      this.noise = noise;
      this.loadGlassHit(ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Fetch + decode the recorded glass hit; until it is ready, shatter() falls back to synthesis. */
  private loadGlassHit(ctx: AudioContext) {
    if (this.glassHit || this.glassHitLoading) return;
    this.glassHitLoading = true;
    fetch(GLASS_HIT_URL)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => ctx.decodeAudioData(data))
      .then((buf) => {
        this.glassHit = buf;
      })
      .catch(() => {
        this.glassHitLoading = false; // keep the synthesized shatter; retry on a later unlock
      });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ctx && this.fileOut) this.fileOut.gain.setTargetAtTime(muted ? 0 : GLASS_HIT_VOLUME, this.ctx.currentTime, 0.03);
    if (this.ctx && this.out) this.out.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, this.ctx.currentTime, 0.03);
  }

  /** The live audio graph, or null when muted / not yet unlocked. */
  private graph() {
    const { ctx, out, noise } = this;
    if (this.muted || !ctx || !out || !noise || ctx.state !== "running") return null;
    return { ctx, out, noise };
  }

  /**
   * Called on frames with wall hits. Throttled: at most one pop per gap, and the gap
   * widens (and the pop softens) as the circle fills, so thousands of hits stay pleasant.
   * Pitch rises with fill to build tension.
   */
  hit(fill: number) {
    const g0 = this.graph();
    if (!g0) return;
    const { ctx, out } = g0;
    const t = ctx.currentTime;
    if (t < this.nextPopAt) return;
    this.nextPopAt = t + 0.055 + fill * 0.14;

    const freq = 480 + fill * 620 + Math.random() * 90;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.55, t + 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 * (1 - 0.55 * fill), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  /** Explosion: filtered noise sweep + sub-bass drop + short high crack. */
  boom() {
    const g0 = this.graph();
    if (!g0) return;
    const { ctx, out, noise } = g0;
    const t = ctx.currentTime;

    const body = ctx.createBufferSource();
    body.buffer = noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 1.0);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(0.8, t + 0.01);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    body.connect(lp).connect(bg).connect(out);
    body.start(t);
    body.stop(t + 1.4);

    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(120, t);
    sub.frequency.exponentialRampToValueAtTime(36, t + 0.7);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(0.75, t + 0.01);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    sub.connect(sg).connect(out);
    sub.start(t);
    sub.stop(t + 1);

    const crack = ctx.createBufferSource();
    crack.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1500;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.3, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    crack.connect(hp).connect(cg).connect(out);
    crack.start(t, 0.3);
    crack.stop(t + 0.1);
  }

  /**
   * Glass "tink": a few inharmonic sine partials (like a struck glass) with a fast
   * attack and a short ring. Throttled so a burst of cracks doesn't pile up.
   */
  tink(gain = 0.07, when = 0) {
    const g0 = this.graph();
    if (!g0) return;
    const { ctx, out } = g0;
    const t = ctx.currentTime + when;
    if (when === 0) {
      if (t < this.nextTinkAt) return;
      this.nextTinkAt = t + 0.06;
    }
    const f = 2100 + Math.random() * 1700;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.18 + Math.random() * 0.15);
    env.connect(out);
    for (const [ratio, level] of [[1, 1], [2.76, 0.5], [5.4, 0.25]] as const) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.frequency.value = f * ratio;
      og.gain.value = level;
      o.connect(og).connect(env);
      o.start(t);
      o.stop(t + 0.36);
    }
  }

  /**
   * Glass shatter: the recorded cinematic hit if loaded, otherwise synthesized
   * (bright noise crash + a spray of falling tinkles + a soft low thump).
   */
  shatter() {
    const g0 = this.graph();
    if (!g0) return;
    const { ctx, out, noise } = g0;
    const t = ctx.currentTime;

    // the recorded cinematic glass hit, when it has loaded
    if (this.glassHit && this.fileOut) {
      const src = ctx.createBufferSource();
      src.buffer = this.glassHit;
      src.connect(this.fileOut);
      src.start(t);
      return;
    }
    if (this.ctx) this.loadGlassHit(this.ctx);

    // the break: band-limited noise with a sharp attack and fast decay
    const crash = ctx.createBufferSource();
    crash.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2200;
    const peak = ctx.createBiquadFilter();
    peak.type = "peaking";
    peak.frequency.value = 5200;
    peak.gain.value = 8;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, t);
    cg.gain.linearRampToValueAtTime(0.55, t + 0.004);
    cg.gain.exponentialRampToValueAtTime(0.08, t + 0.12);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    crash.connect(hp).connect(peak).connect(cg).connect(out);
    crash.start(t);
    crash.stop(t + 1);

    // shards landing: scattered tinks thinning out over ~0.9s
    for (let i = 0; i < 16; i++) {
      const when = 0.02 + Math.pow(Math.random(), 1.6) * 0.9;
      this.tink(0.05 * (1 - when * 0.7), when);
    }

    // body: a short low thump so it still feels like a burst
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(140, t);
    sub.frequency.exponentialRampToValueAtTime(45, t + 0.35);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(0.45, t + 0.008);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    sub.connect(sg).connect(out);
    sub.start(t);
    sub.stop(t + 0.55);
  }
}
