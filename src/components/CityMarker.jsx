import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { latLonToVec3 } from '../utils/windField';
import { describeWeatherCode } from '../utils/weatherCodes';
import { GLOBE_RADIUS } from './Globe';

const MARKER_RADIUS = GLOBE_RADIUS * 1.002;
const PULSE_PERIOD = 2.4; // seconds

/**
 * A locator reticle, not a city boundary.
 *
 * Actual administrative limits would need a separate polygon dataset (Natural
 * Earth, OSM boundaries) that the weather API does not carry — see README. A
 * pulsing ring at the exact coordinate communicates the same thing at this
 * zoom level for none of the payload.
 */
export default function CityMarker({ place, weather }) {
  const groupRef = useRef(null);
  const pulseRef = useRef(null);
  const { camera } = useThree();
  const [facing, setFacing] = useState(true);

  const { position, quaternion } = useMemo(() => {
    const out = [0, 0, 0];
    latLonToVec3(place.latitude, place.longitude, MARKER_RADIUS, out);
    const pos = new THREE.Vector3(out[0], out[1], out[2]);
    // Lay the rings flat against the surface: +Z of the group points outward.
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      pos.clone().normalize(),
    );
    return { position: pos, quaternion: q };
  }, [place.latitude, place.longitude]);

  const clock = useRef(0);
  const normal = useMemo(() => position.clone().normalize(), [position]);
  const toCamera = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    clock.current += delta;

    // Expanding ring: grows outward and fades, restarting each period.
    const t = (clock.current % PULSE_PERIOD) / PULSE_PERIOD;
    if (pulseRef.current) {
      const scale = 1 + t * 2.6;
      pulseRef.current.scale.set(scale, scale, scale);
      pulseRef.current.material.opacity = (1 - t) * 0.7;
    }

    // The globe is opaque, so a marker on the far side must be hidden — the
    // label is an HTML overlay and would otherwise float over the planet with
    // nothing to attach it to.
    toCamera.copy(camera.position).sub(position).normalize();
    const visible = normal.dot(toCamera) > 0.08;
    if (visible !== facing) setFacing(visible);
  });

  const temperature = weather?.temperature_2m;
  const windSpeed = weather?.wind_speed_10m;
  const condition = weather ? describeWeatherCode(weather.weather_code) : null;

  return (
    <group ref={groupRef} position={position} quaternion={quaternion} visible={facing}>
      {/* Expanding pulse */}
      <mesh ref={pulseRef}>
        <ringGeometry args={[0.016, 0.021, 48]} />
        <meshBasicMaterial color="#5fd0ff" transparent opacity={0.7} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {/* Static reticle */}
      <mesh>
        <ringGeometry args={[0.014, 0.018, 48]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.9} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh>
        <circleGeometry args={[0.006, 24]} />
        <meshBasicMaterial color="#5fd0ff" side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {facing && (
        // No distanceFactor: the label keeps a fixed screen size rather than
        // scaling with zoom, the way a map label should. Scaling it in world
        // units makes it swallow the globe as the camera closes in.
        <Html center position={[0, 0.055, 0]} zIndexRange={[9, 0]}>
          <div className="marker">
            <p className="marker__name">{place.name}</p>
            <p className="marker__place">
              {[place.admin1, place.country].filter(Boolean).join(' · ')}
            </p>
            {weather && (
              <div className="marker__badge">
                <span className="marker__temp">{Math.round(temperature)}°C</span>
                <span className="marker__cond">{condition}</span>
                <span className="marker__wind">{Math.round(windSpeed)} km/h wind</span>
                {/* Labelled, because this is a point reading and the ambient
                    layer is a smoothed 10° field — they will differ. */}
                <span className="marker__source">Current conditions</span>
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}
