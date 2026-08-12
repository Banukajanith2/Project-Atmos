# PROJECT ATMOS — Phase 1 Build Prompt (Weather/Wind Globe, React)

Paste everything below into Claude Code as the initial project prompt.

---

## Goal

Build "Project Atmos" — a real-time 3D Earth in the browser showing live wind
flow as animated particle streaks across the globe surface (visual reference:
earth.nullschool.net, simplified). Portfolio piece. Zero cost to run, no API
keys, no backend server.

## Stack (fixed — do not substitute)

- **React + Vite** (not Next.js — no routing/SSR/backend needed, Vite is the
  lightest bundler that still gives a normal React dev experience).
- **@react-three/fiber** for the Three.js scene, **@react-three/drei** for
  `OrbitControls` and helpers.
- Plain `fetch` for data — no data-fetching library needed for one endpoint.
- Deploy target: any static host (Vercel/Netlify free tier) — build output is
  static files, no server runtime required.

## File structure

```
/project-atmos
  package.json
  vite.config.js
  index.html
  src/
    main.jsx
    App.jsx
    styles.css
    components/
      Globe.jsx          (sphere + Earth texture)
      WindParticles.jsx   (the particle flow system)
      HUD.jsx             (status/legend/timestamp overlay, plain DOM not R3F)
    hooks/
      useWindData.js      (fetch + cache + refetch interval)
    utils/
      windField.js        (grid → interpolation helpers)
  README.md
```

## Data source — Open-Meteo (confirmed free, no key, no signup)

Open-Meteo's forecast API is **per-point**, not a pre-built global wind grid —
build the grid yourself, don't look for a "whole world" endpoint that doesn't
exist.

- Endpoint: `https://api.open-meteo.com/v1/forecast`
- Batch coordinates in **one request** via comma-separated `latitude=` /
  `longitude=` lists (confirmed: up to 1000 locations per call, free tier
  10,000 calls/day, non-commercial, no key required).
- Params: `current=wind_speed_10m,wind_direction_10m`
- Grid: 10° spacing, latitude −80 to 80, longitude −180 to 170 (~612 points —
  under the 1000 cap in a single fetch). Skip poles; direction is degenerate
  there.
- `useWindData.js`: fetch once on mount, cache in state, refetch every
  30–60 min via `setInterval`, clean up the interval on unmount. Never fetch
  per animation frame.
- **React 18 StrictMode note**: dev mode double-invokes effects, which will
  look like a duplicate fetch in the console during development — that's
  expected StrictMode behavior, not a bug. Guard with an `AbortController` or
  a ref-based "already fetching" flag so it doesn't double-hit the API even
  in dev.

### Vector field math (`utils/windField.js`)

- Convert `wind_speed_10m` (km/h) + `wind_direction_10m` (meteorological
  convention — direction wind is **coming from**) to a 2D vector per point.
- **Bilinear interpolation** between the 4 nearest grid points for any
  queried lat/lon — raw nearest-neighbor looks blocky and robotic.
- **Antimeridian wrap**: treat longitude as circular at the 180°/−180°
  boundary, not linear, when finding neighbors.
- **Pole exclusion**: never sample above ±80° latitude; fade particles out
  before that band instead of letting the field blow up.

## `WindParticles.jsx` — the signature visual, and the main R3F performance trap

- ~2000–4000 particles on desktop as a single `THREE.Points` object with a
  `BufferGeometry` — **not** 2000 individual React-managed meshes.
- **Do not drive per-frame position updates through React state.** Mutate the
  `BufferAttribute` array directly inside `useFrame` and set
  `attribute.needsUpdate = true`. Storing particle positions in `useState`
  and re-rendering every frame will tank performance — this is the single
  most common mistake in R3F particle systems.
- Each particle: age/lifetime, respawn on death weighted toward higher-speed
  regions, fade opacity in/out over its lifetime so streaks don't pop.
- Color/speed mapping matches the HUD legend (see palette below).

## `Globe.jsx`

