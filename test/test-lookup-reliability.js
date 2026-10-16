#!/usr/bin/env node
/**
 * test/test-lookup-reliability.js — a lookup that was refused is not a lookup that found nothing.
 *
 * The defect this suite exists for, measured on the real volume 01 run before it was fixed: three of
 * that volume's Wikipedia lookups were rejected with HTTP 429 (`芥川龍之介` in both languages,
 * `読書スペース` in English), and the research pass filed
 *
 *     No reference page matched "芥川龍之介" in the languages searched. The lookup returned nothing to read.
 *
 * as a `research_notes` row, which `renderGlossary` merged into the term's Notes cell of the published
 * `glossary.md`. A rate limit had become a published claim about what the reference has to say — and the
 * next volume inherits it. `researchTerms` could not tell the two cases apart because it computed
 * `found = results.some(r => r.extract || r.title)`, and a rejected lookup and an empty answer both
 * produce no title and no extract.
 *
 * What is pinned here, in the order the dispatch named it:
 *
 *   1. **Three states, decided in the lookup layer.** `ok` / `no-results` / `failed`, the last one
 *      carrying the HTTP status.
 *   2. **A bounded, polite retry.** At most 2 retries, exponential backoff, `Retry-After` honoured and
 *      capped, retried on 429 and 5xx, NOT retried on any other 4xx.
 *   3. **A run-level circuit breaker, half-open.** Five consecutive gave-up requests stop the layer
 *      querying, out loud. A success resets the count. While it is open a request that arrives before
 *      `LOOKUP_CIRCUIT_PROBE_AFTER_MS` has elapsed is refused with no request and no wait; the first one
 *      that arrives after it is sent as a **probe** — one request, no retries, and a lookup the stage was
 *      already going to make. A probe that reaches the reference closes the circuit and prints how long
 *      it was open and how many terms the open window cost; a probe that fails re-arms the window, and
 *      `LOOKUP_CIRCUIT_MAX_PROBES` failed probes give up for the rest of the run. **The cooldown is
 *      measured, never slept through.**
 *   4. **`maxlag=5` on both Wikipedia calls** — the politeness parameter the API documents.
 *   5. **The honesty fix.** A term whose every lookup failed files **nothing**, is named in the log as
 *      unanswered, costs no model call, and **is looked up again on the next pass**. A genuine
 *      "nothing there" still files its note. A partial failure is visible in the log.
 *   6. **The published glossary prints no failure as an answer**, and the two cases stay distinguishable
 *      in the log and in the record.
 *   7. **No knob.** The retry bound, the backoff cap, the breaker, the probe window and the probe budget
 *      are constants; a process that tries to raise them in the environment gets the same numbers. The
 *      clock the cooldown is measured against is a **test seam** no stage and no environment variable
 *      reaches, and that is asserted too.
 *
 * Zero model calls and zero requests to Wikipedia: every lookup is answered by a local stub HTTP server,
 * and every fixture names its own series folder (AGENTS.md rule 8, gotcha 69, gotcha 143). The lookup
 * layer stays sequential — that is the behaviour a public API asks for, and the endpoint on this machine
 * answers one request at a time (AGENTS.md §7).
 *
 * Run with `npm test`, or standalone: `node test/test-lookup-reliability.js`.
 *
 * @module test/test-lookup-reliability
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const harness = require("../harness");
const research = require("../research");
const glossaryStore = require("../glossary/store");
const { researchVolumeTerms, lookupCoverageLines, lookupLogLines } = require("../glossary/research");
const { RESEARCH_MAX_TERMS_PER_VOLUME } = require("../glossary/researchable");
const { researchNotesInRecord } = require("../utils/reference-store");
const { assertInsideFixture, FIXTURES_ROOT } = require("./fixture-reference-store");

// Pin the pre-existing research settings so a local `.env` cannot change what these scenarios measure,
// and so no scenario can reach the network through the optional general-search backends.
process.env.WIKI_LANGS = "ja,en";
process.env.SEARCH_API = "";
process.env.SEARCH_API_KEY = "";
process.env.RESEARCH_DELAY_MS = "0"; // the politeness sleep is not what these scenarios are testing
process.env.RESEARCH_ENABLED = "true";

let checks = 0;

/**
 * Count one assertion and run it.
 * @param {boolean|void} condition
 * @param {string} message
 * @returns {void}
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}

/**
 * Count one deep-equality assertion and run it.
 * @param {*} a
 * @param {*} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── The stub reference ───────────────────────────────────────────────────────

/**
 * Stand a local HTTP server where Wikipedia stands.
 *
 * `research/wiki.js` builds `https://<lang>.wikipedia.org/w/api.php?...` URLs. The shim below rewrites only
 * those hosts to the stub, preserving the path and the query, and records what each request asked for —
 * which is what lets a scenario assert `maxlag=5` and count attempts instead of trusting a comment.
 * Nothing else about the request path changes: the real `fetchWithTimeout` (in `research/circuit.js`), the
 * real status handling, the real retry loop and the real breaker all run, and the patch lands on the
 * global `fetch` the moved module calls — which is the proof the split did not break the stub.
 *
 * @param {Function} responder - `(record, n) => { status, headers, body }` for the n-th request.
 * @returns {Promise<{requests: Array<Object>, stop: Function}>} The recorded requests and the shutdown.
 */
