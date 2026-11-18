'use strict';

/*
 * Ride Tracker — syncs a dot on a trail map to a YouTube ride video.
 *
 * Encoding schema (rays-ride-encoding/v1):
 * {
 *   "id": "dQw4w9WgXcQ",              // unique key (defaults to the videoId)
 *   "title": "Wildcat lap",
 *   "videoId": "dQw4w9WgXcQ",         // YouTube video id
 *   "interpolation": "catmull-rom",   // "catmull-rom" (smooth) | "linear"
 *   "keyframes": [                    // sorted by t
 *     { "t": 3.2,  "x": 0.412, "y": 0.233 },   // t = video seconds, x/y = 0..1 of map width/height
 *     { "t": 41.0, "hidden": true }            // dot hidden from here until the next keyframe
 *   ]
 * }
 * encodings.json wraps these as { "schema", "map", "encodings": [...] }.
 */

const STORAGE_KEY = 'rays.encodings.v1';
const SCHEMA = 'rays-ride-encoding/v1';
const FRAME = 1 / 30;            // YouTube doesn't expose fps; 30 is a sensible step size
const SAME_TIME_EPS = FRAME / 2; // a click within half a frame of a keyframe replaces it
const MAP_SRC = 'map.png';

const $ = (sel) => document.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
const els = {
  rideSelect: $('#rideSelect'), editToggle: $('#editToggle'), editor: $('#editor'),
  mapImg: $('#mapImg'), overlay: $('#overlay'), dot: $('#dot'), dotPulse: $('#dotPulse'),
  pathLayer: $('#pathLayer'), keyLayer: $('#keyLayer'),
  time: $('#timeReadout'), keyList: $('#keyList'), interp: $('#interpSelect'),
  title: $('#titleInput'), urlInput: $('#urlInput'), newTitle: $('#newTitleInput'),
  jsonPanel: $('#jsonPanel'), jsonText: $('#jsonText'), jsonToggle: $('#jsonToggle'),
  status: $('#status'),
};

const state = {
  encodings: [],
  current: null,
  player: null,
  playerReady: false,
  playerVideoId: null,
  apiReady: false,
  loaded: false,
  editing: false,
  seekTarget: null, // last requested seek time while paused (getCurrentTime lags behind seekTo)
  mapW: 576, mapH: 576,
  drag: null,
};

/* ------------------------------------------------------------------ *
 * Interpolation
 * ------------------------------------------------------------------ */

/**
 * Maps linear time progress through a segment (u in 0..1) to spatial progress.
 * Returning u unchanged means constant speed between every pair of keyframes.
 *
 * a and b are the keyframes bounding the segment; (b.t - a.t) is its duration and
 * the distance between them is Math.hypot(b.x - a.x, b.y - a.y).
 */
function segmentProgress(u, a, b) {
  return u;
}

function positionAt(enc, t) {
  const k = enc?.keyframes;
  if (!k?.length) return null;
  if (t <= k[0].t) return k[0].hidden ? null : k[0];

  const i = lastIndexAtOrBefore(k, t);
  const a = k[i], b = k[i + 1];
  if (a.hidden) return null;
  if (!b || b.hidden) return a; // hold at the last visible point

  const u = segmentProgress((t - a.t) / (b.t - a.t), a, b);
  if (enc.interpolation === 'linear') return lerp(a, b, u);

  const p0 = k[i - 1] && !k[i - 1].hidden ? k[i - 1] : a;
  const p3 = k[i + 2] && !k[i + 2].hidden ? k[i + 2] : b;
  return centripetalCatmullRom(p0, a, b, p3, u);
}

