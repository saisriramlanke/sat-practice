/* Unit tests for lib.js — run with: node test.js */
"use strict";

const L = require("./lib.js");

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error("FAIL: " + name); }
}
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.error("  expected " + JSON.stringify(b) + " got " + JSON.stringify(a));
  assert(ok, name);
}

/* ---- fixtures ---- */

const modernMcq = {
  uId: "013b49a8-e0e3-4cde-8913-5016b184fb62",
  questionId: "002dba45",
  skill_cd: "H.C.",
  skill_desc: "Linear equations in two variables",
  primary_class_cd: "H",
  primary_class_cd_desc: "Algebra",
  difficulty: "M",
  module: "math",
  content: {
    origin: "manifold",
    type: "mcq",
    stem: "<p>What is x?</p>",
    answerOptions: [
      { id: "u1", content: "<p>1</p>" },
      { id: "u2", content: "<p>2</p>" },
      { id: "u3", content: "<p>3</p>" },
      { id: "u4", content: "<p>4</p>" },
    ],
    correct_answer: ["C"],
    rationale: "<p>Because.</p>",
  },
};

const modernSpr = {
  uId: "spr-uid-1",
  questionId: "spr01",
  skill_cd: "P.C.",
  skill_desc: "Ratios",
  primary_class_cd: "P",
  primary_class_cd_desc: "Problem-Solving and Data Analysis",
  difficulty: "H",
  module: "math",
  content: {
    origin: "manifold",
    type: "spr",
    stem: "<p>Compute.</p>",
    answerOptions: [],
    correct_answer: [".1764", " .1765", " 3/17"],
    rationale: "<p>3/17 ≈ .1764</p>",
  },
};

const legacyMcq = {
  questionId: "f224df07",
  skill_cd: "H.E.",
  skill_desc: "Linear inequalities in one or two variables",
  primary_class_cd: "H",
  primary_class_cd_desc: "Algebra",
  difficulty: "M",
  module: "math",
  content: {
    body: "<div>passage</div>",
    prompt: "<p>Which value?</p>",
    answer: {
      style: "Multiple Choice",
      choices: {
        a: { body: "<p>2</p>" },
        b: { body: "<p>4</p>" },
        c: { body: "<p>5</p>" },
        d: { body: "<p>6</p>" },
      },
      correct_choice: "c",
      rationale: "<p>It is 5.</p>",
    },
  },
};

const legacySprNoKey = {
  questionId: "nokey01",
  skill_cd: "H.E.",
  skill_desc: "Linear inequalities in one or two variables",
  primary_class_cd: "H",
  primary_class_cd_desc: "Algebra",
  difficulty: "H",
  module: "math",
  content: {
    prompt: "<p>Give one value of x with 2x &gt; 10.</p>",
    answer: {
      style: "SPR",
      rationale: "<p>Any value greater than 5 works, e.g. 6.</p>",
    },
  },
};

/* ---- payload shapes ---- */

eq(L.extractQuestions(modernMcq).length, 1, "single object payload");
eq(L.extractQuestions([modernMcq, legacyMcq]).length, 2, "array payload");
eq(L.extractQuestions({ a: modernMcq, b: legacyMcq }).length, 2, "object-map payload");
eq(L.extractQuestions({ data: { x: modernMcq } }).length, 1, "nested map payload");
eq(L.extractQuestions(null).length, 0, "null payload");
eq(L.extractQuestions("junk").length, 0, "junk payload");

/* ---- modern normalization ---- */

const m = L.normalizeQuestion(modernMcq);
eq(m.id, "013b49a8-e0e3-4cde-8913-5016b184fb62", "modern id = uId");
eq(m.type, "mcq", "modern mcq type");
eq(m.module, "Math", "module label");
eq(m.options.map(o => o.letter), ["A", "B", "C", "D"], "options lettered by position");
eq(m.correct, ["C"], "modern correct letters");
assert(m.options[2].html.indexOf("3") !== -1, "option C body");

// correct_answer given as option id instead of letter
const modernById = JSON.parse(JSON.stringify(modernMcq));
modernById.content.correct_answer = ["u2"];
eq(L.normalizeQuestion(modernById).correct, ["B"], "modern correct via option id");

const ms = L.normalizeQuestion(modernSpr);
eq(ms.type, "spr", "modern spr type");
eq(ms.correct, [".1764", ".1765", "3/17"], "modern spr keys trimmed");

// spr with keys field instead
const modernKeys = JSON.parse(JSON.stringify(modernSpr));
delete modernKeys.content.correct_answer;
modernKeys.content.keys = ["42"];
eq(L.normalizeQuestion(modernKeys).correct, ["42"], "modern spr via keys field");

/* ---- legacy normalization ---- */

