import { useCallback, useEffect, useState } from 'react';
import { buildGrid, createWindField, syntheticSamples, GRID_POINTS } from '../utils/windField';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const REFETCH_MS = 30 * 60 * 1000; // surface wind updates every 15 min upstream
const REQUEST_TIMEOUT_MS = 20000;

const { lats, lons } = buildGrid();
// Every weather layer reads from this one request. Adding fields to the
// existing batched call costs nothing extra against the rate limit; a second
// endpoint per layer would multiply it.
const CURRENT_FIELDS = [
  'wind_speed_10m',
  'wind_direction_10m',
  'weather_code',
  'precipitation',
  'cloud_cover',
  'temperature_2m',
].join(',');

const REQUEST_URL =
  `${ENDPOINT}?latitude=${lats.join(',')}` +
  `&longitude=${lons.join(',')}` +
  `&current=${CURRENT_FIELDS}`;

/**
 * Open-Meteo answers a batched request with an array in request order, and each
 * entry after the first carries a zero-based `location_id`. We key off that id
 * where present rather than trusting position alone, so a reordered or short
 * response degrades to "some points calm" instead of a globally rotated field.
 */
function samplesFromResponse(payload) {
  const samples = new Array(GRID_POINTS).fill(null);
  let filled = 0;

  payload.forEach((entry, position) => {
    const index = Number.isInteger(entry?.location_id) ? entry.location_id : position;
    if (index < 0 || index >= GRID_POINTS) return;
    const current = entry?.current;
    if (!current) return;
    const speedKmh = current.wind_speed_10m;
    const directionDeg = current.wind_direction_10m;
    if (!Number.isFinite(speedKmh) || !Number.isFinite(directionDeg)) return;
    samples[index] = {
      speedKmh,
      directionDeg,
      // Optional: a point missing these still contributes valid wind rather
      // than being discarded outright.
      weatherCode: current.weather_code,
      precipitation: current.precipitation,
      cloudCover: current.cloud_cover,
      temperature: current.temperature_2m,
    };
    filled++;
  });

  return { samples, filled };
}

/* ------------------------------------------------------------------ *
 * Module-level request cache.
 *
 * StrictMode in development mounts, unmounts, then remounts. A per-component
 * "already fetching" ref cannot stop the duplicate, because the cleanup that
 * clears it runs *before* the second mount's effect — you get two real requests
 * and one of them shows up aborted. Deduping at module scope is what actually
 * keeps development from double-hitting a rate-limited public API.
 *
 * The in-flight request owns its own AbortController: it is shared between
 * subscribers, so no individual unmount is allowed to cancel it. Unmounted
 * consumers simply ignore the result.
 * ------------------------------------------------------------------ */

let pending = null;
let cached = null; // { field, observedAt, filled, at }

function requestGrid() {
  if (pending) return pending;

  pending = (async () => {
    const controller = new AbortController();
    // AbortController's real job here: bounding a hung connection, which an
    // overloaded or rate-limited upstream will otherwise leave open forever.
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(REQUEST_URL, { signal: controller.signal });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.reason || `HTTP ${response.status}`);
      }
      // A rate-limit reply arrives as {error: true, reason: "..."} — and can do
      // so with a 200, so response.ok alone is not enough to trust the body.
      if (!Array.isArray(payload)) {
        throw new Error(payload?.reason || 'Unexpected response shape');
      }

      const { samples, filled } = samplesFromResponse(payload);
      if (filled === 0) throw new Error('Response contained no usable wind samples');

      cached = {
        field: createWindField(samples),
        observedAt: payload[0]?.current?.time ?? null,
        filled,
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

/**
 * Fetches the global wind grid once, caches it, and refreshes on an interval.
 *
 * Never call this from inside `useFrame` — one request covers the whole globe
 * and the particle system reads the cached field, not the network.
 */
export function useWindData() {
  const [state, setState] = useState(() =>
    cached
      ? {
          field: cached.field,
          status: 'live',
          error: null,
          updatedAt: cached.at,
          observedAt: cached.observedAt,
          filled: cached.filled,
        }
      : {
          field: createWindField(syntheticSamples()),
          status: 'loading',
          error: null,
          updatedAt: null,
          observedAt: null,
          filled: 0,
        },
  );

  const load = useCallback(async (isStale) => {
    try {
      const result = await requestGrid();
      if (isStale()) return;
      setState({
        field: result.field,
        status: 'live',
        error: null,
        updatedAt: result.at,
        observedAt: result.observedAt,
        filled: result.filled,
      });
    } catch (err) {
      if (isStale()) return;
      // Keep the globe populated. A visibly synthetic field beats an empty
      // sphere, as long as the HUD says which one you are looking at. If we
      // already had live data, keep it and just flag the failed refresh.
      setState((prev) => ({
        ...prev,
        field: prev.status === 'live' ? prev.field : createWindField(syntheticSamples()),
        status: prev.status === 'live' ? 'live' : 'fallback',
        error: err?.message || 'Wind data request failed',
      }));
    }
  }, []);

  useEffect(() => {
    let unmounted = false;
    const isStale = () => unmounted;

    // A cached grid that is still fresh is reused as-is — no request at all.
    if (cached && Date.now() - cached.at < REFETCH_MS) {
      setState({
        field: cached.field,
        status: 'live',
        error: null,
        updatedAt: cached.at,
        observedAt: cached.observedAt,
        filled: cached.filled,
      });
    } else {
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
  }, [load]);

  return { ...state, refetchMs: REFETCH_MS, gridPoints: GRID_POINTS };
}