- `<mesh>` + `sphereGeometry` + texture loaded via `useLoader(TextureLoader, url)`
  wrapped in `<Suspense fallback={...}>` in `App.jsx` — R3F's `useLoader`
  suspends, and forgetting the `Suspense` boundary silently blanks the whole
  canvas with no error.
- Pick a texture CDN URL and **verify it actually returns the image with an
  `access-control-allow-origin` header** before wiring it in (e.g. unpkg or
  jsdelivr serving three.js's example textures) — don't assume a path
  resolves.
- If the texture fails, fall back to a flat dark-blue `meshStandardMaterial`
  rather than an invisible/broken sphere.
- `OrbitControls` from drei: `enableDamping`, `makeDefault`, zoom distance
  clamped (`minDistance`/`maxDistance`) so users can't clip through the globe
  or zoom out to nothing. Slow auto-rotate when idle.

## Adaptive quality (desktop-first, graceful on mobile)

- On mount, capability-check: `navigator.deviceMemory` where available, plus
  a fallback render-time probe (iOS Safari doesn't reliably expose
  `deviceMemory`, so don't rely on it alone).
- Below threshold: drop particle count to ~500–800, cap `<Canvas dpr={[1, 1.5]}>`
  instead of letting it default to full device pixel ratio, skip any
  post-processing you add later (bloom, etc.).
- Show a "reduced quality mode" notice in the HUD when this triggers — stated
  fallback, not silent degradation.
- **Capability-check only, never brand-check.** "If iOS, assume it's fine" is
  wrong — an older iPhone under Safari's memory-pressure tab eviction can
  still choke on a heavy scene.

## Known bugs to pre-empt (implement the fix up front)

| Issue | Fix |
|---|---|
| Blank canvas, no error | Missing `<Suspense>` around `useLoader` — always wrap it |
| Texture CORS failure | Verified CORS-safe CDN URL; `crossOrigin` handled by loader; dark-material fallback on error |
| Particle animation janky/slow | Mutate `BufferAttribute` in `useFrame`, never store per-frame positions in React state |
| Duplicate fetch warning in dev console | Expected StrictMode double-invoke — guard with `AbortController`, not a real bug |
| Blocky/robotic wind motion | Bilinear interpolation, never nearest-neighbor |
| Particles break near poles / at antimeridian | Hard pole exclusion (±80°) + circular longitude interpolation |
| Open-Meteo fetch fails (network/rate limit) | try/catch with a small hardcoded synthetic wind-field fallback so the globe is never empty; surface the error in the HUD, don't fail silently |
| iOS Safari kills tab under memory pressure | Adaptive quality by capability probe, not device brand |
| Canvas/controls jump on window resize | R3F's `<Canvas>` handles resize automatically — verify you're not also manually setting renderer size anywhere, which fights it |
| Hammering the API every frame | Fetch once + interval refetch in `useWindData`, never inside `useFrame` |

## Design tokens (carry through into `styles.css` / HUD, don't default to templated AI styling)

- Background: near-black `#05070c`; panel backing `#0b1220`; hairline dividers `#1c2740`
- Text: primary `#e9edf5`, secondary `#7d8ba3`
- Signature accent (wind mode): cyan `#5fd0ff`
- Type: a geometric display face for HUD labels (e.g. Space Grotesk), Inter for body, a monospace face (e.g. IBM Plex Mono) for coordinates/telemetry-style numbers — avoid the generic warm-cream/serif template look.
- HUD is plain DOM overlay (`HUD.jsx`, not inside the R3F `<Canvas>`), positioned fixed above the canvas, `pointer-events: none` except on interactive elements.

## Explicitly out of scope for this prompt

- No aurora layer, no dark-mode toggle, no NOAA aurora data — Phase 2, as a
  separate follow-up prompt once this is working.
- No routing, no backend, no login, no analytics.

## Deliverable for this phase

A working Vite + React app (`npm install && npm run dev`) implementing the
structure above, plus a `README.md` covering: setup/run/build commands, and
the known-bug table so the reasoning behind each fix isn't lost later.