const lg = L.normalizeQuestion(legacyMcq);
eq(lg.id, "f224df07", "legacy id = questionId");
eq(lg.type, "mcq", "legacy mcq type");
eq(lg.stimulus, "<div>passage</div>", "legacy stimulus from body");
eq(lg.options.map(o => o.letter), ["A", "B", "C", "D"], "legacy options uppercased");
eq(lg.correct, ["C"], "legacy correct_choice uppercased");
assert(lg.rationale.indexOf("It is 5") !== -1, "legacy rationale");

const nk = L.normalizeQuestion(legacySprNoKey);
eq(nk.type, "spr", "legacy spr type");
eq(nk.correct, null, "legacy spr with no recoverable key -> null");
assert(nk.rationale.length > 0, "no-key spr keeps rationale");

// rationale-recovery fallbacks
const mcqNoChoice = JSON.parse(JSON.stringify(legacyMcq));
delete mcqNoChoice.content.answer.correct_choice;
mcqNoChoice.content.answer.rationale = "<p>Choice B is correct. Subtracting…</p>";
eq(L.normalizeQuestion(mcqNoChoice).correct, ["B"], "mcq key recovered from rationale");

const sprRecover = JSON.parse(JSON.stringify(legacySprNoKey));
sprRecover.content.answer.rationale = "<p>The correct answer is <b>403</b>. For a linear equation…</p>";
eq(L.normalizeQuestion(sprRecover).correct, ["403"], "spr key recovered from rationale");

const sprMulti = JSON.parse(JSON.stringify(legacySprNoKey));
sprMulti.content.answer.rationale = "<p>The correct answers are 6 and 7. Either value…</p>";
eq(L.normalizeQuestion(sprMulti).correct, ["6", "7"], "spr multiple keys recovered");

const sprImgAnswer = JSON.parse(JSON.stringify(legacySprNoKey));
sprImgAnswer.content.answer.rationale = '<p>The correct answer is <img src="data:image/png;base64,AAA">.</p>';
eq(L.normalizeQuestion(sprImgAnswer).correct, null, "image-only answer stays null");

/* ---- dedupe ---- */

const all = L.normalizeAll([modernMcq, modernMcq, legacyMcq]);
eq(all.questions.length, 2, "dedupe within payload");
eq(all.skipped, 0, "nothing skipped");
eq(L.normalizeAll([{ foo: "bar" }]).questions.length, 0, "unrecognized object skipped");

/* ---- sanitization ---- */

eq(L.sanitizeHtml('<p>hi</p><script>alert(1)</script><b>ok</b>'), "<p>hi</p><b>ok</b>", "script stripped");
eq(L.sanitizeHtml('<p><math><mi>x</mi></math></p>'), "<p><math><mi>x</mi></math></p>", "mathml preserved");
eq(L.sanitizeHtml('<img src="data:image/png;base64,AAAA">'), '<img src="data:image/png;base64,AAAA">', "img preserved");

/* ---- mfenced repair (Chrome dropped <mfenced>) ---- */

eq(
  L.sanitizeHtml("<math><mfenced><mrow><mn>8</mn><mi>x</mi></mrow></mfenced></math>"),
  "<math><mrow><mo>(</mo><mrow><mn>8</mn><mi>x</mi></mrow><mo>)</mo></mrow></math>",
  "mfenced default parens"
);
eq(
  L.sanitizeHtml('<math><mfenced open="|" close="|"><mi>x</mi></mfenced></math>'),
  "<math><mrow><mo>|</mo><mi>x</mi><mo>|</mo></mrow></math>",
  "mfenced custom fences (absolute value)"
);
eq(
  L.sanitizeHtml("<math><mfenced><mn>0</mn><mn>22</mn></mfenced></math>"),
  "<math><mrow><mo>(</mo><mn>0</mn><mo>,</mo><mn>22</mn><mo>)</mo></mrow></math>",
  "mfenced multi-child gets comma separator"
);
eq(
  L.sanitizeHtml("<math><mfenced><mrow><mfenced><mi>y</mi></mfenced></mrow></mfenced></math>"),
  "<math><mrow><mo>(</mo><mrow><mrow><mo>(</mo><mi>y</mi><mo>)</mo></mrow></mrow><mo>)</mo></mrow></math>",
  "nested mfenced"
);
assert(L.sanitizeHtml("<math><mfenced><mi>x</mi></math>").indexOf("<mfenced") !== -1 || true, "malformed mfenced does not hang");

/* ---- menclose repair ---- */

eq(
  L.sanitizeHtml('<math><menclose notation="top"><mn>3</mn></menclose></math>'),
  '<math><mover accent="true"><mrow><mn>3</mn></mrow><mo stretchy="true">&#x00AF;</mo></mover></math>',
  "menclose top becomes overline"
);
eq(
  L.sanitizeHtml('<math><menclose notation="box"><mi>x</mi></menclose></math>'),
  "<math><mrow><mi>x</mi></mrow></math>",
  "unknown menclose notation unwraps"
);

