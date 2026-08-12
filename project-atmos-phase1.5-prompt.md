# PROJECT ATMOS — Phase 1.5 Build Prompt (City Search + Full Weather Layers + Filters)

Paste this into Claude Code **after** Phase 1 (wind globe) is working, and
**before** Phase 2 (aurora). Same repo, same React/Vite/`@react-three/fiber`
project — extend existing files, don't restructure them.

---

## Goal

1. A search box: type a city, hit enter, the globe auto-rotates and zooms to
   that location, drops a marker, and shows live weather for that exact spot.
2. Filter toggles to switch which global weather layer is showing (wind /
   rain / thunderstorms / clear-sunny / cloud cover), each with its own
   distinct motion style — not just a recolored version of the wind particles.

## Scope call to make explicit up front

"Show that city outline" is ambiguous — a true administrative-boundary
polygon (city limits) requires a separate boundary dataset (e.g. Natural
Earth or OSM boundary geometry) that isn't part of the weather API at all.
**Build a locator reticle/pin with the city name and country label instead**
(an animated ring or crosshair at the exact coordinate) — this is the
practical, free, low-complexity version and reads just as well visually.
Real polygon boundaries are a valid future enhancement but out of scope here
to keep this phase tight.

## 1. City search

### Data source
- Open-Meteo Geocoding API (free, no key, same provider you're already
  using): `https://geocoding-api.open-meteo.com/v1/search?name=QUERY&count=5`
- Returns candidate matches with `latitude`, `longitude`, `name`, `country`,
  `admin1` (state/region), `population`.

### Build
- `hooks/useCitySearch.js` — debounce the input (~300ms), fetch on each
  debounced keystroke, cache the last query to avoid duplicate calls.
- `components/SearchBar.jsx` — text input in the HUD + a dropdown of up to 5
  matches. **Always show country/region in the dropdown row**, not just the
  city name — "Springfield" alone is ambiguous across a dozen countries, and
  picking the wrong one silently is worse than making the user disambiguate.
- On selecting a result (click or Enter with one result highlighted):
  trigger the camera flight + marker + weather fetch below.

### Camera flight (`utils/cameraFlight.js`)
- Animate the camera from its current position to the target lat/lon over
  ~1.5–2.5 seconds, easing in/out, ending zoomed in enough to see the marker
  clearly but not so close the texture looks blurry (2K equirectangular
  texture has a real resolution ceiling — clamp max zoom so it never crosses
  into visibly pixelated).
- **Interpolate along the sphere surface (spherical/great-circle
  interpolation), not a naive straight lerp between two lat/lon-derived
  points.** A linear lerp can cut through the globe's interior or swing the
  camera the "long way around" when the two points straddle the antimeridian
  — use quaternion slerp or equivalent so the camera arcs smoothly over the
  surface.
- Auto-rotation (already in Phase 1's `OrbitControls` idle state) should
  pause during the flight and resume afterward, not fight the animation.

### City marker (`components/CityMarker.jsx`)
- Pin/reticle at the exact coordinate, animated (pulse or expanding ring),
  with a label showing city name + country.
- Weather badge attached to the marker showing the **exact-point** weather
  for that city (see fetch note below) — temperature, condition, wind speed.

### Precise weather for the searched city
- The global wind grid (Phase 1) is 10° spacing for performance — too coarse
  to be "this city's weather." When a city is selected, fire a **separate,
  single-point** request: `https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover`
- Treat this as a distinct, higher-fidelity data source from the ambient grid
  — don't try to reconcile it with the coarse grid's interpolated value at
  that point, they're allowed to differ slightly (one is a real
  reading/nowcast for that spot, the other is a smoothed global field). If
  you want to avoid user confusion, label the marker badge clearly (e.g.
  "current conditions") rather than implying it's the same data as the
  ambient layer.

## 2. Full weather layers + filters

### Data — extend the existing grid fetch, don't add a new endpoint
- Add to the same batched Open-Meteo grid call already built in Phase 1:
  `current=wind_speed_10m,wind_direction_10m,weather_code,precipitation,cloud_cover,temperature_2m`
  — same request, same 612-point grid, same 10°/30–60min cadence. Zero extra
  API cost.