function lastIndexAtOrBefore(k, t) {
  let lo = 0, hi = k.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (k[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function lerp(a, b, u) {
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

// Barry–Goldman form of centripetal Catmull–Rom (alpha = 0.5): passes through every
// keyframe and avoids the cusps/loops uniform Catmull–Rom makes with uneven spacing.
function centripetalCatmullRom(p0, p1, p2, p3, u) {
  const knot = (a, b) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-6);
  const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const L = (A, B, ta, tb) => lerp(A, B, (t - ta) / (tb - ta));
  const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
  const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

/* ------------------------------------------------------------------ *
 * Storage: encodings.json (shared) + localStorage drafts (per browser)
 * ------------------------------------------------------------------ */

async function loadEncodings() {
  let fromFile = [];
  try {
    const res = await fetch('encodings.json', { cache: 'no-store' });
    if (res.ok) fromFile = (await res.json()).encodings ?? [];
  } catch (err) {
    console.warn('Could not load encodings.json', err);
  }
  const byId = new Map(fromFile.map((e) => [String(e.id ?? e.videoId), normalize(e)]));
  for (const [id, e] of Object.entries(readLocal())) {
    if (e.deleted) byId.delete(id); else byId.set(id, normalize(e));
  }
  state.encodings = [...byId.values()];
}

function readLocal() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function writeLocal(obj) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); }
  catch (err) { flash(`Couldn't save draft: ${err.message}`); }
}
function persist(enc) {
  const local = readLocal();
  local[enc.id] = enc;
  writeLocal(local);
}
function persistDelete(id) {
  const local = readLocal();
  local[id] = { id, deleted: true };
  writeLocal(local);
}

function normalize(e) {
  if (!e || typeof e.videoId !== 'string') throw new Error('Encoding needs a "videoId" string');
  const round = (n) => Math.round(n * 10000) / 10000;
  return {
    id: String(e.id ?? e.videoId),
    title: e.title || e.videoId,
    videoId: e.videoId,
    interpolation: e.interpolation === 'linear' ? 'linear' : 'catmull-rom',
    keyframes: (e.keyframes ?? [])
      .map((k) => (k.hidden
        ? { t: round(+k.t), hidden: true }
        : { t: round(+k.t), x: round(clamp01(+k.x)), y: round(clamp01(+k.y)) }))
      .filter((k) => Number.isFinite(k.t) && (k.hidden || (Number.isFinite(k.x) && Number.isFinite(k.y))))
      .sort((a, b) => a.t - b.t),
  };
}

function exportFile(encodings) {
  return {
    schema: SCHEMA,
    map: { src: MAP_SRC, width: state.mapW, height: state.mapH },
    encodings,
  };
}

/* ------------------------------------------------------------------ *
 * YouTube player
 * ------------------------------------------------------------------ */

window.onYouTubeIframeAPIReady = () => {
  state.apiReady = true;
  ensurePlayer();
};

function ensurePlayer() {
  if (!state.apiReady || !state.loaded || !state.current) return;
  if (state.player) {
    if (state.playerReady && state.playerVideoId !== state.current.videoId) cueCurrent();
    return;
  }
  state.playerVideoId = state.current.videoId;
  state.player = new YT.Player('player', {
    videoId: state.current.videoId,
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { state.playerReady = true; ensurePlayer(); },
      onStateChange: (e) => { if (e.data === YT.PlayerState.PLAYING) state.seekTarget = null; },
    },
  });
}

function cueCurrent() {
  state.playerVideoId = state.current.videoId;
  state.seekTarget = null;
  state.player.cueVideoById(state.current.videoId);
}

function currentTime() {
  if (!state.playerReady) return 0;
  return state.seekTarget ?? (state.player.getCurrentTime() || 0);
}

function seekTo(t) {
  if (!state.playerReady) return;
  t = Math.max(0, t);
  const dur = state.player.getDuration();
  if (dur) t = Math.min(t, dur);
  state.player.pauseVideo();
  state.seekTarget = t;
  state.player.seekTo(t, true);
}

function togglePlay() {
  if (!state.playerReady) return;
  if (state.player.getPlayerState() === YT.PlayerState.PLAYING) state.player.pauseVideo();
  else state.player.playVideo();
}

function parseVideoId(input) {
  input = input.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1, 12);
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const m = url.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[1];
  } catch { /* not a URL */ }
  return null;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function tick() {
  const t = currentTime();
  const p = positionAt(state.current, t);
  for (const c of [els.dot, els.dotPulse]) {
    c.classList.toggle('hidden-dot', !p);
    if (p) { c.setAttribute('cx', p.x * state.mapW); c.setAttribute('cy', p.y * state.mapH); }
  }
  if (state.editing) {
    els.time.textContent = fmtTime(t);
    renderOverlay(t);
    highlightActive(t);
  }
  requestAnimationFrame(tick);
}

