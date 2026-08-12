/*
 * app.js — UI + IndexedDB persistence for the SAT practice viewer.
 * Depends on lib.js (window.SatLib).
 */

(function () {
  "use strict";

  var L = window.SatLib;

  /* ---------------- IndexedDB ---------------- */

  var DB_NAME = "sat-practice";
  var STORE = "questions";
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function dbGetAll() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function dbPutAll(questions) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        var store = tx.objectStore(STORE);
        questions.forEach(function (q) { store.put(q); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbClear() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------------- state ---------------- */

  var state = {
    all: [],            // every question, sorted
    filtered: [],       // current filtered set
    index: 0,           // position in filtered
    filter: { module: null, domain: null, skill: null }, // sidebar selection
    difficulties: {},   // e.g. {E:true} — empty means all
    selectedLetter: null,
    checked: false,
  };

  /* ---------------- elements ---------------- */

  function $(id) { return document.getElementById(id); }

  var el = {
    tree: $("tree"),
    totalCount: $("total-count"),
    emptyState: $("empty-state"),
    questionView: $("question-view"),
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

  /* ---------------- filtering ---------------- */

  function applyFilter() {
    var f = state.filter;
    var diffs = Object.keys(state.difficulties).filter(function (d) { return state.difficulties[d]; });
    state.filtered = state.all.filter(function (q) {
      if (f.module && q.module !== f.module) return false;
      if (f.domain && q.domain !== f.domain) return false;
      if (f.skill && q.skill !== f.skill) return false;
      if (diffs.length && diffs.indexOf(q.difficulty) === -1) return false;
      return true;
    });
    if (state.index >= state.filtered.length) state.index = 0;
  }

  /* ---------------- sidebar tree ---------------- */

  var expanded = {}; // "module" and "module||domain" keys

  function treeRow(depth, label, count, opts) {
    var row = document.createElement("div");
    row.className = "tree-row" + (opts.selected ? " selected" : "");
    var caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = opts.hasChildren ? (opts.open ? "▾" : "▸") : "";
    var lab = document.createElement("span");
    lab.className = "label";
    lab.textContent = label;
    lab.title = label;
    var cnt = document.createElement("span");
    cnt.className = "count";
    cnt.textContent = count;
    row.appendChild(caret);
    row.appendChild(lab);
    row.appendChild(cnt);
    row.addEventListener("click", opts.onclick);
    return row;
  }

  function renderTree() {
    var tree = L.buildTree(state.all);
    el.tree.innerHTML = "";
    var f = state.filter;

    // "All questions" row
    el.tree.appendChild(
      treeRow(0, "All questions", state.all.length, {
        selected: !f.module,
        hasChildren: false,
        onclick: function () {
          state.filter = { module: null, domain: null, skill: null };
          state.index = 0;
          refresh();
        },
      })
    );

    Object.keys(tree).sort().forEach(function (modName) {
      var mod = tree[modName];
      var modKey = modName;
      var modOpen = !!expanded[modKey];
      var modNode = document.createElement("div");
      modNode.className = "tree-node";
      modNode.appendChild(
        treeRow(0, modName, mod.count, {
          selected: f.module === modName && !f.domain,
          hasChildren: true,
          open: modOpen,
          onclick: function () {
            expanded[modKey] = !modOpen || !(f.module === modName && !f.domain) ? true : !modOpen;
            if (f.module === modName && !f.domain) expanded[modKey] = !modOpen;
            state.filter = { module: modName, domain: null, skill: null };
            state.index = 0;
            refresh();
          },
        })
      );

      if (modOpen) {
        var domWrap = document.createElement("div");
        domWrap.className = "tree-children";
        Object.keys(mod.domains).sort().forEach(function (domName) {
          var dom = mod.domains[domName];
          var domKey = modName + "||" + domName;
          var domOpen = !!expanded[domKey];
          domWrap.appendChild(
            treeRow(1, domName, dom.count, {
              selected: f.module === modName && f.domain === domName && !f.skill,
              hasChildren: true,
              open: domOpen,
              onclick: function () {
                if (f.module === modName && f.domain === domName && !f.skill) {
                  expanded[domKey] = !domOpen;
                } else {
                  expanded[domKey] = true;
                }
                state.filter = { module: modName, domain: domName, skill: null };
                state.index = 0;
                refresh();
              },
            })
          );
          if (domOpen) {
            var skWrap = document.createElement("div");
            skWrap.className = "tree-children";
            Object.keys(dom.skills).sort().forEach(function (skName) {
              var sk = dom.skills[skName];
              skWrap.appendChild(
                treeRow(2, skName, sk.count, {
                  selected: f.module === modName && f.domain === domName && f.skill === skName,
                  hasChildren: false,
                  onclick: function () {
                    state.filter = { module: modName, domain: domName, skill: skName };
                    state.index = 0;
                    refresh();
                  },
                })
              );
            });
            domWrap.appendChild(skWrap);
          }
        });
        modNode.appendChild(domWrap);
      }
      el.tree.appendChild(modNode);
    });

    el.totalCount.textContent = state.all.length + " question" + (state.all.length === 1 ? "" : "s");
  }

  /* ---------------- question rendering ---------------- */

  function setHtml(node, html) {
    node.innerHTML = L.sanitizeHtml(html || "");
  }

  function renderQuestion() {
    if (!state.all.length) {
      el.emptyState.classList.remove("hidden");
      el.questionView.classList.add("hidden");
      return;
    }
    el.emptyState.classList.add("hidden");
    el.questionView.classList.remove("hidden");

    if (!state.filtered.length) {
      el.breadcrumb.textContent = "No questions match the current filters.";
      el.difficulty.textContent = "";
      el.position.textContent = "0 / 0";
      el.stimulus.classList.add("hidden");
      el.stem.innerHTML = "";
      el.options.classList.add("hidden");
      el.spr.classList.add("hidden");
      el.check.disabled = true;
      el.result.classList.add("hidden");
      el.prev.disabled = true;
      el.next.disabled = true;
      return;
    }

    var q = state.filtered[state.index];
    state.selectedLetter = null;
    state.checked = false;

    el.breadcrumb.textContent = q.module + " › " + q.domain + " › " + q.skill;
    el.difficulty.textContent = L.difficultyLabel(q.difficulty);
    el.position.textContent = state.index + 1 + " / " + state.filtered.length;

    if (q.stimulus && q.stimulus.trim()) {
      setHtml(el.stimulus, q.stimulus);
      el.stimulus.classList.remove("hidden");
    } else {
      el.stimulus.classList.add("hidden");
      el.stimulus.innerHTML = "";
    }
    setHtml(el.stem, q.stem);

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
        setHtml(body, opt.html);
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
    el.next.disabled = state.index >= state.filtered.length - 1;
  }

  /* ---------------- checking ---------------- */

  function checkAnswer() {
    if (state.checked || !state.filtered.length) return;
    var q = state.filtered[state.index];
    var verdict;

    if (q.type === "mcq") {
      if (!state.selectedLetter) return; // nothing selected yet
      verdict = L.gradeMcq(state.selectedLetter, q.correct);
      // reveal highlighting
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
      if (q.type === "spr" && q.correct) {
        el.resultBanner.textContent = "Incorrect — correct answer: " + q.correct.join(", ");
      } else if (q.correct) {
        el.resultBanner.textContent = "Incorrect — correct answer: " + q.correct.join(", ");
      } else {
        el.resultBanner.textContent = "Incorrect";
      }
    } else {
      // verdict === null: no structured answer key
      el.resultBanner.className = "result-banner nokey";
      el.resultBanner.textContent = "No structured answer key for this question — see the explanation below.";
    }

    if (q.rationale && q.rationale.trim()) {
      setHtml(el.rationale, q.rationale);
      el.rationaleWrap.classList.remove("hidden");
    }
  }

  /* ---------------- navigation ---------------- */

  function go(delta) {
    var ni = state.index + delta;
    if (ni < 0 || ni >= state.filtered.length) return;
    state.index = ni;
    renderQuestion();
    el.questionView.scrollIntoView({ block: "start" });
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

    // merge/dedupe against existing set (by id = uId || questionId)
    var byId = {};
    state.all.forEach(function (q) { byId[q.id] = q; });
    var added = 0, updated = 0;
    incoming.forEach(function (q) {
      if (byId[q.id]) updated++; else added++;
      byId[q.id] = q; // newest import wins
    });

    var merged = Object.keys(byId).map(function (k) { return byId[k]; });

    dbPutAll(incoming).then(function () {
      state.all = L.sortQuestions(merged);
      state.index = 0;
      var msg = "Imported: " + added + " new, " + updated + " updated";
      if (skipped) msg += ", " + skipped + " unrecognized skipped";
      if (parseErrors) msg += ", " + parseErrors + " file(s) failed to parse";
      el.importStatus.textContent = msg;
      pendingFileTexts = [];
      el.pasteInput.value = "";
      el.fileInput.value = "";
      refresh();
    }).catch(function (e) {
      el.importStatus.textContent = "Storage error: " + e;
    });
  }

  /* ---------------- refresh ---------------- */

  function refresh() {
    applyFilter();
    renderTree();
    renderQuestion();
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

  document.addEventListener("keydown", function (e) {
    if (!el.modal.classList.contains("hidden")) return;
    if (e.target === el.sprInput || e.target === el.pasteInput) return;
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  });

  Array.prototype.forEach.call(document.querySelectorAll("#diff-chips .chip"), function (chip) {
    chip.addEventListener("click", function () {
      var d = chip.dataset.diff;
      state.difficulties[d] = !state.difficulties[d];
      chip.classList.toggle("active", state.difficulties[d]);
      state.index = 0;
      refresh();
    });
  });

  $("btn-clear").addEventListener("click", function () {
    if (!state.all.length) return;
    if (!confirm("Delete all " + state.all.length + " imported questions? This cannot be undone.")) return;
    dbClear().then(function () {
      state.all = [];
      state.filter = { module: null, domain: null, skill: null };
      state.index = 0;
      refresh();
    });
  });

  /* ---------------- init ---------------- */

  dbGetAll().then(function (questions) {
    state.all = L.sortQuestions(questions);
    // expand all modules by default
    Object.keys(L.buildTree(state.all)).forEach(function (m) { expanded[m] = true; });
    refresh();
  }).catch(function (e) {
    el.emptyState.classList.remove("hidden");
    console.error("Failed to open IndexedDB:", e);
  });
})();
