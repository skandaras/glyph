# Glyph Slate — Phase 0 & Language Core Plan (v1.2)

Mirror of the approved plan (Library: *Glyph Slate — Phase 0 & Language
Core Plan (v1.2)*, filed under the Glyph Slate brief). The Library copy is
authoritative; this file exists so the repo is self-contained.

## 1. Scope

Phase 0: the Glyph Lab web app (briefs 1–4, unchanged) plus the language
core (tasks 5–10). Electronics (stream 2) and the phone-side compiler
(stream 3) are carried forward as constraints, not built here. Everything
Phase 0 produces is designed to survive the trip to hardware: pure
modules, stroke-not-pixel data, export format matching the future BLE
payload.

## 2. Locked decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Parse unit | Whole page since last commit/Clear; explicit Parse button in v1; live parse-on-ring-closure later as a toggle. 500 ms grouping stays for thumbnails and teaching only. |
| 2 | v1 grammar | Exactly one ring, exactly one central sigil, signs optional. A second ring/sigil is never silently dropped — it surfaces as an unsupported condition. Nesting and connector strokes deferred to v2. |
| 3 | Argument slots | 8 slots from day one, laid out as the compass directions N, NE, E, SE, S, SW, W, NW (four cardinals plus their bisections). Working/testing default is 4 of the 8. Per-lexeme `slotMode` may narrow or widen. Slot meaning is assigned by the admin, not by code. Which reference fixes the sector compass is deferred (§4.3). |
| 4 | Orientation | No external frame for meaning. All semantics are relational to the expression itself (§4). Templates are taught in a canonical orientation purely for matching; angles reported to the compiler are measured intrinsically. The sigil needs no "top" and need not be symmetric (§4.5). |
| 5 | v1 output | Intent echo: pretty-printed GlyphIR + plain-English sentence ("fire, intensified, directed west — active"). No visual effects. Real action targets are Phase 3. |
| 6 | Modules | `parser.js`, `compiler.js`, `lexicon.js` join `recogniser.js` as pure, DOM-free modules; `app.js` is the only page-touching file; everything in `data/` is hand-edited. |

## 3. Architecture fundamentals

### 3.1 Three separations

| Layer | Stored as | Owned by |
|---|---|---|
| Ink | `Point {x, y, t, pressure}` → `Stroke` → `Glyph` | the app, automatically |
| Shape | `Template {name, samples}`, $P-based, taught in-app | the admin, 2–3 samples per shape |
| Meaning | `data/lexicon.json` + `data/grammar.json`, hand-edited | the admin, in a text editor |

Code never hard-codes a glyph's meaning. Growing the alphabet never
touches the program: edit the lexicon, refresh, teach, go.

### 3.2 Channel taxonomy

The parser measures six channels; each lexeme declares which it reads.
All are relational (decision 4):

| Channel | Measured as | Meaning |
|---|---|---|
| Shape | $P match against templates | identity |
| Radial layer | centroid distance vs ring radius → centre / middle / outer / boundary / outside | role |
| Angular position | 8 compass-direction sectors (§4.3) | argument slot |
| Size | extent vs ring radius | degree / intensity |
| Orientation | principal-axis angle relative to the expression's own elements | mode / direction |
| Multiplicity | count of identical shapes in a slot | repetition, plural |

### 3.3 `data/lexicon.json` schema

Per lexeme: `name`, `class` (sigil/sign/ring/connector), `templates`
(template-name list), `layers`, `orientationMode` (`invariant` /
`semantic` / `fixed`), `scaleMode` (`none` / `degree`), `slotMode`
(`named` / `anywhereInLayer`) + `slots`, `semantics` (free-form), `notes`.
Template samples are taught in-app and referenced by name, so shapes can
be redesigned without touching meaning and vice versa. Starter lexicon:
4 placeholder lexemes so the pipeline is testable before the real
alphabet exists.

### 3.4 `data/grammar.json`

