/* ============================================================
   app.js — UI, drawing, screens. The ONLY file allowed to
   touch the page.

   Modes (header switch):
     draw   — strokes become a PAGE; Parse reads it as one
              expression (ring + sigil + signs) via parser.js
              and compiler.js; the echo box shows the result.
     teach  — finished glyphs become samples of the template
              named in the text field.
     bench  — drill (draw what the app names) and leave-one-out.

   Everything drawn is logged and saved (localStorage), and can
   be exported/imported as JSON.
   ============================================================ */
"use strict";

/* Pure modules are classic <script>s: their top-level functions
   are globals in the browser. Alias them so the code below reads
   the same under node-style names. */
const lexiconModule = globalThis.loadLexiconData ? globalThis : null;
const parserModule = globalThis.parsePage ? globalThis : null;
const compilerModule = globalThis.compileAst ? globalThis : null;
const recogniserModule = globalThis.classify ? globalThis : null;

/* ---------------- state ---------------- */
const GROUP_TIMEOUT_FALLBACK_MS = 500; // used until grammar.json loads

const state = {
  mode: "draw",
  grammar: null,        // validated grammar.json data
  lexicon: null,        // validated lexicon.json data
  load: null,           // loader result (errors/warnings/templateOwner)
  templateInfo: {},     // templateName -> { lexemeId, class }
  trained: {},          // templateName -> [Glyph, ...]
  drawLog: [],          // { when, mode, glyph } — every glyph ever
  page: [],             // Stroke[] on the current page (draw order)
  groups: [],           // finished glyph groups on the page, for undo
  pending: [],          // strokes of the glyph being drawn right now
  activePointer: null,
  currentStroke: null,
  groupingTimer: null,
  penSeen: false,       // palm-rejection latch
  results: null,        // last bench results {kind, trials}
  drill: null           // active drill session
};

/* ---------------- tiny DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);
const els = {};
["modeSelect","palmToggle","helpBtn","ink","debug","dbgStrokes","dbgPoints",
 "dbgGlyphs","dbgTempl","dbgUnknowns","btnParse","btnAst","badge","echoBox",
 "panel","panelDraw","panelTeach","panelBench","btnClear","btnUndo","glyphLog",
 "teachName","btnTeachUndo","templateList","repsPerGlyph","btnDrill","btnLoo",
 "benchStatus","benchResults","modal","modalTitle","modalBody","modalButtons"]
 .forEach(id => { els[id] = $(id); });

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

let badgeTimer = null;
function badge(text) {
  els.badge.textContent = text;
  show(els.badge);
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => hide(els.badge), 1800);
}

/* ---------------- modal ---------------- */
function modal(title, bodyNode, buttons) {
  els.modalTitle.textContent = title;
  els.modalBody.replaceChildren(bodyNode);
  const btns = buttons || [{ label: "Close" }];
  els.modalButtons.replaceChildren(
    ...btns.map(b => {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      if (b.ghost) btn.className = "ghost";
      btn.onclick = () => { hide(els.modal); if (b.action) b.action(); };
      return btn;
    })
  );
  show(els.modal);
}

function modalText(title, text) {
  const pre = document.createElement("pre");
  pre.className = "astview";
  pre.textContent = text;
  modal(title, pre);
}

/* ---------------- canvas ---------------- */
const canvas = els.ink;
const ctx = canvas.getContext("2d");
let viewW = 0, viewH = 0, dpr = 1;

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  viewW = Math.round(rect.width);
  viewH = Math.round(rect.height);
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

/* One redraw draws the whole page + the pending glyph. */
let needsDraw = true;
function redraw() { needsDraw = true; }
function frame() {
  if (needsDraw) {
    needsDraw = false;
    ctx.clearRect(0, 0, viewW, viewH);
    drawStrokes(state.page);
    drawStrokes(state.pending, "#7a4d1f");
  }
  requestAnimationFrame(frame);
}
function drawStrokes(strokes, color) {
  ctx.strokeStyle = color || "#1a1a1a";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
}

