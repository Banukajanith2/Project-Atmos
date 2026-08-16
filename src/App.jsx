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
import AuroraLayer from './components/AuroraLayer';
import HUD from './components/HUD';
import { AURORA_LAYER } from './components/FilterPanel';
import { useWindData } from './hooks/useWindData';
import { useCityWeather } from './hooks/useCityWeather';
import { useAuroraData } from './hooks/useAuroraData';
import { useSunPosition } from './hooks/useSunPosition';

// `particles` counts streaks, not vertices - each one is drawn as a short trail
// of points (see WindParticles TAIL), all inside the same single geometry.
// `precip` is the per-layer budget for rain/snow/thunder drops.
const QUALITY = {
  high: { particles: 2800, dpr: [1, 2], precip: 2600, auroraStep: 1 },
  // The aurora grid is downsampled rather than dropped: 180x91 still resolves
  // the oval, at a quarter of the rasterise cost and a quarter of the texture
  // upload.
  low: { particles: 700, dpr: [1, 1.5], precip: 700, auroraStep: 2 },
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

/**
 * Seconds to cross between Wind and Aurora. Long enough to read as a scene
 * changing rather than a switch flipping, short enough not to feel like waiting.
 */
const MODE_TRANSITION_SECONDS = 1.4;

/**
 * The single writer of the mode crossfade.
 *
 * `transitionRef` runs 0 (Wind) to 1 (Aurora) and every affected layer reads it
 * from its own `useFrame` - globe lighting, atmosphere strength, aurora opacity,
 * particle alpha. Driving it through a ref rather than React state is what keeps
 * a 1.4-second animation from triggering ~84 renders of the whole tree, and it
 * is the reason the `<Canvas>` never remounts: nothing above it changes while
 * the crossfade runs.
 *
 * The ramp is linear here and eased by each consumer, so a toggle pressed
 * mid-transition simply reverses from wherever the value had reached instead of
 * snapping back to the start.
 */
function ModeTransition({ target, transitionRef, onSettled }) {
  useFrame((_, delta) => {
    const current = transitionRef.current;
    if (current === target) return;

    const step = Math.min(delta, 0.05) / MODE_TRANSITION_SECONDS;
    const next =
      target > current ? Math.min(target, current + step) : Math.max(target, current - step);

    transitionRef.current = next;
    if (next === target) onSettled();
  });

  return null;
}

export default function App() {
  const wind = useWindData();
  const [quality, setQuality] = useState(probeCapability);
  const [transitioning, setTransitioning] = useState(false);
  const transitionRef = useRef(0);
  const [textureFallback, setTextureFallback] = useState(false);
  const [activeLayers, setActiveLayers] = useState(DEFAULT_LAYERS);
  const statsRef = useRef({ fps: 0 });

  /**
   * Mode is derived from the layer selection rather than stored beside it. Two
   * pieces of state describing the same thing can disagree, and this one would:
   * every path that clears Aurora would also have to remember to set the mode
   * back, and any that forgot would leave a dark Earth with the wind chips lit.
   */
  const auroraOn = activeLayers.includes(AURORA_LAYER);
  const mode = auroraOn ? 'aurora' : 'wind';

  // Lazy: nothing is requested until Aurora is selected for the first time.
  const aurora = useAuroraData(auroraOn);
  const sun = useSunPosition();

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
  const poleRef = useRef(null);
  const handleResetNorth = useCallback(() => resetNorthRef.current?.(), []);
  const handleZoomIn = useCallback(() => zoomRef.current?.(ZOOM_STEP), []);
  const handleZoomOut = useCallback(() => zoomRef.current?.(1 / ZOOM_STEP), []);

  const handleSettled = useCallback(() => setTransitioning(false), []);

  /**
   * The layer selection to put back when Aurora is switched off, so leaving the
   * mode restores whatever the user had rather than dumping them on a default.
   */
  const restoreRef = useRef(DEFAULT_LAYERS);

  /**
   * Which oval to point the camera at. Held in a ref because the value arrives
   * from the network, and the ease that reads it is fired from a click handler.
   */
  const hemisphereRef = useRef(aurora.hemisphere);
  hemisphereRef.current = aurora.hemisphere;

  /**
   * Send the camera poleward, unless the user is already looking somewhere
   * poleward, in which case `poleRef` declines and leaves the view alone.
   *
   * Deferred until the grid is live rather than fired on the press. Which oval
   * is worth looking at is a property of the data, and on a cold first open the
   * data is still in flight - aiming immediately would pick the default
   * hemisphere and could fly to the quiet pole. A second corrective ease is not
   * an option either: by then the camera is already poleward, so the
   * "leave the user alone" guard declines it and the wrong view sticks. Waiting
   * costs under a second and always aims once, at the right oval.
   */
  const pendingEaseRef = useRef(false);

  const requestPoleward = useCallback((isLive) => {
    if (isLive) poleRef.current?.(hemisphereRef.current);
    else pendingEaseRef.current = true;
  }, []);

  useEffect(() => {
    if (!auroraOn || aurora.status !== 'live' || !pendingEaseRef.current) return;
    pendingEaseRef.current = false;
    poleRef.current?.(hemisphereRef.current);
  }, [auroraOn, aurora.status]);

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
   *
   * Aurora is the exception: it takes the globe on its own, so selecting it
   * clears everything else and deselecting it restores what was there. Every
   * branch that crosses into or out of Aurora also starts the crossfade.
   *
   * Written against `activeLayers` rather than as a state updater because the
   * Aurora branches have side effects - stashing the restore list, starting the
   * transition, moving the camera - and React may run an updater twice under
   * StrictMode, which would fire all three twice.
   */
  const handleToggleLayer = useCallback(
    (id) => {
      if (id === AURORA_LAYER) {
        if (auroraOn) {
          setActiveLayers(restoreRef.current.length ? restoreRef.current : DEFAULT_LAYERS);
        } else {
          restoreRef.current = activeLayers;
          setActiveLayers([AURORA_LAYER]);
          requestPoleward(aurora.status === 'live');
        }
        setTransitioning(true);
        return;
      }

      // A weather chip pressed while Aurora is on is a request to leave Aurora.
      // The press selects that layer outright rather than merging it into the
      // stashed set, so the tap does the obvious thing.
      if (auroraOn) {
        setActiveLayers([id]);
        setTransitioning(true);
        return;
      }

      setActiveLayers((prev) => {
        if (prev.includes(id)) return prev.filter((l) => l !== id);
        const next = [...prev, id];
        return next.slice(Math.max(0, next.length - maxActiveLayers));
      });
    },
    [activeLayers, aurora.status, auroraOn, maxActiveLayers, requestPoleward],
  );

  // Dropping to reduced quality mid-session must also enforce the tighter cap on
  // whatever was already switched on.
  useEffect(() => {
    setActiveLayers((prev) =>
      prev.length <= maxActiveLayers ? prev : prev.slice(prev.length - maxActiveLayers),
    );
  }, [maxActiveLayers]);

  const isOn = (id) => activeLayers.includes(id);

  /**
   * Mounting, not visibility, is how a layer is switched off here - a hidden but
   * mounted layer keeps running its `useFrame` and costs a full simulation step
   * per frame for nothing.
   *
   * Wind particles outlive the switch into Aurora by the length of the crossfade
   * so they have something to fade *out* of; once `transitioning` clears they
   * unmount and the simulation genuinely stops. The `restoreRef` term is what
   * keeps them mounted through that fade, since the selection they were part of
   * has already been replaced by the time it starts. The remaining Phase 1.5
   * layers are cut at the press instead, while the whole scene is changing
   * anyway, rather than being left at full strength and popping out at the end.
   */
  const windMounted =
    isOn('wind') || (transitioning && auroraOn && restoreRef.current.includes('wind'));
  const auroraMounted = auroraOn || transitioning;

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
        {/* Mounted unconditionally, above every consumer, so it advances the
            crossfade before anything reads it. */}
        <ModeTransition
          target={auroraOn ? 1 : 0}
          transitionRef={transitionRef}
          onSettled={handleSettled}
        />

        <Suspense fallback={<PlainGlobe />}>
          <Globe
            onTextureError={handleTextureError}
            resetRef={resetNorthRef}
            flyToRef={flyToRef}
            zoomRef={zoomRef}
            poleRef={poleRef}
            transitionRef={transitionRef}
            sunDirection={sun.direction}
          />
        </Suspense>

        {/* Every layer below is mounted only while it is switched on. Unmounting
            is the pause: a hidden-but-mounted layer would keep running its
            useFrame simulation and cost exactly as much as a visible one. */}

        {/* Deliberately outside Suspense: the wind field should animate from the
            first frame rather than waiting on the basemap. */}
        {windMounted && (
          <WindParticles
            field={wind.field}
            count={settings.particles}
            transitionRef={transitionRef}
          />
        )}
        {isOn('rain') && <RainLayer field={wind.field} budget={settings.precip} />}
        {isOn('thunder') && <ThunderLayer field={wind.field} budget={settings.precip} />}
        {isOn('snow') && <SnowLayer field={wind.field} budget={settings.precip} />}
        {isOn('clear') && <SunnyGlow field={wind.field} />}
        {isOn('clouds') && <CloudLayer field={wind.field} />}

        {auroraMounted && (
          <AuroraLayer
            values={aurora.values}
            step={settings.auroraStep}
            transitionRef={transitionRef}
          />
        )}

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
        mode={mode}
        aurora={aurora}
        sun={sun}
      />
    </div>
  );
}
