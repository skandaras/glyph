/* ============================================================
   parser.js — strokes on the page → GlyphAST  (PURE)

   A "page" is everything drawn since the last Clear (or since
   the last committed expression). The parser:

     1. finds THE ring (the circle that anchors everything),
     2. groups the remaining strokes into glyphs by pauses,
     3. classifies each glyph against the taught templates,
     4. measures where it sits (layer band + sector),
     5. works out the frame (which way is "north"),
     6. reports what it could NOT read, and never silently
        drops anything.

   Output shape (see AGENTS.MD):
     GlyphAST { ringState, ring, frame, candidates, unknowns,
                warnings, unsupported }

   Candidate shape:
     { name, score, confidence, centroid, extent, layer, sector,
       sizeRatio, axisDeg, strokeCount, ... }

   This file contains no DOM, canvas or browser APIs. In the
   browser it is loaded after recogniser.js (whose functions
   are globals); under node it requires recogniser.js.
   ============================================================ */
"use strict";

/* Loader shim: pure module, but node needs require(). */
const R_ = (typeof module !== "undefined" && module.exports)
  ? require("./recogniser.js")
  : globalThis;

/* Group strokes into glyph groups: a pause longer than
   groupingTimeoutMs starts a new group. Strokes must arrive in
   the order they were drawn. Returns an array of stroke arrays.
   (Same rule as the app's live grouping, re-applied here so the
   parser can be tested on its own.) */
