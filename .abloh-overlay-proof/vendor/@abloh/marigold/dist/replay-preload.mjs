// src/replay/preload.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";

// src/replay/node-options.ts
import { pathToFileURL } from "url";
function parseReplayConfig(importUrl) {
  let url;
  try {
    url = new URL(importUrl);
  } catch {
    return null;
  }
  const mode = url.searchParams.get("mode");
  const recordingsPath = url.searchParams.get("recordings");
  const journalDir = url.searchParams.get("journal");
  const scope = url.searchParams.get("scope") ?? "external";
  if (mode !== "record" && mode !== "replay") return null;
  if (recordingsPath === null || recordingsPath === "") return null;
  if (journalDir === null || journalDir === "") return null;
  if (scope !== "external" && scope !== "all") return null;
  return { mode, recordingsPath, journalDir, scope };
}

// src/replay/runtime.ts
import { HttpRequestInterceptor } from "@mswjs/interceptors/http";
import { XMLHttpRequestInterceptor } from "@mswjs/interceptors/XMLHttpRequest";

// src/replay/recordings.ts
import { createHash } from "crypto";

// src/replay/scrub.ts
var REDACTED = "[abloh-redacted]";
var DROPPED_HEADERS = [
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "proxy-authenticate",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-session-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
  "x-goog-api-key",
  "x-shopify-access-token",
  "private-token",
  "authentication"
];
var DROPPED_HEADER_SET = new Set(DROPPED_HEADERS);
var SECRET_FIELD_WORDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "privatekey",
  "clientsecret",
  "credential",
  "authorization",
  "session",
  "signature",
  "refresh"
];
function fieldWordMatch(name) {
  const flattened = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return SECRET_FIELD_WORDS.some((word) => flattened.includes(word));
}
var TOKEN_SHAPES = [
  /* JSON Web Tokens: three base64url segments, the first of which decodes to a JOSE header and so
     always begins `eyJ`. This is the one shape that carries its own claims, which is why it is
     first: a leaked JWT is frequently also a leaked user identity. */
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gu,
  /* GitHub's documented prefixes, fine-grained first (it is the longest). */
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /* Slack. */
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu,
  /* Stripe and the OpenAI family share the `sk_`/`sk-` spelling; the project form is longer. */
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/gu,
  /\b[sprw]k_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\bsk-[A-Za-z0-9]{20,}\b/gu,
  /* Google API keys: the prefix plus the 35 characters Google documents. Deliberately NOT anchored
     with a trailing `\b` - a key written into a longer opaque string still has its 39 significant
     characters removed, and requiring a word boundary there was measured to let exactly that case
     through. */
  /\bAIza[A-Za-z0-9_-]{35}/gu,
  /* AWS access key ids. The SECRET key has no distinguishing shape at all and is caught only by the
     field-name rule above - which is stated here rather than left implicit, because a reader who
     sees AWS handled might otherwise believe both halves are. */
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/gu,
  /* An inline `Bearer <token>` written into a body or a URL rather than into a header. */
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gu
];
function scrubTokenShapes(text) {
  let out = text;
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}
function scrubHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (DROPPED_HEADER_SET.has(name.toLowerCase())) continue;
    if (fieldWordMatch(name)) continue;
    out[name.toLowerCase()] = scrubTokenShapes(value);
  }
  return out;
}
function scrubUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return scrubTokenShapes(rawUrl);
  }
  for (const name of [...url.searchParams.keys()]) {
    if (fieldWordMatch(name)) url.searchParams.set(name, REDACTED);
  }
  const withScrubbedValues = new URL(url.href);
  for (const [name, value] of [...withScrubbedValues.searchParams.entries()]) {
    withScrubbedValues.searchParams.set(name, scrubTokenShapes(value));
  }
  withScrubbedValues.hash = "";
  return withScrubbedValues.href;
}
function scrubBody(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(body);
      return JSON.stringify(scrubJsonValue(parsed));
    } catch {
    }
  }
  return scrubTextBody(body);
}
function scrubJsonValue(value) {
  if (Array.isArray(value)) return value.map(scrubJsonValue);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = fieldWordMatch(key) ? redactStrings(entry) : scrubJsonValue(entry);
    }
    return out;
  }
  if (typeof value === "string") return scrubTokenShapes(value);
  return value;
}
function redactStrings(value) {
  if (typeof value === "string") return REDACTED;
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactStrings(entry);
    return out;
  }
  return value;
}
function scrubTextBody(body) {
  const shaped = scrubTokenShapes(body);
  const formScrubbed = shaped.replace(
    /(^|[&;\n\r\s])([A-Za-z0-9_.\][-]{1,64})=([^&;\n\r]*)/gu,
    (whole, lead, name, value) => fieldWordMatch(name) && value.length > 0 ? `${lead}${name}=${REDACTED}` : whole
  );
  return formScrubbed.replace(
    /"([A-Za-z0-9_.-]{1,64})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/gu,
    (whole, name, separator, value) => fieldWordMatch(name) && value.length > 0 ? `"${name}"${separator}"${REDACTED}"` : whole
  );
}

