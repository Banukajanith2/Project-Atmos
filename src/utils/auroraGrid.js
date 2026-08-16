/**
 * auroraGrid.js - OVATION probability grid -> equirectangular canvas texture.
 *
 * NOAA hands back 65,160 flat `[lon, lat, probability]` triples. Rendering that
 * as 65,160 points would be the wrong tool twice over: it is a dense regular
 * grid, not a point cloud, and the thing it describes is a soft glow rather than
 * a set of discrete objects. Rasterising it into a texture instead costs one
 * draw call and gets smooth interpolation from the GPU for free.
 *
 * Verified against the live payload on 2026-08-16:
 *   - 65,160 triples, longitude-major: index = lon * 181 + (lat + 90).
 *   - longitude 0..359 (unsigned), latitude -90..90 inclusive, probability
 *     0..100 as a percentage.
 */

export const N_LON = 360;
export const N_LAT = 181; // -90..90 inclusive
export const GRID_SIZE = N_LON * N_LAT;

/**
 * Probability treated as "full brightness". The real scale is 0-100, but an
 * ordinary night peaks in the 20-40 range and a strong storm rarely passes 70,
 * so normalising against 100 would render most nights as a barely visible
 * smudge. This is a display gain, not a rescaling of the data - the HUD reports
 * the true observed peak alongside it so the number is never hidden behind the
 * gain.
 */
export const FULL_SCALE = 45;

/**
 * Probabilities below this are dropped. The model emits a low single-digit haze
 * across most of the globe, including the interior of both polar caps, which
 * accumulates under additive blending into a dirty film over the whole planet.
 */
const NOISE_FLOOR = 3;

/**
 * Flatten the triples into a lat-major Float32Array indexed by
 * `latIdx * N_LON + lonIdx`, with longitude re-centred so index 0 is -180.
 *
 * Done once per fetch. Every downstream rasterise reads this array, so
 * re-rasterising at a different resolution never re-walks the raw JSON.
 *
 * @param {Array<[number, number, number]>} coordinates
 * @returns {{values: Float32Array, peak: number, hemisphere: 'north'|'south'}}
 *   `peak` is the true maximum probability in the payload, ungained and
 *   unclamped. `hemisphere` is whichever oval is currently stronger, so the
 *   camera can be sent to the one actually worth looking at.
 */
export function parseCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) throw new Error('Aurora payload has no coordinate array');

  const values = new Float32Array(GRID_SIZE);
  let peak = 0;
  let seen = 0;
  // Summed rather than maximised: both ovals routinely touch a similar peak, so
  // total activity is what actually distinguishes them.
  let northTotal = 0;
  let southTotal = 0;

  for (let i = 0; i < coordinates.length; i++) {
    const triple = coordinates[i];
    if (!triple || triple.length < 3) continue;
    const lon = triple[0];
    const lat = triple[1];
    const probability = triple[2];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(probability)) continue;

    const latIdx = Math.round(lat) + 90;
    if (latIdx < 0 || latIdx >= N_LAT) continue;
    // Re-centre 0..359 onto -180..179 so column 0 is the antimeridian, matching
    // the equirectangular convention the basemap already uses.
    const lonIdx = (((Math.round(lon) + 180) % 360) + 360) % 360;

    values[latIdx * N_LON + lonIdx] = probability;
    if (probability > peak) peak = probability;
    if (latIdx > 90) northTotal += probability;
    else if (latIdx < 90) southTotal += probability;
    seen++;
  }

  if (seen === 0) throw new Error('Aurora payload contained no usable points');
  return { values, peak, hemisphere: southTotal > northTotal ? 'south' : 'north' };
}

/**
 * Separable box blur over the grid, in place of a single wide pass.
 *
 * Nearest-neighbour sampling of a 1-degree grid is visibly blocky once the globe
 * fills the viewport - one cell lands on roughly three screen pixels - and
 * bilinear filtering alone turns those blocks into diamonds rather than removing
 * them. Two cheap 1D passes over 65k floats fix it before the data ever reaches
 * the GPU.
 *
 * Longitude wraps (the grid is circular); latitude clamps, because there is no
 * row past the poles to blend toward.
 */
function blur(values, radius) {
  if (radius < 1) return values;

  const width = 1 + radius * 2;
  const horizontal = new Float32Array(GRID_SIZE);

  for (let y = 0; y < N_LAT; y++) {
    const row = y * N_LON;
    for (let x = 0; x < N_LON; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += values[row + (((x + k) % N_LON) + N_LON) % N_LON];
      }
      horizontal[row + x] = sum / width;
    }
  }

  const out = new Float32Array(GRID_SIZE);
  for (let y = 0; y < N_LAT; y++) {
    for (let x = 0; x < N_LON; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(N_LAT - 1, Math.max(0, y + k));
        sum += horizontal[yy * N_LON + x];
      }
      out[y * N_LON + x] = sum / width;
    }
  }

  return out;
}

/**
 * Colour ramp, in the order a real auroral oval brightens: a dim teal haze at
 * the edges, oxygen green through the body of the oval, and a pale green-white
 * core where the probability is highest. Written into `out` to avoid allocating
 * per pixel.
 */
