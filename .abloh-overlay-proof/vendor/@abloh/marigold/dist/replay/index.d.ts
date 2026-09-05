/**
 * THE RECORDINGS FILE: what a customer commits so their networked tests can be measured, and the
 * rules that make one recording answer the same way every time it is asked.
 *
 * WHY IT EXISTS. Abloh's measurement is SEALED - `--network none`, `--cap-drop ALL`, no writable
 * path to the host - and that is not a setting, it is the product. A suite whose tests call a real
 * API therefore cannot run inside the seal at all: today those tests fail on DNS, the run reads them
 * as a broken suite, and the code they were the only cover for goes unmeasured. Kenneth ruled on
 * 2026-08-24 that the answer is neither to open the seal nor to give up on those tests, but to move
 * the network to where it legitimately already is - the customer's own machine and their own CI -
 * capture what the API said there, and serve that back inside the seal.
 *
 * WHAT A RECORDING IS, AND WHAT IT IS NOT. It is DATA the customer commits to their repository,
 * exactly like a fixture file. Loading one opens no channel: the sealed run reads bytes off a
 * read-only mount and answers requests from them. Nothing in the replay path can reach a socket, and
 * an unmatched request is an error rather than a fallback to the network - see `runtime.ts`, where
 * that is the whole of the replay branch.
 *
 * DETERMINISM IS THE POINT, not a nicety. A mutation run executes the same suite hundreds of times,
 * once per planted mutant, and every one of those runs must see the SAME response - otherwise a
 * mutant that "survived" may simply have been asked on a day the API answered differently, and the
 * catch rate stops describing the test suite at all. `docs/lessons/a-gate-measures-the-difference.md`
 * is the standing rule: convict on the difference the change made. A varying response is a second
 * difference nothing reported. So: one entry per match key, served identically every time, for the
 * whole run.
 *
 * THE FILE IS BYTE-DETERMINISTIC TOO. Entries sorted by key, header names lower-cased and sorted, no
 * timestamps anywhere. Re-recording against an unchanged API produces an identical file, which is
 * what makes `git diff` on a recordings file mean "the API changed" rather than "I ran it again".
 */
/** The on-disk format version. A file abloh does not recognise is refused, never guessed at. */
declare const RECORDINGS_VERSION = 1;
/** What is stored for the request half of an exchange. Headers are kept for the reader, not for matching. */
interface RecordedRequest {
    method: string;
    /** the scrubbed, normalized URL - see {@link normalizeUrl} */
    url: string;
    /** sha256 of the scrubbed request body; the empty body hashes like any other empty string */
    bodyHash: string;
    /** scrubbed request headers, lower-cased and sorted; never consulted when matching */
    headers: Record<string, string>;
}
/** What is served back. `bodyBase64` is present exactly when the body is not valid UTF-8 text. */
interface RecordedResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: string;
    bodyBase64?: string;
}
interface Recording {
    /** {@link matchKey} of the request. Entries are sorted by it, and it is unique within a file. */
    key: string;
    request: RecordedRequest;
    response: RecordedResponse;
}
interface RecordingsFile {
    version: number;
    /**
     * The scope the capture ran under, carried so a reader knows what the file is NOT expected to
     * hold. See {@link RecordingScope}.
     */
    scope: RecordingScope;
    recordings: Recording[];
}
/**
 * WHICH REQUESTS RECORD AND REPLAY COVER.
 *
 * `external` is the default and the one that matches what the seal actually excludes. A sealed
 * container's own loopback is REAL: a service the environment contract provisions starts inside the
 * run and answers on `127.0.0.1`, so recording it would freeze a live thing and replaying it would
 * serve a stale answer over a service that is right there. The public network is the part the seal
 * removes, so the public network is the part a recording restores.
 *
 * `all` includes loopback. It exists for the case where the "external" API a suite calls is reached
 * through a proxy or a stub bound locally, and it is what abloh's OWN fixtures use so an end-to-end
 * proof can stand up a server, record against it, stop it, and prove the replayed run never needed
 * it. Declaring it is a customer's statement that their loopback traffic is not a live service.
 */
