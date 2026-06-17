# Audio + Files-Drawer UX — Observations & Fix Plan

> Status: **planning** (no code changes applied yet). Anchor session:
> `hero.camofiles.app/terminal/#f936a990-aa2e-4a0f-98bd-05dcc6093d81` — David's
> narrativeHero TTS chat where these observations surfaced 2026-06-17.

The drawer already has more audio plumbing than it looks like from the UI
surface (sequential playback queue, sort buckets, per-row inline `<audio>`).
The issues David flagged are mostly **discoverability** and **one concrete
session-isolation bug**, not "build it from scratch."

This doc lists each observation at higher resolution than the voice note, points
at the exact code, and proposes a fix order. Implementation only starts after
David signs off.

---

## 0. Architectural fit (ARCHITECTURE.md cross-check)

Quick map from this plan to the principles in `ARCHITECTURE.md`, so the work
is justified against the north star rather than landing as ad-hoc UX patches:

| Plan step | Principle served | Why |
|---|---|---|
| §1 — cross-chat player leak | **§3.3 "the chat is sacred"**, **§8 invariant** | The player following the operator across chats is a session-isolation violation, same family as the 2026-05-20 invariants in CLAUDE.md (WS session_id locking, voice-note nonce, modal cleanup). Closing it strengthens the isolation guarantee. |
| §2 — calendar date buckets, sticky headers | **§1 "time-from-idea-to-action → 0"**, **§3.4 "nothing gets dropped"** | David comes back days later to listen to a week-old voiceover take. Today they collapse into `Older` and effectively vanish from attention. Calendar buckets surface them. |
| §3 — audio-batch playlist card | **§1 north star**, **§3.1 capture latency** | Today: see a TTS run land → tap drawer → select all the new audio rows → tap Play. Tomorrow: see a card in the chat thread → tap ▶. Cuts a 4-tap workflow to 1. |
| §4 — row-level ▶ replays batch | **§1 north star**, **§3.4** | "I want to hear the group again to pick my reference takes" is a recurring intent. Today: re-select all → Play. Tomorrow: ▶ on any row in that batch. |

**Concept hygiene (§3.10 "data primitives ARE the product"):**
The new word "**batch**" is **NOT** a new first-class data primitive. It is a
**derived UI grouping** computed at refresh time on the in-memory
`sessionPreviews` array (a `_batchId` tag, not a stored column). It does not:
- touch `web/src/store.js` schema (no migration),
- touch `web/config/projects.json`,
- get persisted anywhere,
- get sent to the orchestrator backend.

If batch later wants to be a real primitive (e.g. "name and pin a batch"), that
would be a separate decision to add it to `session`/`project`/`decision`/`task`
alongside the existing primitives. Today we don't need it.

**No restart required:**
All four steps touch only `web/public/*.js` + `web/public/styles.css`. The
mtime-based cache-bust in `server.js` (`rewriteCacheBust()`) handles freshness
automatically — no `systemctl restart llm-terminal` needed. (Per CLAUDE.md:
restart is only for `server.js` and `web/src/` changes.)

**Playwright verification will use the `llmterminal` chromium pool** (slug
`llmterminal`, per `web/config/projects.json`) at iPhone 14 viewport
(390×844) — NOT the orchestratorhero or crankhero chromium, even though the
files-under-test originate in the narrativeHero/orchestratorHero project.

---

## 1. The cross-chat player bug ("the player follows me")

**Symptom (David, verbatim):** *"the player if i have it open goes to other
chats, i have it open in this chat right now while it should not be there since
the files belong to the narrativehero chat"*

**Root cause — confirmed by reading source:**

`web/public/app-ws.js`:

```js
// line 17–25
function _teardownAndConnect(project, sessionId){
  ...
  chat.innerHTML=""; session=null; ws=null; busy=false; ...   // ← line 20
  ...
  connect(project, sessionId);                                 // ← line 23
}

// line 81–95
function connect(project,sessionId){
  // "Per-chat cleanup: when switching to a DIFFERENT session, stop any
  //  in-flight audio playback and clear the file selection..."
  const isSessionSwitch = session && session.id && sessionId
                          && session.id !== sessionId;        // ← line 86
  if (isSessionSwitch) {
    try { stopPlayback(); } catch {}                          // ← never fires
    if (selectedPreviewIds.size) {
      selectedPreviewIds.clear();                             // ← never fires
      ...
    }
  }
```

`session` is nulled at line 20 **before** `connect()` runs at line 23. So
inside `connect()`, `session` is `null`, `isSessionSwitch` is **always false**
on every chat→chat switch, and the cleanup block is dead code. Comment on line
85 — *"Same-session reconnects don't trigger this; first-page-load doesn't
either"* — was written under the false assumption that `session` is still set
when `connect()` runs.

