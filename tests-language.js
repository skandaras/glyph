/* ============================================================
   tests-language.js — end-to-end checks for the language core.
   Run with: node tests-language.js
   Uses the SHIPPED data files (data/lexicon.json,
   data/grammar.json), synthetic pages, and the real
   loader → parser → compiler pipeline.
   ============================================================ */
"use strict";
const fs = require("fs");
const R = require("./recogniser.js");
const X = require("./lexicon.js");
const P = require("./parser.js");
const C = require("./compiler.js");

let failures = 0;
function check(label, cond) {
  if (cond) { console.log("  ok  " + label); }
  else { console.log("  FAIL " + label); failures++; }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }

/* ---- fixture builders ------------------------------------------- */

const line = (x0, y0, x1, y1, n) => {
  const pts = [];
  for (let i = 0; i <= n; i++)
    pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);
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
/* A stroke drawn at a time base: points get t = base + i*4 ms.
   Glyphs are spaced >= 500 ms apart so the parser's pause
   grouping sees them as separate glyph groups. */
const stroke = (pts, base) => ({
  points: pts.map((p, i) => ({ x: p[0], y: p[1], t: base + i * 4, pressure: 0.5 }))
});

const CX = 400, CY = 300, RING_R = 150;
const ringStroke = (base, closed) =>
  stroke(arc(CX, CY, RING_R, -175, closed ? 185 : 170, 3), base);

/* sigil "beacon": an asymmetric zigzag centred on the ring
   centre, drawn left to right (axis heading ~0°). */
const beaconAt = (base) =>
  stroke([[CX - 40, CY], [CX, CY - 30], [CX, CY + 30], [CX + 40, CY]], base);

/* sigil "anchor": vertical-shaft anchor, drawn top to bottom. */
const anchorAt = (base) => [
  stroke(arc(CX, CY + 30, 45, 10, 170, 6), base),
  stroke(line(CX, CY - 60, CX, CY + 75, 12), base + 200),
  stroke(line(CX - 25, CY - 40, CX + 25, CY - 40, 6), base + 400)
];

/* sign "push": an arrow (shaft + head, two strokes, same glyph).
   tipX: where the arrowhead points; y: the row it sits on
   (default: the ring's horizontal through the centre). */
const pushAt = (base, tipX, tailX, y) => [
  stroke([[tailX, y === undefined ? CY : y], [tipX, y === undefined ? CY : y]], base),
  stroke([[tipX, y === undefined ? CY : y], [tipX + 13, (y === undefined ? CY : y) - 12],
          [tipX, y === undefined ? CY : y], [tipX + 13, (y === undefined ? CY : y) + 12]], base + 200)
];

/* sign "carry": a wavy line drawn from outside toward the
   centre-ish (axis heading down-left). */
const carryAt = (base) =>
  stroke([[CX + 55, CY - 75], [CX + 40, CY - 60], [CX + 55, CY - 60],
          [CX + 40, CY - 45], [CX + 55, CY - 45], [CX + 40, CY - 30]], base);

/* sigil "halo" (test-only): a small symmetric circle. */
const haloAt = (base) => stroke(arc(CX, CY, 30, -178, 182, 4), base);

/* ---- load the shipped data files -------------------------------- */
const lexData = JSON.parse(fs.readFileSync("data/lexicon.json", "utf8"));
const gramData = JSON.parse(fs.readFileSync("data/grammar.json", "utf8"));
const loaded = X.loadLexiconData(lexData, gramData);
const grammar = loaded.grammar, lexicon = loaded.lexicon;

/* classify-shaped template list + templateInfo, as the app builds
   them (samples would come from Teach mode; here synthetic). */
const trained = {
  anchor: [{ strokes: anchorAt(0) }],
  beacon: [
    { strokes: [beaconAt(0)] },
    { strokes: [stroke(beaconAt(0).points.map(p => [p.x + 2, p.y - 3]), 0)] }
  ],
  push: [{ strokes: pushAt(0, 30, 90) }],
  carry: [{ strokes: [carryAt(0)] }],
  halo: [{ strokes: [haloAt(0)] }]
};
const templateInfo = {};
for (const [tName, lexId] of Object.entries(loaded.templateOwner)) {
  templateInfo[tName] = { lexemeId: lexId, class: lexicon.lexemes[lexId].class };
}
const templates = X.classifyTemplateList(trained);

