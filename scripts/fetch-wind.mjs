/**
 * Build-time wind snapshot.
 *
 * Fetches the global grid once and writes `public/wind-grid.json`, which Vite
 * copies into `dist/` and the site then serves as a static file.
 *
 * Why this exists at all: Open-Meteo weights a request by the data it returns,
 * roughly `nLocations * (nDays / 14) * (nVariables / 10)`. Our grid asks for 612
 * locations, so a single HTTP request costs several hundred calls against a
 * 10,000/day free allowance - about 17 page loads per day for the entire site
 * before wind data stops working for everybody. The grid is identical for every
 * visitor, so fetching it per visitor was always the wrong shape. Fetching it
 * once per deploy makes runtime API usage exactly zero and the visitor count
 * irrelevant.
 *
 * Open-Meteo data is CC BY 4.0, so caching and re-serving it is permitted with
 * attribution.
 *
 * Run via `npm run wind:fetch`. Never fails the build: a deploy without a fresh
 * snapshot is far better than no deploy, and the app degrades to fetching live
 * and then to a synthetic field.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUEST_URL,
  samplesFromResponse,
  encodeSamples,
  SNAPSHOT_FIELDS,
} from '../src/utils/windRequest.js';
import { LAT_MIN, LAT_MAX, LON_MIN, STEP, GRID_POINTS } from '../src/utils/windField.js';

const OUTPUT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'wind-grid.json');

/**
 * Where the currently deployed snapshot lives. If a build cannot reach
 * Open-Meteo (a rate limit from an earlier run in the same hour is the likely
 * cause), the previous snapshot is reused rather than shipping nothing. Slightly
 * stale real weather beats a synthetic field.
 */
const DEPLOYED_SNAPSHOT =
  process.env.ATMOS_DEPLOYED_SNAPSHOT ||
  'https://banukajanith2.github.io/Project-Atmos/wind-grid.json';

const ATTEMPTS = 3;
const BACKOFF_MS = [0, 8000, 25000];
const REQUEST_TIMEOUT_MS = 45000;

/**
 * An existing snapshot younger than this is left alone.
 *
 * This runs before `dev` and `build`, and without a guard a morning of rebuilds
 * would burn the daily allowance exactly the way fetching per visitor did. CI
 * checks out fresh and the file is gitignored, so a scheduled run never hits
 * this path and always fetches.
 */
const MAX_AGE_MS = 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function existingSnapshotAge() {
  try {
    const existing = JSON.parse(await readFile(OUTPUT, 'utf8'));
    const stamp = Date.parse(existing.reusedAt || existing.generated);
    if (!Number.isFinite(stamp)) return null;
    return Date.now() - stamp;
  } catch {
    return null;
  }
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'project-atmos-build (+https://github.com/Banukajanith2)' },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.reason || `${label} returned HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFreshGrid() {
  let lastError = null;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt]) {
      console.log(`[wind] waiting ${BACKOFF_MS[attempt] / 1000}s before retry`);
      await sleep(BACKOFF_MS[attempt]);
    }

    try {
      const payload = await fetchJson(REQUEST_URL, 'Open-Meteo');
      // A rate-limited reply is `{error: true, reason}` and can arrive with HTTP
      // 200, so the body shape is validated rather than trusting the status.
      if (!Array.isArray(payload)) {
        throw new Error(payload?.reason || 'Unexpected response shape');
      }

      const { samples, filled } = samplesFromResponse(payload);
      if (filled === 0) throw new Error('Response contained no usable wind samples');

      return {
        observed: payload[0]?.current?.time ?? null,
        samples,
        filled,
      };
    } catch (error) {
      lastError = error;
      console.warn(`[wind] attempt ${attempt + 1}/${ATTEMPTS} failed: ${error.message}`);
    }
  }

  throw lastError ?? new Error('Wind grid request failed');
}

async function reuseDeployedSnapshot() {
  const payload = await fetchJson(DEPLOYED_SNAPSHOT, 'Deployed snapshot');
  if (!Array.isArray(payload?.samples) || payload.samples.length === 0) {
    throw new Error('Deployed snapshot has no samples');
  }
  return payload;
}

async function main() {
  await mkdir(dirname(OUTPUT), { recursive: true });

  const age = await existingSnapshotAge();
  if (age !== null && age < MAX_AGE_MS && !process.argv.includes('--force')) {
    console.log(`[wind] existing snapshot is ${Math.round(age / 60000)} min old, keeping it`);
    return;
  }

  let snapshot;

  try {
    const { observed, samples, filled } = await fetchFreshGrid();
    snapshot = {
      generated: new Date().toISOString(),
      observed,
      source: 'https://open-meteo.com',
      licence: 'CC BY 4.0',
      grid: { latMin: LAT_MIN, latMax: LAT_MAX, lonMin: LON_MIN, step: STEP, points: GRID_POINTS },
      filled,
      fields: SNAPSHOT_FIELDS,
      samples: encodeSamples(samples),
    };
    console.log(`[wind] fetched ${filled}/${GRID_POINTS} points, observed ${observed}`);
  } catch (error) {
    console.warn(`[wind] live fetch failed: ${error.message}`);
    try {
      snapshot = await reuseDeployedSnapshot();
      // Marked so the age shown in the HUD stays truthful about the underlying
      // observation rather than resetting the clock on a straight copy.
      snapshot.reusedAt = new Date().toISOString();
      console.log(`[wind] reused deployed snapshot, observed ${snapshot.observed}`);
    } catch (reuseError) {
      console.warn(`[wind] could not reuse deployed snapshot: ${reuseError.message}`);
      console.warn('[wind] no snapshot written - the app will fetch live, then fall back');
      return;
    }
  }

  const json = JSON.stringify(snapshot);
  await writeFile(OUTPUT, json);
  console.log(`[wind] wrote ${OUTPUT} (${(json.length / 1024).toFixed(1)} KB)`);
}

main().catch((error) => {
  // Still never fatal. Anything unexpected here should cost a stale snapshot,
  // not a failed deploy.
  console.warn(`[wind] snapshot step failed unexpectedly: ${error.message}`);
});
