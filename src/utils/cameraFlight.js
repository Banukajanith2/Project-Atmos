import * as THREE from 'three';
import { latLonToVec3 } from './windField';

/**
 * Camera flight from wherever the camera is now to directly above a lat/lon.
 *
 * The interpolation is done on the camera's *direction* as a rotation, not on
 * its lat/lon or its xyz position:
 *
 *   - Lerping lat/lon takes the long way round whenever the two points straddle
 *     the antimeridian (a flight from 175°E to 175°W travels 350° eastward
 *     instead of 10° westward).
 *   - Lerping xyz cuts a straight chord through the globe's interior, so the
 *     camera dives through the planet and pops out the other side.
 *
 * Slerping the rotation between the two direction vectors gives a great-circle
 * arc over the surface, which is both correct and what the eye expects.
 * `setFromUnitVectors` also handles the exactly-antipodal case internally by
 * choosing an arbitrary perpendicular axis, so a 180° flight still resolves.
 */

export const FLIGHT_DURATION = 1.9; // seconds

/** Ease in/out — no abrupt start or stop at either end of the arc. */
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const _scratch = [0, 0, 0];

/** Unit vector pointing at the given lat/lon on the globe. */
export function directionTo(lat, lon) {
  latLonToVec3(lat, lon, 1, _scratch);
  return new THREE.Vector3(_scratch[0], _scratch[1], _scratch[2]).normalize();
}

/**
 * @returns a flight object with `advance(dt)` -> {direction, radius, done}.
 */
export function createFlight({ fromDirection, toDirection, fromRadius, toRadius, duration = FLIGHT_DURATION }) {
  const start = fromDirection.clone().normalize();
  const end = toDirection.clone().normalize();
  const rotation = new THREE.Quaternion().setFromUnitVectors(start, end);
  const identity = new THREE.Quaternion();

  const direction = new THREE.Vector3();
  const step = new THREE.Quaternion();

  let elapsed = 0;

  return {
    advance(dt) {
      elapsed = Math.min(duration, elapsed + dt);
      const t = duration > 0 ? elapsed / duration : 1;
      const eased = easeInOutCubic(t);

      step.copy(identity).slerp(rotation, eased);
      direction.copy(start).applyQuaternion(step);

      return {
        direction,
        radius: THREE.MathUtils.lerp(fromRadius, toRadius, eased),
        done: t >= 1,
      };
    },
  };
}
