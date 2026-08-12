/*
 * lib.js — pure data logic for the SAT practice viewer.
 * No DOM access here; this file is also runnable under Node for tests.
 *
 * Responsibilities:
 *  - Accept any College Board Question Bank JSON payload shape
 *    (single object, array, or object-map keyed by uid)
 *  - Normalize both known formats (modern "manifold" and legacy item-bank)
 *    into one internal model
 *  - Grade multiple-choice and student-produced-response answers
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SatLib = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LETTERS = "ABCDEFGHIJ";

  /* ---------------- payload extraction ---------------- */

  function looksLikeQuestion(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      (typeof obj.questionId === "string" ||
        typeof obj.uId === "string" ||
        (obj.content && typeof obj.content === "object"))
    );
  }

  // Returns a flat array of raw question objects from any accepted payload shape.
  function extractQuestions(payload) {
    if (payload == null) return [];
    if (Array.isArray(payload)) {
      var out = [];
      payload.forEach(function (item) {
        out = out.concat(extractQuestions(item));
      });
      return out;
    }
    if (typeof payload !== "object") return [];
    if (looksLikeQuestion(payload)) return [payload];
    // Object-map: { uid: {...}, uid2: {...} }
    var vals = Object.keys(payload).map(function (k) {
      return payload[k];
    });
    var out2 = [];
    vals.forEach(function (v) {
      out2 = out2.concat(extractQuestions(v));
    });
    return out2;
  }

  /* ---------------- normalization ---------------- */

  function letterFromIndex(i) {
    return LETTERS[i] || null;
  }

  function moduleLabel(mod) {
    var m = String(mod || "").toLowerCase().trim();
    if (m === "math" || m === "m") return "Math";
    if (
      m === "en" ||
      m === "english" ||
      m === "ela" ||
      m === "rw" ||
      m === "reading" ||
      m === "reading-writing" ||
      m === "reading and writing"
    )
      return "Reading & Writing";
    if (!m) return "Unknown";
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  function difficultyLabel(d) {
    var m = String(d || "").toUpperCase().trim();
    if (m === "E") return "Easy";
    if (m === "M") return "Medium";
    if (m === "H") return "Hard";
    return d ? String(d) : "Unrated";
  }

  // Strip <script> tags only; everything else is trusted College Board markup.
  function sanitizeHtml(html) {
    if (typeof html !== "string") return "";
    return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*\/?>/gi, "");
  }

  function isModern(raw) {
    var c = raw.content || {};
    if (c.origin === "manifold") return true;
    if (c.prompt !== undefined || c.answer !== undefined) return false;
    return c.stem !== undefined || c.answerOptions !== undefined;
  }

  function normalizeModern(raw) {
    var c = raw.content || {};
    var type = String(c.type || "").toLowerCase() === "spr" ? "spr" : "mcq";
    var options = [];
    (c.answerOptions || []).forEach(function (opt, i) {
      options.push({
        letter: letterFromIndex(i),
        html: sanitizeHtml(opt && opt.content != null ? opt.content : ""),
        id: opt && opt.id != null ? String(opt.id) : null,
      });
    });
    if (options.length === 0 && type === "mcq" && String(c.type || "").toLowerCase() !== "mcq") {
      type = "spr";
    }

    var correct = null;
    if (type === "mcq") {
      var arr = Array.isArray(c.correct_answer) ? c.correct_answer : c.correct_answer != null ? [c.correct_answer] : [];
      var letters = [];
      arr.forEach(function (v) {
        var s = String(v).trim();
        if (/^[A-Ja-j]$/.test(s)) {
          letters.push(s.toUpperCase());
        } else {
          // Occasionally the value is an option id rather than a letter.
          for (var i = 0; i < options.length; i++) {
            if (options[i].id === s) letters.push(options[i].letter);
          }
        }
      });
      correct = letters.length ? letters : null;
    } else {
      var keys = [];
      [c.correct_answer, c.keys].forEach(function (src) {
        if (Array.isArray(src)) {
          src.forEach(function (v) {
            if (v != null && String(v).trim() !== "") keys.push(String(v).trim());
          });
        } else if (src != null && String(src).trim() !== "") {
          keys.push(String(src).trim());
        }
      });
      // de-dupe accepted strings
      keys = keys.filter(function (v, i) {
        return keys.indexOf(v) === i;
      });
      correct = keys.length ? keys : null;
    }

    return {
      stimulus: sanitizeHtml(c.stimulus || c.body || ""),
      stem: sanitizeHtml(c.stem || ""),
      type: type,
      options: type === "mcq" ? options : [],
      correct: correct,
      rationale: sanitizeHtml(c.rationale || ""),
    };
  }

  function normalizeLegacy(raw) {
    var c = raw.content || {};
    var ans = c.answer || {};
    var style = String(ans.style || "").toLowerCase();
    var type = style === "spr" ? "spr" : "mcq";

    var options = [];
    if (type === "mcq" && ans.choices && typeof ans.choices === "object") {
      Object.keys(ans.choices)
        .sort()
        .forEach(function (key) {
          var ch = ans.choices[key] || {};
          options.push({
            letter: key.toUpperCase(),
            html: sanitizeHtml(ch.body != null ? ch.body : ""),
            id: key,
          });
        });
    }

    var correct = null;
    if (type === "mcq") {
      if (ans.correct_choice != null && String(ans.correct_choice).trim() !== "") {
        correct = [String(ans.correct_choice).trim().toUpperCase()];
      }
    } else {
      // Legacy SPR: structured key may exist under several names — or not at all.
      var keys = [];
      [ans.correct_answer, ans.keys, ans.correct_choice, ans.answer].forEach(function (src) {
        if (Array.isArray(src)) {
          src.forEach(function (v) {
            if (v != null && String(v).trim() !== "") keys.push(String(v).trim());
          });
        } else if (src != null && typeof src !== "object" && String(src).trim() !== "") {
          keys.push(String(src).trim());
        }
      });
      keys = keys.filter(function (v, i) {
        return keys.indexOf(v) === i;
      });
      correct = keys.length ? keys : null; // null => "no structured answer key"
    }

    return {
      stimulus: sanitizeHtml(c.body || ""),
      stem: sanitizeHtml(c.prompt || ""),
      type: type,
      options: options,
      correct: correct,
      rationale: sanitizeHtml(ans.rationale || c.rationale || ""),
    };
  }

  // Normalize one raw question object into the internal model. Returns null if unusable.
  function normalizeQuestion(raw) {
    if (!looksLikeQuestion(raw)) return null;
    var core = isModern(raw) ? normalizeModern(raw) : normalizeLegacy(raw);
    if (!core.stem && !core.stimulus) return null;

    var id =
      (raw.uId != null && String(raw.uId)) ||
      (raw.questionId != null && String(raw.questionId)) ||
      null;
    if (!id) {
      // Deterministic fallback id from content so re-imports still dedupe.
      id = "gen-" + simpleHash(core.stem + "|" + core.stimulus);
    }

    return {
      id: id,
      uId: raw.uId != null ? String(raw.uId) : null,
      questionId: raw.questionId != null ? String(raw.questionId) : null,
      module: moduleLabel(raw.module),
      domainCode: raw.primary_class_cd || "",
      domain: raw.primary_class_cd_desc || "Uncategorized",
      skillCode: raw.skill_cd || "",
      skill: raw.skill_desc || "Uncategorized",
      difficulty: String(raw.difficulty || "").toUpperCase() || "?",
      type: core.type,
      stimulus: core.stimulus,
      stem: core.stem,
      options: core.options,
      correct: core.correct,
      rationale: core.rationale,
    };
  }

  function simpleHash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  // Full import pipeline: payload -> { questions: [...], skipped: n }
  function normalizeAll(payload) {
    var raws = extractQuestions(payload);
    var out = [];
    var seen = {};
    var skipped = 0;
    raws.forEach(function (raw) {
      var q = normalizeQuestion(raw);
      if (!q) {
        skipped++;
        return;
      }
      if (seen[q.id]) return; // dedupe within a single payload
      seen[q.id] = true;
      out.push(q);
    });
    return { questions: out, skipped: skipped };
  }

  /* ---------------- grading ---------------- */

  // Parse "3/2", "1.5", "-0.25", ".1764", "1,000", "50%" etc. Returns number or null.
  function parseNumeric(str) {
    if (str == null) return null;
    var s = String(str).trim().replace(/,/g, "").replace(/\$/g, "");
    var pct = false;
    if (/%$/.test(s)) {
      pct = true;
      s = s.replace(/%$/, "").trim();
    }
    var m = s.match(/^(-?)(\d+(?:\.\d*)?|\.\d+)\s*\/\s*(-?)(\d+(?:\.\d*)?|\.\d+)$/);
    var val;
    if (m) {
      var num = parseFloat(m[2]);
      var den = parseFloat(m[4]);
      if (!isFinite(num) || !isFinite(den) || den === 0) return null;
      val = (num / den) * (m[1] === "-" ? -1 : 1) * (m[3] === "-" ? -1 : 1);
    } else if (/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) {
      val = parseFloat(s);
    } else {
      return null;
    }
    if (!isFinite(val)) return null;
    return pct ? val / 100 : val;
  }

  var EPSILON = 1e-6;

  // Free-response grading: numeric comparison first, string fallback.
  function gradeSpr(input, accepted) {
    if (accepted == null || !accepted.length) return null; // no structured key
    var inStr = String(input == null ? "" : input).trim();
    if (inStr === "") return false;
    var inNum = parseNumeric(inStr);
    for (var i = 0; i < accepted.length; i++) {
      var a = String(accepted[i]).trim();
      if (a.toLowerCase() === inStr.toLowerCase()) return true;
      var aNum = parseNumeric(a);
      if (inNum != null && aNum != null && Math.abs(inNum - aNum) < EPSILON) return true;
    }
    return false;
  }

  // Multiple-choice grading.
  function gradeMcq(selectedLetter, correctLetters) {
    if (correctLetters == null || !correctLetters.length) return null;
    var sel = String(selectedLetter || "").trim().toUpperCase();
    return correctLetters.indexOf(sel) !== -1;
  }

  /* ---------------- taxonomy helpers ---------------- */

  // Build Module -> Domain -> Skill -> difficulty-count tree from question list.
  function buildTree(questions) {
    var tree = {};
    questions.forEach(function (q) {
      var mod = (tree[q.module] = tree[q.module] || { count: 0, domains: {} });
      mod.count++;
      var dom = (mod.domains[q.domain] = mod.domains[q.domain] || { count: 0, skills: {} });
      dom.count++;
      var sk = (dom.skills[q.skill] = dom.skills[q.skill] || { count: 0, difficulties: {} });
      sk.count++;
      sk.difficulties[q.difficulty] = (sk.difficulties[q.difficulty] || 0) + 1;
    });
    return tree;
  }

  var DIFF_ORDER = { E: 0, M: 1, H: 2 };

  function sortQuestions(list) {
    return list.slice().sort(function (a, b) {
      if (a.module !== b.module) return a.module < b.module ? -1 : 1;
      if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
      if (a.skill !== b.skill) return a.skill < b.skill ? -1 : 1;
      var da = DIFF_ORDER[a.difficulty] != null ? DIFF_ORDER[a.difficulty] : 9;
      var db = DIFF_ORDER[b.difficulty] != null ? DIFF_ORDER[b.difficulty] : 9;
      if (da !== db) return da - db;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  return {
    extractQuestions: extractQuestions,
    normalizeQuestion: normalizeQuestion,
    normalizeAll: normalizeAll,
    sanitizeHtml: sanitizeHtml,
    parseNumeric: parseNumeric,
    gradeSpr: gradeSpr,
    gradeMcq: gradeMcq,
    buildTree: buildTree,
    sortQuestions: sortQuestions,
    moduleLabel: moduleLabel,
    difficultyLabel: difficultyLabel,
    letterFromIndex: letterFromIndex,
  };
});
