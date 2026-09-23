/* ============================================================
   recogniser.js — recognition maths ONLY (pure, no DOM)
   ============================================================
   The app calls these functions with plain data (arrays of
   points) and gets plain data back. Nothing in this file knows
   a canvas or a browser exists. That is what lets us port it
   to C for the wrist device later.

   Contents:
     1. $P point-cloud recogniser (Vatavu, Anthony & Wobbrock
        2012, "Gestures as Point Clouds"). Stroke order and
        stroke direction do not affect the result.
     2. classify() — the two-threshold rejection wrapper.
     3. Geometry helpers (bounds, centroid, extent, axis).
     4. Ring detection (task 5): circle fit, angular gap,
        roundness — decides whether a stroke is the ring.
     5. Spatial channels (task 5): layer bands, sectors,
        sigil axis. All measured relative to the ring.
     6. RDP simplification (task 10 wire format).

   All angle units are degrees unless a name says Deg or Rad.
   ============================================================ */

"use strict";

/* --- Tunable constants (named, per the briefs) --- */

// How many points each glyph is reduced to before matching.
const P_RESAMPLE_N = 32;

// Standard $P greedy-match search step.
const P_GREEDY_EPSILON = 0.5;

// Fraction of each glyph's points ignored at the corners of the
// greedy search (standard $P uses sqrt(2)/2).
const P_BOUND = Math.SQRT1_2;

// Lazy rotation search: try ±45° in 9° steps. Rotation-variant
// by design (plan decision 4): this only forgives the natural
// wobble of a hand, it does not make a shape orientation-free.
const P_ANGLE_RANGE = Math.PI / 2;            // radians, ±45°
const P_ANGLE_PRECISION = (2 * Math.PI) / 40; // radians, 9°

// classify() default thresholds (overridable via options; the
// sliders in RECOGNISE mode pass their values here).
const REJECT_DISTANCE = 0.9; // above this distance = unknown
const REJECT_MARGIN = 0.1;   // 1st vs 2nd closer than this = ambiguous

// Ring detection defaults (grammar.json can override at runtime).
const RING_MAX_ROUNDNESS = 0.18; // radial error / mean radius
const RING_MAX_GAP_DEG = 40;     // largest missing arc allowed
const RING_MIN_RADIUS_PX = 40;   // smaller = probably a squiggle
const RING_CLOSED_GAP_DEG = 4;   // gap below this = closed ring

// Layer bands, as fractions of the ring radius R (grammar.json
// mirrors these; recogniser defaults exist so tests can run
// without a grammar file).
const BAND_CENTER_MAX = 0.35;
const BAND_MIDDLE_MAX = 0.7;
const BAND_OUTER_MAX = 1.0;
const BAND_OUTSIDE_MIN = 1.05;

// Sector order used everywhere (matches data/grammar.json).
const SECTOR_NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/* ============================================================
   1. $P point-cloud recogniser
   ============================================================ */

function pDist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// A glyph might be a single stroke ({points}) or a full glyph
// ({strokes}). This handles both.
function strokesOf(glyphOrStroke) {
  return glyphOrStroke.points ? [glyphOrStroke] : glyphOrStroke.strokes;
}

// Total drawn length across every stroke in a glyph.
function glyphPathLength(glyph) {
  let len = 0;
  const strokes = strokesOf(glyph);
  for (const s of strokes) len += pathLength(s);
  return len;
}

function pathLength(stroke) {
  let len = 0;
  const pts = stroke.points;
  for (let i = 1; i < pts.length; i++) len += pDist(pts[i], pts[i - 1]);
  return len;
}

