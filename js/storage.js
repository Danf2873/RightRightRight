// Persistence: settings, best times, ghosts. Every access is guarded: storage can be
// unavailable (private mode, blocked site data) and the game must still run.

const SETTINGS_KEY = 'rrr.settings';
const BEST_KEY = 'rrr.best';
const GHOST_PREFIX = 'rrr.ghost.';

export const DEFAULT_SETTINGS = {
  input: {},
  codriver: { enabled: true, verbosity: 'all', leadSeconds: 5, voiceURI: '', rate: 1.1, volume: 1, mode: 'voice' },
  audio: { master: 0.8, engine: 0.7, fx: 0.8 },
  graphics: { quality: 'medium' },
  units: 'kmh',
  gearbox: 'auto',
  camera: 0,
};

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function merge(defaults, saved) {
  const out = { ...defaults };
  if (!saved || typeof saved !== 'object') return out;
  for (const k of Object.keys(saved)) {
    const d = defaults[k];
    out[k] = d && typeof d === 'object' && !Array.isArray(d) ? { ...d, ...saved[k] } : saved[k];
  }
  return out;
}

export function loadSettings() {
  return merge(structuredClone(DEFAULT_SETTINGS), read(SETTINGS_KEY));
}

export function saveSettings(settings) {
  // onChange callbacks live on sub-objects; JSON.stringify drops functions.
  write(SETTINGS_KEY, settings);
}

// Best results: { [stageId]: { timeMs, splits: [ms...], date } }
export function loadBest() {
  return read(BEST_KEY) || {};
}

export function saveBest(stageId, timeMs, splits) {
  const all = loadBest();
  const prev = all[stageId];
  if (prev && prev.timeMs <= timeMs) return false;
  all[stageId] = { timeMs, splits, date: Date.now() };
  write(BEST_KEY, all);
  return true;
}

// Ghosts are stored quantized: positions in cm, quaternions x1000, one frame every GHOST_DT.
export const GHOST_DT = 0.1;

export function saveGhost(stageId, frames) {
  const packed = [];
  for (const f of frames) {
    packed.push(
      Math.round(f[0] * 100), Math.round(f[1] * 100), Math.round(f[2] * 100),
      Math.round(f[3] * 1000), Math.round(f[4] * 1000), Math.round(f[5] * 1000), Math.round(f[6] * 1000),
    );
  }
  if (!write(GHOST_PREFIX + stageId, packed)) {
    // Out of quota: drop all other ghosts and try once more.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(GHOST_PREFIX)) localStorage.removeItem(k);
      }
    } catch { /* ignore */ }
    write(GHOST_PREFIX + stageId, packed);
  }
}

export function loadGhost(stageId) {
  const packed = read(GHOST_PREFIX + stageId);
  if (!Array.isArray(packed) || packed.length < 7) return null;
  const frames = [];
  for (let i = 0; i + 6 < packed.length; i += 7) {
    frames.push([
      packed[i] / 100, packed[i + 1] / 100, packed[i + 2] / 100,
      packed[i + 3] / 1000, packed[i + 4] / 1000, packed[i + 5] / 1000, packed[i + 6] / 1000,
    ]);
  }
  return frames;
}