declare const RECORDING_SCOPES: readonly ["external", "all"];
type RecordingScope = (typeof RECORDING_SCOPES)[number];
/** `localhost`, the loopback ranges, and nothing else. Everything else is "the public network". */
declare function isLoopbackHost(hostname: string): boolean;
/** Is this request inside the declared scope? Anything out of scope is left entirely alone. */
declare function inScope(url: string, scope: RecordingScope): boolean;
/**
 * THE NORMALIZATION, stated so a customer can predict what will and will not match.
 *
 * Ignored, because they vary between two identical requests and matching on them would mean no
 * request ever matched its own recording:
 *
 *   - EVERY HEADER. `Date`, `User-Agent`, `traceparent`, `Authorization`, a per-process request id -
 *     all of them differ run to run, and the credential-bearing ones are gone from the file
 *     entirely (`scrub.ts`). Headers are stored for a human to read and take no part in matching.
 *   - THE FRAGMENT. A `#hash` is never sent to a server, so it cannot identify what the server was
 *     asked.
 *   - THE DEFAULT PORT. `https://api.example.com:443/x` and `https://api.example.com/x` are one
 *     request written two ways.
 *   - QUERY ORDER. `?b=2&a=1` and `?a=1&b=2` are the same request; parameters are sorted by name and
 *     then by value. Order WITHIN a repeated name is preserved by sorting the values, which keeps
 *     `?id=1&id=2` distinct from `?id=1&id=3` while making both order-insensitive.
 *
 * Kept, because they are what the server was actually asked:
 *
 *   - the method, upper-cased;
 *   - the scheme and host, lower-cased (both are case-insensitive by RFC 3986);
 *   - the path, VERBATIM including case and percent-encoding, because a path is case-sensitive and a
 *     server may distinguish `%2F` from `/`;
 *   - the body, hashed.
 */
declare function normalizeUrl(rawUrl: string): string;
/**
 * HEADERS THAT ARE NOT STORED, for two separate reasons that happen to share a list.
 *
 * THE FIRST REASON IS DETERMINISM. `date`, `age`, `x-request-id`, `cf-ray` and their kin change on
 * every single call, so keeping them would mean re-recording an UNCHANGED API produced a diff -
 * which trains a reader to stop reading recording diffs, and a recording diff is the one place a
 * changed API becomes visible.
 *
 * THE SECOND REASON IS CORRECTNESS, and it is the one that would otherwise produce a broken replay.
 * The body captured on a record pass is the DECODED body: `undici` unzips a `content-encoding: gzip`
 * response before anything downstream sees it. Serving those decoded bytes back beside the original
 * `content-encoding: gzip` header tells the client to unzip plain JSON, which fails inside the HTTP
 * client rather than in the test. `content-length` is the same shape of mistake one step smaller,
 * and the hop-by-hop headers of RFC 7230 section 6.1 - `connection`, `keep-alive`,
 * `transfer-encoding`, `te`, `trailer`, `upgrade` - describe the connection that carried the
 * response and not the response, so replaying them describes a connection that no longer exists.
 *
 * The values are recomputed by whichever client receives the replayed response, which is what makes
 * dropping them safe rather than lossy.
 */
declare const UNSTORED_HEADERS: readonly string[];
/**
 * The identity of a request: method, normalized URL, and a hash of the SCRUBBED body.
 *
 * SCRUBBED, and that is load-bearing rather than incidental. A login request's body holds the
 * password; the file stores the redacted form, so the file's own key must be the redacted form's
 * key. Hashing the live body at replay time and the redacted body at record time would mean no
 * request that ever carried a secret could match its own recording - a bug that would only appear on
 * the authenticated calls, which are most of them.
 *
 * The body is HASHED rather than stored in the key so a multi-megabyte upload does not become a
 * multi-megabyte string; the body itself is not kept at all, because a recording answers a request
 * and never re-issues one.
 */
