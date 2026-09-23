/* ============================================================
   smoke-app.js — harness for app.js's bench + export logic.
   Fakes a minimal browser (DOM, canvas, localStorage) in plain
   node, loads app.js in a vm sandbox, and drives the expression
   drill and wire export through the real code paths. Pure
   modules stay node-required; only the app layer is faked.
   ============================================================ */
"use strict";

/* ---------------- the fake browser ---------------- */

function makeEl(id, tag) {
  return {
    id: id || "",
    tagName: (tag || "div").toUpperCase(),
    textContent: "",
    innerHTML: "",
    value: "10",
    checked: true,
    files: [],
    style: {},
    classList: {
      _s: new Set(["hidden"]),   // new elements start hidden, like index.html
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    children: [],
    appendChild(c) { this.children.push(c); },
    append(...c) { this.children.push(...c); },
    replaceChildren(...c) { this.children = c; },
    addEventListener() {},
    onclick: null,
    onchange: null,
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 500 }; },
    setPointerCapture() {},
    getContext() {
      return {
        setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {},
        lineTo() {}, stroke() {}
      };
    }
  };
}

const elements = {};
for (const id of ["modeSelect", "palmToggle", "helpBtn", "ink", "debug",
  "dbgStrokes", "dbgPoints", "dbgGlyphs", "dbgTempl", "dbgUnknowns",
  "btnParse", "btnAst", "badge", "echoBox", "panel", "panelDraw",
  "panelTeach", "panelBench", "btnClear", "btnUndo", "glyphLog",
  "teachName", "btnTeachUndo", "templateList", "repsPerGlyph", "btnDrill",
  "btnLoo", "btnExprDrill", "exprCtl", "btnExprRead", "btnExprSkip",
  "benchStatus", "benchResults", "modal", "modalTitle", "modalBody",
  "modalButtons"]) {
  elements[id] = makeEl(id);
}
/* the modal starts visible-hidden; modal() unhides it */
elements.modal.classList._s.add("hidden");

let savedBlob = null;
global.localStorage = {
  setItem(k, v) { savedBlob = v; },
  getItem() { return savedBlob; }
};
global.performance = { now: () => Date.now() };
global.window = { devicePixelRatio: 1, addEventListener() {} };
global.requestAnimationFrame = () => 0;
global.document = {
  createElement(tag) { return makeEl("", tag); },
  createTextNode(t) { return { text: t }; },
  getElementById(id) { return elements[id] || null; }
};
global.Blob = class { constructor(parts) { this.text = parts.join(""); } };
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
/* fetch rejects like a non-served folder; the harness sets state.load
   directly, which is all the drill and parse paths need. */
global.fetch = () => Promise.reject(new Error("no server in the harness"));

/* ---------------- load app.js in the sandbox ---------------- */

const fs = require("fs");
const vm = require("vm");

const R = require("./recogniser.js");
const X = require("./lexicon.js");
const P = require("./parser.js");
const C = require("./compiler.js");

const sandbox = {
  console,
  document: global.document,
  localStorage: global.localStorage,
  performance: global.performance,
  window: global.window,
  requestAnimationFrame: global.requestAnimationFrame,
  Blob: global.Blob,
  URL: global.URL,
  setTimeout, clearTimeout,
  Date, JSON, Math, Set, Object, Array, String, Number, Boolean, isFinite,
  /* pure-module globals, exactly as the <script> tags provide them */
  parsePage: P.parsePage,
  compileAst: C.compileAst,
  renderIntent: C.renderIntent,
  buildWirePayload: C.buildWirePayload,
  loadLexiconData: X.loadLexiconData,
  classifyTemplateList: X.classifyTemplateList,
  classify: R.classify,
  boundsOf: R.boundsOf
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("app.js", "utf8"), sandbox,
  { filename: "app.js" });

/* const/let bindings do not attach to the sandbox object; pull the
   ones the checks need out through a line run in the same context. */
