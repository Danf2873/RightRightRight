# Right Right Right — module contracts

Browser rally game. Plain ES modules, **no build step, no npm deps in the game**. Three.js is loaded
through an importmap in `index.html`:

```json
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
} }
```

Every module imports Three as `import * as THREE from 'three';`. Do not import from any other URL.

## Global conventions

- Units: meters, seconds, kilograms, radians. Speeds in m/s internally (HUD converts).
- World axes: **Y up**. Right-handed (Three default).
- **Car local frame: forward = -Z, right = +X, up = +Y** (same as a Three camera).
- Signed curvature / steering: **positive = turning RIGHT**.
- Physics runs at a fixed **120 Hz** step (`dt = 1/120`). Rendering is separate; never assume dt.
- Hot paths (anything called per physics step) must not allocate: reuse scratch vectors/objects.
- Low-poly look: `flatShading: true`, `MeshLambertMaterial` / `MeshStandardMaterial`, low segment
  counts, vertex colors where handy. Target 60 fps on a mid laptop at `quality: 'medium'`.
- Quality level string: `'low' | 'medium' | 'high'`.

## Surfaces (shared enum, string ids)

`'tarmac' | 'wet' | 'gravel' | 'dirt' | 'sand' | 'snow' | 'ice' | 'mud' | 'grass' | 'ash'`

`tires.js` owns the grip numbers for these. `track.js` owns which surface is where. Off-road ground
returns the biome's off-road surface (usually `'grass'`, `'sand'` in desert, `'snow'` in snow
biomes, `'ash'` on the volcano, etc.).

---

## stages.js  (owner: world worker)

```js
export const STAGES = [ StageDef, ... ];   // exactly 12, in menu order
```

`StageDef` (the fields consumers rely on — add more private fields freely):

```js
{
  id: 'pine-valley',            // url/storage-safe slug, unique
  name: 'Pine Valley',
  region: 'Finland',            // flavour text
  description: 'Fast forest gravel with blind crests.',
  seed: 1234,                   // deterministic generation
  weather: 'clear' | 'fog' | 'rain' | 'snow' | 'storm' | 'dust' | 'ash',
  timeOfDay: 'day' | 'dawn' | 'dusk' | 'night',
  biome: 'forest' | 'coast' | 'alpine' | 'desert' | 'ice' | 'mud' | 'snowforest'
       | 'vineyard' | 'canyon' | 'highland' | 'volcanic' | 'mixed',
  difficulty: 1..5,
  // everything else (control points, surface zones, set pieces) is private to world worker
}
```

## track.js  (owner: world worker)

```js
export function buildTrack(stageDef, scene, quality) -> Track
```

Builds terrain, road ribbon, scenery, start/finish gates and split banners, adds them to `scene`,
returns:

```js
Track {
  def,                     // the StageDef
  step,                    // spacing of samples in meters (2)
  samples,                 // Array<Sample>, centerline every `step` meters, index i at dist i*step
  length,                  // total centerline length (m)
  startDist,               // dist of start line (car spawns here)
  finishDist,              // dist of finish line
  splits,                  // [d1, d2, d3] split distances, ascending, between start and finish
  features,                // Array<{ dist, type, len? }>, type in:
                           //  'jump' | 'crest' | 'water' | 'bridge' | 'narrows' | 'bump' | 'caution'
  startPos,                // THREE.Vector3 on the road surface at startDist
  startDir,                // THREE.Vector3 unit, horizontal, direction of travel at startDist
  offroadSurface,          // surface id for off-road ground

  groundAt(x, z, cache, out) -> out
     // physics query, called 4x per step. MUST be fast and allocation-free.
     // cache: a plain object the caller owns per wheel (track may store e.g. cache.i = last index)
     // out:   caller-owned object; fill and return:
     //   out.height  (number, ground Y at x,z — road or terrain, whichever is the surface there)
     //   out.nx, out.ny, out.nz  (unit ground normal)
     //   out.surface (surface id)
     //   out.onRoad  (bool)
     //   out.water   (0..1 depth factor, 0 = dry; for splashes/drag)

  project(x, z, cache, out) -> out
     // nearest centerline point. Fills out.dist (m along track), out.lateral (m, + = right of
     // centerline), out.index (sample index), out.width (road width there). Allocation-free.

  sampleAt(dist, out) -> out
     // interpolated centerline point at dist: out.pos (Vector3), out.dir (Vector3 unit tangent),
     // out.right (Vector3 unit), out.width, out.surface, out.curvature. `out` is caller-owned;
     // if out.pos/dir/right are missing create them once.

  collidersNear(x, z, radius) -> Array<Collider>
     // static solid scenery near a point: { x, z, r, kind } circles ('tree','rock','post',
     // 'wall','house','barrier'). Spatial-hashed. May return a shared array (do not keep it).

  update(dt, camera)       // per-frame cosmetic stuff (optional animation, LOD); may be no-op
  dispose()                // remove from scene, free geometry/materials
}

Sample {
  x, y, z,                 // centerline road surface position
  dist,                    // i * step
  dirX, dirZ,              // unit horizontal tangent
  curvature,               // signed 1/m, + = turning right, smoothed
  width,                   // road width (m), typically 6–9
  surface,                 // road surface id at this point
  bank,                    // camber angle (rad), small
}
```

