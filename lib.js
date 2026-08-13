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

  /*
   * <mfenced> was removed from MathML Core, so Chrome silently drops the
   * fences: "2(8x)" renders as "28x". College Board content uses it heavily
   * (6,600+ occurrences), so rewrite it to explicit <mrow><mo>(...)</mo></mrow>.
   * Handles open/close attributes (|x|, brackets) and multi-child separators.
   */
  function attrValue(attrs, name, dflt) {
    var m = attrs.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', "i"));
    return m ? m[1] : dflt;
  }

  // Split MathML inner markup into top-level child elements; null if it
  // contains top-level text or is malformed (caller then leaves it joined).
  function splitTopLevelChildren(inner) {
    var out = [];
    var depth = 0;
    var start = 0;
    var re = /<\/?([a-zA-Z][\w:-]*)[^>]*?(\/?)>|[^<]+/g;
    var m;
    while ((m = re.exec(inner)) !== null) {
      var tok = m[0];
      if (tok.charAt(0) !== "<") {
        if (depth === 0 && tok.trim() !== "") return null; // loose text at top level
        continue;
      }
      var isClose = tok.charAt(1) === "/";
      var selfClose = m[2] === "/";
      if (isClose) {
        depth--;
        if (depth === 0) { out.push(inner.slice(start, m.index + tok.length)); start = m.index + tok.length; }
        if (depth < 0) return null;
      } else if (selfClose) {
        if (depth === 0) { out.push(inner.slice(start, m.index + tok.length)); start = m.index + tok.length; }
      } else {
        if (depth === 0) start = m.index;
        depth++;
      }
    }
    if (depth !== 0) return null;
    return out.filter(function (s) { return s.trim() !== ""; });
  }

  function fixMfenced(html) {
    if (html.indexOf("<mfenced") === -1) return html;
    var innermost = /<mfenced([^>]*)>((?:(?!<\/?mfenced)[\s\S])*?)<\/mfenced>/gi;
    var guard = 0;
    while (/<mfenced/i.test(html) && guard++ < 100) {
      var before = html;
      html = html.replace(innermost, function (_, attrs, inner) {
        var open = attrValue(attrs, "open", "(");
        var close = attrValue(attrs, "close", ")");
        var sep = attrValue(attrs, "separators", ",").trim();
        var body = inner;
        var kids = splitTopLevelChildren(inner);
        if (kids && kids.length > 1) {
          var joiner = "<mo>" + (sep.charAt(0) || ",") + "</mo>";
          body = kids.join(joiner);
        }
        return "<mrow>" +
          (open ? "<mo>" + open + "</mo>" : "") +
          body +
          (close ? "<mo>" + close + "</mo>" : "") +
          "</mrow>";
      });
      if (html === before) break; // malformed leftovers; don't loop forever
    }
    return html;
  }

  /*
   * <menclose> is also missing from MathML Core; CB uses notation="top" for
   * overlines (repeating decimals, line segments). Rewrite to <mover> with a
   * stretchy macron; unknown notations just unwrap so content stays visible.
   */
  function fixMenclose(html) {
    if (html.indexOf("<menclose") === -1) return html;
    var innermost = /<menclose([^>]*)>((?:(?!<\/?menclose)[\s\S])*?)<\/menclose>/gi;
    var guard = 0;
    while (/<menclose/i.test(html) && guard++ < 50) {
      var before = html;
      html = html.replace(innermost, function (_, attrs, inner) {
        var notation = attrValue(attrs, "notation", "");
        if (/\btop\b|\boverline\b/i.test(notation)) {
          return '<mover accent="true"><mrow>' + inner + '</mrow><mo stretchy="true">&#x00AF;</mo></mover>';
        }
        return "<mrow>" + inner + "</mrow>"; // unwrap unknown notations
      });
      if (html === before) break;
    }
    return html;
  }

  // Strip <script> tags, then repair markup Chrome can't display.
  // Everything else is trusted College Board markup.
  function sanitizeHtml(html) {
    if (typeof html !== "string") return "";
    var out = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<script\b[^>]*\/?>/gi, "");
    return fixMenclose(fixMfenced(out));
  }

  function stripTags(html) {
    return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
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
      } else {
        // Some legacy items omit correct_choice; the rationale states it
        // ("Choice B is correct..."). Recover it conservatively.
        var mMcq = stripTags(ans.rationale || c.rationale).match(
          /choice\s+([a-j])\s+is\s+(?:correct|the\s+best)/i
        );
        if (mMcq) correct = [mMcq[1].toUpperCase()];
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
      if (!keys.length) {
        // Many legacy SPR rationales open with "The correct answer is 403."
        // Recover numeric answers only; if the value is an image, no match.
        var NUM = "-?\\d*\\.?\\d+(?:\\s*\\/\\s*\\d+)?";
        var mSpr = stripTags(ans.rationale || c.rationale).match(
          new RegExp("correct answers?\\s+(?:is|are)\\s+(" + NUM + "(?:\\s*(?:,|and|or)\\s*" + NUM + ")*)", "i")
        );
        if (mSpr) {
          keys = mSpr[1].split(/\s*(?:,|and|or)\s*/).map(function (s) {
            return s.trim();
          }).filter(Boolean);
        }
      }
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

  /* ---------------- exam module composition (official blueprint) ---------------- */

  // College Board assessment framework: operational domain weights.
  var BLUEPRINT = {
    "Math": [
      ["Algebra", 0.35],
      ["Advanced Math", 0.35],
      ["Problem-Solving and Data Analysis", 0.15],
      ["Geometry and Trigonometry", 0.15],
    ],
    "Reading & Writing": [
      ["Craft and Structure", 0.28],
      ["Information and Ideas", 0.26],
      ["Standard English Conventions", 0.26],
      ["Expression of Ideas", 0.20],
    ],
  };

  // RW modules present skills in this order on the real test.
  var RW_SKILL_ORDER = ["WIC", "TSP", "CTC", "CID", "COE", "INF", "BOU", "FSS", "TRA", "SYN"];

  function shuffleArr(arr, rng) {
    var a = arr.slice();
    var rand = rng || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  // Largest-remainder allocation of n questions across a module's domains,
  // with ±1 jitter so consecutive modules aren't identical.
  function domainQuotas(mod, n, rng) {
    var rand = rng || Math.random;
    var doms = BLUEPRINT[mod] || [];
    var quotas = {};
    var floors = [];
    var used = 0;
    doms.forEach(function (d) {
      var exact = n * d[1];
      var f = Math.floor(exact);
      quotas[d[0]] = f;
      used += f;
      floors.push({ name: d[0], frac: exact - f });
    });
    floors.sort(function (a, b) { return b.frac - a.frac; });
    for (var i = 0; used < n; i = (i + 1) % floors.length) {
      quotas[floors[i].name]++;
      used++;
    }
    if (doms.length > 1 && rand() < 0.5) { // jitter: shift one question
      var names = doms.map(function (d) { return d[0]; });
      var from = names[Math.floor(rand() * names.length)];
      var to = names[Math.floor(rand() * names.length)];
      if (from !== to && quotas[from] > 1) { quotas[from]--; quotas[to]++; }
    }
    return quotas;
  }

  /*
   * Compose an exam module from a question pool following the real test's
   * domain distribution, SPR count (Math), and skill ordering (RW).
   * Falls back gracefully when a domain's pool runs dry: the shortfall is
   * filled from whatever remains, so late-plan modules still fill up.
   */
  function composeModule(mod, pool, n, rng) {
    var rand = rng || Math.random;
    n = Math.min(n, pool.length);
    if (!n) return [];
    var quotas = domainQuotas(mod, n, rng);
    var used = {};
    var picked = [];

    function take(q) { used[q.id] = true; picked.push(q); }

    // Math: place the real number of student-produced responses first.
    if (mod === "Math") {
      var sprPerModule = rand() < 0.5 ? 5 : 6;
      var sprTarget = Math.max(pool.some(function (q) { return q.type === "spr"; }) ? 1 : 0,
        Math.round(n * sprPerModule / 22));
      var sprs = shuffleArr(pool.filter(function (q) { return q.type === "spr"; }), rng);
      for (var s = 0; s < sprs.length && sprTarget > 0; s++) {
        var qs = sprs[s];
        if (quotas[qs.domain] > 0) {
          take(qs);
          quotas[qs.domain]--;
          sprTarget--;
        }
      }
    }

    // Fill each domain quota (Math: multiple choice preferred from here on).
    var byDomain = {};
    pool.forEach(function (q) {
      if (used[q.id]) return;
      (byDomain[q.domain] = byDomain[q.domain] || []).push(q);
    });
    Object.keys(quotas).forEach(function (dom) {
      var candidates = shuffleArr(byDomain[dom] || [], rng);
      if (mod === "Math") {
        candidates = candidates.filter(function (q) { return q.type === "mcq"; })
          .concat(candidates.filter(function (q) { return q.type === "spr"; }));
      }
      for (var i = 0; i < candidates.length && quotas[dom] > 0; i++) {
        take(candidates[i]);
        quotas[dom]--;
      }
    });

    // Shortfall (a domain ran dry): fill from anything left.
    if (picked.length < n) {
      var rest = shuffleArr(pool.filter(function (q) { return !used[q.id]; }), rng);
      for (var r = 0; r < rest.length && picked.length < n; r++) take(rest[r]);
    }

    // Order: RW follows the real skill sequence; Math intersperses everything.
    if (mod === "Reading & Writing") {
      picked.sort(function (a, b) {
        var ia = RW_SKILL_ORDER.indexOf(a.skillCode);
        var ib = RW_SKILL_ORDER.indexOf(b.skillCode);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
    } else {
      picked = shuffleArr(picked, rng);
    }
    return picked;
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
    composeModule: composeModule,
    domainQuotas: domainQuotas,
    RW_SKILL_ORDER: RW_SKILL_ORDER,
    moduleLabel: moduleLabel,
    difficultyLabel: difficultyLabel,
    letterFromIndex: letterFromIndex,
  };
});