console.log("lexicon loader");
{
  check("shipped data loads clean", loaded.ok === true && loaded.errors.length === 0);
  const bad = X.loadLexiconData(
    { lexiconVersion: 1, lexemes: { "x.y": { name: "x", class: "wizard", templates: [], layers: [], orientationMode: "nope", scaleMode: "none", slotMode: "named", slots: [] } } },
    gramData);
  check("bad lexeme rejected with errors", !bad.ok && bad.errors.length >= 3);
  const dup = X.loadLexiconData(
    { lexiconVersion: 1, lexemes: {
      "a.b": { name: "a", class: "sign", templates: ["t1"], layers: ["middle"], orientationMode: "invariant", scaleMode: "none", slotMode: "anywhereInLayer" },
      "c.d": { name: "c", class: "sign", templates: ["t1"], layers: ["middle"], orientationMode: "invariant", scaleMode: "none", slotMode: "anywhereInLayer" }
    } }, gramData);
  check("duplicate template claim caught", !dup.ok &&
    dup.errors.some(e => e.indexOf("already claimed") !== -1));
}

console.log("parse + compile: the happy path");
{
  const page = [
    ringStroke(0, true),
    beaconAt(2000),
    ...pushAt(4000, 455, 495), // centroid ~0.5R: middle band, arrow pointing inward (east side)
    carryAt(6000)
  ];
  const ast = P.parsePage(page, templates, templateInfo, grammar);
  check("ring found, active (closed)", ast.ringState === "active" && ast.ring.closed);
  check("ring radius ~150", near(ast.ring.radius, RING_R, 2));
  check("frame anchored by the sigil", ast.frame.anchoredBy === "beacon");
  check("sigil axis heading ~0", ast.frame.offsetDeg !== null && Math.abs(ast.frame.offsetDeg) < 12);
  const names = ast.candidates.filter(c => c.glyphClass === "sign")
    .map(c => c.lexemeId).sort();
  check("candidates read as carry + push", JSON.stringify(names) === JSON.stringify(["sign.carry", "sign.push"]));
  const byLex = {};
  for (const c of ast.candidates) byLex[c.lexemeId] = c;
  check("push in middle layer, E sector", byLex["sign.push"].layer === "middle" && byLex["sign.push"].sector === "E");
  check("carry in middle layer, NE sector", byLex["sign.carry"].layer === "middle" && byLex["sign.carry"].sector === "NE");
  check("no unknowns", ast.unknowns.length === 0);

  const out = C.compileAst(ast, lexicon, grammar);
  check("compiles clean", out.ok === true && out.errors.length === 0);
  check("op is the sigil's element", out.ir.op === "beacon");
  check("state active", out.ir.state === "active");
  check("two sign args", out.ir.args.length === 2);
  const pushArg = out.ir.args.find(a => a.name === "push");
  check("push reads inward, slot E", pushArg.orientation === "inward" && pushArg.slot === "E");
  check("push has a degree word", typeof pushArg.degree === "string" && pushArg.degree.length > 0);
  check("echo names the sigil and commits", out.echo.indexOf("beacon") !== -1 && out.echo.indexOf("committed") !== -1);
}

console.log("open ring = draft");
{
  const page = [ringStroke(0, false), beaconAt(2000)];
  const ast = P.parsePage(page, templates, templateInfo, grammar);
  check("prepared state for an open ring", ast.ringState === "prepared" && !ast.ring.closed);
  const out = C.compileAst(ast, lexicon, grammar);
  check("echo says draft", out.ok && out.echo.indexOf("draft") !== -1 && out.ir.state === "prepared");
}

console.log("slot and layer rules come from the lexicon");
{
  const page = [ringStroke(0, true), beaconAt(2000),
    ...pushAt(4000, 428, 478, CY - 53)]; // centroid ~0.5R toward NE, middle band
  const ast = P.parsePage(page, templates, templateInfo, grammar);
  const out = C.compileAst(ast, lexicon, grammar);
  check("push in a disallowed slot is named", !out.ok &&
    out.errors.some(e => e.indexOf("sector") !== -1 && e.indexOf("NE") !== -1));

  const page2 = [ringStroke(0, true), beaconAt(2000),
    ...pushAt(4000, 545, 600)]; // centroid ~1.06R: outside the ring
  const ast2 = P.parsePage(page2, templates, templateInfo, grammar);
  const out2 = C.compileAst(ast2, lexicon, grammar);
  const pushC = ast2.candidates.find(c => c.lexemeId === "sign.push");
  check("1.06R reads as outside layer", pushC.layer === "outside");
  check("outside-layer sign is named", !out2.ok &&
    out2.errors.some(e => e.indexOf("outside") !== -1));
}