declare function matchKey(method: string, url: string, body: string): string;
/**
 * Build the entry a captured exchange becomes. Both halves are scrubbed here and nowhere else, so
 * there is one place to check that nothing reaches the file unscrubbed.
 */
declare function buildRecording(input: {
    method: string;
    url: string;
    requestBody: string;
    requestHeaders: Readonly<Record<string, string>>;
    status: number;
    statusText: string;
    responseHeaders: Readonly<Record<string, string>>;
    responseBody: Buffer;
}): Recording;
/**
 * Serialize a set of recordings, deterministically.
 *
 * Sorted by key, header maps sorted by name, two-space JSON with a trailing newline so the file is
 * an ordinary well-behaved text file in a repository. Nothing here records WHEN the capture ran: a
 * timestamp would make every re-record a diff, which would train a reader to stop reading them.
 */
declare function serializeRecordings(recordings: readonly Recording[], scope: RecordingScope): string;
/**
 * Read a recordings file into a lookup, refusing anything whose shape is not the one above.
 *
 * IT REFUSES RATHER THAN SKIPS. A recordings file with a version abloh does not know, or an entry
 * missing its response, would otherwise produce a run that quietly measured less than it appeared
 * to - the exact failure `docs/lessons/ready-is-a-claim.md` exists to prevent. A named refusal sends
 * the customer to `abloh run --record-network`, which rewrites the file in the current shape.
 */
declare function parseRecordings(text: string): Map<string, Recording>;
/**
 * The same parse, keeping the file's own SCOPE.
 *
 * THE SCOPE BELONGS TO THE FILE AND NOT TO THE INVOCATION, which is a defect this function exists to
 * close. A customer whose API is reached through a local proxy records with loopback in scope; a
 * later run that decided its own scope from its own flags would put loopback OUT of scope, serve
 * nothing, and let every one of those requests go to a socket that is not there. The failure is
 * silent in the worst way - the journal says zero requests served, the suite fails on the network,
 * and the recordings file sitting right there looks fine. Measured on the end-to-end fixture,
 * 2026-08-24. The file says what it covers; replay obeys it.
 */
declare function parseRecordingsFile(text: string): {
    scope: RecordingScope;
    recordings: Map<string, Recording>;
};
/**
 * Merge every process's capture into the one file the customer commits.
 *
 * FIRST WINS, ACROSS PROCESSES AS WITHIN ONE, and the ordering is made deterministic by the caller
 * handing the files in sorted name order. A key that two processes captured DIFFERENTLY is counted
 * as a conflict rather than resolved: the endpoint answered two ways during the recording pass, so
 * the file freezes one of them, and the count is what tells the customer their API varies where the
 * recording says it does not.
 *
 * A capture that will not parse is SKIPPED rather than fatal, and reported through `unreadable`. A
 * record pass is expensive - it is a whole test run - and losing all of it because one worker was
 * killed mid-write would be the wrong trade; a count of what was lost is what keeps that honest.
 */
declare function mergeCaptures(texts: readonly string[]): {
    recordings: Recording[];
    conflicts: number;
    unreadable: number;
};
/** The bytes a recorded response carries, decoded back from whichever form the file stored. */
declare function responseBodyBuffer(response: RecordedResponse): Buffer;