vm.runInContext(";globalThis.__x = { state, els, C_, renderResults, runParse," +
  " handleExpressionRead, handleExpressionSkip, startExpressionDrill, saveData };",
  sandbox, { filename: "expose.js" });
const app = sandbox.__x;

/* ---------------- the checks ---------------- */

let failures = 0;
function check(label, cond) {
  if (cond) console.log("  ok  " + label);
  else { console.log("  FAIL " + label); failures++; }
}

const elsOk = ["panelDraw", "panelTeach", "panelBench", "btnExprDrill",
  "exprCtl", "btnExprRead", "btnExprSkip"].every(k => !!app.els[k]);
check("all panel/button ids resolve", elsOk);

/* ---- fixture builders (same shapes as tests-language.js) ---- */
const line = (x0, y0, x1, y1, n) => {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);
  return pts;
};
const arc = (cx, cy, rad, a0, a1, step) => {
  const pts = [];
  for (let a = a0; a <= a1; a += step) {
    const t = a * Math.PI / 180;
    pts.push([cx + rad * Math.cos(t), cy + rad * Math.sin(t)]);
  }
  return pts;
};
const stroke = (pts, base) => ({
  points: pts.map((p, i) => ({ x: p[0], y: p[1], t: base + i * 4, pressure: 0.5 }))
});
const CX = 400, CY = 300, RING_R = 150;
const ringStroke = (base, closed) =>
  stroke(arc(CX, CY, RING_R, -175, closed ? 185 : 170, 3), base);
const beaconAt = (base) =>
  stroke([[CX - 40, CY], [CX, CY - 30], [CX, CY + 30], [CX + 40, CY]], base);
const pushAt = (base, tipX, tailX, y) => [
  stroke([[tailX, y === undefined ? CY : y], [tipX, y === undefined ? CY : y]], base),
  stroke([[tipX, y === undefined ? CY : y],
          [tipX + 13, (y === undefined ? CY : y) - 12],
          [tipX, y === undefined ? CY : y],
          [tipX + 13, (y === undefined ? CY : y) + 12]], base + 200)
];
const carryAt = (base) =>
  stroke([[CX + 55, CY - 75], [CX + 40, CY - 60], [CX + 55, CY - 60],
          [CX + 40, CY - 45], [CX + 55, CY - 45], [CX + 40, CY - 30]], base);
const haloAt = (base) => stroke(arc(CX, CY, 30, -178, 182, 4), base);
const anchorAt = (base) => [
  stroke(arc(CX, CY + 30, 45, 10, 170, 6), base),
  stroke(line(CX, CY - 60, CX, CY + 75, 12), base + 200),
  stroke(line(CX - 25, CY - 40, CX + 25, CY - 40, 6), base + 400)
];

/* ---- fixture: language files + trained templates ---- */
const lexData = JSON.parse(fs.readFileSync("data/lexicon.json", "utf8"));
const gramData = JSON.parse(fs.readFileSync("data/grammar.json", "utf8"));
const loaded = X.loadLexiconData(lexData, gramData);
app.state.load = loaded;
app.state.lexicon = loaded.lexicon;
app.state.grammar = loaded.grammar;
app.state.templateInfo = {};
for (const [tName, lexId] of Object.entries(loaded.templateOwner)) {
  app.state.templateInfo[tName] =
    { lexemeId: lexId, class: loaded.lexicon.lexemes[lexId].class };
}
/* the exact trained set tests-language.js uses, whose happy-path
   parse passes — same samples, same margins. */
app.state.trained = {
  beacon: [
    { strokes: [beaconAt(0)] },
    { strokes: [stroke(beaconAt(0).points.map(p => [p.x + 2, p.y - 3]), 0)] }
  ],
  anchor: [{ strokes: anchorAt(0) }],
  push: [{ strokes: pushAt(0, 30, 90) }],
  carry: [{ strokes: [carryAt(0)] }]
};

