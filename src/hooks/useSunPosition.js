import { useEffect, useMemo, useState } from 'react';
import { latLonToVec3 } from '../utils/windField';

/**
 * Subsolar point - the lat/lon where the sun is directly overhead - and the unit
 * vector pointing at it, for the day/night terminator.
 *
 * Everything here runs on UTC. `Date.now()` is an absolute instant, and the
 * astronomical formulas below consume it as one, so no local-time component ever
 * enters the calculation. That is deliberate and it is the whole correctness
 * story for this file: the classic version of this bug reads `getHours()`
 * somewhere in the chain, which silently rotates the terminator by the viewer's
 * UTC offset - up to 14 hours, or 210 degrees of longitude, and it looks
 * perfectly plausible to anyone testing in UTC+0.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Unix epoch in Julian days, and the J2000.0 epoch the series below is fitted to. */
const UNIX_EPOCH_JD = 2440587.5;
const J2000 = 2451545.0;

/**
 * Low-accuracy solar position, the formulation published in the Astronomical
 * Almanac. Good to roughly 0.01 degrees for the next century, which is several
 * orders of magnitude better than a soft terminator gradient can show.
 *
 * @param {number} [nowMs] milliseconds since the Unix epoch; defaults to now.
 * @returns {{lat: number, lon: number}} subsolar latitude and longitude in
 *   degrees, longitude normalised to [-180, 180).
 */
export function subsolarPoint(nowMs = Date.now()) {
  // Days since J2000.0. Both terms are absolute instants, so this is UTC by
  // construction - there is no calendar arithmetic here to get a timezone wrong.
  const n = nowMs / 86400000 + UNIX_EPOCH_JD - J2000;

  const meanLongitude = 280.46 + 0.9856474 * n;
  const meanAnomaly = (357.528 + 0.9856003 * n) * DEG2RAD;

  // Equation of centre: the correction from the fictitious "mean sun" that moves
  // at a constant rate to the real one on an elliptical orbit. Dropping it is
  // the second most common way to get this wrong, and costs up to 4 degrees of
  // longitude either side of the true terminator.
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG2RAD;

  const obliquity = (23.439 - 0.0000004 * n) * DEG2RAD;

  const sinDeclination = Math.sin(obliquity) * Math.sin(eclipticLongitude);
  const lat = Math.asin(sinDeclination) * RAD2DEG;

  const rightAscension =
    Math.atan2(
      Math.cos(obliquity) * Math.sin(eclipticLongitude),
      Math.cos(eclipticLongitude),
    ) * RAD2DEG;

  // Greenwich mean sidereal time, in hours, then in degrees. Subtracting it from
  // the sun's right ascension turns a celestial coordinate into a position over
  // the rotating Earth.
  const gmstHours = 18.697374558 + 24.06570982441908 * n;
  const gmstDegrees = ((gmstHours % 24) + 24) % 24 * 15;

  const lon = (((rightAscension - gmstDegrees + 180) % 360) + 360) % 360 - 180;

  return { lat, lon };
}

/**
 * Refresh cadence. The subsolar point moves 15 degrees of longitude per hour, so
 * a minute of drift is a quarter of a degree - far below what a soft gradient
 * makes visible, and this triggers a React render, so it has no business being
 * any faster. It certainly has no business being in `useFrame`.
 */
const TICK_MS = 60 * 1000;

/**
 * @returns {{lat: number, lon: number, direction: [number, number, number]}}
 *   `direction` is a unit vector in the same frame `latLonToVec3` produces, so
 *   it lines up with the globe mesh without any extra rotation.
 */
export function useSunPosition() {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const { lat, lon } = subsolarPoint(nowMs);
    const direction = latLonToVec3(lat, lon, 1, [0, 0, 0]);
    return { lat, lon, direction };
  }, [nowMs]);
}
