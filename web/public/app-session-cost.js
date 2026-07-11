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
    if (n >= 100) return "$" + Math.round(n);
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toFixed(3).replace(/0$/, "");
  }

  function _label(d) {
    const bits = [];
    if (d.api_usd > 0) bits.push(_fmt(d.api_usd) + " api");
    bits.push(_fmt(d.plan_usd) + " plan");
    return bits.join(" · ");
  }

  function _title(d) {
    const lines = [
      "This chat's spend:",
      "API (billed dollars, OpenAI/Gemini): " + _fmt(d.api_usd),
      "Claude Max plan (included; list-equivalent): " + _fmt(d.own ? d.own.plan_usd : d.plan_usd),
    ];
    if (d.downstream && d.downstream.available && d.downstream.items) {
      lines.push("Downstream queue items: " + d.downstream.items + " (" + _fmt(d.downstream.plan_usd) + " plan)");
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
        top.className = "hide-mobile";
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

  window.refreshSessionCost = refreshSessionCost;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshSessionCost();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refreshSessionCost();
  }, 25000);
  setTimeout(refreshSessionCost, 3000); // after the session message lands
})();
