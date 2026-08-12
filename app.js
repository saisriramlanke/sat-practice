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

  // 30-day plan configuration (Sai's plan, committed 2026-08-11)
  var PLAN = {
    start: "2026-08-12",
    lastDay: "2026-09-11",
    testDate: "2026-09-12",
    goal: "1500+",
    quota: { "Reading & Writing": 27, "Math": 22 }, // one real module per day
  };

  var state = {
    all: [],              // every question, sorted
    progress: {},         // id -> { correct: true|false|null }
    module: null,         // current module tab
    difficulties: {},     // {E:true,...} — empty means all
    statusFilter: "all",  // all | unanswered | answered
    view: "plan",         // plan | topics | practice
    daily: {},            // "YYYY-MM-DD" -> { "Module|Diff": count } answered tally
    set: [],              // current practice set
    index: 0,
    selectedLetter: null,
    checked: false,
    setLabel: "",         // label for the practice set
    marked: {},           // id -> true (mark for review, persisted)
    struck: {},           // id -> { letter: true } (eliminated choices, persisted)
    elimMode: false,      // ABC cross-out mode
    timer: null,          // { start, intervalId }
    timerHidden: false,
    pendingRestore: null, // one-shot: reapply selection/checked after resume
  };

  /* ---------------- elements ---------------- */

  function $(id) { return document.getElementById(id); }

  var el = {
    topbar: $("topbar"),
    moduleTabs: $("module-tabs"),
    planView: $("plan-view"),
    planCountdown: $("plan-countdown"),
    planStreak: $("plan-streak"),
    planPools: $("plan-pools"),
    todayCard: $("today-card"),
    planDays: $("plan-days"),
    topicsView: $("topics-view"),
    moduleTitle: $("module-title"),
    practiceAllSub: $("practice-all-sub"),
    domainList: $("domain-list"),
    statusFilter: $("status-filter"),
    emptyState: $("empty-state"),
    practiceView: $("practice-view"),
    setLabel: $("set-label"),
    timerEl: $("timer"),
    timerToggle: $("btn-timer-toggle"),
    qArea: $("q-area"),
    qLeft: $("q-left"),
    qNum: $("q-num"),
    markBtn: $("btn-mark"),
    elimBtn: $("btn-eliminate"),
    bbSkill: $("bb-skill"),
    bbPos: $("bb-pos"),
    bbTotal: $("bb-total"),
    navBtn: $("btn-navigator"),
    navPopup: $("nav-popup"),
    navPopupTitle: $("nav-popup-title"),
    navGrid: $("nav-grid"),
    difficulty: $("q-difficulty"),
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

    var planBtn = document.createElement("button");
    planBtn.className = "tab" + (state.view === "plan" ? " active" : "");
    planBtn.textContent = "Plan";
    planBtn.addEventListener("click", function () {
      state.view = "plan";
      render();
    });
    el.moduleTabs.appendChild(planBtn);

    mods.forEach(function (m) {
      var b = document.createElement("button");
      b.className = "tab" + (state.view === "topics" && m === state.module ? " active" : "");
      b.textContent = m;
      b.addEventListener("click", function () {
        state.module = m;
        state.view = "topics";
        savePrefs();
        render();
      });
      el.moduleTabs.appendChild(b);
    });
  }

  /* ---------------- plan engine ---------------- */

  function dateKey(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function parseDay(s) {
    var p = s.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function addDays(d, n) {
    var x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  var DAY_FMT = { weekday: "short", month: "short", day: "numeric" };

  function tallyFor(dayKeyStr, mod, diff) {
    var t = state.daily[dayKeyStr] || {};
    if (diff) return t[mod + "|" + diff] || 0;
    var sum = 0;
    Object.keys(t).forEach(function (k) {
      if (k.indexOf(mod + "|") === 0) sum += t[k];
    });
    return sum;
  }

  function recordDaily(q) {
    var k = dateKey(new Date());
    var t = state.daily[k] = state.daily[k] || {};
    var key = q.module + "|" + q.difficulty;
    t[key] = (t[key] || 0) + 1;
    try { localStorage.setItem("sat-daily", JSON.stringify(state.daily)); } catch (e) {}
  }

  function unansweredPool(mod, diff) {
    return state.all.filter(function (q) {
      return q.module === mod && q.difficulty === diff && !state.progress[q.id];
    });
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  // Build the day-by-day schedule. Past days carry actual tallies; today and
  // future days carry targets computed from the live unanswered pools, so the
  // plan self-corrects as questions get done (or skipped).
  function computePlan() {
    var today = parseDay(dateKey(new Date()));
    var start = parseDay(PLAN.start);
    var last = parseDay(PLAN.lastDay);
    var days = [];

    var pools = {};
    MODULE_ORDER.forEach(function (mod) {
      pools[mod] = {
        H: unansweredPool(mod, "H").length,
        M: unansweredPool(mod, "M").length,
      };
    });
    // Subtract what's already done today so today's row shows the full-day target.
    var todayKey = dateKey(today);
    MODULE_ORDER.forEach(function (mod) {
      pools[mod].H += Math.min(tallyFor(todayKey, mod, "H"), PLAN.quota[mod]);
    });

    var totalFuture = Math.round((last - today) / 86400000) + 1;

    for (var d = new Date(start); d <= last; d = addDays(d, 1)) {
      var k = dateKey(d);
      var row = { key: k, date: new Date(d), past: d < today, today: k === todayKey, targets: {}, done: {} };
      MODULE_ORDER.forEach(function (mod) {
        row.done[mod] = {
          H: tallyFor(k, mod, "H"),
          M: tallyFor(k, mod, "M"),
          total: tallyFor(k, mod),
        };
        if (!row.past) {
          var daysLeft = Math.round((last - d) / 86400000) + 1;
          var h = Math.min(PLAN.quota[mod], pools[mod].H);
          var m = 0;
          if (h < PLAN.quota[mod] && pools[mod].M > 0) {
            m = Math.ceil(pools[mod].M / daysLeft);
          }
          pools[mod].H -= h;
          pools[mod].M -= Math.min(m, pools[mod].M);
          row.targets[mod] = { H: h, M: m };
        }
      });
      days.push(row);
    }
    return days;
  }

  function dayMet(row) {
    return MODULE_ORDER.every(function (mod) {
      return row.done[mod].total >= PLAN.quota[mod];
    });
  }

  function computeStreak(days) {
    var streak = 0;
    for (var i = days.length - 1; i >= 0; i--) {
      var row = days[i];
      if (!row.past && !row.today) continue;
      if (row.today) {
        if (dayMet(row)) streak++;
        continue; // an unfinished today doesn't break the streak
      }
      if (dayMet(row)) streak++;
      else break;
    }
    return streak;
  }

  function startPracticeExact(set, label) {
    if (!set.length) return;
    state.set = set;
    state.index = 0;
    state.setLabel = label;
    state.view = "practice";
    startTimer(0);
    render();
  }

  function buildPlanSet(mod, todayRow) {
    var t = todayRow.targets[mod] || { H: 0, M: 0 };
    var needH = Math.max(0, t.H - todayRow.done[mod].H);
    var needM = Math.max(0, t.M - todayRow.done[mod].M);
    return shuffle(unansweredPool(mod, "H")).slice(0, needH)
      .concat(shuffle(unansweredPool(mod, "M")).slice(0, needM));
  }

  function todayRowOf(days) {
    var row = null;
    (days || computePlan()).forEach(function (r) { if (r.today) row = r; });
    return row;
  }

  function dayNumOf(row) {
    return Math.round((parseDay(row.key) - parseDay(PLAN.start)) / 86400000) + 1;
  }

  function startPlanModule(mod) {
    var todayRow = todayRowOf();
    if (!todayRow) { alert("Today is outside the plan window."); return; }
    var set = buildPlanSet(mod, todayRow);
    if (!set.length) {
      alert("Today's " + mod + " module is already done (or the pools are empty).");
      return;
    }
    startPracticeExact(set, "Day " + dayNumOf(todayRow) + " — " + mod);
  }

  // One click = the whole day: remaining R&W dose, then remaining Math dose.
  function startPlanDay() {
    var todayRow = todayRowOf();
    if (!todayRow) { alert("Today is outside the plan window."); return; }
    var set = buildPlanSet("Reading & Writing", todayRow).concat(buildPlanSet("Math", todayRow));
    if (!set.length) {
      alert("Today is already done. See you tomorrow.");
      return;
    }
    startPracticeExact(set, "Day " + dayNumOf(todayRow));
  }

  // One-shot dry run so the flow can be verified before the plan starts.
  var TESTRUN_KEY = "sat-testrun-done";
  function testRunDone() {
    try { return localStorage.getItem(TESTRUN_KEY) === "1"; } catch (e) { return false; }
  }
  function startTestRun() {
    var set = shuffle(unansweredPool("Reading & Writing", "H")).slice(0, 3)
      .concat(shuffle(unansweredPool("Math", "H")).slice(0, 2));
    if (!set.length) { alert("No questions available."); return; }
    startPracticeExact(set, "Test run");
  }

  function renderPlan() {
    var days = computePlan();
    var today = dateKey(new Date());
    var testDay = parseDay(PLAN.testDate);
    var daysToTest = Math.round((testDay - parseDay(today)) / 86400000);

    el.planCountdown.textContent =
      "SAT: Sat, Sep 12 · " + (daysToTest > 0 ? daysToTest + " day" + (daysToTest === 1 ? "" : "s") + " to go" : daysToTest === 0 ? "TODAY" : "passed");

    var streak = computeStreak(days);
    el.planStreak.textContent = streak + "-day streak";

    var poolBits = MODULE_ORDER.map(function (mod) {
      var h = unansweredPool(mod, "H").length;
      var m = unansweredPool(mod, "M").length;
      return (mod === "Math" ? "Math" : "R&W") + ": " + h + " hard / " + m + " med left";
    });
    el.planPools.textContent = poolBits.join(" · ");

    // Today card
    el.todayCard.innerHTML = "";
    var todayRow = null;
    days.forEach(function (r) { if (r.today) todayRow = r; });
    if (!todayRow) {
      var msg = document.createElement("div");
      msg.className = "today-row";
      var txt = document.createElement("span");
      txt.style.flex = "1";
      txt.textContent = parseDay(dateKey(new Date())) < parseDay(PLAN.start)
        ? "The plan starts tomorrow (Wed, Aug 12). Day 1 will light up here."
        : "The plan window (Aug 12 – Sep 11) has ended.";
      msg.appendChild(txt);
      if (!testRunDone() && parseDay(dateKey(new Date())) < parseDay(PLAN.start)) {
        var tbtn = document.createElement("button");
        tbtn.className = "btn btn-primary btn-sm";
        tbtn.textContent = "Test run (5 questions)";
        tbtn.title = "A quick dry run of the exact daily flow. This button disappears after you finish it.";
        tbtn.addEventListener("click", startTestRun);
        msg.appendChild(tbtn);
      }
      el.todayCard.appendChild(msg);
    } else {
      MODULE_ORDER.forEach(function (mod) {
        var t = todayRow.targets[mod] || { H: 0, M: 0 };
        var target = t.H + t.M;
        var done = Math.min(todayRow.done[mod].total, target || todayRow.done[mod].total);
        var rowEl = document.createElement("div");
        rowEl.className = "today-row";

        var name = document.createElement("span");
        name.className = "today-name";
        name.textContent = mod;
        var desc = document.createElement("span");
        desc.className = "today-desc";
        desc.textContent = t.H && t.M ? t.H + " hard + " + t.M + " medium" : t.H ? t.H + " hard" : t.M ? t.M + " medium" : "pool empty";

        var prog = document.createElement("span");
        prog.className = "today-prog";
        var bar = document.createElement("span");
        bar.className = "bar";
        var fill = document.createElement("span");
        fill.className = "bar-fill" + (target && done >= target ? " bar-done" : "");
        fill.style.width = target ? Math.min(100, Math.round((done / target) * 100)) + "%" : "0%";
        bar.appendChild(fill);
        var frac = document.createElement("span");
        frac.className = "frac";
        frac.textContent = done + "/" + target;
        prog.appendChild(bar);
        prog.appendChild(frac);

        var btn = document.createElement("button");
        btn.className = "btn btn-primary btn-sm";
        if (target && done >= target) {
          btn.textContent = "Done ✓";
          btn.disabled = true;
        } else {
          btn.textContent = done > 0 ? "Continue" : "Start";
          btn.addEventListener("click", function () { startPlanModule(mod); });
        }

        rowEl.appendChild(name);
        rowEl.appendChild(desc);
        rowEl.appendChild(prog);
        rowEl.appendChild(btn);
        el.todayCard.appendChild(rowEl);
      });
    }

    // Day list
    el.planDays.innerHTML = "";
    days.forEach(function (row, i) {
      var d = document.createElement("div");
      d.className = "plan-day" + (row.today ? " plan-today" : "") + (row.past ? " plan-past" : "");

      var num = document.createElement("span");
      num.className = "plan-day-num";
      num.textContent = i + 1;

      var date = document.createElement("span");
      date.className = "plan-day-date";
      date.textContent = row.date.toLocaleDateString(undefined, DAY_FMT);

      var detail = document.createElement("span");
      detail.className = "plan-day-detail";
      if (row.past || row.today) {
        var bits = MODULE_ORDER.map(function (mod) {
          var label = mod === "Math" ? "Math" : "R&W";
          return label + " " + row.done[mod].total + "/" + PLAN.quota[mod];
        });
        detail.textContent = bits.join(" · ");
      } else {
        var bits2 = MODULE_ORDER.map(function (mod) {
          var t = row.targets[mod];
          var label = mod === "Math" ? "Math" : "R&W";
          if (!t || (!t.H && !t.M)) return label + " —";
          var parts = [];
          if (t.H) parts.push(t.H + "H");
          if (t.M) parts.push(t.M + "M");
          return label + " " + parts.join("+");
        });
        detail.textContent = bits2.join(" · ");
      }

      var status = document.createElement("span");
      status.className = "plan-day-status";
      if (row.past || row.today) {
        if (dayMet(row)) { status.textContent = "✓"; status.classList.add("met"); }
        else if (!row.today) { status.textContent = "missed"; status.classList.add("missed"); }
      }

      d.appendChild(num);
      d.appendChild(date);
      d.appendChild(detail);
      d.appendChild(status);

      // Today's row gets the one-click start for the whole day's dose.
      if (row.today && !dayMet(row)) {
        var started = MODULE_ORDER.some(function (mod) { return row.done[mod].total > 0; });
        var dbtn = document.createElement("button");
        dbtn.className = "btn btn-primary btn-sm";
        dbtn.textContent = started ? "Continue" : "Start";
        dbtn.addEventListener("click", startPlanDay);
        d.appendChild(dbtn);
      }

      el.planDays.appendChild(d);
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
    var modStats = statsFor(moduleQs);
    el.practiceAllSub.textContent =
      "All " + skillCount + " skills · " + modStats.answered + "/" + modStats.total + " answered" +
      (modStats.accuracy !== null ? " · " + modStats.accuracy + "% accuracy" : "");

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

  /* ---------------- timer ---------------- */

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var mm = (m < 10 ? "0" : "") + m;
    var ss = (sec < 10 ? "0" : "") + sec;
    return h ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  function startTimer(offsetMs) {
    stopTimer();
    state.timer = { start: Date.now() - (offsetMs || 0), intervalId: null, ticks: 0 };
    el.timerEl.textContent = fmtTime(offsetMs || 0);
    state.timer.intervalId = setInterval(function () {
      if (!state.timer) return;
      el.timerEl.textContent = fmtTime(Date.now() - state.timer.start);
      // Persist elapsed time every few seconds so a resume is accurate.
      if (++state.timer.ticks % 5 === 0) saveSession();
    }, 1000);
  }

  function stopTimer() {
    if (state.timer && state.timer.intervalId) clearInterval(state.timer.intervalId);
    state.timer = null;
  }

  /* ---------------- session persistence ---------------- */

  function saveSession() {
    try {
      if (state.view !== "practice" || !state.set.length) {
        localStorage.removeItem("sat-session");
        return;
      }
      localStorage.setItem("sat-session", JSON.stringify({
        setIds: state.set.map(function (q) { return q.id; }),
        label: state.setLabel,
        index: state.index,
        elapsed: state.timer ? Date.now() - state.timer.start : 0,
        timerHidden: state.timerHidden,
        elimMode: state.elimMode,
        checked: state.checked,
        selectedLetter: state.selectedLetter,
        sprValue: el.sprInput.value || "",
      }));
    } catch (e) {}
  }

  function saveMarks() {
    try { localStorage.setItem("sat-marks", JSON.stringify(state.marked)); } catch (e) {}
  }
  function saveStruck() {
    try { localStorage.setItem("sat-struck", JSON.stringify(state.struck)); } catch (e) {}
  }

  function loadPersisted(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; }
  }

  // Rebuild an interrupted practice session from its snapshot, if possible.
  function restoreSession() {
    var snap = loadPersisted("sat-session", null);
    if (!snap || !snap.setIds || !snap.setIds.length) return false;
    var byId = {};
    state.all.forEach(function (q) { byId[q.id] = q; });
    var set = snap.setIds.map(function (id) { return byId[id]; }).filter(Boolean);
    if (!set.length) return false;
    state.set = set;
    state.setLabel = snap.label || "Practice";
    state.index = Math.min(Math.max(0, snap.index || 0), set.length - 1);
    state.elimMode = !!snap.elimMode;
    state.timerHidden = !!snap.timerHidden;
    el.timerEl.classList.toggle("hidden", state.timerHidden);
    el.timerToggle.textContent = state.timerHidden ? "Show" : "Hide";
    state.pendingRestore = {
      checked: !!snap.checked,
      selectedLetter: snap.selectedLetter || null,
      sprValue: snap.sprValue || "",
    };
    state.view = "practice";
    startTimer(snap.elapsed || 0);
    return true;
  }

  // Reapply the in-question state (selection / checked) after a resume.
  function applyPendingRestore() {
    var pr = state.pendingRestore;
    if (!pr) return;
    state.pendingRestore = null;
    var q = currentQ();
    if (!q) return;
    if (q.type === "mcq" && pr.selectedLetter) selectOption(pr.selectedLetter);
    if (q.type === "spr" && pr.sprValue) el.sprInput.value = pr.sprValue;
    if (pr.checked) checkAnswer();
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
    startTimer(0);
    render();
  }

  function exitPractice() {
    stopTimer();
    closeNavigator();
    if (state.setLabel === "Test run") {
      try { localStorage.setItem(TESTRUN_KEY, "1"); } catch (e) {} // button disappears for good
    }
    state.view = "plan"; // home base is the plan
    saveSession(); // clears the snapshot
    render();
  }

  function currentQ() { return state.set[state.index]; }

  function renderOptions(q) {
    el.options.innerHTML = "";
    var struck = state.struck[q.id] || {};
    q.options.forEach(function (opt) {
      var row = document.createElement("div");
      row.className = "option-row" + (state.elimMode ? " elim-on" : "");

      var btn = document.createElement("button");
      btn.className = "option";
      btn.dataset.letter = opt.letter;
      if (struck[opt.letter]) btn.classList.add("struck");
      if (state.selectedLetter === opt.letter) btn.classList.add("selected");
      var letter = document.createElement("span");
      letter.className = "opt-letter";
      letter.textContent = opt.letter;
      var body = document.createElement("span");
      body.className = "opt-body";
      body.innerHTML = L.sanitizeHtml(opt.html);
      btn.appendChild(letter);
      btn.appendChild(body);
      btn.addEventListener("click", function () { selectOption(opt.letter); });
      row.appendChild(btn);

      var elim = document.createElement("button");
      elim.className = "elim-btn";
      elim.title = struck[opt.letter] ? "Undo cross out" : "Cross out choice " + opt.letter;
      elim.innerHTML = struck[opt.letter] ? "Undo" : "<span class='elim-letter'>" + opt.letter + "</span>";
      elim.addEventListener("click", function () {
        if (state.checked) return;
        var s = state.struck[q.id] = state.struck[q.id] || {};
        s[opt.letter] = !s[opt.letter];
        if (s[opt.letter] && state.selectedLetter === opt.letter) state.selectedLetter = null;
        saveStruck();
        saveSession();
        renderOptions(q);
      });
      row.appendChild(elim);

      el.options.appendChild(row);
    });
  }

  function selectOption(letterWanted) {
    if (state.checked) return;
    var q = currentQ();
    if (!q || q.type !== "mcq") return;
    var struck = state.struck[q.id] || {};
    if (struck[letterWanted]) { struck[letterWanted] = false; saveStruck(); } // selecting un-strikes
    state.selectedLetter = letterWanted;
    saveSession();
    renderOptions(q);
  }

  function renderQuestion() {
    var q = currentQ();
    state.selectedLetter = null;
    state.checked = false;

    el.setLabel.textContent = state.setLabel;
    el.qNum.textContent = state.index + 1;
    el.bbPos.textContent = state.index + 1;
    el.bbTotal.textContent = state.set.length;
    el.bbSkill.textContent = q.skill;
    el.difficulty.textContent = L.difficultyLabel(q.difficulty);
    el.markBtn.classList.toggle("active", !!state.marked[q.id]);
    el.elimBtn.classList.toggle("active", state.elimMode);

    var hasStimulus = !!(q.stimulus && q.stimulus.trim());
    el.qArea.classList.toggle("single", !hasStimulus);
    if (hasStimulus) {
      el.stimulus.innerHTML = L.sanitizeHtml(q.stimulus);
    } else {
      el.stimulus.innerHTML = "";
    }

    el.stem.innerHTML = L.sanitizeHtml(q.stem);

    el.result.classList.add("hidden");
    el.rationaleWrap.classList.add("hidden");
    el.resultBanner.className = "result-banner";
    el.check.disabled = false;
    el.check.textContent = "Check Answer";

    if (q.type === "mcq") {
      el.spr.classList.add("hidden");
      el.options.classList.remove("hidden");
      renderOptions(q);
    } else {
      el.options.classList.add("hidden");
      el.options.innerHTML = "";
      el.spr.classList.remove("hidden");
      el.sprInput.value = "";
      el.sprInput.disabled = false;
    }

    el.prev.disabled = state.index === 0;
    el.next.disabled = state.index >= state.set.length - 1;
    renderNavigator();
    window.scrollTo({ top: 0 });
    saveSession();
  }

  /* ---------------- question navigator ---------------- */

  function renderNavigator() {
    if (el.navPopup.classList.contains("hidden")) return;
    el.navPopupTitle.textContent = state.setLabel;
    el.navGrid.innerHTML = "";
    state.set.forEach(function (q, i) {
      var b = document.createElement("button");
      b.className = "nav-cell";
      b.textContent = i + 1;
      if (state.progress[q.id]) b.classList.add("answered");
      if (state.marked[q.id]) b.classList.add("marked");
      if (i === state.index) b.classList.add("current");
      b.addEventListener("click", function () {
        state.index = i;
        renderQuestion();
      });
      el.navGrid.appendChild(b);
    });
  }

  function openNavigator() {
    el.navPopup.classList.remove("hidden");
    renderNavigator();
  }
  function closeNavigator() {
    el.navPopup.classList.add("hidden");
  }
  function toggleNavigator() {
    if (el.navPopup.classList.contains("hidden")) openNavigator();
    else closeNavigator();
  }

  function checkAnswer() {
    if (state.checked || !state.set.length) return;
    var q = state.set[state.index];
    var verdict;

    if (q.type === "mcq") {
      if (!state.selectedLetter) return;
      verdict = L.gradeMcq(state.selectedLetter, q.correct);
      Array.prototype.forEach.call(el.options.querySelectorAll(".option"), function (c) {
        var letter = c.dataset.letter;
        c.disabled = true;
        c.classList.remove("struck");
        if (q.correct && q.correct.indexOf(letter) !== -1) {
          c.classList.add("reveal-correct");
        } else if (letter === state.selectedLetter && verdict === false) {
          c.classList.add("reveal-wrong");
        }
      });
      Array.prototype.forEach.call(el.options.querySelectorAll(".elim-btn"), function (b) {
        b.disabled = true;
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

    // Record the attempt (latest attempt wins) and today's tally.
    recordDaily(q);
    var rec = { id: q.id, correct: verdict, ts: Date.now() };
    state.progress[q.id] = rec;
    dbPutAll(P_STORE, [rec]).catch(function (e) {
      console.error("Failed to save progress:", e);
    });
    renderNavigator();
    saveSession();
    el.next.focus();
  }

  function go(delta) {
    var ni = state.index + delta;
    if (ni < 0 || ni >= state.set.length) return;
    state.index = ni;
    renderQuestion();
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
      el.topbar.classList.remove("hidden");
      el.emptyState.classList.remove("hidden");
      el.topicsView.classList.add("hidden");
      el.practiceView.classList.add("hidden");
      return;
    }
    el.emptyState.classList.add("hidden");
    if (state.view === "practice") {
      el.topbar.classList.add("hidden"); // full-screen test feel, like Bluebook
      el.topicsView.classList.add("hidden");
      el.planView.classList.add("hidden");
      el.practiceView.classList.remove("hidden");
      renderQuestion();
    } else if (state.view === "plan") {
      el.topbar.classList.remove("hidden");
      el.practiceView.classList.add("hidden");
      el.topicsView.classList.add("hidden");
      el.planView.classList.remove("hidden");
      renderPlan();
    } else {
      el.topbar.classList.remove("hidden");
      el.practiceView.classList.add("hidden");
      el.planView.classList.add("hidden");
      el.topicsView.classList.remove("hidden");
      renderTopics();
    }
  }

  /* ---------------- saved UI prefs ---------------- */

  function savePrefs() {
    try {
      localStorage.setItem("sat-ui", JSON.stringify({
        module: state.module,
        difficulties: state.difficulties,
        statusFilter: state.statusFilter,
      }));
    } catch (e) {}
  }

  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem("sat-ui") || "null");
      if (!p) return;
      if (p.module) state.module = p.module;
      if (p.difficulties) {
        state.difficulties = p.difficulties;
        Array.prototype.forEach.call(document.querySelectorAll("#diff-chips .chip"), function (chip) {
          chip.classList.toggle("active", !!state.difficulties[chip.dataset.diff]);
        });
      }
      if (p.statusFilter) {
        state.statusFilter = p.statusFilter;
        el.statusFilter.value = p.statusFilter;
      }
    } catch (e) {}
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
    if (e.key === "Enter") {
      if (!state.checked) checkAnswer();
      else go(1);
    }
  });
  el.prev.addEventListener("click", function () { go(-1); });
  el.next.addEventListener("click", function () { go(1); });
  $("btn-back").addEventListener("click", exitPractice);

  el.markBtn.addEventListener("click", function () {
    var q = currentQ();
    if (!q) return;
    if (state.marked[q.id]) delete state.marked[q.id];
    else state.marked[q.id] = true;
    el.markBtn.classList.toggle("active", !!state.marked[q.id]);
    saveMarks();
    renderNavigator();
  });

  el.elimBtn.addEventListener("click", function () {
    state.elimMode = !state.elimMode;
    el.elimBtn.classList.toggle("active", state.elimMode);
    saveSession();
    var q = currentQ();
    if (q && q.type === "mcq" && !state.checked) renderOptions(q);
  });

  el.navBtn.addEventListener("click", toggleNavigator);
  $("btn-nav-close").addEventListener("click", closeNavigator);
  document.addEventListener("click", function (e) {
    if (el.navPopup.classList.contains("hidden")) return;
    if (el.navPopup.contains(e.target) || el.navBtn.contains(e.target)) return;
    closeNavigator();
  });

  el.timerToggle.addEventListener("click", function () {
    state.timerHidden = !state.timerHidden;
    el.timerEl.classList.toggle("hidden", state.timerHidden);
    el.timerToggle.textContent = state.timerHidden ? "Show" : "Hide";
    saveSession();
  });

  el.sprInput.addEventListener("input", function () { saveSession(); });

  window.addEventListener("beforeunload", function () { saveSession(); });

  document.addEventListener("keydown", function (e) {
    if (state.view !== "practice") return;
    if (!el.modal.classList.contains("hidden")) return;
    if (e.key === "Escape") { closeNavigator(); return; }
    if (e.target === el.sprInput || e.target === el.pasteInput) return;
    if (e.key === "ArrowLeft") { go(-1); return; }
    if (e.key === "ArrowRight") { go(1); return; }
    if (e.key === "Enter") {
      e.preventDefault(); // avoid double-firing via native button activation
      if (state.checked) go(1);
      else checkAnswer();
      return;
    }
    if (e.key === "m" || e.key === "M") { el.markBtn.click(); return; }
    var q = currentQ();
    if (q && q.type === "mcq" && !state.checked && /^[a-jA-J]$/.test(e.key)) {
      var letter = e.key.toUpperCase();
      if (q.options.some(function (o) { return o.letter === letter; })) selectOption(letter);
    }
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
      savePrefs();
      render();
    });
  });

  el.statusFilter.addEventListener("change", function () {
    state.statusFilter = el.statusFilter.value;
    savePrefs();
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
      state.marked = {};
      state.struck = {};
      state.module = null;
      state.view = "topics";
      try {
        localStorage.removeItem("sat-session");
        localStorage.removeItem("sat-marks");
        localStorage.removeItem("sat-struck");
        localStorage.removeItem("sat-preload-stamp");
      } catch (e) {}
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
    loadPrefs();
    if (modulesPresent().indexOf(state.module) === -1) state.module = modulesPresent()[0] || null;
    state.marked = loadPersisted("sat-marks", {});
    state.struck = loadPersisted("sat-struck", {});
    state.daily = loadPersisted("sat-daily", {});
    if (!restoreSession()) state.view = "plan"; // land on the plan unless resuming practice
    render();
    applyPendingRestore();
  }).catch(function (e) {
    el.emptyState.classList.remove("hidden");
    console.error("Failed to open IndexedDB:", e);
  });
})();
