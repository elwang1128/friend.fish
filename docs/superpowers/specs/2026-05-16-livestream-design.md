# Livestream subscriber — design

**Date:** 2026-05-16
**Status:** Approved (pending user review of this written spec)
**Topic:** Replace the "livestream coming soon" placeholder in `public/index.html` with a live video subscriber for the camera feed already being published to Cloudflare's MoQ relay (`relay.cloudflare.mediaoverquic.com`) via `hang publish`. Video only, viewer-public, no audio, no controls beyond click-to-fullscreen.

---

## Background

The camera publishes via:

```
ffmpeg -rtsp_transport tcp -i 'rtsps://<console-ip>:7441/<token>?enableSrtp' \
  -c:v copy -c:a aac \
  -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof - \
  | hang publish https://relay.cloudflare.mediaoverquic.com/friend.fish/tank
```

The frontend (`public/index.html` lines 485–495) currently shows a static placeholder inside a 16:10 dashed-border box: a fish emoji, the headline "livestream coming soon", a subtitle, and a row of seven floating bubble divs (the bubbles loader from commit `0e476dc`). The CSS for a `LIVE` pill (`.feed-label` + `.live-dot` at lines 62–70) is already defined but unused.

The site is one vanilla HTML file served by a Hono Cloudflare Worker, with inline `<style>` and `<script>`. There is no bundler, no TypeScript, no JS framework.

## Goals

1. Render the live MoQ broadcast `friend.fish/tank` in place of the placeholder, keeping the 16:10 box and the existing visual frame.
2. Reuse the existing bubbles loader and headline markup as the "connecting / offline" overlay state.
3. Show a `LIVE` pill in the corner of the box only while frames are flowing.
4. Click-to-fullscreen the video.
5. Reconnect automatically if the publisher restarts or the connection drops.
6. Ship with no new build tooling — load the subscriber library from a CDN as ESM.

## Non-goals

- **No audio.** The publisher includes an `-c:a aac` track today, but the subscriber will ignore audio entirely (no decoder, no `<audio>`, no volume UI). If audio is ever wanted later, it's a small addition.
- **No control overlay.** No pause, no volume, no quality selector, no stats. The `<moq-watch-ui>` SolidJS overlay is explicitly skipped.
- **No DVR / recording / scrub.** Live only.
- **No viewer count, no chat, no presence.**
- **No auth gating on the viewer.** Anyone visiting the site can watch — matches the rest of the page (viewing public, editing owner-only).
- **No automated tests.** The site has none today; manual smoke is the verification path.
- **No bundler, no npm dep added to `package.json`.** The library loads from a jsDelivr `+esm` URL pinned to a major version.
- **No changes to the Worker (`src/worker.js`).** This is a pure frontend change.

## Library choice