// Resample ONE stroke to k points evenly spaced along its path.
// Each resampled point keeps the time and pressure of the
// original point it came from.
function resampleStroke(stroke, k) {
  const pts = stroke.points;
  if (pts.length === 0) return [];
  if (k < 2 || pathLength(stroke) < 1e-9) {
    // A tap: one point is all the geometry there is.
    return [{ x: pts[0].x, y: pts[0].y, t: pts[0].t, pressure: pts[0].pressure }];
  }
  const I = pathLength(stroke) / (k - 1); // spacing between points
  let out = [{ x: pts[0].x, y: pts[0].y, t: pts[0].t, pressure: pts[0].pressure }];
  let D = 0; // distance accumulated since the last resampled point
  let p = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i];
    let d = pDist(p, q);
    while (D + d >= I) {
      // A resampled point belongs between p and q.
      const t = (I - D) / d; // 0..1 along p→q
      const np = {
        x: p.x + t * (q.x - p.x),
        y: p.y + t * (q.y - p.y),
        t: Math.round(p.t + t * (q.t - p.t)),
        pressure: q.pressure
      };
      out.push(np);
      p = np;
      D = 0;
      d = pDist(p, q);
    }
    if (d > 0) {
      D += d;
      p = q;
    }
  }
  // Round-off safety: pad or trim to exactly k points.
  while (out.length < k) out.push({ ...out[out.length - 1] });
  return out.slice(0, k);
}

// Resample a whole glyph (multi-stroke) to n points. Strokes are
// NEVER merged: resampling never crosses the pen jump between
// two strokes. Each stroke gets points in proportion to how much
// of the drawn path it carries, so a long diagonal and a short
// tick each keep their share of the shape.
function resampleGlyph(glyph, n) {
  const strokes = strokesOf(glyph);
  if (strokes.length === 1) return resampleStroke(strokes[0], n);
  const lens = strokes.map(pathLength);
  const total = lens.reduce((a, b) => a + b, 0);
  if (total < 1e-9) {
    // All taps: hand out points evenly.
    let out = [];
    const k = Math.max(1, Math.floor(n / strokes.length));
    for (const s of strokes) out.push(...resampleStroke(s, k));
    while (out.length < n) out.push({ ...out[out.length - 1] });
    return out.slice(0, n);
  }
  let out = [];
  for (let s = 0; s < strokes.length; s++) {
    const k = Math.max(2, Math.round(n * lens[s] / total));
    out.push(...resampleStroke(strokes[s], k));
  }
  // Small allocation wobble is trimmed from the end of the
  // pooled list (harmless for cloud matching).
  while (out.length < n) out.push({ ...out[out.length - 1] });
  if (out.length > n) out = out.slice(0, n);
  return out;
}

// Scale a glyph uniformly to fit a unit box, preserving aspect
// ratio, then move its centroid to the origin (0, 0).
function normalizeGlyph(glyph) {
  let pts = resampleGlyph(glyph, P_RESAMPLE_N);
  const bb = boundsOf(pts);
  const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
  const s = 1 / Math.max(w, h, 1e-9); // never divide by zero
  pts = pts.map(p => ({ x: p.x * s, y: p.y * s, t: 0, pressure: p.pressure }));
  const c = centroidOf(pts);
  return pts.map(p => ({ x: p.x - c.x, y: p.y - c.y, t: 0, pressure: p.pressure }));
}

// Total "cost" of laying one point cloud over another. Lower is
// a better match. This is the heart of $P.
function greedyCloudMatch(pts, tmpl, epsilon) {
  const n = pts.length;
  const epsn = epsilon * n;                          // step on template
  const step = Math.floor(Math.sqrt(n) * epsilon);   // step on our points
  const skipped = Math.floor(n / P_BOUND);           // ignored corner range
  let minVal = Infinity;

  for (let i = 0; i < n; i += step) {
    for (let j = 0; j < n; j += epsn) {
      // Weight: starting points that are far apart in index
      // order counts against the match (from the paper).
      const weight = 1 - ((i - j + n) % n) / n;
      const d1 = cloudDistance(pts, tmpl, i, epsn);
      const d2 = cloudDistance(tmpl, pts, j, epsn);
      const v = Math.min(d1, d2) * weight;
      if (v < minVal) minVal = v;
    }
  }
  return minVal;
}