/**
 * WHAT NEVER REACHES A RECORDINGS FILE, and why the list is a closed one.
 *
 * A recording is captured on the CUSTOMER'S machine, where the credentials are real, and is then
 * COMMITTED to the customer's repository so the sealed run can serve it back. Those two sentences
 * together are the whole of this file's reason to exist: everything captured is on its way into a
 * git history, and a git history is forever. A token that lands in one is not deleted by deleting
 * the file.
 *
 * SO THE SCRUB RUNS ON BOTH HALVES, requests and responses alike. Scrubbing only requests is the
 * obvious half and the wrong one: a login endpoint's RESPONSE is where the session token is, an
 * OAuth exchange returns the refresh token in its body, and `Set-Cookie` is a response header by
 * definition. `docs/lessons/verifying-rules.md` is the standing rule that a filter running in bulk
 * has to be checked against what it actually matches, and `scrub.test.ts` is that check: every
 * pattern below has a test carrying a real-shaped secret and asserting it does not survive.
 *
 * IT IS DELIBERATELY NOT A DETECTOR. This file does not try to decide whether a string is secret.
 * It removes the headers that CARRY credentials by name, redacts the token SHAPES that vendors
 * publish, and redacts the values of fields whose NAME says what they hold. Each of those three is
 * a rule a customer can read and check against their own recording. A cleverer heuristic - entropy
 * scoring, say - would redact some things it should not and, far worse, would give a reader the
 * impression that everything else had been examined and cleared. Nothing here clears anything: the
 * staleness and disclosure copy in `docs/` says plainly that a recording is customer-supplied data
 * the customer is responsible for reading before they commit it.
 *
 * THE SCRUB IS PART OF THE MATCH KEY, which is the non-obvious consequence and the reason this
 * module is imported by `recordings.ts` rather than sitting beside it. A request's body is hashed
 * into its key; if recording hashed the scrubbed body and replay hashed the live one, no request
 * carrying a token would ever match its own recording. Both sides therefore scrub FIRST and hash
 * the scrubbed bytes, so the two agree by construction.
 */
/** What a redacted value is replaced by. One fixed string, so the file stays byte-deterministic. */
declare const REDACTED = "[abloh-redacted]";
/**
 * Request and response headers dropped from a recording entirely, matched case-insensitively.
 *
 * DROPPED RATHER THAN REDACTED, unlike a body value. A header's NAME is as much of a disclosure as
 * its value when the name is `x-shopify-access-token`, and nothing downstream needs to know the
 * header was present: headers take no part in matching (see `recordings.ts`), and a replayed
 * response that omits `set-cookie` is a response the test's own client treats as cookie-less, which
 * is the honest thing for a recording that must not carry a session.
 */
declare const DROPPED_HEADERS: readonly string[];
/**
 * Field names whose VALUE is redacted wherever one is found - in a JSON body, in a form body, or in
 * a URL's query string.
 *
 * MATCHED AS A WHOLE WORD INSIDE THE NAME, not as an exact name, because the same secret is spelled
 * `api_key`, `apiKey`, `API-KEY` and `x_api_key` by four different vendors and a list of exact names
 * would miss three of them. The cost of the looser match is a field like `token_count` being
 * redacted; that is a number a recording does not need, and the direction to be wrong in is obvious.
 */
declare const SECRET_FIELD_WORDS: readonly string[];
/** Redact every published token shape found anywhere in a string. */
declare function scrubTokenShapes(text: string): string;
/** Drop the credential-carrying headers and scrub token shapes out of the values that remain. */
declare function scrubHeaders(headers: Readonly<Record<string, string>>): Record<string, string>;
/**
 * Redact secret-named query parameters and scrub token shapes out of a URL.
 *
 * A URL IS SCRUBBED AND NOT DROPPED, because it is half the match key: a recording whose URL was
 * removed could never be served. `?access_token=…` therefore becomes `?access_token=[abloh-redacted]`
 * and both sides of the match produce that same string, which is the property `recordings.ts` needs.
 */
declare function scrubUrl(rawUrl: string): string;
/**
 * Scrub a body, treating it as JSON when it parses as JSON and as text otherwise.
 *
 * JSON IS WALKED RATHER THAN REGEX'D so that the FIELD-NAME rule can apply at all - a token with no
 * published shape, sitting in `{"session":"9f2c…"}`, is invisible to every pattern above and obvious
 * from its key. Text falls back to the shape rules plus a `name=value` pass, which is what covers a
 * form-encoded body without needing to know that it is one.
 */
