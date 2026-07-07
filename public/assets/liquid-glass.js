// liquid-glass.js — Apple-style "liquid glass" floating orbs, self-contained.
// Drop in with <script defer src="/assets/liquid-glass.js"></script>.
// Injects its own <style>, an inline SVG filter, three orbs, and the
// "air bubbles" toggle. Everything is namespaced lg-*.
(function () {
  'use strict';

  var STORAGE_KEY = 'lg-bubbles';
  var ORB_COUNT = 5;
  var Z_ORBS = 800; // above overlay panels (500), below lightbox (900)

  // ---- feature detection --------------------------------------------------
  // backdrop-filter: url(#svg) only renders in Chromium. Safari/Firefox parse
  // it but paint nothing, so gate the lens on an actual Chromium engine and
  // fall back to plain frosted glass elsewhere.
  var hasBackdrop = false;
  try {
    hasBackdrop = CSS.supports('backdrop-filter', 'blur(1px)') ||
                  CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
  } catch (e) { /* very old browser */ }
  var isChromium = !!window.chrome && hasBackdrop && CSS.supports('backdrop-filter', 'url(#lg-lens)');
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- displacement map ---------------------------------------------------
  // Radial convex-lens map for feDisplacementMap: dx in R, dy in G, 128 =
  // neutral. Displacement points inward and ramps with r^2.8, so the lens
  // magnifies (samples toward its center) hardest at the silhouette. The
  // outer 8% eases back to neutral to avoid a harsh rim artifact.
  function makeLensMap(size) {
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
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  // ---- inline SVG filters -------------------------------------------------
  // One filter per orb: feImage coordinates resolve in user-space pixels
  // under backdrop-filter, so the displacement map must be given the orb's
  // exact pixel size or it renders as a misplaced patch instead of covering
  // the lens. Three displacement passes at slightly different scales, one
  // per RGB channel, recombined additively => chromatic fringing at the rim.
  // Then a whisper of blur and a saturation lift for the frosted-but-clear
  // look.
  var lensImages = []; // feImage nodes, one per orb, resized with the orbs

  function buildFilters() {
    var map = makeLensMap(256);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lg-defs');
    svg.setAttribute('aria-hidden', 'true');
    var filters = '';
    for (var i = 0; i < ORB_COUNT; i++) {
      filters +=
        '<filter id="lg-lens-' + i + '" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">' +
          '<feImage href="' + map + '" x="0" y="0" width="100" height="100" preserveAspectRatio="none" result="lgmap"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="52" xChannelSelector="R" yChannelSelector="G" result="dR"/>' +
          '<feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cR"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="59" xChannelSelector="R" yChannelSelector="G" result="dG"/>' +
          '<feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cG"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="66" xChannelSelector="R" yChannelSelector="G" result="dB"/>' +
          '<feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cB"/>' +
          '<feComposite in="cR" in2="cG" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="cRG"/>' +
          '<feComposite in="cRG" in2="cB" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="cRGB"/>' +
          '<feGaussianBlur in="cRGB" stdDeviation="0.35" result="soft"/>' +
          '<feColorMatrix in="soft" type="saturate" values="1.18"/>' +
        '</filter>';
    }
    svg.innerHTML = filters;
    document.body.appendChild(svg);
    lensImages = Array.prototype.slice.call(svg.querySelectorAll('feImage'));
  }

  function sizeLens(i, px) {
    var img = lensImages[i];
    if (!img) return;
    img.setAttribute('width', px.toFixed(1));
    img.setAttribute('height', px.toFixed(1));
    // displacement strength tracks the orb size (with R/G/B offsets for the
    // chromatic fringe) so small orbs don't over-bend what's behind them
    var maps = img.parentNode.querySelectorAll('feDisplacementMap');
    var scales = [0.40, 0.45, 0.50];
    for (var k = 0; k < maps.length; k++) {
      maps[k].setAttribute('scale', (px * scales[k]).toFixed(1));
    }
  }

  // ---- styles -------------------------------------------------------------
  function buildStyles() {
    var css =
      '.lg-defs{position:fixed;width:0;height:0;pointer-events:none;}' +

      '.lg-orb{' +
        'position:fixed;left:0;top:0;border-radius:50%;pointer-events:none;' +
        'z-index:' + Z_ORBS + ';will-change:transform;contain:layout style;' +
        'background:rgba(255,255,255,0.15);' +
        (isChromium
          ? ''  /* per-orb backdrop-filter set inline in buildOrbs */
          : 'backdrop-filter:blur(7px) saturate(1.35);-webkit-backdrop-filter:blur(7px) saturate(1.35);') +
        'transition:box-shadow .35s ease;' +
        'box-shadow:' +
          'inset 0 0 2px 1px rgba(255,255,255,0.42),' +   /* fresnel rim */
          'inset 0 0 16px rgba(255,255,255,0.28),' +
          '0 16px 30px rgba(30,50,80,0.05);' +            /* drop shadow */
      '}' +
      /* while merged with a neighbor, soften the rim so the pair reads as
         one liquid body instead of two stacked circles */
      '.lg-orb.lg-merged{' +
        'box-shadow:' +
          'inset 0 0 2px 1px rgba(255,255,255,0.14),' +
          'inset 0 0 16px rgba(255,255,255,0.10),' +
          '0 16px 30px rgba(30,50,80,0.05);' +
      '}' +
      '.lg-orb.lg-hidden{display:none;}' +

      '.lg-toggle-wrap{display:flex;gap:12px;align-items:center;order:99;margin-left:auto;}' +
      '.lg-toggle-wrap.lg-floating{position:fixed;top:16px;right:16px;z-index:' + (Z_ORBS + 1) + ';}' +
      '.lg-switch{position:relative;width:32px;height:18px;border-radius:999px;border:none;' +
        'background:#000;cursor:pointer;padding:0;flex-shrink:0;transition:background .18s;}' +
      '.lg-switch[aria-checked="false"]{background:#d6d6d6;}' +
      '.lg-knob{position:absolute;top:2px;left:16px;width:14px;height:14px;border-radius:50%;' +
        'background:#fff;transition:left .18s;}' +
      '.lg-switch[aria-checked="false"] .lg-knob{left:2px;}' +
      '.lg-toggle-label{font-family:\'Fira Mono\',ui-monospace,monospace;font-size:10px;' +
        'letter-spacing:-0.03em;text-transform:uppercase;color:#000;white-space:nowrap;}' +

      '@media (max-width:636px){' +
        '.lg-toggle-wrap{order:-1;margin-left:0;align-self:flex-end;padding:0 0 12px;}' +
      '}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---- toggle switch ------------------------------------------------------
  var enabled = (function () {
    try { return localStorage.getItem(STORAGE_KEY) !== 'off'; }
    catch (e) { return true; }
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

  function orbSizes() {
    var base = window.innerHeight * 0.15;
    return [base, base * 0.9, base * 1.1, base * 0.95, base * 1.05];
  }

  function buildOrbs() {
    var sizes = orbSizes();
    for (var i = 0; i < ORB_COUNT; i++) {
      var el = document.createElement('div');
      el.className = 'lg-orb';
      if (isChromium) el.style.backdropFilter = 'url(#lg-lens-' + i + ')';
      document.body.appendChild(el);
      var d = sizes[i % sizes.length];
      sizeLens(i, d);
      orbs.push({
        el: el,
        d: d,
        x: (0.06 + 0.19 * i) * window.innerWidth,
        y: (0.12 + 0.2 * ((i * 2) % 4)) * window.innerHeight,
        vx: (Math.random() - 0.5) * 30,
        vy: (Math.random() - 0.5) * 30,
        fx: 0.35 + 0.18 * i,
        fy: 0.28 + 0.15 * ((i + 1) % ORB_COUNT),
        phase: Math.random() * Math.PI * 2,
        scale: 1,
        targetScale: 1,
      });
      el.style.width = el.style.height = d.toFixed(1) + 'px';
    }
  }

  function resize() {
    var sizes = orbSizes();
    orbs.forEach(function (o, i) {
      o.d = sizes[i % sizes.length];
      o.el.style.width = o.el.style.height = o.d.toFixed(1) + 'px';
      sizeLens(i, o.d);
      o.x = Math.min(o.x, window.innerWidth - o.d);
      o.y = Math.min(o.y, window.innerHeight - o.d);
    });
  }

  function step(t) {
    rafId = requestAnimationFrame(step);
    var dt = Math.min(0.032, (t - lastT) / 1000 || 0.016); // cap at ~30ms => stable at 60fps
    lastT = t;
    var W = window.innerWidth, H = window.innerHeight;
    var ts = t / 1000;
    var i, o;

    var MIN_SPEED = 24, MAX_SPEED = 95;
    for (i = 0; i < orbs.length; i++) {
      o = orbs[i];
      // time-based sine drift + slight damping
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

      // near-elastic bounce off viewport edges
      if (o.x < 0) { o.x = 0; o.vx = Math.abs(o.vx) * 0.96 + 4; }
      if (o.y < 0) { o.y = 0; o.vy = Math.abs(o.vy) * 0.96 + 4; }
      if (o.x > W - o.d) { o.x = W - o.d; o.vx = -Math.abs(o.vx) * 0.96 - 4; }
      if (o.y > H - o.d) { o.y = H - o.d; o.vy = -Math.abs(o.vy) * 0.96 - 4; }
      o.targetScale = 1;
      o.nowMerged = false;
    }

    // orb-orb repulsion — deliberately late (0.5x combined radii) so orbs
    // overlap and visually merge before surface tension pushes them apart
    for (i = 0; i < orbs.length; i++) {
      for (var j = i + 1; j < orbs.length; j++) {
        var a = orbs[i], b = orbs[j];
        var ra = a.d / 2, rb = b.d / 2;
        var dx = (b.x + rb) - (a.x + ra);
        var dy = (b.y + rb) - (a.y + ra);
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        var trigger = 0.5 * (ra + rb);
        if (dist < ra + rb) {           // overlapping at all: swell a touch
          a.targetScale = b.targetScale = 1.065;
          a.nowMerged = b.nowMerged = true;
        }
        if (dist < trigger) {           // deep overlap: gentle spring apart
          var push = (trigger - dist) / trigger * 60 * dt;
          var nx = dx / dist, ny = dy / dist;
          a.vx -= nx * push; a.vy -= ny * push;
          b.vx += nx * push; b.vy += ny * push;
        }
      }
    }

    for (i = 0; i < orbs.length; i++) {
      o = orbs[i];
      o.scale += (o.targetScale - o.scale) * Math.min(1, dt * 6); // ease in/out
      o.el.style.transform = 'translate3d(' + o.x.toFixed(2) + 'px,' + o.y.toFixed(2) + 'px,0) scale(' + o.scale.toFixed(3) + ')';
      if (o.nowMerged !== o.merged) {
        o.merged = o.nowMerged;
        o.el.classList.toggle('lg-merged', o.merged);
      }
    }
  }

  function setRunning(on) {
    orbs.forEach(function (o) { o.el.classList.toggle('lg-hidden', !on); });
    if (on && !reducedMotion) {
      if (rafId == null) { lastT = performance.now(); rafId = requestAnimationFrame(step); }
    } else if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (on && reducedMotion) {
      // static placement, no animation
      orbs.forEach(function (o) {
        o.el.style.transform = 'translate3d(' + o.x.toFixed(2) + 'px,' + o.y.toFixed(2) + 'px,0)';
      });
    }
  }

  // ---- boot ---------------------------------------------------------------
  function init() {
    buildStyles();
    if (isChromium) buildFilters();
    buildOrbs();
    buildToggle(setRunning);
    setRunning(enabled);
    window.addEventListener('resize', resize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
