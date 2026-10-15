"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import gsap from "gsap";
import * as THREE from "three";
import type { BloomEffect } from "postprocessing";
import { RING_TUBE, type Engine } from "../../lib/engine";
import { buildCracks, buildShards, CRACK_START } from "../../lib/fracture";

export type GlassApi = {
  /** Swap the intact ring for its shards and blow them apart (call at the blast). */
  shatter(): void;
  /** Bring the ring back (call when a new round starts). */
  reform(): void;
};

/** Scene-level effects the break sequence animates (owned by GlassScene). */
export type GlassFx = { bloom: BloomEffect | null; flash: THREE.PointLight | null };

type Props = {
  engine: Engine;
  ringR: number;
  calm: boolean;
  pausedRef: React.MutableRefObject<boolean>;
  fx: React.MutableRefObject<GlassFx>;
  /** Fired when a new crack starts spreading (for the "tink" sound). */
  onCrack: () => void;
};

const TAU = Math.PI * 2;
const ICE = new THREE.Color("#d4f1ff");
const ROSE = new THREE.Color("#ffb8c6");
const HALO_CALM = new THREE.Color("#7fdcff");
const HALO_HOT = new THREE.Color("#ff5a6e");
export const BLOOM_BASE = 0.55;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Real crystal: full transmission through real thickness, ior 1.5, clearcoat, a touch of dispersion. */
function crystal(tube: number, opts: Partial<THREE.MeshPhysicalMaterialParameters> = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: "#ffffff",
    transmission: 1,
    thickness: tube * 1.8,
    ior: 1.5,
    roughness: 0.03,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    specularIntensity: 1,
    envMapIntensity: 1.6,
    iridescence: 0.15,
    iridescenceIOR: 1.3,
    attenuationColor: ICE.clone(),
    attenuationDistance: tube * 10,
    emissive: new THREE.Color("#ff4060"),
    emissiveIntensity: 0,
    transparent: true,
    ...opts,
  });
}

const CRACK_VERT = /* glsl */ `
attribute float a_t;
uniform float u_tension;
varying float v_a;
void main() {
  v_a = clamp((u_tension - a_t) / 0.04, 0.0, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CRACK_FRAG = /* glsl */ `
