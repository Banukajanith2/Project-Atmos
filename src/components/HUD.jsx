import { useEffect, useState } from 'react';
import { SPEED_STOPS, MS_TO_KMH } from '../utils/windField';
import SearchBar from './SearchBar';
import FilterPanel from './FilterPanel';

const STATUS_LABEL = {
  loading: 'Connecting',
  live: 'Live',
  fallback: 'Offline data',
};

function formatClock(ms) {
  if (!ms) return '-';
  return new Date(ms).toISOString().slice(11, 16) + ' UTC';
}

function formatObserved(iso) {
  if (!iso) return '-';
  const [date, time] = iso.split('T');
  return `${date} · ${time} UTC`;
}

const legendGradient = `linear-gradient(90deg, ${SPEED_STOPS.map(
  (stop, i) => `${stop.hex} ${(i / (SPEED_STOPS.length - 1)) * 100}%`,
).join(', ')})`;

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
}) {
  const { fps } = useFrameStats(statsRef);

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
            <p className="brand__sub">Global surface wind · 10 m above ground</p>
          </div>
        </div>
      </header>

      <section className="card hud__data">
        <div className={`pill pill--${status}`}>
          <span className="pill__dot" aria-hidden="true" />
          {STATUS_LABEL[status]}
        </div>
        <div className="stats">
          <Stat label="Observed" value={formatObserved(observedAt)} />
          <Stat label="Retrieved" value={formatClock(updatedAt)} />
          <Stat label="Coverage" value={`${filled || 0} of ${gridPoints} points`} />
          <Stat label="Refreshes every" value={`${Math.round(refetchMs / 60000)} minutes`} />
        </div>
      </section>

      <div className="hud__search">
        <SearchBar onSelect={onSelectPlace} onClear={onClearPlace} selected={selectedPlace} />
      </div>

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

      <section className="card hud__perf">
        <div className="stats stats--tight">
          <Stat label="Streaks" value={particleCount.toLocaleString()} accent />
          <Stat label="Frame rate" value={fps ? `${fps} fps` : '-'} accent />
          <Stat label="Quality" value={quality.tier === 'high' ? 'Full' : 'Reduced'} accent />
        </div>
      </section>

      <div className="hud__notices">
        {status === 'fallback' && (
          <p className="notice notice--warn">
            <strong>Live wind unavailable.</strong> Showing a synthetic climatological field.
            {error ? ` ${error}` : ''}
          </p>
        )}
        {status === 'live' && error && (
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
