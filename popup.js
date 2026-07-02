const FX_DEFAULT = {
  slowed: { on: false, val: 85 },
  reverb: { on: false, val: 50 },
  bass: { on: false, val: 45 },
  muffle: { on: false, val: 45 },
  echo: { on: false, val: 40 },
  wide: { on: false, val: 50 },
  rain: { on: false, val: 45 },
  wow: { on: false, val: 40 },
  eqlow: { on: false, val: 50 },
  eqmid: { on: false, val: 50 },
  eqhigh: { on: false, val: 50 }
};
const FX_META = [
  { key: "slowed", name: "Speed", sub: "0.5x slow to 2x fast" },
  { key: "reverb", name: "Reverb", sub: "dreamy hall" },
  { key: "bass", name: "Bass boost", sub: "low end" },
  { key: "muffle", name: "Muffle", sub: "soft lowpass" },
  { key: "echo", name: "Echo", sub: "delay throwback" },
  { key: "wide", name: "8D pan", sub: "spins L / R" },
  { key: "rain", name: "Rain", sub: "rainfall ambience" },
  { key: "wow", name: "Wow / flutter", sub: "tape pitch wobble" },
  { key: "eqlow", name: "EQ Low", sub: "bass shelf (dB)" },
  { key: "eqmid", name: "EQ Mid", sub: "mids (dB)" },
  { key: "eqhigh", name: "EQ High", sub: "treble (dB)" }
];
const EQ_KEYS = new Set(["eqlow", "eqmid", "eqhigh"]);
// Partial presets: unspecified effects fall back to off (merged with FX_DEFAULT).
const PRESETS = {
  lofi: {
    slowed: { on: true, val: 85 }, reverb: { on: true, val: 100 }, bass: { on: true, val: 6 },
    muffle: { on: true, val: 75 }, rain: { on: true, val: 14 }, wow: { on: true, val: 30 }
  },
  dreamy: {
    slowed: { on: true, val: 88 }, reverb: { on: true, val: 66 }, muffle: { on: true, val: 40 },
    eqhigh: { on: true, val: 66 }, wow: { on: true, val: 15 }
  },
  nightcore: {
    slowed: { on: true, val: 132 }, reverb: { on: true, val: 20 }, bass: { on: true, val: 45 },
    eqmid: { on: true, val: 58 }, eqhigh: { on: true, val: 66 }
  },
  club: {
    eqlow: { on: true, val: 72 }, eqhigh: { on: true, val: 62 }, reverb: { on: true, val: 24 }
  },
  screwed: {
    slowed: { on: true, val: 70 }, bass: { on: true, val: 60 }, reverb: { on: true, val: 55 },
    muffle: { on: true, val: 45 }, echo: { on: true, val: 30 }
  },
  space: {
    slowed: { on: true, val: 90 }, reverb: { on: true, val: 58 }, wide: { on: true, val: 62 },
    echo: { on: true, val: 35 }, eqhigh: { on: true, val: 58 }
  },
  vintage: {
    muffle: { on: true, val: 55 }, eqmid: { on: true, val: 70 }, eqlow: { on: true, val: 30 },
    wow: { on: true, val: 30 }, reverb: { on: true, val: 22 }
  }
};
const DEFAULTS = {
  segMin: 40,
  segMax: 70,
  overlap: 5,
  volume: 100,
  fx: FX_DEFAULT,
  fxPreset: "none",
  fxCustom: FX_DEFAULT
};
const clone = (o) => JSON.parse(JSON.stringify(o));

const POLL_MS = 1000;
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const THUMB = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const WATCH = (id) => `https://music.youtube.com/watch?v=${id}`;

