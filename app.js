/*
 * app.js — UI + IndexedDB persistence for the SAT practice viewer.
 * Depends on lib.js (window.SatLib).
 *
 * Layout modeled on question-bank sites like OnePrep: a per-module landing
 * page listing domains and skills with progress + accuracy, and a separate
 * practice view showing one question at a time.
 */

(function () {
  "use strict";

  var L = window.SatLib;

  /* ---------------- IndexedDB ---------------- */

  var DB_NAME = "sat-practice";
  var Q_STORE = "questions";
  var P_STORE = "progress"; // { id, correct: true|false|null, ts }
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(Q_STORE)) {
          db.createObjectStore(Q_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(P_STORE)) {
          db.createObjectStore(P_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function dbGetAll(store) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readonly");
        var req = tx.objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function dbPutAll(store, rows) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        var s = tx.objectStore(store);
        rows.forEach(function (r) { s.put(r); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbClear(store) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------------- state ---------------- */

  var MODULE_ORDER = ["Reading & Writing", "Math"];

  var state = {
    all: [],              // every question, sorted
    progress: {},         // id -> { correct: true|false|null }
    module: null,         // current module tab
    difficulties: {},     // {E:true,...} — empty means all
    statusFilter: "all",  // all | unanswered | answered
    view: "topics",       // topics | practice
    set: [],              // current practice set
    index: 0,
    selectedLetter: null,
    checked: false,
    setLabel: "",         // breadcrumb prefix for the practice set
  };

  /* ---------------- elements ---------------- */

  function $(id) { return document.getElementById(id); }

  var el = {
    moduleTabs: $("module-tabs"),
    topicsView: $("topics-view"),
    moduleTitle: $("module-title"),
    practiceAllSub: $("practice-all-sub"),
    domainList: $("domain-list"),
    statusFilter: $("status-filter"),
    emptyState: $("empty-state"),
    practiceView: $("practice-view"),
    breadcrumb: $("q-breadcrumb"),
    difficulty: $("q-difficulty"),
    position: $("q-position"),
    stimulus: $("q-stimulus"),
    stem: $("q-stem"),
    options: $("q-options"),
    spr: $("q-spr"),
    sprInput: $("spr-input"),
    check: $("btn-check"),
    result: $("result"),
    resultBanner: $("result-banner"),
    rationaleWrap: $("rationale-wrap"),
    rationale: $("rationale"),
    prev: $("btn-prev"),
    next: $("btn-next"),
    modal: $("import-modal"),
    dropZone: $("drop-zone"),
    fileInput: $("file-input"),
    pasteInput: $("paste-input"),
    importStatus: $("import-status"),
    importRun: $("btn-import-run"),
  };

  /* ---------------- helpers ---------------- */

  function modulesPresent() {
    var seen = {};
    state.all.forEach(function (q) { seen[q.module] = true; });
    var known = MODULE_ORDER.filter(function (m) { return seen[m]; });
    var extra = Object.keys(seen).filter(function (m) { return MODULE_ORDER.indexOf(m) === -1; }).sort();
    return known.concat(extra);
  }

  function questionMatchesFilters(q) {
    var diffs = Object.keys(state.difficulties).filter(function (d) { return state.difficulties[d]; });
    if (diffs.length && diffs.indexOf(q.difficulty) === -1) return false;
    var answered = state.progress[q.id] !== undefined;
    if (state.statusFilter === "unanswered" && answered) return false;
    if (state.statusFilter === "answered" && !answered) return false;
    return true;
  }

  // Stats over a list of questions (unfiltered totals, like OnePrep's rows).
  function statsFor(list) {
    var total = list.length, answered = 0, graded = 0, correct = 0;
    list.forEach(function (q) {
      var p = state.progress[q.id];
      if (p !== undefined) {
        answered++;
        if (p.correct === true) { graded++; correct++; }
        else if (p.correct === false) { graded++; }
        // correct === null: answered but ungradable (no answer key)
      }
    });
    return {
      total: total,
      answered: answered,
      accuracy: graded ? Math.round((correct / graded) * 100) : null,
    };
  }

  function accuracyClass(pct) {
    if (pct === null) return "";
    if (pct >= 66) return "acc-good";
    if (pct >= 40) return "acc-mid";
    return "acc-bad";
  }

  /* ---------------- topbar / module tabs ---------------- */

  function renderTabs() {
    var mods = modulesPresent();
    el.moduleTabs.innerHTML = "";
    mods.forEach(function (m) {
      var b = document.createElement("button");
      b.className = "tab" + (m === state.module ? " active" : "");
      b.textContent = m;
      b.addEventListener("click", function () {
        state.module = m;
        state.view = "topics";
        render();
      });
      el.moduleTabs.appendChild(b);
    });
  }

  /* ---------------- topics view ---------------- */

  function renderTopics() {
    var moduleQs = state.all.filter(function (q) { return q.module === state.module; });
    el.moduleTitle.textContent = state.module || "";

    // Domain -> skill grouping (insertion order follows sorted question list)
    var domains = {}; // name -> { skills: { name -> [q] } }
    var domainOrder = [];
    moduleQs.forEach(function (q) {
      if (!domains[q.domain]) { domains[q.domain] = { order: [], skills: {} }; domainOrder.push(q.domain); }
      var d = domains[q.domain];
      if (!d.skills[q.skill]) { d.skills[q.skill] = []; d.order.push(q.skill); }
      d.skills[q.skill].push(q);
    });

    var skillCount = 0;
    domainOrder.forEach(function (dn) { skillCount += domains[dn].order.length; });
    el.practiceAllSub.textContent =
      "Start practicing all " + skillCount + " skill" + (skillCount === 1 ? "" : "s") +
      " in " + (state.module || "this module") + ".";

    el.domainList.innerHTML = "";
    domainOrder.forEach(function (domainName) {
      var d = domains[domainName];

      var section = document.createElement("section");
      section.className = "domain-section";

      var h = document.createElement("h2");
      h.className = "domain-title";
      h.textContent = domainName;
      section.appendChild(h);

      d.order.forEach(function (skillName) {
        var qs = d.skills[skillName];
        var st = statsFor(qs);

        var row = document.createElement("button");
        row.className = "skill-row";

        var name = document.createElement("span");
        name.className = "col-topic skill-name";
        name.textContent = skillName;

        var prog = document.createElement("span");
        prog.className = "col-progress";
        var bar = document.createElement("span");
        bar.className = "bar";
        var fill = document.createElement("span");
        fill.className = "bar-fill";
        fill.style.width = (st.total ? Math.max(2, Math.round((st.answered / st.total) * 100)) : 0) + "%";
        if (!st.answered) fill.style.width = "0%";
        bar.appendChild(fill);
        var frac = document.createElement("span");
        frac.className = "frac";
        frac.textContent = st.answered + "/" + st.total;
        prog.appendChild(bar);
        prog.appendChild(frac);

        var acc = document.createElement("span");
        acc.className = "col-accuracy " + accuracyClass(st.accuracy);
        if (st.accuracy !== null) {
          var dot = document.createElement("span");
          dot.className = "acc-dot";
          acc.appendChild(dot);
          acc.appendChild(document.createTextNode(st.accuracy + " %"));
        } else {
          acc.textContent = "–";
        }

        row.appendChild(name);
        row.appendChild(prog);
        row.appendChild(acc);
        row.addEventListener("click", function () {
          startPractice(qs, state.module + " › " + domainName);
        });
        section.appendChild(row);
      });

      el.domainList.appendChild(section);
    });
  }

  /* ---------------- practice flow ---------------- */

  function startPractice(pool, label) {
    var set = L.sortQuestions(pool.filter(questionMatchesFilters));
    if (!set.length) {
      alert("No questions match the current difficulty/status filters.");
      return;
    }
    state.set = set;
    state.index = 0;
    state.setLabel = label;
    state.view = "practice";
    render();
  }

  function renderQuestion() {
    var q = state.set[state.index];
    state.selectedLetter = null;
    state.checked = false;

    el.breadcrumb.textContent = q.module + " › " + q.domain + " › " + q.skill;
    el.difficulty.textContent = L.difficultyLabel(q.difficulty);
    el.position.textContent = state.index + 1 + " / " + state.set.length;

    if (q.stimulus && q.stimulus.trim()) {
      el.stimulus.innerHTML = L.sanitizeHtml(q.stimulus);
      el.stimulus.classList.remove("hidden");
    } else {
      el.stimulus.classList.add("hidden");
      el.stimulus.innerHTML = "";
    }
    el.stem.innerHTML = L.sanitizeHtml(q.stem);

    el.result.classList.add("hidden");
    el.rationaleWrap.classList.add("hidden");
    el.resultBanner.className = "result-banner";
    el.check.disabled = false;

    if (q.type === "mcq") {
      el.spr.classList.add("hidden");
      el.options.classList.remove("hidden");
      el.options.innerHTML = "";
      q.options.forEach(function (opt) {
        var btn = document.createElement("button");
        btn.className = "option";
        btn.dataset.letter = opt.letter;
        var letter = document.createElement("span");
        letter.className = "opt-letter";
        letter.textContent = opt.letter;
        var body = document.createElement("span");
        body.className = "opt-body";
        body.innerHTML = L.sanitizeHtml(opt.html);
        btn.appendChild(letter);
        btn.appendChild(body);
        btn.addEventListener("click", function () {
          if (state.checked) return;
          state.selectedLetter = opt.letter;
          Array.prototype.forEach.call(el.options.children, function (c) {
            c.classList.toggle("selected", c.dataset.letter === opt.letter);
          });
        });
        el.options.appendChild(btn);
      });
    } else {
      el.options.classList.add("hidden");
      el.options.innerHTML = "";
      el.spr.classList.remove("hidden");
      el.sprInput.value = "";
      el.sprInput.disabled = false;
    }

    el.prev.disabled = state.index === 0;
    el.next.disabled = state.index >= state.set.length - 1;
  }

  function checkAnswer() {
    if (state.checked || !state.set.length) return;
    var q = state.set[state.index];
    var verdict;

    if (q.type === "mcq") {
      if (!state.selectedLetter) return;
      verdict = L.gradeMcq(state.selectedLetter, q.correct);
      Array.prototype.forEach.call(el.options.children, function (c) {
        var letter = c.dataset.letter;
        c.disabled = true;
        if (q.correct && q.correct.indexOf(letter) !== -1) {
          c.classList.add("reveal-correct");
        } else if (letter === state.selectedLetter && verdict === false) {
          c.classList.add("reveal-wrong");
        }
      });
    } else {
      verdict = L.gradeSpr(el.sprInput.value, q.correct);
      el.sprInput.disabled = true;
    }

    state.checked = true;
    el.check.disabled = true;
    el.result.classList.remove("hidden");

    if (verdict === true) {
      el.resultBanner.className = "result-banner correct";
      el.resultBanner.textContent = "Correct";
      if (q.type === "spr" && q.correct) {
        el.resultBanner.textContent += " — accepted answers: " + q.correct.join(", ");
      }
    } else if (verdict === false) {
      el.resultBanner.className = "result-banner incorrect";
      el.resultBanner.textContent = q.correct
        ? "Incorrect — correct answer: " + q.correct.join(", ")
        : "Incorrect";
    } else {
      el.resultBanner.className = "result-banner nokey";
      el.resultBanner.textContent = "No structured answer key for this question — see the explanation below.";
    }

    if (q.rationale && q.rationale.trim()) {
      el.rationale.innerHTML = L.sanitizeHtml(q.rationale);
      el.rationaleWrap.classList.remove("hidden");
    }

    // Record the attempt (latest attempt wins).
    var rec = { id: q.id, correct: verdict, ts: Date.now() };
    state.progress[q.id] = rec;
    dbPutAll(P_STORE, [rec]).catch(function (e) {
      console.error("Failed to save progress:", e);
    });
  }

  function go(delta) {
    var ni = state.index + delta;
    if (ni < 0 || ni >= state.set.length) return;
    state.index = ni;
    renderQuestion();
    window.scrollTo({ top: 0 });
  }

  /* ---------------- import ---------------- */

  function openModal() {
    el.importStatus.textContent = "";
    el.pasteInput.value = "";
    el.fileInput.value = "";
    pendingFileTexts = [];
    el.modal.classList.remove("hidden");
  }
  function closeModal() { el.modal.classList.add("hidden"); }

  var pendingFileTexts = [];

  function readFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var remaining = files.length;
    files.forEach(function (f) {
      var reader = new FileReader();
      reader.onload = function () {
        pendingFileTexts.push(reader.result);
        remaining--;
        if (remaining === 0) {
          el.importStatus.textContent = pendingFileTexts.length + " file" + (pendingFileTexts.length === 1 ? "" : "s") + " ready — click Import";
        }
      };
      reader.readAsText(f);
    });
  }

  function runImport() {
    var texts = pendingFileTexts.slice();
    var pasted = el.pasteInput.value.trim();
    if (pasted) texts.push(pasted);
    if (!texts.length) {
      el.importStatus.textContent = "Nothing to import — choose a file or paste JSON.";
      return;
    }

    var incoming = [];
    var parseErrors = 0;
    var skipped = 0;
    texts.forEach(function (t) {
      var payload;
      try {
        payload = JSON.parse(t);
      } catch (e) {
        parseErrors++;
        return;
      }
      var res = L.normalizeAll(payload);
      incoming = incoming.concat(res.questions);
      skipped += res.skipped;
    });

    if (parseErrors && !incoming.length) {
      el.importStatus.textContent = "Could not parse that as JSON.";
      return;
    }

    var byId = {};
    state.all.forEach(function (q) { byId[q.id] = q; });
    var added = 0, updated = 0;
    incoming.forEach(function (q) {
      if (byId[q.id]) updated++; else added++;
      byId[q.id] = q;
    });

    var merged = Object.keys(byId).map(function (k) { return byId[k]; });

    dbPutAll(Q_STORE, incoming).then(function () {
      state.all = L.sortQuestions(merged);
      if (!state.module || modulesPresent().indexOf(state.module) === -1) {
        state.module = modulesPresent()[0] || null;
      }
      var msg = "Imported: " + added + " new, " + updated + " updated";
      if (skipped) msg += ", " + skipped + " unrecognized skipped";
      if (parseErrors) msg += ", " + parseErrors + " file(s) failed to parse";
      el.importStatus.textContent = msg;
      pendingFileTexts = [];
      el.pasteInput.value = "";
      el.fileInput.value = "";
      state.view = "topics";
      render();
    }).catch(function (e) {
      el.importStatus.textContent = "Storage error: " + e;
    });
  }

  /* ---------------- render root ---------------- */

  function render() {
    renderTabs();
    if (!state.all.length) {
      el.emptyState.classList.remove("hidden");
      el.topicsView.classList.add("hidden");
      el.practiceView.classList.add("hidden");
      return;
    }
    el.emptyState.classList.add("hidden");
    if (state.view === "practice") {
      el.topicsView.classList.add("hidden");
      el.practiceView.classList.remove("hidden");
      renderQuestion();
    } else {
      el.practiceView.classList.add("hidden");
      el.topicsView.classList.remove("hidden");
      renderTopics();
    }
  }

  /* ---------------- wiring ---------------- */

  $("btn-import").addEventListener("click", openModal);
  $("btn-import-empty").addEventListener("click", openModal);
  $("btn-import-close").addEventListener("click", closeModal);
  el.modal.addEventListener("click", function (e) {
    if (e.target === el.modal) closeModal();
  });
  el.importRun.addEventListener("click", runImport);
  el.fileInput.addEventListener("change", function () { readFiles(el.fileInput.files); });

  el.dropZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    el.dropZone.classList.add("dragover");
  });
  el.dropZone.addEventListener("dragleave", function () {
    el.dropZone.classList.remove("dragover");
  });
  el.dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    el.dropZone.classList.remove("dragover");
    readFiles(e.dataTransfer.files);
  });

  el.check.addEventListener("click", checkAnswer);
  el.sprInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") checkAnswer();
  });
  el.prev.addEventListener("click", function () { go(-1); });
  el.next.addEventListener("click", function () { go(1); });
  $("btn-back").addEventListener("click", function () {
    state.view = "topics";
    render();
  });

  document.addEventListener("keydown", function (e) {
    if (state.view !== "practice") return;
    if (!el.modal.classList.contains("hidden")) return;
    if (e.target === el.sprInput || e.target === el.pasteInput) return;
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  });

  $("btn-practice-all").addEventListener("click", function () {
    var pool = state.all.filter(function (q) { return q.module === state.module; });
    startPractice(pool, state.module);
  });

  Array.prototype.forEach.call(document.querySelectorAll("#diff-chips .chip"), function (chip) {
    chip.addEventListener("click", function () {
      var d = chip.dataset.diff;
      state.difficulties[d] = !state.difficulties[d];
      chip.classList.toggle("active", state.difficulties[d]);
      render();
    });
  });

  el.statusFilter.addEventListener("change", function () {
    state.statusFilter = el.statusFilter.value;
    render();
  });

  $("btn-reset-progress").addEventListener("click", function () {
    var n = Object.keys(state.progress).length;
    if (!n) return;
    if (!confirm("Reset all progress (" + n + " answered questions)? Questions themselves are kept.")) return;
    dbClear(P_STORE).then(function () {
      state.progress = {};
      render();
    });
  });

  $("btn-clear").addEventListener("click", function () {
    if (!state.all.length) return;
    if (!confirm("Delete all " + state.all.length + " imported questions and all progress? This cannot be undone.")) return;
    Promise.all([dbClear(Q_STORE), dbClear(P_STORE)]).then(function () {
      state.all = [];
      state.progress = {};
      state.module = null;
      state.view = "topics";
      render();
    });
  });

  /* ---------------- preload (optional data/ scripts) ---------------- */

  // If data/preload-*.js files exist they define window.SAT_PRELOAD (raw
  // question objects). Import anything new once per stamp, so the parse cost
  // is paid but the normalize/store cost is skipped on subsequent loads.
  function maybeImportPreload() {
    var pre = window.SAT_PRELOAD;
    if (!pre || !pre.length) return Promise.resolve(0);
    var stamp = String(window.SAT_PRELOAD_STAMP || "n" + pre.length);
    var seenStamp = null;
    try { seenStamp = localStorage.getItem("sat-preload-stamp"); } catch (e) {}
    if (seenStamp === stamp) return Promise.resolve(0);
    var res = L.normalizeAll(pre);
    var existing = {};
    state.all.forEach(function (q) { existing[q.id] = true; });
    var added = res.questions.filter(function (q) { return !existing[q.id]; }).length;
    return dbPutAll(Q_STORE, res.questions).then(function () {
      var byId = {};
      state.all.forEach(function (q) { byId[q.id] = q; });
      res.questions.forEach(function (q) { byId[q.id] = q; });
      state.all = L.sortQuestions(Object.keys(byId).map(function (k) { return byId[k]; }));
      try { localStorage.setItem("sat-preload-stamp", stamp); } catch (e) {}
      if (added) console.log("Preload: imported " + added + " new questions.");
      return added;
    });
  }

  /* ---------------- init ---------------- */

  Promise.all([dbGetAll(Q_STORE), dbGetAll(P_STORE)]).then(function (res) {
    state.all = L.sortQuestions(res[0]);
    res[1].forEach(function (p) { state.progress[p.id] = p; });
    return maybeImportPreload();
  }).then(function () {
    state.module = modulesPresent()[0] || null;
    render();
  }).catch(function (e) {
    el.emptyState.classList.remove("hidden");
    console.error("Failed to open IndexedDB:", e);
  });
})();
