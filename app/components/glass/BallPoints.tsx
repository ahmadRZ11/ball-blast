"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { BUCKET_COUNT, MAX_PARTICLES, type Engine } from "../../lib/engine";

/*
 * Balls + blast sparks as ONE point-sprite draw call inside the Three.js scene, so the
 * glass ring's transmission pass actually refracts them. Vertices are [x, y, size, bucket]
 * in engine (css px, y-down) coordinates; the shader moves them into the ring's plane
 * (centred, y-up) so they tilt with the ring under the perspective camera.
 * The material is opaque on purpose: three.js only feeds opaque objects into the
 * transmission buffer the glass samples from.
 */

const VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec2 position;
attribute float a_size;
attribute float a_bucket;
uniform float u_side;
uniform float u_dpr;
uniform vec3 u_pal[${BUCKET_COUNT}];
varying vec3 v_col;
varying float v_px;
void main() {
  vec3 p = vec3(position.x - u_side * 0.5, u_side * 0.5 - position.y, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  v_px = a_size * u_dpr + 1.0;
  gl_PointSize = v_px;
  v_col = u_pal[int(a_bucket + 0.5)];
}`;

const FRAG = /* glsl */ `
precision mediump float;
uniform float u_alpha;
uniform float u_round;
varying vec3 v_col;
varying float v_px;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  float a = mix(1.0, 1.0 - smoothstep(1.0 - 2.0 / v_px, 1.0, d), u_round);
  if (a < 0.02) discard;
  float hl = u_round * (1.0 - smoothstep(0.0, 0.9, length(p + vec2(0.35, 0.35)))) * 0.45;
  vec3 col = mix(v_col, vec3(1.0), hl);
  a *= u_alpha;
  gl_FragColor = vec4(col * a, a);
}`;

function palette() {
  const c = new THREE.Color();
  return Array.from({ length: BUCKET_COUNT }, (_, b) => {
    // linear values: the post-processing composer converts to sRGB at the very end
    c.setHSL(b / BUCKET_COUNT, 0.9, 0.62, THREE.SRGBColorSpace);
    return new THREE.Vector3(c.r, c.g, c.b);
  });
}

export default function BallPoints({ engine, side }: { engine: Engine; side: number }) {
  const { buffer, geometry, material } = useMemo(() => {
    const data = new Float32Array(MAX_PARTICLES * 4);
    const buffer = new THREE.InterleavedBuffer(data, 4).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.InterleavedBufferAttribute(buffer, 2, 0));
    geometry.setAttribute("a_size", new THREE.InterleavedBufferAttribute(buffer, 1, 2));
    geometry.setAttribute("a_bucket", new THREE.InterleavedBufferAttribute(buffer, 1, 3));
    const material = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        u_side: { value: 1 },
        u_dpr: { value: 1 },
        u_pal: { value: palette() },
        u_alpha: { value: 1 },
        u_round: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    return { buffer, geometry, material };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame(({ gl }) => {
    const n = engine.fillPoints(buffer.array as Float32Array);
    buffer.clearUpdateRanges();
    buffer.addUpdateRange(0, n * 4);
    buffer.needsUpdate = true;
    geometry.setDrawRange(0, n);
    const u = material.uniforms;
    u.u_side.value = side;
    u.u_dpr.value = gl.getPixelRatio();
    u.u_alpha.value = engine.pointsAlpha;
    u.u_round.value = engine.phase === "run" ? 1 : 0;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={-1} />;
}