const el = {
  segMin: document.getElementById("segMin"),
  segMax: document.getElementById("segMax"),
  overlap: document.getElementById("overlap"),
  volume: document.getElementById("volume"),
  volVal: document.getElementById("volVal"),
  fxRack: document.getElementById("fxRack"),
  djIdle: document.getElementById("djIdle"),
  djLive: document.getElementById("djLive"),
  dj2Status: document.getElementById("dj2Status"),
  dj2Start: document.getElementById("dj2Start"),
  dj2Stop: document.getElementById("dj2Stop"),
  btnSkip: document.getElementById("btnSkip"),
  btnPlayNow: document.getElementById("btnPlayNow"),
  btnPlayPause: document.getElementById("btnPlayPause"),
  icoPlay: document.getElementById("icoPlay"),
  icoPause: document.getElementById("icoPause"),
  ppLabel: document.getElementById("ppLabel")
};

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

let masterTab = null;
let snapshot = null;

function clamp(value, min, max, fallback) {
  const n = parseFloat(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------- settings ----------
let fx = FX_DEFAULT;
let fxPreset = "custom";
let fxCustom = FX_DEFAULT;

chrome.storage.sync.get(DEFAULTS, (c) => {
  el.segMin.value = c.segMin;
  el.segMax.value = c.segMax;
  el.overlap.value = c.overlap;
  el.volume.value = c.volume;
  el.volVal.textContent = c.volume + "%";
  fx = { ...FX_DEFAULT, ...(c.fx || {}) };
  fxPreset = c.fxPreset || "custom";
  fxCustom = { ...FX_DEFAULT, ...(c.fxCustom || {}) };
  wirePresets();
  renderPresets();
  buildFxRack();
});

let fxSaveTimer = null;
function persist(immediate) {
  clearTimeout(fxSaveTimer);
  const write = () => chrome.storage.sync.set({ fx, fxPreset, fxCustom });
  if (immediate) write();
  else fxSaveTimer = setTimeout(write, 150);
}

function renderPresets() {
  document.querySelectorAll("#presets button").forEach((b) => {
    b.classList.toggle("active", b.dataset.preset === fxPreset);
  });
}

function wirePresets() {
  document.querySelectorAll("#presets button").forEach((b) => {
    b.addEventListener("click", () => selectPreset(b.dataset.preset));
  });
}

function selectPreset(name) {
  fxPreset = name;
  if (name === "custom") fx = clone(fxCustom);
  else if (name === "none") fx = clone(FX_DEFAULT); // everything off
  else fx = { ...clone(FX_DEFAULT), ...clone(PRESETS[name]) };
  renderPresets();
  buildFxRack();
  persist(true);
}

// an edit to any control means we are no longer on a named preset
function markCustom() {
  fxCustom = clone(fx);
  if (fxPreset !== "custom") {
    fxPreset = "custom";
    renderPresets();
  }
}

function fxDisplay(key, val) {
  if (key === "slowed") return (val / 100).toFixed(2) + "x";
  if (EQ_KEYS.has(key)) {
    const db = Math.round(((val - 50) / 50) * 15);
    return (db > 0 ? "+" : "") + db + " dB";
  }
  return val + "%";
}

function buildFxRack() {
  el.fxRack.innerHTML = "";
  for (const m of FX_META) {
    const state = fx[m.key] || FX_DEFAULT[m.key];
    const wrap = document.createElement("div");
    wrap.className = "fx" + (state.on ? " on" : "");

    const row = document.createElement("div");
    row.className = "fxrow";
    row.innerHTML = `<div><div class="name">${m.name}</div><div class="sub">${m.sub}</div></div>`;

    const right = document.createElement("div");
    right.className = "fxright";
    const val = document.createElement("span");
    val.className = "fxval";
    val.textContent = fxDisplay(m.key, state.val);
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.on;
    const sl = document.createElement("span");
    sl.className = "slider";
    sw.appendChild(cb);
    sw.appendChild(sl);
    right.appendChild(val);
    right.appendChild(sw);
    row.appendChild(right);

    const range = document.createElement("input");
    range.type = "range";
    range.min = m.key === "slowed" ? 50 : EQ_KEYS.has(m.key) ? 0 : 5; // EQ centers at 50 (flat)
    range.max = m.key === "slowed" ? 200 : 100; // speed goes up to 2x
    range.value = state.val;
    range.disabled = !state.on;

    cb.addEventListener("change", () => {
      fx[m.key].on = cb.checked;
      wrap.classList.toggle("on", cb.checked);
      range.disabled = !cb.checked;
      markCustom();
      persist(true);
    });
    range.addEventListener("input", () => {
      fx[m.key].val = parseInt(range.value, 10);
      val.textContent = fxDisplay(m.key, fx[m.key].val);
      markCustom();
      persist(false);
    });

    wrap.appendChild(row);
    wrap.appendChild(range);
    el.fxRack.appendChild(wrap);
  }
}

function commitRange() {
  let min = clamp(el.segMin.value, 5, 180, DEFAULTS.segMin);
  let max = clamp(el.segMax.value, 5, 180, DEFAULTS.segMax);
  if (min > max) min = max;
  el.segMin.value = min;
  el.segMax.value = max;
  chrome.storage.sync.set({ segMin: min, segMax: max });
}
el.segMin.addEventListener("change", commitRange);
el.segMax.addEventListener("change", commitRange);

el.overlap.addEventListener("change", () => {
  const v = clamp(el.overlap.value, 1, 15, DEFAULTS.overlap);
  el.overlap.value = v;
  chrome.storage.sync.set({ overlap: v });
});

let volSaveTimer = null;
el.volume.addEventListener("input", () => {
  const v = parseInt(el.volume.value, 10);
  el.volVal.textContent = v + "%";
  clearTimeout(volSaveTimer);
  volSaveTimer = setTimeout(() => chrome.storage.sync.set({ volume: v }), 120);
});

// ---------- messaging ----------
function sendTab(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (resp) => {
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

function musicTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "https://music.youtube.com/*" }, (tabs) => resolve(tabs || []));
  });
}

