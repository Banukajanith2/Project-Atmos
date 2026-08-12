import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { GRID_POINTS } from '../utils/windField';
import { CATEGORY } from '../utils/weatherCodes';
import { createGridTexture } from './CloudLayer';
import { GLOBE_RADIUS } from './Globe';

/**
 * Clear sky, rendered as a soft glow rather than as particles.
 *
 * "Clear" is the absence of weather, so drawing nothing would leave those
 * regions looking like missing data instead of a reported condition. A light
 * additive wash says "measured, and nothing is happening here".
 *
 * Tinted cool to sit inside the existing palette. The brief suggested a warm
 * rim-light, which would introduce a second accent temperature competing with
 * the blue globe and cyan wind - see README.
 */
const GLOW_COLOUR = '#cfeaff';

export default function SunnyGlow({ field, opacity = 0.38 }) {
  const texture = useMemo(() => {
    const clearness = new Float32Array(GRID_POINTS);
    for (let i = 0; i < GRID_POINTS; i++) {
      const category = field.category[i];
      // Fully clear reads strongest; "mainly clear" cells that landed in the
      // cloudy bucket still get a hint so the edges are not hard cut-outs.
      if (category === CATEGORY.CLEAR) {
        clearness[i] = 1 - Math.min(1, (field.cloudCover[i] || 0) / 100) * 0.45;
      } else if (category === CATEGORY.CLOUDY) {
        clearness[i] = Math.max(0, 0.35 - (field.cloudCover[i] || 0) / 300);
      }
    }
    return createGridTexture(clearness);
  }, [field]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh scale={1.006}>
      <sphereGeometry args={[GLOBE_RADIUS, 96, 64]} />
      <meshBasicMaterial
        color={GLOW_COLOUR}
        alphaMap={texture}
        transparent
        opacity={opacity}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  );
}
