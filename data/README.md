# The language data

These two files are where the glyph language lives. They are mine to edit
in a text editor; the code only reads them.

## data/lexicon.json — what each glyph means

One entry per glyph shape I have taught (or plan to teach) in the app.

- `class` — grammatical role: `sigil` (the subject, drawn in the centre),
  `sign` (a modifier, drawn in the middle or outer layer), `ring` (the
  boundary circle itself), `connector` (reserved, not used yet).
- `templates` — the template names I teach in the app that this lexeme
  covers. A lexeme can own more than one template name (e.g. the same
  meaning drawn two ways).
- `layers` — which radial bands the lexeme is allowed to appear in.
- `orientationMode` — `invariant` (angle is ignored), `semantic` (the
  compiler reads the intrinsic angle), or `fixed` (each orientation is a
  distinct template/lexeme).
- `scaleMode` — `none`, or `degree` (drawing it bigger means more).
- `slotMode` / `slots` — which of the 8 sectors this sign may occupy
  (`named`), or `anywhereInLayer` to ignore sectors.
- `semantics` — free-form; this is the meaning the compiler echoes.
- `notes` — my design notes. Nothing reads these except me.

## data/grammar.json — the rules of a sentence

Tunable constants, so grammar experiments never touch code:

- `bands` — where the centre / middle / outer layers end, as fractions of
  the ring radius R.
- `ring` — thresholds for deciding a stroke is a ring: max angular gap,
  max roundness error, min radius in px.
- `sectors` — the 8 slot directions (45° each). The names N, NE, ... are
  provisional labels; which way "N" points is a deferred question (the
  leading candidate is the central sigil's own weighted axis).
- `frame` — how the sector compass is fixed at read time. v1 uses the
  sigil axis; switching is a config change, not a rewrite.
- `defaultSlots` — the working/testing subset of the 8.
- `cardinality` — how many rings, sigils and signs one expression may
  have. v1: exactly one ring, exactly one sigil, signs optional.
- `degreeBuckets` — how drawn size maps to degree words.

## Rules for editing

- Keep the `lexiconVersion` / `grammarVersion` numbers. Bump them when the
  shape of the file changes; the loaders refuse a file whose version they
  do not know, with a clear message.
- JSON must stay valid JSON (no trailing commas, no comments). The loader
  names the problem if I break it.
- Placeholder lexemes ship with this repo so the whole pipeline is
  testable before my real alphabet exists. Delete them as real glyphs
  arrive.
