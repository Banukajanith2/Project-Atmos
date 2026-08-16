import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { rasterizeAurora } from '../utils/auroraGrid';
import { GLOBE_RADIUS } from './Globe';

/**
 * Just clear of the surface. Any closer and z-fighting speckles the oval where
 * it crosses the terminator; any further and it visibly detaches from the limb
 * and reads as a ring hovering off the planet - the same failure the atmosphere
 * shell had in Phase 1.
 */
const SHELL_RADIUS = GLOBE_RADIUS * 1.018;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uLimb;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    vec4 texel = texture2D(uMap, vUv);
    if (texel.a <= 0.0) discard;

    // Grazing view angles look along the emitting shell rather than through it,
    // so the same column of air stacks up brighter at the limb. This is the one
    // cue that stops the overlay reading as a decal painted on the surface, and
    // it is why real aurora photographed from orbit glows hardest on the edge.
    float ndv = abs(dot(normalize(vNormal), normalize(vView)));
    float limb = 1.0 + uLimb * pow(1.0 - ndv, 2.5);

    gl_FragColor = vec4(texel.rgb, texel.a * uOpacity * limb);
  }
`;

/**
 * The auroral oval, drawn as a single additive shell over the globe.
 *
 * Opacity is driven from `transitionRef` inside `useFrame` rather than from a
 * prop, so the 1.4-second crossfade never re-renders React. The component only
 * re-renders when the grid itself changes, which is once every five minutes.
 */
export default function AuroraLayer({ values, step = 1, transitionRef }) {
  // One canvas and one texture for the life of the component. The 5-minute
  // refresh redraws into the same canvas and flips `needsUpdate`, so a refresh
  // re-uploads the texture without reallocating it or dropping a frame to a
  // fresh GPU allocation.
  const canvas = useMemo(() => document.createElement('canvas'), []);

  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    // Longitude is circular; the oval regularly crosses the antimeridian and
    // would otherwise show a seam there. Latitude clamps - there is nothing
    // past the poles to repeat.
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  }, [canvas]);

  // Rasterising is ~65k reads plus two blur passes. It runs here, in an effect
  // tied to the data, never in useFrame.
  useEffect(() => {
    if (!values) return;
    rasterizeAurora(values, { step, canvas });
    texture.needsUpdate = true;
  }, [values, step, canvas, texture]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uMap: { value: texture },
          uOpacity: { value: 0 },
          uLimb: { value: 1.35 },
        },
        transparent: true,
        // Depth-tested against the globe so the oval over the far pole stays
        // hidden behind the planet instead of showing through it.
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
      }),
    [texture],
  );

  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame(() => {
    const t = transitionRef?.current ?? 1;
    // Eased late so the glow arrives after the Earth has already darkened,
    // rather than washing out against a still-lit day side.
    material.uniforms.uOpacity.value = t * t;
  });

  return (
    <mesh material={material} frustumCulled={false}>
      <sphereGeometry args={[SHELL_RADIUS, 96, 64]} />
    </mesh>
  );
}