async function startStub(responder) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const record = {
      n: requests.length + 1,
      lang: req.headers["x-wiki-lang"] || "",
      action: u.searchParams.get("action"),
      list: u.searchParams.get("list"),
      prop: u.searchParams.get("prop"),
      srsearch: u.searchParams.get("srsearch"),
      titles: u.searchParams.get("titles"),
      maxlag: u.searchParams.get("maxlag"),
    };
    requests.push(record);
    const reply = responder(record, record.n) || { status: 200, body: {} };
    res.writeHead(reply.status ?? 200, {
      "Content-Type": "application/json",
      ...(reply.headers || {}),
    });
    res.end(reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => {
    const target = new URL(String(url));
    if (!/(^|\.)wikipedia\.org$/.test(target.hostname)) return realFetch(url, options);
    const headers = { ...(options.headers || {}), "x-wiki-lang": target.hostname.split(".")[0] };
    return realFetch(`${base}${target.pathname}${target.search}`, { ...options, headers });
  };
  return {
    requests,
    /** Close the stub and put the real `fetch` back. @returns {Promise<void>} */
    stop: async () => {
      globalThis.fetch = realFetch;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * The JSON a Wikipedia search response carries for a title, and its extract.
 * @param {string} title
 * @returns {Object}
 */
function searchBody(title) {
  return { query: { search: [{ title }] } };
}

/** The JSON a Wikipedia extract response carries. @returns {Object} */
function extractBody(text) {
  return { query: { pages: { 1: { extract: text } } } };
}

/** The JSON a search response carries when the reference answered and had nothing. @returns {Object} */
const EMPTY_SEARCH = { query: { search: [] } };

// ─── Scenario 1 — the three states ────────────────────────────────────────────

/**
 * A lookup says which of three things happened, and the term-level rule agrees with it.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheThreeStates() {
  const stub = await startStub((record) => {
    if (record.list === "search") {
      if (record.srsearch === "rejected") return { status: 429, headers: { "Retry-After": "0" }, body: { error: { code: 429 } } };
      if (record.srsearch === "empty") return { status: 200, body: EMPTY_SEARCH };
      return { status: 200, body: searchBody(record.srsearch) };
    }
    return { status: 200, body: extractBody(`${record.titles} is a real thing.`) };
  });
  try {
    const notes = await research.researchTerms([
      { term: "answered" },
      { term: "empty" },
      { term: "rejected" },
    ]);
    const byTerm = Object.fromEntries(notes.map((note) => [note.term, note]));

    ok(byTerm.answered.status === research.LOOKUP_OK, `a lookup with a page is "${byTerm.answered.status}"`);
    ok(byTerm.answered.found === true, "a lookup with a page is not `found`");
    same(byTerm.answered.failedLanguages, [], "an answered lookup reported a failed language");

    ok(byTerm.empty.status === research.LOOKUP_NO_RESULTS, `a lookup the reference answered with nothing is "${byTerm.empty.status}"`);
    ok(byTerm.empty.found === false, "a lookup with no page is `found`");
    same(byTerm.empty.noResultLanguages, ["ja", "en"], "the languages that answered with nothing are not named");
    same(byTerm.empty.failedLanguages, [], "a reference that answered is reported as failed");

    ok(byTerm.rejected.status === research.LOOKUP_FAILED, `a lookup the reference rejected is "${byTerm.rejected.status}"`);
    ok(byTerm.rejected.found === false, "a rejected lookup is `found`");
    same(byTerm.rejected.noResultLanguages, [], "a rejected lookup is reported as \"no results\" — the exact lie this pass exists to stop");
    same(byTerm.rejected.answeredLanguages, [], "a rejected lookup is reported as answered");
    same(byTerm.rejected.failedLanguages.map((f) => f.lang), ["ja", "en"], "the rejected languages are not named");
    same(byTerm.rejected.failedLanguages.map((f) => f.httpStatus), [429, 429], "the HTTP status did not travel with the failure");

    // A term the lookup never read is described differently from one it read and found nothing.
    const rejectedText = research.formatResearchNotes([byTerm.rejected]);
    const emptyText = research.formatResearchNotes([byTerm.empty]);
    ok(rejectedText.includes("could not be reached"), "the prompt block does not say the reference was unreachable");
    ok(!rejectedText.includes("nothing for this term"), "an unreachable reference is described as \"it had nothing\"");
    ok(emptyText.includes("the reference answered and had nothing"), "a genuine empty answer is not described as one");
    ok(rejectedText !== emptyText, "a failed lookup and an empty lookup format identically");

    console.log("lookup 1 / 11: ok / no-results / failed are three different answers, and the HTTP status rides along");
  } finally {
    research.resetLookupCircuit();
    await stub.stop();
  }
}

// ─── Scenario 2 — the retry ───────────────────────────────────────────────────

/**
 * A rejected request is asked again, a wrong request is not, and the bound is the bound.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheRetry() {
  const seen = new Map();
  const stub = await startStub((record) => {
    if (record.list !== "search") return { status: 200, body: extractBody("an extract") };
    const key = `${record.srsearch}|${record.lang}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (record.srsearch === "flaky-429") return n === 1 ? { status: 429, headers: { "Retry-After": "0" }, body: {} } : { status: 200, body: searchBody(record.srsearch) };
    if (record.srsearch === "flaky-503") return n === 1 ? { status: 503, headers: { "Retry-After": "0" }, body: {} } : { status: 200, body: searchBody(record.srsearch) };
    if (record.srsearch === "bad-request") return { status: 400, body: { error: { info: "bad srsearch" } } };
    if (record.srsearch === "gone") return { status: 404, body: {} };
    // A 200 whose body is not JSON: the old code's per-language try/catch covered it; the new one has
    // to report it as `failed` rather than let it escape `researchWiki`.
    if (record.srsearch === "not-json") return { status: 200, raw: "<html>rate limited</html>" };
    return { status: 500, headers: { "Retry-After": "0" }, body: {} };
  });
  try {
    /**
     * One case, one term, its own circuit: a case must not inherit the previous case's failures, which
     * is what `resetLookupCircuit` is for.
     * @param {string} term
     * @returns {Promise<{note: Object, searches: Array<Object>}>}
     */
    async function attemptCase(term) {
      research.resetLookupCircuit();
      const from = stub.requests.length;
      const [note] = await research.researchTerms([{ term }]);
      return { note, searches: stub.requests.slice(from).filter((r) => r.list === "search") };
    }

    const flaky429 = await attemptCase("flaky-429");
    ok(flaky429.note.status === research.LOOKUP_OK, `a 429 that answered on the second try is "${flaky429.note.status}"`);
    same(flaky429.searches.filter((r) => r.lang === "ja").length, 2, "a 429 was not retried");
    same(flaky429.note.failedLanguages, [], "a lookup that recovered reports a failed language");

    const flaky503 = await attemptCase("flaky-503");
    ok(flaky503.note.status === research.LOOKUP_OK, `a 503 that answered on the second try is "${flaky503.note.status}"`);
    same(flaky503.searches.filter((r) => r.lang === "ja").length, 2, "a 5xx was not retried");

    const bad = await attemptCase("bad-request");
    same(bad.searches.length, 2, `a 400 was re-sent (${bad.searches.length} searches for 2 languages) — re-sending an identical wrong request is not politeness, it is pressure`);
    ok(bad.note.status === research.LOOKUP_FAILED, `a 400 is "${bad.note.status}"`);
    same(bad.note.failedLanguages.map((f) => f.attempts), [1, 1], "a 400 was retried");

    const gone = await attemptCase("gone");
    same(gone.searches.length, 2, "a 404 was re-sent");

    const never = await attemptCase("always-500");
    same(never.searches.length, 2 * (1 + research.LOOKUP_MAX_RETRIES), `a request that never answered cost ${never.searches.length} search(es); the bound is ${1 + research.LOOKUP_MAX_RETRIES} per language`);
    ok(never.note.status === research.LOOKUP_FAILED, "a request that never answered is not failed");
    same(never.note.failedLanguages.map((f) => f.attempts), [3, 3], "the attempt count did not travel with the failure");
    same(never.note.failedLanguages.map((f) => f.httpStatus), [500, 500], "the 5xx status did not travel with the failure");

    const notJson = await attemptCase("not-json");
    ok(notJson.note.status === research.LOOKUP_FAILED, `a 200 with an unreadable body is "${notJson.note.status}" — it must not become "nothing there"`);
    same(notJson.note.noResultLanguages, [], 'an unreadable body is reported as "the reference had nothing"');
    ok(/not JSON/.test(notJson.note.results[0].error || ""), `the failure does not say what it was: ${notJson.note.results[0].error}`);

    console.log(`lookup 2 / 11: retried 429 and 5xx (${1 + research.LOOKUP_MAX_RETRIES} requests at most), never a 400 or a 404, and an unreadable 200 is a failure not an empty answer`);
  } finally {
    research.resetLookupCircuit();
    await stub.stop();
  }
}

// ─── Scenario 3 — Retry-After and the backoff ─────────────────────────────────

/**
 * The server's `Retry-After` is honoured, capped, and the fallback is exponential.
 *
 * @returns {Promise<void>}
 */
async function scenarioRetryAfter() {
  same(research.parseRetryAfterMs("1"), 1000, "a delta-seconds Retry-After is not read as seconds");
  same(research.parseRetryAfterMs("0"), 0, "Retry-After: 0 is not read as \"no header\"");
  same(research.parseRetryAfterMs(null), null, "a missing Retry-After is not read as a wait");
  same(research.parseRetryAfterMs(""), null, "an empty Retry-After is not read as a wait");
  same(research.parseRetryAfterMs("not a date"), null, "an unusable Retry-After is not read as a wait");
  same(research.parseRetryAfterMs("3600"), research.LOOKUP_RETRY_AFTER_MAX_MS, `Retry-After: 3600 is not clamped to ${research.LOOKUP_RETRY_AFTER_MAX_MS} ms — a header must not be able to stall a run`);
  same(research.parseRetryAfterMs("999999"), research.LOOKUP_RETRY_AFTER_MAX_MS, "an absurd Retry-After is not clamped");
  const when = Date.now() + 2000;
  ok(research.parseRetryAfterMs(new Date(when).toUTCString()) >= 0, "an HTTP-date Retry-After is not read");
  ok(research.parseRetryAfterMs(new Date(Date.now() - 60000).toUTCString()) === 0, "an HTTP-date in the past is not a negative wait");

  same(research.retryDelayMs(1), research.LOOKUP_BACKOFF_BASE_MS, "the first backoff is not the base");
  same(research.retryDelayMs(2), research.LOOKUP_BACKOFF_BASE_MS * 2, "the second backoff is not double the first");
  same(research.retryDelayMs(9), research.LOOKUP_RETRY_AFTER_MAX_MS, "the backoff is not capped");
  same(research.retryDelayMs(1, "4"), 4000, "the server's Retry-After does not win over the backoff");
  same(research.retryDelayMs(1, "600"), research.LOOKUP_RETRY_AFTER_MAX_MS, "the cap does not apply to a server-supplied wait");

  // And on the wire: a 429 that says "1 second" actually sits for a second, and says so.
  const stub = await startStub((record) => {
    if (record.list === "search") {
      return record.n === 1
        ? { status: 429, headers: { "Retry-After": "1" }, body: {} }
        : { status: 200, body: searchBody(record.srsearch) };
    }
    return { status: 200, body: extractBody("an extract") };
  });
  try {
    const captured = await captureConsole(() => research.researchTerms([{ term: "rate-limited" }]));
    const note = captured.result[0];
    ok(note.status === research.LOOKUP_OK, `a 429 with a Retry-After did not recover: ${note.status}`);
    const waited = captured.warnings.find((line) => line.includes("retrying in"));
    ok(!!waited, "the retry was not said out loud");
    ok(/retrying in 1000 ms/.test(waited || ""), `the retry did not wait the second the server asked for: ${waited}`);
    ok(/honouring the server's Retry-After/.test(waited || ""), `the retry does not say it honoured the header: ${waited}`);
    console.log("lookup 3 / 11: Retry-After is honoured on the wire, capped at 30 s, and the fallback doubles from 1 s");
  } finally {
    research.resetLookupCircuit();
    await stub.stop();
  }
}

// ─── Scenario 4 — the circuit breaker ─────────────────────────────────────────

/**
 * Five gave-up requests in a row stop the layer querying, out loud, for the rest of the run.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheCircuitBreaker() {
  research.resetLookupCircuit();
  const stub = await startStub((record) => {
    if (record.list === "search") {
      if (String(record.srsearch).startsWith("rejected")) return { status: 429, headers: { "Retry-After": "0" }, body: {} };
      return { status: 200, body: searchBody(record.srsearch) };
    }
    return { status: 200, body: extractBody("an extract") };
  });
  try {
    // An answered lookup leaves nothing counted, so the count means "in a row".
    await research.researchTerms([{ term: "answered-1" }]);
    same(research.circuitState().failures, 0, "a lookup that answered left a failure counted");
    ok(!research.circuitState().open, "the circuit opened on answered lookups");

    const captured = await captureConsole(() =>
      research.researchTerms([{ term: "rejected-1" }, { term: "rejected-2" }, { term: "rejected-3" }, { term: "rejected-4" }])
    );
    const open = research.circuitState();
    ok(open.open, `the circuit did not open after ${research.LOOKUP_CIRCUIT_OPEN_AFTER} consecutive failed request(s)`);
    ok(open.openedAfter >= research.LOOKUP_CIRCUIT_OPEN_AFTER, `the circuit opened after ${open.openedAfter} failures, below the bound`);
    const trip = captured.errors.concat(captured.warnings).find((line) => line.includes("Lookup circuit OPEN"));
    ok(!!trip, "the circuit opened silently — a run that stops asking must say it stopped");
    ok(/no further lookups/i.test(trip || ""), `the trip does not say what it stops: ${trip}`);

    const before = stub.requests.length;
    const after = await research.researchTerms([{ term: "after-the-trip-1" }, { term: "after-the-trip-2" }]);
    same(stub.requests.length, before, `the circuit is open and the layer sent ${stub.requests.length - before} further request(s)`);
    ok(after.every((note) => note.status === research.LOOKUP_FAILED), "a term behind an open circuit is not reported as failed");
    ok(
      after.every((note) => note.results.every((r) => r.circuitOpen === true)),
      "a term behind an open circuit is not reported as \"the reference had nothing\""
    );
    ok(after.every((note) => note.status !== research.LOOKUP_NO_RESULTS), "an open circuit is reported as \"no results\" — the same lie, bigger");
    ok(after.every((note) => note.found === false), "a term behind an open circuit is reported as found");

    // The reset door is the only way back, and a fresh run starts clean.
    research.resetLookupCircuit();
    same(
      research.circuitState(),
      {
        failures: 0, open: false, gaveUp: false, openedAfter: 0, openedAt: null, openedAtMs: 0,
        probes: 0, probing: false, refusedRequests: 0, unansweredTerms: 0, lastError: null,
      },
      "resetLookupCircuit did not reset the circuit"
    );
    const recovered = await research.researchTerms([{ term: "answered-again" }]);
    ok(recovered[0].status === research.LOOKUP_OK, "the layer cannot query again after a reset");
    same(research.circuitState().failures, 0, "an answered lookup left a failure counted");

    console.log(`lookup 4 / 11: the circuit opens after ${research.LOOKUP_CIRCUIT_OPEN_AFTER} consecutive gave-up request(s), sends 0 more inside its window, and a success resets it`);
  } finally {
    research.resetLookupCircuit();
    await stub.stop();
  }
}

// ─── Scenario 5 — maxlag, and the primitives the agent tools use ──────────────

/**
 * Both Wikipedia calls carry the documented politeness parameter, and the shared primitives keep the
 * contract `ai/tools-wiki.js` (re-exported through `harness.js`) depends on.
 *
 * @returns {Promise<void>}
 */
async function scenarioMaxlagAndPrimitives() {
  const stub = await startStub((record) => {
    if (record.list === "search") {
      if (record.srsearch === "rejected-page") return { status: 429, headers: { "Retry-After": "0" }, body: {} };
      return { status: 200, body: searchBody(record.srsearch) };
    }
    if (record.titles === "rejected-page") return { status: 429, headers: { "Retry-After": "0" }, body: {} };
    return { status: 200, body: extractBody("the intro") };
  });
  try {
    research.resetLookupCircuit();
    const hits = await research.wikiSearch("ja", "黒板");
    same(hits.map((h) => h.title), ["黒板"], "wikiSearch no longer returns the search hits");
    const text = await research.wikiExtract("ja", "黒板");
    ok(text === "the intro", `wikiExtract no longer returns the extract (got "${text}")`);

    let thrown = null;
    try {
      await research.wikiSearch("ja", "rejected-page");
    } catch (err) {
      thrown = err;
    }
    ok(thrown instanceof Error, "a rejected search did not throw — the agent tool's error path is gone");
    ok(/status 429/.test(thrown.message), `the thrown error does not name the status: ${thrown && thrown.message}`);
    same(thrown.attempts, 1 + research.LOOKUP_MAX_RETRIES, "the thrown error does not carry the attempt count");
    same(thrown.httpStatus, 429, "the thrown error does not carry the HTTP status");

    let extractThrew = null;
    try {
      await research.wikiExtract("ja", "rejected-page");
    } catch (err) {
      extractThrew = err;
    }
    ok(extractThrew instanceof Error, "a rejected extract did not throw");

    // Every request the layer sent carried maxlag, on both actions.
    const searches = stub.requests.filter((r) => r.list === "search");
    const extracts = stub.requests.filter((r) => r.prop === "extracts");
    ok(searches.length > 0 && extracts.length > 0, "the stub saw no search or no extract request");
    ok(searches.every((r) => r.maxlag === String(research.WIKI_MAXLAG)), `a search went without maxlag: ${JSON.stringify(searches.map((r) => r.maxlag))}`);
    ok(extracts.every((r) => r.maxlag === String(research.WIKI_MAXLAG)), `an extract went without maxlag: ${JSON.stringify(extracts.map((r) => r.maxlag))}`);

    // The tool set the harness hands an agent still builds, and still reports a failure to the model.
    const tools = harness.createWikiTools();
    ok(tools.wiki_search && tools.wiki_extract, "createWikiTools no longer returns the two tools");
    const searchOut = await tools.wiki_search.execute({ query: "rejected-page" });
    ok(/search error/.test(searchOut), `the wiki_search tool does not report the failure to the model: ${searchOut}`);
    const extractOut = await tools.wiki_extract.execute({ title: "rejected-page", lang: "ja" });
    ok(/extract error/.test(extractOut), `the wiki_extract tool does not report the failure to the model: ${extractOut}`);

    console.log(`lookup 5 / 11: maxlag=${research.WIKI_MAXLAG} on both calls; wikiSearch / wikiExtract / createWikiTools keep their contract and gain the retry underneath`);
  } finally {
    research.resetLookupCircuit();
    await stub.stop();
  }
}

// ─── The fixture the filing scenarios run on ──────────────────────────────────

/** Where these fixtures live. Each scenario passes its own label so they cannot collide. */
// The root comes from the fixture helper, which honours AI_CLIENT_TEST_FIXTURES_ROOT: the runner
// gives every suite a root of its own, so a label reused by another suite cannot delete this one's
// fixture mid-run. Unset (a person running this suite by hand) means the same shared default as ever.
// FIXTURES_ROOT is destructured from the require above.

/** The one fixture volume. */
const FX_VOLUME = { folder: "Lookup Story(01)", installmentNumber: "01", base: "lookup_story(1)" };

/** Its source, chapter by chapter. Every term the fixture files occurs verbatim here. */
const SOURCE = {
  ch0: [
    "# 第一章",
    "黒板に文字を書いた。",
    "芥川龍之介の名前が黒板に書いてあった。",
    "駱駝の話が出た。",
    "橋を渡った。",
  ],
};

/**
 * The rows the fixture's read pass returns.
 *
 * Two are researchable (one picked by its section, one by the closed note shape the classifier knows);
 * one is not, because its own note says this series made it up.
 *
 * @type {Array<{term: string, rendering: string, note: string, type: string, section: string, query: string}>}
 */
const ROWS = [
  { term: "黒板", rendering: "the blackboard", note: "Real classroom fixture.", type: "concept", section: "Real-World References", query: "黒板" },
  { term: "芥川龍之介", rendering: "Akutagawa Ryunosuke", note: "Real author of Rashomon.", type: "concept", section: "Real-World References", query: "芥川龍之介" },
  { term: "駱駝", rendering: "the camel", note: "An in-series coinage for the club's plan.", type: "concept", section: "Terms & Concepts", query: "駱駝" },
];

/**
 * Lay out the one-volume fixture series.
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @returns {{dir: string, volumeDir: string}}
 */
function fixtureSeries(label) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.env.SERIES_LOCATION = dir;

  const volumeDir = path.join(dir, FX_VOLUME.folder);
  fs.mkdirSync(volumeDir, { recursive: true });
  const segments = Object.entries(SOURCE).map(([id, lines]) => {
    const file = `${FX_VOLUME.base}-${id}.md`;
    fs.writeFileSync(path.join(volumeDir, file), lines.join("\n") + "\n", "utf8");
    return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
  });
  fs.writeFileSync(path.join(volumeDir, `${FX_VOLUME.base}-bundle.meta.json`), JSON.stringify({ format: "epub", schema: 8, base: FX_VOLUME.base, wholeFile: `${FX_VOLUME.base}-whole.md`, segments }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(volumeDir, `${FX_VOLUME.base}-whole.md`), Object.values(SOURCE).flat().join("\n") + "\n", "utf8");

  fs.writeFileSync(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Lookup Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-lookup-reliability.js",
        generatedAt: new Date().toISOString(),
        discovery: { summary: "fixture", confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 }, evidence: ["one book"], excluded: [] },
        volumes: [
          {
            folder: FX_VOLUME.folder,
            sourceFile: `${FX_VOLUME.folder}/${FX_VOLUME.base}.epub`,
            installmentNumber: FX_VOLUME.installmentNumber,
            title: "Lookup Story",
            integrity: { isNarrative: true, confidence: 0.9, basis: "fixture" },
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return { dir, volumeDir };
}

/**
 * Open the fixture volume's record through the stage's own door and file its rows.
 * @param {string} label - Scenario name.
 * @returns {{ctx: Object, fx: {dir: string, volumeDir: string}}}
 */
function openFixture(label) {
  const fx = fixtureSeries(label);
  const ctx = {
    values: { INSTALLMENT_NUMBER: "01", SOURCE_NAME: "Lookup Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" },
    folderName: FX_VOLUME.folder,
    seriesDir: fx.dir,
    volumeDir: fx.volumeDir,
    isFirst: true,
    previousFolderName: null,
    previousGlossaryFile: null,
    bundle: { segments: [{ id: "ch0", file: `${FX_VOLUME.base}-ch0.md`, title: "第一章", chars: 60 }], wholeChars: 60, sourceFingerprint: "fixture" },
    glossaryOutputFile: path.join(fx.volumeDir, "glossary.md"),
    validationOutputFile: path.join(fx.volumeDir, "glossary-validation.md"),
    researchNotesFile: path.join(fx.volumeDir, "glossary-research.md"),
    refStore: null,
    researchTurnsLeft: RESEARCH_MAX_TERMS_PER_VOLUME,
    researchLog: null,
  };
  const attempt = glossaryStore.openGlossaryRecord(ctx, null);
  assert.ok(attempt.ok, `the fixture record refused to open: ${attempt.error}`);
  ctx.refStore = attempt.opened.store;
  assertInsideFixture(ctx.refStore.file, fx.dir);
  glossaryStore.fileGlossaryTermRows(ctx, ROWS);
  return { ctx, fx };
}

/**
 * A lookup that answers in a scripted way per term.
 *
 * @param {Object<string, "ok"|"no-results"|"failed"|"partial">} behaviour - What each term's lookup does.
 * @returns {{lookup: Function, asked: string[]}}
 */
function scriptedLookup(behaviour) {
  const asked = [];
  /**
   * @param {Array<{term: string, query?: string}>} terms
   * @returns {Promise<Array<Object>>}
   */
  async function lookup(terms) {
    asked.push(...terms.map((entry) => entry.term));
    return terms.map((entry) => {
      const how = behaviour[entry.term] || "ok";
      if (how === "failed") {
        return {
          term: entry.term,
          query: entry.term,
          found: false,
          status: research.LOOKUP_FAILED,
          results: ["ja", "en"].map((lang) => ({ lang, status: research.LOOKUP_FAILED, title: null, url: null, extract: null, httpStatus: 429, attempts: 3, error: `Wikipedia search (${lang}) failed with status 429 after 3 request(s)` })),
        };
      }
      if (how === "empty-ok") {
        // The lookup layer contradicting itself: it says a page was found and hands nothing to read.
        return {
          term: entry.term,
          query: entry.term,
          found: true,
          status: research.LOOKUP_OK,
          results: [{ lang: "ja", status: research.LOOKUP_OK, title: null, url: null, extract: null }],
        };
      }
      if (how === "no-results") {
        return {
          term: entry.term,
          query: entry.term,
          found: false,
          status: research.LOOKUP_NO_RESULTS,
          results: ["ja", "en"].map((lang) => ({ lang, status: research.LOOKUP_NO_RESULTS, title: null, url: null, extract: null, note: "no results" })),
        };
      }
      if (how === "partial") {
        return {
          term: entry.term,
          query: entry.term,
          found: true,
          status: research.LOOKUP_OK,
          results: [
            { lang: "ja", status: research.LOOKUP_OK, title: entry.term, url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(entry.term)}`, extract: `${entry.term} は実在する語である。` },
            { lang: "en", status: research.LOOKUP_FAILED, title: null, url: null, extract: null, httpStatus: 429, attempts: 3, error: "Wikipedia search (en) failed with status 429 after 3 request(s)" },
          ],
        };
      }
      return {
        term: entry.term,
        query: entry.term,
        found: true,
        status: research.LOOKUP_OK,
        results: [
          { lang: "ja", status: research.LOOKUP_OK, title: entry.term, url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(entry.term)}`, extract: `${entry.term} は実在する語である。` },
          { lang: "en", status: research.LOOKUP_OK, title: `${entry.term} (term)`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(entry.term)}`, extract: `${entry.term} is a real thing.` },
        ],
      };
    });
  }
  return { lookup, asked };
}

/**
 * Stand in for the model, count every call, and answer with the shape the research prompt asks for.
 * @param {{calls: string[]}} sink
 * @returns {Function}
 */
function fakeResearchModel(sink) {
  return async function runOneShot(request) {
    sink.calls.push(request.label);
    const term = String(request.messages[request.messages.length - 1].text.match(/^Term: (.+)$/m)?.[1] || "");
    return JSON.stringify({
      found: true,
      page: term,
      lang: "ja",
      url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(term)}`,
      note: `${term} is a real thing; the established English name is "${term}".`,
    });
  };
}

/**
 * Run one function with `harness.runOneShot` replaced, and restore it afterwards.
 * @param {Function} replacement
 * @param {Function} body
 * @returns {Promise<*>}
 */
async function withStubbedModel(replacement, body) {
  const original = harness.runOneShot;
  harness.runOneShot = replacement;
  try {
    return await body();
  } finally {
    harness.runOneShot = original;
  }
}

/**
 * Capture what a pass printed, so "it says so out loud" is an assertion and not a hope.
 * @param {Function} body
 * @returns {Promise<{result: *, logs: string[], warnings: string[], errors: string[]}>}
 */
async function captureConsole(body) {
  const logs = [];
  const warnings = [];
  const errors = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => warnings.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const result = await body();
    return { result, logs, warnings, errors };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

/**
 * The published glossary cell a fixture row was rendered into.
 * @param {Object} ctx
 * @param {string} term
 * @returns {string} The line, or "" when the term is not printed.
 */
function glossaryCell(ctx, term) {
  const file = fs.readFileSync(ctx.glossaryOutputFile, "utf8");
  return file.split("\n").find((line) => line.startsWith(`| ${term} |`)) || "";
}

// ─── Scenario 6 — the honesty fix ─────────────────────────────────────────────

/**
 * A term whose every lookup was rejected files nothing, costs no model call, is named as unanswered,
 * and is looked up again on the next pass. A genuine "nothing there" still files its note.
 *
 * @returns {Promise<void>}
 */
async function scenarioAFailedLookupFilesNothing() {
  const { ctx } = openFixture("lookup-6");

  // Pass 1: 芥川龍之介 is rejected in both languages, exactly the volume-01 shape.
  const wiki1 = scriptedLookup({ 黒板: "ok", 芥川龍之介: "failed" });
  const sink1 = { calls: [] };
  const pass1 = await withStubbedModel(fakeResearchModel(sink1), () =>
    captureConsole(() => researchVolumeTerms(ctx, { lookup: wiki1.lookup }))
  );
  const result1 = pass1.result;
  const log1 = fs.readFileSync(ctx.researchNotesFile, "utf8");

  same(result1.unanswered, 1, `${result1.unanswered} term(s) reported as unanswered; 芥川龍之介 was rejected in both languages`);
  same(result1.filed, 1, `the pass filed ${result1.filed} note(s); only the term the reference answered may be filed`);
  same(result1.notFound, 0, "a rejected lookup was counted as \"nothing matched\" — the lie this scenario exists to stop");
  same(sink1.calls.length, 1, `${sink1.calls.length} model call(s) were spent; a term nobody managed to ask costs none`);
  ok(!sink1.calls.some((label) => label.includes("芥川")), "a model call was spent on a term whose lookup never reached the reference");
  ok(result1.asked === 2, `the lookup was asked for ${result1.asked} term(s); both researchable rows still get looked up`);

  const notes1 = researchNotesInRecord(ctx.refStore, { volume: 1 });
  same(notes1.map((note) => note.term).sort(), ["黒板"], `the record holds notes for ${notes1.map((n) => n.term).join(", ")} — a rejected lookup must file nothing`);
  ok(!notes1.some((note) => note.note.includes("No reference page matched")), "the \"no reference page matched\" note was filed for a term the reference refused to answer");

  ok(log1.includes("## Could not ask (1)"), `the log has no "Could not ask" section: ${log1.slice(0, 400)}`);
  ok(log1.includes("- 芥川龍之介 (Real-World References)"), "the log does not name the term it could not ask");
  ok(log1.includes("COULD NOT ASK"), "the log does not say the lookup could not reach the reference");
  ok(log1.includes("status 429"), "the log does not carry the HTTP status that rejected the lookup");
  ok(log1.includes("asked again on the next pass"), "the log does not say the term is asked again");
  ok(!/No reference page matched "芥川龍之介"/.test(log1), "the log still prints the lie for 芥川龍之介");
  ok(log1.includes("Could not ask: 1"), "the log header does not count what it could not ask");
  ok(pass1.warnings.some((line) => line.includes("could not be asked")), "the pass did not warn about the term it could not ask");

  // The published file says nothing about the term it could not ask — and nothing false about it either.
  const rendered1 = await glossaryStore.renderGlossaryArtifact(ctx);
  ok(rendered1.ok, `the fixture refused to render: ${rendered1.refusal && rendered1.refusal.because}`);
  const cell1 = glossaryCell(ctx, "芥川龍之介");
  ok(cell1 !== "", "the term vanished from the published glossary — an unanswered term is still a row");
  ok(!cell1.includes("Research ("), `the published cell claims a research answer the lookup never produced: ${cell1}`);
  ok(!cell1.includes("No reference page matched"), `the published glossary prints the lie: ${cell1}`);
  ok(glossaryCell(ctx, "黒板").includes("Research (v1):"), "the term the reference DID answer lost its note");

  // Pass 2: the same volume, the reference now reachable. The unanswered term is looked up again.
  // A fresh pass starts with a fresh log and a fresh budget, which is what a new process does.
  ctx.researchLog = null;
  ctx.researchTurnsLeft = RESEARCH_MAX_TERMS_PER_VOLUME;
  const wiki2 = scriptedLookup({ 黒板: "ok", 芥川龍之介: "ok" });
  const sink2 = { calls: [] };
  const pass2 = await withStubbedModel(fakeResearchModel(sink2), () => researchVolumeTerms(ctx, { lookup: wiki2.lookup }));
  ok(wiki2.asked.includes("芥川龍之介"), "a term left unanswered was NOT looked up on the next pass — filing nothing is the whole point only if it is asked again");
  same(pass2.unanswered, 0, `the second pass still reports ${pass2.unanswered} unanswered term(s)`);
  const notes2 = researchNotesInRecord(ctx.refStore, { volume: 1 });
  same(notes2.map((note) => note.term).sort(), ["芥川龍之介", "黒板"], "the second pass did not file the note the first pass could not");
  const log2 = fs.readFileSync(ctx.researchNotesFile, "utf8");
  ok(log2.includes("## Could not ask (0)"), "the second pass's log still counts the term it has now asked");
  ok(log2.includes("every lookup this volume attempted reached the reference"), "the second pass's log does not say the reference was reachable");

  console.log("lookup 6 / 11: a rejected lookup files nothing and is asked again next pass; a genuine \"nothing there\" still files its note");
}

// ─── Scenario 7 — a genuine empty answer, and a partial one ───────────────────

/**
 * The two cases the defect collapsed into one stay apart: the reference answered with nothing (a fact,
 * filed), and the reference answered in one language and was rejected in the other (filed, but named as
 * resting on half the reference).
 *
 * @returns {Promise<void>}
 */
async function scenarioEmptyAndPartialStayApart() {
  const { ctx } = openFixture("lookup-7");
  // A third researchable row, for the case the lookup layer contradicts itself.
  glossaryStore.fileGlossaryTermRows(ctx, [
    { term: "橋", rendering: "the bridge", note: "Real crossing outside the school.", type: "concept", section: "Real-World References", query: "橋" },
  ]);
  const wiki = scriptedLookup({ 黒板: "no-results", 芥川龍之介: "partial", 橋: "empty-ok" });
  const sink = { calls: [] };
  const pass = await withStubbedModel(fakeResearchModel(sink), () => researchVolumeTerms(ctx, { lookup: wiki.lookup }));
  const log = fs.readFileSync(ctx.researchNotesFile, "utf8");

  same(pass.unanswered, 0, "a term one language answered is reported as unanswered");
  same(pass.notFound, 2, `${pass.notFound} term(s) reported as "nothing matched"; 黒板 and 橋 are the two with nothing to read`);
  same(sink.calls.length, 1, `${sink.calls.length} model call(s); a term with nothing to read costs none, even when the lookup claims a page`);

  const notes = researchNotesInRecord(ctx.refStore, { volume: 1 });
  const empty = notes.find((note) => note.term === "黒板");
  ok(!!empty, "the genuine \"nothing there\" note was not filed — a true fact was thrown away");
  ok(empty.found === false, "the empty answer is filed as a found answer");
  ok(empty.note.includes("No reference page matched"), `the empty answer's note changed shape: ${empty.note}`);
  const partial = notes.find((note) => note.term === "芥川龍之介");
  ok(!!partial && partial.found === true, "the partial answer was not filed from the half the reference gave");
  const contradicted = notes.find((note) => note.term === "橋");
  ok(!!contradicted && contradicted.found === false, "a lookup that handed nothing to read was filed as a found answer");

  ok(log.includes("- lookup [ja]: no page matched"), "the log does not say the reference answered with nothing");
  ok(log.includes("reported a page and handed nothing to read"), "a lookup that claims a page and hands none is not named in the log");
  ok(!log.includes("| 橋 |") || !fs.readFileSync(ctx.glossaryOutputFile, "utf8").includes("橋 | the bridge | Real crossing outside the school.; Research (v1): undefined"), "a contradiction leaked into the published cell");
  ok(log.includes("- lookup [en]: COULD NOT ASK"), "the log does not name the language that was rejected");
  ok(log.includes("PARTIAL"), "a partial failure is reported as a clean answer");
  ok(log.includes("### 芥川龍之介 — Real-World References"), "the partial term is not in the log");
  ok(!log.includes("## Could not ask (1)"), "a partial failure is counted as a term nobody asked");

  // The coverage line is the same function the pass uses, run on the three states directly.
  same(lookupCoverageLines({ status: research.LOOKUP_OK, answeredLanguages: ["ja"], noResultLanguages: [], failedLanguages: [{ lang: "en", httpStatus: 429, attempts: 3 }] }).length, 1, "a partial failure produces no coverage line");
  same(lookupCoverageLines({ status: research.LOOKUP_OK, answeredLanguages: ["ja", "en"], noResultLanguages: [], failedLanguages: [] }), [], "a clean lookup produced a coverage line");
  const failedLines = lookupLogLines([
    { lang: "ja", status: research.LOOKUP_FAILED, title: null, url: null, extract: null, httpStatus: 503, attempts: 3, error: "Wikipedia search (ja) failed with status 503 after 3 request(s)" },
  ]);
  ok(failedLines.some((line) => line.includes("COULD NOT ASK") && line.includes("status 503")), `the lookup lines do not name the state: ${failedLines.join(" | ")}`);

  console.log("lookup 7 / 11: \"nothing there\" and \"could not ask\" and \"half the reference answered\" are three different published facts");
}

// ─── Scenario 9 — the half-open window ────────────────────────────────────────

/**
 * The breaker is half-open, not permanent: a refused lookup costs no request and no wait, the cooldown
 * is measured rather than slept through, and the lookup the run was already going to make goes out as
 * a probe once the window has elapsed. If it reaches the reference the circuit closes and says how long
 * it was open and how many terms it left unanswered.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheHalfOpenProbeClosesTheCircuit() {
  research.resetLookupCircuit();
  let rejecting = true;
  const stub = await startStub((record) => {
    if (record.list === "search") {
      if (rejecting) return { status: 429, headers: { "Retry-After": "0" }, body: {} };
      return { status: 200, body: searchBody(record.srsearch) };
    }
    return { status: 200, body: extractBody(`${record.titles} is a real thing.`) };
  });

  /** The clock the breaker measures against. **A test seam** — scenario 8 pins that nothing else can move it. */
  let fakeNow = 1_000_000;
  research.setLookupClockForTests(() => fakeNow);

  try {
    // Open it: three rejected terms is six gave-up requests, and the bound is five.
    await captureConsole(() =>
      research.researchTerms([{ term: "rejected-1" }, { term: "rejected-2" }, { term: "rejected-3" }])
    );
    const opened = research.circuitState();
    ok(opened.open && !opened.gaveUp, "the circuit did not open on five consecutive gave-up request(s)");
    same(opened.probes, 0, "opening the circuit spent a probe request");
    same(opened.refusedRequests, 1, `${opened.refusedRequests} request(s) were refused while opening the circuit; the fifth failure opened it mid-term`);
    same(opened.unansweredTerms, 1, `${opened.unansweredTerms} term(s) counted as left unanswered by the open circuit; only the term the circuit refused counts`);

    // Inside the window: refused, instantly, with no request on the wire.
    const before = stub.requests.length;
    const refusedFrom = Date.now();
    const refused = await research.researchTerms([{ term: "rejected-4" }, { term: "rejected-5" }]);
    const refusedIn = Date.now() - refusedFrom;
    same(stub.requests.length, before, `the circuit was open inside its window and the layer sent ${stub.requests.length - before} request(s)`);
    ok(refusedIn < 1000, `refusing two terms took ${refusedIn} ms — a refusal must be instant; a cooldown that waits turns a rate limit into a stall`);
    ok(refused.every((note) => note.status === research.LOOKUP_FAILED && note.found === false), "a term refused by the open circuit is not reported as failed");
    ok(refused.every((note) => note.results.every((r) => r.circuitOpen === true)), "a refused term does not say the refusal came from the circuit");
    same(research.circuitState().refusedRequests, 5, `${research.circuitState().refusedRequests} refused request(s) counted`);
    same(research.circuitState().unansweredTerms, 3, `${research.circuitState().unansweredTerms} term(s) counted as unanswered by the open circuit`);

    // One millisecond short of the window: still refused, still no request.
    fakeNow += research.LOOKUP_CIRCUIT_PROBE_AFTER_MS - 1;
    const near = stub.requests.length;
    await research.researchTerms([{ term: "rejected-6" }]);
    same(stub.requests.length, near, "a lookup arrived 1 ms before the window elapsed and was sent anyway");

    // The window elapses. Nothing waited for it: the clock moved, and the next lookup goes out as a probe.
    fakeNow += 1;
    rejecting = false; // the reference recovered, which is what a 20-second blip is
    const probeFrom = Date.now();
    const probeRun = await captureConsole(() => research.researchTerms([{ term: "after-the-window" }]));
    const probeIn = Date.now() - probeFrom;
    ok(probeIn < 10_000, `the lookup that crossed the window took ${probeIn} ms — the layer must compare elapsed time, never sleep through the cooldown`);

    const sent = stub.requests.filter((r) => r.list === "search" && r.srsearch === "after-the-window");
    same(sent.length, 2, `the term behind the window cost ${sent.length} search request(s); one per language, once the probe closed the circuit`);
    same(sent.filter((r) => r.lang === "ja").length, 1, "the probe was retried — a probe is one request, no retries");
    ok(probeRun.warnings.some((line) => line.includes("half-open") && /probe 1 of/.test(line)), "the probe was not said out loud");
    const closed = probeRun.logs.find((line) => line.includes("Lookup circuit CLOSED"));
    ok(!!closed, "the circuit closed silently — a run that lost notes has to say it lost them");
    ok(closed.includes(`${research.LOOKUP_CIRCUIT_PROBE_AFTER_MS} ms`), `the close does not say how long the circuit was open: ${closed}`);
    ok(closed.includes("7 lookup request(s) were refused"), `the close does not count the refused requests: ${closed}`);
    ok(closed.includes("4 term(s) went unanswered"), `the close does not count the terms the window cost: ${closed}`);
    ok(probeRun.warnings.some((line) => line.includes("No request was waited for")), "the probe does not say it was not waited for");

    const afterClose = research.circuitState();
    ok(!afterClose.open && !afterClose.gaveUp, "the circuit is still open after a probe reached the reference");
    same(afterClose.failures, 0, "a probe that reached the reference left failures counted");
    same(afterClose.probes, 0, "the probe budget did not reset with the circuit");
    same(afterClose.unansweredTerms, 0, "the unanswered count carried into the closed circuit");

    // And later lookups behave normally again: the full retry budget is back.
    rejecting = true;
    const from = stub.requests.length;
    await research.researchTerms([{ term: "closed-again" }]);
    const jaSearches = stub.requests.slice(from).filter((r) => r.list === "search" && r.lang === "ja").length;
    same(jaSearches, 1 + research.LOOKUP_MAX_RETRIES, `a lookup after the close cost ${jaSearches} request(s); the retry budget is ${1 + research.LOOKUP_MAX_RETRIES}`);
    ok(!research.circuitState().open, "the circuit reopened on fewer than five consecutive failures");

    console.log(`lookup 9 / 11: a refusal costs 0 requests and 0 ms, the window is measured not slept, and probe 1 of ${research.LOOKUP_CIRCUIT_MAX_PROBES} closing the circuit prints what the open window cost`);
  } finally {
    research.resetLookupClockForTests();
    research.resetLookupCircuit();
    await stub.stop();
  }
}

// ─── Scenario 10 — the probes run out ─────────────────────────────────────────

/**
 * A failed probe leaves the circuit open and re-arms the window; `LOOKUP_CIRCUIT_MAX_PROBES` failed
 * probes end the breaker's patience for the rest of the run, so an unreachable reference cannot cost one
 * request per minute. Every number in this scenario is read off the constant, so re-pinning the budget
 * re-pins the scenario — which is the point: a scenario that hard-coded three would silently keep
 * asserting three after the bound moved.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheProbesRunOut() {
  research.resetLookupCircuit();
  const stub = await startStub((record) => {
    if (record.list === "search") return { status: 429, headers: { "Retry-After": "0" }, body: {} };
    return { status: 200, body: extractBody("an extract") };
  });
  let fakeNow = 2_000_000;
  research.setLookupClockForTests(() => fakeNow);

  try {
    await research.researchTerms([{ term: "rejected-1" }, { term: "rejected-2" }, { term: "rejected-3" }]);
    const openedAt = research.circuitState().openedAtMs;
    ok(research.circuitState().open, "the circuit did not open, so this scenario proves nothing");

    for (let probe = 1; probe <= research.LOOKUP_CIRCUIT_MAX_PROBES; probe++) {
      fakeNow = openedAt + probe * research.LOOKUP_CIRCUIT_PROBE_AFTER_MS;
      const from = stub.requests.length;
      const captured = await captureConsole(() => research.researchTerms([{ term: `probe-${probe}` }]));
      const searches = stub.requests.slice(from).filter((r) => r.list === "search");
      same(searches.length, 1, `probe ${probe} cost ${searches.length} search request(s) — a probe is one request, no retries`);
      ok(captured.warnings.some((line) => line.includes(`probe ${probe} of ${research.LOOKUP_CIRCUIT_MAX_PROBES}`)), `probe ${probe} was not said out loud`);
      const state = research.circuitState();
      same(state.probes, probe, `probe ${probe} was not counted`);
      if (probe < research.LOOKUP_CIRCUIT_MAX_PROBES) {
        ok(state.open && !state.gaveUp, `the circuit closed on a failed probe (probe ${probe})`);
        ok(captured.warnings.some((line) => line.includes("was rejected") && line.includes("the window starts again")), `the failed probe does not say the window starts again: ${captured.warnings.join(" | ")}`);
        // The rest of the same term's lookups are refused again, immediately: the window was re-armed.
        same(state.openedAtMs, fakeNow, `a failed probe did not re-arm the window (openedAtMs ${state.openedAtMs}, now ${fakeNow})`);
        const afterProbe = stub.requests.length;
        await research.researchTerms([{ term: `after-failed-probe-${probe}` }]);
        same(stub.requests.length, afterProbe, "the layer kept sending requests after a probe failed");
      }
    }

    const given = research.circuitState();
    ok(given.open, "the circuit closed when the probes ran out — an unreachable reference is not reachable");
    ok(given.gaveUp, "the breaker did not say it has given up for the rest of the run");
    same(given.probes, research.LOOKUP_CIRCUIT_MAX_PROBES, `${given.probes} probe(s) were paid for; the bound is ${research.LOOKUP_CIRCUIT_MAX_PROBES}`);

    // Half an hour later: still open, and still not one more request.
    fakeNow += 30 * 60_000;
    const held = stub.requests.length;
    const heldFrom = Date.now();
    const still = await research.researchTerms([{ term: "half-an-hour-later-1" }, { term: "half-an-hour-later-2" }]);
    const heldIn = Date.now() - heldFrom;
    same(stub.requests.length, held, `the probes ran out and the layer sent ${stub.requests.length - held} further request(s)`);
    ok(heldIn < 1000, `refusing after the probes ran out took ${heldIn} ms`);
    ok(still.every((note) => note.status === research.LOOKUP_FAILED && note.results.every((r) => r.circuitOpen === true)), "a term behind a given-up circuit is not reported as refused by the circuit");

    const totalProbes = stub.requests.filter((r) => String(r.srsearch).startsWith("probe-")).length;
    same(totalProbes, research.LOOKUP_CIRCUIT_MAX_PROBES, `the run paid for ${totalProbes} probe request(s); the bound is ${research.LOOKUP_CIRCUIT_MAX_PROBES}`);

    console.log(`lookup 10 / 11: a failed probe re-arms the window, ${research.LOOKUP_CIRCUIT_MAX_PROBES} failed probes give up out loud, and 30 minutes later the layer still sends 0 requests`);
  } finally {
    research.resetLookupClockForTests();
    research.resetLookupCircuit();
    await stub.stop();
  }
}

// ─── Scenario 11 — the stage side of the open window ──────────────────────────

/**
 * The account owner's reason for the half-open window, end to end through the stage's own door: a
 * blip during volume 1 used to cost this volume every research note it would have written. The terms
 * the open window refused are still filed as nothing, still named under "Could not ask", still cost no
 * model call, and are still looked up again on the next pass — where the probe reaches the reference
 * and all three notes get written.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheOpenWindowCostsNotesAndTheProbeGetsThemBack() {
  const { ctx } = openFixture("lookup-11");
  // A third researchable row, so this volume's own lookups are enough to trip the breaker.
  glossaryStore.fileGlossaryTermRows(ctx, [
    { term: "橋", rendering: "the bridge", note: "Real crossing outside the school.", type: "concept", section: "Real-World References", query: "橋" },
  ]);

  research.resetLookupCircuit();
  let rejecting = true;
  const stub = await startStub((record) => {
    if (record.list === "search") {
      if (rejecting) return { status: 429, headers: { "Retry-After": "0" }, body: {} };
      return { status: 200, body: searchBody(record.srsearch) };
    }
    return { status: 200, body: extractBody(`${record.titles} is a real thing.`) };
  });
  let fakeNow = 3_000_000;
  research.setLookupClockForTests(() => fakeNow);

  try {
    // Pass 1: the reference is refusing, and the breaker shuts for this volume's whole research pass.
    const sink1 = { calls: [] };
    const pass1 = await withStubbedModel(fakeResearchModel(sink1), () =>
      captureConsole(() => researchVolumeTerms(ctx))
    );
    const result1 = pass1.result;
    const log1 = fs.readFileSync(ctx.researchNotesFile, "utf8");

    ok(research.circuitState().open, "the circuit did not open on this volume's lookups");
    same(result1.asked, 3, `${result1.asked} term(s) were put through the lookup`);
    same(result1.unanswered, 3, `${result1.unanswered} term(s) reported unanswered; every lookup was refused or rejected`);
    same(result1.filed, 0, `${result1.filed} note(s) filed; a term the reference never answered may not be filed`);
    same(result1.notFound, 0, "a refused lookup was counted as \"nothing matched\"");
    same(sink1.calls.length, 0, `${sink1.calls.length} model call(s) spent; a term nobody managed to ask costs none`);
    same(researchNotesInRecord(ctx.refStore, { volume: 1 }), [], "the record holds research notes for terms the reference never answered");

    ok(log1.includes("## Could not ask (3)"), `the log has no "Could not ask (3)" section: ${log1.slice(0, 400)}`);
    for (const term of ["黒板", "芥川龍之介", "橋"]) {
      ok(log1.includes(`- ${term} (Real-World References)`), `the log does not name ${term} as a term it could not ask`);
      ok(!/No reference page matched "[^"]*"/.test(log1), `the log still prints "nothing matched" for a term the reference never answered: ${term}`);
    }
    ok(log1.includes("asked again on the next pass"), "the log does not say the terms are asked again");

    // Pass 2: the blip has cleared, the window has elapsed, and the pass asks the same three terms.
    ctx.researchLog = null;
    ctx.researchTurnsLeft = RESEARCH_MAX_TERMS_PER_VOLUME;
    rejecting = false;
    fakeNow += research.LOOKUP_CIRCUIT_PROBE_AFTER_MS;
    const sink2 = { calls: [] };
    const pass2 = await withStubbedModel(fakeResearchModel(sink2), () =>
      captureConsole(() => researchVolumeTerms(ctx))
    );
    const log2 = fs.readFileSync(ctx.researchNotesFile, "utf8");

    ok(!research.circuitState().open, "the probe did not close the circuit, so the volume is still shut out");
    same(pass2.result.unanswered, 0, `${pass2.result.unanswered} term(s) still unanswered after the reference recovered`);
    same(pass2.result.filed, 3, `the second pass filed ${pass2.result.filed} note(s); the probe was supposed to get all three back`);
    const notes = researchNotesInRecord(ctx.refStore, { volume: 1 });
    same(notes.map((note) => note.term).sort(), ["橋", "芥川龍之介", "黒板"].sort(), "the notes the open window cost were not written on the next pass");
    ok(log2.includes("## Could not ask (0)"), "the second pass's log still counts the terms it has now asked");
    ok(log2.includes("every lookup this volume attempted reached the reference"), "the second pass's log does not say the reference was reachable");
    ok(pass2.logs.some((line) => line.includes("Lookup circuit CLOSED")), "the stage's own pass did not print that the circuit closed");

    console.log("lookup 11 / 11: an open window files nothing and names every term it cost; the next pass asks them and the probe gets the notes back");
  } finally {
    research.resetLookupClockForTests();
    research.resetLookupCircuit();
    await stub.stop();
  }
}

// ─── Scenario 8 — no knob ─────────────────────────────────────────────────────

/**
 * The reliability bounds are constants. A process that tries to raise them in the environment gets the
 * same numbers, nothing in the lookup layer reads them out of `process.env`, and the clock seam the
 * cooldown is tested through is a seam no stage can reach.
 *
 * @returns {void}
 */
function scenarioTheBoundsHaveNoKnob() {
  const names = ["LOOKUP_MAX_RETRIES", "LOOKUP_BACKOFF_BASE_MS", "LOOKUP_RETRY_AFTER_MAX_MS", "LOOKUP_CIRCUIT_OPEN_AFTER", "LOOKUP_CIRCUIT_PROBE_AFTER_MS", "LOOKUP_CIRCUIT_MAX_PROBES", "WIKI_MAXLAG", "RESEARCH_MAX_RETRIES", "RESEARCH_RETRY_AFTER_MAX_MS", "RESEARCH_CIRCUIT", "RESEARCH_CIRCUIT_OPEN_AFTER", "RESEARCH_CIRCUIT_PROBE_AFTER_MS", "RESEARCH_CIRCUIT_MAX_PROBES", "LOOKUP_CLOCK", "RESEARCH_LOOKUP_CLOCK", "LOOKUP_CIRCUIT_CLOCK_MS", "WIKI_MAXLAG"];
  const env = Object.fromEntries(names.map((name) => [name, "999"]));
  const script =
    "const r = require('./research');" +
    "console.log(JSON.stringify([r.LOOKUP_MAX_RETRIES, r.LOOKUP_BACKOFF_BASE_MS, r.LOOKUP_RETRY_AFTER_MAX_MS, r.LOOKUP_CIRCUIT_OPEN_AFTER, r.LOOKUP_CIRCUIT_PROBE_AFTER_MS, r.LOOKUP_CIRCUIT_MAX_PROBES, r.WIKI_MAXLAG]));";
  const run = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
  const values = JSON.parse(String(run.stdout).trim());
  same(values, [2, 1000, 30000, 5, 60000, 10, 5], `a process that set ${names.join(" / ")}=999 got ${JSON.stringify(values)}`);

  const layer = require("./module-layer").readModuleLayer(ROOT, "research.js");
  for (const name of ["LOOKUP_MAX_RETRIES", "LOOKUP_BACKOFF_BASE_MS", "LOOKUP_RETRY_AFTER_MAX_MS", "LOOKUP_CIRCUIT_OPEN_AFTER", "LOOKUP_CIRCUIT_PROBE_AFTER_MS", "LOOKUP_CIRCUIT_MAX_PROBES", "WIKI_MAXLAG"]) {
    const declaration = layer.match(new RegExp(`const ${name} = (\\d+);`));
    ok(!!declaration, `${name} is not a literal constant in research.js's layer`);
    ok(!new RegExp(`process\\.env\\.${name}`).test(layer), `${name} is read out of the environment`);
  }
  ok(!/process\.env\.RESEARCH_MAX_RETRIES|process\.env\.RESEARCH_CIRCUIT/.test(layer), "the lookup layer grew a retry or circuit knob");
  ok(!/process\.env\.[A-Z0-9_]*(CLOCK|PROBE)[A-Z0-9_]*/.test(layer), "the cooldown grew a clock or probe knob in the environment");
  same(research.LOOKUP_MAX_RETRIES, 2, "the retry bound moved");
  same(research.LOOKUP_CIRCUIT_OPEN_AFTER, 5, "the circuit bound moved");
  same(research.LOOKUP_CIRCUIT_PROBE_AFTER_MS, 60000, "the probe window moved");
  same(research.LOOKUP_CIRCUIT_MAX_PROBES, 10, "the probe budget moved");
  same(research.LOOKUP_RETRY_AFTER_MAX_MS, 30000, "the Retry-After cap moved");
  same(research.WIKI_MAXLAG, 5, "maxlag moved");

  // **The clock is a test seam, not a door.** No **stage** may name it: a stage that could move the
  // clock could make the cooldown elapse whenever it liked, which is a guard the guarded party controls
  // (AGENTS.md §4.3, gotcha 70). `research.js` is now a face over `research/`, so the seam is *defined*
  // inside the module's own layer and re-exported by the face; the layer is therefore skipped by the
  // walk, and the two assertions below are what keep that skip from becoming a blind spot — the seam is
  // defined exactly once in the layer, and nothing inside the layer calls it.
  const skip = new Set(["node_modules", ".git", "plan", "test", ".dry-run", ".run", "epub_source"]);
  const seamCallers = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".js")) {
        const rel = path.relative(ROOT, abs);
        if (rel === "research.js" || rel.startsWith(`research${path.sep}`)) continue;
        if (/setLookupClockForTests|resetLookupClockForTests/.test(fs.readFileSync(abs, "utf8"))) seamCallers.push(rel);
      }
    }
  })(ROOT);
  same(seamCallers, [], `the lookup clock seam is reached from ${seamCallers.join(", ")} — it exists for the offline suites and for nothing else`);

  for (const name of ["setLookupClockForTests", "resetLookupClockForTests"]) {
    // `setLookupClockForTests` is a substring of `resetLookupClockForTests`, so the bare name would
    // count the reset as a call of the setter. The lookbehind is the whole trick; without it this check
    // reports a call that does not exist (gotcha 67: a check that fires on a coincidence is not a check).
    const callPattern = new RegExp(`(?<!re)${name}\\s*\\(`, "g");
    const defined = (layer.match(new RegExp(`function ${name}\\s*\\(`, "g")) || []).length;
    const called = (layer.match(callPattern) || []).length - defined;
    same(defined, 1, `${name} is defined ${defined} time(s) across research.js's layer — the seam must have exactly one definition`);
    same(called, 0, `${name} is called from inside the lookup layer — the cooldown it installs must not be reachable from the code it gates`);
  }

  // And the seam refuses a value that would quietly disable the cooldown.
  let seamThrew = null;
  try {
    research.setLookupClockForTests(60000);
  } catch (err) {
    seamThrew = err;
  }
  ok(seamThrew instanceof Error, "the clock seam accepted a non-function — a seam that accepts anything can be handed a value that turns the cooldown off");
  ok(/test seam/.test(String(seamThrew && seamThrew.message)), `the seam does not say what it is: ${seamThrew && seamThrew.message}`);
  research.resetLookupClockForTests();

  console.log("lookup 8 / 11: the retry bound, the backoff cap, both circuit bounds and maxlag are constants, and the clock seam is reachable from no stage and from no environment variable");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

/**
 * Run every scenario.
 * @returns {Promise<void>}
 */
async function main() {
  await scenarioTheThreeStates();
  await scenarioTheRetry();
  await scenarioRetryAfter();
  await scenarioTheCircuitBreaker();
  await scenarioMaxlagAndPrimitives();
  await scenarioAFailedLookupFilesNothing();
  await scenarioEmptyAndPartialStayApart();
  await scenarioTheHalfOpenProbeClosesTheCircuit();
  await scenarioTheProbesRunOut();
  await scenarioTheOpenWindowCostsNotesAndTheProbeGetsThemBack();
  scenarioTheBoundsHaveNoKnob();
  console.log(`\ntest-lookup-reliability: ${checks} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
