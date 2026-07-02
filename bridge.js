// Isolated-world bridge: the only script here with chrome.* access.
// Relays traffic between the main-world player script, the background worker,
// and (for dual-tab DJ) the other YT Music tab.

const NS = "ytdj";
const DEFAULTS = {
  segMin: 40,
  segMax: 70,
  overlap: 5,
  volume: 100,
  lastSeed: "",
  fx: {
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
  }
};
const EXEC_TIMEOUT_MS = 8000;

// After the extension is reloaded/updated, content scripts already injected in
// open tabs are orphaned: chrome.* calls throw "Extension context invalidated".
// Nothing can recover in this page load, so guard every call and fail quietly.
function alive() {
  return !!(chrome.runtime && chrome.runtime.id);
}

const pendingExec = new Map(); // execId -> resolve (main-world command results)
let execSeq = 0;

function askMainWorld(kind, payload) {
  return new Promise((resolve) => {
    const execId = `x${++execSeq}`;
    pendingExec.set(execId, resolve);
    window.postMessage({ source: NS, kind, execId, ...payload }, "*");
    setTimeout(() => {
      if (pendingExec.has(execId)) {
        pendingExec.delete(execId);
        resolve({ ok: false, error: "page did not respond" });
      }
    }, EXEC_TIMEOUT_MS);
  });
}

function pushConfig() {
  if (!alive()) return;
  try {
    chrome.storage.sync.get(DEFAULTS, (c) => {
      if (chrome.runtime.lastError) return;
      c.rainUrl = chrome.runtime.getURL("rain.m4a"); // main world can't resolve this itself
      window.postMessage({ source: NS, kind: "config", config: c }, "*");
    });
  } catch (_e) {
    // stale content script; ignore
  }
}

// YT Music's radio queue for a seed song. Fetched from here (not the
// background worker) so the request is same-origin - InnerTube 403s the
// extension origin but accepts the page's own.
async function fetchRadio(videoId) {
  try {
    const res = await fetch("https://music.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB_REMIX", clientVersion: "1.20250101.01.00", hl: "en" } },
        videoId,
        playlistId: "RDAMVM" + videoId,
        params: "wAEB"
      })
    });
    if (!res.ok) return { ok: false, tracks: [], error: "HTTP " + res.status };
    const data = await res.json();
    const tracks = [];
    const seen = new Set();
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.playlistPanelVideoRenderer) {
        const r = node.playlistPanelVideoRenderer;
        const runText = (f) => (f && f.runs && f.runs[0] ? f.runs[0].text : "");
        const title = runText(r.title);
        const artist = runText(r.shortBylineText) || runText(r.longBylineText);
        if (r.videoId && !seen.has(r.videoId)) {
          seen.add(r.videoId);
          tracks.push({ id: r.videoId, title, artist });
        }
      }
      for (const k in node) walk(node[k]);
    })(data);
    return { ok: true, tracks };
  } catch (e) {
    return { ok: false, tracks: [], error: String(e && e.message ? e.message : e) };
  }
}

function sendBg(payload) {
  return new Promise((resolve) => {
    if (!alive()) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        resolve(chrome.runtime.lastError ? null : resp);
      });
    } catch (_e) {
      resolve(null);
    }
  });
}

// main world -> bridge
window.addEventListener("message", async (e) => {
  const d = e.data;
  if (!d || d.source !== NS) return;

  if (d.kind === "peak-request") {
    const resp = await sendBg({
      type: "GET_PEAK",
      videoId: d.videoId,
      introSkip: d.introSkip,
      windowSec: d.windowSec
    });
    window.postMessage(
      {
        source: NS,
        kind: "peak-response",
        reqId: d.reqId,
        peakSeconds: resp && resp.ok ? resp.peakSeconds : null,
        hasHeatmap: !!(resp && resp.hasHeatmap)
      },
      "*"
    );
  } else if (d.kind === "radio-request") {
    const resp = await fetchRadio(d.videoId);
    window.postMessage(
      { source: NS, kind: "radio-response", reqId: d.reqId, tracks: resp.tracks, error: resp.error },
      "*"
    );
  } else if (d.kind === "remote-cmd") {
    // master engine -> background -> other tab
    const resp = await sendBg({ type: "DJ2_RELAY", op: d.op, tabId: d.tabId, cmd: d.cmd, args: d.args });
    window.postMessage(
      { source: NS, kind: "remote-result", reqId: d.reqId, resp: resp || { ok: false, error: "relay failed" } },
      "*"
    );
  } else if (d.kind === "exec-result" || d.kind === "dj2-result") {
    const resolve = pendingExec.get(d.execId);
    if (resolve) {
      pendingExec.delete(d.execId);
      resolve(d.resp);
    }
  } else if (d.kind === "save-seed") {
    if (alive() && d.videoId) {
      try {
        chrome.storage.sync.set({ lastSeed: d.videoId });
      } catch (_e) {}
    }
  } else if (d.kind === "hello") {
    pushConfig();
  }
});

// background / popup -> this tab
if (alive()) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "DJ2_EXEC") {
      askMainWorld("exec", { cmd: msg.cmd, args: msg.args }).then(sendResponse);
      return true;
    }
    const uiKinds = {
      DJ2_START: "dj2-start",
      DJ2_STOP: "dj2-stop",
      DJ2_STATUS: "dj2-status",
      DJ2_SKIP: "dj2-skip",
      DJ2_PLAYNOW: "dj2-playnow",
      DJ2_PAUSE: "dj2-pause",
      DJ2_RESUME: "dj2-resume"
    };
    if (msg && uiKinds[msg.type]) {
      askMainWorld(uiKinds[msg.type], {}).then(sendResponse);
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener(pushConfig);
  pushConfig();
}
