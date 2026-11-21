// =============================================================================
// mobile_remote_html.hpp
// -----------------------------------------------------------------------------
// A tiny, dependency-free single-page remote control, served directly by the
// C++ server (GET /remote) so a phone on the same WiFi can open it in any
// browser — no app, no build step, no static-file infrastructure needed.
//
// It talks to its own dedicated, Public-tier wrapper API — see
// control_server.cpp's "Mobile remote: its own Public-tier API" block —
// rather than the real /api/project/*, /api/selection, /api/transport/*
// routes Companion and the desktop client use, since a phone has no way to
// hold a login session: GET /api/remote/header, GET /api/remote/items,
// GET /api/remote/summary (polled), POST /api/remote/select,
// GET/POST /api/remote/go, GET/POST /api/remote/cart/<n>/play.
//
// Two screens, switched by a bottom tab bar:
//   - Cue List: the show's cues (top, scrollable, tap to select) with
//     PREV / GO / NEXT at the bottom.
//   - Hot Buttons: a grid of the project's cart slots (tap to fire).
//
// No auth — same open-on-the-LAN posture the REST API already has for
// Companion. Kept as one plain HTML/CSS/JS string so it ships inside the
// server binary with no packaging changes.
// =============================================================================
#pragma once

namespace liveplay::net {

inline constexpr const char* kMobileRemoteHtml = R"HTML(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>LivePlay Remote</title>
<style>
  :root {
    --bg: #121212;
    --surface: #1c1c1c;
    --surface-2: #262626;
    --border: #333;
    --text: #f0f0f0;
    --text-dim: #9a9a9a;
    --accent: #DA1E28;
    --accent-dim: #6b1016;
    --green: #2eb872;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overscroll-behavior: none;
    user-select: none;
  }
  #app {
    display: flex; flex-direction: column;
    height: 100vh; height: 100dvh;
  }
  /* ---- header ---- */
  #topbar {
    flex: 0 0 auto;
    padding: 10px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
    font-size: 14px;
  }
  #projectName { font-weight: 600; }
  #connDot {
    width: 9px; height: 9px; border-radius: 50%;
    background: var(--green);
    flex: 0 0 auto;
  }
  #connDot.bad { background: var(--accent); }
  /* ---- screens ---- */
  .screen { flex: 1 1 auto; display: none; min-height: 0; flex-direction: column; }
  .screen.active { display: flex; }

  /* ---- cue list ---- */
  #cueList {
    flex: 1 1 auto; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 6px;
  }
  .cue-row {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 10px;
    margin-bottom: 4px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid transparent;
  }
  .cue-row.group {
    background: transparent;
    color: var(--text-dim);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 10px 10px 4px;
    margin-bottom: 0;
  }
  .cue-row.selected { border-color: var(--accent); }
  .cue-row.playing { background: var(--accent-dim); }
  .cue-dot {
    width: 10px; height: 10px; border-radius: 3px;
    flex: 0 0 auto;
  }
  .cue-name { flex: 1 1 auto; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cue-playing-badge {
    font-size: 11px; font-weight: 700; color: var(--green);
    flex: 0 0 auto;
  }
  .cue-warn { color: #ffc400; font-size: 13px; flex: 0 0 auto; }

  /* ---- transport bar ---- */
  #transport {
    flex: 0 0 auto;
    display: flex; gap: 8px;
    padding: 10px;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  #transport button {
    flex: 1 1 0;
    padding: 18px 0;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 15px; font-weight: 700;
  }
  #transport button:active { background: #333; }
  #goBtn {
    background: var(--green) !important;
    color: #04210f !important;
    border-color: var(--green) !important;
    flex: 1.4 1 0 !important;
    font-size: 18px !important;
  }
  #goBtn:active { filter: brightness(0.85); }

  /* ---- hot buttons ---- */
  #cartGrid {
    flex: 1 1 auto; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    padding: 12px;
    align-content: start;
  }
  .cart-btn {
    aspect-ratio: 1.3;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 8px;
    font-size: 14px; font-weight: 600;
    line-height: 1.25;
  }
  .cart-btn:active { filter: brightness(0.8); }
  .cart-btn.empty {
    background: transparent; color: var(--text-dim);
    border-style: dashed;
    font-weight: 400; font-size: 12px;
  }

  /* ---- bottom tab bar ---- */
  #tabbar {
    flex: 0 0 auto;
    display: flex;
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
  #tabbar button {
    flex: 1 1 0;
    padding: 12px 0 10px;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 13px;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
  }
  #tabbar button.active { color: var(--accent); }
  #tabbar .tab-icon { font-size: 20px; }

  .empty-msg { padding: 24px 16px; color: var(--text-dim); text-align: center; font-size: 14px; }