`@moq/watch` from the `moq-dev/moq` monorepo (the open-source MoQ TypeScript stack the user's `hang publish` CLI is built on). Ships a Web Component plus a JS API.

Loaded via:

```js
import "https://cdn.jsdelivr.net/npm/@moq/watch@0.2/element.js/+esm";
```

Pin to a major-version range (e.g. `@0.2`) — pre-1.0 means minor bumps can break, so we lock the major. jsDelivr's `+esm` rewrites bare imports (`@moq/lite`, `@moq/hang`, `@moq/signals`) into sibling `+esm` URLs so a single `<script type="module">` is enough.

The element registers `<moq-watch>` as a custom element. Observed attributes (verified by reading `js/watch/src/element.ts` in `moq-dev/moq`): `url`, `name`, `paused`, `volume`, `muted`, `reload`, `latency`, `jitter`, `catalog-format`. (The package README mistakenly documents `path` instead of `name`; the source is authoritative.)

The element also exposes JS-accessible signal-based state: `element.broadcast.video.media` (a `Signal<MediaStream | undefined>`) and `element.connection.established`, both backed by `@moq/signals`'s `Signal`/`Effect` primitives.

## Architecture

```
Browser ──► friend.fish (Cloudflare Worker, static asset)
   │
   ▼
public/index.html
   │
   ├─ <script type="module" src="...@moq/watch@0.2/element.js/+esm">
   │      registers <moq-watch> custom element
   │
   └─ <div class="feed-placeholder">           (box + dashed border, 16:10)
        ├─ <moq-watch url="..." name="friend.fish/tank" muted>
        │     <canvas></canvas>                (filled by WebCodecs decoder)
        │  </moq-watch>
        ├─ <span class="live-pill">…</span>    (shown when live)
        └─ <div class="feed-overlay">          (shown when not-live)
             fish emoji + headline + bubbles loader
             (same DOM as today's placeholder)
```

The `<moq-watch>` element opens a WebTransport connection to the relay, subscribes to the broadcast catalog at `friend.fish/tank`, and renders decoded video frames into the child `<canvas>`. When the publisher is offline, no frames arrive and `broadcast.video.media` stays `undefined`.

## Files changed

Single file: `public/index.html`.

- **Edit** the `<style>` block: add rules for `.feed-placeholder moq-watch`, `.feed-placeholder canvas`, `.feed-overlay`, `.live-pill`, and a small visibility toggle (`.feed-placeholder.is-live .feed-overlay { display: none; }`). Touch `.feed-placeholder` to remove or adjust the dashed border so it doesn't look broken behind live video.
- **Edit** the markup inside `<div class="feed-placeholder">` (lines 487–494) to the structure shown in *Architecture* above.
- **Add** a `<script type="module">` that imports the element module and wires up the online/offline state toggle.

No new files. No worker changes.

## Subscription parameters

| Attribute | Value |
|---|---|
| `url` | `https://relay.cloudflare.mediaoverquic.com/` |
| `name` | `friend.fish/tank` |
| `muted` | (set, defensive — no audio decoder requested but the element defaults to audio on) |

The split between `url` (relay root) and `name` (path under the relay) is equivalent to the publisher's full URL `https://relay.cloudflare.mediaoverquic.com/friend.fish/tank`; moq-lite concatenates the URL path and the broadcast name to form the announced path.

Both values are hardcoded as attributes on the element. No env var, no template substitution — the worker doesn't see this file at build time.

## State machine

Three visible states for the `.feed-placeholder` box:

| State | Trigger | Visible elements |
|---|---|---|
| `connecting` | Initial load; WebTransport not yet established or catalog not yet received | overlay visible, bubbles animating, headline "connecting…" |
| `live` | `element.broadcast.video.media` produces a non-null `MediaStream` | canvas visible, `LIVE` pill visible, overlay hidden |
| `offline` | Connection established but no broadcast announced; or a previously-live broadcast went away (`media` flips back to `undefined`) | overlay visible, bubbles animating, headline "stream offline" |

A single CSS class on `.feed-placeholder` drives the visibility:

- `.feed-placeholder` (no extra class) → overlay shown, pill hidden — covers both `connecting` and `offline`.
- `.feed-placeholder.is-live` → overlay hidden, pill shown.

The two text strings ("connecting…" vs "stream offline") differ only in copy; a single inline `<span>` inside the overlay holds the text and is updated by the wiring script. Distinction:

- If we've never seen `media` non-null since page load → "connecting…"
- If we saw it non-null at some point and it's now null → "stream offline"

A simple boolean `everLive` in the script captures this.

## Online/offline detection

The element exposes signals via `@moq/signals`. The wiring script uses the `Effect` class (re-exported from the element) to subscribe:

```js
const el = document.querySelector('moq-watch');
const box = document.querySelector('.feed-placeholder');
const text = box.querySelector('.feed-overlay-text');

let everLive = false;
el.signals.run((effect) => {
  const stream = effect.get(el.broadcast.video.media);
  const live = !!stream;
  if (live) everLive = true;
  box.classList.toggle('is-live', live);
  text.textContent = live
    ? ''
    : (everLive ? 'stream offline' : 'connecting…');
});
```

`el.signals` is the element's own `Effect` instance (exposed on the class per `element.ts`), so the subscription is cleaned up automatically when the element is removed from the DOM.

If the `broadcast.video.media` path turns out to be wrong at implementation time (the source file is the spec, but library internals may shift), the fallback signals to try are `element.broadcast.catalog` (non-null when a catalog has been received from the relay) and `element.connection.established` (non-null when the WebTransport session is up). The state-machine logic is identical regardless of which signal drives it.

## Layout and aspect

The placeholder box stays `aspect-ratio: 16/10` and `width: 100%` (existing rules at lines 72–77). The 16:9 source video is letterboxed inside the box with thin black bars top/bottom — visually acceptable, matches the existing frame, and avoids a layout shift when the stream comes online.

Canvas styles:

```css
.feed-placeholder moq-watch {
  position: absolute; inset: 0;
  display: block; width: 100%; height: 100%;
}
.feed-placeholder canvas {
  display: block; width: 100%; height: 100%;
  object-fit: contain; background: #000;
}
```

`object-fit: contain` on a canvas is a no-op for the drawn pixels (the element sizes internally), but the property is harmless. Black background fills the letterbox bars.

The overlay (`.feed-overlay`) keeps the existing fish-icon + headline + bubbles markup, positioned absolutely on top:

```css
.feed-overlay {
  position: absolute; inset: 0; z-index: 2;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 1rem; pointer-events: none;
}
.feed-placeholder.is-live .feed-overlay { display: none; }
```

`pointer-events: none` so clicks pass through to the canvas for fullscreen.

The dashed border on `.feed-placeholder` (line 74) is kept — it frames both states identically and the dashed style reads as "tank window" rather than "broken image." If it looks wrong with live video behind it, drop to a solid 1.5px border in a follow-up.

## `LIVE` pill

Reuse the existing CSS classes `.feed-label` and `.live-dot` (lines 62–70 of the existing stylesheet) — they're already defined for exactly this purpose and were left over from earlier iterations. Markup:

```html
<span class="live-pill"><span class="live-dot"></span>LIVE</span>
```

`.live-pill` is the pill itself; it inherits look from `.feed-label` but positions absolutely:

```css
.live-pill {
  position: absolute; top: 0.75rem; left: 0.75rem; z-index: 3;
  display: none;
  /* visual: same as .feed-label */
  align-items: center; gap: 0.4rem;
  background: var(--black); color: var(--white);
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; padding: 0.35rem 0.75rem; border-radius: 100px;
}
.feed-placeholder.is-live .live-pill { display: inline-flex; }
```

Practically, `.live-pill` duplicates `.feed-label`'s declarations rather than `@extend`-ing them — the project uses plain CSS, so the cleaner option is one self-contained rule. The existing `.feed-label` rule can be deleted as part of this change since nothing else uses it (verify with a grep before deleting).

## Click-to-fullscreen

```js
box.addEventListener('click', () => {
  if (!box.classList.contains('is-live')) return;
  const target = el.querySelector('canvas') ?? el;
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    target.requestFullscreen?.();
  }
});
```

Only fires when live. On iOS Safari `requestFullscreen` doesn't exist on canvas; the optional-chained call simply no-ops there. (iOS Safari fullscreen for non-`<video>` elements is generally not supported. Acceptable — desktop/Android get fullscreen; iOS users get the inline view.)

Cursor state:

```css
.feed-placeholder.is-live { cursor: pointer; }
```

## Reconnection

`<moq-watch>` uses `Moq.Connection.Reload` internally (verified in `element.ts` constructor) — the connection auto-reconnects with backoff on drop. No manual retry button. If the publisher restarts, the subscriber catches the new broadcast within the reconnect window (a few seconds in practice) and the overlay toggles automatically via the signal-driven state machine.

## Browser support

`<moq-watch>` requires:

- **WebTransport** — Chrome/Edge 97+, Firefox 114+, Safari 18+. Not supported on iOS Safari < 18.
- **WebCodecs** — Chrome/Edge 94+, Safari 16.4+, Firefox 130+. Reasonable coverage in mid-2026.

On unsupported browsers the canvas stays blank and the overlay stays in `connecting…` forever. That's a silent degradation; an explicit "your browser can't play this stream" message is out of scope for this spec but would be a small follow-up.

## Testing

Manual smoke after deploy:

1. **Publisher offline, page load.** Box shows bubbles + "connecting…". After ~2–3s with no announcement, it should still read "connecting…" (the script can't distinguish "no announcement yet" from "connection still establishing" with the chosen signal; this is fine — see *Open questions*).
2. **Start publisher.** Within ~2s of `hang publish` starting, the canvas should fill with video and the `LIVE` pill should appear.
3. **Stop publisher.** Within the reconnect/timeout window (~5s), the overlay should reappear with copy "stream offline".
4. **Restart publisher.** The overlay should disappear again and the canvas fill, with no page reload.
5. **Click the box while live.** Canvas goes fullscreen on Chrome/Firefox desktop. Press Esc to exit.
6. **Mobile (Android Chrome).** Same flow; fullscreen tap works.
7. **Mobile (iOS Safari 18+).** Video plays inline; clicks are harmless no-ops on fullscreen.
8. **DevTools network tab during a live session.** Should show a single WebTransport session to `relay.cloudflare.mediaoverquic.com` and nothing else new.
9. **Owner-only UI unaffected.** `body.is-owner` toggling still shows/hides the add-feed button; the livestream change doesn't touch that path.

Rollback: `git revert <merge-commit>` restores the placeholder.

## Risks

- **Library API drift.** `@moq/watch` is pre-1.0 (currently `0.x`). Pinning to a major (`@0.2`) protects against breaking changes between minor versions, but a future bump will require code review of the new shape of `broadcast.video.media` and the observed attributes. Mitigation: the major-pin in the CDN URL.
- **README/source disagreement.** The `@moq/watch` README documents `path=` and `<canvas>` as required; the actual source (`element.ts`) uses `name=` and accepts either `<canvas>` or `<video>` as the child. We follow the source. If the source itself changes between read-time and ship-time, the spec needs a re-check.
- **CDN availability.** jsDelivr is reliable but not under our control. If it 503s, the page renders without the subscriber (overlay stays visible — graceful degradation). A self-hosted bundle copy in `public/` is an option but adds maintenance; defer.
- **WebTransport on corporate networks.** Some firewalls block QUIC/UDP. Users behind those see the overlay forever. Out of scope to mitigate — the protocol's nature.
- **Letterbox bars** if the camera ever produces non-16:9 output. The 16:10 box accommodates 16:9 cleanly; aspect ratios outside `16:9..16:10` would look worse. The Unifi camera doesn't change aspect at runtime, so this is theoretical.
- **`broadcast.video.media` signal path.** Verified by reading `js/watch/src/element.ts` but not by running the code. If the path is wrong at implementation time, fall back to `broadcast.catalog` or `connection.established` (logic identical).

## Open questions

- **"Connecting" vs "offline" copy on cold load.** We can't reliably distinguish "publisher offline" from "still handshaking" in the first ~2s using the chosen signal alone — both states have `media === undefined`. The current design keeps the copy at "connecting…" until the first frame ever arrives, then switches to "stream offline" on subsequent disconnects. Alternative: add a 5s grace timer that flips to "stream offline" if no frame arrives. Pick during implementation; trivial to swap.

---

(End of spec.)