async function findMaster() {
  for (const t of await musicTabs()) {
    const resp = await sendTab(t.id, { type: "DJ2_STATUS" });
    if (resp && resp.active) return { tabId: t.id, snapshot: resp };
  }
  return null;
}

// ---------- deck panel ----------
function deckTrack(which) {
  if (!snapshot) return null;
  // each deck reports the song its own player currently holds (live song, or
  // the standby it is cued to); fall back to queue metadata if status is blank
  const st = which === "self" ? snapshot.self : snapshot.remote;
  if (st && st.videoId) return st;
  if (snapshot.live !== which && snapshot.standby) {
    return { videoId: snapshot.standby.id, title: snapshot.standby.title, artist: snapshot.standby.artist };
  }
  return st;
}

function fillCard(which, ids) {
  const live = snapshot.live === which;
  const blendOut = !!snapshot.blending && !live; // the deck fading out during a blend
  const ready = !!(snapshot.standby && snapshot.standby.ready);
  const loading = !live && !blendOut && !ready; // standby deck still cueing up
  const t = deckTrack(which);

  const card = document.getElementById(ids.card);
  card.classList.toggle("live", live);
  card.classList.toggle("paused", live && !!snapshot.paused);
  card.classList.toggle("blend", blendOut);
  card.classList.toggle("loading", loading);

  const thumb = document.getElementById(ids.thumb);
  const song = document.getElementById(ids.song);
  const artist = document.getElementById(ids.artist);
  const fill = document.getElementById(ids.fill);

  if (loading) {
    thumb.src = BLANK;
    song.innerHTML = 'Finding next track<span class="dots"></span>';
    artist.textContent = "";
    delete card.dataset.videoId;
    fill.style.width = "0%";
    return;
  }

  if (t && t.videoId) {
    thumb.src = THUMB(t.videoId);
    song.textContent = t.title || "Loading…";
    artist.textContent = t.artist || "";
    card.dataset.videoId = t.videoId;
  } else {
    thumb.src = BLANK;
    song.textContent = "-";
    artist.textContent = "";
    delete card.dataset.videoId;
  }

  const seg = snapshot.seg;
  if (live && seg && seg.totalMs > 0) {
    fill.style.width = Math.min(100, (seg.elapsedMs / seg.totalMs) * 100) + "%";
    document.getElementById(ids.cur).textContent = mmss(Math.min(seg.elapsedMs, seg.totalMs));
    document.getElementById(ids.tot).textContent = mmss(seg.totalMs);
  } else if (blendOut) {
    fill.style.width = "100%"; // fading out, bar complete
  } else {
    fill.style.width = "0%";
  }
}

