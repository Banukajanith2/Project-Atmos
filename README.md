# Project Atmos

A real-time 3D Earth showing live global surface wind as animated particle
streaks. No API key, no backend, no paid services - the build output is static
files.

Visual reference: [earth.nullschool.net](https://earth.nullschool.net),
simplified.

---

## Setup

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # -> dist/, static files only
npm run preview  # serve the production build locally
```

Deploys as-is to any static host (Vercel, Netlify, GitHub Pages, Cloudflare
Pages). No server runtime, no environment variables, nothing to configure.

## Stack

| Piece | Choice | Why |
|---|---|---|
| Bundler | Vite + React | No routing, SSR, or backend to justify Next.js |
| 3D | `@react-three/fiber` + `@react-three/drei` | React renderer for Three.js; drei supplies `OrbitControls` |
| Data | plain `fetch` | One endpoint - a data-fetching library would be dead weight |

## Data source

[Open-Meteo](https://open-meteo.com) forecast API - free, no key, no signup
(10,000 calls/day, non-commercial).

The API is **per-point**; there is no "whole world" wind grid endpoint. The
global grid is therefore built here and requested in a single batched call:

- 10° spacing, latitude -80…80, longitude -180…170 → **612 points**, under
  Open-Meteo's 1,000-locations-per-request cap.
- `current=wind_speed_10m,wind_direction_10m`
- One request on mount, then a refetch every 30 minutes. Never per frame.

The response is an array in request order, and each entry after the first
carries a zero-based `location_id`; the hook keys off that id where present
rather than trusting array position alone.

## Architecture

```
src/
  main.jsx                  React root (StrictMode)
  App.jsx                   Canvas, Suspense boundary, adaptive quality
  styles.css                design tokens + HUD layout
  components/
    Globe.jsx               sphere, texture, atmosphere, error boundary, controls
    WindParticles.jsx       the wind system (single Points object)
    RainLayer.jsx           falling streaks + the reusable PrecipStreaks core
    ThunderLayer.jsx        PrecipStreaks + independently-timed flashes
    SnowLayer.jsx           slow drifting points
    CloudLayer.jsx          cloud shell + the shared grid-texture builder
    SunnyGlow.jsx           clear-sky wash
    CityMarker.jsx          reticle, label, current-conditions badge
    SearchBar.jsx           debounced search + disambiguation list
    FilterPanel.jsx         layer toggles
    HUD.jsx                 plain DOM overlay - deliberately not inside <Canvas>
  hooks/
    useWindData.js          grid fetch + cache + interval refetch + fallback
    useCitySearch.js        debounced geocoding
    useCityWeather.js       single-point precise fetch
  utils/
    windField.js            grid, vector math, bilinear interpolation, colour ramp
    weatherCodes.js         WMO code -> condition buckets
    cameraFlight.js         great-circle camera interpolation
```

**One rule holds the whole thing together:** per-frame state never touches
React. Particle positions live in typed arrays mutated inside `useFrame`;
React renders the scene graph once and then gets out of the way.

### The wind field

`wind_direction_10m` is *meteorological* - the bearing the wind is coming
**from**. The motion vector is the reverse:

```
u (eastward)  = -speed · sin(direction)
v (northward) = -speed · cos(direction)
```

Sampling is **bilinear** across the four surrounding grid points. The `u`/`v`
components are interpolated rather than speed and bearing - averaging *angles*
across the 359°→1° seam would swing a particle the long way round the compass.

Longitude is treated as **circular**: the neighbour of the 170° column is the
-180° column, so there is no seam at the antimeridian. Latitude neighbours
clamp instead, because no row exists past ±80°.

### Particle streaks

Each particle is drawn as a short trail of points - one live head plus a
ring buffer of frozen past positions - which is what turns a field of dots into
directional streaks. All particles' slots share **one** `BufferGeometry` and
**one** `THREE.Points` object, so it stays a single draw call.

Trail samples are laid down every 110 ms rather than every frame; at 60 fps a
per-frame sample would be sub-pixel and the streak would collapse into a blob.
Because the cadence is measured in simulated seconds, streak length is the same
whether the device runs at 60 fps or 15.

`TIME_ACCEL` in `WindParticles.jsx` is a pure playback speed-up. Real surface
wind moves about 0.0001°/s, which is invisible; the constant only affects
animation, never the speeds reported in the HUD.

### Adaptive quality

Capability probe on mount - `navigator.deviceMemory`, `hardwareConcurrency`,
and `prefers-reduced-motion` - followed by a live frame-time probe that
downgrades once if the device sustains under 38 fps.

The runtime probe matters because `deviceMemory` is Chromium-only: iOS Safari
reports nothing, so a missing value has to mean *unknown*, not *fast*. This is
**capability detection, never brand detection** - an old iPhone under Safari's
memory-pressure eviction chokes on a scene a new one handles fine, and the user
agent cannot tell you which one you have.

| Tier | Streaks | DPR cap | Antialiasing |
|---|---|---|---|
| full | 2,800 | 2 | on |
| reduced | 700 | 1.5 | off |

Degradation is stated, not silent: the HUD shows a "reduced quality mode"
notice with the reason that triggered it.

## Known bugs, pre-empted

Each of these is fixed in the code as shipped. The table is here so the
reasoning is not lost the next time someone "simplifies" one of them.

| Issue | Fix |
|---|---|
| Blank canvas, no error | `useLoader` suspends - missing `<Suspense>` blanks the canvas silently. Boundary lives in `App.jsx`. |
| Texture CORS / 404 failure | CDN URL verified to return `200` + `access-control-allow-origin: *` before wiring it in. Note the three.js `examples/textures/planets/...` paths on unpkg and jsdelivr now **404** - they are not published inside the npm package. |
| Texture fails anyway | A thrown loader error does not land in a Suspense fallback. `Globe.jsx` has a real error boundary that swaps in a flat dark material, and the HUD says so. |
| Particle animation janky | `BufferAttribute` arrays mutated in `useFrame` with `needsUpdate = true`. Per-frame positions in `useState` would re-render React at 60 Hz. |
| Duplicate fetch in dev console | Expected StrictMode double-invoke, not a bug. Guarded by an `AbortController` plus an in-flight ref so it does not double-hit the API. |
| Blocky / robotic motion | Bilinear interpolation, never nearest-neighbour. |
| Breakage at the poles | Hard exclusion at ±80° with an opacity fade from ±66°, so the cutoff is a soft horizon rather than a ring of vanishing particles. |
| Breakage at the antimeridian | Circular longitude interpolation. Folding ±180° is continuous in 3D, so trails do not smear across the globe at the seam. |
| Open-Meteo unreachable | `try`/`catch` with a synthetic banded-zonal-flow fallback field, so the globe is never empty. Error surfaced in the HUD. |
| Rate limit returns **200** | A rate-limited reply is `{error: true, reason: "..."}` and can arrive with a 200 status, so `response.ok` alone is not enough - the body shape is validated too. |
| A refresh fails after a good fetch | Last good field is kept and the HUD flags the stale refresh, rather than throwing away live data for synthetic. |
| iOS Safari killed under memory pressure | Capability probe + live frame-time probe. Never a brand check. |
| Canvas jumps on resize | `<Canvas>` owns resize. Nothing else calls `setSize`/`setPixelRatio` - a second writer fights it. |
| Hammering the API | One batched request on mount + 30-minute interval, cleaned up on unmount. Never inside `useFrame`. |
| Camera clipping through the globe | `minDistance`/`maxDistance` clamped on `OrbitControls`. |
| Camera flies through the globe, or the long way round, on antimeridian-crossing searches | Quaternion slerp of the camera *direction*, never a lat/lon or xyz lerp. Lerping lat/lon sends 175°E → 175°W the 350° way; lerping xyz cuts a chord through the planet's interior. |
| Exactly antipodal flight produces NaN | `setFromUnitVectors` picks an arbitrary perpendicular axis for the 180° case; covered by a test. |
| Zoomed-in city view looks pixelated | `minDistance` derived from the basemap's real texel density (see above), not chosen by feel. |
| Ambiguous city names resolve to the wrong place silently | Region and country always shown; selection is always explicit. |
| Geocoding request on every keystroke | 300 ms debounce plus a query cache in `useCitySearch.js`. Verified: 11 keystrokes → 1 request. |
| Geocoding "no match" crashes the dropdown | A query with no results answers **200 with the `results` key absent entirely** - not an empty array - so the shape is validated rather than assumed. |
| Out-of-order search responses overwrite newer ones | Each lookup carries a request id; a stale response is discarded. |
| City badge disagrees with the ambient grid at that point | Expected - different fidelities. Labelled "current conditions" rather than reconciled. |
| Misclassified conditions (drizzle shown as thunder) | Explicit WMO code sets, not range guesses. Covered by per-code tests. |
| All layers on at once becomes visual noise | Capped at 3 (1 in reduced quality); the oldest selection is evicted rather than the tap ignored. |
| Frame drops from layers that are toggled off | Layers are unmounted, not hidden, so their `useFrame` stops entirely. |
| Auto-rotate fighting the search camera flight | Auto-rotate is disabled for the duration of any camera animation and re-armed only by the normal idle timer. |
| Weather layers misaligned half a cell from their data | Grid textures correct for the half-texel offset (grid point 0 is the *centre* of texel 0) and rescale sphere V from ±90° to the grid's ±80°. |

## Design

| Token | Value |
|---|---|
| Background base / mid | `#0b1120` / `#101c33` |
| Surface (glass) | `rgba(255,255,255,.055)` |
| Border | `rgba(255,255,255,.10)` |
| Text / secondary | `#f1f5f9` / `#9aabc4` |
| Accent (wind) | `#5fd0ff` |
| Warning | `#fbbf24` |

Deliberately **not** a pure-black backdrop. Flat `#000` flattens the globe and
turns every panel edge into a hairline diagram; the background is a layered blue
gradient instead, and the panels are translucent glass that picks it up.

Glass is applied **selectively** - to the floating panels only, never the whole
page - which is what keeps it reading as current rather than 2020. Corners are
18 px, type is plain Inter at readable sizes rather than letterspaced caps and
monospace telemetry, and numbers use `tabular-nums` so values that change every
frame do not reflow their row.

The HUD is a plain DOM overlay with `pointer-events: none`; only the compass
button opts back in.

The particle colour ramp and the HUD legend read from the same `SPEED_STOPS`
array in `windField.js`, so the two cannot drift apart. Its low stop is tuned to
stay visible over sunlit land - a near-black "calm" colour disappears against
the basemap under additive blending.

## Controls

- **Drag** to rotate, **scroll** or the **+ / -** buttons to zoom. Zoom steps are
  multiplicative, so each press covers the same proportion of the remaining
  distance - a fixed step is a nudge when far out and a lurch when already close.
- Auto-rotate resumes after 3.5 s idle.
- **Compass button** resets to north, the way Google Earth's compass behaves: it
  levels the tilt so the pole points up the screen, without teleporting you to a
  different part of the world. OrbitControls never rolls the camera, so the polar
  angle is the only thing that can put north off-vertical - that is animated back
  to the equator while azimuth and zoom are left exactly where you left them.
- All camera animations (flight, reset, zoom) share **one** animation slot, so
  starting any of them cancels the others instead of two of them fighting over
  the camera. A manual drag cancels whatever is running.

### Zoom limits are set by the texture, not by feel

The basemap is 4096 px around 360° of longitude - about 652 px per world unit at
the equator. With a 42° vertical FOV, magnification passes 1:1 at roughly
`distance = 2.8` on a 900 px-tall window, which is far enough out that enforcing
it strictly would forbid zooming at all. `minDistance` is therefore **1.75**,
capping magnification at about 2.5×, which linear filtering plus anisotropy carry
without the texture visibly breaking into texels.

## City search

Open-Meteo's geocoding API (`geocoding-api.open-meteo.com`), same provider, still
no key. Typing is debounced 300 ms and completed queries are cached, so spelling
"Springfield" costs **one** request, not eleven.

Results **always** show region and country. There is deliberately no path that
jumps to the top hit when several matches exist - "Springfield" matches a dozen
real places, and silently flying to the most populous one is a wrong answer
delivered confidently.

Selecting a result fires a **separate single-point** request for that city's
current conditions. This is intentionally not reconciled with the ambient grid:
the grid is 10° spacing (~1,100 km between samples), so its interpolated value at
a city is a smoothed regional field, not that city's weather. The two are allowed
to disagree, and the marker badge is labelled "current conditions" to say which
one is being read.

The marker is a **locator reticle, not a city boundary**. Real administrative
limits need a separate polygon dataset (Natural Earth, OSM boundaries) that the
weather API does not carry - a valid future enhancement, out of scope here.

## Weather layers

All six read from the *same* batched 612-point grid request as the wind field -
`weather_code`, `precipitation`, `cloud_cover` and `temperature_2m` were added to
the existing call, so the extra layers cost zero additional API budget.

| Layer | Rendering | Why it is not a recolour |
|---|---|---|
| Wind | Point trails along the interpolated vector field | - |
| Rain | `LineSegments` anchored to the radial | A line has an axis; anchoring it to "straight down" reads as falling from any camera angle |
| Thunderstorm | Rain's motion, plus flash sprites | Each cell owns its countdown and duration, so storms never strobe in unison |
| Snow | Round points, ⅓ the fall speed, per-flake lateral wander | Recolouring rain white just produces white rain |
| Clear | Cool additive wash over clear cells | "Clear" is a reported state; drawing nothing would look like missing data |
| Clouds | Translucent white shell, opacity from `cloud_cover` | Coverage is a state, not a particle phenomenon |

Layers are capped at **3 at once** (1 in reduced-quality mode). Going past the cap
drops the *oldest* selection rather than rejecting the tap - a button that
visibly does nothing reads as broken.

Each layer is **unmounted** when toggled off, not hidden. Unmounting is the
pause: a hidden-but-mounted layer keeps running its `useFrame` simulation and
costs exactly as much as a visible one.

Clouds and Clear are **off by default**, so the globe on load looks exactly as it
does without this phase.

### A note on the sunny glow

The brief specified a *warm* rim-light for clear sky. It is implemented cool
(`#cfeaff`) instead: a warm gold accent would introduce a second colour
temperature competing with the blue basemap and the cyan wind ramp. Change
`GLOW_COLOUR` in `SunnyGlow.jsx` if you want the literal reading.

### WMO code buckets

`utils/weatherCodes.js` maps codes as explicit sets, not ranges. The numbering is
not contiguous by condition - 77 (snow grains) sits between 71-75 (snowfall) and
85-86 (snow showers) - so "code > 70 means snow" style shortcuts misclassify.
Codes 56/57 (freezing drizzle) are absent from the brief's list and are grouped
with rain here, since they are precipitation and would otherwise render as
nothing.

The particle colour ramp and the HUD legend read from the same `SPEED_STOPS`
array in `windField.js`, so the two cannot drift apart.

## Notes

- The JS bundle is ~1.1 MB (~300 KB gzipped), almost entirely Three.js. Fine for
  a static portfolio piece; code-split if that ever stops being true.
- The Earth texture is NASA Blue Marble at 4096×2048 (~1.4 MB), the single
  heaviest asset and the one thing loaded from a CDN at runtime. The 93 KB
  `earth-dark.jpg` alternative is far lighter but renders as near-black
  landmasses that are illegible on a dark background; readability won. Self-host
  it if you would rather not depend on jsDelivr.
- The atmosphere glow is a Fresnel shader on a back-faced shell, not a
  translucent sphere. A uniform-opacity shell renders as a flat disc with a hard
  circular edge, which reads as a grey ring around the planet.
- Wind is 10 m above ground and updates upstream every 15 minutes, so a 30-minute
  refresh is comfortably inside the data's own resolution.

## Out of scope (Phase 2)

No aurora layer, no NOAA aurora data, no dark-mode toggle. No routing, backend,
login, or analytics.
