# Glyph Lab — project context

## What this is
A drawing app for designing and testing a hand-drawn glyph alphabet.
Users draw marks with a stylus or finger; the app recognises them and,
later, reads spatial relationships between them. It is a design tool
and test bench, not a finished product.

## Who I am
I'm new to programming and electronics. Explain what you changed in
plain English after each task. Don't assume I know terminology; if you
use a technical term, define it briefly the first time.

## Hard constraints
- Plain HTML, CSS and JavaScript only. No frameworks, no npm, no build step.
- Files:
  - index.html — page structure and styles
  - app.js — UI, drawing, screens; the ONLY file allowed to touch the page
  - recogniser.js — recognition maths ONLY ($P matching, ring detection,
    spatial channel measurement)
  - lexicon.js — loads and validates data/lexicon.json + data/grammar.json
  - parser.js — turns a page of strokes into a GlyphAST (pure)
  - compiler.js — turns a GlyphAST into a GlyphIR + plain-English echo (pure)
  - data/lexicon.json — what each glyph MEANS; hand-edited by me
  - data/grammar.json — the sentence rules and tunable constants; hand-edited by me
- recogniser.js, lexicon.js, parser.js and compiler.js must contain pure
  functions with no DOM, canvas or browser APIs. They take plain data in
  and return plain data out. They will later be ported to C or WASM for
  a microcontroller, so keep them simple and readable.
- Code never hard-codes a glyph's meaning. A glyph's meaning lives only
  in data/lexicon.json; sentence rules live only in data/grammar.json.
  Growing the alphabet means editing data, never code.
- Must work on iPad Safari with Apple Pencil, Android Chrome, and
  desktop browsers.
- Serve locally with `python3 -m http.server 8000`. Tell me how to open
  it on my tablet over my home Wi-Fi.

## Data model (use these names everywhere)
- Point: { x, y, t, pressure }   // t = milliseconds
- Stroke: { points: Point[] }
- Glyph: { id, strokes: Stroke[], createdAt }
- Template: { name, samples: Glyph[] }
- Candidate: one glyph group read against the templates: { name, score,
  confidence, centroid, extent, layer, sector, sizeRatio, axisDeg,
  strokeCount }
- GlyphAST: what the parser believes is on the page: { ringState, ring,
  frame, candidates, unknowns, warnings, unsupported }
- GlyphIR: what a valid expression DOES: { op, args, degree, mode, state }

## Working style
- Do one task at a time. Don't add features I haven't asked for.
- Keep code commented so a beginner can follow it.
- When finished, list what I should manually test.
