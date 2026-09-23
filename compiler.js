/* ============================================================
   compiler.js — GlyphAST → GlyphIR + plain-English echo (PURE)

   The compiler asks the LEXICON what things mean and the
   GRAMMAR what is allowed. It contains no glyph knowledge of
   its own: if a glyph is not in data/lexicon.json, it has no
   meaning and the compiler says so.

   Stages, so failures are named clearly:
     recognition  (unknown marks, no ring)   → parse stage
     structure    (cardinality: rings, sigils) → here
     semantics    (wrong layer, wrong slot)    → here

   Output:
     { ok, errors, warnings, ir, echo }
     ir (GlyphIR): { op, args, degree, mode, state }
       op      the sigil's semantic element (what it IS)
       args    the signs, with slot, intrinsic orientation, degree
       degree  the sigil's own degree word (or null)
       mode    { anchored, offsetDeg } — frame information
       state   "prepared" (draft, ring open) | "active" (committed)

   v1 execution target is the echo itself: a readable sentence.
   No animations, no side effects.
   ============================================================ */
"use strict";

/* Loader shim: pure module; node needs require(). */
const R_ = (typeof module !== "undefined" && module.exports)
  ? require("./recogniser.js")
  : globalThis;
const P_ = (typeof module !== "undefined" && module.exports)
  ? require("./parser.js")
  : globalThis;

/* Words for the sigil's size-as-degree. Shares the bucket table
   with signs via lexicon.degreeFor. */
function degreeWord(lexeme, grammar, sizeRatio) {
  if (!lexeme || lexeme.scaleMode !== "degree") return null;
  const buckets = (grammar && grammar.degreeBuckets) || [];
  for (const b of buckets) {
    if (sizeRatio <= b.max) return b.word;
  }
  return buckets.length > 0 ? buckets[buckets.length - 1].word : null;
}

/* Compile one parsed page.
   ast      the GlyphAST from parser.parsePage
   lexicon  the validated lexicon data
   grammar  the validated grammar data */
function compileAst(ast, lexicon, grammar) {
  const out = { ok: true, errors: [], warnings: [], ir: null, echo: "" };
  const err = (m) => { out.errors.push(m); out.ok = false; };

  const lexemes = (lexicon && lexicon.lexemes) || {};

  /* --- stage 1: structure ------------------------------------------ */
  if (ast.ringState === "empty") {
    err("the page is empty — draw a ring, a sigil and signs");
    return finish(out);
  }
  if (ast.ringState === "none") {
    err("no ring on the page — a circle anchors the expression; every other mark is unreadable without it");
    return finish(out);
  }
  if (ast.unknowns.length > 0) {
    err(ast.unknowns.length + " mark(s) could not be recognised — teach the shape in Teach mode, or draw it more distinctly");
  }
  for (const u of ast.unsupported) out.warnings.push(u);

  /* Every candidate must be a lexicon word. */
  for (const c of ast.candidates) {
    if (!c.lexemeId || !lexemes[c.lexemeId]) {
      err("glyph '" + (c.name || "?") + "' is not in the lexicon — add it to data/lexicon.json to give it meaning");
    }
  }

  /* Exactly one sigil, in the centre layer. */
  const sigils = ast.candidates.filter(c => c.glyphClass === "sigil");
  if (sigils.length === 0) {
    err("no sigil in the centre layer — an expression needs exactly one");
  } else if (sigils.length > 1) {
    err(sigils.length + " sigils found — v1 supports exactly one central sigil");
  }

  /* Signs: right layer, right slot. */
  const anchored = ast.frame.offsetDeg !== null;
  if (!anchored && ast.candidates.some(c => c.glyphClass === "sign")) {
    out.warnings.push("sectors not anchored (sigil has no axis or none present) — slot rules are not applied");
  }
  for (const c of ast.candidates) {
    if (c.glyphClass !== "sign") continue;
    const L = lexemes[c.lexemeId];
    if (!L) continue;
    if (L.layers.indexOf(c.layer) === -1) {
      err("sign '" + L.name + "' sits in the " + c.layer +
          " layer; the lexicon allows: " + L.layers.join(", "));
    }
    if (anchored && c.sector && L.slotMode === "named" &&
        L.slots.indexOf(c.sector) === -1) {
      err("sign '" + L.name + "' sits in the " + c.sector +
          " sector; the lexicon allows: " + L.slots.join(", "));
    }
  }

  if (!out.ok) return finish(out); // don't build an IR from a broken AST

  /* --- stage 2: build the IR --------------------------------------- */
  const sigilC = sigils[0];
  const sigilLexeme = lexemes[sigilC.lexemeId];
  const sigilDegree = degreeWord(sigilLexeme, grammar, sigilC.sizeRatio);

  const args = [];
  for (const c of ast.candidates) {
    if (c.glyphClass !== "sign") continue;
    const L = lexemes[c.lexemeId];
    args.push({
      sign: c.lexemeId,
      name: L.name,
      layer: c.layer,
      slot: c.sector,
      orientationDeg: c.orientationDeg,
      orientationAltDeg: c.orientationAltDeg,
      orientation: P_.intrinsicWord(c.orientationDeg, c.orientationAltDeg),
      degree: degreeWord(L, grammar, c.sizeRatio)
    });
  }

  out.ir = {
    op: (sigilLexeme.semantics && sigilLexeme.semantics.element)
      ? String(sigilLexeme.semantics.element) : sigilLexeme.name,
    args,
    degree: sigilDegree,
    mode: { anchored, offsetDeg: ast.frame.offsetDeg },
    state: ast.ringState // "prepared" = draft, "active" = committed
  };

  /* --- stage 3: the echo (the v1 "execution") ----------------------- */
  let sentence = sigilLexeme.name;
  if (sigilDegree) sentence += ", " + sigilDegree;
  if (args.length > 0) {
    sentence += " — " + args.map(a => {
      let s = a.name;
      if (a.orientation) s += " " + a.orientation;
      if (a.degree) s += ", " + a.degree;
      if (a.slot) s += ", in " + a.slot;
      return s;
    }).join("; ");
  } else {
    sentence += " — no signs";
  }
  sentence += ast.ringState === "prepared"
    ? "  ·  draft (ring open — close it to commit)"
    : "  ·  committed";
  out.echo = sentence;

  for (const w of ast.warnings) out.warnings.push(w);
  return finish(out);
}

/* Fold warnings into the echo so one box shows everything. */
function finish(out) {
  const lines = [];
  if (out.ir || out.echo) lines.push(out.echo || "(nothing to execute)");
  for (const e of out.errors) lines.push("✗ " + e);
  for (const w of out.warnings) lines.push("· " + w);
  out.echo = lines.join("\n");
  return out;
}

/* Node export (browser: globals). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { compileAst, degreeWord };
}
