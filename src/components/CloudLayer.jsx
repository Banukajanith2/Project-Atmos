import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GRID_POINTS, N_LAT, N_LON, STEP } from '../utils/windField';
import { GLOBE_RADIUS } from './Globe';

/**
 * Turn a grid-ordered scalar array (0..1) into a texture that lines up with the
 * Earth basemap's equirectangular UVs.
 *
 * Two corrections matter here and both are easy to miss:
 *
 *  - **Half-texel offset.** Grid point 0 is the *centre* of the first texel, at
 *    u = 0.5/36, not at u = 0. Ignoring this shifts every layer half a cell
 *    (5°) east of the weather it represents.
 *  - **Latitude range.** The grid spans ±80°, but a sphere's V spans ±90°.
 *    Mapping V straight onto the texture stretches the data over the poles and
 *    misplaces every row. `repeat.y` rescales ±90 into ±80.
 *
 * Exported because SunnyGlow needs exactly the same mapping.
 */
export function createGridTexture(values) {
  const data = new Uint8Array(GRID_POINTS * 4);
  for (let i = 0; i < GRID_POINTS; i++) {
    const v = Math.max(0, Math.min(1, values[i] || 0));
    const byte = Math.round(v * 255);
    const p = i * 4;
    // All channels carry the value: three reads alphaMap from the green
    // channel, but keeping RGB in sync means the same texture also works as a
    // colour or intensity map without surprises.
    data[p] = byte;
    data[p + 1] = byte;
    data[p + 2] = byte;
    data[p + 3] = byte;
  }

  const texture = new THREE.DataTexture(data, N_LON, N_LAT, THREE.RGBAFormat);
  texture.needsUpdate = true;

  // Smooth between cells — nearest-neighbour would draw 10° checkerboards.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  // Longitude is circular, latitude is not.
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  // Sphere V covers 180° of latitude; the grid's 17 rows cover only 170°
  // (±80 plus half a cell either side), so V is rescaled by 180/170.
  texture.repeat.set(1, 180 / (N_LAT * STEP));
  texture.offset.set(1 / (2 * N_LON), -0.5 / N_LAT);

  return texture;
}

/**
 * Cloud cover as a translucent white shell over the basemap.
 *
 * Coverage is a state, not a phenomenon with motion, so this does not simulate
 * anything — it just blends. There is a barely-perceptible drift because the
 * brief asks for it; note that drifting the texture does slowly decouple the
 * clouds from the coordinates they were measured at, so it is kept tiny
 * (a few degrees across a whole refresh interval).
 */
const DRIFT_PER_SECOND = 0.000015;

export default function CloudLayer({ field, opacity = 0.5 }) {
  const materialRef = useRef(null);

  const texture = useMemo(() => {
    const clouds = new Float32Array(GRID_POINTS);
    for (let i = 0; i < GRID_POINTS; i++) {
      // cloud_cover is a percentage; soften the low end so thin cover does not
      // haze the whole planet.
      const pct = (field.cloudCover[i] || 0) / 100;
      clouds[i] = pct * pct;
    }
    return createGridTexture(clouds);
  }, [field]);

  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((_, delta) => {
    texture.offset.x += DRIFT_PER_SECOND * Math.min(delta, 0.05);
  });

  return (
    <mesh scale={1.004}>
      <sphereGeometry args={[GLOBE_RADIUS, 96, 64]} />
      <meshStandardMaterial
        ref={materialRef}
        color="#ffffff"
        alphaMap={texture}
        transparent
        opacity={opacity}
        roughness={1}
        metalness={0}
        depthWrite={false}
      />
    </mesh>
  );
}
