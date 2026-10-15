"use client";

import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Engine, FALLBACK_CAP, MAX_BALLS, ringRadiusFor } from "../lib/engine";
import { Sfx } from "../lib/sfx";
import type { GlassApi } from "./glass/GlassRing";

// Three.js stays out of the server bundle and the first paint; it streams in client-side
const GlassScene = dynamic(() => import("./glass/GlassScene"), { ssr: false });

type Stats = { count: number; fill: number; fps: number; blasting: boolean };
/** "glass": Three.js scene (glass ring + balls); "2d": plain Canvas2D fallback (no WebGL). */
type Mode = "pending" | "glass" | "2d";

/** Canvases extend past the circle so blast sparks / shards can fly out (faded by a CSS mask). */
const BLEED = 1.3;
const HUD_INTERVAL_MS = 150; // React only re-renders the HUD ~7x/sec, never per spawn
const MUTE_KEY = "ballblast:muted";

const fmt = new Intl.NumberFormat("en-US");

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** If the 3D scene throws (driver issue, context failure…), drop to the 2D version instead of crashing. */
class GlassBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function BallBlast() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const glassRef = useRef<HTMLDivElement | null>(null); // Three.js layer
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // flash / shockwave overlay (+ everything in 2D mode)
  const engineRef = useRef<Engine | null>(null);
  const sfxRef = useRef<Sfx | null>(null);
  const glassApi = useRef<GlassApi>(null);
  const pausedRef = useRef(false);
  const dirtyRef = useRef(true);
  const modeRef = useRef<Mode>("pending");
  const frameMsRef = useRef(1000 / 60);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [mode, setMode] = useState<Mode>("pending");
  const [layout, setLayout] = useState({ side: 0, ringR: 0 });
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [size, setSize] = useState(1);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [cap, setCap] = useState(MAX_BALLS);
  const [stats, setStats] = useState<Stats>({ count: 1, fill: 0, fps: 0, blasting: false });

  if (!engineRef.current) engineRef.current = new Engine();
  if (!sfxRef.current) sfxRef.current = new Sfx();

  /**
   * One simulation step + overlay draw. Driven by the Three.js frame loop in glass mode,
   * or by our own rAF loop in 2D mode, so there is only ever one loop running.
   */
  const tick = useRef((deltaSeconds: number) => {
    const engine = engineRef.current!;
    const ctx = ctxRef.current;
    if (!ctx) return;
    const twoD = modeRef.current === "2d";
    if (pausedRef.current) {
      if (dirtyRef.current) engine.draw2D(ctx, { points: twoD, ring: twoD });
      dirtyRef.current = false;
      return;
    }
    const ms = Math.min(deltaSeconds * 1000, 100);
    frameMsRef.current += (ms - frameMsRef.current) * 0.05;
    const dt = Math.min(ms / (1000 / 60), 3); // frame-rate independent, capped after stalls
    const hits = engine.step(dt);
    if (hits) sfxRef.current!.hit(engine.fill);
    engine.draw2D(ctx, { points: twoD, ring: twoD });
  }).current;

  // ---- setup (mounted once; settings flow in through refs) ----
  useEffect(() => {
    const wrap = wrapRef.current;
    const glass = glassRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const engine = engineRef.current;
    const sfx = sfxRef.current;
    if (!wrap || !glass || !canvas || !ctx || !engine || !sfx) return;
    ctxRef.current = ctx;

    // initial prefs: reduced motion starts paused + muted and calms the effects; mute persists
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let storedMute: string | null = null;
    try {
      storedMute = localStorage.getItem(MUTE_KEY);
    } catch {}
    const startMuted = storedMute === null ? reduce : storedMute === "1";
    setReducedMotion(reduce);
    engine.calm = reduce;
    setMuted(startMuted);
    sfx.setMuted(startMuted);
    pausedRef.current = reduce;
    setPaused(reduce);

    engine.onBlast = () => {
      if (modeRef.current === "glass") {
        sfx.shatter();
        glassApi.current?.shatter();
      } else sfx.boom();
    };
    engine.onReset = () => glassApi.current?.reform();

    const fit = () => {
      const wrapSide = Math.floor(wrap.clientWidth);
      if (wrapSide <= 0) return;
      const side = Math.round(wrapSide * BLEED);
      const offset = `${-(side - wrapSide) / 2}px`;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(side * dpr);
      canvas.height = Math.round(side * dpr);
      for (const el of [glass, canvas]) {
        el.style.width = `${side}px`;
        el.style.height = `${side}px`;
        el.style.left = offset;
        el.style.top = offset;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ringR = ringRadiusFor(wrapSide);
      wrap.style.setProperty("--disc-inset", `${wrapSide / 2 - ringR}px`);
      engine.resize(side, ringR);
      setLayout((l) => (l.side === side && l.ringR === ringR ? l : { side, ringR }));
      dirtyRef.current = true;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    fit();

    const glassOk = hasWebGL();
    modeRef.current = glassOk ? "glass" : "2d";
    setMode(modeRef.current);

    // throttled HUD sync
    const hud = window.setInterval(() => {
      const blasting = engine.phase === "blast";
      const next: Stats = {
        count: blasting ? engine.blastCount : engine.n,
        fill: engine.fill,
        fps: pausedRef.current ? 0 : Math.round(1000 / frameMsRef.current),
        blasting,
      };
      setStats((p) =>
        p.count === next.count && p.fps === next.fps && p.blasting === next.blasting && Math.abs(p.fill - next.fill) < 0.002
          ? p
          : next,
      );
    }, HUD_INTERVAL_MS);

    // audio unlocks on the first user gesture
    const unlock = () => sfx.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    return () => {
      window.clearInterval(hud);
      ro.disconnect();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      engine.onBlast = undefined;
      engine.onReset = undefined;
    };
  }, []);

  // ---- per-mode: ball cap, and our own rAF loop only in 2D mode ----
  useEffect(() => {
    modeRef.current = mode;
    if (mode === "pending") return;
    const engine = engineRef.current!;
    engine.cap = mode === "glass" ? MAX_BALLS : FALLBACK_CAP;
    // glass mode: a lighter spark cloud so the flying glass shards stay the star of the blast
    engine.sparkBudget = mode === "glass" ? 20_000 : FALLBACK_CAP * 2;
    setCap(engine.cap);
    if (engine.n > engine.cap) engine.reset();
    dirtyRef.current = true;
    if (mode !== "2d") return;

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      tick((now - last) / 1000);
      last = now;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [mode, tick]);

  // ---- settings → engine / audio ----
  useEffect(() => {
    engineRef.current!.speedScale = speed;
  }, [speed]);

  useEffect(() => {
    engineRef.current!.sizeScale = size;
    dirtyRef.current = true;
  }, [size]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    sfxRef.current!.unlock();
    sfxRef.current!.setMuted(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? "1" : "0");
    } catch {}
  };

  const reset = () => {
    engineRef.current!.reset();
    dirtyRef.current = true;
  };

  // keyboard shortcuts: Space/P pause, R reset, M mute
  const actions = useRef({ reset, toggleMute, togglePause: () => setPaused((p) => !p) });
  actions.current = { reset, toggleMute, togglePause: () => setPaused((p) => !p) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "BUTTON" || el.tagName === "INPUT")) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "p") {
        e.preventDefault();
        actions.current.togglePause();
      } else if (k === "r") actions.current.reset();
      else if (k === "m") actions.current.toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pct = Math.round(stats.fill * 100);
  const danger = stats.fill >= 0.75 && !stats.blasting;

  return (
    <main className="app">
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <h1>Ball Blast</h1>
        </div>
        <p className="tagline">Every wall hit spawns a ball. Fill the circle and it blasts.</p>
      </header>

      <section className="stage">
        <div className={`canvas-wrap${mode === "2d" ? " flat" : ""}`} ref={wrapRef}>
          <div className="glass-layer" ref={glassRef} aria-hidden>
            {mode === "glass" && layout.side > 0 && (
              <GlassBoundary onError={() => setMode("2d")}>
                <GlassScene
                  engine={engineRef.current}
                  side={layout.side}
                  ringR={layout.ringR}
                  calm={reducedMotion}
                  paused={paused}
                  pausedRef={pausedRef}
                  tick={tick}
                  onCrack={() => sfxRef.current!.tink()}
                  apiRef={glassApi}
                />
              </GlassBoundary>
            )}
          </div>
          <canvas ref={canvasRef} aria-label="Ball Blast simulation" role="img" />
          {paused && (
            <button className="overlay" onClick={() => setPaused(false)}>
              <span className="overlay-icon">
                <PlayIcon />
              </span>
              <span>{reducedMotion ? "Reduced motion is on. Tap to play" : "Paused. Tap to resume"}</span>
            </button>
          )}
        </div>
      </section>

      <footer className="hud">
        <div className={`stat-card${danger ? " danger" : ""}${stats.blasting ? " blasting" : ""}`}>
          <div className="stat-row">
            <span className="stat-label">{stats.blasting ? "Blast!" : "Balls"}</span>
            <span className="stat-value">{fmt.format(stats.count)}</span>
            <span className="stat-max">/ {fmt.format(cap)}</span>
          </div>
          <div
            className="meter"
            role="progressbar"
            aria-label="Circle fill"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div className="meter-rest" style={{ transform: `scaleX(${1 - stats.fill})` }} />
          </div>
          <div className="stat-sub">
            <span>{stats.blasting ? "resetting…" : `${pct}% full`}</span>
            <span>{stats.fps ? `${stats.fps} fps` : "paused"}</span>
          </div>
        </div>

        <div className="controls">
          <div className="btn-row">
            <button className="btn" onClick={() => setPaused((p) => !p)} title="Pause / play (Space)">
              {paused ? <PlayIcon /> : <PauseIcon />}
              <span>{paused ? "Play" : "Pause"}</span>
            </button>
            <button className="btn" onClick={reset} title="Reset (R)">
              <ResetIcon />
              <span>Reset</span>
            </button>
            <button
              className={`btn${muted ? "" : " on"}`}
              onClick={toggleMute}
              aria-pressed={!muted}
              title="Sound on / off (M)"
            >
              {muted ? <MuteIcon /> : <SoundIcon />}
              <span>{muted ? "Muted" : "Sound"}</span>
            </button>
          </div>
          <div className="sliders">
            <label className="slider">
              <span>Speed</span>
              <input type="range" min={0.5} max={2} step={0.1} value={speed} onChange={(e) => setSpeed(+e.target.value)} />
              <output>{speed.toFixed(1)}×</output>
            </label>
            <label className="slider">
              <span>Size</span>
              <input type="range" min={0.6} max={1.6} step={0.1} value={size} onChange={(e) => setSize(+e.target.value)} />
              <output>{size.toFixed(1)}×</output>
            </label>
          </div>
        </div>
      </footer>
    </main>
  );
}

/* ---------------- icons ---------------- */
const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const PlayIcon = () => (
  <Svg>
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
  </Svg>
);
const PauseIcon = () => (
  <Svg>
    <path d="M8 5v14M16 5v14" />
  </Svg>
);
const ResetIcon = () => (
  <Svg>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Svg>
);
const SoundIcon = () => (
  <Svg>
    <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
  </Svg>
);
const MuteIcon = () => (
  <Svg>
    <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" />
    <path d="M17 9l5 5M22 9l-5 5" />
  </Svg>
);