Hand-edited, versioned. Holds: layer band boundaries (centre < 0.35R,
middle 0.35–0.7R, outer 0.7R–R, outside > 1.05R); the eight sector
definitions with provisional names; the sector reference-frame field
(v1 default `sigilAxis`, switchable — §4.3); the 4-slot working default;
cardinality rules; the active channel list; `plane: flat` (one drawing
surface; layers are radial bands, nesting is a separate v2 question). A
loader validates against the version field and refuses malformed files
with a clear message. `data/README.md` is where the language gets written
down.

### 3.5 Two intermediate representations

- **GlyphAST** — what the parser believes is on the page: ring state,
  candidates with match/confidence/layer/sector/size/intrinsic-angle, the
  frame heading, unknowns, warnings. Serialisable JSON.
- **GlyphIR** — what a valid structure does: `{op, args, degree, mode,
  state: prepared|active}`. Validation at the AST→IR boundary. Open ring
  = prepared (draft); closed ring = active (commit).

Recognition failures and semantic failures fail at different stages, with
different messages.

## 4. Relational semantics (decision 4, in full)

**Principle:** every semantic quantity is relational to elements of the
expression itself — the ring's centre, the ring's radius, centroid-to-
centroid lines. Rotating a whole drawn page in the plane leaves its
meaning unchanged. No channel references the world.

### 4.1 Sigil axis (provisional machinery)
The principal axis of the central sigil is the leading candidate for the
expression's reference line. A perfectly symmetric sigil (circle, radial
star) carries a degenerate axis; acceptable for v1 — the machinery falls
back to `anywhereInLayer` slots, and the lexicon notes such sigils cannot
anchor directional sectors.

### 4.2 Sign orientation (frame-free, settled)
A sign's principal axis is reported as an angle with pointing at the ring
centre = 0°, along the ring tangent = 90°. This needs no frame. A "push"
sign oriented outward means "toward the boundary"; rotated 90° it means
"along the ring". Flip-symmetry: if the sign's shape is near-degenerate
across its axis, the compiler renders both readings rather than guessing,
until the lexeme declares chirality.

### 4.3 The 8 sectors — layout set, reference frame deferred

**Layout (decided):** eight sectors of 45°, centred on N, NE, E, SE, S,
SW, W, NW. Names are provisional labels in `grammar.json`. Per-lexeme
`slotMode: "named"` typically uses 2–4 of the 8; `whereInLayer` ignores
sectors.

**Open question (deferred by the admin):** what fixes the sector compass.
Candidates: the sigil's own weighted axis (leading candidate; v1 code
default, switchable), the ring opening / ring stroke start (intrinsic,
available when the ring is open), or the page/device frame (breaks
self-containment; weakest). Until decided, v1 measures sectors in the
sigil-axis frame and records the axis heading alongside each sector in
the GlyphAST, so a frame switch is a config change. When no axis is
available, the fallback is `anywhereInLayer`. Sector precision depends on
axis consistency; the drill bench (task 9) measures exactly that.

### 4.4 Intrinsic direction is shape, not channel
Arrowheads and spiral chirality are shape identity: taught as separate
lexemes, not read as an orientation channel. $P stays rotation-variant by
design; hand-rotation variance is absorbed by teaching extra samples.

### 4.5 Sigil design freedom
A glyph does not need a "top", and it should not be forced symmetric.
An asymmetric, weighted sigil is legitimate and may itself be expressive.
Candidate future channel: read weightedness as the offset of the ink
centroid from the shape's geometric centre. Nothing reads weightedness in
v1; the drill bench shows whether hand-drawn weightedness is consistent
enough to carry meaning before this is built.

**Flat but layered:** one drawing surface, no depth stacking. Meaning
lives in radial bands and angular sectors. Nesting is deferred to v2.

## 5. Work plan

1. **Drawing surface and stroke capture** (brief 1, as written). Pointer
   Events, palm rejection, 500 ms glyph grouping, debug panel.
2. **$P recogniser and teaching** (brief 2, as written). Pure
   `recogniser.js`, TEACH/RECOGNISE, two-threshold rejection.
   Rotation-variant, per decision 4.
3. **Persistence, export, import** (brief 3, as written). localStorage,
   `version: 1` format, raw draw log included.
