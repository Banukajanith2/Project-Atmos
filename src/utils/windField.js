/**
 * windField.js — grid definition, vector math, and interpolation.
 *
 * Open-Meteo is a per-point API, so the "global grid" is something we build
 * ourselves out of one batched request. Everything downstream (particles, HUD
 * legend) reads the field through `createWindField`, so there is exactly one
 * place where meteorological conventions get decoded.
 */

import { CATEGORY, bucketWeatherCode } from './weatherCodes';

export const LAT_MIN = -80;
export const LAT_MAX = 80;
export const LON_MIN = -180;
export const STEP = 10;

export const N_LAT = (LAT_MAX - LAT_MIN) / STEP + 1; // 17 rows
export const N_LON = 360 / STEP; // 36 columns, -180..170 (circular)
export const GRID_POINTS = N_LAT * N_LON; // 612 — under Open-Meteo's 1000/call cap

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const KMH_TO_MS = 1 / 3.6;

/**
 * Grid coordinates in row-major order (latitude outer, longitude inner).
 * Index of (latIdx, lonIdx) is `latIdx * N_LON + lonIdx` — the same ordering
 * the API response is mapped back into.
 */
export function buildGrid() {
  const lats = new Array(GRID_POINTS);
  const lons = new Array(GRID_POINTS);
  let i = 0;
  for (let y = 0; y < N_LAT; y++) {
    const lat = LAT_MIN + y * STEP;
    for (let x = 0; x < N_LON; x++) {
      lats[i] = lat;
      lons[i] = LON_MIN + x * STEP;
      i++;
    }
  }
  return { lats, lons };
}

/**
 * Meteorological direction is the bearing the wind is coming FROM, measured
 * clockwise from north. The motion vector is the reverse of that bearing.
 *   dir=0   (from north) -> blowing south -> v negative
 *   dir=90  (from east)  -> blowing west  -> u negative
 * Returns metres/second in (u = eastward, v = northward).
 */