uniform float u_opacity;
varying float v_a;
void main() {
  if (v_a <= 0.0) discard;
  // > 1.0 so the bloom pass picks the fresh fractures up as faint glints
  gl_FragColor = vec4(vec3(1.25, 1.3, 1.35), v_a * u_opacity);
}`;

// soft additive glow hugging the ring, warming to red under stress
const HALO_VERT = /* glsl */ `
varying vec2 v_xy;
void main() {
  v_xy = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const HALO_FRAG = /* glsl */ `
uniform vec3 u_color;
uniform float u_major;
uniform float u_tube;
uniform float u_strength;
varying vec2 v_xy;
void main() {
  float d = (length(v_xy) - u_major) / (u_tube * 1.6);
  gl_FragColor = vec4(u_color, exp(-d * d) * u_strength);
}`;

const GlassRing = forwardRef<GlassApi, Props>(function GlassRing({ engine, ringR, calm, pausedRef, fx, onCrack }, ref) {
  const tube = ringR * RING_TUBE;
  const major = ringR + tube; // inner edge of the glass sits exactly on the bounce boundary

  const shakeRef = useRef<THREE.Group>(null);
  const torusRef = useRef<THREE.Mesh>(null);
  const shardsRef = useRef<THREE.Group>(null);

  // ---- geometry + materials ----
  const torusGeo = useMemo(() => new THREE.TorusGeometry(major, tube, 48, 256), [major, tube]);
  const ringMat = useMemo(() => crystal(tube, { dispersion: 0.35 }), [tube]);
  const shardMat = useMemo(() => crystal(tube, { thickness: tube * 1.2, flatShading: true }), [tube]);
  const edgeMat = useMemo(
    () => new THREE.LineBasicMaterial({ color: "#eaf9ff", transparent: true, opacity: 0.45, depthWrite: false }),
    [],
  );
  const cracks = useMemo(() => buildCracks(major, tube), [major, tube]);
  const crackMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: CRACK_VERT,
        fragmentShader: CRACK_FRAG,
        uniforms: { u_tension: { value: 0 }, u_opacity: { value: 0.9 } },
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  const shards = useMemo(() => buildShards(major, tube), [major, tube]);
  const haloGeo = useMemo(() => new THREE.RingGeometry(major - tube * 3.5, major + tube * 3.5, 192, 1), [major, tube]);
  const haloMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: HALO_VERT,
        fragmentShader: HALO_FRAG,
        uniforms: {
          u_color: { value: HALO_CALM.clone() },
          u_major: { value: 1 },
          u_tube: { value: 1 },
          u_strength: { value: 0.1 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );

  useEffect(
    () => () => {
      torusGeo.dispose();
      haloGeo.dispose();
      cracks.geometry.dispose();
      shards.forEach((s) => {
        s.geometry.dispose();
        s.edges.dispose();
      });
    },
    [torusGeo, haloGeo, cracks, shards],
  );
  useEffect(() => () => ringMat.dispose(), [ringMat]);
  useEffect(() => () => shardMat.dispose(), [shardMat]);
  useEffect(() => () => [edgeMat, crackMat, haloMat].forEach((m) => m.dispose()), [edgeMat, crackMat, haloMat]);

  // ---- shard physics state ----
  type Sim = { active: boolean; t: number; v: Float32Array; w: Float32Array; delay: Float32Array; shrinkAt: Float32Array };
  const sim = useRef<Sim>({ active: false, t: 0, v: new Float32Array(0), w: new Float32Array(0), delay: new Float32Array(0), shrinkAt: new Float32Array(0) });
  const tl = useRef<gsap.core.Timeline | null>(null);

  // ---- GSAP-driven shake: quickTo retargets smoothly every couple of frames ----
  const shake = useRef<{ x: gsap.QuickToFunc; y: gsap.QuickToFunc; rx: gsap.QuickToFunc; ry: gsap.QuickToFunc } | null>(null);
  useEffect(() => {
    const g = shakeRef.current!;
    const opts = { duration: 0.07, ease: "power1.out" };
    shake.current = {
      x: gsap.quickTo(g.position, "x", opts),
      y: gsap.quickTo(g.position, "y", opts),
      rx: gsap.quickTo(g.rotation, "x", opts),
      ry: gsap.quickTo(g.rotation, "y", opts),
    };
    return () => {
      gsap.killTweensOf(g.position);
      gsap.killTweensOf(g.rotation);
    };
  }, []);

  // draw the (invisible) shards for the first frames so their shaders compile and buffers
  // upload up front; otherwise the first shatter would hitch right at the big moment
  const warmup = useRef(2);
  useEffect(() => {
    warmup.current = 2;
  }, [shards]);

  const opened = useRef(0);
  const frame = useRef(0);
  const shaking = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      shatter() {
        const torus = torusRef.current;
        const group = shardsRef.current;
        if (!torus || !group) return;
        tl.current?.kill();
        gsap.killTweensOf([torus.scale, ringMat]);
        torus.visible = false;

        // the break starts at one point on the ring and runs around it from there
        const breakTheta = Math.random() * TAU;
        const bx = Math.cos(breakTheta) * major;
        const by = Math.sin(breakTheta) * major;
        const k = ringR / 340; // px-per-frame speeds scale with the ring
        const power = calm ? 0.45 : 1;
        const n = shards.length;
        const s: Sim = {
          active: true,
          t: 0,
          v: new Float32Array(n * 3),
          w: new Float32Array(n * 3),
          delay: new Float32Array(n),
          shrinkAt: new Float32Array(n),
        };
        group.children.forEach((child, i) => {
          const { center, theta } = shards[i];
          child.position.copy(center);
          child.rotation.set(0, 0, 0);
          child.scale.setScalar(1);
          // outward from the break point, blended with straight out from the ring centre
          const rl = Math.hypot(center.x, center.y) || 1;
          let dx = center.x - bx;
          let dy = center.y - by;
          const dl = Math.hypot(dx, dy) || 1;
          dx = (dx / dl) * 0.55 + (center.x / rl) * 0.85;
          dy = (dy / dl) * 0.55 + (center.y / rl) * 0.85;
          const len = Math.hypot(dx, dy) || 1;
          // near the break point pieces fly hardest; uneven speeds so it's not a uniform "poof"
          let ang = Math.abs(theta - breakTheta);
          if (ang > Math.PI) ang = TAU - ang;
          const near = 1 - ang / Math.PI;
          const speed = (2.5 + Math.random() * 5 + near * 4) * k * power;
          s.v[i * 3] = (dx / len) * speed;
          s.v[i * 3 + 1] = (dy / len) * speed + 1.2 * k * power; // slight upward kick before gravity wins
          s.v[i * 3 + 2] = (Math.random() - 0.2) * speed * 0.9; // tumble toward / away from camera
          for (let a = 0; a < 3; a++) s.w[i * 3 + a] = (Math.random() - 0.5) * 0.45 * (calm ? 0.4 : 1);
          // the fracture races around the ring from the break point: a quick stagger
          s.delay[i] = (ang / Math.PI) * 0.12 + Math.random() * 0.03;
          s.shrinkAt[i] = 0.55 + Math.random() * 0.5;
        });
        sim.current = s;
        group.visible = true;
        shardMat.opacity = 1;
        edgeMat.opacity = 0.3;
        shardMat.envMapIntensity = calm ? 2.5 : 6;

        // flash: bloom spike + a burst of light at the break, then the glass fades as it falls
        const { bloom, flash } = fx.current;
        if (flash) flash.position.set(bx * 0.8, by * 0.8, tube * 6);
        const peak = calm ? 1.3 : 3.2;
        const t = gsap.timeline();
        if (bloom) t.fromTo(bloom, { intensity: peak }, { intensity: BLOOM_BASE, duration: 0.55, ease: "power2.out" }, 0);
        if (flash) t.fromTo(flash, { intensity: calm ? 2 : 9 }, { intensity: 0, duration: 0.4, ease: "power3.out" }, 0);
        t.to(shardMat, { envMapIntensity: 1.6, duration: 0.7, ease: "power2.out" }, 0)
          .to([shardMat, edgeMat], { opacity: 0, duration: 0.6, ease: "power1.in" }, 1.25)
          .call(() => {
            group.visible = false;
            sim.current.active = false;
          }, [], 1.9);
        tl.current = t;

        // settle the shake so the reformed ring starts centred
        const g = shakeRef.current!;
        gsap.to(g.position, { x: 0, y: 0, duration: 0.3, overwrite: true });
        gsap.to(g.rotation, { x: 0, y: 0, duration: 0.3, overwrite: true });
        shaking.current = false;
        opened.current = 0;
      },

      reform() {
        const torus = torusRef.current;
        const group = shardsRef.current;
        if (!torus || !group) return;
        if (sim.current.active) {
          // manual reset mid-shatter
          tl.current?.kill();
          group.visible = false;
          sim.current.active = false;
          if (fx.current.bloom) fx.current.bloom.intensity = BLOOM_BASE;
          if (fx.current.flash) fx.current.flash.intensity = 0;
        }
        opened.current = 0;
        if (torus.visible) return; // first start / reset while intact: nothing to animate
        torus.visible = true;
        gsap.fromTo(torus.scale, { x: 0.9, y: 0.9, z: 0.9 }, { x: 1, y: 1, z: 1, duration: 0.9, ease: "elastic.out(1, 0.45)" });
        gsap.fromTo(ringMat, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power2.out" });
      },
    }),
    [calm, edgeMat, fx, major, ringMat, ringR, shardMat, shards, tube],
  );

  useFrame((state, delta) => {
    const paused = pausedRef.current;
    const group = shardsRef.current;

    if (group && warmup.current > 0 && !sim.current.active) {
      warmup.current--;
      const warming = warmup.current > 0;
      group.visible = warming;
      shardMat.opacity = warming ? 0 : 1;
      edgeMat.opacity = warming ? 0 : 0.3;
    }

    const tension = engine.tension;

    // cracks grow with tension; a "tink" each time a new one starts
    crackMat.uniforms.u_tension.value = tension;
    let n = 0;
    while (n < cracks.starts.length && cracks.starts[n] <= tension) n++;
    if (n > opened.current && !paused) onCrack();
    opened.current = n;

    // stressed glass warms toward red and pulses
    const heat = clamp((tension - CRACK_START) / (2 - CRACK_START), 0, 1);
    const pulse = 0.75 + 0.25 * Math.sin(state.clock.elapsedTime * (8 + heat * 14));
    ringMat.attenuationColor.lerpColors(ICE, ROSE, heat);
    ringMat.emissiveIntensity = heat * 0.35 * pulse;
    const hu = haloMat.uniforms;
    hu.u_major.value = major;
    hu.u_tube.value = tube;
    hu.u_color.value.lerpColors(HALO_CALM, HALO_HOT, heat);
    hu.u_strength.value = 0.08 + heat * 0.35 * pulse;

    // shake: amplitude ramps up through the critical hold
    const s = shake.current;
    if (s && !paused && frame.current++ % 2 === 0) {
      const t = clamp((tension - 0.7) / 1.3, 0, 1);
      const amp = Math.pow(t, 1.6) * ringR * 0.02 * (calm ? 0.25 : 1);
      if (amp > 0.05) {
        const rot = 0.12 * t * (calm ? 0.25 : 1);
        s.x((Math.random() - 0.5) * 2 * amp);
        s.y((Math.random() - 0.5) * 2 * amp);
        s.rx((Math.random() - 0.5) * rot);
        s.ry((Math.random() - 0.5) * rot);
        shaking.current = true;
      } else if (shaking.current) {
        s.x(0);
        s.y(0);
        s.rx(0);
        s.ry(0);
        shaking.current = false;
      }
    }

    // shard physics: staggered release, fast burst that decelerates, gravity, tumble, shrink
    const sm = sim.current;
    if (group && sm.active && !paused) {
      const dt = Math.min(delta * 60, 3);
      sm.t += delta;
      const k = ringR / 340;
      const g = 0.12 * k * dt;
      const drag = Math.pow(0.955, dt);
      const spinDrag = Math.pow(0.99, dt);
      const { v, w, delay, shrinkAt } = sm;
      group.children.forEach((child, i) => {
        if (sm.t < delay[i]) return;
        const o = i * 3;
        child.position.x += v[o] * dt;
        child.position.y += v[o + 1] * dt;
        child.position.z += v[o + 2] * dt;
        v[o] *= drag;
        v[o + 1] = v[o + 1] * drag - g;
        v[o + 2] *= drag;
        child.rotation.x += w[o] * dt;
        child.rotation.y += w[o + 1] * dt;
        child.rotation.z += w[o + 2] * dt;
        w[o] *= spinDrag;
        w[o + 1] *= spinDrag;
        w[o + 2] *= spinDrag;
        if (sm.t > delay[i] + shrinkAt[i]) child.scale.setScalar(Math.max(0.15, child.scale.x - 0.012 * dt));
      });
    }
  });

  return (
    <>
      <group ref={shakeRef}>
        <mesh ref={torusRef} geometry={torusGeo} material={ringMat}>
          <mesh geometry={haloGeo} material={haloMat} position-z={-tube * 1.4} renderOrder={5} />
        </mesh>
        <lineSegments geometry={cracks.geometry} material={crackMat} renderOrder={10} frustumCulled={false} />
      </group>
      <group ref={shardsRef} visible={false}>
        {shards.map((s, i) => (
          <mesh key={i} geometry={s.geometry} material={shardMat} position={s.center}>
            <lineSegments geometry={s.edges} material={edgeMat} />
          </mesh>
        ))}
      </group>
    </>
  );
});

export default GlassRing;
