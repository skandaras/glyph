/* ============================================================
   lexicon.js — loads and validates the language data files.

   PURE MODULE: no DOM, no canvas, no browser APIs. Takes plain
   data in, returns plain data out. Works in the browser (loaded
   with a <script> tag) and under node (tests).

   Two files make up the language:
     data/lexicon.json — what each glyph MEANS (I edit this)
     data/grammar.json — the sentence rules (I edit this)

   Code never hard-codes a meaning. Everything the parser and
   compiler know about glyphs comes through this loader.
   ============================================================ */
"use strict";

/* ---- vocabulary the rest of the code relies on ---------------- */

const CLASSES = ["sigil", "sign", "ring", "connector"];
const LAYERS = ["center", "middle", "outer", "boundary", "outside"];
const ORIENTATION_MODES = ["invariant", "semantic", "fixed"];
const SCALE_MODES = ["none", "degree"];
const SLOT_MODES = ["named", "anywhereInLayer"];

/* ---- the loader ------------------------------------------------
   loadLexiconData(lexiconData, grammarData) returns:
     { ok, errors, warnings, lexicon, grammar, templateOwner }
   - ok          false when any ERROR was found (do not start the app)
   - errors      strings, each naming the file and the problem
   - warnings    strings, problems that do not stop the app
   - lexicon     the validated data, handed to parser/compiler
   - grammar     the validated data, handed to parser/compiler
   - templateOwner  { templateName: lexemeId } — which lexeme owns
                  which template. The app uses this to build the
                  classify template list and to look meanings up. */