**Consequences:**
- `_playbackEl` (the global `Audio()` object in `app-drawer.js:70`) keeps
  playing across the chat switch.
- `selectedPreviewIds` (Set, persisted to `localStorage["llmt_selected_previews"]`
  at app-drawer.js:39) survives. On the new chat it gets re-read from storage
  on next reload too.
- `renderSelectedTray()` (app-drawer.js:199) shows the now-playing strip in
  the new chat as long as `_playbackIndex >= 0`.

**Why David sees it in *this* (llmTerminal) chat:** he hit Stop / closed the
narrativeHero tab and opened a different chat in the same browser. The
audio kept playing across the session switch; the tray rendered against
`sessionPreviews` of the new chat, finding nothing to draw chips for, but
the **"now playing" strip** at lines 254-263 renders from `_playbackQueue`
alone — which still has the narrativeHero file URLs.

**Fix (one-liner, but needs to happen in the right place):**

Move the cleanup OUT of the dead `connect()` branch and INTO
`_teardownAndConnect()` (or `resumeSession`), guarded by the OLD session id
before it's nulled:

```js
// in _teardownAndConnect, BEFORE session=null:
const oldId = session?.id;
const switching = oldId && sessionId && oldId !== sessionId;
if (switching) {
  try { stopPlayback(); } catch {}
  try { closeFileModal(); } catch {}
  if (selectedPreviewIds.size) {
    selectedPreviewIds.clear();
    _lastSelectedId = null;
    _saveSelection();
    try { renderSelectedTray(); } catch {}
  }
  expandedPreviewId = null;
}
chat.innerHTML=""; session=null; ws=null; ...
```

Also clean up the dead block in `connect()` (delete lines 86–95) so the
intent isn't split across two functions.

**Two related leaks to fix in the same pass:**

1. **`#file-modal`** stays open across chat switches (`closeFileModal()` in
   `app-drawer.js:490` is never called from session teardown).
2. **`expandedPreviewId`** (the currently-expanded file card) is never
   reset. Re-render of the new chat's drawer renders it as "active" if any
   row happens to share the id — rare but possible in project view.

**Estimated effort:** 1 small commit, ~20 lines.

---

## 2. Dedicated audio playlist card for TTS / generation runs

**What David is asking for:** when the agent generates a batch of audio
files in a turn (e.g. narrativeHero TTS for scene voiceover takes), surface
a **first-class card in the chat thread** with the whole batch as a
playlist — play, pause, skip, "play all", scrub. Don't make David hunt
through the drawer and shift-click to assemble a selection just to listen.

**What exists today:**

- **Queue engine: built.** `_playbackQueue`, `_playbackIndex`, `_playCurrent`,
  `skipNext/Prev`, `pauseToggle`, `stopPlayback` — all in
  `app-drawer.js:67-165`. It's solid; the `onended` chain advances to next
  track automatically (line 124).
- **Inline-preview spawn point: built.** `addInlinePreview(p)` in
  `app-drawer.js:359` already renders a card in the chat thread for each
  newly arrived preview. Today it's per-file, plain audio control. There's
  no batching.
- **Detection of "a batch of audio just arrived" — not done.**
  `refreshPreviews()` at line 280 polls, computes `oldIds`/new IDs, then
  calls `addInlinePreview(p)` per-new-preview in a loop (line 348-353).
  No grouping logic.

**Proposed design:**

Add a **batch-detection step** inside that loop:

- After computing `newPreviews = sessionPreviews.filter(p => !oldIds.has(p.id))`,
  bucket the new previews by **fileKindMeta(p).kind === "audio"** and
  group consecutive arrivals within a short window (~5s) of each other.
- If a batch has **≥ 2 audio files**, render ONE playlist card instead of
  N per-file cards. Single-file batches keep the current per-file inline
  card.
- Card UI: header with batch title (`"3 audio tracks generated"`), then a
  list of tracks with one `<audio>` element being driven by the existing
  `_playbackQueue` engine. Re-use `playSingleFromId` (line 270) — we'd add
  `playFromBatch(batchId, index)` that loads only that batch into the
  queue.

**Hooks needed:**
1. New function `addInlineAudioBatch(previews)` next to `addInlinePreview`
   in `app-drawer.js` — same rendering surface, different layout.
2. Small refactor of `_selectedAudioQueue()` (line 72) → factor out the
   queue-building loop so a batch card can call it with its own preview
   list rather than going through `selectedPreviewIds`.
3. Persist "user has played track N from batch B" in
   `localStorage["llmt_played_batches"]` so the card collapses gracefully
   after the run when no longer interesting.

