// Fetches a YouTube watch page and extracts the "Most Replayed" best part:
// the best moving-average window of the heatmap (avoids lone rewatch spikes).
// The heatmap has no public API; it is parsed from the markers array embedded
// in the watch-page HTML. pickSingle is the fallback for very short tracks.

const MARKERS_RE = /"markerType":"MARKER_TYPE_HEATMAP","markers":(\[.*?\])/s;
const PEAK_TIMEOUT_MS = 12000;
// The opening marker is inflated (every play + replays-from-start count toward
// it), so skip a leading window and the tail to reach the real hook / drop.
const DEFAULT_INTRO_SKIP_SEC = 15;
const DEFAULT_WINDOW_SEC = 20;
const OUTRO_SKIP_FRAC = 0.1;

function parseMarkers(markers) {
  const parsed = [];
  for (const item of markers) {
    if (!item) continue;
    // Current format is a flat marker; older layouts nested it under
    // heatMarkerRenderer. Accept both field-name variants.
    const r = item.heatMarkerRenderer || item;
    const score = r.intensityScoreNormalized ?? r.heatMarkerIntensityScoreNormalized ?? 0;
    const startMs = r.startMillis ?? r.timeRangeStartMillis;
    if (startMs == null) continue;
    const durMs = r.durationMillis ?? r.markerDurationMillis ?? 0;
    parsed.push({ score, startMs: Number(startMs), durMs: Number(durMs) });
  }
  parsed.sort((a, b) => a.startMs - b.startMs);
  return parsed;
}

function bodyBounds(parsed, introSkipSec) {
  const totalMs = Math.max(...parsed.map((p) => p.startMs + p.durMs));
  return { introCutMs: introSkipSec * 1000, outroCutMs: totalMs * (1 - OUTRO_SKIP_FRAC) };
}

function pickSingle(parsed, introSkipSec) {
  const { introCutMs, outroCutMs } = bodyBounds(parsed, introSkipSec);
  const body = parsed.filter((p) => p.startMs >= introCutMs && p.startMs <= outroCutMs);
  const pool = body.length ? body : parsed;
  let best = null;
  for (const p of pool) {
    if (!best || p.score > best.score) best = p;
  }
  return best ? best.startMs / 1000 : null;
}

function pickSustained(parsed, introSkipSec, windowSec) {
  const { introCutMs, outroCutMs } = bodyBounds(parsed, introSkipSec);
  const markerMs = parsed[0].durMs || (parsed[1] ? parsed[1].startMs - parsed[0].startMs : 1000);
  const w = Math.max(1, Math.round((windowSec * 1000) / markerMs));
  if (w >= parsed.length) return pickSingle(parsed, introSkipSec);

  const n = parsed.length;
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + parsed[i].score;

  let best = null;
  for (let i = 0; i + w <= n; i++) {
    const start = parsed[i].startMs;
    if (start < introCutMs) continue;
    if (start > outroCutMs) break;
    const avg = (prefix[i + w] - prefix[i]) / w;
    if (!best || avg > best.avg) best = { avg, startMs: start };
  }
  return best ? best.startMs / 1000 : pickSingle(parsed, introSkipSec);
}

async function fetchPeak(videoId, introSkipSec, windowSec) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEAK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: "omit",
      headers: { "Accept-Language": "en-US,en;q=0.9" },
      signal: controller.signal
    });
    const html = await res.text();
    const m = html.match(MARKERS_RE);
    if (!m) return { ok: true, peakSeconds: null, hasHeatmap: false };

    let markers;
    try {
      markers = JSON.parse(m[1]);
    } catch {
      return { ok: true, peakSeconds: null, hasHeatmap: false };
    }

    const parsed = parseMarkers(markers);
    if (!parsed.length) return { ok: true, peakSeconds: null, hasHeatmap: false };

    const peakSeconds = pickSustained(parsed, introSkipSec, windowSec);
    if (peakSeconds == null) return { ok: true, peakSeconds: null, hasHeatmap: false };
    return { ok: true, peakSeconds, hasHeatmap: true };
  } finally {
    clearTimeout(timer);
  }
}

const YTM_URL = "https://music.youtube.com/";

// Dual-tab DJ relay: the engine lives in the master tab's page; this worker
// only finds/creates the second YT Music tab and forwards commands to it.
async function ensureDeckTab(sender) {
  const masterId = sender.tab.id;
  // pin the master first so both decks sit together at the front of the strip
  const master = await chrome.tabs.update(masterId, { pinned: true });
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });
  const other = (tabs || []).find((t) => t.id !== masterId);
  if (other) {
    await chrome.tabs.update(other.id, { pinned: true });
    await chrome.tabs.move(other.id, { index: master.index + 1 });
    return { ok: true, tabId: other.id };
  }
  // Foreground the new tab (and its window) so Chrome grants it audio autoplay
  // when the standby track plays during prep; focus returns to master after.
  const tab = await chrome.tabs.create({ url: YTM_URL, active: true, pinned: true, index: master.index + 1 });
  if (!tab) return { ok: false, error: "could not create tab" };
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_e) {}
  return { ok: true, tabId: tab.id, created: true };
}

function handleDj2Relay(msg, sender, sendResponse) {
  if (msg.op === "ensure") {
    ensureDeckTab(sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return;
  }
  if (msg.op === "close" && msg.tabId) {
    chrome.tabs.remove(msg.tabId, () => {
      sendResponse(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : { ok: true });
    });
    return;
  }
  if (msg.op === "exec" && msg.tabId) {
    chrome.tabs.sendMessage(msg.tabId, { type: "DJ2_EXEC", cmd: msg.cmd, args: msg.args }, (resp) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse(resp || { ok: false, error: "no response from deck tab" });
    });
    return;
  }
  sendResponse({ ok: false, error: "bad relay op" });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "DJ2_RELAY") {
    handleDj2Relay(msg, _sender, sendResponse);
    return true;
  }
  if (msg && msg.type === "GET_PEAK" && msg.videoId) {
    const introSkipSec = typeof msg.introSkip === "number" ? msg.introSkip : DEFAULT_INTRO_SKIP_SEC;
    const windowSec = typeof msg.windowSec === "number" ? msg.windowSec : DEFAULT_WINDOW_SEC;
    fetchPeak(msg.videoId, introSkipSec, windowSec)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, peakSeconds: null, hasHeatmap: false }));
    return true; // keep the message channel open for the async response
  }
  return false;
});