// src/replay/recordings.ts
var RECORDINGS_VERSION = 1;
function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host === "0.0.0.0" || host === "::") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}
function inScope(url, scope) {
  if (scope === "all") return true;
  try {
    return !isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
function normalizeUrl(rawUrl) {
  const url = new URL(scrubUrl(rawUrl));
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (url.protocol === "https:" && url.port === "443" || url.protocol === "http:" && url.port === "80") {
    url.port = "";
  }
  const pairs = [...url.searchParams.entries()].sort(
    (a, b) => a[0] === b[0] ? a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0 : a[0] < b[0] ? -1 : 1
  );
  url.search = "";
  for (const [name, value] of pairs) url.searchParams.append(name, value);
  return url.href;
}
var UNSTORED_HEADERS = [
  /* volatile */
  "date",
  "age",
  "expires",
  "x-request-id",
  "x-amz-request-id",
  "x-amzn-requestid",
  "x-amzn-trace-id",
  "x-github-request-id",
  "cf-ray",
  "x-served-by",
  "x-timer",
  "x-runtime",
  "report-to",
  "nel",
  "alt-svc",
  /* recomputed by the receiving client, and wrong if replayed */
  "content-encoding",
  "content-length",
  /* hop-by-hop: they describe a connection, not a response */
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection"
];
var UNSTORED_HEADER_SET = new Set(UNSTORED_HEADERS);
function storableHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!UNSTORED_HEADER_SET.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  }
  return out;
}
function sha256(input) {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}
function matchKey(method, url, body) {
  return sha256([method.toUpperCase(), normalizeUrl(url), sha256(scrubBody(body))].join("\n"));
}
function buildRecording(input) {
  const text = input.responseBody.toString("utf8");
  const isText = Buffer.from(text, "utf8").equals(input.responseBody);
  const body = isText ? { body: scrubBody(text) } : { bodyBase64: input.responseBody.toString("base64") };
  return {
    key: matchKey(input.method, input.url, input.requestBody),
    request: {
      method: input.method.toUpperCase(),
      url: normalizeUrl(input.url),
      bodyHash: sha256(scrubBody(input.requestBody)),
      headers: storableHeaders(scrubHeaders(input.requestHeaders))
    },
    response: {
      status: input.status,
      statusText: input.statusText,
      headers: storableHeaders(scrubHeaders(input.responseHeaders)),
      ...body
    }
  };
}
function serializeRecordings(recordings, scope) {
  const sorted = [...recordings].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const file = {
    version: RECORDINGS_VERSION,
    scope,
    recordings: sorted.map((entry) => ({
      key: entry.key,
      request: { ...entry.request, headers: sortHeaders(entry.request.headers) },
      response: { ...entry.response, headers: sortHeaders(entry.response.headers) }
    }))
  };
  return `${JSON.stringify(file, null, 2)}
`;
}
function sortHeaders(headers) {
  const out = {};
  for (const name of Object.keys(headers).sort()) out[name] = headers[name];
  return out;
}
function parseRecordingsFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`recordings file is not JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("recordings file must be an object");
  const file = parsed;
  if (file.version !== RECORDINGS_VERSION) {
    throw new Error(
      `recordings file is version ${JSON.stringify(file.version)}, and this Abloh reads version ${RECORDINGS_VERSION}`
    );
  }
  if (!Array.isArray(file.recordings)) throw new Error("recordings file must carry a `recordings` array");
  const out = /* @__PURE__ */ new Map();
  for (const entry of file.recordings) {
    const recording = entry;
    if (typeof recording.key !== "string" || recording.key === "") {
      throw new Error("every recording must carry a string `key`");
    }
    if (recording.request === void 0 || recording.response === void 0) {
      throw new Error(`recording ${recording.key} is missing its request or its response`);
    }
    if (typeof recording.response.status !== "number") {
      throw new Error(`recording ${recording.key} has no response status`);
    }
    if (out.has(recording.key)) throw new Error(`recordings file has two entries for key ${recording.key}`);
    out.set(recording.key, recording);
  }
  const scope = file.scope === "all" ? "all" : "external";
  return { scope, recordings: out };
}
function responseBodyBuffer(response) {
  if (response.bodyBase64 !== void 0) return Buffer.from(response.bodyBase64, "base64");
  return Buffer.from(response.body ?? "", "utf8");
}

// src/replay/journal.ts
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
var UNMATCHED_SENTINEL = "abloh replay: recording-missing";
var JOURNAL_SUFFIX = ".journal.json";
var CAPTURE_SUFFIX = ".capture.json";
function processFileName(suffix) {
  return `${String(process.pid)}-${(process.hrtime.bigint() % 1000000n).toString()}${suffix}`;
}
function captureFilePath(directory) {
  return join(directory, processFileName(CAPTURE_SUFFIX));
}
function writeJournal(directory, journal) {
  try {
    writeFileSync(join(directory, processFileName(JOURNAL_SUFFIX)), `${JSON.stringify(journal)}