declare function scrubBody(body: string): string;

/**
 * WHAT THE RUN LEARNS ABOUT A REPLAY, and how a fact crosses from inside the customer's test
 * process back out to the artifact.
 *
 * THE PROBLEM THIS SOLVES. The interceptor runs INSIDE the test process - one of many, since a
 * runner forks per file and Stryker forks per worker - and that process's only channels back to
 * abloh are its exit code and its report. Neither can carry "seven requests were served from
 * recordings and one had none", and that sentence is exactly what the customer is owed: a rate
 * measured over replayed responses is a different claim from a rate measured over live ones, and a
 * reader who is not told cannot tell.
 *
 * SO EVERY PROCESS WRITES ITS OWN FILE, into a directory abloh made, named by pid and a counter.
 * ONE FILE PER PROCESS AND NEVER A SHARED ONE: a mutation run has as many test processes alive at
 * once as its concurrency allows, and concurrent appends to a single file interleave into JSON
 * nobody can parse. The merge happens here, afterwards, in a single reader.
 *
 * THE SENTINEL IS THE OTHER HALF, and it is what makes `recording-missing` a MEASURED reason rather
 * than an inferred one. When replay has no recording for a request it errors that request, and the
 * error message carries {@link UNMATCHED_SENTINEL}. That string travels through the client, through
 * the test's failure, and into the runner's own report - so a test that failed because a recording
 * was missing SAYS SO, in its own failure text, and abloh reads the fact rather than guessing it
 * from the fact that a network-shaped test failed. `docs/lessons/verifying-rules.md` is the standing
 * rule that a diagnosis naming a mechanism must be checked against the mechanism; this is the check.
 */
/**
 * The exact string an unmatched-request error carries.
 *
 * IT IS MATCHED VERBATIM, in the runner's report text, by `unmatchedTests` below - so it may never
 * be reworded without the reader being changed in the same edit, and `journal.test.ts` pins the two
 * together. Nothing after it is load-bearing; the method and URL that follow are for the human who
 * has to go and record the missing call.
 */
declare const UNMATCHED_SENTINEL = "abloh replay: recording-missing";
/**
 * The quarantine reason a test earns when its failure carries the sentinel.
 *
 * The value is duplicated in `@abloh/core`'s `QUARANTINE_REASONS`, and duplicated deliberately:
 * this package is loaded INSIDE the customer's test process, where importing the policy engine to
 * read one string would drag the whole of core into a preload that must stay small and dependency
 * free. `quarantine-reason-sync.test.ts` in core holds the two equal.
 */
declare const RECORDING_MISSING_REASON = "recording-missing";
/** One request replay was asked for and had nothing to serve. */
interface UnmatchedRequest {
    method: string;
    /** the normalized, scrubbed URL - the same form a recording would carry, so it is copy-pasteable */
    url: string;
    key: string;
}
/** What one process observed. Written once, when the process exits. */
interface ReplayJournal {
    mode: "record" | "replay";
    /** requests answered from a recording (replay), or captured into one (record) */
    handled: number;
    /** requests in scope that had no recording. Empty on a record pass. */
    unmatched: UnmatchedRequest[];
    /**
     * Requests a record pass saw a SECOND, DIFFERENT answer for.
     *
     * Counted rather than stored, and it is the honest half of the determinism promise: the file keeps
     * the first response and serves it every time, so an endpoint that genuinely varies has been
     * frozen at one of its answers. A customer whose count is not zero has a recording that describes
     * their API less well than the count of entries suggests, and the disclosure says so.
     */
    conflicts: number;
}
/** The merged view of every process's journal, which is what the run reports. */
interface ReplaySummary {
    mode: "record" | "replay";
    /** how many processes wrote a journal - zero means the preload never loaded, which is a fault */
    processes: number;
    handled: number;
    unmatched: UnmatchedRequest[];
    conflicts: number;
}
/** Where a recording process writes what IT captured, before the run merges them all. */
declare function captureFilePath(directory: string): string;
/** Every per-process capture file in a directory, oldest name first, for a deterministic merge. */
declare function captureFiles(directory: string): string[];
/** Write this process's journal. Never throws: a failure to disclose must not fail a test run. */
declare function writeJournal(directory: string, journal: ReplayJournal): void;
/**
 * Merge every journal in a directory.
 *
 * UNMATCHED REQUESTS ARE DEDUPLICATED BY KEY, and that is not cosmetic: a mutation run re-executes
 * the same suite once per mutant, so a single missing recording produces one unmatched entry per
 * mutant - hundreds of copies of one fact. What the customer needs is the list of calls to record,
 * which is the deduplicated set.
 *
 * `handled` is NOT deduplicated, because it answers a different question: how much work the
 * recordings did, across the whole run.
 */
