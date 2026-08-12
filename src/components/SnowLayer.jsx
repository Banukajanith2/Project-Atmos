import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { latLonToVec3, gridLatLon, STEP } from '../utils/windField';
import { CATEGORY } from '../utils/weatherCodes';
import { GLOBE_RADIUS } from './Globe';

const ALT_TOP = GLOBE_RADIUS * 1.05;
const ALT_GROUND = GLOBE_RADIUS * 1.002;
const MAX_DELTA = 0.05;
const SNOW_CATEGORIES = [CATEGORY.SNOW];

/**
 * Snow is deliberately built on different primitives from rain: round points
 * rather than line segments, a third of the fall speed, and a per-flake lateral
 * wander. Recolouring the rain streaks white would produce white rain - the
 * motion, not the colour, is what distinguishes the two.
 */

const vertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;

  uniform float uPixelRatio;

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uPixelRatio / -mv.z, 1.0, 9.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    gl_FragColor = vec4(uColor, vAlpha * smoothstep(0.25, 0.03, r2));
  }
`;

export default function SnowLayer({ field, budget = 2200 }) {
  const pointsRef = useRef(null);

  const state = useMemo(() => {
    const cells = field.cellsMatching(SNOW_CATEGORIES);
    if (cells.length === 0) return null;

    const per = Math.max(1, Math.min(9, Math.floor(budget / cells.length)));
    const count = cells.length * per;

    const lat = new Float32Array(count);
    const lon = new Float32Array(count);
    const alt = new Float32Array(count);
    const cellOf = new Int32Array(count);
    const speed = new Float32Array(count);
    // Each flake wanders on its own phase and rate, so the field never looks
    // like a single sheet sliding sideways.
    const phase = new Float32Array(count);
    const wanderRate = new Float32Array(count);
    const wanderAmp = new Float32Array(count);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);

    let i = 0;
    for (const cell of cells) {
      const { lat: cLat, lon: cLon } = gridLatLon(cell);
      for (let k = 0; k < per; k++) {
        lat[i] = cLat + (Math.random() - 0.5) * STEP;
        lon[i] = cLon + (Math.random() - 0.5) * STEP;
        alt[i] = ALT_GROUND + Math.random() * (ALT_TOP - ALT_GROUND);
        cellOf[i] = cell;
        speed[i] = 0.6 + Math.random() * 0.8;
        phase[i] = Math.random() * Math.PI * 2;
        wanderRate[i] = 0.6 + Math.random() * 1.4;
        wanderAmp[i] = 0.6 + Math.random() * 1.6;
        sizes[i] = 7 + Math.random() * 8;
        i++;
      }
    }

    return {
      count,
      lat,
      lon,
      alt,
      cellOf,
      speed,
      phase,
      wanderRate,
      wanderAmp,
      sizes,
      alphas,
      positions: new Float32Array(count * 3),
      clock: 0,
    };
  }, [field, budget]);

  const geometry = useMemo(() => {
    if (!state) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(state.positions, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(state.alphas, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(state.sizes, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), ALT_TOP * 1.1);
    return g;
  }, [state]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uColor: { value: new THREE.Color('#eaf6ff') },
          uPixelRatio: { value: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1 },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  const vec = useRef([0, 0, 0]).current;

  useFrame((_, rawDelta) => {
    if (!state || !pointsRef.current) return;
    const dt = Math.min(rawDelta, MAX_DELTA);
    state.clock += dt;

    const { count, lat, lon, alt, cellOf, speed, phase, wanderRate, wanderAmp, alphas, positions, clock } = state;

    for (let i = 0; i < count; i++) {
      // Roughly a third of rain's descent rate.
      alt[i] -= 0.05 * speed[i] * dt;

      if (alt[i] <= ALT_GROUND) {
        const { lat: cLat, lon: cLon } = gridLatLon(cellOf[i]);
        lat[i] = cLat + (Math.random() - 0.5) * STEP;
        lon[i] = cLon + (Math.random() - 0.5) * STEP;
        alt[i] = ALT_TOP;
      }

      // Drift: a slow horizontal sway that makes flakes tumble rather than drop.
      const wobble = Math.sin(clock * wanderRate[i] + phase[i]);
      const driftLon = wobble * wanderAmp[i] * dt * 2.2;
      const driftLat = Math.cos(clock * wanderRate[i] * 0.7 + phase[i]) * wanderAmp[i] * dt * 0.9;
      lon[i] += driftLon;
      lat[i] += driftLat;

      const span = ALT_TOP - ALT_GROUND;
      const fromGround = (alt[i] - ALT_GROUND) / span;
      alphas[i] = Math.max(0, Math.min(1, Math.min(fromGround * 6, (1 - fromGround) * 7 + 0.3))) * 0.85;

      latLonToVec3(lat[i], lon[i], alt[i], vec);
      const p = i * 3;
      positions[p] = vec[0];
      positions[p + 1] = vec[1];
      positions[p + 2] = vec[2];
    }

    const attrs = pointsRef.current.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
  });

  if (!state || !geometry) return null;
  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />;
}
