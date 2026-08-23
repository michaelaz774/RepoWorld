/**
 * Blockade Labs Skybox AI integration (via the same-origin /api/skybox proxy).
 *
 * All network calls are optional: when no key is configured (__HAS_BLOCKADE__
 * falsy/undefined) every entry point short-circuits and the app falls back to
 * the procedural sky in SkyEnvironment.jsx. generateSkybox() NEVER throws.
 */

/** True when a Blockade Labs key is configured at build time. */
export function skyboxAvailable() {
  return typeof __HAS_BLOCKADE__ !== 'undefined' && !!__HAS_BLOCKADE__;
}

/** Language -> visual palette/material cue for the panorama prompt. */
const LANG_MOOD = {
  JavaScript: 'warm golden amber neon towers',
  TypeScript: 'cool azure glass spires',
  Python: 'deep serene blue horizon with soft mist',
  Rust: 'rusted industrial orange steel and copper haze',
  Go: 'minimal cyan geometry under clean light',
  Java: 'umber brick megastructures',
  'C++': 'crimson circuit-etched canyons',
  C: 'grey monolithic concrete slabs',
  'C#': 'emerald-green lattice towers',
  Ruby: 'ruby-red lantern glow',
  PHP: 'violet-indigo terraces',
  Swift: 'sunset-orange chrome curves',
  Kotlin: 'purple holographic ridgelines',
  Shell: 'phosphor-green terminal glow',
  HTML: 'burnt-orange scaffold frames',
  CSS: 'deep violet gradient banners',
};
const DEFAULT_MOOD = 'iridescent circuit-lit skyline';

/**
 * Atmosphere cue from hazard count: many hazards = ominous, few = calm.
 * @param {number} n
 */
function atmosphereFor(n) {
  if (n >= 8) return 'under a smoky storm sky with drifting embers';
  if (n >= 3) return 'in a hazy amber dusk with scattered sparks';
  return 'in clear calm dawn light';
}

/**
 * Build a deterministic equirect-panorama prompt from repo metadata.
 * Pure function, no network, stays under ~350 chars.
 * @param {{name?:string, description?:string, language?:string, topics?:string[],
 *          summary?:string, fileCount?:number, hazardCount?:number}} [meta]
 * @returns {string}
 */
export function buildPrompt(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const name = String(m.name || 'a code repository').slice(0, 40);
  const mood = LANG_MOOD[m.language] || DEFAULT_MOOD;
  const hazards = Number(m.hazardCount) || 0;
  const topics = Array.isArray(m.topics) ? m.topics.filter(Boolean) : [];
  const theme = topics.length ? `, themed around ${String(topics[0]).slice(0, 30)}` : '';
  return (
    `The world of ${name}: a ${mood}${theme}, ${atmosphereFor(hazards)}, ` +
    'seen from inside a vast digital city, 360 equirectangular panorama, ' +
    'no text, no watermark'
  );
}

/**
 * Pick a skybox style id by fuzzy name match against `preferred`.
 * Falls back to the first usable id, then to 5.
 * @param {Array<{id?:number|string, name?:string}>} styles
 * @param {string[]} [preferred]
 * @returns {number|string}
 */
export function pickStyleId(styles, preferred = ['digital', 'cyber', 'sci-fi', 'anime']) {
  const list = Array.isArray(styles)
    ? styles.filter((s) => s && typeof s === 'object' && s.id !== undefined && s.id !== null)
    : [];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const want of preferred) {
    const w = norm(want);
    if (!w) continue;
    const hit = list.find((s) => norm(s.name || '').includes(w));
    if (hit) return hit.id;
  }
  return list.length ? list[0].id : 5;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full generation flow: fetch styles -> pick style -> request skybox -> poll
 * every 3s until complete or timeout. Resolves to the equirect image URL, or
 * null on failure/timeout/no-key. Never throws, never rejects.
 * @param {string} prompt
 * @param {{timeoutMs?:number, onProgress?:(status:string, elapsedSeconds:number)=>void}} [opts]
 * @returns {Promise<string|null>}
 */
export async function generateSkybox(prompt, opts = {}) {
  if (!skyboxAvailable()) return null;
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 120000;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  try {
    // 1. Styles (non-fatal if it fails — pickStyleId falls back to 5).
    let styles = [];
    try {
      const r = await fetch('/api/skybox/api/v1/skybox/styles');
      if (r.ok) {
        const data = await r.json();
        styles = Array.isArray(data) ? data : data && Array.isArray(data.styles) ? data.styles : [];
      }
    } catch {
      /* keep empty styles */
    }
    const styleId = pickStyleId(styles);

    // 2. Kick off generation.
    onProgress('requesting', elapsed());
    const res = await fetch('/api/skybox/api/v1/skybox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: String(prompt || ''),
        skybox_style_id: styleId,
        negative_text: 'text, watermark, logo, words, blurry',
      }),
    });
    if (!res.ok) return null;
    const job = await res.json();
    const id = job && (job.id !== undefined ? job.id : job.request && job.request.id);
    if (id === undefined || id === null) return null;

    // 3. Poll every 3s until complete/abort/error/timeout.
    while (Date.now() - started < timeoutMs) {
      await sleep(3000);
      let req = null;
      try {
        const pr = await fetch(`/api/skybox/api/v1/imagine/requests/${id}`);
        if (pr.ok) {
          const data = await pr.json();
          req = data && data.request ? data.request : data;
        }
      } catch {
        /* transient poll failure — keep polling */
      }
      const status = (req && req.status) || 'pending';
      onProgress(status, elapsed());
      if (status === 'complete') return (req && req.file_url) || null;
      if (status === 'abort' || status === 'error') return null;
    }
    return null;
  } catch {
    return null;
  }
}