function renderRideSelect() {
  els.rideSelect.replaceChildren(...state.encodings.map((e) => new Option(e.title, e.id)));
  if (state.current) els.rideSelect.value = state.current.id;
  els.rideSelect.disabled = !state.encodings.length;
}

function selectEncoding(id) {
  state.current = state.encodings.find((e) => e.id === id) ?? state.encodings[0] ?? null;
  renderRideSelect();
  renderEditor();
  ensurePlayer();
}

function renderEditor() {
  if (!state.editing) {
    els.pathLayer.replaceChildren();
    els.keyLayer.replaceChildren();
    return;
  }
  const enc = state.current;
  els.title.value = enc?.title ?? '';
  els.interp.value = enc?.interpolation ?? 'catmull-rom';
  renderOverlay(currentTime(), true);
  renderKeyTable(enc);
  refreshJson();
}

// While editing, the map shows only the keyframes that bracket the current time
// (the last one at/before it and the next one after it) plus the path between them.
function windowAt(t) {
  const k = state.current?.keyframes ?? [];
  const prev = k.length && t >= k[0].t ? lastIndexAtOrBefore(k, t) : -1;
  return { prev, next: prev + 1 < k.length ? prev + 1 : -1 };
}

let shownWindow = null;
function renderOverlay(t, force = false) {
  const w = windowAt(t);
  const key = `${w.prev},${w.next}`;
  if (!force && key === shownWindow) return;
  shownWindow = key;
  renderPath(state.current, w);
  renderKeyMarkers(state.current, w);
}

function renderPath(enc, { prev, next }) {
  els.pathLayer.replaceChildren();
  const k = enc?.keyframes ?? [];
  if (prev < 0 || next < 0) return;
  const start = k[prev].t, end = k[next].t;
  const step = Math.max((end - start) / 300, 0.02);
  let pts = [];
  const flush = () => {
    if (pts.length > 1) {
      const pl = document.createElementNS(SVG_NS, 'polyline');
      pl.setAttribute('points', pts.join(' '));
      els.pathLayer.append(pl);
    }
    pts = [];
  };
  for (let t = start; t <= end + step / 2; t += step) {
    const p = positionAt(enc, Math.min(t, end));
    if (p) pts.push(`${(p.x * state.mapW).toFixed(1)},${(p.y * state.mapH).toFixed(1)}`);
    else flush();
  }
  flush();
}

function renderKeyMarkers(enc, { prev, next }) {
  els.keyLayer.replaceChildren();
  (enc?.keyframes ?? []).forEach((k, i) => {
    if (k.hidden || (i !== prev && i !== next)) return;
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('key');
    if (i === prev) g.classList.add('active');
    g.dataset.index = i;
    g.setAttribute('transform', `translate(${k.x * state.mapW} ${k.y * state.mapH})`);
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('r', 9);
    const label = document.createElementNS(SVG_NS, 'text');
    label.textContent = i + 1;
    g.append(c, label);
    els.keyLayer.append(g);
  });
}