// Walk pts from index "start", greedily pairing each point with
// the nearest still-unpaired template point. Sum of the pair
// distances.
function cloudDistance(pts, tmpl, start, epsn) {
  const n = pts.length;
  const matched = new Array(n).fill(false);
  let sum = 0;
  let i = start;
  do {
    let min = Infinity, index = -1;
    for (let j = 0; j < n; j++) {
      if (!matched[j]) {
        const d = pDist(pts[i], tmpl[j]);
        if (d < min) { min = d; index = j; }
      }
    }
    matched[index] = true;
    sum += min;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}

// Rotate points about the origin (they are centroid-centred by
// normalizeGlyph).
function rotatePoints(pts, thetaRad) {
  const cos = Math.cos(thetaRad), sin = Math.sin(thetaRad);
  return pts.map(p => ({
    x: p.x * cos - p.y * sin,
    y: p.x * cos + p.y * sin,
    t: p.t, pressure: p.pressure
  }));
}

// Distance between two glyphs, trying small rotations both ways
// so a hand's wobble doesn't cause a miss. Returns the best.
function glyphDistance(glyphA, glyphB) {
  const a = normalizeGlyph(glyphA);
  const b = normalizeGlyph(glyphB);
  let best = greedyCloudMatch(a, b, P_GREEDY_EPSILON);
  for (let theta = P_ANGLE_PRECISION; theta < P_ANGLE_RANGE; theta += P_ANGLE_PRECISION) {
    const dPos = greedyCloudMatch(rotatePoints(a, theta), b, P_GREEDY_EPSILON);
    const dNeg = greedyCloudMatch(rotatePoints(a, -theta), b, P_GREEDY_EPSILON);
    if (dPos < best) best = dPos;
    if (dNeg < best) best = dNeg;
  }
  return best;
}

// Turn a raw $P distance into a 0–1 score for display. 1 = the
// clouds sit exactly on top of each other. (Our own mapping —
// the thresholds in classify() work on distance, not score.)
function distanceToScore(d) {
  return Math.max(0, Math.min(1, 1 - d / 2));
}

// recognise(glyph, templates) → ranked list, best first:
//   [{ name, distance, score }]
function recognise(glyph, templates) {
  const ranked = [];
  for (const tmpl of templates) {
    let best = Infinity;
    for (const sample of tmpl.samples) {
      const d = glyphDistance(glyph, sample);
      if (d < best) best = d;
    }
    if (best !== Infinity) {
      ranked.push({ name: tmpl.name, distance: best, score: distanceToScore(best) });
    }
  }
  ranked.sort((a, b) => a.distance - b.distance);
  return ranked;
}

/* ============================================================
   2. classify() — recognition with rejection
   ============================================================ */

// classify(glyph, templates, options) → { name | "unknown", ranked }
// Returns "unknown" when EITHER:
//   - the best distance is above options.rejectDistance, OR
//   - 1st and 2nd place are closer together than options.margin
//     (we can't tell which shape was meant).
function classify(glyph, templates, options) {
  const opts = options || {};
  const rejectDistance = opts.rejectDistance !== undefined ? opts.rejectDistance : REJECT_DISTANCE;
  const margin = opts.margin !== undefined ? opts.margin : REJECT_MARGIN;

  const ranked = recognise(glyph, templates);
  if (ranked.length === 0) return { name: "unknown", ranked };

  const first = ranked[0];
  const second = ranked.length > 1 ? ranked[1] : null;

  if (first.distance > rejectDistance) return { name: "unknown", ranked };
  if (second && (second.distance - first.distance) < margin) {
    return { name: "unknown", ranked };
  }
  return { name: first.name, ranked };
}

/* ============================================================
   3. Geometry helpers
   ============================================================ */

// Axis-aligned bounding box of a point list.
function boundsOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// Mean of all points (the "ink centroid": if ink were weight,
// where the shape would balance).
function centroidOf(pts) {
  if (pts.length === 0) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / pts.length, y: sy / pts.length };
}

