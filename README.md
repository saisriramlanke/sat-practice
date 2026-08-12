# SAT Practice

A local, offline SAT practice viewer that mimics reviewing questions in the official
College Board Question Bank / Bluebook. No accounts, no timer, no subscriptions —
just import questions, answer them, check correctness, read the explanation.

## Run it

Open `index.html` in any modern browser (Chrome, Edge, Firefox). That's it — no
server, no build step, no dependencies.

## Layout

Each module (Reading & Writing / Math) gets a landing page listing its domains
and skills — one row per skill with a progress bar (answered/total) and an
accuracy percentage, plus a "Practice all topics" card. Clicking a skill starts
practice on that skill's questions. Difficulty chips and an
answered/unanswered filter control which questions are included in a practice
set. Progress and accuracy persist locally; "Reset progress" clears attempts
without deleting questions. Accuracy counts each question's latest attempt;
questions with no structured answer key count toward progress but not accuracy.

## Import questions

Click **Import JSON** and drop/choose/paste JSON exported from the official
College Board Question Bank (satsuitequestionbank.collegeboard.org). Supported
payload shapes: a single question object, an array of questions, or an
object-map `{uid: {...}, ...}`. Both known formats are handled:

- **Modern** (`content.origin === "manifold"`): `stem` / `answerOptions` /
  `correct_answer` / `rationale`; `content.type` of `mcq` or `spr`.
- **Legacy** item-bank: `content.body` / `content.prompt` /
  `content.answer.choices` / `correct_choice`; `answer.style` of
  `"Multiple Choice"` or `"SPR"`.

Imports are merged and deduped by `uId` / `questionId` — re-importing the same
file is safe. Some legacy SPR questions have no structured answer key; those
still work, but instead of grading you'll see "no structured answer key — see
the explanation."

No question content is bundled with this app. `sample-questions.json` contains
four self-written dummy questions purely to demonstrate the import format.

## Where the data lives

Imported questions and answer history persist in your browser's IndexedDB
(origin-scoped, fully local). "Delete all questions" wipes everything;
"Reset progress" wipes only answer history. Nothing is ever sent anywhere.

Note: MathML (`<math>` tags) renders natively in current Chrome/Edge/Firefox.
Some Question Bank explanations reference images hosted on College Board's CDN;
those need an internet connection to display (base64-embedded images work
offline).

## Grading

- **Multiple choice**: selected letter vs. the question's answer key.
- **Free response (SPR)**: input is compared against every accepted answer —
  numerically when both parse as numbers (fractions like `3/2`, decimals like
  `1.5`, tolerance 1e-6), case-insensitive string match otherwise.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell |
| `styles.css` | Styling |
| `lib.js` | Pure data logic: payload parsing, format normalization, grading (Node-testable) |
| `app.js` | UI + IndexedDB persistence |
| `test.js` | Unit tests — run with `node test.js` |
| `sample-questions.json` | Self-written dummy questions demonstrating both import formats |
