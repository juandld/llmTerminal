// app-email-draft.js
// Loaded AFTER app.js. Shares the same global scope (no module isolation).
// Exposes: addEmailDraft(msg), logExternalSendIntent(channel, to, cc, subject, body)
// Referenced from app.js WS message handler (case "email_draft") and history replay.

// ── Open-in-Gmail / Mail-app intent log (fire-and-forget) ──
// Cross-channel dedup hint for camoHero send pipeline. Best-effort; if the
// fetch fails the navigation still happens.
function logExternalSendIntent(channel, to, cc, subject, body) {
  try {
    fetch(apiUrl("/api/email-draft/log-intent"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      keepalive: true,
      body: JSON.stringify({
        sessionId: (typeof session !== "undefined" && session && session.id) || "",
        channel,
        to: to || "",
        cc: cc || "",
        subject: subject || "",
        body: body || "",
      }),
    }).catch(()=>{});
  } catch {}
}

// ── Email draft action card (from mcp__crankhero-draft__draft_email) ──
function addEmailDraft(msg){
  const to = msg.to || "";
  const cc = msg.cc || "";
  const subject = msg.subject || "";
  const body = msg.body || "";
  const threadId = msg.thread_id || "";
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];

  const d = mk("div","msg email-draft");
  const label = mk("div","msg-label draft-label");
  label.textContent = threadId ? "\u21A9 Reply (threads into existing conversation)" : "\u2709 New email";
  const hdr = mk("div","draft-hdr");
  const addRow = (k,v)=>{ if(!v) return;
    const ek=mk("span","k"); ek.textContent=k;
    const ev=mk("span","v"); ev.textContent=v;
    hdr.appendChild(ek); hdr.appendChild(ev);
  };
  addRow("To:", to);
  if(cc) addRow("Cc:", cc);
  addRow("Subject:", subject);

  const bodyEl = mk("div","draft-body"); bodyEl.textContent = body;

  // Attachments (if any) — read-only display; sent via the camoHero Send button.
  let attachmentsEl = null;
  if (attachments.length) {
    attachmentsEl = mk("div", "draft-attachments attachments-list");
    const lbl = mk("div", "att-label"); lbl.textContent = "\u{1F4CE} " + attachments.length + " attachment" + (attachments.length === 1 ? "" : "s");
    attachmentsEl.appendChild(lbl);
    attachments.forEach((p) => {
      const row = mk("a", "att-row att-link");
      const name = String(p).split("/").pop();
      row.textContent = "📎 " + name;
      row.title = p;
      const _ext = p.split(".").pop().toLowerCase();
      const _viewable = ["pdf","png","jpg","jpeg","gif","svg"].includes(_ext);
      if (_viewable) {
        row.href = "#";
        row.onclick = (e) => { e.preventDefault(); openFileModal(name, p); };
      } else {
        row.href = apiUrl("/api/file?path=" + encodeURIComponent(p));
        row.target = "_blank";
        row.rel = "noopener noreferrer";
      }
      attachmentsEl.appendChild(row);
    });
    const note = mk("div", "att-note");
    note.textContent = "Attachments are only included via the Send button. Open-in-Gmail can\u2019t pre-attach files (Gmail compose URL doesn\u2019t support it).";
    attachmentsEl.appendChild(note);
  }

  const toEnc = encodeURIComponent(to);
  const ccEnc = encodeURIComponent(cc);
  const subEnc = encodeURIComponent(subject);
  const bodyEnc = encodeURIComponent(body);
  const prefillLen = toEnc.length + ccEnc.length + subEnc.length + bodyEnc.length;

  const actions = mk("div","draft-actions");

  // Primary: Open in Gmail. Two modes:
  //   * No threadId  → opens compose with subject/body prefilled.
  //                    iOS: googlegmail://co?... (Gmail app).
  //                    Else: https://mail.google.com/mail/?view=cm... in new tab.
  //   * threadId set → opens that *thread* so the user taps Reply on it (the
  //                    only way to actually thread the message — Gmail web URL
  //                    has no compose-with-thread parameter). Body is auto-copied
  //                    to clipboard so paste-after-Reply is one tap.
  const gmailComposeWeb = `https://mail.google.com/mail/?view=cm&fs=1&to=${toEnc}&su=${subEnc}&body=${bodyEnc}` + (cc ? `&cc=${ccEnc}` : "");
  const gmailComposeIos = `googlegmail://co?to=${toEnc}&subject=${subEnc}&body=${bodyEnc}` + (cc ? `&cc=${ccEnc}` : "");
  const gmailThreadWeb = threadId ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}` : "";
  const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const gmailBtn = mk("a","draft-btn primary");
  if (threadId) {
    // Reply-to-thread mode: copy body, navigate to the thread (or to a
    // search for it on iOS — Gmail app has no thread-id scheme, and iOS
    // Brave/Chrome don't honor Apple Universal Links so the https URL
    // would just load Gmail mobile web instead of opening the app).
    if (isIOS) {
      const subjForSearch = subject.replace(/^\s*Re:\s*/i, "").slice(0, 90);
      const iosSearchUrl = `googlegmail://search?query=${encodeURIComponent(subjForSearch)}`;
      gmailBtn.href = iosSearchUrl;
      gmailBtn.textContent = "\u{1F4E8} Find thread in Gmail app (body copied)";
    } else {
      gmailBtn.href = gmailThreadWeb;
      gmailBtn.target = "_blank";
      gmailBtn.rel = "noopener noreferrer";
      gmailBtn.textContent = "\u{1F4E8} Reply in Gmail (body copied)";
    }
    gmailBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(body); } catch {}
      logExternalSendIntent("reply_in_gmail", to, cc, subject, body);
    });
  } else if (isIOS) {
    gmailBtn.href = gmailComposeIos;
    gmailBtn.textContent = "\u{1F4E8} Open in Gmail app";
    gmailBtn.addEventListener("click", () => logExternalSendIntent("open_in_gmail_ios", to, cc, subject, body));
  } else {
    gmailBtn.href = gmailComposeWeb;
    gmailBtn.target = "_blank";
    gmailBtn.rel = "noopener noreferrer";
    gmailBtn.textContent = "\u{1F4E8} Open in Gmail";
    gmailBtn.addEventListener("click", () => logExternalSendIntent("open_in_gmail_web", to, cc, subject, body));
  }

  const copyBodyBtn = mk("button","draft-btn");
  copyBodyBtn.textContent = "\u{1F4CB} Copy body";
  copyBodyBtn.onclick = async ()=>{
    try {
      await navigator.clipboard.writeText(body);
      copyBodyBtn.textContent = "\u2713 Copied";
    } catch {
      const ta = document.createElement("textarea");
      ta.value = body; ta.style.position="fixed"; ta.style.opacity="0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); copyBodyBtn.textContent = "\u2713 Copied"; }
      catch { copyBodyBtn.textContent = "Copy failed"; }
      ta.remove();
    }
    setTimeout(()=>{ copyBodyBtn.textContent = "\u{1F4CB} Copy body"; }, 1500);
  };

  const copySubjBtn = mk("button","draft-btn");
  copySubjBtn.textContent = "\u{1F4CB} Subject";
  copySubjBtn.onclick = async ()=>{
    try { await navigator.clipboard.writeText(subject); copySubjBtn.textContent = "\u2713 Copied"; }
    catch { copySubjBtn.textContent = "Copy failed"; }
    setTimeout(()=>{ copySubjBtn.textContent = "\u{1F4CB} Subject"; }, 1500);
  };

  const mailtoBtn = mk("button","draft-btn");
  mailtoBtn.textContent = "\u{1F4E7} Mail app";
  mailtoBtn.onclick = ()=>{
    logExternalSendIntent("mailto", to, cc, subject, body);
    const url = `mailto:${to}?subject=${subEnc}&body=${bodyEnc}` + (cc ? `&cc=${ccEnc}` : "");
    window.location.href = url;
  };

  // camoHero Send button — only renders when this draft was produced in a camoHero session.
  // Two-tap confirm (mobile-fastest, mirrors how the rest of the cards behave).
  // POSTs to /api/email-draft/send which shells out to camoHero send_gmail_email.py.
  if (msg.project === "camoHero") {
    const sendBtn = mk("button","draft-btn primary send");
    const SEND_LABEL = "\u{1F680} Send (camofiles)";
    sendBtn.textContent = SEND_LABEL;
    const forceBtn = mk("button", "draft-btn force");
    forceBtn.textContent = "\u26A0 Force send";
    forceBtn.style.display = "none";
    const errorEl = mk("div", "send-error-panel"); errorEl.style.display = "none";
    let armed = false, sending = false;
    sendBtn.onclick = async () => {
      if (sending) return;
      if (!armed) {
        armed = true;
        sendBtn.textContent = "\u26A0 Tap again to send";
        sendBtn.classList.add("armed");
        setTimeout(() => {
          if (armed && !sending) {
            armed = false;
            sendBtn.classList.remove("armed");
            sendBtn.textContent = SEND_LABEL;
          }
        }, 4000);
        return;
      }
      sending = true;
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending\u2026";
      sendBtn.classList.remove("armed");
      try {
        const r = await fetch(apiUrl("/api/email-draft/send"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: (session && session.id) || "", to, cc, subject, body, threadId, attachments }),
        });
        const data = await r.json();
        if (data.ok) {
          sendBtn.textContent = "\u2713 Sent";
          sendBtn.classList.add("sent");
          errorEl.style.display = "none";
        } else {
          sendBtn.textContent = "\u2717 Blocked — see below";
          sendBtn.classList.add("failed");
          // stdout has the full pre-send summary with all BLOCKED lines
          const fullErr = (data.stdout || "").trim() || data.error || data.stderr || "send failed";
          errorEl.innerHTML = '<div class="sep-title">Why it was blocked</div>' + esc(fullErr);
          errorEl.style.display = "";
          forceBtn.style.display = "";
          setTimeout(() => {
            sending = false; armed = false;
            sendBtn.disabled = false;
            sendBtn.textContent = SEND_LABEL;
            sendBtn.classList.remove("failed");
          }, 3000);
        }
      } catch (e) {
        sendBtn.textContent = "\u2717 Network";
        sendBtn.classList.add("failed");
        sendBtn.title = e.message || "network error";
        setTimeout(() => {
          sending = false; armed = false;
          sendBtn.disabled = false;
          sendBtn.textContent = SEND_LABEL;
          sendBtn.classList.remove("failed");
        }, 6000);
      }
    };
    let forceArmed = false, forceSending = false;
    forceBtn.onclick = async () => {
      if (forceSending) return;
      if (!forceArmed) {
        forceArmed = true;
        forceBtn.textContent = "\u26A0 Tap again to FORCE";
        forceBtn.classList.add("armed");
        setTimeout(() => {
          if (forceArmed && !forceSending) {
            forceArmed = false;
            forceBtn.classList.remove("armed");
            forceBtn.textContent = "\u26A0 Force send";
          }
        }, 4000);
        return;
      }
      forceSending = true;
      forceBtn.disabled = true;
      forceBtn.textContent = "Forcing\u2026";
      forceBtn.classList.remove("armed");
      try {
        const r = await fetch(apiUrl("/api/email-draft/send"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: (session && session.id) || "", to, cc, subject, body, threadId, attachments, force: true }),
        });
        const data = await r.json();
        if (data.ok) {
          forceBtn.textContent = "\u2713 Sent (forced)";
          forceBtn.classList.add("sent");
          sendBtn.style.display = "none";
        } else {
          forceBtn.textContent = "\u2717 " + (data.error ? data.error.slice(0, 40) : "Failed");
          forceBtn.classList.add("failed");
          forceBtn.title = data.error || data.stderr || data.stdout || "force send failed";
          setTimeout(() => {
            forceSending = false; forceArmed = false;
            forceBtn.disabled = false;
            forceBtn.textContent = "\u26A0 Force send";
            forceBtn.classList.remove("failed");
          }, 6000);
        }
      } catch (e) {
        forceBtn.textContent = "\u2717 Network";
        forceBtn.classList.add("failed");
        forceBtn.title = e.message || "network error";
        setTimeout(() => {
          forceSending = false; forceArmed = false;
          forceBtn.disabled = false;
          forceBtn.textContent = "\u26A0 Force send";
          forceBtn.classList.remove("failed");
        }, 6000);
      }
    };

    actions.appendChild(sendBtn);
    actions.appendChild(forceBtn);
    actions.appendChild(errorEl);
  }

  actions.appendChild(gmailBtn);
  actions.appendChild(copyBodyBtn);
  actions.appendChild(copySubjBtn);
  actions.appendChild(mailtoBtn);

  d.appendChild(label);
  d.appendChild(hdr);
  d.appendChild(bodyEl);
  if (attachmentsEl) d.appendChild(attachmentsEl);
  d.appendChild(actions);

  // Expand button if body is tall — appended after DOM insert so we can measure.
  chat.appendChild(d);
  setTimeout(()=>{
    if(bodyEl.scrollHeight > 180 + 10){
      const toggle = mk("button","draft-body-toggle");
      toggle.textContent = "show more";
      toggle.onclick = ()=>{
        bodyEl.classList.toggle("expanded");
        toggle.textContent = bodyEl.classList.contains("expanded") ? "show less" : "show more";
      };
      d.insertBefore(toggle, actions);
    }
  }, 0);

  scrollToBottomForce();
}