// Centroid of a glyph (all strokes flattened).
function glyphCentroid(glyph) {
  const strokes = strokesOf(glyph);
  const all = [];
  for (const s of strokes) for (const p of s.points) all.push(p);
  return centroidOf(all);
}

// Extent: the largest distance between any two points in the
// glyph. Used for the "size" channel (bigger drawing = stronger).
function extentOf(glyph) {
  const strokes = strokesOf(glyph);
  const all = [];
  for (const s of strokes) for (const p of s.points) all.push(p);
  let max = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const d = pDist(all[i], all[j]);
      if (d > max) max = d;
    }
  }
  return max;
}

// Principal axis: the glyph's overall flow direction, taken as
// the line from its first-drawn point to its last-drawn point,
// in degrees (0° = pointing right/east, 90° = down/south, like
// canvas coordinates). This is the intrinsic angle the compiler
// reads — never a page angle.
function principalAxisOf(glyph) {
  const strokes = strokesOf(glyph);
  const first = strokes[0].points[0];
  const lastStroke = strokes[strokes.length - 1];
  const last = lastStroke.points[lastStroke.points.length - 1];
  return degNormalize(Math.atan2(last.y - first.y, last.x - first.x) * 180 / Math.PI);
}

// How long the glyph's ink is along its principal axis versus
// across it. A near-1.0 ratio means the shape is symmetric
// along its axis (reading it flipped gives the same answer);
// a small ratio means the shape clearly points one way.
// The compiler uses this to ask instead of guess.
function axisAsymmetryOf(glyph) {
  const strokes = strokesOf(glyph);
  const all = [];
  for (const s of strokes) for (const p of s.points) all.push(p);
  const c = centroidOf(all);
  const axisRad = principalAxisOf(glyph) * Math.PI / 180;
  const cos = Math.cos(axisRad), sin = Math.sin(axisRad);
  let alongSum = 0, acrossSum = 0;
  for (const p of all) {
    const dx = p.x - c.x, dy = p.y - c.y;
    alongSum += Math.abs(dx * cos + dy * sin);   // distance along the axis
    acrossSum += Math.abs(-dx * sin + dy * cos); // distance across it
  }
  const n = Math.max(1, all.length);
  const along = alongSum / n, across = acrossSum / n;
  return along / Math.max(across, 1e-9);
}

// Wrap any angle into (-180, +180].
function degNormalize(deg) {
  let d = deg;
  while (d <= -180) d += 360;
  while (d > 180) d -= 360;
  return d;
}

/* ============================================================
   4. Ring detection (task 5)
   ============================================================ */

// Algebraic circle fit (Kåsa method): solve the least-squares
// circle through the stroke's points. Pure algebra, works on
// any arc, not just full circles.
// Returns { cx, cy, r, rms } or null if the fit is degenerate.
function fitCircleToStroke(stroke) {
  return fitCircleToPoints(stroke.points);
}

function fitCircleToPoints(pts) {
  let n = pts.length;
  if (n < 6) return null;
  // Means, so the sums stay small and well-behaved.
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;

  // Least squares for x² + y² = a·x + b·y + c
  let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, szz = 0;
  for (const p of pts) {
    const x = p.x - mx, y = p.y - my;
    const z = x * x + y * y;
    sxx += x * x; syy += y * y; sxy += x * y;
    sxz += x * z; syz += y * z; szz += z * z;
  }
  // Solve the 2x2 system for a and b (c follows).
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-12) return null;
  const a = (syz * sxy - sxz * syy) / det;
  const b = (sxz * sxy - syz * sxx) / det;
  // c from the means-normalised system (so the numbers stay small):
  let sumZ = 0, sumX = 0, sumY = 0;
  for (const p of pts) {
    const x = p.x - mx, y = p.y - my;
    sumZ += x * x + y * y; sumX += x; sumY += y;
  }
  const cc = (sumZ - a * sumX - b * sumY) / n;

  const cx = a / 2 + mx;
  const cy = b / 2 + my;
  // r² = c + (centre shift)²: the fit lives in mean-centred
  // coordinates, so the centre's offset from the origin has to
  // come back in here. Missing this inflates r hugely.
  const rSq = cc + (cx - mx) * (cx - mx) + (cy - my) * (cy - my);
  if (!(rSq > 0) || !isFinite(rSq)) return null;
  const r = Math.sqrt(rSq);

  // RMS error: how far the points sit from the fitted circle.
  let errSum = 0;
  for (const p of pts) {
    const d = pDist(p, { x: cx, y: cy }) - r;
    errSum += d * d;
  }
  const rms = Math.sqrt(errSum / n);
  return { cx, cy, r, rms };
}

