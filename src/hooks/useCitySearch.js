import { useCallback, useEffect, useRef, useState } from 'react';

const ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const DEBOUNCE_MS = 300;
const RESULT_COUNT = 5;
const MIN_QUERY = 2;

// Repeated queries are common while backspacing, so completed lookups are kept.
const cache = new Map();

/**
 * Debounced city lookup against Open-Meteo's geocoding API.
 *
 * Without the debounce this fires once per keystroke — eight requests to spell
 * "Auckland" — which is both wasteful and racy, since responses can land out of
 * order and leave the dropdown showing matches for a prefix the user has
 * already moved past.
 */
export function useCitySearch(query) {
  const [state, setState] = useState({ results: [], status: 'idle', error: null });
  const requestId = useRef(0);

  const run = useCallback(async (term, signal) => {
    const id = ++requestId.current;
    const key = term.toLowerCase();

    if (cache.has(key)) {
      setState({ results: cache.get(key), status: 'done', error: null });
      return;
    }

    setState((prev) => ({ ...prev, status: 'searching', error: null }));

    try {
      const url = `${ENDPOINT}?name=${encodeURIComponent(term)}&count=${RESULT_COUNT}&language=en&format=json`;
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();

      // A query with no matches answers 200 with the `results` key absent
      // entirely — not an empty array — so this cannot assume the field exists.
      const results = Array.isArray(payload?.results) ? payload.results : [];
      cache.set(key, results);

      // A slower earlier request must never overwrite a newer one's results.
      if (id !== requestId.current) return;
      setState({ results, status: 'done', error: null });
    } catch (err) {
      if (err?.name === 'AbortError' || id !== requestId.current) return;
      setState({ results: [], status: 'error', error: err?.message || 'Search failed' });
    }
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < MIN_QUERY) {
      requestId.current++; // invalidate anything in flight
      setState({ results: [], status: 'idle', error: null });
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => run(term, controller.signal), DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, run]);

  return state;
}

/** "Springfield, Illinois, United States" — never just "Springfield". */
export function describePlace(place) {
  return [place.name, place.admin1, place.country].filter(Boolean).join(', ');
}
