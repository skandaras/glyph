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
  - app.js — UI, drawing, screens
  - recogniser.js — recognition maths ONLY
- recogniser.js must contain pure functions with no DOM, canvas or
  browser APIs. It takes arrays of points in and returns plain data out.
  It will later be ported to C for a microcontroller, so keep it simple
  and readable.
- Must work on iPad Safari with Apple Pencil, Android Chrome, and
  desktop browsers.
- Serve locally with `python3 -m http.server 8000`. Tell me how to open
  it on my tablet over my home Wi-Fi.

## Data model (use these names everywhere)
- Point: { x, y, t, pressure }   // t = milliseconds
- Stroke: { points: Point[] }
- Glyph: { id, strokes: Stroke[], createdAt }
- Template: { name, samples: Glyph[] }

## Working style
- Do one task at a time. Don't add features I haven't asked for.
- Keep code commented so a beginner can follow it.
- When finished, list what I should manually test.
