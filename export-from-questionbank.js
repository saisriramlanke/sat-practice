/*
 * export-from-questionbank.js
 *
 * Grabs SAT questions as JSON from the official College Board Question Bank,
 * in exactly the format sat-practice imports. Run it in your own browser,
 * on the official site, using the same API the site itself uses.
 *
 * HOW TO USE
 *  1. Go to https://satsuitequestionbank.collegeboard.org and open any
 *     question search results page (so the site is fully loaded).
 *  2. Open DevTools (F12) -> Console tab.
 *  3. Paste this entire file into the console and press Enter.
 *     (If Chrome blocks pasting, type "allow pasting" first — that prompt
 *     exists to protect you from pasting untrusted code; read this file.)
 *  4. Type rw or math when prompted. Wait a few minutes (there are a few
 *     thousand questions; progress logs every 25).
 *  5. A .json file downloads automatically. Import it into sat-practice.
 *
 * WHY NOT THE PDF EXPORT: the PDF renders all equations as images, so the
 * question text can't be recovered from it. This gets the real data.
 */

(async () => {
  "use strict";

  const API = "https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank/digital";
  const TESTS = {
    rw:   { test: 1, domains: "INI,CAS,EOI,SEC", module: "en" },
    math: { test: 2, domains: "H,P,Q,S",         module: "math" },
  };

  const choice = (prompt("Which module? Type rw or math", "math") || "").trim().toLowerCase();
  const cfg = TESTS[choice];
  if (!cfg) { alert("Please type rw or math"); return; }

  const post = (url, body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });

  console.log("Fetching question list…");
  // asmtEventId 99 = SAT. The site sends the same request when you search.
  const list = await post(`${API}/get-questions`, {
    asmtEventId: 99,
    test: cfg.test,
    domain: cfg.domains,
  });
  console.log(list.length + " questions listed. Fetching each one (be patient)…");

  const out = [];
  let failed = 0;

  for (let i = 0; i < list.length; i++) {
    const meta = list[i];
    try {
      let content = null;
      if (meta.external_id) {
        // Modern ("manifold") item — same endpoint the site calls per question.
        content = await post(`${API}/get-question`, { external_id: meta.external_id });
      } else if (meta.ibn) {
        // Legacy item — served as a static JSON file.
        const arr = await fetch(
          `https://saic.collegeboard.org/disclosed/${meta.ibn}.json`
        ).then((r) => r.json());
        content = Array.isArray(arr) ? arr[0] : arr;
      }
      if (content) {
        out.push(Object.assign({}, meta, { module: cfg.module, content }));
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
      console.warn("Failed on", meta.questionId || meta.external_id || meta.ibn, e.message);
    }
    if ((i + 1) % 25 === 0) console.log(`${i + 1} / ${list.length}…`);
    // Be polite to the API.
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`Done: ${out.length} questions fetched, ${failed} failed.`);

  const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sat-${choice}-questions-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  console.log("Saved " + a.download + " — import it into sat-practice.");
})();