// Largest gap in the stroke's angular coverage of the fitted
// circle, in degrees. A closed ring has a tiny gap; an arc (like
// a bracket) has a huge one.
function ringAngularGapDeg(stroke, center) {
  const angles = stroke.points
    .map(p => Math.atan2(p.y - center.y, p.x - center.x) * 180 / Math.PI)
    .sort((a, b) => a - b);
  if (angles.length < 2) return 360;
  let maxGap = 360 + angles[0] - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) {
    const gap = angles[i] - angles[i - 1];
    if (gap > maxGap) maxGap = gap;
  }
  return maxGap;
}

// Roundness: mean absolute radial deviation ÷ mean radius.
// 0 = perfect circle; a hand-drawn circle is usually 0.05–0.15.
function ringRoundness(stroke, center) {
  let sum = 0, rSum = 0;
  const radii = [];
  for (const p of stroke.points) {
    const r = pDist(p, center);
    radii.push(r);
    rSum += r;
  }
  const rMean = rSum / stroke.points.length;
  for (const r of radii) sum += Math.abs(r - rMean);
  return sum / stroke.points.length / Math.max(rMean, 1e-9);
}

// Test one stroke against the ring thresholds. Returns a plain
// verdict object the debug panel can show directly:
//   { isRing, reason, center, radius, gapDeg, roundness }
// thresholds (optional): { maxRoundness, maxGapDeg, minRadiusPx }
function testRingCandidate(stroke, thresholds) {
  const t = thresholds || {};
  const maxRoundness = t.maxRoundness !== undefined ? t.maxRoundness : RING_MAX_ROUNDNESS;
  const maxGapDeg = t.maxGapDeg !== undefined ? t.maxGapDeg : RING_MAX_GAP_DEG;
  const minRadiusPx = t.minRadiusPx !== undefined ? t.minRadiusPx : RING_MIN_RADIUS_PX;

  const verdict = { isRing: false, reason: "", center: null, radius: 0, gapDeg: 0, roundness: 0 };

  const fit = fitCircleToStroke(stroke);
  if (!fit) { verdict.reason = "too few points for a circle"; return verdict; }
  verdict.center = { x: fit.cx, y: fit.cy };
  verdict.radius = fit.r;

  if (fit.r < minRadiusPx) { verdict.reason = "radius below minimum"; return verdict; }

  const gap = ringAngularGapDeg(stroke, fit.center ? fit.center : { x: fit.cx, y: fit.cy });
  verdict.gapDeg = gap;
  verdict.roundness = ringRoundness(stroke, verdict.center);

  if (gap > maxGapDeg) { verdict.reason = "arc gap too wide"; return verdict; }
  if (verdict.roundness > maxRoundness) { verdict.reason = "not round enough"; return verdict; }

  verdict.isRing = true;
  verdict.reason = "passes all ring tests";
  return verdict;
}

// Find THE ring on a page of strokes: the largest stroke that
// passes the ring tests wins (marks inside or outside a ring are
// much smaller than the ring itself). Returns:
//   { ring: stroke, info: verdict, index } or null.
// thresholds come from grammar.json via the caller.
function detectRing(strokes, thresholds) {
  let best = null;
  for (let i = 0; i < strokes.length; i++) {
    const verdict = testRingCandidate(strokes[i], thresholds);
    if (verdict.isRing) {
      if (!best || verdict.radius > best.info.radius) {
        best = { ring: strokes[i], info: verdict, index: i };
      }
    }
  }
  return best;
}

