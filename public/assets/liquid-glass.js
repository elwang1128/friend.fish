// liquid-glass.js — floating "liquid glass" orbs, self-contained drop-in.
// Drop in with <script defer src="/assets/liquid-glass.js"></script>.
// Injects its own <style>, an inline SVG filter block, the orbs, and the
// "air bubbles" toggle. Everything is namespaced lg-*.
//
// Rendering tiers (Safari/iOS is the primary design target, not a fallback):
//   PRIMARY  — Safari desktop, all iOS browsers, Firefox: light backdrop
//              blur (3px) + saturate + brightness, a faint radial gradient
//              to fake lens curvature, and a crisp fresnel rim. Content
//              behind an orb stays clearly readable.
//   ENHANCED — Chromium only (feature-detected): the same light glass plus
//              backdrop-filter: url(#lg-lens-N) — an feDisplacementMap
//              radial lens with subtle per-channel chromatic aberration
//              that refracts the live page content.
//   BASE     — no backdrop-filter at all: translucent gradient orbs with
//              the same rim styling; never breaks the page.
(function () {
  'use strict';

  var STORAGE_KEY = 'lg-bubbles';
  var Z_ORBS = 800; // above overlay panels (500), below lightbox (900)

  var RESTITUTION = 0.9;     // orb-orb bounce softness (1 = billiard-hard)
  var SQUASH_MS = 150;       // squash-and-stretch duration on impact
  var SQUASH_AMOUNT = 0.03;  // scale delta along the collision normal

  // ---- feature detection --------------------------------------------------
  // backdrop-filter: url(#svg) only renders in Chromium. Safari parses it
  // (CSS.supports lies) but paints nothing, so gate the lens on an actual
  // Chromium engine; everyone else gets the primary light-glass tier.
  var hasBackdrop = false;
  try {
    hasBackdrop = CSS.supports('backdrop-filter', 'blur(1px)') ||
                  CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
  } catch (e) { /* very old browser */ }
  var isChromium = !!window.chrome && hasBackdrop && CSS.supports('backdrop-filter', 'url(#lg-lens)');
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  // ---- viewport -----------------------------------------------------------
  // visualViewport tracks the area the user can actually see (iOS URL bar,
  // keyboard), so orbs bounce inside the visible page, not the layout box.
  function viewport() {
    var vv = window.visualViewport;
    return {
      w: (vv && vv.width) || window.innerWidth,
      h: (vv && vv.height) || window.innerHeight,
    };
  }

  // Orb count + diameters for the current viewport. Phones (coarse pointer,
  // small viewport) get 3 slightly smaller orbs to protect frame rate and
  // battery; sizes key off the smaller dimension there, which in portrait is
  // the width — stable while the iOS URL bar collapses during scroll.
  function layout() {
    var v = viewport();
    var minDim = Math.min(v.w, v.h);
    var phone = coarsePointer && minDim < 700;
    var factors = phone ? [0.26, 0.20, 0.23] : [0.20, 0.15, 0.24, 0.17, 0.22];
    var basis = phone ? minDim : v.h;
    var sizes = [];
    for (var i = 0; i < factors.length; i++) sizes.push(factors[i] * basis);
    return { phone: phone, count: factors.length, sizes: sizes, basis: basis };
  }

  // ---- displacement map (enhanced tier) -----------------------------------
  // Radial convex-lens map for feDisplacementMap: dx in R, dy in G, 128 =
  // neutral. Displacement points inward and ramps with r^2.8, so the lens is
  // near-flat at the center and bends hardest at the silhouette. The outer
  // 8% eases back to neutral to avoid a harsh rim artifact.
  function makeLensMap(size, seed) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(size, size);
    var d = img.data;
    var cx = (size - 1) / 2;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var i = (y * size + x) * 4;
        var nx = (x - cx) / cx;
        var ny = (y - cx) / cx;
        var r = Math.min(1, Math.sqrt(nx * nx + ny * ny));
        var ux = r ? nx / r : 0;
        var uy = r ? ny / r : 0;
        var amt = Math.pow(r, 2.8) * (r > 0.92 ? 1 - (r - 0.92) / 0.08 : 1);
        d[i] = Math.round(128 - 127 * ux * amt);
        d[i + 1] = Math.round(128 - 127 * uy * amt);
        d[i + 2] = 128;
        d[i + 3] = 255;
      }
    }
    // uniqueness tweak in the unused blue channel: Chromium caches feImage
    // rasterizations by href, so every filter needs its own distinct URI or
    // orbs of different sizes end up sharing one wrongly-sized map
    d[2] = 128 + (seed || 0);
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  // ---- inline SVG filters (enhanced tier) ---------------------------------
  // One filter per orb: feImage coordinates resolve in user-space pixels
  // under backdrop-filter, so the displacement map must be authored at the
  // orb's exact pixel size or it renders as a misplaced patch instead of
  // covering the lens. Chromium does NOT observe attribute mutations inside
  // a filter already referenced by backdrop-filter, so the values are baked
  // into the markup and the whole defs block is rebuilt (with fresh ids)
  // whenever orb sizes change. Three displacement passes at slightly offset
  // scales, one per RGB channel, recombined additively => a subtle chromatic
  // fringe at the rim. The blur stays as light as the primary tier.
  var defsSvg = null;
  var filterVersion = 0;
  var mapSeed = 0;

  function buildFilters(sizes) {
    if (!isChromium) return;
    if (defsSvg && defsSvg.parentNode) defsSvg.parentNode.removeChild(defsSvg);
    filterVersion++;
    defsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defsSvg.setAttribute('class', 'lg-defs');
    defsSvg.setAttribute('aria-hidden', 'true');
    var filters = '';
    for (var i = 0; i < sizes.length; i++) {
      var px = sizes[i].toFixed(1);
      // bend strength tracks orb size; ±3px between channels = the fringe
      var base = sizes[i] * 0.4;
      var scales = [base - 3, base, base + 3];
      var mapURI = makeLensMap(256, ++mapSeed % 120);
      filters +=
        '<filter id="' + filterId(i) + '" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">' +
          '<feImage href="' + mapURI + '" x="0" y="0" width="' + px + '" height="' + px + '" preserveAspectRatio="none" result="lgmap"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="' + scales[0].toFixed(1) + '" xChannelSelector="R" yChannelSelector="G" result="dR"/>' +
          '<feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cR"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="' + scales[1].toFixed(1) + '" xChannelSelector="R" yChannelSelector="G" result="dG"/>' +
          '<feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cG"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="' + scales[2].toFixed(1) + '" xChannelSelector="R" yChannelSelector="G" result="dB"/>' +
          '<feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cB"/>' +
          '<feComposite in="cR" in2="cG" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="cRG"/>' +
          '<feComposite in="cRG" in2="cB" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="cRGB"/>' +
          '<feGaussianBlur in="cRGB" stdDeviation="1.5" result="soft"/>' +
          '<feColorMatrix in="soft" type="saturate" values="1.25"/>' +
        '</filter>';
    }
    defsSvg.innerHTML = filters;
    document.body.appendChild(defsSvg);
  }

  function filterId(i) {
    return 'lg-lens-' + i + '-v' + filterVersion;
  }

  function applyFilters() {
    if (!isChromium) return;
    for (var i = 0; i < orbs.length; i++) {
      orbs[i].el.style.backdropFilter = 'url(#' + filterId(i) + ')';
    }
  }

  // ---- styles -------------------------------------------------------------
  function buildStyles() {
    // Shared glass anatomy, all tiers:
    //  - radial gradient: near-zero at center, faint brightening toward the
    //    rim with a barely-there cool tint => fakes lens curvature without
    //    obscuring what's behind
    //  - fresnel rim via inset shadows: invisible at center, a crisp bright
    //    silhouette edge, plus a subtle highlight hugging the upper rim
    //  - soft low-opacity drop shadow for depth
    var gradient =
      'radial-gradient(circle at 50% 50%,' +
        'rgba(255,255,255,0) 0%,' +
        'rgba(255,255,255,0) 60%,' +      /* dead-flat center: no banding rings */
        'rgba(255,255,255,0.03) 82%,' +
        'rgba(198,220,255,0.09) 93%,' +
        'rgba(255,255,255,0.16) 98%,' +
        'rgba(255,255,255,0.05) 100%)';
    var rim =
      'inset 0 0 1px 1px rgba(255,255,255,0.42),' +   /* crisp fresnel edge */
      'inset 0 1px 6px -1px rgba(255,255,255,0.30),' + /* upper-rim highlight */
      'inset 0 -6px 12px -8px rgba(170,200,240,0.28)'; /* cool lower rim */
    var dropShadow = '0 14px 30px rgba(25,45,80,0.05)';
    // On Chromium the outer drop shadow must NOT be on the orb itself: any
    // ink overflow (outer shadow, even on a pseudo-element) expands the
    // element's paint bounds and shifts the backdrop-filter region, which
    // misaligns the feImage displacement map. The shadow lives on a sibling
    // .lg-shadow twin there; other tiers keep it in the orb's own shadow.
    if (!isChromium) rim += ',' + dropShadow;

    var css =
      '.lg-defs{position:fixed;width:0;height:0;pointer-events:none;}' +

      '.lg-orb{' +
        'position:fixed;left:0;top:0;border-radius:50%;' +
        'pointer-events:none;touch-action:none;' +
        'z-index:' + Z_ORBS + ';will-change:transform;contain:layout style;' +
        'background:' + gradient + ';' +
        'box-shadow:' + rim + ';' +
        (hasBackdrop
          ? (isChromium
              ? ''  /* per-orb backdrop-filter: url(#lg-lens-N) set inline */
              : 'backdrop-filter:blur(3px) saturate(1.3) brightness(1.03);' +
                '-webkit-backdrop-filter:blur(3px) saturate(1.3) brightness(1.03);')
          : '') +
      '}' +
      // Base tier: no backdrop-filter anywhere, so the glass body itself
      // carries a little more light or the orb disappears entirely.
      (hasBackdrop ? '' :
        '.lg-orb{background:radial-gradient(circle at 50% 42%,' +
          'rgba(255,255,255,0.05) 0%,rgba(255,255,255,0.08) 55%,' +
          'rgba(198,220,255,0.14) 86%,rgba(255,255,255,0.22) 97%,' +
          'rgba(255,255,255,0.08) 100%);}') +
      '.lg-shadow{' +
        'position:fixed;left:0;top:0;border-radius:50%;pointer-events:none;' +
        'z-index:' + (Z_ORBS - 1) + ';will-change:transform;contain:layout style;' +
        'box-shadow:' + dropShadow + ';' +
      '}' +
      '.lg-orb.lg-hidden,.lg-shadow.lg-hidden{display:none;}' +

      '.lg-toggle-wrap{display:flex;gap:12px;align-items:center;order:99;margin-left:auto;margin-right:0;justify-content:flex-end;min-height:24px;min-width:0;padding:0;border-radius:0;}' +
      '.lg-toggle-wrap.lg-floating{position:fixed;top:16px;right:16px;z-index:' + (Z_ORBS + 1) + ';}' +
      '.lg-switch{position:relative;width:32px;height:18px;border-radius:999px;border:none;' +
        'background:#000;cursor:pointer;padding:0;flex-shrink:0;transition:background .18s;margin:-6px -8px;}' +
      '.lg-switch[aria-checked="false"]{background:#d6d6d6;}' +
      '.lg-knob{position:absolute;top:2px;left:16px;width:14px;height:14px;border-radius:50%;' +
        'background:#fff;transition:left .18s;}' +
      '.lg-switch[aria-checked="false"] .lg-knob{left:2px;}' +
      '.lg-toggle-label{font-family:\'Fira Mono\',ui-monospace,monospace;font-size:10px;' +
        'letter-spacing:-0.03em;text-transform:uppercase;color:#000;white-space:nowrap;line-height:1;}' +

      '@media (max-width:636px){' +
        '.lg-toggle-wrap{order:-1;margin-left:0;align-self:flex-end;padding:0 0 12px;}' +
      '}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---- toggle switch ------------------------------------------------------
  var enabled = (function () {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'on';
    }
    catch (e) { return false; }
  })();

  function buildToggle(onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'lg-toggle-wrap';
    var btn = document.createElement('button');
    btn.className = 'lg-switch';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', String(enabled));
    btn.setAttribute('aria-label', 'air bubbles');
    var knob = document.createElement('span');
    knob.className = 'lg-knob';
    btn.appendChild(knob);
    var label = document.createElement('span');
    label.className = 'lg-toggle-label';
    label.textContent = 'air bubbles';
    wrap.appendChild(btn);
    wrap.appendChild(label);

    btn.addEventListener('click', function () {
      enabled = !enabled;
      btn.setAttribute('aria-checked', String(enabled));
      try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch (e) {}
      onChange(enabled);
    });

    var tabs = document.querySelector('.tabs');
    if (tabs) tabs.appendChild(wrap);
    else { wrap.classList.add('lg-floating'); document.body.appendChild(wrap); }
  }

  // ---- orbs + physics -----------------------------------------------------
  var orbs = [];
  var rafId = null;
  var lastT = 0;
  var currentLayout = null;

  function buildOrbs() {
    currentLayout = layout();
    buildFilters(currentLayout.sizes);
    for (var i = 0; i < currentLayout.count; i++) {
      var d = currentLayout.sizes[i];
      var shadowEl = null;
      if (isChromium) {
        shadowEl = document.createElement('div');
        shadowEl.className = 'lg-shadow';
        if (!enabled) shadowEl.classList.add('lg-hidden');
        shadowEl.style.width = shadowEl.style.height = d.toFixed(1) + 'px';
        document.body.appendChild(shadowEl);
      }
      var el = document.createElement('div');
      el.className = 'lg-orb';
      if (!enabled) el.classList.add('lg-hidden');
      document.body.appendChild(el);
      el.style.width = el.style.height = d.toFixed(1) + 'px';
      orbs.push({
        el: el,
        shadowEl: shadowEl,
        d: d,
        x: 0, y: 0,
        vx: (Math.random() - 0.5) * 30,
        vy: (Math.random() - 0.5) * 30,
        fx: 0.35 + 0.18 * i,
        fy: 0.28 + 0.15 * ((i + 1) % currentLayout.count),
        phase: Math.random() * Math.PI * 2,
        squash: 0,           // 0..1 amplitude of squash-and-stretch
        squashAngle: 0,      // collision normal angle, radians
      });
    }
    applyFilters();
    placeOrbs();
  }

  function destroyOrbs() {
    for (var i = 0; i < orbs.length; i++) {
      if (orbs[i].el.parentNode) orbs[i].el.parentNode.removeChild(orbs[i].el);
      var s = orbs[i].shadowEl;
      if (s && s.parentNode) s.parentNode.removeChild(s);
    }
    orbs = [];
  }

  // Spread the orbs out, then relax any overlaps so solid orbs never start
  // (or restart after a resize) intersecting.
  function placeOrbs() {
    var v = viewport();
    var i;
    for (i = 0; i < orbs.length; i++) {
      var o = orbs[i];
      o.x = (0.08 + 0.83 * ((i * 0.618034) % 1)) * Math.max(1, v.w - o.d);
      o.y = (0.08 + 0.83 * ((i * 0.381966 + 0.35) % 1)) * Math.max(1, v.h - o.d);
    }
    for (var pass = 0; pass < 24; pass++) {
      var moved = separateOverlaps();
      clampToBounds(v);
      if (!moved) break;
    }
  }

  function clampToBounds(v) {
    for (var i = 0; i < orbs.length; i++) {
      var o = orbs[i];
      o.x = Math.max(0, Math.min(o.x, v.w - o.d));
      o.y = Math.max(0, Math.min(o.y, v.h - o.d));
    }
  }

  // Positional correction only (no velocity change): push intersecting pairs
  // apart along the collision normal. Returns true if anything moved.
  function separateOverlaps() {
    var moved = false;
    for (var i = 0; i < orbs.length; i++) {
      for (var j = i + 1; j < orbs.length; j++) {
        var a = orbs[i], b = orbs[j];
        var ra = a.d / 2, rb = b.d / 2;
        var dx = (b.x + rb) - (a.x + ra);
        var dy = (b.y + rb) - (a.y + ra);
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        var pen = ra + rb - dist;
        if (pen > 0.05) {
          var nx = dx / dist, ny = dy / dist;
          a.x -= nx * pen / 2; a.y -= ny * pen / 2;
          b.x += nx * pen / 2; b.y += ny * pen / 2;
          moved = true;
        }
      }
    }
    return moved;
  }

  function startSquash(o, nx, ny, strength) {
    o.squash = Math.max(o.squash, Math.min(1, strength));
    o.squashAngle = Math.atan2(ny, nx);
  }

  function applyTransform(o) {
    var tf = 'translate3d(' + o.x.toFixed(2) + 'px,' + o.y.toFixed(2) + 'px,0)';
    if (o.squash > 0.01) {
      // squash along the collision normal, stretch across it — soft impact
      var k = o.squash * o.squash; // ease back toward rest
      var sN = 1 - SQUASH_AMOUNT * k;
      var sT = 1 + SQUASH_AMOUNT * k;
      tf += ' rotate(' + o.squashAngle.toFixed(3) + 'rad)' +
            ' scale(' + sN.toFixed(4) + ',' + sT.toFixed(4) + ')' +
            ' rotate(' + (-o.squashAngle).toFixed(3) + 'rad)';
    }
    o.el.style.transform = tf;
    if (o.shadowEl) o.shadowEl.style.transform = tf;
  }

  function step(t) {
    rafId = requestAnimationFrame(step);
    var dt = Math.min(0.032, (t - lastT) / 1000 || 0.016); // cap => stable after tab jank
    lastT = t;
    var v = viewport();
    var W = v.w, H = v.h;
    var ts = t / 1000;
    var i, o;

    var MIN_SPEED = currentLayout.phone ? 16 : 24;
    var MAX_SPEED = currentLayout.phone ? 65 : 95;

    for (i = 0; i < orbs.length; i++) {
      o = orbs[i];
      // time-based sine drift + slight damping, per-orb frequency/phase
      o.vx += Math.sin(ts * o.fx + o.phase) * 14 * dt;
      o.vy += Math.cos(ts * o.fy + o.phase * 1.37) * 14 * dt;
      o.vx *= 0.999;
      o.vy *= 0.999;

      // keep every orb travelling: below the speed floor, ease it back up
      // along its current heading (the drift forces can otherwise cancel a
      // slow orb into hovering in place)
      var sp = Math.sqrt(o.vx * o.vx + o.vy * o.vy);
      if (sp < 0.5) {
        var ang = o.phase + ts * 0.2;
        o.vx = Math.cos(ang) * MIN_SPEED;
        o.vy = Math.sin(ang) * MIN_SPEED;
      } else if (sp < MIN_SPEED) {
        var boost = 1 + (MIN_SPEED / sp - 1) * Math.min(1, dt * 3);
        o.vx *= boost;
        o.vy *= boost;
      } else if (sp > MAX_SPEED) {
        o.vx *= MAX_SPEED / sp;
        o.vy *= MAX_SPEED / sp;
      }

      o.x += o.vx * dt;
      o.y += o.vy * dt;

      // soft elastic bounce off viewport edges, with a touch of squash
      if (o.x < 0) { o.x = 0; o.vx = Math.abs(o.vx) * 0.96 + 4; startSquash(o, 1, 0, 0.6); }
      if (o.y < 0) { o.y = 0; o.vy = Math.abs(o.vy) * 0.96 + 4; startSquash(o, 0, 1, 0.6); }
      if (o.x > W - o.d) { o.x = W - o.d; o.vx = -Math.abs(o.vx) * 0.96 - 4; startSquash(o, 1, 0, 0.6); }
      if (o.y > H - o.d) { o.y = H - o.d; o.vy = -Math.abs(o.vy) * 0.96 - 4; startSquash(o, 0, 1, 0.6); }
    }

    // orb-orb collisions: the orbs are solid and never overlap. Elastic
    // circle-circle response along the collision normal (equal masses,
    // restitution < 1 so impacts feel soft), plus same-frame positional
    // separation so no penetration is ever visible.
    for (i = 0; i < orbs.length; i++) {
      for (var j = i + 1; j < orbs.length; j++) {
        var a = orbs[i], b = orbs[j];
        var ra = a.d / 2, rb = b.d / 2;
        var dx = (b.x + rb) - (a.x + ra);
        var dy = (b.y + rb) - (a.y + ra);
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        var pen = ra + rb - dist;
        if (pen <= 0) continue;
        var nx = dx / dist, ny = dy / dist;

        // separate the penetration immediately
        a.x -= nx * pen / 2; a.y -= ny * pen / 2;
        b.x += nx * pen / 2; b.y += ny * pen / 2;

        // impulse only if the pair is still approaching
        var vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          var jmp = -(1 + RESTITUTION) * vn / 2; // equal masses
          a.vx -= jmp * nx; a.vy -= jmp * ny;
          b.vx += jmp * nx; b.vy += jmp * ny;
          var strength = Math.min(1, 0.35 + (-vn) / 90);
          startSquash(a, nx, ny, strength);
          startSquash(b, nx, ny, strength);
        }
      }
    }
    clampToBounds(v);

    for (i = 0; i < orbs.length; i++) {
      o = orbs[i];
      if (o.squash > 0) o.squash = Math.max(0, o.squash - dt * 1000 / SQUASH_MS);
      applyTransform(o);
    }
  }

  // ---- resize / orientation ----------------------------------------------
  function resize() {
    if (!orbs.length) return;
    var next = layout();
    if (next.count !== currentLayout.count) {
      // crossing the phone/desktop threshold: rebuild with the right count
      destroyOrbs();
      buildOrbs();
      if (enabled && (reducedMotion || rafId == null)) renderStatic();
      return;
    }
    // ignore sub-3% basis wobble (iOS URL bar collapse fires visualViewport
    // resize constantly during scroll — re-sizing orbs there looks jittery;
    // bounce bounds are read live each frame anyway)
    var sizeChanged = Math.abs(next.basis - currentLayout.basis) / currentLayout.basis > 0.03;
    currentLayout = next;
    var v = viewport();
    if (sizeChanged) {
      buildFilters(next.sizes); // rebuild with fresh ids: see buildFilters
      for (var i = 0; i < orbs.length; i++) {
        var o = orbs[i];
        o.d = next.sizes[i];
        o.el.style.width = o.el.style.height = o.d.toFixed(1) + 'px';
        if (o.shadowEl) o.shadowEl.style.width = o.shadowEl.style.height = o.d.toFixed(1) + 'px';
      }
      applyFilters();
    }
    clampToBounds(v);
    for (var pass = 0; pass < 8 && separateOverlaps(); pass++) clampToBounds(v);
    if (enabled && (reducedMotion || rafId == null)) renderStatic();
  }

  function renderStatic() {
    for (var i = 0; i < orbs.length; i++) {
      orbs[i].squash = 0;
      applyTransform(orbs[i]);
    }
  }

  // ---- run state ----------------------------------------------------------
  function startLoop() {
    if (rafId == null) { lastT = performance.now(); rafId = requestAnimationFrame(step); }
  }
  function stopLoop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function setRunning(on) {
    for (var i = 0; i < orbs.length; i++) {
      orbs[i].el.classList.toggle('lg-hidden', !on);
      if (orbs[i].shadowEl) orbs[i].shadowEl.classList.toggle('lg-hidden', !on);
    }
    if (on && !reducedMotion && !document.hidden) startLoop();
    else stopLoop();
    // reduced motion: static orbs, glass styling intact
    if (on && reducedMotion) renderStatic();
  }

  // ---- boot ---------------------------------------------------------------
  function init() {
    buildStyles();
    buildOrbs();
    buildToggle(setRunning);
    setRunning(enabled);

    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () {
      setTimeout(resize, 250); // let the new dimensions settle first
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', resize);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopLoop();
      else if (enabled && !reducedMotion) startLoop();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