declare function mergeJournals(directory: string): ReplaySummary;
/**
 * Which tests failed because a recording was missing, read out of a runner's own report text.
 *
 * THE IDENTITY FORM IS THE CALLER'S, not this function's. It is handed a map of test identity to
 * that test's failure text - built by `@abloh/measure`'s `parseReportEvidence`, which is the one
 * place a test's canonical identity is derived - and returns the subset whose failure carries the
 * sentinel. Deriving identities here would be a second derivation of the same thing, which is how
 * two surfaces come to disagree about which test is which.
 */
declare function unmatchedTests(failureText: Readonly<Record<string, string>>): string[];
/**
 * The one sentence the artifact, the Markdown summary and the run page all state when replay ran.
 *
 * IT NAMES BOTH NUMBERS AND THE CAVEAT, because each answers a question a reader will otherwise
 * answer for themselves. "Replay was active" alone reads as "abloh handled the network"; the count
 * says how much of the suite it touched; and the staleness clause says the thing a recording can
 * never say for itself - that it froze an answer on the day it was captured, and the API has been
 * free to change since.
 */
declare function replayDisclosureSentence(summary: ReplaySummary): string;

/**
 * Where the bundled preload lands in this package's build output.
 *
 * Resolved by the CALLER from its own dependency on this package, never by a path relative to
 * process.cwd(): the CLI runs from wherever the customer invoked it, and the sealed image stages
 * abloh somewhere of its own choosing.
 */
declare const PRELOAD_BASENAME: string;
/**
 * The specifier a consumer hands a resolver to find the preload on disk.
 *
 * Derived from this package's own name and the subpath it publishes, so a consumer cannot ask for
 * a subpath the manifest does not export. `apps/cli/src/replay-plan.ts` explains why it resolves a
 * specifier rather than composing a path.
 */
declare const PRELOAD_PACKAGE_SPECIFIER: string;

/**
 * THE INTERCEPTOR ITSELF: one code path for capture, one for service, and no third path that
 * reaches a socket while replay is on.
 *
 * WHY `@mswjs/interceptors` AND NOT SOMETHING WRITTEN HERE. A suite's outbound calls arrive through
 * at least three surfaces - `fetch` (undici, in every modern runner), `http.ClientRequest` (axios,
 * got, node-fetch, superagent and every library built on them), and `XMLHttpRequest` (jsdom, which
 * is the default environment for jest and for Angular-vitest). Covering three surfaces means
 * three separate patch sites, each with its own body-encoding, redirect and abort semantics, and
 * getting one of them subtly wrong produces a replayed response that differs from the live one in a
 * way no test can see. That is a solved problem with a maintained solution, and `AVOID.md`'s general
 * rule - do not rebuild a load-bearing wheel - applies exactly. The library's node preset is the
 * three interceptors above, applied together.
 *
 * THE SEAL IS NOT WEAKENED BY EITHER MODE. Recording runs on the customer's own machine, where the
 * network already exists, and is refused inside a sealed run (`node-options.ts` will not build a
 * record configuration for a sealed execution). Replay runs inside the seal and has no socket to
 * reach: it answers from a `Map` built out of a file, and the one thing it does when it has no
 * answer is fail the request. There is deliberately NO fallback-to-network branch anywhere in this
 * file - a "replay, and if that misses, fetch it" mode would be a network channel wearing a
 * recording's name, and it would make the sealed run's central claim false.
 */

