import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { latLonToVec3, gridLatLon, STEP } from '../utils/windField';
import { CATEGORY } from '../utils/weatherCodes';
import { PrecipStreaks } from './RainLayer';
import { GLOBE_RADIUS } from './Globe';

const FLASH_RADIUS = GLOBE_RADIUS * 1.012;
const THUNDER_CATEGORIES = [CATEGORY.THUNDER];

const vertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;

  uniform float uPixelRatio;

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uPixelRatio / -mv.z, 2.0, 90.0);
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
    // Soft core with a wide halo, so a flash reads as a burst of light rather
    // than a hard disc switching on.
    float glow = smoothstep(0.25, 0.0, r2);
    gl_FragColor = vec4(uColor, vAlpha * glow * glow);
  }
`;

/**
 * Flash markers over thunderstorm cells.
 *
 * Each cell keeps its own countdown and its own flash duration. Driving them
 * from a single shared clock - a global sin() or one timer for the layer - makes
 * every storm on the planet strobe in unison, which instantly reads as a screen
 * effect rather than weather.
 */
function Flashes({ field, cells }) {
  const pointsRef = useRef(null);

  const state = useMemo(() => {
    if (cells.length === 0) return null;
    const count = cells.length;
    const positions = new Float32Array(count * 3);
    const alphas = new Float32Array(count);
    const sizes = new Float32Array(count);
    const nextAt = new Float32Array(count);
    const duration = new Float32Array(count);
    const elapsed = new Float32Array(count).fill(Infinity);

    const vec = [0, 0, 0];
    cells.forEach((cell, i) => {
      const { lat, lon } = gridLatLon(cell);
      // Offset inside the cell so the flash is not pinned to the exact grid node.
      latLonToVec3(
        lat + (Math.random() - 0.5) * STEP * 0.5,
        lon + (Math.random() - 0.5) * STEP * 0.5,
        FLASH_RADIUS,
        vec,
      );
      positions[i * 3] = vec[0];
      positions[i * 3 + 1] = vec[1];
      positions[i * 3 + 2] = vec[2];
      sizes[i] = 55 + Math.random() * 45;
      nextAt[i] = Math.random() * 4; // stagger the very first flash too
      duration[i] = 0.16 + Math.random() * 0.16;
    });

    return { count, positions, alphas, sizes, nextAt, duration, elapsed, timers: new Float32Array(count) };
  }, [cells]);

  const geometry = useMemo(() => {
    if (!state) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(state.positions, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(state.alphas, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(state.sizes, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FLASH_RADIUS * 1.1);
    return g;
  }, [state]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uColor: { value: new THREE.Color('#e8f6ff') },
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

  useFrame((_, rawDelta) => {
    if (!state || !pointsRef.current) return;
    const dt = Math.min(rawDelta, 0.05);
    const { count, alphas, timers, nextAt, duration, elapsed } = state;

    for (let i = 0; i < count; i++) {
      timers[i] += dt;

      if (elapsed[i] < duration[i]) {
        elapsed[i] += dt;
        const t = Math.min(1, elapsed[i] / duration[i]);
        // Fast attack, slower decay - the shape of an actual lightning flash.
        alphas[i] = t < 0.18 ? t / 0.18 : Math.pow(1 - (t - 0.18) / 0.82, 2);
      } else {
        alphas[i] = 0;
        if (timers[i] >= nextAt[i]) {
          timers[i] = 0;
          elapsed[i] = 0;
          nextAt[i] = 1.4 + Math.random() * 5.5; // fresh interval every time
          duration[i] = 0.16 + Math.random() * 0.16;
        }
      }
    }

    pointsRef.current.geometry.attributes.aAlpha.needsUpdate = true;
  });

  if (!state || !geometry) return null;
  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />;
}

export default function ThunderLayer({ field, budget = 1800 }) {
  const cells = useMemo(() => field.cellsMatching(THUNDER_CATEGORIES), [field]);

  return (
    <>
      <PrecipStreaks
        field={field}
        categories={THUNDER_CATEGORIES}
        maxParticles={budget}
        perCell={11}
        fallSpeed={0.2}
        color="#bfe4ff"
        intensity={1.15}
      />
      <Flashes field={field} cells={cells} />
    </>
  );
}
