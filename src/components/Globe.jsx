import { Component, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { createFlight, directionTo } from '../utils/cameraFlight';

export const GLOBE_RADIUS = 1;

/**
 * NASA Blue Marble, 4096x2048. Verified 2026-08-13: returns 200,
 * `content-type: image/jpeg`, and `access-control-allow-origin: *`, which is
 * what makes it usable as a WebGL texture. The equivalent three.js
 * example-texture paths on unpkg/jsdelivr
 * (`three@0.160.0/examples/textures/planets/...`) now 404 — they are not
 * published inside the npm package — so do not "restore" them here.
 *
 * It is 1.4 MB, the single heaviest asset in the app. The 93 KB `earth-dark.jpg`
 * alternative is far lighter but renders as near-black landmasses that are
 * illegible against a dark background; readability won.
 */
const EARTH_TEXTURE_URL =
  'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/earth-blue-marble.jpg';

/** Shown while the texture loads, and permanently if it fails to. */
function PlainGlobe({ dim = false }) {
  return (
    <mesh>
      <sphereGeometry args={[GLOBE_RADIUS, 64, 48]} />
      <meshStandardMaterial
        color={dim ? '#1c3661' : '#22406f'}
        roughness={0.95}
        metalness={0}
      />
    </mesh>
  );
}

function TexturedGlobe() {
  // useLoader suspends. The <Suspense> boundary lives in App.jsx — without one,
  // the canvas goes blank with no error in the console.
  const texture = useLoader(THREE.TextureLoader, EARTH_TEXTURE_URL);
  const { gl } = useThree();

  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
  }, [texture, gl]);

  return (
    <mesh>
      <sphereGeometry args={[GLOBE_RADIUS, 96, 64]} />
      <meshStandardMaterial
        map={texture}
        // A gentle emissive lift keeps the night side of the terminator readable.
        // The wind field covers the whole sphere, so letting half of it fall into
        // shadow would hide half the data.
        emissive="#ffffff"
        emissiveMap={texture}
        emissiveIntensity={0.32}
        roughness={0.85}
        metalness={0}
      />
    </mesh>
  );
}

/**
 * A thrown texture load (404, CORS, decode failure) does not land in a Suspense
 * fallback — it propagates as a render error, so it needs a real error boundary
 * or it takes the whole canvas down with it.
 */
class TextureBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn('[atmos] Earth texture failed, falling back to flat material:', error?.message);
    this.props.onError?.(error?.message || 'texture load failed');
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Soft blue halo at the limb, the way the atmosphere scatters in a photograph
 * of Earth.
 *
 * This needs a Fresnel term, not a plain translucent shell: a back-faced sphere
 * at uniform opacity renders as a flat disc with a hard circular edge, which
 * reads as a grey ring around the planet rather than a glow. Weighting opacity
 * by the view angle concentrates it at the limb and fades it to nothing
 * face-on, which is the whole effect. Additive blending over the background
 * gradient keeps it from muddying the dark side.
 */
const atmosphereVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const atmosphereFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uStrength;

  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    // Note there is no "1.0 -" here, which is the counter-intuitive part.
    // We render the shell's BACK faces, so within the visible ring between the
    // planet's edge and the shell's silhouette this term is largest right at the
    // planet and falls to zero outward — glow hugging the limb. Inverting it
    // puts the maximum on the outer silhouette instead, which draws a detached
    // blue donut floating around the planet.
    float rim = abs(dot(normalize(vNormal), normalize(vView)));
    gl_FragColor = vec4(uColor, pow(rim, uPower) * uStrength);
  }