Road is a heightfield-conforming ribbon; jumps/crests come from the elevation profile so a car
going fast genuinely leaves the ground. Terrain must exist at least ~150 m either side of the road;
beyond that the world may end (main.js resets the car if |lateral| > 80).

## tires.js  (owner: physics worker)

```js
export const SURFACES = {           // per surface id
  tarmac: { grip, rolling, dust:  boolean|color, color, ... }, ...
};
export function tireForces(slipRatio, slipAngle, load, surfaceId, out) -> out // out.fx, out.fy
```

## vehicle.js  (owner: physics worker)

```js
export class Vehicle {
  constructor(scene, opts = { color: 0xd8262b, quality: 'medium' })
  mesh                         // THREE.Group (low-poly rally car + 4 wheel meshes)
  reset(pos, dir)              // place on ground at pos (Vector3) facing dir (unit Vector3), zero velocity
  update(dt, input, track)     // ONE fixed physics step. Reads track.groundAt and
                               // track.collidersNear. input is an InputState (see input.js).
  syncVisuals()                // copy physics state to mesh + wheels (spin, steer, suspension travel)
  setLights(on)                // headlights + tail lights (night stages)
  setManualGearbox(bool)

  // read-only state for HUD / audio / camera / main:
  position                     // THREE.Vector3 (center of mass)
  quaternion                   // THREE.Quaternion
  velocity                     // THREE.Vector3 world m/s
  angularVelocity              // THREE.Vector3 world rad/s
  speed                        // signed forward speed m/s
  rpm, maxRpm, gear            // gear: -1 reverse, 0 neutral, 1..6
  throttle                     // applied 0..1 (after traction/rev limiter)
  damage                       // 0..1 overall
  airborne                     // true if no wheel touching
  upsideDown                   // true if roof is pointing down for >1s
  wheels                       // [FL, FR, RL, RR] each { contact, surface, slipRatio, slipAngle,
                               //   load, compression, water }
  onImpact                     // assignable callback(strengthMetersPerSec, kind) — main uses it for
                               // penalties, audio, rumble
}
```

## input.js  (owner: ui worker)

```js
export class Input {
  constructor(settings)        // settings = the `input` sub-object of global settings (mutable)
  update(dt, speedMs) -> InputState     // poll keyboard + gamepads, call once per frame
  rumble(strong, weak, ms)     // gamepad vibration if supported
  renderSettings(container)    // builds the input settings UI (device, mapping, calibration,
                               // deadzone, sensitivity, steering linearity, wheel rotation) into
                               // `container`; writes into the settings object and calls
                               // settings.onChange?.()
  get activeDevice()           // 'keyboard' | 'gamepad' | 'wheel'
}
InputState {
  steer,        // -1..1, + = right
  throttle,     // 0..1
  brake,        // 0..1
  handbrake,    // 0..1
  // edge-triggered booleans (true for exactly one update after press):
  shiftUp, shiftDown, reset, restart, camera, pause, repeatNote, confirm, back,
  device        // 'keyboard' | 'gamepad' | 'wheel'
}
```

Default keyboard: arrows / WASD steer+throttle+brake, Space handbrake, E/Q shift up/down, C camera,
Backspace reset to road, R restart stage, Esc/P pause, N repeat pace note, Enter confirm.
Gamepad (standard mapping): left stick steer, RT throttle, LT brake, A/X handbrake, RB/LB shift,
Y camera, B back / reset (hold), Start pause, Select repeat note.
Wheel: any non-"standard" gamepad (or one whose id matches /wheel|g29|g920|g923|t300|t150|tmx|
fanatec|csl|moza|simucube|logitech.*racing|thrustmaster/i) → mapping table with axis index,
inversion and range per control (steer, throttle, brake, clutch-as-handbrake optional), buttons for
shift/handbrake. Calibration screen lets the user press/turn each control to bind it.

