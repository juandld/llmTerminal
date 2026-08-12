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
// Header (To/Cc/Subject) and body are editable in place — tap a field, the
// mobile keyboard opens, and Send / Open-in-Gmail / Copy buttons all post the
// *current* values rather than the originally-drafted ones. On a successful
// send the inputs lock so a re-tap can't quietly re-fire with edited text.
function addEmailDraft(msg){
  const initialTo = msg.to || "";
  const initialCc = msg.cc || "";
  const initialSubject = msg.subject || "";
  const initialBody = msg.body || "";
  const threadId = msg.thread_id || "";
  const replyMode = msg.reply_mode || "";
  const threadParticipants = Array.isArray(msg.thread_participants) ? msg.thread_participants : [];
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  // ts of the saved draft row — passed back on Send so the server can patch
  // the row with the values actually sent (which may differ from the agent's
  // original draft if the user edited in place).
  const draftTs = msg.ts || 0;
  // History replay: server marks `sent: true` once /api/email-draft/send
  // succeeds, and overwrites to/cc/subject/body with the values that actually
  // went out. The card renders frozen in a confirmed "✓ Sent" state so the
  // user can verify what was sent (instead of seeing the pre-edit draft and
  // panicking that the wrong text was used).
  const wasSent = msg.sent === true;
  const sentAt = msg.sent_ts || 0;
  const sentMessageId = msg.message_id || "";

  const d = mk("div","msg email-draft");
  if (wasSent) d.classList.add("sent");
  const label = mk("div","msg-label draft-label");
  if (wasSent) {
    const when = sentAt ? new Date(sentAt).toLocaleString() : "";
    label.textContent = "✓ Sent" + (when ? " — " + when : "");
  } else {
    let base = threadId ? "↩ Reply (threads into existing conversation)" : "✉ New email";
    if (replyMode) base += "  ·  mode: " + replyMode;
    label.textContent = base;
  }

  const hdr = mk("div","draft-hdr");

  // ── From: identity ──
  // The send handler (POST /api/email-draft/send) passes `fromAccount` straight
  // to camoHero/scripts/send_gmail_email.py --from <slug>; the slug resolves to
  // a Gmail identity in camoHero/accounts.yaml. This map mirrors that file so
  // the card can show the actual address about to be used — keep in sync if
  // accounts are ever added there. Unknown slugs (e.g. future accounts on
  // replayed cards) fall back to displaying the slug itself.
  const FROM_IDENTITIES = {
    crankwheel: "david@crankwheel.com",
    camofiles: "david@camofiles.app",
  };
  const fromEmailFor = (slug) => FROM_IDENTITIES[slug] || slug;
  // Same resolution the Send button used before this row existed: server-sent
  // default_from_account, else derive from the draft's project. For sent
  // replays prefer msg.account — the identity that ACTUALLY sent it (the
  // server patches it onto the row on success).
  const initialFromAccount = (wasSent && msg.account) ||
    msg.default_from_account || (msg.project === "camoHero" ? "camofiles" : "crankwheel");
  const fromKey = mk("span","k"); fromKey.textContent = "From:";
  hdr.appendChild(fromKey);
  // The server accepts any registered fromAccount from the client, so identity
  // is user-choosable at send time — render a select, not a static line.
  let fromSelect = null;
  if (wasSent) {
    const fv = mk("span","draft-from-static");
    fv.textContent = fromEmailFor(initialFromAccount);
    hdr.appendChild(fv);
  } else {
    fromSelect = mk("select","draft-input draft-from-select");
    const slugs = Object.keys(FROM_IDENTITIES);
    if (!slugs.includes(initialFromAccount)) slugs.unshift(initialFromAccount);
    for (const slug of slugs) {
      const o = document.createElement("option");
      o.value = slug;
      o.textContent = fromEmailFor(slug);
      fromSelect.appendChild(o);
    }
    fromSelect.value = initialFromAccount;
    hdr.appendChild(fromSelect);
  }
  const currentFromAccount = () => fromSelect ? fromSelect.value : initialFromAccount;

  const addEditableRow = (k, v, placeholder) => {
    const ek = mk("span","k"); ek.textContent = k;
    const ev = mk("input","v draft-input");
    ev.type = "text";
    ev.value = v;
    ev.spellcheck = false;
    ev.autocapitalize = "off";
    ev.autocomplete = "off";
    if (placeholder) ev.placeholder = placeholder;
    hdr.appendChild(ek);
    hdr.appendChild(ev);
    return ev;
  };
  const toInput = addEditableRow("To:", initialTo);
  // Cc is always shown so it can be *added*, not only edited if pre-set.
  const ccInput = addEditableRow("Cc:", initialCc, "(none)");
  const subjectInput = addEditableRow("Subject:", initialSubject);

  // Thread participant picker — shown when the agent passed a non-empty
  // `thread_participants` list (typically only on replies). Each entry is
  // rendered as a tri-state chip (To / Cc / off). Tapping cycles the state
  // and rewrites the To/Cc inputs from the chip map, so the rest of the
  // card (Send, Open-in-Gmail, mailto, Copy) stays driven by the inputs.
  // Two presets above the chips: "Reply all" puts every participant in To;
  // "Sender only" keeps the first participant in To and drops the rest.
  let participantsEl = null;
  if (threadParticipants.length) {
    participantsEl = mk("div", "draft-participants");
    const bareEmail = (raw) => {
      const s = String(raw || "").trim();
      const m = s.match(/<([^>]+)>\s*$/);
      return (m ? m[1] : s).toLowerCase();
    };
    const splitEmails = (s) =>
      (s || "").split(",").map(x => x.trim()).filter(Boolean);
    const initialToList = splitEmails(initialTo).map(bareEmail);
    const initialCcList = splitEmails(initialCc).map(bareEmail);
    const state = new Map();
    threadParticipants.forEach((p, i) => {
      const e = bareEmail(p);
      if (!e) return;
      let s;
      if (initialCcList.includes(e)) s = "cc";
      else if (initialToList.includes(e)) s = "to";
      else if (replyMode === "reply_all") s = "to";
      else if (replyMode === "reply") s = i === 0 ? "to" : "off";
      else s = "off";
      state.set(e, { display: String(p), s });
    });
    const presets = mk("div", "draft-participants-presets");
    const replyAllBtn = mk("button", "draft-mini-btn");
    replyAllBtn.textContent = "↩↩ Reply all";
    const senderBtn = mk("button", "draft-mini-btn");
    senderBtn.textContent = "↩ Sender only";
    presets.appendChild(replyAllBtn);
    presets.appendChild(senderBtn);
    participantsEl.appendChild(presets);
    const chipRow = mk("div", "draft-participants-chips");
    participantsEl.appendChild(chipRow);
    const hint = mk("div", "draft-participants-hint");
    hint.textContent = "Tap to cycle: To → Cc → off. Edits below stay in sync.";
    participantsEl.appendChild(hint);

    const syncInputs = () => {
      const keepExtra = (currentVal, dropEmails) => {
        const set = new Set(dropEmails);
        return splitEmails(currentVal)
          .filter(addr => !set.has(bareEmail(addr)));
      };
      const partEmails = [...state.keys()];
      const extraTo = keepExtra(toInput.value, partEmails);
      const extraCc = keepExtra(ccInput.value, partEmails);
      const toParts = [];
      const ccParts = [];
      for (const [, v] of state) {
        if (v.s === "to") toParts.push(v.display);
        else if (v.s === "cc") ccParts.push(v.display);
      }
      toInput.value = [...toParts, ...extraTo].join(", ");
      ccInput.value = [...ccParts, ...extraCc].join(", ");
    };
    const renderChips = () => {
      chipRow.textContent = "";
      for (const [email, v] of state) {
        const chip = mk("button", "draft-chip chip-" + v.s);
        const label = v.s === "to" ? "To " : v.s === "cc" ? "Cc " : "× ";
        chip.textContent = label + (v.display.length > 32 ? email : v.display);
        chip.title = email + " — " + v.s;
        chip.onclick = (e) => {
          e.preventDefault();
          v.s = v.s === "to" ? "cc" : v.s === "cc" ? "off" : "to";
          syncInputs();
          renderChips();
        };
        chipRow.appendChild(chip);
      }
    };
    replyAllBtn.onclick = (e) => {
      e.preventDefault();
      for (const v of state.values()) v.s = "to";
      syncInputs(); renderChips();
    };
    senderBtn.onclick = (e) => {
      e.preventDefault();
      let first = true;
      for (const v of state.values()) { v.s = first ? "to" : "off"; first = false; }
      syncInputs(); renderChips();
    };
    renderChips();
    syncInputs();
  }

  // Body as textarea; auto-grow up to 60vh, then scrolls internally.
  const bodyEl = mk("textarea","draft-body");
  bodyEl.value = initialBody;
  bodyEl.spellcheck = false;
  const autosizeBody = () => {
    bodyEl.style.height = "auto";
    const cap = Math.floor(window.innerHeight * 0.6);
    bodyEl.style.height = Math.min(bodyEl.scrollHeight + 4, cap) + "px";
  };
  bodyEl.addEventListener("input", autosizeBody);

  // Attachments (if any) — read-only display; sent via the Send button.
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
    note.textContent = "Attachments are only included via the Send button. Open-in-Gmail can’t pre-attach files (Gmail compose URL doesn’t support it).";
    attachmentsEl.appendChild(note);
  }

  // Live snapshot of the currently-typed values. Every button below reads
  // through here, so edits flow into Send/Force/Gmail/mailto/Copy with no
  // re-binding required.
  function current() {
    return {
      to: toInput.value.trim(),
      cc: ccInput.value.trim(),
      subject: subjectInput.value,
      body: bodyEl.value,
    };
  }
  const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function buildGmailHref() {
    const c = current();
    if (threadId) {
      // Reply-to-thread mode: navigate to the thread (Gmail web URL has no
      // compose-with-thread param, so we always send the user to the thread
      // and pre-copy the edited body to clipboard for paste-after-Reply).
      if (isIOS) {
        const subjForSearch = c.subject.replace(/^\s*Re:\s*/i, "").slice(0, 90);
        return `googlegmail://search?query=${encodeURIComponent(subjForSearch)}`;
      }
      return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
    }
    const toEnc = encodeURIComponent(c.to);
    const ccEnc = encodeURIComponent(c.cc);
    const subEnc = encodeURIComponent(c.subject);
    const bodyEnc = encodeURIComponent(c.body);
    if (isIOS) {
      return `googlegmail://co?to=${toEnc}&subject=${subEnc}&body=${bodyEnc}` + (c.cc ? `&cc=${ccEnc}` : "");
    }
    return `https://mail.google.com/mail/?view=cm&fs=1&to=${toEnc}&su=${subEnc}&body=${bodyEnc}` + (c.cc ? `&cc=${ccEnc}` : "");
  }
  function freezeEditing() {
    [toInput, ccInput, subjectInput, bodyEl].forEach(el => { el.disabled = true; });
    if (fromSelect) fromSelect.disabled = true;
    if (participantsEl) {
      participantsEl.querySelectorAll("button").forEach(b => { b.disabled = true; });
    }
    d.classList.add("sent");
  }

  const actions = mk("div","draft-actions");

  // Primary: Open in Gmail. Three modes:
  //   * threadId set → opens that *thread* so the user taps Reply on it (the
  //                    only way to actually thread the message — Gmail web URL
  //                    has no compose-with-thread parameter). Body is auto-copied
  //                    to clipboard so paste-after-Reply is one tap.
  //   * iOS, no thread → googlegmail://co?... (Gmail app).
  //   * Web, no thread → https://mail.google.com/mail/?view=cm... in new tab.
  // href is rebuilt on click so post-edit values are picked up.
  const gmailBtn = mk("a","draft-btn primary");
  if (threadId) {
    if (isIOS) {
      gmailBtn.textContent = "\u{1F4E8} Find thread in Gmail app (body copied)";
    } else {
      gmailBtn.target = "_blank";
      gmailBtn.rel = "noopener noreferrer";
      gmailBtn.textContent = "\u{1F4E8} Reply in Gmail (body copied)";
    }
    gmailBtn.addEventListener("click", async () => {
      gmailBtn.href = buildGmailHref();
      const c = current();
      try { await navigator.clipboard.writeText(c.body); } catch {}
      logExternalSendIntent("reply_in_gmail", c.to, c.cc, c.subject, c.body);
    });
  } else if (isIOS) {
    gmailBtn.textContent = "\u{1F4E8} Open in Gmail app";
    gmailBtn.addEventListener("click", () => {
      gmailBtn.href = buildGmailHref();
      const c = current();
      logExternalSendIntent("open_in_gmail_ios", c.to, c.cc, c.subject, c.body);
    });
  } else {
    gmailBtn.target = "_blank";
    gmailBtn.rel = "noopener noreferrer";
    gmailBtn.textContent = "\u{1F4E8} Open in Gmail";
    gmailBtn.addEventListener("click", () => {
      gmailBtn.href = buildGmailHref();
      const c = current();
      logExternalSendIntent("open_in_gmail_web", c.to, c.cc, c.subject, c.body);
    });
  }
  // Seed the initial href so long-press-copy-link works without a click first.
  gmailBtn.href = buildGmailHref();

  const copyBodyBtn = mk("button","draft-btn");
  copyBodyBtn.textContent = "\u{1F4CB} Copy body";
  copyBodyBtn.onclick = async ()=>{
    const c = current();
    try {
      await navigator.clipboard.writeText(c.body);
      copyBodyBtn.textContent = "✓ Copied";
    } catch {
      const ta = document.createElement("textarea");
      ta.value = c.body; ta.style.position="fixed"; ta.style.opacity="0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); copyBodyBtn.textContent = "✓ Copied"; }
      catch { copyBodyBtn.textContent = "Copy failed"; }
      ta.remove();
    }
    setTimeout(()=>{ copyBodyBtn.textContent = "\u{1F4CB} Copy body"; }, 1500);
  };

  const copySubjBtn = mk("button","draft-btn");
  copySubjBtn.textContent = "\u{1F4CB} Subject";
  copySubjBtn.onclick = async ()=>{
    const c = current();
    try { await navigator.clipboard.writeText(c.subject); copySubjBtn.textContent = "✓ Copied"; }
    catch { copySubjBtn.textContent = "Copy failed"; }
    setTimeout(()=>{ copySubjBtn.textContent = "\u{1F4CB} Subject"; }, 1500);
  };

  const mailtoBtn = mk("button","draft-btn");
  mailtoBtn.textContent = "\u{1F4E7} Mail app";
  mailtoBtn.onclick = ()=>{
    const c = current();
    logExternalSendIntent("mailto", c.to, c.cc, c.subject, c.body);
    const url = `mailto:${c.to}?subject=${encodeURIComponent(c.subject)}&body=${encodeURIComponent(c.body)}` + (c.cc ? `&cc=${encodeURIComponent(c.cc)}` : "");
    window.location.href = url;
  };

  // Send button — renders in every session. The actual send always shells out
  // to camoHero/scripts/send_gmail_email.py (preserves all safety checks);
  // session.project just picks the From: identity by default.
  // Two-tap confirm (mobile-fastest, mirrors how the rest of the cards behave).
  {
    const sendBtn = mk("button","draft-btn primary send");
    // Label tracks the From: select so the button always names the identity
    // that the tap will actually send as.
    const sendLabel = () => "\u{1F680} Send as " + fromEmailFor(currentFromAccount());
    sendBtn.textContent = sendLabel();
    if (fromSelect) {
      fromSelect.addEventListener("change", () => {
        if (!sending && !armed) sendBtn.textContent = sendLabel();
      });
    }
    const forceBtn = mk("button", "draft-btn force");
    forceBtn.textContent = "⚠ Force send";
    forceBtn.style.display = "none";
    const errorEl = mk("div", "send-error-panel"); errorEl.style.display = "none";
    let armed = false, sending = false;
    sendBtn.onclick = async () => {
      if (sending) return;
      if (!armed) {
        armed = true;
        sendBtn.textContent = "⚠ Tap again to send";
        sendBtn.classList.add("armed");
        setTimeout(() => {
          if (armed && !sending) {
            armed = false;
            sendBtn.classList.remove("armed");
            sendBtn.textContent = sendLabel();
          }
        }, 4000);
        return;
      }
      sending = true;
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending…";
      sendBtn.classList.remove("armed");
      try {
        const c = current();
        const r = await fetch(apiUrl("/api/email-draft/send"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: (session && session.id) || "", ...c, threadId, attachments, fromAccount: currentFromAccount(), draftTs }),
        });
        const data = await r.json();
        if (data.ok) {
          sendBtn.textContent = "✓ Sent";
          sendBtn.classList.add("sent");
          errorEl.style.display = "none";
          freezeEditing();
        } else {
          sendBtn.textContent = "✗ Blocked — see below";
          sendBtn.classList.add("failed");
          // stdout has the full pre-send summary with all BLOCKED lines
          const fullErr = (data.stdout || "").trim() || data.error || data.stderr || "send failed";
          errorEl.innerHTML = '<div class="sep-title">Why it was blocked</div>' + esc(fullErr);
          errorEl.style.display = "";
          forceBtn.style.display = "";
          setTimeout(() => {
            sending = false; armed = false;
            sendBtn.disabled = false;
            sendBtn.textContent = sendLabel();
            sendBtn.classList.remove("failed");
          }, 3000);
        }
      } catch (e) {
        sendBtn.textContent = "✗ Network";
        sendBtn.classList.add("failed");
        sendBtn.title = e.message || "network error";
        setTimeout(() => {
          sending = false; armed = false;
          sendBtn.disabled = false;
          sendBtn.textContent = sendLabel();
          sendBtn.classList.remove("failed");
        }, 6000);
      }
    };
    let forceArmed = false, forceSending = false;
    forceBtn.onclick = async () => {
      if (forceSending) return;
      if (!forceArmed) {
        forceArmed = true;
        forceBtn.textContent = "⚠ Tap again to FORCE";
        forceBtn.classList.add("armed");
        setTimeout(() => {
          if (forceArmed && !forceSending) {
            forceArmed = false;
            forceBtn.classList.remove("armed");
            forceBtn.textContent = "⚠ Force send";
          }
        }, 4000);
        return;
      }
      forceSending = true;
      forceBtn.disabled = true;
      forceBtn.textContent = "Forcing…";
      forceBtn.classList.remove("armed");
      try {
        const c = current();
        const r = await fetch(apiUrl("/api/email-draft/send"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: (session && session.id) || "", ...c, threadId, attachments, fromAccount: currentFromAccount(), force: true, draftTs }),
        });
        const data = await r.json();
        if (data.ok) {
          forceBtn.textContent = "✓ Sent (forced)";
          forceBtn.classList.add("sent");
          sendBtn.style.display = "none";
          freezeEditing();
        } else {
          forceBtn.textContent = "✗ " + (data.error ? data.error.slice(0, 40) : "Failed");
          forceBtn.classList.add("failed");
          forceBtn.title = data.error || data.stderr || data.stdout || "force send failed";
          setTimeout(() => {
            forceSending = false; forceArmed = false;
            forceBtn.disabled = false;
            forceBtn.textContent = "⚠ Force send";
            forceBtn.classList.remove("failed");
          }, 6000);
        }
      } catch (e) {
        forceBtn.textContent = "✗ Network";
        forceBtn.classList.add("failed");
        forceBtn.title = e.message || "network error";
        setTimeout(() => {
          forceSending = false; forceArmed = false;
          forceBtn.disabled = false;
          forceBtn.textContent = "⚠ Force send";
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
  if (participantsEl) d.appendChild(participantsEl);
  d.appendChild(bodyEl);
  if (attachmentsEl) d.appendChild(attachmentsEl);
  d.appendChild(actions);

  // History-replay path: this draft was already sent in a prior turn (the
  // server patched `sent: true` onto the row after a successful send and
  // overwrote to/cc/subject/body with the actually-sent values). Freeze the
  // form, hide every action that could re-fire a send, and pin a confirmation
  // line with the Gmail message_id so the user can verify what went out.
  if (wasSent) {
    [toInput, ccInput, subjectInput, bodyEl].forEach(el => { el.disabled = true; });
    if (participantsEl) {
      participantsEl.querySelectorAll("button").forEach(b => { b.disabled = true; });
    }
    actions.querySelectorAll(".draft-btn.send, .draft-btn.force, .send-error-panel")
      .forEach(el => { el.remove(); });
    if (sentMessageId) {
      const idLine = mk("div", "draft-sent-id");
      idLine.textContent = "Message ID: " + sentMessageId;
      d.appendChild(idLine);
    }
  }

  chat.appendChild(d);
  // Initial sizing must happen after the textarea is in the DOM (scrollHeight
  // needs layout).
  setTimeout(autosizeBody, 0);
  scrollToBottomForce();
}

// ── Inbound email reply card ──
// Server saves an "email_reply" message via /api/sessions/:id/reactivate when
// a tracked Gmail thread gets a new reply. Frontend had NO renderer for this
// role — the message just dropped silently, so David couldn't see the email
// from the chat and had to jump to Gmail. Now: render from/subject/snippet as
// a card with an "Open in Gmail" jump link. Reuses the same card styling
// vocabulary as the draft card (msg-label / bubble) so it looks consistent.
function addEmailReply(msg, opts) {
  const from = (msg.fromEmail || "someone").trim();
  const subject = (msg.subject || "").trim();
  const messageId = msg.messageId || "";
  const rawText = msg.text || "";
  // Server-formatted text is "📬 Reply received from X — *subject*\n\n> snippet".
  // Strip the header line + blockquote marker so we can render structured.
  let snippet = "";
  const bqIdx = rawText.indexOf("\n\n> ");
  if (bqIdx >= 0) snippet = rawText.slice(bqIdx + 4).trim();

  const d = mk("div", "msg email-reply");
  const label = mk("div", "msg-label email-reply-label");
  label.textContent = "📬 Email reply";
  d.appendChild(label);

  const header = mk("div", "email-reply-header");
  const fromLine = mk("div", "email-reply-from");
  fromLine.innerHTML = "<strong>From:</strong> " + escHtml(from);
  header.appendChild(fromLine);
  if (subject) {
    const subjLine = mk("div", "email-reply-subject");
    subjLine.innerHTML = "<strong>Subject:</strong> " + escHtml(subject);
    header.appendChild(subjLine);
  }
  d.appendChild(header);

  // Prefer the full email body (poller fetches it since 2026-07-07); older
  // messages only carry the ~200-char snippet — render whichever we have so
  // David can read the email here instead of jumping to Gmail.
  const fullBody = (msg.body || "").trim();
  const bodyText = fullBody || snippet;
  if (bodyText) {
    const body = mk("div", "bubble email-reply-body");
    const COLLAPSE_AT = 700;
    if (bodyText.length > COLLAPSE_AT) {
      let expanded = false;
      const render = () => {
        body.innerHTML = fmt(expanded ? bodyText : bodyText.slice(0, COLLAPSE_AT) + "…");
      };
      render();
      d.appendChild(body);
      const more = mk("button", "email-reply-expand");
      more.textContent = "Show full email";
      more.onclick = () => {
        expanded = !expanded;
        render();
        more.textContent = expanded ? "Show less" : "Show full email";
      };
      d.appendChild(more);
    } else {
      body.innerHTML = fmt(bodyText);
      d.appendChild(body);
    }
  }

  if (messageId) {
    const actions = mk("div", "email-reply-actions");
    const openBtn = mk("a", "draft-btn open");
    openBtn.textContent = "Open in Gmail";
    openBtn.href = "https://mail.google.com/mail/u/0/#inbox/" + encodeURIComponent(messageId);
    openBtn.target = "_blank";
    openBtn.rel = "noopener noreferrer";
    actions.appendChild(openBtn);
    d.appendChild(actions);
  }

  chat.appendChild(d);
  if (!opts || !opts.suppressScroll) scrollToBottomForce();
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

