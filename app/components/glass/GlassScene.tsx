"use client";

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Float } from "@react-three/drei";
import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import gsap from "gsap";
import * as THREE from "three";
import { RING_TUBE, type Engine } from "../../lib/engine";
import BallPoints from "./BallPoints";
import GlassRing, { BLOOM_BASE, type GlassApi, type GlassFx } from "./GlassRing";

type Props = {
  engine: Engine;
  /** canvas size in css px (includes the blast bleed) */
  side: number;
  ringR: number;
  calm: boolean;
  paused: boolean;
  pausedRef: React.MutableRefObject<boolean>;
  /** advances the simulation; runs before anything in the scene reads it */
  tick: (deltaSeconds: number) => void;
  onCrack: () => void;
  apiRef: React.Ref<GlassApi>;
};

const FOV = 30;
/**
 * Max rendered pixels. Transmission, MSAA and bloom all cost per pixel, so big windows
 * render at a slightly lower internal resolution instead of dropping frames
 * (~2M px held a locked 60fps at 100k balls on an Intel Iris Xe).
 */
const PIXEL_BUDGET = 2_000_000;
/** Same file drei's "studio" preset uses, self-hosted in /public (no third-party CDN at runtime). */
const HDRI = "/hdri/studio_small_03_1k.hdr";
const BG_INNER = new THREE.Color("#141c3c");
const BG_OUTER = new THREE.Color("#070914");
const DISC_INNER = new THREE.Color("#1b2552");
const DISC_EDGE = new THREE.Color("#0b1230");

function Driver({ tick }: { tick: (d: number) => void }) {
  // negative priority: run before the default (0) subscribers, without taking over rendering
  useFrame((_, delta) => tick(delta), -2);
  return null;
}

/**
 * Perspective camera placed so the ring's plane (z = 0) maps 1 world unit to 1 css px,
 * which keeps the 2D simulation and the 3D ring perfectly aligned while still giving
 * real depth to the tilt, the tube and the flying shards.
 */
function CameraRig({ side }: { side: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  useEffect(() => {
    const dist = side / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    camera.fov = FOV;
    camera.position.set(0, 0, dist);
    camera.near = dist * 0.1;
    camera.far = dist * 4;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, side]);
  return null;
}

/** Key + cool fill + rim from behind so the crystal's edges catch highlights. */
function Lights({ side, flashRef }: { side: number; flashRef: React.RefObject<THREE.PointLight> }) {
  const d = side;
  return (
    <>
      <directionalLight position={[-0.9 * d, 1.1 * d, 1.4 * d]} intensity={2.4} color="#ffffff" />
      <directionalLight position={[1.1 * d, -0.5 * d, 0.8 * d]} intensity={0.7} color="#a8d4ff" />
      <directionalLight position={[0.4 * d, 0.9 * d, -1.3 * d]} intensity={2} color="#d9c8ff" />
      <pointLight ref={flashRef} intensity={0} decay={0} color="#eef8ff" />
    </>
  );
}

const BG_VERT = /* glsl */ `
varying vec2 v_xy;
void main() {
  v_xy = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BG_FRAG = /* glsl */ `
uniform vec3 u_inner;
uniform vec3 u_outer;
uniform float u_r0;
uniform float u_r1;
varying vec2 v_xy;
void main() {
  float t = smoothstep(u_r0, u_r1, length(v_xy));
  gl_FragColor = vec4(mix(u_inner, u_outer, t), 1.0);
}`;

/** Opaque radial-gradient plane; opaque so the glass's transmission pass refracts it. */
function GradientPlane(props: { size: number; inner: THREE.Color; outer: THREE.Color; r0: number; r1: number; z: number; circle?: boolean }) {
  const { size, inner, outer, r0, r1, z, circle } = props;
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: BG_VERT,
        fragmentShader: BG_FRAG,
        uniforms: { u_inner: { value: inner }, u_outer: { value: outer }, u_r0: { value: r0 }, u_r1: { value: r1 } },
        depthWrite: false,
      }),
    [inner, outer, r0, r1],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  return (
    <mesh position-z={z} material={mat} renderOrder={-3}>
      {circle ? <circleGeometry args={[size, 128]} /> : <planeGeometry args={[size, size]} />}
    </mesh>
  );
}

export default function GlassScene({ engine, side, ringR, calm, paused, pausedRef, tick, onCrack, apiRef }: Props) {
  const fx = useRef<GlassFx>({ bloom: null, flash: null });
  const flashRef = useRef<THREE.PointLight>(null);
  const tube = ringR * RING_TUBE;
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(PIXEL_BUDGET / (side * side))));

  useEffect(() => {
    fx.current.flash = flashRef.current;
  });

  // GSAP drives the shake / shatter / reform timing, so pause it with the simulation
  useEffect(() => {
    if (paused) gsap.globalTimeline.pause();
    else gsap.globalTimeline.resume();
  }, [paused]);

  return (
    <Canvas
      camera={{ fov: FOV, position: [0, 0, 1000], near: 1, far: 10000 }}
      dpr={dpr}
      gl={{ antialias: false, alpha: false, powerPreference: "high-performance", stencil: false }}
      onCreated={({ gl }) => gl.setClearColor(BG_OUTER)}
      style={{ width: "100%", height: "100%" }}
    >
      <CameraRig side={side} />
      <Driver tick={tick} />
      <Environment files={HDRI} environmentIntensity={1} />
      <Lights side={side} flashRef={flashRef} />

      {/* static page-coloured backdrop; the ring assembly floats in front of it */}
      <GradientPlane size={side * 1.6} inner={BG_INNER} outer={BG_OUTER} r0={ringR * 0.9} r1={side * 0.7} z={-tube * 6} />

      {/* slow idle drift/tilt so the depth and moving reflections read as real 3D */}
      <Float speed={calm ? 0 : 1.1} rotationIntensity={calm ? 0 : 0.7} floatIntensity={0} floatingRange={[0, 0]}>
        <GradientPlane size={ringR + tube * 2} inner={DISC_INNER} outer={DISC_EDGE} r0={0} r1={ringR + tube * 2} z={-tube * 2} circle />
        <BallPoints engine={engine} side={side} />
        <GlassRing ref={apiRef} engine={engine} ringR={ringR} calm={calm} pausedRef={pausedRef} fx={fx} onCrack={onCrack} />
      </Float>

      <EffectComposer multisampling={4} enableNormalPass={false}>
        <Bloom
          ref={(b: unknown) => {
            fx.current.bloom = (b as GlassFx["bloom"]) ?? null;
          }}
          mipmapBlur
          intensity={BLOOM_BASE}
          luminanceThreshold={0.82}
          luminanceSmoothing={0.15}
          radius={0.55}
        />
        <ToneMapping mode={ToneMappingMode.AGX} />
      </EffectComposer>
    </Canvas>
  );
}
