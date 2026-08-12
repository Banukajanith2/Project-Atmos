import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import Globe, { PlainGlobe, ZOOM_STEP } from './components/Globe';
import WindParticles from './components/WindParticles';
import RainLayer from './components/RainLayer';
import ThunderLayer from './components/ThunderLayer';
import SnowLayer from './components/SnowLayer';
import SunnyGlow from './components/SunnyGlow';
import CloudLayer from './components/CloudLayer';
import CityMarker from './components/CityMarker';
import HUD from './components/HUD';
import { useWindData } from './hooks/useWindData';
import { useCityWeather } from './hooks/useCityWeather';

// `particles` counts streaks, not vertices - each one is drawn as a short trail
// of points (see WindParticles TAIL), all inside the same single geometry.
// `precip` is the per-layer budget for rain/snow/thunder drops.
const QUALITY = {
  high: { particles: 2800, dpr: [1, 2], precip: 2600 },
  low: { particles: 700, dpr: [1, 1.5], precip: 700 },
};

/** Stacking every layer at once is noise, not information. */
const MAX_ACTIVE_LAYERS = 3;

// Wind only, so the globe on load looks exactly as it did before this phase.
const DEFAULT_LAYERS = ['wind'];

/**
 * Capability probe, never a brand check. `navigator.deviceMemory` is
 * Chromium-only - iOS Safari reports nothing at all - so a missing value must
 * mean "unknown", not "fast". Whatever this misses is caught afterwards by the
 * live frame-time probe below.
 */
function probeCapability() {
  if (typeof navigator === 'undefined') return { tier: 'high', reason: null };

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return { tier: 'low', reason: 'Reduced-motion is enabled in your system settings' };
  }

  const memory = navigator.deviceMemory;
  if (typeof memory === 'number' && memory <= 4) {
    return { tier: 'low', reason: `This device reports ${memory} GB of memory` };
  }

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === 'number' && cores <= 4) {
    return { tier: 'low', reason: `This device reports ${cores} logical cores` };
  }

  return { tier: 'high', reason: null };
}

const SAMPLE_WINDOW = 0.5; // seconds per fps sample
const WARMUP = 3; // ignore shader compile / texture upload hitches
const SLOW_FPS = 38;
const SLOW_SAMPLES_BEFORE_DOWNGRADE = 3;

/** Measures real frame time and downgrades once if the device cannot keep up. */
function PerfProbe({ statsRef, onSustainedSlowdown }) {
  const acc = useRef({ time: 0, frames: 0, warmup: 0, slowRun: 0, fired: false });

  useFrame((_, delta) => {
    const a = acc.current;
    a.warmup += delta;
    a.time += delta;
    a.frames += 1;
    if (a.time < SAMPLE_WINDOW) return;

    const fps = a.frames / a.time;
    statsRef.current.fps = fps;
    a.time = 0;
    a.frames = 0;

    if (a.fired || a.warmup < WARMUP) return;

    a.slowRun = fps < SLOW_FPS ? a.slowRun + 1 : 0;
    if (a.slowRun >= SLOW_SAMPLES_BEFORE_DOWNGRADE) {
      a.fired = true;
      onSustainedSlowdown(Math.round(fps));
    }
  });

  return null;
}

