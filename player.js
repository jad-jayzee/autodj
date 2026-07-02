// Main-world script on music.youtube.com. Two roles:
//  1. Dual-tab DJ master: this tab runs the mix engine and crossfades itself
//     against a second YT Music tab for true overlapping transitions.
//  2. Deck slave: executes load/seek/play/volume commands sent by a master tab.
// Talks to the isolated-world bridge via window.postMessage.

(() => {
  const NS = "ytdj";
  const DEBUG = false; // set true for [YTDJ] console diagnostics
  const FALLBACK_FRAC = 0.4; // seek here when a track has no heatmap
  const MIN_SEEK_SEC = 3; // never start at 0 / the very top of a track
  const MAX_VOL = 100;
  const MIN_SEGMENT_MS = 3000;
  const REQUEST_TIMEOUT_MS = 12000;
  const RAMP_MS = 50;
  const PREPARE_TIMEOUT_MS = 15000;
  const RADIO_REFILL_AT = 4;
  const RETRY_TRANSITION_MS = 10000;
  const INTRO_SKIP_SEC = 15; // heatmap: ignore the inflated opening
  const PREROLL_SEC = 4; // start this far before the peak so the drop lands in-segment

  const log = (...a) => {
    if (DEBUG) console.log("[YTDJ]", ...a);
  };

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
  let cfg = {
    segMin: 40,
    segMax: 70,
    overlap: 5,
    volume: 100,
    fx: FX_DEFAULT
  };

  // Rain: decode the bundled file into Web Audio and loop it gaplessly
  // (loopStart/End skip the AAC encoder padding that makes <audio> loops stutter).
  // Its own context, independent of the fx tap; level follows deck volume.
  let rainCtx = null, rainSrc = null, rainGainNode = null, rainReady = false, rainLoading = false;
  async function ensureRain(url) {
    if (rainReady || rainLoading || !url) return;
    rainLoading = true;
    try {
      if (!rainCtx) rainCtx = new AudioContext();
      if (rainCtx.state === "suspended") await rainCtx.resume();
      if (rainCtx.state !== "running") return; // retry later via the guard
      const buf = await fetch(url).then((r) => r.arrayBuffer()).then((a) => rainCtx.decodeAudioData(a));
      rainSrc = rainCtx.createBufferSource();
      rainSrc.buffer = buf;
      rainSrc.loop = true;
      rainSrc.loopStart = 0.05;
      rainSrc.loopEnd = Math.max(0.1, buf.duration - 0.08); // trim padding for a seamless loop
      rainGainNode = rainCtx.createGain();
      rainGainNode.gain.value = 0;
      rainSrc.connect(rainGainNode);
      rainGainNode.connect(rainCtx.destination);
      rainSrc.start();
      rainReady = true;
    } catch (_e) {
      // will retry on the next guard tick
    } finally {
      rainLoading = false;
    }
  }
  function updateRain() {
    if (!rainReady) return;
    const p = player();
    const playing = p && typeof p.getPlayerState === "function" ? p.getPlayerState() === 1 : false;
    const deckVol = videoEl() ? videoEl().volume : 1;
    // only rain when this deck is actually playing and audible (stops on pause/stop)
    const target = fxState.rain.on && playing && deckVol > 0.01 ? Math.min(1, (fxState.rain.val / 100) * 0.85) * deckVol : 0;
    const t = rainCtx.currentTime;
    rainGainNode.gain.cancelScheduledValues(t);
    rainGainNode.gain.setValueAtTime(rainGainNode.gain.value, t);
    rainGainNode.gain.linearRampToValueAtTime(target, t + PARAM_RAMP_S);
  }

  // --- effects rack: taps this tab's audio element and processes it live ------
  const REVERB_SECONDS = 2.8;
  const REVERB_DECAY = 2.0;
  const PARAM_RAMP_S = 0.3;
  const audio = {
    ctx: null, src: null, tappedEl: null,
    bass: null, lp: null, panner: null, dry: null,
    reverbWet: null, echoWet: null, delay: null, lfo: null, lfoDepth: null,
    eqLow: null, eqMid: null, eqHigh: null, wowDelay: null, wowLfo: null, wowDepth: null,
    limiter: null, guard: null, ok: false
  };
  const videoEl = () => document.querySelector("video");
  let fxState = FX_DEFAULT;
  // Effects only apply while this tab is an active DJ deck; otherwise the graph
  // stays flat so normal listening is untouched.
  let fxEnabled = false;
  const effectiveFx = () => (fxEnabled ? cfg.fx || FX_DEFAULT : FX_DEFAULT);

  function makeImpulse(ctx) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(REVERB_SECONDS * rate));
    const ir = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, REVERB_DECAY);
    }
    return ir;
  }

  async function ensureFx() {
    if (audio.ok && audio.tappedEl === videoEl()) return true;
    const el = videoEl();
    if (!el) return false;
    try {
      if (!audio.ctx) audio.ctx = new AudioContext();
      if (audio.ctx.state === "suspended") await audio.ctx.resume();
      if (audio.ctx.state !== "running") {
        log("fx: ctx not running (", audio.ctx.state, ") - click this tab once to activate audio");
        return false;
      }
      const c = audio.ctx;
      audio.src = c.createMediaElementSource(el);
      audio.tappedEl = el;

      audio.bass = c.createBiquadFilter();
      audio.bass.type = "lowshelf";
      audio.bass.frequency.value = 160;
      // 3-band EQ
      audio.eqLow = c.createBiquadFilter();
      audio.eqLow.type = "lowshelf";
      audio.eqLow.frequency.value = 120;
      audio.eqMid = c.createBiquadFilter();
      audio.eqMid.type = "peaking";
      audio.eqMid.frequency.value = 1000;
      audio.eqMid.Q.value = 1;
      audio.eqHigh = c.createBiquadFilter();
      audio.eqHigh.type = "highshelf";
      audio.eqHigh.frequency.value = 7000;
      audio.lp = c.createBiquadFilter();
      audio.lp.type = "lowpass";
      audio.lp.frequency.value = 20000;
      audio.lp.Q.value = 0.2;
      // wow/flutter: an LFO-modulated delay line -> pitch wobble
      audio.wowDelay = c.createDelay(0.05);
      audio.wowDelay.delayTime.value = 0.008;
      audio.wowLfo = c.createOscillator();
      audio.wowLfo.frequency.value = 1.2;
      audio.wowDepth = c.createGain();
      audio.wowDepth.gain.value = 0;
      audio.wowLfo.connect(audio.wowDepth);
      audio.wowDepth.connect(audio.wowDelay.delayTime);
      audio.wowLfo.start();
      audio.panner = c.createStereoPanner();
      // master limiter catches boost/EQ peaks so nothing clips into distortion
      audio.limiter = c.createDynamicsCompressor();
      audio.limiter.threshold.value = -3;
      audio.limiter.knee.value = 0;
      audio.limiter.ratio.value = 20;
      audio.limiter.attack.value = 0.003;
      audio.limiter.release.value = 0.25;
      audio.limiter.connect(c.destination);

      audio.dry = c.createGain();
      audio.dry.gain.value = 1;
      const convolver = c.createConvolver();
      convolver.buffer = makeImpulse(c);
      audio.reverbWet = c.createGain();
      audio.reverbWet.gain.value = 0;
      audio.delay = c.createDelay(1.0);
      audio.delay.delayTime.value = 0.3;
      const fb = c.createGain();
      fb.gain.value = 0.35;
      audio.echoWet = c.createGain();
      audio.echoWet.gain.value = 0;

      // chain: src -> bass -> eq(low/mid/high) -> lp -> wow -> panner -> (dry+reverb+echo)
      audio.src.connect(audio.bass);
      audio.bass.connect(audio.eqLow);
      audio.eqLow.connect(audio.eqMid);
      audio.eqMid.connect(audio.eqHigh);
      audio.eqHigh.connect(audio.lp);
      audio.lp.connect(audio.wowDelay);
      audio.wowDelay.connect(audio.panner);
      audio.panner.connect(audio.dry);
      audio.dry.connect(audio.limiter);
      audio.panner.connect(convolver);
      convolver.connect(audio.reverbWet);
      audio.reverbWet.connect(audio.limiter);
      audio.panner.connect(audio.delay);
      audio.delay.connect(fb);
      fb.connect(audio.delay);
      audio.delay.connect(audio.echoWet);
      audio.echoWet.connect(audio.limiter);

      // 8D auto-pan LFO -> panner.pan
      audio.lfo = c.createOscillator();
      audio.lfo.frequency.value = 0.12;
      audio.lfoDepth = c.createGain();
      audio.lfoDepth.gain.value = 0;
      audio.lfo.connect(audio.lfoDepth);
      audio.lfoDepth.connect(audio.panner.pan);
      audio.lfo.start();

      audio.ok = true;
      log("fx: tapped OK");
      return true;
    } catch (e) {
      log("fx: tap failed", e && e.message);
      audio.ok = false;
      return false;
    }
  }

  function ramp(param, v) {
    const t = audio.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(v, t + PARAM_RAMP_S);
  }

  function applySpeed() {
    const el = videoEl();
    if (!el) return;
    const target = fxState.slowed.on ? fxState.slowed.val / 100 : 1;
    if (Math.abs(el.playbackRate - target) > 0.01) el.playbackRate = target;
  }

  function anyGraphFx() {
    return (
      fxState.reverb.on || fxState.bass.on || fxState.muffle.on ||
      fxState.echo.on || fxState.wide.on || fxState.wow.on ||
      fxState.eqlow.on || fxState.eqmid.on || fxState.eqhigh.on
    );
  }

  async function applyFx(fx) {
    fxState = { ...FX_DEFAULT, ...fx };
    applySpeed(); // playbackRate lives on the element, no graph needed
    startFxGuard();
    // rain is independent of the Web Audio graph, so handle it before the tap
    if (fxState.rain.on && cfg.rainUrl) await ensureRain(cfg.rainUrl);
    updateRain();
    if (anyGraphFx()) await ensureFx();
    if (!audio.ok) return;
    ramp(audio.bass.gain, fxState.bass.on ? (fxState.bass.val / 100) * 10 : 0);
    // logarithmic cutoff so the slider muffles perceptibly across its whole range
    ramp(audio.lp.frequency, fxState.muffle.on ? 20000 * Math.pow(200 / 20000, fxState.muffle.val / 100) : 20000);
    ramp(audio.reverbWet.gain, fxState.reverb.on ? (fxState.reverb.val / 100) * 0.9 : 0);
    ramp(audio.echoWet.gain, fxState.echo.on ? (fxState.echo.val / 100) * 0.6 : 0);
    ramp(audio.lfoDepth.gain, fxState.wide.on ? 0.9 : 0);
    audio.lfo.frequency.setValueAtTime(0.05 + (fxState.wide.val / 100) * 0.3, audio.ctx.currentTime);
    // 3-band EQ: slider 50 = flat, maps to -15..+15 dB
    const eqDb = (s) => (s.on ? ((s.val - 50) / 50) * 15 : 0);
    ramp(audio.eqLow.gain, eqDb(fxState.eqlow));
    ramp(audio.eqMid.gain, eqDb(fxState.eqmid));
    ramp(audio.eqHigh.gain, eqDb(fxState.eqhigh));
    // wow/flutter: depth up to ~3.5ms, rate slides from slow wow to fast flutter
    ramp(audio.wowDepth.gain, fxState.wow.on ? (fxState.wow.val / 100) * 0.0035 : 0);
    audio.wowLfo.frequency.setValueAtTime(0.8 + (fxState.wow.val / 100) * 6, audio.ctx.currentTime);
  }

  function startFxGuard() {
    if (audio.guard) return;
    setInterval(updateRain, 300); // responsive rain gating on pause / volume
    audio.guard = setInterval(async () => {
      if (audio.ctx && audio.ctx.state === "suspended") {
        try {
          await audio.ctx.resume();
        } catch (_e) {}
      }
      applySpeed(); // YT resets playbackRate on each new track
      if (rainCtx && rainCtx.state === "suspended") {
        try {
          await rainCtx.resume();
        } catch (_e) {}
      }
      if (fxState.rain.on && !rainReady && cfg.rainUrl) await ensureRain(cfg.rainUrl);
      updateRain(); // track deck volume + play state
      if (anyGraphFx() && !audio.ok && (await ensureFx())) applyFx(fxState);
    }, 1500);
  }
  let targetVol = MAX_VOL;
  const pendingPeak = new Map();
  const pendingRadio = new Map();
  const pendingRemote = new Map();
  let reqSeq = 0;

  const player = () => document.getElementById("movie_player");

  function ready() {
    const p = player();
    return !!(p && typeof p.getVideoData === "function" && typeof p.seekTo === "function");
  }

  function randomSegmentMs() {
    const lo = Math.min(cfg.segMin, cfg.segMax);
    const hi = Math.max(cfg.segMin, cfg.segMax);
    const sec = lo + Math.random() * (hi - lo);
    return Math.max(MIN_SEGMENT_MS, sec * 1000);
  }

  function clampSeek(seekTarget, dur) {
    let s = Math.max(MIN_SEEK_SEC, seekTarget);
    if (dur) {
      const maxSeg = Math.max(cfg.segMin, cfg.segMax);
      s = Math.min(s, Math.max(MIN_SEEK_SEC, dur - maxSeg - 1));
    }
    return s;
  }

  // --- bridge round-trips -----------------------------------------------------
  function bridgeRequest(kind, payload, pending, timeoutValue) {
    return new Promise((resolve) => {
      const reqId = `${NS}${++reqSeq}`;
      pending.set(reqId, resolve);
      window.postMessage({ source: NS, kind, reqId, ...payload }, "*");
      setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          resolve(timeoutValue);
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }

  function requestPeak(videoId) {
    return bridgeRequest(
      "peak-request",
      { videoId, introSkip: INTRO_SKIP_SEC, windowSec: Math.min(cfg.segMin, cfg.segMax) },
      pendingPeak,
      { peakSeconds: null, hasHeatmap: false }
    );
  }

  function requestRadio(videoId) {
    return bridgeRequest("radio-request", { videoId }, pendingRadio, { tracks: [] });
  }

  function remote(op, tabId, cmd, args) {
    return bridgeRequest("remote-cmd", { op, tabId, cmd, args }, pendingRemote, {
      ok: false,
      error: "relay timeout"
    });
  }

  function saveSeed(videoId) {
    if (videoId) window.postMessage({ source: NS, kind: "save-seed", videoId }, "*");
  }

  // =============================================================================
  // Deck slave: execute commands from a master tab
  // =============================================================================
  function execCommand(cmd, args) {
    const p = player();
    if (!p) return { ok: false, error: "no player" };
    try {
      switch (cmd) {
        case "status": {
          const d = typeof p.getVideoData === "function" ? p.getVideoData() : null;
          return {
            ok: true,
            videoId: d && d.video_id ? d.video_id : null,
            title: d && d.title ? d.title : "",
            artist: d && d.author ? d.author : "",
            state: typeof p.getPlayerState === "function" ? p.getPlayerState() : -1,
            t: typeof p.getCurrentTime === "function" ? p.getCurrentTime() : 0,
            d: typeof p.getDuration === "function" ? p.getDuration() : 0
          };
        }
        case "load":
          if (typeof p.loadVideoById !== "function") return { ok: false, error: "no loadVideoById" };
          p.loadVideoById(args.videoId);
          return { ok: true };
        case "seek":
          p.seekTo(args.s, true);
          return { ok: true };
        case "play":
          p.playVideo();
          return { ok: true };
        case "pause":
          p.pauseVideo();
          return { ok: true };
        case "setVolume":
          p.setVolume(args.v);
          if (args.v > 0 && typeof p.unMute === "function") p.unMute();
          return { ok: true };
        case "fx":
          fxEnabled = !!args.on;
          applyFx(effectiveFx());
          return { ok: true };
        default:
          return { ok: false, error: "unknown cmd " + cmd };
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  // =============================================================================
  // Dual-tab DJ master engine
  // =============================================================================
  const dj2 = {
    active: false,
    slaveTab: null,
    queue: [],
    qi: 0,
    played: new Set(),
    titles: new Map(), // videoId -> {title, artist} (from radio queue)
    lastPlayed: null,
    live: "self", // "self" | "remote"
    standbyReady: false,
    standbyId: null,
    preparing: false,
    segTimer: null,
    rampTimer: null,
    // segment progress (until the transition fires)
    segStartAt: 0,
    segRunMs: 0,
    paused: false,
    pausedRemainMs: 0,
    blendUntil: 0
  };

  function selfExec(cmd, args) {
    return Promise.resolve(execCommand(cmd, args || {}));
  }
  function slaveExec(cmd, args) {
    return remote("exec", dj2.slaveTab, cmd, args || {});
  }
  function deckExec(which, cmd, args) {
    return which === "self" ? selfExec(cmd, args) : slaveExec(cmd, args);
  }

  async function waitDeck(which, pred, timeoutMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const st = await deckExec(which, "status");
      if (st && st.ok && pred(st)) return st;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  function dj2NextId() {
    if (dj2.qi >= dj2.queue.length) return null;
    const id = dj2.queue[dj2.qi++];
    dj2.played.add(id);
    dj2.lastPlayed = id;
    return id;
  }

  function dj2Absorb(tracks) {
    for (const t of tracks || []) dj2.titles.set(t.id, { title: t.title || "", artist: t.artist || "" });
    return (tracks || []).map((t) => t.id).filter((id) => !dj2.played.has(id) && !dj2.queue.includes(id));
  }

  async function dj2Refill() {
    if (dj2.queue.length - dj2.qi > RADIO_REFILL_AT) return;
    const resp = await requestRadio(dj2.lastPlayed);
    const fresh = dj2Absorb(resp.tracks);
    dj2.queue.push(...fresh);
    log("dj2 radio refill:", fresh.length, "new, queue ahead:", dj2.queue.length - dj2.qi);
  }

  async function dj2SeekSpot(videoId, dur) {
    const resp = await requestPeak(videoId);
    let s;
    if (resp.hasHeatmap && resp.peakSeconds != null) s = resp.peakSeconds - PREROLL_SEC;
    else s = dur ? dur * FALLBACK_FRAC : 60;
    return clampSeek(s, dur || 0);
  }

  async function dj2PrepareStandby() {
    if (dj2.preparing) return;
    dj2.preparing = true;
    try {
      dj2.standbyReady = false;
      await dj2Refill();
      const id = dj2NextId();
      if (!id) {
        log("dj2: queue empty, cannot prepare standby");
        return;
      }
      dj2.standbyId = id;
      const standby = dj2.live === "self" ? "remote" : "self";
      await deckExec(standby, "setVolume", { v: 0 });
      // load + nudge play, retrying: a freshly created deck tab may ignore the
      // first autoplay until Chrome grants it (foregrounding handles this).
      let st = null;
      for (let attempt = 0; attempt < 3 && !st; attempt++) {
        const load = await deckExec(standby, "load", { videoId: id });
        if (!load || !load.ok) {
          log("dj2: standby load failed", load && load.error);
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        await deckExec(standby, "play");
        st = await waitDeck(standby, (s) => s.videoId === id && s.state === 1, 8000);
      }
      if (!st) {
        log("dj2: standby never started playing - click the other YT Music tab once to activate it");
        return;
      }
      if (st.title) {
        const known = dj2.titles.get(id) || { title: "", artist: "" };
        dj2.titles.set(id, { title: st.title, artist: st.artist || known.artist });
      }
      const seek = await dj2SeekSpot(id, st.d);
      await deckExec(standby, "seek", { s: seek });
      await deckExec(standby, "pause");
      dj2.standbyReady = true;
      log(`dj2: standby [${standby}] ready: ${st.title || id} @ ${seek.toFixed(1)}s`);
    } finally {
      dj2.preparing = false;
    }
  }

  function dj2Crossfade(fromDeck, toDeck, seconds) {
    return new Promise((resolve) => {
      clearInterval(dj2.rampTimer);
      const t0 = performance.now();
      const dur = Math.max(200, seconds * 1000);
      dj2.rampTimer = setInterval(() => {
        const t = Math.min(1, (performance.now() - t0) / dur);
        const a = Math.cos((t * Math.PI) / 2);
        const b = Math.sin((t * Math.PI) / 2);
        deckExec(fromDeck, "setVolume", { v: Math.round(a * a * targetVol) });
        deckExec(toDeck, "setVolume", { v: Math.round(b * b * targetVol) });
        if (t >= 1) {
          clearInterval(dj2.rampTimer);
          dj2.rampTimer = null;
          resolve();
        }
      }, RAMP_MS);
    });
  }

  async function dj2Transition() {
    if (!dj2.active) return;
    if (dj2.paused) {
      // "Play next now" while paused: bring the live deck back first
      dj2.paused = false;
      await deckExec(dj2.live, "play");
    }
    if (!dj2.standbyReady) {
      log("dj2: standby not ready, retrying shortly");
      dj2PrepareStandby();
      dj2.segTimer = setTimeout(dj2Transition, RETRY_TRANSITION_MS);
      return;
    }
    const from = dj2.live;
    const to = from === "self" ? "remote" : "self";
    await deckExec(to, "play");
    await waitDeck(to, (s) => s.state === 1, 4000);
    if (!dj2.active) return;
    // new song is audible now: flip live, start its clock, mark the blend window
    dj2.live = to;
    dj2.blendUntil = Date.now() + cfg.overlap * 1000;
    dj2Schedule();
    await dj2Crossfade(from, to, cfg.overlap);
    if (!dj2.active) return;
    await deckExec(from, "pause");
    saveSeed(dj2.standbyId); // remember the now-playing song for resume
    dj2PrepareStandby();
  }

  function dj2Schedule() {
    clearTimeout(dj2.segTimer);
    // full time this song stays live, from becoming audible to its out-crossfade
    dj2.segRunMs = Math.max((cfg.overlap + 8) * 1000, randomSegmentMs());
    dj2.segStartAt = Date.now();
    dj2.paused = false;
    dj2.segTimer = setTimeout(dj2Transition, dj2.segRunMs);
  }

  function dj2Pause() {
    if (!dj2.active || dj2.paused) return { ok: true };
    clearTimeout(dj2.segTimer);
    dj2.pausedRemainMs = Math.max(0, dj2.segStartAt + dj2.segRunMs - Date.now());
    dj2.paused = true;
    deckExec(dj2.live, "pause");
    log("dj2: paused,", Math.round(dj2.pausedRemainMs / 1000) + "s of segment left");
    return { ok: true };
  }

  function dj2Resume() {
    if (!dj2.active || !dj2.paused) return { ok: true };
    dj2.paused = false;
    dj2.segStartAt = Date.now() - (dj2.segRunMs - dj2.pausedRemainMs);
    deckExec(dj2.live, "play");
    clearTimeout(dj2.segTimer);
    dj2.segTimer = setTimeout(dj2Transition, dj2.pausedRemainMs);
    log("dj2: resumed");
    return { ok: true };
  }

  async function dj2Start() {
    if (dj2.active) return { ok: true, note: "already running" };
    const p = player();
    if (!ready()) return { ok: false, error: "no player in this tab" };
    const data = p.getVideoData();
    let seed = data && data.video_id;
    // resume: if nothing is playing, pick up from the last remembered song
    if (!seed && cfg.lastSeed) {
      if (typeof p.loadVideoById === "function") p.loadVideoById(cfg.lastSeed);
      const st = await waitDeck("self", (s) => s.videoId === cfg.lastSeed && s.state === 1, 10000);
      seed = (st && st.videoId) || cfg.lastSeed;
    }
    if (!seed) return { ok: false, error: "play a song first, then start the DJ" };
    saveSeed(seed);

    targetVol = typeof cfg.volume === "number" ? cfg.volume : MAX_VOL;
    selfExec("fx", { on: true }); // effects on for this deck

    log("dj2: starting, seed", seed);
    const ens = await remote("ensure", null, null, null);
    if (!ens || !ens.ok) return { ok: false, error: "could not open second YT Music tab: " + (ens && ens.error) };
    dj2.slaveTab = ens.tabId;
    log("dj2: deck tab", dj2.slaveTab, ens.created ? "(created)" : "(existing)");

    dj2.queue = [];
    dj2.qi = 0;
    dj2.played.clear();
    dj2.titles.clear();
    dj2.played.add(seed);
    const radio = await requestRadio(seed);
    const ids = dj2Absorb(radio.tracks);
    if (ids.length < 2) return { ok: false, error: "could not build radio queue: " + (radio.error || "empty") };

    dj2.queue = ids;
    dj2.lastPlayed = seed;
    dj2.live = "self";
    dj2.standbyReady = false;
    dj2.standbyId = null;
    dj2.active = true;

    // current song: jump to its best part right away
    const dur = typeof p.getDuration === "function" ? p.getDuration() : 0;
    const seek = await dj2SeekSpot(seed, dur);
    p.seekTo(seek, true);
    p.setVolume(targetVol);
    if (typeof p.playVideo === "function") p.playVideo();
    log("dj2: live [self]", (data.title || seed) + " @ " + seek.toFixed(1) + "s, queue " + dj2.queue.length);

    // respond to the popup immediately; finish setup in the background.
    // We intentionally leave focus on the newly created deck tab - keeping it
    // foregrounded is what lets Chrome autoplay it; jumping back to master
    // de-activates it and the standby can't start.
    (async () => {
      if (ens.created) await waitDeck("remote", (s) => !!s, 20000);
      if (!dj2.active) return;
      slaveExec("fx", { on: true }); // effects on for the other deck
      dj2Schedule();
      dj2PrepareStandby();
    })();
    return { ok: true };
  }

  async function dj2Snapshot() {
    if (!dj2.active) return { active: false };
    const meta = (id) => dj2.titles.get(id) || { title: "", artist: "" };
    const self = execCommand("status", {});
    let remoteSt = null;
    if (dj2.slaveTab != null) {
      const r = await slaveExec("status");
      if (r && r.ok) remoteSt = r;
    }
    const elapsed = dj2.paused
      ? dj2.segRunMs - dj2.pausedRemainMs
      : Math.min(dj2.segRunMs, Date.now() - dj2.segStartAt);
    // fill title/artist from the radio metadata while a deck's player title
    // is still loading (avoids briefly flashing the raw video id)
    const enrich = (st) => {
      if (!st || !st.ok || !st.videoId) return null;
      const m = meta(st.videoId);
      return { videoId: st.videoId, title: st.title || m.title || "", artist: st.artist || m.artist || "" };
    };
    return {
      active: true,
      live: dj2.live,
      paused: dj2.paused,
      blending: Date.now() < dj2.blendUntil,
      seg: { totalMs: dj2.segRunMs, elapsedMs: Math.max(0, elapsed) },
      self: enrich(self),
      remote: enrich(remoteSt),
      standby: dj2.standbyId ? { id: dj2.standbyId, ...meta(dj2.standbyId), ready: dj2.standbyReady } : null
    };
  }

  function dj2SkipNext() {
    if (!dj2.active) return { ok: false, error: "not running" };
    if (dj2.preparing) return { ok: false, error: "busy preparing, try again in a moment" };
    log("dj2: skip requested, replacing standby");
    dj2PrepareStandby();
    return { ok: true };
  }

  function dj2PlayNow() {
    if (!dj2.active) return { ok: false, error: "not running" };
    if (!dj2.standbyReady) return { ok: false, error: "next track still loading" };
    log("dj2: instant transition requested");
    clearTimeout(dj2.segTimer);
    dj2Transition();
    return { ok: true };
  }

  async function dj2Stop() {
    if (!dj2.active) return { ok: true };
    dj2.active = false;
    dj2.paused = false;
    clearTimeout(dj2.segTimer);
    clearInterval(dj2.rampTimer);
    dj2.segTimer = null;
    dj2.rampTimer = null;
    selfExec("fx", { on: false }); // clear effects from normal listening
    slaveExec("fx", { on: false });
    selfExec("pause");
    selfExec("setVolume", { v: targetVol });
    // close the second deck tab (also silences it)
    if (dj2.slaveTab != null) {
      remote("close", dj2.slaveTab, null, null);
      dj2.slaveTab = null;
    }
    log("dj2: stopped");
    return { ok: true };
  }

  // =============================================================================
  // config + message wiring
  // =============================================================================
  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || d.source !== NS) return;

    if (d.kind === "peak-response") {
      const r = pendingPeak.get(d.reqId);
      if (r) {
        pendingPeak.delete(d.reqId);
        r({ peakSeconds: d.peakSeconds, hasHeatmap: d.hasHeatmap });
      }
    } else if (d.kind === "radio-response") {
      const r = pendingRadio.get(d.reqId);
      if (r) {
        pendingRadio.delete(d.reqId);
        r({ tracks: d.tracks, error: d.error });
      }
    } else if (d.kind === "remote-result") {
      const r = pendingRemote.get(d.reqId);
      if (r) {
        pendingRemote.delete(d.reqId);
        r(d.resp);
      }
    } else if (d.kind === "config") {
      cfg = { ...cfg, ...d.config };
      applyFx(effectiveFx());
      // master volume: retarget the mix and set the live deck immediately
      if (typeof cfg.volume === "number" && dj2.active) {
        targetVol = cfg.volume;
        if (!dj2.blending && !dj2.paused) deckExec(dj2.live, "setVolume", { v: targetVol });
      }
    } else if (d.kind === "exec") {
      // slave role: run the command, report back to the bridge
      const resp = execCommand(d.cmd, d.args || {});
      window.postMessage({ source: NS, kind: "exec-result", execId: d.execId, resp }, "*");
    } else if (d.kind === "dj2-start") {
      const resp = await dj2Start();
      window.postMessage({ source: NS, kind: "dj2-result", execId: d.execId, resp }, "*");
    } else if (d.kind === "dj2-stop") {
      const resp = await dj2Stop();
      window.postMessage({ source: NS, kind: "dj2-result", execId: d.execId, resp }, "*");
    } else if (d.kind === "dj2-status") {
      const resp = await dj2Snapshot();
      window.postMessage({ source: NS, kind: "dj2-result", execId: d.execId, resp }, "*");
    } else if (d.kind === "dj2-skip") {
      window.postMessage({ source: NS, kind: "dj2-result", execId: d.execId, resp: dj2SkipNext() }, "*");
    } else if (d.kind === "dj2-playnow") {
      window.postMessage({ source: NS, kind: "dj2-result", execId: d.execId, resp: dj2PlayNow() }, "*");
    } else if (d.kind === "dj2-pause") {
      window.postMessage({ source: NS, kind: "dj2-result", execId: d.execId, resp: dj2Pause() }, "*");
    } else if (d.kind === "dj2-resume") {
      window.postMessage({ source: NS, kind: "dj2-result", execId: d.execId, resp: dj2Resume() }, "*");
    }
  });

  window.postMessage({ source: NS, kind: "hello" }, "*");
})();
