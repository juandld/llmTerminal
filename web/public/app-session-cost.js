// Per-chat cost chip (2026-07-11) — classic script, shares globals with app.js.
// Shows exactly what this chat cost: real API dollars (OpenAI/Gemini keys)
// separate from Claude Max plan usage (included; number = list-price
// equivalent the CLI reports). Includes downstream orchestrator queue items
// the chat originated, once the backend supports origin_session.
//
// Self-mounting: creates its own chip in the desktop topbar and a row in the
// mobile overflow menu — no edits to other client files. Refreshes on load,
// on tab focus, and every 25s while visible (the endpoint is a local ledger
// scan; cheap).
(function initSessionCost() {
  let _last = null;

  function _fmt(n) {
    if (n > 0 && n < 0.001) return "<$0.001"; // sub-milli spend must not render as $0.00
    if (n >= 100) return "$" + Math.round(n);
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toFixed(3).replace(/0$/, "");
  }

  function _label(d) {
    // Claude usage displays as % OF THE PLAN — the sub is flat $200/mo, so
    // dollar-slices read like fake charges (David 2026-07-11). API spend
    // stays in dollars: that IS billed money. After a provider switch the
    // chat has BOTH — show both, never let one hide the other (2026-07-13).
    // "$?" = API turns happened but the model has no rate in pricing.js.
    const bits = [];
    if (d.api_usd > 0) bits.push(_fmt(d.api_usd) + " api");
    else if (d.api_unpriced_calls > 0) bits.push("$? api");
    if ((d.plan_usage_fraction || 0) > 0 || !bits.length) bits.push((d.plan_usage_fraction || 0) + "% of plan");
    return bits.join(" · ");
  }

  function _title(d) {
    const lines = [
      "This chat's ACTUAL cost:",
      "API (billed, OpenAI/Gemini): " + _fmt(d.api_usd) +
        (d.api_unpriced_calls > 0 ? " + " + d.api_unpriced_calls + " call(s) with no rate on file (dollars unknown)" : ""),
      "Claude: " + (d.plan_usage_fraction || 0) + "% of this month's Max-plan usage " +
        "(the plan is a flat $" + (d.plan_month_bill_usd || 200) + "/mo — that share ≈ " + _fmt(d.plan_share_usd || 0) + " of the bill)",
    ];
    if (d.downstream && d.downstream.available && d.downstream.items) {
      lines.push("Includes " + d.downstream.items + " downstream queue item(s), " + d.downstream.runs + " run(s)");
    }
    for (const n of d.notes || []) lines.push("• " + n);
    return lines.join("\n");
  }

  function _ensureChips() {
    let top = document.getElementById("sessionCostChip");
    if (!top) {
      const anchor = document.getElementById("modelPickerBtn");
      if (anchor && anchor.parentElement) {
        top = document.createElement("span");
        top.id = "sessionCostChip";
        // No `hide-mobile` class here: that class is inverted in this CSS
        // (base display:none + mobile override display:block = mobile-only),
        // which crammed a 72px chip into the mobile topbar and hid it on
        // desktop where it belongs. The mobile chip lives in the ⋮ menu
        // (#omSessionCostVal); this span is desktop-only, hidden via
        // @media(max-width:768px){#sessionCostChip{display:none}} in styles.css.
        top.style.cssText = "color:var(--dim);font-size:12px;margin-left:6px;white-space:nowrap;cursor:default";
        anchor.parentElement.insertBefore(top, anchor.nextSibling);
      }
    }
    let om = document.getElementById("omSessionCostRow");
    if (!om) {
      const modelRow = document.querySelector('[data-om="model"]');
      if (modelRow && modelRow.parentElement) {
        om = document.createElement("div");
        om.id = "omSessionCostRow";
        om.className = "om-model-row";
        om.innerHTML = '<span style="color:var(--dim);font-size:13px">Cost</span><span id="omSessionCostVal" style="margin-left:auto;font-size:13px;color:var(--text)">—</span>';
        modelRow.parentElement.insertBefore(om, modelRow.nextSibling);
      }
    }
    return { top, omVal: document.getElementById("omSessionCostVal") };
  }

  async function refreshSessionCost() {
    try {
      const sid = (typeof session !== "undefined" && session && session.id) || null;
      if (!sid) return;
      const base = typeof apiUrl === "function" ? apiUrl("/api/session-cost") : "/api/session-cost";
      const r = await fetch(base + (base.includes("?") ? "&" : "?") + "session=" + encodeURIComponent(sid));
      if (!r.ok) return;
      const d = await r.json();
      _last = d;
      const { top, omVal } = _ensureChips();
      const text = _label(d);
      const tip = _title(d);
      if (top) { top.textContent = text; top.title = tip; }
      if (omVal) { omVal.textContent = text; omVal.parentElement.title = tip; }
    } catch {}
  }

  // ── Sidebar badges: each chat label shows its actual total, top-right ──
  let _bulk = null;
  async function _fetchBulk() {
    try {
      const base = typeof apiUrl === "function" ? apiUrl("/api/session-costs") : "/api/session-costs";
      const r = await fetch(base);
      if (r.ok) _bulk = await r.json();
      _decorateSidebar();
    } catch {}
  }
  function _lookup(sid) {
    if (!_bulk || !_bulk.costs) return null;
    return _bulk.costs[sid] || _bulk.costs[String(sid).slice(0, 8)] || null;
  }
  function _decorateSidebar() {
    if (!_bulk) return;
    if (_sbObserver) _sbObserver.disconnect();
    try {
    document.querySelectorAll("#sbList .sb-item[data-sid]").forEach((el) => {
      const c = _lookup(el.dataset.sid);
      let badge = el.querySelector(".sb-cost");
      const hasApi = !!c && (c.api_usd > 0 || c.api_unpriced_calls > 0);
      if (!c || (!hasApi && !(c.plan_pct > 0))) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement("div");
        badge.className = "sb-cost";
        el.appendChild(badge);
      }
      // Provider-switched chats have BOTH billing kinds — show both numbers
      // side by side (David 2026-07-13). "$?" = API turns exist but the model
      // has no rate in pricing.js: dollars unknown, not zero.
      const pct = c.plan_pct || 0;
      const parts = [];
      if (c.api_usd > 0) parts.push(_fmt(c.api_usd));
      else if (c.api_unpriced_calls > 0) parts.push("$?");
      if (pct > 0 || !parts.length) parts.push(pct + "%");
      badge.textContent = parts.join(" · ");
      badge.title = pct + "% of the Max plan's " + (c.plan_pct_month || "monthly") + " usage" +
        (c.api_usd > 0 ? " + " + _fmt(c.api_usd) + " API (billed)" : "") +
        (c.api_unpriced_calls > 0 ? " + " + c.api_unpriced_calls + " API call(s) with no rate on file (dollars unknown)" : "");
    });
    } finally {
      const _l = document.getElementById("sbList");
      if (_l && _sbObserver) _sbObserver.observe(_l, { childList: true });
    }
  }
  const _sbObserver = new MutationObserver(() => _decorateSidebar());
  function _armSidebar() {
    const list = document.getElementById("sbList");
    if (!list) { setTimeout(_armSidebar, 1000); return; }
    _sbObserver.observe(list, { childList: true }); // NOT subtree: badges live inside items; subtree caused an observer->mutate->observer infinite loop (100% CPU / tab crash)
    _fetchBulk();
  }
  _armSidebar();
  setInterval(() => { if (document.visibilityState === "visible") _fetchBulk(); }, 60000);

  window.refreshSessionCost = refreshSessionCost;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshSessionCost();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refreshSessionCost();
  }, 25000);
  setTimeout(refreshSessionCost, 3000); // after the session message lands
})();