/** How the interceptor was configured for this process. Built by `node-options.ts`, read by the preload. */
interface ReplayConfig {
    mode: "record" | "replay";
    /** absolute path of the recordings file: written on a record pass, read on a replay pass */
    recordingsPath: string;
    /** absolute path of the directory each process drops its journal into */
    journalDir: string;
    scope: RecordingScope;
}
/** What `start` hands back so the preload can stop cleanly and write its journal exactly once. */
interface ReplayHandle {
    stop: () => void;
}
/**
 * RECORD. Let every in-scope request go to the real server, and keep what came back.
 *
 * The request is NOT answered here - no `respondWith`, no `errorWith` - so it executes exactly as it
 * would if abloh were absent, which is the property that makes a recording worth anything. The
 * exchange is captured in the `response` event, which fires with the response the server actually
 * sent (`responseType: "original"`).
 *
 * FIRST ANSWER WINS, and a second, different answer is COUNTED rather than kept. Two entries under
 * one key would mean the sealed run had to pick one, and a run that picks is a run whose result
 * depends on which it picked; see the determinism note in `recordings.ts`. The count reaches the
 * disclosure so a customer whose API genuinely varies is told that their file froze one answer.
 */
declare function startRecording(config: ReplayConfig, 
/**
 * Writes this ONE PROCESS's capture, to a path the caller picks per process.
 *
 * NOT THE RECORDINGS FILE ITSELF, and that distinction is a defect this signature exists to
 * prevent. A record pass runs the suite the way the runner runs it - many processes at once - and
 * every one of them is capturing. Each writing the whole recordings file means the last to exit
 * silently overwrites what the others found: the file is valid, and short. `captureFilePath` names
 * the per-process file; the run merges them (`mergeCaptures`) once every process has exited.
 */
writeCapture: (path: string, text: string) => void): ReplayHandle;
/**
 * REPLAY. Answer every in-scope request from the file, and fail the ones the file does not hold.
 *
 * THE FAILURE IS THE POINT OF THE `recording-missing` PATH. `controller.errorWith` produces, for
 * each client, the error that client produces for a network failure - which is precisely what a
 * request makes today inside `--network none`, so a suite that has never been recorded behaves
 * exactly as it does now and nothing regresses. What is added is the MESSAGE: it carries
 * {@link UNMATCHED_SENTINEL}, so the failure the runner reports says why, and the quarantine reason
 * downstream is a fact read out of the report rather than a guess about a failing test.
 *
 * THE SAME RECORDING IS SERVED EVERY TIME. Nothing is consumed, nothing is popped off a queue, and
 * there is no per-key call counter: the map is read-only for the whole process, and the response is
 * rebuilt from the recorded bytes on each call. Two mutant runs asking the same question get the
 * same answer, which is the whole reason a sealed measurement may use a recording at all.
 */
declare function startReplay(config: ReplayConfig, recordingsText: string): ReplayHandle;