function loadLexiconData(lexiconData, grammarData) {
  const errors = [];
  const warnings = [];
  const err = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);

  const lexicon = lexiconData || null;
  const grammar = grammarData || null;

  if (!lexicon || typeof lexicon !== "object") {
    err("lexicon.json: file missing or not a JSON object");
  }
  if (!grammar || typeof grammar !== "object") {
    err("grammar.json: file missing or not a JSON object");
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings, lexicon, grammar, templateOwner: {} };
  }

  /* --- version fields: refuse unknown formats outright --- */
  if (lexicon.lexiconVersion !== 1) {
    err("lexicon.json: expected lexiconVersion 1, found " + JSON.stringify(lexicon.lexiconVersion));
  }
  if (grammar.grammarVersion !== 1) {
    err("grammar.json: expected grammarVersion 1, found " + JSON.stringify(grammar.grammarVersion));
  }

  /* --- grammar.json shape --- */
  const sectorNames = [];
  if (!Array.isArray(grammar.sectors) || grammar.sectors.length === 0) {
    err("grammar.json: sectors must be a non-empty array");
  } else {
    for (const s of grammar.sectors) {
      if (!s || typeof s.name !== "string") {
        err("grammar.json: every sector needs a name");
      } else if (typeof s.centerDeg !== "number") {
        err("grammar.json: sector " + s.name + " needs a numeric centerDeg");
      } else if (sectorNames.indexOf(s.name) !== -1) {
        err("grammar.json: duplicate sector name " + s.name);
      } else {
        sectorNames.push(s.name);
      }
    }
  }

  const b = grammar.bands || {};
  if (!(b.centerMax > 0 && b.centerMax < b.middleMax &&
        b.middleMax < b.outerMax && b.outerMax < b.outsideMin)) {
    err("grammar.json: bands must satisfy 0 < centerMax < middleMax < outerMax < outsideMin");
  }

  const ring = grammar.ring || {};
  for (const key of ["maxGapDeg", "maxRoundness", "minRadiusPx"]) {
    if (typeof ring[key] !== "number") {
      err("grammar.json: ring." + key + " must be a number");
    }
  }

  if (!Array.isArray(grammar.defaultSlots) || grammar.defaultSlots.length === 0) {
    err("grammar.json: defaultSlots must be a non-empty array");
  } else {
    for (const slot of grammar.defaultSlots) {
      if (sectorNames.length > 0 && sectorNames.indexOf(slot) === -1) {
        err("grammar.json: defaultSlots entry " + slot + " is not a sector name");
      }
    }
  }

  const buckets = grammar.degreeBuckets;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    err("grammar.json: degreeBuckets must be a non-empty array");
  } else {
    for (let i = 0; i < buckets.length; i++) {
      if (typeof buckets[i].max !== "number" || typeof buckets[i].word !== "string") {
        err("grammar.json: degreeBuckets entry " + i + " needs numeric max and string word");
      }
      if (i > 0 && buckets[i].max <= buckets[i - 1].max) {
        err("grammar.json: degreeBuckets max values must increase");
      }
    }
  }

  if (grammar.frame && grammar.frame.mode && grammar.frame.mode !== "sigilAxis") {
    warn("grammar.json: frame.mode " + JSON.stringify(grammar.frame.mode) +
         " — only \"sigilAxis\" is implemented in v1; using sigilAxis");
  }

  /* --- lexicon.json shape, per lexeme --- */
  const claimed = {}; // template name -> lexeme id, for the app
  if (!lexicon.lexemes || typeof lexicon.lexemes !== "object") {
    err("lexicon.json: needs a lexemes object");
  } else {
    const ids = Object.keys(lexicon.lexemes);
    if (ids.length === 0) warn("lexicon.json: no lexemes defined yet");
    const nameSeen = {};

    for (const id of ids) {
      const L = lexicon.lexemes[id];
      const at = "lexicon.json: " + id + " — ";

      if (!L || typeof L !== "object") { err(at + "not an object"); continue; }
      if (typeof L.name !== "string" || L.name.length === 0) { err(at + "needs a name"); }
      else if (nameSeen[L.name]) { err(at + "duplicate name " + L.name); }
      else { nameSeen[L.name] = true; }

      if (CLASSES.indexOf(L.class) === -1) {
        err(at + "class must be one of " + CLASSES.join(", ") +
            " (found " + JSON.stringify(L.class) + ")");
      }

      if (!Array.isArray(L.templates) || L.templates.length === 0) {
        err(at + "needs at least one template name");
      } else {
        for (const t of L.templates) {
          if (typeof t !== "string" || t.length === 0) {
            err(at + "template names must be non-empty strings");
          } else if (claimed[t]) {
            err(at + "template " + t + " is already claimed by " + claimed[t]);
          } else {
            claimed[t] = id;
          }
        }
      }

      if (!Array.isArray(L.layers) || L.layers.length === 0) {
        err(at + "needs at least one allowed layer");
      } else {
        for (const layer of L.layers) {
          if (LAYERS.indexOf(layer) === -1) {
            err(at + "unknown layer " + JSON.stringify(layer));
          }
        }
        // Sanity advice, not errors: sigils live in the centre,
        // signs live outside it.
        if (L.class === "sigil" && L.layers.indexOf("center") === -1) {
          warn(at + "sigil does not list the center layer; the compiler will reject it");
        }
        if (L.class === "sign" && L.layers.indexOf("center") !== -1) {
          warn(at + "sign lists the center layer; signs normally sit in middle/outer");
        }
      }

      if (ORIENTATION_MODES.indexOf(L.orientationMode) === -1) {
        err(at + "orientationMode must be one of " + ORIENTATION_MODES.join(", "));
      }
      if (SCALE_MODES.indexOf(L.scaleMode) === -1) {
        err(at + "scaleMode must be one of " + SCALE_MODES.join(", "));
      }
      if (SLOT_MODES.indexOf(L.slotMode) === -1) {
        err(at + "slotMode must be one of " + SLOT_MODES.join(", "));
      }

      if (L.slotMode === "named") {
        if (!Array.isArray(L.slots) || L.slots.length === 0) {
          err(at + "slotMode \"named\" needs a non-empty slots array " +
              "(or use slotMode \"anywhereInLayer\")");
        } else if (sectorNames.length > 0) {
          for (const slot of L.slots) {
            if (sectorNames.indexOf(slot) === -1) {
              err(at + "slot " + slot + " is not a sector in grammar.json");
            }
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors, warnings,
    lexicon, grammar,
    templateOwner: claimed
  };
}

/* ---- accessors used by parser.js, compiler.js and app.js ------
   All pure; all take the validated bundle (or its parts). */

// The ring thresholds in the exact shape testRingCandidate wants.
function ringThresholds(grammar) {
  const r = (grammar && grammar.ring) || {};
  return {
    maxGapDeg: r.maxGapDeg,
    maxRoundness: r.maxRoundness,
    minRadiusPx: r.minRadiusPx
  };
}

// Sector names in declared order.
function sectorNames(grammar) {
  return (grammar && grammar.sectors || []).map(s => s.name);
}

// Which slots a lexeme may occupy. "named" uses its own list,
// everything else falls back to the grammar's working default.
function slotsFor(lexeme, grammar) {
  if (lexeme && lexeme.slotMode === "named") return lexeme.slots || [];
  return (grammar && grammar.defaultSlots) || [];
}

// Turn a size ratio (candidate extent / ring radius) into the
// grammar's degree word. Only meaningful when the lexeme reads
// size as degree; otherwise returns null.
function degreeFor(lexeme, grammar, sizeRatio) {
  if (!lexeme || lexeme.scaleMode !== "degree") return null;
  const buckets = (grammar && grammar.degreeBuckets) || [];
  for (const bucket of buckets) {
    if (sizeRatio <= bucket.max) return bucket.word;
  }
  return buckets.length > 0 ? buckets[buckets.length - 1].word : null;
}

// Template list in the shape classify() wants:
//   [{ name, samples: Glyph[] }]
// trained is the app's store: { templateName: [Glyph, ...] }.
function classifyTemplateList(trained) {
  const list = [];
  for (const name of Object.keys(trained || {})) {
    if (trained[name] && trained[name].length > 0) {
      list.push({ name, samples: trained[name] });
    }
  }
  return list;
}

/* ---- Node export (browser loads this file as globals) -------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    loadLexiconData,
    ringThresholds, sectorNames, slotsFor, degreeFor, classifyTemplateList,
    CLASSES, LAYERS, ORIENTATION_MODES, SCALE_MODES, SLOT_MODES
  };
}