function renderKeyTable(enc) {
  els.keyList.replaceChildren(...(enc?.keyframes ?? []).map((k, i) => {
    const tr = document.createElement('tr');
    tr.dataset.index = i;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><button class="time-link" data-seek="${k.t}">${fmtTime(k.t)}</button></td>
      <td>${k.hidden ? '—' : k.x.toFixed(3)}</td>
      <td>${k.hidden ? 'off-map' : k.y.toFixed(3)}</td>
      <td><button class="del" data-del="${i}" title="Delete point">✕</button></td>`;
    return tr;
  }));
}

let lastActive = -1;
function highlightActive(t) {
  const k = state.current?.keyframes ?? [];
  const i = k.length && t >= k[0].t ? lastIndexAtOrBefore(k, t) : -1;
  if (i === lastActive) return;
  lastActive = i;
  for (const el of document.querySelectorAll('.key, .keys tr')) {
    el.classList.toggle('active', Number(el.dataset.index) === i);
  }
}

function refreshJson() {
  if (els.jsonPanel.hidden || document.activeElement === els.jsonText) return;
  els.jsonText.value = state.current ? JSON.stringify(state.current, null, 2) : '';
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

function commit() {
  if (!state.current) return;
  state.current.keyframes.sort((a, b) => a.t - b.t);
  persist(state.current);
  lastActive = -2;
  renderEditor();
}

function upsertKeyframe(kf) {
  const k = state.current.keyframes;
  const existing = k.findIndex((o) => Math.abs(o.t - kf.t) <= SAME_TIME_EPS);
  if (existing >= 0) k[existing] = kf; else k.push(kf);
  commit();
}

function mapPointFromEvent(e) {
  const r = els.overlay.getBoundingClientRect();
  const round = (n) => Math.round(clamp01(n) * 10000) / 10000;
  return { x: round((e.clientX - r.left) / r.width), y: round((e.clientY - r.top) / r.height) };
}

function onMapPointerDown(e) {
  if (!state.editing || !state.current) return;
  const marker = e.target.closest('.key');
  if (marker) {
    state.drag = { index: Number(marker.dataset.index), moved: false, x0: e.clientX, y0: e.clientY };
    els.overlay.setPointerCapture(e.pointerId);
    return;
  }
  if (!state.playerReady) { flash('Video not ready yet'); return; }
  const t = Math.round(currentTime() * 1000) / 1000;
  upsertKeyframe({ t, ...mapPointFromEvent(e) });
}

function onMapPointerMove(e) {
  const d = state.drag;
  if (!d) return;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
  d.moved = true;
  Object.assign(state.current.keyframes[d.index], mapPointFromEvent(e));
  renderOverlay(currentTime(), true);
}

function onMapPointerUp() {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  if (d.moved) commit();
  else seekTo(state.current.keyframes[d.index].t);
}

function addRide() {
  const videoId = parseVideoId(els.urlInput.value);
  if (!videoId) { flash("That doesn't look like a YouTube URL or ID"); return; }
  let id = videoId;
  if (state.encodings.some((e) => e.id === id)) {
    selectEncoding(id);
    flash('That video already has an encoding — selected it');
    return;
  }
  const enc = normalize({ id, videoId, title: els.newTitle.value.trim() || videoId, keyframes: [] });
  state.encodings.push(enc);
  persist(enc);
  els.urlInput.value = els.newTitle.value = '';
  selectEncoding(id);
  flash('Ride added — step to the start and click the map');
}

function deleteRide() {
  const enc = state.current;
  if (!enc || !confirm(`Delete encoding "${enc.title}"?`)) return;
  state.encodings = state.encodings.filter((e) => e !== enc);
  persistDelete(enc.id);
  selectEncoding(state.encodings[0]?.id);
}

function applyJson() {
  let data;
  try { data = JSON.parse(els.jsonText.value); } catch (err) { flash(`Invalid JSON: ${err.message}`); return; }
  try {
    const list = Array.isArray(data.encodings) ? data.encodings : [data];
    let lastId;
    for (const raw of list) {
      const enc = normalize(raw);
      const i = state.encodings.findIndex((e) => e.id === enc.id);
      if (i >= 0) state.encodings[i] = enc; else state.encodings.push(enc);
      persist(enc);
      lastId = enc.id;
    }
    els.jsonText.blur();
    selectEncoding(list.length === 1 ? lastId : state.current?.id ?? lastId);
    flash(`Applied ${list.length} encoding${list.length === 1 ? '' : 's'}`);
  } catch (err) {
    flash(err.message);
  }
}

function downloadAll() {
  const blob = new Blob([JSON.stringify(exportFile(state.encodings), null, 2) + '\n'], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'encodings.json' });
  a.click();
  URL.revokeObjectURL(a.href);
  flash('Downloaded — replace encodings.json in the site folder to share it');
}

function onKey(e) {
  if (!state.editing || e.target.matches('input, textarea, select')) return;
  const steps = { ',': -FRAME, '.': FRAME, ArrowLeft: e.shiftKey ? -5 : -1, ArrowRight: e.shiftKey ? 5 : 1 };
  if (e.key in steps) { seekTo(currentTime() + steps[e.key]); e.preventDefault(); }
  else if (e.key === 'k' || e.key === 'K') togglePlay();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.current) {
    const k = state.current.keyframes;
    const i = k.findIndex((o) => Math.abs(o.t - currentTime()) <= SAME_TIME_EPS);
    if (i >= 0) { k.splice(i, 1); commit(); e.preventDefault(); }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers + wiring
 * ------------------------------------------------------------------ */

function clamp01(n) { return Math.min(1, Math.max(0, n)); }

function fmtTime(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
}

let flashTimer;
function flash(msg) {
  els.status.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { els.status.textContent = ''; }, 4000);
}

function setEditing(on) {
  state.editing = on;
  els.editor.hidden = !on;
  document.body.classList.toggle('editing', on);
  els.editToggle.textContent = on ? 'Done editing' : 'Edit encodings';
  lastActive = -2;
  renderEditor();
}

function wire() {
  els.rideSelect.addEventListener('change', () => selectEncoding(els.rideSelect.value));
  els.editToggle.addEventListener('click', () => setEditing(!state.editing));

  els.overlay.addEventListener('pointerdown', onMapPointerDown);
  els.overlay.addEventListener('pointermove', onMapPointerMove);
  els.overlay.addEventListener('pointerup', onMapPointerUp);
  els.overlay.addEventListener('pointercancel', () => { state.drag = null; commit(); });

  document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const s = b.dataset.step;
    const d = s === 'frame' ? FRAME : s === '-frame' ? -FRAME : Number(s);
    seekTo(currentTime() + d);
  }));
  $('#playPause').addEventListener('click', togglePlay);
  $('#offMap').addEventListener('click', () => {
    if (state.current && state.playerReady) upsertKeyframe({ t: Math.round(currentTime() * 1000) / 1000, hidden: true });
  });

  els.keyList.addEventListener('click', (e) => {
    const seek = e.target.closest('[data-seek]');
    const del = e.target.closest('[data-del]');
    if (seek) seekTo(Number(seek.dataset.seek));
    if (del) { state.current.keyframes.splice(Number(del.dataset.del), 1); commit(); }
  });

  els.title.addEventListener('change', () => {
    if (!state.current) return;
    state.current.title = els.title.value.trim() || state.current.videoId;
    commit();
    renderRideSelect();
  });
  els.interp.addEventListener('change', () => {
    if (!state.current) return;
    state.current.interpolation = els.interp.value;
    commit();
  });

  $('#addRide').addEventListener('click', addRide);
  els.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRide(); });
  $('#deleteRide').addEventListener('click', deleteRide);

  els.jsonToggle.addEventListener('click', () => {
    els.jsonPanel.hidden = !els.jsonPanel.hidden;
    els.jsonToggle.textContent = els.jsonPanel.hidden ? 'Show JSON' : 'Hide JSON';
    refreshJson();
  });
  $('#jsonApply').addEventListener('click', applyJson);
  $('#jsonCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(els.jsonText.value); flash('Copied'); }
    catch { els.jsonText.select(); flash('Press ⌘C to copy'); }
  });
  $('#downloadAll').addEventListener('click', downloadAll);
  $('#clearDrafts').addEventListener('click', () => {
    if (!confirm('Discard all edits saved in this browser and reload from encodings.json?')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    location.reload();
  });

  document.addEventListener('keydown', onKey);

  const onMapLoad = () => {
    state.mapW = els.mapImg.naturalWidth || 576;
    state.mapH = els.mapImg.naturalHeight || 576;
    els.overlay.setAttribute('viewBox', `0 0 ${state.mapW} ${state.mapH}`);
    renderEditor();
  };
  if (els.mapImg.complete) onMapLoad(); else els.mapImg.addEventListener('load', onMapLoad);
}

async function init() {
  wire();
  await loadEncodings();
  state.loaded = true;
  selectEncoding(new URLSearchParams(location.search).get('ride'));
  requestAnimationFrame(tick);
}

init();
