/**
 * WMO 4677 weather-code buckets.
 *
 * Written as explicit code sets rather than range guesses - the numbering is not
 * contiguous by condition (77 is snow grains, sitting between 71-75 snowfall and
 * 85-86 snow showers), so "code > 70 means snow" style shortcuts misclassify.
 */

export const CATEGORY = {
  CLEAR: 0,
  CLOUDY: 1,
  FOG: 2,
  RAIN: 3,
  SNOW: 4,
  THUNDER: 5,
  UNKNOWN: 6,
};

export const CATEGORY_NAME = {
  [CATEGORY.CLEAR]: 'Clear',
  [CATEGORY.CLOUDY]: 'Cloudy',
  [CATEGORY.FOG]: 'Fog',
  [CATEGORY.RAIN]: 'Rain',
  [CATEGORY.SNOW]: 'Snow',
  [CATEGORY.THUNDER]: 'Thunderstorm',
  [CATEGORY.UNKNOWN]: 'Unknown',
};

const CLEAR = [0, 1];
const CLOUDY = [2, 3];
const FOG = [45, 48];
const RAIN = [
  51, 53, 55, // drizzle
  56, 57, // freezing drizzle - precipitation, so grouped with rain
  61, 63, 65, // rain
  66, 67, // freezing rain
  80, 81, 82, // rain showers
];
const SNOW = [
  71, 73, 75, // snowfall
  77, // snow grains
  85, 86, // snow showers
];
const THUNDER = [95, 96, 99];

const LOOKUP = new Map();
const register = (codes, category) => codes.forEach((code) => LOOKUP.set(code, category));

register(CLEAR, CATEGORY.CLEAR);
register(CLOUDY, CATEGORY.CLOUDY);
register(FOG, CATEGORY.FOG);
register(RAIN, CATEGORY.RAIN);
register(SNOW, CATEGORY.SNOW);
register(THUNDER, CATEGORY.THUNDER);

/** WMO code -> CATEGORY. Unrecognised or missing codes fall back to UNKNOWN. */
export function bucketWeatherCode(code) {
  if (!Number.isFinite(code)) return CATEGORY.UNKNOWN;
  const found = LOOKUP.get(code);
  return found === undefined ? CATEGORY.UNKNOWN : found;
}

/** Human-readable condition for a single WMO code, for the city badge. */
const DESCRIPTION = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export function describeWeatherCode(code) {
  return DESCRIPTION[code] ?? 'Unknown conditions';
}
