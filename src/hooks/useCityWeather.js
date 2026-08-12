import { useEffect, useState } from 'react';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const CURRENT_FIELDS = [
  'temperature_2m',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'precipitation',
  'cloud_cover',
].join(',');

/**
 * Single-point current conditions for a selected city.
 *
 * Deliberately a separate request from the ambient grid. The grid is 10° spacing
 * — roughly 1,100 km between samples — so its interpolated value at a city is a
 * smoothed regional field, not that city's weather. These two numbers are
 * allowed to disagree and no attempt is made to reconcile them; the marker badge
 * is labelled "current conditions" so it is clear which one is being read.
 */
export function useCityWeather(place) {
  const [state, setState] = useState({ data: null, status: 'idle', error: null });

  useEffect(() => {
    if (!place) {
      setState({ data: null, status: 'idle', error: null });
      return undefined;
    }

    const controller = new AbortController();
    setState({ data: null, status: 'loading', error: null });

    (async () => {
      try {
        const url =
          `${ENDPOINT}?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&current=${CURRENT_FIELDS}`;
        const response = await fetch(url, { signal: controller.signal });
        const payload = await response.json().catch(() => null);

        if (!response.ok) throw new Error(payload?.reason || `HTTP ${response.status}`);
        // Same shape trap as the grid call: an error body can arrive with a 200.
        if (!payload?.current) throw new Error(payload?.reason || 'No current conditions returned');

        setState({ data: payload.current, status: 'done', error: null });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setState({ data: null, status: 'error', error: err?.message || 'Lookup failed' });
      }
    })();

    return () => controller.abort();
  }, [place]);

  return state;
}
