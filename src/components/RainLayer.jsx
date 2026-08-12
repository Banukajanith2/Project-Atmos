import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { latLonToVec3, gridLatLon, STEP } from '../utils/windField';
import { CATEGORY } from '../utils/weatherCodes';
import { GLOBE_RADIUS } from './Globe';

const ALT_TOP = GLOBE_RADIUS * 1.055;
const ALT_GROUND = GLOBE_RADIUS * 1.002;
const MAX_DELTA = 0.05;

/**
 * Precipitation is drawn as LineSegments, not points.
 *
 * That is the whole difference between "falling" and "flowing": a line has an
 * axis, and anchoring that axis to the radial (straight down toward the planet
 * centre) makes every streak read as descending regardless of which way the
 * camera is oriented. The wind layer's round points can only express direction
 * through motion over time, which is the wrong idiom for rain.
 */

const vertexShader = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    gl_FragColor = vec4(uColor, vAlpha);
  }
`;

/**
 * Reusable falling-streak system. Exported so ThunderLayer can render the same
 * precipitation motion without duplicating it - the prompt specifies thunder as
 * "the rain layer's motion, plus flashes".
 */
export function PrecipStreaks({
  field,
  categories,
  perCell = 8,
  maxParticles = 2600,
  fallSpeed = 0.16,
  streakLength = 0.022,
  color = '#a8dcff',
  intensity = 1,
}) {
  const linesRef = useRef(null);

  const fieldRef = useRef(field);
  fieldRef.current = field;

  // Cells are recomputed only when the data or the budget changes, never per
  // frame. With no matching weather anywhere this yields zero particles and the
  // component renders nothing at all.
  const state = useMemo(() => {
    const cells = field.cellsMatching(categories);
    if (cells.length === 0) return null;

    const per = Math.max(1, Math.min(perCell, Math.floor(maxParticles / cells.length)));
    const count = cells.length * per;

    const lat = new Float32Array(count);
    const lon = new Float32Array(count);
    const alt = new Float32Array(count);
    const speed = new Float32Array(count);
    const cellOf = new Int32Array(count);
    // Per-particle tilt. Beyond breaking up mechanically parallel streaks, this
    // is what keeps rain legible when a cell faces the camera head-on: a purely
    // radial streak is fully foreshortened there and collapses to a dot.
    const tiltLat = new Float32Array(count);
    const tiltLon = new Float32Array(count);

    let i = 0;
    for (const cell of cells) {
      const { lat: cLat, lon: cLon } = gridLatLon(cell);
      for (let k = 0; k < per; k++) {
        lat[i] = cLat + (Math.random() - 0.5) * STEP;
        lon[i] = cLon + (Math.random() - 0.5) * STEP;
        alt[i] = ALT_GROUND + Math.random() * (ALT_TOP - ALT_GROUND);
        speed[i] = 0.75 + Math.random() * 0.5;
        cellOf[i] = cell;
        tiltLat[i] = (Math.random() - 0.5) * 3.5;
        tiltLon[i] = (Math.random() - 0.5) * 3.5;
        i++;
      }
    }

    return {
      count,
      lat,
      lon,
      alt,
      speed,
      cellOf,
      tiltLat,
      tiltLon,
      positions: new Float32Array(count * 2 * 3),
      alphas: new Float32Array(count * 2),
    };
  }, [field, categories, perCell, maxParticles]);

  const geometry = useMemo(() => {
    if (!state) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(state.positions, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(state.alphas, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), ALT_TOP * 1.1);
    return g;
  }, [state]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { uColor: { value: new THREE.Color(color) } },
        transparent: true,
        depthTest: true, // far-side precipitation stays hidden behind the globe
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [color],
  );

  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  const head = useRef([0, 0, 0]).current;
  const tail = useRef([0, 0, 0]).current;

  useFrame((_, rawDelta) => {
    if (!state || !linesRef.current) return;
    const dt = Math.min(rawDelta, MAX_DELTA);
    const { count, lat, lon, alt, speed, cellOf, tiltLat, tiltLon, positions, alphas } = state;
    const precipitation = fieldRef.current.precipitation;

    for (let i = 0; i < count; i++) {
      alt[i] -= fallSpeed * speed[i] * dt;

      if (alt[i] <= ALT_GROUND) {
        // Respawn at cloud height with a fresh position inside the same cell.
        const { lat: cLat, lon: cLon } = gridLatLon(cellOf[i]);
        lat[i] = cLat + (Math.random() - 0.5) * STEP;
        lon[i] = cLon + (Math.random() - 0.5) * STEP;
        alt[i] = ALT_TOP;
      }

      const span = ALT_TOP - ALT_GROUND;
      const fromGround = (alt[i] - ALT_GROUND) / span;
      // Fade in at cloud base and out as it lands, so nothing pops.
      const life = Math.min(1, Math.min(fromGround * 5, (1 - fromGround) * 6 + 0.35));

      // mm of precipitation nudges opacity, so heavy cells look heavier.
      const wetness = Math.min(1, 0.45 + (precipitation[cellOf[i]] || 0) * 0.4);
      const alpha = Math.max(0, life) * wetness * intensity;

      latLonToVec3(lat[i], lon[i], alt[i], head);
      latLonToVec3(lat[i] + tiltLat[i], lon[i] + tiltLon[i], alt[i] + streakLength, tail);

      const p = i * 6;
      positions[p] = head[0];
      positions[p + 1] = head[1];
      positions[p + 2] = head[2];
      positions[p + 3] = tail[0];
      positions[p + 4] = tail[1];
      positions[p + 5] = tail[2];

      const a = i * 2;
      alphas[a] = alpha; // leading end, bright
      alphas[a + 1] = alpha * 0.12; // trailing end, nearly transparent
    }

    const attrs = linesRef.current.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
  });

  if (!state || !geometry) return null;

  return <lineSegments ref={linesRef} geometry={geometry} material={material} frustumCulled={false} />;
}

const RAIN_CATEGORIES = [CATEGORY.RAIN];

export default function RainLayer({ field, budget = 2600 }) {
  return <PrecipStreaks field={field} categories={RAIN_CATEGORIES} maxParticles={budget} />;
}
