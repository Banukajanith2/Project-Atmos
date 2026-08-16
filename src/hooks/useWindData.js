import { useCallback, useEffect, useState } from 'react';
import { createWindField, syntheticSamples, GRID_POINTS } from '../utils/windField';
import { REQUEST_URL, samplesFromResponse, decodeSamples } from '../utils/windRequest';

/**
 * Wind grid loading, in three tiers.
 *
 *   1. `wind-grid.json`, a static snapshot baked into the deploy.
 *   2. A live Open-Meteo request, if that file is missing or too old.
 *   3. A synthetic climatological field, if the network fails entirely.
 *
 * Tier 1 exists because Open-Meteo weights a request by the data it returns,
 * roughly `nLocations * (nDays / 14) * (nVariables / 10)`. This grid asks for 612
 * locations, so one HTTP request costs several hundred calls against a
 * 10,000/day allowance - roughly 17 page loads per day for the whole site before
 * wind data stops working for everyone. The grid is byte-identical for every
 * visitor, so fetching it per visitor was always the wrong shape. Reading a
 * static file instead makes runtime API usage zero and the visitor count
 * irrelevant.
 *
 * Tier 2 is kept as a safety net rather than deleted: a deploy that skipped the
 * snapshot step, or a `vite dev` run without one, still shows real weather. It
 * is the old behaviour, demoted.
 */

/**
 * Relative to the document, so the same build works at the `/Project-Atmos/`
 * subpath, at a domain root, and on any other static host - the same reason
 * `base: './'` is set in the Vite config.
 */
const SNAPSHOT_URL = `${import.meta.env.BASE_URL}wind-grid.json`;

/**
 * How long a snapshot is trusted before falling through to a live request.
 *
 * The scheduled workflow refreshes every 3 hours, so this allows two missed runs
 * before a visitor pays for a live call. Set too tight, a single late GitHub
 * Actions run would send every visitor back to the API and undo the point of the
 * exercise.
 */
const SNAPSHOT_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** Only meaningful in tier 2. Tier 1 refreshes when the site redeploys. */
const REFETCH_MS = 30 * 60 * 1000;

/** Tier 1's real cadence: the cron in `.github/workflows/refresh-wind.yml`. */
const SNAPSHOT_REFRESH_MS = 3 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 20000;

/* ------------------------------------------------------------------ *
 * Module-level request cache.
 *
 * StrictMode in development mounts, unmounts, then remounts. A per-component
 * "already fetching" ref cannot stop the duplicate, because the cleanup that
 * clears it runs *before* the second mount's effect - you get two real requests
 * and one of them shows up aborted. Deduping at module scope is what actually
 * keeps development from double-hitting a rate-limited public API.
 *
 * The in-flight request owns its own AbortController: it is shared between
 * subscribers, so no individual unmount is allowed to cancel it. Unmounted
 * consumers simply ignore the result.
 * ------------------------------------------------------------------ */

let pending = null;
let cached = null; // { field, observedAt, filled, at, source }

async function requestWithTimeout(url) {
  const controller = new AbortController();
  // AbortController's real job here: bounding a hung connection, which an
  // overloaded or rate-limited upstream will otherwise leave open forever.
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

/** Tier 1. Resolves null when there is no usable snapshot, rather than throwing. */
async function loadSnapshot() {
  try {
    const { response, payload } = await requestWithTimeout(SNAPSHOT_URL);
    if (!response.ok || !payload) return null;

    const stamp = Date.parse(payload.reusedAt || payload.generated);
    if (Number.isFinite(stamp) && Date.now() - stamp > SNAPSHOT_MAX_AGE_MS) return null;

    const { samples, filled } = decodeSamples(payload.samples);
    if (filled === 0) return null;

    return {
      field: createWindField(samples),
      observedAt: payload.observed ?? null,
      filled,
      at: stamp || Date.now(),
      source: 'snapshot',
    };
  } catch {
    // A missing file is the normal case in `vite dev`, not an error worth
    // surfacing. Falling through to tier 2 is the whole point.
    return null;
  }
}

/** Tier 2. Throws on failure so the caller can fall through to tier 3. */
async function requestLiveGrid() {
  const { response, payload } = await requestWithTimeout(REQUEST_URL);

  if (!response.ok) {
    throw new Error(payload?.reason || `HTTP ${response.status}`);
  }
  // A rate-limit reply arrives as {error: true, reason: "..."} - and can do so
  // with a 200, so response.ok alone is not enough to trust the body.
  if (!Array.isArray(payload)) {
    throw new Error(payload?.reason || 'Unexpected response shape');
  }

  const { samples, filled } = samplesFromResponse(payload);
  if (filled === 0) throw new Error('Response contained no usable wind samples');

  return {
    field: createWindField(samples),
    observedAt: payload[0]?.current?.time ?? null,
    filled,
    at: Date.now(),
    source: 'live',
  };
}

function requestGrid() {
  if (pending) return pending;

  pending = (async () => {
    try {
      cached = (await loadSnapshot()) || (await requestLiveGrid());
      return cached;
    } finally {
      pending = null;
    }
  })();

  return pending;
}

const stateFrom = (result) => ({
  field: result.field,
  status: result.source, // 'snapshot' | 'live'
  error: null,
  updatedAt: result.at,
  observedAt: result.observedAt,
  filled: result.filled,
});

/**
 * Never call this from inside `useFrame` - one request covers the whole globe
 * and the particle system reads the cached field, not the network.
 */
export function useWindData() {
  const [state, setState] = useState(() =>
    cached
      ? stateFrom(cached)
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
      setState(stateFrom(result));
    } catch (err) {
      if (isStale()) return;
      // Keep the globe populated. A visibly synthetic field beats an empty
      // sphere, as long as the HUD says which one you are looking at. If we
      // already had real data, keep it and just flag the failed refresh.
      setState((prev) => {
        const hadRealData = prev.status === 'live' || prev.status === 'snapshot';
        return {
          ...prev,
          field: hadRealData ? prev.field : createWindField(syntheticSamples()),
          status: hadRealData ? prev.status : 'fallback',
          error: err?.message || 'Wind data request failed',
        };
      });
    }
  }, []);

  useEffect(() => {
    let unmounted = false;
    const isStale = () => unmounted;

    // A cached grid that is still fresh is reused as-is - no request at all.
    if (cached && Date.now() - cached.at < REFETCH_MS) {
      setState(stateFrom(cached));
    } else {
      load(isStale);
    }

    const id = setInterval(() => {
      // Only tier 2 has anything to poll for. A snapshot changes when the site
      // redeploys, so re-requesting the same static file on a timer would be
      // pure waste - and clearing the cache would re-run the whole tier chain,
      // which can escalate a perfectly good snapshot into a live API call.
      //
      // Checked here rather than when the effect runs, because on first mount
      // the load is still in flight and `cached` is not populated yet.
      if (cached?.source === 'snapshot') return;
      cached = null; // force the next request past the freshness check
      load(isStale);
    }, REFETCH_MS);

    return () => {
      unmounted = true;
      clearInterval(id);
    };
  }, [load]);

  return {
    ...state,
    // Reported so the HUD states the cadence that actually applies to whichever
    // tier is on screen, rather than a fixed number that is wrong half the time.
    refetchMs: state.status === 'snapshot' ? SNAPSHOT_REFRESH_MS : REFETCH_MS,
    gridPoints: GRID_POINTS,
  };
}
