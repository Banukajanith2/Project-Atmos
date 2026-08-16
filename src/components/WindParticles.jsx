import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LAT_MAX, speedColor, latLonToVec3 } from '../utils/windField';
import { GLOBE_RADIUS } from './Globe';

const PARTICLE_RADIUS = GLOBE_RADIUS * 1.008;

/**
 * Real surface wind moves ~10 m/s, which is ~0.0001°/s - invisible. This is the
 * playback speed-up applied to the true field: purely a visual constant, tune
 * it for feel, it does not affect the speeds reported in the HUD.
 */
const TIME_ACCEL = 26000;
const METRES_PER_DEGREE = 111320;

/**
 * Each particle is drawn as TAIL points: one live head plus a frozen trail of
 * past positions. That is what turns a field of dots into directional streaks,
 * and it still costs exactly one THREE.Points object and one draw call, because
 * every particle's slots live in the same BufferGeometry.
 *
 * A new trail sample is laid down every TAIL_SAMPLE_DT seconds rather than every
 * frame - at 60 fps a per-frame sample would be sub-pixel and the "streak" would
 * collapse into a single blob.
 */
const TAIL = 9;
const TAIL_SAMPLE_DT = 0.11;

const LIFE_MIN = 2.6;
const LIFE_SPAN = 4.2;
const FADE_IN = 0.16; // fraction of life spent ramping up
const FADE_OUT = 0.34; // fraction of life spent ramping down

/** Particles are retired before the pole gap so none of them ever extrapolate. */
const RETIRE_LAT = LAT_MAX - 2;
const FADE_LAT = LAT_MAX - 14;

const MAX_DELTA = 0.05; // a backgrounded tab returns one huge delta; clamp it
const RESPAWN_TRIES = 4;
const FAST_ENOUGH = 9; // m/s - stop searching for a windier respawn point

const vertexShader = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aSize;

  uniform float uPixelRatio;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uPixelRatio / -mv.z, 1.0, 14.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float falloff = smoothstep(0.25, 0.02, r2);
    gl_FragColor = vec4(vColor, vAlpha * falloff);
  }