**Decided 2026-06-17 (David):** Batch card **does NOT auto-play.** It
renders with ▶ visible and waits for a tap. Reason: David is on mobile,
phone often in pocket, often in a meeting. No surprise audio.

**Batch-detection rule (shared by §3 and §4):**

Group consecutive new audio previews into one batch when **all** hold:
1. Same `session_id`.
2. `fileKindMeta(p).kind === "audio"`.
3. Created within a **5-second sliding window** of the previous member
   (i.e. `created_at` deltas ≤ 5000ms in sequence). A 6th-second arrival
   starts a fresh batch.
4. Single-file arrivals (no sibling within 5s) are NOT batches — they
   render as today's per-file inline card and row ▶ queues just that
   file.

Store the resulting `batchId` (synthesized, e.g. `b:<earliest_created_at>`)
on each preview in `sessionPreviews`. Add a helper:

```js
function batchMembersOf(previewId) {
  const p = sessionPreviews.find(x => x.id === previewId);
  if (!p || !p._batchId) return [previewId];   // singleton
  return sessionPreviews
    .filter(x => x._batchId === p._batchId)
    .sort((a,b) => new Date(a.created_at) - new Date(b.created_at))
    .map(x => x.id);
}
```

Both the batch card (§4) and row ▶ (§3) call this. Batch grouping is
recomputed every `refreshPreviews()` from scratch — no persistence
needed; `created_at` is stable enough.

**Estimated effort:** 1 medium commit, ~80–120 lines + CSS.

---

## 3. Play from the Files tab without "select first"

**What David is asking for:** the drawer is the inventory. He should be
able to play any audio file directly from its row, not have to:
1. check the row to put it in `selectedPreviewIds`,
2. open the tray,
3. hit ▶ Play N.

**What exists today:**

- **Expanding a row** renders an inline `<audio controls>` element via
  `fileBodyHtml(...)` at `app-drawer.js:520-524`. So if you tap the row
  open, you DO get a player. But you don't see it without expanding.
- **Row-level play button: not done.** The row header at line 612-614
  shows icon + title + time + type + delete-× but has no play affordance.

**Proposed:**

Add a small **play-from-row** button on `fp-kind-audio` and `fp-kind-voice`
rows in `renderDrawer()`:

```
[🎵] file_name.mp3            [▶]    2m    Audio    ×
```

