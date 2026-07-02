# AutoDJ for YouTube Music

by [Jad](https://github.com/jad-jayzee) · v1.0.0


**Plays the best part of every song and smoothly blends into the next - like
your own nonstop DJ.**

A Chrome extension (MV3) for YouTube Music: it finds the most-replayed moment
(the hook / drop) of each track, plays it, and crossfades into the next song
while an endless radio queue keeps the vibe going. Optional live effects
(slowed, reverb, lo-fi, 8D, and more). Runs on your logged-in account, so
Premium applies (no ads).

## What it does

- Jumps each track to its **Most Replayed peak** (the hook / drop) and plays a
  random segment, then **crossfades** into the next track - both songs audible
  at once, a real blend.
- The queue comes from **YouTube Music's own radio algorithm**, seeded by the
  song you started from and refilled forever.
- A live **effects rack** (Speed, Reverb, Bass, Muffle, Echo, 8D pan, Rain,
  Wow/flutter, 3-band EQ) with mood **presets**, applied to both decks.

## How it works (dual-tab)

One YouTube Music tab can only play one stream, so a true crossfade needs two.
On Start, the extension uses your current tab as **Deck A** and opens a second
YT Music tab as **Deck B** (both pinned, side by side):

- The **master tab** runs the DJ engine: builds the radio queue, preloads the
  next track on the standby deck (cued at its peak, muted), and crossfades the
  two decks by ramping their volumes.
- The **standby deck** is prepared silently while the live deck plays; a
  skeleton "Finding next track" shows until it's ready.
- Focus stays on the newly created Deck B so Chrome grants it audio autoplay.

## Files

- `background.js` - fetches watch pages, parses the Most Replayed heatmap
  (best sustained window), and relays commands between the two deck tabs
  (find/create/close, exec).
- `bridge.js` - isolated-world content script: bridges page <-> background,
  fetches the radio queue same-origin (InnerTube `next`), and persists config
  and the last-played song.
- `player.js` - main-world content script: drives the `movie_player` API, runs
  the dual-tab mix engine, and hosts the Web Audio effects rack (with a master
  limiter so boosts don't clip).
- `popup.*` - deck cards (thumbnail, artist, spinning disc, progress bar),
  transport (pause/play, swap next, play next), master volume, effects rack,
  and presets.
- `rain.m4a` - looped rainfall used by the Rain effect (gapless via Web Audio).

## Usage

Load unpacked via `chrome://extensions` (Developer mode). After any extension
reload, reload all YouTube Music tabs (content scripts orphan otherwise).

1. Play a song on music.youtube.com (this is the seed).
2. Open the extension popup and click **Start DJ**.
3. Keep both YT Music tabs open while mixing.

**Resume:** the last-played song is remembered, so you can come back later,
click **Start DJ** with nothing playing, and it picks up from where you left
off.

If a deck ever stays silent (Chrome autoplay), click that tab once. Effects are
only active while a mix is running, so normal listening stays clean.

## Notes / limitations

- Heatmap and radio parsing use undocumented YouTube structures; they can break
  if YouTube changes them. Personal use only (ToS-grey scraping).
- Tracks without a heatmap fall back to ~40% into the song.
- The radio queue is the anonymous algorithm (not personalized to your history).
- Transitions are time-based equal-power crossfades (no beat-matching).
- Deck tabs load songs via `loadVideoById`, beneath YT Music's own UI, so those
  tabs show a paused/stale title while audio plays correctly.
- `DEBUG` in `player.js` gates `[YTDJ]` console logging (off by default).

## Disclaimer

This is a personal project, not affiliated with, endorsed by, or connected to
YouTube or Google. It reads undocumented internal data and automates playback,
which may be against YouTube's Terms of Service. Use at your own risk, for
personal use only.

## License

MIT - see [LICENSE](LICENSE).
