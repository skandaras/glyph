/* ============================================================
   tests.js — checks for the pure recogniser maths.
   Run with: node tests.js
   Ends with ALL TESTS PASSED when everything holds.
   ============================================================ */
"use strict";
const r = require("./recogniser.js");

let failures = 0;
function check(label, cond) {
  if (cond) { console.log("  ok  " + label); }
  else { console.log("  FAIL " + label); failures++; }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }

/* ---- builders ---- */
const mk = (ss) => ({ strokes: ss.map(pts => ({
  points: pts.map((p, i) => ({ x: p[0], y: p[1], t: i * 8, pressure: 0.5 }))
})) });
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

console.log("ring detection");
{
  const closed = mk([arc(400, 300, 150, -175, 185, 3)]);
  const open = mk([arc(400, 300, 150, -175, 175, 3)]);
  const bracket = mk([arc(400, 300, 150, -60, 60, 3)]);
  const v1 = r.testRingCandidate(closed.strokes[0]);
  const v2 = r.testRingCandidate(open.strokes[0]);
  const v3 = r.testRingCandidate(bracket.strokes[0]);
  check("full circle is a ring", v1.isRing);
  check("fitted radius ~150", near(v1.radius, 150, 1));
  check("closed ring gap tiny", v1.gapDeg < 10);
  check("350 deg arc is a ring", v2.isRing);
  check("120 deg arc is not a ring", !v3.isRing);
  const twoPart = r.testRingGlyph(mk([arc(400, 300, 150, -90, 90, 3), arc(400, 300, 150, 90, 270, 3)]));
  check("two-part circle is a ring", twoPart.isRing);
  check("two-part ring radius ~150", near(twoPart.radius, 150, 1));
  const found = r.detectRing([
    mk([arc(400, 300, 20, 0, 300, 5)]).strokes[0],
    mk([arc(400, 300, 150, -175, 185, 3)]).strokes[0]
  ]);
  check("detectRing picks the big circle", found && near(found.info.radius, 150, 1));
  check("ringIsClosed: 2 deg yes, 20 deg no", r.ringIsClosed(2) && !r.ringIsClosed(20));
}

console.log("layer bands");
{
  check("0.1R center", r.layerOf(0.1) === "center");
  check("0.5R middle", r.layerOf(0.5) === "middle");
  check("0.9R outer", r.layerOf(0.9) === "outer");
  check("1.0R boundary", r.layerOf(1.0) === "boundary");
  check("1.02R boundary", r.layerOf(1.02) === "boundary");
  check("1.2R outside", r.layerOf(1.2) === "outside");
}

console.log("sectors and intrinsic angles");
{
  check("frame 0: canvas -45 = NE", r.sectorOf(-45, 0) === "NE");
  check("frame 90: canvas -45 = NW", r.sectorOf(-45, 90) === "NW");
  check("frame 0: canvas 45 = SE", r.sectorOf(45, 0) === "SE");
  check("frame 0: canvas 180 = W", r.sectorOf(180, 0) === "W");
  check("intrinsic: pointing at centre = 0", near(r.intrinsicAngleDeg(0, 180), 0));
  check("intrinsic: pointing away = 180", near(r.intrinsicAngleDeg(180, 180), 180));
  check("intrinsic: along the ring = ±90", near(Math.abs(r.intrinsicAngleDeg(90, 0)), 90));
}

console.log("$P recogniser invariants");
{
  const A = mk([line(-100, -100, 100, 100, 10), line(-100, 100, 100, -100, 10)]);
  const B = mk([line(100, -100, -100, 100, 10), line(100, 100, -100, -100, 10)]);
  // One-stroke X: the pen retraces the first diagonal to get to
  // the start of the second one. Same ink, one stroke.
  const C = mk([line(-100, -100, 100, 100, 10)
    .concat(line(100, 100, -100, -100, 10).slice(1))
    .concat(line(-100, -100, -100, 100, 10).slice(1))
    .concat(line(-100, 100, 100, -100, 10).slice(1))]);
  // Same circle traversed the opposite way: reverse the points.
  const circPts = arc(0, 0, 100, -178, 182, 4);
  const circle = mk([circPts]);
  const circleACW = mk([circPts.slice().reverse()]);
  const dAB = r.glyphDistance(A, B);
  const dAC = r.glyphDistance(A, C);
  const dAX = r.glyphDistance(A, circle);
  const dCC = r.glyphDistance(circle, circleACW);
  const dAA = r.glyphDistance(A, A);
  check("same glyph distance 0", dAA < 1e-9);
  check("reversed order/direction ~ same glyph", dAB < 0.1);
  check("retraced one-stroke X ~ two-stroke X", dAC < 0.5 /* $P is density-sensitive; a retraced stroke reads same-shape within this */);
  check("clockwise and anticlockwise circles match", dCC < 0.1);
  check("X vs circle clearly different", dAX > 0.4 && dAX > dAB * 4);
  const tmpls = [
    { name: "cross", samples: [A, B, C] },
    { name: "circle", samples: [circle] }
  ];
  const hit = r.classify(C, tmpls);
  check("classify X -> cross", hit.name === "cross");
  const circ = r.classify(circle, tmpls);
  check("classify circle -> circle", circ.name === "circle");
  const junk = r.classify(mk([[line(0, 0, 80, 60, 8)].concat([[line(80, 60, -60, 90, 8).slice(1)]])]), tmpls);
  check("scribble rejected as unknown", junk.name === "unknown");
  const none = r.classify(A, []);
  check("no templates -> unknown", none.name === "unknown");
}

console.log("geometry helpers");
{
  const g = mk([line(0, 0, 100, 0, 20), line(100, 0, 100, 50, 20)]);
  check("extent ~ diagonal", near(r.extentOf(g), Math.hypot(100, 50), 2));
  check("principal axis of L-glyph ~ NE-ish", r.principalAxisOf(g) > 0);
  const circleGlyph = mk([arc(0, 0, 80, -178, 182, 4)]);
  const arrowish = mk([line(0, 0, 100, 0, 20).concat([[115, 0], [90, -20], [90, 20]])]);
  check("circle axis reads as symmetric", r.sigilAxisHeadingDeg(circleGlyph) === null);
  const arrowHead = r.sigilAxisHeadingDeg(arrowish);
  check("arrow-like glyph has an axis heading", arrowHead !== null);
  check("arrow axis points along drawing direction", Math.abs(arrowHead) < 30);
  const simplified = r.simplifyStrokeRDP(
    arc(0, 0, 100, 0, 350, 2).map(p => ({ x: p[0], y: p[1], t: 0, pressure: 0.5 })), 2.0);
  check("RDP keeps endpoints and cuts bulk", simplified.length >= 2 && simplified.length < 60);
  const resampled = r.resampleGlyph(g, 32);
  check("resample yields exactly 32", resampled.length === 32);
}

if (failures === 0) {
  console.log("ALL TESTS PASSED");
} else {
  console.log(failures + " TEST(S) FAILED");
  process.exit(1);
}