`;

function Atmosphere() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: atmosphereVertex,
        fragmentShader: atmosphereFragment,
        uniforms: {
          uColor: { value: new THREE.Color('#6fb4ff') },
          uPower: { value: 2.0 },
          uStrength: { value: 1.5 },
        },
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );

  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh scale={1.12} material={material}>
      <sphereGeometry args={[GLOBE_RADIUS, 48, 32]} />
    </mesh>
  );
}

const IDLE_BEFORE_AUTOROTATE_MS = 3500;
const RESET_DURATION = 0.75; // seconds

/**
 * Zoom floor, set by the basemap's real resolution rather than by feel.
 *
 * The texture is 4096 px around 360° of longitude, so it carries ~652 px per
 * world unit at the equator. With a 42° vertical FOV, a camera at distance d
 * spreads 0.768·(d−1) world units across the viewport height, and magnification
 * passes 1:1 at roughly d = 2.8 on a 900 px-tall window — far enough out that
 * enforcing it strictly would forbid zooming at all. 1.75 caps magnification at
 * about 2.5×, which linear filtering and anisotropy carry without the texture
 * visibly breaking into texels.
 */
const MIN_DISTANCE = 1.75;
const MAX_DISTANCE = 5.5;
const FLIGHT_RADIUS = 2.0; // where a city flight comes to rest
const ZOOM_DURATION = 0.32; // seconds per button press
export const ZOOM_STEP = 0.78; // multiply distance per press; >1 zooms out

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function Controls({ resetRef, flyToRef, zoomRef }) {
  const [idle, setIdle] = useState(true);
  const timer = useRef(null);
  const controlsRef = useRef(null);
  // One slot for whichever animation is driving the camera: {kind:'reset'} or
  // {kind:'flight'}. Keeping them in a single slot means starting one
  // implicitly cancels the other rather than having both fight for the camera.
  const anim = useRef(null);
  const { camera } = useThree();

  useEffect(() => () => clearTimeout(timer.current), []);

  const onStart = () => {
    clearTimeout(timer.current);
    anim.current = null; // a manual drag cancels any camera animation
    setIdle(false);
  };
  const onEnd = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), IDLE_BEFORE_AUTOROTATE_MS);
  };

  /**
   * "Reset to north", the way Google Earth's compass behaves: level the tilt so
   * the north pole points up the screen, without teleporting the viewer to a
   * different part of the world. OrbitControls never rolls the camera, so the
   * only thing that can put north off-vertical is the polar angle — drive that
   * back to the equator and leave azimuth and zoom exactly where the user left
   * them.
   */
  useEffect(() => {
    if (!resetRef) return undefined;
    resetRef.current = () => {
      const controls = controlsRef.current;
      if (!controls) return;
      const from = controls.getPolarAngle();
      // Already level: nothing to animate.
      if (Math.abs(from - Math.PI / 2) < 0.001) return;
      anim.current = { kind: 'reset', fromPhi: from, t: 0 };
      clearTimeout(timer.current);
      setIdle(false);
    };
    return () => {
      resetRef.current = null;
    };
  }, [resetRef]);

  /**
   * Fly to a lat/lon. Auto-rotate is switched off for the duration and only
   * re-armed by the normal idle timer afterwards — otherwise OrbitControls keeps
   * spinning the azimuth underneath the animation and the camera never actually
   * arrives where it was sent.
   */
  useEffect(() => {
    if (!flyToRef) return undefined;
    flyToRef.current = (lat, lon) => {
      const controls = controlsRef.current;
      if (!controls) return;

      const offsetNow = new THREE.Vector3().copy(camera.position).sub(controls.target);
      anim.current = {
        kind: 'flight',
        flight: createFlight({
          fromDirection: offsetNow.clone().normalize(),
          toDirection: directionTo(lat, lon),
          fromRadius: offsetNow.length(),
          toRadius: FLIGHT_RADIUS,
        }),
      };
      clearTimeout(timer.current);
      setIdle(false);
    };
    return () => {
      flyToRef.current = null;
    };
  }, [flyToRef, camera]);

  /**
   * Stepped zoom for the on-screen buttons. Multiplicative rather than additive
   * so each press covers the same *proportion* of the remaining distance —
   * a fixed −0.3 step is a nudge when far out and a lurch when already close.
   * Clamped to the same limits the scroll wheel obeys.
   */
  useEffect(() => {
    if (!zoomRef) return undefined;
    zoomRef.current = (factor) => {
      const controls = controlsRef.current;
      if (!controls) return;
      const offsetNow = new THREE.Vector3().copy(camera.position).sub(controls.target);
      const from = offsetNow.length();
      const to = THREE.MathUtils.clamp(from * factor, MIN_DISTANCE, MAX_DISTANCE);
      if (Math.abs(to - from) < 0.001) return; // already at the stop
      anim.current = { kind: 'zoom', direction: offsetNow.normalize(), from, to, t: 0 };
      clearTimeout(timer.current);
      setIdle(false);
    };
    return () => {
      zoomRef.current = null;
    };
  }, [zoomRef, camera]);

  const spherical = useMemo(() => new THREE.Spherical(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    const current = anim.current;
    const controls = controlsRef.current;
    if (!current || !controls) return;

    if (current.kind === 'reset') {
      current.t = Math.min(1, current.t + delta / RESET_DURATION);
      const phi = THREE.MathUtils.lerp(current.fromPhi, Math.PI / 2, easeInOutCubic(current.t));

      // Rewrite only the polar component of the camera's position around the
      // orbit target; radius and azimuth are carried through untouched.
      offset.copy(camera.position).sub(controls.target);
      spherical.setFromVector3(offset);
      spherical.phi = phi;
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      camera.lookAt(controls.target);

      if (current.t >= 1) {
        anim.current = null;
        onEnd();
      }
      return;
    }

    if (current.kind === 'zoom') {
      current.t = Math.min(1, current.t + delta / ZOOM_DURATION);
      const radius = THREE.MathUtils.lerp(current.from, current.to, easeInOutCubic(current.t));
      camera.position.copy(controls.target).addScaledVector(current.direction, radius);
      camera.lookAt(controls.target);

      if (current.t >= 1) {
        anim.current = null;
        onEnd();
      }
      return;
    }

    const { direction, radius, done } = current.flight.advance(delta);
    camera.position.copy(controls.target).addScaledVector(direction, radius);
    camera.lookAt(controls.target);

    if (done) {
      anim.current = null;
      onEnd();
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.06}
      rotateSpeed={0.45}
      zoomSpeed={0.6}
      enablePan={false}
      // Clamped so the camera can neither enter the sphere nor shrink it to a dot.
      minDistance={MIN_DISTANCE}
      maxDistance={MAX_DISTANCE}
      autoRotate={idle}
      autoRotateSpeed={0.32}
      onStart={onStart}
      onEnd={onEnd}
    />
  );
}

export default function Globe({ onTextureError, resetRef, flyToRef, zoomRef }) {
  return (
    <>
      {/* Mostly flat lighting with one soft key. A hard terminator would look
          photographic but hide half the wind field. */}
      <ambientLight intensity={1.85} />
      <directionalLight position={[3, 1.5, 4]} intensity={0.8} color="#ffffff" />
      <directionalLight position={[-4, -1, -3]} intensity={0.5} color="#93b4ff" />

      <TextureBoundary fallback={<PlainGlobe dim />} onError={onTextureError}>
        <TexturedGlobe />
      </TextureBoundary>

      <Atmosphere />
      <Controls resetRef={resetRef} flyToRef={flyToRef} zoomRef={zoomRef} />
    </>
  );
}

export { PlainGlobe };
