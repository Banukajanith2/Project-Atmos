# Project Atmos

A real-time 3D Earth showing live global weather on a WebGL globe: animated wind
streaks, six weather layers, and a live NOAA auroral oval. No API key, no
backend, no paid services - the build output is static files.

Live: <https://banukajanith2.github.io/Project-Atmos/>
Visual reference: [earth.nullschool.net](https://earth.nullschool.net), simplified.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
npm run build:only # -> dist/, static files only
npm run build      # build AND deploy to the gh branch
npm run preview    # serve the production build locally
```

Deploys as-is to any static host. No server runtime, no environment variables.
`base: './'` in `vite.config.js` is required - this is a project site served from
a subpath, so the default absolute base 404s every asset.

## Stack

Vite + React (no routing, SSR or backend to justify Next.js),
`@react-three/fiber` + `@react-three/drei` for the scene, plain `fetch` for data.

## Data sources

All free, no key, no signup.

| Source | Used for | Cadence |
|---|---|---|
| [Open-Meteo](https://open-meteo.com) forecast | Wind + all six weather layers | 30 min |
| Open-Meteo geocoding | City search | debounced, cached |
| [NOAA SWPC OVATION](https://services.swpc.noaa.gov/json/ovation_aurora_latest.json) | Auroral oval | 5 min, lazy |

Open-Meteo is **per-point** - there is no whole-world grid endpoint - so the grid
is built here and requested in one batched call: 10° spacing, lat -80…80,
lon -180…170 → **612 points**, under the 1,000-per-request cap. Every weather
layer reads from that same request, so the extra layers cost zero API budget.
Responses carry a zero-based `location_id`; the hook keys off it rather than
trusting array position.

OVATION is 924 KB of flat `[lon, lat, probability]` triples: 65,160 points,
**longitude-major**, lon 0-359 unsigned, lat -90 to 90 inclusive. Verified to send
`access-control-allow-origin: *`. Fetched lazily - a user who never opens Aurora
never pays for it.

## Architecture

```
src/
  App.jsx                   Canvas, Suspense boundary, adaptive quality, mode crossfade
  components/
    Globe.jsx               sphere, texture, atmosphere, terminator, error boundary, controls
    WindParticles.jsx       the wind system (single Points object)
    RainLayer.jsx           falling streaks + the reusable PrecipStreaks core
    ThunderLayer.jsx        PrecipStreaks + independently-timed flashes
    SnowLayer.jsx           slow drifting points
    CloudLayer.jsx          cloud shell + the shared grid-texture builder
    SunnyGlow.jsx           clear-sky wash
    AuroraLayer.jsx         auroral oval as an additive canvas-texture shell
    CityMarker.jsx          reticle, label, current-conditions badge
    SearchBar.jsx           debounced search + disambiguation list
    FilterPanel.jsx         layer toggles, including the exclusive Aurora chip
    HUD.jsx                 plain DOM overlay - deliberately not inside <Canvas>
  hooks/
    useWindData.js          grid fetch + cache + interval refetch + fallback
    useAuroraData.js        OVATION fetch + cache + 5-minute refetch + fallback
    useSunPosition.js       subsolar point from UTC, for the terminator
    useCitySearch.js        debounced geocoding
    useCityWeather.js       single-point precise fetch
  utils/
    windField.js            grid, vector math, bilinear interpolation, colour ramp
    auroraGrid.js           probability grid -> blurred canvas texture
    weatherCodes.js         WMO code -> condition buckets
    cameraFlight.js         great-circle camera interpolation
```

**One rule holds the whole thing together:** per-frame state never touches React.
Particle positions live in typed arrays mutated inside `useFrame`; React renders
the scene graph once and gets out of the way. The mode crossfade follows the same
rule - it runs through a ref, so a 1.4 s animation causes zero renders.

## How it works

**Wind field.** `wind_direction_10m` is *meteorological* - the bearing wind comes
**from** - so the motion vector is `u = -speed·sin(dir)`, `v = -speed·cos(dir)`.
Sampling is bilinear on the `u`/`v` components, not on speed and bearing:
averaging angles across the 359°→1° seam swings a particle the long way round the
compass. Longitude is circular; latitude clamps, as no row exists past ±80°.

**Streaks.** Each particle is a short trail - one live head plus a ring buffer of
frozen past positions - all sharing one `BufferGeometry` and one `Points` object,
so it stays a single draw call. Trail samples are laid down every 110 ms; at
60 fps a per-frame sample would be sub-pixel and collapse into a blob.

**Adaptive quality.** Capability probe on mount (`deviceMemory`,
`hardwareConcurrency`, `prefers-reduced-motion`), then a live frame-time probe
that downgrades once below 38 fps. The runtime probe matters because
`deviceMemory` is Chromium-only, so a missing value must mean *unknown*, not
*fast*. Capability detection, never brand detection.

| Tier | Streaks | DPR cap | Antialiasing | Aurora grid |
|---|---|---|---|---|
| full | 2,800 | 2 | on | 360×181 |
| reduced | 700 | 1.5 | off | 180×91 |

**Zoom limits come from the texture, not from feel.** The basemap is 4096 px
around 360° (~652 px per world unit at the equator). `minDistance` is **1.75**,
capping magnification at ~2.5×, which linear filtering plus anisotropy carry
without visible texels.

## Aurora

The seventh chip in the filter row, and the one **exclusive** entry: selecting it
clears the others and deselecting restores them. The rest are washes over a
daylit Earth and combine happily, but Aurora rebuilds the scene around a dark
one, so pairing them would mean lighting and unlighting the globe at once.

Mode is **derived** from `activeLayers.includes('aurora')`, never stored beside
it - two pieces of state describing one thing eventually disagree.

**Why a texture, not points.** 65,160 is the wrong count for a `Points` object
and the right count for a raster: a dense regular grid describing a soft glow. It
is rasterised to a canvas and applied as a `CanvasTexture` on an additive shell
just clear of the surface - one draw call, GPU interpolation for free. Two cheap
separable blur passes run first, because at 1° resolution a cell covers ~3 screen
pixels and bilinear filtering alone turns blocks into diamonds. The shell
brightens at grazing angles, which is why real aurora glows hardest at the limb.

**Display gain.** The ramp saturates at **45%**, not 100%. An ordinary night
peaks at 20-40 and a strong storm rarely passes 70, so normalising against the
nominal maximum would render most nights as a smudge. The legend states the scale
and the HUD reports the true observed peak, so the gain is visible, not hidden.
Values below 3% are dropped - the model emits a low haze over most of the globe
that accumulates under additive blending into a dirty film.

**Terminator.** The subsolar point uses the Astronomical Almanac's low-accuracy
formula including the equation of centre (dropping it costs up to 4° of
longitude). It is injected into the **existing** `MeshStandardMaterial` via
`onBeforeCompile` rather than replacing it - the Phase 1 globe is already lit,
textured and emissive-mapped correctly. The patch is a strict no-op at
`uNight = 0`, so **Wind mode keeps the Phase 1 look exactly**: flat bright
lighting, no terminator, the full wind field readable everywhere.

## Weather layers

All six read from the same batched 612-point request.

| Layer | Rendering | Why it is not a recolour |
|---|---|---|
| Wind | Point trails along the interpolated vector field | - |
| Rain | `LineSegments` anchored to the radial | A line has an axis; anchoring it to "down" reads as falling from any angle |
| Thunderstorm | Rain's motion, plus flash sprites | Each cell owns its countdown, so storms never strobe in unison |
| Snow | Round points, ⅓ the fall speed, lateral wander | Recolouring rain white just produces white rain |
| Clear | Cool additive wash over clear cells | "Clear" is a reported state; drawing nothing would look like missing data |
| Clouds | Translucent shell, opacity from `cloud_cover` | Coverage is a state, not a particle phenomenon |

Capped at **3 at once** (1 in reduced quality); going past the cap drops the
*oldest* selection rather than rejecting the tap, because a button that visibly
does nothing reads as broken. Layers are **unmounted** when off, not hidden -
unmounting is the pause.

The sunny glow is deliberately cool (`#cfeaff`) rather than the warm rim-light
the brief specified: a gold accent would fight the blue basemap and cyan wind
ramp. `utils/weatherCodes.js` maps WMO codes as explicit sets, not ranges - the
numbering is not contiguous by condition.

## City search

Debounced 300 ms with a query cache, so typing "Springfield" costs one request,
not eleven. Results **always** show region and country, and there is deliberately
no path that jumps to the top hit - "Springfield" matches a dozen real places,
and silently flying to the most populous one is a wrong answer delivered
confidently.

Selecting a result fires a separate single-point request. This is intentionally
not reconciled with the ambient grid: at 10° spacing (~1,100 km) the interpolated
value at a city is a smoothed regional field, not that city's weather. The badge
is labelled "current conditions" to say which is being read. The marker is a
locator reticle, not a city boundary.

## Controls

Drag to rotate, scroll or **+ / -** to zoom; auto-rotate resumes after 3.5 s
idle. Zoom steps are multiplicative, so each press covers the same proportion of
the remaining distance. The compass button levels the tilt so the pole points up
the screen without teleporting you elsewhere. All camera animations share **one**
slot, so starting any cancels the others rather than two fighting for the camera.

## Design

| Token | Value |
|---|---|
| Background base / mid | `#0b1120` / `#101c33` |
| Surface (glass) | `rgba(255,255,255,.055)` |
| Border | `rgba(255,255,255,.10)` |
| Text / secondary | `#f1f5f9` / `#9aabc4` |
| Accent (wind) / Aurora | `#5fd0ff` / `#2ee4be` |
| Warning | `#fbbf24` |

Deliberately **not** pure black - flat `#000` flattens the globe and turns every
panel edge into a hairline diagram. Glass is applied selectively, to the floating
panels only, which keeps it reading as current rather than 2020. Numbers use
`tabular-nums` so values that change every frame do not reflow their row. The HUD
is plain DOM with `pointer-events: none`; only controls opt back in.

The particle ramp and the HUD legend both read `SPEED_STOPS` from
`windField.js`, so they cannot drift apart.

## Known bugs, pre-empted

Each is fixed in the code as shipped. The table exists so the reasoning is not
lost the next time someone "simplifies" one of them.

| Issue | Fix |
|---|---|
| Blank canvas, no error | `useLoader` suspends - the `<Suspense>` boundary lives in `App.jsx`. |
| Texture 404 / CORS | CDN URL verified before wiring it in. three.js `examples/textures/planets/...` paths on unpkg and jsdelivr now **404** - not published in the npm package. |
| Texture fails anyway | A thrown loader error does not land in a Suspense fallback; `Globe.jsx` has a real error boundary. |
| Janky particles | `BufferAttribute` arrays mutated in `useFrame`. Per-frame positions in `useState` would re-render at 60 Hz. |
| Duplicate fetch in dev | StrictMode double-invoke. A per-component ref cannot stop it - its cleanup runs before the second mount - so both hooks dedupe at **module scope**. |
| Blocky motion | Bilinear interpolation of `u`/`v`, never nearest-neighbour or angle averaging. |
| Breakage at poles / antimeridian | Hard exclusion at ±80° with a fade from ±66°; longitude wraps circularly. |
| Rate limit returns **200** | The reply is `{error: true, reason}` and can arrive with a 200, so the body shape is validated, not just `response.ok`. |
| Refresh fails after a good fetch | Last good field is kept and the HUD flags it, rather than discarding live data. |
| API unreachable | Synthetic banded-zonal-flow field for wind, procedural two-pole ring for aurora. The globe is never empty and the HUD says which you are seeing. |
| Canvas jumps on resize | `<Canvas>` owns resize. Nothing else calls `setSize`/`setPixelRatio`. |
| Camera flies through the globe, or the long way round | Quaternion slerp of the camera *direction*. Lerping lat/lon sends 175°E → 175°W the 350° way; lerping xyz cuts a chord through the interior. |
| Geocoding "no match" crashes | A no-result query answers **200 with `results` absent entirely**, not an empty array. |
| Out-of-order search responses | Each lookup carries a request id; stale responses are discarded. |
| Frame drops from layers toggled off | Layers are unmounted, not hidden, so their `useFrame` stops entirely. |
| Auto-rotate fights a camera animation | Disabled for the duration of any animation, re-armed only by the idle timer. |
| Grid layers misaligned half a cell | Textures correct for the half-texel offset and rescale sphere V from ±90° to the grid's ±80°. |
| **Aurora** oval in the wrong hemisphere | OVATION indexes latitude from -90 up, but canvas row 0 is the image *top*, which `flipY` maps to `uv.y = 1`, which `SphereGeometry` puts at the **north** pole - so the rasteriser walks the grid backwards. Mirroring parks the northern oval over Antarctica, plausible enough to survive a casual glance. Verified against the geometry: lat +90 → `v` 1.000. |
| **Aurora** terminator in the wrong place | Derived from an absolute instant (`Date.now()` → Julian days), never `getHours()`. Local time rotates the terminator by the viewer's UTC offset - up to 210° - and looks fine to anyone testing in UTC+0. Verified against the solstices (±23.44°) and the equation of time. |
| **Aurora** night side crushes to black | The `onBeforeCompile` patch goes after `<opaque_fragment>` (linear), not after `<dithering_fragment>` (already sRGB-encoded). |
| **Aurora** flicker when switching modes | One persistent `<Canvas>`; mode is derived and the crossfade runs through a ref, so nothing above the canvas changes. |
| **Aurora** camera flies to the quiet pole | The poleward ease is **deferred until the grid is live**, then aimed at the stronger hemisphere. Aiming on the press uses the default hemisphere, and a corrective second ease cannot work - by then the camera is already poleward and the "leave the user alone" guard declines it. |
| **Aurora** wind particles still costing frames | Two levels: `WindParticles` returns from `useFrame` before any advection once faded, and `App.jsx` then unmounts it entirely. |
| **Aurora** frame hitch on the 924 KB parse | Fetch, parse and rasterise all happen in effects keyed to the data. Nothing touches the network or the grid inside `useFrame`. |
| **Aurora** mode and chips disagree | Mode is derived from `activeLayers`, not stored beside it. |

## Notes

- The JS bundle is ~1.1 MB (~300 KB gzipped), almost entirely Three.js. Fine for
  a static portfolio piece; code-split if that stops being true.
- The Earth texture is NASA Blue Marble at 4096×2048 (~1.4 MB), the heaviest
  asset and the only thing loaded from a CDN at runtime. The 93 KB `earth-dark.jpg`
  alternative is lighter but renders as near-black landmasses that are illegible
  on a dark background; readability won.
- The atmosphere glow is a Fresnel shader on a back-faced shell. A
  uniform-opacity shell renders as a flat disc with a hard edge, which reads as a
  grey ring around the planet.
- Out of scope: routing, backend, login, analytics.