Click ▶ → seeds `_playbackQueue` with **just this file** (or this file
followed by all other audio rows in the current drawer order — TBD by
David's preference), calls `_playCurrent()`. The now-playing strip in the
tray (`app-drawer.js:254-263`) handles the rest — already built.

**This is small.** The infra is there; we're just adding an entry point
that doesn't require selection.

**Decided 2026-06-17 (David):** Row ▶ plays **the generation batch the
row belongs to** — not just the one file, not the whole drawer. Reason:
David's workflow is "generate a group → listen to the group → pick a
couple to reference for the next generation." The batch is the natural
unit of attention; he'll select within it manually after listening.

This means §3 and §4 share a primitive — **"which batch does this file
belong to?"** — so they should ship together or §3 should land after §4
defines the batching logic. See §4 for the batch-detection rule. The row
▶ handler becomes:

```js
function playFromRow(previewId) {
  const batchIds = batchMembersOf(previewId);   // shared helper
  _playbackQueue = batchIds.map(toAudioItem);
  _playbackIndex = batchIds.indexOf(previewId);
  _playCurrent();
}
```

If the row has no batch siblings (singleton arrival), queue length = 1
and ▶ just plays it.

**Estimated effort:** 1 small commit, ~30 lines + CSS, **after §4 lands
the `batchMembersOf` helper**.

---

## 4. Group files by date with stronger headers

**What David is asking for:** he wants files **separated by dates** so he
can sort by when they came in.

**What exists today:**

- **Time-bucket grouping IS implemented**, but only for `sortMode ===
  "newest"` or `"oldest"` (`app-drawer.js:571-585`). The buckets are:
  `Last hour`, `Today`, `Yesterday`, `This week`, `Older`.
- **Default sort is `"newest"`** (`app-drawer.js:26` reads from
  `localStorage["llmt_file_sort"]` with fallback to newest).
- So the grouping is **already on by default**. David may not have noticed
  it because the bucket headers (`drawer-group-h`) are visually quiet, or
  because the `Older` bucket is the catch-all and his TTS files all land
  there.

**Two real gaps:**

1. **The `Older` bucket is opaque.** Everything past 7 days collapses into
   one heap with no calendar grouping. For someone who comes back to
   listen to a week-old voiceover take, this is unhelpful.
2. **Headers are too quiet** visually. `drawer-group-h` is rendered with
   tiny grey text — David's voice note implied he hadn't noticed dates at
   all.

**Proposed:**

1. **Replace `Older` with calendar-date buckets** (e.g. `"Jun 14"`,
   `"Jun 12"`, `"Jun 8"`, then `"May"`, then `"Apr"`, then `"2025"`).
   Generate dynamically from each file's mtime. This works for `newest`
   and `oldest` sort modes.
2. **Visual: stronger date headers** — bigger font, sticky positioning so
   the current bucket name stays visible at the top of the scroll
   viewport while you scroll its files. CSS-only.
3. **Type-sort ALSO sub-groups by date.** **Decided 2026-06-17 (David):** when
   `sortMode === "type"`, render two-level headers — outer = type label
   (Audio / Image / PDF / …), inner = date buckets per §2.1 (calendar
   months/dates). The "name" sort stays flat alphabetical (no date sub-group)
   since "name" implies the user is hunting by string, not time.

**Estimated effort:** 1 small commit (date buckets + sticky CSS), ~40 lines.

---

## Plan — execution order

The bug fix in §1 is unrelated to §2-4 and is **shortest path to relief**.
Suggest doing it first as its own commit, then design + ship §2-4 once
David confirms the direction:

| # | Step | Files touched | Commit type |
|---|---|---|---|
| 1 | Fix cross-chat player leak: move cleanup into `_teardownAndConnect`, kill dead block in `connect`, also close file modal + reset `expandedPreviewId` | `web/public/app-ws.js`, `web/public/app-drawer.js` | `fix` |
| 2 | Strengthen date grouping: replace `Older` bucket with calendar months/dates, sticky headers | `app-drawer.js`, `styles.css` | `feat` |
| 3 | Batch-detection helper + audio-batch playlist card for TTS / multi-file generation runs (no auto-play). Lands `batchMembersOf()` for §4. | `app-drawer.js` (`addInlineAudioBatch`, `batchMembersOf`), `styles.css` | `feat` |
| 4 | Row-level ▶ button on audio rows: plays the file's batch via `batchMembersOf()` | `app-drawer.js`, `styles.css` | `feat` |

Note: §3 and §4 swapped order from the original draft — §4's row ▶ now
reuses §3's batch helper, so the playlist card lands first.

**Verification plan** (per CLAUDE.md "test in Playwright before shipping"):

After each step, drive the UI in Playwright at iPhone 14 viewport (390×844)
and screenshot:
- §1: open narrativeHero chat in tab A → start playing an audio queue →
  switch to llmTerminal chat → confirm now-playing strip vanishes,
  `selectedPreviewIds` empties in localStorage, no audio audible (network
  panel: no requests to `/api/file?path=…mp3`).
- §2: load a chat with files spanning multiple weeks → confirm calendar
  buckets render, scroll behavior leaves headers sticky.
- §3: trigger a synthetic 3-audio-file generation in narrativeHero (or
  fake by pinning 3 audio files in quick succession via `llmt_show_file`)
  → confirm batch card renders in chat thread with all 3 tracks, ▶ plays
  the whole batch, no audio fires on arrival.
- §4: tap ▶ on a single audio row whose batch has 3 siblings → confirm
  queue length is 3 starting at the tapped track, now-playing strip
  appears, no row-selection state created. Tap ▶ on a singleton row →
  queue length is 1.

---

## What this plan does NOT do

- **Doesn't touch the supervisors / contract-check** (`web/src/supervisors.js`)
  — they don't sit in this flow.
- **Doesn't restructure how attribution decides which files belong to
  which chat.** The backend at `web/server.js:281-296` and
  `web/src/attribution.js` are correct; this is a frontend hygiene + UX
  pass. If audit reveals an attribution bug surfacing in §1's testing,
  call it out as a separate work item.
- **Doesn't add a service worker / offline audio caching.** Out of scope;
  CLAUDE.md forbids without explicit approval.
- **Doesn't tackle "voice note vs. audio file" terminology cleanup.**
  Voice notes are intentionally hidden from `All` view (app-drawer.js:543);
  this is by design and David's "audio files" complaint is about
  agent-generated audio, not his own voice notes.

### Known related limitation (out of scope)

**Reloading into a sibling chat in the same project** can carry over a
selection from another chat, because `selectedPreviewIds` lives in
`localStorage["llmt_selected_previews"]` and preview IDs are shared across
chats in a project (the `/api/previews?project=X` path). The §1 fix catches
chat→chat switches via the sidebar but NOT this fresh-boot case — there is
no "old session" to detect.

Two ways to handle if it comes up:
- **Persist selection per-session** (key = `llmt_selected_previews_<session>`)
  — clean but adds a small storage-key proliferation.
- **Clear selection on every fresh load** (session-tab-scoped) — simpler,
  loses the "I was about to attach files, then reloaded" affordance.

Punting on this until David hits it; the §1 fix covers the case he flagged.