`, {
      encoding: "utf8",
      mode: 384
    });
  } catch {
  }
}

// src/replay/runtime.ts
function headerRecord(headers) {
  const out = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    out[key] = out[key] === void 0 ? value : `${out[key]}, ${value}`;
  });
  return out;
}
function nodeInterceptors() {
  return [new HttpRequestInterceptor(), new XMLHttpRequestInterceptor()];
}
function startRecording(config2, writeCapture) {
  const captured = /* @__PURE__ */ new Map();
  const requestBodies = /* @__PURE__ */ new Map();
  let conflicts = 0;
  const interceptors = nodeInterceptors();
  for (const interceptor of interceptors) {
    interceptor.on("request", async ({ request, requestId }) => {
      if (!inScope(request.url, config2.scope)) return;
      requestBodies.set(requestId, await safeText(request.clone()));
    });
    interceptor.on(
      "response",
      async ({
        response,
        request,
        requestId
      }) => {
        if (!inScope(request.url, config2.scope)) return;
        const requestBody = requestBodies.get(requestId) ?? "";
        requestBodies.delete(requestId);
        const bytes = Buffer.from(await response.clone().arrayBuffer());
        const recording = buildRecording({
          method: request.method,
          url: request.url,
          requestBody,
          requestHeaders: headerRecord(request.headers),
          status: response.status,
          statusText: response.statusText,
          responseHeaders: headerRecord(response.headers),
          responseBody: bytes
        });
        const existing = captured.get(recording.key);
        if (existing === void 0) {
          captured.set(recording.key, recording);
          return;
        }
        if (JSON.stringify(existing.response) !== JSON.stringify(recording.response)) conflicts += 1;
      }
    );
    interceptor.apply();
  }
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const interceptor of interceptors) interceptor.dispose();
      writeCapture(captureFilePath(config2.journalDir), serializeRecordings([...captured.values()], config2.scope));
      const journal = {
        mode: "record",
        handled: captured.size,
        unmatched: [],
        conflicts
      };
      writeJournal(config2.journalDir, journal);
    }
  };
}
function startReplay(config2, recordingsText) {
  const file = parseRecordingsFile(recordingsText);
  const scope = file.scope;
  const recordings = file.recordings;
  const unmatched = /* @__PURE__ */ new Map();
  let handled = 0;
  const interceptors = nodeInterceptors();
  for (const interceptor of interceptors) {
    interceptor.on(
      "request",
      async ({
        request,
        controller
      }) => {
        if (!inScope(request.url, scope)) return;
        const body = await safeText(request.clone());
        const key = matchKey(request.method, request.url, body);
        const recording = recordings.get(key);
        if (recording === void 0) {
          const url = normalizeUrl(request.url);
          unmatched.set(key, { method: request.method.toUpperCase(), url, key });
          controller.errorWith(
            new Error(
              `${UNMATCHED_SENTINEL} ${request.method.toUpperCase()} ${url} - this sealed run serves network responses from the committed recordings file, and it holds none for this request. Re-record with \`abloh run --record-network\` where the network exists.`
            )
          );
          return;
        }
        handled += 1;
        controller.respondWith(
          new Response(
            /* 204 and 304 must carry no body at all: a `Response` constructed with one throws, and
               the throw would be coerced into a 500 the test would report as the server's. */
            recording.response.status === 204 || recording.response.status === 304 ? null : (
              /* A plain `Uint8Array` view rather than the `Buffer` itself: node's `Buffer` is one
                 at runtime, but the Fetch `BodyInit` type admits `ArrayBufferView` and not the
                 node subclass, and the view is free (same backing memory, no copy). */
              new Uint8Array(responseBodyBuffer(recording.response))
            ),
            {
              status: recording.response.status,
              statusText: recording.response.statusText,
              headers: recording.response.headers
            }
          )
        );
      }
    );
    interceptor.apply();
  }
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const interceptor of interceptors) interceptor.dispose();
      const journal = {
        mode: "replay",
        handled,
        unmatched: [...unmatched.values()],
        conflicts: 0
      };
      writeJournal(config2.journalDir, journal);
    }
  };
}
async function safeText(request) {
  try {
    return request.body === null ? "" : await request.text();
  } catch {
    return "";
  }
}

// src/replay/preload.ts
var config = parseReplayConfig(import.meta.url);
if (config !== null) {
  let handle = null;
  if (config.mode === "record") {
    handle = startRecording(config, (path, text) => {
      writeFileSync2(path, text, { encoding: "utf8", mode: 384 });
    });
  } else {
    const text = readFileSync2(config.recordingsPath, "utf8");
    handle = startReplay(config, text);
  }
  const finish = () => {
    try {
      handle?.stop();
    } catch {
    }
  };
  process.on("exit", finish);
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
}