export default function App() {
  const wind = useWindData();
  const [quality, setQuality] = useState(probeCapability);
  const [textureFallback, setTextureFallback] = useState(false);
  const [activeLayers, setActiveLayers] = useState(DEFAULT_LAYERS);
  const statsRef = useRef({ fps: 0 });

  const settings = QUALITY[quality.tier];

  const handleSlowdown = useCallback((fps) => {
    setQuality((prev) =>
      prev.tier === 'low'
        ? prev
        : { tier: 'low', reason: `This device sustained only ${fps} fps at full quality` },
    );
  }, []);

  const handleTextureError = useCallback(() => setTextureFallback(true), []);

  // Imperative handles into the R3F scene. These controls live in the DOM
  // overlay, outside <Canvas>, so they cannot touch OrbitControls directly.
  const resetNorthRef = useRef(null);
  const flyToRef = useRef(null);
  const zoomRef = useRef(null);
  const handleResetNorth = useCallback(() => resetNorthRef.current?.(), []);
  const handleZoomIn = useCallback(() => zoomRef.current?.(ZOOM_STEP), []);
  const handleZoomOut = useCallback(() => zoomRef.current?.(1 / ZOOM_STEP), []);

  const [selectedPlace, setSelectedPlace] = useState(null);
  const cityWeather = useCityWeather(selectedPlace);

  const handleSelectPlace = useCallback((place) => {
    setSelectedPlace(place);
    flyToRef.current?.(place.latitude, place.longitude);
  }, []);

  const handleClearPlace = useCallback(() => setSelectedPlace(null), []);

  const maxActiveLayers = quality.tier === 'high' ? MAX_ACTIVE_LAYERS : 1;

  /**
   * Toggling past the cap drops the *oldest* selection rather than rejecting the
   * tap. A button that visibly does nothing reads as broken; this way the newest
   * intent always wins and the cap stays invisible until it matters.
   */
  const handleToggleLayer = useCallback(
    (id) => {
      setActiveLayers((prev) => {
        if (prev.includes(id)) return prev.filter((l) => l !== id);
        const next = [...prev, id];
        return next.slice(Math.max(0, next.length - maxActiveLayers));
      });
    },
    [maxActiveLayers],
  );

  // Dropping to reduced quality mid-session must also enforce the tighter cap on
  // whatever was already switched on.
  useEffect(() => {
    setActiveLayers((prev) =>
      prev.length <= maxActiveLayers ? prev : prev.slice(prev.length - maxActiveLayers),
    );
  }, [maxActiveLayers]);

  const isOn = (id) => activeLayers.includes(id);

  return (
    <div className="app">
      <Canvas
        dpr={settings.dpr}
        camera={{ position: [0, 0.35, 3.1], fov: 42 }}
        // Transparent so the CSS gradient behind the canvas shows through,
        // rather than painting a flat clear colour over it.
        gl={{ antialias: quality.tier === 'high', powerPreference: 'high-performance', alpha: true }}
      >
        {/* <Canvas> owns resize handling. Do not call setSize/setPixelRatio
            anywhere else - a second writer fights it and the view jumps. */}

        {/* useLoader inside <Globe> suspends; this boundary is what keeps the
            canvas from silently rendering nothing while the texture downloads. */}
        <Suspense fallback={<PlainGlobe />}>
          <Globe
            onTextureError={handleTextureError}
            resetRef={resetNorthRef}
            flyToRef={flyToRef}
            zoomRef={zoomRef}
          />
        </Suspense>

        {/* Every layer below is mounted only while it is switched on. Unmounting
            is the pause: a hidden-but-mounted layer would keep running its
            useFrame simulation and cost exactly as much as a visible one. */}

        {/* Deliberately outside Suspense: the wind field should animate from the
            first frame rather than waiting on the basemap. */}
        {isOn('wind') && <WindParticles field={wind.field} count={settings.particles} />}
        {isOn('rain') && <RainLayer field={wind.field} budget={settings.precip} />}
        {isOn('thunder') && <ThunderLayer field={wind.field} budget={settings.precip} />}
        {isOn('snow') && <SnowLayer field={wind.field} budget={settings.precip} />}
        {isOn('clear') && <SunnyGlow field={wind.field} />}
        {isOn('clouds') && <CloudLayer field={wind.field} />}

        {selectedPlace && <CityMarker place={selectedPlace} weather={cityWeather.data} />}

        <PerfProbe statsRef={statsRef} onSustainedSlowdown={handleSlowdown} />
      </Canvas>

      <HUD
        status={wind.status}
        error={wind.error}
        updatedAt={wind.updatedAt}
        observedAt={wind.observedAt}
        gridPoints={wind.gridPoints}
        filled={wind.filled}
        refetchMs={wind.refetchMs}
        quality={quality}
        particleCount={settings.particles}
        statsRef={statsRef}
        textureFallback={textureFallback}
        onResetNorth={handleResetNorth}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        activeLayers={activeLayers}
        maxActiveLayers={maxActiveLayers}
        onToggleLayer={handleToggleLayer}
        onSelectPlace={handleSelectPlace}
        onClearPlace={handleClearPlace}
        selectedPlace={selectedPlace}
        cityWeather={cityWeather}
      />
    </div>
  );
}