function auroraColor(t, out) {
  if (t < 0.45) {
    const k = t / 0.45;
    out[0] = 20 + k * 26;
    out[1] = 150 + k * 78;
    out[2] = 170 + k * 20;
  } else {
    const k = (t - 0.45) / 0.55;
    out[0] = 46 + k * 164;
    out[1] = 228 + k * 27;
    out[2] = 190 + k * 55;
  }
  return out;
}

/**
 * Rasterise the parsed grid into an equirectangular canvas.
 *
 * The canvas is built so its pixel *centres* land on the sphere's UV grid, which
 * is why the loop walks output pixels and looks data up, rather than walking
 * data points and writing pixels. Doing it the other way round leaves the map
 * offset by half a texel and the whole oval sits half a cell off its true
 * latitude - the same trap the Phase 1.5 weather layers had to correct for with
 * an explicit texture offset. Generating the pixels in the sphere's own frame
 * makes the correction unnecessary.
 *
 * @param {Float32Array} values from `parseCoordinates`
 * @param {{step?: number, canvas?: HTMLCanvasElement}} options `step` > 1
 *   downsamples for the reduced-quality path.
 * @returns {HTMLCanvasElement}
 */
export function rasterizeAurora(values, { step = 1, canvas } = {}) {
  const width = Math.max(2, Math.round(N_LON / step));
  const height = Math.max(2, Math.round((N_LAT - 1) / step) + 1);

  const target = canvas || document.createElement('canvas');
  target.width = width;
  target.height = height;

  const context = target.getContext('2d');
  const image = context.createImageData(width, height);
  const data = image.data;

  // Blur radius is in source cells, so it has to shrink with the output or a
  // downsampled texture ends up smeared into a featureless band.
  const smoothed = blur(values, step > 2 ? 1 : 2);

  const rgb = [0, 0, 0];
  const lonScale = N_LON / width;
  const latScale = (N_LAT - 1) / (height - 1);

  for (let y = 0; y < height; y++) {
    // Canvas row 0 is the top of the image, which a flipY texture maps to
    // uv.y = 1, which is the north pole - so row 0 must read the *last* grid
    // row, because `parseCoordinates` indexes latitude from -90 upward. Reading
    // it in the same direction as y mirrors the planet about the equator and
    // parks the northern oval over Antarctica, which looks plausible enough at a
    // glance to survive a casual check.
    // Canvas row 0 is the top of the image; three's default `flipY` puts that at
    // uv.y = 1, and SphereGeometry puts uv.y = 1 at the north pole (verified
    // against the geometry: lat +90 -> v 1.000, lat -90 -> v 0.000). Because
    // `parseCoordinates` indexes latitude from -90 upward, row 0 has to read the
    // *last* grid row. Walking both in the same direction mirrors the planet
    // about the equator and parks the northern oval over Antarctica.
    const latIdx = N_LAT - 1 - Math.min(N_LAT - 1, Math.round(y * latScale));
    const row = latIdx * N_LON;

    for (let x = 0; x < width; x++) {
      const lonIdx = Math.min(N_LON - 1, Math.round(x * lonScale));
      const probability = smoothed[row + lonIdx];
      const offset = (y * width + x) * 4;

      if (probability <= NOISE_FLOOR) {
        data[offset + 3] = 0;
        continue;
      }

      const t = Math.min(1, (probability - NOISE_FLOOR) / (FULL_SCALE - NOISE_FLOOR));
      auroraColor(t, rgb);
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      // Alpha ramps faster than linearly at the low end so the oval keeps a soft
      // outer falloff instead of ending on a visible edge.
      data[offset + 3] = Math.round(255 * Math.pow(t, 0.75));
    }
  }

  context.putImageData(image, 0, 0);
  return target;
}

/**
 * Procedural fallback oval, used only if the NOAA fetch fails outright.
 *
 * CORS is not the reason this exists - the endpoint was verified to send
 * `access-control-allow-origin: *` - but a government data service going down
 * for maintenance is ordinary, and an empty aurora mode reads as a broken app.
 * Shaped as a ring offset toward the geomagnetic poles rather than the
 * geographic ones, which is why the real oval sits over northern Canada rather
 * than centred on the north pole.
 */
export function syntheticAurora() {
  const values = new Float32Array(GRID_SIZE);

  // Geomagnetic pole positions, north and south, as [lat, lon] in degrees.
  const poles = [
    [80.7, -72.7],
    [-80.7, 107.3],
  ];
  const RING_RADIUS = 21; // degrees of colatitude from the pole
  const RING_WIDTH = 7;

  for (let y = 0; y < N_LAT; y++) {
    const lat = y - 90;
    for (let x = 0; x < N_LON; x++) {
      const lon = x - 180;
      let best = 0;

      for (const [poleLat, poleLon] of poles) {
        // Great-circle distance, so the ring stays circular over the pole
        // instead of stretching into a lens the way a flat lat/lon distance does.
        const a = (lat * Math.PI) / 180;
        const b = (poleLat * Math.PI) / 180;
        const dLon = ((lon - poleLon) * Math.PI) / 180;
        const cosDistance = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dLon);
        const distance = (Math.acos(Math.min(1, Math.max(-1, cosDistance))) * 180) / Math.PI;

        const offset = (distance - RING_RADIUS) / RING_WIDTH;
        const intensity = 34 * Math.exp(-offset * offset);
        if (intensity > best) best = intensity;
      }

      values[y * N_LON + x] = best;
    }
  }

  return { values, peak: 34, hemisphere: 'north' };
}