/* ---------------- pointer input ---------------- */
canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (state.activePointer !== null) return;      // one pen at a time
  if (e.pointerType === "touch" && state.penSeen && els.palmToggle.checked) {
    return;                                      // palm rejected
  }
  if (e.pointerType === "pen") state.penSeen = true;

  state.activePointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  state.currentStroke = { points: [] };
  state.pending.push(state.currentStroke);
  addPoint(e);
  stopGroupingTimer();
  redraw();
});

canvas.addEventListener("pointermove", (e) => {
  if (e.pointerId !== state.activePointer) return;
  e.preventDefault();
  const events = (typeof e.getCoalescedEvents === "function"
    && e.getCoalescedEvents().length > 0)
    ? e.getCoalescedEvents() : [e];
  for (const ev of events) addPoint(ev);
  redraw();
});

function endStroke(e) {
  if (e && e.pointerId !== state.activePointer) return;
  state.activePointer = null;
  state.currentStroke = null;
  startGroupingTimer();
  redraw();
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

function addPoint(e) {
  const rect = canvas.getBoundingClientRect();
  state.currentStroke.points.push({
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    t: performance.now(),
    pressure: (typeof e.pressure === "number" && e.pressure > 0)
      ? e.pressure : 0.5
  });
}

/* ---------------- glyph grouping ---------------- */
function groupingTimeoutMs() {
  return (state.grammar && state.grammar.groupingTimeoutMs)
    || GROUP_TIMEOUT_FALLBACK_MS;
}
function startGroupingTimer() {
  stopGroupingTimer();
  state.groupingTimer = setTimeout(finishPendingGlyph, groupingTimeoutMs());
}
function stopGroupingTimer() {
  if (state.groupingTimer) { clearTimeout(state.groupingTimer); state.groupingTimer = null; }
}

function finishPendingGlyph() {
  stopGroupingTimer();
  const strokes = state.pending.filter(s => s.points.length > 0);
  state.pending = [];
  if (strokes.length === 0) return;

  const glyph = { id: newGlyphId(), strokes, createdAt: Date.now() };

  if (state.mode === "draw") {
    // keep the ink on the page
    state.page.push(...strokes);
    state.groups.push(glyph);
  } else if (state.mode === "teach") {
    const name = els.teachName.value.trim();
    if (!name) {
      badge("type a template name first");
    } else {
      if (!state.trained[name]) state.trained[name] = [];
      state.trained[name].push(glyph);
      badge("sample saved to '" + name + "'");
      renderTemplates();
    }
  } else if (state.mode === "bench") {
    handleDrillGlyph(glyph);
  }

  logGlyph(glyph);
  updateDebug();
  redraw();
}

let idCounter = 0;
function newGlyphId() {
  idCounter += 1;
  return "g" + Date.now().toString(36) + "-" + idCounter;
}
function logGlyph(glyph) {
  state.drawLog.push({ when: Date.now(), mode: state.mode, glyph });
  saveData(); // brief 3: save automatically after every change
}

function undoLast() {
  const glyph = state.groups.pop();
  if (!glyph) { badge("nothing to undo"); return; }
  const remove = new Set(glyph.strokes);
  state.page = state.page.filter(s => !remove.has(s));
  badge("glyph removed");
  updateDebug();
  redraw();
}

function clearPage() {
  state.page = [];
  state.groups = [];
  hide(els.echoBox);
  badge("page cleared");
  updateDebug();
  redraw();
}

/* ---------------- pure pipeline calls ---------------- */
function classifyTemplates() {
  return lexiconModule.classifyTemplateList(state.trained);
}

function runParse() {
  if (state.page.length === 0) { badge("nothing on the page"); return; }
  if (!state.load || !state.load.ok) {
    badge("lexicon/grammar not loaded — parse disabled");
    return;
  }
  const ast = parserModule.parsePage(
    state.page, classifyTemplates(), state.templateInfo, state.grammar);
  const out = compilerModule.compileAst(ast, state.lexicon, state.grammar);
  els.echoBox.textContent = out.echo;
  show(els.echoBox);
  updateDebug(ast);
  return { ast, out };
}

/* ---------------- debug panel ---------------- */
function updateDebug(ast) {
  let strokeCount = state.page.length + state.pending.length;
  let lastPts = 0;
  const all = state.page.concat(state.pending);
  if (all.length > 0) lastPts = all[all.length - 1].points.length;
  els.dbgStrokes.textContent = String(strokeCount);
  els.dbgPoints.textContent = String(lastPts);
  els.dbgGlyphs.textContent = String(state.groups.length);
  els.dbgTempl.textContent = String(Object.keys(state.trained).length);
  els.dbgUnknowns.textContent = ast ? String(ast.unknowns.length) : "–";
}

/* ---------------- teach panel ---------------- */
function renderTemplates() {
  const wrap = els.templateList;
  wrap.replaceChildren();
  const names = Object.keys(state.trained);
  if (names.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "no templates yet";
    wrap.appendChild(p);
    return;
  }
  for (const name of names) {
    const card = document.createElement("div");
    card.className = "thumbcard";
    const title = document.createElement("strong");
    title.textContent = name;
    card.appendChild(title);
    const info = document.createElement("div");
    info.className = "meta";
    info.textContent = state.trained[name].length + " samples" +
      (state.templateInfo[name] ? " · " + state.templateInfo[name].class : " · not in lexicon");
    card.appendChild(info);
    for (const sample of state.trained[name]) {
      const row = document.createElement("div");
      row.appendChild(thumbnail(sample, 72, 54));
      const del = document.createElement("button");
      del.className = "delete ghost";
      del.textContent = "delete";
      del.onclick = () => {
        const list = state.trained[name];
        list.splice(list.indexOf(sample), 1);
        if (list.length === 0) delete state.trained[name];
        saveData();
        renderTemplates();
      };
      row.appendChild(del);
      card.appendChild(row);
    }
    wrap.appendChild(card);
  }
}

function thumbnail(glyph, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const R = globalThis; // recogniser is a browser global here
  const all = [];
  for (const s of glyph.strokes) for (const p of s.points) all.push(p);
  if (all.length > 0) {
    const b = R.boundsOf(all);
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    const scale = Math.min((w - 6) / bw, (h - 6) / bh);
    const ox = (w - bw * scale) / 2 - b.minX * scale;
    const oy = (h - bh * scale) / 2 - b.minY * scale;
    g.strokeStyle = "#1a1a1a"; g.lineWidth = 1.5;
    g.lineCap = "round"; g.lineJoin = "round";
    for (const s of glyph.strokes) {
      if (s.points.length === 0) continue;
      g.beginPath();
      g.moveTo(s.points[0].x * scale + ox, s.points[0].y * scale + oy);
      for (const p of s.points) g.lineTo(p.x * scale + ox, p.y * scale + oy);
      g.stroke();
    }
  }
  return c;
}

/* ---------------- bench ---------------- */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startDrill() {
  const names = Object.keys(state.trained);
  if (names.length === 0) { badge("teach some templates first"); return; }
  const reps = Math.max(1, parseInt(els.repsPerGlyph.value, 10) || 10);
  const queue = [];
  for (const n of names) for (let i = 0; i < reps; i++) queue.push(n);
  state.drill = { queue: shuffle(queue), index: 0, results: [] };
  showDrillPrompt();
}

function showDrillPrompt() {
  const d = state.drill;
  if (!d || d.index >= d.queue.length) { finishDrill(); return; }
  els.benchStatus.innerHTML =
    "draw <strong>" + d.queue[d.index] + "</strong> (" +
    (d.index + 1) + " of " + d.queue.length + ")";
}

function handleDrillGlyph(glyph) {
  const d = state.drill;
  if (!d) return;
  const target = d.queue[d.index];
  const cls = recogniserModule.classify(glyph, classifyTemplates());
  d.results.push({
    target, predicted: cls.name,
    score: cls.ranked[0] ? cls.ranked[0].score : 0,
    when: Date.now(), glyph
  });
  d.index += 1;
  saveData();
  showDrillPrompt();
}

function finishDrill() {
  state.results = { kind: "drill", trials: state.drill.results };
  state.drill = null;
  els.benchStatus.textContent = "drill done";
  renderResults();
}

function runLeaveOneOut() {
  const names = Object.keys(state.trained);
  if (names.length === 0) { badge("teach some templates first"); return; }
  const trials = [];
  for (const name of names) {
    const samples = state.trained[name];
    for (const held of samples) {
      const templates = classifyTemplates().map(t =>
        t.name === name
          ? { name: t.name, samples: t.samples.filter(s => s !== held) }
          : t);
      const usable = templates.filter(t => t.samples.length > 0);
      const cls = recogniserModule.classify(held, usable);
      trials.push({
        target: name, predicted: cls.name,
        score: cls.ranked[0] ? cls.ranked[0].score : 0,
        when: Date.now(), glyph: held
      });
    }
  }
  state.results = { kind: "leave-one-out", trials };
  els.benchStatus.textContent = "leave-one-out done";
  renderResults();
}

function renderResults() {
  const wrap = els.benchResults;
  wrap.replaceChildren();
  const res = state.results;
  if (!res || res.trials.length === 0) {
    wrap.appendChild(document.createTextNode("no results"));
    return;
  }
  const right = res.trials.filter(t => t.predicted === t.target).length;
  const head = document.createElement("p");
  head.innerHTML = "<strong>" + res.kind + "</strong>: " +
    right + " / " + res.trials.length + " correct (" +
    Math.round(100 * right / res.trials.length) + "%)";
  wrap.appendChild(head);

  // confusion matrix: rows = target, cols = predicted + unknown
  const labels = Object.keys(state.trained).slice();
  if (!labels.includes("unknown")) labels.push("unknown");
  const counts = {};
  for (const t of res.trials) {
    const key = t.target + "→" + t.predicted;
    counts[key] = (counts[key] || 0) + 1;
    if (!counts[key + "cells"]) counts[key + "cells"] = [];
    counts[key + "cells"].push(t);
  }
  const table = document.createElement("table");
  table.className = "matrix";
  const thead = document.createElement("tr");
  thead.appendChild(th("meant ↓ read →"));
  for (const col of labels) thead.appendChild(th(col));
  table.appendChild(thead);
  for (const row of labels.filter(l => l !== "unknown")) {
    const tr = document.createElement("tr");
    tr.appendChild(th(row));
    for (const col of labels) {
      const n = counts[row + "→" + col] || 0;
      const rowTotal = res.trials.filter(t => t.target === row).length;
      const td = document.createElement("td");
      td.textContent = n > 0 ? n + " (" + Math.round(100 * n / rowTotal) + "%)" : "·";
      if (row === col) td.classList.add("diag");
      else if (n > 0 && col !== "unknown") td.classList.add("off");
      if (n === 0) td.classList.add("zero");
      if (n > 0) {
        td.onclick = () => showCell(row, col, counts[row + "→" + col + "cells"]);
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);

  // worst 3 confusions, plain English
  const confusions = Object.keys(counts)
    .filter(k => k.indexOf("cells") === -1)
    .map(k => {
      const [target, predicted] = k.split("→");
      return { target, predicted, n: counts[k] };
    })
    .filter(c => c.target !== c.predicted && c.predicted !== "unknown")
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  if (confusions.length > 0) {
    const p = document.createElement("p");
    p.innerHTML = confusions.map(c =>
      "'" + c.target + "' was read as '" + c.predicted + "' " + c.n + "×"
    ).join("<br>");
    wrap.appendChild(p);
  }
  function th(t) {
    const x = document.createElement("th"); x.textContent = t; return x;
  }
}

function showCell(target, predicted, trials) {
  const card = document.createElement("div");
  card.className = "glyphlog";
  for (const t of trials) {
    const tc = document.createElement("div");
    tc.className = "thumbcard";
    tc.appendChild(thumbnail(t.glyph, 90, 68));
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = t.target + " · score " + t.score.toFixed(2);
    tc.appendChild(meta);
    card.appendChild(tc);
  }
  modal("'" + target + "' read as '" + predicted + "' — " + trials.length + " drawing(s)", card);
}

/* ---------------- persistence (task 3) ---------------- */
const STORAGE_KEY = "glyphlab.data.v1";

function saveData() {
  try {
    const blob = {
      version: 1,
      savedAt: new Date().toISOString(),
      templates: state.trained,
      drawLog: state.drawLog,
      lastResults: state.results
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch (e) {
    badge("could not save: " + e.message);
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const blob = JSON.parse(raw);
    if (blob.version !== 1) throw new Error("unknown data version " + blob.version);
    state.trained = blob.templates || {};
    state.drawLog = blob.drawLog || [];
    state.results = blob.lastResults || null;
  } catch (e) {
    modalText("Saved data could not be loaded", String(e));
  }
}

function exportData() {
  const blob = {
    version: 1,
    savedAt: new Date().toISOString(),
    templates: state.trained,
    drawLog: state.drawLog,
    lastResults: state.results
  };
  const text = JSON.stringify(blob, null, 2);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name = "glyphlab-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) +
    "-" + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + ".json";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  badge("exported " + name);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let blob;
    try {
      blob = JSON.parse(reader.result);
    } catch (e) {
      modalText("Import failed", "That file is not valid JSON: " + e.message);
      return;
    }
    if (!blob || blob.version !== 1 || typeof blob.templates !== "object") {
      modalText("Import failed",
        "This file is not a Glyph Lab export (missing version 1 templates). Nothing was changed.");
      return;
    }
    const doMerge = () => {
      for (const name of Object.keys(blob.templates)) {
        if (!state.trained[name]) state.trained[name] = [];
        state.trained[name].push(...blob.templates[name]);
      }
      state.drawLog.push(...(blob.drawLog || []));
    };
    const doReplace = () => {
      state.trained = blob.templates;
      state.drawLog = blob.drawLog || [];
      state.results = blob.lastResults || null;
    };
    modal("Import " + file.name,
      document.createTextNode("Merge with your current data, or replace it?"),
      [
        { label: "Merge", action: () => { doMerge(); afterImport(); } },
        { label: "Replace", action: () => { doReplace(); afterImport(); } },
        { label: "Cancel", ghost: true }
      ]);
  };
  reader.readAsText(file);
}
function afterImport() {
  saveData();
  renderTemplates();
  renderResults();
  badge("imported");
}

/* ---------------- mode switching ---------------- */
function setMode(mode) {
  state.mode = mode;
  hide(els.panelDraw); hide(els.panelTeach); hide(els.panelBench);
  if (mode === "draw") show(els.panelDraw);
  if (mode === "teach") { show(els.panelTeach); renderTemplates(); }
  if (mode === "bench") { show(els.panelBench); renderResults(); }
}

/* ---------------- data files (lexicon + grammar) ---------------- */
async function loadLanguageFiles() {
  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(url + " → HTTP " + res.status);
    return res.json();
  }
  try {
    const [lex, gram] = await Promise.all([
      getJson("data/lexicon.json"), getJson("data/grammar.json")
    ]);
    const loaded = lexiconModule.loadLexiconData(lex, gram);
    state.load = loaded;
    state.lexicon = loaded.lexicon;
    state.grammar = loaded.grammar;
    // templateName -> { lexemeId, class }
    state.templateInfo = {};
    for (const [tName, lexId] of Object.entries(loaded.templateOwner)) {
      const L = loaded.lexicon.lexemes[lexId];
      state.templateInfo[tName] = { lexemeId: lexId, class: L ? L.class : null };
    }
    if (!loaded.ok) {
      modalText("data files have errors — parse disabled until fixed",
        loaded.errors.join("\n") + (loaded.warnings.length
          ? "\n\nwarnings:\n" + loaded.warnings.join("\n") : ""));
    } else if (loaded.warnings.length > 0) {
      modalText("data files loaded with warnings", loaded.warnings.join("\n"));
    }
  } catch (e) {
    state.load = { ok: false, errors: [String(e)], warnings: [] };
    modalText("Could not load the language data",
      "The app still draws and teaches, but Parse needs data/lexicon.json and\n" +
      "data/grammar.json. Serve the folder with:\n\n    python3 -m http.server 8000\n\n" +
      String(e));
  }
}

/* ---------------- help ---------------- */
function showHelp() {
  const div = document.createElement("div");
  div.innerHTML =
    "<p><strong>Draw</strong> — every stroke you draw is kept on the page. " +
    "Pause ½ second and the strokes become one glyph (a small badge confirms it). " +
    "<em>Parse</em> (top right) reads the whole page as one expression: " +
    "a ring, one sigil inside it, signs between ring and sigil. " +
    "The echo box (bottom left) shows what it read.</p>" +
    "<p><strong>Teach</strong> — type a template name, draw the shape, " +
    "each finished glyph becomes one sample. Give each glyph 2–3 samples. " +
    "Template names must match those in data/lexicon.json.</p>" +
    "<p><strong>Bench</strong> — drill names a glyph, you draw it from memory; " +
    "leave-one-out scores your saved samples against themselves. " +
    "Both produce a confusion matrix; tap a red cell to see the drawings.</p>" +
    "<p><strong>Files</strong> — everything is saved in this browser automatically. " +
    "Export/Import moves it between devices (buttons below).</p>" +
    "<p><strong>Expression shape (v1)</strong> — one ring, one central sigil, " +
    "up to eight signs. An unclosed ring is a draft; close it to commit. " +
    "Slot sectors are named N, NE, E, SE, S, SW, W, NW around the sigil's own axis.</p>";
  modal("Glyph Lab — how to use this", div);
}

/* ---------------- wire up ---------------- */
function wire() {
  els.modeSelect.onchange = () => setMode(els.modeSelect.value);
  els.btnClear.onclick = clearPage;
  els.btnUndo.onclick = undoLast;
  els.btnParse.onclick = () => runParse();
  els.btnAst.onclick = () => {
    const r = runParse();
    if (r) modalText("GlyphAST → GlyphIR",
      JSON.stringify({ ast: r.ast, ir: r.out.ir }, null, 2));
  };
  els.btnTeachUndo.onclick = () => {
    const name = els.teachName.value.trim();
    const list = state.trained[name];
    if (!list || list.length === 0) { badge("nothing to undo"); return; }
    list.pop();
    if (list.length === 0) delete state.trained[name];
    saveData(); renderTemplates();
  };
  els.btnDrill.onclick = startDrill;
  els.btnLoo.onclick = runLeaveOneOut;
  els.helpBtn.onclick = showHelp;

  // file export/import (brief 3)
  const btnrow = document.createElement("div");
  btnrow.className = "btnrow";
  btnrow.style.marginTop = "10px";
  const exp = document.createElement("button");
  exp.className = "ghost"; exp.textContent = "Export";
  exp.onclick = exportData;
  const imp = document.createElement("button");
  imp.className = "ghost"; imp.textContent = "Import";
  const file = document.createElement("input");
  file.type = "file"; file.accept = "application/json"; file.className = "hidden";
  imp.onclick = () => file.click();
  file.onchange = () => { if (file.files[0]) importData(file.files[0]); file.value = ""; };
  btnrow.append(exp, imp, file);
  els.panelDraw.appendChild(btnrow);
}

/* ---------------- init ---------------- */
async function init() {
  wire();
  loadData();
  renderTemplates();
  setMode("draw");
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  requestAnimationFrame(frame);
  await loadLanguageFiles();
  updateDebug();
}
init();
