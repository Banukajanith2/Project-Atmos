/**
 * windRequest.js - how the global grid is asked for, and how the answer is
 * decoded. Shared by the browser hook and the build-time snapshot script.
 *
 * This exists as its own module because there are now two callers. Letting the
 * script keep its own copy of the field list and the response decoder would mean
 * two definitions of the same request, and the day they drift is the day the
 * snapshot silently carries different data from the live path.
 */

import { buildGrid, GRID_POINTS } from './windField';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/**
 * Every weather layer reads from this one request. Adding fields to the existing
 * batched call costs nothing extra against the rate limit; a second endpoint per
 * layer would multiply it.
 */
export const CURRENT_FIELDS = [
  'wind_speed_10m',
  'wind_direction_10m',
  'weather_code',
  'precipitation',
  'cloud_cover',
  'temperature_2m',
];

const { lats, lons } = buildGrid();

export const REQUEST_URL =
  `${ENDPOINT}?latitude=${lats.join(',')}` +
  `&longitude=${lons.join(',')}` +
  `&current=${CURRENT_FIELDS.join(',')}`;

/**
 * Open-Meteo answers a batched request with an array in request order, and each
 * entry after the first carries a zero-based `location_id`. We key off that id
 * where present rather than trusting position alone, so a reordered or short
 * response degrades to "some points calm" instead of a globally rotated field.
 */
export function samplesFromResponse(payload) {
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
 * Snapshot encoding.
 *
 * Samples are stored as fixed-order tuples rather than objects. The object form
 * repeats six key names 612 times and lands around 67 KB; the tuple form is
 * about 13 KB for exactly the same numbers, and this file is downloaded by every
 * visitor. Values are rounded to the precision the data actually carries -
 * reporting wind direction to twelve decimal places is noise, not accuracy.
 * ------------------------------------------------------------------ */

/** Field order inside each encoded tuple. Written into the file as `fields`. */
export const SNAPSHOT_FIELDS = [
  'speedKmh',
  'directionDeg',
  'weatherCode',
  'precipitation',
  'cloudCover',
  'temperature',
];

const round = (value, places) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export function encodeSamples(samples) {
  return samples.map((s) =>
    s
      ? [
          round(s.speedKmh, 1),
          round(s.directionDeg, 0),
          Number.isFinite(s.weatherCode) ? s.weatherCode : null,
          round(s.precipitation, 1),
          round(s.cloudCover, 0),
          round(s.temperature, 1),
        ]
      : null,
  );
}

export function decodeSamples(rows) {
  if (!Array.isArray(rows)) throw new Error('Snapshot has no sample array');

  const samples = new Array(GRID_POINTS).fill(null);
  let filled = 0;

  for (let i = 0; i < Math.min(rows.length, GRID_POINTS); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const [speedKmh, directionDeg, weatherCode, precipitation, cloudCover, temperature] = row;
    // Same contract as the live path: wind is required, everything else is
    // optional enrichment.
    if (!Number.isFinite(speedKmh) || !Number.isFinite(directionDeg)) continue;
    samples[i] = {
      speedKmh,
      directionDeg,
      weatherCode: weatherCode ?? undefined,
      precipitation: precipitation ?? undefined,
      cloudCover: cloudCover ?? undefined,
      temperature: temperature ?? undefined,
    };
    filled++;
  }

  return { samples, filled };
}