// A ring drawn in several strokes (a circle repaired midway)
// still counts: fit a circle to the whole glyph at once.
// Returns the same shape as testRingCandidate.
function testRingGlyph(glyph, thresholds) {
  const t = thresholds || {};
  const maxRoundness = t.maxRoundness !== undefined ? t.maxRoundness : RING_MAX_ROUNDNESS;
  const maxGapDeg = t.maxGapDeg !== undefined ? t.maxGapDeg : RING_MAX_GAP_DEG;
  const minRadiusPx = t.minRadiusPx !== undefined ? t.minRadiusPx : RING_MIN_RADIUS_PX;

  const strokes = strokesOf(glyph);
  const all = [];
  for (const s of strokes) for (const p of s.points) all.push(p);
  const verdict = { isRing: false, reason: "", center: null, radius: 0, gapDeg: 0, roundness: 0 };

  const fit = fitCircleToPoints(all);
  if (!fit) { verdict.reason = "too few points for a circle"; return verdict; }
  verdict.center = { x: fit.cx, y: fit.cy };
  verdict.radius = fit.r;
  if (fit.r < minRadiusPx) { verdict.reason = "radius below minimum"; return verdict; }

  // Angular coverage across the combined glyph: concatenate the
  // angle lists of every stroke, then find the largest gap.
  let angles = [];
  for (const s of strokes) {
    for (const p of s.points) {
      angles.push(Math.atan2(p.y - verdict.center.y, p.x - verdict.center.x) * 180 / Math.PI);
    }
  }
  angles.sort((a, b) => a - b);
  let maxGap = 360 + angles[0] - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) {
    const gap = angles[i] - angles[i - 1];
    if (gap > maxGap) maxGap = gap;
  }
  verdict.gapDeg = maxGap;
  verdict.roundness = ringRoundness({ points: all }, verdict.center);

  if (maxGap > maxGapDeg) { verdict.reason = "arc gap too wide"; return verdict; }
  if (verdict.roundness > maxRoundness) { verdict.reason = "not round enough"; return verdict; }

  verdict.isRing = true;
  verdict.reason = "passes all ring tests";
  return verdict;
}

// Open or closed? A tiny gap is just the pen lifting where it
// started. Uses RING_CLOSED_GAP_DEG.
function ringIsClosed(gapDeg) {
  return gapDeg <= RING_CLOSED_GAP_DEG;
}

/* ============================================================
   5. Spatial channels (task 5) — all measured relative to the
      ring. Nothing here references the page edges.
   ============================================================ */

// Which layer band a distance falls in. dOverR = distance from
// the ring centre divided by the ring radius.
// bands (optional): { centerMax, middleMax, outerMax, outsideMin }
function layerOf(dOverR, bands) {
  const b = bands || {};
  const centerMax = b.centerMax !== undefined ? b.centerMax : BAND_CENTER_MAX;
  const middleMax = b.middleMax !== undefined ? b.middleMax : BAND_MIDDLE_MAX;
  const outerMax = b.outerMax !== undefined ? b.outerMax : BAND_OUTER_MAX;
  const outsideMin = b.outsideMin !== undefined ? b.outsideMin : BAND_OUTSIDE_MIN;

  if (dOverR <= centerMax) return "center";
  if (dOverR <= middleMax) return "middle";
  if (dOverR < outerMax) return "outer";
  if (dOverR >= outsideMin) return "outside";
  return "boundary"; // the gap band: ON the ring line itself
}

// Sector of an angle, in the expression's own frame.
// angleDeg: canvas angle (0° = east, increasing clockwise, since
//   screen y grows downward).
// frameOffsetDeg: the heading of the frame's "north", measured
//   the same way. v1 uses the sigil's principal axis here.
// Returns a name from SECTOR_NAMES ("N", "NE", ...).
function sectorOf(angleDeg, frameOffsetDeg) {
  const off = frameOffsetDeg || 0;
  const a = degNormalize(angleDeg - off);
  // Canvas "north" (up the screen) is -90°, hence the +90 shift.
  const idx = ((Math.round((a + 90) / 45) % 8) + 8) % 8;
  return SECTOR_NAMES[idx];
}

