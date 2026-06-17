// app-topbar.js — priority+ progressive collapse for the desktop topbar.
// The old behavior hid ALL .topbar-collapsible buttons at a fixed viewport
// breakpoint, which either overflowed the bar (sidebar open at 1280) or left
// hundreds of px of dead space (everything collapsed at once). Instead:
// collapse the least-used buttons into the ⋮ overflow one at a time, only
// while the nav genuinely doesn't fit. Mobile (<769px) keeps its all-in-⋮
// design via the existing media queries; this script stands down there.
(function () {
  'use strict';

  // Collapse order: first entry is the first to go. Reverse = keep priority.
  // Everything here has a ⋮-menu equivalent except the bell, which shrinks instead.
  var CHAIN = ['summaryBtn', 'searchBtn', 'decisionsBtn', 'jobsBtn', 'tasksBtn', 'modelPickerBtn', 'appBtn'];
  // Variable-text items that flex-shrink with a CSS floor — budget them at the
  // floor so the kept set always fits; flexbox hands real slack back to them.
  // The project badge is NOT budgeted at its floor: it's chat identity, so
  // buttons collapse before the name compresses. Its CSS floor still acts as
  // a last-resort relief valve when even a fully-collapsed bar overflows.
  var MIN_W = { topbarAtt: 48, browserBtn: 64 };
  var OVERFLOW_W = 36;  // ⋮ button width
  var nav, topbar, scheduled = false;

  function natW(el) { return el ? el.getBoundingClientRect().width : 0; }

  function recalc() {
    scheduled = false;
    if (!nav) return;
    var chain = CHAIN.map(function (id) { return document.getElementById(id); }).filter(Boolean);
    // Mobile media keeps ⋮ permanently (Browser/Model/App live only in the
    // menu there), so it's a fixed cost; on desktop it only costs when d>0.
    var mobile = window.matchMedia('(max-width:768px)').matches;

    var cs = getComputedStyle(nav);
    var gap = parseFloat(cs.columnGap) || 10;
    var avail = nav.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

    // Everything that's not in the chain and not the ⋮ wrapper is fixed cost.
    var fixedW = 0, fixedCount = 0;
    Array.prototype.forEach.call(nav.children, function (el) {
      if (el.id === 'topbarOverflow' || chain.indexOf(el) !== -1) return;
      if (getComputedStyle(el).display === 'none') return;
      var w = MIN_W[el.id] || natW(el);
      if (w > 0) { fixedW += w; fixedCount++; }
    });

    // Smallest number of collapsed chain items (from the front) that fits.
    // Width-0 entries are media-hidden (Model/App on mobile) — they cost
    // nothing and get no gap, so they never trigger a collapse.
    var chainW = chain.map(natW);
    var n = chain.length;
    var dropped = n;
    for (var d = 0; d <= n; d++) {
      var dots = mobile || d > 0;
      var w = fixedW + (dots ? OVERFLOW_W : 0);
      var count = fixedCount + (dots ? 1 : 0);
      for (var i = d; i < n; i++) { w += chainW[i]; if (chainW[i] > 0) count++; }
      w += gap * Math.max(0, count - 1);
      if (w <= avail) { dropped = d; break; }
    }

    chain.forEach(function (el, i) {
      var want = i < dropped;
      if (el.classList.contains('tb-collapsed') !== want) el.classList.toggle('tb-collapsed', want);
    });
    var any = dropped > 0;
    if (topbar.classList.contains('tb-has-collapsed') !== any) topbar.classList.toggle('tb-has-collapsed', any);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(recalc);
  }

  function init() {
    topbar = document.querySelector('.topbar');
    nav = document.querySelector('.topbar-nav');
    if (!topbar || !nav) return;
    window.addEventListener('resize', schedule);
    if (window.ResizeObserver) new ResizeObserver(schedule).observe(topbar);
    // Badge counts, model label, browser pill, bell text all change live —
    // any of them can change what fits. Recalc is idempotent, so the
    // mutations our own class toggles cause settle after one extra pass.
    new MutationObserver(schedule).observe(nav, { subtree: true, childList: true, characterData: true, attributes: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
