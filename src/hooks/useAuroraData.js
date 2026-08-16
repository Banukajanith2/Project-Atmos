import { useCallback, useEffect, useState } from 'react';
import { parseCoordinates, syntheticAurora } from '../utils/auroraGrid';

/**
 * NOAA SWPC OVATION aurora nowcast.
 *
 * Verified live on 2026-08-16: HTTP 200, `content-type: application/json`, and
 * `access-control-allow-origin: *`, so this is fetchable straight from the
 * browser with no proxy and no key. 924 KB, `Cache-Control: max-age=60`, served
 * through CloudFront.
 */
const ENDPOINT = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

/**
 * The model itself only regenerates every ~5 minutes, so anything faster is a
 * megabyte of transfer for a byte-identical answer. Matching the real cadence is
 * the whole rate-limit strategy here.
 */
const REFETCH_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 25000; // a megabyte on a slow connection needs room

/* ------------------------------------------------------------------ *
 * Module-level request cache - same reasoning as useWindData.js.
 *
 * A per-component "already fetching" ref cannot suppress StrictMode's
 * double-invoke in development, because the cleanup that clears the ref runs
 * before the second mount's effect ever reads it. Deduping at module scope is
 * what actually prevents two 924 KB downloads on every dev page load.
 *
 * The in-flight promise is shared, so no single unmount may abort it. The
 * AbortController's real job is bounding a hung connection; unmounted
 * subscribers just ignore the result.
 * ------------------------------------------------------------------ */

let pending = null;
let cached = null; // { values, peak, observedAt, forecastAt, at }

function requestAurora() {
  if (pending) return pending;

  pending = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(ENDPOINT, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json().catch(() => null);
      // Validate the body shape rather than trusting the status. Phase 1 was
      // caught out by an upstream that answers an error with HTTP 200; assume
      // any public endpoint can do the same.
      if (!payload || !Array.isArray(payload.coordinates)) {
        throw new Error('Unexpected aurora response shape');
      }

      const { values, peak, hemisphere } = parseCoordinates(payload.coordinates);

      cached = {
        values,
        peak,
        hemisphere,
        observedAt: payload['Observation Time'] ?? null,
        forecastAt: payload['Forecast Time'] ?? null,
        at: Date.now(),
      };
      return cached;
    } finally {
      clearTimeout(timeout);
      pending = null;
    }
  })();

  return pending;
}

const fallbackState = () => {
  const { values, peak, hemisphere } = syntheticAurora();
  return {
    values,
    peak,
    hemisphere,
    status: 'fallback',
    error: null,
    observedAt: null,
    forecastAt: null,
    updatedAt: null,
  };
};

const liveState = (result) => ({
  values: result.values,
  peak: result.peak,
  hemisphere: result.hemisphere,
  status: 'live',
  error: null,
  observedAt: result.observedAt,
  forecastAt: result.forecastAt,
  updatedAt: result.at,
});

/**
 * Fetches the OVATION grid and refreshes it on a 5-minute interval.
 *
 * Lazy on purpose: nothing is requested until `enabled` first goes true. A user
 * who never opens aurora mode should not pay a megabyte for a layer they never
 * see, and the mode's fade-in covers the request on the first toggle. Once
 * fetched the grid lives in the module cache, so toggling back and forth costs
 * nothing.
 *
 * Never call this from inside `useFrame`. One request covers the entire globe
 * and `AuroraLayer` reads the rasterised texture, not the network.
 */
export function useAuroraData(enabled) {
  const [state, setState] = useState(() =>
    cached
      ? liveState(cached)
      : {
          values: null,
          peak: 0,
          hemisphere: 'north',
          status: 'idle',
          error: null,
          observedAt: null,
          forecastAt: null,
          updatedAt: null,
        },
  );

  const load = useCallback(async (isStale) => {
    try {
      const result = await requestAurora();
      if (isStale()) return;
      setState(liveState(result));
    } catch (err) {
      if (isStale()) return;
      const message = err?.message || 'Aurora data request failed';
      // Keep the last good grid if we have one - a failed refresh should not
      // blank a working layer. With nothing to fall back on, the procedural oval
      // keeps the mode meaningful, and the HUD says which one is on screen.
      setState((prev) =>
        prev.status === 'live'
          ? { ...prev, error: message }
          : { ...fallbackState(), error: message },
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    let unmounted = false;
    const isStale = () => unmounted;

    if (cached && Date.now() - cached.at < REFETCH_MS) {
      setState(liveState(cached));
    } else {
      setState((prev) => (prev.status === 'idle' ? { ...prev, status: 'loading' } : prev));
      load(isStale);
    }

    const id = setInterval(() => {
      cached = null; // force the next request past the freshness check
      load(isStale);
    }, REFETCH_MS);

    return () => {
      unmounted = true;
      clearInterval(id);
    };
  }, [enabled, load]);

  return { ...state, refetchMs: REFETCH_MS };
}