/* ---- expression drill: start, draw, read ---- */
app.startExpressionDrill();
check("drill starts with a queue",
  app.state.drill && app.state.drill.kind === "expression" &&
  app.state.drill.queue.length > 0);
check("drill items have sigil + 1-2 signs with slots",
  app.state.drill.queue.every(q => q.sigil && q.args.length >= 1 &&
    q.args.every(a => !!a.slot)));

/* make the queue deterministic: the page below is a beacon with
   push in the E slot. Two items so the session survives one Read. */
const item = { sigil: "beacon", args: [{ sign: "push", slot: "E" }] };
app.state.drill.queue = [item,
  { sigil: "beacon", args: [{ sign: "push", slot: "N" }] }];
app.state.drill.index = 0;

const page = [ringStroke(0, true), beaconAt(2000), ...pushAt(4000, 455, 495)];
app.state.page = page.slice();
app.state.groups = [{ id: "g", strokes: page }];
app.handleExpressionRead();

/* the session is still open (one item left) */
const trial = app.state.drill.results[0];
if (process.env.SMOKE_DEBUG) {
  vm.runInContext(";globalThis.__dbg = {" +
    " trainedKeys: Object.keys(state.trained)," +
    " tmpl: classifyTemplates().map(t => t.name + ':' + t.samples.length)," +
    " ast: parsePage(state.page, classifyTemplates(), state.templateInfo, state.grammar) };",
    sandbox);
  const d = sandbox.__dbg;
  console.log("--- sandbox parse debug ---");
  console.log("trained:", d.trainedKeys.join(", "));
  console.log("templates:", d.tmpl.join(", "));
  console.log("candidates:", d.ast.candidates.map(c =>
    [c.name, c.glyphClass, c.layer, c.sector]));
  console.log("unknowns:", d.ast.unknowns.map(u => u.strokeCount));
  console.log("trial readSigns:", trial.readSigns);
}
check("read recorded a trial", !!trial);
check("sigil read matches the target template name",
  trial.readSigil === trial.targetSigil);
check("sign+slot matches when the drawing matches the prompt",
  trial.readSigns.some(r => item.args.some(a =>
    a.sign === r.sign && a.slot === r.slot)));
check("compile ok on a clean expression", trial.compileOk === true);
check("echo captured", typeof trial.echo === "string" && trial.echo.length > 0);

/* ---- skip path: the second Skip empties the queue and the drill
   self-finishes, writing state.results ---- */
const before = app.state.drill.results.length;
app.handleExpressionSkip();
const res2 = app.state.results;
check("skip records a skipped trial and the drill self-finishes",
  res2 && res2.kind === "expression-drill" &&
  res2.trials.length === before + 1 &&
  res2.trials[res2.trials.length - 1].skipped === true);
check("renderResults survives the fake DOM",
  (() => { try { app.renderResults(); return true; } catch (e) {
    console.log("      " + e.message); return false; } })());

/* ---- wire export ---- */
app.state.page = [ringStroke(0, true), beaconAt(2000), ...pushAt(4000, 455, 495)];
app.runParse();
check("parse keeps the page for the wire export", !!app.state.lastParse);
const payload = app.C_.buildWirePayload(
  app.state.lastParse.page, app.state.lastParse.ast,
  app.state.lastParse.compiled);
check("exportWire path produces a v2 payload", payload.version === 2);
check("payload has strokes + ast + ir",
  payload.strokes.length === app.state.lastParse.page.length &&
  !!payload.ast && !!payload.ir);

/* ---- persistence still round-trips ---- */
app.saveData();
check("saveData wrote a blob",
  typeof savedBlob === "string" && savedBlob.indexOf("\"version\":1") !== -1);

if (failures === 0) {
  console.log("ALL TESTS PASSED");
} else {
  console.log(failures + " TEST(S) FAILED");
  process.exit(1);
}