`;

/** Area-uniform latitude: a naive uniform in degrees clusters at the poles. */
function randomLat() {
  return Math.asin(Math.random() * 2 - 1) * (180 / Math.PI);
}

/**
 * Below this the streaks are invisible, so the simulation stops entirely rather
 * than advancing a field nobody can see. App.jsx unmounts the component shortly
 * afterwards; this covers the crossfade's tail, where the layer is still mounted
 * because it is mid-fade but is no longer contributing any pixels.
 */
const INVISIBLE = 0.004;

export default function WindParticles({ field, count, transitionRef }) {
  const pointsRef = useRef(null);
  const { gl } = useThree();

  // Mirror the field into a ref so useFrame always reads the newest one without
  // the animation loop depending on render identity.
  const fieldRef = useRef(field);
  fieldRef.current = field;

  // Reallocated only when the particle budget changes (i.e. a quality change),
  // never per frame.
  const buffers = useMemo(() => {
    const slots = count * TAIL;
    const base = new Float32Array(count);
    for (let i = 0; i < count; i++) base[i] = 11 + Math.random() * 13;
    return {
      slots,
      positions: new Float32Array(slots * 3),
      colors: new Float32Array(slots * 3),
      alphas: new Float32Array(slots),
      sizes: new Float32Array(slots),
      baseSize: base,
      lat: new Float32Array(count),
      lon: new Float32Array(count),
      age: new Float32Array(count),
      life: new Float32Array(count),
      tailRamp: new Float32Array(TAIL),
      head: 0,
      sampleTimer: 0,
    };
  }, [count]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(buffers.colors, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(buffers.alphas, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(buffers.sizes, 1));
    // Points sit on a sphere of known radius; skip the per-frame bounds recompute.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), PARTICLE_RADIUS * 1.05);
    return g;
  }, [buffers]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { uPixelRatio: { value: 1 } },
        transparent: true,
        depthTest: true, // hides particles on the far side behind the globe
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    material.uniforms.uPixelRatio.value = gl.getPixelRatio();
  }, [material, gl]);

  // Seed positions once per buffer allocation, with staggered ages so the whole
  // population does not expire on the same frame.
  useEffect(() => {
    const { lat, lon, age, life } = buffers;
    for (let i = 0; i < count; i++) {
      lat[i] = randomLat();
      lon[i] = Math.random() * 360 - 180;
      life[i] = LIFE_MIN + Math.random() * LIFE_SPAN;
      age[i] = Math.random() * life[i];
    }
  }, [buffers, count]);

  const rgb = useRef([0, 0, 0]).current;
  const vec = useRef([0, 0, 0]).current;

  useFrame((_, rawDelta) => {
    const points = pointsRef.current;
    const currentField = fieldRef.current;
    if (!points || !currentField) return;

    // 1 in Wind mode, 0 in Aurora mode, ramping across the crossfade. Read from
    // a ref rather than a prop so the fade costs no React renders.
    const fade = 1 - (transitionRef?.current ?? 0);
    // A genuine pause, not a hidden layer: advection, respawn sampling and the
    // four buffer uploads are all skipped, not merely rendered at zero alpha.
    if (fade <= INVISIBLE) return;

    const dt = Math.min(rawDelta, MAX_DELTA);
    const { positions, colors, alphas, sizes, baseSize, lat, lon, age, life, tailRamp } = buffers;
    const degPerMetre = (dt * TIME_ACCEL) / METRES_PER_DEGREE;

    // Advance the ring head on its own cadence. The previous head then stays
    // frozen in place as the newest trail sample.
    buffers.sampleTimer += dt;
    if (buffers.sampleTimer >= TAIL_SAMPLE_DT) {
      buffers.sampleTimer -= TAIL_SAMPLE_DT;
      buffers.head = (buffers.head + 1) % TAIL;
    }
    const head = buffers.head;

    // Trail weight per ring slot, by how many samples back it is from the head.
    // Depends only on `head`, so it is computed once per frame, not per particle.
    for (let k = 0; k < TAIL; k++) {
      const stepsBack = (head - k + TAIL) % TAIL;
      const t = 1 - stepsBack / TAIL;
      tailRamp[k] = t * t;
    }

    for (let i = 0; i < count; i++) {
      age[i] += dt;

      let sample = Math.abs(lat[i]) > RETIRE_LAT ? null : currentField.sample(lat[i], lon[i]);
      let respawned = false;

      // Retire on old age, on drifting into the polar gap, or on landing in dead
      // calm where the particle would otherwise sit still for its whole life.
      if (age[i] >= life[i] || sample === null || sample.speed < 0.05) {
        let bestLat = 0;
        let bestLon = 0;
        let bestSample = null;
        let bestSpeed = -1;

        // Best-of-N rejection sampling biases respawns toward windier regions
        // without building a full cumulative distribution every refresh.
        for (let t = 0; t < RESPAWN_TRIES; t++) {
          const tryLat = randomLat();
          if (Math.abs(tryLat) > RETIRE_LAT) continue;
          const tryLon = Math.random() * 360 - 180;
          const s = currentField.sample(tryLat, tryLon);
          const speed = s ? s.speed : -1;
          if (speed > bestSpeed) {
            bestSpeed = speed;
            bestLat = tryLat;
            bestLon = tryLon;
            bestSample = s;
          }
          if (speed >= FAST_ENOUGH) break;
        }

        lat[i] = bestLat;
        lon[i] = bestLon;
        age[i] = 0;
        life[i] = LIFE_MIN + Math.random() * LIFE_SPAN;
        sample = bestSample;
        respawned = true;
      } else {
        // Advect. Meridians converge toward the poles, so a fixed eastward speed
        // covers more degrees of longitude at high latitude; the clamp keeps that
        // correction from exploding in the last few degrees before the cutoff.
        const cosLat = Math.max(Math.cos((lat[i] * Math.PI) / 180), 0.18);
        lon[i] += (sample.u * degPerMetre) / cosLat;
        lat[i] += sample.v * degPerMetre;

        // Folding longitude back into range is continuous in 3D - ±180 map to the
        // same point - so the trail does not smear across the globe at the seam.
        if (lon[i] > 180) lon[i] -= 360;
        else if (lon[i] < -180) lon[i] += 360;
      }

      const speed = sample ? sample.speed : 0;
      const t = life[i] > 0 ? age[i] / life[i] : 1;

      // Ramp in and out so streaks never pop into or out of existence.
      let alpha = 1;
      if (t < FADE_IN) alpha = t / FADE_IN;
      else if (t > 1 - FADE_OUT) alpha = (1 - t) / FADE_OUT;

      // Additional fade approaching the excluded polar band, so the cutoff is a
      // soft horizon rather than a visible ring of vanishing particles.
      const absLat = Math.abs(lat[i]);
      if (absLat > FADE_LAT) {
        alpha *= Math.max(0, 1 - (absLat - FADE_LAT) / (RETIRE_LAT - FADE_LAT));
      }
      alpha *= 0.92 * fade;

      speedColor(speed, rgb);
      latLonToVec3(lat[i], lon[i], PARTICLE_RADIUS, vec);

      const slot0 = i * TAIL;

      if (respawned) {
        // Collapse the whole trail onto the new position, otherwise the particle
        // draws a streak from wherever it died to wherever it reappeared.
        for (let k = 0; k < TAIL; k++) {
          const p = (slot0 + k) * 3;
          positions[p] = vec[0];
          positions[p + 1] = vec[1];
          positions[p + 2] = vec[2];
          colors[p] = rgb[0];
          colors[p + 1] = rgb[1];
          colors[p + 2] = rgb[2];
        }
      } else {
        // Steady state: only the head slot moves. Older slots keep the position
        // and colour they were laid down with, which is what makes the trail
        // trace the path actually travelled.
        const p = (slot0 + head) * 3;
        positions[p] = vec[0];
        positions[p + 1] = vec[1];
        positions[p + 2] = vec[2];
        colors[p] = rgb[0];
        colors[p + 1] = rgb[1];
        colors[p + 2] = rgb[2];
      }

      // Taper opacity and size along the trail so each streak reads as a comet
      // with a direction, rather than a chain of identical dots.
      const size = baseSize[i];
      for (let k = 0; k < TAIL; k++) {
        const ramp = tailRamp[k];
        alphas[slot0 + k] = alpha * ramp;
        sizes[slot0 + k] = size * (0.4 + 0.6 * ramp);
      }
    }

    // The whole point of the exercise: push the mutated typed arrays straight to
    // the GPU. Routing any of this through useState would re-render React at
    // 60 Hz and stall the frame.
    const attrs = points.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.aColor.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
    attrs.aSize.needsUpdate = true;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />;
}