export function toVector(speedKmh, directionDeg) {
  const speed = (speedKmh || 0) * KMH_TO_MS;
  const rad = (directionDeg || 0) * DEG2RAD;
  return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

/** Inverse of `toVector` — used to feed synthetic data through the same path. */
export function toMeteorological(u, v) {
  const speedKmh = Math.hypot(u, v) / KMH_TO_MS;
  let dir = Math.atan2(-u, -v) * RAD2DEG;
  if (dir < 0) dir += 360;
  return { speedKmh, directionDeg: dir };
}

/** Grid index -> the lat/lon that index represents. */
export function gridLatLon(index) {
  const y = Math.floor(index / N_LON);
  const x = index % N_LON;
  return { lat: LAT_MIN + y * STEP, lon: LON_MIN + x * STEP };
}

/**
 * Build a sampleable field from grid-ordered samples.
 *
 * @param {Array<{speedKmh:number, directionDeg:number, weatherCode?:number,
 *   precipitation?:number, cloudCover?:number, temperature?:number}|null>} samples
 *   One entry per grid point, in `buildGrid()` order. Nulls are treated as calm.
 */
export function createWindField(samples) {
  const u = new Float32Array(GRID_POINTS);
  const v = new Float32Array(GRID_POINTS);
  const precipitation = new Float32Array(GRID_POINTS);
  const cloudCover = new Float32Array(GRID_POINTS);
  const temperature = new Float32Array(GRID_POINTS);
  const category = new Uint8Array(GRID_POINTS).fill(CATEGORY.UNKNOWN);
  let maxSpeed = 0;

  for (let i = 0; i < GRID_POINTS; i++) {
    const s = samples[i];
    if (!s || !Number.isFinite(s.speedKmh) || !Number.isFinite(s.directionDeg)) continue;
    const vec = toVector(s.speedKmh, s.directionDeg);
    u[i] = vec.u;
    v[i] = vec.v;
    const mag = Math.hypot(vec.u, vec.v);
    if (mag > maxSpeed) maxSpeed = mag;

    if (Number.isFinite(s.precipitation)) precipitation[i] = s.precipitation;
    if (Number.isFinite(s.cloudCover)) cloudCover[i] = s.cloudCover;
    if (Number.isFinite(s.temperature)) temperature[i] = s.temperature;
    if (s.weatherCode !== undefined) category[i] = bucketWeatherCode(s.weatherCode);
  }

  /**
   * Bilinear sample. Interpolating the u/v components (rather than speed and
   * bearing) is what keeps this correct across the 359°->1° seam; averaging
   * angles there would swing a particle the long way round the compass.
   *
   * Returns null above ±80° — the poles are excluded from the grid entirely,
   * and callers are expected to retire particles that drift into that band
   * rather than extrapolate into it.
   */
  function sample(lat, lon) {
    if (lat > LAT_MAX || lat < LAT_MIN) return null;

    // Longitude is circular: fold any input into [-180, 180) first.
    const wrapped = (((lon + 180) % 360) + 360) % 360 - 180;

    const fx = (wrapped - LON_MIN) / STEP; // 0 .. 36 (wraps at the top)
    const fy = (lat - LAT_MIN) / STEP; // 0 .. 16

    const x0 = Math.floor(fx);
    const y0 = Math.min(Math.floor(fy), N_LAT - 1);
    const tx = fx - x0;
    const ty = fy - y0;

    // Longitude neighbours wrap around the antimeridian; latitude neighbours
    // clamp, because there is no row past ±80 to blend toward.
    const ix0 = ((x0 % N_LON) + N_LON) % N_LON;
    const ix1 = (ix0 + 1) % N_LON;
    const iy0 = Math.max(y0, 0);
    const iy1 = Math.min(iy0 + 1, N_LAT - 1);

    const r0 = iy0 * N_LON;
    const r1 = iy1 * N_LON;
    const i00 = r0 + ix0;
    const i10 = r0 + ix1;
    const i01 = r1 + ix0;
    const i11 = r1 + ix1;

    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;

    const su = u[i00] * w00 + u[i10] * w10 + u[i01] * w01 + u[i11] * w11;
    const sv = v[i00] * w00 + v[i10] * w10 + v[i01] * w01 + v[i11] * w11;

    return { u: su, v: sv, speed: Math.hypot(su, sv) };
  }

  /**
   * Grid indices whose bucketed condition is in `wanted`. Layers iterate cells,
   * not the whole grid, so a layer with no matching weather anywhere costs
   * nothing to have mounted.
   */
  function cellsMatching(wanted) {
    const set = Array.isArray(wanted) ? wanted : [wanted];
    const out = [];
    for (let i = 0; i < GRID_POINTS; i++) {
      if (set.includes(category[i])) out.push(i);
    }
    return out;
  }

  return {
    sample,
    maxSpeed,
    u,
    v,
    category,
    precipitation,
    cloudCover,
    temperature,
    cellsMatching,
  };
}

/**
 * Synthetic fallback field: banded zonal flow (tropical easterlies, mid-latitude
 * westerlies, polar easterlies) with a little meridional waviness so it does not
 * read as perfectly striped. Used when the API is unreachable or rate-limited,
 * so the globe is never empty.
 */
export function syntheticSamples() {
  const { lats, lons } = buildGrid();
  return lats.map((lat, i) => {
    const lon = lons[i];
    // cos with a 60° period flips sign at 30° and 60° -> three wind belts.
    const zonal = -9 * Math.cos(lat * DEG2RAD * 6);
    const wave = 3.5 * Math.sin(lon * DEG2RAD * 3 + lat * DEG2RAD * 2);
    const u = zonal + wave;
    const v = 2.5 * Math.sin(lon * DEG2RAD * 2) * Math.cos(lat * DEG2RAD * 3);
    const wind = toMeteorological(u, v);

    // Plausible-but-invented conditions so the weather layers still have
    // something to render when the API is unreachable. Wet near the equator and
    // the storm tracks, frozen toward the poles, clear over the subtropics.
    const absLat = Math.abs(lat);
    const wetness =
      Math.cos(lat * DEG2RAD * 6) * 0.5 +
      0.5 * Math.sin(lon * DEG2RAD * 2 + lat * DEG2RAD * 1.5);
    const temperature = 30 - absLat * 0.75 + 4 * Math.sin(lon * DEG2RAD * 3);

    let weatherCode = 0;
    if (wetness > 0.55) weatherCode = temperature < 0 ? 73 : absLat < 22 ? 95 : 63;
    else if (wetness > 0.2) weatherCode = temperature < 0 ? 71 : 61;
    else if (wetness > -0.15) weatherCode = 3;
    else if (wetness > -0.45) weatherCode = 2;

    const cloudCover = Math.max(0, Math.min(100, (wetness + 0.6) * 90));
    const precipitation = wetness > 0.2 ? (wetness - 0.2) * 4 : 0;

    return { ...wind, weatherCode, cloudCover, precipitation, temperature };
  });
}

/* ------------------------------------------------------------------ *
 * Speed -> colour ramp.
 * Shared by the particle system and the HUD legend so the two cannot
 * drift apart. Stops are in metres/second.
 * ------------------------------------------------------------------ */

/**
 * Tuned against the Blue Marble basemap, not a black backdrop. The low stop has
 * to stay bright enough to read over sunlit land and cloud — a near-black
 * "calm" colour simply disappears there under additive blending.
 */
export const SPEED_STOPS = [
  { speed: 0, rgb: [0.16, 0.45, 0.72], hex: '#2973b8' },
  { speed: 5, rgb: [0.24, 0.68, 0.94], hex: '#3dadf0' },
  { speed: 11, rgb: [0.37, 0.82, 1.0], hex: '#5fd0ff' }, // signature accent
  { speed: 20, rgb: [0.72, 0.94, 1.0], hex: '#b8f0ff' },
  { speed: 32, rgb: [1.0, 1.0, 1.0], hex: '#ffffff' },
];

/** Linear interpolation across SPEED_STOPS. Writes into `out` to avoid garbage. */
export function speedColor(speed, out = [0, 0, 0]) {
  const stops = SPEED_STOPS;
  if (speed <= stops[0].speed) {
    out[0] = stops[0].rgb[0];
    out[1] = stops[0].rgb[1];
    out[2] = stops[0].rgb[2];
    return out;
  }
  for (let i = 1; i < stops.length; i++) {
    if (speed <= stops[i].speed || i === stops.length - 1) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = Math.min((speed - a.speed) / (b.speed - a.speed), 1);
      out[0] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t;
      out[1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t;
      out[2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t;
      return out;
    }
  }
  return out;
}

/** Lat/lon (degrees) -> position on a sphere of the given radius. */
export function latLonToVec3(lat, lon, radius, out) {
  const phi = (90 - lat) * DEG2RAD;
  const theta = (lon + 180) * DEG2RAD;
  const sinPhi = Math.sin(phi);
  out[0] = -radius * sinPhi * Math.cos(theta);
  out[1] = radius * Math.cos(phi);
  out[2] = radius * sinPhi * Math.sin(theta);
  return out;
}

export const MS_TO_KMH = 3.6;
