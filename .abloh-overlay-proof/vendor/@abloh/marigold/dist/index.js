// src/types.ts
var INTAKE_EXCLUSION_REASONS = [
  "not-a-survivor",
  "no-replacement-text",
  "no-original-text",
  "no-span-columns",
  "duplicate-identity"
];
var LOOP_STAGES = [
  "intake",
  "normalization",
  "triage",
  "generation",
  "admission",
  "light-check",
  "kill-matrix",
  "exit-proof"
];
var LIGHT_CHECK_VERDICTS = [
  "distinguishes",
  "real-not-passing",
  "mutant-not-failing",
  "not-executed",
  "errored"
];
var EXIT_VERDICTS = ["proven", "rejected", "not-attempted-budget"];
var SUITE_DELTA_BASES = [
  "no-failures",
  "baseline-green",
  "named",
  "counted",
  "unattributable",
  "error"
];
function emptyFunnel() {
  const funnel = {};
  for (const stage of LOOP_STAGES) {
    funnel[stage] = { entered: 0, advanced: 0, held: 0, holdReasons: {} };
  }
  return funnel;
}
var DEFAULT_BUDGET = {
  totalMs: 20 * 6e4,
  msPerGap: 15e4,
  /* 150, not 60: batch 1 turns ~14 batches into ~55 calls plus retries, and in the bench arm
     triage takes 36 of them before generation starts. In production the CLI seam passes
     `upstreamTriaged`, so triage costs the loop nothing and this is the whole generation budget. */
  modelCalls: 150,
  executions: 400,
  rounds: 3
};
function effectiveTotalMs(budget, gapCount) {
  return budget.totalMs + budget.msPerGap * Math.max(0, gapCount);
}
var MAX_EVIDENCE_CHARS = 4e3;
function boundEvidence(text, max = MAX_EVIDENCE_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}
\u2026 (${text.length - max} more characters elided)`;
}
function boundEvidenceTail(text, max = MAX_EVIDENCE_CHARS) {
  if (text.length <= max) return text;
  return `\u2026 (${text.length - max} earlier characters elided)
${text.slice(text.length - max)}`;
}

// src/unavailable.ts
var EngineUnavailableError = class extends Error {
  /** The closed wire code. Nothing else about this error may leave the machine. */
  code;
  /**
   * The full local diagnosis - LOCAL ONLY, and untrusted.
   *
   * It holds whatever the failure held: a docker build log, a runner's stderr, a customer's setup
   * script output. It is scrubbed before it reaches even the local log, because a secret in a build
   * log is a secret in a build log wherever that log is read.
   */
  detail;
  constructor(code, message, detail = message) {
    super(message);
    this.name = "EngineUnavailableError";
    this.code = code;
    this.detail = detail;
  }
};
function unavailableCode(error) {
  return error instanceof EngineUnavailableError ? error.code : "engine-error";
}
function unavailableDetail(error) {
  if (error instanceof EngineUnavailableError) return error.detail;
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

// src/upload-projection.ts
import { redactCredentialShapesDeep, scrubSecretsDeep } from "@abloh/core";
function survivorProofsProjection(sidecar) {
  const proven = sidecar.exitProofs.filter((proof) => proof.verdict === "proven");
  const provenCandidateIds = new Set(proven.map((proof) => proof.candidateId));
  return {
    schema: sidecar.schema,
    sha: sidecar.sha,
    /* Named in the document, so a reader who opens the uploaded bytes is told what they are holding
       rather than left to notice that a candidate they expected is absent. */
    projection: "survivors-only",
    candidates: sidecar.candidates.filter((candidate) => provenCandidateIds.has(candidate.candidateId)).map(uploadedCandidate),
    exitProofs: proven
  };
}
function uploadedCandidate(candidate) {
  return {
    candidateId: candidate.candidateId,
    gapId: candidate.gapId,
    round: candidate.round,
    testFile: candidate.testFile,
    testName: candidate.testName,
    testBody: candidate.testBody
  };
}
function survivorPool2Projection(ledger, survivors) {
  const proven = /* @__PURE__ */ new Set();
  for (const survivor of survivors) {
    if (typeof survivor.bugId !== "string") continue;
    if (survivor.witness !== "proven") continue;
    proven.add(survivor.bugId);
  }
  return {
    schema: ledger.schema,
    sha: ledger.sha,
    /* Named in the document, as the loop's projection is, so a reader who opens the uploaded bytes
       is told what they are holding. */
    projection: "survivors-only",
    /* THE KEY AND THE SHAPE BOTH STAY. The far side parses `entries` and refuses anything else, so
       a projection that returned a bare array would be a document it cannot read. */
    entries: ledger.entries.filter((entry) => proven.has(entry.bugId)).map(({ evidence: _dropped, ...kept }) => kept)
  };
}
function uploadableSidecarText(projection) {
  return `${JSON.stringify(redactCredentialShapesDeep(scrubSecretsDeep(projection)), null, 2)}
`;
}

// src/identity.ts
import { structuralDigest } from "@abloh/core";
import { bugIdentity, canonicalJson, sha256, sha256Bytes, structuralDigest as structuralDigest2 } from "@abloh/core";
function gapIdentity(input) {
  return structuralDigest({
    file: input.file,
    startLine: input.startLine,
    startColumn: input.startColumn,
    endLine: input.endLine,
    endColumn: input.endColumn,
    mutator: input.mutator,
    replacement: input.replacement
  });
}
function spanIdentity(input) {
  return structuralDigest({
    file: input.file,
    startLine: input.startLine,
    startColumn: input.startColumn,
    endLine: input.endLine,
    endColumn: input.endColumn
  });
}
function candidateIdentity(input) {
  return structuralDigest({
    gapId: input.gapId,
    round: input.round,
    files: [
      { path: input.testFile, source: input.testBody },
      ...input.supportFiles
    ].map((f) => ({ path: f.path, source: f.source })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  });
}
function candidateDigest(input) {
  return structuralDigest(
    [{ path: input.testFile, source: input.testBody }, ...input.supportFiles].map((f) => ({ path: f.path, source: f.source })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

// src/intake.ts
var ELIGIBLE_STATUSES = /* @__PURE__ */ new Set(["survived", "no-coverage"]);
function intakeSurvivors(mutants) {
  const gaps = [];
  const excluded = [];
  const seen = /* @__PURE__ */ new Set();
  for (const mutant of mutants) {
    const where = {
      mutantId: mutant.id,
      file: mutant.file,
      startLine: mutant.startLine,
      mutator: mutant.mutator
    };
    if (!ELIGIBLE_STATUSES.has(mutant.status)) {
      excluded.push({ ...where, reason: "not-a-survivor" });
      continue;
    }
    if (mutant.replacement === null || mutant.replacement === void 0) {
      excluded.push({ ...where, reason: "no-replacement-text" });
      continue;
    }
    if (mutant.originalText === void 0) {
      excluded.push({ ...where, reason: "no-original-text" });
      continue;
    }
    if (mutant.startColumn === void 0 || mutant.endColumn === void 0) {
      excluded.push({ ...where, reason: "no-span-columns" });
      continue;
    }
    const gapId = gapIdentity({
      file: mutant.file,
      startLine: mutant.startLine,
      startColumn: mutant.startColumn,
      endLine: mutant.endLine,
      endColumn: mutant.endColumn,
      mutator: mutant.mutator,
      replacement: mutant.replacement
    });
    if (seen.has(gapId)) {
      excluded.push({ ...where, reason: "duplicate-identity" });
      continue;
    }
    seen.add(gapId);
    gaps.push({
      gapId,
      /* THE SPAN, alongside the mutation. Intake is where every mutant is in one place, so it is
         where the coarser key is derived; nothing here groups anything, because intake still
         refuses to make judgements about what is worth attempting. What reads it is generation
         batching, which asks one question per span rather than one per replacement. */
      spanKey: spanIdentity({
        file: mutant.file,
        startLine: mutant.startLine,
        startColumn: mutant.startColumn,
        endLine: mutant.endLine,
        endColumn: mutant.endColumn
      }),
      mutantId: mutant.id,
      file: mutant.file,
      startLine: mutant.startLine,
      endLine: mutant.endLine,
      startColumn: mutant.startColumn,
      endColumn: mutant.endColumn,
      mutator: mutant.mutator,
      replacement: mutant.replacement,
      originalText: mutant.originalText,
      coveredBy: mutant.coveredBy
    });
  }
  return { gaps, excluded };
}

// src/normalize.ts
function normalizeSpan(text) {
  const out = [];
  let safe = true;
  let i = 0;
  const isRegexAmbiguous = (index) => {
    const next = text[index + 1];
    return next !== "/" && next !== "*";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      out.push(quote);
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") {
          out.push(text.slice(j, j + 2));
          j += 2;
          continue;
        }
        out.push(c);
        j += 1;
        if (c === quote) break;
      }
      if (j > text.length) safe = false;
      i = j;
      continue;
    }
    if (ch === "/") {
      if (text[i + 1] === "/") {
        const end = text.indexOf("\n", i);
        i = end === -1 ? text.length : end;
        out.push(" ");
        continue;
      }
      if (text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end === -1 ? text.length : end + 2;
        out.push(" ");
        continue;
      }
      if (isRegexAmbiguous(i)) safe = false;
      out.push(ch);
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  let normalized = collapseWhitespaceOutsideLiterals(out.join(""));
  normalized = normalized.trim();
  while (normalized.endsWith(";")) normalized = normalized.slice(0, -1).trimEnd();
  normalized = stripRedundantWrappingParens(normalized);
  return { normalized, safe };
}
function collapseWhitespaceOutsideLiterals(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      out += quote;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") {
          out += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        out += c;
        j += 1;
        if (c === quote) break;
      }
      i = j;
      continue;
    }
    if (/\s/u.test(ch)) {
      out += " ";
      while (i < text.length && /\s/u.test(text[i])) i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
function stripRedundantWrappingParens(text) {
  let current = text;
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < current.length; i++) {
      if (current[i] === "(") depth += 1;
      else if (current[i] === ")") {
        depth -= 1;
        if (depth === 0 && i < current.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps || depth !== 0) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}
var TRIVIAL_VERDICTS = ["identical-after-normalization", "needs-model"];
function trivialTriage(input) {
  const original = normalizeSpan(input.originalText);
  const replacement = normalizeSpan(input.replacement);
  const safe = original.safe && replacement.safe;
  const identical = safe ? original.normalized === replacement.normalized : input.originalText.trim() === input.replacement.trim();
  return {
    verdict: identical ? "identical-after-normalization" : "needs-model",
    evidence: {
      original: safe ? original.normalized : input.originalText.trim(),
      replacement: safe ? replacement.normalized : input.replacement.trim(),
      safeToNormalize: safe
    }
  };
}

// src/functions.ts
import ts from "typescript";
var FUNCTION_SHAPES = [
  /** `function name() {}`, including `export default function () {}` */
  "function-declaration",
  /** `const f = function () {}`, `{ f: function () {} }`, `module.exports = function () {}` */
  "function-expression",
  /** `const f = () => {}` and `{ f: () => {} }` - block-bodied arrows only */
  "arrow-block",
  /** a class method and an object literal's shorthand method, which are the same node */
  "method",
  /** `get x() {}` / `set x(v) {}` */
  "accessor"
];
function scriptKind(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/u.test(fileName)) return ts.ScriptKind.TS;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}
function syntaxErrorCount(sourceFile) {
  const withDiagnostics = sourceFile;
  return withDiagnostics.parseDiagnostics?.length ?? 0;
}
function guttableShape(node) {
  if (ts.isFunctionDeclaration(node)) return node.body === void 0 ? null : "function-declaration";
  if (ts.isFunctionExpression(node)) return node.body === void 0 ? null : "function-expression";
  if (ts.isArrowFunction(node)) return ts.isBlock(node.body) ? "arrow-block" : null;
  if (ts.isMethodDeclaration(node)) return node.body === void 0 ? null : "method";
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.body === void 0 ? null : "accessor";
  }
  return null;
}
var CACHE_LIMIT = 32;
var cache = /* @__PURE__ */ new Map();
function detectFunctions(source, fileName) {
  const key = `${fileName}\0${source}`;
  const cached = cache.get(key);
  if (cached !== void 0) return cached;
  const found = parseFunctions(source, fileName);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, found);
  return found;
}
function parseFunctions(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */
    false,
    scriptKind(fileName)
  );
  if (syntaxErrorCount(sourceFile) > 0) return [];
  const lineOf = (offset) => sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
  const out = [];
  const visit = (node, owner, bound2) => {
    const shape = guttableShape(node);
    if (shape !== null) {
      const body = node.body;
      const bodyStart = body.getStart(sourceFile) + 1;
      const bodyEnd = body.end - 1;
      if (source[bodyStart - 1] === "{" && source[bodyEnd] === "}" && bodyEnd >= bodyStart) {
        out.push({
          startLine: lineOf(node.getStart(sourceFile)),
          endLine: lineOf(bodyEnd),
          bodyStart,
          bodyEnd,
          shape,
          name: declaredName(node) ?? bound2,
          owner: shape === "method" || shape === "accessor" ? owner : null
        });
      }
    }
    const nextOwner = ts.isClassDeclaration(node) || ts.isClassExpression(node) ? node.name?.text ?? owner : owner;
    ts.forEachChild(node, (child) => visit(child, nextOwner, boundNameFor(node, child)));
  };
  ts.forEachChild(sourceFile, (child) => visit(child, null, null));
  return out;
}
function declaredName(node) {
  const named = node;
  const name = named.name;
  if (name === void 0) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}
function boundNameFor(parent, child) {
  if (ts.isVariableDeclaration(parent) && parent.initializer === child) return declaredName(parent);
  if (ts.isPropertyAssignment(parent) && parent.initializer === child) return declaredName(parent);
  if (ts.isPropertyDeclaration(parent) && parent.initializer === child) return declaredName(parent);
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === child) {
    const left = parent.left;
    if (ts.isIdentifier(left)) return left.text;
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) return left.name.text;
  }
  return null;
}
function functionName(declarationLine) {
  const patterns = [
    /(?:^|\s)function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/u,
    /(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(declarationLine);
    if (match !== null) return match[1];
  }
  return null;
}
function enclosingFunction(source, fileName, line) {
  let best = null;
  for (const fn of detectFunctions(source, fileName)) {
    if (fn.startLine > line || fn.endLine < line) continue;
    if (best === null || fn.startLine > best.startLine) best = fn;
  }
  return best;
}

// src/context.ts
import { readFileSync, existsSync } from "fs";
import { join, relative, dirname, basename } from "path";

// src/temp-root.ts
var REPOSITORY_LOCATION_EXPRESSIONS = [
  { pattern: /\b__dirname\b/u, what: "__dirname" },
  { pattern: /\b__filename\b/u, what: "__filename" },
  { pattern: /\bimport\s*\.\s*meta\b/u, what: "import.meta" },
  { pattern: /\bfileURLToPath\s*\(/u, what: "fileURLToPath(...)" },
  { pattern: /\bprocess\s*\.\s*cwd\s*\(/u, what: "process.cwd()" },
  { pattern: /\bprocess\s*\.\s*argv\b/u, what: "process.argv" },
  { pattern: /\bprocess\s*\.\s*env\b/u, what: "process.env" },
  { pattern: /\brequire\s*\.\s*resolve\s*\(/u, what: "require.resolve(...)" },
  /* Not the repository, but not a temp root either, and naming it here produces a refusal that says
     why rather than the generic provenance one. */
  { pattern: /\bhomedir\s*\(/u, what: "homedir()" }
];
var LINK_OPERATIONS = /* @__PURE__ */ new Set([
  "symlink",
  "symlinkSync",
  "link",
  "linkSync",
  "realpath",
  "realpathSync",
  "readlink",
  "readlinkSync",
  "cp",
  "cpSync"
]);
var DESCRIPTOR_ONLY = /* @__PURE__ */ new Set(["writeSync", "readSync", "closeSync", "fsyncSync", "fstatSync", "ftruncateSync"]);
var MKDTEMP = /* @__PURE__ */ new Set(["mkdtemp", "mkdtempSync"]);
var JOINERS = /* @__PURE__ */ new Set(["join", "resolve"]);
var FS_MODULES = /* @__PURE__ */ new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
var OS_MODULES = /* @__PURE__ */ new Set(["os", "node:os"]);
var CHILD_PROCESS_MODULES = /* @__PURE__ */ new Set(["child_process", "node:child_process"]);
var ALLOWED_BINARIES = /* @__PURE__ */ new Set(["git"]);
var GIT_ARGUMENTS = /* @__PURE__ */ new Set([
  /* subcommands that build a fixture revision, which is the measured use */
  "init",
  "add",
  "commit",
  "config",
  "checkout",
  "branch",
  "tag",
  "rev-parse",
  "status",
  "symbolic-ref",
  "update-index",
  /* value-free flags */
  "-q",
  "--quiet",
  "-A",
  "--all",
  "--allow-empty",
  "--allow-empty-message",
  "--no-verify",
  "--no-gpg-sign",
  "--bare",
  "-b",
  "--initial-branch",
  "--local",
  "-m",
  "--message",
  /* the current directory, which is the temp root because the cwd is required to be derived */
  "."
]);
var GIT_PATH_OPTIONS = /* @__PURE__ */ new Set(["-C"]);
var GIT_FREE_TEXT_OPTIONS = /* @__PURE__ */ new Set(["-m", "--message", "-b", "--initial-branch", "config"]);
var ARGV_LAUNCHERS = /* @__PURE__ */ new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
var SHELL_LAUNCHERS = /* @__PURE__ */ new Set(["exec", "execSync", "fork"]);
var REFUSED_LAUNCH_OPTIONS = ["env", "shell", "input", "stdio", "argv0"];
function provesSelfContainedUse(input) {
  const code = stripCommentsKeepingStrings(input.source);
  for (const entry of REPOSITORY_LOCATION_EXPRESSIONS) {
    if (entry.pattern.test(code)) {
      return {
        proven: false,
        detail: `it names ${entry.what}, which reaches the checkout rather than a temporary directory - the self-containment allowance covers only paths built from a mkdtemp root the test itself creates`
      };
    }
  }
  const bindings = moduleBindings(code);
  const wantsExec = input.requested.some((specifier) => CHILD_PROCESS_MODULES.has(specifier));
  const wantsFs = input.requested.some((specifier) => FS_MODULES.has(specifier));
  const roots = tempRoots(code, bindings);
  if (roots.size === 0) {
    return {
      proven: false,
      detail: "no temporary root is created: the allowance needs a `const root = mkdtempSync(join(tmpdir(), '...'))` in the test, and every path and process argument derived from it"
    };
  }
  const derived = derivedBindings(code, roots);
  if (wantsFs) {
    const verdict = provesFilesystemUse(code, bindings, derived);
    if (!verdict.proven) return verdict;
  }
  if (wantsExec) {
    const verdict = provesProcessUse(code, bindings, derived);
    if (!verdict.proven) return verdict;
  }
  return { proven: true };
}
function isSelfContainmentAllowedModule(specifier) {
  return FS_MODULES.has(specifier) || OS_MODULES.has(specifier) || CHILD_PROCESS_MODULES.has(specifier);
}
function provesFilesystemUse(code, bindings, derived) {
  if (bindings.fsNamespaces.size === 0 && bindings.fsNames.size === 0) {
    return {
      proven: false,
      detail: "the filesystem module is bound in a way this scan cannot follow; import the functions you need directly from 'node:fs' so every path can be checked"
    };
  }
  const calls = boundCalls(code, bindings.fsNamespaces, bindings.fsNames);
  for (const call of calls) {
    if (LINK_OPERATIONS.has(call.name)) {
      return {
        proven: false,
        detail: `it calls ${call.name}, and a link or a copy can point anywhere - including into the checkout - so the link, copy and realpath family is refused under the self-containment allowance`
      };
    }
    if (MKDTEMP.has(call.name) || DESCRIPTOR_ONLY.has(call.name)) continue;
    if (call.args.length === 0) {
      return { proven: false, detail: `${call.name} is called with no path this scan can read` };
    }
    if (!isDerivedPath(call.args[0], derived)) {
      return {
        proven: false,
        detail: `${call.name}(${bound(call.args[0])}) does not provably use a path under the temporary root; build every path with join(root, '...') from the mkdtemp root this test created`
      };
    }
  }
  return { proven: true };
}
function provesProcessUse(code, bindings, derived) {
  if (bindings.execNamespaces.size === 0 && bindings.execNames.size === 0) {
    return {
      proven: false,
      detail: "the process module is bound in a way this scan cannot follow; import execFileSync directly from 'node:child_process' so every argument can be checked"
    };
  }
  const calls = boundCalls(code, bindings.execNamespaces, bindings.execNames);
  for (const call of calls) {
    if (SHELL_LAUNCHERS.has(call.name)) {
      return {
        proven: false,
        detail: `it calls ${call.name}, which takes a shell command line - what actually runs is decided by quoting, so no argument can be checked. Use execFileSync(binary, [args], { cwd }) instead.`
      };
    }
    if (!ARGV_LAUNCHERS.has(call.name)) {
      return { proven: false, detail: `${call.name} is not a process launcher this scan recognises` };
    }
    const verdict = provesLaunch(call, derived);
    if (!verdict.proven) return verdict;
  }
  return { proven: true };
}
function provesLaunch(call, derived) {
  const binary = literalValue(call.args[0] ?? "");
  if (binary === null) {
    return {
      proven: false,
      detail: `${call.name} is given a binary this scan cannot read; write it as a string literal, and only ${[...ALLOWED_BINARIES].join(", ")} is admitted`
    };
  }
  if (!ALLOWED_BINARIES.has(binary)) {
    return {
      proven: false,
      detail: `${call.name} runs '${binary}', which is not on the allowlist (${[...ALLOWED_BINARIES].join(", ")}); a gap that can only be reached by running anything else is reported as structurally untestable rather than attempted`
    };
  }
  const second = call.args[1];
  const secondIsArgv = second !== void 0 && second.trim().startsWith("[");
  if (second !== void 0 && !secondIsArgv && !second.trim().startsWith("{")) {
    return { proven: false, detail: `${call.name}'s argument list is not a literal array this scan can read` };
  }
  const argv = secondIsArgv ? arrayElements(second) : [];
  if (argv === null) {
    return { proven: false, detail: `${call.name}'s argument list is not a literal array this scan can read` };
  }
  const verdict = provesGitArguments(argv, derived);
  if (!verdict.proven) return verdict;
  const optionText = secondIsArgv ? call.args[2] : second;
  if (optionText === void 0) {
    return {
      proven: false,
      detail: `${call.name} declares no cwd, so it would run inside the checkout; pass { cwd: <a path under the mkdtemp root> }`
    };
  }
  for (const refused of REFUSED_LAUNCH_OPTIONS) {
    if (new RegExp(`(^|[{,\\s])${refused}\\s*:`, "u").test(optionText)) {
      return {
        proven: false,
        detail: `${call.name} passes '${refused}', which can point the subprocess somewhere this scan cannot follow; only { cwd } is admitted`
      };
    }
  }
  const cwd = /(?:^|[{,\s])cwd\s*:\s*([^,}]+)/u.exec(optionText);
  if (cwd === null) {
    return {
      proven: false,
      detail: `${call.name} declares no cwd, so it would run inside the checkout; pass { cwd: <a path under the mkdtemp root> }`
    };
  }
  if (!isDerivedPath(cwd[1], derived)) {
    return {
      proven: false,
      detail: `${call.name}'s cwd (${bound(cwd[1])}) does not provably sit under the temporary root`
    };
  }
  return { proven: true };
}
function provesGitArguments(argv, derived) {
  let expectPath = false;
  let freeTextBudget = 0;
  for (const argument of argv) {
    if (expectPath) {
      expectPath = false;
      if (!isDerivedPath(argument, derived)) {
        return {
          proven: false,
          detail: `git is pointed at ${bound(argument)}, which does not provably sit under the temporary root - the checkout is exactly what this refuses`
        };
      }
      continue;
    }
    if (isDerivedPath(argument, derived)) {
      freeTextBudget = 0;
      continue;
    }
    const literal = literalValue(argument);
    if (literal === null) {
      return {
        proven: false,
        detail: `git is given ${bound(argument)}, which is neither a string literal nor a path built from the temporary root; arguments assembled at runtime cannot be checked`
      };
    }
    if (freeTextBudget > 0 && isFreeText(literal)) {
      freeTextBudget -= 1;
      continue;
    }
    if (GIT_PATH_OPTIONS.has(literal)) {
      expectPath = true;
      freeTextBudget = 0;
      continue;
    }
    if (!GIT_ARGUMENTS.has(literal)) {
      return {
        proven: false,
        detail: `git is given '${literal}', which is not on the admitted argument list; options that carry a command, a configuration assignment or a path outside the temporary root are refused by name`
      };
    }
    freeTextBudget = GIT_FREE_TEXT_OPTIONS.has(literal) ? literal === "config" ? 2 : 1 : 0;
  }
  if (expectPath) return { proven: false, detail: "git's -C is given no directory" };
  return { proven: true };
}
function isFreeText(value) {
  return !value.includes("/") && !value.includes("\\") && !value.includes("..") && !value.includes("=");
}
var IMPORT_CLAUSE = /\bimport\s+([^;'"`]*?)\s+from\s*['"]([^'"]+)['"]/gu;
function moduleBindings(code) {
  const bindings = {
    fsNamespaces: /* @__PURE__ */ new Set(),
    fsNames: /* @__PURE__ */ new Map(),
    execNamespaces: /* @__PURE__ */ new Set(),
    execNames: /* @__PURE__ */ new Map(),
    tmpdirNames: /* @__PURE__ */ new Set(),
    joinerNames: /* @__PURE__ */ new Set(),
    pathNamespaces: /* @__PURE__ */ new Set(),
    osNamespaces: /* @__PURE__ */ new Set()
  };
  IMPORT_CLAUSE.lastIndex = 0;
  let match;
  while ((match = IMPORT_CLAUSE.exec(code)) !== null) {
    const clause = match[1].trim();
    const specifier = match[2];
    const isFs = FS_MODULES.has(specifier);
    const isOs = OS_MODULES.has(specifier);
    const isExec = CHILD_PROCESS_MODULES.has(specifier);
    const isPath = /^(?:node:)?path(?:\/posix|\/win32)?$/u.test(specifier);
    if (!isFs && !isOs && !isExec && !isPath) continue;
    const namespace = /^\*\s+as\s+(\w+)$/u.exec(clause) ?? /^(\w+)$/u.exec(clause);
    if (namespace !== null) {
      if (isFs) bindings.fsNamespaces.add(namespace[1]);
      if (isExec) bindings.execNamespaces.add(namespace[1]);
      if (isOs) bindings.osNamespaces.add(namespace[1]);
      if (isPath) bindings.pathNamespaces.add(namespace[1]);
      continue;
    }
    const braced = /\{([^}]*)\}/u.exec(clause);
    if (braced === null) continue;
    for (const part of braced[1].split(",")) {
      const [imported, local] = part.split(/\s+as\s+/u).map((piece) => piece.trim());
      if (imported === void 0 || imported === "") continue;
      const name = local === void 0 || local === "" ? imported : local;
      if (!/^\w+$/u.test(name) || !/^\w+$/u.test(imported)) continue;
      if (isFs) bindings.fsNames.set(name, imported);
      if (isExec) bindings.execNames.set(name, imported);
      if (isOs && imported === "tmpdir") bindings.tmpdirNames.add(name);
      if (isPath && JOINERS.has(imported)) bindings.joinerNames.add(name);
    }
  }
  return bindings;
}
function boundCalls(code, namespaces, names) {
  const calls = [];
  const call = /(?:\b(\w+)\s*\.\s*)?\b(\w+)\s*\(/gu;
  let match;
  while ((match = call.exec(code)) !== null) {
    const namespace = match[1];
    const member = match[2];
    let imported = null;
    if (namespace !== void 0 && namespaces.has(namespace)) imported = member;
    else if (namespace === void 0 && names.has(member)) imported = names.get(member);
    if (imported === null) continue;
    calls.push({ name: imported, args: argumentsOf(code, match.index + match[0].length - 1) });
  }
  return calls;
}
function tempRoots(code, bindings) {
  const roots = /* @__PURE__ */ new Set();
  const assignment = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:(\w+)\s*\.\s*)?(\w+)\s*\(/gu;
  let match;
  while ((match = assignment.exec(code)) !== null) {
    const [, name, namespace, member] = match;
    const imported = namespace !== void 0 && bindings.fsNamespaces.has(namespace) ? member : namespace === void 0 ? bindings.fsNames.get(member) : void 0;
    if (imported === void 0 || !MKDTEMP.has(imported)) continue;
    const args = argumentsOf(code, match.index + match[0].length - 1);
    if (args.length === 0 || !isUnderSystemTemp(args[0], bindings)) continue;
    roots.add(name);
  }
  return roots;
}
function derivedBindings(code, roots) {
  const derived = new Set(roots);
  const poisoned = /* @__PURE__ */ new Set();
  const assignment = /\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)/gu;
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    assignment.lastIndex = 0;
    let match;
    while ((match = assignment.exec(code)) !== null) {
      const name = match[1];
      if (roots.has(name)) continue;
      if (isDerivedPath(match[2], derived)) {
        if (!derived.has(name) && !poisoned.has(name)) {
          derived.add(name);
          grew = true;
        }
      } else {
        if (derived.has(name)) {
          derived.delete(name);
          grew = true;
        }
        poisoned.add(name);
      }
    }
    if (!grew) break;
  }
  return derived;
}
function isDerivedPath(expression, derived) {
  const text = expression.trim();
  if (/^\w+$/u.test(text)) return derived.has(text);
  const joiner = /^(?:(\w+)\s*\.\s*)?(\w+)\s*\(/u.exec(text);
  if (joiner !== null && JOINERS.has(joiner[2])) {
    const open = text.indexOf("(");
    const args = argumentsOf(text, open);
    if (closingParen(text, open) !== text.length - 1) return false;
    if (args.length === 0) return false;
    if (!isDerivedPath(args[0], derived)) return false;
    return args.slice(1).every((argument) => isSafeSegment(argument));
  }
  if (text.startsWith("`") && text.endsWith("`") && text.length > 1) {
    const first = /^`\$\{([^}]+)\}/u.exec(text);
    if (first === null) return false;
    if (!isDerivedPath(first[1], derived)) return false;
    const rest = text.slice(first[0].length, -1);
    if (rest.includes("${")) return false;
    return isSafeSegment(`"${separatorTail(rest)}"`);
  }
  return false;
}
function isSafeSegment(argument) {
  const value = literalValue(argument);
  if (value === null) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  return !value.split("/").includes("..");
}
function separatorTail(rest) {
  return rest.replace(/^\/+/u, "");
}
function literalValue(argument) {
  const literal = /^(['"])((?:\\.|(?!\1).)*)\1$/u.exec(argument.trim());
  return literal === null ? null : literal[2];
}
function arrayElements(expression) {
  const text = expression.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = `(${text.slice(1, -1)})`;
  return argumentsOf(inner, 0);
}
function isUnderSystemTemp(expression, bindings) {
  const text = expression.trim();
  const tmpdirCall = (piece) => {
    const call = /^(?:(\w+)\s*\.\s*)?(\w+)\s*\(\s*\)$/u.exec(piece.trim());
    if (call === null) return false;
    const [, namespace, member] = call;
    if (namespace !== void 0) return bindings.osNamespaces.has(namespace) && member === "tmpdir";
    return bindings.tmpdirNames.has(member);
  };
  if (tmpdirCall(text)) return true;
  const joiner = /^(?:(\w+)\s*\.\s*)?(\w+)\s*\(/u.exec(text);
  if (joiner !== null && JOINERS.has(joiner[2])) {
    const args = argumentsOf(text, text.indexOf("("));
    return args.length > 0 && tmpdirCall(args[0]) && args.slice(1).every((argument) => isSafeSegment(argument));
  }
  if (text.startsWith("`")) {
    const first = /^`\$\{([^}]+)\}/u.exec(text);
    if (first === null) return false;
    const rest = text.slice(first[0].length, -1);
    return tmpdirCall(first[1]) && !rest.includes("${") && isSafeSegment(`"${separatorTail(rest)}"`);
  }
  return false;
}
function argumentsOf(source, open) {
  if (source[open] !== "(") return [];
  const args = [];
  let depth = 0;
  let start = open + 1;
  let quote = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const tail = source.slice(start, i).trim();
        if (tail !== "" || args.length > 0) args.push(tail);
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}
function closingParen(source, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function stripCommentsKeepingStrings(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += quote;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          out += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        out += source[j];
        const closed = source[j] === quote;
        j += 1;
        if (closed) break;
      }
      i = j;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k++) out += source[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
function bound(text) {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 77)}...`;
}

// src/admission.ts
var ADMISSION_RULES = [
  "path-not-contained",
  "path-not-reserved",
  "file-empty-or-binary",
  "byte-cap",
  "file-count",
  "denied-module",
  "undeclared-import",
  "dynamic-code",
  "target-replacement",
  "no-test-declared"
];
var DENIED_MODULES = /* @__PURE__ */ new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "net",
  "node:net",
  "http",
  "node:http",
  "https",
  "node:https",
  "dgram",
  "node:dgram",
  "tls",
  "node:tls",
  "vm",
  "node:vm",
  "module",
  "node:module",
  "worker_threads",
  "node:worker_threads",
  "inspector",
  "node:inspector",
  "v8",
  "node:v8",
  /*
   * `os` JOINS THE LIST rather than the allowed one, 2026-08-21, and that is a widening even though
   * it reads as a tightening. It was never in `BASE_ALLOWED_IMPORTS`, so every candidate importing
   * it was already refused - as `undeclared-import`, which said nothing useful. Here it reaches the
   * self-containment allowance instead, which is the only way `tmpdir()` becomes writable at all:
   * the temp root the whole rule is built on is `mkdtempSync(join(tmpdir(), …))`.
   */
  "os",
  "node:os",
  /*
   * DENO'S EQUIVALENTS, added 2026-08-18, and the gap they close is exactly the one this list
   * exists for. Every name above is a NODE specifier, so a deno witness reaching for the same
   * capability spelled deno's way passed the import scan untouched: `jsr:@std/fs` is the
   * source-reading fake's tool with a different address on the envelope.
   *
   * The call-expression half was already built, which is what makes this list the LAST hole rather
   * than the first: `candidate-admission.ts` refuses `Deno.run` and `Deno.Command`, and
   * `triage/src/candidate-validation.ts` refuses `Deno.readTextFile`. The module-specifier half is
   * here.
   *
   * BOTH SPELLINGS OF EACH, because deno resolves a bare `@std/fs` through the project's import map
   * and a `jsr:@std/fs` directly, and a scan that knew only one of them would refuse the careful
   * cheat and admit the lazy one. The `node:` compat forms are already above.
   */
  "@std/fs",
  "jsr:@std/fs",
  "@std/net",
  "jsr:@std/net",
  "@std/http",
  "jsr:@std/http"
]);
var BASE_ALLOWED_IMPORTS = [
  "node:test",
  "node:assert",
  "node:assert/strict",
  "assert",
  "vitest",
  "jest",
  "@jest/globals",
  "bun:test",
  /*
   * DENO, 2026-08-18. `Deno.test` is a GLOBAL, so a minimal deno witness needs no import at all -
   * but a model writing TypeScript reaches for an assertion library, and `@std/assert` is the one
   * every deno repository uses. Absent from this list, every such candidate was refused
   * `undeclared-import` before a runner ever saw it.
   *
   * THIS IS THE AVA DEFECT OF 2026-08-15, PREDICTED BY THIS FILE'S OWN COMMENT AND THEN REPEATED.
   * `ava` was missing here, `import test from "ava"` is the only way an AVA test can be written, and
   * every correct AVA candidate died at admission. The lesson was written down; the next runner
   * still needed its entry adding by hand. BOTH deno spellings are here for the reason
   * `DENIED_MODULES` states: the bare form resolves through the project's import map, the `jsr:`
   * form resolves directly, and a model may write either.
   */
  "@std/assert",
  "jsr:@std/assert",
  "@std/expect",
  "jsr:@std/expect",
  "mocha",
  "jasmine",
  "ava",
  "tap",
  "chai",
  "expect"
];
var JSR_VERSION_PIN = /^(jsr:@[^/@]+\/[^/@]+)@[^/]*$/u;
function canonicalSpecifier(specifier) {
  const pinned = JSR_VERSION_PIN.exec(specifier);
  return pinned === null ? specifier : pinned[1];
}
var NUL_BYTE = String.fromCharCode(0);
var PATH_LIBRARY_IMPORTS = ["path", "node:path", "path/posix", "node:path/posix"];
function admitCandidate(input) {
  const findings = [];
  const maxSourceBytes = input.maxSourceBytes ?? 2e5;
  const maxTotalBytes = input.maxTotalBytes ?? 256e3;
  const maxFiles = input.maxFiles ?? 5;
  const supportFiles = input.supportFiles ?? [];
  const files = [{ path: input.testFile, source: input.testSource }, ...supportFiles];
  if (files.length > maxFiles) {
    findings.push({ rule: "file-count", detail: `${files.length} files, at most ${maxFiles} are admitted` });
  }
  const reserved = /* @__PURE__ */ new Set([input.testFile, ...input.allowedSupportPaths ?? []]);
  let totalBytes = 0;
  for (const file of files) {
    if (!isContainedRelativePath(file.path)) {
      findings.push({ rule: "path-not-contained", detail: file.path });
      continue;
    }
    if (!reserved.has(file.path)) {
      findings.push({ rule: "path-not-reserved", detail: file.path });
    }
    const bytes = Buffer.byteLength(file.source, "utf8");
    totalBytes += bytes;
    if (file.source.length === 0 || file.source.includes(NUL_BYTE)) {
      findings.push({ rule: "file-empty-or-binary", detail: file.path });
    }
    if (bytes > maxSourceBytes) {
      findings.push({ rule: "byte-cap", detail: `${file.path} is ${bytes} bytes, cap ${maxSourceBytes}` });
    }
  }
  if (totalBytes > maxTotalBytes) {
    findings.push({ rule: "byte-cap", detail: `bundle is ${totalBytes} bytes, cap ${maxTotalBytes}` });
  }
  const allowedBare = /* @__PURE__ */ new Set([...BASE_ALLOWED_IMPORTS, ...PATH_LIBRARY_IMPORTS, ...input.allowedBareImports ?? []]);
  const imports = /* @__PURE__ */ new Set();
  let testName = null;
  for (const file of files) {
    const code = stripLiteralsAndComments(file.source);
    const replaced = moduleMockSpecifiers(file.source);
    const requested = moduleSpecifiers(file.source).filter(
      (specifier) => DENIED_MODULES.has(specifier) && !replaced.has(specifier) && isSelfContainmentAllowedModule(specifier)
    );
    const selfContained = requested.length === 0 ? { proven: false, detail: "" } : provesSelfContainedUse({ source: file.source, requested });
    for (const specifier of moduleSpecifiers(file.source)) {
      imports.add(specifier);
      const module = canonicalSpecifier(specifier);
      if (DENIED_MODULES.has(module)) {
        if (replaced.has(specifier)) continue;
        if (isSelfContainmentAllowedModule(specifier) && selfContained.proven) continue;
        findings.push({
          rule: "denied-module",
          detail: isSelfContainmentAllowedModule(specifier) ? `${file.path} imports '${specifier}' and its use is not self-contained: ${selfContained.proven ? "" : selfContained.detail}. Reading a path inside the repository is the source-reading fake's route (recorded incident: seven fake proofs on one bun repository); building a fixture under a fresh mkdtemp root is admitted.` : `${file.path} imports '${specifier}' and does not replace it - the source-reading fake's route (recorded incident: seven fake proofs on one bun repository). A test double is admitted: add a mock declaration for '${specifier}' spelled exactly that way.`
        });
        continue;
      }
      if (!specifier.startsWith(".") && !allowedBare.has(module) && !allowedPackageRoot(specifier, allowedBare)) {
        findings.push({
          rule: "undeclared-import",
          detail: `${file.path} imports '${specifier}', which the project does not declare`
        });
      }
    }
    ACTUAL_MODULE_ESCAPE.lastIndex = 0;
    let actualMatch;
    while ((actualMatch = ACTUAL_MODULE_ESCAPE.exec(stripComments(file.source))) !== null) {
      const specifier = actualMatch[2];
      if (!DENIED_MODULES.has(specifier)) continue;
      findings.push({
        rule: "denied-module",
        detail: `${file.path} reaches past its own mock for the real '${specifier}' - replacing a module is admitted, unwrapping it is the source-reading fake's route`
      });
    }
    for (const pattern of DYNAMIC_CODE) {
      const match = pattern.exec(code);
      if (match !== null) {
        findings.push({ rule: "dynamic-code", detail: `${file.path}: ${match[0].trim()}` });
      }
    }
    for (const pattern of TARGET_REPLACEMENT) {
      const match = pattern.exec(code);
      if (match !== null) {
        findings.push({
          rule: "target-replacement",
          detail: `${file.path}: ${match[0].trim()} - the implementation-rewrite fake's route (recorded incident: two of three "proven" candidates on one repository)`
        });
      }
    }
    MODULE_MOCK_CALL.lastIndex = 0;
    let mockMatch;
    while ((mockMatch = MODULE_MOCK_CALL.exec(stripComments(file.source))) !== null) {
      if (mocksTargetModule(mockMatch[2], input.testFile, input.targetFile)) {
        findings.push({
          rule: "target-replacement",
          detail: `${file.path} mocks the module under test ('${mockMatch[2]}') - the implementation-rewrite fake's route; stubbing a third-party package is fine, replacing the subject is not`
        });
      }
    }
    if (testName === null) testName = firstDeclaredTestName(file.source);
  }
  if (testName === null) {
    findings.push({ rule: "no-test-declared", detail: "no it()/test() with a literal name" });
  }
  return { admitted: findings.length === 0, findings, imports: [...imports].sort(), testName };
}
var DYNAMIC_CODE = [
  /\beval\s*\(/u,
  /*
   * `new` IS OPTIONAL, and the missing `?:` was a live cheat channel rather than a tidiness bug.
   *
   * `Function("…")()` compiles a string exactly as `new Function("…")()` does. Two candidates on the
   * complete-fix benchmark's run B walked straight through the hole: each lifted the SOURCE TEXT of
   * the private function under test out of a generated script with a regex, compiled it with a bare
   * `Function(...)`, and asserted on the result - the source-reading fake with one extra hop, and
   * every admission rule passed it (`data/abloh-unfixed-gaps-investigation/report.md` BUG 2). Both
   * happened to die later on an unrelated TypeError; a slightly different generated script would
   * have earned a PROVEN badge for a test that proves nothing about the module's behaviour.
   *
   * `Function` IS NOT SPELLED ANYWHERE AN HONEST TEST NEEDS IT. `typeof x === "function"` is a
   * lowercase string inside a literal, which `stripLiteralsAndComments` has already blanked before
   * this pattern runs, and `assert.equal(typeof f, "function")` never writes the constructor. The
   * word boundary keeps `AsyncFunction` and a `.Function` member access out.
   */
  /\b(?:new\s+)?Function\s*\(/u,
  /\bimport\s*\(\s*[^'"`)]/u,
  /\brequire\s*\(\s*[^'"`)]/u,
  /\bprocess\s*\.\s*binding\b/u
];
var TARGET_REPLACEMENT = [
  /\brequire\s*\.\s*cache\b/u,
  /\bObject\s*\.\s*defineProperty\s*\(\s*(?:module|exports|globalThis)\b/u
];
var MODULE_MOCK_CALL = /\b(?:jest\s*\.\s*(?:mock|doMock)|vi\s*\.\s*(?:mock|doMock)|mock\s*\.\s*module|mockModule)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/gu;
function moduleMockSpecifiers(source) {
  const specifiers = /* @__PURE__ */ new Set();
  const scanned = stripComments(source);
  MODULE_MOCK_CALL.lastIndex = 0;
  let match;
  while ((match = MODULE_MOCK_CALL.exec(scanned)) !== null) specifiers.add(match[2]);
  return specifiers;
}
var ACTUAL_MODULE_ESCAPE = /\b(?:jest|vi)\s*\.\s*(?:importActual|requireActual)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/gu;
function mocksTargetModule(specifier, testFile, targetFile) {
  if (!specifier.startsWith(".")) return false;
  const from = testFile.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") from.pop();
    else from.push(segment);
  }
  const resolved = from.join("/");
  const stem2 = (path) => path.replace(/\.(?:m|c)?[jt]sx?$/u, "");
  return stem2(resolved) === stem2(targetFile);
}
function allowedPackageRoot(specifier, allowed) {
  for (const root of allowed) {
    if (root.includes(":")) continue;
    const isRoot = root.startsWith("@") ? root.split("/").length === 2 : !root.includes("/");
    if (isRoot && specifier.startsWith(`${root}/`)) return true;
  }
  return false;
}
function isContainedRelativePath(path) {
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return false;
  if (path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function moduleSpecifiers(source) {
  const blanked = stripLiteralsAndComments(source);
  const found = [];
  const patterns = [
    /\bimport\s+[^;'"`]*?from\s*['"]([^'"]+)['"]/gdu,
    /\bimport\s*['"]([^'"]+)['"]/gdu,
    /\bexport\s+[^;'"`]*?from\s*['"]([^'"]+)['"]/gdu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gdu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gdu
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(blanked)) !== null) {
      const at = match.indices?.[1];
      if (at === void 0) continue;
      found.push(source.slice(at[0], at[1]));
    }
  }
  return [...new Set(found)];
}
function firstDeclaredTestName(source) {
  const match = /\b(?:it|test)\s*(?:\.\s*\w+\s*)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/u.exec(source);
  return match === null ? null : match[2];
}
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += quote;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          out += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        out += source[j];
        const closed = source[j] === quote;
        j += 1;
        if (closed) break;
      }
      i = j;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k++) out += source[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
function stripLiteralsAndComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += quote;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          out += "  ";
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          out += quote;
          j += 1;
          break;
        }
        out += source[j] === "\n" ? "\n" : " ";
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k++) out += source[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// src/route-purity.ts
import ts2 from "typescript";
import { ROUTE_PURITY_RUNGS } from "@abloh/core";
var UNCLASSIFIED_ROUTE = Object.freeze({ rung: "unknown", route: [], contacts: [] });
var UNKNOWN = UNCLASSIFIED_ROUTE;
var MAX_FUNCTIONS = 400;
var MAX_ROUTE_HOPS = 12;
var FS_MODULES2 = /* @__PURE__ */ new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
var HOST_MODULES = /* @__PURE__ */ new Set(["os", "node:os"]);
var PROCESS_MODULES = /* @__PURE__ */ new Set(["child_process", "node:child_process"]);
var NETWORK_MODULES = /* @__PURE__ */ new Set([
  "net",
  "node:net",
  "http",
  "node:http",
  "https",
  "node:https",
  "dgram",
  "node:dgram",
  "tls",
  "node:tls"
]);
var WALLED_MODULES = /* @__PURE__ */ new Set([
  ...NETWORK_MODULES,
  "vm",
  "node:vm",
  "module",
  "node:module",
  "worker_threads",
  "node:worker_threads",
  "inspector",
  "node:inspector",
  "v8",
  "node:v8"
]);
var COMMAND_LINE_FORMS = /* @__PURE__ */ new Set(["exec", "execSync"]);
function runContact(binary) {
  return `run:${binary}`;
}
var CACHE_LIMIT2 = 16;
var cache2 = /* @__PURE__ */ new Map();
function classifyRoutePurity(input) {
  const analysis = analyze(input.source, input.fileName);
  if (analysis === null) return UNKNOWN;
  const start = innermostNamed(analysis.functions, input.line);
  if (start === null) return UNKNOWN;
  const route = shortestPublicRoute(analysis, start);
  if (route === null) return UNKNOWN;
  const contacts = reachableContacts(analysis, route[0]);
  return {
    rung: rungOf(contacts),
    route: route.map((fn) => fn.name),
    contacts: [...contacts].sort()
  };
}
function reachableContacts(analysis, entry) {
  const cached = analysis.closures.get(entry.id);
  if (cached !== void 0) return cached;
  const contacts = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set([entry.id]);
  const queue = [entry];
  while (queue.length > 0) {
    const fn = queue.shift();
    for (const contact of fn.contacts) contacts.add(contact);
    for (const callee of fn.calls) {
      const id = analysis.byName.get(callee);
      if (id === void 0 || seen.has(id)) continue;
      seen.add(id);
      queue.push(analysis.functions[id]);
    }
  }
  analysis.closures.set(entry.id, contacts);
  return contacts;
}
function rungOf(contacts) {
  let worst = "pure-exported";
  for (const contact of contacts) {
    worst = worstOf(worst, rungOfContact(contact));
  }
  return worst;
}
function rungOfContact(contact) {
  if (contact.startsWith("run:")) {
    const binary = contact.slice("run:".length);
    return ALLOWED_BINARIES.has(binary) ? "scaffolding-reachable" : "structurally-out-of-reach";
  }
  if (WALLED_MODULES.has(contact)) return "structurally-out-of-reach";
  return "exported-with-io";
}
function worstOf(a, b) {
  return ROUTE_PURITY_RUNGS.indexOf(a) >= ROUTE_PURITY_RUNGS.indexOf(b) ? a : b;
}
function innermostNamed(functions, line) {
  let best = null;
  for (const fn of functions) {
    if (fn.startLine > line || fn.endLine < line) continue;
    if (best === null || fn.startLine > best.startLine) best = fn;
  }
  return best;
}
function shortestPublicRoute(analysis, start) {
  if (start.exported) return [start];
  const seen = /* @__PURE__ */ new Set([start.id]);
  let level = [[start]];
  for (let hop = 0; hop < MAX_ROUTE_HOPS && level.length > 0; hop++) {
    const next = [];
    const arrived = [];
    for (const path of level) {
      const head = path[0];
      for (const callerId of analysis.callers.get(head.name) ?? []) {
        if (seen.has(callerId)) continue;
        const caller = analysis.functions[callerId];
        const extended = [caller, ...path];
        if (caller.exported) arrived.push(extended);
        else next.push(extended);
      }
    }
    for (const path of [...arrived, ...next]) seen.add(path[0].id);
    if (arrived.length > 0) return purest(analysis, arrived);
    level = next;
  }
  return null;
}
function purest(analysis, paths) {
  let best = paths[0];
  let bestRung = rungOf(reachableContacts(analysis, best[0]));
  for (const path of paths.slice(1)) {
    const rung = rungOf(reachableContacts(analysis, path[0]));
    if (ROUTE_PURITY_RUNGS.indexOf(rung) < ROUTE_PURITY_RUNGS.indexOf(bestRung)) {
      best = path;
      bestRung = rung;
    }
  }
  return best;
}
function analyze(source, fileName) {
  const key = `${fileName}\0${source}`;
  const cached = cache2.get(key);
  if (cached !== void 0) return cached;
  const built = parse(source, fileName);
  if (cache2.size >= CACHE_LIMIT2) {
    const oldest = cache2.keys().next();
    if (!oldest.done) cache2.delete(oldest.value);
  }
  cache2.set(key, built);
  return built;
}
function scriptKind2(fileName) {
  if (fileName.endsWith(".tsx")) return ts2.ScriptKind.TSX;
  if (/\.[cm]?ts$/u.test(fileName)) return ts2.ScriptKind.TS;
  if (fileName.endsWith(".jsx")) return ts2.ScriptKind.JSX;
  return ts2.ScriptKind.JS;
}
function syntaxErrorCount2(sourceFile) {
  const withDiagnostics = sourceFile;
  return withDiagnostics.parseDiagnostics?.length ?? 0;
}
function parse(source, fileName) {
  const sourceFile = ts2.createSourceFile(fileName, source, ts2.ScriptTarget.Latest, false, scriptKind2(fileName));
  if (syntaxErrorCount2(sourceFile) > 0) return null;
  const modules = moduleBindings2(sourceFile);
  const exportedNames2 = exportClauseNames(sourceFile);
  const functions = [];
  const lineOf = (offset) => sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
  const record = (node, name, exported) => {
    if (functions.length >= MAX_FUNCTIONS) return;
    const body = node.body;
    if (body === void 0) return;
    const fn = {
      id: functions.length,
      name,
      startLine: lineOf(node.getStart(sourceFile)),
      endLine: lineOf(body.end),
      exported: exported || exportedNames2.has(name),
      calls: /* @__PURE__ */ new Set(),
      contacts: /* @__PURE__ */ new Set()
    };
    readBody(body, modules, fn);
    functions.push(fn);
  };
  const visit = (node, container, exported) => {
    for (const named of namedFunctionsOf(node, container, exported)) {
      record(named.node, named.name, named.exported);
    }
    for (const child of childrenOf(node)) {
      visit(child.node, child.container ?? container, child.exported ?? exported);
    }
  };
  visit(sourceFile, null, false);
  for (const produced of producedBindings(sourceFile, exportedNames2)) {
    if (functions.length >= MAX_FUNCTIONS) break;
    const fn = {
      id: functions.length,
      name: produced.name,
      startLine: lineOf(produced.declaration.getStart(sourceFile)),
      endLine: lineOf(produced.initializer.end),
      exported: produced.exported,
      calls: /* @__PURE__ */ new Set(),
      contacts: /* @__PURE__ */ new Set()
    };
    readCall(produced.initializer, modules, fn);
    readBody(produced.initializer, modules, fn);
    functions.push(fn);
  }
  const byName = /* @__PURE__ */ new Map();
  for (const fn of functions) if (!byName.has(fn.name)) byName.set(fn.name, fn.id);
  const callers = /* @__PURE__ */ new Map();
  for (const fn of functions) {
    for (const callee of fn.calls) {
      const list = callers.get(callee);
      if (list === void 0) callers.set(callee, [fn.id]);
      else list.push(fn.id);
    }
  }
  return { functions, callers, byName, closures: /* @__PURE__ */ new Map() };
}
function moduleBindings2(sourceFile) {
  const bindings = /* @__PURE__ */ new Map();
  const remember = (local, specifier) => {
    if (FS_MODULES2.has(specifier) || HOST_MODULES.has(specifier) || PROCESS_MODULES.has(specifier) || WALLED_MODULES.has(specifier)) {
      bindings.set(local, specifier);
    }
  };
  const walk = (node) => {
    if (ts2.isImportDeclaration(node) && ts2.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.namedBindings !== void 0) {
        if (ts2.isNamespaceImport(clause.namedBindings)) {
          remember(clause.namedBindings.name.text, specifier);
        } else {
          for (const element of clause.namedBindings.elements) remember(element.name.text, specifier);
        }
      }
      if (clause?.name !== void 0) remember(clause.name.text, specifier);
    }
    if (ts2.isVariableDeclaration(node) && node.initializer !== void 0 && ts2.isCallExpression(node.initializer) && ts2.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require" && node.initializer.arguments.length > 0 && ts2.isStringLiteral(node.initializer.arguments[0])) {
      const specifier = node.initializer.arguments[0].text;
      if (ts2.isIdentifier(node.name)) remember(node.name.text, specifier);
      else if (ts2.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts2.isIdentifier(element.name)) remember(element.name.text, specifier);
        }
      }
    }
    ts2.forEachChild(node, walk);
  };
  walk(sourceFile);
  return bindings;
}
function producedBindings(sourceFile, exportedNames2) {
  const out = [];
  for (const statement of sourceFile.statements) {
    if (!ts2.isVariableStatement(statement)) continue;
    const declaredExport = hasExportModifier(statement);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts2.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      if (initializer === void 0 || !ts2.isCallExpression(initializer)) continue;
      if (ts2.isIdentifier(initializer.expression) && initializer.expression.text === "require") continue;
      if (initializer.expression.kind === ts2.SyntaxKind.ImportKeyword) continue;
      const name = declaration.name.text;
      out.push({ name, declaration, initializer, exported: declaredExport || exportedNames2.has(name) });
    }
  }
  return out;
}
function exportClauseNames(sourceFile) {
  const names = /* @__PURE__ */ new Set();
  const walk = (node) => {
    if (ts2.isExportDeclaration(node) && node.exportClause !== void 0 && ts2.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        names.add((element.propertyName ?? element.name).text);
      }
    }
    if (ts2.isExpressionStatement(node) && ts2.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts2.SyntaxKind.EqualsToken && ts2.isPropertyAccessExpression(node.expression.left) && ts2.isIdentifier(node.expression.right)) {
      const target = node.expression.left.expression;
      const onExports = ts2.isIdentifier(target) && target.text === "exports" || ts2.isPropertyAccessExpression(target) && ts2.isIdentifier(target.expression) && target.expression.text === "module" && target.name.text === "exports";
      if (onExports) names.add(node.expression.right.text);
    }
    ts2.forEachChild(node, walk);
  };
  walk(sourceFile);
  return names;
}
function namedFunctionsOf(node, container, exported) {
  if (ts2.isFunctionDeclaration(node) && node.name !== void 0) {
    return [{ node, name: node.name.text, exported: hasExportModifier(node) }];
  }
  if (ts2.isVariableStatement(node)) {
    const declared = hasExportModifier(node);
    const out = [];
    for (const declaration of node.declarationList.declarations) {
      if (!ts2.isIdentifier(declaration.name) || declaration.initializer === void 0) continue;
      const initializer = declaration.initializer;
      if (ts2.isArrowFunction(initializer) || ts2.isFunctionExpression(initializer)) {
        out.push({ node: initializer, name: declaration.name.text, exported: declared });
      }
    }
    return out;
  }
  if (ts2.isMethodDeclaration(node) && ts2.isIdentifier(node.name)) {
    const name = container === null ? node.name.text : `${container}.${node.name.text}`;
    return [{ node, name, exported }];
  }
  return [];
}
function childrenOf(node) {
  const out = [];
  if (ts2.isClassDeclaration(node)) {
    const name = node.name?.text ?? null;
    const exported = hasExportModifier(node);
    for (const member of node.members) out.push({ node: member, container: name, exported });
    return out;
  }
  ts2.forEachChild(node, (child) => {
    out.push({ node: child });
  });
  return out;
}
function hasExportModifier(node) {
  const modifiers = node.modifiers;
  return modifiers?.some((modifier) => modifier.kind === ts2.SyntaxKind.ExportKeyword) === true;
}
function readBody(body, modules, fn) {
  const walk = (node) => {
    if (node !== body && isNamedFunctionBoundary(node)) return;
    if (ts2.isCallExpression(node)) {
      readCall(node, modules, fn);
    }
    ts2.forEachChild(node, walk);
  };
  ts2.forEachChild(body, walk);
}
function isNamedFunctionBoundary(node) {
  if (ts2.isFunctionDeclaration(node) && node.name !== void 0) return true;
  if (ts2.isMethodDeclaration(node)) return true;
  if (ts2.isVariableStatement(node)) {
    return node.declarationList.declarations.some(
      (declaration) => ts2.isIdentifier(declaration.name) && declaration.initializer !== void 0 && (ts2.isArrowFunction(declaration.initializer) || ts2.isFunctionExpression(declaration.initializer))
    );
  }
  return false;
}
function readCall(node, modules, fn) {
  const callee = node.expression;
  if (ts2.isIdentifier(callee)) {
    fn.calls.add(callee.text);
    const specifier = modules.get(callee.text);
    if (specifier !== void 0) contactFor(specifier, callee.text, node, fn);
    return;
  }
  if (ts2.isPropertyAccessExpression(callee)) {
    fn.calls.add(callee.name.text);
    if (ts2.isIdentifier(callee.expression)) {
      const specifier = modules.get(callee.expression.text);
      if (specifier !== void 0) contactFor(specifier, callee.name.text, node, fn);
    }
    if (ts2.isIdentifier(callee.expression)) fn.calls.add(`${callee.expression.text}.${callee.name.text}`);
  }
}
function contactFor(specifier, binding, node, fn) {
  if (PROCESS_MODULES.has(specifier)) {
    fn.contacts.add(runContact(binaryOf(binding, node)));
    return;
  }
  fn.contacts.add(specifier);
}
var SHELL_CHAINING = /[|&;<>`]|\$\(/u;
function binaryOf(binding, node) {
  const first = node.arguments[0];
  if (first === void 0) return "?";
  if (!COMMAND_LINE_FORMS.has(binding)) {
    return ts2.isStringLiteral(first) ? first.text : "?";
  }
  const whole = wholeText(first);
  if (whole !== null && !SHELL_CHAINING.test(whole)) return firstToken(whole) ?? "?";
  const leading = firstToken(leadingText(first) ?? "");
  return leading !== null && !ALLOWED_BINARIES.has(leading) ? leading : "?";
}
function firstToken(text) {
  const token = text.trim().split(/\s+/u)[0];
  return token === void 0 || token.length === 0 ? null : token;
}
function wholeText(node) {
  if (ts2.isStringLiteral(node) || ts2.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts2.isBinaryExpression(node) && node.operatorToken.kind === ts2.SyntaxKind.PlusToken) {
    const left = wholeText(node.left);
    const right = wholeText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}
function leadingText(node) {
  let current = node;
  while (ts2.isBinaryExpression(current) && current.operatorToken.kind === ts2.SyntaxKind.PlusToken) {
    current = current.left;
  }
  if (ts2.isStringLiteral(current) || ts2.isNoSubstitutionTemplateLiteral(current)) return current.text;
  if (ts2.isTemplateExpression(current)) return current.head.text;
  return null;
}

// src/test-shape.ts
var TEST_SHAPES = ["unit", "service-backed", "harness-level"];
var POLICY_SKIP_REASONS = ["browser-dependent", "open-network"];
var BROWSER_DRIVERS = /* @__PURE__ */ new Set([
  "playwright",
  "playwright-core",
  "@playwright/test",
  "puppeteer",
  "puppeteer-core",
  "selenium-webdriver",
  "webdriverio",
  "cypress"
]);
function routeTestShape(input) {
  const specifiers = new Set(input.moduleSpecifiers);
  for (const specifier of specifiers) {
    if (BROWSER_DRIVERS.has(rootPackage(specifier))) {
      return {
        kind: "skip",
        policy: "browser-dependent",
        why: BROWSER_DRIVEN_SKIP_REASON
      };
    }
  }
  const suite = new Set(input.suitePackages);
  const shared = [...specifiers].map((specifier) => rootPackage(specifier)).filter((name) => !name.startsWith(".") && !name.startsWith("/") && suite.has(name));
  if (input.declaredServices.length > 0 && shared.length > 0) {
    return {
      kind: "route",
      shape: "service-backed",
      why: `this repository declares ${input.declaredServices.join(" and ")} and its own tests exercise this file's dependencies, so a test here can use them`,
      instructions: serviceInstructions(input.declaredServices, input.purity, input.exportedNames)
    };
  }
  const networkContacts = input.purity.contacts.filter((contact) => NETWORK_MODULES.has(contact));
  if (networkContacts.length > 0) {
    return { kind: "skip", policy: "open-network", why: OPEN_NETWORK_SKIP_REASON };
  }
  if (input.purity.rung === "unknown" || input.purity.rung === "structurally-out-of-reach") {
    return {
      kind: "route",
      shape: "harness-level",
      why: input.purity.rung === "unknown" ? "no exported function in this file reaches this code, so a unit test cannot call it directly" : `the route runs ${input.purity.contacts.join(", ")}, which a self-contained test may not run in-process`,
      instructions: harnessInstructions(input.exportedNames, input.purity)
    };
  }
  return {
    kind: "route",
    shape: "unit",
    why: input.purity.contacts.length === 0 ? `the shortest public route is ${describeRoute(input.purity)} and it touches nothing outside itself` : `the shortest public route is ${describeRoute(input.purity)}, touching ${input.purity.contacts.join(", ")}`,
    instructions: unitInstructions(input.purity)
  };
}
var BROWSER_DRIVEN_SKIP_REASON = "this code is only reachable by driving a real browser, which this run does not do, so no test was asked for and nothing was charged";
var OPEN_NETWORK_SKIP_REASON = "this code's only route opens a network connection, and a sealed proof runs with no network at all, so no test was asked for and nothing was charged";
function isPolicySkip(reason) {
  return reason === BROWSER_DRIVEN_SKIP_REASON || reason === OPEN_NETWORK_SKIP_REASON;
}
var MAX_SUITE_FILES_SCANNED = 60;
function suiteTestPackages(input) {
  const found = /* @__PURE__ */ new Set();
  for (const path of input.testFilePaths.slice(0, MAX_SUITE_FILES_SCANNED)) {
    const source = input.readFile(path);
    if (source === null) continue;
    for (const specifier of input.specifiersOf(source)) {
      const name = rootPackage(specifier);
      if (!name.startsWith(".") && !name.startsWith("/")) found.add(name);
    }
    if (found.size >= MAX_SUITE_PACKAGES) break;
  }
  return [...found];
}
var MAX_SUITE_PACKAGES = 400;
function describeRoute(purity) {
  return purity.route.length === 0 ? "the exported function itself" : purity.route.join(" -> ");
}
function rootPackage(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? specifier;
}
function unitInstructions(purity) {
  const lines = [
    `TEST SHAPE: a plain unit test. The shortest public route to this code is ${describeRoute(purity)}. Call that entry point directly with plain data and assert on what the real code returns.`
  ];
  if (purity.contacts.length > 0) {
    lines.push(
      `That route touches ${purity.contacts.join(", ")}. Build whatever it reads under your own temp root as rule 5 shows, and do not mock it away - the point is to run the real code.`
    );
  }
  return lines;
}
function serviceInstructions(services, purity, exportedNames2) {
  const named = services.join(" and ");
  return [
    `TEST SHAPE: this run has ${named} running, declared in this repository's abloh.yml and reachable at exactly the address its own CI uses - the same host, port and credentials its tests already use.`,
    "If reaching this code needs one of them, connect exactly the way the example test above connects - the same client, the same configuration source, the same helper if there is one. Do not fake the client and do not stand up your own substitute: a test against a fake proves the fake works. Create whatever rows, keys or schema you need under a name unique to this test and remove them at the end, so the test passes beside the repository's own tests and when it runs twice.",
    /* THE OTHER SHAPE, IN FULL, because a gap routed here that needs no database still needs to be
       told how to reach its own code. The leading `TEST SHAPE:` is stripped: this block already
       opened with one, and two of them in one prompt reads as two instructions. */
    `If reaching this code needs no service, write that test instead: ${(purity.rung === "unknown" || purity.rung === "structurally-out-of-reach" ? harnessInstructions(exportedNames2, purity)[0] : unitInstructions(purity)[0]).replace(/^TEST SHAPE: /u, "")}`
  ];
}
function harnessInstructions(exportedNames2, purity) {
  const entry = exportedNames2.length === 0 ? "the file's public entry point" : `one of this file's exports (${exportedNames2.slice(0, 8).join(", ")})`;
  const lines = [
    `TEST SHAPE: a harness-level test through ${entry}. Do not try to reach the changed code directly - drive the public entry point that leads to it and assert on what the whole call does differently.`,
    "Set up the inputs that make the entry point take the branch the change is on, under your own temp root as rule 5 shows. Assert on the entry point's own result, its thrown error, or the files it wrote - whatever the real code produces."
  ];
  if (purity.contacts.some((contact) => contact.startsWith("run:"))) {
    lines.push(
      "The route runs a subprocess. Let it run rather than replacing it, and if the only binary it can run is one this run does not allow, assert on the failure the real code produces when that binary is absent - that is still a behaviour the change can alter."
    );
  }
  return lines;
}

// src/context.ts
var WINDOW = 40;
function buildGapContext(input) {
  const absolute = join(input.repoDir, input.gap.file);
  const source = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
  const lines = source.split("\n");
  const enclosing = enclosingFunction(source, input.gap.file, input.gap.startLine);
  const start = enclosing?.startLine ?? Math.max(1, input.gap.startLine - WINDOW / 2);
  const end = enclosing?.endLine ?? Math.min(lines.length, input.gap.startLine + WINDOW / 2);
  const routePurity = classifyRoutePurity({ source, fileName: input.gap.file, line: input.gap.startLine });
  const specifiers = moduleSpecifiers(source);
  const names = exportedNames(source);
  return {
    slice: lines.slice(start - 1, end).join("\n"),
    sliceStartLine: start,
    enclosingFunction: enclosing !== null,
    mutatedLine: lines[input.gap.startLine - 1] ?? "",
    importSpecifier: importSpecifierFor({
      testFile: input.testFile,
      targetFile: input.gap.file,
      moduleFormat: input.moduleFormat,
      runner: input.runner
    }),
    exportedNames: names,
    exportSignatures: exportSignatures(source),
    exportedTypes: exportedTypes(source),
    defaultExportName: defaultExportName(source),
    routePurity,
    moduleSpecifiers: specifiers,
    shape: routeTestShape({
      purity: routePurity,
      moduleSpecifiers: specifiers,
      declaredServices: input.declaredServices ?? [],
      suitePackages: input.suitePackages ?? [],
      exportedNames: names
    })
  };
}
var MAX_SIGNATURE_CHARS = 400;
var MAX_TYPE_CHARS = 1200;
var MAX_SIGNATURES = 60;
var MAX_TYPES = 25;
function exportSignatures(source) {
  const signatures = [];
  const seen = /* @__PURE__ */ new Set();
  const declaration = /^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+\w+/gmu;
  let match;
  while ((match = declaration.exec(source)) !== null && signatures.length < MAX_SIGNATURES) {
    const line = cutSignature(source, match.index + match[0].length, match[0]);
    if (line === null) continue;
    const collapsed = line.replace(/\s+/gu, " ").trim();
    if (collapsed.length > MAX_SIGNATURE_CHARS || seen.has(collapsed)) continue;
    seen.add(collapsed);
    signatures.push(collapsed);
  }
  return signatures;
}
function cutSignature(source, from, heading) {
  let depth = 0;
  const until = Math.min(source.length, from + MAX_SIGNATURE_CHARS);
  for (let i = from; i < until; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === "=" && source[i + 1] === ">") return `${heading}${source.slice(from, i + 2)}`;
      if (ch === "{" || ch === ";" || ch === "`") return `${heading}${source.slice(from, i)}`;
    }
  }
  return null;
}
function exportedTypes(source) {
  const declarations = [];
  const heading = /^[ \t]*export\s+(?:declare\s+)?(?:interface|type)\s+\w+/gmu;
  let match;
  while ((match = heading.exec(source)) !== null && declarations.length < MAX_TYPES) {
    const body = /\binterface\b/u.test(match[0]) ? balancedBraceBody(source, match.index) : aliasBody(source, match.index);
    if (body === null || body.length > MAX_TYPE_CHARS) continue;
    declarations.push(body.trimEnd());
  }
  return declarations;
}
function balancedBraceBody(source, from) {
  const open = source.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return null;
}
function aliasBody(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && ch === ";") return source.slice(from, i + 1);
    else if (depth === 0 && ch === "\n") {
      const next = /^\s*[|&]/u.test(source.slice(i));
      if (!next) return source.slice(from, i);
    }
  }
  return null;
}
function defaultExportName(source) {
  const patterns = [
    /\bexport\s+default\s+(?:async\s+)?function\s+(\w+)/u,
    /\bexport\s+default\s+class\s+(\w+)/u,
    /\bexport\s+default\s+(\w+)\s*;?\s*$/mu,
    /\bmodule\.exports\s*=\s*(\w+)\s*;?\s*$/mu
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match !== null && /^\w+$/u.test(match[1]) && match[1] !== "function" && match[1] !== "class") {
      return match[1];
    }
  }
  return null;
}
function exportedNames(source) {
  const names = /* @__PURE__ */ new Set();
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+(\w+)/gu,
    /\bexport\s+(?:const|let|var|class)\s+(\w+)/gu,
    /\bexport\s*\{([^}]*)\}/gu,
    /\bmodule\.exports\.(\w+)\s*=/gu,
    /\bexports\.(\w+)\s*=/gu
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      for (const part of match[1].split(",")) {
        const name = part.split(/\s+as\s+/u).pop()?.trim();
        if (name !== void 0 && /^\w+$/u.test(name)) names.add(name);
      }
    }
  }
  return [...names].sort();
}
var LITERAL_SPECIFIER_RUNNERS = /* @__PURE__ */ new Set(["node-test", "deno"]);
function importSpecifierFor(input) {
  const fromDir = dirname(input.testFile);
  let specifier = relative(fromDir, input.targetFile);
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  const name = basename(specifier);
  if (input.moduleFormat === "cjs") {
    return specifier.slice(0, specifier.length - name.length) + name.replace(/\.(?:m|c)?[jt]sx?$/u, "");
  }
  if (LITERAL_SPECIFIER_RUNNERS.has(input.runner) && /\.tsx?$/u.test(specifier)) return specifier;
  return specifier.replace(/\.tsx?$/u, ".js");
}

// src/placement.ts
import { dirname as dirname2, basename as basename2, extname, join as join2 } from "path";
function placeCandidate(input) {
  const anchor = chooseAnchor(input.testFilePaths, input.targetFile);
  if (anchor === null) {
    const extension = extname(input.targetFile) === ".ts" ? ".ts" : ".js";
    return {
      testFile: join2(dirname2(input.targetFile), `${stem(input.targetFile)}.abloh-${input.discriminator}.test${extension}`),
      anchor: null
    };
  }
  const anchorExtension = extname(anchor);
  const infix = /\.spec\./u.test(basename2(anchor)) ? "spec" : "test";
  return {
    testFile: join2(
      dirname2(anchor),
      `${stem(input.targetFile)}.abloh-${input.discriminator}.${infix}${anchorExtension}`
    ),
    anchor
  };
}
function chooseAnchor(testFilePaths, targetFile) {
  if (testFilePaths.length === 0) return null;
  const targetSegments = dirname2(targetFile).split("/");
  let best = null;
  for (const path of testFilePaths) {
    const segments = dirname2(path).split("/");
    let shared = 0;
    while (shared < segments.length && shared < targetSegments.length && segments[shared] === targetSegments[shared]) {
      shared += 1;
    }
    if (best === null || shared > best.shared || shared === best.shared && path.length < best.path.length) {
      best = { path, shared };
    }
  }
  return best === null ? null : best.path;
}
function stem(file) {
  return basename2(file).replace(/\.(?:m|c)?[jt]sx?$/u, "");
}

// src/prompt.ts
var PROMPT_VERSION = "marigold-generation/8";
var TRIAGE_PROMPT_VERSION = "marigold-triage/1";
var DECLINE_REASONS = ["not-self-containable", "cannot-distinguish", "structurally-untestable"];
var WORKED_TEMP_ROOT_EXAMPLE = [
  "const root = mkdtempSync(join(tmpdir(), 'gap-'));",
  "writeFileSync(join(root, 'input.json'), '{}');",
  "execFileSync('git', ['init', '-q'], { cwd: root });"
];
function importRules() {
  return [
    "4. Import the test framework, the assertion library, `node:path`, and ANY module of the repository under test - the file the change is in, and every other module of this repository you need to build the thing under test. Import them by relative path, the way this repository's own tests import them, and reach for its real factory, loader or entry point rather than hand-rolling a stand-in for it (rule 2). A third-party package is admitted only where this project already declares it. What stays refused is READING a repository path as data - opening the source under test, or a fixture beside it, as a file - and rule 5 says where a path may come from. Importing a filesystem, process or network module so that you can REPLACE it is allowed: `import { fork } from 'child_process'` is admitted when the same file declares `vi.mock('child_process', ...)` (or the jest equivalent) for that exact specifier. Spell the module the same way in both places, and do not reach for the real one with importActual. Network modules are refused outright.",
    "   When the runner is `node:test` AND the file under test ends in `.ts` or `.tsx`, import it by that literal path - `../src/cart.ts`, not `../src/cart.js`, overriding the `import the code under test as:` line above if it disagrees - because node runs the TypeScript by stripping its types and resolves the specifier exactly as written, with no `.js`-to-`.ts` remap; under every other runner, and in a TypeScript project that compiles before it runs, the `.js` spelling above is the correct one and stands.",
    "5. The test must be self-contained. You MAY use `node:fs`, `node:os` and `node:child_process` for real, without mocking them, under ALL of the following - a test that breaks any one of them is refused:",
    "   a. Create your own root first: `const root = mkdtempSync(join(tmpdir(), 'something-'))`. Every path you read, write, stat or delete must be built from it with `join(root, '...')`. Nothing may come from the checkout - not the file under test, not a fixture beside it, and not `__dirname`, `import.meta.url`, `process.cwd()`, `process.env` or `require.resolve`, each of which is refused on sight.",
    "   b. No `..` in any path segment, and no symlink, hard link, copy or realpath call - every one of those can point back at the checkout and the check cannot follow one.",
    "   c. The only binary you may run is `git`, only through `execFileSync('git', [args], { cwd })` with a cwd under your root, and only with plain subcommands and flags: `init`, `add`, `commit`, `config`, `checkout`, `branch`, `tag`, `-m`, `-q`, `-A`, `-b`, `-C <a path under your root>`. `-c anything=anything`, `--git-dir`, `--work-tree`, `--exec-path`, `--global`, an `env` option, and `exec`/`execSync` are all refused. Every argument must be a string literal or a path built from your root; arguments assembled at runtime cannot be checked and are refused.",
    "   d. Still no network, and no clock you do not control.",
    "   The shape that is admitted, copied literally - the root is made first and every path and cwd after it is built from that name:",
    "   ```",
    `   ${WORKED_TEMP_ROOT_EXAMPLE.join("\n   ")}`,
    "   ```",
    "   Anything that does not read like those three lines is refused, however close it looks: a path that is not `join(root, ...)`, a root that came from anywhere but a `mkdtemp` call in this test, or a process with no `cwd` under the root.",
    /* /7, 2026-08-26. This line used to end rule 5 by inviting a decline, and it was the single
       largest source of them: twenty of round 3's thirty-one processed items came back as "no
       self-contained test can reach this code". That answer was TRUE and the question was wrong -
       the engine only ever asked for one shape of test. Each gap now arrives with the shape that
       reaches it, so the line points at that block rather than at the decline vocabulary. */
    "   If a plain self-contained test cannot reach the code, do not force one and do not decline: read that gap's TEST SHAPE line below and write the shape it names. A gap that genuinely cannot be reached at all in this run is not asked about here."
  ];
}
function exportsLine(context) {
  if (context.exportSignatures.length > 0) {
    const lines = ["exports available, with their exact signatures - call them as written:"];
    for (const signature of context.exportSignatures) lines.push(`  ${signature}`);
    if (context.defaultExportName !== null) {
      lines.push(`  default export: ${context.defaultExportName} (import it WITHOUT braces)`);
    }
    if (context.exportedTypes.length > 0) {
      lines.push("the types those signatures name, so your assertions use the real field names:");
      lines.push("```");
      lines.push(...context.exportedTypes);
      lines.push("```");
    }
    return lines.join("\n");
  }
  const named = context.exportedNames.length > 0 ? `exports available: ${context.exportedNames.join(", ")}` : null;
  const fallback = context.defaultExportName === null ? null : `default export: ${context.defaultExportName} (import it WITHOUT braces)`;
  if (named !== null && fallback !== null) return `${named}; ${fallback}`;
  if (named !== null) return named;
  if (fallback !== null) return fallback;
  return "exports available: none detected; read the slice below for the entry point";
}
function buildBatchGenerationPrompt(input) {
  const gaps = input.items.map((item, index) => {
    const feedback = input.ledger.promptBlock(item.gap.gapId);
    return [
      `### gap ${index + 1} - id: ${item.gap.gapId}`,
      `file: ${item.gap.file}`,
      `the test you write goes at: ${item.testFile}`,
      `import the code under test as: ${item.context.importSpecifier}`,
      exportsLine(item.context),
      "",
      item.context.enclosingFunction ? `The function containing the change (from line ${item.context.sliceStartLine}):` : `A window around the change (from line ${item.context.sliceStartLine}); the enclosing function could not be identified:`,
      "```",
      item.context.slice,
      "```",
      "",
      /*
       * THE SHAPE THIS GAP NEEDS, from the reachability router.
       *
       * WHAT CHANGED, AND WHY IT IS SAFE. `context.ts` refused to put the route classification in
       * the prompt because telling a model its gap is out of reach invites a decline. This is the
       * opposite instruction: it never names a rung and never says a gap is hard, it names the
       * shape of test that reaches this code and tells the model how to write one. Twenty of round
       * 3's thirty-one processed items died on a model correctly saying a plain unit test cannot
       * reach the code it was given (`data/abloh-proposal-loop-autopsy` §5.2), which is what a
       * prompt that only ever asks for one shape gets back.
       *
       * ABSENT IS THE OLD PROMPT. A caller that builds an item without a routed shape asks exactly
       * what this prompt asked before the router existed.
       */
      ...item.context.shape !== void 0 && item.context.shape.kind === "route" ? ["", ...item.context.shape.instructions] : [],
      "",
      `The mutation, at line ${item.gap.startLine}, mutator ${item.gap.mutator}:`,
      `  before: ${item.gap.originalText}`,
      `  after:  ${item.gap.replacement}`,
      ...item.siblingReplacements === void 0 || item.siblingReplacements.length === 0 ? [] : [
        "",
        `The SAME expression is also mutated ${item.siblingReplacements.length} other way(s), each replacing the same text above:`,
        ...item.siblingReplacements.map((replacement) => `  after:  ${replacement}`),
        "One test that distinguishes several of these is worth more than one that distinguishes only the first; write the test that pins down what the real expression accepts and rejects."
      ],
      "",
      feedback === "" ? "No previous attempt on this gap." : `Previous attempts on this gap, and exactly how they failed:
${feedback}`
    ].join("\n");
  }).join("\n\n");
  return [
    "You are writing tests that detect a specific bug.",
    "",
    `For each gap below, write ONE test that FAILS when the mutated code is in place and PASSES against the real code. The project runs its tests with ${input.runner} and uses ${input.moduleFormat} module resolution.`,
    "",
    "Rules, all of which have cost this product real proofs when broken:",
    "1. Test BEHAVIOUR through the module's public entry points. A test that reads a source file as text and asserts on its contents passes and proves nothing; it will be refused.",
    /* THE PUBLIC-API RULE (Kenneth, 2026-08-14, from the pool-2 acceptance run's forensic read),
       carried here from the witness ask under architecture G. 6 of 18 witnesses on that run built a
       fake of the HOST object - a hand-rolled plugin factory - and drove the target through it.
       Those tests prove something about the fake, they read as foreign in a repository that never
       writes that style, and a maintainer cannot merge one. Rule 2 already banned faking the
       function under test; the second sentence is what extends it to the object that hosts it. */
    /* AMENDED TO /5 ON 2026-08-23, Kenneth's ruling from the requalification sweep
       (data/abloh-cost-requal-aws-sweep/report.md section 8.2, measured 16 -> 22 of 36 on the
       node-cron gap set): the /3 sentence contradicted rule 4's explicit platform-mock permission
       over fork-heavy code, and the two-value decline vocabulary reported the collision as
       "not self-containable" - a false statement about the customer's code. The ban on faking the
       SUBJECT stays; platform boundaries are explicitly rule 4's jurisdiction. */
    "2. Do not stub, mock, or replace the function under test, and do not assert on a replacement you wrote: that proves your replacement works, and it will be refused. This covers the object that HOSTS it - do not hand-roll a stand-in for the module under test and drive the target through it. Build the real thing the way the repository's own tests build it, drive it through its public API, and assert on what the REAL code does. Replacing a platform boundary the code merely depends on - a process, the filesystem, a timer, a clock - is NOT that, and rule 4 governs when it is allowed; mocking one of those and then asserting on the real code's behaviour is exactly right.",
    "3. Do not weaken an assertion to make a test pass. If your test cannot distinguish the mutation, say so in `note` and return no test for that gap; a truthful blank is worth more than a test that passes both ways.",
    ...importRules(),
    "",
    input.exampleTest === void 0 ? "No example test was available; follow ordinary conventions for the runner named above." : `An existing test from this repository, for conventions (imports, style, helpers) - ${input.exampleTest.path}:
\`\`\`
${input.exampleTest.source}
\`\`\``,
    "",
    gaps,
    "",
    /* NDJSON: one JSON object per gap, one per line, no wrapper.
       A truncated stream of one big object is unparseable and worth nothing; a truncated stream of
       per-gap lines yields every gap already written. */
    "Reply with ONE JSON object PER LINE and nothing else - no wrapper object, no array, no markdown fence.",
    "Each line:",
    '{ "gapId": "<the id above>", "testName": "<the exact name inside it(...)>", "testBody": "<the complete test file source>", "declined": "<only when testBody is empty: not-self-containable | cannot-distinguish | structurally-untestable>", "note": "<optional: why this gap is hard, or why you returned no test>" }',
    "Emit each line as soon as that gap's test is written, so a line already sent is never lost.",
    /* WHICH TRUTH THE BLANK IS. Rule 3 asks for a truthful blank and got one seventeen times on a
       package whose logic is private behind a container build - and every one of them was reported
       as "the model returned no test", which reads as giving up. Naming the reason is what turns
       those into a statement about the customer's code. See `DECLINE_REASONS`. */
    "When you cannot write an honest test for a gap, give it an empty testBody and say WHY in `declined`:",
    /* /7, 2026-08-26: this value now costs the engine something to receive, so the prompt says what
       it means. Each gap carries the shape that reaches it, and a decline here says that shape was
       wrong for this gap - which is a fact worth having, and a different fact from "your rules
       stopped me". `note` is what makes it actionable, so it is now required rather than suggested. */
    '  "not-self-containable" - you followed this gap\'s TEST SHAPE line and it still does not reach the code. Say in `note` what the shape asked for, what you tried, and what stopped it; that is how the shape gets fixed.',
    '  "cannot-distinguish" - you can reach the code, and no assertion you could write tells the two versions apart.',
    /* THE WALL, SAID OUT LOUD. Distinct from "not-self-containable" on purpose: that one says our
       rules stopped you, and our rules can move. This one says nothing we could permit would help,
       which is a fact about the customer's code and is reported to them as one. See
       `DECLINE_REASONS`. */
    '  "structurally-untestable" - the only route to this code runs through something live that no test can stand up in-process: a running container or daemon, a real network peer, a real clock. Rule 5 could be widened to anything and this gap would still be out of reach. Use this rather than "not-self-containable" when the obstacle is the world, not our rules, and name the live thing in `note`.',
    "Both are worth more than a test that passes either way. Omitting a gap entirely says neither, so prefer the blank with a reason."
  ].join("\n");
}
function buildTriagePrompt(input) {
  return [
    "A mutation testing run changed one expression and the test suite did not notice.",
    "Decide whether the change is EQUIVALENT (it cannot alter observable behaviour for any input) or a REAL GAP (some input distinguishes it, so the suite is missing a test).",
    "",
    `file: ${input.gap.file}, line ${input.gap.startLine}, mutator ${input.gap.mutator}`,
    "",
    input.context.enclosingFunction ? `The function containing the change (from line ${input.context.sliceStartLine}):` : `A window around the change (from line ${input.context.sliceStartLine}):`,
    "```",
    input.context.slice,
    "```",
    "",
    "The change, with comments and formatting normalized away:",
    `  before: ${input.normalized.original}`,
    `  after:  ${input.normalized.replacement}`,
    "",
    "Answer with ONE JSON object and nothing else:",
    '{ "verdict": "equivalent" | "real-gap" | "unclear", "reason": "<one sentence>" }',
    "Answer `unclear` when the surrounding code does not let you decide. `unclear` is treated as a real gap, so it costs nothing to be honest."
  ].join("\n");
}

// src/feedback.ts
var FeedbackLedger = class {
  #byGap = /* @__PURE__ */ new Map();
  record(gapId, round, hold) {
    const entries = this.#byGap.get(gapId) ?? [];
    entries.push({ ...hold, round });
    this.#byGap.set(gapId, entries);
  }
  for(gapId) {
    return this.#byGap.get(gapId) ?? [];
  }
  gaps() {
    return [...this.#byGap.keys()];
  }
  /** The prompt-facing form: most recent first, bounded, newest evidence kept in full. */
  promptBlock(gapId, maxEntries = 3) {
    const entries = [...this.for(gapId)].reverse().slice(0, maxEntries);
    if (entries.length === 0) return "";
    return entries.map(
      (entry, index) => `Attempt ${entry.round} was held at ${entry.stage}: ${entry.reason}` + (entry.evidence === void 0 ? "" : `
What the runner reported:
${index === 0 ? entry.evidence : entry.evidence.slice(0, 800)}`)
    ).join("\n\n");
  }
  /** Every hold, grouped by stage, for the funnel. */
  byStage() {
    const out = {};
    for (const entries of this.#byGap.values()) {
      for (const entry of entries) {
        (out[entry.stage] ??= []).push(entry);
      }
    }
    return out;
  }
};

// src/artifact.ts
import {
  PROPOSALS_BLOCK_SCHEMA,
  PROPOSALS_GAP_ORIGINS,
  PROPOSALS_SIDECAR_SCHEMA,
  PROPOSALS_VERDICTS,
  shapeDidNotReachSentence
} from "@abloh/core";
var NO_TEST_HOLD_REASON = "the model returned no test for this gap";
var SHAPE_DID_NOT_REACH_HOLD_REASON = shapeDidNotReachSentence();
var CANNOT_DISTINGUISH_HOLD_REASON = "no test can distinguish this change: the mutation is not observable through this code's public entry points";
var LIVE_DEPENDENCY_HOLD_REASON = "no self-contained test can reach this code: its only route runs through something live - a running container or daemon, a network peer, or a real clock";
function isStructurallyUntestable(reason) {
  return reason === LIVE_DEPENDENCY_HOLD_REASON;
}
var PROPOSALS_VERSION = "0.1.0";
function buildProposalsBlock(input) {
  const proven = input.summaries.filter((summary) => summary.verdict === "proven");
  return {
    schema: PROPOSALS_BLOCK_SCHEMA,
    state: "completed",
    engineVersion: PROPOSALS_VERSION,
    survivorsIn: input.survivorsIn,
    gapsAttemptable: input.gapsAttemptable,
    /* Closed counts GAPS, not candidates: one candidate closing four gaps closes four gaps, and
       reporting it as one would understate the loop's own product. */
    gapsClosed: proven.reduce((total, summary) => total + 1 + summary.alsoClosesCount, 0),
    proven: proven.length,
    rejected: input.summaries.filter((summary) => summary.verdict === "rejected").length,
    notAttempted: input.summaries.filter((summary) => summary.verdict === "not-attempted-budget").length,
    summaries: input.summaries,
    funnel: projectFunnel(input.funnel),
    disclosure: input.disclosure,
    proofsDigest: input.proofsDigest
  };
}
function projectFunnel(funnel) {
  const out = {};
  for (const stage of LOOP_STAGES) {
    const value = funnel[stage];
    out[stage] = {
      entered: value.entered,
      advanced: value.advanced,
      held: value.held,
      holdReasons: { ...value.holdReasons }
    };
  }
  return out;
}
function buildRoutePurityDisclosure(gaps, closedGapIds) {
  if (gaps.length === 0) return void 0;
  const rows = [];
  for (const rung of ROUTE_PURITY_RUNGS) {
    const onRung = gaps.filter((gap) => gap.rung === rung);
    if (onRung.length === 0) continue;
    rows.push({
      rung,
      gaps: onRung.length,
      closed: onRung.filter((gap) => closedGapIds.has(gap.gapId)).length
    });
  }
  return rows.length === 0 ? void 0 : { rows };
}
function buildRebaselineDisclosure(input) {
  return {
    atRun: input.atRun,
    compared: input.comparison.compared,
    effectiveCompared: input.comparison.effectiveCompared,
    agreed: input.comparison.agreed,
    disagreementRate: input.comparison.disagreementRate,
    reproduced: input.comparison.reproduced,
    flakyFlips: input.comparison.flaky,
    inconclusiveFlips: input.comparison.inconclusive,
    replayRepetitions: input.replayRepetitions,
    hiddenGaps: input.comparison.hiddenGaps,
    staleSurvivors: input.comparison.staleSurvivors,
    tolerance: input.comparison.tolerance,
    withinTolerance: input.comparison.withinTolerance,
    storeRebuilt: input.outcome.storeRebuilt
  };
}
function describeReuseDisclosure(disclosure) {
  const lines = [
    `Reuse: ${disclosure.reusedVerdicts} verdicts reused, ${disclosure.executedVerdicts} executed live.`
  ];
  if (disclosure.wholesaleInvalidated) {
    lines.push("The lockfile or runner config changed, so every stored verdict was dropped this run.");
  }
  lines.push(...describeCarry(disclosure.carry));
  const last = disclosure.lastRebaseline;
  if (last !== void 0) {
    const percent = (last.disagreementRate * 100).toFixed(2);
    const tolerance = (last.tolerance * 100).toFixed(2);
    lines.push(
      `Last full re-baseline (run ${last.atRun}): ${last.agreed}/${last.compared} agreed, ${percent}% disagreement against a ${tolerance}% tolerance.`
    );
    if (last.flakyFlips > 0 || last.inconclusiveFlips > 0) {
      lines.push(
        `${last.flakyFlips} flipped verdicts did not reproduce over ${last.replayRepetitions} replays and ${last.inconclusiveFlips} could not be replayed at all; both are excluded from the rate, which is measured over ${last.effectiveCompared} verdicts rather than ${last.compared}.`
      );
    }
    if (last.hiddenGaps > 0) {
      lines.push(
        `${last.hiddenGaps} of those were HIDDEN GAPS: reuse had answered "the suite notices this" where a fresh run says it does not.`
      );
    }
    if (last.staleSurvivors > 0) {
      lines.push(
        `${last.staleSurvivors} were the other direction: a reused survivor the fresh run kills, which costs an execution and no claim.`
      );
    }
    if (last.storeRebuilt) {
      lines.push("Disagreement reached the tolerance, so the reuse store was distrusted and rebuilt from scratch.");
    }
  } else {
    lines.push("No full re-baseline has run against this repository yet.");
  }
  lines.push(
    `Next re-baseline is due after ${Math.floor(disclosure.interval.runs)} runs or ${disclosure.interval.days.toFixed(1)} days, whichever comes first.`
  );
  return lines;
}
function describeCarry(carry) {
  if (carry === void 0) return [];
  const lines = [];
  if (carry.forcedFullReasons.length > 0) {
    lines.push(
      `Nothing carried into this run: ${carry.forcedFullReasons.join(", ")}. Every verdict and every proposed test on this run was produced fresh.`
    );
  } else if (carry.storeState !== "warm") {
    lines.push(
      `No earlier run was available to carry from (${carry.storeState}), so this run measured everything itself.` + (carry.storeIdentitySource === "local-path" ? " Its store is keyed on this checkout's own path, because no GitHub repository identity was available; a run of the same repository from a different directory cannot find it." : carry.storeIdentitySource === void 0 ? "" : " Its store is keyed on the repository's GitHub identity, which is stable across checkouts, so a later push can find what this run writes.")
    );
  }
  const triageTotal = carry.carriedTriage + carry.freshTriage;
  if (triageTotal > 0) {
    lines.push(
      `Triage: ${carry.freshTriage} of ${triageTotal} survivor verdict(s) were asked live this run; ${carry.carriedTriage} were carried from an earlier push and were NOT re-measured.`
    );
  }
  const candidateTotal = carry.carriedCandidates + carry.freshCandidates;
  if (candidateTotal > 0) {
    lines.push(
      `Proposed tests: ${carry.freshCandidates} of ${candidateTotal} were written this run; ${carry.carriedCandidates} were carried from an earlier push. Every one of them was executed, proved and suite-checked fresh here - a carried proposal is source, never a result.`
    );
  }
  if (carry.carriedTriage > 0 || carry.carriedCandidates > 0) {
    lines.push(
      "No carried record can remove a gap from this report: a verdict that would have called a survivor harmless is re-asked live every run, never carried."
    );
  }
  if (carry.directionRuleReasks > 0) {
    lines.push(
      `${carry.directionRuleReasks} stored verdict(s) matched this run exactly and were re-asked anyway under that rule.`
    );
  }
  const dropped = carry.dropped;
  if (dropped !== void 0) {
    const parts = [];
    const corrupt = dropped.corruptTriage + dropped.corruptCandidates;
    const evicted = dropped.evictedTriage + dropped.evictedCandidates;
    const overBytes = dropped.overBytesTriage + dropped.overBytesCandidates;
    if (corrupt > 0) {
      parts.push(
        `${corrupt} record(s) in the stored file did not read back and were discarded, so this store held less history than it was written with`
      );
    }
    if (evicted > 0) {
      parts.push(`${evicted} of the oldest record(s) were evicted to stay inside the store's record caps`);
    }
    if (overBytes > 0) {
      parts.push(
        `${overBytes} of the oldest record(s) were dropped to keep the store inside its 16 MiB file bound; the newest were kept`
      );
    }
    if (parts.length > 0) {
      lines.push(
        `Carry-forward store maintenance: ${parts.join("; ")}. Anything dropped is re-measured on the next push at full price, and nothing dropped can change what this run reported.`
      );
    }
    if (dropped.gapIds.length > 0) {
      lines.push(`Gaps whose carried proposal was dropped: ${dropped.gapIds.join(", ")}.`);
    }
  }
  return lines;
}
function sidecarDigest(text) {
  return sha256(text);
}

// src/model/policy.ts
var ALLOWED_MODEL_FAMILY = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
var ENDPOINT_EFFORT_CATALOG_MESSAGE = "Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.";
function effortsFromCatalogMessage(message) {
  return [...message.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
}
var MODEL_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
function effortBelow(effort) {
  const index = MODEL_EFFORTS.indexOf(effort);
  return index <= 0 ? null : MODEL_EFFORTS[index - 1];
}
var DEFAULT_TASK_PINS = Object.freeze({
  triage: Object.freeze({
    model: "gpt-5.6-terra",
    effort: "high",
    maxCompletionTokens: 8e3,
    timeoutMs: 29e4
  }),
  generation: Object.freeze({
    /*
     * 32,000 PER GAP, matching what v1 actually gets.
     *
     * MEASURED, not chosen. This pin was 16,000 for a whole batch, while v1 pins the same model at
     * the same effort for the same task and sets NO ceiling - taking the provider default of
     * 32,000 - for ONE gap per call. v2 was therefore asking for four times the output under half
     * the budget, and on node-cron's 36 survivors 12 of 20 generation batches came back
     * `finish_reason: length`: paid for, truncated, discarded.
     */
    maxCompletionTokens: 32e3,
    timeoutMs: 29e4,
    model: "gpt-5.6-sol",
    /*
     * `medium`, RULED BY KENNETH ON 2026-08-23. This supersedes the 2026-08-14 2x2 lock recorded
     * below; his explicit ruling that night is the authority, not this comment.
     *
     * THE EVIDENCE: `data/abloh-stage2-effort-arms/report.md` (firstmate home) - 19 runs, with the
     * `high` baseline and `medium` each replicated twice. `medium` was never worse than baseline on
     * any PR, and beat it on PR-A in both runs (13 and 12 proven against 11 and 11). It costs 24 to
     * 64% less per generation call, and wall time was a wash. Under performance > latency > cost
     * that is a win on the first axis and the third, with the second unchanged.
     *
     * THE CARRY KEY MOVES WITH IT, and that is intended, not a side effect: the model pin is part of
     * the C4 rerun-carry identity, so this change invalidates the existing carry entries once. They
     * refill on the next run.
     *
     * WHAT THE 2x2 SAID, kept because the ruling overrides it rather than erasing it - it was the
     * reason the pin read `high`, and the arm it eliminated (`xhigh`) is still eliminated.
     *
     * The remote 2x2 crossed batch size against effort on the same gap set
     * (`artifacts/2x2-comparison.txt`):
     *
     *   arm        closed  proven  generation seconds
     *   b1-xhigh      16      14        1129
     *   b2-xhigh      15      15         948
     *   b1-high       15      12         941
     *   b2-high       15      15         470
     *
     * b2-high proved 15 of 15 in 470 s where b1-xhigh proved 14 in 1129 s: one more proven test in
     * 42% of the wall clock. Under performance > latency > cost that is a win on the first axis and
     * the second at once, so no trade had to be made.
     *
     * THE ONE THING b1-xhigh DID BETTER, recorded rather than buried: it CLOSED 16 gaps to
     * b2-high's 15. It closed more and proved fewer, which means one of its closures did not
     * survive the exit proof - and a candidate that does not survive the proof is not a product.
     * Proven is the number that ships, so proven is the number this pin answers to.
     *
     * `high` at batch 2 also changes what a truncated reply means. Effort spends the ceiling on
     * hidden reasoning before the first visible line, so the same 40,000-token ceiling buys more
     * test at `high` than at `xhigh` - which is the mechanism behind the wall-clock difference, not
     * a separate lucky finding.
     */
    effort: "medium"
  }),
  /**
   * THE AGENT BUG POOL'S PLANTER, AND IT IS ONE IDENTITY FOR BOTH SURFACES.
   *
   * Pool 2 runs on the pull-request seam (`apps/cli/src/marigold-dispatch.ts`) and on the night
   * (`packages/overnight-lane/src/cli.ts`). Each used to declare this literal itself, with the two
   * connected only by a test that read both files as text and compared the fields it could extract.
   * That test could not reach a customer's pinned CLI meeting a newer service, and it closed nothing
   * the moment either side was edited by a hand that did not run it (audit F35). The pin is declared
   * here once and both surfaces pass it; the ruled pattern is unchanged, because what that pattern
   * forbids is an ENGINE MODULE quietly defaulting a pin, and no module does - `runAgentBugPool`
   * still requires the caller to hand one in.
   *
   * WHY THE TWO MUST NOT DIVERGE: the night's planted-bug counts and a pull request's are read side
   * by side. If one surface plants with a different model or at a different effort, a difference
   * between the two numbers is a difference in the PLANTER rather than in the repository, and
   * nothing on either page would say so.
   *
   * TERRA AT `high` (Kenneth, 2026-08-15), replacing sol at `xhigh`. Two measured facts stand behind
   * the ruling. Planting is the largest line item in a night's spend and terra costs roughly 2.5x
   * less than sol for the same call, so the same nightly limit reaches more files
   * (`data/abloh-hunt-economics/report.md` sections 5a.1, 5a.2 and 11). Effort moved with it because
   * this project's own 2x2 on the neighbouring generation task found `high` beat `xhigh` on both
   * axes at once - one more proven test in 42% of the wall clock (the generation pin above).
   *
   * FINAL (Kenneth, 2026-08-15), and no longer a value under measurement. The open half was bug
   * QUALITY - a cheaper planter's cruder bugs would have read as a healthier catch rate rather than
   * as a worse hunt - and the `abloh-cost-mechanics` benchmark of 2026-08-15 answered it. Terra
   * escaped 58.2% against the sol-era 24.5%, paired across the same 13 items, with NO DROP ON ANY
   * AXIS; a 112-bug forensic read found every one of them promised behavior rather than noise; and
   * realism came out at or above sol on both independent reads. The cheaper planter plants better,
   * so the economics and the quality point the same way and there is nothing left to pin later.
   *
   * TWO THINGS WERE CLOSED WITH IT rather than left hanging. Luna is PARKED as economically
   * irrelevant: it saves 13% of a whole run, and stage 2 - where the spend actually is - was never
   * measured, so the saving is not worth another planter identity. An attribution trial was
   * DECLINED: placement and sizing move together with the model in the runs we have, so a trial
   * would not have separated which of the three earned the escape rate, and the confound is recorded
   * here rather than silently carried.
   *
   * `maxCompletionTokens` AND `timeoutMs` ARE UNCHANGED by that ruling, and stay so a later edit
   * cannot fold a second change into it: nothing in the family's catalog gives terra a different
   * generated-token ceiling or a different transport wall.
   */
  pool2: Object.freeze({
    model: "gpt-5.6-terra",
    effort: "high",
    maxCompletionTokens: 32e3,
    timeoutMs: 29e4
  })
});
var PER_GAP_COMPLETION_TOKENS = 8e3;
var MAX_COMPLETION_TOKENS = 128e3;
function batchCompletionCeiling(pin, gapCount) {
  const gaps = Math.max(1, gapCount);
  return Math.min(MAX_COMPLETION_TOKENS, pin.maxCompletionTokens + PER_GAP_COMPLETION_TOKENS * (gaps - 1));
}
var MEASURED_TOKENS_PER_SECOND = 70;
var CALL_OVERHEAD_MS = 45e3;
var MAX_DERIVED_CALL_MS = 48e4;
var HARD_CALL_CEILING_MS = 6e5;
function derivedCallDeadlineMs(input) {
  const derived = input.completionCeiling / MEASURED_TOKENS_PER_SECOND * 1e3 + CALL_OVERHEAD_MS;
  const capped = Math.min(derived, MAX_DERIVED_CALL_MS, HARD_CALL_CEILING_MS);
  const bounded2 = input.remainingBudgetMs === void 0 ? capped : Math.max(1e3, Math.min(capped, input.remainingBudgetMs));
  return Math.floor(bounded2);
}
function isAllowedModel(name) {
  return ALLOWED_MODEL_FAMILY.includes(name);
}
function assertAllowedModel(name) {
  if (!isAllowedModel(name)) {
    throw new Error(
      `marigold model policy: '${name}' is outside the allowed family (${ALLOWED_MODEL_FAMILY.join(", ")})`
    );
  }
  return name;
}
function taskModelIdentity(task, pin) {
  return `${task}:${pin.model}@${pin.effort}`;
}

// src/model/call-record.ts
function callRecord(input) {
  const timing = input.result.timing;
  return {
    task: input.task,
    round: input.round,
    gapIds: [...input.gapIds],
    ok: input.result.ok,
    ...input.result.ok ? {} : { failure: input.result.failure.kind },
    latencyMs: timing?.latencyMs ?? input.result.latencyMs,
    timeToFirstTokenMs: timing?.timeToFirstTokenMs ?? null,
    tokensPerSecond: timing?.tokensPerSecond ?? null,
    deadlineMs: timing?.deadlineMs ?? null,
    effort: timing?.effort ?? input.effort,
    throttleRetries: timing?.throttleRetries ?? 0,
    longestSilenceMs: timing?.longestSilenceMs ?? null,
    surface: timing?.surface ?? null
  };
}

// src/generation.ts
function declineHoldReason(declared) {
  if (declared === "not-self-containable") return SHAPE_DID_NOT_REACH_HOLD_REASON;
  if (declared === "cannot-distinguish") return CANNOT_DISTINGUISH_HOLD_REASON;
  if (declared === "structurally-untestable") return LIVE_DEPENDENCY_HOLD_REASON;
  return NO_TEST_HOLD_REASON;
}
async function generateBatch(input) {
  const asked = new Map(input.items.map((item) => [item.gap.gapId, item]));
  let prompt = buildBatchGenerationPrompt({
    items: input.items,
    ledger: input.ledger,
    runner: input.runner,
    moduleFormat: input.moduleFormat,
    exampleTest: input.exampleTest
  });
  let modelCalls = 0;
  let lastHold = null;
  const timings = [];
  const attempts = [
    { effort: void 0, why: "first attempt at the pinned effort" }
  ];
  const lowerEffort = effortBelow(input.pin.effort);
  if (lowerEffort !== null) {
    attempts.push({ effort: lowerEffort, why: `one retry at ${lowerEffort} after a deadline miss` });
  }
  for (const [index, attempt] of attempts.entries()) {
    const result = await input.client.call({
      task: "generation",
      pin: input.pin,
      prompt,
      jsonObject: false,
      gapCount: input.items.length,
      ...attempt.effort === void 0 ? {} : { effort: attempt.effort },
      ...input.remainingBudgetMs === void 0 ? {} : { remainingBudgetMs: input.remainingBudgetMs },
      signal: input.signal
    });
    modelCalls += 1;
    const effortUsed = result.timing?.effort ?? attempt.effort ?? input.pin.effort;
    timings.push(
      callRecord({
        task: "generation",
        round: input.round,
        gapIds: [...asked.keys()],
        effort: attempt.effort ?? input.pin.effort,
        result
      })
    );
    if (!result.ok) {
      lastHold = {
        stage: "generation",
        reason: `model call failed: ${result.failure.kind}`,
        /* The kind as a VALUE beside the sentence, so the loop can tell a call the money refused
           from a call the endpoint dropped without reading prose. See `Hold.failureKind`. */
        failureKind: result.failure.kind,
        evidence: boundEvidence(`${result.failure.detail} (effort ${effortUsed})`)
      };
      if (result.failure.kind !== "timeout") break;
      if (index === attempts.length - 1) break;
      continue;
    }
    const parsed = parseCandidatesReply(result.text);
    if (!parsed.ok) {
      lastHold = { stage: "generation", reason: parsed.reason, evidence: boundEvidence(result.text) };
      break;
    }
    const candidates = [];
    const holds = [];
    const answered2 = /* @__PURE__ */ new Set();
    for (const entry of parsed.candidates) {
      const gapId = typeof entry.gapId === "string" ? entry.gapId : "";
      const item = asked.get(gapId);
      if (item === void 0) continue;
      answered2.add(gapId);
      const testBody = typeof entry.testBody === "string" ? entry.testBody : "";
      if (testBody.trim() === "") {
        holds.push({
          gapId,
          hold: {
            stage: "generation",
            reason: declineHoldReason(entry.declined),
            evidence: typeof entry.note === "string" ? boundEvidence(entry.note) : void 0
          }
        });
        continue;
      }
      const declared = typeof entry.testName === "string" && entry.testName.trim() !== "" ? entry.testName : firstDeclaredTestName(testBody);
      if (declared === null) {
        holds.push({
          gapId,
          hold: {
            stage: "generation",
            reason: "the reply carried a test body with no declared test name",
            evidence: boundEvidence(testBody)
          }
        });
        continue;
      }
      candidates.push({
        candidateId: candidateIdentity({ gapId, round: input.round, testFile: item.testFile, testBody, supportFiles: [] }),
        gapId,
        round: input.round,
        testFile: item.testFile,
        testName: declared,
        testBody,
        supportFiles: [],
        model: input.pin.model,
        /* the effort is part of the identity that produced this candidate, so a quality
           difference between `xhigh` and a `high` retry is visible rather than assumed */
        promptVersion: `${PROMPT_VERSION}@${effortUsed}`
      });
    }
    for (const [gapId] of asked) {
      if (answered2.has(gapId)) continue;
      holds.push({ gapId, hold: { stage: "generation", reason: "the reply did not mention this gap" } });
    }
    return { candidates, holds, modelCalls, timings };
  }
  const hold = lastHold ?? { stage: "generation", reason: "generation produced nothing" };
  return {
    candidates: [],
    holds: [...asked.keys()].map((gapId) => ({ gapId, hold })),
    modelCalls,
    timings
  };
}
function parseCandidatesReply(text) {
  const unfenced = unfence(text).trim();
  if (unfenced === "") return { ok: false, reason: "the reply was empty" };
  const candidates = [];
  let sawAnyJson = false;
  for (const line of unfenced.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    sawAnyJson = true;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value;
    if (Array.isArray(record.candidates)) {
      for (const entry of record.candidates) {
        if (typeof entry === "object" && entry !== null) candidates.push(entry);
      }
      continue;
    }
    if (typeof record.gapId === "string") candidates.push(record);
  }
  if (candidates.length > 0) return { ok: true, candidates };
  if (!sawAnyJson) return { ok: false, reason: "no line of the reply was JSON" };
  return { ok: false, reason: "the reply carried no object naming a gapId" };
}
function unfence(text) {
  const fenced = /```(?:json|ndjson)?\s*\n([\s\S]*?)```/u.exec(text);
  return fenced === null ? text : fenced[1];
}

// src/triage.ts
var TRIAGE_VERDICTS = ["real-gap", "equivalent", "unclear"];
async function triageGaps(input) {
  const records = [];
  const attemptable = [];
  let modelCalls = 0;
  const ceiling = input.maxModelCalls ?? Number.POSITIVE_INFINITY;
  const concurrency = Math.max(1, input.concurrency ?? 8);
  let slot = 0;
  const decided = await Promise.all(
    chunked(input.gaps, concurrency).map(
      async (group) => Promise.all(
        group.map(async (gap) => {
          const trivial = trivialTriage({ originalText: gap.originalText, replacement: gap.replacement });
          if (trivial.verdict === "identical-after-normalization") {
            return {
              attempt: false,
              record: {
                gapId: gap.gapId,
                verdict: "equivalent",
                source: "normalization",
                reason: "the replacement is the original once comments and whitespace are normalized away",
                promptVersion: TRIAGE_PROMPT_VERSION,
                model: null
              }
            };
          }
          if (input.upstreamTriaged === true) {
            return {
              attempt: true,
              record: {
                gapId: gap.gapId,
                verdict: "real-gap",
                source: "upstream",
                reason: "the caller classified this survivor as a real gap before the loop started",
                promptVersion: TRIAGE_PROMPT_VERSION,
                model: null
              }
            };
          }
          const context = input.contexts.get(gap.gapId);
          const mySlot = slot++;
          if (input.client === null || context === void 0 || mySlot >= ceiling) {
            return {
              attempt: true,
              record: {
                gapId: gap.gapId,
                verdict: "unclear",
                source: "normalization",
                reason: input.client === null ? "no model endpoint was available, so nothing said this gap cannot matter" : mySlot >= ceiling ? "the triage call ceiling was reached; the gap is attempted rather than discarded" : "no source context could be built for this gap",
                promptVersion: TRIAGE_PROMPT_VERSION,
                model: null
              }
            };
          }
          const result = await input.client.call({
            task: "triage",
            pin: input.pin,
            prompt: buildTriagePrompt({ gap, context, normalized: trivial.evidence }),
            jsonObject: true,
            signal: input.signal
          });
          modelCalls += 1;
          if (!result.ok) {
            return {
              attempt: true,
              record: {
                gapId: gap.gapId,
                verdict: "unclear",
                source: "model",
                reason: `the triage call failed (${result.failure.kind}); an unanswered gap stays a gap`,
                promptVersion: TRIAGE_PROMPT_VERSION,
                model: input.pin.model,
                hold: { stage: "triage", reason: result.failure.kind, evidence: boundEvidence(result.failure.detail) }
              }
            };
          }
          const parsed = parseTriageReply(result.text);
          return {
            attempt: parsed.verdict !== "equivalent",
            record: {
              gapId: gap.gapId,
              verdict: parsed.verdict,
              source: "model",
              reason: parsed.reason,
              promptVersion: TRIAGE_PROMPT_VERSION,
              model: input.pin.model,
              ...parsed.verdict === "unclear" && parsed.malformed ? { hold: { stage: "triage", reason: "unreadable triage reply", evidence: boundEvidence(result.text) } } : {}
            }
          };
        })
      )
    )
  );
  for (const [index, outcome] of decided.flat().entries()) {
    records.push(outcome.record);
    if (outcome.attempt) attemptable.push(input.gaps[index]);
  }
  return { records, attemptable, modelCalls };
}
function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}
function parseTriageReply(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/u.exec(text);
  try {
    const value = JSON.parse((fenced === null ? text : fenced[1]).trim());
    const verdict = value.verdict;
    const reason = typeof value.reason === "string" ? value.reason : "";
    if (verdict === "equivalent" || verdict === "real-gap" || verdict === "unclear") {
      return { verdict, reason, malformed: false };
    }
    return { verdict: "unclear", reason: `the reply named no known verdict`, malformed: true };
  } catch {
    return { verdict: "unclear", reason: "the triage reply was not JSON", malformed: true };
  }
}

// src/light-check.ts
async function lightCheck(candidate, gap, options) {
  const files = [{ path: candidate.testFile, source: candidate.testBody }, ...candidate.supportFiles];
  const realResult = await options.runner.execute({
    files,
    patches: [],
    mode: "targeted",
    testFile: candidate.testFile,
    testName: candidate.testName,
    timeoutMs: options.timeoutMs
  });
  const real = toSideRun(realResult);
  if (realResult.error !== void 0) {
    return { candidateId: candidate.candidateId, gapId: gap.gapId, verdict: "errored", real, mutant: null, executions: 1 };
  }
  if (realResult.report.executed === false) {
    return { candidateId: candidate.candidateId, gapId: gap.gapId, verdict: "not-executed", real, mutant: null, executions: 1 };
  }
  if (!real.passed) {
    return {
      candidateId: candidate.candidateId,
      gapId: gap.gapId,
      verdict: "real-not-passing",
      real,
      mutant: null,
      executions: 1,
      ...realResult.gateShapedFailure === true ? { gateShaped: true } : {}
    };
  }
  const mutantResult = await options.runner.execute({
    files,
    patches: [gap],
    mode: "targeted",
    testFile: candidate.testFile,
    testName: candidate.testName,
    timeoutMs: options.timeoutMs
  });
  const mutant = toSideRun(mutantResult);
  if (mutantResult.error !== void 0) {
    return { candidateId: candidate.candidateId, gapId: gap.gapId, verdict: "errored", real, mutant, executions: 2 };
  }
  if (mutant.passed) {
    return { candidateId: candidate.candidateId, gapId: gap.gapId, verdict: "mutant-not-failing", real, mutant, executions: 2 };
  }
  if (!mutant.failedAssertion) {
    return { candidateId: candidate.candidateId, gapId: gap.gapId, verdict: "errored", real, mutant, executions: 2 };
  }
  return { candidateId: candidate.candidateId, gapId: gap.gapId, verdict: "distinguishes", real, mutant, executions: 2 };
}
function toSideRun(result) {
  return {
    passed: result.report.passed,
    /* `null` means the report format did not say. It is recorded as not-proven-executed rather
       than assumed either way; the discovery sentinel is what settles it before an exit proof. */
    executed: result.report.executed === true,
    failedAssertion: result.report.failedAssertion,
    report: boundEvidence(result.output),
    wallMs: result.wallMs
  };
}
function lightCheckHoldReason(verdict, gateShaped = false) {
  switch (verdict) {
    case "real-not-passing":
      return gateShaped ? "the project's own test command exited non-zero without running a test, which is the shape of a lint, format, typecheck or build stage in front of the runner; declare environment.sealedTestCommand to invoke the runner directly" : "the test did not pass against the real source";
    case "mutant-not-failing":
      return "the test passed against the mutated source too, so it does not detect this change";
    case "not-executed":
      return "the runner did not execute the test at that path";
    case "errored":
      return "the run failed on the machinery rather than on an assertion";
    case "distinguishes":
      return "";
  }
}

// src/kill-matrix.ts
async function buildKillMatrix(input) {
  const cells = [];
  const kills = /* @__PURE__ */ new Map();
  let executions = 0;
  let skipped = 0;
  for (const candidate of input.candidates) {
    const own = kills.get(candidate.candidateId) ?? /* @__PURE__ */ new Set();
    own.add(candidate.gapId);
    kills.set(candidate.candidateId, own);
  }
  const queues = input.candidates.map((candidate) => ({
    candidate,
    files: [{ path: candidate.testFile, source: candidate.testBody }, ...candidate.supportFiles],
    pending: input.openGaps.filter((gap) => gap.gapId !== candidate.gapId)
  }));
  while (queues.some((queue) => queue.pending.length > 0)) {
    if (executions >= input.options.maxExecutions) {
      skipped += queues.reduce((total, queue) => total + queue.pending.length, 0);
      break;
    }
    const pass = [...queues].filter((queue) => queue.pending.length > 0).sort((left, right) => (kills.get(right.candidate.candidateId)?.size ?? 0) - (kills.get(left.candidate.candidateId)?.size ?? 0));
    for (const queue of pass) {
      const gap = queue.pending.shift();
      if (gap === void 0) continue;
      if (executions >= input.options.maxExecutions) {
        skipped += 1;
        continue;
      }
      const candidate = queue.candidate;
      const result = await input.options.runner.execute({
        files: queue.files,
        patches: [gap],
        mode: "targeted",
        testFile: candidate.testFile,
        testName: candidate.testName,
        timeoutMs: input.options.timeoutMs
      });
      executions += 1;
      if (result.error !== void 0) {
        cells.push({
          candidateId: candidate.candidateId,
          gapId: gap.gapId,
          kills: false,
          executions: 1,
          hold: { stage: "kill-matrix", reason: "the replay could not run", evidence: boundEvidence(result.error) }
        });
        continue;
      }
      const killed = !result.report.passed && result.report.failedAssertion;
      cells.push({ candidateId: candidate.candidateId, gapId: gap.gapId, kills: killed, executions: 1 });
      if (killed) kills.get(candidate.candidateId)?.add(gap.gapId);
    }
  }
  return { cells, kills, executions, skipped };
}
function chooseWinningSet(kills, openGapIds) {
  const remaining = new Set(openGapIds);
  const chosen = [];
  const closedBy = /* @__PURE__ */ new Map();
  const available = new Map([...kills].map(([id, set]) => [id, new Set(set)]));
  while (remaining.size > 0) {
    let best = null;
    for (const [id, set] of available) {
      if (chosen.includes(id)) continue;
      const covered = [...set].filter((gapId) => remaining.has(gapId));
      if (covered.length === 0) continue;
      if (best === null || covered.length > best.covered.length || covered.length === best.covered.length && id < best.id) {
        best = { id, covered };
      }
    }
    if (best === null) break;
    chosen.push(best.id);
    for (const gapId of best.covered) {
      closedBy.set(gapId, best.id);
      remaining.delete(gapId);
    }
  }
  const redundant = [...available.keys()].filter((id) => !chosen.includes(id));
  return { chosen, closedBy, redundant };
}

// src/exit-proof.ts
import { proofReportUnavailableSentence } from "@abloh/core";
var DEFAULT_PROOF_REPETITIONS = 2;
var SENTINEL_TEST_NAME = "abloh discovery sentinel";
function unansweredAsk(result) {
  const unavailable = result.report.unavailable;
  return unavailable !== void 0 && unavailable.asked === true ? unavailable : void 0;
}
function sentinelSource(runner) {
  const name = JSON.stringify(SENTINEL_TEST_NAME);
  switch (runner) {
    case "vitest":
      return `import { it, expect } from "vitest";
it(${name}, () => { expect(1).toBe(2); });
`;
    case "jest":
      return `it(${name}, () => { expect(1).toBe(2); });
`;
    case "mocha":
      return `it(${name}, function () { throw new Error("the abloh discovery sentinel must fail"); });
`;
    case "jasmine":
      return `it(${name}, function () { expect(1).toBe(2); });
`;
    case "ava":
      return `import test from "ava";
test(${name}, (t) => { t.is(1, 2); });
`;
    case "tap":
      return `import t from "tap";
t.test(${name}, (t) => { t.equal(1, 2); t.end(); });
`;
    case "bun":
      return `import { test, expect } from "bun:test";
test(${name}, () => { expect(1).toBe(2); });
`;
    /* DENO NEEDS NO IMPORT AT ALL: `Deno.test` is a global on the runtime itself, so the sentinel
       is the thinnest of the eight - which also makes it the safest, because a sentinel that
       imported an assertion library would fail on a repository that has not cached that library
       under `--cached-only` and report "the runner does not execute this path" for a path it
       executes perfectly well. It fails by THROWING for the same reason mocha's does: no assertion
       library means nothing to be missing. */
    case "deno":
      return `Deno.test(${name}, () => { throw new Error("the abloh discovery sentinel must fail"); });
`;
    default:
      return `import { it } from "node:test";
import assert from "node:assert/strict";
it(${name}, () => { assert.equal(1, 2); });
`;
  }
}
async function proveCandidate(input) {
  const repetitions = input.options.repetitions ?? DEFAULT_PROOF_REPETITIONS;
  const candidate = input.candidate;
  const seen = input.discoveryByPath ?? /* @__PURE__ */ new Map();
  let executions = 0;
  let discovery = seen.get(candidate.testFile) ?? null;
  if (discovery === null) {
    const sentinel = await input.options.runner.execute({
      files: [{ path: candidate.testFile, source: sentinelSource(input.runnerName) }],
      patches: [],
      mode: "targeted",
      testFile: candidate.testFile,
      testName: SENTINEL_TEST_NAME,
      timeoutMs: input.options.timeoutMs
    });
    executions += 1;
    const sentinelUnavailable = unansweredAsk(sentinel);
    const confirmed = sentinel.error === void 0 && sentinelUnavailable === void 0 && !sentinel.report.passed && sentinel.report.executed !== false;
    discovery = {
      confirmed,
      detail: confirmed ? "a test planted at this path failed as designed, so the runner collects it" : sentinelUnavailable !== void 0 ? proofReportUnavailableSentence(sentinelUnavailable) : `a test planted at this path did not fail; the runner does not execute ${candidate.testFile}`
    };
    seen.set(candidate.testFile, discovery);
  }
  const base = {
    candidateId: candidate.candidateId,
    gapId: candidate.gapId,
    alsoCloses: [],
    discovery
  };
  if (input.gap === void 0) {
    return {
      ...base,
      verdict: "rejected",
      repetitions: [],
      suite: null,
      hold: { stage: "exit-proof", reason: "the candidate lost its target gap" },
      executions
    };
  }
  if (!discovery.confirmed) {
    return {
      ...base,
      verdict: "rejected",
      repetitions: [],
      suite: null,
      hold: { stage: "exit-proof", reason: discovery.detail },
      executions
    };
  }
  const files = [{ path: candidate.testFile, source: candidate.testBody }, ...candidate.supportFiles];
  const rounds = [];
  let failure = null;
  for (let i = 0; i < repetitions; i++) {
    const realFirst = i % 2 === 0;
    const order = realFirst ? ["real", "mutant"] : ["mutant", "real"];
    let real = null;
    let mutant = null;
    for (const side of order) {
      const result = await input.options.runner.execute({
        files,
        patches: side === "mutant" ? [input.gap] : [],
        mode: "targeted",
        testFile: candidate.testFile,
        testName: candidate.testName,
        timeoutMs: input.options.timeoutMs
      });
      executions += 1;
      const run = toSideRun(result);
      if (side === "real") real = run;
      else mutant = run;
      if (result.error !== void 0) failure ??= `the ${side} side could not run: ${result.error}`;
      else {
        const unanswered = unansweredAsk(result);
        if (unanswered !== void 0) failure ??= proofReportUnavailableSentence(unanswered);
      }
    }
    if (real === null || mutant === null) break;
    rounds.push({ realFirst, real, mutant });
    if (!real.passed) failure ??= "a repetition did not pass against the real source";
    if (mutant.passed) failure ??= "a repetition passed against the mutated source";
    if (!mutant.passed && !mutant.failedAssertion) {
      failure ??= "a repetition failed on the machinery rather than on an assertion";
    }
    if (failure !== null) break;
  }
  return {
    ...base,
    verdict: failure === null ? "proven" : "rejected",
    repetitions: rounds,
    suite: null,
    ...failure === null ? {} : { hold: { stage: "exit-proof", reason: failure } },
    executions
  };
}
function measureSuiteBaseline(options) {
  let pending = null;
  let charged = false;
  return {
    async measure() {
      pending ??= (async () => {
        const run = await options.runner.execute({
          files: [],
          patches: [],
          mode: "suite",
          timeoutMs: options.suiteTimeoutMs
        });
        return {
          green: run.error === void 0 && run.report.passed,
          failed: run.report.failed,
          failures: run.report.failures,
          ...run.error === void 0 ? {} : { error: run.error },
          report: boundEvidence(run.output)
        };
      })();
      const measured = await pending;
      const executions = charged ? 0 : 1;
      charged = true;
      return { ...measured, executions };
    }
  };
}
function suiteDelta(baseline, run) {
  const none = { newFailures: [], regressed: false, reason: null };
  if (run.error !== void 0) {
    if (baseline.error !== void 0) return { ...none, basis: "unattributable" };
    return {
      newFailures: [],
      basis: "error",
      regressed: true,
      reason: `the suite could not run with the candidate present: ${run.error}`
    };
  }
  if (run.report.passed) return { ...none, basis: "no-failures" };
  if (baseline.error !== void 0) return { ...none, basis: "unattributable" };
  if (baseline.green) {
    return {
      newFailures: run.report.failures ?? [],
      basis: "baseline-green",
      regressed: true,
      /* THE ORIGINAL SENTENCE, unchanged, because on a green baseline the original judgement was
         right and a customer reading two runs should not see the same fact worded two ways. */
      reason: "the candidate passes alone but the whole suite does not stay green with it present"
    };
  }
  if (run.report.failures !== null && baseline.failures !== null) {
    const before = new Set(baseline.failures);
    const newFailures = run.report.failures.filter((name) => !before.has(name));
    if (newFailures.length === 0) return { ...none, basis: "named" };
    return {
      newFailures,
      basis: "named",
      regressed: true,
      /* A COUNT AND NEVER THE NAMES. This sentence reaches the artifact as `holdReason`; a test
         name is free text the customer wrote and stops at the machine (`catch-profile.ts`). The
         names are in `newFailures`, which reaches the local sidecar only. */
      reason: `the suite was already failing ${baseline.failures.length} test(s) before this run, and the candidate makes ${newFailures.length} further test(s) fail that passed without it`
    };
  }
  if (run.report.failed !== null && baseline.failed !== null) {
    if (run.report.failed <= baseline.failed) return { ...none, basis: "counted" };
    return {
      newFailures: [],
      basis: "counted",
      regressed: true,
      reason: `the suite fails ${run.report.failed} test(s) with the candidate present and ${baseline.failed} without it; this runner's report does not name them, so the rise in the count is the whole of the evidence`
    };
  }
  return { ...none, basis: "unattributable" };
}
async function proveSuite(input) {
  if (input.proven.length === 0) return { executions: 0, baseline: null };
  let executions = 0;
  const files = input.proven.flatMap((candidate) => [
    { path: candidate.testFile, source: candidate.testBody },
    ...candidate.supportFiles
  ]);
  const combined = await input.options.runner.execute({
    files,
    patches: [],
    mode: "suite",
    timeoutMs: input.options.suiteTimeoutMs
  });
  executions += 1;
  if (combined.error === void 0 && combined.report.passed) {
    for (const candidate of input.proven) {
      const current = input.resultsById.get(candidate.candidateId);
      if (current !== void 0) {
        current.suite = {
          green: true,
          regressed: false,
          failed: combined.report.failed,
          basis: "no-failures",
          newFailures: [],
          report: boundEvidence(combined.output)
        };
      }
    }
    return { executions, baseline: null };
  }
  const probe = input.baseline ?? measureSuiteBaseline(input.options);
  const baseline = await probe.measure();
  executions += baseline.executions;
  const combinedDelta = suiteDelta(baseline, combined);
  if (!combinedDelta.regressed) {
    for (const candidate of input.proven) {
      const current = input.resultsById.get(candidate.candidateId);
      if (current !== void 0) {
        current.suite = {
          green: false,
          regressed: false,
          failed: combined.report.failed,
          basis: combinedDelta.basis,
          newFailures: [],
          baseline: { green: baseline.green, failed: baseline.failed, ...baseline.error === void 0 ? {} : { error: baseline.error } },
          report: boundEvidence(combined.output)
        };
      }
    }
    return { executions, baseline };
  }
  for (const candidate of input.proven) {
    const alone = await input.options.runner.execute({
      files: [{ path: candidate.testFile, source: candidate.testBody }, ...candidate.supportFiles],
      patches: [],
      mode: "suite",
      timeoutMs: input.options.suiteTimeoutMs
    });
    executions += 1;
    const delta = suiteDelta(baseline, alone);
    const current = input.resultsById.get(candidate.candidateId);
    if (current === void 0) continue;
    current.suite = {
      green: alone.error === void 0 && alone.report.passed,
      regressed: delta.regressed,
      failed: alone.report.failed,
      basis: delta.basis,
      newFailures: delta.newFailures,
      baseline: { green: baseline.green, failed: baseline.failed, ...baseline.error === void 0 ? {} : { error: baseline.error } },
      report: boundEvidence(alone.output)
    };
    if (delta.regressed) {
      current.verdict = "rejected";
      current.hold = {
        stage: "exit-proof",
        reason: delta.reason ?? "the candidate passes alone but the whole suite does not stay green with it present",
        evidence: boundEvidence(alone.output)
      };
    }
  }
  return { executions, baseline };
}
async function proveExit(input) {
  const discoveryByPath = /* @__PURE__ */ new Map();
  const perCandidate = /* @__PURE__ */ new Map();
  const survived = [];
  let executions = 0;
  for (const candidate of input.candidates) {
    const result = await proveCandidate({
      candidate,
      gap: input.gapsByCandidate.get(candidate.candidateId),
      runnerName: input.runnerName,
      options: input.options,
      discoveryByPath
    });
    result.alsoCloses = input.alsoCloses.get(candidate.candidateId) ?? [];
    executions += result.executions;
    perCandidate.set(candidate.candidateId, result);
    if (result.verdict === "proven") survived.push(candidate);
  }
  const suite = await proveSuite({
    proven: survived,
    resultsById: perCandidate,
    options: input.options,
    baseline: measureSuiteBaseline(input.options)
  });
  executions += suite.executions;
  const results = [];
  for (const candidate of input.candidates) {
    const result = perCandidate.get(candidate.candidateId);
    if (result !== void 0) results.push(result);
  }
  return { results, executions };
}

// src/mutant-difference.ts
var MUTANT_READINGS = ["noticed", "unnoticed", "not-executed"];
async function readMutantRun(input) {
  const none = { newFailures: [], baselineExecutions: 0 };
  if (input.run.timedOut === true) return { ...none, reading: "not-executed", basis: "timed-out" };
  if (input.run.error !== void 0) return { ...none, reading: "not-executed", basis: "not-run" };
  if (input.run.report.passed) return { ...none, reading: "unnoticed", basis: "no-failures" };
  const baseline = await input.baseline();
  const delta = suiteDelta(baseline, { report: input.run.report });
  if (delta.basis === "unattributable") {
    return { reading: "not-executed", basis: "unattributable", newFailures: [], baselineExecutions: baseline.executions };
  }
  return {
    reading: delta.regressed ? "noticed" : "unnoticed",
    basis: delta.basis,
    newFailures: delta.newFailures,
    baselineExecutions: baseline.executions
  };
}

// src/scoring.ts
import {
  caughtWithinMeasured,
  countsAreWholeVerdicts,
  percentOfMeasured,
  pool2Population
} from "@abloh/core";
function scoreComponent(caught, measured) {
  if (!countsAreWholeVerdicts(caught, measured)) {
    throw new Error("a score component counts whole verdicts; caught and measured are non-negative integers");
  }
  if (!caughtWithinMeasured(caught, measured)) {
    throw new Error(`a score component cannot catch ${caught} of ${measured} measured verdicts`);
  }
  return { caught, measured, rate: percentOfMeasured(caught, measured) };
}
function pool2ScoreComponent(agentBugs) {
  const population = pool2Population(agentBugs);
  if (population === null) {
    const untested = agentBugs.untestedLines;
    throw new Error(
      `an agent bug pool cannot have planted more bugs on unexecuted lines than it measured (${untested?.suiteKilled ?? 0} killed and ${untested?.suiteSurvived ?? 0} survived of ${agentBugs.suiteKilled} and ${agentBugs.suiteSurvived})`
    );
  }
  return scoreComponent(population.caught, population.measured);
}
function twoRates(input) {
  return { classic: input.classic, pool2: input.pool2 };
}

// src/composition.ts
var COMPOSED_REASON_LIMIT = 200;
function isCompleted(block) {
  return block.state === "completed";
}
function composedProofsDigest(entries) {
  return sha256(
    canonicalJson({
      schema: "abloh-proposals-composed-proofs/v1",
      packages: entries.filter((entry) => isCompleted(entry.block)).map((entry) => ({
        directory: entry.directory,
        proofsDigest: entry.block.proofsDigest
      }))
    })
  );
}
function composeSignedScore(blocks) {
  const parts = blocks.map((block) => block.disclosure.signedScore).filter((score) => score !== void 0);
  if (parts.length === 0) return void 0;
  const sum = (pick) => parts.reduce(
    (total, score) => {
      const component = pick(score);
      return { caught: total.caught + component.caught, measured: total.measured + component.measured };
    },
    { caught: 0, measured: 0 }
  );
  const classic = sum((score) => score.classic);
  const pool2 = sum((score) => score.pool2);
  return {
    classic: scoreComponent(classic.caught, classic.measured),
    pool2: scoreComponent(pool2.caught, pool2.measured)
  };
}
function composeFunnel(blocks) {
  const out = {};
  for (const stage of LOOP_STAGES) {
    const holdReasons = {};
    let entered = 0;
    let advanced = 0;
    let held = 0;
    for (const block of blocks) {
      const value = block.funnel[stage];
      entered += value.entered;
      advanced += value.advanced;
      held += value.held;
      for (const [reason, count] of Object.entries(value.holdReasons)) {
        holdReasons[reason] = (holdReasons[reason] ?? 0) + count;
      }
    }
    out[stage] = { entered, advanced, held, holdReasons };
  }
  return out;
}
function composeExecution(blocks) {
  const runnerIds = new Set(blocks.map((block) => block.disclosure.execution.runnerId));
  return {
    /* One identity when every package ran in the same kind of runner, and "multi" when they did
       not - the same rule the classic layer signs a mixed-runner run with. Naming the first
       package's runner over another's executions would be a claim about work it did not do. */
    runnerId: runnerIds.size === 1 ? [...runnerIds][0] : "multi",
    /* SEALED IS AN "EVERY", never an "any": one unsealed package makes the composed evidence
       unsealed, because a reader who sees `sealed: true` may present any of it as a sealed proof. */
    sealed: blocks.every((block) => block.disclosure.execution.sealed),
    executed: blocks.reduce((total, block) => total + block.disclosure.execution.executed, 0),
    /* Likewise an "every": the composed run avoided re-preparation only if every package did. */
    reusedPreparation: blocks.every((block) => block.disclosure.execution.reusedPreparation),
    matrixSkipped: blocks.reduce((total, block) => total + block.disclosure.execution.matrixSkipped, 0),
    /* AN AGREEMENT, never a majority and never the first package's answer. Every package in one
       composed run prepares on the same machine from the same policy, so they agree in practice -
       and on the day they do not, saying nothing is the only honest composition, because
       "borrowed" over a set that contains a rebuilt package is a false statement about where the
       evidence came from. The per-package blocks keep their own answers either way. */
    ...composeAgreement(blocks, (execution) => execution.environmentSource, "environmentSource"),
    ...composeAgreement(blocks, (execution) => execution.inheritedEnvironment, "inheritedEnvironment")
  };
}
function composeAgreement(blocks, pick, key) {
  const values = blocks.map((block) => pick(block.disclosure.execution));
  if (values.length === 0 || values.some((value) => value === void 0)) return {};
  const first = JSON.stringify(values[0]);
  if (!values.every((value) => JSON.stringify(value) === first)) return {};
  return { [key]: values[0] };
}
function composeBudget(blocks) {
  const sum = (pick) => blocks.reduce((total, block) => total + pick(block.disclosure.budget), 0);
  return {
    /* `rounds` is the CEILING each package ran under, not work done, so it is the largest ceiling
       any package was given - summing ceilings would describe a budget nobody had. `roundsRun` IS
       work done, so it sums. */
    rounds: Math.max(...blocks.map((block) => block.disclosure.budget.rounds)),
    roundsRun: sum((budget) => budget.roundsRun),
    modelCalls: sum((budget) => budget.modelCalls),
    modelCallsUsed: sum((budget) => budget.modelCallsUsed),
    executionCap: sum((budget) => budget.executionCap),
    /* "The loop stopped because it ran out of new work" is only true of the composed run when it
       was true of every package; "a ceiling ended the loop" is true as soon as one hit one. */
    stoppedOnDryRound: blocks.every((block) => block.disclosure.budget.stoppedOnDryRound),
    stoppedOnBudget: blocks.some((block) => block.disclosure.budget.stoppedOnBudget),
    /* Same rule as `stoppedOnBudget`, whose refinement this is: one package cut off by the clock is
       a composed run cut off by the clock. Absent rather than `false` when no package carried the
       field at all, so a block written before it existed does not compose into a claim. */
    ...blocks.some((block) => block.disclosure.budget.stoppedOnWallClock !== void 0) ? { stoppedOnWallClock: blocks.some((block) => block.disclosure.budget.stoppedOnWallClock === true) } : {}
  };
}
function recomposeProposalsScore(block) {
  if (block.state !== "completed" || block.packages === void 0) return;
  const completed = block.packages.map((entry) => entry.block).filter(isCompleted);
  const signedScore = composeSignedScore(completed);
  if (signedScore === void 0) delete block.disclosure.signedScore;
  else block.disclosure.signedScore = signedScore;
}
function composedRefusalReason(entries) {
  const distinct = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const reason = entry.block.reason ?? entry.block.state;
    const directories = distinct.get(reason) ?? [];
    directories.push(entry.directory);
    distinct.set(reason, directories);
  }
  const joined = distinct.size === 1 ? [...distinct.keys()][0] : [...distinct.entries()].map(([reason, directories]) => `${directories.join(", ")}: ${reason}`).join("; ");
  return joined.length <= COMPOSED_REASON_LIMIT ? joined : `${joined.slice(0, COMPOSED_REASON_LIMIT - 3).trimEnd()}...`;
}
function composeProposalsBlocks(entries) {
  if (entries.length === 0) {
    return { schema: PROPOSALS_BLOCK_SCHEMA, state: "not-run", reason: "no measurable package in this change" };
  }
  if (entries.length === 1) return entries[0].block;
  const ordered = [...entries].sort((left, right) => left.directory.localeCompare(right.directory));
  const packages = ordered.map((entry) => ({
    directory: entry.directory,
    block: entry.block
  }));
  const completed = ordered.map((entry) => entry.block).filter(isCompleted);
  if (completed.length === 0) {
    const states = new Set(ordered.map((entry) => entry.block.state));
    return {
      schema: PROPOSALS_BLOCK_SCHEMA,
      state: states.size === 1 ? [...states][0] : "unavailable",
      reason: composedRefusalReason(ordered),
      packages
    };
  }
  const sum = (pick) => completed.reduce((total, block) => total + pick(block), 0);
  const summaries = completed.flatMap((block) => block.summaries);
  const signedScore = composeSignedScore(completed);
  return {
    schema: PROPOSALS_BLOCK_SCHEMA,
    state: "completed",
    engineVersion: PROPOSALS_VERSION,
    survivorsIn: sum((block) => block.survivorsIn),
    gapsAttemptable: sum((block) => block.gapsAttemptable),
    gapsClosed: sum((block) => block.gapsClosed),
    proven: sum((block) => block.proven),
    rejected: sum((block) => block.rejected),
    notAttempted: sum((block) => block.notAttempted),
    summaries,
    funnel: composeFunnel(completed),
    disclosure: {
      ...signedScore === void 0 ? {} : { signedScore },
      execution: composeExecution(completed),
      budget: composeBudget(completed)
    },
    proofsDigest: composedProofsDigest(ordered),
    packages
  };
}

// src/catch-profile.ts
var CATCH_PROFILE_LIMIT = 50;
var EXECUTED = /* @__PURE__ */ new Set(["killed", "timeout", "survived", "no-coverage"]);
var MISSED = /* @__PURE__ */ new Set(["survived", "no-coverage"]);
var CAUGHT = /* @__PURE__ */ new Set(["killed", "timeout"]);
function testFileOf(canonical) {
  const at = canonical.indexOf("::");
  if (at <= 0) return null;
  return canonical.slice(0, at);
}
function buildCatchProfile(mutants, killerFilesOf) {
  const files = /* @__PURE__ */ new Map();
  const tests = /* @__PURE__ */ new Map();
  for (const mutant of mutants) {
    if (!EXECUTED.has(mutant.status)) continue;
    let entry = files.get(mutant.file);
    if (!entry) files.set(mutant.file, entry = { planted: 0, missed: 0 });
    entry.planted += 1;
    if (MISSED.has(mutant.status)) entry.missed += 1;
    if (!CAUGHT.has(mutant.status)) continue;
    const credited = /* @__PURE__ */ new Set();
    const direct = killerFilesOf?.(mutant);
    for (const testFile of direct ?? []) {
      if (credited.has(testFile)) continue;
      credited.add(testFile);
      tests.set(testFile, (tests.get(testFile) ?? 0) + 1);
    }
    if (direct !== void 0) continue;
    for (const canonical of mutant.killedByTests ?? []) {
      const testFile = testFileOf(canonical);
      if (testFile === null || credited.has(testFile)) continue;
      credited.add(testFile);
      tests.set(testFile, (tests.get(testFile) ?? 0) + 1);
    }
  }
  const rankedFiles = [...files.entries()].map(([file, counts]) => ({ file, planted: counts.planted, missed: counts.missed })).sort((a, b) => b.missed - a.missed || b.planted - a.planted || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const rankedTests = [...tests.entries()].map(([testFile, catches]) => ({ testFile, catches })).sort((a, b) => b.catches - a.catches || (a.testFile < b.testFile ? -1 : a.testFile > b.testFile ? 1 : 0));
  return {
    files: rankedFiles.slice(0, CATCH_PROFILE_LIMIT),
    catchingTests: rankedTests.slice(0, CATCH_PROFILE_LIMIT),
    filesTruncated: Math.max(0, rankedFiles.length - CATCH_PROFILE_LIMIT),
    catchingTestsTruncated: Math.max(0, rankedTests.length - CATCH_PROFILE_LIMIT)
  };
}

// src/loop.ts
import { readFileSync as readFileSync2 } from "fs";
import { join as join3 } from "path";

// src/concurrency.ts
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (; ; ) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// src/repair.ts
function buildRepairPrompt(input) {
  return [
    "A test you wrote does not pass against the REAL, unmodified source. Fix it.",
    "",
    `The project runs its tests with ${input.runner} and uses ${input.moduleFormat} module resolution.`,
    `The test file is at: ${input.candidate.testFile}`,
    `import the code under test as: ${input.context.importSpecifier}`,
    /* THE SAME EXPORTS BLOCK THE FIRST ATTEMPT GOT, signatures and all. It used to be the bare name
       list while generation had moved on, which is how three of run A's repairs kept an invented
       `readRunReports([documents])` call and hunted the result for a number that was never in it. */
    exportsLine(input.context),
    ...input.callShapeFailed !== true ? [] : [
      "",
      /* THE DIAGNOSIS, stated. `escalate-context` exists because re-asking with the same context
         produced a repaired test asserting `Math.max(...collectHitCounts(result)) === 12` on a
         result that was `-Infinity`: the premise was never questioned because nothing in the
         prompt questioned it. `repair-routing.ts` carries the measurement. */
      "WHAT THE FAILURE ACTUALLY SAYS: the runner read a property of something that was undefined or null. That is not a broken assertion - it means the entry point you called is not the one that produces this value, or you called it with the wrong arguments. Do not keep the same call and assert differently. Re-read the signatures above, pick the export whose parameters match the data you have, and build the test around what its return type actually declares."
    ],
    "",
    "The test as you wrote it:",
    "```",
    input.candidate.testBody,
    "```",
    "",
    "What the runner said when it ran against the real source:",
    "```",
    input.failureOutput,
    "```",
    "",
    `The code under test, from line ${input.context.sliceStartLine}:`,
    "```",
    input.context.slice,
    "```",
    "",
    `The change this test must detect, at line ${input.gap.startLine}, mutator ${input.gap.mutator}:`,
    `  before: ${input.gap.originalText}`,
    `  after:  ${input.gap.replacement}`,
    "",
    "Rules:",
    "1. The repaired test must PASS against the real source above AND FAIL when the change is applied. Both, or it is worth nothing.",
    "2. DO NOT weaken the assertion to make it pass. Removing the assertion that detects the change turns a broken test into a useless one, and the whole-suite proof will refuse it anyway. If the failure shows the test cannot be made to distinguish this change, return an empty testBody and say why in `note`.",
    "3. Fix the setup, not the subject: imports, module format, fixtures, async handling, timers. Do not stub or replace the function under test.",
    /* Rules 4 and 5 are the generation prompt's own, imported rather than restated, because the two
       must not drift: a repair asked under a stricter import rule than the candidate was written
       under would be told to undo the very pattern half of this engine's candidates rely on. They
       used to be duplicated here and the duplication is exactly how a drift happens. */
    ...importRules(),
    "",
    "Reply with ONE JSON object and nothing else - no markdown fence:",
    `{ "gapId": "${input.gap.gapId}", "testName": "<the exact name inside it(...)>", "testBody": "<the complete repaired test file source>", "note": "<optional>" }`
  ].join("\n");
}
async function repairCandidate(input) {
  const prompt = buildRepairPrompt({
    gap: input.gap,
    context: input.context,
    candidate: input.candidate,
    failureOutput: input.failureOutput,
    runner: input.runner,
    moduleFormat: input.moduleFormat,
    ...input.callShapeFailed === void 0 ? {} : { callShapeFailed: input.callShapeFailed }
  });
  const result = await input.client.call({
    task: "generation",
    pin: input.pin,
    prompt,
    jsonObject: false,
    gapCount: 1,
    ...input.remainingBudgetMs === void 0 ? {} : { remainingBudgetMs: input.remainingBudgetMs },
    signal: input.signal
  });
  const timings = [
    callRecord({
      task: "repair",
      round: input.round,
      gapIds: [input.gap.gapId],
      effort: input.pin.effort,
      result
    })
  ];
  if (!result.ok) {
    return {
      candidate: null,
      hold: {
        stage: "generation",
        reason: `repair: the model call failed: ${result.failure.kind}`,
        /* See `Hold.failureKind`: `repair.refusedByBudget` read 0 on a run where every repair call
           was refused for money, because the only record of that was this sentence. */
        failureKind: result.failure.kind,
        evidence: boundEvidence(result.failure.detail)
      },
      modelCalls: 1,
      timings
    };
  }
  const parsed = parseCandidatesReply(result.text);
  if (!parsed.ok) {
    return {
      candidate: null,
      hold: { stage: "generation", reason: `repair: ${parsed.reason}`, evidence: boundEvidence(result.text) },
      modelCalls: 1,
      timings
    };
  }
  const entry = parsed.candidates.find(
    (reply) => typeof reply.gapId !== "string" || reply.gapId === input.gap.gapId
  );
  const testBody = entry !== void 0 && typeof entry.testBody === "string" ? entry.testBody : "";
  if (testBody.trim() === "") {
    return {
      candidate: null,
      hold: {
        stage: "generation",
        reason: "repair: the model returned no repaired test for this gap",
        evidence: entry !== void 0 && typeof entry.note === "string" ? boundEvidence(entry.note) : void 0
      },
      modelCalls: 1,
      timings
    };
  }
  const declared = entry !== void 0 && typeof entry.testName === "string" && entry.testName.trim() !== "" ? entry.testName : firstDeclaredTestName(testBody);
  if (declared === null) {
    return {
      candidate: null,
      hold: {
        stage: "generation",
        reason: "repair: the repaired body carried no declared test name",
        evidence: boundEvidence(testBody)
      },
      modelCalls: 1,
      timings
    };
  }
  const effortUsed = result.timing?.effort ?? input.pin.effort;
  return {
    candidate: {
      /* The repair rides in the SAME round as the candidate it repairs - that is what "in-round"
         means, and it is what separates this from the next round re-asking from scratch. The body
         differs, so `candidateIdentity` gives it its own id and the sidecar carries both. */
      candidateId: candidateIdentity({
        gapId: input.gap.gapId,
        round: input.round,
        testFile: input.candidate.testFile,
        testBody,
        supportFiles: []
      }),
      gapId: input.gap.gapId,
      round: input.round,
      testFile: input.candidate.testFile,
      testName: declared,
      testBody,
      supportFiles: [],
      model: input.pin.model,
      /* `+repair` is part of the identity that produced this candidate, so the proof rate of
         repaired tests can be computed from the artifact without reading the sidecar - which is the
         check that says whether repair is buying weakened tests. */
      promptVersion: `${PROMPT_VERSION}+repair@${effortUsed}`,
      repairedFrom: input.candidate.candidateId
    },
    modelCalls: 1,
    timings
  };
}

// src/repair-routing.ts
var RUNNER_CAPABILITY_FAILURES = [
  /*
   * MEASURED, four reproductions on run A. `admission.ts` blesses `t.mock.module("node:fs", …)` and
   * generation rule 4 asks for it, while `sealedRunnerCommand`'s node-test row invoked plain
   * `node --test`, where the flag that creates it is absent and the property is `undefined`. The
   * flag is now added when the runtime accepts it (`core/src/sealed-test-command.ts`); this entry is
   * what keeps a run on a runtime that does NOT accept it from spending a call per candidate
   * learning the same thing.
   */
  { text: "t.mock.module is not a function", capability: "node:test module mocks (--experimental-test-module-mocks)" },
  /* The same call written against a destructured `mock`, which is the other spelling models use. */
  { text: "mock.module is not a function", capability: "node:test module mocks (--experimental-test-module-mocks)" },
  /*
   * The runtime has no such builtin. Node raises this by name for an unknown `node:` specifier, and
   * no rewrite of the test conjures the module - the only fix is a different runtime.
   */
  { text: "ERR_UNKNOWN_BUILTIN_MODULE", capability: "a built-in module this runtime does not carry" }
];
var RESULT_SHAPE_FAILURES = [
  /* V8, node 16+ and chromium: `Cannot read properties of undefined (reading 'perTest')` */
  "Cannot read properties of undefined",
  "Cannot read properties of null",
  /* V8, older spelling, still emitted by some bundled runtimes */
  "Cannot read property ",
  /* JavaScriptCore, which is what bun reports: `undefined is not an object (evaluating 'x.y')` */
  "undefined is not an object",
  "null is not an object"
];
function routeRepair(failureOutput) {
  for (const entry of RUNNER_CAPABILITY_FAILURES) {
    if (failureOutput.includes(entry.text)) return { route: "runner-capability", capability: entry.capability };
  }
  for (const text of RESULT_SHAPE_FAILURES) {
    if (failureOutput.includes(text)) return { route: "escalate-context" };
  }
  return { route: "repair" };
}
function capabilityHoldReason(capability) {
  return `the runner cannot execute this test: it needs ${capability}, which this run's runtime does not provide`;
}

// src/loop.ts
var RULED_GENERATION_BATCH_SIZE = 2;
var RULED_MATRIX_CELLS_PER_ROUND = 50;
var RULED_IN_ROUND_REPAIR = true;
var PROMOTED_ORIGINS = ["proven-witness", "carried-proposal"];
var PROMOTED_ROUND = 0;
async function runMarigold(input) {
  const started = Date.now();
  const budget = { ...DEFAULT_BUDGET, ...input.budget };
  const pins = input.pins ?? { triage: DEFAULT_TASK_PINS.triage, generation: DEFAULT_TASK_PINS.generation };
  const batchSize = input.batchSize ?? RULED_GENERATION_BATCH_SIZE;
  const generationConcurrency = input.generationConcurrency ?? 8;
  const targetedTimeoutMs = input.targetedTimeoutMs ?? 12e4;
  const suiteTimeoutMs = input.suiteTimeoutMs ?? 6e5;
  const progress = input.onProgress ?? (() => {
  });
  const stream = input.stream;
  const matrixCellsPerRound = input.matrixCellsPerRound ?? RULED_MATRIX_CELLS_PER_ROUND;
  const repairEnabled = input.repairOnRealNotPassing ?? RULED_IN_ROUND_REPAIR;
  const repairStats = {
    eligible: 0,
    attempted: 0,
    modelCalls: 0,
    returnedCandidate: 0,
    admitted: 0,
    distinguishing: 0,
    refusedByBudget: 0,
    refusedByCapability: 0,
    modelMs: 0,
    distinguishingCandidateIds: [],
    ms: 0
  };
  const modelCallTimings = [];
  const executionsBefore = input.runner.executions;
  const executionsUsed = () => input.runner.executions - executionsBefore;
  const executionsLeft = () => Math.max(0, budget.executions - executionsUsed());
  let runsReported = executionsBefore;
  const reportRuns = () => {
    const delta = input.runner.executions - runsReported;
    if (delta <= 0) return;
    runsReported = input.runner.executions;
    stream?.record({ kind: "counts", add: { testRuns: delta } });
  };
  const funnel = emptyFunnel();
  const ledger = new FeedbackLedger();
  const metrics = { totalMs: 0, generationMs: 0, lightCheckMs: 0, matrixMs: 0, exitProofMs: 0 };
  let deadline = started + effectiveTotalMs(budget, 0);
  const outOfTime = () => Date.now() >= deadline || input.signal?.aborted === true;
  const intake = intakeSurvivors(input.mutants);
  const alreadyTaken = new Set(intake.gaps.map((gap) => gap.gapId));
  const firstCoverage = (input.firstCoverageGaps ?? []).filter((gap) => !alreadyTaken.has(gap.gapId));
  intake.gaps.push(...firstCoverage);
  const survivorsIn = input.mutants.filter((m) => m.status === "survived" || m.status === "no-coverage").length + firstCoverage.length;
  funnel.intake.entered = survivorsIn;
  funnel.intake.advanced = intake.gaps.length;
  funnel.intake.held = intake.excluded.filter((e) => e.reason !== "not-a-survivor").length;
  for (const exclusion of intake.excluded) {
    if (exclusion.reason === "not-a-survivor") continue;
    funnel.intake.holdReasons[exclusion.reason] = (funnel.intake.holdReasons[exclusion.reason] ?? 0) + 1;
  }
  progress(
    firstCoverage.length === 0 ? `marigold: ${intake.gaps.length} attemptable gap(s) from ${survivorsIn} survivor(s)` : `marigold: ${intake.gaps.length} attemptable gap(s) from ${survivorsIn} survivor(s), ${firstCoverage.length} of them changed function(s) no test executes`
  );
  const suitePackages = suiteTestPackages({
    readFile: (path) => {
      try {
        return readFileSync2(join3(input.repoDir, path), "utf8");
      } catch {
        return null;
      }
    },
    testFilePaths: input.testFilePaths,
    specifiersOf: moduleSpecifiers
  });
  const placements = /* @__PURE__ */ new Map();
  const contexts = /* @__PURE__ */ new Map();
  for (const gap of intake.gaps) {
    const placement = placeCandidate({
      testFilePaths: input.testFilePaths,
      targetFile: gap.file,
      discriminator: gap.gapId.slice(0, 8)
    });
    placements.set(gap.gapId, placement.testFile);
    contexts.set(
      gap.gapId,
      buildGapContext({
        repoDir: input.repoDir,
        gap,
        testFile: placement.testFile,
        moduleFormat: input.moduleFormat,
        runner: input.runnerName,
        declaredServices: input.declaredServices ?? [],
        suitePackages
      })
    );
  }
  funnel.normalization.entered = intake.gaps.length;
  funnel.triage.entered = intake.gaps.length;
  const triage = await triageGaps({
    gaps: intake.gaps,
    contexts,
    client: input.client,
    pin: pins.triage,
    signal: input.signal,
    maxModelCalls: budget.modelCalls,
    upstreamTriaged: input.upstreamTriaged
  });
  let modelCallsUsed = triage.modelCalls;
  const normalizedOut = triage.records.filter((r) => r.source === "normalization" && r.verdict === "equivalent").length;
  funnel.normalization.advanced = intake.gaps.length - normalizedOut;
  funnel.normalization.held = normalizedOut;
  if (normalizedOut > 0) funnel.normalization.holdReasons["identical-after-normalization"] = normalizedOut;
  funnel.triage.advanced = triage.attemptable.length;
  funnel.triage.held = intake.gaps.length - triage.attemptable.length - normalizedOut;
  for (const record of triage.records) {
    if (record.verdict === "equivalent" && record.source === "model") {
      funnel.triage.holdReasons["model-called-equivalent"] = (funnel.triage.holdReasons["model-called-equivalent"] ?? 0) + 1;
    }
    if (record.hold !== void 0) ledger.record(record.gapId, 0, record.hold);
  }
  const keptByTriage = triage.attemptable.length;
  const routerSkipped = triage.attemptable.filter((gap) => contexts.get(gap.gapId)?.shape?.kind === "skip");
  for (const gap of routerSkipped) {
    const shape = contexts.get(gap.gapId)?.shape;
    if (shape === void 0 || shape.kind !== "skip") continue;
    const hold = { stage: "generation", reason: shape.why, evidence: `policy: ${shape.policy}` };
    ledger.record(gap.gapId, 0, hold);
    funnel.generation.entered += 1;
    funnel.generation.held += 1;
    funnel.generation.holdReasons[shape.why] = (funnel.generation.holdReasons[shape.why] ?? 0) + 1;
  }
  const attemptable = routerSkipped.length === 0 ? triage.attemptable : triage.attemptable.filter((gap) => contexts.get(gap.gapId)?.shape?.kind !== "skip");
  if (routerSkipped.length > 0) {
    progress(
      `marigold: ${routerSkipped.length} gap(s) need something this run cannot stand up (a real browser, or a network peer); each is recorded with the reason and cost no model call`
    );
  }
  const shapeCounts = shapeTally(attemptable, contexts);
  if (attemptable.length > 0) {
    progress(
      `marigold: test shapes - ${TEST_SHAPES.map((shape) => `${shapeCounts[shape]} ${shape}`).join(", ")}`
    );
  }
  deadline = started + effectiveTotalMs(budget, attemptable.length);
  progress(
    `marigold: triage kept ${keptByTriage} gap(s) (${normalizedOut} normalized away); wall-clock budget ${Math.round(effectiveTotalMs(budget, attemptable.length) / 1e3)}s`
  );
  stream?.record({ kind: "stage-started", stage: "loop" });
  stream?.record({
    kind: "counts",
    add: { gapsSetAside: Math.max(0, intake.gaps.length - attemptable.length) }
  });
  await stream?.flush();
  const gapsById = new Map(attemptable.map((gap) => [gap.gapId, gap]));
  const prepared = await input.runner.prepare();
  progress(
    `marigold: environment ${prepared.reused ? "reused" : "prepared"} (${prepared.runnerId}, sealed=${prepared.sealed})`
  );
  const distinguishing = /* @__PURE__ */ new Map();
  const lightChecks = [];
  const allCandidates = [];
  const kills = /* @__PURE__ */ new Map();
  const matrixCells = [];
  const covered = /* @__PURE__ */ new Set();
  const proofsByCandidate = /* @__PURE__ */ new Map();
  const discoveryByPath = /* @__PURE__ */ new Map();
  const proofRepetitions = input.proofRepetitions ?? DEFAULT_PROOF_REPETITIONS;
  const proofOptions = {
    runner: input.runner,
    timeoutMs: targetedTimeoutMs,
    suiteTimeoutMs,
    ...input.proofRepetitions === void 0 ? {} : { repetitions: input.proofRepetitions }
  };
  const runCheck = async (subject, gap) => {
    const checkStarted = Date.now();
    const result = await lightCheck(subject, gap, { runner: input.runner, timeoutMs: targetedTimeoutMs });
    metrics.lightCheckMs += Date.now() - checkStarted;
    lightChecks.push(result);
    return result;
  };
  const proveOne = async (candidate, withinRound) => {
    if (input.signal?.aborted === true) return null;
    if (withinRound) {
      const cost = (discoveryByPath.has(candidate.testFile) ? 0 : 1) + 2 * proofRepetitions;
      if (executionsUsed() + cost > budget.executions) return null;
    }
    const proofStarted = Date.now();
    const result = await proveCandidate({
      candidate,
      gap: gapsById.get(candidate.gapId),
      runnerName: input.runnerName,
      options: proofOptions,
      discoveryByPath
    });
    metrics.exitProofMs += Date.now() - proofStarted;
    proofsByCandidate.set(candidate.candidateId, result);
    return result;
  };
  let matrixSkipped = 0;
  let matrixCapRoundsBound = 0;
  let matrixCapCellsRefused = 0;
  let roundsRun = 0;
  let stoppedOnDryRound = false;
  let stoppedOnBudget = false;
  let stoppedOnWallClock = false;
  const refused = /* @__PURE__ */ new Set();
  const carriedProposals = input.carry?.proposals({ gaps: attemptable, recipeDigest: prepared.recipeDigest }) ?? [];
  const offers = [...input.promoted ?? [], ...carriedProposals];
  const promotion = {
    offered: offers.length,
    unmatched: 0,
    admitted: 0,
    distinguishing: 0,
    gapsClosedBeforeGeneration: 0,
    carried: { offered: 0, admitted: 0, distinguishing: 0, rejectedGapIds: [] }
  };
  const promotedIds = /* @__PURE__ */ new Set();
  const carriedGapByCandidate = /* @__PURE__ */ new Map();
  for (const offer of offers) {
    const isCarried = offer.origin === "carried-proposal";
    if (isCarried) promotion.carried.offered += 1;
    const gap = gapsById.get(offer.gapId);
    if (gap === void 0 || covered.has(offer.gapId)) {
      promotion.unmatched += 1;
      continue;
    }
    const supportFiles = offer.supportFiles ?? [];
    const candidate = {
      candidateId: candidateIdentity({
        gapId: offer.gapId,
        round: PROMOTED_ROUND,
        testFile: offer.testFile,
        testBody: offer.testBody,
        supportFiles
      }),
      gapId: offer.gapId,
      round: PROMOTED_ROUND,
      testFile: offer.testFile,
      testName: offer.testName,
      testBody: offer.testBody,
      supportFiles,
      model: offer.model,
      promptVersion: offer.promptVersion
    };
    allCandidates.push(candidate);
    promotedIds.add(candidate.candidateId);
    if (isCarried) carriedGapByCandidate.set(candidate.candidateId, offer.gapId);
    funnel.admission.entered += 1;
    const admission = admitCandidate({
      testFile: candidate.testFile,
      testSource: candidate.testBody,
      supportFiles: candidate.supportFiles,
      allowedSupportPaths: supportFiles.map((file) => file.path),
      targetFile: gap.file
    });
    if (!admission.admitted) {
      const hold = {
        stage: "admission",
        reason: admission.findings.map((finding) => finding.rule).join(", "),
        evidence: admission.findings.map((finding) => `${finding.rule}: ${finding.detail}`).join("\n")
      };
      funnel.admission.held += 1;
      refused.add(candidate.candidateId);
      ledger.record(candidate.gapId, PROMOTED_ROUND, hold);
      countHold(funnel, hold);
      if (isCarried) promotion.carried.rejectedGapIds.push(offer.gapId);
      continue;
    }
    funnel.admission.advanced += 1;
    promotion.admitted += 1;
    if (isCarried) promotion.carried.admitted += 1;
    if (executionsUsed() + 2 > budget.executions || outOfTime()) {
      stoppedOnBudget = true;
      if (outOfTime()) stoppedOnWallClock = true;
      ledger.record(candidate.gapId, PROMOTED_ROUND, {
        stage: "light-check",
        /* The condition is "executions gone OR out of time", and the sentence used to name only the
           first however the run actually ended. See the same fix at the round's own light check. */
        reason: outOfTime() ? "the wall-clock budget ended before this already-proven test could be checked" : "the execution budget ended before this already-proven test could be checked"
      });
      continue;
    }
    funnel["light-check"].entered += 1;
    const promotedCheckStarted = Date.now();
    const check = await lightCheck(candidate, gap, { runner: input.runner, timeoutMs: targetedTimeoutMs });
    metrics.lightCheckMs += Date.now() - promotedCheckStarted;
    lightChecks.push(check);
    if (check.verdict !== "distinguishes") {
      const hold = {
        stage: "light-check",
        reason: lightCheckHoldReason(check.verdict, check.gateShaped === true),
        evidence: [check.real?.report, check.mutant?.report].filter((report) => report !== void 0 && report !== "").join("\n---\n")
      };
      funnel["light-check"].held += 1;
      refused.add(candidate.candidateId);
      ledger.record(candidate.gapId, PROMOTED_ROUND, hold);
      countHold(funnel, hold);
      if (isCarried) promotion.carried.rejectedGapIds.push(offer.gapId);
      continue;
    }
    funnel["light-check"].advanced += 1;
    distinguishing.set(candidate.candidateId, candidate);
    kills.set(candidate.candidateId, /* @__PURE__ */ new Set([candidate.gapId]));
    stream?.record({ kind: "counts", add: { testsWritten: 1 } });
    const proof = await proveOne(candidate, true);
    if (proof !== null && proof.verdict !== "proven") {
      distinguishing.delete(candidate.candidateId);
      kills.delete(candidate.candidateId);
      proofsByCandidate.delete(candidate.candidateId);
      refused.add(candidate.candidateId);
      funnel["exit-proof"].entered += 1;
      funnel["exit-proof"].held += 1;
      if (proof.hold !== void 0) {
        ledger.record(offer.gapId, PROMOTED_ROUND, proof.hold);
        countHold(funnel, proof.hold);
      }
      if (isCarried) promotion.carried.rejectedGapIds.push(offer.gapId);
      continue;
    }
    promotion.distinguishing += 1;
    if (isCarried) promotion.carried.distinguishing += 1;
    promotion.gapsClosedBeforeGeneration += 1;
    covered.add(candidate.gapId);
  }
  if (promotion.offered > 0) {
    const witnesses = promotion.offered - promotion.carried.offered;
    if (witnesses > 0) {
      progress(
        `marigold: ${promotion.gapsClosedBeforeGeneration - promotion.carried.distinguishing} of ${witnesses} already-proven test(s) held up against this run's gates; those gaps are never asked about`
      );
    }
    if (promotion.carried.offered > 0) {
      progress(
        `marigold: ${promotion.carried.distinguishing} of ${promotion.carried.offered} test(s) carried from an earlier push were proved here and closed their gap without a model call; ${promotion.carried.rejectedGapIds.length} did not hold up and were dropped, so those gaps are asked again`
      );
    }
    reportRuns();
    await stream?.flush();
  }
  for (let round = 1; round <= budget.rounds; round++) {
    const open = attemptable.filter((gap) => !covered.has(gap.gapId));
    if (open.length === 0) break;
    if (outOfTime() || modelCallsUsed >= budget.modelCalls || executionsUsed() >= budget.executions) {
      stoppedOnBudget = true;
      if (outOfTime()) stoppedOnWallClock = true;
      break;
    }
    roundsRun = round;
    const coveredBefore = covered.size;
    let roundRefusedOnBudget = false;
    const askedSpans = /* @__PURE__ */ new Set();
    const asked = [];
    const deferred = [];
    const openBySpan = /* @__PURE__ */ new Map();
    for (const gap of open) {
      const list = openBySpan.get(gap.spanKey) ?? [];
      list.push(gap);
      openBySpan.set(gap.spanKey, list);
    }
    for (const gap of open) {
      if (askedSpans.has(gap.spanKey)) {
        deferred.push(gap);
        continue;
      }
      askedSpans.add(gap.spanKey);
      asked.push(gap);
    }
    for (const gap of deferred) {
      ledger.record(gap.gapId, round, {
        stage: "generation",
        reason: "asked as part of the mutation at the same span, which is one question",
        evidence: `the same span carries ${openBySpan.get(gap.spanKey)?.length ?? 1} open mutations; a test written for one of them is replayed against this one by the kill matrix`
      });
    }
    const batches = [];
    for (let offset = 0; offset < asked.length; offset += batchSize) {
      const items = asked.slice(offset, offset + batchSize).map((gap) => ({
        gap,
        context: contexts.get(gap.gapId),
        testFile: placements.get(gap.gapId),
        /* Keyed on the SIBLING'S gapId, not on its replacement text: two mutators can substitute
           the same text at the same span and are still two gaps, and matching on the text would
           silently drop both from the list. Duplicated texts collapse afterwards, because a
           prompt listing the same replacement twice says nothing twice. */
        siblingReplacements: [
          ...new Set(
            (openBySpan.get(gap.spanKey) ?? []).filter((sibling) => sibling.gapId !== gap.gapId).map((sibling) => sibling.replacement)
          )
        ]
      })).filter((item) => item.context !== void 0 && item.testFile !== void 0);
      if (items.length > 0) batches.push(items);
    }
    const CALLS_PER_BATCH = 2;
    let reserved = modelCallsUsed;
    const batchReservations = batches.map(() => {
      const fits = reserved + CALLS_PER_BATCH <= budget.modelCalls;
      if (fits) reserved += CALLS_PER_BATCH;
      return fits;
    });
    const generationStarted = Date.now();
    const generatedBatches = await mapWithConcurrency(batches, generationConcurrency, async (items, index) => {
      if (outOfTime() || batchReservations[index] !== true) {
        stoppedOnBudget = true;
        roundRefusedOnBudget = true;
        if (outOfTime()) stoppedOnWallClock = true;
        return {
          candidates: [],
          holds: items.map((item) => ({
            gapId: item.gap.gapId,
            hold: {
              stage: "generation",
              reason: outOfTime() ? "the wall-clock budget ended before this batch was asked" : "the model-call budget had no slot left for this batch"
            }
          })),
          modelCalls: 0,
          timings: []
        };
      }
      if (input.client === null) {
        return {
          candidates: [],
          holds: items.map((item) => ({
            gapId: item.gap.gapId,
            hold: { stage: "generation", reason: "no model endpoint was available" }
          })),
          modelCalls: 0,
          timings: []
        };
      }
      return generateBatch({
        items,
        ledger,
        remainingBudgetMs: Math.max(0, deadline - Date.now()),
        client: input.client,
        pin: pins.generation,
        runner: input.runnerName,
        moduleFormat: input.moduleFormat,
        exampleTest: input.exampleTest,
        round,
        signal: input.signal
      });
    });
    metrics.generationMs += Date.now() - generationStarted;
    const roundCandidates = [];
    for (const [index, generated] of generatedBatches.entries()) {
      const items = batches[index];
      funnel.generation.entered += items.length;
      modelCallsUsed += generated.modelCalls;
      modelCallTimings.push(...generated.timings);
      funnel.generation.advanced += generated.candidates.length;
      funnel.generation.held += generated.holds.length;
      stream?.record({ kind: "counts", add: { testsWritten: generated.candidates.length } });
      for (const { gapId, hold } of generated.holds) {
        ledger.record(gapId, round, hold);
        countHold(funnel, hold);
        if (hold.failureKind === "budget") {
          stoppedOnBudget = true;
          roundRefusedOnBudget = true;
        }
      }
      allCandidates.push(...generated.candidates);
      for (const candidate of generated.candidates) {
        const gap = gapsById.get(candidate.gapId);
        if (gap === void 0) continue;
        funnel.admission.entered += 1;
        const admission = admitCandidate({
          testFile: candidate.testFile,
          testSource: candidate.testBody,
          supportFiles: candidate.supportFiles,
          allowedSupportPaths: candidate.supportFiles.map((file) => file.path),
          targetFile: gap.file
        });
        if (!admission.admitted) {
          const hold = {
            stage: "admission",
            reason: admission.findings.map((finding) => finding.rule).join(", "),
            evidence: admission.findings.map((finding) => `${finding.rule}: ${finding.detail}`).join("\n")
          };
          funnel.admission.held += 1;
          refused.add(candidate.candidateId);
          ledger.record(candidate.gapId, round, hold);
          countHold(funnel, hold);
          continue;
        }
        funnel.admission.advanced += 1;
        if (executionsUsed() + 2 > budget.executions || outOfTime()) {
          stoppedOnBudget = true;
          roundRefusedOnBudget = true;
          if (outOfTime()) stoppedOnWallClock = true;
          ledger.record(candidate.gapId, round, {
            stage: "light-check",
            /* WHICH CEILING, and it used to say the wrong one. The condition is "executions gone OR
               out of time", and replicate 1 of the node-cron regression was stopped by the CLOCK
               with 86 executions and 45 model calls unspent while the ledger told its reader the
               executions had run out. That sentence misdirects exactly the person diagnosing it. */
            reason: outOfTime() ? "the wall-clock budget ended before this candidate could be checked" : "the execution budget ended before this candidate could be checked"
          });
          continue;
        }
        funnel["light-check"].entered += 1;
        const check = await runCheck(candidate, gap);
        const entry = { candidate, gap, check };
        roundCandidates.push(entry);
        if (!repairEnabled || check.verdict !== "real-not-passing" || input.client === null) continue;
        repairStats.eligible += 1;
        const failureOutput = check.real?.report ?? "";
        const context = contexts.get(gap.gapId);
        const routing = routeRepair(failureOutput);
        if (routing.route === "runner-capability") {
          repairStats.refusedByCapability += 1;
          ledger.record(candidate.gapId, round, {
            stage: "light-check",
            reason: capabilityHoldReason(routing.capability ?? "a runner capability"),
            evidence: failureOutput
          });
          continue;
        }
        if (context === void 0) {
          ledger.record(candidate.gapId, round, {
            stage: "generation",
            reason: "repair: no gap context was available to build a repair prompt"
          });
          continue;
        }
        entry.repair = { context, failureOutput, callShapeFailed: routing.route === "escalate-context" };
      }
    }
    const repairable = roundCandidates.filter((entry) => entry.repair !== void 0);
    let repairReserved = modelCallsUsed;
    const repairAllowed = repairable.map(() => {
      if (repairReserved + 1 > budget.modelCalls) return false;
      repairReserved += 1;
      return true;
    });
    const repairPhaseStarted = Date.now();
    const repaired = await mapWithConcurrency(repairable, generationConcurrency, async (entry, at) => {
      if (!repairAllowed[at] || outOfTime()) return null;
      return repairCandidate({
        candidate: entry.candidate,
        gap: entry.gap,
        context: entry.repair.context,
        failureOutput: entry.repair.failureOutput,
        client: input.client,
        pin: pins.generation,
        runner: input.runnerName,
        moduleFormat: input.moduleFormat,
        round,
        /* The call is still spent; what changes is that the prompt names the CALL SHAPE as
           the suspect and carries the entry point's signatures, instead of re-asking with the
           context that produced the wrong shape in the first place. */
        callShapeFailed: entry.repair.callShapeFailed,
        remainingBudgetMs: Math.max(0, deadline - Date.now()),
        signal: input.signal
      });
    });
    if (repairable.length > 0) {
      repairStats.ms += Date.now() - repairPhaseStarted;
    }
    for (const entry of roundCandidates) {
      const { candidate, gap } = entry;
      let winner = candidate;
      let check = entry.check;
      const repairIndex = repairable.indexOf(entry);
      const outcome = repairIndex < 0 ? null : repaired[repairIndex];
      if (entry.repair !== void 0 && outcome === null) {
        repairStats.refusedByBudget += 1;
        stoppedOnBudget = true;
        roundRefusedOnBudget = true;
        if (outOfTime()) stoppedOnWallClock = true;
        ledger.record(candidate.gapId, round, {
          stage: "generation",
          reason: "repair: the budget had no slot for a repair call"
        });
      } else if (outcome !== null) {
        repairStats.attempted += 1;
        repairStats.modelCalls += outcome.modelCalls;
        repairStats.modelMs += outcome.timings.reduce((total, timing) => total + timing.latencyMs, 0);
        modelCallsUsed += outcome.modelCalls;
        modelCallTimings.push(...outcome.timings);
        if (outcome.candidate === null) {
          if (outcome.hold !== void 0) {
            ledger.record(candidate.gapId, round, outcome.hold);
            if (outcome.hold.failureKind === "budget") {
              repairStats.refusedByBudget += 1;
              stoppedOnBudget = true;
              roundRefusedOnBudget = true;
            }
          }
        } else {
          repairStats.returnedCandidate += 1;
          allCandidates.push(outcome.candidate);
          const repairAdmission = admitCandidate({
            testFile: outcome.candidate.testFile,
            testSource: outcome.candidate.testBody,
            supportFiles: outcome.candidate.supportFiles,
            allowedSupportPaths: outcome.candidate.supportFiles.map((file) => file.path),
            targetFile: gap.file
          });
          if (!repairAdmission.admitted) {
            ledger.record(candidate.gapId, round, {
              stage: "generation",
              reason: `repair: admission refused the repaired test (${repairAdmission.findings.map((f) => f.rule).join(", ")})`,
              evidence: repairAdmission.findings.map((f) => `${f.rule}: ${f.detail}`).join("\n")
            });
          } else {
            repairStats.admitted += 1;
            if (executionsUsed() + 2 > budget.executions || outOfTime()) {
              repairStats.refusedByBudget += 1;
              if (outOfTime()) stoppedOnWallClock = true;
              ledger.record(candidate.gapId, round, {
                stage: "light-check",
                reason: outOfTime() ? "repair: the wall-clock budget ended before the repaired test could be checked" : "repair: the execution budget ended before the repaired test could be checked"
              });
            } else {
              ledger.record(candidate.gapId, round, {
                stage: "light-check",
                reason: "repair: superseded by a repaired candidate in the same round",
                evidence: entry.repair?.failureOutput ?? ""
              });
              winner = outcome.candidate;
              check = await runCheck(outcome.candidate, gap);
              if (check.verdict === "distinguishes") {
                repairStats.distinguishing += 1;
                repairStats.distinguishingCandidateIds.push(outcome.candidate.candidateId);
              }
            }
          }
        }
      }
      if (check.verdict !== "distinguishes") {
        const hold = {
          stage: "light-check",
          reason: lightCheckHoldReason(check.verdict, check.gateShaped === true),
          evidence: [check.real?.report, check.mutant?.report].filter((r) => r !== void 0 && r !== "").join("\n---\n")
        };
        funnel["light-check"].held += 1;
        refused.add(winner.candidateId);
        ledger.record(winner.gapId, round, hold);
        countHold(funnel, hold);
        continue;
      }
      funnel["light-check"].advanced += 1;
      distinguishing.set(winner.candidateId, winner);
      covered.add(winner.gapId);
      const own = kills.get(winner.candidateId) ?? /* @__PURE__ */ new Set();
      own.add(winner.gapId);
      kills.set(winner.candidateId, own);
      await proveOne(winner, true);
    }
    const stillOpen = attemptable.filter((gap) => !covered.has(gap.gapId));
    const newCandidates = [...distinguishing.values()].filter((candidate) => candidate.round === round);
    if (newCandidates.length > 0 && stillOpen.length > 0 && !outOfTime()) {
      funnel["kill-matrix"].entered += newCandidates.length;
      const matrixStarted = Date.now();
      const budgetLeft = executionsLeft();
      const capBinds = matrixCellsPerRound < budgetLeft;
      const matrix = await buildKillMatrix({
        candidates: newCandidates,
        openGaps: stillOpen,
        options: {
          runner: input.runner,
          timeoutMs: targetedTimeoutMs,
          maxExecutions: Math.min(matrixCellsPerRound, budgetLeft)
        }
      });
      metrics.matrixMs += Date.now() - matrixStarted;
      matrixSkipped += matrix.skipped;
      if (capBinds && matrix.skipped > 0) {
        matrixCapRoundsBound += 1;
        matrixCapCellsRefused += matrix.skipped;
      }
      for (const cell of matrix.cells) {
        matrixCells.push({
          candidateId: cell.candidateId,
          gapId: cell.gapId,
          kills: cell.kills,
          executions: cell.executions,
          ...cell.hold === void 0 ? {} : { hold: cell.hold }
        });
        if (cell.kills) {
          covered.add(cell.gapId);
          const set = kills.get(cell.candidateId) ?? /* @__PURE__ */ new Set();
          set.add(cell.gapId);
          kills.set(cell.candidateId, set);
        } else if (cell.hold !== void 0) {
          ledger.record(cell.gapId, round, cell.hold);
        }
      }
      const closedByMatrix = matrix.cells.filter((cell) => cell.kills).length;
      funnel["kill-matrix"].advanced += closedByMatrix;
      funnel["kill-matrix"].held += matrix.cells.length - closedByMatrix;
      if (matrix.skipped > 0) {
        funnel["kill-matrix"].holdReasons["execution-ceiling"] = (funnel["kill-matrix"].holdReasons["execution-ceiling"] ?? 0) + matrix.skipped;
      }
      progress(`marigold: round ${round} matrix replayed ${matrix.executions} time(s), ${closedByMatrix} extra gap(s) covered`);
    }
    reportRuns();
    await stream?.flush();
    if (covered.size === coveredBefore) {
      if (roundRefusedOnBudget) {
        progress(`marigold: round ${round} closed nothing new, and the budget refused work in it; stopping on budget`);
        break;
      }
      stoppedOnDryRound = true;
      progress(`marigold: round ${round} closed nothing new; stopping on a dry round`);
      break;
    }
  }
  const coveredIds = [...covered];
  const winning = chooseWinningSet(kills, coveredIds);
  const chosen = winning.chosen.map((id) => distinguishing.get(id)).filter((candidate) => candidate !== void 0);
  const alsoCloses = new Map(
    chosen.map((candidate) => [
      candidate.candidateId,
      [...kills.get(candidate.candidateId) ?? []].filter((gapId) => gapId !== candidate.gapId && covered.has(gapId))
    ])
  );
  funnel["exit-proof"].entered += chosen.length;
  stream?.record({ kind: "stage-finished", stage: "loop" });
  stream?.record({ kind: "stage-started", stage: "proof" });
  reportRuns();
  await stream?.flush();
  const proofResults = /* @__PURE__ */ new Map();
  const provenCandidates = [];
  for (const candidate of chosen) {
    let result = proofsByCandidate.get(candidate.candidateId) ?? null;
    if (result === null) result = await proveOne(candidate, false);
    if (result === null) {
      const cancelled = input.signal?.aborted === true;
      if (!cancelled) stoppedOnBudget = true;
      if (!cancelled && outOfTime()) stoppedOnWallClock = true;
      result = {
        candidateId: candidate.candidateId,
        gapId: candidate.gapId,
        verdict: "not-attempted-budget",
        repetitions: [],
        suite: null,
        discovery: null,
        alsoCloses: [],
        hold: {
          stage: "exit-proof",
          reason: cancelled ? "the run was cancelled before the exit proof could run" : "the budget ended before the exit proof could run"
        },
        executions: 0
      };
    }
    result.alsoCloses = alsoCloses.get(candidate.candidateId) ?? [];
    proofResults.set(candidate.candidateId, result);
    if (result.verdict === "proven") provenCandidates.push(candidate);
  }
  let suiteBaseline = null;
  if (provenCandidates.length > 0 && input.signal?.aborted !== true) {
    const suiteStarted = Date.now();
    const suite = await proveSuite({
      proven: provenCandidates,
      resultsById: proofResults,
      options: { runner: input.runner, suiteTimeoutMs },
      baseline: measureSuiteBaseline({ runner: input.runner, suiteTimeoutMs })
    });
    suiteBaseline = suite.baseline;
    metrics.exitProofMs += Date.now() - suiteStarted;
  }
  const exitProofs = chosen.map((candidate) => proofResults.get(candidate.candidateId)).filter((result) => result !== void 0);
  for (const result of exitProofs) {
    if (result.verdict === "proven") {
      funnel["exit-proof"].advanced += 1;
      const candidate = distinguishing.get(result.candidateId);
      if (candidate !== void 0) {
        stream?.record({
          kind: "proposal",
          proposal: {
            testFile: candidate.testFile,
            testName: candidate.testName,
            alsoClosesCount: result.alsoCloses.length,
            /* The proven test's own source. It reaches the check body and the local sidecar; the
               signed block still carries only its digest. */
            testBody: candidate.testBody
          }
        });
      }
      stream?.record({ kind: "counts", add: { testsProven: 1 } });
    } else {
      funnel["exit-proof"].held += 1;
      refused.add(result.candidateId);
      const carriedGap = carriedGapByCandidate.get(result.candidateId);
      if (carriedGap !== void 0 && !promotion.carried.rejectedGapIds.includes(carriedGap)) {
        promotion.carried.rejectedGapIds.push(carriedGap);
      }
      if (result.hold !== void 0) {
        ledger.record(result.gapId, roundsRun, result.hold);
        countHold(funnel, result.hold);
      }
    }
  }
  stream?.record({ kind: "stage-finished", stage: "proof" });
  reportRuns();
  await stream?.flush();
  const plantedGapIds = new Set(input.plantedGapIds ?? []);
  const nearbyGapIds = new Set(input.nearbyGapIds ?? []);
  const summaries = exitProofs.map((result) => {
    const candidate = distinguishing.get(result.candidateId);
    const gap = candidate === void 0 ? void 0 : gapsById.get(candidate.gapId);
    return {
      mutantId: gap?.mutantId ?? "",
      gapId: result.gapId,
      /* KEYED ON THE GAP, NOT ON THE CANDIDATE. `result.gapId` is the gap this proof closed, so a
         pool-2 gap closed by a generated test still reports the origin of its own bug. */
      origin: plantedGapIds.has(result.gapId) ? "planted-bug" : nearbyGapIds.has(result.gapId) ? "nearby" : "mechanical",
      /* The gap's own location, so a run with no classic findings can still say where its weakness
         is. Read off the gap the verdict is ABOUT, which is resolvable even when no candidate
         survived to name it. */
      file: gapsById.get(result.gapId)?.file ?? "",
      startLine: gapsById.get(result.gapId)?.startLine ?? 0,
      candidateDigest: candidate === void 0 ? "" : candidateDigest({
        testFile: candidate.testFile,
        testBody: candidate.testBody,
        supportFiles: candidate.supportFiles
      }),
      verdict: result.verdict,
      round: candidate?.round ?? 0,
      runner: input.runnerName,
      model: candidate?.model ?? null,
      promptVersion: candidate?.promptVersion ?? "",
      /* THREE OUTCOMES, because green and regressed are not each other's negation. A suite that was
         already red before this run touched it is neither: it did not pass, and this candidate did
         not make it fail. Keyed off `regressed`, which is the judgement, rather than off `green`,
         which is only the colour. */
      suite: result.suite === null ? "not-checked" : result.suite.green ? "green" : result.suite.regressed ? "regressed" : "pre-red-unchanged",
      discovery: result.discovery?.confirmed === true ? "confirmed" : "unconfirmed",
      alsoClosesCount: result.alsoCloses.length,
      ...result.hold === void 0 ? {} : { holdReason: result.hold.reason },
      /* F6. Read off the gap's own context, which was built before anything was asked for the gap,
         so the rung says what the customer's code is shaped like rather than what became of the
         attempt. Omitted only when no context exists for the gap - a verdict a budget stop left
         behind with nothing resolvable - because a rung nothing measured is not a fact. */
      ...contexts.get(result.gapId) === void 0 ? {} : { routePurity: contexts.get(result.gapId).routePurity.rung }
    };
  });
  if (input.carry !== void 0) {
    input.carry.record({
      recipeDigest: prepared.recipeDigest,
      rejectedGapIds: promotion.carried.rejectedGapIds,
      carriable: allCandidates.filter(
        (candidate) => !refused.has(candidate.candidateId) && (!promotedIds.has(candidate.candidateId) || carriedGapByCandidate.has(candidate.candidateId))
      )
    });
  }
  const sidecar = {
    schema: PROPOSALS_SIDECAR_SCHEMA,
    sha: input.sha,
    intakeExclusions: intake.excluded,
    triage: triage.records,
    candidates: allCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      gapId: candidate.gapId,
      round: candidate.round,
      testFile: candidate.testFile,
      testName: candidate.testName,
      testBody: candidate.testBody,
      /* PROVENANCE AND SUPPORT FILES, both of which this projection used to drop (EVID-01). The
         support files participate in `candidateId`, so without them the document cannot recompute
         the identity every other row in it is keyed on. */
      ...candidate.supportFiles.length === 0 ? {} : { supportFiles: candidate.supportFiles.map((file) => ({ path: file.path, source: file.source })) },
      model: candidate.model,
      promptVersion: candidate.promptVersion,
      ...candidate.repairedFrom === void 0 ? {} : { repairedFrom: candidate.repairedFrom },
      ...promotedIds.has(candidate.candidateId) ? { promoted: true } : {}
    })),
    lightChecks,
    matrix: matrixCells,
    modelCallTimings,
    exitProofs,
    ledger: ledger.gaps().flatMap(
      (gapId) => ledger.for(gapId).map((entry) => ({
        gapId,
        round: entry.round,
        stage: entry.stage,
        reason: entry.reason,
        ...entry.evidence === void 0 ? {} : { evidence: entry.evidence }
      }))
    ),
    repair: repairStats,
    promotion
  };
  const sidecarText = `${JSON.stringify(sidecar, null, 2)}
`;
  const uploadSidecarText = uploadableSidecarText(survivorProofsProjection(sidecar));
  const closedGapIds = /* @__PURE__ */ new Set();
  for (const result of exitProofs) {
    if (result.verdict !== "proven") continue;
    closedGapIds.add(result.gapId);
    for (const also of result.alsoCloses) closedGapIds.add(also);
  }
  const routePurity = buildRoutePurityDisclosure(
    triage.attemptable.flatMap((gap) => {
      const context = contexts.get(gap.gapId);
      return context === void 0 ? [] : [{ gapId: gap.gapId, rung: context.routePurity.rung }];
    }),
    closedGapIds
  );
  const disclosure = {
    ...routePurity === void 0 ? {} : { routePurity },
    /*
     * WHAT THE ROUTER DECIDED, over the same population the split above uses plus the gaps it
     * refused. The refused ones are counted here and NOT in `shapes`, because a gap nothing was
     * asked for is not a gap that was given a shape - collapsing the two would let a run report
     * every gap as routed while writing nothing for some of them.
     */
    testShapes: {
      ...shapeCounts,
      skipped: routerSkipped.length,
      skippedReasons: routerSkipped.reduce((counts, gap) => {
        const shape = contexts.get(gap.gapId)?.shape;
        if (shape?.kind !== "skip") return counts;
        counts[shape.policy] = (counts[shape.policy] ?? 0) + 1;
        return counts;
      }, {})
    },
    /* PRESENT ONLY WHEN THE RUN MEASURED IT, which is only when the suite came back red carrying the
       winning set. Counts and never names - the name half of a test identity stays on the customer's
       machine (`catch-profile.ts`). */
    ...suiteBaseline === null ? {} : {
      suiteBaseline: {
        green: suiteBaseline.green,
        failed: suiteBaseline.failed,
        named: suiteBaseline.failures === null ? null : suiteBaseline.failures.length,
        ...suiteBaseline.error === void 0 ? {} : { error: suiteBaseline.error }
      }
    },
    /* DISCLOSED ONLY WHEN IT BOUND. A ceiling that refused nothing says nothing about this run, and
       a block that carried it every time would train a reader to skip it. */
    ...matrixCapRoundsBound > 0 ? {
      matrixCap: {
        cellsPerRound: matrixCellsPerRound,
        roundsBound: matrixCapRoundsBound,
        cellsRefused: matrixCapCellsRefused
      }
    } : {},
    execution: {
      runnerId: prepared.runnerId,
      sealed: prepared.sealed,
      /* THIS RUN'S executions, which on a shared runner is the difference and not the total: the
         field is documented as "container executions this run performed", and the night's other
         phases are not this run's work to claim. */
      executed: executionsUsed(),
      reusedPreparation: prepared.reused,
      matrixSkipped,
      /* WHICH ENVIRONMENT THIS RAN IN, straight from the preparation that answered it. Absent when
         the runner does not answer the question at all - see `PreparedEnvironment`. */
      ...prepared.environmentSource === void 0 ? {} : { environmentSource: prepared.environmentSource },
      ...prepared.inherited === void 0 ? {} : { inheritedEnvironment: prepared.inherited },
      /* WHAT CEILING THIS RUN HAD, so a failure nobody can explain later has the number in front of
         it. Absent when the runner bounds no processes - see `PreparedEnvironment.processCeiling`. */
      ...prepared.processCeiling === void 0 ? {} : { processCeiling: prepared.processCeiling }
    },
    budget: {
      rounds: budget.rounds,
      roundsRun,
      modelCalls: budget.modelCalls,
      modelCallsUsed,
      executionCap: budget.executions,
      stoppedOnDryRound,
      stoppedOnBudget,
      stoppedOnWallClock
    }
  };
  metrics.totalMs = Date.now() - started;
  return {
    block: buildProposalsBlock({
      survivorsIn,
      gapsAttemptable: triage.attemptable.length,
      summaries,
      funnel,
      disclosure,
      proofsDigest: sidecarDigest(uploadSidecarText)
    }),
    sidecar,
    sidecarText,
    uploadSidecarText,
    metrics
  };
}
function shapeTally(gaps, contexts) {
  const counts = Object.fromEntries(TEST_SHAPES.map((shape) => [shape, 0]));
  for (const gap of gaps) {
    const shape = contexts.get(gap.gapId)?.shape;
    if (shape?.kind === "route") counts[shape.shape] += 1;
  }
  return counts;
}
function countHold(funnel, hold) {
  const stage = funnel[hold.stage];
  stage.holdReasons[hold.reason] = (stage.holdReasons[hold.reason] ?? 0) + 1;
}

// src/gutting.ts
import { readFileSync as readFileSync3, existsSync as existsSync2 } from "fs";
import { join as join4 } from "path";
var GUTTING_MUTATOR = "WholeBodyGutting";
var GUTTING_LABELS = ["return-gutting", "void-gutting", "not-measurable"];
var GUTTING_ROUTES = ["pseudo-tested", "tests-fight-back", "not-measurable", "not-executed"];
function changedFunctions(repoDir, file, changedLines) {
  const absolute = join4(repoDir, file);
  if (!existsSync2(absolute)) return [];
  const source = readFileSync3(absolute, "utf8");
  const wanted = new Set(changedLines);
  return detectFunctions(source, file).filter((fn) => {
    for (const line of wanted) {
      if (line >= fn.startLine && line <= fn.endLine) return true;
    }
    return false;
  }).map((fn) => ({ file, ...fn }));
}
function fileFunctions(repoDir, file) {
  const absolute = join4(repoDir, file);
  if (!existsSync2(absolute)) return [];
  return detectFunctions(readFileSync3(absolute, "utf8"), file).map((fn) => ({ file, ...fn }));
}
function planGutting(repoDir, fn) {
  const absolute = join4(repoDir, fn.file);
  const source = readFileSync3(absolute, "utf8");
  const { bodyStart, bodyEnd } = fn;
  if (source[bodyStart - 1] !== "{" || source[bodyEnd] !== "}" || bodyEnd < bodyStart) {
    return { ...fn, label: "not-measurable" };
  }
  const body = source.slice(bodyStart, bodyEnd);
  if (body.trim() === "") {
    return { ...fn, label: "not-measurable" };
  }
  const returnsValue = /\breturn\s+[^;\s]/u.test(body) || /\bthrow\b/u.test(body);
  const replacementBody = returnsValue ? " return undefined; " : "";
  const label = returnsValue ? "return-gutting" : "void-gutting";
  const before = source.slice(0, bodyStart);
  const startLine = before.split("\n").length;
  const startColumn = bodyStart - (before.lastIndexOf("\n") + 1) + 1;
  const beforeEnd = source.slice(0, bodyEnd);
  const endLine = beforeEnd.split("\n").length;
  const endColumn = bodyEnd - (beforeEnd.lastIndexOf("\n") + 1) + 1;
  const gap = {
    gapId: gapIdentity({
      file: fn.file,
      startLine,
      startColumn,
      endLine,
      endColumn,
      mutator: GUTTING_MUTATOR,
      replacement: replacementBody
    }),
    spanKey: spanIdentity({ file: fn.file, startLine, startColumn, endLine, endColumn }),
    mutantId: `${fn.file}:${fn.startLine}:${GUTTING_MUTATOR}`,
    file: fn.file,
    startLine,
    endLine,
    startColumn,
    endColumn,
    mutator: GUTTING_MUTATOR,
    replacement: replacementBody,
    originalText: body,
    coveredBy: 0
  };
  return { ...fn, label, gap };
}
async function runGuttingPass(input) {
  const results = [];
  let stoppedEarly = null;
  let executionMs = 0;
  let executed = 0;
  for (const fn of input.functions) {
    if (executed > 0 && input.admitNextFunction !== void 0) {
      const admitted = input.admitNextFunction({
        done: results.length,
        total: input.functions.length,
        unitMs: executionMs / executed
      });
      if (!admitted) {
        stoppedEarly = { gutted: results.length, total: input.functions.length };
        break;
      }
    }
    const entry = planGutting(input.repoDir, fn);
    if (entry.gap === void 0) {
      results.push({ entry, route: "not-measurable", executions: 0 });
      continue;
    }
    const startedAtMs = Date.now();
    const run = await input.runner.execute({
      files: [],
      patches: [entry.gap],
      mode: "suite",
      timeoutMs: input.timeoutMs
    });
    const difference = await readMutantRun({ run, baseline: input.suiteBaseline });
    executionMs += Date.now() - startedAtMs;
    executed += 1 + difference.baselineExecutions;
    results.push({
      entry,
      route: difference.reading === "not-executed" ? "not-executed" : difference.reading === "noticed" ? "tests-fight-back" : "pseudo-tested",
      /* THE GUTTED RUN, and not the baseline beside it: this counter is what the night reports as
         test runs and what a reader reads as "one suite run per changed function". The unpatched
         side is the RUN's shared measurement, asked at most once and counted in `runner.executions`
         like every other execution - see the slice's own note. The MEAN above holds both, because
         the stage really spent both and a work-item boundary is priced from what was spent. */
      executions: 1
    });
  }
  const summary = {
    functionsChanged: input.functions.length,
    gutted: results.filter((result) => result.entry.gap !== void 0).length,
    pseudoTested: results.filter((result) => result.route === "pseudo-tested").length,
    testsFightBack: results.filter((result) => result.route === "tests-fight-back").length,
    notMeasurable: results.filter((result) => result.route === "not-measurable").length,
    notExecuted: results.filter((result) => result.route === "not-executed").length,
    executions: results.reduce((total, result) => total + result.executions, 0),
    stoppedEarly
  };
  return { results, summary };
}
function pseudoTestedGaps(results) {
  return results.filter((result) => result.route === "pseudo-tested" && result.entry.gap !== void 0).map((result) => result.entry.gap);
}

// src/line-pass.ts
import { existsSync as existsSync3, readFileSync as readFileSync4 } from "fs";
import { join as join5 } from "path";
import ts3 from "typescript";
var LINE_MUTATOR = "LineOperator";
var LINE_OPERATORS = [
  /** `<` <-> `<=`, `>` <-> `>=` - the boundary a loop or a guard is written at */
  "boundary",
  /** `===` <-> `!==`, `==` <-> `!=` - the sense of an equality test */
  "equality",
  /** `&&` <-> `||` - the sense of a compound condition */
  "logical",
  /** `+` <-> `-`, `*` <-> `/` - an arithmetic slip */
  "arithmetic",
  /** an integer literal moved by one - the off-by-one, at the literal itself */
  "literal-increment",
  /** `true` <-> `false` */
  "boolean-flip"
];
var BINARY_SWAPS = [
  { from: "<=", to: "<", operator: "boundary" },
  { from: ">=", to: ">", operator: "boundary" },
  { from: "<", to: "<=", operator: "boundary" },
  { from: ">", to: ">=", operator: "boundary" },
  { from: "===", to: "!==", operator: "equality" },
  { from: "!==", to: "===", operator: "equality" },
  { from: "==", to: "!=", operator: "equality" },
  { from: "!=", to: "==", operator: "equality" },
  { from: "&&", to: "||", operator: "logical" },
  { from: "||", to: "&&", operator: "logical" },
  { from: "+", to: "-", operator: "arithmetic" },
  { from: "-", to: "+", operator: "arithmetic" },
  { from: "*", to: "/", operator: "arithmetic" },
  { from: "/", to: "*", operator: "arithmetic" }
];
function lineOperatorInventory() {
  const byOperator = /* @__PURE__ */ new Map();
  for (const swap of BINARY_SWAPS) {
    const seen = byOperator.get(swap.operator) ?? /* @__PURE__ */ new Set();
    seen.add(`${swap.from} for ${swap.to}`);
    byOperator.set(swap.operator, seen);
  }
  const rewrites = [];
  for (const [operator, swaps] of byOperator) {
    rewrites.push({ id: operator, rewrite: `swaps one operator token for another: ${[...swaps].join(", ")}` });
  }
  rewrites.push({
    id: "literal-increment",
    rewrite: "adds one to an integer literal written in plain decimal digits, and nothing else"
  });
  rewrites.push({ id: "boolean-flip", rewrite: "flips a `true` keyword to `false` and a `false` to `true`" });
  return rewrites.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function scriptKind3(fileName) {
  if (fileName.endsWith(".tsx")) return ts3.ScriptKind.TSX;
  if (/\.[cm]?ts$/u.test(fileName)) return ts3.ScriptKind.TS;
  if (fileName.endsWith(".jsx")) return ts3.ScriptKind.JSX;
  return ts3.ScriptKind.JS;
}
function syntaxErrorCount3(sourceFile) {
  const withDiagnostics = sourceFile;
  return withDiagnostics.parseDiagnostics?.length ?? 0;
}
function planLineMutants(source, file) {
  const sourceFile = ts3.createSourceFile(file, source, ts3.ScriptTarget.Latest, false, scriptKind3(file));
  if (syntaxErrorCount3(sourceFile) > 0) return [];
  const out = [];
  const emit = (start, end, replacement, operator) => {
    const originalText = source.slice(start, end);
    if (originalText === "" || originalText === replacement) return;
    const from = sourceFile.getLineAndCharacterOfPosition(start);
    const to = sourceFile.getLineAndCharacterOfPosition(end);
    const startLine = from.line + 1;
    const endLine = to.line + 1;
    const startColumn = from.character + 1;
    const endColumn = to.character + 1;
    out.push({
      file,
      startLine,
      endLine,
      operator,
      gap: {
        gapId: gapIdentity({ file, startLine, startColumn, endLine, endColumn, mutator: LINE_MUTATOR, replacement }),
        spanKey: spanIdentity({ file, startLine, startColumn, endLine, endColumn }),
        mutantId: `line:${file}:${startLine}:${startColumn}:${operator}`,
        file,
        startLine,
        endLine,
        startColumn,
        endColumn,
        mutator: LINE_MUTATOR,
        replacement,
        originalText,
        coveredBy: 0
      }
    });
  };
  const visit = (node) => {
    if (ts3.isBinaryExpression(node)) {
      const token = node.operatorToken;
      const text = source.slice(token.getStart(sourceFile), token.end);
      const swap = BINARY_SWAPS.find((entry) => entry.from === text);
      if (swap !== void 0) emit(token.getStart(sourceFile), token.end, swap.to, swap.operator);
    } else if (ts3.isNumericLiteral(node)) {
      const text = source.slice(node.getStart(sourceFile), node.end);
      if (/^\d+$/u.test(text) && text.length < 15) {
        emit(node.getStart(sourceFile), node.end, `${Number.parseInt(text, 10) + 1}`, "literal-increment");
      }
    } else if (node.kind === ts3.SyntaxKind.TrueKeyword || node.kind === ts3.SyntaxKind.FalseKeyword) {
      const start = node.getStart(sourceFile);
      emit(start, node.end, node.kind === ts3.SyntaxKind.TrueKeyword ? "false" : "true", "boolean-flip");
    }
    ts3.forEachChild(node, visit);
  };
  ts3.forEachChild(sourceFile, visit);
  return out;
}
function selectLineMutants(mutants, cap) {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error("the per-line pass mutants-per-file cap must be an integer >= 1 (there is no default)");
  }
  if (mutants.length <= cap) return [...mutants];
  const stride = mutants.length / cap;
  const picked = [];
  for (let index = 0; index < cap; index += 1) {
    picked.push(mutants[Math.floor(index * stride)]);
  }
  return picked;
}
var LINE_VERDICTS = ["survived", "killed", "not-measured"];
var RULED_LINE_PASS_MUTANTS_PER_FILE = 12;
var RULED_LINE_PASS_ATTRIBUTION_TEST_FILES = 4;
async function runLinePass(input) {
  if (!Number.isInteger(input.mutantsPerFile) || input.mutantsPerFile < 1) {
    throw new Error("the per-line pass mutantsPerFile must be an integer >= 1 (there is no default)");
  }
  if (!Number.isInteger(input.attributionTestFiles) || input.attributionTestFiles < 0) {
    throw new Error("the per-line pass attributionTestFiles must be an integer >= 0 (there is no default)");
  }
  const results = [];
  let executions = 0;
  let budgetSpent = false;
  for (const file of input.files) {
    if (input.stop()) {
      budgetSpent = true;
      break;
    }
    const absolute = join5(input.repoDir, file);
    if (!existsSync3(absolute)) continue;
    let source;
    try {
      source = readFileSync4(absolute, "utf8");
    } catch {
      continue;
    }
    const planned = selectLineMutants(planLineMutants(source, file), input.mutantsPerFile);
    if (planned.length === 0) {
      results.push({ file, contentDigest: sha256(source), outcomes: [], complete: true, executions: 0 });
      continue;
    }
    const outcomes = [];
    let fileExecutions = 0;
    let complete = true;
    const attributed = /* @__PURE__ */ new Map();
    for (const mutant of planned) {
      if (input.stop()) {
        complete = false;
        budgetSpent = true;
        break;
      }
      const suite = await input.runner.execute({
        files: [],
        patches: [mutant.gap],
        mode: "suite",
        timeoutMs: input.suiteTimeoutMs
      });
      fileExecutions += 1;
      if (suite.error !== void 0 || suite.gateShapedFailure === true) {
        outcomes.push({ startLine: mutant.startLine, endLine: mutant.endLine, operator: mutant.operator, verdict: "not-measured" });
        continue;
      }
      if (suite.report.passed) {
        outcomes.push({ startLine: mutant.startLine, endLine: mutant.endLine, operator: mutant.operator, verdict: "survived" });
        continue;
      }
      let covering = attributed.get(mutant.startLine);
      if (covering === void 0) {
        const scan = await attributeKill({
          gap: mutant.gap,
          runner: input.runner,
          testFilePaths: input.testFilePaths,
          limit: input.attributionTestFiles,
          timeoutMs: input.targetedTimeoutMs
        });
        fileExecutions += scan.executions;
        covering = scan.testFiles;
        if (covering.length > 0) attributed.set(mutant.startLine, covering);
      }
      outcomes.push({
        startLine: mutant.startLine,
        endLine: mutant.endLine,
        operator: mutant.operator,
        verdict: "killed",
        ...covering.length === 0 ? {} : { coveringTestFiles: covering }
      });
    }
    executions += fileExecutions;
    results.push({ file, contentDigest: sha256(source), outcomes, complete, executions: fileExecutions });
    if (!complete) break;
  }
  const measured = results.filter((entry) => entry.complete).length;
  return {
    files: results.filter((entry) => entry.complete),
    offered: input.files.length,
    measured,
    deferred: input.files.length - measured,
    budgetSpent,
    executions
  };
}
async function attributeKill(input) {
  let executions = 0;
  const tried = input.testFilePaths.slice(0, input.limit);
  for (const testFile of tried) {
    const run = await input.runner.execute({
      files: [],
      patches: [input.gap],
      mode: "targeted",
      testFile,
      timeoutMs: input.timeoutMs
    });
    executions += 1;
    if (run.error !== void 0 || run.gateShapedFailure === true) continue;
    if (!run.report.passed) return { testFiles: [testFile], executions };
  }
  return { testFiles: [], executions };
}

// src/line-map-store.ts
import { existsSync as existsSync4, mkdirSync, readFileSync as readFileSync5, writeFileSync } from "fs";
import { dirname as dirname3, join as join6 } from "path";

// src/pool2/covering-tests.ts
function buildCoverageIndex(mutants) {
  const byFile = /* @__PURE__ */ new Map();
  for (const mutant of mutants) {
    const tests = mutant.coveredByTests;
    if (tests === void 0) continue;
    const startLine = mutant.startLine;
    const endLine = mutant.endLine >= startLine ? mutant.endLine : startLine;
    const spans = byFile.get(mutant.file);
    const span = { startLine, endLine, tests };
    if (spans === void 0) byFile.set(mutant.file, [span]);
    else spans.push(span);
  }
  const index = {
    coveringTests(file, startLine, endLine) {
      const spans = byFile.get(file);
      if (spans === void 0) return null;
      const first = Math.min(startLine, endLine);
      const last = Math.max(startLine, endLine);
      const covering = /* @__PURE__ */ new Set();
      for (let line = first; line <= last; line++) {
        let answered2 = false;
        for (const span of spans) {
          if (span.startLine > line || span.endLine < line) continue;
          answered2 = true;
          for (const test of span.tests) covering.add(test);
        }
        if (!answered2) return null;
      }
      return [...covering].sort();
    },
    coveringFiles(file, startLine, endLine) {
      const identities = index.coveringTests(file, startLine, endLine);
      return identities === null ? null : coveringTestFiles(identities);
    }
  };
  return index;
}
function buildLineCoverageIndex(spans) {
  const byFile = /* @__PURE__ */ new Map();
  for (const span of spans) {
    const startLine = span.startLine;
    const endLine = span.endLine >= startLine ? span.endLine : startLine;
    const forFile = byFile.get(span.file);
    const entry = { startLine, endLine, testFiles: span.testFiles };
    if (forFile === void 0) byFile.set(span.file, [entry]);
    else forFile.push(entry);
  }
  return {
    coveringTests() {
      return null;
    },
    coveringFiles(file, startLine, endLine) {
      const recorded = byFile.get(file);
      if (recorded === void 0) return null;
      const first = Math.min(startLine, endLine);
      const last = Math.max(startLine, endLine);
      const files = /* @__PURE__ */ new Set();
      for (let line = first; line <= last; line++) {
        let answered2 = false;
        for (const span of recorded) {
          if (span.startLine > line || span.endLine < line) continue;
          answered2 = true;
          for (const testFile of span.testFiles) files.add(testFile);
        }
        if (!answered2) return null;
      }
      return [...files].sort();
    }
  };
}
function coveringTestFiles(identities) {
  const files = [];
  const seen = /* @__PURE__ */ new Set();
  for (const identity of identities) {
    const separator = identity.indexOf("::");
    if (separator <= 0) return null;
    const file = identity.slice(0, separator);
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}

// src/line-map-store.ts
var LINE_MAP_SCHEMA = "abloh-marigold-line-maps/v1";
var LINE_MAP_FILE_LIMIT = 2e3;
var LineMapStore = class _LineMapStore {
  #data;
  #path;
  constructor(path, data) {
    this.#path = path;
    this.#data = data;
  }
  /** A corrupt or wrong-schema file is no store: every read answers absent, which changes nothing. */
  static open(storeDir, repoKey) {
    const path = join6(storeDir, `${sha256(repoKey).slice(0, 32)}-line-maps.json`);
    const empty = { schema: LINE_MAP_SCHEMA, files: [] };
    if (!existsSync4(path)) return new _LineMapStore(path, empty);
    try {
      const parsed = JSON.parse(readFileSync5(path, "utf8"));
      if (parsed.schema !== LINE_MAP_SCHEMA || !Array.isArray(parsed.files)) return new _LineMapStore(path, empty);
      return new _LineMapStore(path, parsed);
    } catch {
      return new _LineMapStore(path, empty);
    }
  }
  get data() {
    return this.#data;
  }
  get path() {
    return this.#path;
  }
  /**
   * The record for a file, ONLY when it describes the bytes on disk right now.
   *
   * The caller supplies the digest because the caller is the one holding the source; recomputing it
   * here from a path would make this store read a repository, which is not its job and is not always
   * possible (the night's checkout is gone by the time a later reader asks).
   */
  fresh(file, contentDigest) {
    const record = this.#data.files.find((entry) => entry.file === file);
    if (record === void 0 || record.contentDigest !== contentDigest) return null;
    return record;
  }
  /** Every fresh record among the files the caller has digests for. */
  freshAmong(digests) {
    const out = [];
    for (const [file, digest] of digests) {
      const record = this.fresh(file, digest);
      if (record !== null) out.push(record);
    }
    return out;
  }
  /** Write one finished file's maps. Re-measuring a file replaces its record: the map is singular. */
  record(input) {
    if (!input.result.complete) return;
    const survivors = [];
    const coverage = [];
    for (const outcome of input.result.outcomes) {
      if (outcome.verdict === "survived") {
        survivors.push({ startLine: outcome.startLine, endLine: outcome.endLine, operator: outcome.operator });
        continue;
      }
      if (outcome.verdict !== "killed" || outcome.coveringTestFiles === void 0) continue;
      coverage.push({
        startLine: outcome.startLine,
        endLine: outcome.endLine,
        testFiles: [...outcome.coveringTestFiles]
      });
    }
    this.#data.files = [
      ...this.#data.files.filter((entry) => entry.file !== input.result.file),
      {
        file: input.result.file,
        contentDigest: input.result.contentDigest,
        nightId: input.nightId,
        measuredAtMs: input.nowMs,
        survivors,
        coverage,
        measured: input.result.outcomes.length
      }
    ];
    if (this.#data.files.length > LINE_MAP_FILE_LIMIT) {
      this.#data.files = [...this.#data.files].sort((a, b) => a.measuredAtMs - b.measuredAtMs).slice(-LINE_MAP_FILE_LIMIT);
    }
  }
  save() {
    mkdirSync(dirname3(this.#path), { recursive: true });
    writeFileSync(this.#path, `${JSON.stringify(this.#data, null, 2)}
`);
  }
};
function lineMapCoverageIndex(maps) {
  return buildLineCoverageIndex(
    maps.flatMap(
      (map) => map.coverage.map((span) => ({
        file: map.file,
        startLine: span.startLine,
        endLine: span.endLine,
        testFiles: span.testFiles
      }))
    )
  );
}

// src/slice-ledger.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync6, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname4, join as join7 } from "path";
var SLICE_LEDGER_SCHEMA = "abloh-marigold-slice-ledger/v1";
var SLICE_LEDGER_LIMIT = 1e3;
function sliceAnswerKey(input) {
  return sha256(
    [input.file, input.bodyDigest, [...input.coveringTestFileDigests].sort().join(","), input.runner].join(" ")
  );
}
var SliceLedger = class _SliceLedger {
  #data;
  #path;
  constructor(path, data) {
    this.#path = path;
    this.#data = data;
  }
  /** A corrupt or wrong-schema file is no ledger: every read answers absent, which measures. */
  static open(storeDir, repoKey) {
    const path = join7(storeDir, `${sha256(repoKey).slice(0, 32)}-slice-ledger.json`);
    const empty = { schema: SLICE_LEDGER_SCHEMA, answers: [] };
    if (!existsSync5(path)) return new _SliceLedger(path, empty);
    try {
      const parsed = JSON.parse(readFileSync6(path, "utf8"));
      if (parsed.schema !== SLICE_LEDGER_SCHEMA || !Array.isArray(parsed.answers)) {
        return new _SliceLedger(path, empty);
      }
      return new _SliceLedger(path, parsed);
    } catch {
      return new _SliceLedger(path, empty);
    }
  }
  get data() {
    return this.#data;
  }
  get path() {
    return this.#path;
  }
  /** The answer held under this key, or null - which is the same as never having asked. */
  lookup(key) {
    return this.#data.answers.find((answer) => answer.key === key) ?? null;
  }
  /**
   * Write one neighbour's answer, replacing whatever stood under the same key.
   *
   * `not-executed` IS NOT AN ANSWER AND IS NOT KEPT. It says the run itself failed, which is a fact
   * about a container rather than about the function - carrying it would make a machine that was
   * briefly broken look like a measurement, and the next run would trust it.
   */
  record(answer) {
    if (answer.outcome === "not-executed") return;
    const answers = this.#data.answers.filter((entry) => entry.key !== answer.key);
    answers.push(answer);
    answers.sort((a, b) => b.measuredAtMs - a.measuredAtMs);
    this.#data = { ...this.#data, answers: answers.slice(0, SLICE_LEDGER_LIMIT) };
  }
  save() {
    mkdirSync2(dirname4(this.#path), { recursive: true });
    writeFileSync2(this.#path, JSON.stringify(this.#data, null, 2) + "\n", { mode: 384 });
  }
};

// src/slice.ts
import { readFileSync as readFileSync7, readdirSync, existsSync as existsSync6, statSync } from "fs";
import { dirname as dirname5, join as join8, relative as relative2, resolve } from "path";
import { AUDITABLE_SOURCE_EXTENSIONS as SOURCE_EXTENSIONS, NON_SOURCE_DIRECTORIES, isAuditableSourcePath } from "@abloh/core";
var SLICE_ROLES = ["caller", "callee"];
var SLICE_REFUSAL_REASONS = [
  "method-call",
  "constructor-call",
  "external-module",
  "not-resolved",
  "top-level-call-site",
  "unnamed-function"
];
function sliceSourceFiles(repoDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join8(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NON_SOURCE_DIRECTORIES.has(entry.name)) walk(path);
        continue;
      }
      const repoRelative = relative2(repoDir, path);
      if (isAuditableSourcePath(repoRelative)) out.push(repoRelative);
    }
  };
  walk(repoDir);
  return out.sort();
}
function declarationAt(source, file, startLine) {
  for (const fn of detectFunctions(source, file)) {
    if (fn.startLine === startLine) return { name: fn.name, owner: fn.owner };
  }
  return { name: null, owner: null };
}
function definitionRange(source, file, name) {
  for (const fn of detectFunctions(source, file)) {
    if (fn.name === name && fn.owner === null) return fn;
  }
  return null;
}
function methodRange(source, file, owner, name) {
  for (const fn of detectFunctions(source, file)) {
    if (fn.name === name && fn.owner === owner) return fn;
  }
  return null;
}
var CALL_SITE = /([A-Za-z_$][\w$]*)\s*\(/gu;
var NOT_A_CALL = /* @__PURE__ */ new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "do",
  "return",
  "typeof",
  "await",
  "yield",
  "function",
  "import",
  "require",
  "super",
  "this"
]);
function callSites(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    CALL_SITE.lastIndex = 0;
    while ((match = CALL_SITE.exec(line)) !== null) {
      const name = match[1];
      if (NOT_A_CALL.has(name)) continue;
      const prefix = line.slice(0, match.index);
      if (/(?:function|class)\s*\*?\s*$/u.test(prefix)) continue;
      out.push({
        name,
        line: i + 1,
        method: /\.\s*$/u.test(prefix),
        thisReceiver: /(?:^|[^\w$.])this\s*\.\s*$/u.test(prefix),
        constructorCall: /(?:^|[^\w$])new\s+$/u.test(`${prefix} `.replace(/\s+$/u, " "))
      });
    }
  }
  return out;
}
function importBindings(source) {
  const out = [];
  const named = /import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"\n]+)['"]/gu;
  let match;
  while ((match = named.exec(source)) !== null) {
    for (const part of match[1].split(",")) {
      const cleaned = part.replace(/\btype\b/gu, "").trim();
      if (cleaned === "") continue;
      const [imported, local] = cleaned.split(/\s+as\s+/u).map((piece) => piece.trim());
      out.push({ localName: local ?? imported, specifier: match[2], imported });
    }
  }
  const defaultImport = /import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from)\s*(?:\{[^}]*\}\s*from\s*)?['"]([^'"\n]+)['"]/gu;
  while ((match = defaultImport.exec(source)) !== null) {
    out.push({ localName: match[1], specifier: match[2], imported: "default" });
  }
  const namespace = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"\n]+)['"]/gu;
  while ((match = namespace.exec(source)) !== null) {
    out.push({ localName: match[1], specifier: match[2], imported: "*" });
  }
  const requireDestructured = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu;
  while ((match = requireDestructured.exec(source)) !== null) {
    for (const part of match[1].split(",")) {
      const cleaned = part.trim();
      if (cleaned === "") continue;
      const [imported, local] = cleaned.split(/\s*:\s*/u).map((piece) => piece.trim());
      out.push({ localName: local ?? imported, specifier: match[2], imported });
    }
  }
  const requireNamespace = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu;
  while ((match = requireNamespace.exec(source)) !== null) {
    out.push({ localName: match[1], specifier: match[2], imported: "*" });
  }
  return out;
}
function resolveImport(repoDir, fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(repoDir, dirname5(fromFile), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.jsx$/u, ".tsx"),
    base.replace(/\.mjs$/u, ".mts"),
    ...SOURCE_EXTENSIONS.map((extension) => join8(base, `index${extension}`))
  ];
  for (const candidate of candidates) {
    if (existsSync6(candidate) && statSync(candidate).isFile()) return relative2(repoDir, candidate);
  }
  return null;
}
function deriveNeighborhood(input) {
  const neighbors = [];
  const refusals = [];
  const seen = /* @__PURE__ */ new Set();
  const addNeighbor = (neighbor) => {
    const key = `${neighbor.role}:${neighbor.file}:${neighbor.startLine}-${neighbor.endLine}:${neighbor.ofFunction}`;
    if (seen.has(key)) return;
    seen.add(key);
    neighbors.push(neighbor);
  };
  const refusalsSeen = /* @__PURE__ */ new Set();
  const refuse = (reason, detail) => {
    const key = `${reason}:${detail}`;
    if (refusalsSeen.has(key)) return;
    refusalsSeen.add(key);
    refusals.push({ reason, detail });
  };
  const sources = sliceSourceFiles(input.repoDir);
  const fileSources = /* @__PURE__ */ new Map();
  const sourceOf = (file) => {
    const cached = fileSources.get(file);
    if (cached !== void 0) return cached;
    const absolute = join8(input.repoDir, file);
    const text = existsSync6(absolute) ? readFileSync7(absolute, "utf8") : "";
    fileSources.set(file, text);
    return text;
  };
  const linesOf = (file) => sourceOf(file).split("\n");
  for (const changed of input.changed) {
    const lines = linesOf(changed.file);
    const { name: changedName, owner: changedOwner } = declarationAt(
      sourceOf(changed.file),
      changed.file,
      changed.startLine
    );
    if (changedName === null) {
      refuse("unnamed-function", `${changed.file}:${changed.startLine}`);
      continue;
    }
    const body = lines.slice(changed.startLine - 1, changed.endLine).join("\n");
    const bindings = importBindings(lines.join("\n"));
    for (const site of callSites(body)) {
      const at = `${changed.file}:${changed.startLine + site.line - 1} ${site.name}`;
      if (site.name === changedName) continue;
      if (site.constructorCall) {
        refuse("constructor-call", at);
        continue;
      }
      if (site.thisReceiver) {
        const sibling = changedOwner === null ? null : methodRange(sourceOf(changed.file), changed.file, changedOwner, site.name);
        if (sibling === null) {
          refuse("not-resolved", at);
          continue;
        }
        addNeighbor({
          file: changed.file,
          ...sibling,
          role: "callee",
          ofFunction: changedName,
          ofFile: changed.file,
          name: site.name
        });
        continue;
      }
      if (site.method) {
        refuse("method-call", at);
        continue;
      }
      const local = definitionRange(sourceOf(changed.file), changed.file, site.name);
      if (local !== null) {
        addNeighbor({
          file: changed.file,
          ...local,
          role: "callee",
          ofFunction: changedName,
          ofFile: changed.file,
          name: site.name
        });
        continue;
      }
      const binding = bindings.find((candidate) => candidate.localName === site.name);
      if (binding === void 0) {
        refuse("not-resolved", at);
        continue;
      }
      const target = resolveImport(input.repoDir, changed.file, binding.specifier);
      if (target === null) {
        refuse("external-module", at);
        continue;
      }
      if (binding.imported === "default" || binding.imported === "*") {
        refuse("not-resolved", at);
        continue;
      }
      const remote = definitionRange(sourceOf(target), target, binding.imported);
      if (remote === null) {
        refuse("not-resolved", at);
        continue;
      }
      addNeighbor({
        file: target,
        ...remote,
        role: "callee",
        ofFunction: changedName,
        ofFile: changed.file,
        name: binding.imported
      });
    }
    for (const file of sources) {
      const callerLines = linesOf(file);
      let localName = null;
      if (file === changed.file) {
        localName = changedName;
      } else if (changedOwner === null) {
        const edge = importBindings(callerLines.join("\n")).find(
          (binding) => binding.imported === changedName && resolveImport(input.repoDir, file, binding.specifier) === changed.file
        );
        if (edge !== void 0) localName = edge.localName;
      }
      if (localName === null) continue;
      for (const site of callSites(callerLines.join("\n"))) {
        if (site.name !== localName || site.constructorCall) continue;
        if (changedOwner === null ? site.method : !site.thisReceiver) continue;
        if (file === changed.file && site.line >= changed.startLine && site.line <= changed.endLine) {
          continue;
        }
        const enclosing = enclosingFunction(sourceOf(file), file, site.line);
        if (enclosing === null) {
          refuse("top-level-call-site", `${file}:${site.line} ${localName}`);
          continue;
        }
        if (changedOwner !== null && enclosing.owner !== changedOwner) continue;
        addNeighbor({
          file,
          ...enclosing,
          role: "caller",
          ofFunction: changedName,
          ofFile: changed.file,
          name: enclosing.name
        });
      }
    }
  }
  return { neighbors, refusals };
}
function validateSlicePolicy(policy) {
  if (!Number.isInteger(policy.cap) || policy.cap < 1) {
    throw new Error("slice cap must be an integer >= 1 (Kenneth sets it; there is no default)");
  }
}
var RULED_SLICE_CAP = 7;
var RULED_SLICE_POLICY = { cap: RULED_SLICE_CAP };
var SLICE_DROP_REASONS = [
  "already-in-diff",
  "duplicate",
  "not-measurable",
  "widely-executed",
  "not-measured",
  "capped",
  "job-time-budget"
];
var RULED_SLICE_COVERING_FILES = 3;
function roleRank(role) {
  return role === "caller" ? 0 : 1;
}
function readerRank(fn, changedFiles) {
  if (fn.file === fn.ofFile) return 0;
  if (changedFiles.has(fn.file)) return 1;
  return 2;
}
function changedFunctionKey(file, name) {
  return `${file}:${name}`;
}
function planNeighborhoodSlice(input) {
  validateSlicePolicy(input.policy);
  const changedFiles = new Set(input.changed.map((changed) => changed.file));
  const ordered = [...input.neighborhood.neighbors].sort(
    (a, b) => readerRank(a, changedFiles) - readerRank(b, changedFiles) || /* A CALLER BEFORE A CALLEE, because a caller nothing notices is the change unobserved on its
       way out, which is a statement about the change rather than about the neighbour. Stated as
       an explicit rank and not as a string compare: "callee" sorts before "caller". */
    roleRank(a.role) - roleRank(b.role) || a.file.localeCompare(b.file) || a.startLine - b.startLine
  );
  const planted = [];
  const drops = [];
  const taken = /* @__PURE__ */ new Set();
  let executionsPlanned = 0;
  for (const neighbor of ordered) {
    const overlapsDiff = input.changed.some(
      (changed) => changed.file === neighbor.file && neighbor.startLine <= changed.endLine && neighbor.endLine >= changed.startLine
    );
    if (overlapsDiff) {
      drops.push({ fn: neighbor, reason: "already-in-diff" });
      continue;
    }
    const key = `${neighbor.file}:${neighbor.startLine}-${neighbor.endLine}`;
    if (taken.has(key)) {
      drops.push({ fn: neighbor, reason: "duplicate" });
      continue;
    }
    taken.add(key);
    const entry = planGutting(input.repoDir, {
      file: neighbor.file,
      startLine: neighbor.startLine,
      endLine: neighbor.endLine,
      bodyStart: neighbor.bodyStart,
      bodyEnd: neighbor.bodyEnd,
      shape: neighbor.shape
    });
    if (entry.gap === void 0) {
      drops.push({ fn: neighbor, reason: "not-measurable" });
      continue;
    }
    if (input.map === null) {
      drops.push({ fn: neighbor, reason: "not-measured" });
      continue;
    }
    const covering = input.map.coveringFiles(neighbor.file, neighbor.startLine, neighbor.endLine) ?? [];
    if (covering.length > input.coveringFileCap) {
      drops.push({ fn: neighbor, reason: "widely-executed" });
      continue;
    }
    if (executionsPlanned + covering.length > input.policy.cap) {
      drops.push({ fn: neighbor, reason: "capped" });
      continue;
    }
    executionsPlanned += covering.length;
    planted.push({
      fn: neighbor,
      label: entry.label,
      gap: entry.gap,
      coveringFiles: covering,
      foldsIntoUnguarded: covering.length === 0 && input.unguardedChanged.has(changedFunctionKey(neighbor.ofFile, neighbor.ofFunction))
    });
  }
  return {
    planted,
    drops,
    refusals: input.neighborhood.refusals,
    cap: input.policy.cap,
    candidates: input.neighborhood.neighbors.length,
    mapRead: input.map !== null
  };
}
var SLICE_OUTCOMES = ["unexecuted", "unnoticed", "covered", "not-executed"];
async function runNeighborhoodSlice(input) {
  const results = [...input.alreadyAnswered ?? []];
  const answeredEntries = new Set(results.map((result) => result.entry));
  const paid = input.plan.planted.filter((entry) => entry.coveringFiles.length > 0).length;
  if (paid > 0) input.onStart?.(paid);
  let stoppedEarly = null;
  let executionMs = 0;
  let executed = 0;
  for (const entry of input.plan.planted) {
    if (answeredEntries.has(entry)) continue;
    if (executed > 0 && entry.coveringFiles.length > 0 && input.admitNextNeighbor !== void 0) {
      const admitted = input.admitNextNeighbor({
        done: results.length,
        total: input.plan.planted.length,
        unitMs: executionMs / executed
      });
      if (!admitted) {
        stoppedEarly = { answered: results.length, total: input.plan.planted.length };
        break;
      }
    }
    if (entry.coveringFiles.length === 0) {
      results.push({ entry, outcome: "unexecuted", executions: 0 });
      continue;
    }
    const digests = input.digestsFor?.(entry) ?? null;
    const carried = input.carry === void 0 || digests === null ? null : input.carry.lookup({
      file: entry.fn.file,
      bodyDigest: digests.bodyDigest,
      coveringTestFileDigests: digests.coveringTestFileDigests
    });
    if (carried !== null) {
      results.push({ entry, outcome: carried.outcome, executions: 0, carriedFromRunId: carried.runId });
      continue;
    }
    let outcome = "unnoticed";
    let executions = 0;
    for (const testFile of entry.coveringFiles) {
      const startedAtMs = Date.now();
      const run = await input.runner.execute({
        files: [],
        patches: [entry.gap],
        mode: "targeted",
        testFile,
        timeoutMs: input.timeoutMs
      });
      const difference = await readMutantRun({
        run,
        baseline: () => input.baselineFor(testFile)
      });
      executionMs += Date.now() - startedAtMs;
      executed += 1 + difference.baselineExecutions;
      executions += 1;
      if (difference.reading === "not-executed") {
        outcome = "not-executed";
        break;
      }
      if (difference.reading === "noticed") {
        outcome = "covered";
        break;
      }
    }
    results.push({ entry, outcome, executions });
    if (input.carry !== void 0 && digests !== null) {
      input.carry.record({
        file: entry.fn.file,
        name: entry.fn.name,
        bodyDigest: digests.bodyDigest,
        coveringTestFileDigests: digests.coveringTestFileDigests,
        outcome
      });
    }
  }
  return { results, disclosure: buildSliceDisclosure(input.plan, results), stoppedEarly };
}
function buildSliceDisclosure(plan, results, stoppedByJobClock = false) {
  const dropReasons = {};
  for (const drop of plan.drops) {
    dropReasons[drop.reason] = (dropReasons[drop.reason] ?? 0) + 1;
  }
  const unresolved = {};
  for (const refusal of plan.refusals) {
    unresolved[refusal.reason] = (unresolved[refusal.reason] ?? 0) + 1;
  }
  const answered2 = new Set(results.map((result) => result.entry));
  let stoppedShort = 0;
  for (const entry of plan.planted) {
    if (answered2.has(entry)) continue;
    stoppedShort += 1;
  }
  if (stoppedShort > 0) dropReasons["job-time-budget"] = (dropReasons["job-time-budget"] ?? 0) + stoppedShort;
  const folded = results.filter((result) => result.outcome === "unexecuted" && result.entry.foldsIntoUnguarded).length;
  return {
    countsTowardScore: false,
    cap: plan.cap,
    candidates: plan.candidates,
    planned: results.length,
    executed: results.reduce((total, result) => total + result.executions, 0),
    unexecuted: results.filter((result) => result.outcome === "unexecuted").length,
    unnoticed: results.filter((result) => result.outcome === "unnoticed").length,
    covered: results.filter((result) => result.outcome === "covered").length,
    notExecuted: results.filter((result) => result.outcome === "not-executed").length,
    capped: dropReasons.capped ?? 0,
    folded,
    mapRead: plan.mapRead,
    stoppedByJobClock: stoppedByJobClock || stoppedShort > 0,
    carried: results.filter((result) => result.carriedFromRunId !== void 0).length,
    dropReasons,
    unresolved,
    /* Exactly the findings, in plan order, minus the ones folded into the unguarded row. The counts
       above and this list are the same fact twice, and the server recomputes that they agree. */
    gaps: results.filter(
      (result) => (result.outcome === "unexecuted" || result.outcome === "unnoticed") && !result.entry.foldsIntoUnguarded
    ).map((result) => ({
      file: result.entry.fn.file,
      name: result.entry.fn.name,
      startLine: result.entry.fn.startLine,
      role: result.entry.fn.role,
      ofChangedFunction: result.entry.fn.ofFunction,
      verdict: result.outcome,
      /* WHICH RUN MEASURED IT, when this one did not. Absent is this run's own measurement, which
         is what every finding was before the ledger existed. */
      ...result.carriedFromRunId === void 0 ? {} : { carriedFromRunId: result.carriedFromRunId }
    }))
  };
}

// src/streaming.ts
var CHECK_STREAM_STAGES = ["reuse", "gutting", "mutation", "loop", "proof"];
var CHECK_STREAM_STAGE_LABELS = {
  reuse: "Reusing previous results",
  gutting: "Checking changed functions",
  mutation: "Planting bugs",
  loop: "Writing tests",
  proof: "Proving tests"
};
var CHECK_STREAM_STAGE_STATES = ["pending", "running", "done", "skipped"];
var CHECK_STREAM_COUNTERS = [
  "bugsPlanted",
  "gapsFound",
  "gapsSetAside",
  "testsWritten",
  "testsProven",
  "testRuns"
];
var CHECK_CONCLUSIONS = ["success", "failure", "neutral", "action_required"];
var CHECK_EVIDENCE_STATES = ["complete", "incomplete", "cannot-attest"];
var CHECK_GATE_STATES = ["pass", "fail", "cannot-attest"];
function conclusionFor(verdict) {
  if (verdict.evidence === "complete" && verdict.gate === "pass") return "success";
  if (verdict.enforcement === "advisory") return "neutral";
  if (verdict.evidence !== "complete" || verdict.gate === "cannot-attest") return "action_required";
  return "failure";
}
var COUNTER_ROWS = [
  { key: "bugsPlanted", label: "Bugs planted", from: ["gutting", "mutation"] },
  { key: "gapsFound", label: "Bugs no test noticed", from: ["gutting", "mutation"] },
  { key: "gapsSetAside", label: "Set aside as equivalent", from: ["loop"] },
  { key: "testsWritten", label: "Tests written", from: ["loop"] },
  { key: "testsProven", label: "Tests proven in your suite", from: ["proof"] },
  { key: "testRuns", label: "Test runs", from: "any" }
];
var SCORE_ROW_LABEL = "Catch rate";
var MAX_PROPOSALS_RENDERED = 20;
var CHECK_BODY_LIMIT = 65535;
var CHECK_BODY_MARGIN = 12288;
function htmlSafe(value) {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").slice(0, 240);
}
function fenceFor(body) {
  const longest = (body.match(/`+/gu) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}
function languageOf(testFile) {
  const match = /\.([a-z]+)$/iu.exec(testFile);
  const extension = match === null ? "" : match[1].toLowerCase();
  if (extension === "ts" || extension === "mts" || extension === "cts") return "ts";
  if (extension === "tsx") return "tsx";
  if (extension === "js" || extension === "mjs" || extension === "cjs") return "js";
  if (extension === "jsx") return "jsx";
  if (extension === "py") return "python";
  return "";
}
function codeSpanSafe(value) {
  return value.replace(/[\u0000-\u001f\u007f`]/gu, " ").slice(0, 240);
}
function plural(count, one, many) {
  return count === 1 ? one : many;
}
function formatScore(score) {
  if (score === null) return "not available";
  return `${Number(score.toFixed(1))}%`;
}
function identityLines(identity) {
  return [
    "",
    `Repository: \`${codeSpanSafe(identity.repository)}\` \xB7 Commit: \`${codeSpanSafe(identity.headSha).slice(0, 12)}\``,
    ""
  ];
}
function startedStages(stages) {
  const out = /* @__PURE__ */ new Set();
  for (const view of stages) {
    if (view.state === "running" || view.state === "done") out.add(view.stage);
  }
  return out;
}
function counterRows(snapshot) {
  const started = startedStages(snapshot.stages);
  const anyStarted = started.size > 0;
  const rows = [];
  for (const row of COUNTER_ROWS) {
    const visible = row.from === "any" ? anyStarted : row.from.some((stage) => started.has(stage));
    if (!visible) continue;
    rows.push({ label: row.label, value: snapshot.counts[row.key] });
  }
  return rows;
}
function stageLine(stages) {
  return stages.map((view) => {
    const label = CHECK_STREAM_STAGE_LABELS[view.stage];
    if (view.state === "skipped") {
      return `${label}: skipped${view.reason === void 0 ? "" : ` (${codeSpanSafe(view.reason)})`}`;
    }
    return `${label}: ${view.state}`;
  }).join(" \xB7 ");
}
function proposalHeadline(proposal) {
  const also = proposal.alsoClosesCount > 0 ? ` \xB7 also closes ${proposal.alsoClosesCount} other ${plural(proposal.alsoClosesCount, "gap", "gaps")}` : "";
  return `<code>${htmlSafe(proposal.testFile)}</code> - ${htmlSafe(proposal.testName)}${also}`;
}
function proposalSection(proposals, options) {
  if (proposals.length === 0) return [];
  const shown = proposals.slice(0, MAX_PROPOSALS_RENDERED);
  const omitted = proposals.length - shown.length;
  const lines = ["", "### Proposed tests", ""];
  let remaining = options.budget;
  for (const proposal of shown) {
    const headline = proposalHeadline(proposal);
    const tag = options.open ? "<details open>" : "<details>";
    const body = proposal.testBody ?? "";
    const fence = fenceFor(body);
    const withCode = [
      tag,
      `<summary>${headline}</summary>`,
      "",
      `${fence}${languageOf(proposal.testFile)}`,
      body,
      fence,
      "",
      "</details>",
      ""
    ];
    const cost = withCode.join("\n").length + 1;
    if (body !== "" && cost <= remaining) {
      remaining -= cost;
      lines.push(...withCode);
      continue;
    }
    const fallback = [
      tag,
      `<summary>${headline}</summary>`,
      "",
      `Too large to show here. [Open it in the Abloh Command Center](${options.dashboardUrl})`,
      "",
      "</details>",
      ""
    ];
    remaining -= fallback.join("\n").length + 1;
    lines.push(...fallback);
  }
  if (omitted > 0) lines.push(`${omitted} more in the Abloh Command Center`, "");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function assemble(head, tail, proposals, options) {
  const base = [...head, ...tail].join("\n").length;
  const budget = Math.max(0, CHECK_BODY_LIMIT - CHECK_BODY_MARGIN - base);
  return [...head, ...proposalSection(proposals, { ...options, budget }), ...tail].join("\n");
}
function renderMeasuring(snapshot) {
  const rows = counterRows(snapshot);
  const head = [
    "## Still measuring",
    ...identityLines(snapshot.identity),
    ...rows.length === 0 ? [] : [
      "| Measurement | Count so far |",
      "|---|---:|",
      ...rows.map((row) => `| ${row.label} | **${row.value}** |`)
    ],
    "",
    stageLine(snapshot.stages)
  ];
  const tail = [
    "",
    "_Counts only grow. No score is shown until every measurement is final._",
    "",
    `[Follow this run in the Abloh Command Center](${snapshot.identity.dashboardUrl})`
  ];
  return assemble(head, tail, snapshot.proposals, { open: true, dashboardUrl: snapshot.identity.dashboardUrl });
}
function renderVerdict(snapshot) {
  const rows = counterRows(snapshot);
  const head = [
    `## Evidence: ${snapshot.verdict.evidence.toUpperCase()} \xB7 Gate: ${snapshot.verdict.gate.toUpperCase()}`,
    ...identityLines(snapshot.identity),
    "| Measurement | Result |",
    "|---|---:|",
    ...rows.map((row) => `| ${row.label} | **${row.value}** |`),
    `| ${SCORE_ROW_LABEL} | **${formatScore(snapshot.verdict.score)}** |`
  ];
  const tail = ["", `[Open this run in the Abloh Command Center](${snapshot.identity.dashboardUrl})`];
  return assemble(head, tail, snapshot.proposals, { open: false, dashboardUrl: snapshot.identity.dashboardUrl });
}
var CHECK_STREAM_MIN_INTERVAL_MS = 1e4;
var CheckStream = class {
  #identity;
  #publisher;
  #stages;
  /** how many finishes a stage needs before it is done; one per package this run measures */
  #parts;
  /** finishes seen per stage, so a stage is done only when the last package finishes it */
  #finishes = /* @__PURE__ */ new Map();
  #minIntervalMs;
  #now;
  #counts = {
    bugsPlanted: 0,
    gapsFound: 0,
    gapsSetAside: 0,
    testsWritten: 0,
    testsProven: 0,
    testRuns: 0
  };
  #proposals = [];
  #dirty = false;
  #lastPublishedAt = null;
  #published = 0;
  /* The published verdict, kept verbatim so the nearby-code addendum can only APPEND to it. Holding
     the rendered text rather than re-rendering is what makes rule 6 checkable: an addendum whose
     leading bytes differ from the verdict update's would be a revision wearing an addition's
     clothes. */
  #verdictSummary = null;
  #verdictTitle = null;
  #verdictConclusion = null;
  constructor(options) {
    if (options.plan.length === 0) throw new Error("a check stream needs at least one stage in its plan");
    const ordered = CHECK_STREAM_STAGES.filter((stage) => options.plan.includes(stage));
    if (ordered.length !== new Set(options.plan).size) {
      throw new Error("the check stream plan carries an unknown stage");
    }
    this.#identity = options.identity;
    this.#publisher = options.publisher;
    this.#stages = ordered.map((stage) => ({ stage, state: "pending" }));
    const parts = options.parts ?? 1;
    if (!Number.isInteger(parts) || parts < 1) throw new Error("a check stream measures at least one part");
    this.#parts = parts;
    this.#minIntervalMs = options.minIntervalMs ?? CHECK_STREAM_MIN_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }
  /** Updates actually handed to the publisher. Batching means this is far below the event count. */
  get updatesPublished() {
    return this.#published;
  }
  get counts() {
    return { ...this.#counts };
  }
  /**
   * What this run has established so far, for a surface that stores it rather than showing it.
   *
   * Read off the same fields the summary renders from, so the run page and the pull request can
   * never report different numbers for one run. It carries no test source — see
   * {@link CheckStreamProgress} — and it is a plain copy, so a caller holding it cannot reach back
   * into the stream's state through it.
   *
   * Available AFTER the verdict too, unlike `flush`. The verdict closes the check run; it does not
   * close the record, and the last thing a stored stream needs is the final tally.
   */
  progress() {
    return {
      counts: { ...this.#counts },
      stages: this.#stages.map((view) => ({ ...view })),
      proposals: this.#proposals.map((proposal) => ({
        testFile: proposal.testFile,
        testName: proposal.testName,
        alsoClosesCount: proposal.alsoClosesCount
      }))
    };
  }
  record(event) {
    if (this.#verdictSummary !== null) {
      throw new Error("the verdict is published; its measurements are final");
    }
    switch (event.kind) {
      case "counts": {
        for (const counter of CHECK_STREAM_COUNTERS) {
          const delta = event.add[counter];
          if (delta === void 0) continue;
          if (!Number.isInteger(delta) || delta < 0) {
            throw new Error(`${counter} moves by non-negative integers only; counts never decrease`);
          }
          this.#counts[counter] += delta;
        }
        break;
      }
      case "proposal": {
        this.#proposals.push(event.proposal);
        break;
      }
      default: {
        const view = this.#stages.find((candidate) => candidate.stage === event.stage);
        if (view === void 0) throw new Error(`stage ${event.stage} is not in this run's plan`);
        if (event.kind === "stage-started") {
          if (view.state !== "done" && view.state !== "skipped") view.state = "running";
        } else if (event.kind === "stage-finished") {
          const finished = (this.#finishes.get(event.stage) ?? 0) + 1;
          this.#finishes.set(event.stage, finished);
          if (finished >= this.#parts) view.state = "done";
        } else {
          view.state = "skipped";
          view.reason = event.reason;
        }
      }
    }
    this.#dirty = true;
  }
  #snapshot() {
    return {
      identity: this.#identity,
      counts: { ...this.#counts },
      stages: this.#stages.map((view) => ({ ...view })),
      proposals: [...this.#proposals]
    };
  }
  /** The stage the reader is told about in the title: the running one, else the last to finish. */
  #currentStageLabel() {
    const running = this.#stages.find((view) => view.state === "running");
    if (running !== void 0) return CHECK_STREAM_STAGE_LABELS[running.stage];
    const settled = [...this.#stages].reverse().find((view) => view.state !== "pending");
    return settled === void 0 ? "starting" : CHECK_STREAM_STAGE_LABELS[settled.stage];
  }
  /**
   * Publish the accumulated state, if anything changed and the rate-limit window allows it.
   *
   * A throttled flush is not a lost update: the state stays dirty and merges into the next one.
   */
  async flush() {
    if (this.#verdictSummary !== null) return false;
    if (!this.#dirty) return false;
    const now = this.#now();
    if (this.#lastPublishedAt !== null && now - this.#lastPublishedAt < this.#minIntervalMs) return false;
    await this.#publisher.publish({
      status: "in_progress",
      title: `Still measuring \xB7 ${this.#currentStageLabel()}`,
      summary: renderMeasuring(this.#snapshot())
    });
    this.#dirty = false;
    this.#lastPublishedAt = now;
    this.#published += 1;
    return true;
  }
  /** The terminal update. It bypasses the rate-limit window: the answer always lands. */
  async verdict(verdict) {
    if (this.#verdictSummary !== null) throw new Error("the verdict is published once");
    const summary = renderVerdict({ ...this.#snapshot(), verdict });
    const title = `Evidence ${verdict.evidence.toUpperCase()} \xB7 Gate ${verdict.gate.toUpperCase()}`;
    const conclusion = conclusionFor(verdict);
    this.#verdictSummary = summary;
    this.#verdictTitle = title;
    this.#verdictConclusion = conclusion;
    await this.#publisher.publish({ status: "completed", title, summary, conclusion });
    this.#dirty = false;
    this.#lastPublishedAt = this.#now();
    this.#published += 1;
  }
};

// src/reuse/carry.ts
var CARRY_STORE_SCHEMA = "abloh-marigold-carry/v1";
var CARRIABLE_TRIAGE_VERDICTS = ["real-gap", "unclear"];
function carriableVerdict(verdict) {
  return CARRIABLE_TRIAGE_VERDICTS.find((allowed) => allowed === verdict) ?? null;
}
function movesAgainstTheScore(verdict) {
  return carriableVerdict(verdict) !== null;
}
function carryKey(input) {
  return structuralDigest2({
    gapId: input.gapId,
    fileDigest: input.fileDigest,
    reachDigest: input.reachDigest,
    recipeDigest: input.recipeDigest,
    policyDigest: input.policyDigest,
    promptVersion: input.promptVersion,
    modelPin: input.modelPin,
    engineVersion: input.engineVersion,
    triageMode: input.triageMode,
    importSpecifier: input.importSpecifier ?? "",
    coverage: input.coverageAttributed ? "attributed" : "unattributed"
  });
}
function modelPinString(pin) {
  return `${pin.model}@${pin.effort}/${pin.maxCompletionTokens}`;
}
var FORCED_FULL_REASONS = [
  "base-changed",
  "policy-changed",
  "triage-prompt-changed",
  "generation-prompt-changed",
  "engine-changed",
  "model-pin-changed",
  "recipe-changed",
  "wholesale-invalidated",
  "rebaseline-due",
  "identity-indeterminate",
  "repository-mismatch",
  "operator-forced"
];
function forcedFullReasons(input) {
  const reasons = [];
  const { current } = input;
  const determinate = isNonEmpty(current.baseSha) && isNonEmpty(current.policyDigest) && isNonEmpty(current.engineVersion) && isNonEmpty(current.triagePromptVersion) && isNonEmpty(current.generationPromptVersion) && isNonEmpty(current.recipeDigest) && Object.keys(current.modelPins).length > 0 && Object.values(current.modelPins).every(isNonEmpty);
  if (!determinate) reasons.push("identity-indeterminate");
  const stored = input.stored;
  if (stored === null) return reasons;
  if (stored.baseSha !== current.baseSha) reasons.push("base-changed");
  if (stored.policyDigest !== current.policyDigest) reasons.push("policy-changed");
  if (stored.triagePromptVersion !== current.triagePromptVersion) reasons.push("triage-prompt-changed");
  if (stored.generationPromptVersion !== current.generationPromptVersion) reasons.push("generation-prompt-changed");
  if (stored.engineVersion !== current.engineVersion) reasons.push("engine-changed");
  if (stored.recipeDigest !== current.recipeDigest) reasons.push("recipe-changed");
  if (modelPinsDigest(stored.modelPins) !== modelPinsDigest(current.modelPins)) reasons.push("model-pin-changed");
  return reasons;
}
function isNonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}
function modelPinsDigest(pins) {
  return structuralDigest2(pins);
}
function carryIdentityDigest(identity) {
  return structuralDigest2(identity);
}
var CARRY_BOUNDS = {
  maxFileBytes: 16 * 1024 * 1024,
  maxTriageRecords: 2e4,
  maxCandidateRecords: 2e3,
  maxCandidateSourceBytes: 256 * 1024,
  maxSupportFiles: 16
};
function readValidTriage(value) {
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  if (!isNonEmpty(record.key) || !isNonEmpty(record.gapId)) return null;
  const verdict = typeof record.verdict === "string" ? carriableVerdict(record.verdict) : null;
  if (verdict === null) return null;
  if (!isNonEmpty(record.reasonCode)) return null;
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) return null;
  if (record.confidence < 0 || record.confidence > 1) return null;
  if (!isNonEmpty(record.modelId) || !isNonEmpty(record.promptVersion)) return null;
  if (typeof record.producedAtRun !== "number" || !Number.isInteger(record.producedAtRun)) return null;
  return {
    key: record.key,
    gapId: record.gapId,
    verdict,
    reasonCode: record.reasonCode,
    confidence: record.confidence,
    ...typeof record.rationale === "string" ? { rationale: record.rationale } : {},
    ...typeof record.description === "string" ? { description: record.description } : {},
    ...typeof record.about === "string" ? { about: record.about } : {},
    ...typeof record.severity === "string" ? { severity: record.severity } : {},
    ...typeof record.severityBasis === "string" ? { severityBasis: record.severityBasis } : {},
    modelId: record.modelId,
    promptVersion: record.promptVersion,
    ...typeof record.effort === "string" ? { effort: record.effort } : {},
    producedAtSha: typeof record.producedAtSha === "string" ? record.producedAtSha : "",
    producedAtRun: record.producedAtRun
  };
}
function readValidCandidate(value) {
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  if (!isNonEmpty(record.key) || !isNonEmpty(record.gapId) || !isNonEmpty(record.candidateId)) return null;
  if (!isNonEmpty(record.testFile) || typeof record.testBody !== "string") return null;
  if (record.testBody.length > CARRY_BOUNDS.maxCandidateSourceBytes) return null;
  if (typeof record.producedAtRun !== "number" || !Number.isInteger(record.producedAtRun)) return null;
  if (record.rejectedAtRun !== null && !Number.isInteger(record.rejectedAtRun)) return null;
  if (!Array.isArray(record.supportFiles) || record.supportFiles.length > CARRY_BOUNDS.maxSupportFiles) return null;
  const supportFiles = [];
  for (const entry of record.supportFiles) {
    if (typeof entry !== "object" || entry === null) return null;
    const file = entry;
    if (!isNonEmpty(file.path) || typeof file.source !== "string") return null;
    if (file.source.length > CARRY_BOUNDS.maxCandidateSourceBytes) return null;
    supportFiles.push({ path: file.path, source: file.source });
  }
  return {
    key: record.key,
    gapId: record.gapId,
    candidateId: record.candidateId,
    testFile: record.testFile,
    testBody: record.testBody,
    supportFiles,
    producedAtSha: typeof record.producedAtSha === "string" ? record.producedAtSha : "",
    producedAtRun: record.producedAtRun,
    rejectedAtRun: record.rejectedAtRun
  };
}
function readValidIdentity(value) {
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  const fields = ["baseSha", "policyDigest", "engineVersion", "triagePromptVersion", "generationPromptVersion", "recipeDigest"];
  for (const field of fields) if (typeof record[field] !== "string") return null;
  if (typeof record.modelPins !== "object" || record.modelPins === null) return null;
  const pins = {};
  for (const [task, pin] of Object.entries(record.modelPins)) {
    if (typeof pin !== "string") return null;
    pins[task] = pin;
  }
  return {
    baseSha: record.baseSha,
    policyDigest: record.policyDigest,
    engineVersion: record.engineVersion,
    triagePromptVersion: record.triagePromptVersion,
    generationPromptVersion: record.generationPromptVersion,
    modelPins: pins,
    recipeDigest: record.recipeDigest
  };
}
function repositoryDigest(repoKey) {
  return sha256(repoKey);
}

// src/reuse/store.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync3, readFileSync as readFileSync8, renameSync, unlinkSync, writeFileSync as writeFileSync3 } from "fs";
import { randomBytes } from "crypto";
import { dirname as dirname6, isAbsolute, join as join9, relative as relative3, resolve as resolve2, sep } from "path";

// src/reuse/rebaseline.ts
var MS_PER_DAY = 864e5;
var RULED_REBASELINE_POLICY = {
  floorRuns: 25,
  floorDays: 7,
  stretchFactor: 1.5,
  capDays: 30,
  disagreementTolerance: 0.01
};
function validateRebaselinePolicy(policy) {
  if (!Number.isInteger(policy.floorRuns) || policy.floorRuns < 1) {
    throw new Error("rebaseline floorRuns must be an integer >= 1 (Kenneth sets it; there is no default)");
  }
  if (!(Number.isFinite(policy.floorDays) && policy.floorDays > 0)) {
    throw new Error("rebaseline floorDays must be a positive number (Kenneth sets it; there is no default)");
  }
  if (!(Number.isFinite(policy.stretchFactor) && policy.stretchFactor >= 1)) {
    throw new Error("rebaseline stretchFactor must be >= 1 (Kenneth sets it; there is no default)");
  }
  if (!(Number.isFinite(policy.capDays) && policy.capDays >= policy.floorDays)) {
    throw new Error("rebaseline capDays must be >= floorDays (Kenneth sets it; there is no default)");
  }
  if (!(policy.disagreementTolerance > 0 && policy.disagreementTolerance < 1)) {
    throw new Error("rebaseline disagreementTolerance must be in (0, 1) (Kenneth sets it; there is no default)");
  }
}
function floorState(policy) {
  validateRebaselinePolicy(policy);
  return { intervalRuns: policy.floorRuns, intervalDays: policy.floorDays, lastRunAt: 0, lastAtMs: 0 };
}
function rebaselineDue(store, policy, nowMs) {
  validateRebaselinePolicy(policy);
  const state = store.rebaseline;
  if (store.runCounter - state.lastRunAt >= state.intervalRuns) return true;
  const anchorMs = state.lastAtMs !== 0 ? state.lastAtMs : store.firstRunAtMs;
  if (anchorMs === 0) return false;
  return nowMs - anchorMs >= state.intervalDays * MS_PER_DAY;
}
function rebaselineStatus(store, policy, nowMs) {
  const state = store.rebaseline;
  const anchorMs = state.lastAtMs !== 0 ? state.lastAtMs : store.firstRunAtMs;
  return {
    intervalRuns: state.intervalRuns,
    intervalDays: state.intervalDays,
    runsSince: store.runCounter - state.lastRunAt,
    daysSince: anchorMs === 0 ? null : (nowMs - anchorMs) / MS_PER_DAY,
    due: rebaselineDue(store, policy, nowMs)
  };
}
function noticed(status) {
  return status === "killed" || status === "timeout";
}
function compareRebaseline(stored, fresh, policy) {
  validateRebaselinePolicy(policy);
  const disagreed = [];
  let compared = 0;
  for (const verdict of stored) {
    const freshStatus = fresh.get(verdict.gapId);
    if (freshStatus === void 0) continue;
    compared += 1;
    if (freshStatus !== verdict.status) {
      disagreed.push({
        gapId: verdict.gapId,
        stored: verdict.status,
        fresh: freshStatus,
        hiddenGap: noticed(verdict.status) && !noticed(freshStatus)
      });
    }
  }
  const rate = compared === 0 ? 0 : disagreed.length / compared;
  return {
    compared,
    agreed: compared - disagreed.length,
    disagreed,
    disagreementRate: rate,
    hiddenGaps: disagreed.filter((entry) => entry.hiddenGap).length,
    staleSurvivors: disagreed.filter((entry) => !noticed(entry.stored) && noticed(entry.fresh)).length,
    tolerance: policy.disagreementTolerance,
    withinTolerance: rate < policy.disagreementTolerance
  };
}
var REPLAY_REPETITION_RANGE = { min: 1, max: 10 };
async function confirmDisagreements(input) {
  validateRebaselinePolicy(input.policy);
  const { max, min } = REPLAY_REPETITION_RANGE;
  if (!Number.isInteger(input.replayRepetitions) || input.replayRepetitions < min || input.replayRepetitions > max) {
    throw new Error(`replay repetitions must be an integer from ${min} to ${max}`);
  }
  const flips = [];
  for (const flip of input.comparison.disagreed) {
    const replays = [];
    let verdict = "reproduced";
    for (let repetition = 1; repetition <= input.replayRepetitions; repetition++) {
      const status = await input.replay(flip, repetition);
      replays.push(status);
      if (status === null) {
        verdict = "inconclusive";
        break;
      }
      if (status !== flip.fresh) {
        verdict = "flaky";
        break;
      }
    }
    flips.push({ ...flip, verdict, replayed: replays.length, replays });
  }
  const reproduced = flips.filter((flip) => flip.verdict === "reproduced");
  const flaky = flips.filter((flip) => flip.verdict === "flaky").length;
  const inconclusive = flips.filter((flip) => flip.verdict === "inconclusive").length;
  const effectiveCompared = input.comparison.compared - flaky - inconclusive;
  const rate = effectiveCompared <= 0 ? 0 : reproduced.length / effectiveCompared;
  return {
    compared: input.comparison.compared,
    effectiveCompared,
    agreed: input.comparison.agreed,
    flips,
    reproduced: reproduced.length,
    flaky,
    inconclusive,
    disagreementRate: rate,
    hiddenGaps: reproduced.filter((flip) => flip.hiddenGap).length,
    staleSurvivors: reproduced.filter((flip) => !flip.hiddenGap).length,
    tolerance: input.policy.disagreementTolerance,
    withinTolerance: rate < input.policy.disagreementTolerance
  };
}
function applyRebaselineOutcome(input) {
  const { comparison, policy, store } = input;
  validateRebaselinePolicy(policy);
  const previous = store.data.rebaseline;
  const breached = !comparison.withinTolerance;
  const clean = comparison.reproduced === 0;
  let state;
  if (breached) {
    store.rebuildFromScratch();
    state = { ...floorState(policy), lastRunAt: store.data.runCounter, lastAtMs: input.nowMs };
  } else if (clean) {
    state = {
      intervalRuns: previous.intervalRuns * policy.stretchFactor,
      intervalDays: Math.min(previous.intervalDays * policy.stretchFactor, policy.capDays),
      lastRunAt: store.data.runCounter,
      lastAtMs: input.nowMs
    };
  } else {
    state = { ...previous, lastRunAt: store.data.runCounter, lastAtMs: input.nowMs };
  }
  store.setRebaselineState(state);
  return {
    storeRebuilt: breached,
    stretched: !breached && clean,
    snapped: breached,
    atCap: state.intervalDays >= policy.capDays,
    state
  };
}

// src/reuse/store.ts
var REUSE_STORE_SCHEMA = "abloh-marigold-reuse/v3";
function emptyStore(policy, repositoryDigest2 = "") {
  return {
    schema: REUSE_STORE_SCHEMA,
    repositoryDigest: repositoryDigest2,
    runCounter: 0,
    firstRunAtMs: 0,
    rebaseline: floorState(policy),
    lockfileDigest: "",
    configDigest: "",
    identity: null,
    verdicts: [],
    reach: [],
    triage: [],
    candidates: []
  };
}
function fileSetDigest(repoDir, files) {
  const parts = [...files].sort().map((file) => {
    const absolute = join9(repoDir, file);
    return `${file}:${existsSync7(absolute) ? sha256Bytes(readFileSync8(absolute)) : "<absent>"}`;
  });
  return sha256(parts.join("\n"));
}
function wholesalePaths(repoDir, subdir, candidates) {
  const root = resolve2(repoDir);
  const start = subdir === null || subdir === void 0 || subdir.trim() === "" ? root : resolve2(root, subdir);
  const levels = [];
  let cursor = contains(root, start) ? start : root;
  for (; ; ) {
    levels.push(cursor);
    if (cursor === root) break;
    const parent = dirname6(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const paths = /* @__PURE__ */ new Set();
  for (const level of levels) {
    for (const candidate of candidates) {
      paths.add(relative3(root, join9(level, candidate)).split(sep).join("/"));
    }
  }
  return [...paths].sort();
}
function contains(root, candidate) {
  const rel = relative3(root, candidate);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function reachDigest(tests) {
  return sha256([...tests].sort().join("\n"));
}
var LOCKFILE_CANDIDATES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
];
var CONFIG_CANDIDATES = [
  "package.json",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vite.config.ts",
  "vite.config.js",
  "jest.config.js",
  "jest.config.ts",
  "jest.config.json",
  "tsconfig.json",
  "babel.config.js",
  ".babelrc"
];
function storePartitionKey(repoKey, subdir) {
  const measured = normalizedPackageKey(subdir);
  return measured === "" ? repoKey : `${repoKey}\0${measured}`;
}
function normalizedPackageKey(subdir) {
  if (subdir === null || subdir === void 0) return "";
  const posix = subdir.split(sep).join("/").trim();
  const trimmed = posix.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (trimmed === "" || trimmed === ".") return "";
  if (isAbsolute(subdir) || trimmed === ".." || trimmed.startsWith("../")) return "";
  return trimmed;
}
var STORE_OPEN_REASONS = [
  "warm",
  "absent",
  "unreadable",
  "oversized",
  "corrupt",
  "wrong-schema",
  "repository-mismatch"
];
var MAX_DISCLOSED_DROPPED_GAPS = 50;
var emptyLoss = () => ({
  corrupt: { triage: 0, candidates: 0 },
  evicted: { triage: 0, candidates: 0 },
  overBytes: { triage: 0, candidates: 0 },
  droppedGapIds: []
});
function storeLossIsEmpty(loss) {
  return loss.corrupt.triage + loss.corrupt.candidates + loss.evicted.triage + loss.evicted.candidates + loss.overBytes.triage + loss.overBytes.candidates === 0;
}
var ReuseStore = class _ReuseStore {
  #data;
  #path;
  #openReason;
  #loss;
  constructor(path, data, openReason, loss = emptyLoss()) {
    this.#path = path;
    this.#data = data;
    this.#openReason = openReason;
    this.#loss = loss;
  }
  /**
   * Open the store for one repository. A corrupt or wrong-schema file is treated as no store at
   * all - reuse silently degrades to full execution, never to a guess.
   *
   * THE STORE FILE IS PER REPOSITORY, keyed on a digest of `repoKey`, and so is every piece of
   * state inside it: two repositories never share an interval, a run counter or a verdict.
   *
   * AND THE FILE SAYS SO ITSELF. The path key alone is not enough once a store can arrive from a
   * CI cache under a `restore-keys` PREFIX match: the file that lands at this path may have been
   * written by a different checkout. `repositoryDigest` is compared before anything in the store is
   * believed, and a mismatch reads as no store - the same check the baseline-history store makes
   * before it counts an observation.
   *
   * The policy is required here because a cold start has to begin AT THE FLOOR, and the floor is
   * Kenneth's number, not this file's.
   *
   * AND IT IS PER MEASURED PACKAGE AS WELL AS PER REPOSITORY. `subdir` is the package this run is
   * measuring, repository-relative; see {@link storePartitionKey} for the monorepo defect that
   * demands it and for why omitting it reproduces the behaviour a single-package repository has
   * always had. Every check below - the path, and the digest the file states about itself - is made
   * against that combined identity, so a store written while measuring another package reads as a
   * mismatch rather than as this package's history.
   */
  static open(storeDir, repoKey, policy, subdir) {
    const partitionKey = storePartitionKey(repoKey, subdir);
    const digest = repositoryDigest(partitionKey);
    const path = join9(storeDir, `${sha256(partitionKey).slice(0, 32)}.json`);
    const cold = (reason) => new _ReuseStore(path, emptyStore(policy, digest), reason);
    if (!existsSync7(path)) return cold("absent");
    let raw;
    try {
      raw = readFileSync8(path, "utf8");
    } catch {
      return cold("unreadable");
    }
    if (Buffer.byteLength(raw, "utf8") > CARRY_BOUNDS.maxFileBytes) return cold("oversized");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return cold("corrupt");
    }
    if (typeof parsed !== "object" || parsed === null) return cold("corrupt");
    const data = parsed;
    if (data.schema !== REUSE_STORE_SCHEMA) return cold("wrong-schema");
    if (data.repositoryDigest !== digest) return cold("repository-mismatch");
    const loss = emptyLoss();
    const rawTriage = Array.isArray(data.triage) ? data.triage : [];
    const rawCandidates = Array.isArray(data.candidates) ? data.candidates : [];
    const triage = rawTriage.map(readValidTriage).filter((record) => record !== null);
    const candidates = rawCandidates.map(readValidCandidate).filter((record) => record !== null);
    loss.corrupt.triage = rawTriage.length - triage.length;
    loss.corrupt.candidates = rawCandidates.length - candidates.length;
    return new _ReuseStore(
      path,
      {
        schema: REUSE_STORE_SCHEMA,
        repositoryDigest: digest,
        runCounter: Number.isInteger(data.runCounter) ? data.runCounter : 0,
        firstRunAtMs: Number.isInteger(data.firstRunAtMs) ? data.firstRunAtMs : 0,
        rebaseline: data.rebaseline ?? floorState(policy),
        lockfileDigest: typeof data.lockfileDigest === "string" ? data.lockfileDigest : "",
        configDigest: typeof data.configDigest === "string" ? data.configDigest : "",
        identity: readValidIdentity(data.identity),
        verdicts: Array.isArray(data.verdicts) ? data.verdicts : [],
        reach: Array.isArray(data.reach) ? data.reach : [],
        /* EVERY CARRIED RECORD RE-VALIDATED ON THE WAY IN, one at a time: a single malformed entry
           drops itself rather than the whole store, and `readValidTriage` is where an equivalence
           hand-written into this file is refused. HOW MANY DROPPED IS COUNTED into `loss` above, so
           a store that lost half its contents to a partial write no longer reads as a store that
           only ever held half. */
        triage,
        candidates
      },
      "warm",
      loss
    );
  }
  /** Why this store opened cold, for the disclosure line; `"warm"` when it did not. */
  get openReason() {
    return this.#openReason;
  }
  /** What this store lost reading in, evicting, or writing out. Counts, never records. */
  get loss() {
    return {
      corrupt: { ...this.#loss.corrupt },
      evicted: { ...this.#loss.evicted },
      overBytes: { ...this.#loss.overBytes },
      droppedGapIds: [...this.#loss.droppedGapIds]
    };
  }
  get data() {
    return this.#data;
  }
  /** Start a run: bumps the counter, anchors the days rail, and rechecks the whole-store digests. */
  beginRun(current, nowMs) {
    this.#data.runCounter += 1;
    if (this.#data.firstRunAtMs === 0) this.#data.firstRunAtMs = nowMs;
    const known = this.#data.lockfileDigest !== "" || this.#data.configDigest !== "";
    const wholesale = known && (this.#data.lockfileDigest !== current.lockfileDigest || this.#data.configDigest !== current.configDigest);
    if (!known) {
      this.#data.lockfileDigest = current.lockfileDigest;
      this.#data.configDigest = current.configDigest;
    }
    if (wholesale) {
      this.#data.verdicts = [];
      this.#data.reach = [];
      this.#data.triage = [];
      this.#data.candidates = [];
      this.#data.lockfileDigest = current.lockfileDigest;
      this.#data.configDigest = current.configDigest;
    }
    return { run: this.#data.runCounter, wholesaleInvalidated: wholesale };
  }
  /* ----------------------------------------------------------------------- *
   * CARRIED MODEL OUTPUT
   * ----------------------------------------------------------------------- */
  /** The identity the stored records were produced under; `null` on a cold store. */
  get identity() {
    return this.#data.identity;
  }
  /**
   * Adopt this run's identity and drop everything the old one produced.
   *
   * Called when {@link forcedFullReasons} named at least one difference. The records are DROPPED
   * rather than left for their keys to miss on: a key miss and a wholesale drop cost the same money,
   * and a store that keeps records it has already decided are invalid is a store waiting for the
   * next reader to be less careful.
   */
  adoptIdentity(identity, forced) {
    if (forced) {
      this.#data.triage = [];
      this.#data.candidates = [];
    }
    this.#data.identity = identity;
  }
  /**
   * The carried triage verdict for this key, or `null`.
   *
   * BYTE-EXACT: the key already names every argument of the function whose answer this is, so a
   * match is a memoized answer to the identical question rather than a guess that the question is
   * close enough. There is no partial match and no nearest neighbour.
   */
  carriedTriage(key) {
    return this.#data.triage.find((record) => record.key === key) ?? null;
  }
  /**
   * Write a carried triage verdict.
   *
   * The verdict argument is {@link CarriableTriageVerdict}, so a caller holding a `likely-equivalent`
   * cannot reach this method without narrowing first - and narrowing is where the rule fires.
   */
  recordTriage(record) {
    this.#data.triage = this.#data.triage.filter((existing) => existing.key !== record.key);
    this.#data.triage.push(record);
  }
  /**
   * The carried generation proposal for this key, or `null`.
   *
   * A proposal a previous run's light check REJECTED is not returned. Re-carrying it would pin a
   * permanently failing candidate to the gap and the gap would never be regenerated - a carry that
   * suppresses work rather than saving it.
   */
  carriedCandidate(key) {
    const found = this.#data.candidates.find((record) => record.key === key);
    if (found === void 0 || found.rejectedAtRun !== null) return null;
    return found;
  }
  recordCandidate(record) {
    this.#data.candidates = this.#data.candidates.filter((existing) => existing.key !== record.key);
    this.#data.candidates.push(record);
  }
  /**
   * Mark a proposal this run's light check rejected, so the next run regenerates the gap.
   *
   * A TOMBSTONE, NOT A DELETE. Deleting would let the next run carry the same bytes again the moment
   * a model re-proposed them; the marked record says "these exact bytes were tried and did not
   * survive the light check", and {@link carriedCandidate} refuses to return it. The gap goes back
   * into the generation batch, which is the whole point.
   */
  rejectCandidate(key, atRun) {
    this.#data.candidates = this.#data.candidates.map(
      (existing) => existing.key === key ? { ...existing, rejectedAtRun: atRun } : existing
    );
  }
  /** A verdict is reusable only when every recorded digest matches today's. */
  lookup(input) {
    const found = this.#data.verdicts.find((verdict) => verdict.gapId === input.gapId);
    if (found === void 0) return null;
    if (found.fileDigest !== input.fileDigest || found.reachDigest !== input.reachDigest || found.recipeDigest !== input.recipeDigest) {
      return null;
    }
    return found;
  }
  record(verdict) {
    this.#data.verdicts = this.#data.verdicts.filter((existing) => existing.gapId !== verdict.gapId);
    this.#data.verdicts.push(verdict);
  }
  recordReach(reach) {
    this.#data.reach = this.#data.reach.filter((existing) => existing.file !== reach.file);
    this.#data.reach.push(reach);
  }
  reachFor(file, fileDigest) {
    const found = this.#data.reach.find((reach) => reach.file === file);
    return found !== null && found !== void 0 && found.fileDigest === fileDigest ? found : null;
  }
  /**
   * Distrust everything and start over. Used when a re-baseline's disagreement reaches tolerance:
   * the rate says the digests are not binding something that moves verdicts, so the entries that
   * happened to agree are no more trustworthy than the ones that did not. The run counter and the
   * days anchor survive - they describe the STORE's history, not the verdicts' validity.
   */
  rebuildFromScratch() {
    this.#data.verdicts = [];
    this.#data.reach = [];
    this.#data.triage = [];
    this.#data.candidates = [];
  }
  /** Record the new interval after a completed re-baseline. */
  setRebaselineState(state) {
    this.#data.rebaseline = state;
  }
  /**
   * Persist the store, ATOMICALLY.
   *
   * This wrote the file in place with a plain `writeFileSync`, so a run killed mid-write - a
   * cancelled check, a runner reclaimed, a deadline firing - left a half-written JSON file behind.
   * The next run reads that file, fails to parse it and starts cold, which is the safe direction but
   * pays full price for an accident. Every other store in this repository writes to a temp file with
   * `wx` and renames; this one now does too, so the file at this path is always either the previous
   * complete store or the new complete store and never a prefix of one.
   *
   * The temp name carries a random token because two runs of two repositories share this directory,
   * and `wx` turns a token collision into an error rather than a clobber.
   */
  save() {
    mkdirSync3(dirname6(this.#path), { recursive: true });
    this.#evictToBounds();
    this.#evictToByteBound();
    const bounded2 = `${JSON.stringify(this.#data, null, 2)}
`;
    const temp = join9(dirname6(this.#path), `.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync3(temp, bounded2, { flag: "wx", mode: 384 });
      renameSync(temp, this.#path);
    } catch (error) {
      try {
        if (existsSync7(temp)) unlinkSync(temp);
      } catch {
      }
      throw error;
    }
  }
  /**
   * Keep the record counts inside their bounds, oldest first.
   *
   * LRU BY `producedAtRun`, and rejected candidates go before anything else: a tombstone has done
   * its job once the gap it belonged to has been regenerated, and it is the only record here whose
   * value decays. Everything else is dropped oldest-first, which costs a model call on a gap nobody
   * has looked at in a long time rather than on the ones this push is about.
   */
  #evictToBounds() {
    if (this.#data.triage.length > CARRY_BOUNDS.maxTriageRecords) {
      const kept = [...this.#data.triage].sort((a, b) => a.producedAtRun - b.producedAtRun).slice(this.#data.triage.length - CARRY_BOUNDS.maxTriageRecords);
      this.#loss.evicted.triage += this.#data.triage.length - kept.length;
      this.#data.triage = kept;
    }
    if (this.#data.candidates.length > CARRY_BOUNDS.maxCandidateRecords) {
      const ordered = [...this.#data.candidates].sort(oldestCandidateFirst);
      const dropped = ordered.slice(0, ordered.length - CARRY_BOUNDS.maxCandidateRecords);
      this.#loss.evicted.candidates += dropped.length;
      this.#noteDroppedGaps(dropped);
      this.#data.candidates = ordered.slice(dropped.length);
    }
  }
  /**
   * KEEP AS MANY RECORDS AS THE BOUND ALLOWS, OLDEST OUT FIRST (junction audit CARRY-04).
   *
   * The bound exists because `open` refuses a file above it, so a store written past it would read
   * as cold forever. What the bound must NOT do is what it used to: replace both record arrays with
   * empty ones, which turned "this store is 1 byte too large" into "this repository has no history",
   * silently, on a save that reported success.
   *
   * The per-record cost is measured once - candidates carry test bodies up to 256 KiB each and are
   * where the bytes actually are - and the oldest are removed until the whole document fits, with
   * candidates going before triage verdicts because they are both larger and cheaper to reproduce.
   * A record that survives is byte-identical to the one that went in.
   */
  #evictToByteBound() {
    const serialize = () => Buffer.byteLength(`${JSON.stringify(this.#data, null, 2)}
`, "utf8");
    if (serialize() <= CARRY_BOUNDS.maxFileBytes) return;
    const costOf = (record) => Buffer.byteLength(JSON.stringify(record) ?? "", "utf8") + 8;
    const candidates = [...this.#data.candidates].sort(oldestCandidateFirst);
    const triage = [...this.#data.triage].sort((a, b) => a.producedAtRun - b.producedAtRun);
    const candidateCosts = candidates.map(costOf);
    const triageCosts = triage.map(costOf);
    const recordBytes = candidateCosts.reduce((sum, bytes) => sum + bytes, 0) + triageCosts.reduce((sum, bytes) => sum + bytes, 0);
    const fixedBytes = Math.max(0, serialize() - recordBytes);
    let budget = CARRY_BOUNDS.maxFileBytes - fixedBytes;
    const keptCandidates = [];
    const keptTriage = [];
    for (let index = triage.length - 1; index >= 0; index -= 1) {
      if (triageCosts[index] > budget) break;
      budget -= triageCosts[index];
      keptTriage.unshift(triage[index]);
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (candidateCosts[index] > budget) break;
      budget -= candidateCosts[index];
      keptCandidates.unshift(candidates[index]);
    }
    this.#loss.overBytes.triage += triage.length - keptTriage.length;
    this.#loss.overBytes.candidates += candidates.length - keptCandidates.length;
    this.#noteDroppedGaps(candidates.slice(0, candidates.length - keptCandidates.length));
    this.#data.triage = keptTriage;
    this.#data.candidates = keptCandidates;
    while (serialize() > CARRY_BOUNDS.maxFileBytes && this.#data.candidates.length > 0) {
      const [dropped] = this.#data.candidates.splice(0, 1);
      this.#loss.overBytes.candidates += 1;
      if (dropped !== void 0) this.#noteDroppedGaps([dropped]);
    }
    while (serialize() > CARRY_BOUNDS.maxFileBytes && this.#data.triage.length > 0) {
      this.#data.triage.splice(0, 1);
      this.#loss.overBytes.triage += 1;
    }
  }
  #noteDroppedGaps(records) {
    for (const record of records) {
      if (this.#loss.droppedGapIds.length >= MAX_DISCLOSED_DROPPED_GAPS) return;
      this.#loss.droppedGapIds.push(record.gapId);
    }
  }
};
function oldestCandidateFirst(a, b) {
  const rejected = Number(a.rejectedAtRun !== null) - Number(b.rejectedAtRun !== null);
  return rejected !== 0 ? -rejected : a.producedAtRun - b.producedAtRun;
}

// src/reuse/plan.ts
var REUSE_DECISIONS = [
  "reused",
  "execute-fresh-no-record",
  "execute-invalidated-file",
  "execute-invalidated-reach",
  "execute-invalidated-recipe",
  "execute-rebaseline",
  "execute-reported-gap",
  /**
   * THE DIRECTION RULE FIRED: a carried record existed and every digest matched, and it was re-asked
   * anyway because answering from it could only have removed a gap from the report.
   *
   * Named separately from every other exclusion because it is the only one that is not an
   * invalidation. Nothing changed; the rule simply does not let this answer be carried. Folding it
   * into `execute-fresh-no-record` would make the safe design look like a cache that keeps missing.
   */
  "execute-direction-rule",
  /** the run's identity moved - base, policy, prompt, engine, model or recipe - so nothing carried */
  "execute-forced-full"
];
function currentWholesaleDigests(repoDir, subdir) {
  return {
    lockfileDigest: fileSetDigest(repoDir, wholesalePaths(repoDir, subdir, LOCKFILE_CANDIDATES)),
    configDigest: fileSetDigest(repoDir, wholesalePaths(repoDir, subdir, CONFIG_CANDIDATES))
  };
}
function planReuse(input) {
  const { store } = input;
  const begun = store.beginRun(currentWholesaleDigests(input.repoDir), input.nowMs);
  const rebaseline = rebaselineDue(store.data, input.policy, input.nowMs);
  const entries = [];
  for (const candidate of input.candidates) {
    const reach = reachDigest(candidate.reachingTests);
    const stored = store.data.verdicts.find((verdict) => verdict.gapId === candidate.gapId);
    if (stored === void 0) {
      entries.push({ gapId: candidate.gapId, decision: "execute-fresh-no-record" });
      continue;
    }
    if (rebaseline) {
      entries.push({ gapId: candidate.gapId, decision: "execute-rebaseline", storedStatus: stored.status });
      continue;
    }
    if (stored.fileDigest !== candidate.fileDigest) {
      entries.push({ gapId: candidate.gapId, decision: "execute-invalidated-file", storedStatus: stored.status });
      continue;
    }
    if (stored.reachDigest !== reach) {
      entries.push({ gapId: candidate.gapId, decision: "execute-invalidated-reach", storedStatus: stored.status });
      continue;
    }
    if (stored.recipeDigest !== input.recipeDigest) {
      entries.push({ gapId: candidate.gapId, decision: "execute-invalidated-recipe", storedStatus: stored.status });
      continue;
    }
    if (candidate.wouldBeReported && stored.status !== "killed" && stored.status !== "timeout") {
      entries.push({ gapId: candidate.gapId, decision: "execute-reported-gap", storedStatus: stored.status });
      continue;
    }
    entries.push({ gapId: candidate.gapId, decision: "reused", storedStatus: stored.status });
  }
  const reused = entries.filter((entry) => entry.decision === "reused").length;
  return {
    entries,
    rebaseline,
    wholesaleInvalidated: begun.wholesaleInvalidated,
    reused,
    executed: entries.length - reused
  };
}
function planCarry(input) {
  const forcedFull = [
    ...forcedFullReasons({ stored: input.store.identity, current: input.identity }),
    ...input.forceFull ?? []
  ];
  const forced = forcedFull.length > 0;
  input.store.adoptIdentity(input.identity, forced);
  const keyFor = (candidate, promptVersion, modelPin) => carryKey({
    gapId: candidate.gapId,
    fileDigest: candidate.fileDigest,
    reachDigest: reachDigest(candidate.reachingTests),
    recipeDigest: input.keyContext.recipeDigest,
    policyDigest: input.keyContext.policyDigest,
    promptVersion,
    modelPin,
    engineVersion: input.keyContext.engineVersion,
    triageMode: input.keyContext.triageMode,
    importSpecifier: candidate.importSpecifier ?? "",
    coverageAttributed: candidate.reachAttributed
  });
  const triage = [];
  let directionRuleReasks = 0;
  for (const candidate of input.survivors) {
    const key = keyFor(candidate, input.triagePromptVersion, input.triageModelPin);
    if (forced) {
      triage.push({ gapId: candidate.gapId, key, decision: "execute-forced-full" });
      continue;
    }
    if (!candidate.reachAttributed) {
      triage.push({ gapId: candidate.gapId, key, decision: "execute-invalidated-reach" });
      continue;
    }
    const record = input.store.carriedTriage(key);
    if (record === null) {
      triage.push({ gapId: candidate.gapId, key, decision: "execute-fresh-no-record" });
      continue;
    }
    if (carriableVerdict(record.verdict) === null) {
      directionRuleReasks += 1;
      triage.push({ gapId: candidate.gapId, key, decision: "execute-direction-rule" });
      continue;
    }
    triage.push({ gapId: candidate.gapId, key, decision: "reused", triage: record });
  }
  const candidates = [];
  for (const gap of input.openGaps) {
    const key = keyFor(gap, input.generationPromptVersion, input.generationModelPin);
    if (forced) {
      candidates.push({ gapId: gap.gapId, key, decision: "execute-forced-full" });
      continue;
    }
    if (!gap.reachAttributed) {
      candidates.push({ gapId: gap.gapId, key, decision: "execute-invalidated-reach" });
      continue;
    }
    const record = input.store.carriedCandidate(key);
    if (record === null) {
      candidates.push({ gapId: gap.gapId, key, decision: "execute-fresh-no-record" });
      continue;
    }
    candidates.push({ gapId: gap.gapId, key, decision: "reused", candidate: record });
  }
  const carriedTriage = triage.filter((entry) => entry.decision === "reused").length;
  const carriedCandidates = candidates.filter((entry) => entry.decision === "reused").length;
  return {
    triage,
    candidates,
    forcedFull,
    carriedTriage,
    freshTriage: triage.length - carriedTriage,
    directionRuleReasks,
    carriedCandidates,
    freshCandidates: candidates.length - carriedCandidates
  };
}
function carriableTriageRecord(input) {
  const verdict = carriableVerdict(input.verdict);
  if (verdict === null) return null;
  return {
    key: input.key,
    gapId: input.gapId,
    verdict,
    reasonCode: input.reasonCode,
    confidence: input.confidence,
    ...input.rationale === void 0 ? {} : { rationale: input.rationale },
    ...input.description === void 0 ? {} : { description: input.description },
    ...input.about === void 0 ? {} : { about: input.about },
    ...input.severity === void 0 ? {} : { severity: input.severity },
    ...input.severityBasis === void 0 ? {} : { severityBasis: input.severityBasis },
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    ...input.effort === void 0 ? {} : { effort: input.effort },
    producedAtSha: input.producedAtSha,
    producedAtRun: input.producedAtRun
  };
}

// src/predict/features.ts
var FEATURE_VERSION = "marigold-predictor-features/1";
var MUTATION_SHAPES = [
  "emptied",
  "literal-swap",
  "string-literal",
  "comparison",
  "logical",
  "arithmetic",
  "call",
  "other"
];
var MUTATION_SPANS = ["single-line", "multi-line"];
var WHOLESALE_LITERALS = /* @__PURE__ */ new Set(["true", "false", "null", "undefined", "0", "1", "-1", "[]", "{}", "NaN"]);
var STRING_LITERAL_RE = /^(?:"[^"]*"|'[^']*'|`[^`]*`)$/su;
var COMPARISON_RE = /(?:<=|>=|===|!==|==|!=|<|>)/u;
var LOGICAL_RE = /(?:&&|\|\||(?:^|[\s(,])!)/u;
var ARITHMETIC_RE = /[\w).\]]\s*[+\-*/%]\s*[\w(["'`]/u;
var CALL_RE = /[\w.\]]\s*\(/u;
function mutationShape(input) {
  const original = input.originalText.trim();
  const replacement = input.replacement.trim();
  if (replacement === "") return "emptied";
  if (WHOLESALE_LITERALS.has(replacement)) return "literal-swap";
  if (STRING_LITERAL_RE.test(replacement) && STRING_LITERAL_RE.test(original)) return "string-literal";
  if (COMPARISON_RE.test(original) && COMPARISON_RE.test(replacement)) return "comparison";
  if (LOGICAL_RE.test(original) && LOGICAL_RE.test(replacement)) return "logical";
  if (ARITHMETIC_RE.test(original) && ARITHMETIC_RE.test(replacement)) return "arithmetic";
  if (CALL_RE.test(original)) return "call";
  return "other";
}
function mutationSpan(originalText) {
  return originalText.includes("\n") ? "multi-line" : "single-line";
}
function describeMutant(snippet) {
  return {
    file: snippet.file,
    mutator: snippet.mutator,
    shape: mutationShape(snippet),
    span: mutationSpan(snippet.originalText)
  };
}
var LADDER_RUNGS = ["file-mutator-shape-span", "file-mutator", "mutator-shape-span", "mutator"];
function rungKey(rung, features) {
  switch (rung) {
    case "file-mutator-shape-span":
      return `${features.file}\0${features.mutator}\0${features.shape}\0${features.span}`;
    case "file-mutator":
      return `${features.file}\0${features.mutator}`;
    case "mutator-shape-span":
      return `${features.mutator}\0${features.shape}\0${features.span}`;
    case "mutator":
      return features.mutator;
  }
}

// src/predict/store.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync4, readFileSync as readFileSync9, writeFileSync as writeFileSync4 } from "fs";
import { dirname as dirname7, join as join10 } from "path";
var PREDICTOR_STORE_SCHEMA = "abloh-marigold-predictor/v1";
function emptyPredictorStore() {
  return {
    schema: PREDICTOR_STORE_SCHEMA,
    featureVersion: FEATURE_VERSION,
    runCounter: 0,
    lockfileDigest: "",
    configDigest: "",
    examples: [],
    auditRounds: []
  };
}
var PredictorStore = class _PredictorStore {
  #data;
  #path;
  constructor(path, data) {
    this.#path = path;
    this.#data = data;
  }
  /**
   * Open the store for one repository. A corrupt file, a wrong schema or a stale feature version is
   * treated as NO store: the predictor degrades to cold, which executes everything. It never
   * degrades to a guess.
   */
  static open(storeDir, repoKey) {
    const path = join10(storeDir, `${sha256(repoKey).slice(0, 32)}-predictor.json`);
    if (!existsSync8(path)) return new _PredictorStore(path, emptyPredictorStore());
    try {
      const parsed = JSON.parse(readFileSync9(path, "utf8"));
      if (parsed.schema !== PREDICTOR_STORE_SCHEMA || parsed.featureVersion !== FEATURE_VERSION) {
        return new _PredictorStore(path, emptyPredictorStore());
      }
      return new _PredictorStore(path, parsed);
    } catch {
      return new _PredictorStore(path, emptyPredictorStore());
    }
  }
  get data() {
    return this.#data;
  }
  get path() {
    return this.#path;
  }
  /**
   * Start a run: bump the counter, and drop everything if the environment the outcomes were
   * recorded under has changed.
   */
  beginRun(current) {
    this.#data.runCounter += 1;
    const changed = this.#data.lockfileDigest !== current.lockfileDigest || this.#data.configDigest !== current.configDigest;
    if (changed) {
      this.#data.examples = [];
      this.#data.auditRounds = [];
      this.#data.lockfileDigest = current.lockfileDigest;
      this.#data.configDigest = current.configDigest;
    }
    return { run: this.#data.runCounter, environmentChanged: changed };
  }
  /**
   * Add this run's labeled outcomes, keeping the most recent `windowExamples`. The window is the
   * caller's explicit number - there is no default here, for the same reason the rebaseline cadence
   * has none.
   */
  recordExamples(examples, windowExamples) {
    if (!Number.isInteger(windowExamples) || windowExamples < 1) {
      throw new Error("predictor trainingWindowExamples must be an integer >= 1 (there is no default)");
    }
    this.#data.examples = [...this.#data.examples, ...examples].slice(-windowExamples);
  }
  /**
   * Add one finished audit round to the ROLLING window, then drop the oldest rounds until the
   * window holds at most `windowPredictions` compared predictions. The newest round is always kept
   * whole, even when it alone exceeds the window: a window that dropped the freshest evidence would
   * judge the predictor on nothing.
   */
  recordAuditRound(round, windowPredictions) {
    if (!Number.isInteger(windowPredictions) || windowPredictions < 1) {
      throw new Error("predictor auditWindowPredictions must be an integer >= 1 (there is no default)");
    }
    const rounds = [...this.#data.auditRounds, round];
    const kept = [];
    let total = 0;
    for (let index = rounds.length - 1; index >= 0; index--) {
      const candidate = rounds[index];
      if (kept.length > 0 && total + candidate.compared > windowPredictions) break;
      kept.unshift(candidate);
      total += candidate.compared;
    }
    this.#data.auditRounds = kept;
  }
  /**
   * Drop the audit window, keeping the training set. Called on a breach: Kenneth ruled that
   * re-enabling happens only after re-clearing on FRESH audits, so the rounds that recorded a
   * breach cannot be averaged away by the next few good ones.
   */
  clearAuditWindow() {
    this.#data.auditRounds = [];
  }
  save() {
    mkdirSync4(dirname7(this.#path), { recursive: true });
    writeFileSync4(this.#path, `${JSON.stringify(this.#data, null, 2)}
`);
  }
};

// src/predict/predictor.ts
var PREDICTION_LABELS = ["likely-killed", "likely-survived", "no-history"];
function validatePredictorPolicy(policy) {
  if (!(policy.disagreementThreshold > 0 && policy.disagreementThreshold < 1)) {
    throw new Error("predictor disagreementThreshold must be in (0, 1) (Kenneth sets it; there is no default)");
  }
  if (!Number.isInteger(policy.minAuditedPredictions) || policy.minAuditedPredictions < 1) {
    throw new Error("predictor minAuditedPredictions must be an integer >= 1 (Kenneth sets it; there is no default)");
  }
  if (!Number.isInteger(policy.auditWindowPredictions) || policy.auditWindowPredictions < policy.minAuditedPredictions) {
    throw new Error(
      "predictor auditWindowPredictions must be an integer >= minAuditedPredictions (a window smaller than the minimum could never license anything)"
    );
  }
  if (!(policy.auditFraction > 0 && policy.auditFraction <= 1)) {
    throw new Error("predictor auditFraction must be in (0, 1] (there is no default)");
  }
  if (!Number.isInteger(policy.minSamplesPerRung) || policy.minSamplesPerRung < 1) {
    throw new Error("predictor minSamplesPerRung must be an integer >= 1 (there is no default)");
  }
  if (!Number.isInteger(policy.trainingWindowExamples) || policy.trainingWindowExamples < 1) {
    throw new Error("predictor trainingWindowExamples must be an integer >= 1 (there is no default)");
  }
}
var RULED_PREDICTOR_POLICY = {
  disagreementThreshold: 0.03,
  minAuditedPredictions: 100,
  auditWindowPredictions: 400,
  auditFraction: 0.1,
  minSamplesPerRung: 5,
  trainingWindowExamples: 2e4
};
function decisiveOutcome(status) {
  if (status === "killed" || status === "timeout") return "killed";
  if (status === "survived" || status === "no-coverage") return "survived";
  return null;
}
function trainPredictor(examples) {
  const rungs = /* @__PURE__ */ new Map();
  for (const rung of LADDER_RUNGS) rungs.set(rung, /* @__PURE__ */ new Map());
  let trainedOn = 0;
  for (const example of examples) {
    trainedOn += 1;
    for (const rung of LADDER_RUNGS) {
      const table = rungs.get(rung);
      const key = rungKey(rung, example.features);
      const tally = table.get(key) ?? { killed: 0, survived: 0 };
      tally[example.outcome] += 1;
      table.set(key, tally);
    }
  }
  if (trainedOn === 0) return null;
  return { featureVersion: FEATURE_VERSION, trainedOn, rungs };
}
function predictGap(model, mutant, policy) {
  validatePredictorPolicy(policy);
  for (const rung of LADDER_RUNGS) {
    const tally = model.rungs.get(rung)?.get(rungKey(rung, mutant.features));
    if (tally === void 0) continue;
    const samples = tally.killed + tally.survived;
    if (samples < policy.minSamplesPerRung) continue;
    return {
      gapId: mutant.gapId,
      label: tally.killed > tally.survived ? "likely-killed" : "likely-survived",
      basis: { rung, samples, killRate: tally.killed / samples }
    };
  }
  return { gapId: mutant.gapId, label: "no-history", basis: { rung: null, samples: 0, killRate: null } };
}

// src/predict/plan.ts
var PREDICTOR_MODES = ["cold", "shadow", "skipping"];
var PREDICTOR_DECISIONS = [
  "execute-predicted-survivor",
  "execute-no-history",
  "execute-audit-slice",
  "execute-shadow",
  "execute-cold",
  "skip-predicted-kill"
];
var ORDER_RANK = {
  "execute-predicted-survivor": 0,
  "execute-shadow": 1,
  "execute-cold": 1,
  "execute-no-history": 2,
  "execute-audit-slice": 3,
  "skip-predicted-kill": 4
};
function executionOrder(entries) {
  const executing = entries.filter((entry) => entry.decision !== "skip-predicted-kill");
  const rankOf = (entry) => {
    if (entry.decision !== "execute-shadow") return ORDER_RANK[entry.decision];
    if (entry.prediction?.label === "likely-survived") return 0;
    if (entry.prediction?.label === "no-history") return 2;
    return 3;
  };
  return executing.map((entry, index) => ({ entry, index })).sort((a, b) => rankOf(a.entry) - rankOf(b.entry) || a.index - b.index).map(({ entry }) => entry.gapId);
}
function summarizeAuditWindow(rounds, policy) {
  validatePredictorPolicy(policy);
  let compared = 0;
  let disagreed = 0;
  for (const round of rounds) {
    compared += round.compared;
    disagreed += round.disagreed;
  }
  const rate = compared === 0 ? 0 : disagreed / compared;
  const withinThreshold = rate < policy.disagreementThreshold;
  const sufficient = compared >= policy.minAuditedPredictions;
  return {
    rounds: rounds.length,
    compared,
    disagreed,
    disagreementRate: rate,
    threshold: policy.disagreementThreshold,
    withinThreshold,
    sufficient,
    licensed: sufficient && withinThreshold
  };
}
function predictorMode(model, window, maySkip) {
  if (model === null) return "cold";
  return maySkip && window.licensed ? "skipping" : "shadow";
}
function seededAuditSlice(predictedKillGapIds, seed, auditFraction) {
  const ranked = [...predictedKillGapIds].sort((a, b) => {
    const ha = sha256(`${seed}:${a}`);
    const hb = sha256(`${seed}:${b}`);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  const size = predictedKillGapIds.length === 0 ? 0 : Math.ceil(auditFraction * predictedKillGapIds.length);
  return new Set(ranked.slice(0, size));
}
function planPredictor(input) {
  validatePredictorPolicy(input.policy);
  const mode = predictorMode(input.model, input.window, input.maySkip);
  const entries = [];
  if (mode === "cold") {
    for (const mutant of input.mutants) {
      entries.push({ gapId: mutant.gapId, decision: "execute-cold", prediction: null });
    }
    return {
      mode,
      entries,
      order: executionOrder(entries),
      predictedKilled: 0,
      predictedSurvived: 0,
      /* No model means no history for anything: the whole population is counted here, so
         executed + skipped equals the label sum in every mode and the server can recompute it. */
      noHistory: entries.length,
      auditSliceSize: 0,
      skipped: 0,
      executed: entries.length
    };
  }
  const model = input.model;
  const predictions = input.mutants.map((mutant) => predictGap(model, mutant, input.policy));
  const predictedKilled = predictions.filter((p) => p.label === "likely-killed").length;
  const predictedSurvived = predictions.filter((p) => p.label === "likely-survived").length;
  const noHistory = predictions.filter((p) => p.label === "no-history").length;
  if (mode === "shadow") {
    for (const prediction of predictions) {
      entries.push({ gapId: prediction.gapId, decision: "execute-shadow", prediction });
    }
    return {
      mode,
      entries,
      order: executionOrder(entries),
      predictedKilled,
      predictedSurvived,
      noHistory,
      auditSliceSize: 0,
      skipped: 0,
      executed: entries.length
    };
  }
  const slice = seededAuditSlice(
    predictions.filter((p) => p.label === "likely-killed").map((p) => p.gapId),
    input.seed,
    input.policy.auditFraction
  );
  for (const prediction of predictions) {
    const decision = prediction.label === "likely-survived" ? "execute-predicted-survivor" : prediction.label === "no-history" ? "execute-no-history" : slice.has(prediction.gapId) ? "execute-audit-slice" : "skip-predicted-kill";
    entries.push({ gapId: prediction.gapId, decision, prediction });
  }
  const skipped = entries.filter((entry) => entry.decision === "skip-predicted-kill").length;
  return {
    mode,
    entries,
    order: executionOrder(entries),
    predictedKilled,
    predictedSurvived,
    noHistory,
    auditSliceSize: slice.size,
    skipped,
    executed: entries.length - skipped
  };
}
function auditRound(plan, fresh) {
  const audited = plan.entries.filter(
    (entry) => entry.prediction?.label === "likely-killed" && (entry.decision === "execute-audit-slice" || entry.decision === "execute-shadow")
  );
  const disagreed = [];
  let compared = 0;
  let undecided = 0;
  for (const entry of audited) {
    const status = fresh.get(entry.gapId);
    if (status === void 0) continue;
    const outcome = decisiveOutcome(status);
    if (outcome === null) {
      undecided += 1;
      continue;
    }
    compared += 1;
    if (outcome === "survived") disagreed.push({ gapId: entry.gapId, fresh: status });
  }
  return {
    scope: plan.mode === "shadow" ? "full" : "slice",
    compared,
    agreed: compared - disagreed.length,
    disagreed,
    undecided
  };
}
function foldAuditRound(input) {
  validatePredictorPolicy(input.policy);
  if (input.round.compared === 0) {
    return {
      window: summarizeAuditWindow(input.store.data.auditRounds, input.policy),
      breached: false,
      recorded: false
    };
  }
  input.store.recordAuditRound(
    {
      atRun: input.atRun,
      scope: input.round.scope,
      compared: input.round.compared,
      disagreed: input.round.disagreed.length
    },
    input.policy.auditWindowPredictions
  );
  const window = summarizeAuditWindow(input.store.data.auditRounds, input.policy);
  const breached = window.sufficient && !window.withinThreshold;
  if (breached) input.store.clearAuditWindow();
  return { window, breached, recorded: true };
}
function predictorDisclosure(input) {
  const project = (window) => ({
    rounds: window.rounds,
    compared: window.compared,
    disagreed: window.disagreed,
    disagreementRate: window.disagreementRate,
    threshold: window.threshold,
    withinThreshold: window.withinThreshold,
    sufficient: window.sufficient,
    licensed: window.licensed
  });
  return {
    countsTowardScore: false,
    mode: input.plan.mode,
    predictedKilled: input.plan.predictedKilled,
    predictedSurvived: input.plan.predictedSurvived,
    noHistory: input.plan.noHistory,
    executed: input.plan.executed,
    auditSliceSize: input.plan.auditSliceSize,
    skippedPredictedKills: input.plan.skipped,
    windowAtPlan: project(input.windowAtPlan),
    ...input.windowAfter === void 0 ? {} : { windowAfter: project(input.windowAfter) },
    ...input.round === void 0 ? {} : {
      round: {
        scope: input.round.scope,
        compared: input.round.compared,
        agreed: input.round.agreed,
        disagreed: input.round.disagreed.length,
        undecided: input.round.undecided
      }
    },
    ...input.breached === void 0 ? {} : { breached: input.breached }
  };
}

// src/pool2/aim.ts
var AIM_SOURCES = ["night-per-line", "night-sweep", "diff-survivors", "warm-start"];
function aimDigest(aims) {
  const named = nonEmptyAims(aims);
  if (named.length === 0) return void 0;
  return structuralDigest2({
    aims: named.map((aim) => ({
      source: aim.source,
      spans: mergeAimSpans(aim.spans).map(([from, to]) => [from, to])
    })).sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
  });
}
function nonEmptyAims(aims) {
  return (aims ?? []).filter((aim) => aim.spans.length > 0);
}
function buildAimDisclosure(targets) {
  const aimedFiles = targets.map((target) => nonEmptyAims(target.aims)).filter((aims) => aims.length > 0);
  if (aimedFiles.length === 0) return void 0;
  const sources = /* @__PURE__ */ new Set();
  let spans = 0;
  let lines = 0;
  for (const aims of aimedFiles) {
    for (const aim of aims) sources.add(aim.source);
    const merged = mergeAimSpans(aims.flatMap((aim) => aim.spans));
    spans += merged.length;
    for (const [from, to] of merged) lines += to - from + 1;
  }
  return { sources: [...sources].sort(), files: aimedFiles.length, spans, lines };
}
function mergeAimSpans(spans) {
  const ordered = [...spans].map(([from, to]) => [Math.min(from, to), Math.max(from, to)]).filter(([from]) => from >= 1).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [from, to] of ordered) {
    const last = merged[merged.length - 1];
    if (last !== void 0 && from <= last[1] + 1) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], to)];
      continue;
    }
    merged.push([from, to]);
  }
  return merged;
}
function aimWithin(spans, within) {
  if (within.length === 0) return mergeAimSpans(spans);
  const clipped = [];
  for (const [from, to] of spans) {
    for (const [low, high] of within) {
      const start = Math.max(from, low);
      const end = Math.min(to, high);
      if (start <= end) clipped.push([start, end]);
    }
  }
  return mergeAimSpans(clipped);
}

// src/pool2/sizing.ts
var RULED_SIZING_LAMBDA = 2;
var RULED_MIN_ATTEMPTS_PER_FILE = 2;
var RULED_POOL2_WALL_ALLOWANCE_MS = 20 * 60 * 1e3;
var RULED_NIGHT_POOL2_WALL_ALLOWANCE_MS = 240 * 60 * 1e3;
var MEASURED_EXECUTIONS_PER_ATTEMPT = 3;
var MEASURED_EXECUTION_MS = 11e3;
var MEASURED_ATTEMPT_EXECUTION_MS = MEASURED_EXECUTIONS_PER_ATTEMPT * MEASURED_EXECUTION_MS;
var MEASURED_GENERATION_ROUND_MS = 13e4;
var RULED_GENERATION_CONCURRENCY = 8;
function classicSitesByFile(input) {
  const rangesByFile = /* @__PURE__ */ new Map();
  for (const scope of input.scopes) rangesByFile.set(scope.file, scope.ranges);
  const sites = /* @__PURE__ */ new Map();
  for (const mutant of input.mutants) {
    if (mutant.origin !== void 0 && mutant.origin !== "stryker" && mutant.origin !== "deterministic") continue;
    const ranges = rangesByFile.get(mutant.file);
    if (ranges === void 0) continue;
    if (!overlapsAnyRange(mutant.startLine, mutant.endLine, ranges)) continue;
    const key = [mutant.startLine, mutant.startColumn ?? "", mutant.endLine, mutant.endColumn ?? ""].join(":");
    const forFile = sites.get(mutant.file) ?? /* @__PURE__ */ new Set();
    forFile.add(key);
    sites.set(mutant.file, forFile);
  }
  const counts = /* @__PURE__ */ new Map();
  for (const scope of input.scopes) counts.set(scope.file, sites.get(scope.file)?.size ?? 0);
  return counts;
}
function overlapsAnyRange(startLine, endLine, ranges) {
  return ranges.some(([from, to]) => startLine <= to && endLine >= from);
}
function attemptsForFile(sites, policy, explicit) {
  if (explicit !== void 0) {
    if (!Number.isInteger(explicit) || explicit < 0) {
      throw new Error("an explicit per-file attempt count must be a non-negative integer");
    }
    return explicit;
  }
  if (!Number.isInteger(sites) || sites < 0) {
    throw new Error("a site count must be a non-negative integer");
  }
  if (sites === 0) return 0;
  return Math.max(policy.minAttemptsPerFile, policy.lambda * sites);
}
function sizingSitesOf(scope) {
  const uncovered = scope.uncoveredSites ?? 0;
  if (!Number.isInteger(uncovered) || uncovered < 0) {
    throw new Error("uncovered site count must be a non-negative integer");
  }
  return scope.classicSites + uncovered;
}
function validateSizingPolicy(policy) {
  if (!Number.isInteger(policy.lambda) || policy.lambda < 1) {
    throw new Error("agent bug pool lambda must be an integer >= 1 (there is no default)");
  }
  if (!Number.isInteger(policy.minAttemptsPerFile) || policy.minAttemptsPerFile < 1) {
    throw new Error("agent bug pool minAttemptsPerFile must be an integer >= 1 (there is no default)");
  }
  if (!Number.isInteger(policy.wallAllowanceMs) || policy.wallAllowanceMs < 6e4) {
    throw new Error("agent bug pool wallAllowanceMs must be an integer >= 60000 (there is no default)");
  }
}
function planPoolSizing(input) {
  validateSizingPolicy(input.policy);
  const ordered = [...input.scopes].sort(
    (a, b) => sizingSitesOf(b) - sizingSitesOf(a) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  );
  const identifiedSites = ordered.reduce((total, scope) => total + sizingSitesOf(scope), 0);
  const uncoveredSites = ordered.reduce((total, scope) => total + (scope.uncoveredSites ?? 0), 0);
  const zeroSiteFiles = ordered.filter((scope) => sizingSitesOf(scope) === 0 && scope.attempts === void 0).length;
  const withSites = ordered.filter((scope) => attemptsForFile(sizingSitesOf(scope), input.policy, scope.attempts) > 0);
  const maxConcurrentGeneration = Math.max(1, Math.min(RULED_GENERATION_CONCURRENCY, Math.max(1, withSites.length)));
  const generationRounds = withSites.length === 0 ? 0 : Math.ceil(withSites.length / maxConcurrentGeneration);
  const executionBudgetMs = Math.max(0, input.policy.wallAllowanceMs - generationRounds * MEASURED_GENERATION_ROUND_MS);
  const attemptCap = Math.floor(executionBudgetMs / MEASURED_ATTEMPT_EXECUTION_MS);
  const files = [];
  let attemptsPlanned = 0;
  let attemptsRequested = 0;
  let coveredSites = 0;
  let filesFunded = 0;
  for (const scope of ordered) {
    const sites = sizingSitesOf(scope);
    const requested = attemptsForFile(sites, input.policy, scope.attempts);
    attemptsRequested += requested;
    const room = attemptCap - attemptsPlanned;
    const attempts = requested === 0 ? 0 : requested <= room ? requested : room >= input.policy.minAttemptsPerFile ? room : 0;
    const covered = attempts === 0 ? 0 : attempts >= requested ? sites : Math.min(sites, Math.floor(attempts / input.policy.lambda));
    attemptsPlanned += attempts;
    coveredSites += covered;
    if (attempts > 0) filesFunded += 1;
    files.push({
      file: scope.file,
      classicSites: scope.classicSites,
      uncoveredSites: scope.uncoveredSites ?? 0,
      attempts,
      requested,
      coveredSites: covered,
      funded: attempts > 0
    });
  }
  return {
    files,
    identifiedSites,
    uncoveredSites,
    coveredSites,
    zeroSiteFiles,
    filesFunded,
    attemptsRequested,
    attemptsPlanned,
    attemptCap,
    maxConcurrentGeneration,
    generationRounds,
    truncated: coveredSites < identifiedSites,
    hasDiffSurface: ordered.some((scope) => scope.ranges.length > 0),
    planDigest: structuralDigest2({
      lambda: input.policy.lambda,
      minAttemptsPerFile: input.policy.minAttemptsPerFile,
      wallAllowanceMs: input.policy.wallAllowanceMs,
      files: ordered.map((scope) => {
        const aim = aimDigest(scope.aims);
        return {
          file: scope.file,
          ranges: scope.ranges.map(([from, to]) => [from, to]),
          classicSites: scope.classicSites,
          /* THE UNEXECUTED HALF JOINS THE KEY WHEN THERE IS ONE, on the aim block's argument
             exactly: it changes the ASK, so a pool generated for four attempts must not be replayed
             for a run that would have asked for ten. A change with no unexecuted site digests the
             bytes it always did, so every pool pinned before this stays addressable. The uncovered
             RANGES are absent from the key on purpose - they change no question, only how the
             answers are counted afterwards. */
          ...scope.uncoveredSites ? { uncoveredSites: scope.uncoveredSites } : {},
          ...scope.attempts === void 0 ? {} : { attempts: scope.attempts },
          ...aim === void 0 ? {} : { aim }
        };
      })
    })
  };
}
function fundedFileCeiling(input) {
  validateSizingPolicy(input.policy);
  if (!Number.isInteger(input.attemptsPerFile) || input.attemptsPerFile < 1) {
    throw new Error("fundedFileCeiling attemptsPerFile must be an integer >= 1");
  }
  if (!Number.isInteger(input.ceiling) || input.ceiling < 0) {
    throw new Error("fundedFileCeiling ceiling must be a non-negative integer");
  }
  return fundedAskPrefix({
    attempts: Array.from({ length: input.ceiling }, () => input.attemptsPerFile),
    policy: input.policy
  });
}
function fundedAskPrefix(input) {
  validateSizingPolicy(input.policy);
  input.attempts.forEach((ask, index) => {
    if (!Number.isInteger(ask) || ask < 1) {
      throw new Error(`fundedAskPrefix attempts[${index}] must be an integer >= 1`);
    }
  });
  let funded = 0;
  let asked = 0;
  for (let files = 1; files <= input.attempts.length; files += 1) {
    asked += input.attempts[files - 1];
    const plan = planPoolSizing({
      scopes: input.attempts.slice(0, files).map((attempts, index) => ({
        file: `${index}`,
        ranges: [],
        classicSites: 0,
        attempts
      })),
      policy: input.policy
    });
    if (plan.attemptsPlanned < asked) break;
    funded = files;
  }
  return funded;
}
function coverageClaimSentence(coverage) {
  if (coverage.identifiedSites === 0) {
    return "this change has no mutable code this run could find, so no bugs were planted";
  }
  if (!coverage.truncated) {
    return `attempted all ${coverage.identifiedSites} identified site(s) on this change`;
  }
  const missed = coverage.identifiedSites - coverage.coveredSites;
  return `covered ${coverage.coveredSites} of ${coverage.identifiedSites} identified site(s) on this change - this run's time allowance ended, and the ${missed} we did not reach are not a clean bill`;
}

// src/pool2/uncovered-sites.ts
import ts4 from "typescript";
function scriptKind4(fileName) {
  if (fileName.endsWith(".tsx")) return ts4.ScriptKind.TSX;
  if (/\.[cm]?ts$/u.test(fileName)) return ts4.ScriptKind.TS;
  if (fileName.endsWith(".jsx")) return ts4.ScriptKind.JSX;
  return ts4.ScriptKind.JS;
}
function syntaxErrorCount4(sourceFile) {
  const withDiagnostics = sourceFile;
  return withDiagnostics.parseDiagnostics?.length ?? 0;
}
var BINARY_OPERATORS = /* @__PURE__ */ new Set([
  /* arithmetic: + for -, * for / */
  ts4.SyntaxKind.PlusToken,
  ts4.SyntaxKind.MinusToken,
  ts4.SyntaxKind.AsteriskToken,
  ts4.SyntaxKind.SlashToken,
  ts4.SyntaxKind.PercentToken,
  /* equality and the boundaries off-by-one moves */
  ts4.SyntaxKind.EqualsEqualsToken,
  ts4.SyntaxKind.ExclamationEqualsToken,
  ts4.SyntaxKind.EqualsEqualsEqualsToken,
  ts4.SyntaxKind.ExclamationEqualsEqualsToken,
  ts4.SyntaxKind.LessThanToken,
  ts4.SyntaxKind.LessThanEqualsToken,
  ts4.SyntaxKind.GreaterThanToken,
  ts4.SyntaxKind.GreaterThanEqualsToken,
  /* logical, including the nullish fallback the deterministic pass drops */
  ts4.SyntaxKind.AmpersandAmpersandToken,
  ts4.SyntaxKind.BarBarToken,
  ts4.SyntaxKind.QuestionQuestionToken,
  /* assignment: `=` for `+=`, and every compound for its counterpart */
  ts4.SyntaxKind.EqualsToken,
  ts4.SyntaxKind.PlusEqualsToken,
  ts4.SyntaxKind.MinusEqualsToken,
  ts4.SyntaxKind.AsteriskEqualsToken,
  ts4.SyntaxKind.SlashEqualsToken,
  ts4.SyntaxKind.PercentEqualsToken,
  ts4.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts4.SyntaxKind.BarBarEqualsToken,
  ts4.SyntaxKind.QuestionQuestionEqualsToken
]);
var UNARY_OPERATORS = /* @__PURE__ */ new Set([
  ts4.SyntaxKind.PlusToken,
  ts4.SyntaxKind.MinusToken,
  ts4.SyntaxKind.TildeToken,
  ts4.SyntaxKind.ExclamationToken
]);
function isMutableSite(node) {
  if (ts4.isBinaryExpression(node)) return BINARY_OPERATORS.has(node.operatorToken.kind);
  if (ts4.isPrefixUnaryExpression(node)) return UNARY_OPERATORS.has(node.operator) || isUpdateOperator(node.operator);
  if (ts4.isPostfixUnaryExpression(node)) return isUpdateOperator(node.operator);
  if (node.kind === ts4.SyntaxKind.TrueKeyword || node.kind === ts4.SyntaxKind.FalseKeyword) return true;
  if (ts4.isStringLiteral(node) || ts4.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts4.isNumericLiteral(node)) return true;
  if (ts4.isRegularExpressionLiteral(node)) return true;
  if (ts4.isArrayLiteralExpression(node) || ts4.isObjectLiteralExpression(node)) return true;
  if (ts4.isConditionalExpression(node)) return true;
  if (ts4.isCallExpression(node) || ts4.isNewExpression(node)) return true;
  if (ts4.isPropertyAccessExpression(node) || ts4.isElementAccessExpression(node)) {
    return node.questionDotToken !== void 0;
  }
  if (ts4.isReturnStatement(node)) return node.expression !== void 0;
  if (ts4.isBlock(node)) return true;
  if (ts4.isArrowFunction(node)) return true;
  if (ts4.isAwaitExpression(node)) return true;
  if (ts4.isThrowStatement(node)) return true;
  if (node.kind === ts4.SyntaxKind.BreakStatement || node.kind === ts4.SyntaxKind.ContinueStatement) return true;
  return false;
}
function isUpdateOperator(kind) {
  return kind === ts4.SyntaxKind.PlusPlusToken || kind === ts4.SyntaxKind.MinusMinusToken;
}
function mutableSitesOnLines(input) {
  if (input.ranges.length === 0) return 0;
  const sourceFile = ts4.createSourceFile(
    input.file,
    input.source,
    ts4.ScriptTarget.Latest,
    /* setParentNodes */
    false,
    scriptKind4(input.file)
  );
  if (syntaxErrorCount4(sourceFile) > 0) return 0;
  const spans = /* @__PURE__ */ new Set();
  const visit = (node) => {
    if (isMutableSite(node)) {
      const start = node.getStart(sourceFile);
      const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
      if (overlapsAnyRange(line, line, input.ranges)) spans.add(`${start}:${node.end}`);
    }
    ts4.forEachChild(node, visit);
  };
  ts4.forEachChild(sourceFile, visit);
  return spans.size;
}
function uncoveredSitesByFile(input) {
  const counts = /* @__PURE__ */ new Map();
  for (const scope of input.scopes) {
    const source = scope.ranges.length === 0 ? null : input.readSource(scope.file);
    counts.set(
      scope.file,
      source === null ? 0 : mutableSitesOnLines({ file: scope.file, source, ranges: scope.ranges })
    );
  }
  return counts;
}

// src/pool2/store.ts
import { existsSync as existsSync9, readFileSync as readFileSync10, rmSync } from "fs";
import { join as join11 } from "path";
import {
  EVIDENCE_RETENTION_DEFAULT_DAYS,
  evidenceDeleteAfter,
  evidenceRetentionExpired,
  makeFilePrivate,
  requireEvidenceCustody,
  writePrivateFile
} from "@abloh/core";
var BUG_POOL_STORE_SCHEMA = "abloh-marigold-bug-pool/v2";
function fileContentDigest(source) {
  return sha256(source);
}
var CONTENT_POOL_REUSE_LIMIT = 4;
function purgeExpiredPins(data, now) {
  const kept = (deleteAfter) => typeof deleteAfter === "string" && !evidenceRetentionExpired(deleteAfter, now);
  return {
    ...data,
    pools: (data.pools ?? []).filter((pool) => kept(pool.deleteAfter)),
    ...data.filePools === void 0 ? {} : { filePools: data.filePools.filter((entry) => kept(entry.deleteAfter)) },
    ...data.graduated === void 0 ? {} : { graduated: data.graduated.filter((entry) => kept(entry.deleteAfter)) }
  };
}
function custodyOr(custody) {
  return requireEvidenceCustody(
    custody ?? { retentionDays: EVIDENCE_RETENTION_DEFAULT_DAYS, now: () => /* @__PURE__ */ new Date() }
  );
}
function bugPoolStorePath(storeDir, repoKey) {
  return join11(storeDir, `${sha256(repoKey).slice(0, 32)}-bug-pool.json`);
}
var BugPoolStore = class _BugPoolStore {
  #data;
  #path;
  #custody;
  /** Whether opening this store dropped anything, and therefore owes the disk a rewrite. */
  #purged;
  constructor(path, data, custody) {
    this.#path = path;
    this.#custody = custody;
    this.#data = purgeExpiredPins(data, custody.now());
    const held = (input) => (input.pools ?? []).length + (input.filePools ?? []).length + (input.graduated ?? []).length;
    this.#purged = held(this.#data) !== held(data);
  }
  /**
   * A corrupt or wrong-schema file is no store at all: the pool regenerates, never guesses.
   *
   * AND AN EXPIRED ENTRY IS NOT A STORE EITHER. Every entry past its deadline is dropped here,
   * before a single lookup can be answered from it, so an expired pin cannot be replayed and cannot
   * be disclosed. The drop is in memory until `save()`; a night that reads and never writes leaves
   * the file alone, and the next write is what removes the bytes.
   */
  static open(storeDir, repoKey, custody) {
    const held = custodyOr(custody);
    const path = bugPoolStorePath(storeDir, repoKey);
    const empty = () => new _BugPoolStore(path, { schema: BUG_POOL_STORE_SCHEMA, pools: [] }, held);
    if (!existsSync9(path)) return empty();
    makeFilePrivate(path);
    try {
      const parsed = JSON.parse(readFileSync10(path, "utf8"));
      if (parsed.schema !== BUG_POOL_STORE_SCHEMA) return empty();
      const store = new _BugPoolStore(path, parsed, held);
      if (store.#purged) store.save();
      return store;
    } catch {
      return empty();
    }
  }
  /**
   * Plant tonight's working copy from pins held somewhere else.
   *
   * THE HOST IS NOT WHERE THESE LIVE. A production night's pins come from the control plane, and
   * this writes them where the run can reach them for the length of the night. `null` plants
   * nothing: a repository the control plane holds no pins for is a repository whose first night
   * generates its pool, which is what an absent file has always meant.
   *
   * A WRONG-SCHEMA BLOB IS NOT PLANTED, for the same reason `open` treats one as no store: an entry
   * written under `/v1` carries source text under no policy, and materialising it on the audit host
   * would put exactly that on the disk this whole change exists to clear.
   */
  static plantWorkingCopy(storeDir, repoKey, data) {
    const path = bugPoolStorePath(storeDir, repoKey);
    if (data === null || data.schema !== BUG_POOL_STORE_SCHEMA) {
      _BugPoolStore.clearWorkingCopy(storeDir, repoKey);
      return;
    }
    writePrivateFile(path, `${JSON.stringify(data, null, 2)}
`);
  }
  /**
   * What the working copy holds now, for the sync that sends it back - or null when it holds nothing.
   *
   * NOT `open().data`, deliberately. `open` purges expired entries in memory, and the sync must send
   * what the night actually wrote rather than a filtered view of it; the control plane runs the same
   * purge under the same window on its own rows, so filtering twice would only hide a disagreement
   * between the two if there ever were one.
   */
  static readWorkingCopy(storeDir, repoKey) {
    const path = bugPoolStorePath(storeDir, repoKey);
    if (!existsSync9(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync10(path, "utf8"));
      return parsed.schema === BUG_POOL_STORE_SCHEMA ? parsed : null;
    } catch {
      return null;
    }
  }
  /** Remove the working copy from this host. Nothing there is not an error - it is the goal. */
  static clearWorkingCopy(storeDir, repoKey) {
    rmSync(bugPoolStorePath(storeDir, repoKey), { force: true });
  }
  get data() {
    return this.#data;
  }
  /** The deadline this store stamps on anything written right now. */
  get deleteAfter() {
    return evidenceDeleteAfter(this.#custody.now(), this.#custody.retentionDays);
  }
  lookup(sha, promptVersion, planDigest) {
    return this.#data.pools.find(
      (pool) => pool.sha === sha && pool.promptVersion === promptVersion && (pool.planDigest ?? void 0) === planDigest
    ) ?? null;
  }
  /** The commit-independent graduated members, newest night first. */
  graduated() {
    return [...this.#data.graduated ?? []].sort((a, b) => b.graduatedOnNight - a.graduatedOnNight);
  }
  /**
   * The same members in RE-CHECK order: the one that has waited longest goes first.
   *
   * WHAT THE ORDER IS FOR. A run takes the first `graduatedCeiling` of this list, so the order is
   * what decides who is re-verified now and who waits a run. Sorting by staleness is what makes the
   * wait bounded: a member re-checked in the newest round sinks to the bottom, so it cannot take a
   * seat again until everyone above it has had one.
   *
   * NEWEST-NIGHT-FIRST IS STILL THE TIE-BREAK, and that is deliberate rather than incidental. Every
   * member of a store written before the rotation is equally stale, so the first run after this
   * lands composes its pool in exactly the order the old truncation did - and a repository whose
   * carried set fits under the ceiling is never re-ordered at all, because its members are always
   * stamped together and therefore always tie. The bug id is the last tie-break so two members
   * graduated on one night have an order that does not depend on how the file was written.
   */
  graduatedStalestFirst() {
    return [...this.#data.graduated ?? []].sort((a, b) => {
      const left = a.lastReplayedRound ?? 0;
      const right = b.lastReplayedRound ?? 0;
      if (left !== right) return left - right;
      if (a.graduatedOnNight !== b.graduatedOnNight) return b.graduatedOnNight - a.graduatedOnNight;
      return a.bugId < b.bugId ? -1 : a.bugId > b.bugId ? 1 : 0;
    });
  }
  /** Which round the graduated set has reached; zero before any run took a member. */
  graduatedReplayRound() {
    return this.#data.graduatedReplayRound ?? 0;
  }
  /**
   * Record that these members were re-checked, as one round, and answer the round it counted as.
   *
   * ONE ROUND PER RUN, not one per member: the point of the number is to say who has waited longer
   * than whom, and a per-member stamp would make a run that took eight members eight rounds old.
   * The caller still has to `save()`, exactly as it does for the content decay.
   */
  markGraduatedReplayed(bugIds) {
    const round = this.graduatedReplayRound() + 1;
    const replayed = new Set(bugIds);
    this.#data.graduatedReplayRound = round;
    this.#data.graduated = (this.#data.graduated ?? []).map(
      (entry) => replayed.has(entry.bugId) ? { ...entry, lastReplayedRound: round } : entry
    );
    return round;
  }
  /**
   * Admit a graduated bug. Re-graduating the same bug replaces its record rather than duplicating
   * it: the pool is a set of weak spots, and the same weak spot found twice is one weak spot.
   *
   * BUT THE FIRST FINDING KEEPS ITS DATE. A weak spot found on night 1 and re-proven on night 2 was
   * still found on night 1, and the whole record used to be overwritten - so the second night's
   * store said all nine of its weak spots were found that night, four of which were night 1's, and
   * nothing anywhere still knew when any of them was first seen (`data/abloh-second-night/report.md`
   * defect 4). The proof is this night's and is replaced; the discovery is not this night's and is
   * carried, so a re-graduation is a re-proof rather than a re-discovery.
   */
  graduate(bug) {
    const existing = this.#data.graduated ?? [];
    const first = existing.find((entry) => entry.bugId === bug.bugId);
    const dated = { ...bug, deleteAfter: this.deleteAfter };
    const admitted = first === void 0 ? dated : {
      ...dated,
      graduatedOnNight: first.graduatedOnNight,
      graduatedAtMs: first.graduatedAtMs,
      graduatedAtSha: first.graduatedAtSha,
      /* AND ITS PLACE IN THE ROTATION IS CARRIED FOR THE SAME REASON THE DATE IS. A weak spot
         re-proven tonight is the same weak spot, so dropping its last replay round would send
         it to the front of the re-check queue and let it take a seat ahead of members that
         have genuinely waited longer - the rotation would starve exactly the weak spots the
         lane keeps re-finding. Absent stays absent, which is a member no run has taken yet. */
      ...first.lastReplayedRound === void 0 ? {} : { lastReplayedRound: first.lastReplayedRound }
    };
    this.#data.graduated = [...existing.filter((entry) => entry.bugId !== bug.bugId), admitted];
  }
  /**
   * Look up one file version's pool and SPEND a reuse if it answers.
   *
   * The spend happens here rather than at the call site because the two must not drift: a lookup
   * that replays without counting is a file that never decays, and a count taken somewhere else is a
   * count that a `continue` can skip. The caller still has to `save()`.
   */
  lookupByContent(key) {
    const entry = (this.#data.filePools ?? []).find(
      (candidate) => candidate.contentDigest === key.contentDigest && candidate.promptVersion === key.promptVersion && candidate.ask === key.ask && candidate.file === key.file && (candidate.aimDigest ?? void 0) === key.aimDigest && (candidate.catalogDigest ?? void 0) === key.catalogDigest
    );
    if (entry === void 0) return { state: "absent" };
    if (entry.reuses >= CONTENT_POOL_REUSE_LIMIT) return { state: "decayed", entry };
    entry.reuses += 1;
    return { state: "replay", entry };
  }
  /**
   * Record what one file version's generation produced, under its content key.
   *
   * Re-recording the same key replaces it and RESETS the reuse count, which is what makes the decay
   * a cycle rather than a one-off: the fresh generation an exhausted entry earned becomes the entry
   * the next four visits replay.
   */
  recordByContent(entry) {
    const existing = this.#data.filePools ?? [];
    this.#data.filePools = [
      /* THE SAME KEY THE LOOKUP ASKS, `file` INCLUDED. The two predicates are what make an entry
         replaceable rather than duplicable, so a field in one and not the other would leave a
         second entry under a key the lookup then answers from at random. */
      ...existing.filter(
        (candidate) => !(candidate.contentDigest === entry.contentDigest && candidate.promptVersion === entry.promptVersion && candidate.ask === entry.ask && candidate.file === entry.file && (candidate.aimDigest ?? void 0) === (entry.aimDigest ?? void 0) && (candidate.catalogDigest ?? void 0) === (entry.catalogDigest ?? void 0))
      ),
      { ...entry, reuses: 0, deleteAfter: this.deleteAfter }
    ];
  }
  /**
   * Attach a proven witness to a stored bug wherever the store holds it.
   *
   * WHY THE STORE LEARNS IT. Under the deferred witness a survivor pays a model call for its test,
   * and a survivor replayed from a content key would survive again and pay again every visit -
   * which would hand back the saving the deferral just bought. Writing it down once makes the second
   * visit free. It changes nothing about proof: the witness is still executed live, both sides, on
   * every run that replays it.
   */
  attachWitness(bugId, witness, diagnosis) {
    for (const entry of this.#data.filePools ?? []) {
      for (const bug of entry.bugs) {
        if (bug.bugId !== bugId || bug.witness !== void 0) continue;
        bug.witness = witness;
        if (diagnosis !== void 0) bug.diagnosis = diagnosis;
      }
    }
  }
  /**
   * Remove a bug's witness wherever the store holds it, so the next visit writes a new one.
   *
   * THE COUNTERPART TO `attachWitness`, and the reason it exists is that attaching is one-way:
   * `attachWitness` refuses to overwrite a bug that already has a witness, which is correct for a
   * PROVEN one - two visits to the same pin must replay the same test - and was catastrophic for a
   * refused one. A witness that failed its proof stayed attached, so every later visit replayed the
   * broken test, spent no model call, and returned the identical refusal until the pin expired.
   *
   * ALL THREE COLLECTIONS, for `purgeExpiredPins`'s reason: a bug can be held as a commit pin, as a
   * file version's entry, and as a graduated weak spot, and a witness left behind in any one of them
   * is a witness the next visit replays.
   *
   * THE DIAGNOSIS GOES WITH IT. The same model call wrote both, so a diagnosis kept beside a deleted
   * witness would describe a demonstration this repository no longer has.
   */
  detachWitness(bugId) {
    const strip = (bug) => {
      if (bug.bugId !== bugId) return;
      delete bug.witness;
      delete bug.diagnosis;
    };
    for (const entry of this.#data.filePools ?? []) for (const bug of entry.bugs) strip(bug);
    for (const pool of this.#data.pools) for (const bug of pool.bugs) strip(bug);
    for (const bug of this.#data.graduated ?? []) strip(bug);
  }
  /** Record a freshly generated pool. Re-recording the same key replaces it - the pin is singular. */
  record(pool) {
    this.#data.pools = this.#data.pools.filter(
      (existing) => !(existing.sha === pool.sha && existing.promptVersion === pool.promptVersion && (existing.planDigest ?? void 0) === (pool.planDigest ?? void 0))
    );
    this.#data.pools.push({ ...pool, deleteAfter: this.deleteAfter });
  }
  /**
   * PRIVATE AND ATOMIC, because this file holds a customer's original source, the replacement that
   * was planted into it, and the witness test written against it (junction audit rank 8). It used
   * to be written with the ambient umask, which is `0644` on the measured default - readable by
   * every account on the host and by every other job sharing a CI runner. The rename also means a
   * half-written store can never be read as a corrupt one, which for this store would throw away a
   * night of model spend.
   */
  save() {
    writePrivateFile(this.#path, `${JSON.stringify(this.#data, null, 2)}
`);
  }
};

// src/pool2/generation.ts
import {
  acceptBugBehaviour,
  acceptBugSentence,
  acceptBugSeverity,
  acceptBugType,
  BUG_BEHAVIOUR_VERDICTS,
  BUG_SEVERITIES,
  MAX_BUG_RATIONALE_LEN,
  MAX_BUG_SENTENCE_LEN,
  MAX_BUG_TYPE_LEN,
  sanitizeFindingAbout
} from "@abloh/core";

// src/pool2/domain-context.ts
import { existsSync as existsSync11, readFileSync as readFileSync12 } from "fs";
import { dirname as dirname9, join as join13, resolve as resolve4 } from "path";

// src/pool2/witness-modules.ts
import { existsSync as existsSync10, readFileSync as readFileSync11, statSync as statSync2 } from "fs";
import { dirname as dirname8, join as join12, relative as relative4, resolve as resolve3 } from "path";
var MAX_TEST_FILES_READ = 12;
var MAX_TEST_FILE_CHARS = 64e3;
var MAX_MODULES = 4;
var MAX_EXPORTED_NAMES = 60;
var MAX_DEPENDENCIES = 8;
var SOURCE_EXTENSIONS2 = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
function collectWitnessModules(input) {
  const modules = [];
  const target = readModule(input.repoDir, input.targetFile, input.witnessFile, input.moduleFormat, input.runner);
  if (target !== null) modules.push(target);
  const seen = /* @__PURE__ */ new Set([input.targetFile]);
  let others = 0;
  for (const [file] of rankImportedModules(input.repoDir, input.testFilePaths)) {
    if (others >= MAX_MODULES) break;
    if (seen.has(file)) continue;
    seen.add(file);
    const module = readModule(input.repoDir, file, input.witnessFile, input.moduleFormat, input.runner);
    if (module === null || module.exportedNames.length === 0 && module.defaultExportName === null) continue;
    modules.push(module);
    others += 1;
  }
  return modules;
}
function collectWitnessDependencies(input) {
  const counts = /* @__PURE__ */ new Map();
  const declared = /* @__PURE__ */ new Set();
  let read = 0;
  for (const testPath of input.testFilePaths) {
    if (read >= MAX_TEST_FILES_READ) break;
    const absolute = join12(input.repoDir, testPath);
    if (!existsSync10(absolute)) continue;
    const source = readFileSync11(absolute, "utf8");
    if (source.length > MAX_TEST_FILE_CHARS) continue;
    read += 1;
    for (const name of declaredDependencies(input.repoDir, dirname8(testPath))) declared.add(name);
    for (const specifier of bareSpecifiers(source)) {
      const name = packageNameOf(specifier);
      if (name === null) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  for (const name of declaredDependencies(input.repoDir, ".")) declared.add(name);
  return [...counts.entries()].filter(([name]) => declared.has(name)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_DEPENDENCIES).map(([name]) => name);
}
function declaredDependencies(repoDir, fromDir) {
  const names = [];
  const root = resolve3(repoDir);
  let directory = resolve3(root, fromDir);
  for (; ; ) {
    const manifest = join12(directory, "package.json");
    if (existsSync10(manifest)) names.push(...manifestDependencies(manifest));
    if (directory === root) break;
    const parent = dirname8(directory);
    if (parent === directory || !parent.startsWith(root)) break;
    directory = parent;
  }
  return names;
}
function manifestDependencies(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync11(manifestPath, "utf8"));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const names = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = parsed[field];
    if (typeof block === "object" && block !== null) names.push(...Object.keys(block));
  }
  return names;
}
function packageNameOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) return null;
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.length < 2 ? null : `${segments[0]}/${segments[1]}`;
  return segments[0] === "" ? null : segments[0];
}
function bareSpecifiers(source) {
  const specifiers = /* @__PURE__ */ new Set();
  for (const pattern of IMPORT_PATTERNS) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (!match[1].startsWith(".")) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}
function readModule(repoDir, file, witnessFile, moduleFormat, runner) {
  const absolute = join12(repoDir, file);
  if (!existsSync10(absolute)) return null;
  const source = readFileSync11(absolute, "utf8");
  const names = exportedNames(source);
  const truncated = names.length > MAX_EXPORTED_NAMES;
  return {
    file,
    specifier: importSpecifierFor({ testFile: witnessFile, targetFile: file, moduleFormat, runner }),
    exportedNames: truncated ? names.slice(0, MAX_EXPORTED_NAMES) : names,
    defaultExportName: defaultExportName(source),
    truncated
  };
}
function rankImportedModules(repoDir, testFilePaths) {
  const counts = /* @__PURE__ */ new Map();
  const testFiles = new Set(testFilePaths);
  let read = 0;
  for (const testPath of testFilePaths) {
    if (read >= MAX_TEST_FILES_READ) break;
    const absolute = join12(repoDir, testPath);
    if (!existsSync10(absolute)) continue;
    const source = readFileSync11(absolute, "utf8");
    if (source.length > MAX_TEST_FILE_CHARS) continue;
    read += 1;
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = resolveModule(repoDir, dirname8(testPath), specifier);
      if (resolved === null || testFiles.has(resolved)) continue;
      counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
var IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu
];
function relativeSpecifiers(source) {
  const specifiers = /* @__PURE__ */ new Set();
  for (const pattern of IMPORT_PATTERNS) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1].startsWith(".")) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}
function resolveModule(repoDir, fromDir, specifier) {
  const absoluteRoot = resolve3(repoDir);
  const base = resolve3(absoluteRoot, fromDir, specifier);
  const candidates = [base];
  const stripped = base.replace(/\.(?:m|c)?js$/u, "");
  if (stripped !== base) candidates.push(stripped, ...SOURCE_EXTENSIONS2.map((ext) => `${stripped}${ext}`));
  candidates.push(...SOURCE_EXTENSIONS2.map((ext) => `${base}${ext}`));
  candidates.push(...SOURCE_EXTENSIONS2.map((ext) => join12(base, `index${ext}`)));
  for (const candidate of candidates) {
    if (!existsSync10(candidate) || !statSync2(candidate).isFile()) continue;
    const repoRelative = relative4(absoluteRoot, candidate);
    if (repoRelative === "" || repoRelative.startsWith("..")) return null;
    return repoRelative.split("\\").join("/");
  }
  return null;
}

// src/pool2/domain-context.ts
var MAX_DOMAIN_MODULES = 6;
var MAX_DOMAIN_MODULE_CHARS = 96e3;
var MAX_DOMAIN_TYPES = 8;
var MAX_DOMAIN_TYPE_CHARS = 900;
var MAX_DOMAIN_CONSTANTS = 16;
var MAX_DOMAIN_CONSTANT_CHARS = 120;
var MAX_README_FRAGMENTS = 3;
var MAX_README_FRAGMENT_CHARS = 600;
var MIN_README_NEEDLE = 4;
var MAX_DOMAIN_INVARIANTS = 12;
var MAX_DOMAIN_INVARIANT_CHARS = 300;
var EMPTY_DOMAIN_CONTEXT = { types: [], constants: [], readme: [], invariants: [] };
function isEmptyDomainContext(context) {
  return context.types.length === 0 && context.constants.length === 0 && context.readme.length === 0 && context.invariants.length === 0;
}
function constantsIn(source, file) {
  const out = [];
  const pattern = /^[ \t]*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^\n]+)$/gmu;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const value = match[2].trim().replace(/[;,]$/u, "").trim();
    if (value === "" || value.length > MAX_DOMAIN_CONSTANT_CHARS) continue;
    if (/[{([]\s*$/u.test(value)) continue;
    out.push({ file, name: match[1], value });
  }
  return out;
}
function readmeFragments(input) {
  const readme = nearestReadme(input.repoDir, input.targetFile);
  if (readme === null) return [];
  const basename4 = (input.targetFile.split("/").pop() ?? "").replace(/\.[^.]+$/u, "");
  const needles = new Set(exportedNames(input.source).filter((name) => name.length >= MIN_README_NEEDLE));
  if (basename4.length >= MIN_README_NEEDLE) needles.add(basename4);
  if (needles.size === 0) return [];
  const withoutFences = readme.replace(/```[\s\S]*?```/gu, "");
  const fragments = [];
  for (const raw of withoutFences.split(/\n\s*\n/u)) {
    const paragraph = raw.trim();
    if (paragraph === "" || paragraph.startsWith("#") || paragraph.startsWith("|")) continue;
    if (![...needles].some((needle) => mentions(paragraph, needle))) continue;
    const collapsed = paragraph.replace(/\s+/gu, " ");
    fragments.push(
      collapsed.length > MAX_README_FRAGMENT_CHARS ? `${collapsed.slice(0, MAX_README_FRAGMENT_CHARS)}\u2026` : collapsed
    );
    if (fragments.length >= MAX_README_FRAGMENTS) break;
  }
  return fragments;
}
function mentions(paragraph, needle) {
  const isWordChar = (character) => character !== void 0 && /[\w$]/u.test(character);
  const identifierShaped = /[A-Z_]/u.test(needle.slice(1));
  let from = 0;
  for (; ; ) {
    const at = paragraph.indexOf(needle, from);
    if (at === -1) return false;
    const bounded2 = !isWordChar(paragraph[at - 1]) && !isWordChar(paragraph[at + needle.length]);
    if (bounded2 && (identifierShaped || isOwnCodeSpan(paragraph, at, needle))) return true;
    from = at + 1;
  }
}
function isOwnCodeSpan(paragraph, offset, needle) {
  let open = -1;
  let ticks = 0;
  for (let index = 0; index < offset; index++) {
    if (paragraph[index] !== "`") continue;
    ticks += 1;
    open = index;
  }
  if (ticks % 2 === 0) return false;
  const close = paragraph.indexOf("`", offset);
  if (close === -1) return false;
  const span = paragraph.slice(open + 1, close).trim();
  if (!span.startsWith(needle)) return false;
  const after = span[needle.length];
  return after === void 0 || !/[\w$]/u.test(after);
}
function nearestReadme(repoDir, targetFile) {
  const root = resolve4(repoDir);
  let directory = resolve4(root, dirname9(targetFile));
  for (; ; ) {
    for (const name of ["README.md", "readme.md", "Readme.md"]) {
      const candidate = join13(directory, name);
      if (existsSync11(candidate)) {
        const text = readFileSync12(candidate, "utf8");
        if (text.length <= MAX_DOMAIN_MODULE_CHARS) return text;
        return text.slice(0, MAX_DOMAIN_MODULE_CHARS);
      }
    }
    if (directory === root) return null;
    const parent = dirname9(directory);
    if (parent === directory || !parent.startsWith(root)) return null;
    directory = parent;
  }
}
function collectDomainContext(input) {
  const types = [];
  const constants = [];
  const fromDir = dirname9(input.targetFile);
  let read = 0;
  for (const specifier of relativeSpecifiers(input.source)) {
    if (read >= MAX_DOMAIN_MODULES) break;
    const file = resolveModule(input.repoDir, fromDir, specifier);
    if (file === null || file === input.targetFile) continue;
    const absolute = join13(input.repoDir, file);
    if (!existsSync11(absolute)) continue;
    const source = readFileSync12(absolute, "utf8");
    if (source.length > MAX_DOMAIN_MODULE_CHARS) continue;
    read += 1;
    for (const declaration of exportedTypes(source)) {
      if (types.length >= MAX_DOMAIN_TYPES) break;
      if (declaration.length > MAX_DOMAIN_TYPE_CHARS) continue;
      types.push({ file, declaration });
    }
    for (const constant of constantsIn(source, file)) {
      if (constants.length >= MAX_DOMAIN_CONSTANTS) break;
      constants.push(constant);
    }
  }
  const invariants = (input.invariants ?? []).map((entry) => entry.replace(/\s+/gu, " ").trim()).filter((entry) => entry !== "" && entry.length <= MAX_DOMAIN_INVARIANT_CHARS).slice(0, MAX_DOMAIN_INVARIANTS);
  return {
    types,
    constants,
    readme: readmeFragments({ repoDir: input.repoDir, targetFile: input.targetFile, source: input.source }),
    invariants
  };
}
function domainBlock(entries) {
  const present = entries.filter((entry) => !isEmptyDomainContext(entry.domain));
  if (present.length === 0) return [];
  const perFile = present.flatMap((entry) => {
    const { types, constants, readme, invariants } = entry.domain;
    const lines = [`### what surrounds ${entry.file}:`];
    if (types.length > 0) {
      lines.push("types it imports, as declared:");
      for (const type of types) lines.push(`from ${type.file}:`, "```", type.declaration, "```");
    }
    if (constants.length > 0) {
      lines.push("named constants it can reach, with the values they were given:");
      for (const constant of constants) lines.push(`- ${constant.name} = ${constant.value}  (${constant.file})`);
    }
    if (readme.length > 0) {
      lines.push("what this repository's own documentation says about it:");
      for (const fragment of readme) lines.push(`- ${fragment}`);
    }
    if (invariants.length > 0) {
      lines.push("RULES THE OWNERS OF THIS CODE WROTE DOWN THEMSELVES, in their words:");
      for (const invariant of invariants) lines.push(`- ${invariant}`);
    }
    lines.push("");
    return lines;
  });
  return [
    "",
    "WHAT THIS CODE MEANS. The facts below are read off the repository around each file - the types",
    "it imports, the constants it can reach, what its own documentation says about it. They are a",
    "SAMPLE and never a complete account: a type or a constant absent here may still exist.",
    "",
    ...perFile,
    "USE THEM FOR MEANING, NOT FOR PLACEMENT. A unit named in a type or a constant is what makes a",
    "unit confusion writable; two same-typed fields are what make a semantic swap writable; a rule",
    "the owners wrote down is what makes breaking it worth reporting. This changes nothing about",
    "where a bug may go: the placement rule above still decides that."
  ];
}

// src/pool2/negative-catalog.ts
function classicPlantedByFile(input) {
  const rangesByFile = new Map(input.scopes.map((scope) => [scope.file, scope.ranges]));
  const out = /* @__PURE__ */ new Map();
  for (const scope of input.scopes) out.set(scope.file, []);
  for (const mutant of input.mutants) {
    if (mutant.origin !== void 0 && mutant.origin !== "stryker" && mutant.origin !== "deterministic") continue;
    const ranges = rangesByFile.get(mutant.file);
    if (ranges === void 0) continue;
    if (ranges.length > 0 && !input.overlaps(mutant.startLine, mutant.endLine, ranges)) continue;
    out.get(mutant.file)?.push({
      startLine: mutant.startLine,
      endLine: mutant.endLine,
      operator: mutant.mutator,
      replacement: mutant.replacement,
      ...mutant.originalText === void 0 ? {} : { originalText: mutant.originalText }
    });
  }
  return out;
}
var MAX_PLANTED_PER_FILE = 12;
var MAX_PLANTED_TEXT_CHARS = 120;
function oneLine(text) {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_PLANTED_TEXT_CHARS ? `${collapsed.slice(0, MAX_PLANTED_TEXT_CHARS)}\u2026` : collapsed;
}
function inSourceOrder(mutants) {
  return [...mutants].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || (a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0));
}
function stridedSample(items, cap) {
  if (cap < 1) return [];
  if (items.length <= cap) return [...items];
  const stride = items.length / cap;
  const picked = [];
  for (let index = 0; index < cap; index++) picked.push(items[Math.floor(index * stride)]);
  return picked;
}
function catalogDigest(input) {
  if (input.operators.length === 0 && input.planted.length === 0 && input.domainLines.length === 0) {
    return void 0;
  }
  return input.digest({
    operators: input.operators.map((operator) => [operator.id, operator.rewrite]),
    /* The SAMPLE, not the population: what the block prints is what the model was asked against,
       and two runs that planted differently but printed the same twelve asked the same question. */
    planted: stridedSample(inSourceOrder(input.planted), MAX_PLANTED_PER_FILE).map((mutant) => [
      mutant.startLine,
      mutant.endLine,
      mutant.operator,
      mutant.replacement
    ]),
    domain: input.domainLines
  });
}
function exclusionBlock(input) {
  const withMutants = input.planted.filter((entry) => entry.mutants.length > 0);
  if (input.operators.length === 0 && withMutants.length === 0) return [];
  const operatorLines = input.operators.length === 0 ? [] : [
    "Every rewrite the free pass runs, by its own operator name:",
    ...input.operators.map((operator) => `- ${operator.id}: ${operator.rewrite}`),
    ""
  ];
  const plantedLines = withMutants.flatMap((entry) => {
    const sample = stridedSample(inSourceOrder(entry.mutants), MAX_PLANTED_PER_FILE);
    const cut = entry.mutants.length > sample.length ? ` (${sample.length} of ${entry.mutants.length} shown)` : "";
    return [
      `### already planted in ${entry.file} by that pass, this run${cut}:`,
      ...sample.map((mutant) => {
        const where = mutant.startLine === mutant.endLine ? `line ${mutant.startLine}` : `lines ${mutant.startLine}-${mutant.endLine}`;
        const became = mutant.replacement === null ? "removed" : `became \`${oneLine(mutant.replacement)}\``;
        const from = mutant.originalText === void 0 ? "" : `\`${oneLine(mutant.originalText)}\` `;
        return `${where} [${mutant.operator}]: ${from}${became}`;
      }),
      ""
    ];
  });
  return [
    "",
    "WHAT IS ALREADY COVERED FOR FREE. A deterministic pass has already mutated these same changed",
    "lines and measured every mutant against the suite. Anything it can express is bought and paid",
    "for, so a bug of yours that repeats it buys this run nothing.",
    "",
    ...operatorLines,
    ...plantedLines,
    "EXCLUSION RULE: do not propose a bug whose edit one of the rewrites above could produce. The",
    "test is EXPRESSIBILITY, never size. Ask only: could that pass, applying one of its own rewrites",
    "to this source, arrive at my edit? If yes, drop it and propose something else, however large it",
    "looks. If no, it is worth proposing, however small it looks - a one-character edit no rewrite",
    "above can reach is exactly what this call is for. This relaxes nothing above: a bug outside the",
    "changed lines is still discarded."
  ];
}

// src/pool2/generation.ts
var BUG_POOL_PROMPT_VERSION = "marigold-bug-pool/11";
var BUG_POOL_TASK = "bug-pool-generation";
var BUG_WITNESS_TASK = "bug-pool-witness";
function validateAgentBugPoolPolicy(policy) {
  validateSizingPolicy(policy);
  if (!Number.isInteger(policy.graduatedCeiling) || policy.graduatedCeiling < 0) {
    throw new Error("agent bug pool graduatedCeiling must be an integer >= 0 (there is no default)");
  }
  for (const key of ["targetedTimeoutMs", "suiteTimeoutMs"]) {
    if (!Number.isInteger(policy[key]) || policy[key] < 1e3) {
      throw new Error(`agent bug pool ${key} must be an integer >= 1000 (there is no default)`);
    }
  }
}
var RULED_AGENT_BUG_POOL_POLICY = {
  lambda: RULED_SIZING_LAMBDA,
  minAttemptsPerFile: RULED_MIN_ATTEMPTS_PER_FILE,
  wallAllowanceMs: RULED_POOL2_WALL_ALLOWANCE_MS,
  graduatedCeiling: 8,
  targetedTimeoutMs: 3e5,
  suiteTimeoutMs: 6e5
};
var MAX_PROMPT_FILE_CHARS = 2e4;
function placementBlock(targets) {
  const listed = targets.filter((target) => target.changedRanges.length > 0);
  if (listed.length === 0) return [];
  const perFile = listed.map((target) => {
    const lines = target.source.split("\n");
    const numbers = changedLineNumbers(target.changedRanges, lines.length);
    return [
      `### changed lines in ${target.file}: ${numbers.join(", ")}`,
      ...numbers.map((line) => `${line}: ${lines[line - 1] ?? ""}`),
      ""
    ].join("\n");
  });
  return [
    "",
    "WHERE THE CHANGE IS. This commit changed only the lines listed below.",
    "",
    ...perFile,
    "PLACEMENT RULE, WHICH OVERRIDES NOTHING ELSE ABOVE: every bug's `originalText` MUST overlap at",
    "least one of the changed lines listed above. A bug elsewhere in the file measures the wrong code",
    "and will be discarded. Still propose at most the number of bugs asked for above."
  ];
}
var AIM_PROVENANCE = {
  "night-per-line": "an overnight pass changed each of these lines mechanically and the suite still passed",
  "night-sweep": "an overnight pass removed each of these function bodies entirely and the suite still passed",
  "diff-survivors": "this run's deterministic mutation of these lines was not caught by any test",
  "warm-start": "an earlier overnight pass changed each of these lines mechanically and the suite still passed"
};
function aimBlock(targets) {
  const aimed = targets.filter((target) => nonEmptyAims(target.aims).length > 0);
  if (aimed.length === 0) return [];
  const perFile = aimed.map((target) => {
    const lines = target.source.split("\n");
    return nonEmptyAims(target.aims).map(
      (aim) => [
        `### proven blind lines in ${target.file} - ${AIM_PROVENANCE[aim.source]}:`,
        ...changedLineNumbers(aim.spans, lines.length).map((line) => `${line}: ${lines[line - 1] ?? ""}`),
        ""
      ].join("\n")
    ).join("\n");
  });
  return [
    "",
    "WHERE THE SUITE IS PROVEN BLIND. Each line below was already changed mechanically and the whole",
    "test suite was run against the result: nothing failed. These are not guesses about weak tests,",
    "they are places the suite demonstrably asserts nothing.",
    "",
    ...perFile,
    "AIM RULE: prefer these lines. A bug placed on one of them is a bug the suite is already known",
    "not to notice, which is what this measurement is for. It does not relax anything above: every",
    "rule stated earlier, including the placement rule, still decides whether a bug is accepted."
  ];
}
function changedLineNumbers(ranges, fileLines) {
  const numbers = /* @__PURE__ */ new Set();
  for (const [from, to] of ranges) {
    for (let line = Math.max(1, from); line <= Math.min(to, fileLines); line++) numbers.add(line);
  }
  return [...numbers].sort((a, b) => a - b);
}
function moduleBlock(target) {
  const lines = target.modules.map((module) => {
    const names = module.exportedNames.join(", ");
    const exported = names === "" ? "exports nothing under a name" : `exports ${names}${module.truncated ? ", \u2026 (list cut)" : ""}`;
    const fallback = module.defaultExportName === null ? "" : `; default export: ${module.defaultExportName}`;
    return `- \`${module.specifier}\` (${module.file}) ${exported}${fallback}`;
  });
  const listed = lines.length === 0 ? [] : [`modules a witness for ${target.file} may import, and everything they export:`, ...lines];
  const packages = target.dependencies.length === 0 ? [] : [
    `packages this repository's own tests import, which your test may import too: ${target.dependencies.join(", ")}`
  ];
  if (listed.length === 0 && packages.length === 0) return [];
  return [
    ...listed,
    /* The class, stated rather than enumerated: naming hundreds of first-party paths would cost more
       than the file already in the prompt, and the defect being held closed is an invented NAME on a
       module, never a first-party PATH. */
    `every other source file of this repository is importable too, by its path relative to ${target.witnessFile} - the list above is what a few of them export, not the limit of what exists`,
    ...packages
  ];
}
function buildBugPoolPrompt(input) {
  const files = input.targets.map((target) => {
    const truncated = target.source.length > MAX_PROMPT_FILE_CHARS;
    const source = truncated ? target.source.slice(0, MAX_PROMPT_FILE_CHARS) : target.source;
    return [
      `### file: ${target.file}${truncated ? " (truncated)" : ""}`,
      "```",
      source,
      "```"
    ].join("\n");
  });
  return [
    "You are writing REALISTIC BUGS to measure a test suite.",
    "",
    `Propose at most ${input.maxBugs} bugs across the files below. Each bug must:`,
    /* THE SEMANTIC ASK, /11 (Kenneth, 2026-08-27). The five examples that stood here named the
       five edits a free deterministic pass performs on these same lines before this call is made,
       so the ask was spending a model on the cheap arm's own output. What replaces them is the set
       of mistakes that pass cannot express at all - every one of them a mistake about MEANING
       rather than about a token. They are shapes to reach for, never a closed list. */
    "- be a mistake about MEANING, of a kind that reads as correct code. Reach for these shapes:",
    "  * WRONG ORDER OF OPERATIONS - the same operations, sequenced so the answer changes",
    "    (rounding before scaling, filtering after taking a slice, normalising after comparing);",
    "  * A SEMANTIC SWAP of two values of the SAME TYPE whose meanings differ - width for height,",
    "    from for to, row for column, start for end, buyer for seller, actual for expected;",
    "  * UNIT CONFUSION - milliseconds where seconds are meant, pixels for rem, cents for the major",
    "    currency unit, bytes for kilobytes, radians for degrees, a ratio for a percentage;",
    "  * A PLAUSIBLE-BUT-WRONG FORMULA - a computation a careful reader would accept and that gives",
    "    the wrong number: the wrong denominator, an average of averages, tax on the wrong subtotal;",
    "  * A DROPPED OR REORDERED await - work no longer waited for, or awaited in an order that lets",
    "    a later step read what an earlier one had not finished writing;",
    "  * ERROR-PATH ROT - an error caught and swallowed, a fallback value that is wrong rather than",
    "    absent, a retry that returns the failed attempt's result, a cleanup that no longer runs;",
    "  * A LEGAL-BUT-WRONG STATE TRANSITION - a status, flag or lifecycle step moved to a value the",
    "    type permits and the domain does not, or one reached without the step that earns it;",
    "  * ONE CODE PATH FORGETTING AN INVARIANT the others keep - the same clamp, sort, trim, lock or",
    "    rounding applied everywhere but on one branch.",
    "  Never a syntax error, and never an edit that only renames or reformats.",
    /* MULTI-STATEMENT EDITS, SAID OUT LOUD. The old ask said ONE contiguous stretch and gave only
       token-sized examples, and a model reading both together reads a ceiling on size. The span
       rule is unchanged - it is what makes a bug locatable - but several of the classes above
       cannot be written inside one token, so the sentence now says the stretch may be long. */
    "- replace ONE contiguous stretch of existing source text with new text of your choosing. That",
    "  stretch may be a whole statement or several consecutive statements, and for most of the",
    "  shapes above it will have to be - a reordering or a wrong formula is rarely one token;",
    "- quote the replaced text EXACTLY as it appears in the file, uniquely enough that it occurs",
    "  only once in that file (include surrounding characters if needed);",
    /* WHY THE PROMPT SAYS THIS OUT LOUD (2026-08-15, the deferred witness). The ask used to require a
       witness test per bug, and that requirement was doing a second job nobody wrote down: it kept
       the generator away from changes nothing could ever observe. Removing the ask without saying
       why would drop that job silently, so the requirement stays and only the ARTEFACT goes - the
       model must still be able to name a test that would catch it, and simply does not have to write
       one for a bug the suite is about to catch on its own. */
    "- be OBSERVABLE: a test could tell the bugged code from the real code by calling the module's",
    "  public API and looking at what comes back. A change no caller can observe measures nothing.",
    "",
    ...files,
    "",
    "Reply with ONE JSON object and nothing else:",
    "{",
    '  "bugs": [',
    "    {",
    '      "file": "<repo-relative path>",',
    '      "originalText": "<exact source text to replace>",',
    '      "replacement": "<the buggy text>",',
    /* THE TYPE, ASKED FOR RATHER THAN INFERRED (Kenneth, 2026-08-15). It is shown to the customer
       beside the finding, so the ask is for a category and not a sentence: `note` already carries
       the sentence directly below it, and a "type" that runs to a clause is a second description
       wearing a label. The examples are the shape asked for, never a closed list - a generator held
       to eight words would file every real mistake under the nearest one. */
    /* THE EXAMPLES MOVED WITH THE ASK, /11. Four of the six named here were classic-expressible
       categories - a `type` list is read as the menu whatever the rules above say, so leaving them
       would have re-offered by example exactly what the exclusion rule forbids by name. */
    '      "type": "<two or three words naming the category of mistake, lower case:',
    "               e.g. unit confusion, argument swap, wrong denominator, unawaited write,",
    '               swallowed error, stale fallback, wrong order, missed clamp>",',
    '      "note": "<one line: what mistake this simulates>"',
    "    }",
    "  ]",
    "}",
    ...placementBlock(input.targets),
    ...aimBlock(input.targets),
    /* THE READING ORDER, AND IT IS THE ORDER THESE ARE APPENDED IN. Placement decides where a bug
       is ALLOWED, aim decides where it is most VALUABLE, exclusion decides what KIND is worth
       paying for, and the domain block is the material all three are spent on. Each block says in
       its own text that it relaxes nothing above it, so a model cannot resolve the tension by
       dropping the rule it read first. */
    ...exclusionBlock({
      operators: input.classicOperators ?? [],
      planted: input.targets.map((target) => ({ file: target.file, mutants: target.classicPlanted ?? [] }))
    }),
    ...domainBlock(
      input.targets.flatMap(
        (target) => target.domain === void 0 || isEmptyDomainContext(target.domain) ? [] : [{ file: target.file, domain: target.domain }]
      )
    )
  ].join("\n");
}
var BUG_POOL_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "originalText", "replacement", "type", "note"],
        properties: {
          file: { type: "string", description: "repo-relative path, exactly as listed above" },
          originalText: { type: "string", description: "exact source text to replace, non-empty" },
          replacement: { type: "string", description: "the buggy text, different from originalText" },
          type: { type: ["string", "null"], description: "two or three words naming the category of mistake" },
          note: { type: ["string", "null"], description: "one line: what mistake this simulates" }
        }
      }
    }
  }
};
function buildWitnessPrompt(input) {
  const truncated = input.target.source.length > MAX_PROMPT_FILE_CHARS;
  const source = truncated ? input.target.source.slice(0, MAX_PROMPT_FILE_CHARS) : input.target.source;
  const example = input.exampleTest === void 0 ? [] : [
    "An existing test from this repository, for its conventions:",
    `### ${input.exampleTest.path}`,
    "```",
    input.exampleTest.source,
    "```",
    ""
  ];
  return [
    "You are writing ONE WITNESS TEST for a bug that has already been planted and measured.",
    "",
    "The test must PASS on the current source and FAIL, on an assertion, once the bug below is",
    "applied. It is the demonstration that this bug is real; it is not a search for another one.",
    "",
    `### the file: ${input.target.file}${truncated ? " (truncated)" : ""}`,
    `your test goes at: ${input.target.witnessFile}`,
    `import the file under test as: ${input.target.importSpecifier}`,
    ...moduleBlock(input.target),
    "```",
    source,
    "```",
    "",
    "### the bug this test must catch",
    "this exact text in the file above:",
    "```",
    input.bug.originalText,
    "```",
    "becomes:",
    "```",
    input.bug.replacement,
    "```",
    ...input.bug.bugType === void 0 ? [] : [`the category of mistake: ${input.bug.bugType}`],
    ...input.bug.note === void 0 ? [] : [`what it simulates: ${input.bug.note}`],
    "",
    "Rules for the test:",
    `- it runs under ${input.runner} in a ${input.moduleFormat} project;`,
    "- use the import specifier stated above verbatim, never a path of your own, and never read",
    "  source files as text;",
    /* THE PUBLIC-API RULE (Kenneth, 2026-08-14, from the acceptance run's forensic read), carried
       here unchanged. 6 of 18 witnesses on that run built a fake of the host object - a hand-rolled
       plugin factory - and drove the target through it. Those witnesses prove something about the
       fake, they read as foreign in repositories that never write that style, and a maintainer
       cannot merge one. It moves with the witness ask because it is a rule about the witness. */
    "- drive the target through its PUBLIC API, exactly as the example test does. Never construct a",
    "  fake, stub or mock of the module under test or of the object that hosts it: build the real",
    "  thing the way the repository's own tests build it, call it, and assert on what comes back;",
    /* THE IMPORT RULE (D3 of the official benchmark, 2026-08-15), likewise carried with the ask.
       WIDENED THE SAME DAY by Kenneth's fix-forward ruling, after the `/5` form of it - "never an
       import you have not been shown" over a list of the most-imported modules - cost the pinned
       planter its whole pool on four of ten corpus items. The anti-invention half is untouched and
       is now the second line: it always was a rule about NAMES on a module, and it stays exactly
       that. What is added is the two classes the list could never enumerate. */
    "- you may import: any source file OF THIS REPOSITORY, by its path relative to your test file -",
    "  including a sibling module the target needs, whether or not it is listed above; the packages",
    "  named above as ones this repository's own tests import; and the test framework itself plus",
    "  the language's own built-ins. Import nothing else - no package that is not named above.",
    "- from any module listed above, use ONLY the names it is shown to export. Never a name you have",
    "  not been shown on it: an export that does not exist fails at import and proves nothing.",
    "",
    ...example,
    /*
     * THE DIAGNOSIS, /9. Five bounded fields beside the test, and this is the only call in the
     * pipeline positioned to write them: it runs AFTER the suite has spoken and only for a bug the
     * suite missed, so it is explaining an event that has happened rather than predicting one. The
     * planting call cannot do this - it runs before the suite and would grade bugs that get thrown
     * away.
     *
     * WHAT IT MAY NOT SAY is the load-bearing half, and each prohibition answers a specific way
     * this goes wrong:
     *
     *   NO TEST NAMES. This call is given the file and the bug, and at most ONE example test. It is
     *   never handed the suite's test list, so "the test in refunds.window.test.ts would have to
     *   change" is a name it invented. The mechanical lane's triage IS given the covering-test
     *   identities and keeps that sentence; this one cannot have it.
     *
     *   NO RATES. "Roughly 3% of users", "called 400 times a minute" - nothing behind this call can
     *   back a number about the customer's traffic. Reach is judged from the CONDITION, which is
     *   readable: a branch behind a non-default locale reaches fewer inputs than one on the default
     *   path. That is Kenneth's distinction and it is the whole boundary.
     *
     *   NO INVENTED PRODUCT. The call sees the file, not the customer's screens. "A customer who
     *   opens a refund" is grounded in what the function decides; a button, a page or a journey is
     *   not.
     */
    /*
     * THE ACCOUNT, /10, and the reason this ask grew rather than gained a call.
     *
     * Kenneth's ruling of 2026-08-18, carried over from the mechanical lane's prompts p10 and p11.
     * The section a reader opens first on a finding is "About this bug", and on this lane it held ONE
     * sentence: `consequence`. Everything else a person needs in order to decide whether to care was
     * in a one-line title, in a diff, or nowhere. The mechanical lane fixed that by asking the model
     * already reading the code for three answers in the reply it was already sending; this asks the
     * same three of the call that WROTE the bug, so one finding reads the same on either lane.
     *
     * THE ONE-SENTENCE FIELDS STAY, deliberately, on exactly the mechanical lane's argument: the
     * account is one long field behind an all-or-nothing guard, so keeping `consequence` costs a few
     * output tokens and makes the worst case the section a /9 run would have shown rather than none.
     *
     * TWO RUBRIC CHANGES ARRIVE WITH IT, both so the lanes grade and describe on ONE scale:
     *
     *   THE MONEY FLOOR, prompt p11's, word for word. A repeat pass over nine real mechanical gaps
     *   found the checkout-boundary gap grading `low` on one of three passes, with a basis that said
     *   a silently incorrect total was possible "but only for the single cutoff value" - narrow reach
     *   pulling the worst break under the middle. A witness call grading the same shape of bug must
     *   not be free to do what the mechanical lane is now forbidden.
     *
     *   PARAGRAPH TWO MAY BE ONE SENTENCE on a pure library, measured on three real p10 samples over
     *   a pricing module with no HTTP layer, no UI and no caller in the context: all three wrote
     *   "a caller invokes the exported function" and padded it to paragraph length. The honesty
     *   clause it hangs off is untouched.
     */
    "Then diagnose the bug you have just demonstrated. Six fields, and the limits on them",
    "matter more than the fields do:",
    "",
    "- BEHAVIOUR: is the behaviour this bug breaks one the code PROMISES - a rule it exists to",
    "  enforce, a value a caller relies on - or is it INCIDENTAL, an accident of implementation",
    '  nobody owes? Answer "unclear" when the file does not settle it. Incidental bugs are dropped',
    '  and never shown, so do not reach for "promised" to keep one alive.',
    "- HOW IT IS MET: one sentence saying how somebody actually encounters this bug. If the code is",
    "  user-facing, the action a user takes and what they get instead. If it is backend-facing, what",
    "  calls it and what your system then does with the wrong answer. Ground it in what THIS FILE",
    "  shows - never a screen, a button or a user journey you were not given.",
    "- WHY UNNOTICED: why the suite did not fail. Name the concrete input that separates the two",
    "  versions and the observable output that differs, then say what kind of assertion is missing.",
    "  YOU HAVE NOT BEEN SHOWN THE SUITE: never name a test file or a test, and never guess what any",
    "  test asserts.",
    "- CONSEQUENCE: one sentence on what a reader should worry about if this stays untested. Do not",
    "  restate the other fields.",
    "- SEVERITY: critical, high, medium or low, judged on what breaks and how widely it can be",
    "  reached. Worse: money, permissions, data written or deleted, something sent onwards; a wrong",
    "  value returned silently rather than an error that announces itself; an effect that escapes the",
    "  function. Milder: formatting, logging, a display string; a throw; a pure return the caller",
    "  checks. Reach is read off the CONDITION - the default path reaches more than a rare guard, a",
    "  whole range more than one boundary value. THE ONE FLOOR: a monetary amount that comes back",
    "  wrong with no error raised is never below medium, however narrow the inputs that reach it -",
    "  reach may hold a money break at medium, never under it. NEVER state a rate, a percentage, a",
    "  traffic figure or any claim about the customer's business. If the file does not tell you what",
    '  the code affects, answer "medium" and say so in the basis.',
    "- ABOUT: the full account of this bug, in EXACTLY THREE PARAGRAPHS separated by a blank line,",
    "  800 characters in total at the very most. Write to the engineer who owns this code.",
    "  PARAGRAPH 1 - WHAT IT IS: what this code is responsible for, and which part of that",
    "  responsibility this bug breaks. Say more than the one-line fields above, never the same words.",
    "  PARAGRAPH 2 - HOW IT WOULD BE ENCOUNTERED: decide from the file you were shown which kind of",
    "  code this is, and describe the route that fits it. If a person can reach it, say what they",
    "  would be doing and what they would see. If only another system can reach it - a job, a queue",
    "  message, a scheduled task, a call from elsewhere in the codebase - say which system, what",
    "  arrives, and what it does next with the result. LEAD WITH THE ROUTE, never with what you",
    "  cannot see. WHEN THE FILE SHOWS NO ENTRY POINT AT ALL - no screen, no job, no caller, nothing",
    "  but exported functions another program would import - this paragraph may be ONE sentence",
    "  naming that fact and the call it does support, and you should prefer that to padding it out.",
    "  Never stretch a route you cannot see into a paragraph, and never invent a screen, a customer",
    "  or a product this file does not show you.",
    "  PARAGRAPH 3 - WHAT HAPPENS IF IT SHIPS: the concrete wrong outcome that escapes this code - a",
    "  wrong value returned or stored, an action allowed that should have been refused, something",
    "  sent onwards, work silently skipped - and who or what is holding the wrong thing afterwards.",
    "  NEVER state a rate, a percentage, a traffic figure, a monetary amount, or any claim about the",
    "  customer's business, and never name a test or say anything about how this bug was found.",
    /* THE PLAIN-PROSE CLAUSE, and it is not decoration - it is the difference between an account
       that renders and one that is dropped whole. MEASURED on 15 real witness calls over 5 real
       planted bugs: without it, 4 of the 15 accounts named the function in backticks inside
       paragraph two - the one paragraph this ask invites to describe a call - and
       `sanitizeFindingAbout` refused all four, all-or-nothing, leaving the section on the single
       sentence. The mechanical lane's spec has carried this clause since p10; the witness ask needs
       it MORE, because this call is shown the file and the exact changed text and the other lane's
       classifier is not. */
    "  PLAIN PROSE ONLY, in all three paragraphs: never quote source, an identifier, a string",
    "  literal, a function name or any code syntax. Name what the code does, not what it is called.",
    "",
    "Reply with ONE JSON object and nothing else:",
    "{",
    '  "witnessTestName": "<the test name, exactly as it appears in the test body>",',
    '  "witnessTestBody": "<the complete test file>",',
    '  "behaviour": "promised|incidental|unclear",',
    '  "behaviourReason": "<ONE sentence: how somebody meets this bug>",',
    '  "whyUnnoticed": "<up to 120 words: why the existing tests do not fail>",',
    '  "consequence": "<ONE sentence: what to worry about if this stays untested>",',
    '  "severity": "critical|high|medium|low",',
    '  "severityBasis": "<ONE sentence: what breaks, and how widely it can be reached>",',
    '  "about": "<three paragraphs, a blank line between them, 800 characters at the very most>"',
    "}"
  ].join("\n");
}
var BUG_WITNESS_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  /* Strict mode requires every declared property in `required`. The five diagnosis fields are
     declared NULLABLE rather than left out, which is strict mode's way of saying optional: a
     witness that proves its bug and writes no diagnosis is still a witness, and the surfaces render
     nothing rather than a guess. Only the test itself is structurally required. */
  required: [
    "witnessTestName",
    "witnessTestBody",
    "behaviour",
    "behaviourReason",
    "whyUnnoticed",
    "consequence",
    "severity",
    "severityBasis",
    "about"
  ],
  properties: {
    witnessTestName: { type: "string", description: "the test name, exactly as it appears in the body" },
    witnessTestBody: { type: "string", description: "the complete test file" },
    behaviour: {
      type: ["string", "null"],
      enum: ["promised", "incidental", "unclear", null],
      description: "is the broken behaviour promised by the code, incidental, or unclear"
    },
    behaviourReason: { type: ["string", "null"], description: "one sentence: how somebody meets this bug" },
    whyUnnoticed: { type: ["string", "null"], description: "up to 120 words: why the existing tests do not fail" },
    consequence: { type: ["string", "null"], description: "one sentence: what to worry about if this stays untested" },
    severity: {
      type: ["string", "null"],
      enum: ["critical", "high", "medium", "low", null],
      description: "graded on what breaks and how widely it can be reached"
    },
    severityBasis: { type: ["string", "null"], description: "one sentence: what breaks, and how widely" },
    about: {
      type: ["string", "null"],
      description: "three paragraphs, blank line between them: what it is, how it is met, what ships wrong"
    }
  }
};
var BUG_REFUSAL_REASONS = [
  "unknown-file",
  "empty-original-text",
  "replacement-identical",
  /* The witness ask's own refusal, and since 2026-08-15 it belongs to the SECOND call: planting no
     longer asks for a witness, so this names a survivor whose witness-only call came back with
     nothing usable rather than a planting reply missing a field. */
  "no-witness",
  /* THE PLACEMENT RULE, ENFORCED RATHER THAN REQUESTED. The prompt states it and the A/B says the
     model obeys it 207 times out of 207, but a rule only the prompt holds is a rule the next model
     revision can drop silently - and a bug off the change measures code this commit did not touch
     while being reported as "written against this change". */
  "off-diff",
  /* Placement cannot be checked on text that is not in the file exactly once, and neither can the
     bug be applied later: `locateBug` refuses the same text with `text-not-found` or
     `ambiguous-text`. Refusing at generation names it where it happened instead of carrying a bug
     that was never plantable through the whole pool. */
  "unlocatable-text"
];
async function generateBugPool(input) {
  const maxBugs = input.maxBugs;
  if (!Number.isInteger(maxBugs) || maxBugs < 1) {
    throw new Error("agent bug pool maxBugs must be an integer >= 1 (there is no default)");
  }
  const known = new Map(input.targets.map((target) => [target.file, target]));
  let prompt = buildBugPoolPrompt({
    targets: input.targets,
    maxBugs,
    ...input.classicOperators === void 0 ? {} : { classicOperators: input.classicOperators }
  });
  let modelCalls = 0;
  let lastFailure;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await input.client.call({
      task: BUG_POOL_TASK,
      pin: input.pin,
      prompt,
      jsonSchema: { name: "abloh_bug_pool", schema: BUG_POOL_REPLY_SCHEMA },
      /* THE PER-CALL CEILING, AS THE LOOP ALREADY DERIVES IT. Until 2026-08-15 this call passed no
         `gapCount`, so `batchCompletionCeiling` stayed flat at the pin's 32,000 tokens however many
         bugs were asked for - and with the derived deadline scaling off that same ceiling, a large
         ask bought itself no more room to answer in. The sizing law makes the ask variable, so the
         ceiling has to move with it. */
      gapCount: maxBugs,
      signal: input.signal
    });
    modelCalls += 1;
    if (!result.ok) {
      lastFailure = result.failure;
      const noRetry = ["authentication", "rate-limit", "truncated", "context-window", "budget", "request-not-sent"];
      if (noRetry.includes(result.failure.kind)) break;
      prompt = `${prompt}

The previous attempt failed with: ${result.failure.detail}`;
      continue;
    }
    const parsed = parseBugPoolReply(result.text);
    if (!parsed.ok) {
      lastFailure = { kind: "unparseable", detail: boundEvidence(`${parsed.reason}
${result.text}`) };
      prompt = [
        prompt,
        "",
        "Your previous reply could not be read:",
        parsed.reason,
        "Reply again with ONE JSON object matching the shape above and nothing else."
      ].join("\n");
      continue;
    }
    const bugs = [];
    const refused = [];
    for (const entry of parsed.bugs.slice(0, maxBugs)) {
      const file = typeof entry.file === "string" ? entry.file : "";
      const target = known.get(file);
      if (target === void 0) {
        refused.push({ reason: "unknown-file", file });
        continue;
      }
      const originalText = typeof entry.originalText === "string" ? entry.originalText : "";
      const replacement = typeof entry.replacement === "string" ? entry.replacement : "";
      if (originalText === "") {
        refused.push({ reason: "empty-original-text", file });
        continue;
      }
      if (originalText === replacement) {
        refused.push({ reason: "replacement-identical", file });
        continue;
      }
      const placement = placementOf(target, originalText);
      if (placement !== "on-diff") {
        refused.push({ reason: placement, file });
        continue;
      }
      const bugType = acceptBugType(entry.type);
      bugs.push({
        /* THE TYPE IS NOT IN THE IDENTITY, and the rule saying so lives with the function: the
           control plane uses this same digest as the checksum over the change text a sidecar
           supplies, so the two sides compute one function or the check is not one. */
        bugId: bugIdentity({ file, originalText, replacement }),
        file,
        originalText,
        replacement,
        ...bugType === void 0 ? {} : { bugType },
        ...typeof entry.note === "string" && entry.note !== "" ? { note: boundEvidence(entry.note, 300) } : {}
        /* NO WITNESS HERE, AND THAT IS THE ARCHITECTURE. It is written after the suite has spoken and
           only for a bug the suite missed - `generateWitness` below. */
      });
    }
    return { bugs, refused, modelCalls };
  }
  return { bugs: [], refused: [], modelCalls, failure: lastFailure };
}
function placementOf(target, originalText) {
  if (target.changedRanges.length === 0) return "on-diff";
  const first = target.source.indexOf(originalText);
  if (first === -1) return "unlocatable-text";
  if (target.source.indexOf(originalText, first + 1) !== -1) return "unlocatable-text";
  const startLine = target.source.slice(0, first).split("\n").length;
  const endLine = target.source.slice(0, first + originalText.length).split("\n").length;
  return overlapsAnyRange(startLine, endLine, target.changedRanges) ? "on-diff" : "off-diff";
}
function parseBugPoolReply(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/u.exec(text);
  const unfenced = (fenced === null ? text : fenced[1]).trim();
  let value;
  try {
    value = JSON.parse(unfenced);
  } catch (error) {
    return { ok: false, reason: `the reply was not JSON: ${error instanceof Error ? error.message : "parse error"}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "the reply was not a JSON object" };
  }
  const bugs = value.bugs;
  if (!Array.isArray(bugs)) return { ok: false, reason: "the reply carried no `bugs` array" };
  return {
    ok: true,
    bugs: bugs.filter((entry) => typeof entry === "object" && entry !== null)
  };
}
var acceptSentence = acceptBugSentence;
function acceptBugDiagnosis(entry) {
  const behaviour = acceptBugBehaviour(entry.behaviour);
  const severity = acceptBugSeverity(entry.severity);
  const behaviourReason = acceptSentence(entry.behaviourReason, MAX_BUG_SENTENCE_LEN);
  const whyUnnoticed = acceptSentence(entry.whyUnnoticed, MAX_BUG_RATIONALE_LEN);
  const consequence = acceptSentence(entry.consequence, MAX_BUG_SENTENCE_LEN);
  const severityBasis = acceptSentence(entry.severityBasis, MAX_BUG_SENTENCE_LEN);
  const about = sanitizeFindingAbout(entry.about) ?? void 0;
  const diagnosis = {
    ...behaviour === void 0 ? {} : { behaviour },
    ...behaviourReason === void 0 ? {} : { behaviourReason },
    ...whyUnnoticed === void 0 ? {} : { whyUnnoticed },
    ...consequence === void 0 ? {} : { consequence },
    ...severity === void 0 ? {} : { severity },
    ...severityBasis === void 0 ? {} : { severityBasis },
    ...about === void 0 ? {} : { about }
  };
  return Object.keys(diagnosis).length === 0 ? void 0 : diagnosis;
}
function parseWitnessReply(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/u.exec(text);
  const unfenced = (fenced === null ? text : fenced[1]).trim();
  let value;
  try {
    value = JSON.parse(unfenced);
  } catch (error) {
    return { ok: false, reason: `the reply was not JSON: ${error instanceof Error ? error.message : "parse error"}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "the reply was not a JSON object" };
  }
  const entry = value;
  const testName = typeof entry.witnessTestName === "string" ? entry.witnessTestName.trim() : "";
  const testBody = typeof entry.witnessTestBody === "string" ? entry.witnessTestBody : "";
  if (testName === "" || testBody.trim() === "") {
    return { ok: false, reason: "the reply carried no `witnessTestName` and `witnessTestBody`" };
  }
  const diagnosis = acceptBugDiagnosis(value);
  return { ok: true, testName, testBody, ...diagnosis === void 0 ? {} : { diagnosis } };
}
async function generateWitness(input) {
  let prompt = buildWitnessPrompt({
    target: input.target,
    bug: input.bug,
    runner: input.runner,
    moduleFormat: input.moduleFormat,
    ...input.exampleTest === void 0 ? {} : { exampleTest: input.exampleTest }
  });
  let modelCalls = 0;
  let lastFailure;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await input.client.call({
      task: BUG_WITNESS_TASK,
      pin: input.pin,
      prompt,
      jsonSchema: { name: "abloh_bug_witness", schema: BUG_WITNESS_REPLY_SCHEMA },
      /* ONE WITNESS, so the per-call ceiling is the pin's one-gap ceiling and the derived deadline
         scales to it. Passing the pool's ask here would buy a one-test call eight tests' worth of
         wall clock. */
      gapCount: 1,
      signal: input.signal
    });
    modelCalls += 1;
    if (!result.ok) {
      lastFailure = result.failure;
      const noRetry = ["authentication", "rate-limit", "truncated", "context-window", "budget", "request-not-sent"];
      if (noRetry.includes(result.failure.kind)) break;
      prompt = `${prompt}

The previous attempt failed with: ${result.failure.detail}`;
      continue;
    }
    const parsed = parseWitnessReply(result.text);
    if (!parsed.ok) {
      lastFailure = { kind: "unparseable", detail: boundEvidence(`${parsed.reason}
${result.text}`) };
      prompt = [
        prompt,
        "",
        "Your previous reply could not be read:",
        parsed.reason,
        "Reply again with ONE JSON object matching the shape above and nothing else."
      ].join("\n");
      continue;
    }
    return {
      witness: { testName: parsed.testName, testBody: parsed.testBody },
      ...parsed.diagnosis === void 0 ? {} : { diagnosis: parsed.diagnosis },
      modelCalls
    };
  }
  return { refused: "no-witness", modelCalls, ...lastFailure === void 0 ? {} : { failure: lastFailure } };
}

// src/pool2/pool.ts
import { existsSync as existsSync12, readFileSync as readFileSync13 } from "fs";
import { join as join14 } from "path";

// src/pool2/evidence.ts
import { POOL2_EVIDENCE_SCHEMA } from "@abloh/core";
import { POOL2_EVIDENCE_SCHEMA as POOL2_EVIDENCE_SCHEMA2 } from "@abloh/core";
var MAX_POOL2_HOLD_EVIDENCE_CHARS = 1200;
function pool2EvidenceDigest(text) {
  return sha256(text);
}
function buildPool2Evidence(input) {
  const entries = [];
  for (const result of input.results) {
    const witness = result.witness ?? result.bug.witness;
    const diagnosis = result.diagnosis ?? result.bug.diagnosis;
    entries.push({
      bugId: result.bug.bugId,
      route: result.route,
      originalText: result.bug.originalText,
      replacement: result.bug.replacement,
      ...result.bug.note === void 0 ? {} : { description: result.bug.note },
      ...result.bug.bugType === void 0 ? {} : { bugType: result.bug.bugType },
      ...diagnosis === void 0 ? {} : { diagnosis },
      ...result.holdReason === void 0 ? {} : { holdReason: result.holdReason },
      ...result.evidence === void 0 ? {} : { evidence: boundEvidence(result.evidence, MAX_POOL2_HOLD_EVIDENCE_CHARS) },
      ...result.witnessFile === void 0 || witness === void 0 ? {} : {
        witness: {
          testFile: result.witnessFile,
          testName: witness.testName,
          testBody: witness.testBody
        }
      }
    });
  }
  return { schema: POOL2_EVIDENCE_SCHEMA2, sha: input.sha, entries };
}
function serializePool2Evidence(evidence) {
  return `${JSON.stringify(evidence, null, 2)}
`;
}

// src/pool2/pool.ts
var AGENT_BUG_MUTATOR = "AgentBug";
var BUG_ROUTES = [
  "unplaceable",
  "witness-refused",
  "suite-killed",
  "suite-survived",
  "not-executed"
];
var BUG_HOLD_REASONS = [
  "file-absent",
  "text-not-found",
  "ambiguous-text",
  "witness-not-passing",
  /* The witness did not pass candidate admission - the same mechanical organ every ordinary
     candidate faces (`admission.ts`). A witness that reads its target's source as text, replaces the
     module under test, or compiles a string can pass on the real source and fail on the bug while
     knowing nothing about behaviour, so it would prove a non-behavioural bug. Refused BEFORE the two
     executions, so a witness of that shape costs nothing and is never stored. */
  "witness-not-admitted",
  /* The witness never reached the runner: the project's own test command exited non-zero with no
     test report, which is the shape of a lint, format, typecheck or build stage chained in front of
     it. Separate from `witness-not-passing` because the two need opposite responses - one is a bad
     witness, the other is a repository that must declare `environment.sealedTestCommand`. */
  "witness-gate-failed",
  "witness-not-executed",
  "witness-not-failing-on-bug",
  "witness-errored",
  /* The witness-only call came back with nothing usable, or with a failure a second ask cannot fix.
     Under the deferred witness this reaches a SURVIVOR: the suite has already spoken, and what is
     missing is the demonstration, so the gap is held rather than reported. */
  "no-witness",
  /* There was no endpoint to write this survivor's witness with. Distinct from `no-witness`, which
     is a model that answered badly: this is a replay-only run - a pinned or content-replayed pool
     with no client - meeting a survivor whose witness was never stored. The suite verdict is real;
     the demonstration cannot be obtained, so the gap is not reported. */
  "witness-unavailable",
  "suite-run-failed",
  /* Both sides ran and neither could say what failed. The bugged run was red, the same run without
     the patch was red too, and no report named or counted its failing tests - so nothing here can
     tell a catch from a suite that was already broken. Held out of BOTH the killed numerator and the
     measured denominator, because a verdict that cannot be attributed is not a verdict. */
  "verdict-unattributable",
  /* C2 removed this bug's suite execution. It stays witness-proven and is never reported as a
     survivor - an unmeasured bug is not a gap. */
  "predicted-killed"
];
function locateBug(repoDir, bug) {
  const absolute = join14(repoDir, bug.file);
  if (!existsSync12(absolute)) return { ok: false, reason: "file-absent" };
  const source = readFileSync13(absolute, "utf8");
  const first = source.indexOf(bug.originalText);
  if (first === -1) return { ok: false, reason: "text-not-found" };
  if (source.indexOf(bug.originalText, first + 1) !== -1) return { ok: false, reason: "ambiguous-text" };
  const before = source.slice(0, first);
  const startLine = before.split("\n").length;
  const startColumn = first - (before.lastIndexOf("\n") + 1) + 1;
  const end = first + bug.originalText.length;
  const beforeEnd = source.slice(0, end);
  const endLine = beforeEnd.split("\n").length;
  const endColumn = end - (beforeEnd.lastIndexOf("\n") + 1) + 1;
  return {
    ok: true,
    gap: {
      gapId: gapIdentity({
        file: bug.file,
        startLine,
        startColumn,
        endLine,
        endColumn,
        mutator: AGENT_BUG_MUTATOR,
        replacement: bug.replacement
      }),
      spanKey: spanIdentity({ file: bug.file, startLine, startColumn, endLine, endColumn }),
      mutantId: `agent-bug:${bug.file}:${startLine}`,
      file: bug.file,
      startLine,
      endLine,
      startColumn,
      endColumn,
      mutator: AGENT_BUG_MUTATOR,
      replacement: bug.replacement,
      originalText: bug.originalText,
      coveredBy: 0
    }
  };
}
async function proveWitness(input) {
  const placement = placeCandidate({
    testFilePaths: input.testFilePaths,
    targetFile: input.bug.file,
    discriminator: input.bug.bugId.slice(0, 8)
  });
  const files = [{ path: placement.testFile, source: input.witness.testBody }];
  const admission = admitCandidate({
    testFile: placement.testFile,
    testSource: input.witness.testBody,
    targetFile: input.bug.file,
    ...input.allowedBareImports === void 0 ? {} : { allowedBareImports: input.allowedBareImports }
  });
  if (!admission.admitted) {
    return {
      proven: false,
      reason: "witness-not-admitted",
      executions: 0,
      witnessFile: placement.testFile,
      evidence: boundEvidence(
        admission.findings.map((finding) => `${finding.rule}: ${finding.detail}`).join("\n")
      )
    };
  }
  const real = await input.runner.execute({
    files,
    patches: [],
    mode: "targeted",
    testFile: placement.testFile,
    testName: input.witness.testName,
    timeoutMs: input.timeoutMs
  });
  if (real.error !== void 0) {
    return { proven: false, reason: "witness-errored", executions: 1, witnessFile: placement.testFile, evidence: boundEvidence(real.output) };
  }
  if (real.report.executed === false) {
    return { proven: false, reason: "witness-not-executed", executions: 1, witnessFile: placement.testFile, evidence: boundEvidence(real.output) };
  }
  if (!real.report.passed) {
    return {
      proven: false,
      reason: real.gateShapedFailure === true ? "witness-gate-failed" : "witness-not-passing",
      executions: 1,
      witnessFile: placement.testFile,
      evidence: boundEvidence(real.output)
    };
  }
  const bugged = await input.runner.execute({
    files,
    patches: [input.gap],
    mode: "targeted",
    testFile: placement.testFile,
    testName: input.witness.testName,
    timeoutMs: input.timeoutMs
  });
  if (bugged.error !== void 0) {
    return { proven: false, reason: "witness-errored", executions: 2, witnessFile: placement.testFile, evidence: boundEvidence(bugged.output) };
  }
  if (bugged.report.passed) {
    return { proven: false, reason: "witness-not-failing-on-bug", executions: 2, witnessFile: placement.testFile, evidence: boundEvidence(bugged.output) };
  }
  if (!bugged.report.failedAssertion) {
    return { proven: false, reason: "witness-errored", executions: 2, witnessFile: placement.testFile, evidence: boundEvidence(bugged.output) };
  }
  return { proven: true, executions: 2, witnessFile: placement.testFile };
}
var SUITE_VERDICT_SOURCES = ["covering-tests", "whole-suite"];
function measureBugBaselines(input) {
  const pending = /* @__PURE__ */ new Map();
  const charged = /* @__PURE__ */ new Set();
  return {
    async measure(request) {
      const key = request.mode === "suite" ? "suite" : `targeted:${request.testFile}`;
      let measuring = pending.get(key);
      if (measuring === void 0) {
        measuring = (async () => {
          const run = await input.runner.execute({
            files: [],
            patches: [],
            ...request.mode === "suite" ? { mode: "suite", timeoutMs: input.suiteTimeoutMs } : {
              mode: "targeted",
              testFile: request.testFile,
              timeoutMs: input.targetedTimeoutMs
            }
          });
          return {
            green: run.error === void 0 && run.report.passed,
            failed: run.report.failed,
            failures: run.report.failures,
            ...run.error === void 0 ? {} : { error: run.error },
            report: boundEvidence(run.output)
          };
        })();
        pending.set(key, measuring);
      }
      const measured = await measuring;
      const executions = charged.has(key) ? 0 : 1;
      charged.add(key);
      return { ...measured, executions };
    }
  };
}
function coveringFilesFor(input) {
  if (input.coverage === void 0) return null;
  const files = input.coverage.coveringFiles(input.gap.file, input.gap.startLine, input.gap.endLine);
  if (files === null) return null;
  const observed = new Set(input.testFilePaths);
  if (!files.every((file) => observed.has(file))) return null;
  if (files.length >= input.testFilePaths.length) return null;
  return files;
}
async function measureBug(input) {
  let executions = 0;
  const covering = coveringFilesFor({
    coverage: input.coverage,
    gap: input.gap,
    testFilePaths: input.testFilePaths
  });
  if (covering !== null) {
    for (const testFile of covering) {
      const selective = await input.runner.execute({
        files: [],
        patches: [input.gap],
        mode: "targeted",
        testFile,
        timeoutMs: input.targetedTimeoutMs
      });
      executions += 1;
      if (selective.error !== void 0 || selective.timedOut === true || selective.gateShapedFailure === true) break;
      if (!selective.report.passed) {
        const baseline2 = await input.baselines.measure({ mode: "targeted", testFile });
        executions += baseline2.executions;
        const delta2 = suiteDelta(baseline2, selective);
        if (delta2.regressed) return { outcome: "killed", executions, verdictBy: "covering-tests" };
        if (delta2.basis === "unattributable") {
          return {
            outcome: "unattributable",
            executions,
            verdictBy: "covering-tests",
            evidence: boundEvidence(selective.output)
          };
        }
      }
    }
  }
  const suite = await input.runner.execute({
    files: [],
    patches: [input.gap],
    mode: "suite",
    timeoutMs: input.suiteTimeoutMs
  });
  executions += 1;
  if (suite.error !== void 0 || suite.timedOut === true) {
    return { outcome: "failed", executions, verdictBy: "whole-suite", evidence: boundEvidence(suite.output) };
  }
  if (suite.report.passed) return { outcome: "survived", executions, verdictBy: "whole-suite" };
  const baseline = await input.baselines.measure({ mode: "suite" });
  executions += baseline.executions;
  const delta = suiteDelta(baseline, suite);
  if (delta.regressed) return { outcome: "killed", executions, verdictBy: "whole-suite" };
  if (delta.basis === "unattributable") {
    return {
      outcome: "unattributable",
      executions,
      verdictBy: "whole-suite",
      evidence: boundEvidence(suite.output)
    };
  }
  return { outcome: "survived", executions, verdictBy: "whole-suite" };
}
function untestedLineVerdicts(targets, results) {
  const rangesByFile = /* @__PURE__ */ new Map();
  for (const target of targets) {
    if (target.uncoveredRanges === void 0 || target.uncoveredRanges.length === 0) continue;
    rangesByFile.set(target.file, [...rangesByFile.get(target.file) ?? [], ...target.uncoveredRanges]);
  }
  const counted = { planted: 0, suiteKilled: 0, suiteSurvived: 0 };
  if (rangesByFile.size === 0) return counted;
  for (const result of results) {
    const ranges = rangesByFile.get(result.bug.file);
    if (ranges === void 0 || result.gap === void 0) continue;
    if (!overlapsAnyRange(result.gap.startLine, result.gap.endLine, ranges)) continue;
    counted.planted += 1;
    if (result.route === "suite-killed") counted.suiteKilled += 1;
    if (result.route === "suite-survived") counted.suiteSurvived += 1;
  }
  return counted;
}
async function runAgentBugPool(input) {
  validateAgentBugPoolPolicy(input.policy);
  const plan = planPoolSizing({ scopes: input.targets, policy: input.policy });
  const store = BugPoolStore.open(input.storeDir, input.repoKey, input.custody);
  let pool = store.lookup(input.sha, BUG_POOL_PROMPT_VERSION, plan.planDigest);
  const pinned = pool !== null;
  let modelCalls = 0;
  let replayed = 0;
  let fileLedger = [];
  const refusedReasons = {};
  if (pool === null) {
    const fundedByPlan = plan.files.filter((file) => file.funded);
    const funded = fundedByPlan.filter((file) => existsSync12(join14(input.repoDir, file.file))).map((file) => {
      const source = readFileSync13(join14(input.repoDir, file.file), "utf8");
      const placement = placeCandidate({
        testFilePaths: input.testFilePaths,
        targetFile: file.file,
        discriminator: "witness"
      });
      const scope = input.targets.find((entry) => entry.file === file.file);
      const aims = nonEmptyAims(scope?.aims);
      const digest = aimDigest(aims);
      const classicPlanted = scope?.classicPlanted ?? [];
      const domain = collectDomainContext({
        repoDir: input.repoDir,
        targetFile: file.file,
        source,
        ...input.domainInvariants === void 0 ? {} : { invariants: input.domainInvariants }
      });
      const catalog = catalogDigest({
        operators: input.classicOperators ?? [],
        planted: classicPlanted,
        domainLines: isEmptyDomainContext(domain) ? [] : domainBlock([{ file: file.file, domain }]),
        digest: structuralDigest2
      });
      return {
        file: file.file,
        source,
        attempts: file.attempts,
        contentDigest: fileContentDigest(source),
        ...digest === void 0 ? {} : { aimDigest: digest },
        ...catalog === void 0 ? {} : { catalogDigest: catalog },
        target: {
          file: file.file,
          source,
          witnessFile: placement.testFile,
          importSpecifier: importSpecifierFor({
            testFile: placement.testFile,
            targetFile: file.file,
            moduleFormat: input.moduleFormat,
            runner: input.runnerName
          }),
          changedRanges: scope?.ranges ?? [],
          ...aims.length === 0 ? {} : { aims },
          /* WHAT ELSE THE WITNESS MAY IMPORT, read off the same disk and told to the model for the
             same reason the witness path is: a fact the model cannot see, that it invents when it
             is not given. Computed here beside the placement so both come from one read of the
             repository rather than from two derivations that can disagree. */
          modules: collectWitnessModules({
            repoDir: input.repoDir,
            targetFile: file.file,
            witnessFile: placement.testFile,
            moduleFormat: input.moduleFormat,
            runner: input.runnerName,
            testFilePaths: input.testFilePaths
          }),
          dependencies: collectWitnessDependencies({
            repoDir: input.repoDir,
            testFilePaths: input.testFilePaths
          }),
          ...classicPlanted.length === 0 ? {} : { classicPlanted },
          ...isEmptyDomainContext(domain) ? {} : { domain }
        }
      };
    });
    const replayedFiles = [];
    const fresh = [];
    for (const file of funded) {
      const lookup = store.lookupByContent({
        contentDigest: file.contentDigest,
        promptVersion: BUG_POOL_PROMPT_VERSION,
        ask: file.attempts,
        /* AND SO IS THE PATH. The bugs an entry holds each name the file they were planted for, so
           an entry found by bytes alone answers a DIFFERENT file with that file's paths - which on
           a composed run handed one package's runner a spec under a sibling package's directory and
           cost that package its whole pool (finding K, 2026-09-02). */
        file: file.file,
        /* THE AIM IS PART OF THE FILE KEY TOO. Unchanged bytes asked with an aim block are a
           different question from unchanged bytes asked without one, and replaying the unaimed
           answer for an aimed ask would report E as having run while delivering the pool it
           replaced. Absent leaves the key exactly what it was. */
        ...file.aimDigest === void 0 ? {} : { aimDigest: file.aimDigest },
        /* AND SO IS THE /11 MATERIAL, for the same argument one line up: an exclusion block or a
           domain block changes what was asked, and neither is visible in the file's own bytes. */
        ...file.catalogDigest === void 0 ? {} : { catalogDigest: file.catalogDigest }
      });
      if (process.env.ABLOH_DEBUG_POOL_PIN === "1") {
        process.stderr.write(
          `[pool-pin] ${file.file} content=${file.contentDigest} ask=${file.attempts} aim=${file.aimDigest ?? "none"} -> ${lookup.state}
`
        );
      }
      if (lookup.state === "replay") replayedFiles.push(lookup.entry);
      else fresh.push(file);
    }
    const unanswered = fundedByPlan.length - replayedFiles.length;
    if (unanswered > 0 && input.client === null) {
      return {
        state: "unavailable",
        reason: "no pinned pool for this commit and no model endpoint to generate one",
        results: [],
        disclosure: null,
        evidenceText: null,
        uploadEvidenceText: null,
        modelCalls: 0,
        attemptsPlanned: plan.attemptsPlanned
      };
    }
    const client = input.client;
    const generations = client === null ? [] : await mapWithConcurrency(
      fresh,
      plan.maxConcurrentGeneration,
      async (file) => generateBugPool({
        targets: [file.target],
        client,
        pin: input.pin,
        maxBugs: file.attempts,
        ...input.classicOperators === void 0 ? {} : { classicOperators: input.classicOperators },
        ...input.signal === void 0 ? {} : { signal: input.signal }
      })
    );
    modelCalls = generations.reduce((total, generation) => total + generation.modelCalls, 0);
    const replayedByFile = new Map(replayedFiles.map((entry) => [entry.file, entry]));
    const onDisk = new Set(funded.map((file) => file.file));
    const generationByFile = new Map(fresh.map((file, index) => [file.file, generations[index]]));
    fileLedger = plan.files.map((planned) => {
      const replay = replayedByFile.get(planned.file);
      if (replay !== void 0) {
        return { file: planned.file, outcome: "replayed", bugs: replay.bugs.length, refused: 0 };
      }
      if (!planned.funded) {
        return { file: planned.file, outcome: "unfunded", bugs: 0, refused: 0 };
      }
      if (!onDisk.has(planned.file)) {
        return { file: planned.file, outcome: "source-unreadable", bugs: 0, refused: 0 };
      }
      const generation = generationByFile.get(planned.file);
      if (generation === void 0) {
        return { file: planned.file, outcome: "source-unreadable", bugs: 0, refused: 0 };
      }
      if (generation.failure !== void 0) {
        return {
          file: planned.file,
          outcome: "generation-failed",
          bugs: 0,
          refused: generation.refused.length,
          reason: generation.failure.kind
        };
      }
      return {
        file: planned.file,
        outcome: "generated",
        bugs: generation.bugs.length,
        refused: generation.refused.length
      };
    });
    for (const generation of generations) {
      for (const entry of generation.refused) {
        refusedReasons[entry.reason] = (refusedReasons[entry.reason] ?? 0) + 1;
      }
    }
    const failed = generations.filter((generation) => generation.failure !== void 0);
    if (failed.length > 0 && failed.length === generations.length && replayedFiles.length === 0) {
      const kinds = {};
      for (const generation of failed) {
        const kind = generation.failure?.kind ?? "unknown";
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      }
      return {
        state: "unavailable",
        reason: `bug generation failed for all ${failed.length} file(s): ` + Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind} x${count}`).join(", "),
        results: [],
        disclosure: null,
        evidenceText: null,
        uploadEvidenceText: null,
        modelCalls,
        attemptsPlanned: plan.attemptsPlanned
      };
    }
    generations.forEach((generation, index) => {
      if (generation.failure !== void 0) return;
      store.recordByContent({
        contentDigest: fresh[index].contentDigest,
        promptVersion: BUG_POOL_PROMPT_VERSION,
        ask: fresh[index].attempts,
        ...fresh[index].aimDigest === void 0 ? {} : { aimDigest: fresh[index].aimDigest },
        ...fresh[index].catalogDigest === void 0 ? {} : { catalogDigest: fresh[index].catalogDigest },
        file: fresh[index].file,
        model: input.pin.model,
        generationRefused: generation.refused.length,
        bugs: generation.bugs
      });
    });
    const attempted = /* @__PURE__ */ new Set([
      ...generations.flatMap((generation, index) => generation.failure === void 0 ? [fresh[index].file] : []),
      ...replayedFiles.map((entry) => entry.file)
    ]);
    const covered = plan.files.filter((file) => file.funded && attempted.has(file.file));
    const coveredSites = covered.reduce((total, file) => total + file.coveredSites, 0);
    const replayedBugs = replayedFiles.flatMap((entry) => entry.bugs);
    replayed = replayedBugs.length;
    pool = {
      sha: input.sha,
      promptVersion: BUG_POOL_PROMPT_VERSION,
      planDigest: plan.planDigest,
      /* The store stamps this on `record` from the custody it was opened under; taken from the same
         place here so the object this run discloses and the object the file holds agree. */
      deleteAfter: store.deleteAfter,
      /* NO CHANGE, NO CLAIM. The overnight lane plants over whole files with no diff behind them, so
         there is no identified surface for a coverage sentence to be about and none is written. */
      ...plan.hasDiffSurface ? {
        coverage: {
          identifiedSites: plan.identifiedSites,
          coveredSites,
          zeroSiteFiles: plan.zeroSiteFiles,
          filesIdentified: plan.files.length,
          filesCovered: covered.length,
          attemptsPlanned: covered.reduce((total, file) => total + file.attempts, 0),
          truncated: coveredSites < plan.identifiedSites
        }
      } : {},
      model: input.pin.model,
      /* The replayed files' own refusals are not re-counted here: they were disclosed by the run
         that paid for them, and counting them again would report one refusal once per replay. */
      generationRefused: generations.reduce((total, generation) => total + generation.refused.length, 0),
      bugs: [...generations.flatMap((generation) => generation.bugs), ...replayedBugs]
    };
    store.record(pool);
    store.save();
  }
  const generatedIds = new Set(pool.bugs.map((bug) => bug.bugId));
  const carried = store.graduatedStalestFirst().filter((bug) => !generatedIds.has(bug.bugId));
  const graduated = carried.slice(0, input.policy.graduatedCeiling);
  if (graduated.length > 0) {
    store.markGraduatedReplayed(graduated.map((bug) => bug.bugId));
    store.save();
  }
  const poolBugs = [...pool.bugs, ...graduated];
  const results = [];
  const located = [];
  for (const bug of poolBugs) {
    const found = locateBug(input.repoDir, bug);
    if (!found.ok) {
      results.push({ bug, route: "unplaceable", holdReason: found.reason, executions: 0 });
      continue;
    }
    located.push({ bug, gap: found.gap });
  }
  const routing = input.selectForExecution === void 0 ? null : input.selectForExecution(located.map((entry) => ({ gapId: entry.gap.gapId, gap: entry.gap })));
  const selected = routing === null ? null : routing.execute;
  if (routing !== null && routing.order.length > 0) {
    const rank = new Map(routing.order.map((gapId, index) => [gapId, index]));
    const positioned = located.map((entry, index) => ({ entry, index }));
    positioned.sort(
      (a, b) => (rank.get(a.entry.gap.gapId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.entry.gap.gapId) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index
    );
    located.splice(0, located.length, ...positioned.map(({ entry }) => entry));
  }
  const baselines = measureBugBaselines({
    runner: input.runner,
    targetedTimeoutMs: input.policy.targetedTimeoutMs,
    suiteTimeoutMs: input.policy.suiteTimeoutMs
  });
  const witnessTargets = /* @__PURE__ */ new Map();
  const witnessTargetFor = (file) => {
    const cached = witnessTargets.get(file);
    if (cached !== void 0) return cached;
    const absolute = join14(input.repoDir, file);
    if (!existsSync12(absolute)) return null;
    const placement = placeCandidate({
      testFilePaths: input.testFilePaths,
      targetFile: file,
      discriminator: "witness"
    });
    const target = {
      file,
      source: readFileSync13(absolute, "utf8"),
      witnessFile: placement.testFile,
      importSpecifier: importSpecifierFor({
        testFile: placement.testFile,
        targetFile: file,
        moduleFormat: input.moduleFormat,
        runner: input.runnerName
      }),
      /* NO PLACEMENT RULE ON A WITNESS. `changedRanges` is the surface a BUG must land on, and this
         call is not proposing one. */
      changedRanges: [],
      modules: collectWitnessModules({
        repoDir: input.repoDir,
        targetFile: file,
        witnessFile: placement.testFile,
        moduleFormat: input.moduleFormat,
        runner: input.runnerName,
        testFilePaths: input.testFilePaths
      }),
      dependencies: collectWitnessDependencies({
        repoDir: input.repoDir,
        testFilePaths: input.testFilePaths
      })
    };
    witnessTargets.set(file, target);
    return target;
  };
  for (const entry of located) {
    if (selected !== null && !selected.has(entry.gap.gapId)) {
      results.push({
        bug: entry.bug,
        route: "not-executed",
        holdReason: "predicted-killed",
        gap: entry.gap,
        executions: 0
      });
      continue;
    }
    const measurement = await measureBug({
      gap: entry.gap,
      runner: input.runner,
      coverage: input.coverage,
      testFilePaths: input.testFilePaths,
      targetedTimeoutMs: input.policy.targetedTimeoutMs,
      suiteTimeoutMs: input.policy.suiteTimeoutMs,
      baselines
    });
    const measuredExecutions = measurement.executions;
    if (measurement.outcome === "failed" || measurement.outcome === "unattributable") {
      results.push({
        bug: entry.bug,
        route: "not-executed",
        holdReason: measurement.outcome === "failed" ? "suite-run-failed" : "verdict-unattributable",
        gap: entry.gap,
        executions: measuredExecutions,
        verdictBy: measurement.verdictBy,
        ...measurement.evidence === void 0 ? {} : { evidence: measurement.evidence }
      });
      continue;
    }
    if (measurement.outcome === "killed") {
      results.push({
        bug: entry.bug,
        route: "suite-killed",
        gap: entry.gap,
        executions: measuredExecutions,
        verdictBy: measurement.verdictBy
      });
      continue;
    }
    let witness = entry.bug.witness;
    let diagnosis = entry.bug.diagnosis;
    let witnessCalls = 0;
    let witnessIsFresh = false;
    if (witness === void 0) {
      const target = witnessTargetFor(entry.bug.file);
      if (input.client === null || target === null) {
        results.push({
          bug: entry.bug,
          route: "witness-refused",
          holdReason: "witness-unavailable",
          gap: entry.gap,
          executions: measuredExecutions,
          verdictBy: measurement.verdictBy
        });
        continue;
      }
      const written = await generateWitness({
        target,
        bug: {
          originalText: entry.bug.originalText,
          replacement: entry.bug.replacement,
          ...entry.bug.bugType === void 0 ? {} : { bugType: entry.bug.bugType },
          ...entry.bug.note === void 0 ? {} : { note: entry.bug.note }
        },
        client: input.client,
        pin: input.pin,
        runner: input.runnerName,
        moduleFormat: input.moduleFormat,
        ...input.exampleTest === void 0 ? {} : { exampleTest: input.exampleTest },
        ...input.signal === void 0 ? {} : { signal: input.signal }
      });
      witnessCalls = written.modelCalls;
      modelCalls += witnessCalls;
      if (written.witness === void 0) {
        results.push({
          bug: entry.bug,
          route: "witness-refused",
          holdReason: "no-witness",
          gap: entry.gap,
          executions: measuredExecutions,
          verdictBy: measurement.verdictBy,
          ...written.failure === void 0 ? {} : { evidence: boundEvidence(written.failure.detail) }
        });
        continue;
      }
      witness = written.witness;
      diagnosis = written.diagnosis;
      witnessIsFresh = true;
    }
    const proofTarget = witnessTargetFor(entry.bug.file);
    const proof = await proveWitness({
      bug: entry.bug,
      witness,
      gap: entry.gap,
      runner: input.runner,
      testFilePaths: input.testFilePaths,
      timeoutMs: input.policy.targetedTimeoutMs,
      ...proofTarget === null ? {} : { allowedBareImports: proofTarget.dependencies }
    });
    if (!proof.proven) {
      store.detachWitness(entry.bug.bugId);
      store.save();
      results.push({
        bug: entry.bug,
        route: "witness-refused",
        holdReason: proof.reason,
        gap: entry.gap,
        executions: measuredExecutions + proof.executions,
        verdictBy: measurement.verdictBy,
        witnessFile: proof.witnessFile,
        ...proof.evidence === void 0 ? {} : { evidence: proof.evidence }
      });
      continue;
    }
    if (witnessIsFresh) {
      store.attachWitness(entry.bug.bugId, witness, diagnosis);
      store.save();
    }
    results.push({
      bug: entry.bug,
      route: "suite-survived",
      gap: entry.gap,
      executions: measuredExecutions + proof.executions,
      verdictBy: measurement.verdictBy,
      witnessFile: proof.witnessFile,
      witness,
      ...diagnosis === void 0 ? {} : { diagnosis }
    });
  }
  const ledger = buildPool2Evidence({ sha: input.sha, results });
  const evidenceText = serializePool2Evidence(ledger);
  const uploadEvidenceText = uploadableSidecarText(
    survivorPool2Projection(
      ledger,
      results.filter((result) => result.route === "suite-survived").map((result) => ({ bugId: result.bug.bugId, witness: "proven" }))
    )
  );
  return {
    state: "completed",
    results,
    disclosure: buildAgentBugDisclosure(
      pool,
      pinned,
      results,
      graduated.length,
      pool2EvidenceDigest(uploadEvidenceText),
      replayed,
      /* WHAT THIS RUN AIMED AT, taken from the targets it was handed rather than from the pool it
         produced. A pinned or content-replayed pool was generated under the same plan digest, which
         now carries the aim, so the statement holds on a replay as well as on a fresh generation. */
      buildAimDisclosure(input.targets),
      /* WHAT EACH FILE PRODUCED AND WHY THE GENERATOR REFUSED WHAT IT DID (POOL-02, POOL-03). Both
         empty on a pinned or content-replayed run, which generated nothing this visit. */
      { files: fileLedger, refusedReasons },
      /* WHICH VERDICTS CAME OFF AN UNEXECUTED CHANGED LINE, so the rate can leave them out. Counted
         from the targets this run was handed and the placements it actually made - a replayed pool
         is placed by this run too, so the answer holds on a replay exactly as on a fresh call. */
      untestedLineVerdicts(input.targets, results)
    ),
    evidenceText,
    uploadEvidenceText,
    modelCalls,
    attemptsPlanned: plan.attemptsPlanned
  };
}
function buildAgentBugDisclosure(pool, pinned, results, graduated = 0, evidenceDigest, replayed = 0, aim, generation, untestedLines) {
  const holdReasons = {};
  for (const result of results) {
    if (result.holdReason === void 0) continue;
    holdReasons[result.holdReason] = (holdReasons[result.holdReason] ?? 0) + 1;
  }
  const witnessProven = results.filter((result) => result.route === "suite-survived").length;
  return {
    ...evidenceDigest === void 0 ? {} : { evidenceDigest },
    ...aim === void 0 ? {} : { aim },
    ...pool.coverage === void 0 ? {} : { coverage: pool.coverage },
    ...untestedLines === void 0 || untestedLines.planted === 0 ? {} : { untestedLines: { ...untestedLines } },
    promptVersion: pool.promptVersion,
    model: pool.model,
    generatedAtSha: pool.sha,
    pinned,
    witnessMode: "deferred",
    replayed,
    generated: pool.bugs.length,
    graduated,
    generationRefused: pool.generationRefused,
    /* Omitted entirely when there is nothing to say, so an ordinary block is unchanged and a block
       that carries one of these carries it because something happened. */
    ...generation?.refusedReasons === void 0 || Object.keys(generation.refusedReasons).length === 0 ? {} : { generationRefusedReasons: { ...generation.refusedReasons } },
    ...generation?.files === void 0 || generation.files.length === 0 ? {} : { files: generation.files.map((entry) => ({ ...entry })) },
    unplaceable: results.filter((result) => result.route === "unplaceable").length,
    witnessProven,
    witnessRefused: results.filter((result) => result.route === "witness-refused").length,
    holdReasons,
    suiteKilled: results.filter((result) => result.route === "suite-killed").length,
    suiteSurvived: results.filter((result) => result.route === "suite-survived").length,
    notExecuted: results.filter((result) => result.route === "not-executed").length,
    executions: results.reduce((total, result) => total + result.executions, 0),
    survivors: results.filter((result) => result.route === "suite-survived").map((result) => ({
      bugId: result.bug.bugId,
      file: result.bug.file,
      startLine: result.gap?.startLine ?? 0,
      witness: "proven"
    }))
  };
}

// src/execution/runner.ts
import { scrubSecrets } from "@abloh/core";
function maskCapturedOutput(captured) {
  return { ...captured, stdout: scrubSecrets(captured.stdout), stderr: scrubSecrets(captured.stderr) };
}

// src/execution/patch.ts
function applyGapPatch(source, gap) {
  const offsets = spanOffsets(source, gap);
  if (!offsets.ok) return offsets;
  const slice = source.slice(offsets.start, offsets.end);
  if (slice !== gap.originalText) {
    return {
      ok: false,
      reason: `span at ${gap.file}:${gap.startLine}:${gap.startColumn} holds ${JSON.stringify(
        slice.slice(0, 80)
      )}, not the reported original ${JSON.stringify(gap.originalText.slice(0, 80))}`
    };
  }
  return { ok: true, source: source.slice(0, offsets.start) + gap.replacement + source.slice(offsets.end) };
}
function resolveReportedSpan(source, span) {
  const text = span.originalText;
  if (text === void 0 || text === "") return null;
  const lines = source.split("\n");
  if (span.startLine < 1 || span.startLine > lines.length) return null;
  let lineStart = 0;
  for (let i = 0; i < span.startLine - 1; i++) lineStart += lines[i].length + 1;
  const lineEnd = lineStart + lines[span.startLine - 1].length;
  const occurrences = [];
  for (let at = source.indexOf(text, lineStart); at !== -1 && at <= lineEnd; at = source.indexOf(text, at + 1)) {
    occurrences.push(at);
  }
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) {
    return { start: occurrences[0], end: occurrences[0] + text.length, replacedText: text };
  }
  const column = span.startColumn;
  if (typeof column !== "number") return null;
  const oneBased = lineStart + column - 1;
  const zeroBased = lineStart + column;
  const fitsOneBased = occurrences.includes(oneBased);
  const fitsZeroBased = occurrences.includes(zeroBased);
  if (fitsOneBased === fitsZeroBased) return null;
  const start = fitsOneBased ? oneBased : zeroBased;
  return { start, end: start + text.length, replacedText: text };
}
function spanOffsets(source, gap) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  if (gap.startLine < 1 || gap.startLine > lineStarts.length) {
    return { ok: false, reason: `start line ${gap.startLine} is outside ${gap.file}` };
  }
  if (gap.endLine < 1 || gap.endLine > lineStarts.length) {
    return { ok: false, reason: `end line ${gap.endLine} is outside ${gap.file}` };
  }
  const start = lineStarts[gap.startLine - 1] + (gap.startColumn - 1);
  const end = lineStarts[gap.endLine - 1] + (gap.endColumn - 1);
  if (start > end || end > source.length) {
    return { ok: false, reason: `span ${gap.startLine}:${gap.startColumn}-${gap.endLine}:${gap.endColumn} is not a range in ${gap.file}` };
  }
  return { ok: true, start, end };
}

// src/execution/report.ts
import {
  classifyReportUnavailable,
  findXmlElements,
  looksLikeRunnerFailureSummary,
  parseXml,
  xmlChild
} from "@abloh/core";
function namedFailures(passed, names) {
  const distinct = [...new Set(names.filter((name) => name !== ""))];
  if (distinct.length > 0) return distinct;
  return passed ? [] : null;
}
function parseTestReport(input) {
  const json = parseJsonReport(input);
  if (json !== null) return json;
  const junit = parseJUnitReport(input);
  if (junit !== null) return junit;
  const tap = parseTapReport(input);
  if (tap !== null) return tap;
  return {
    passed: input.exitCode === 0,
    executed: null,
    failedAssertion: looksLikeAssertion(`${input.stdout}
${input.stderr}`),
    failed: null,
    failures: null,
    format: "exit-code",
    unavailable: {
      dialect: null,
      path: input.reportPath ?? null,
      parserError: null,
      timedOut: input.timedOut === true,
      /* WHOSE FAILURE THIS WAS, decided HERE - where the runner's own output is in hand - and read
         once, by `proofReportRefusalCode`. Before the split every one of these was published under
         `owner: "abloh"`, including a suite that died on the repository's own config and a runner
         too old for the flag abloh added. */
      cause: classifyReportUnavailable({
        output: `${input.stdout}
${input.stderr}`,
        timedOut: input.timedOut === true,
        askedWith: input.askedWith ?? []
      }),
      /* WHETHER THERE WAS AN ASK TO FAIL. A reporting flag on the argv, or a file abloh named for
         the report, is abloh asking; a runner with neither - jasmine, deno, the generic command
         runner - was never going to write one, and the exit-code reading is what it always was.
         See `ReportUnavailable.asked`. */
      asked: (input.askedWith ?? []).length > 0 || (input.reportPath ?? null) !== null
    }
  };
}
function looksLikeGateFailure(report, output) {
  if (report.passed || report.format !== "exit-code" || report.failedAssertion) return false;
  return !looksLikeRunnerFailureSummary(output);
}
function statesFailure(parsed, assertions) {
  const counts = [parsed.numFailedTests, parsed.numFailedTestSuites, parsed.numRuntimeErrorTestSuites];
  if (counts.some((count) => count !== void 0 && count > 0)) return true;
  if ((parsed.testResults ?? []).some((file) => file.status === "failed")) return true;
  if (assertions.some((assertion) => assertion.status === "failed")) return true;
  if (counts.every((count) => count === void 0) && parsed.success !== void 0) return !parsed.success;
  return false;
}
function parseJsonReport(input) {
  const start = input.stdout.indexOf("{");
  const end = input.stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(input.stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed.numTotalTests === void 0 && parsed.testResults === void 0) return null;
  const assertions = (parsed.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const wanted = input.testName;
  const ranCount = parsed.numTotalTests ?? assertions.length;
  const executed = wanted === void 0 ? ranCount > 0 : assertions.some(
    (a) => (a.title === wanted || a.fullName === wanted || (a.fullName ?? "").includes(wanted)) && a.status !== "pending" && a.status !== "skipped" && a.status !== "todo"
  );
  const messages = assertions.flatMap((a) => a.failureMessages ?? []).join("\n");
  const suiteLevel = (parsed.testResults ?? []).map((file) => file.message ?? "").join("\n");
  const passed = ranCount > 0 && !statesFailure(parsed, assertions);
  return {
    passed,
    executed,
    failedAssertion: messages.trim() !== "" ? looksLikeAssertion(messages) : looksLikeAssertion(suiteLevel),
    failed: parsed.numFailedTests ?? null,
    /* `fullName` FIRST, because it carries the describe chain and `title` alone repeats across
       files - two suites can each own a "returns null on a missing key", and a set difference that
       cannot tell them apart would read one file's pre-existing failure as cover for another
       file's new one. */
    failures: namedFailures(
      passed,
      assertions.filter((a) => a.status === "failed").map((a) => a.fullName ?? a.title ?? "")
    ),
    format: "json"
  };
}
function parseJUnitReport(input) {
  const start = input.stdout.indexOf("<testsuites");
  const end = input.stdout.lastIndexOf("</testsuites>");
  if (start === -1 || end <= start) return null;
  const xml = input.stdout.slice(start, end + "</testsuites>".length);
  const roots = parseXml(xml);
  const cases = [];
  for (const testcase of findXmlElements(roots, "testcase")) {
    const attributes = testcase.attributes;
    const name = attributes.name ?? "";
    const classname = attributes.classname ?? "";
    cases.push({
      /* bun joins a describe chain to a test name with ONE space, which is also what its `-t`
         matches - so this is the same string `exactTestNamePattern` was built from. */
      fullName: classname === "" ? name : `${classname} ${name}`,
      /* THE LEAF NAME ON ITS OWN, because two producers put two different things in `classname`.
         bun puts the enclosing describe chain there, so joining it yields the title its `-t`
         matched. DENO PUTS THE TEST FILE'S PATH there (`./test/cart.test.ts`), so the joined form
         is never equal to any name a caller holds and the leaf is the only exact match available.
         It carries the match that a loose `includes` used to carry, WITHOUT the loose reading:
         `includes` reported a candidate named `adds` as executed on the strength of a pre-existing
         test named `adds two numbers`, which is the one fact this function exists to establish
         being established by a different test. */
      name,
      executed: xmlChild(testcase, "skipped") === void 0,
      failed: xmlChild(testcase, "failure") !== void 0 || xmlChild(testcase, "error") !== void 0
    });
  }
  const stated = roots.find((root) => root.name === "testsuites")?.attributes.failures;
  const failed = stated === void 0 || !/^\d+$/u.test(stated) ? cases.filter((entry) => entry.failed).length : Number.parseInt(stated, 10);
  const wanted = input.testName;
  const executed = cases.some(
    (entry) => entry.executed && (wanted === void 0 || entry.fullName === wanted || // The leaf, for a producer whose `classname` is the FILE rather than the describe chain.
    entry.name === wanted)
  );
  const passed = failed === 0 && input.exitCode === 0;
  return {
    passed,
    executed,
    /* A junit `<failure>` IS the runner reporting a failed test, exactly as a TAP `not ok` point is,
       so the English-shaped assertion vocabulary has nothing left to establish here and only the
       machinery veto matters. Both streams, because a module that failed to load prints to stderr as
       often as to stdout and reading only stdout would count a crash as a detection. */
    failedAssertion: failed > 0 && !looksLikeMachinery(`${input.stdout}
${input.stderr}`),
    failed,
    /* The JOINED form, for the same reason the JSON branch prefers `fullName`: `classname` is the
       describe chain for bun and the test FILE for deno, and either one prefixed onto the leaf
       keeps two same-named tests in two places apart. */
    failures: namedFailures(passed, cases.filter((entry) => entry.failed).map((entry) => entry.fullName)),
    format: "junit"
  };
}
function parseTapReport(input) {
  const lines = input.stdout.split("\n");
  if (!lines.some((line) => /^TAP version \d+/u.test(line.trim()))) return null;
  const points = lines.map((line) => /^\s*(not ok|ok)\s+\d+\s*-?\s*(.*)$/u.exec(line)).filter((match) => match !== null).map((match) => {
    const stated2 = match[2].trim();
    const hash = /(?:^|\s)#/u.exec(stated2.replace(/\\#/gu, "\\_"));
    const name = (hash === null ? stated2 : stated2.slice(0, hash.index)).trim().replace(/\\#/gu, "#");
    const directive = hash === null ? null : /^\s*(skip|todo)\b/iu.exec(stated2.slice(hash.index + hash[0].length));
    return { ok: directive !== null || match[1] === "ok", ran: directive === null, name };
  });
  const failingPoints = points.filter((point) => !point.ok).length;
  const stated = tapSummaryFailures(input.stdout);
  const failed = stated === null ? failingPoints : Math.min(stated, failingPoints);
  const wanted = input.testName;
  const executed = wanted === void 0 ? points.some((point) => point.ran) : points.some((point) => point.ran && point.name === wanted);
  const passed = failed === 0 && input.exitCode === 0;
  return {
    passed,
    executed,
    /* BOTH STREAMS, and only here. The TAP report itself is stdout - a `TAP version` line on stderr
       is not a report - but a module that failed to load prints to stderr as often as to stdout,
       and reading only stdout would let a crash be counted as a detection. */
    failedAssertion: failed > 0 && !looksLikeMachinery(`${input.stdout}
${input.stderr}`),
    failed,
    /* EVERY LEVEL'S POINT, not just the leaf. `tap` emits one `not ok` for the assertion, one for
       the test containing it and one for the FILE, and the count above already prefers the runner's
       own summary over this list for exactly that reason. The set difference does not care: the
       enclosing names appear identically on both sides of the comparison and cancel, and keeping
       them means a candidate that breaks a whole FILE - which is what a bad import does - is named
       even when no individual assertion inside it got as far as reporting. */
    failures: namedFailures(passed, points.filter((point) => !point.ok).map((point) => point.name)),
    format: "tap"
  };
}
var TAP_SUMMARY_FAILURES = [/^\s*#\s*fail\s+(\d+)\s*$/mu, /^\s*#\s*\{[^\n]*\bfail:\s*(\d+)[^\n]*\}\s*$/mu];
function tapSummaryFailures(stdout) {
  for (const pattern of TAP_SUMMARY_FAILURES) {
    const match = pattern.exec(stdout);
    if (match === null) continue;
    const value = Number.parseInt(match[1], 10);
    if (!Number.isNaN(value)) return value;
  }
  return null;
}
var MACHINERY = [
  /Cannot find module/iu,
  /Cannot find package/iu,
  /ERR_MODULE_NOT_FOUND/u,
  /SyntaxError/u,
  /TypeError: .*is not a function/u,
  /ReferenceError/u,
  /Transform failed/iu,
  /Failed to load/iu,
  /No test files found/iu
];
var ASSERTION = [
  /AssertionError/u,
  /expected .* (?:to|but)/iu,
  /toBe|toEqual|toThrow|toMatch|toHaveBeen/u,
  /assert\./u,
  /Expected:/u
];
function looksLikeAssertion(output) {
  if (looksLikeMachinery(output)) return false;
  return ASSERTION.some((pattern) => pattern.test(output));
}
function looksLikeMachinery(output) {
  return MACHINERY.some((pattern) => pattern.test(output));
}

// src/execution/local-runner.ts
import { spawn } from "child_process";
import { cpSync, mkdtempSync, mkdirSync as mkdirSync5, readFileSync as readFileSync14, rmSync as rmSync2, writeFileSync as writeFileSync5, existsSync as existsSync13 } from "fs";
import { dirname as dirname10, join as join15, resolve as resolve5 } from "path";
import { tmpdir } from "os";

// src/execution/test-filter.ts
import { ANGULAR_RUNNERS, separatorForCommand } from "@abloh/core";
var NAME_FILTER_FLAG = /* @__PURE__ */ new Map([
  ["jest", "--testNamePattern=%t"],
  ["vitest", "--testNamePattern=%t"],
  ["mocha", "--grep=%t"],
  ["node-test", "--test-name-pattern=%t"],
  ["bun", "--test-name-pattern=%t"],
  /*
   * DENO, 2026-08-18, and it is the ONE ENTRY WHOSE VALUE IS NOT THE BARE PATTERN.
   *
   * `deno test --filter` takes a SUBSTRING by default and a REGULAR EXPRESSION only when the value
   * is wrapped in slashes, so `--filter=(?:^|\s)beta$` would be matched literally and select
   * nothing - the vacuous-green failure this whole file exists to prevent, arriving through the
   * flag meant to prevent it. `/.../` is therefore part of the template rather than something a
   * caller remembers.
   *
   * A SLASH INSIDE THE PATTERN IS SAFE, which is the question the wrapping raises and it was
   * measured rather than assumed. deno strips the FIRST and LAST characters and compiles the rest,
   * so a test named `has a/b slash` produces `/(?:^|\s)has a/b slash$/` and selects exactly that
   * test - verified on 2.7.11 against a sibling named `has a/b slash extra`, which stayed
   * `<skipped/>`.
   *
   * Measured on deno 2.7.11, three flat `Deno.test` names in one file:
   *
   *   | pattern | selected |
   *   |---|---|
   *   | `(?:^\|\s)beta$` unwrapped | 0 - read as a literal substring |
   *   | `/(?:^\|\s)beta$/` | exactly 1, with `beta extra` reported `<skipped/>` |
   *
   * Deno test names are FLAT - there is no enclosing `describe` to join - so the title-boundary
   * anchor has less work to do here than on mocha or vitest, and `^name$` would have sufficed. It
   * is used anyway because one escaping-and-anchoring rule for every runner is what stops the next
   * runner from getting a subtly different one.
   *
   * THE VACUOUS SELECTION IS DETECTABLE, and this is the only runner in this map where the EXIT
   * CODE alone lies: a filter matching nothing exits 0 with every case marked `<skipped/>` and
   * `disabled="3"`. `parseJUnitReport` reads `executed` as "no `<skipped` child", so the trap is
   * caught by the report rather than by the exit code - the same mechanism bun's row relies on for
   * a different reason.
   */
  ["deno", "--filter=/%t/"]
]);
var FILE_SELECTION_ARG = new Map(
  ANGULAR_RUNNERS.map((runner) => [runner, "--include=%f"])
);
function targetedArgsFor(input) {
  const runner = input.runner.toLowerCase();
  const flag = NAME_FILTER_FLAG.get(runner);
  const file = FILE_SELECTION_ARG.get(runner) ?? "%f";
  const selection = flag === void 0 ? [file] : [flag, file];
  const separator = separatorForCommand({
    testCommand: input.testCommand,
    ...input.packageManager === void 0 ? {} : { packageManager: input.packageManager }
  });
  return separator.emit ? ["--", ...selection] : selection;
}
function exactTestNamePattern(fullName) {
  return `(?:^|\\s)${fullName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}
function runnerRelativeTestFile(input) {
  const subdir = input.executionSubdir;
  if (subdir === null || subdir === "" || subdir === ".") return input.testFile;
  const prefix = subdir.endsWith("/") ? subdir : `${subdir}/`;
  return input.testFile.startsWith(prefix) ? input.testFile.slice(prefix.length) : input.testFile;
}
function substituteTargetedArgs(input) {
  const named = input.testName !== void 0 && input.testName !== "";
  const runnerPath = runnerRelativeTestFile({ testFile: input.testFile, executionSubdir: input.executionSubdir });
  const substituted = [];
  for (const arg of input.targetedArgs) {
    if (arg.includes("%t")) {
      if (!named) continue;
      substituted.push(arg.replaceAll("%t", exactTestNamePattern(input.testName)));
      continue;
    }
    substituted.push(arg.replaceAll("%f", runnerPath));
  }
  return substituted;
}

// src/execution/spec-presence.ts
var ANSI = /\[[0-9;]*m/gu;
var UNAMBIGUOUS_NO_SPEC = [
  /^\s*No test files found, exiting with code \d+/mu,
  // vitest
  /^\s*No tests found, exiting with code \d+/mu,
  // jest
  /^\s*Error: No test files found:/mu,
  // mocha
  /^\s*The following filters did not match any test files/mu
  // bun
];
var PATH_BEARING_NO_SPEC = [
  /^\s*Could not find '(.+)'\s*$/mu,
  // node:test
  /error: Import '(.+)' failed, not found\./mu
  // deno
];
function specNotFoundEvidence(output, requestedPath) {
  const plain = output.replace(ANSI, "");
  for (const pattern of UNAMBIGUOUS_NO_SPEC) {
    const match = pattern.exec(plain);
    if (match !== null) return match[0].trim();
  }
  for (const pattern of PATH_BEARING_NO_SPEC) {
    const match = pattern.exec(plain);
    if (match === null) continue;
    const named = match[1];
    if (named === requestedPath || named.endsWith(`/${requestedPath}`) || named.endsWith(requestedPath)) {
      return match[0].trim();
    }
  }
  return null;
}
var SpecNotFoundError = class extends EngineUnavailableError {
  /** the engine's repo-relative name for the test file */
  testFile;
  /** the path as the runner command carried it, which is what the runner echoed back */
  requestedPath;
  /**
   * IT CARRIES ITS OWN CODE (raw-message review, entry 211).
   *
   * A plain `Error` here was `unavailableCode`'s undeclared case, so both shapes reached every
   * surface as `proposals-unavailable:engine-error` - pooled with every exception this engine did not
   * anticipate, which is the grouping that hides a cause rather than naming it. Subclassing
   * `EngineUnavailableError` is what puts the code at the throw; the sentence below is unchanged
   * and stays local, as this class's `detail`.
   */
  constructor(input) {
    super(
      "spec-not-found",
      `marigold asked the runner to execute a test file it cannot see: '${input.testFile}' (given to the runner as '${input.requestedPath}') - ${input.detail}`
    );
    this.name = "SpecNotFoundError";
    this.testFile = input.testFile;
    this.requestedPath = input.requestedPath;
  }
};
function assertTargetedSpecIsPlaced(input) {
  if (input.placed.includes(input.testFile)) return;
  if (input.existsInTree(input.testFile)) return;
  throw new SpecNotFoundError({
    testFile: input.testFile,
    requestedPath: input.requestedPath,
    detail: `nothing was written at that path and the repository has no file there; this execution placed ${input.placed.length === 0 ? "no files" : input.placed.map((path) => `'${path}'`).join(", ")}`
  });
}
function assertRunnerFoundSpec(input) {
  const evidence = specNotFoundEvidence(input.output, input.requestedPath);
  if (evidence === null) return;
  throw new SpecNotFoundError({
    testFile: input.testFile,
    requestedPath: input.requestedPath,
    detail: `the runner reported: ${evidence}`
  });
}

// src/execution/local-runner.ts
import {
  ambientEnvironmentWithoutEngineCredentials,
  expandCommandGlobs,
  reportingFlagsIn
} from "@abloh/core";
function childEnvironment(extra) {
  const env = {
    ...ambientEnvironmentWithoutEngineCredentials(process.env),
    ...extra ?? {},
    CI: "1"
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}
var LocalUnsealedRunner = class {
  id = "local-unsealed";
  sealed = false;
  executions = 0;
  /** the selection template a targeted request is run with; see `DockerSealedRunner.targetedArgs` */
  targetedArgs;
  /**
   * The directory every execution runs the test command in, repo-relative, `null` for the root.
   *
   * Readable, and read by BOTH the spawn's `cwd` and the targeted `%f`, for the reason
   * `DockerSealedRunner.executionSubdir` is: a targeted path is relative to this directory, and two
   * places deriving that separately is the defect `test-filter.ts` now owns the fix for.
   */
  executionSubdir;
  #options;
  #workDir = null;
  #scratchRoot = null;
  #prepared = null;
  constructor(options) {
    this.#options = options;
    this.targetedArgs = options.targetedArgs ?? ["%f"];
    this.executionSubdir = options.subdir === void 0 || options.subdir === "" || options.subdir === "." ? null : options.subdir;
  }
  async prepare() {
    if (this.#prepared !== null) return { ...this.#prepared, reused: true };
    const recipeDigest = structuralDigest2({
      runner: this.#options.runner,
      testCommand: this.#options.testCommand,
      installCommand: this.#options.installCommand ?? null,
      subdir: this.#options.subdir ?? null,
      /* Same fact the sealed runner puts in its recipe: where the install ran is part of what the
         prepared tree IS, so two preparations that differ only there are not the same environment. */
      installSubdir: this.#installSubdirForDigest()
    });
    if (this.#options.copyRepository === false) {
      this.#scratchRoot = null;
      this.#workDir = resolve5(this.#options.repoDir);
    } else {
      const root = mkdtempSync(join15(tmpdir(), "abloh-v2-local-"));
      this.#scratchRoot = root;
      const destination = join15(root, "repo");
      cpSync(resolve5(this.#options.repoDir), destination, {
        recursive: true,
        filter: (source) => !source.split("/").includes(".git")
      });
      this.#workDir = destination;
    }
    if (this.#options.installCommand !== void 0 && this.#options.installCommand.length > 0) {
      await this.#spawn(this.#options.installCommand, 15 * 6e4, this.#installDir());
    }
    this.#prepared = {
      recipeDigest,
      reused: false,
      sealed: false,
      runnerId: this.id,
      runner: this.#options.runner
    };
    return this.#prepared;
  }
  async execute(request) {
    if (this.#workDir === null) await this.prepare();
    const workDir = this.#workDir;
    if (workDir === null) throw new Error("local runner: preparation did not produce a work directory");
    const restore = /* @__PURE__ */ new Map();
    const started = Date.now();
    try {
      for (const gap of request.patches) {
        const absolute = join15(workDir, gap.file);
        if (!existsSync13(absolute)) {
          return this.#failed(`patched file is absent from the work tree: ${gap.file}`, started);
        }
        const original = readFileSync14(absolute, "utf8");
        const patched = applyGapPatch(original, gap);
        if (!patched.ok) return this.#failed(patched.reason, started);
        if (!restore.has(absolute)) restore.set(absolute, original);
        writeFileSync5(absolute, patched.source);
      }
      for (const file of request.files) {
        const absolute = join15(workDir, file.path);
        if (!restore.has(absolute)) {
          restore.set(absolute, existsSync13(absolute) ? readFileSync14(absolute, "utf8") : null);
        }
        mkdirSync5(dirname10(absolute), { recursive: true });
        writeFileSync5(absolute, file.source);
      }
      const targeted = request.mode === "targeted" && request.testFile !== void 0;
      const requestedPath = targeted ? runnerRelativeTestFile({ testFile: request.testFile, executionSubdir: this.executionSubdir }) : "";
      if (targeted) {
        assertTargetedSpecIsPlaced({
          testFile: request.testFile,
          requestedPath,
          placed: request.files.map((file) => file.path),
          existsInTree: (relative5) => existsSync13(join15(workDir, relative5))
        });
      }
      const declaredArgv = targeted ? [
        ...this.#options.testCommand,
        ...substituteTargetedArgs({
          targetedArgs: this.targetedArgs,
          testFile: request.testFile,
          executionSubdir: this.executionSubdir,
          testName: request.testName
        })
      ] : [...this.#options.testCommand];
      const argv = expandCommandGlobs(
        declaredArgv,
        this.executionSubdir === null ? workDir : join15(workDir, this.executionSubdir)
      ).argv;
      this.executions += 1;
      const run = maskCapturedOutput(await this.#spawn(argv, request.timeoutMs));
      const report = parseTestReport({
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode,
        testName: request.testName,
        /* ABLOH'S OWN WALL, same reading and same reason as the sealed runner's. */
        timedOut: run.timedOut,
        /* WHICH OF THE FLAGS ON THIS ARGV WERE OURS - the one input that lets an unreadable report
           be attributed to the runner refusing OUR ask rather than to abloh or to the suite. */
        askedWith: reportingFlagsIn(argv)
      });
      const captured = `${run.stdout}
${run.stderr}`.trim();
      if (targeted) {
        assertRunnerFoundSpec({ testFile: request.testFile, requestedPath, output: captured });
      }
      return {
        report,
        exitCode: run.exitCode,
        output: boundEvidence(captured),
        wallMs: Date.now() - started,
        ...run.timedOut ? { timedOut: true } : {},
        ...this.#options.testCommandRunsProjectScript === true && looksLikeGateFailure(report, captured) ? { gateShapedFailure: true } : {}
      };
    } finally {
      for (const [path, contents] of restore) {
        if (contents === null) rmSync2(path, { force: true });
        else writeFileSync5(path, contents);
      }
    }
  }
  async dispose() {
    if (this.#scratchRoot !== null) rmSync2(this.#scratchRoot, { recursive: true, force: true });
    this.#scratchRoot = null;
    this.#workDir = null;
    this.#prepared = null;
  }
  /**
   * THE HARNESS DID NOT GET AS FAR AS A TEST, and the report says exactly that.
   *
   * `executed: false` used to sit here, which is the report POSITIVELY stating that no test ran -
   * and that is a claim about the customer's suite, made on the strength of abloh failing to start
   * a container. It is `null` now, which is the value every reader already treats as "the report
   * did not say", and the diagnostic beside it says why there is no report at all (rank 4).
   */
  #failed(reason, started) {
    return {
      report: {
        passed: false,
        executed: null,
        failedAssertion: false,
        failed: null,
        failures: null,
        format: "exit-code",
        unavailable: { dialect: null, path: null, parserError: reason, timedOut: false }
      },
      exitCode: -1,
      output: reason,
      wallMs: Date.now() - started,
      error: reason
    };
  }
  /**
   * The install directory as a repo-relative value, `null` for the root.
   *
   * `undefined` - nothing declared - is the only case that falls back to the measured package. A
   * DECLARED root normalizes to null and must NOT fall back, which is why this is an explicit
   * check and not `??`.
   */
  #installSubdirForDigest() {
    const declared = this.#options.installSubdir;
    if (declared === void 0) return this.#options.subdir ?? null;
    return declared === null || declared === "" || declared === "." ? null : declared;
  }
  /** Where the install command runs: the declared install directory, else the measured package. */
  #installDir() {
    const root = this.#workDir ?? resolve5(this.#options.repoDir);
    const relative5 = this.#installSubdirForDigest();
    return relative5 === null ? root : join15(root, relative5);
  }
  #spawn(argv, timeoutMs, cwdOverride) {
    const root = this.#workDir ?? resolve5(this.#options.repoDir);
    const cwd = cwdOverride ?? (this.executionSubdir === null ? root : join15(root, this.executionSubdir));
    return new Promise((resolvePromise) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: childEnvironment(this.#options.env),
        stdio: ["ignore", "pipe", "pipe"],
        /*
         * ITS OWN PROCESS GROUP, SO THE WALL CAN END THE WHOLE TREE.
         *
         * A test runner is a process that starts processes: node's own runner spawns one child per
         * test file under its default process isolation, and every runner in the table forks or
         * spawns something. Signalling only the command abloh started leaves those children alive
         * with no parent - measured on this package's own fixture, where ten hanging test-file
         * children outlived their killed runners and were still idling minutes later. They then
         * hold the ports, the locks and the CPU the rest of the run needs.
         *
         * The sealed runner has always ended the whole tree, because it removes the CONTAINER rather
         * than signalling the client (`docker-runner.ts`'s own note says why the order matters).
         * This is that rule for the unsealed lane, which has no container to remove.
         */
        detached: true
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolvePromise({ stdout, stderr: `${stderr}
${error.message}`, exitCode: -1, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, exitCode: code ?? -1, timedOut });
      });
    });
  }
};

// src/execution/docker-runner.ts
import { spawn as spawn2, execFileSync } from "child_process";
import { randomBytes as randomBytes2 } from "crypto";
import { mkdtempSync as mkdtempSync2, mkdirSync as mkdirSync6, readFileSync as readFileSync15, readdirSync as readdirSync3, rmSync as rmSync3, writeFileSync as writeFileSync6, existsSync as existsSync14, chmodSync } from "fs";
import { dirname as dirname11, join as join17, resolve as resolve6 } from "path";
import { tmpdir as tmpdir2 } from "os";

// src/execution/context-identity.ts
import { createHash } from "crypto";
import { closeSync, openSync, readSync, readdirSync as readdirSync2, readlinkSync, statSync as statSync3 } from "fs";
import { join as join16 } from "path";
var READ_CHUNK_BYTES = 1 << 20;
function buildContextDigest(contextDir) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  hashDirectory(hash, contextDir, "", buffer);
  return hash.digest("hex");
}
function sealedImageTag(input) {
  const identity = structuralDigest2({ recipe: input.recipeDigest, context: input.contextDigest });
  return `abloh-marigold:${identity.slice(0, 32)}`;
}
var OVERLAY_WORKSPACE_CONTEXT = "overlay-workspace/v1";
function sealedWorkspaceImageTag(recipeDigest) {
  return sealedImageTag({ recipeDigest, contextDigest: OVERLAY_WORKSPACE_CONTEXT });
}
function hashDirectory(hash, root, relative5, buffer) {
  const absoluteDir = relative5 === "" ? root : join16(root, relative5);
  const entries = readdirSync2(absoluteDir, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const path = relative5 === "" ? entry.name : `${relative5}/${entry.name}`;
    const absolute = join16(root, path);
    if (entry.isSymbolicLink()) {
      hash.update(`L ${path}
${readlinkSync(absolute)}
`);
    } else if (entry.isDirectory()) {
      hash.update(`D ${path}
`);
      hashDirectory(hash, root, path, buffer);
    } else if (entry.isFile()) {
      const stats = statSync3(absolute);
      hash.update(`F ${path} ${(stats.mode & 73) !== 0 ? "x" : "-"} ${stats.size}
`);
      hashFileInto(hash, absolute, buffer);
    } else {
      hash.update(`O ${path}
`);
    }
  }
}
function hashFileInto(hash, absolute, buffer) {
  const fd = openSync(absolute, "r");
  try {
    for (; ; ) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
}

// src/execution/docker-runner.ts
import {
  BROWSER_LANE_MEASURED_ENVIRONMENT,
  BROWSER_SHARED_MEMORY_ARGV,
  SEALED_BROWSER_UID,
  SEALED_CHROMIUM_PACKAGES,
  SEALED_CHROME_BIN,
  SEALED_COREPACK_HOME,
  SEALED_DENO_DIR,
  SEALED_PLAYWRIGHT_BROWSERS_PATH,
  chromeSeccompProfile,
  describeCommandGlobExpansions,
  expandCommandGlobs as expandCommandGlobs2,
  installCommandNeedsCorepackEnable,
  readRegistryAuthFailure,
  registryAuthRefusal,
  reportingFlagsIn as reportingFlagsIn2,
  renderSetupFailure,
  sealedExtrasNeeded,
  sealedRuntimeInstallProgram,
  nativeFloorCommand,
  detectedHostCores,
  pidCeilingExhaustion,
  sealedPidsLimit,
  sealedToolchainCommand,
  setupStepMarker,
  SETUP_SCRIPT_PATH,
  sortedSystemPackages,
  systemPackageInstallCommand
} from "@abloh/core";

// src/execution/services.ts
import {
  MAX_ENVIRONMENT_SERVICES,
  environmentValueProblem,
  healthCommandProblem,
  healthPortProblem,
  isEnvironmentName,
  serviceNameProblem
} from "@abloh/core";
var IMMUTABLE_IMAGE_REF = /^[a-z0-9][a-z0-9._:/-]*@sha256:([a-f0-9]{64})$/u;
var SERVICE_READY_TIMEOUT_MS = 18e4;
var SERVICE_READY_POLL_MS = 500;
function validatedSealedServices(services) {
  if (services.length > MAX_ENVIRONMENT_SERVICES) {
    return { ok: false, problem: `more than ${MAX_ENVIRONMENT_SERVICES} services are declared` };
  }
  if (new Set(services.map((service) => service.name)).size !== services.length) {
    return { ok: false, problem: "one service name is declared twice" };
  }
  for (const service of services) {
    const match = service.ref.match(IMMUTABLE_IMAGE_REF);
    if (serviceNameProblem(service.name) !== null || match === null || match[1] !== service.digest || service.healthCommand !== null && healthCommandProblem(service.healthCommand) !== null || service.healthPort !== null && healthPortProblem(service.healthPort) !== null || service.healthCommand === null && service.healthPort === null || service.env.some(
      (entry) => !isEnvironmentName(entry.name) || environmentValueProblem(entry.value) !== null
    )) {
      return { ok: false, problem: `${service.name} is declared in a shape this contract cannot bind` };
    }
  }
  return {
    ok: true,
    services: services.map((service) => ({ ...service, env: service.env.map((entry) => ({ ...entry })) }))
  };
}
function serviceNetworkArgs(input) {
  return ["network", "create", "--internal", "--label", input.label, input.network];
}
function serviceNamespaceHolderArgs(input) {
  return [
    "create",
    "--name",
    input.name,
    "--label",
    input.label,
    ...input.platform == null ? [] : ["--platform", input.platform],
    "--network",
    input.network,
    ...input.aliases.flatMap((alias) => ["--network-alias", alias]),
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--memory-swap",
    "256m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=16m",
    "--entrypoint",
    "node",
    "--no-healthcheck",
    input.image,
    "-e",
    "setInterval(() => {}, 1 << 30);"
  ];
}
function serviceContainerArgs(input) {
  return [
    "create",
    "--name",
    input.name,
    "--label",
    input.label,
    ...input.platform == null ? [] : ["--platform", input.platform],
    "--network",
    `container:${input.holder}`,
    "--read-only",
    /* The five-capability deviation, and the argument for it, is in this file's header. Everything
       escape-shaped stays dropped and `no-new-privileges` still holds. */
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "1024m",
    "--memory-swap",
    "1024m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=128m",
    ...input.writablePaths.flatMap((path) => ["--tmpfs", `${path}:rw,nosuid,nodev,size=512m`]),
    ...input.service.env.flatMap((entry) => ["--env", `${entry.name}=${entry.value}`]),
    ...input.service.healthCommand === null ? ["--no-healthcheck"] : [
      "--health-cmd",
      input.service.healthCommand,
      "--health-interval",
      "1s",
      "--health-timeout",
      "5s",
      "--health-retries",
      "3"
    ],
    input.service.ref
  ];
}
function serviceWritablePathsFrom(volumesJson) {
  const declared = /* @__PURE__ */ new Set();
  let parsed = null;
  try {
    parsed = JSON.parse(volumesJson.trim() === "" ? "null" : volumesJson.trim());
  } catch {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === "object") {
    for (const path of Object.keys(parsed)) {
      if (/^\/[A-Za-z0-9._\-/]{1,200}$/u.test(path) && !path.includes("..")) declared.add(path);
    }
  }
  declared.delete("/run");
  declared.delete("/tmp");
  return ["/run", ...[...declared].sort()];
}
function serviceTcpProbeScript(port) {
  return `const s=require("net").connect(${port},"127.0.0.1");s.setTimeout(3000);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("timeout",()=>{s.destroy();process.exit(1)});s.on("error",()=>process.exit(1));`;
}
function serviceTcpProbeArgs(input) {
  return ["exec", input.holder, "node", "-e", serviceTcpProbeScript(input.port)];
}
function serviceReadyVerdict(input) {
  if (input.running.trim() === "false") return "exited";
  if (input.health !== null) return input.health.trim() === "healthy" ? "ready" : "waiting";
  if (input.probeConnected === true) return "ready";
  return "waiting";
}

// src/execution/docker-runner.ts
var CONTAINER_WORKDIR = "/work";
var INPUT_MOUNT = "/candidate";
var REPLAY_PRELOAD_NAME = "abloh-replay-preload.mjs";
var REPLAY_JOURNAL_DIR = "/tmp";
function normalizeContainerSubdir(value) {
  if (value === void 0) return void 0;
  if (value === null || value === "" || value === ".") return null;
  return value;
}
function inheritedRecipeFields(inherited) {
  return {
    node: inherited.node,
    packageManager: inherited.packageManager,
    runtimes: [...inherited.runtimes].sort(),
    lockfiles: [...inherited.lockfiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  };
}
var BUILD_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
var SECRET_MOUNT_DIR = "/run/secrets";
function buildSecretMountFlags(names) {
  return names.map((name) => `--mount=type=secret,id=${name}`).join(" ");
}
function buildSecretPrelude(names) {
  return names.map(
    (name) => `if [ -r ${SECRET_MOUNT_DIR}/${name} ]; then ${name}="$(cat ${SECRET_MOUNT_DIR}/${name})"; export ${name}; fi`
  ).join("\n");
}
var DOCKER_BUILD_EVIDENCE_CHARS = 1200;
function dockerBuildFailureEvidence(stdout, stderr) {
  const output = `${stderr}
${stdout}`;
  const lines = output.split("\n");
  const isRule = (line) => /^-{3,}\s*$/u.test(line);
  let stepIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*>\s*.+:\s*$/u.test(lines[index]) && index > 0 && isRule(lines[index - 1])) stepIndex = index;
  }
  if (stepIndex === -1) return boundEvidenceTail(output.trim(), DOCKER_BUILD_EVIDENCE_CHARS);
  const step = lines[stepIndex].trim().replace(/^>\s*/u, "").replace(/:$/u, "");
  const body = [];
  for (let index = stepIndex + 1; index < lines.length && !isRule(lines[index]); index += 1) body.push(lines[index]);
  const detail = body.join("\n").trim();
  const tail = boundEvidenceTail(detail, DOCKER_BUILD_EVIDENCE_CHARS);
  return detail === "" ? `failing step: ${step}` : `${tail}
(failing step: ${step})`;
}
var SEALED_RUN_LABEL = "abloh.sealed-run";
var CONTAINER_NAME_PREFIX = "abloh-v2";
var SEALED_PNPM_VERIFY_DEPS = "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false";
var SEALED_WORKSPACE_ENV = "ABLOH_SEALED_WORKSPACE";
function sealedWorkspaceDefault() {
  return "image";
}
function sealedWorkspaceRequested(environment = process.env) {
  const asked = environment[SEALED_WORKSPACE_ENV];
  if (asked === "image" || asked === "overlay") return asked;
  return sealedWorkspaceDefault();
}
var OVERLAY_WORKSPACE_CAPABILITY = "DAC_OVERRIDE";
var OVERLAY_UNMOUNTABLE_CHARACTERS = /[,:]/u;
function overlayVolumeOptions(input) {
  return [
    "--driver",
    "local",
    "--opt",
    "type=overlay",
    "--opt",
    "device=overlay",
    "--opt",
    `o=lowerdir=${input.lowerdir},upperdir=${input.upperdir},workdir=${input.workdir}`
  ];
}
var CONTAINER_STOP_TIMEOUT_MS = 3e4;
var CLIENT_CLOSE_GRACE_MS = 1e4;
var liveContainers = /* @__PURE__ */ new Map();
var liveNetworks = /* @__PURE__ */ new Map();
var liveVolumes = /* @__PURE__ */ new Map();
var trapsInstalled = false;
function installSweepTraps() {
  if (trapsInstalled) return;
  trapsInstalled = true;
  process.on("exit", sweepLiveResources);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, onSignal);
  }
}
function rememberContainer(name, dockerBin) {
  liveContainers.set(name, dockerBin);
  installSweepTraps();
}
function rememberNetwork(name, dockerBin) {
  liveNetworks.set(name, dockerBin);
  installSweepTraps();
}
function rememberVolume(name, dockerBin) {
  liveVolumes.set(name, dockerBin);
  installSweepTraps();
}
function forgetContainer(name) {
  liveContainers.delete(name);
}
function onSignal(signal) {
  if (process.listenerCount(signal) > 1) return;
  sweepLiveResources();
  process.off(signal, onSignal);
  process.kill(process.pid, signal);
}
function sweepLiveResources() {
  for (const [name, dockerBin] of liveContainers) {
    try {
      execFileSync(dockerBin, ["rm", "-f", name], { stdio: "ignore", timeout: CONTAINER_STOP_TIMEOUT_MS });
    } catch {
    }
  }
  liveContainers.clear();
  for (const [name, dockerBin] of liveNetworks) {
    try {
      execFileSync(dockerBin, ["network", "rm", name], { stdio: "ignore", timeout: CONTAINER_STOP_TIMEOUT_MS });
    } catch {
    }
  }
  liveNetworks.clear();
  for (const [name, dockerBin] of liveVolumes) {
    try {
      execFileSync(dockerBin, ["volume", "rm", "-f", name], { stdio: "ignore", timeout: CONTAINER_STOP_TIMEOUT_MS });
    } catch {
    }
  }
  liveVolumes.clear();
}
function removeContainer(dockerBin, name) {
  return new Promise((resolveRemoval) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      forgetContainer(name);
      resolveRemoval();
    };
    const child = spawn2(dockerBin, ["rm", "-f", name], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, CONTAINER_STOP_TIMEOUT_MS);
    child.on("error", done);
    child.on("close", done);
  });
}
var DockerSealedRunner = class {
  id = "docker-sealed";
  sealed = true;
  executions = 0;
  /** the value of `SEALED_RUN_LABEL` on every container this runner starts */
  runToken = randomBytes2(8).toString("hex");
  /**
   * The selection template a targeted request is run with, resolved once and readable.
   *
   * It is part of what this runner IS rather than a private detail: `["%f"]` selects a file and a
   * `%t` form selects one test by name, and which of the two a construction site handed over is the
   * difference between proving our test ran and hoping it did.
   */
  targetedArgs;
  /**
   * What every execution actually runs, resolved once and readable, for the same reason
   * `targetedArgs` is: a construction site that hands over the project's gated test script instead
   * of the runner is the difference between proving a generated test and refusing every one of
   * them, and a test that rebuilt the construction by hand would prove nothing about the seam.
   */
  testCommand;
  /**
   * The directory the install command runs in, resolved once and readable, `null` for the
   * repository root.
   *
   * Readable for the same reason `targetedArgs` and `testCommand` are: installing at the workspace
   * root and installing inside the measured package build two different images from one repository,
   * and which of the two a construction site handed over is not something a caller should have to
   * rebuild a Dockerfile to find out.
   */
  installSubdir;
  /**
   * The directory every execution `cd`s into before the test command, `null` for the repository
   * root.
   *
   * Readable for the same reason {@link installSubdir} is, and now for a second: it used to be
   * derivable from the measured package, and since workspace-root mode it is not. A project whose
   * declaration says its runner runs at the repository root against a root-relative config executes
   * with this null while the measurement is still one package's, so "where did this run execute"
   * became a question a caller can only answer by asking.
   */
  executionSubdir;
  /**
   * What this runner will serve the network from, or null when it serves nothing.
   *
   * Readable for the same reason the three fields above are: whether the sealed container answers a
   * candidate's HTTP calls from a recording or lets them die on a network that is not there is a
   * fact about the run, and a test that rebuilt the container argv by hand to find it out would
   * prove nothing about the seam that builds it.
   */
  replay;
  /**
   * The install command as everything below reads it: an absent one normalizes to empty, and empty
   * is the borrow path rather than a caller mistake.
   *
   * Normalized ONCE, in the constructor, because four separate places read it - the extras
   * detector, the recipe digest, the corepack line and the install line - and a runner where the
   * digest and the Dockerfile disagreed about whether anything installs would be a tag that names
   * an image it is not.
   */
  installCommand;
  /** Where this environment comes from; `rebuilt` unless the caller borrowed a prepared tree. */
  environmentSource;
  /**
   * The cores this host reports, and the `--pids-limit` derived from them.
   *
   * RESOLVED ONCE, in the constructor, because three places read them - the container arguments,
   * the preparation's disclosure block and the notice a denied fork produces - and a run whose
   * disclosure named a ceiling different from the one it enforced would be worse than no field.
   */
  hostCores;
  pidsLimit;
  /**
   * WHICH ROAD WAS ASKED FOR, resolved once in the constructor.
   *
   * Readable for the reason {@link testCommand} is: which of two delivery mechanisms a run used is a
   * fact about the run, and a test that rebuilt the decision by hand would prove nothing about the
   * seam that makes it.
   */
  workspace;
  /**
   * WHICH ROAD WAS ACTUALLY TAKEN, and it is null until {@link prepare} has answered.
   *
   * Asking for the overlay is not getting it. Separate from {@link workspace} on purpose: a run that
   * asked for a mount and executed a copy has to be able to say so, and one field could not.
   */
  #workspaceRoad = null;
  /** Why the overlay road was not taken, in the sentence the run log printed. Null when it was. */
  #workspaceFallback = null;
  /** The overlay volumes this runner created and has not removed, by name. */
  #ownVolumes = /* @__PURE__ */ new Set();
  #volumeSeq = 0;
  /**
   * WHERE EVERY OVERLAY UPPER AND WORK DIRECTORY LIVES, or null on a run that never mounted one.
   *
   * ONE PARENT RATHER THAN SIBLINGS UNDER THE SCRATCH ROOT, because what a container writes into an
   * upper layer it writes AS ROOT, and the host user cannot then remove a root-owned subdirectory:
   * `rmSync` needs write permission on the PARENT of each entry it unlinks, and root's own
   * directories deny it. So the whole subtree is emptied by a container before the host deletes it,
   * and that container needs one path to be handed - see {@link #scrubOverlayScratch}.
   *
   * 0777, INSIDE THE 0700 SCRATCH ROOT. It is `createInputRoot`'s rule again: the sealed container
   * drops `CAP_DAC_OVERRIDE`, so its root is an ordinary user against a host-owned mode, and every
   * directory it must write into has to say so. The process-private root above it is unchanged.
   */
  #overlayScratch = null;
  #options;
  #prepared = null;
  #imageTag = null;
  #scratchRoot = null;
  /**
   * Host path of the chrome-tailored seccomp profile, written once per run and reused by every
   * execution, or null for every runner that needs no browser.
   *
   * Written to disk because `--security-opt seccomp=` takes a FILE and nothing else - there is no
   * inline form - and written once rather than per execution because the profile is a constant of
   * the build, so re-emitting it per candidate would be the same bytes at a new path each time and
   * would make the container arguments differ between two executions that are meant to be
   * identical.
   */
  #browserSeccompPath = null;
  #containerSeq = 0;
  #ownContainers = /* @__PURE__ */ new Set();
  /**
   * Standing the declared services up, ONCE, as a promise every execution awaits.
   *
   * BUILT ONCE PER RUNNER AND NOT ONCE PER EXECUTION. A loop proves many candidates against one
   * environment, and standing a database up per candidate would pay the boot cost every time and,
   * worse, would give each candidate a different database. One namespace for the runner's life is
   * what the customer's own CI gives their suite.
   *
   * A PROMISE RATHER THAN A RESULT, so a startup that FAILED is not retried. Docker names a network
   * and its containers, so a second attempt collides with the first one's leftovers and reports that
   * collision instead of the database's own refusal - and the second execution's reader would be
   * handed a cause that is abloh's rather than theirs. Awaiting the same promise re-throws the first
   * failure, unchanged, to every caller.
   */
  #serviceStartup = null;
  /**
   * The network to remove at dispose, recorded the moment it is created.
   *
   * SEPARATE FROM THE STARTUP ABOVE, because a startup that fails halfway still made one: a network
   * outlives the containers on it and `network rm` is a second call, so the thing that removes it
   * cannot be reached only through a value the failure never returned.
   */
  #serviceNetwork = null;
  /** glob-expansion lines already written to the run log, so each is said once and not per candidate */
  #loggedGlobLines = /* @__PURE__ */ new Set();
  constructor(options) {
    this.#options = options;
    this.installCommand = [...options.installCommand ?? []];
    this.environmentSource = options.environmentSource ?? "rebuilt";
    this.hostCores = detectedHostCores();
    this.pidsLimit = options.pidsLimit ?? sealedPidsLimit(this.hostCores);
    this.targetedArgs = options.targetedArgs ?? ["%f"];
    this.testCommand = [...options.testCommand];
    const declared = normalizeContainerSubdir(options.installSubdir);
    this.installSubdir = declared === void 0 ? options.subdir ?? null : declared;
    this.executionSubdir = options.subdir ?? null;
    this.replay = options.replay ?? null;
    this.workspace = options.workspace ?? sealedWorkspaceDefault();
  }
  /**
   * The road this preparation actually took, or null before {@link prepare} has decided.
   *
   * READ RATHER THAN ASSUMED, for the same reason {@link imageTag} is readable: a caller that wants
   * to know whether this run paid for a build context has exactly one honest source, and it is the
   * runner that built it.
   */
  get workspaceRoad() {
    return this.#workspaceRoad;
  }
  /** The sentence saying why the overlay road was declined, or null when it was not. */
  get workspaceFallback() {
    return this.#workspaceFallback;
  }
  /**
   * What this image carries beyond node: what the runner implies, plus what the repository declared.
   *
   * One method rather than the call repeated at five sites, because the recipe digest and the
   * Dockerfile have to agree exactly - a tag that says "no bun" over an image that has one is the
   * failure the digest exists to prevent.
   */
  #sealedExtras() {
    return sealedExtrasNeeded({
      runner: this.#options.runner,
      ...this.#options.runtimes ? { runtimes: this.#options.runtimes } : {},
      ...this.#options.browser ? { browser: this.#options.browser } : {},
      /*
       * THE SETUP SCRIPT'S OWN COMMANDS COUNT TOO, and this is the correctness half reaching the
       * file the customer edits. A hand-written step spelling `bun install --frozen-lockfile` with
       * no `environment.runtimes` line beside it would otherwise build an image whose very first
       * step cannot run, and the customer would read `bun: not found` from their own file.
       *
       * ONE TOKEN PER LINE, because that is what this detector reads: the binary position, and a
       * step's body is shell rather than argv. Every line is offered, since a three-line step that
       * reaches bun on its second line needs the runtime just as much as one that opens with it.
       */
      commands: [
        this.installCommand,
        this.#options.testCommand,
        ...(this.#options.setupSteps ?? []).flatMap((step) => step.command.split("\n").map((line) => line.trim().split(/\s+/u)[0] ?? "").filter((token) => token !== "").map((token) => [token]))
      ]
    });
  }
  /**
   * The sealed image this runner built or reused, once {@link prepare} has run; null before that.
   *
   * WHY IT IS READABLE. A sealed image is ~3.3 GB, so a caller that builds many of them in sequence
   * has to remove each one before the next. The only other handle is `docker images abloh-marigold`
   * diffed before and after, and that diff is WRONG on a machine where anything else is building at
   * the same time: another run's image appears in the diff and gets deleted out from under it. The
   * tag names exactly what this runner made, so the removal cannot reach anyone else's.
   *
   * It is the tag and never the credential-bearing options, so it is safe to log.
   */
  get imageTag() {
    return this.#imageTag;
  }
  /**
   * What this preparation says about the environment it prepared, for the artifact.
   *
   * The inheritance travels WHOLE here, runner image id included, while only four of its fields
   * reached the digest above. That asymmetry is the design: hash what the environment is, disclose
   * what produced it, so a reader can tell two runs apart on a field that is deliberately not
   * allowed to invalidate anything.
   */
  #environmentDisclosure() {
    return {
      environmentSource: this.environmentSource,
      ...this.#options.inheritedEnvironment === void 0 ? {} : { inherited: this.#options.inheritedEnvironment },
      /* Said on EVERY sealed preparation, borrowed or rebuilt, because the ceiling bound every one
         of them. See `PreparedEnvironment.processCeiling` for why it is disclosed and not hashed. */
      processCeiling: { pidsLimit: this.pidsLimit, hostCores: this.hostCores }
    };
  }
  /** The 0777 parent every overlay directory of this run lives under, created on first use. */
  #ensureOverlayScratch(scratchRoot) {
    if (this.#overlayScratch !== null) return this.#overlayScratch;
    const root = join17(scratchRoot, "overlay");
    mkdirSync6(root, { recursive: true });
    chmodSync(root, 511);
    this.#overlayScratch = root;
    return root;
  }
  /**
   * EMPTY THE OVERLAY SCRATCH FROM INSIDE A CONTAINER, because root wrote it and root has to remove it.
   *
   * THE DEFECT THIS ANSWERS, measured on the `swagger-api/swagger-ui` census fork (run 33980566715):
   * the overlay road ran, the suite passed, and `dispose` then threw
   * `EACCES ... rm '/tmp/abloh-v2-docker-Jb9YHc'` out of the run. Everything the sealed container
   * wrote into an upper layer is owned by root, and a root-owned subdirectory cannot be unlinked by
   * the host user however wide the mode above it is.
   *
   * ONE CONTAINER PER RUN, at dispose, and only for a run that really mounted something. It carries
   * the execution's own posture minus the workspace: `--network none`, `--cap-drop ALL`,
   * `no-new-privileges`, and one bind mount of abloh's own scratch. Nothing of the customer's is
   * reachable from it - the checkout is not mounted, and the directory it empties holds only what
   * this run's own executions wrote.
   */
  async #scrubOverlayScratch() {
    const root = this.#overlayScratch;
    if (root === null) return;
    this.#overlayScratch = null;
    const name = `${CONTAINER_NAME_PREFIX}-scrub-${this.runToken}`;
    await this.#docker(
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        /* THE SAME ONE, for the same reason one directory over: what it removes was written by root
           into directories root then owned, and it reaches abloh's own scratch and nothing else. */
        "--cap-add",
        OVERLAY_WORKSPACE_CAPABILITY,
        "--security-opt",
        "no-new-privileges",
        "-v",
        `${root}:/scrub`,
        this.#imageTag ?? this.#options.image,
        "sh",
        "-c",
        "rm -rf /scrub/..?* /scrub/.[!.]* /scrub/* 2>/dev/null; exit 0"
      ],
      CONTAINER_STOP_TIMEOUT_MS,
      name
    );
  }
  /**
   * THE CAPABILITY CHECK, AND IT IS A MEASUREMENT RATHER THAN A GUESS.
   *
   * The overlay road needs a daemon that can perform an overlayfs mount whose lower layer is this
   * checkout. That is true of a root Docker on a GitHub `ubuntu-latest` runner (overlay2 on ext4,
   * read on the runner in census run 6's follow-up) and false of Docker Desktop on macOS, where the
   * checkout reaches the VM as a virtiofs share overlayfs refuses to stack on.
   *
   * WHY NOT `docker info`. Its `OSType` says `linux` on Docker Desktop too, because the daemon really
   * is a Linux one - it is the FILESYSTEM under the checkout that decides, and no field names it.
   * Sniffing a version string or an operating-system name would be an assumption dressed as a check,
   * and this road may never silently pretend. So the check is the thing itself: one container, one
   * volume, and the two facts the road actually promises - the lower layer is readable, and a write
   * lands in this run's scratch and not in the customer's checkout.
   *
   * IT COSTS A CONTAINER START, about a second, against the 37 to 46 s the road removes. The image
   * it probes with is the BASE image, which both roads need and which is therefore pulled either
   * way, so the probe adds no pull to a run that was going to build anyway.
   */
  async #overlayProbe(scratchRoot) {
    const lower = resolve6(this.#options.repoDir);
    const entries = readdirSync3(lower, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
    const sentinel = entries[0]?.name;
    const sentinelDir = entries.find((entry) => entry.isDirectory())?.name;
    if (sentinel === void 0 || sentinelDir === void 0) {
      return { ok: false, reason: "the checkout has no directory to mount as a lower layer" };
    }
    const probeRoot = join17(this.#ensureOverlayScratch(scratchRoot), "probe");
    const upper = join17(probeRoot, "upper");
    const work = join17(probeRoot, "work");
    mkdirSync6(upper, { recursive: true });
    mkdirSync6(work, { recursive: true });
    chmodSync(probeRoot, 511);
    chmodSync(upper, 511);
    chmodSync(work, 511);
    for (const path of [lower, upper, work]) {
      if (OVERLAY_UNMOUNTABLE_CHARACTERS.test(path)) {
        return { ok: false, reason: `a path in this run carries a character the mount option list cannot hold: ${path}` };
      }
    }
    const marker = `.abloh-overlay-probe-${this.runToken}`;
    const nested = `${sentinelDir}/${marker}`;
    this.#volumeSeq += 1;
    const volume = `${CONTAINER_NAME_PREFIX}-probe-${this.runToken}-${this.#volumeSeq}`;
    const created = await this.#docker(
      ["volume", "create", ...overlayVolumeOptions({ lowerdir: lower, upperdir: upper, workdir: work }), volume],
      CONTAINER_STOP_TIMEOUT_MS
    );
    if (created.exitCode !== 0) {
      return { ok: false, reason: `the daemon refused the overlay volume: ${boundEvidenceTail(`${created.stderr}
${created.stdout}`.trim(), 300)}` };
    }
    rememberVolume(volume, this.#options.dockerBin ?? "docker");
    this.#ownVolumes.add(volume);
    try {
      const probeName = `${CONTAINER_NAME_PREFIX}-probe-${this.runToken}-${this.#volumeSeq}`;
      const ran = await this.#docker(
        [
          "run",
          "--rm",
          "--name",
          probeName,
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--cap-add",
          OVERLAY_WORKSPACE_CAPABILITY,
          "--security-opt",
          "no-new-privileges",
          "-v",
          `${volume}:${CONTAINER_WORKDIR}`,
          this.#options.image,
          "sh",
          "-c",
          `test -e ${shellQuote(`${CONTAINER_WORKDIR}/${sentinel}`)} && : > ${shellQuote(`${CONTAINER_WORKDIR}/${nested}`)}`
        ],
        2 * 6e4,
        probeName
      );
      if (ran.exitCode !== 0) {
        return { ok: false, reason: `this host cannot mount the checkout as an overlay lower layer: ${boundEvidenceTail(`${ran.stderr}
${ran.stdout}`.trim(), 300)}` };
      }
      if (existsSync14(join17(lower, nested))) {
        rmSync3(join17(lower, nested), { force: true });
        return { ok: false, reason: "the probe's write reached the checkout, so the mount is not layered" };
      }
      if (!existsSync14(join17(upper, nested))) {
        return { ok: false, reason: "the probe's write did not land in this run's own scratch" };
      }
      return { ok: true };
    } finally {
      await this.#removeVolume(volume);
    }
  }
  /**
   * The reasons the overlay road is declined BEFORE a probe is spent, each a fact about this run.
   *
   * Two, and neither is a limitation of overlayfs.
   *
   *   1. THE COLD REBUILD LANE'S IMAGE IS THE BUILD. `COPY . /work` is what the customer's own setup
   *      script then installs into, and the installed tree is what makes the image an environment. A
   *      mount would put the checkout in front of the container after the build had finished, with
   *      nothing installed in it.
   *   2. A BROWSER EXECUTION IS HANDED THE TREE INSIDE THE BUILD. `RUN chown -R 65532 /work` is a
   *      build instruction, and the browser lane runs as that uid; doing it through a mount would
   *      copy every file up into the upper layer to change its owner, which is the copy this road
   *      exists to stop paying, at the same price and one layer lower.
   */
  #overlayPrecondition() {
    if (this.environmentSource !== "borrowed") {
      return "this run rebuilds its environment, and the image build is what installs into the tree";
    }
    if (this.#sealedExtras().includes("chromium")) {
      return "a browser execution is handed the tree inside the build, which a mount happens after";
    }
    return null;
  }
  /**
   * Which road this preparation takes, and the sentence for the run log when it is not the one asked
   * for. Called once, from {@link prepare}, before anything is digested or built.
   */
  async #decideWorkspaceRoad(scratchRoot) {
    if (this.workspace === "image") return "image";
    const precondition = this.#overlayPrecondition();
    const declined = precondition ?? await this.#overlayProbe(scratchRoot).then((probe) => probe.ok ? null : probe.reason);
    if (declined === null) {
      this.#options.log?.("test proposals: the sealed workspace is an overlay volume - the checkout is mounted read-only and nothing is copied into an image");
      return "overlay";
    }
    this.#workspaceFallback = declined;
    this.#options.log?.(`test proposals: the sealed workspace falls back to a built image - ${declined}`);
    return "image";
  }
  async prepare() {
    if (this.#prepared !== null) return { ...this.#prepared, reused: true };
    const recipeDigest = structuralDigest2({
      /* THE DOCKERFILE'S OWN VERSION, because the recipe is not only its inputs. The tag decides
         whether a build is SKIPPED, and a change to the file this runner writes - the `ENV CI=true`
         line, say - moves nothing in the fields below, so a machine holding yesterday's image would
         keep handing it to today's runs. Bump this whenever the emitted Dockerfile changes. */
      /*
       * v4 (2026-08-16): the sealed image installs a PINNED BUN when the runner is bun, which it
       * previously carried not at all. DELIBERATE ATTESTATION-SURFACE EVENT - this digest is what
       * decides image reuse, so the bump rebuilds every cached sealed image once and a v3 artifact
       * and a v4 artifact describe different environments at the same commit. That is the intended
       * consequence: an image that can run bun and one that cannot are not the same environment.
       */
      /*
       * v5 (2026-08-18): the same step installs a PINNED DENO when the runner is deno, the bun
       * branch became a table lookup rather than an `if`, and the image can now carry a BROWSER -
       * when the runner is angular-karma it installs Chromium and its sandbox helper, creates a
       * non-root user and gives that user the workspace, because Chrome refuses to run as root
       * without `--no-sandbox` and that flag is the posture Kenneth's ruling of 2026-08-18 refuses.
       * Every such execution then adds a chrome-tailored seccomp profile and a private /dev/shm.
       *
       * DELIBERATE ATTESTATION-SURFACE EVENT, on the same terms as v4: this digest decides image
       * reuse, so the bump rebuilds every cached sealed image once, and a v4 artifact and a v5
       * artifact at the same commit describe different environments. An image that can run deno, or
       * a browser suite, and one that cannot are not the same environment.
       */
      /*
       * v6 (2026-08-24): the image carries the ORDINARY TOOLING a suite shells out to - `git` at
       * minimum, plus a `pnpm` (and, on a base image that lacks one, a `yarn`) that resolves with the
       * network off. The list and the rule that governs it are `SEALED_TOOLCHAIN_BINARIES` in
       * `@abloh/core`; `COREPACK_HOME` moves to an absolute world-readable path in the same step so
       * a non-root execution can read a store the root build wrote.
       *
       * DELIBERATE ATTESTATION-SURFACE EVENT, on the same terms as v4 and v5: this digest decides
       * image reuse, so the bump rebuilds every cached sealed image once, and a v5 artifact and a v6
       * artifact at the same commit describe different environments. They ARE different environments,
       * and that is the whole point - measured 2026-08-23, a package whose tests drive git produced
       * 26 `spawnSync git ENOENT` failures in the v5 image with nothing planted, which is a suite
       * nothing can be measured from.
       */
      /*
       * v7 (2026-08-25): the extra runtimes stopped being a function of the RUNNER alone. The image
       * now installs a pinned bun or deno when `environment.runtimes` names one, whatever the runner
       * is, so a repository that installs with bun but tests with a node runner gets a bun, and one
       * that reaches bun inside its own test script can declare one. The recipe field went from a
       * single value to a sorted list, which is a second reason a v6 tag and a v7 tag never collide.
       *
       * DELIBERATE ATTESTATION-SURFACE EVENT, on the same terms as v4, v5 and v6: this digest
       * decides image reuse, so the bump rebuilds every cached sealed image once, and a v6 artifact
       * and a v7 artifact at the same commit describe different environments. Measured by the
       * 2026-08-24 CI-recipe audit, in a container: `shadcn-ui/ui` died at `sh: 1: bun: not found`
       * inside a suite that had already installed and built cleanly. An image that can run that and
       * one that cannot are not the same environment.
       */
      /*
       * v8 (2026-08-25): the image can carry declared OS PACKAGES - `environment.systemPackages`,
       * pinned by exact version, installed in one apt step in the build. This is the class beneath
       * the runtimes v7 opened: not a language, a system library a native module links against.
       * Measured by stage 6 of the CI-recipe audit and by section 5 of the install-refusal
       * diagnosis - `microsoft/vscode` cannot complete `npm ci` in a stock `node:...-slim` at all,
       * because its native modules need krb5 and X11 headers that are not in the image.
       *
       * DELIBERATE ATTESTATION-SURFACE EVENT, on the same terms as v4 through v7: this digest
       * decides image reuse, so the bump rebuilds every cached sealed image once, and a v7 artifact
       * and a v8 artifact at the same commit describe different environments. The recipe field
       * below is what keeps two repositories declaring different libraries from ever sharing a tag,
       * and what makes an image with a library and one without it two different tags.
       */
      /*
       * v9 (2026-08-26): the image carries a NATIVE FLOOR nobody declares - the node-gyp toolchain
       * (`python3`, `make`, `g++`, `pkg-config`), fonts, and the one measured client library. This
       * is the class BELOW the declared packages v8 opened: not what one repository needs, but what
       * every repository needs and no workflow ever says, because GitHub's runner image already has
       * it. Section 4 of the 2026-08-26 admission diagnosis probed the default proof image and found
       * all four toolchain rows ABSENT, then measured `tailwindlabs/tailwindcss` and `konvajs/konva`
       * failing their install inside it while both installed cleanly on a box that had a toolchain.
       *
       * DELIBERATE ATTESTATION-SURFACE EVENT, on the same terms as v4 through v8: this digest
       * decides image reuse, so the bump rebuilds every cached sealed image once, and a v8 artifact
       * and a v9 artifact at the same commit describe different environments. They are: an image
       * that can compile a native module and one that cannot are not the same environment, and
       * `mermaid-js/mermaid`'s single failure in 5099 tests was a font that was not there.
       */
      /*
       * v10 (2026-08-26): the image can be built around a BORROWED tree - one the caller's own CI
       * installed and built before abloh was invoked - with no install command inside the image at
       * all. Three things move with it, and each is here rather than in a comment because each
       * decides whether two runs may share an image and a carried verdict.
       *
       * DELIBERATE ATTESTATION-SURFACE EVENT, on the same terms as v4 through v9: this digest
       * decides image reuse and carry-forward validity, so the bump rebuilds every cached sealed
       * image once and drops every stored verdict once. That is the intended consequence. An image
       * whose dependency tree arrived from the customer's runner and one whose dependency tree was
       * installed inside the image are not the same environment, and until this version there was
       * no field in the recipe that could say so.
       */
      /*
       * v11 (2026-08-26): the OTHER half of the same day's work. Where a run does rebuild, it
       * rebuilds by running the customer's own `.abloh/setup.sh`, one Dockerfile `RUN` per step, in
       * place of the declared-OS-package step, the conditional `corepack enable` and the install
       * command. Kenneth's ruling: the cold-lane environment answer is an executable file the
       * customer owns, not config abloh re-derives at every run.
       *
       * DELIBERATE ATTESTATION-SURFACE EVENT on the same terms as v10, and it is a SEPARATE version
       * from it because the two shipped as separate changes and a reader has to be able to tell
       * which one an artifact was measured under.
       *
       * The steps are IN the recipe below, so editing one line of the script is a new tag and a new
       * image, and two repositories with different scripts can never share one.
       */
      /*
       * v12 (2026-08-29): a browser reaches the image by DECLARATION rather than only by runner
       * name, and the image pins where a Playwright-driven lane finds one. Two lines move with it:
       * `environment.browser` adds chromium to the extras for any runner, and
       * `PLAYWRIGHT_BROWSERS_PATH` becomes an image `ENV` so the setup phase writes where the
       * measured phase reads. Round 5's wall census (M17) is the measurement: three repositories
       * whose CI has a browser lane, none of whose RUNNERS is `angular-karma`, so no runner-shaped
       * question could ever put a browser in their image.
       *
       * DELIBERATE ATTESTATION-SURFACE EVENT, on the same terms as v4 through v11: this digest
       * decides image reuse and carry-forward validity, so the bump rebuilds every cached sealed
       * image once and drops every stored verdict once. An image whose measured run can launch a
       * browser and one whose cannot are not the same environment, and the `browser` field below is
       * what keeps a repository that declares one from ever sharing a tag with one that does not.
       */
      containerRecipeVersion: 12,
      /* Present only when a browser is declared, so every repository without one keeps the digest it
         had past the one-time v12 rebuild. The runner-implied browser is already in `sealedExtras`
         below, so an `angular-karma` repository is not counted twice and does not move. */
      ...this.#options.browser ? { browser: this.#options.browser } : {},
      /* Present only when a script is declared, so a repository still on the older keys - and every
         borrowed run, which declares none - keeps the digest it had past the one-time v11 rebuild. */
      ...this.#options.setupSteps === void 0 ? {} : { setupSteps: this.#options.setupSteps.map((step) => step.command) },
      /* WHERE THE ENVIRONMENT CAME FROM, in the recipe so a borrowed run and a rebuilt run can
         never share a tag or a carried verdict. This is the last row of the fingerprint table in
         the ambient-build design: a repository that stops borrowing does not inherit verdicts
         earned somewhere else. */
      environmentSource: this.environmentSource,
      /* WHAT A BORROWED RUN INHERITED, and only the four identity fields of it. The runner image
         id is deliberately absent: GitHub reissues its hosted images weekly, and hashing that id
         would drop every customer's carry every week for a change nothing they run can see. See
         `InheritedEnvironment` in `../types.ts` for the measurement behind the split. */
      ...this.#options.inheritedEnvironment === void 0 ? {} : { inherited: inheritedRecipeFields(this.#options.inheritedEnvironment) },
      /*
       * THE PIN THE TOOLCHAIN STEP STOCKS THE COREPACK STORE WITH, in the recipe because it changes
       * what the built image CONTAINS - two repositories pinning two pnpm versions get two different
       * offline stores and may never share a tag.
       *
       * PRESENT ONLY WHERE ONE IS DECLARED, so every unpinned repository keeps the digest it had and
       * this costs it nothing. A pinned one rebuilds once, which is correct: its image now carries a
       * manager version that image never had before.
       *
       * IT IS NOT REDUNDANT WITH `inherited.packageManager` above, which exists only on a BORROWED
       * run. The cold lane pins a store from the same field and would otherwise put the pin in the
       * image without putting it in the tag.
       */
      ...this.#options.declaredPackageManager ? { declaredPackageManager: this.#options.declaredPackageManager } : {},
      image: this.#options.image,
      /* Present only when a script is declared, so a repository still on the old keys keeps the
         digest it had past the one-time v10 rebuild. */
      ...this.#options.setupSteps === void 0 ? {} : { setupSteps: this.#options.setupSteps.map((step) => step.command) },
      /* THE PINNED LIST, IN THE RECIPE, sorted so two spellings of the same declaration are one
         digest. Empty for almost every repository, which costs those repositories nothing beyond
         the one-time v8 rebuild - an empty array is a stable value, not a per-run one. */
      systemPackages: sortedSystemPackages(this.#options.systemPackages ?? []),
      /* WHAT THE IMAGE CARRIES BEYOND NODE, stated rather than inferred from `runner`. Two
         repositories needing the SAME extras share an image layer honestly, and two needing
         different ones can never share a tag. `runner` itself is deliberately not in the recipe:
         jest and vitest produce byte-identical images, and folding the name in would rebuild for a
         difference the image does not have. */
      sealedExtras: this.#sealedExtras(),
      /* THE RECIPE NAMES WHAT THE BUILD RAN. A run with a setup script does not execute this
         command at all, so carrying it here would rebuild an image over a key nobody read - and
         would make the digest a statement about a build that did not happen. */
      installCommand: this.#options.setupSteps === void 0 ? this.installCommand : [],
      /* PART OF THE RECIPE, because they change what the built image CONTAINS. A repository that
         declares none contributes an empty array, which is a stable value and changes no digest
         (junction audit SETUP-09). */
      postInstallCommands: this.#options.setupSteps === void 0 ? (this.#options.postInstallCommands ?? []).map((argv) => [...argv]) : [],
      testCommand: this.#options.testCommand,
      subdir: this.#options.subdir ?? null,
      /* Part of the recipe, because it changes what the built image CONTAINS: the same repository
         installed at its root and installed inside one package are two different environments, and
         a tag that could not tell them apart would hand one run the other's image. It is the
         RESOLVED value, so a recipe that names no install directory keeps the digest it had. */
      installSubdir: this.installSubdir,
      syntheticEnvironment: this.#options.syntheticEnvironment ?? {}
    });
    const scratchRoot = mkdtempSync2(join17(tmpdir2(), "abloh-v2-docker-"));
    this.#scratchRoot = scratchRoot;
    if (this.#sealedExtras().includes("chromium")) {
      this.#browserSeccompPath = join17(scratchRoot, "chrome-seccomp.json");
      writeFileSync6(this.#browserSeccompPath, JSON.stringify(chromeSeccompProfile()));
    }
    const road = await this.#decideWorkspaceRoad(scratchRoot);
    this.#workspaceRoad = road;
    const overlay = road === "overlay";
    const contextDir = overlay ? mkdtempSync2(join17(scratchRoot, "empty-context-")) : resolve6(this.#options.repoDir);
    const tag = overlay ? sealedWorkspaceImageTag(recipeDigest) : sealedImageTag({ recipeDigest, contextDigest: buildContextDigest(contextDir) });
    this.#imageTag = tag;
    const inspect = await this.#docker(["image", "inspect", tag], 6e4);
    if (inspect.exitCode === 0) {
      this.#prepared = { recipeDigest, reused: true, sealed: true, runnerId: this.id, runner: this.#options.runner, ...this.#environmentDisclosure() };
      return this.#prepared;
    }
    const dockerfile = join17(this.#scratchRoot, "Dockerfile");
    const installWorkdir = this.installSubdir ? `${CONTAINER_WORKDIR}/${this.installSubdir}` : CONTAINER_WORKDIR;
    const sealedExtras = this.#sealedExtras();
    const systemPackages = sortedSystemPackages(this.#options.systemPackages ?? []);
    const mountedSecrets = this.#mountedSecretNames();
    const secretFlags = buildSecretMountFlags(mountedSecrets);
    const secretPrelude = buildSecretPrelude(mountedSecrets);
    const runStep = (command, plain) => mountedSecrets.length === 0 ? plain : `RUN ${secretFlags} ${JSON.stringify(["sh", "-c", `${secretPrelude}
${command}`])}`;
    writeFileSync6(
      dockerfile,
      [
        `FROM ${this.#options.image}`,
        /*
         * CI=true, the same value the host path already sets for the customer's own commands
         * (`buildCustomerProcessEnvironment`, in the CLI and in the environment contract).
         *
         * It is not a convenience. This IS continuous integration - a non-interactive build with no
         * terminal - and a package manager that discovers that for itself behaves differently from
         * one that is told. pnpm asked to reconcile an incompatible modules directory it found in
         * the copied tree stops with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` and prints "If you
         * are running pnpm in CI, set the CI environment variable to true" - so every pnpm
         * repository failed sealed preparation here unless its `abloh.yml` spelled
         * `env CI=true corepack pnpm install ...` by hand, while the classic layer had been running
         * with CI=true all along. Two paths, one repository, two answers.
         */
        "ENV CI=true",
        /*
         * THE LOCALE, DECLARED RATHER THAN INHERITED, for the same reason `TZ` is already treated as
         * evidence-bearing: a snapshot that renders a time renders it in a locale.
         *
         * Measured 2026-08-18 on `Rocket.Chat.ReactNative`: two arms differing by nothing but `LANG`
         * differed by 111 tests. `en_GB` makes Node resolve a 24-hour clock, and 106 React Native
         * snapshots that render a timestamp mismatched on `10:00:00` versus `10:00:00 AM`. React
         * Native suites lean on snapshots far more than the library repositories the runner-reach
         * work measured, so this stopped being a curiosity on that date.
         *
         * The sealed image ALREADY behaves this way and that is precisely the problem: with no LANG
         * set at all, Node's full-icu build defaults to `en-US` and all 412 snapshots passed - by
         * accident, through environment scrubbing, and only for as long as no base image ever sets
         * LANG itself. This line changes no observed behaviour and makes the behaviour a decision.
         */
        "ENV LANG=en_US.UTF-8",
        /*
         * THE ORDINARY TOOLING A SUITE SHELLS OUT TO.
         *
         * A stock `node:...-slim` carries no `git` and no `pnpm`. Measured 2026-08-23: a package
         * whose own tests drive git ran 92 tests in this image with ZERO candidate files present and
         * produced 26 failures, every one of them `spawnSync git ENOENT` - a suite nothing can be
         * measured from, and one the exit proof then read as the candidate's fault. The 2026-08-24
         * study measured `nypm` at 0 of 10 for the package-manager half of the same hole.
         *
         * `COREPACK_HOME` is declared BEFORE the step that populates it and stays set for the run, so
         * the store the root build writes is the store the execution reads. It is the same fix
         * `sandbox/container.ts` applies through `PREPARED_COREPACK_HOME`, at an absolute path
         * because corepack's default lives under `$HOME` and the two processes do not share one.
         *
         * The list, and the rule that decides what may join it, are in `@abloh/core`
         * (`sealed-runtime.ts`, `SEALED_TOOLCHAIN_BINARIES`) - the same file the runtimes live in,
         * because "what does the sealed image carry" is one question. Both steps are guarded, so
         * neither replaces a tool a customer's own `proofImage` already chose to carry.
         *
         * BEFORE `COPY`, so the layer is shared by every repository on this base image AND THE SAME
         * `packageManager` PIN rather than rebuilt per repository - the same placement, for the same
         * reason, as the runtime step. The pin narrows the sharing and it has to: since the census
         * wave-3 fix this step stocks the store with the version the repository declared, so two
         * repositories on two pins genuinely have two different images and a shared layer between
         * them would be a lie the tag could not tell.
         */
        `ENV COREPACK_HOME=${SEALED_COREPACK_HOME}`,
        /* EXEC FORM, because the script is multi-line. A Dockerfile instruction ends at an
           unescaped newline even inside quotes, so the shell form would truncate it; the JSON array
           carries the newlines escaped, which is the same shape `sandbox/preparation.ts` uses for
           every step it writes. */
        `RUN ${JSON.stringify(["sh", "-c", sealedToolchainCommand(this.#options.declaredPackageManager ?? null)])}`,
        /*
         * THE NATIVE FLOOR: the build toolchain and the fonts every proof image carries.
         *
         * IMMEDIATELY AFTER THE TOOLCHAIN AND BEFORE EVERYTHING ELSE, for one reason: `npm ci` is
         * where native modules compile, and a compiler that arrives after the install arrives after
         * the thing that needed it. It is the same placement argument the declared-package step
         * below makes, one layer earlier - this list is the SAME BYTES for every repository on a
         * given base image, so it belongs above the per-repository step where a shared Docker layer
         * cache can keep it.
         *
         * The list and every row's measurement are in `@abloh/core` (`native-floor.ts`). It is
         * unpinned and best-effort by design, on the same terms as the `git` step above it.
         */
        `RUN ${JSON.stringify(["sh", "-c", nativeFloorCommand()])}`,
        /*
         * A RUNTIME THE BASE IMAGE DOES NOT HAVE, installed pinned, before anything asks for it.
         *
         * This image is built `FROM` the environment contract's proof image, which by default is a
         * stock `node:...-slim`. That is everything a node-runner repository needs and nothing a bun
         * one does: measured on elysiajs/elysia-jwt (2026-08-16), a bun repository's sealed build
         * died `/bin/sh: 1: bun: not found` on its own declared install command, so v2's proof and
         * its planted-bug pool were unreachable for every bun repository while v1 measured them
         * perfectly well. DENO joined on 2026-08-18 with the identical shape, and it joined as a ROW
         * rather than a second branch - which is what `sealedRuntimeNeeded` was written to make
         * possible, and the one place that prediction can be checked.
         *
         * IT IS A LIST NOW, AND NOT BECAUSE TWO RUNTIMES ARE EVER NEEDED AT ONCE. It is a list
         * because the question stopped being "which runtime does this runner need" on 2026-08-25:
         * `environment.runtimes` lets a repository whose runner is a node one declare the bun its
         * install command runs, or the bun its own test script reaches three levels down. Emitting
         * one step per entry is what keeps that from becoming a second branch beside this one.
         *
         * The version and the package name live in `@abloh/core` (`sealed-runtime.ts`) because the
         * PREPARED scenario image pins the same runtimes and two images running different versions
         * is a difference nothing would report. The step is a node program rather than a shell line
         * so bun's per-architecture package is chosen from `process.arch` INSIDE the build - a name
         * chosen on the host would install an x64 binary into an arm64 image that cannot execute it -
         * and so both runtimes verify their own symlink in the step that created it.
         *
         * It runs BEFORE `COPY`, so the layer is shared by every repository using this base image
         * rather than rebuilt per repository, and long before the install command that needs it.
         */
        ...sealedExtras.filter((extra) => extra !== "chromium").map((runtime) => `RUN node -e ${shellQuote(sealedRuntimeInstallProgram(runtime))}`),
        /*
         * A BROWSER, AND A USER TO RUN IT AS.
         *
         * Both halves are needed and neither is sufficient. `chromium-sandbox` is a separate
         * package carrying the sandbox helper - without it Chrome reports `No usable sandbox!` and
         * refuses to start as a non-root user - and the fonts stop a suite asserting on rendered
         * text from failing on blank boxes. The user exists because Chrome refuses outright to run
         * as root without `--no-sandbox`, which is the posture this image is built to avoid.
         *
         * `--no-install-recommends` because the recommends of chromium pull in a desktop session,
         * and the apt lists are removed in the same layer so they are never part of the image.
         *
         * BEFORE `COPY`, so the layer is shared by every repository on this base image rather than
         * rebuilt per repository - the same placement, for the same reason, as the bun step above.
         */
        ...this.#sealedExtras().includes("chromium") ? [
          `RUN apt-get update && apt-get install -y --no-install-recommends ${SEALED_CHROMIUM_PACKAGES.join(" ")} && rm -rf /var/lib/apt/lists/*`,
          /* karma-chrome-launcher resolves the browser from CHROME_BIN and, failing that,
             searches for a `google-chrome` that a Debian chromium package does not provide. */
          `ENV CHROME_BIN=${SEALED_CHROME_BIN}`,
          /*
           * WHERE A PLAYWRIGHT-DRIVEN LANE FINDS ITS BROWSER, and the line without which the
           * whole vitest-browser lane is cold.
           *
           * The identical shape as `DENO_DIR` below, and it is here because that one was
           * learned the hard way on 2026-08-25: playwright's default browser directory is
           * `$HOME/.cache/ms-playwright`, the build runs as root and the measurement runs as
           * uid 65532, so a browser downloaded during the build would land somewhere the
           * measured run cannot read - and inside `--network none` the lane cannot fetch a
           * second copy. An absolute, world-readable path outside `/work` is read by both.
           *
           * SET AS AN IMAGE `ENV` so ONE constant serves both phases: the customer's own
           * `playwright install chromium` step inherits it during the build, which is the phase
           * that still has a network, and every execution afterwards reads what that step
           * wrote. The run re-asserts it after the declared variables, because a repository
           * whose own CI sets `PLAYWRIGHT_BROWSERS_PATH` - `vitejs/vite` does - would otherwise
           * point the measured run at a directory this image never had.
           */
          `ENV PLAYWRIGHT_BROWSERS_PATH=${SEALED_PLAYWRIGHT_BROWSERS_PATH}`,
          `RUN mkdir -p ${SEALED_PLAYWRIGHT_BROWSERS_PATH} && chmod 755 ${SEALED_PLAYWRIGHT_BROWSERS_PATH}`,
          `RUN id -u ${SEALED_BROWSER_UID} >/dev/null 2>&1 || useradd -u ${SEALED_BROWSER_UID} -m -s /usr/sbin/nologin abloh`
        ] : [],
        /*
         * WHERE A SEALED DENO RUN KEEPS ITS MODULE CACHE, and the line without which the whole deno
         * sealed lane is cold.
         *
         * `SEALED_DENO_DIR` has existed in `@abloh/core` since 2026-08-18 with the measurement
         * beside it, and until 2026-08-25 NOTHING SET IT. deno's default cache is `$HOME/.cache/deno`,
         * the sealed container runs `--read-only` with a tmpfs only at `/tmp`, and the sealed deno
         * command is `deno test --cached-only`. So the build populated a cache under `/root` that the
         * run could not read, and every `jsr:` or `npm:` specifier failed by name inside
         * `--network none` - the build's failure arriving as a run failure.
         *
         * OUTSIDE `/work`, which the first real container run is what taught. `deno test` discovers
         * its specs by walking the directory it runs in, so a cache under the checkout hands the
         * customer's suite every `*.test.js` a dependency ships; `denoland/deno_doc` was measured
         * against `universal-github-app-jwt`'s own deno test. The constant carries the error.
         *
         * BEFORE `COPY`, so it is set for the install command that populates it and stays set for
         * every execution afterwards.
         */
        /*
         * THE DECLARED OS PACKAGES, and the two placement decisions in this one line.
         *
         * BEFORE `COPY` AND BEFORE THE INSTALL COMMAND, because that is what the packages are FOR: a
         * native module compiles during `npm ci`, and a header that arrives after the install
         * arrives after the thing that needed it. `microsoft/vscode` is the shape - its install
         * cannot complete in a stock `node:...-slim` at all - and section 5 of the install-refusal
         * diagnosis is the measurement.
         *
         * AFTER the toolchain, runtime and browser steps above rather than first, which is a cache
         * decision and not a correctness one. Those steps are the same bytes for every repository on
         * a given base image, so a Docker layer cache shared across repositories keeps them; this
         * step is per-repository, and a per-repository instruction placed above universal ones would
         * invalidate the universal layers for everybody.
         *
         * ROOT, AND ONLY HERE. This is the build - which has run as root since the image shipped,
         * and has a network by design. Every execution below is unchanged: `--network none`,
         * `--cap-drop ALL`, `no-new-privileges`, non-root uid. Nothing reads this list after the
         * build, so there is no test-time path to it.
         *
         * `systemPackageInstallCommand` re-validates every operand and throws rather than emitting a
         * line, so no unchecked string reaches this shell.
         */
        /* SKIPPED ENTIRELY under a setup script: an `apt-get` the customer's own file runs is a step
           in that file, and running it here as well would install the same libraries twice from two
           different sources of truth. */
        ...systemPackages.length > 0 && this.#options.setupSteps === void 0 ? [`RUN ${JSON.stringify(["sh", "-c", systemPackageInstallCommand(systemPackages)])}`] : [],
        ...sealedExtras.includes("deno") ? [`ENV DENO_DIR=${SEALED_DENO_DIR}`] : [],
        `WORKDIR ${CONTAINER_WORKDIR}`,
        /*
         * THE TREE ARRIVES HERE, OR IT ARRIVES AT EXECUTION TIME.
         *
         * On the image road this is `COPY . /work` and the image IS the checkout. On the overlay
         * road the same path is a bare mount point and the checkout is the read-only lower layer of
         * a volume created per execution - so the instruction is absent rather than emptied, and the
         * image built here is the same bytes for every repository sharing this recipe.
         */
        ...overlay ? [] : [`COPY . ${CONTAINER_WORKDIR}`],
        `WORKDIR ${installWorkdir}`,
        /*
         * THE BUILD, FROM THE CUSTOMER'S FILE OR FROM THE OLD KEYS, and never from both.
         *
         * With a script: one `RUN` per step, in the script's order, each carrying that step's own
         * comment so a reader of the Dockerfile and a reader of the repository see the same recipe.
         * `sh -c` in EXEC form because a step's body may be several lines and a Dockerfile
         * instruction ends at an unescaped newline in shell form.
         *
         * Without one: exactly what shipped before - which for a BORROWED tree is nothing at all,
         * because its install command is empty by construction.
         */
        ...this.#options.setupSteps !== void 0 ? this.#options.setupSteps.flatMap((step, index) => [
          `# ${setupStepMarker(index + 1, step.what, step.source)}`,
          runStep(step.command, `RUN ${JSON.stringify(["sh", "-c", step.command])}`)
        ]) : [
          /* Corepack ENABLED, not merely invoked. `installCommandNeedsCorepackEnable` carries the
             whole mechanism: without this line the delegated package manager installs the tree and
             then the repository's own lifecycle script cannot find the binary that installed it. */
          ...installCommandNeedsCorepackEnable(this.installCommand) ? ["RUN corepack enable"] : [],
          ...this.installCommand.length > 0 ? [runStep(
            this.installCommand.map(shellQuote).join(" "),
            `RUN ${this.installCommand.map(shellQuote).join(" ")}`
          )] : [],
          /* AND THE LEGACY SETUP COMMANDS, AFTER THE INSTALL AND IN THEIR DECLARED ORDER
             (junction audit SETUP-09, 2026-08-28). The contract signed them, its own field
             comment promised the image would run them, and nothing did - so a repository on the
             older keys proved candidates in an environment its policy said it would not have.
             EXEC form with each operand quoted, exactly as the install command above: these are
             already parsed argv, never a shell string. */
          ...(this.#options.postInstallCommands ?? []).map(
            (argv) => runStep(argv.map(shellQuote).join(" "), `RUN ${argv.map(shellQuote).join(" ")}`)
          )
        ],
        /*
         * THE WORKSPACE CHANGES HANDS, LAST.
         *
         * The build runs as root and the proof does not, so everything COPYed and everything the
         * install produced is root-owned while the container runs as uid 65532. An Angular karma
         * suite writes inside the workspace before it can run a test: the builder emits its spec
         * bundle to `dist/test-out` and its cache to `.angular`, and a read-only workspace fails
         * with `EACCES: permission denied, mkdir`. So the tree is handed to the user that will run
         * it, after the install rather than before, so the install still runs as the user that
         * populated the cache.
         */
        ...this.#sealedExtras().includes("chromium") ? [
          `RUN chown -R ${SEALED_BROWSER_UID}:${SEALED_BROWSER_UID} ${CONTAINER_WORKDIR}`,
          /* AND THE BROWSER DIRECTORY IS MADE READABLE, after the setup steps rather than
             before, because the setup step is what put anything in it. Playwright's own
             extraction leaves some trees 0700 under the uid that ran it - which is root, and the
             measurement is not root - so a browser that downloaded correctly would still fail to
             launch. `a+rX` grants read everywhere and execute only where execute already is,
             which is the difference between making a directory traversable and making every
             file in it runnable. */
          `RUN chmod -R a+rX ${SEALED_PLAYWRIGHT_BROWSERS_PATH}`
        ] : []
      ].join("\n") + "\n"
    );
    if (this.environmentSource === "borrowed" && !overlay) {
      writeFileSync6(
        `${dockerfile}.dockerignore`,
        "# Abloh borrows the tree your CI built, whole. Nothing is excluded.\n"
      );
    }
    const build = await this.#docker(
      [
        "build",
        "--network",
        "default",
        /*
         * THE SECRETS, BY NAME, READ OUT OF THIS PROCESS'S OWN ENVIRONMENT BY BUILDKIT.
         *
         * `env=NAME` is what makes the whole lane true: the value goes from the customer's shell to
         * the daemon without abloh copying it into a variable, a file, or a field of any object it
         * owns. Nothing here is written to disk and nothing is kept after the build.
         *
         * Emitted only when there is something to mount, so a repository with no declared variables
         * invokes the same command line it always did.
         */
        ...mountedSecrets.flatMap((name) => ["--secret", `id=${name},env=${name}`]),
        "-f",
        dockerfile,
        "-t",
        tag,
        contextDir
      ],
      30 * 6e4,
      void 0,
      /*
       * BUILDKIT EXPLICITLY, and only where a secret depends on it. Docker 23 and newer use buildx
       * by default and this changes nothing for them. An older client would otherwise fall to the
       * legacy builder, which does not know `--secret` and would refuse the flag rather than run the
       * build. Setting it makes the failure "this daemon cannot do BuildKit" rather than "abloh
       * passed an unknown flag".
       */
      mountedSecrets.length === 0 ? void 0 : { DOCKER_BUILDKIT: "1" }
    );
    if (build.exitCode !== 0) {
      const registry = readRegistryAuthFailure(`${build.stderr}
${build.stdout}`);
      if (registry !== null) {
        throw new EngineUnavailableError(
          "registry-authentication-failed",
          registryAuthRefusal({
            failure: registry,
            unavailable: this.#unavailableSecretNames(),
            supplied: mountedSecrets
          })
        );
      }
      const setup = this.#setupFailure(build.stdout, build.stderr);
      if (setup !== null) throw new EngineUnavailableError("setup-step-failed", setup);
      throw new EngineUnavailableError(
        "sealed-preparation-failed",
        `test proposals sealed preparation failed: ${dockerBuildFailureEvidence(build.stdout, build.stderr)}`
      );
    }
    this.#prepared = { recipeDigest, reused: false, sealed: true, runnerId: this.id, runner: this.#options.runner, ...this.#environmentDisclosure() };
    return this.#prepared;
  }
  /**
   * The declared variable names this machine has a value for, sorted, validated.
   *
   * A name that is not a portable environment-variable name is REFUSED rather than emitted: it
   * would reach a Dockerfile instruction and a `docker build` flag unquoted, and a policy that
   * somehow carried one must not be able to turn that into shell. The policy schema already refuses
   * the same shapes, so this throwing is a seam check and not the only one.
   */
  #mountedSecretNames() {
    return this.#secretNames((entry) => entry.available);
  }
  /** The declared names abloh had no value for here, which is every one of them on our own machines. */
  #unavailableSecretNames() {
    return this.#secretNames((entry) => !entry.available);
  }
  /**
   * EVERY DECLARED NAME IS VALIDATED, NOT ONLY THE ONES BEING RETURNED, and the reason is the order
   * these two accessors are called in.
   *
   * `#mountedSecretNames` runs while the Dockerfile is written, before anything is built.
   * `#unavailableSecretNames` runs only after a build has already FAILED. Validating each accessor's
   * own slice would mean a malformed unavailable name threw for the first time on the failure path,
   * replacing the customer's real build failure with a message about a name that was never emitted.
   * Validating the whole list on the first call puts the throw where it belongs: before the build.
   */
  #secretNames(keep) {
    const declared = this.#options.buildSecrets ?? [];
    for (const entry of declared) {
      if (!BUILD_SECRET_NAME.test(entry.name)) {
        throw new Error(`build secret ${JSON.stringify(entry.name)} is not a portable environment-variable name`);
      }
    }
    return [...new Set(declared.filter(keep).map((entry) => entry.name))].sort();
  }
  /**
   * WHICH SETUP STEP STOPPED THIS BUILD, and the sentence the customer reads for it.
   *
   * HOW THE STEP IS IDENTIFIED. Buildkit fences the failing instruction between `------` rules and
   * opens it with ` > [7/9] RUN <the command>:`. Every step here was emitted as its own `RUN` with
   * a `sh -c` body, so the command in that header is the step's body verbatim and matching it back
   * is a lookup rather than a guess. The exit code comes from buildkit's own
   * `did not complete successfully: exit code: N`.
   *
   * NULL RATHER THAN A GUESS whenever the failure is not one of these steps: a base image that
   * cannot be pulled, a `COPY` that fails, a daemon that died. Those are abloh's problems and must
   * not be reported to a customer as a line in their file. The caller falls back to the ordinary
   * build evidence.
   */
  #setupFailure(stdout, stderr) {
    const steps = this.#options.setupSteps;
    if (steps === void 0 || steps.length === 0) return null;
    const output = `${stderr}
${stdout}`;
    const fence = output.lastIndexOf("\n > ");
    const region = fence === -1 ? output : output.slice(fence);
    let failed = -1;
    let at = -1;
    steps.forEach((step, index) => {
      const position = region.lastIndexOf(step.command);
      if (position > at || position === at && position !== -1 && step.command.length > steps[failed].command.length) {
        at = position;
        failed = index;
      }
    });
    if (failed === -1 || at === -1) return null;
    const exitCode = Number.parseInt(
      /did not complete successfully: exit code: (\d+)/u.exec(output)?.[1] ?? "1",
      10
    );
    return renderSetupFailure({
      steps,
      stepNumber: failed + 1,
      exitCode,
      path: this.#options.setupScriptPath ?? SETUP_SCRIPT_PATH
    });
  }
  /**
   * Stand up the declared services once, and hand back the namespace every execution joins.
   *
   * NULL IS THE ANSWER FOR ALMOST EVERY REPOSITORY, and it is the answer that keeps `--network none`
   * the default: a repository that declares no service still runs with no network at all.
   *
   * WHY IT IS HERE RATHER THAN IN `prepare`. Preparation builds an image and can be reused across
   * runs; a running database cannot. Tying the namespace to the first execution means a run that
   * never executes anything - every gap refused upstream, every candidate declined - never starts a
   * database it will not use.
   *
   * A FAILURE HERE IS AN ENGINE FAILURE, not a candidate failing. It is raised rather than returned,
   * so the loop reports the engine `unavailable` with the service named instead of scoring a
   * repository over a suite that could not reach its own database.
   */
  async #ensureServiceNamespace(image) {
    const declared = this.#options.services ?? [];
    if (declared.length === 0) return null;
    this.#serviceStartup ??= this.#startServices(declared, image);
    return this.#serviceStartup;
  }
  /** The startup itself, run exactly once through {@link DockerSealedRunner.#ensureServiceNamespace}. */
  async #startServices(declared, image) {
    const validated = validatedSealedServices(declared);
    if (!validated.ok) {
      throw new EngineUnavailableError(
        "declared-service-unavailable",
        `the environment contract's services could not be read: ${validated.problem}`
      );
    }
    const services = validated.services;
    const dockerBin = this.#options.dockerBin ?? "docker";
    const label = `${SEALED_RUN_LABEL}=${this.runToken}`;
    const network = `abloh-svc-${this.runToken}`;
    const holderName = `${CONTAINER_NAME_PREFIX}-svc-${this.runToken}`;
    const created = await this.#docker(serviceNetworkArgs({ network, label }), 3e4);
    if (created.exitCode !== 0) {
      throw new EngineUnavailableError(
        "engine-error",
        `the service network could not be created: ${boundEvidenceTail(created.stderr.trim(), 200)}`
      );
    }
    rememberNetwork(network, dockerBin);
    this.#serviceNetwork = network;
    const holder = await this.#createAndStart({
      name: holderName,
      dockerBin,
      args: serviceNamespaceHolderArgs({
        name: holderName,
        network,
        image,
        aliases: services.map((service) => service.name),
        label
      })
    });
    if (!holder.ok) {
      throw new EngineUnavailableError("engine-error", `the service namespace failed at ${holder.detail}`);
    }
    for (const [index, service] of services.entries()) {
      const volumes = await this.#docker(
        ["image", "inspect", "--format", "{{json .Config.Volumes}}", service.ref],
        3e4
      );
      const name = `${CONTAINER_NAME_PREFIX}-svc-${this.runToken}-${index}-${service.name}`;
      const container = await this.#createAndStart({
        name,
        dockerBin,
        args: serviceContainerArgs({
          name,
          service,
          holder: holder.id,
          writablePaths: serviceWritablePathsFrom(volumes.exitCode === 0 ? volumes.stdout : ""),
          label
        })
      });
      if (!container.ok) {
        throw new EngineUnavailableError(
          "declared-service-unavailable",
          `declared service ${service.name} failed at ${container.detail}`
        );
      }
      await this.#awaitService(service, name, holder.id);
    }
    this.#options.log?.(
      `marigold: ${services.length} declared service(s) reachable on localhost inside the sealed run (${services.map((service) => service.name).join(", ")})`
    );
    return { holder: holder.id };
  }
  /**
   * `docker create` then `docker start`, registered for the sweep between the two.
   *
   * IT ANSWERS RATHER THAN RAISING, because whose failure this is depends on which container it was:
   * the holder is abloh's own and a service is the repository's declaration, and one sentence for
   * both would tell a customer abloh broke when their database refused its own configuration. The
   * caller has the code and raises it.
   */
  async #createAndStart(input) {
    rememberContainer(input.name, input.dockerBin);
    this.#ownContainers.add(input.name);
    const created = await this.#docker(input.args, 5 * 6e4);
    if (created.exitCode !== 0) {
      return { ok: false, detail: `create: ${boundEvidenceTail(created.stderr.trim(), 200)}` };
    }
    const id = created.stdout.trim();
    if (!/^[a-f0-9]{64}$/u.test(id)) {
      return { ok: false, detail: "create: Docker named no container identity" };
    }
    const started = await this.#docker(["start", input.name], 6e4);
    if (started.exitCode !== 0) {
      return { ok: false, detail: `start: ${boundEvidenceTail(started.stderr.trim(), 200)}` };
    }
    return { ok: true, id };
  }
  /**
   * Wait until one declared service answers, by whichever signal the declaration gave.
   *
   * TWO SIGNALS, IN THE ORDER THE DECLARATION OFFERS THEM. A workflow's own `--health-cmd` is what
   * GitHub waits on, so abloh waits on the same thing, run by Docker inside the service container. A
   * declaration with no health command is waited on by connecting to the port it listens on, from
   * inside the shared namespace - the same connection the suite is about to make.
   */
  async #awaitService(service, containerName, holder) {
    const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const running = await this.#docker(["inspect", "--format", "{{.State.Running}}", containerName], 15e3);
      const health = service.healthCommand === null ? null : (await this.#docker(["inspect", "--format", "{{.State.Health.Status}}", containerName], 15e3)).stdout;
      const probe = service.healthCommand !== null ? null : (await this.#docker(serviceTcpProbeArgs({ holder, port: service.healthPort ?? 0 }), 2e4)).exitCode === 0;
      const verdict = serviceReadyVerdict({
        running: running.exitCode === 0 ? running.stdout : "",
        health,
        probeConnected: probe
      });
      if (verdict === "ready") return;
      if (verdict === "exited") {
        const logs = await this.#docker(["logs", "--tail", "20", containerName], 15e3);
        throw new EngineUnavailableError(
          "declared-service-unavailable",
          `declared service ${service.name} exited before it was ready: ` + boundEvidenceTail(`${logs.stdout}
${logs.stderr}`.trim(), 400)
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, SERVICE_READY_POLL_MS));
    }
    throw new EngineUnavailableError(
      "declared-service-unavailable",
      `declared service ${service.name} did not become ready within ${Math.round(SERVICE_READY_TIMEOUT_MS / 1e3)}s`
    );
  }
  async execute(request) {
    const started = Date.now();
    if (this.#prepared === null) await this.prepare();
    const tag = this.#imageTag;
    const scratchRoot = this.#scratchRoot;
    if (tag === null || scratchRoot === null) throw new Error("the test-proposals sealed runner was not prepared");
    const namespace = await this.#ensureServiceNamespace(tag);
    const opened = this.#workspaceRoad === "overlay" ? await this.#openWorkspaceVolume(scratchRoot) : null;
    if (opened !== null && !opened.ok) return this.#failed(opened.reason, started);
    const workspaceVolume = opened === null ? null : opened.name;
    const inputRoot = createInputRoot(scratchRoot);
    try {
      const placements = [];
      for (const gap of request.patches) {
        const absolute = join17(resolve6(this.#options.repoDir), gap.file);
        if (!existsSync14(absolute)) return this.#failed(`patched file is absent: ${gap.file}`, started);
        const patched = applyGapPatch(readFileSync15(absolute, "utf8"), gap);
        if (!patched.ok) return this.#failed(patched.reason, started);
        writeInput(inputRoot, gap.file, patched.source);
        placements.push({ relative: gap.file });
      }
      for (const file of request.files) {
        writeInput(inputRoot, file.path, file.source);
        placements.push({ relative: file.path });
      }
      const replay = this.#options.replay;
      if (replay !== void 0) writeInput(inputRoot, REPLAY_PRELOAD_NAME, readFileSync15(replay.preloadPath, "utf8"));
      const targeted = request.mode === "targeted" && request.testFile !== void 0;
      const requestedPath = targeted ? runnerRelativeTestFile({ testFile: request.testFile, executionSubdir: this.executionSubdir }) : "";
      if (targeted) {
        assertTargetedSpecIsPlaced({
          testFile: request.testFile,
          requestedPath,
          placed: placements.map((placement) => placement.relative),
          existsInTree: (relative5) => existsSync14(join17(resolve6(this.#options.repoDir), relative5))
        });
      }
      const declaredArgv = targeted ? [
        ...this.#options.testCommand,
        ...substituteTargetedArgs({
          targetedArgs: this.targetedArgs,
          testFile: request.testFile,
          executionSubdir: this.executionSubdir,
          testName: request.testName
        })
      ] : [...this.#options.testCommand];
      const executionDir = this.executionSubdir === null ? resolve6(this.#options.repoDir) : join17(resolve6(this.#options.repoDir), this.executionSubdir);
      const expansion = expandCommandGlobs2(declaredArgv, executionDir, {
        extraPaths: placements.map(
          (placement) => runnerRelativeTestFile({ testFile: placement.relative, executionSubdir: this.executionSubdir })
        )
      });
      const testArgv = expansion.argv;
      for (const line of describeCommandGlobExpansions(expansion)) {
        if (this.#loggedGlobLines.has(line)) continue;
        this.#loggedGlobLines.add(line);
        this.#options.log?.(line);
      }
      const script = [
        "set -e",
        ...placements.map(
          (placement) => `mkdir -p "$(dirname ${shellQuote(`${CONTAINER_WORKDIR}/${placement.relative}`)})" && cp ${shellQuote(
            `${INPUT_MOUNT}/${placement.relative}`
          )} ${shellQuote(`${CONTAINER_WORKDIR}/${placement.relative}`)}`
        ),
        /* THE SAME `executionSubdir` the argv above was made relative to, and read from the same
           field for that reason: these two lines are one decision and a second copy of it is how
           the sweep's 55-of-55 happened. */
        `cd ${shellQuote(this.executionSubdir === null ? CONTAINER_WORKDIR : `${CONTAINER_WORKDIR}/${this.executionSubdir}`)}`,
        `exec ${testArgv.map(shellQuote).join(" ")}`
      ].join("\n");
      this.#containerSeq += 1;
      const containerName = `${CONTAINER_NAME_PREFIX}-${this.runToken}-${this.#containerSeq}`;
      const browserProfile = this.#browserSeccompPath;
      const argv = [
        "run",
        "--rm",
        "--name",
        containerName,
        "--label",
        `${SEALED_RUN_LABEL}=${this.runToken}`,
        /*
         * A REAL PROCESS 1, BECAUSE THE SUITE IS NOT ONE.
         *
         * The script below ends in `exec`, so without this the customer's test runner IS process 1,
         * and process 1 carries a duty no test runner implements: reaping the orphaned children the
         * kernel reparents onto it. A suite that spawns processes and then asserts they are gone
         * instead finds zombies, and the failure names the repository rather than this container.
         *
         * Measured on `sindresorhus/execa` at census commit `3d9d8200`
         * (`data/abloh-preflight-ten/report.md` §2.6, rig defect 2): four failures in
         * `test/terminate/cleanup.js` with ava reporting "Failed to exit", against 5149 passed and
         * 0 failed once a reaper sits at process 1. The `[esbuild] <defunct>` zombies in that
         * session's unocss and prettier stalls are the same fault.
         *
         * `packages/sandbox`'s proof container has always passed it; this one had not, and the two
         * containers run model-written and customer-written code under the same claim. It weakens
         * nothing - docker's init is a reaper and a signal forwarder, not a capability.
         */
        "--init",
        /*
         * `none` UNLESS THE REPOSITORY DECLARED A SERVICE, in which case this execution joins the
         * one namespace those services are already listening in - so `localhost:5432` inside the
         * suite is the customer's own declared database, at the address their own CI gives it.
         *
         * IT IS STILL NOT EGRESS. The namespace's network was created `--internal`, so it carries a
         * loopback and the declared services and no route anywhere else; `services.ts` beside this
         * file carries the whole argument and the one capability deviation, which is on the SERVICE
         * container and never on this one. A repository declaring nothing gets `none`, byte for
         * byte what every execution got before services worked at all.
         */
        "--network",
        namespace === null ? "none" : `container:${namespace.holder}`,
        "--cap-drop",
        "ALL",
        /* ON THE OVERLAY ROAD ONLY, and it is parity with the image road rather than a widening of
           it - see `OVERLAY_WORKSPACE_CAPABILITY` for the whole argument and the two census suites
           that could not run without it. An image-road argv is byte for byte what it was. */
        ...this.#workspaceRoad === "overlay" ? ["--cap-add", OVERLAY_WORKSPACE_CAPABILITY] : [],
        "--security-opt",
        "no-new-privileges",
        /*
         * POSTURE 3, and it is the whole security posture of a browser suite in one place.
         *
         * Chrome's OWN sandbox stays on and the container's syscall filter stays on; the filter is
         * opened by a chrome-tailored profile permitting exactly the three syscalls Chrome's
         * namespace sandbox needs and nothing else - see `chrome-seccomp.ts` for each one and the
         * failure that proved it necessary. Ruled by Kenneth on 2026-08-18 over the two postures
         * the spike measured, each of which turns one boundary off to let the other work.
         *
         * The user is what makes it reachable at all: Chrome refuses to run as root without
         * `--no-sandbox`, so a root container has only the posture this refuses.
         *
         * /dev/shm is a PRIVATE tmpfs and never the host's, and the flag comes from
         * `BROWSER_SHARED_MEMORY_ARGV` in `@abloh/core` rather than being spelled here. The
         * sandbox mounts the identical thing from the identical constant, and the customer-facing
         * seal states it by reading the same constant, so the two browser paths and the published
         * claim agree by construction instead of by three people picking the same number.
         */
        ...browserProfile === null ? [] : [
          "--security-opt",
          `seccomp=${browserProfile}`,
          "--user",
          `${SEALED_BROWSER_UID}:${SEALED_BROWSER_UID}`,
          ...BROWSER_SHARED_MEMORY_ARGV
        ],
        /* SCALED WITH THIS HOST, floored at the 512 that used to be flat. `sealedPidsLimit` in
           `@abloh/core` carries the formula and the measurement that forced it. */
        "--pids-limit",
        String(this.pidsLimit),
        "--memory",
        this.#options.memory ?? "4g",
        "-v",
        `${inputRoot}:${INPUT_MOUNT}:ro`,
        /* THE WORKSPACE, ON THE OVERLAY ROAD ONLY. The volume's lower layer is the checkout and its
           upper layer is this execution's scratch, so `/work` holds exactly the bytes `COPY . /work`
           put there and every write goes somewhere the customer's tree is not. */
        ...workspaceVolume === null ? [] : ["-v", `${workspaceVolume}:${CONTAINER_WORKDIR}`],
        /* The host environment is NEVER inherited: only literal values policy declared reach the
           container, so a credential in the operator's shell cannot become a credential in a
           model-written test's reach. */
        /* THE REPOSITORY'S OWN DECLARED VALUES FIRST, then the engine's, so an engine-owned name
           always wins. This is the channel a repository's own `DATABASE_URL` travels in - without
           it a declared service stands up correctly and the suite is never told where it is. */
        ...Object.entries(this.#options.declaredEnvironment ?? {}).flatMap(([key, value]) => [
          "-e",
          `${key}=${value}`
        ]),
        ...Object.entries(this.#options.syntheticEnvironment ?? {}).flatMap(([key, value]) => [
          "-e",
          `${key}=${value}`
        ]),
        /*
         * ENGINE-OWNED AND AFTER THE DECLARED ONES, for the reason the browser's variables below
         * are: the damage it repairs is abloh's own. The copied tree names a store path that exists
         * on the customer's runner and not in this container, so a repository carrying
         * `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN` in `environment.environmentValues` - a correct value
         * where their store IS present - would put the purge back. See `SEALED_PNPM_VERIFY_DEPS`.
         */
        "-e",
        SEALED_PNPM_VERIFY_DEPS,
        /*
         * THE BROWSER'S OWN VARIABLES, ENGINE-OWNED AND SET AFTER THE DECLARED ONES.
         *
         * They are already image `ENV`s, so this repeats rather than introduces them - and the
         * repetition is the point. `vitejs/vite`'s workflow sets `PLAYWRIGHT_BROWSERS_PATH` to
         * `$HOME/.cache/playwright-bin`, a correct value for their runner and a directory this image
         * has never had; carried into `environment.environmentValues` it would override the image
         * ENV and send the lane looking for a browser where nothing ever wrote one. The engine put
         * the browser somewhere, so the engine has the last word about where it is.
         *
         * `browser-lane-seal.ts` in `@abloh/core` holds the list and says why nothing else is on it.
         */
        ...browserProfile === null ? [] : Object.entries(BROWSER_LANE_MEASURED_ENVIRONMENT).flatMap(([key, value]) => [
          "-e",
          `${key}=${value}`
        ]),
        /*
         * THE ONE ENGINE-OWNED VARIABLE, and it is set AFTER the declared ones so a repository's own
         * policy cannot replace it. `NODE_OPTIONS` reaches every node in the command tree, which is
         * what a runner that forks per test file needs; the interceptor's configuration rides in the
         * import URL's query rather than in more variables, because `customer-environment.ts`
         * reserves the `ABLOH_` prefix by name and a file path is not a reason to widen that.
         */
        ...replay === void 0 ? [] : [
          "-e",
          `NODE_OPTIONS=--import=file://${INPUT_MOUNT}/${REPLAY_PRELOAD_NAME}?mode=replay&recordings=${encodeURIComponent(`${CONTAINER_WORKDIR}/${replay.recordingsRelative}`)}&journal=${encodeURIComponent(REPLAY_JOURNAL_DIR)}&scope=${replay.scope}`
        ],
        tag,
        "sh",
        "-c",
        script
      ];
      this.executions += 1;
      const run = maskCapturedOutput(await this.#docker(argv, request.timeoutMs, containerName));
      const report = parseTestReport({
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode,
        testName: request.testName,
        /* ABLOH'S OWN WALL, HANDED TO THE READING RATHER THAN LEFT OUT OF IT. `parseTestReport` has
           taken this since the report-unavailable work and no execution path ever supplied it, so
           `unavailable.timedOut` read `false` on every timeout and `classifyReportUnavailable` - whose
           first clause is this exact question - never saw one. */
        timedOut: run.timedOut,
        /* Same reading as the unsealed runner, and it has to be: which of the flags on this argv
           were OURS is what separates a runner refusing abloh's ask from abloh's own defect. The
           sealed command is built here, so the answer is taken from the argv that ran. */
        askedWith: reportingFlagsIn2(declaredArgv)
      });
      const captured = `${run.stdout}
${run.stderr}`.trim();
      const ceilingNotice = pidCeilingExhaustion({
        output: captured,
        pidsLimit: this.pidsLimit,
        cores: this.hostCores
      });
      if (ceilingNotice !== null) this.#options.log?.(ceilingNotice);
      const disclosed = ceilingNotice === null ? captured : `${ceilingNotice}

${captured}`;
      if (targeted) {
        assertRunnerFoundSpec({ testFile: request.testFile, requestedPath, output: captured });
      }
      return {
        report,
        exitCode: run.exitCode,
        output: boundEvidence(disclosed),
        wallMs: Date.now() - started,
        ...run.timedOut ? { timedOut: true } : {},
        ...this.#options.testCommandRunsProjectScript === true && looksLikeGateFailure(report, captured) ? { gateShapedFailure: true } : {}
      };
    } finally {
      rmSync3(inputRoot, { recursive: true, force: true });
      if (workspaceVolume !== null) await this.#removeVolume(workspaceVolume);
    }
  }
  async dispose() {
    for (const name of [...this.#ownContainers]) {
      this.#ownContainers.delete(name);
      await removeContainer(this.#options.dockerBin ?? "docker", name);
    }
    for (const name of [...this.#ownVolumes]) await this.#removeVolume(name);
    if (this.#serviceNetwork !== null) {
      const network = this.#serviceNetwork;
      this.#serviceNetwork = null;
      this.#serviceStartup = null;
      await this.#docker(["network", "rm", network], CONTAINER_STOP_TIMEOUT_MS).catch(() => void 0);
      liveNetworks.delete(network);
    }
    await this.#scrubOverlayScratch();
    if (this.#scratchRoot !== null) {
      try {
        rmSync3(this.#scratchRoot, { recursive: true, force: true });
      } catch {
      }
    }
    this.#scratchRoot = null;
  }
  /**
   * THE HARNESS DID NOT GET AS FAR AS A TEST, and the report says exactly that.
   *
   * `executed: false` used to sit here, which is the report POSITIVELY stating that no test ran -
   * and that is a claim about the customer's suite, made on the strength of abloh failing to start
   * a container. It is `null` now, which is the value every reader already treats as "the report
   * did not say", and the diagnostic beside it says why there is no report at all (rank 4).
   */
  #failed(reason, started) {
    return {
      report: {
        passed: false,
        executed: null,
        failedAssertion: false,
        failed: null,
        failures: null,
        format: "exit-code",
        unavailable: { dialect: null, path: null, parserError: reason, timedOut: false }
      },
      exitCode: -1,
      output: reason,
      wallMs: Date.now() - started,
      error: reason
    };
  }
  /**
   * THIS EXECUTION'S OWN WORKSPACE MOUNT, or nothing at all on the image road.
   *
   * ONE VOLUME PER EXECUTION, not one per run, and that is what keeps the fresh-container promise
   * the image road got for free: a new container from an image starts from the image's bytes, and a
   * new container over a new upper layer starts from the checkout's. Everything the previous
   * execution wrote - the placed candidate, a cache the suite dropped, an output directory - was in
   * that execution's upper directory and is gone with it.
   *
   * The upper and work directories are 0777 under a 0700 scratch root, which is `createInputRoot`'s
   * rule: the container drops `CAP_DAC_OVERRIDE`, so its root is an ordinary user against a
   * host-owned mode.
   */
  async #openWorkspaceVolume(scratchRoot) {
    this.#volumeSeq += 1;
    const name = `${CONTAINER_NAME_PREFIX}-work-${this.runToken}-${this.#volumeSeq}`;
    const root = mkdtempSync2(join17(this.#ensureOverlayScratch(scratchRoot), "work-"));
    const upper = join17(root, "upper");
    const work = join17(root, "work");
    mkdirSync6(upper);
    mkdirSync6(work);
    chmodSync(root, 511);
    chmodSync(upper, 511);
    chmodSync(work, 511);
    const created = await this.#docker(
      [
        "volume",
        "create",
        ...overlayVolumeOptions({ lowerdir: resolve6(this.#options.repoDir), upperdir: upper, workdir: work }),
        name
      ],
      CONTAINER_STOP_TIMEOUT_MS
    );
    if (created.exitCode !== 0) {
      return { ok: false, reason: `the sealed workspace volume was refused: ${boundEvidenceTail(`${created.stderr}
${created.stdout}`.trim(), 300)}` };
    }
    rememberVolume(name, this.#options.dockerBin ?? "docker");
    this.#ownVolumes.add(name);
    return { ok: true, name };
  }
  async #removeVolume(name) {
    this.#ownVolumes.delete(name);
    await this.#docker(["volume", "rm", "-f", name], CONTAINER_STOP_TIMEOUT_MS).catch(() => void 0);
    liveVolumes.delete(name);
  }
  /**
   * One docker CLI call, with the timeout aimed at the right thing.
   *
   * When `containerName` is given the call is a `docker run` of that container, and the timeout
   * stops THE CONTAINER first and the client only afterwards, as cleanup. The order is the whole
   * fix: killing the client first detaches from a container that is still running, and `--rm` will
   * never fire for it because it never exits.
   */
  #docker(argv, timeoutMs, containerName, extraEnvironment) {
    const dockerBin = this.#options.dockerBin ?? "docker";
    if (containerName !== void 0) {
      rememberContainer(containerName, dockerBin);
      this.#ownContainers.add(containerName);
    }
    return new Promise((resolvePromise) => {
      const child = spawn2(dockerBin, argv, {
        stdio: ["ignore", "pipe", "pipe"],
        /* The client INHERITS this process's environment, which is how `--secret id=X,env=X` finds
           the customer's own variable without abloh ever reading its value. */
        ...extraEnvironment === void 0 ? {} : { env: { ...process.env, ...extraEnvironment } }
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let grace = null;
      const settle = (exitCode, extraStderr = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace !== null) clearTimeout(grace);
        const result = { stdout, stderr: extraStderr === "" ? stderr : `${stderr}
${extraStderr}`, exitCode, timedOut };
        if (containerName === void 0) {
          resolvePromise(result);
          return;
        }
        this.#ownContainers.delete(containerName);
        if (!timedOut) {
          forgetContainer(containerName);
          resolvePromise(result);
          return;
        }
        void removeContainer(dockerBin, containerName).then(() => resolvePromise(result));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        const killClient = () => {
          child.kill("SIGKILL");
          grace = setTimeout(() => settle(-1, "the sealed execution timed out and its container was removed"), CLIENT_CLOSE_GRACE_MS);
          grace.unref();
        };
        if (containerName === void 0) {
          killClient();
          return;
        }
        void removeContainer(dockerBin, containerName).finally(killClient);
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => settle(-1, error.message));
      child.on("close", (code) => settle(code ?? -1));
    });
  }
};
function createInputRoot(scratchRoot) {
  const inputRoot = mkdtempSync2(join17(scratchRoot, "exec-"));
  chmodSync(inputRoot, 493);
  return inputRoot;
}
function writeInput(root, relative5, source) {
  const absolute = join17(root, relative5);
  mkdirSync6(dirname11(absolute), { recursive: true });
  writeFileSync6(absolute, source, { mode: 420 });
}
function shellQuote(value) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

// src/execution/daemon-probe.ts
import { execFileSync as execFileSync2 } from "child_process";
var DAEMON_PROBE_TIMEOUT_MS = 15e3;
var answered = /* @__PURE__ */ new Map();
function dockerDaemonAvailable(dockerBin = "docker") {
  const cached = answered.get(dockerBin);
  if (cached !== void 0) return cached;
  let available;
  try {
    execFileSync2(dockerBin, ["info"], {
      stdio: "ignore",
      timeout: DAEMON_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL"
    });
    available = true;
  } catch {
    available = false;
  }
  answered.set(dockerBin, available);
  return available;
}

// src/model/throttle.ts
function validateThrottleRetryPolicy(policy) {
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) {
    throw new Error("throttle maxRetries must be an integer >= 0 (there is no default)");
  }
  if (!Number.isInteger(policy.baseDelayMs) || policy.baseDelayMs < 1) {
    throw new Error("throttle baseDelayMs must be an integer >= 1 (there is no default)");
  }
  if (!Number.isInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error("throttle maxDelayMs must be an integer >= baseDelayMs (a ceiling below the floor is not a ceiling)");
  }
}
var RULED_THROTTLE_RETRY = {
  maxRetries: 4,
  baseDelayMs: 1e3,
  maxDelayMs: 2e4
};
function parseRetryAfterMs(headers, nowMs) {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "") {
    const parsed = Number(ms.trim());
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  }
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (/^\d+$/u.test(value)) return Number(value) * 1e3;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}
function throttleBackoffMs(input) {
  const doubled = Math.min(input.policy.maxDelayMs, input.policy.baseDelayMs * 2 ** Math.max(0, input.attempt));
  const half = doubled / 2;
  const jittered = half + Math.min(1, Math.max(0, input.random)) * half;
  return Math.round(jittered);
}
function planThrottleRetry(input) {
  const waitMs = input.retryAfterMs === null ? throttleBackoffMs({ attempt: input.attempt, policy: input.policy, random: input.random }) : input.retryAfterMs;
  if (input.attempt >= input.policy.maxRetries) return { retry: false, reason: "exhausted", waitMs };
  if (waitMs + CALL_OVERHEAD_MS > input.remainingMs) return { retry: false, reason: "deadline", waitMs };
  return { retry: true, waitMs, source: input.retryAfterMs === null ? "backoff" : "retry-after" };
}

// src/model/endpoint.ts
import { resolveModelAccess } from "@abloh/core";
var ENDPOINT_URL_VAR = "MODEL_ENDPOINT";
var ENDPOINT_KEY_VAR = "MODEL_API_KEY";
var ENDPOINT_AUTH_VAR = "MODEL_AUTH";
function resolveEndpoint(env = process.env) {
  const access = resolveModelAccess(env, "default");
  if (!access.available) return { available: false, reason: access.reason ?? "no model endpoint" };
  const url = access.url;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return { available: false, reason: `${ENDPOINT_URL_VAR} is not a URL` };
  }
  return {
    available: true,
    chatUrl: resolveChatUrl(url),
    responsesUrl: resolveResponsesUrl(url),
    /* EMPTY WHEN THE CREDENTIAL IS MINTED, and that is the hosted path rather than an edge case:
       `resolveModelAccess` has already established that one of the two exists. */
    apiKey: access.apiKey ?? "",
    ...access.mintCredential === void 0 ? {} : { mintCredential: access.mintCredential },
    authHeader: access.authHeader,
    host
  };
}
function resolveChatUrl(configured) {
  const trimmed = configured.trim().replace(/\/+$/u, "");
  if (/\/chat\/completions(\?|$)/u.test(trimmed)) return trimmed;
  const match = /^(https?:\/\/[^/]+)(\/.*)?$/u.exec(trimmed);
  if (match === null) return trimmed;
  const [, root, path] = match;
  if (path !== void 0 && path !== "/" && !/^\/api\/projects\//u.test(path)) {
    return `${root}${path}/chat/completions`;
  }
  return `${root}/openai/v1/chat/completions`;
}
function resolveResponsesUrl(configured) {
  const trimmed = configured.trim().replace(/\/+$/u, "");
  if (/\/chat\/completions(\?|$)/u.test(trimmed)) return null;
  const match = /^(https?:\/\/[^/]+)(\/.*)?$/u.exec(trimmed);
  if (match === null) return null;
  const [, root, path] = match;
  if (path !== void 0 && path !== "/" && !/^\/api\/projects\//u.test(path)) {
    return `${root}${path}/responses`;
  }
  return `${root}/openai/v1/responses`;
}
function resolveModelsUrl(chatUrl) {
  return chatUrl.replace(/\/chat\/completions(\?.*)?$/u, "/models");
}

// src/model/client.ts
import {
  ENGINE_MODEL_FAILURES,
  hostedRunHeaders,
  noteModelServiceAnswer,
  readEventUsage,
  redactCredentialShapesDeep as redactCredentialShapesDeep2,
  scrubSecretsDeep as scrubSecretsDeep2
} from "@abloh/core";
import { Agent, fetch as undiciFetch } from "undici";
var MODEL_FAILURES = ENGINE_MODEL_FAILURES;
function transportTimeoutsMs(deadlineMs) {
  const whole = Math.max(0, Math.floor(deadlineMs));
  return { headersTimeout: whole, bodyTimeout: whole };
}
var NETWORK_TRANSPORT = {
  async fetch(url, init) {
    const response = await undiciFetch(url, init);
    return response;
  },
  async sleep(ms, signal) {
    if (signal.aborted || ms <= 0) return;
    await new Promise((resolve7) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve7();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  },
  random: () => Math.random(),
  now: () => Date.now()
};
var AzureModelClient = class _AzureModelClient {
  endpointHost;
  usage = { input: 0, output: 0, reasoning: 0, cached: 0 };
  /**
   * LOGICAL calls, one per `call()`, which is what the loop budgets and what the ledger charges.
   *
   * A throttle retry is not a second call: the same prompt is being asked once, and counting the
   * wait as an extra attempt would inflate every count and every spend estimate built on it. What
   * the retries cost is disclosed beside this number in {@link throttleRetries} and per call in
   * `CallTiming.throttleRetries`, so they are visible without being double-counted.
   */
  calls = 0;
  /** HTTP attempts spent waiting out throttles across every call this client has made */
  throttleRetries = 0;
  #config;
  #throttle;
  #transport;
  /** `responses` until this endpoint says it has no such path; then `chat` for this client's life */
  #surface;
  constructor(config, throttle, transport = NETWORK_TRANSPORT) {
    validateThrottleRetryPolicy(throttle);
    this.#config = config;
    this.#throttle = throttle;
    this.#transport = transport;
    this.endpointHost = config.host;
    this.#surface = config.responsesUrl === null ? "chat" : "responses";
  }
  /** Which surface this client is talking to, so a run's report can say which door it used. */
  get surface() {
    return this.#surface;
  }
  /** Returns null with a named reason when the environment carries no endpoint. */
  static fromEnvironment(input) {
    const resolved = resolveEndpoint(input.env ?? process.env);
    if (!resolved.available) return { ok: false, reason: resolved.reason };
    const { available: _available, ...config } = resolved;
    return {
      ok: true,
      client: new _AzureModelClient(config, input.throttle, input.transport ?? NETWORK_TRANSPORT)
    };
  }
  async call(input) {
    assertAllowedModel(input.pin.model);
    const completionCeiling = batchCompletionCeiling(input.pin, input.gapCount ?? 1);
    const deadlineMs = derivedCallDeadlineMs({
      completionCeiling,
      ...input.remainingBudgetMs === void 0 ? {} : { remainingBudgetMs: input.remainingBudgetMs }
    });
    const effort = input.effort ?? input.pin.effort;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const onExternalAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    const started = this.#transport.now();
    const remainingMs = () => Math.max(0, deadlineMs - (this.#transport.now() - started));
    this.calls += 1;
    let retries = 0;
    let lastThrottle = null;
    try {
      for (; ; ) {
        const attempt = await this.#attempt({
          ...input,
          completionCeiling,
          effort,
          deadlineMs,
          startedAt: started,
          retries,
          signal: controller.signal
        });
        if (attempt.surfaceAbsent && this.#surface === "responses") {
          this.#surface = "chat";
          continue;
        }
        const result = attempt.result;
        if (result.ok || result.failure.kind !== "rate-limit") {
          if (!result.ok && result.failure.kind === "timeout" && lastThrottle !== null) {
            result.failure.detail += ` (after ${retries} throttle retry(ies); last throttle: ${lastThrottle})`;
          }
          if (!result.ok) noteAnswer(result.failure.kind, attempt.answered);
          return result;
        }
        const cause = result.failure.detail;
        lastThrottle = cause;
        const plan = planThrottleRetry({
          attempt: retries,
          policy: this.#throttle,
          retryAfterMs: attempt.retryAfterMs,
          remainingMs: remainingMs(),
          random: this.#transport.random()
        });
        if (!plan.retry) {
          result.failure.detail = throttleGaveUpDetail({
            reason: plan.reason,
            retries,
            waitMs: plan.waitMs,
            remainingMs: remainingMs(),
            cause
          });
          noteAnswer(result.failure.kind, attempt.answered);
          return result;
        }
        await this.#transport.sleep(plan.waitMs, controller.signal);
        if (controller.signal.aborted) {
          noteAnswer("timeout", void 0);
          return {
            ok: false,
            failure: {
              kind: "timeout",
              detail: `cancelled while waiting ${plan.waitMs}ms out of a throttle (${cause})`
            },
            /* The throttled attempts that put us here WERE sent, and none of them reported usage. */
            requestSent: true,
            latencyMs: this.#transport.now() - started,
            timing: {
              latencyMs: this.#transport.now() - started,
              timeToFirstTokenMs: null,
              tokensPerSecond: null,
              deadlineMs,
              effort,
              throttleRetries: retries
            }
          };
        }
        retries += 1;
        this.throttleRetries += 1;
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
  /**
   * One HTTP attempt.
   *
   * It owns its dispatcher and its share of the wall, and it never decides whether to try again -
   * that is `call`'s job, because only `call` knows how much of the deadline the earlier attempts
   * and their backoffs already spent. The one thing it reports back beyond a result is whether the
   * endpoint has the surface at all, which `call` answers by asking again through the other door.
   */
  async #attempt(input) {
    const { completionCeiling, deadlineMs, effort, startedAt } = input;
    const surface = this.#surface;
    const url = surface === "responses" && this.#config.responsesUrl !== null ? this.#config.responsesUrl : this.#config.chatUrl;
    const attemptStarted = this.#transport.now();
    const attemptWallMs = Math.max(1, deadlineMs - (attemptStarted - startedAt));
    let firstChunkAt = null;
    let dispatcher = null;
    let requestIssued = false;
    let lastByteAt = null;
    let longestSilenceMs = 0;
    const silenceNow = () => this.#transport.now() - (lastByteAt ?? attemptStarted);
    const noteByte = () => {
      const at = this.#transport.now();
      const silence = at - (lastByteAt ?? attemptStarted);
      if (silence > longestSilenceMs) longestSilenceMs = silence;
      lastByteAt = at;
      if (firstChunkAt === null) firstChunkAt = at;
    };
    const timing = () => ({
      latencyMs: this.#transport.now() - startedAt,
      timeToFirstTokenMs: firstChunkAt === null ? null : firstChunkAt - attemptStarted,
      tokensPerSecond: null,
      deadlineMs,
      effort,
      throttleRetries: input.retries,
      longestSilenceMs: Math.max(longestSilenceMs, silenceNow()),
      surface
    });
    const plain = (result) => ({ result, retryAfterMs: null });
    try {
      const headers = { "content-type": "application/json" };
      let credential = this.#config.apiKey;
      if (this.#config.mintCredential !== void 0) {
        try {
          credential = await this.#config.mintCredential();
        } catch (error) {
          return plain({
            ok: false,
            failure: {
              kind: "authentication",
              detail: bounded(
                `no model-gateway identity could be minted for this call (${error instanceof Error ? error.message : String(error)}) - the endpoint was never asked`
              )
            },
            latencyMs: this.#transport.now() - startedAt,
            timing: timing(),
            /* The sentence already says it: the endpoint was never asked. So this call settles at
               zero rather than at its worst case. */
            requestSent: false
          });
        }
      }
      if (this.#config.authHeader === "api-key") headers["api-key"] = credential;
      else headers.authorization = `Bearer ${credential}`;
      Object.assign(headers, hostedRunHeaders());
      dispatcher = new Agent(transportTimeoutsMs(attemptWallMs));
      const request = {
        method: "POST",
        headers,
        dispatcher,
        signal: input.signal,
        /*
         * THE MODEL-CALL MASKING BOUNDARY - the last point at which a secret can still be taken back.
         *
         * The captured-output boundary in `execution/runner.ts` is the primary control and catches
         * the common route (a suite prints a key, the failure becomes a repair prompt). This is the
         * backstop for every OTHER route into a prompt, and there are several: a proof report file
         * the runner parsed rather than captured (ENV-07), a changed source file read straight off
         * disk, an error message assembled in-process, a tool result. None of those pass through a
         * spawn's stdout, so none are covered upstream.
         *
         * DEEP, AND BEFORE SERIALIZATION, which is what makes it exact rather than approximate: the
         * walk masks every string in the body whatever field it sits in, including a value whose
         * quotes or newlines would make it a different string once `JSON.stringify` has been over
         * it. The percent-encoded and JSON-escaped forms are registered too, so a test that printed
         * an encoded key does not smuggle it out in that shape (`secret-scrub.ts`).
         *
         * It costs nothing on a run with no declared secrets: the walk returns its input by identity
         * when the registry is empty, which is most runs.
         *
         * AND THEN THE SHAPE SCAN, WHICH IS A DIFFERENT PROBLEM (ENG-PROMPT-001, rank 5). The masker
         * above can only remove what the customer DECLARED. Generation sends whole changed files and
         * whole example tests - by design, because a model shown a file plants better than one shown
         * a span - and a file can hold a key that was never a declared variable. The registered
         * masker has nothing to match it with, so the key would leave with the file.
         *
         * IT REDACTS AND DOES NOT REFUSE, deliberately. A file with one key masked out of it is
         * still the whole file and still plants exactly as well; refusing the call would throw away
         * the measurement to protect a value that a substitution already protects. The prompt is not
         * shrunk here and must not be - see the smarter-planting ruling.
         */
        body: JSON.stringify(
          redactCredentialShapesDeep2(
            scrubSecretsDeep2(
              surface === "responses" ? responsesRequestBody({ ...input, completionCeiling, effort }) : chatRequestBody({ ...input, completionCeiling, effort })
            )
          )
        )
      };
      requestIssued = true;
      const response = await this.#transport.fetch(url, request);
      if (!response.ok) {
        const raw = await response.text();
        if (response.status === 404 && surface === "responses") {
          return {
            result: {
              ok: false,
              failure: { kind: "server-error", detail: bounded(`HTTP 404 at ${url}`) },
              latencyMs: this.#transport.now() - startedAt,
              timing: timing(),
              requestSent: true
            },
            retryAfterMs: null,
            surfaceAbsent: true
          };
        }
        const failure = classifyHttpFailure(response.status, raw);
        return {
          answered: { status: response.status, reason: response.statusText ?? null },
          /* SENT, AND NO USAGE FRAME. An error status carries no stream, so what this request cost
             at the endpoint is unknown rather than zero, and the meter charges its ceiling against
             the budget instead of inventing a number. */
          result: { ok: false, failure, latencyMs: this.#transport.now() - startedAt, timing: timing(), requestSent: true },
          /* Read only when the endpoint actually throttled us; on any other status the header, if
             present at all, is about something this transport does not act on. */
          retryAfterMs: failure.kind === "rate-limit" ? parseRetryAfterMs(response.headers, this.#transport.now()) : null
        };
      }
      if (response.body === null || response.body === void 0) {
        return plain({
          ok: false,
          failure: { kind: "empty", detail: "the endpoint returned no body" },
          latencyMs: this.#transport.now() - startedAt,
          timing: timing(),
          requestSent: true
        });
      }
      const harvest = { text: "", truncated: false, failed: null, usage: { input: 0, output: 0, reasoning: 0, cached: 0 } };
      const readFrame = surface === "responses" ? readResponsesFrame : readChatFrame;
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        noteByte();
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          try {
            readFrame(JSON.parse(payload), harvest);
          } catch {
          }
        }
      }
      const usage = harvest.usage;
      this.usage.input += usage.input;
      this.usage.output += usage.output;
      this.usage.reasoning += usage.reasoning;
      this.usage.cached = (this.usage.cached ?? 0) + (usage.cached ?? 0);
      const attemptElapsed = Math.max(1, this.#transport.now() - attemptStarted);
      const measured = {
        ...timing(),
        tokensPerSecond: usage.output > 0 ? usage.output / attemptElapsed * 1e3 : null
      };
      if (harvest.failed !== null) {
        return plain({
          ok: false,
          failure: { kind: "server-error", detail: bounded(harvest.failed) },
          latencyMs: measured.latencyMs,
          timing: measured,
          usage,
          requestSent: true
        });
      }
      if (harvest.truncated) {
        return plain({
          ok: false,
          failure: {
            kind: "truncated",
            detail: `reply hit the completion ceiling of ${completionCeiling} token(s) for ${input.gapCount ?? 1} gap(s)`
          },
          latencyMs: measured.latencyMs,
          timing: measured,
          usage,
          requestSent: true
        });
      }
      if (harvest.text.trim() === "") {
        return plain({
          ok: false,
          failure: { kind: "empty", detail: "no content in the reply" },
          latencyMs: measured.latencyMs,
          timing: measured,
          usage,
          requestSent: true
        });
      }
      return plain({ ok: true, text: harvest.text, usage, latencyMs: measured.latencyMs, timing: measured });
    } catch (error) {
      const unsent = unsentDetail({ error, requestIssued, attemptWallMs });
      const aborted = input.signal.aborted;
      const cut = aborted || unsent !== null ? null : idleCutDetail({ error, silenceMs: silenceNow(), firstChunkAt, attemptWallMs });
      return plain({
        ok: false,
        failure: unsent !== null ? { kind: "request-not-sent", detail: unsent } : {
          kind: aborted ? "timeout" : "network",
          detail: aborted ? `no reply within ${deadlineMs}ms (derived from a ${completionCeiling}-token ceiling)` : cut ?? bounded(error instanceof Error ? error.message : String(error))
        },
        latencyMs: this.#transport.now() - startedAt,
        timing: timing(),
        /* `requestIssued` is the one fact that separates "our own request-building threw" from "the
           endpoint was asked and the answer never arrived". The first spent nothing and settles at
           zero; the second may have generated an entire reply we never saw, so it settles at its
           own ceiling and its dollars are reported as unknown rather than as a charge. */
        requestSent: requestIssued
      });
    } finally {
      if (dispatcher !== null) await dispatcher.close().catch(() => void 0);
    }
  }
};
function noteAnswer(failure, answered2) {
  noteModelServiceAnswer({
    failure,
    status: answered2?.status ?? null,
    reason: answered2?.reason ?? null,
    atMs: Date.now()
  });
}
function responsesRequestBody(input) {
  return {
    model: input.pin.model,
    input: [{ role: "user", content: input.prompt }],
    max_output_tokens: input.completionCeiling,
    reasoning: { effort: input.effort },
    /* STREAMED for the reason the chat shape is - and here it buys the thing that actually matters:
       `response.created` lands at stream open, before the model thinks, so the response is never
       silent long enough for an intermediary's idle timer to fire. See {@link AzureModelClient}. */
    stream: true,
    ...input.jsonSchema !== void 0 ? {
      text: {
        format: { type: "json_schema", name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema }
      }
    } : input.jsonObject === true ? { text: { format: { type: "json_object" } } } : {}
  };
}
function chatRequestBody(input) {
  return {
    model: input.pin.model,
    messages: [{ role: "user", content: input.prompt }],
    max_completion_tokens: input.completionCeiling,
    reasoning_effort: input.effort,
    /*
     * STREAMED, so the platform's own ~300 s header wall stops binding.
     *
     * Non-streamed, nothing arrives until the whole answer is ready, and Node's fetch abandons a
     * response that has produced no headers for ~300 s whatever deadline we set - so our
     * AbortController was never the thing that fired. A truncated stream also leaves every line
     * already received usable, which is why the reply shape is one JSON object per line.
     *
     * It does NOT buy an early byte on this endpoint: nothing is emitted until the first output
     * token, which is the whole reason `responses` is preferred wherever it exists.
     */
    stream: true,
    stream_options: { include_usage: true },
    /* THE SHAPE, WHEN THE CALLER HAS ONE. `json_schema` is `json_object` plus the shape, so the
       two are exclusive rather than additive; a caller that supplies a schema gets the
       constrained decoder and a caller that supplies neither gets prose. */
    ...input.jsonSchema !== void 0 ? {
      response_format: {
        type: "json_schema",
        json_schema: { name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema }
      }
    } : input.jsonObject === true ? { response_format: { type: "json_object" } } : {}
  };
}
function readChatFrame(event, harvest) {
  const frame = event;
  const choice = frame.choices?.[0];
  harvest.text += choice?.delta?.content ?? "";
  if (choice?.finish_reason === "length") harvest.truncated = true;
  const usage = readEventUsage("chat", event);
  if (usage !== null) harvest.usage = usage;
}
function readResponsesFrame(event, harvest) {
  const frame = event;
  if (frame.type === "response.output_text.delta") {
    harvest.text += frame.delta ?? "";
    return;
  }
  if (frame.type !== "response.completed" && frame.type !== "response.incomplete" && frame.type !== "response.failed") {
    return;
  }
  const response = frame.response;
  if (frame.type === "response.incomplete" && response?.incomplete_details?.reason === "max_output_tokens") {
    harvest.truncated = true;
  }
  if (frame.type === "response.failed") {
    harvest.failed = response?.error?.message ?? "the endpoint reported the generation as failed";
  }
  const usage = readEventUsage("responses", event);
  if (usage !== null) harvest.usage = usage;
}
function idleCutDetail(input) {
  if (!farSideClosed(input.error)) return null;
  const where = input.firstChunkAt === null ? "before a single response byte arrived" : "part-way through the streamed reply";
  return bounded(
    `the endpoint closed the connection ${where}, after ${input.silenceMs}ms of silence. Our own wall for this attempt was ${input.attemptWallMs}ms and had not fired, so the cut came from the endpoint or an intermediary in front of it - a response-idle timeout, not a slow answer.`
  );
}
function farSideClosed(error) {
  for (let link = error, depth = 0; link instanceof Error && depth < 4; link = link.cause, depth += 1) {
    if (/other side closed|socket hang up|ECONNRESET|UND_ERR_SOCKET/u.test(`${link.code ?? ""} ${link.message}`)) {
      return true;
    }
  }
  return false;
}
function throttleGaveUpDetail(input) {
  const why = input.reason === "exhausted" ? `still throttled after ${input.retries} retry(ies)` : `the next wait of ${input.waitMs}ms would not fit in the ${input.remainingMs}ms left of this call's deadline`;
  return `throttled by the endpoint - ${why}; last response: ${input.cause}`;
}
function bounded(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}\u2026`;
}
function unsentDetail(input) {
  const refusal = invalidArgumentRefusal(input.error);
  if (refusal !== null) {
    return bounded(
      `the request was never sent: undici refused an argument this client derived (${refusal}). The attempt's wall was ${input.attemptWallMs}ms. This is our own arithmetic, not the endpoint.`
    );
  }
  if (input.requestIssued) return null;
  return bounded(
    `the request was never sent: it failed while being built (${input.error instanceof Error ? input.error.message : String(input.error)}). This is our own request construction, not the endpoint.`
  );
}
function invalidArgumentRefusal(error) {
  for (let link = error, depth = 0; link instanceof Error && depth < 4; link = link.cause, depth += 1) {
    if (link.code === "UND_ERR_INVALID_ARG") return link.message;
  }
  return null;
}
var THROTTLE_BODY = /rate[ _-]?limit|too many requests|throttl/u;
function classifyHttpFailure(status, raw) {
  const searchable = raw.slice(0, 4e3).toLowerCase();
  const kind = status === 401 || status === 403 ? "authentication" : status === 429 || THROTTLE_BODY.test(searchable) ? "rate-limit" : /content[_ -]?filter|responsible ai/u.test(searchable) ? "content-filter" : /context[_ -]?(?:length|window)|maximum context/u.test(searchable) ? "context-window" : "server-error";
  return { kind, detail: `HTTP ${status}: ${bounded(raw.replace(/\s+/gu, " ").trim())}` };
}

// src/model/catalog.ts
async function fetchModelCatalog(env = process.env, fetchImpl = fetch) {
  const resolved = resolveEndpoint(env);
  if (!resolved.available) return { ok: false, reason: resolved.reason };
  const url = resolveModelsUrl(resolved.chatUrl);
  const headers = {};
  let credential = resolved.apiKey;
  if (resolved.mintCredential !== void 0) {
    try {
      credential = await resolved.mintCredential();
    } catch (error) {
      return { ok: false, reason: `no model-gateway identity could be minted: ${error instanceof Error ? error.message : "error"}` };
    }
  }
  if (resolved.authHeader === "api-key") headers["api-key"] = credential;
  else headers.authorization = `Bearer ${credential}`;
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    return { ok: false, reason: `catalog unreachable: ${error instanceof Error ? error.message : "error"}` };
  }
  if (!response.ok) return { ok: false, reason: `catalog returned HTTP ${response.status}` };
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "catalog reply was not JSON" };
  }
  const data = body.data;
  if (!Array.isArray(data)) return { ok: false, reason: "catalog reply carried no `data` array" };
  return { ok: true, models: data.map((entry) => entry.id).filter((id) => typeof id === "string") };
}
async function verifyModelPin(model, env = process.env, fetchImpl = fetch) {
  const catalog = await fetchModelCatalog(env, fetchImpl);
  if (!catalog.ok) return { state: "unverified-open", reason: catalog.reason };
  const exact = catalog.models.find((id) => id === model);
  if (exact !== void 0) return { state: "verified", deployment: exact };
  return { state: "absent", available: catalog.models };
}
async function verifyModelFamily(env = process.env, fetchImpl = fetch) {
  const out = {};
  for (const model of ALLOWED_MODEL_FAMILY) {
    out[model] = await verifyModelPin(model, env, fetchImpl);
  }
  return out;
}

// src/model/metering.ts
import { RATE_CARD_ENV, callCeilingDollars, usageDollars } from "@abloh/core";
import {
  COMPUTE_RATE_ENV,
  RATE_CARD_ENV as RATE_CARD_ENV2,
  RATE_CARD_SCHEMA,
  rateCardFromEnvironment
} from "@abloh/core";
import { callCeilingDollars as callCeilingDollars2, usageDollars as usageDollars2 } from "@abloh/core";
var TYPICAL_PROMPT_CHARS_PER_TOKEN = 3;
var TYPICAL_COMPLETION_SHARE = 0.25;
function callTypicalDollars(rate, promptChars, completionCeiling) {
  const inputTokens = promptChars / TYPICAL_PROMPT_CHARS_PER_TOKEN;
  const outputTokens = completionCeiling * TYPICAL_COMPLETION_SHARE;
  return (inputTokens * rate.inputPerMillion + outputTokens * rate.outputPerMillion) / 1e6;
}
var MeteredModelClient = class {
  endpointHost;
  /**
   * OBSERVED usage only, summed over the calls that reported one.
   *
   * It is a floor on what this run spent, not a total, and {@link unknownUsageCalls} is how many
   * calls are missing from it. Adding a fabricated figure here would make the one number a report
   * treats as measured into a mixture of measurement and guess.
   */
  usage = { input: 0, output: 0, reasoning: 0, cached: 0 };
  calls = 0;
  /** calls that were sent and reported no usage; their cost is unknown, never zero */
  unknownUsageCalls = 0;
  #inner;
  #ledger;
  #card;
  constructor(inner, ledger, card) {
    this.#inner = inner;
    this.#ledger = ledger;
    this.#card = card;
    this.endpointHost = inner.endpointHost;
  }
  async call(input) {
    const rate = this.#card.models[input.pin.model];
    if (rate === void 0) {
      this.#ledger.recordUnpriceableCall(input.task);
      return {
        ok: false,
        failure: {
          kind: "budget",
          detail: `no price for model "${input.pin.model}" in ${RATE_CARD_ENV} - an unpriced call cannot be metered against a spend limit`
        },
        latencyMs: 0
      };
    }
    const completionCeiling = batchCompletionCeiling(input.pin, input.gapCount ?? 1);
    const held = await this.#ledger.reserve({
      ceilingDollars: callCeilingDollars(rate, input.prompt.length, completionCeiling),
      typicalDollars: callTypicalDollars(rate, input.prompt.length, completionCeiling),
      task: input.task
    });
    if (!held.ok) {
      return { ok: false, failure: { kind: "budget", detail: held.reason }, latencyMs: 0 };
    }
    const ceilingDollars = callCeilingDollars(rate, input.prompt.length, completionCeiling);
    let result;
    try {
      result = await this.#inner.call(input);
    } catch (error) {
      this.unknownUsageCalls += 1;
      held.reservation.settle(`model:${input.task}:threw`, ceilingDollars, false);
      throw error;
    }
    this.calls += 1;
    this.#ledger.recordThrottleRetries(result.timing?.throttleRetries ?? 0);
    const observe = (usage) => {
      this.usage.input += usage.input;
      this.usage.output += usage.output;
      this.usage.reasoning += usage.reasoning;
      this.usage.cached = (this.usage.cached ?? 0) + (usage.cached ?? 0);
    };
    if (result.ok) {
      observe(result.usage);
      held.reservation.settle(`model:${input.task}`, usageDollars(rate, result.usage), true);
      return result;
    }
    const item = `model:${input.task}:${result.failure.kind}`;
    if (result.usage !== void 0) {
      observe(result.usage);
      held.reservation.settle(item, usageDollars(rate, result.usage), true);
    } else if (neverSent(result)) {
      held.reservation.settle(item, 0, true);
    } else {
      this.unknownUsageCalls += 1;
      held.reservation.settle(item, ceilingDollars, false);
    }
    return result;
  }
};
function neverSent(result) {
  if (result.requestSent === false) return true;
  return result.failure.kind === "request-not-sent" || result.failure.kind === "budget";
}
var RULED_CHECK_RUN_DOLLAR_CEILING = 2;
var RunLedger = class {
  ceilingDollars;
  card;
  /** dollars priced from a usage frame; the only figure a report may call a charge */
  #dollars = 0;
  /** worst cases consumed by sent calls that reported no usage; spent, but never measured */
  #unknownDollars = 0;
  /**
   * Dollars other arms of this run have charged against the same bound. See {@link chargeOtherLane}.
   *
   * IN THE BALANCE AND NOT IN `dollars`. It is real money the run spent, so the bound must see it;
   * it is another lane's money, so this ledger's own lane figure must not, or every cost line that
   * sums the lanes would count it twice.
   */
  #otherLaneDollars = 0;
  #unknownUsageCalls = 0;
  /** the expected cost of every call in flight, held out of the balance until each one settles */
  #held = 0;
  /** calls that fit the run's remaining money but not alongside the holds, waiting for one to clear */
  #waiting = [];
  #modelCalls = 0;
  #refusedCalls = 0;
  #queuedCalls = 0;
  #throttleRetries = 0;
  #refusedByTask = /* @__PURE__ */ new Map();
  /** every settlement, in order; `usageKnown: false` marks a worst case rather than a charge */
  entries = [];
  constructor(ceilingDollars, card) {
    if (!(Number.isFinite(ceilingDollars) && ceilingDollars > 0)) {
      throw new Error("a run's dollar ceiling must be a positive number of dollars");
    }
    this.ceilingDollars = ceilingDollars;
    this.card = card;
  }
  get spend() {
    return {
      dollars: this.#dollars,
      unknownUsageCalls: this.#unknownUsageCalls,
      unknownUsageCeilingDollars: this.#unknownDollars,
      modelCalls: this.#modelCalls,
      refusedCalls: this.#refusedCalls,
      refusedByTask: Object.fromEntries([...this.#refusedByTask].sort(([a], [b]) => a < b ? -1 : 1)),
      queuedCalls: this.#queuedCalls,
      throttleRetries: this.#throttleRetries
    };
  }
  /**
   * Everything the RUN has already spent: this ledger's measured charges, the worst cases consumed
   * by calls that reported no usage, and what every other arm of the run has charged. The balance
   * cannot tell the three apart, and it must not - a bound that only counts what it could measure
   * stops bounding a run the moment the endpoint stops reporting, and a bound that only counts its
   * own lane never bounded the run at all. The REPORT tells them apart, which is where the
   * difference belongs.
   */
  get #committed() {
    return this.#dollars + this.#unknownDollars + this.#otherLaneDollars;
  }
  /**
   * Dollars a NEW call may be admitted against: the ceiling, less what has been committed and less
   * every in-flight call's hold. Never negative - a run whose realised charges overshot the ceiling
   * reads as zero here and refuses everything, which is the stop doing its job.
   */
  get remaining() {
    return Math.max(0, this.ceilingDollars - this.#committed - this.#held);
  }
  /** True once the ceiling has refused at least one call, which is what a report must disclose. */
  get bound() {
    return this.#refusedCalls > 0;
  }
  async reserve(input) {
    const hold = input.typicalDollars;
    let queued = false;
    for (; ; ) {
      const afterCharges = this.ceilingDollars - this.#committed;
      if (!(hold <= afterCharges)) {
        this.#refusedCalls += 1;
        this.#refusedByTask.set(input.task, (this.#refusedByTask.get(input.task) ?? 0) + 1);
        return {
          ok: false,
          reason: (
            /* "THIS RUN" AGAIN, AND ONLY BECAUSE IT IS TRUE AGAIN (captain, 2026-09-01). This read
               "the generation arm" for as long as triage spent outside this ledger: a refusal that
               said "this run has $X left" then named a balance the run did not have. Triage now
               charges the same ledger, so the balance below IS the run's, and the sentence says so.
               It is an OPERATOR line, not customer copy - see RULED_CHECK_RUN_DOLLAR_CEILING. */
            `this call is expected to cost $${hold.toFixed(4)} and this run has $${Math.max(0, afterCharges).toFixed(4)} left of its $${this.ceilingDollars.toFixed(2)} spend bound`
          )
        };
      }
      if (hold <= afterCharges - this.#held) break;
      if (!queued) {
        queued = true;
        this.#queuedCalls += 1;
      }
      await new Promise((resolve7) => this.#waiting.push(resolve7));
    }
    const heldDollars = hold;
    this.#held += heldDollars;
    this.#modelCalls += 1;
    let settled = false;
    return {
      ok: true,
      reservation: {
        /* WHAT IS CHARGED IS WHAT HAPPENED, and it may be MORE than what was held - a typical hold
           is not an upper bound, so a call that ran long settles above it. The charge is booked
           whole and never clamped to the hold: clamping would hide real dollars from the very
           balance the $2.00 is enforced against, so the run would spend past its limit and report
           that it had not. The hold is released in full for the same reason - the entire figure
           this reservation took out of the balance goes back, and only the charge stays. */
        settle: (item, dollars, usageKnown = true) => {
          if (settled) return;
          settled = true;
          this.#refuseNegative(dollars);
          this.#held -= heldDollars;
          if (usageKnown) this.#dollars += dollars;
          else {
            this.#unknownDollars += dollars;
            this.#unknownUsageCalls += 1;
          }
          this.entries.push({ item, dollars, ...usageKnown ? {} : { usageKnown: false } });
          this.#wake();
        }
      }
    };
  }
  /**
   * A CHARGE IS MONEY SPENT, SO IT CANNOT BE NEGATIVE - the one site that says so.
   *
   * WHY IT IS A METHOD AND NOT THREE COPIES. Three paths book money against this balance ({@link
   * reserve}'s `settle`, {@link chargeCall} and {@link chargeOtherLane}) and each had the same guard
   * written out. A negative charge would CREDIT the run and buy it spend past its bound, so the
   * third path needed the guard too - and a third copy of the sentence is a third raw message the
   * contract counts (`packages/core/src/message-contract.ts`). One site guards all three, which is
   * what the ledger now records.
   */
  #refuseNegative(dollars) {
    if (dollars < 0) throw new Error("a ledger charge cannot be negative");
  }
  /** Let every waiter re-ask; each one re-checks for itself, so a wake is never a promotion. */
  #wake() {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const resume of waiting) resume();
  }
  recordUnpriceableCall(task) {
    this.#refusedCalls += 1;
    this.#refusedByTask.set(task, (this.#refusedByTask.get(task) ?? 0) + 1);
  }
  recordThrottleRetries(count) {
    if (!Number.isInteger(count) || count < 0) throw new Error("a throttle-retry count must be a non-negative integer");
    this.#throttleRetries += count;
  }
  /**
   * Charge the run directly, outside a model call.
   *
   * The one caller is a test scripting a run that has already spent most of its ceiling; production
   * money reaches this ledger only through {@link reserve} for the generation arm and
   * {@link chargeOtherLane} for every arm that prices itself.
   */
  chargeCall(item, dollars) {
    this.#refuseNegative(dollars);
    this.#dollars += dollars;
    this.#modelCalls += 1;
    this.entries.push({ item, dollars });
    this.#wake();
  }
  /**
   * DRAW THE RUN'S BALANCE FOR AN ARM THAT PRICES ITSELF. The production caller is triage.
   *
   * WHY IT EXISTS (captain's ruling, 2026-09-01). This ledger bounded the generation arm and nothing
   * else, so "the bound on a run" was the bound on part of a run: triage priced its own calls and
   * charged none of them here. It cannot reserve either - `packages/triage` cannot import this
   * package at all - so it does what it can do honestly: report what a call REALLY cost the moment
   * the call settles, and ask {@link remaining} before starting the next one. That is the same
   * policy the generation arm already lives under, reached by a different route.
   *
   * IT DOES NOT MOVE `dollars` OR `modelCalls`, and that is the whole reason it is not
   * {@link chargeCall}. Those two are THIS LEDGER'S OWN LANE, and every customer-facing cost line
   * sums the run's total from the lanes that report themselves - triage's own `costUsd` plus this
   * ledger's. Folding a triage charge into `dollars` would make the run's total count that money
   * twice, which is the same class of defect as reporting a partial ledger as a run total
   * (`data/abloh-cost-opt-regression-check/report.md` §7), wearing the opposite face.
   *
   * IT DOES MOVE THE BALANCE, which is the point: {@link remaining} and every {@link reserve} see it.
   */
  chargeOtherLane(item, dollars) {
    this.#refuseNegative(dollars);
    this.#otherLaneDollars += dollars;
    this.entries.push({ item, dollars });
    this.#wake();
  }
};

// src/model/startup-check.ts
import { deprecatedModelVariableWarning, deprecatedModelVariablesInUse } from "@abloh/core";
function checkModelConfiguration(env, requirements) {
  const refusals = [];
  const warnings = [];
  for (const canonical of deprecatedModelVariablesInUse(env)) {
    warnings.push(deprecatedModelVariableWarning(canonical));
  }
  const endpoint = resolveEndpoint(env);
  if (!endpoint.available) {
    if (requirements.endpointRequired) refusals.push(endpoint.reason);
    else warnings.push(`${endpoint.reason}; this run will measure but generate nothing`);
  }
  const card = rateCardFromEnvironment(env);
  if (!card.ok) {
    if (card.state === "malformed") refusals.push(card.reason);
    else if (requirements.rateCardRequired) refusals.push(card.reason);
    else if (endpoint.available) {
      warnings.push(`${card.reason}; this run's model cost will be reported as unknown, never as zero`);
    }
  }
  return { refusals, warnings };
}
export {
  ADMISSION_RULES,
  AGENT_BUG_MUTATOR,
  AIM_SOURCES,
  ALLOWED_MODEL_FAMILY,
  AzureModelClient,
  BROWSER_DRIVEN_SKIP_REASON,
  BUG_BEHAVIOUR_VERDICTS,
  BUG_HOLD_REASONS,
  BUG_POOL_PROMPT_VERSION,
  BUG_POOL_REPLY_SCHEMA,
  BUG_POOL_STORE_SCHEMA,
  BUG_POOL_TASK,
  BUG_REFUSAL_REASONS,
  BUG_ROUTES,
  BUG_SEVERITIES,
  BUG_WITNESS_REPLY_SCHEMA,
  BUG_WITNESS_TASK,
  BugPoolStore,
  CALL_OVERHEAD_MS,
  CANNOT_DISTINGUISH_HOLD_REASON,
  CARRIABLE_TRIAGE_VERDICTS,
  CARRY_BOUNDS,
  CARRY_STORE_SCHEMA,
  CATCH_PROFILE_LIMIT,
  CHECK_BODY_LIMIT,
  CHECK_CONCLUSIONS,
  CHECK_EVIDENCE_STATES,
  CHECK_GATE_STATES,
  CHECK_STREAM_COUNTERS,
  CHECK_STREAM_MIN_INTERVAL_MS,
  CHECK_STREAM_STAGES,
  CHECK_STREAM_STAGE_LABELS,
  CHECK_STREAM_STAGE_STATES,
  COMPUTE_RATE_ENV,
  CONFIG_CANDIDATES,
  CONTENT_POOL_REUSE_LIMIT,
  CheckStream,
  DECLINE_REASONS,
  DEFAULT_BUDGET,
  DEFAULT_PROOF_REPETITIONS,
  DEFAULT_TASK_PINS,
  DockerSealedRunner,
  EMPTY_DOMAIN_CONTEXT,
  ENDPOINT_AUTH_VAR,
  ENDPOINT_EFFORT_CATALOG_MESSAGE,
  ENDPOINT_KEY_VAR,
  ENDPOINT_URL_VAR,
  EXIT_VERDICTS,
  EngineUnavailableError,
  FEATURE_VERSION,
  FORCED_FULL_REASONS,
  FUNCTION_SHAPES,
  FeedbackLedger,
  GUTTING_LABELS,
  GUTTING_MUTATOR,
  GUTTING_ROUTES,
  HARD_CALL_CEILING_MS,
  INTAKE_EXCLUSION_REASONS,
  LADDER_RUNGS,
  LIGHT_CHECK_VERDICTS,
  LINE_MAP_FILE_LIMIT,
  LINE_MAP_SCHEMA,
  LINE_MUTATOR,
  LINE_OPERATORS,
  LINE_VERDICTS,
  LIVE_DEPENDENCY_HOLD_REASON,
  LOCKFILE_CANDIDATES,
  LOOP_STAGES,
  LineMapStore,
  LocalUnsealedRunner,
  MAX_BUG_RATIONALE_LEN,
  MAX_BUG_SENTENCE_LEN,
  MAX_BUG_TYPE_LEN,
  MAX_COMPLETION_TOKENS,
  MAX_DERIVED_CALL_MS,
  MAX_DOMAIN_CONSTANTS,
  MAX_DOMAIN_CONSTANT_CHARS,
  MAX_DOMAIN_INVARIANTS,
  MAX_DOMAIN_INVARIANT_CHARS,
  MAX_DOMAIN_MODULES,
  MAX_DOMAIN_MODULE_CHARS,
  MAX_DOMAIN_TYPES,
  MAX_DOMAIN_TYPE_CHARS,
  MAX_EVIDENCE_CHARS,
  MAX_PLANTED_PER_FILE,
  MAX_PLANTED_TEXT_CHARS,
  MAX_README_FRAGMENTS,
  MAX_README_FRAGMENT_CHARS,
  MEASURED_ATTEMPT_EXECUTION_MS,
  MEASURED_EXECUTIONS_PER_ATTEMPT,
  MEASURED_EXECUTION_MS,
  MEASURED_GENERATION_ROUND_MS,
  MEASURED_TOKENS_PER_SECOND,
  MIN_README_NEEDLE,
  MODEL_EFFORTS,
  MODEL_FAILURES,
  MS_PER_DAY,
  MUTANT_READINGS,
  MUTATION_SHAPES,
  MUTATION_SPANS,
  MeteredModelClient,
  NETWORK_MODULES,
  NETWORK_TRANSPORT,
  NO_TEST_HOLD_REASON,
  OPEN_NETWORK_SKIP_REASON,
  OVERLAY_UNMOUNTABLE_CHARACTERS,
  OVERLAY_WORKSPACE_CAPABILITY,
  PER_GAP_COMPLETION_TOKENS,
  POLICY_SKIP_REASONS,
  PREDICTION_LABELS,
  PREDICTOR_DECISIONS,
  PREDICTOR_MODES,
  PREDICTOR_STORE_SCHEMA,
  PROMOTED_ORIGINS,
  PROMOTED_ROUND,
  PROMPT_VERSION,
  PROPOSALS_BLOCK_SCHEMA,
  PROPOSALS_GAP_ORIGINS,
  PROPOSALS_SIDECAR_SCHEMA,
  PROPOSALS_VERDICTS,
  PROPOSALS_VERSION,
  PredictorStore,
  RATE_CARD_ENV2 as RATE_CARD_ENV,
  RATE_CARD_SCHEMA,
  REPLAY_REPETITION_RANGE,
  REUSE_DECISIONS,
  REUSE_STORE_SCHEMA,
  ROUTE_PURITY_RUNGS,
  RULED_AGENT_BUG_POOL_POLICY,
  RULED_CHECK_RUN_DOLLAR_CEILING,
  RULED_GENERATION_BATCH_SIZE,
  RULED_GENERATION_CONCURRENCY,
  RULED_IN_ROUND_REPAIR,
  RULED_LINE_PASS_ATTRIBUTION_TEST_FILES,
  RULED_LINE_PASS_MUTANTS_PER_FILE,
  RULED_MATRIX_CELLS_PER_ROUND,
  RULED_MIN_ATTEMPTS_PER_FILE,
  RULED_NIGHT_POOL2_WALL_ALLOWANCE_MS,
  RULED_POOL2_WALL_ALLOWANCE_MS,
  RULED_PREDICTOR_POLICY,
  RULED_REBASELINE_POLICY,
  RULED_SIZING_LAMBDA,
  RULED_SLICE_CAP,
  RULED_SLICE_COVERING_FILES,
  RULED_SLICE_POLICY,
  RULED_THROTTLE_RETRY,
  ReuseStore,
  RunLedger,
  SEALED_PNPM_VERIFY_DEPS,
  SEALED_RUN_LABEL,
  SEALED_WORKSPACE_ENV,
  SENTINEL_TEST_NAME,
  SHAPE_DID_NOT_REACH_HOLD_REASON,
  SLICE_DROP_REASONS,
  SLICE_LEDGER_LIMIT,
  SLICE_LEDGER_SCHEMA,
  SLICE_OUTCOMES,
  SLICE_REFUSAL_REASONS,
  SLICE_ROLES,
  STORE_OPEN_REASONS,
  SUITE_DELTA_BASES,
  SUITE_VERDICT_SOURCES,
  SliceLedger,
  SpecNotFoundError,
  TEST_SHAPES,
  TRIAGE_PROMPT_VERSION,
  TRIAGE_VERDICTS,
  TRIVIAL_VERDICTS,
  TYPICAL_COMPLETION_SHARE,
  TYPICAL_PROMPT_CHARS_PER_TOKEN,
  UNCLASSIFIED_ROUTE,
  WORKED_TEMP_ROOT_EXAMPLE,
  acceptBugDiagnosis,
  acceptBugType,
  admitCandidate,
  aimBlock,
  aimDigest,
  aimWithin,
  applyGapPatch,
  applyRebaselineOutcome,
  assertAllowedModel,
  assertRunnerFoundSpec,
  assertTargetedSpecIsPlaced,
  attemptsForFile,
  auditRound,
  batchCompletionCeiling,
  boundEvidence,
  boundEvidenceTail,
  bugIdentity,
  bugPoolStorePath,
  buildAgentBugDisclosure,
  buildAimDisclosure,
  buildBatchGenerationPrompt,
  buildBugPoolPrompt,
  buildCatchProfile,
  buildContextDigest,
  buildCoverageIndex,
  buildGapContext,
  buildKillMatrix,
  buildLineCoverageIndex,
  buildProposalsBlock,
  buildRebaselineDisclosure,
  buildRoutePurityDisclosure,
  buildSecretMountFlags,
  buildSecretPrelude,
  buildSliceDisclosure,
  buildTriagePrompt,
  buildWitnessPrompt,
  callCeilingDollars2 as callCeilingDollars,
  callSites,
  callTypicalDollars,
  candidateDigest,
  candidateIdentity,
  canonicalJson,
  carriableTriageRecord,
  carriableVerdict,
  carryIdentityDigest,
  carryKey,
  catalogDigest,
  changedFunctionKey,
  changedFunctions,
  checkModelConfiguration,
  chooseAnchor,
  chooseWinningSet,
  classicPlantedByFile,
  classicSitesByFile,
  classifyHttpFailure,
  classifyRoutePurity,
  collectDomainContext,
  compareRebaseline,
  percentOfMeasured as componentRate,
  composeProposalsBlocks,
  composedProofsDigest,
  conclusionFor,
  confirmDisagreements,
  constantsIn,
  coverageClaimSentence,
  coveringTestFiles,
  createInputRoot,
  currentWholesaleDigests,
  decisiveOutcome,
  declarationAt,
  defaultExportName,
  deriveNeighborhood,
  derivedCallDeadlineMs,
  describeCarry,
  describeMutant,
  describeReuseDisclosure,
  detectFunctions,
  dockerBuildFailureEvidence,
  dockerDaemonAvailable,
  domainBlock,
  effectiveTotalMs,
  effortBelow,
  effortsFromCatalogMessage,
  emptyFunnel,
  emptyPredictorStore,
  emptyStore,
  enclosingFunction,
  exactTestNamePattern,
  exclusionBlock,
  executionOrder,
  exportSignatures,
  exportedNames,
  exportedTypes,
  exportsLine,
  fetchModelCatalog,
  fileContentDigest,
  fileFunctions,
  fileSetDigest,
  firstDeclaredTestName,
  floorState,
  foldAuditRound,
  forcedFullReasons,
  functionName,
  fundedAskPrefix,
  fundedFileCeiling,
  gapIdentity,
  generateBatch,
  generateBugPool,
  generateWitness,
  importBindings,
  importRules,
  importSpecifierFor,
  inheritedRecipeFields,
  installCommandNeedsCorepackEnable,
  intakeSurvivors,
  isAllowedModel,
  isContainedRelativePath,
  isEmptyDomainContext,
  isPolicySkip,
  isStructurallyUntestable,
  lightCheck,
  lightCheckHoldReason,
  lineMapCoverageIndex,
  lineOperatorInventory,
  locateBug,
  looksLikeAssertion,
  looksLikeGateFailure,
  looksLikeMachinery,
  looksLikeRunnerFailureSummary,
  maskCapturedOutput,
  measureBugBaselines,
  measureSuiteBaseline,
  mergeAimSpans,
  mocksTargetModule,
  modelPinString,
  modelPinsDigest,
  moduleBlock,
  moduleSpecifiers,
  movesAgainstTheScore,
  mutableSitesOnLines,
  mutationShape,
  mutationSpan,
  nonEmptyAims,
  normalizeSpan,
  overlapsAnyRange,
  overlayVolumeOptions,
  parseBugPoolReply,
  parseCandidatesReply,
  parseRetryAfterMs,
  parseTestReport,
  parseTriageReply,
  parseWitnessReply,
  placeCandidate,
  placementBlock,
  placementOf,
  planCarry,
  planGutting,
  planLineMutants,
  planNeighborhoodSlice,
  planPoolSizing,
  planPredictor,
  planReuse,
  planThrottleRetry,
  pool2ScoreComponent,
  predictGap,
  predictorDisclosure,
  predictorMode,
  proveCandidate,
  proveExit,
  proveSuite,
  proveWitness,
  pseudoTestedGaps,
  rateCardFromEnvironment,
  reachDigest,
  readMutantRun,
  readValidCandidate,
  readValidIdentity,
  readValidTriage,
  readmeFragments,
  rebaselineDue,
  rebaselineStatus,
  recomposeProposalsScore,
  renderMeasuring,
  renderVerdict,
  repositoryDigest,
  resolveChatUrl,
  resolveEndpoint,
  resolveImport,
  resolveModelsUrl,
  resolveReportedSpan,
  resolveResponsesUrl,
  routeTestShape,
  runAgentBugPool,
  runGuttingPass,
  runLinePass,
  runMarigold,
  runNeighborhoodSlice,
  rungKey,
  runnerRelativeTestFile,
  scoreComponent,
  sealedImageTag,
  sealedWorkspaceDefault,
  sealedWorkspaceImageTag,
  sealedWorkspaceRequested,
  seededAuditSlice,
  selectLineMutants,
  sentinelSource,
  sha256,
  sha256Bytes,
  sidecarDigest,
  sizingSitesOf,
  sliceAnswerKey,
  sliceSourceFiles,
  spanIdentity,
  spanOffsets,
  specNotFoundEvidence,
  storeLossIsEmpty,
  storePartitionKey,
  stridedSample,
  stripComments,
  stripLiteralsAndComments,
  structuralDigest2 as structuralDigest,
  substituteTargetedArgs,
  suiteDelta,
  suiteTestPackages,
  summarizeAuditWindow,
  survivorPool2Projection,
  survivorProofsProjection,
  targetedArgsFor,
  taskModelIdentity,
  throttleBackoffMs,
  toSideRun,
  trainPredictor,
  transportTimeoutsMs,
  triageGaps,
  trivialTriage,
  twoRates,
  unavailableCode,
  unavailableDetail,
  uncoveredSitesByFile,
  untestedLineVerdicts,
  uploadableSidecarText,
  usageDollars2 as usageDollars,
  validateAgentBugPoolPolicy,
  validatePredictorPolicy,
  validateRebaselinePolicy,
  validateSizingPolicy,
  validateSlicePolicy,
  validateThrottleRetryPolicy,
  verifyModelFamily,
  verifyModelPin,
  wholesalePaths
};