console.log("cardinality: exactly one ring, one sigil");
{
  const page = [ringStroke(0, true), ...pushAt(2000, 415, 470)];
  const ast = P.parsePage(page, templates, templateInfo, grammar);
  const out = C.compileAst(ast, lexicon, grammar);
  check("missing sigil named", !out.ok && out.errors.some(e => e.indexOf("no sigil") !== -1));

  const page2 = [ringStroke(0, true), beaconAt(2000), ...anchorAt(4000)];
  const ast2 = P.parsePage(page2, templates, templateInfo, grammar);
  const out2 = C.compileAst(ast2, lexicon, grammar);
  check("two sigils named", !out2.ok && out2.errors.some(e => e.indexOf("2 sigils") !== -1));

  const page3 = [...pushAt(0, 415, 470), beaconAt(2000)];
  const ast3 = P.parsePage(page3, templates, templateInfo, grammar);
  check("no ring -> ringState none", ast3.ringState === "none");
  const out3 = C.compileAst(ast3, lexicon, grammar);
  check("no ring named", !out3.ok && out3.errors.some(e => e.indexOf("no ring") !== -1));
}

console.log("unknowns are kept, not dropped");
{
  const scribble = stroke([[430, 300], [470, 270], [430, 340], [480, 320], [440, 350], [470, 290]], 6000);
  const page = [ringStroke(0, true), beaconAt(2000), scribble];
  const ast = P.parsePage(page, templates, templateInfo, grammar);
  check("scribble filed as unknown", ast.unknowns.length === 1);
  const out = C.compileAst(ast, lexicon, grammar);
  check("unknown mark blocks the compile", !out.ok &&
    out.errors.some(e => e.indexOf("could not be recognised") !== -1));
}

console.log("symmetric sigil: frame falls back, nothing breaks");
{
  const lex2 = JSON.parse(JSON.stringify(lexicon));
  lex2.lexemes["sigil.halo"] = {
    name: "halo", class: "sigil", templates: ["halo"], layers: ["center"],
    orientationMode: "invariant", scaleMode: "none", slotMode: "anywhereInLayer",
    slots: [], semantics: { element: "halo" }, notes: "test-only symmetric sigil"
  };
  const page = [ringStroke(0, true), haloAt(2000),
    ...pushAt(4000, 455, 495)];
  const templateInfo2 = Object.assign({}, templateInfo,
    { halo: { lexemeId: "sigil.halo", class: "sigil" } });
  const ast = P.parsePage(page, templates, templateInfo2, grammar);
  check("frame not anchored", ast.frame.offsetDeg === null);
  check("warning explains the fallback", ast.warnings.some(w => w.indexOf("too symmetric") !== -1));
  const out = C.compileAst(ast, lex2, grammar);
  check("compile still succeeds, slots unapplied", out.ok === true && out.ir.mode.anchored === false);
  const pushArg = out.ir.args.find(a => a.name === "push");
  check("push slot is null when unanchored", pushArg.slot === null && pushArg.orientation === "inward");
}

console.log("intent renderer + device wire payload (task 10)");
{
  const ir = { op: "beacon", name: "beacon", degree: null, args: [
    { name: "push", orientation: "inward", degree: "soft", slot: "E" }
  ] };
  check("renderIntent renders the echo sentence",
    C.renderIntent(ir) === "beacon — push inward, soft, in E");

  const page = [ringStroke(0, true), beaconAt(2000), ...pushAt(4000, 455, 495)];
  const ast = P.parsePage(page, templates, templateInfo, grammar);
  const out = C.compileAst(ast, lexicon, grammar);
  const payload = C.buildWirePayload(page, ast, out);
  check("wire payload is version 2", payload.version === 2);
  check("wire carries the GlyphAST and GlyphIR",
    payload.ast && payload.ir && Array.isArray(payload.ast.candidates));
  check("wire carries the ring measurement",
    payload.ring && near(payload.ring.radius, RING_R, 2));
  check("wire strokes are integers on the 1000 grid",
    payload.strokes.length === page.length &&
    payload.strokes.every(s => s.length > 0 && s.every(p =>
      Number.isInteger(p.x) && Number.isInteger(p.y) &&
      p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 1000)));
  check("a phone could recompile from the file alone",
    payload.compile && typeof payload.compile.ok === "boolean" &&
    payload.ast.candidates.length >= 2 && payload.ir.op);
  const bytes = JSON.stringify(payload).length;
  console.log("       payload size: " + bytes + " bytes");
  check("payload inside the 15KB budget", bytes > 0 && bytes <= 15000);
}

if (failures === 0) {
  console.log("ALL TESTS PASSED");
} else {
  console.log(failures + " TEST(S) FAILED");
  process.exit(1);
}