### WMO weather code buckets (`utils/weatherCodes.js`)
Open-Meteo returns a WMO code per point. Bucket into your filter categories —
get this mapping right, it's a common source of misclassified conditions:
- **Clear/sunny**: 0, 1
- **Cloudy**: 2, 3
- **Fog**: 45, 48
- **Rain**: 51–55 (drizzle), 61–65 (rain), 66–67 (freezing rain), 80–82 (showers)
- **Snow**: 71–75, 77, 85–86
- **Thunderstorm**: 95, 96, 99

### Layers — each needs a genuinely different motion, not a recolor
- **Wind** (already built, Phase 1): directional dot-trail particles flowing
  along the interpolated vector field.
- **Rain**: denser, faster, near-vertical falling streaks at grid points
  bucketed as rain/drizzle — different particle geometry/motion from wind,
  it should read as "falling" not "flowing."
- **Thunderstorm**: rain layer's motion, plus intermittent flash/pulse
  markers at thunderstorm-flagged points (brief brightness spike, randomized
  timing per point so they don't all flash in sync).
- **Snow**: slower-falling, more scattered/drifting motion than rain — not
  just rain particles recolored white.
- **Clear/sunny**: no particles — a soft warm rim-light/glow boost on the
  globe surface at those grid regions instead, so "clear" reads as an
  absence-of-weather state rather than an empty gap.
- **Cloud cover**: a semi-transparent white texture layer blended over the
  base Earth texture, opacity driven by the `cloud_cover` percentage per
  grid cell — static-ish (slow drift at most), since clouds are a coverage
  state, not a particle phenomenon.

### Filters UI (`components/FilterPanel.jsx`)
- Toggle buttons in the HUD: Wind / Rain / Thunderstorms / Snow / Clear /
  Clouds. Multiple can be active at once (e.g. Wind + Rain together is a
  normal real-world combination), but **cap how many are simultaneously
  active** (recommend max 2–3) — stacking all six is guaranteed visual noise
  on a single globe, not a useful state.
- Reuse the adaptive-quality gate from Phase 1: on the reduced-quality path,
  cap to a single active layer at a time regardless of what the user taps,
  and say so in the HUD (small note, not a blocking error).

## Known bugs to pre-empt

| Issue | Fix |
|---|---|
| Camera flies through the globe or the "long way around" on antimeridian-crossing searches | Spherical/quaternion interpolation for camera flight, never a naive lat/lon lerp |
| Zoomed-in city view looks blurry/pixelated | Clamp max zoom distance to the texture's real resolution ceiling, don't let users zoom past it |
| Ambiguous city names return the wrong location silently | Always show country/admin1 in the search dropdown, require explicit selection when count > 1 |
| Geocoding API hit on every keystroke | Debounce (~300ms) in `useCitySearch.js` |
| City marker weather doesn't match the ambient grid at that point | Expected — they're different-fidelity sources; label the marker clearly rather than trying to reconcile them |
| Misclassified weather condition (e.g. drizzle shown as thunderstorm) | Use the exact WMO bucket ranges above, don't guess at code meanings |
| All filters on at once turns into visual noise | Cap simultaneous active layers (2–3 max); enforce single-layer cap in reduced-quality mode |
| Frame drops with multiple particle layers active | Each layer should pause its own simulation when toggled off, not just hide — mirrors the pause-when-hidden fix from the Phase 2 aurora prompt |
| Auto-rotate fighting the search camera-flight animation | Explicitly pause `OrbitControls` auto-rotate during flight, resume after |

## File additions (extends Phase 1 — don't rename existing files)

```
src/
  components/
    SearchBar.jsx        (new)
    CityMarker.jsx         (new)
    FilterPanel.jsx          (new)
    RainLayer.jsx              (new)
    ThunderLayer.jsx             (new)
    SnowLayer.jsx                  (new)
    CloudLayer.jsx                   (new)
    SunnyGlow.jsx                      (new)
  hooks/
    useCitySearch.js       (new)
    useCityWeather.js         (new — single-point precise fetch)
  utils/
    cameraFlight.js       (new)
    weatherCodes.js          (new)
```

`Globe.jsx`, `WindParticles.jsx`, `useWindData.js`, `HUD.jsx`, `App.jsx` are
**modified** to add the grid fields, filter state, and layer composition —
not replaced.

## Deliverable for this phase

Working search-to-zoom flow with a labeled city marker and precise local
weather, plus toggleable global weather layers (wind/rain/thunder/snow/clear/
clouds) each with distinct motion, respecting the existing adaptive-quality
system. Update `README.md`'s known-bug table with the entries above.