4. **Recognition test bench** (brief 4, as written). Drill mode,
   leave-one-out, confusion matrix, worst-3 confusions.
5. **Ring detection and spatial measurement.** Algebraic circle fit,
   angular coverage (largest gap below threshold = closed), roundness.
   Largest passing stroke = the ring; centre and radius anchor
   everything; then all six channels per candidate. *Acceptance: ring +
   marks inside and outside classifies every stroke into a layer band and
   reports centre, radius, open/closed.*
6. **Lexicon and grammar files + loaders.** Schemas per §3.3/§3.4
   including the eight sectors and the frame field; loader validation;
   `data/README.md`; starter placeholder lexicon. *Acceptance: edit JSON,
   refresh, teach — new glyph lives with no code changes.*
7. **Parser** (`parser.js`, pure). Page-unit parse on button; ring state
   machine (empty / prepared / active / invalid); candidate grouping
   (one glyph group = one candidate; multi-stroke signs must be drawn
   promptly — documented limitation); all six channels; sector measured
   in the configured frame, axis heading recorded; unknowns preserved;
   nothing dropped. *Acceptance: a drawn expression produces a readable
   GlyphAST matching what was drawn, mistakes included.*
8. **Compiler** (`compiler.js`, pure). AST→IR driven entirely by
   lexicon/grammar; cardinality and layer validation; per-lexeme channel
   declarations; intrinsic angle reading per §4.2; sector reported by
   provisional name; output = intent echo per decision 5. *Acceptance:
   valid expressions compile to the declared intent; invalid ones fail
   naming stage and reason (no ring / no sigil / unknown sign / sign in
   wrong layer).*
9. **Expression test bench.** Intent shown in plain English, drawn from
   memory, target vs compiled recorded. Confusion matrix at lexeme
   level; parse-failure breakdown; sector drift measured (drawn at NE,
   read at E) — the instrument for §4.3's frame question and §4.5's
   weightedness consistency. Saved with the export. *Acceptance: a
   four-glyph vocabulary drills end-to-end; a deliberately ambiguous pair
   shows as a red off-diagonal cell.*
10. **Wire-format alignment.** Export `format version 2`: RDP-simplified
    strokes, 16-bit quantised coords on a 1000×1000 grid, GlyphAST and
    GlyphIR included, version field on top. `version 1` raw export kept
    as training data. *Acceptance: a phone-side compiler could recompile
    from the file alone; 3–15 KB per expression.*

## 6. Path to the device

- Strokes, not pixels, cross the wire; task 10 makes the lab export *be*
  the BLE payload shape.
- Pure modules port three ways: WebView now, WASM later, C port of the
  recogniser per AGENTS.MD.
- Drill data from task 9 (stroke sizes, speeds, per-glyph durations) is
  the ground truth for the capacitive/resistive/EMR choice at Phase 1
  lock-in.
- Teaching exports as data and syncs to the device dictionary later; the
  alphabet is portable property.
- Phases 1–3 per the parent brief: dev board → PCB + wrist case →
  vocabulary growth and real execution targets.

## 7. Resource estimates

- Storage: lexicon ≈ 15 KB at 50 lexemes; grammar ≈ 2 KB; samples
  ≈ 150–500 KB — inside the 5 MB localStorage quota.
- Device payload: 3–15 KB per expression, ~1–2 s over BLE 4.2.
- Effort: tasks 1–4 ≈ 2–3 weeks beginner pace; tasks 5–10 ≈ 3–5 weeks
  (ring detection and parser are the steep parts); dev board ≈ 1–2 weeks
  after parts; PCB + case ≈ 4–8 weeks including fab.

## 8. Open questions (deferred, with owners)

1. **Sector reference frame** — sigil weighted axis (v1 default), ring
   opening, or page frame. Owner: admin, after early drilling; task 9's
   sector-drift metric is the evidence.
2. **Weightedness as a channel** — whether a sigil's asymmetric weighting
   carries meaning, read as ink-centroid offset. Owner: admin; task 9
   data decides feasibility before anything is built.