## hud.js  (owner: ui worker)

```js
export class HUD {
  constructor(root)            // root = #hud element; builds its own DOM, styles live in css/hud.css
  show(); hide()
  setTrack(track)              // prepares minimap from track.samples
  update(state)                // per frame, state = {
                               //   speedMs, rpm, maxRpm, gear, timeMs, penaltyMs, damage,
                               //   dist, startDist, finishDist, carX, carZ, carHeading,
                               //   ghostX?, ghostZ?, upcoming: Note[], wrongWay, units:'kmh'|'mph'}
  showCall(note)               // flash the codriver call text/icons
  showSplit(index, timeMs, deltaMs|null)   // delta vs best (negative = faster, green)
  message(text, ms = 1500)     // big centered message ('3','2','1','GO!','FINISH', 'PENALTY +5s')
}
```

## weather.js  (owner: ui worker)

```js
export function createEnvironment(scene, renderer, stageDef, quality) -> Environment
Environment {
  sun,                         // THREE.DirectionalLight (main uses it for shadow follow)
  update(dt, camera, carPos)   // particles (rain/snow/dust/ash) follow camera, shadow camera
                               //   follows carPos, wind gusts
  isNight                      // bool → main turns on headlights
  dispose()
}
```
Sets `scene.background`, `scene.fog` (density by weather), hemisphere + sun lights by timeOfDay.

## pacenotes.js  (owner: codriver worker)

```js
export function generateNotes(track, verbosity = 'all') -> Note[]
Note {
  dist,              // where the thing starts (m along track)
  kind,              // 'corner' | 'straight' | 'feature' | 'surface' | 'finish' | 'start'
  dir,               // 'left' | 'right' | null
  severity,          // 1..6 (1 = slowest/tightest, 6 = flat-out kink) or 'hairpin' | 'square' | null
  mods,              // array of strings: 'long','tightens','opens','dont-cut','over-crest',
                     //   'jump','caution','narrows','bump','water','into','keep-in','keep-out'
  distanceToNext,    // e.g. 100 / 150 / 200 for the call "100", or null when 'into'
  text,              // full spoken text, e.g. "left 4 tightens into right 2 don't cut"
  icons,             // array of short tokens for HUD icons, e.g. ['L4','tightens','into','R2']
}
export class Codriver {
  constructor(notes, settings) // settings = global settings.codriver (enabled, verbosity,
                               //   leadSeconds, voiceURI, rate, volume, mode:'voice'|'text')
  reset()
  update(dist, speedMs)        // call each frame; speaks notes leadSeconds ahead, chaining
  onCall                       // assignable callback(note) when a note is read
  upcoming(dist, n) -> Note[]  // next n notes after dist (for HUD ribbon)
  repeatLast()
  say(text)                    // speak arbitrary text (countdown "3 2 1 go", "finish")
  stop()
  static voices() -> SpeechSynthesisVoice[]
}
```

## audio.js  (owner: codriver worker)

```js
export class AudioEngine {
  constructor(settings)        // settings = global settings.audio {master, engine, fx}
  resume()                     // call on first user gesture
  update(dt, vehicle)          // engine tone from vehicle.rpm/throttle/gear, tire skid from wheels
                               //   slip, gravel/surface rumble, wind from speed, water splash
  impact(strength)             // crash sound
  beep(kind)                   // 'countdown' | 'go' | 'split' | 'finish' | 'ui'
  setPaused(bool)
}
```
All sounds are synthesized with WebAudio (no audio files).

## storage.js, main.js, index.html, css/style.css  (owner: boss)

Global settings object (persisted in localStorage `rrr.settings`):

```js
{
  input:    { ...owned by input.js, any shape },
  codriver: { enabled: true, verbosity: 'all', leadSeconds: 5, voiceURI: '', rate: 1.1,
              volume: 1, mode: 'voice' },
  audio:    { master: 0.8, engine: 0.7, fx: 0.8 },
  graphics: { quality: 'medium' },
  units: 'kmh',
  gearbox: 'auto',
}
```

DOM provided by index.html: `<canvas id="game">`, `<div id="hud">`, `<div id="menu">` (boss).
