import { useEffect, useState } from 'react';
import { SPEED_STOPS, MS_TO_KMH } from '../utils/windField';
import { FULL_SCALE } from '../utils/auroraGrid';
import SearchBar from './SearchBar';
import FilterPanel from './FilterPanel';

const STATUS_LABEL = {
  idle: 'Standby',
  loading: 'Connecting',
  live: 'Live',
  // Real observed weather, just fetched at deploy time rather than by this
  // browser. Named rather than folded into "Live" because the Observed row
  // beside it can legitimately read a couple of hours old, and a pill claiming
  // "Live" over a three-hour-old timestamp is the kind of small dishonesty that
  // makes a reader distrust the rest of the panel.
  snapshot: 'Snapshot',
  fallback: 'Offline data',
};

function formatClock(ms) {
  if (!ms) return '-';
  return new Date(ms).toISOString().slice(11, 16) + ' UTC';
}

function formatObserved(iso) {
  if (!iso) return '-';
  const [date, time] = iso.split('T');
  // NOAA stamps a trailing Z that Open-Meteo omits; strip it so the two sources
  // render identically rather than one reading "05:50:00Z UTC".
  return `${date} · ${time.replace('Z', '').slice(0, 5)} UTC`;
}

/** Refresh cadences now span 5 minutes to 3 hours; "180 minutes" reads badly. */
function formatCadence(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  const rounded = Number.isInteger(hours) ? hours : hours.toFixed(1);
  return `${rounded} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** Subsolar point, as a plain compass-signed lat/lon pair. */
function formatLatLon({ lat, lon } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '-';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

const legendGradient = `linear-gradient(90deg, ${SPEED_STOPS.map(
  (stop, i) => `${stop.hex} ${(i / (SPEED_STOPS.length - 1)) * 100}%`,
).join(', ')})`;

/**
 * Mirrors the ramp in `auroraColor`, so the legend cannot drift away from what
 * is actually drawn on the globe.
 */
const auroraGradient =
  'linear-gradient(90deg, rgba(20,150,170,0) 0%, rgb(20,150,170) 18%, ' +
  'rgb(46,228,190) 55%, rgb(210,255,245) 100%)';

/** Ticks across the aurora legend, in percentage points of visibility chance. */
const AURORA_TICKS = [0, FULL_SCALE / 3, (FULL_SCALE * 2) / 3, FULL_SCALE];

/**
 * Frame stats live in a mutable ref written by the render loop. The HUD polls it
 * on its own slow timer instead of receiving it as a prop, so a 60 Hz scene
 * never triggers a 60 Hz React render.
 */
function useFrameStats(statsRef) {
  const [stats, setStats] = useState({ fps: 0 });
  useEffect(() => {
    const id = setInterval(() => setStats({ fps: Math.round(statsRef.current.fps) }), 500);
    return () => clearInterval(id);
  }, [statsRef]);
  return stats;
}

function Stat({ label, value, accent = false }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={accent ? 'stat__value stat__value--accent' : 'stat__value'}>{value}</span>
    </div>
  );
}

export default function HUD({
  status,
  error,
  updatedAt,
  observedAt,
  gridPoints,
  filled,
  refetchMs,
  quality,
  particleCount,
  statsRef,
  textureFallback,
  onResetNorth,
  onZoomIn,
  onZoomOut,
  activeLayers,
  maxActiveLayers,
  onToggleLayer,
  onSelectPlace,
  onClearPlace,
  selectedPlace,
  cityWeather,
  mode,
  aurora,
  sun,
}) {
  const { fps } = useFrameStats(statsRef);
  const isAurora = mode === 'aurora';

  return (
    <div className="hud">
      <header className="card hud__brand">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 8h11a3 3 0 1 0-3-3" />
              <path d="M3 13h15a3 3 0 1 1-3 3" />
              <path d="M3 18h8" />
            </svg>
          </span>
          <div>
            <h1 className="brand__name">Project Atmos</h1>
            <p className="brand__sub">
              {isAurora
                ? 'Auroral oval · NOAA OVATION nowcast'
                : 'Global surface wind · 10 m above ground'}
            </p>
          </div>
        </div>
      </header>

      {/* Both modes read from different endpoints on different cadences, so the
          data panel reports whichever one is actually driving the globe rather
          than showing stale wind figures under an aurora. */}
      {isAurora ? (
        <section className="card hud__data">
          <div className={`pill pill--${aurora.status}`}>
            <span className="pill__dot" aria-hidden="true" />
            {STATUS_LABEL[aurora.status]}
          </div>
          <div className="stats">
            <Stat label="Observed" value={formatObserved(aurora.observedAt)} />
            {/* "Forecast for" wraps this 268px card onto a second line; the
                stamp is the same width as the Observed row above it. */}
            <Stat label="Forecast" value={formatObserved(aurora.forecastAt)} />
            <Stat label="Peak chance" value={`${Math.round(aurora.peak || 0)}%`} />
            <Stat label="Subsolar point" value={formatLatLon(sun)} />
            <Stat label="Refreshes every" value={formatCadence(aurora.refetchMs)} />
          </div>
        </section>
      ) : (
        <section className="card hud__data">
          <div className={`pill pill--${status}`}>
            <span className="pill__dot" aria-hidden="true" />
            {STATUS_LABEL[status]}
          </div>
          <div className="stats">
            <Stat label="Observed" value={formatObserved(observedAt)} />
            <Stat label="Retrieved" value={formatClock(updatedAt)} />
            <Stat label="Coverage" value={`${filled || 0} of ${gridPoints} points`} />
            <Stat label="Refreshes every" value={formatCadence(refetchMs)} />
          </div>
        </section>
      )}

      <div className="hud__search">
        <SearchBar onSelect={onSelectPlace} onClear={onClearPlace} selected={selectedPlace} />
      </div>

      {/* Stays up in Aurora mode: the Aurora chip lives in this row, so hiding it
          would remove the only way back out. */}
      <div className="hud__filters">
        <FilterPanel active={activeLayers} onToggle={onToggleLayer} maxActive={maxActiveLayers} />
      </div>

      {/* Icon-only controls: each accessible name lives in aria-label, and the
          tooltip carries it for sighted mouse users. */}
      <div className="map-controls">
        <button
          type="button"
          className="map-btn"
          onClick={onZoomIn}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 6v12M6 12h12" />
          </svg>
        </button>

        <button
          type="button"
          className="map-btn"
          onClick={onZoomOut}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 12h12" />
          </svg>
        </button>

        <button
          type="button"
          className="map-btn compass"
          onClick={onResetNorth}
          aria-label="Reset view to north"
          title="Reset view to north"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".45" />
            <path d="M12 4.9 15.1 12H8.9L12 4.9Z" fill="currentColor" />
            <path d="M8.9 12h6.2L12 19.1 8.9 12Z" fill="currentColor" opacity=".32" />
          </svg>
        </button>
      </div>

      {isAurora ? (
        <section className="card hud__legend">
          <p className="card__title">Aurora visibility</p>
          <div className="legend__bar" style={{ background: auroraGradient }} />
          <div className="legend__scale">
            {AURORA_TICKS.map((tick) => (
              <span key={tick}>{Math.round(tick)}</span>
            ))}
          </div>
          {/* The gain is stated rather than hidden: the scale tops out well below
              100% because an ordinary night never reaches it, and a legend that
              claimed otherwise would imply the display was broken. */}
          <p className="legend__unit">% chance of visible aurora</p>
        </section>
      ) : (
        <section className="card hud__legend">
          <p className="card__title">Wind speed</p>
          <div className="legend__bar" style={{ background: legendGradient }} />
          <div className="legend__scale">
            {SPEED_STOPS.map((stop) => (
              <span key={stop.speed}>{Math.round(stop.speed * MS_TO_KMH)}</span>
            ))}
          </div>
          <p className="legend__unit">kilometres per hour</p>
        </section>
      )}

      <section className="card hud__perf">
        <div className="stats stats--tight">
          <Stat
            label={isAurora ? 'Grid' : 'Streaks'}
            value={
              isAurora
                ? `${quality.tier === 'high' ? '360 × 181' : '180 × 91'}`
                : particleCount.toLocaleString()
            }
            accent
          />
          <Stat label="Frame rate" value={fps ? `${fps} fps` : '-'} accent />
          <Stat label="Quality" value={quality.tier === 'high' ? 'Full' : 'Reduced'} accent />
        </div>
      </section>

      <div className="hud__notices">
        {isAurora && aurora.status === 'fallback' && (
          <p className="notice notice--warn">
            <strong>Live aurora unavailable.</strong> Showing a modelled oval around each
            geomagnetic pole.{aurora.error ? ` ${aurora.error}` : ''}
          </p>
        )}
        {isAurora && aurora.status === 'live' && aurora.error && (
          <p className="notice notice--warn">
            <strong>Refresh failed.</strong> Showing the last good nowcast. {aurora.error}
          </p>
        )}
        {!isAurora && status === 'fallback' && (
          <p className="notice notice--warn">
            <strong>Live wind unavailable.</strong> Showing a synthetic climatological field.
            {error ? ` ${error}` : ''}
          </p>
        )}
        {!isAurora && (status === 'live' || status === 'snapshot') && error && (
          <p className="notice notice--warn">
            <strong>Refresh failed.</strong> Showing the last good reading. {error}
          </p>
        )}
        {quality.tier === 'low' && (
          <p className="notice">
            <strong>Reduced quality.</strong> {quality.reason}.
          </p>
        )}
        {textureFallback && (
          <p className="notice">
            <strong>Earth imagery unavailable.</strong> Falling back to flat shading.
          </p>
        )}
        {cityWeather?.status === 'error' && (
          <p className="notice notice--warn">
            <strong>Could not load conditions</strong> for {selectedPlace?.name}. {cityWeather.error}
          </p>
        )}
      </div>
    </div>
  );
}