/**
 * HOW THE INTERCEPTOR REACHES THE CUSTOMER'S TEST PROCESS, and why its configuration travels in a
 * URL rather than in the environment.
 *
 * THE CHANNEL IS `trustedNodeOptions`, the engine-owned seam in `measure/src/exec.ts` that
 * exists because customer `NODE_OPTIONS` is stripped and must stay stripped. `NODE_OPTIONS` reaches
 * every node process in the command tree, which is exactly what a mutation run needs: Stryker
 * launches its own test-runner processes, a runner forks per test file, and a flag on the outermost
 * argv would reach none of them.
 *
 * THE CONFIGURATION IS A QUERY STRING ON THE IMPORT URL, and that is not a stylistic choice. The
 * obvious spelling - environment variables - is CLOSED: `customer-environment.ts` refuses any
 * override whose name begins with `ABLOH_`, by name, because a customer's `abloh.yml` must never be
 * able to hand itself an engine variable. Passing the recordings path as `ABLOH_REPLAY_PATH` would
 * mean widening that refusal, which is a security boundary being loosened to carry a file path. An
 * ESM import specifier may carry a query, node preserves it, and `import.meta.url` inside the
 * preload hands it straight back - so the configuration arrives on the same channel as the code it
 * configures, and the boundary is untouched.
 *
 * WHY A BUNDLED PRELOAD FILE AND NOT A `data:` URL. The coverage provider's resolve hook fits in a
 * base64 `data:` module because it is nine lines. This one carries an HTTP interception library, and
 * it must resolve its own imports inside whatever tree it is loaded into - including a yarn PnP tree
 * with no `node_modules` at all, and a sealed image where the only thing staged is what abloh put
 * there. `tsup` bundles it to a single self-contained ESM file with no imports but node builtins, so
 * "can node find this file" is the only question that has to be answered anywhere.
 */

/**
 * Build the `--import=` fragment that installs the interceptor in every node descendant.
 *
 * The path is percent-encoded by `pathToFileURL`, which is what makes a repository checked out under
 * a directory with a space in it work: `NODE_OPTIONS` is split on whitespace, and an unencoded path
 * would split into two flags neither of which is valid.
 */
declare function replayNodeOptions(preloadPath: string, config: ReplayConfig): string;
/**
 * Read a configuration back out of the preload's own `import.meta.url`.
 *
 * ABSENT MEANS DO NOTHING, and that is the safety property that lets this preload be inherited by
 * every process in the tree. A node started for any other reason - a leaked `NODE_OPTIONS`, a
 * developer running the file directly - loads a module that reads no query, returns null, and exits
 * having patched nothing. It is the same rule the node-test preload states for
 * `ABLOH_NODE_TEST_RUN_DIR`.
 */
declare function parseReplayConfig(importUrl: string): ReplayConfig | null;
/**
 * Join abloh's own preload onto whatever `trustedNodeOptions` the engine had already built.
 *
 * A run can need BOTH: a yarn PnP repository already carries `--require .pnp.cjs --loader
 * .pnp.loader.mjs` on this channel, and dropping those to add this one would break every bare import
 * in the suite. The order is deliberate - the resolver first, so the preload's own module graph is
 * resolvable in the tree it lands in.
 */
declare function withReplayNodeOptions(existing: string | undefined, preloadPath: string, config: ReplayConfig): string;

export { DROPPED_HEADERS, PRELOAD_BASENAME, PRELOAD_PACKAGE_SPECIFIER, RECORDINGS_VERSION, RECORDING_MISSING_REASON, RECORDING_SCOPES, REDACTED, type RecordedRequest, type RecordedResponse, type Recording, type RecordingScope, type RecordingsFile, type ReplayConfig, type ReplayHandle, type ReplayJournal, type ReplaySummary, SECRET_FIELD_WORDS, UNMATCHED_SENTINEL, UNSTORED_HEADERS, type UnmatchedRequest, buildRecording, captureFilePath, captureFiles, inScope, isLoopbackHost, matchKey, mergeCaptures, mergeJournals, normalizeUrl, parseRecordings, parseRecordingsFile, parseReplayConfig, replayDisclosureSentence, replayNodeOptions, responseBodyBuffer, scrubBody, scrubHeaders, scrubTokenShapes, scrubUrl, serializeRecordings, startRecording, startReplay, unmatchedTests, withReplayNodeOptions, writeJournal };