function renderPanel() {
  const active = !!(snapshot && snapshot.active);
  el.djIdle.style.display = active ? "none" : "";
  el.djLive.style.display = active ? "" : "none";
  el.dj2Start.style.display = active ? "none" : "";
  if (!active) return;

  fillCard("self", { card: "cardSelf", thumb: "thumbSelf", song: "songSelf", artist: "artistSelf", fill: "fillSelf", cur: "curSelf", tot: "totSelf" });
  fillCard("remote", { card: "cardRemote", thumb: "thumbRemote", song: "songRemote", artist: "artistRemote", fill: "fillRemote", cur: "curRemote", tot: "totRemote" });

  el.icoPlay.style.display = snapshot.paused ? "" : "none";
  el.icoPause.style.display = snapshot.paused ? "none" : "";
  el.ppLabel.textContent = snapshot.paused ? "Play" : "Pause";
  el.btnPlayNow.disabled = !(snapshot.standby && snapshot.standby.ready);
  el.btnSkip.disabled = !snapshot.standby;
}

async function poll() {
  if (masterTab != null) {
    const resp = await sendTab(masterTab, { type: "DJ2_STATUS" });
    if (resp && resp.active) {
      snapshot = resp;
      renderPanel();
      return;
    }
    masterTab = null;
  }
  const found = await findMaster();
  if (found) {
    masterTab = found.tabId;
    snapshot = found.snapshot;
  } else {
    snapshot = null;
  }
  renderPanel();
}
poll();
setInterval(poll, POLL_MS);

// ---------- actions ----------
// click a deck card -> open that song in a new tab (like, playlists, etc.)
el.djLive.addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  const card = e.target.closest(".card");
  if (card && card.dataset.videoId) chrome.tabs.create({ url: WATCH(card.dataset.videoId) });
});

async function masterCmd(type) {
  if (masterTab == null) return null;
  return sendTab(masterTab, { type });
}

el.btnPlayPause.addEventListener("click", async () => {
  if (!snapshot) return;
  const resp = await masterCmd(snapshot.paused ? "DJ2_RESUME" : "DJ2_PAUSE");
  if (resp && resp.ok) poll();
});

el.btnPlayNow.addEventListener("click", async () => {
  const resp = await masterCmd("DJ2_PLAYNOW");
  el.dj2Status.textContent = resp && resp.ok ? "" : (resp && resp.error) || "Not ready.";
});

el.btnSkip.addEventListener("click", async () => {
  const resp = await masterCmd("DJ2_SKIP");
  el.dj2Status.textContent = resp && resp.ok ? "" : (resp && resp.error) || "Skip failed.";
});

// ---------- start / stop ----------
function activeMusicTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      resolve(t && t.url && t.url.startsWith("https://music.youtube.com") ? t : null);
    });
  });
}

document.getElementById("credit").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://github.com/jad-jayzee" });
});

el.dj2Start.addEventListener("click", async () => {
  let tab = await activeMusicTab();
  if (!tab) {
    const tabs = await musicTabs();
    tab = tabs[0] || null;
  }
  if (!tab) {
    el.dj2Status.textContent = "Open music.youtube.com, play a song, then Start.";
    return;
  }
  el.dj2Status.textContent = "Starting…";
  const resp = await sendTab(tab.id, { type: "DJ2_START" });
  if (!resp) {
    el.dj2Status.textContent = "No connection - reload the YT Music tab and try again.";
    return;
  }
  el.dj2Status.textContent = resp.ok ? "" : resp.error || "Failed.";
  if (resp.ok) {
    masterTab = tab.id;
    poll();
  }
});

el.dj2Stop.addEventListener("click", async () => {
  for (const t of await musicTabs()) sendTab(t.id, { type: "DJ2_STOP" });
  el.dj2Status.textContent = "Stopped.";
  snapshot = null;
  masterTab = null;
  renderPanel();
});