function groupStrokesByTime(strokes, timeoutMs) {
  const groups = [];
  let current = [];
  let lastEnd = -Infinity;
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    const start = s.points[0].t;
    const end = s.points[s.points.length - 1].t;
    if (current.length > 0 && start - lastEnd > timeoutMs) {
      groups.push(current);
      current = [];
    }
    current.push(s);
    if (end > lastEnd) lastEnd = end;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/* Angle from the ring centre to a point, in canvas degrees
   (0° = east, angles grow clockwise because screen y is down). */
function angleFromRing(center, point) {
  return R_.degNormalize(Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI);
}

/* Words for an intrinsic sign orientation (0° = pointing at the
   ring centre, ±90° = along the ring). Used by the compiler's
   echo; kept here so both stages say the same thing. */
function intrinsicWord(deg, altDeg) {
  const a = Math.abs(R_.degNormalize(deg));
  if (altDeg !== null && altDeg !== undefined) {
    // Flip-ambiguous: two mirror readings, both shown.
    const alt = Math.abs(R_.degNormalize(altDeg));
    const inwardish = a < 45 || alt < 45;
    const outwardish = a > 135 || alt > 135;
    if (inwardish && outwardish) return "inward or outward (flip ambiguous)";
    if (inwardish) return "inward (or outward — flip ambiguous)";
    if (outwardish) return "outward (or inward — flip ambiguous)";
    return "along the ring (either way — flip ambiguous)";
  }
  if (a < 45) return "inward";
  if (a > 135) return "outward";
  return "along the ring";
}

/* The main entry point.
   strokes        all strokes on the page, in draw order
   templates      classify-shaped list: [{ name, samples }]
   templateInfo   { templateName: { lexemeId, class } } — built
                  from the lexicon by the app (the parser itself
                  never reads the lexicon)
   grammar        the validated grammar data */
function parsePage(strokes, templates, templateInfo, grammar) {
  const ast = {
    ringState: "empty",   // empty | none | prepared | active | invalid
    ring: null,
    frame: { mode: "sigilAxis", offsetDeg: null, anchoredBy: null },
    candidates: [],
    unknowns: [],
    warnings: [],
    unsupported: []
  };
  if (!strokes || strokes.length === 0) return ast;

  const g = grammar || {};
  const timeout = g.groupingTimeoutMs || 500;
  const thresholds = g.ring; // keys already match the ring tests

  /* --- 1. the ring ------------------------------------------------ */
  let ringInfo = null;       // { center, radius, gapDeg, roundness }
  let ringStrokeIds = [];    // indices into `strokes` that form the ring

  const found = R_.detectRing(strokes, thresholds);
  if (found) {
    ringInfo = found.info;
    ringStrokeIds = [found.index];
  } else {
    // Maybe the ring was drawn in several strokes with nothing
    // else on the page: test the whole page as one ring glyph.
    const whole = R_.testRingGlyph({ strokes }, thresholds);
    if (whole.isRing) {
      ringInfo = whole;
      ringStrokeIds = strokes.map((s, i) => i);
      ast.warnings.push("ring drawn in several strokes — v1 prefers a single-stroke ring once there are marks inside it");
    }
  }

  if (!ringInfo) {
    /* No ring: nothing can be placed in a layer or sector. The
       groups still get classified so you can see what the
       recogniser thought, but they are filed as unknowns with a
       clear reason. */
    ast.ringState = "none";
    ast.warnings.push("no ring found — the circle is what anchors every other mark; nothing else can be read without it");
    const groups = groupStrokesByTime(strokes, timeout);
    for (const grp of groups) {
      const glyph = { strokes: grp };
      const cls = R_.classify(glyph, templates);
      const top = cls.ranked && cls.ranked[0]
        ? { name: cls.ranked[0].name, score: cls.ranked[0].score } : null;
      ast.unknowns.push({
        centroid: R_.glyphCentroid(glyph),
        strokeCount: grp.length,
        reason: "no ring on the page — marks cannot be read",
        wouldHaveBeen: top
      });
    }
    return ast;
  }

  const closed = R_.ringIsClosed(ringInfo.gapDeg);
  ast.ringState = closed ? "active" : "prepared"; // open ring = draft
  ast.ring = {
    center: { x: ringInfo.center.x, y: ringInfo.center.y },
    radius: ringInfo.radius,
    gapDeg: ringInfo.gapDeg,
    roundness: ringInfo.roundness,
    closed,
    strokeCount: ringStrokeIds.length
  };

  /* --- 2. group what is left, classify each group ------------------ */
  const ringIdSet = {};
  for (const i of ringStrokeIds) ringIdSet[i] = true;
  const remaining = strokes.filter((s, i) => !ringIdSet[i]);
  const groups = groupStrokesByTime(remaining, timeout);

  for (const grp of groups) {
    const glyph = { strokes: grp };
    const cls = R_.classify(glyph, templates);
    const centroid = R_.glyphCentroid(glyph);
    const extent = R_.extentOf(glyph);
    const ranked = cls.ranked || [];
    const first = ranked[0] || null;
    const second = ranked[1] || null;

    const info = templateInfo && cls.name !== "unknown"
      ? templateInfo[cls.name] : null;

    /* distance from the ring centre, over the ring radius */
    const centreDist = Math.hypot(centroid.x - ast.ring.center.x,
                                  centroid.y - ast.ring.center.y);
    const dOverR = centreDist / ast.ring.radius;
    const layer = R_.layerOf(dOverR, g.bands);

    const candidate = {
      name: cls.name === "unknown" ? null : cls.name,
      score: first ? first.score : 0,           // 0..1, higher = better
      margin: first && second
        ? Math.abs(second.distance - first.distance) // gap to the runner-up
        : (first ? 1 : 0),
      centroid,
      extent,
      layer,
      sector: null,          // filled in once the frame is known
      sizeRatio: ast.ring.radius > 0 ? extent / ast.ring.radius : 0,
      axisDeg: R_.principalAxisOf(glyph),
      axisAsymmetry: R_.axisAsymmetryOf(glyph),
      orientationDeg: null,  // intrinsic: 0° = toward the centre
      orientationAltDeg: null,
      strokeCount: grp.length,
      lexemeId: info ? info.lexemeId : null,
      glyphClass: info ? info.class : "unregistered"
    };
    ast.candidates.push(candidate);
  }

  /* --- 3. the frame: the sigil orients its own sentence ----------- */
  const sigils = ast.candidates.filter(c =>
    c.glyphClass === "sigil" && c.layer === "center");

  if (sigils.length === 0) {
    ast.warnings.push("no sigil in the centre layer — sectors cannot be anchored, slots fall back to anywhere-in-layer");
  } else {
    if (sigils.length > 1) {
      ast.unsupported.push("more than one central sigil (" +
        sigils.length + ") — v1 supports exactly one; the compiler will refuse this");
    }
    const anchor = sigils[0];
    // The anchor candidate's group, with its strokes, for the
    // axis measurement. Candidates keep only measurements, so
    // groups are matched by order (they were pushed in order).
    const anchorGlyph = { strokes: groups[ast.candidates.indexOf(anchor)] };
    const heading = R_.sigilAxisHeadingDeg(anchorGlyph);
    ast.frame.offsetDeg = heading;
    ast.frame.anchoredBy = anchor.name;
    if (heading === null) {
      ast.warnings.push("sigil '" + (anchor.name || "?") + "' is too symmetric to anchor the sectors — slots fall back to anywhere-in-layer");
    }
  }

  /* --- 4. sectors and intrinsic orientations, frame applied ------- */
  for (const c of ast.candidates) {
    const angle = angleFromRing(ast.ring.center, c.centroid);
    if (ast.frame.offsetDeg !== null) {
      c.sector = R_.sectorOf(angle, ast.frame.offsetDeg);
    }
    if (c.glyphClass === "sign") {
      c.orientationDeg = R_.intrinsicAngleDeg(c.axisDeg, angle);
      if (c.axisAsymmetry < 1.15) {
        // Near-symmetric along its axis: the mirror reading is
        // just as plausible. Both are reported, never guessed.
        c.orientationAltDeg = R_.degNormalize(c.orientationDeg + 180);
      }
    }
  }

  /* --- 5. repetition (multiplicity) ------------------------------- */
  const seen = {};
  for (const c of ast.candidates) {
    const key = (c.name || "?") + "|" + c.layer + "|" + (c.sector || "-");
    seen[key] = (seen[key] || 0) + 1;
  }
  for (const key of Object.keys(seen)) {
    if (seen[key] > 1) {
      ast.warnings.push(seen[key] + " × '" + key.split("|")[0] +
        "' in the same place — repetition is not read in v1");
    }
  }

  /* Anything the classifier could not name */
  for (const c of ast.candidates) {
    if (c.name === null) {
      ast.unknowns.push({
        centroid: c.centroid,
        strokeCount: c.strokeCount,
        reason: "no template matched (or the top two were too close to call)",
        wouldHaveBeen: null
      });
    }
  }
  ast.candidates = ast.candidates.filter(c => c.name !== null);

  return ast;
}

/* Node export (browser: globals). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parsePage, groupStrokesByTime, intrinsicWord, angleFromRing };
}