</style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <span id="projectName">LivePlay Remote</span>
    <span id="connDot" class="bad"></span>
  </div>

  <div id="cuelistScreen" class="screen active">
    <div id="cueList"><div class="empty-msg">Loading…</div></div>
    <div id="transport">
      <button id="prevBtn">PREV</button>
      <button id="goBtn">GO</button>
      <button id="nextBtn">NEXT</button>
    </div>
  </div>

  <div id="hotButtonsScreen" class="screen">
    <div id="cartGrid"><div class="empty-msg">Loading…</div></div>
  </div>

  <div id="tabbar">
    <button id="tabCuelist" class="active">
      <span class="tab-icon">&#9776;</span>
      <span>Cue List</span>
    </button>
    <button id="tabHotButtons">
      <span class="tab-icon">&#9638;</span>
      <span>Hot Buttons</span>
    </button>
  </div>
</div>

<script>
(function () {
  'use strict';

  var state = {
    itemsByUuid: {},   // uuid -> { name, color, type, mediaFileName, depth }
    order: [],         // flat render order: { kind: 'group'|'item', uuid, depth, name }
    cartItems: [],      // [{slot, itemUuid}]
    selectedUuid: null,
    playingUuids: {},   // uuid -> true
  };

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().catch(function () { return {}; });
    });
  }

  function setConn(ok) {
    var dot = document.getElementById('connDot');
    if (ok) dot.classList.remove('bad'); else dot.classList.add('bad');
  }

  // ---- build the flat render order from the nested item tree ----
  function flatten(items, depth, out, byUuid) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.uuid) continue;
      byUuid[it.uuid] = {
        name: it.displayName || '(untitled)',
        color: it.color || '#555',
        type: it.type,
        mediaFileName: it.mediaFileName,
        depth: depth,
      };
      if (it.type === 'group') {
        out.push({ kind: 'group', uuid: it.uuid, depth: depth, name: it.displayName || '(untitled)' });
        if (Array.isArray(it.children)) flatten(it.children, depth + 1, out, byUuid);
      } else {
        out.push({ kind: 'item', uuid: it.uuid, depth: depth });
      }
    }
  }

  function loadShow() {
    return Promise.all([
      api('/api/remote/header'),
      api('/api/remote/items?limit=1000'),
    ]).then(function (res) {
      var header = res[0], itemsRes = res[1];
      document.getElementById('projectName').textContent = header.name || 'LivePlay Remote';

      var byUuid = {};
      // Cart-only items (cart slots that aren't in the main playlist) resolve
      // their name/colour from here.
      flatten(header.cartOnlyItems || [], 0, [], byUuid);
      var order = [];
      flatten(itemsRes.items || [], 0, order, byUuid);

      state.itemsByUuid = byUuid;
      state.order = order;
      state.cartItems = header.cartItems || [];

      renderCueList();
      renderCartGrid();
    });
  }

  function renderCueList() {
    var el = document.getElementById('cueList');
    if (state.order.length === 0) {
      el.innerHTML = '<div class="empty-msg">No cues yet.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < state.order.length; i++) {
      var row = state.order[i];
      var facts = state.itemsByUuid[row.uuid] || {};
      var indent = (row.depth * 14);
      if (row.kind === 'group') {
        html += '<div class="cue-row group" style="padding-left:' + (10 + indent) + 'px">' +
          escapeHtml(row.name) + '</div>';
        continue;
      }
      var selected = state.selectedUuid === row.uuid;
      var playing = !!state.playingUuids[row.uuid];
      var noMedia = facts.type === 'audio' && !facts.mediaFileName;
      html += '<div class="cue-row' + (selected ? ' selected' : '') + (playing ? ' playing' : '') +
        '" style="padding-left:' + (10 + indent) + 'px" data-uuid="' + row.uuid + '">' +
        '<span class="cue-dot" style="background:' + (facts.color || '#555') + '"></span>' +
        '<span class="cue-name">' + escapeHtml(facts.name || '') + '</span>' +
        (noMedia ? '<span class="cue-warn">&#9888;</span>' : '') +
        (playing ? '<span class="cue-playing-badge">PLAYING</span>' : '') +
        '</div>';
    }
    el.innerHTML = html;
  }

  function renderCartGrid() {
    var el = document.getElementById('cartGrid');
    var bySlot = {};
    for (var i = 0; i < state.cartItems.length; i++) {
      bySlot[state.cartItems[i].slot] = state.cartItems[i];
    }
    var html = '';
    for (var slot = 0; slot < 16; slot++) {
      var entry = bySlot[slot];
      if (!entry || !entry.itemUuid) {
        html += '<div class="cart-btn empty">' + (slot + 1) + '</div>';
        continue;
      }
      var facts = state.itemsByUuid[entry.itemUuid] || {};
      html += '<div class="cart-btn" style="border-color:' + (facts.color || '#555') +
        '" data-slot="' + slot + '">' + escapeHtml(facts.name || ('Slot ' + (slot + 1))) + '</div>';
    }
    el.innerHTML = html || '<div class="empty-msg">No hot buttons assigned.</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- live state polling ----
  function pollSummary() {
    api('/api/remote/summary').then(function (s) {
      setConn(true);
      var sel = s.selection && s.selection.itemUuid ? s.selection.itemUuid : null;
      var playing = {};
      (s.playing || []).forEach(function (p) { playing[p.itemUuid] = true; });

      var selChanged = sel !== state.selectedUuid;
      var playChanged = JSON.stringify(Object.keys(playing).sort()) !==
                         JSON.stringify(Object.keys(state.playingUuids).sort());

      state.selectedUuid = sel;
      state.playingUuids = playing;

      if (selChanged || playChanged) renderCueList();
    }).catch(function () { setConn(false); });
  }

  // ---- actions ----
  function select(uuid) {
    api('/api/remote/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemUuid: uuid }),
    }).catch(function () {});
  }
  function step(delta) {
    api('/api/remote/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta: delta }),
    }).catch(function () {});
  }
  function go() {
    api('/api/remote/go', { method: 'POST' }).catch(function () {});
  }
  function fireCart(slot) {
    api('/api/remote/cart/' + slot + '/play', { method: 'POST' }).catch(function () {});
  }

  // ---- wiring ----
  document.getElementById('cueList').addEventListener('click', function (e) {
    var row = e.target.closest('.cue-row');
    if (!row || !row.dataset.uuid) return;
    select(row.dataset.uuid);
  });
  document.getElementById('cartGrid').addEventListener('click', function (e) {
    var btn = e.target.closest('.cart-btn');
    if (!btn || btn.classList.contains('empty')) return;
    fireCart(parseInt(btn.dataset.slot, 10));
  });
  document.getElementById('prevBtn').addEventListener('click', function () { step(-1); });
  document.getElementById('nextBtn').addEventListener('click', function () { step(1); });
  document.getElementById('goBtn').addEventListener('click', go);

  var tabCuelist = document.getElementById('tabCuelist');
  var tabHotButtons = document.getElementById('tabHotButtons');
  var cuelistScreen = document.getElementById('cuelistScreen');
  var hotButtonsScreen = document.getElementById('hotButtonsScreen');
  tabCuelist.addEventListener('click', function () {
    tabCuelist.classList.add('active'); tabHotButtons.classList.remove('active');
    cuelistScreen.classList.add('active'); hotButtonsScreen.classList.remove('active');
  });
  tabHotButtons.addEventListener('click', function () {
    tabHotButtons.classList.add('active'); tabCuelist.classList.remove('active');
    hotButtonsScreen.classList.add('active'); cuelistScreen.classList.remove('active');
  });

  loadShow().catch(function () { setConn(false); });
  setInterval(pollSummary, 1000);
  setInterval(function () { loadShow().catch(function () {}); }, 15000);
})();
</script>
</body>
</html>
)HTML";

}  // namespace liveplay::net