/* ---- module composition ---- */

function fakeQ(id, domain, skillCode, type) {
  return { id: String(id), module: "Math", domain: domain, skillCode: skillCode, type: type || "mcq", correct: ["1"], difficulty: "H" };
}
var fakePool = [];
var domains = ["Algebra", "Advanced Math", "Problem-Solving and Data Analysis", "Geometry and Trigonometry"];
domains.forEach(function (d, di) {
  for (var i = 0; i < 40; i++) fakePool.push(fakeQ(d + i, d, "X", i < 8 ? "spr" : "mcq"));
});
var modSet = L.composeModule("Math", fakePool, 22);
eq(modSet.length, 22, "module fills to 22");
var byDom = {};
modSet.forEach(function (q) { byDom[q.domain] = (byDom[q.domain] || 0) + 1; });
assert(byDom["Algebra"] >= 6 && byDom["Algebra"] <= 9, "algebra ~35%");
assert(byDom["Advanced Math"] >= 6 && byDom["Advanced Math"] <= 9, "advanced ~35%");
assert((byDom["Problem-Solving and Data Analysis"] || 0) >= 2 && byDom["Problem-Solving and Data Analysis"] <= 5, "psda ~15%");
var sprN = modSet.filter(function (q) { return q.type === "spr"; }).length;
assert(sprN >= 4 && sprN <= 7, "spr count realistic (got " + sprN + ")");
var ids = {};
assert(modSet.every(function (q) { if (ids[q.id]) return false; ids[q.id] = 1; return true; }), "no duplicate questions");

// depleted domain backfills
var tinyPool = fakePool.filter(function (q) { return q.domain !== "Algebra"; });
eq(L.composeModule("Math", tinyPool, 22).length, 22, "backfill when a domain is empty");

/* ---- numeric parsing ---- */

eq(L.parseNumeric("3/2"), 1.5, "fraction");
eq(L.parseNumeric("-3/2"), -1.5, "negative fraction");
eq(L.parseNumeric(".1764"), 0.1764, "bare decimal");
eq(L.parseNumeric("1,000"), 1000, "comma stripped");
eq(L.parseNumeric("$5"), 5, "dollar stripped");
eq(L.parseNumeric("50%"), 0.5, "percent");
eq(L.parseNumeric("x+1"), null, "non-numeric null");
eq(L.parseNumeric("3/0"), null, "divide by zero null");

/* ---- SPR grading ---- */

const keys = [".1764", ".1765", "3/17"];
eq(L.gradeSpr("3/17", keys), true, "exact fraction match");
eq(L.gradeSpr(".1764", keys), true, "decimal match");
eq(L.gradeSpr("0.1764", keys), true, "leading-zero decimal numeric match");
eq(L.gradeSpr(" .1765 ", keys), true, "whitespace trimmed");
eq(L.gradeSpr(".18", keys), false, "wrong decimal");
eq(L.gradeSpr("", keys), false, "empty input false");
eq(L.gradeSpr("6", ["6", "6.0"]), true, "integer match");
eq(L.gradeSpr("12/2", ["6"]), true, "equivalent fraction numeric match");
eq(L.gradeSpr("abc", ["ABC"]), true, "case-insensitive string fallback");
eq(L.gradeSpr("anything", null), null, "no key -> null verdict");
eq(L.gradeSpr("anything", []), null, "empty key -> null verdict");

/* ---- MCQ grading ---- */

eq(L.gradeMcq("C", ["C"]), true, "mcq correct");
eq(L.gradeMcq("c", ["C"]), true, "mcq case-insensitive");
eq(L.gradeMcq("A", ["C"]), false, "mcq wrong");
eq(L.gradeMcq("A", null), null, "mcq no key");

/* ---- tree + sort ---- */

const qs = [m, ms, lg, nk].map(q => q);
const tree = L.buildTree(qs);
eq(tree["Math"].count, 4, "tree module count");
eq(tree["Math"].domains["Algebra"].count, 3, "tree domain count");
eq(tree["Math"].domains["Algebra"].skills["Linear inequalities in one or two variables"].count, 2, "tree skill count");
eq(tree["Math"].domains["Algebra"].skills["Linear inequalities in one or two variables"].difficulties, { M: 1, H: 1 }, "tree difficulty counts");

const sorted = L.sortQuestions(qs);
assert(sorted.length === 4, "sort keeps all");
assert(sorted[0].domain <= sorted[sorted.length - 1].domain, "sorted by domain");

/* ---- labels ---- */

eq(L.moduleLabel("en"), "Reading & Writing", "en -> Reading & Writing");
eq(L.moduleLabel("math"), "Math", "math label");
eq(L.difficultyLabel("E"), "Easy", "difficulty label");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
