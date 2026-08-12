# PROJECT ATMOS — Phase 2 Build Prompt (Aurora / Dark Mode)

Paste this into Claude Code **after** Phase 1 (the wind globe) is working.
This extends the existing React/Vite/`@react-three/fiber` project — same
repo, same component structure, do not rewrite what already works.

---

## Goal

Add a mode toggle to the existing globe: **Wind** (already built) and
**Aurora** (new) — dark Earth with a live auroral-oval glow near the poles,
driven by real NOAA space-weather data, plus a day/night terminator shader.
Same zero-cost, no-key, no-backend constraint as Phase 1.

## What NOT to do

- Do not remount or recreate the `<Canvas>` when switching modes — that
  causes a visible flicker/reset. Keep one persistent Canvas; toggle
  materials, textures, and layer visibility inside it.
- Do not throw away `WindParticles.jsx` or `useWindData.js` — aurora mode
  fades wind particles out, it doesn't replace the wind system.

## Data source — NOAA SWPC OVATION Aurora (confirmed free, no key)

- Endpoint: `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json`
- Public NOAA data service, updated roughly every 5 minutes with the
  intensity/location of the aurora for the next ~30–90 minutes.
- Format: JSON object with a `"Forecast Time"` string (UTC) and a
  `"coordinates"` array of flat `[longitude, latitude, probability]` triples
  — `longitude` 0–359°, `latitude` −90–90°, `probability` 0–100 (% chance of
  visible aurora at that point).
- **Verify CORS before wiring it in** — SWPC is a public government data
  service and is commonly consumed client-side, but confirm the response
  actually carries `access-control-allow-origin` from this specific endpoint
  in a real browser fetch before relying on it; if it's blocked, fall back to
  a small procedural aurora oval (a fixed-shape ring around each magnetic
  pole) so the mode still works.
- The payload is large (roughly 800KB–1MB as a flat numeric array). Fetch it
  once, refetch on a **5-minute interval** matching the model's real update
  cadence — no faster, and never inside `useFrame`.
- Build `hooks/useAuroraData.js` mirroring the structure of the existing
  `useWindData.js` (fetch, cache, interval refetch, cleanup on unmount,
  `AbortController` guard for StrictMode's double-invoke in dev).

### Turning the grid into a visual (`utils/auroraGrid.js`)

- Don't render 65,000 individual points — that's the wrong tool for a dense
  probability grid. Instead, **rasterize the grid into a `<canvas>` texture**:
  a 360×181 (or downsampled, see mobile note below) canvas where each pixel's
  brightness/alpha comes from the probability value at that lon/lat.
- Apply that canvas as a `THREE.CanvasTexture` on a second, slightly larger
  sphere layered over the globe, with additive blending and a green/teal glow
  color, so it reads as a soft auroral band rather than a hard-edged overlay.
- The data is one global grid but the aurora only ever appears in bands near
  the poles — no special masking needed, the probability values themselves
  are already ~0 away from the auroral zone.

## Day/night terminator

- Compute the **subsolar point** (the lat/lon where the sun is directly
  overhead) from the current UTC time using a standard simplified solar
  position formula. **Use `Date` UTC methods (`getUTCHours`, etc.), not local
  time** — using local time is the most common bug here and silently puts the
  terminator in the wrong place for anyone not in UTC+0.
- Pass the subsolar direction as a uniform into a custom `ShaderMaterial` (or
  extend the existing globe material) on the Earth sphere: dot product of the
  surface normal and sun direction darkens the night-side hemisphere with a
  soft gradient at the terminator line, not a hard edge.
- In Aurora mode: dim the day-side lighting overall (this is meant to read as
  "dark Earth," not "daytime Earth with a glow added on top") and increase
  contrast so the aurora overlay reads clearly against it.

## Mode toggle & transition

- `App.jsx`: add a `mode` state (`'wind' | 'aurora'`), lifted above the
  Canvas, passed down to the components that need it.
- `HUD.jsx`: add the visible toggle control (a simple switch, not a full
  settings panel — keep the HUD as minimal as Phase 1).
- Transition on toggle, over ~1–2 seconds, driven inside `useFrame` (lerp,
  not CSS, since it's crossing 3D material/lighting properties):
  - Wind particles: fade opacity to 0, pause spawning (don't just hide —
    stop the simulation so it's not burning frames on an invisible layer).
  - Globe material: crossfade lighting intensity down, terminator shader
    fades in.
  - Aurora texture layer: fade opacity to 1.
  - Camera: if currently looking at the equator, ease toward a higher-latitude
    view so the aurora oval is actually visible without the user having to
    manually rotate the globe — don't leave them staring at an equatorial
    view with an aurora happening off-screen near the pole.
- Reverse the same transition going back to Wind mode, resuming particle
  spawning.

## Known bugs to pre-empt

| Issue | Fix |
|---|---|
| Terminator line in the wrong place | Use UTC time for subsolar calculation, never local time |
| Flicker/reset when switching modes | One persistent `<Canvas>`; toggle materials/visibility, never remount it |
| Aurora fetch blocked by CORS | Verify the endpoint's CORS headers in a real browser test first; procedural fallback oval if blocked |
| Hammering NOAA's endpoint | Interval refetch at 5 minutes, matching real model cadence, never per-frame or per-toggle |
| Toggling to aurora mode shows nothing interesting | Ease the camera toward a poleward view on transition, don't leave it equator-centered |
| Wind particles still consuming frame budget while hidden in aurora mode | Actually pause the simulation (stop updating positions), don't just set opacity to 0 |
| Aurora texture too heavy on low-end devices | In the adaptive-quality path already built in Phase 1, downsample the probability grid (e.g. every 2nd or 4th point) before rasterizing to canvas when reduced-quality mode is active |
| Large JSON parse causing a frame hitch | Fetch and parse happens once per 5-minute interval outside the render loop — confirm it's not accidentally triggered inside `useFrame` or on every re-render |

## File additions (extends Phase 1 structure — don't rename existing files)

```
src/
  components/
    AuroraLayer.jsx      (new — canvas-texture glow sphere)
    ModeToggle.jsx        (new — HUD switch control)
  hooks/
    useAuroraData.js       (new — fetch/cache/interval, mirrors useWindData.js)
    useSunPosition.js       (new — subsolar point from UTC time)
  utils/
    auroraGrid.js            (new — grid → canvas texture rasterization)
```

`Globe.jsx`, `WindParticles.jsx`, `HUD.jsx`, `App.jsx` are **modified**, not
replaced — extend their existing props/state rather than restructuring them.

## Deliverable for this phase

Working mode toggle in the existing app: Wind mode behaves exactly as in
Phase 1, Aurora mode shows a dark Earth with a live NOAA-driven auroral glow
and a correct day/night terminator, with a smooth crossfade between the two.
Update `README.md`'s known-bug table to include the Phase 2 entries above.