// Intrinsic orientation of a candidate, expressed frame-free:
// 0° = pointing AT the ring centre, 180° = pointing away,
// ±90° = sitting along the ring. axisDeg: the candidate's own
// principal axis (start of drawing → end). centerToCandidateDeg:
// angle from ring centre to the candidate's centroid (canvas
// convention, degrees).
function intrinsicAngleDeg(axisDeg, centerToCandidateDeg) {
  // +180 puts "toward the centre" at 0, matching the documented
  // convention the lexicon notes describe.
  return degNormalize(axisDeg - centerToCandidateDeg + 180);
}

// Heading of the sigil's own axis, as the frame's "north".
// This is the v1 sector frame (plan §4.3): the sigil's asymmetry
// orients its own sentence. Returns null when the axis is not
// usable (degenerate/symmetric sigil) — the parser then falls
// back to anywhereInLayer slots.
function sigilAxisHeadingDeg(sigilGlyph) {
  if (!sigilGlyph) return null;
  const asym = axisAsymmetryOf(sigilGlyph);
  // Below this, the shape reads as symmetric from every angle;
  // no axis to anchor a compass with.
  if (asym < 1.15) return null;
  return principalAxisOf(sigilGlyph);
}

/* ============================================================
   6. Ramer–Douglas–Peucker simplification (task 10)
   ============================================================ */

// Reduce a stroke to its essential points so an exported
// expression stays small (the wire format for the device).
// epsilon: max allowed deviation, in pixels.
function simplifyStrokeRDP(points, epsilon) {
  if (points.length < 3) return points.slice();
  const sqEps = epsilon * epsilon;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  rdpWalk(points, 0, points.length - 1, sqEps, keep);
  return points.filter((p, i) => keep[i]);
}

function rdpWalk(pts, start, end, sqEps, keep) {
  if (end - start < 2) return;
  const a = pts[start], b = pts[end];
  let maxSq = 0, maxIdx = -1;
  for (let i = start + 1; i < end; i++) {
    const sq = sqDistToSegment(pts[i], a, b);
    if (sq > maxSq) { maxSq = sq; maxIdx = i; }
  }
  if (maxSq > sqEps) {
    keep[maxIdx] = true;
    rdpWalk(pts, start, maxIdx, sqEps, keep);
    rdpWalk(pts, maxIdx, end, sqEps, keep);
  }
}

// Squared distance from point p to the segment a→b.
function sqDistToSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return apx * apx + apy * apy;
  let t = (apx * abx + apy * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const dx = apx - t * abx, dy = apy - t * aby;
  return dx * dx + dy * dy;
}

/* --- Node export ------------------------------------------------
   In the browser this file is loaded with <script> tags and the
   functions are simply global. Under node (the dev checks and
   the later test benches), hand them out through module.exports.
   The typeof check keeps browser loading unaffected. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    recognise, classify, glyphDistance, distanceToScore,
    resampleGlyph, normalizeGlyph,
    boundsOf, centroidOf, glyphCentroid, extentOf,
    principalAxisOf, axisAsymmetryOf, degNormalize,
    fitCircleToStroke, fitCircleToPoints, ringAngularGapDeg,
    ringRoundness, testRingCandidate, detectRing, testRingGlyph,
    ringIsClosed, layerOf, sectorOf, intrinsicAngleDeg,
    sigilAxisHeadingDeg, simplifyStrokeRDP,
    P_RESAMPLE_N, P_GREEDY_EPSILON, REJECT_DISTANCE, REJECT_MARGIN,
    RING_MAX_ROUNDNESS, RING_MAX_GAP_DEG, RING_MIN_RADIUS_PX,
    RING_CLOSED_GAP_DEG, SECTOR_NAMES
  };
}
