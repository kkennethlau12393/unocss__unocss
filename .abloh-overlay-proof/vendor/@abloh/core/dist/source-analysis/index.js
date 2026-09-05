// src/source-analysis/ast.ts
import ts from "typescript";
function scriptKindFor(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".mts") || fileName.endsWith(".cts") || fileName.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}
function parseSource(fileName, source) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/
    true,
    scriptKindFor(fileName)
  );
  const diags = sourceFile.parseDiagnostics ?? [];
  return { sourceFile, parseOk: diags.length === 0 };
}
function lineOf(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}
function commentInNodeMatches(node, sourceFile, source, pattern) {
  const start = node.getStart(sourceFile);
  const text = source.slice(start, node.getEnd());
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /*skipTrivia*/
    false,
    ts.LanguageVariant.Standard,
    text
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      if (pattern.test(scanner.getTokenText())) return true;
    }
  }
  return false;
}

// src/source-analysis/mutation-recipes.ts
import { createHash } from "crypto";
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function offsetOf(source, line, column) {
  let lineStart = 0;
  let curLine = 1;
  for (let i = 0; i < source.length && curLine < line; i++) {
    if (source[i] === "\n") {
      lineStart = i + 1;
      curLine++;
    }
  }
  const off = lineStart + (column - 1);
  return off < 0 ? 0 : off > source.length ? source.length : off;
}
function lineEndOffset(source, line) {
  let lineStart = 0;
  let curLine = 1;
  for (let i = 0; i < source.length && curLine < line; i++) {
    if (source[i] === "\n") {
      lineStart = i + 1;
      curLine++;
    }
  }
  if (curLine < line) return -1;
  const nl = source.indexOf("\n", lineStart);
  return nl === -1 ? source.length : nl;
}
function strictOffsetOf(source, line, column) {
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return null;
  const end = lineEndOffset(source, line);
  if (end < 0) return null;
  const start = offsetOf(source, line, 1);
  const off = start + (column - 1);
  return off > end ? null : off;
}
function recipeId(file, startOffset, endOffset, original, replacement) {
  return sha256([file, startOffset, endOffset, original, replacement].join("\0"));
}
function recipeFromSpan(file, source, span, replacement, category) {
  const r = tryRecipeFromSpan(file, source, span, replacement, category);
  if (!r) throw new Error(`span out of range for ${file}: ${JSON.stringify(span)}`);
  return r;
}
function tryRecipeFromSpan(file, source, span, replacement, category) {
  const startOffset = strictOffsetOf(source, span.startLine, span.startColumn);
  const endOffset = strictOffsetOf(source, span.endLine, span.endColumn);
  if (startOffset === null || endOffset === null || endOffset < startOffset) return null;
  const original = source.slice(startOffset, endOffset);
  return {
    file,
    startOffset,
    endOffset,
    original,
    replacement,
    sourceDigest: sha256(source),
    id: recipeId(file, startOffset, endOffset, original, replacement),
    ...category !== void 0 ? { category } : {}
  };
}
function recipeFromOffsets(file, source, startOffset, endOffset, replacement, category) {
  const original = source.slice(startOffset, endOffset);
  return {
    file,
    startOffset,
    endOffset,
    original,
    replacement,
    sourceDigest: sha256(source),
    id: recipeId(file, startOffset, endOffset, original, replacement),
    ...category !== void 0 ? { category } : {}
  };
}
function applyRecipe(source, recipe) {
  if (recipe.startOffset < 0 || recipe.endOffset < recipe.startOffset || recipe.endOffset > source.length) {
    return { ok: false, reason: "bad-span" };
  }
  if (sha256(source) !== recipe.sourceDigest) return { ok: false, reason: "source-drift" };
  if (source.slice(recipe.startOffset, recipe.endOffset) !== recipe.original) return { ok: false, reason: "slice-mismatch" };
  return { ok: true, result: source.slice(0, recipe.startOffset) + recipe.replacement + source.slice(recipe.endOffset) };
}
function escapeMutatePath(path) {
  return path.replace(/[[\]{}*?!+@()|]/g, (c) => `\\${c}`);
}

// src/source-analysis/error-handlers.ts
var TODO_RE = /\b(?:TODO|FIXME)\b/;
function isAbortCall(expr) {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const obj = callee.expression;
  if (!ts.isIdentifier(obj)) return false;
  const method = callee.name.text;
  const holder = obj.text;
  return holder === "process" && (method === "exit" || method === "abort") || holder === "Deno" && method === "exit" || holder === "Bun" && method === "exit";
}
function hasHandlerLevelAbort(block) {
  for (const stmt of block.statements) {
    if (ts.isExpressionStatement(stmt) && isAbortCall(stmt.expression)) return true;
  }
  return false;
}
function scanFileHandlers(fileName, source, changedLines) {
  const parsed = parseSource(fileName, source);
  if (!parsed.parseOk) return { antiPatterns: [], changedHandlers: [], parseOk: false };
  const sf = parsed.sourceFile;
  const antiPatterns = [];
  const changedHandlers = [];
  const intersectsChange = (startLine, endLine) => {
    for (let l = startLine; l <= endLine; l++) if (changedLines.has(l)) return true;
    return false;
  };
  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const startLine = lineOf(sf, node.getStart(sf));
      const endLine = lineOf(sf, node.getEnd());
      if (intersectsChange(startLine, endLine)) {
        changedHandlers.push({ file: fileName, startLine, endLine });
        const push = (kind) => antiPatterns.push({ file: fileName, startLine, endLine, kind });
        if (node.block.statements.length === 0) push("empty-catch");
        if (hasHandlerLevelAbort(node.block)) push("catch-all-abort");
        if (commentInNodeMatches(node, sf, source, TODO_RE)) push("todo-in-handler");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { antiPatterns, changedHandlers, parseOk: true };
}
function forcedHandlerRecipes(fileName, source, changedLines) {
  const parsed = parseSource(fileName, source);
  if (!parsed.parseOk) return [];
  const sf = parsed.sourceFile;
  const recipes = [];
  const intersectsChange = (startLine, endLine) => {
    for (let l = startLine; l <= endLine; l++) if (changedLines.has(l)) return true;
    return false;
  };
  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const startLine = lineOf(sf, node.getStart(sf));
      const endLine = lineOf(sf, node.getEnd());
      if (intersectsChange(startLine, endLine)) {
        const target = node.block.statements.find((st) => {
          if (ts.isEmptyStatement(st)) return false;
          if (source.slice(st.getStart(sf), st.getEnd()).trim() === ";") return false;
          const s0 = lineOf(sf, st.getStart(sf));
          const e0 = lineOf(sf, st.getEnd());
          for (let l = s0; l <= e0; l++) if (!changedLines.has(l)) return false;
          return true;
        });
        if (target) {
          const s = target.getStart(sf);
          const e = target.getEnd();
          recipes.push(recipeFromOffsets(fileName, source, s, e, ";", "error-handler"));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  recipes.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.startOffset - b.startOffset);
  return recipes;
}
function scanErrorHandlers(inputs) {
  const antiPatterns = [];
  const changedHandlers = [];
  let quality = "complete";
  for (const { file, source, changedLines } of inputs) {
    const r = scanFileHandlers(file, source, changedLines);
    if (!r.parseOk) {
      quality = "partial";
      continue;
    }
    antiPatterns.push(...r.antiPatterns);
    changedHandlers.push(...r.changedHandlers);
  }
  const key = (h) => `${h.file}:${h.startLine}:${h.endLine}`;
  antiPatterns.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
  changedHandlers.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return { antiPatterns, changedHandlers, quality };
}

// src/workdir-path.ts
import { isAbsolute, relative } from "path";
function toWorkdirRelPosix(file, workDir) {
  if (!file) return file;
  let f = file;
  if (workDir && isAbsolute(f)) {
    const rel = relative(workDir, f);
    if (rel.length > 0 && !rel.startsWith("..")) f = rel;
  }
  return f.replace(/\\/g, "/");
}

// src/source-analysis/test-analysis.ts
var EXPECT_MATCHERS = /* @__PURE__ */ new Set(["toBe", "toEqual", "toStrictEqual"]);
var ASSERT_EQ_METHODS = /* @__PURE__ */ new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual", "deepEqual"]);
var ASSERT_TRUTHY_METHODS = /* @__PURE__ */ new Set(["ok", "isTrue"]);
function sameText(a, b, sf) {
  if (a.getText(sf).trim() !== b.getText(sf).trim()) return false;
  return isPurelyReferential(a) && isPurelyReferential(b);
}
function isPurelyReferential(n) {
  let ok = true;
  const visit = (node) => {
    if (!ok) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isPropertyAccessExpression(node) || // may hit a getter / Proxy trap
    ts.isElementAccessExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) || // ++x / x-- mutate between evaluations
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      ok = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(n);
  return ok;
}
function isTrueLiteral(n) {
  return n.kind === ts.SyntaxKind.TrueKeyword;
}
function classifyCall(call, sf) {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    const obj = callee.expression;
    const method = callee.name.text;
    if (ts.isCallExpression(obj) && ts.isIdentifier(obj.expression) && obj.expression.text === "expect") {
      if (!EXPECT_MATCHERS.has(method)) return "unknown";
      const lhs = obj.arguments[0];
      const rhs = call.arguments[0];
      if (!lhs || !rhs) return "unknown";
      return sameText(lhs, rhs, sf) ? "tautology" : "non-tautology";
    }
    if (ts.isIdentifier(obj) && obj.text === "assert") {
      if (ASSERT_EQ_METHODS.has(method)) {
        const a = call.arguments[0];
        const b = call.arguments[1];
        if (!a || !b) return "unknown";
        return sameText(a, b, sf) ? "tautology" : "non-tautology";
      }
      if (ASSERT_TRUTHY_METHODS.has(method)) {
        const a = call.arguments[0];
        return a && isTrueLiteral(a) ? "tautology" : "non-tautology";
      }
      return "unknown";
    }
    return null;
  }
  if (ts.isIdentifier(callee) && callee.text === "assert") {
    const a = call.arguments[0];
    return a && isTrueLiteral(a) ? "tautology" : "non-tautology";
  }
  return null;
}
var TEST_FNS = /* @__PURE__ */ new Set(["it", "test"]);
var DESCRIBE_FNS = /* @__PURE__ */ new Set(["describe", "suite"]);
var TEST_MODIFIERS = /* @__PURE__ */ new Set(["only", "skip", "todo", "failing", "concurrent", "each", "fails"]);
function isParameterized(expr) {
  let node = expr;
  while (ts.isCallExpression(node)) node = node.expression;
  while (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "each") return true;
    node = node.expression;
  }
  return false;
}
function testCallName(expr) {
  let node = expr;
  while (ts.isCallExpression(node)) node = node.expression;
  while (ts.isPropertyAccessExpression(node) && TEST_MODIFIERS.has(node.name.text)) node = node.expression;
  if (ts.isIdentifier(node)) return node.text;
  return null;
}
function stringArg(call) {
  const a = call.arguments[0];
  if (a && ts.isStringLiteralLike(a)) return a.text;
  return null;
}
function scanFile(fileName, source, out, workDir) {
  const parsed = parseSource(fileName, source);
  if (!parsed.parseOk) return false;
  const sf = parsed.sourceFile;
  const relFile = toWorkdirRelPosix(fileName, workDir);
  let parameterizedSkipped = false;
  const walkTestBody = (body) => {
    let taut = 0;
    let real = 0;
    let unknown = 0;
    const visit2 = (n) => {
      if (ts.isCallExpression(n)) {
        const inner = testCallName(n.expression);
        if (inner !== null && (TEST_FNS.has(inner) || DESCRIBE_FNS.has(inner))) return;
      }
      if (ts.isCallExpression(n)) {
        const cls = classifyCall(n, sf);
        if (cls === "tautology") taut++;
        else if (cls === "non-tautology") real++;
        else if (cls === "unknown") unknown++;
      }
      ts.forEachChild(n, visit2);
    };
    ts.forEachChild(body, visit2);
    return { taut, real, unknown };
  };
  const visit = (node, describeStack) => {
    if (ts.isCallExpression(node) && testCallName(node.expression) !== null) {
      const fn = testCallName(node.expression);
      const title = stringArg(node);
      const cb = node.arguments.find((a) => ts.isFunctionExpression(a) || ts.isArrowFunction(a));
      if (DESCRIBE_FNS.has(fn) && title !== null && cb?.body) {
        const nested = [...describeStack, title];
        ts.forEachChild(cb.body, (c) => visit(c, nested));
        return;
      }
      if (TEST_FNS.has(fn) && isParameterized(node.expression)) {
        parameterizedSkipped = true;
        return;
      }
      if (TEST_FNS.has(fn) && title !== null && cb?.body) {
        const fullName = [...describeStack, title].join(" ");
        const { taut, real, unknown } = walkTestBody(cb.body);
        if (taut > 0 && real === 0 && unknown === 0) out.push(`${relFile}::${fullName}`);
        return;
      }
    }
    ts.forEachChild(node, (c) => visit(c, describeStack));
  };
  visit(sf, []);
  return !parameterizedSkipped;
}
function scanTautologies(inputs, workDir) {
  const tautologicalTests = [];
  let quality = inputs.length === 0 ? "partial" : "complete";
  for (const { file, source } of inputs) {
    if (!scanFile(file, source, tautologicalTests, workDir)) quality = "partial";
  }
  tautologicalTests.sort();
  return { tautologicalTests, quality };
}

// src/source-analysis/reachability.ts
import { dirname, isAbsolute as isAbsolute2, resolve as resolvePath } from "path";
var FUNCTION_LIKE = /* @__PURE__ */ new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor
]);
var SERVICE_MODULES = [
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "sqlite3",
  "better-sqlite3",
  "mongodb",
  "mongoose",
  "ioredis",
  "redis",
  "@clickhouse/client",
  "kafkajs",
  "amqplib",
  "@prisma/client",
  "aws-sdk",
  "@aws-sdk/",
  "nodemailer",
  "puppeteer",
  "playwright",
  "@playwright/test"
];
var BUILTIN_TYPES = /* @__PURE__ */ new Set([
  "Array",
  "Promise",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "ReturnType",
  "Parameters",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Error",
  "Function",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Iterable",
  "AsyncIterable",
  "Generator",
  "unknown",
  "any",
  "void",
  "never",
  "null",
  "undefined",
  "string",
  "number",
  "boolean",
  "object",
  "symbol",
  "bigint",
  "this"
]);
function enclosingNodes(sf, start, end) {
  const hits = [];
  const visit = (n) => {
    const ns = n.getStart(sf);
    const ne = n.getEnd();
    if (ne < start || ns > end) return;
    if (ns <= start && ne >= end) hits.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits.filter((n) => !ts.isSourceFile(n)).sort((a, b) => a.getEnd() - a.getStart(sf) - (b.getEnd() - b.getStart(sf)));
}
function modifiersOf(node) {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
}
function hasModifier(node, kind) {
  return modifiersOf(node).some((m) => m.kind === kind);
}
function moduleExportSurface(sourceFile) {
  const out = /* @__PURE__ */ new Set();
  const declarations = /* @__PURE__ */ new Map();
  let hasDefault = false;
  const locals = /* @__PURE__ */ new Map();
  for (const stmt of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
      locals.set(stmt.name.text, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) locals.set(d.name.text, d);
      }
    }
  }
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt)) {
      if (!stmt.isExportEquals) {
        hasDefault = true;
        if (ts.isIdentifier(stmt.expression)) {
          const local = locals.get(stmt.expression.text);
          if (local) declarations.set("default", local);
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const localName = (el.propertyName ?? el.name).text;
        const bound = stmt.moduleSpecifier ? void 0 : locals.get(localName);
        if (el.name.text === "default") {
          hasDefault = true;
          if (bound) declarations.set("default", bound);
        } else {
          out.add(el.name.text);
          if (bound) declarations.set(el.name.text, bound);
        }
      }
      continue;
    }
    const mods = modifiersOf(stmt);
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      hasDefault = true;
      declarations.set("default", stmt);
      continue;
    }
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
      out.add(stmt.name.text);
      declarations.set(stmt.name.text, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          out.add(d.name.text);
          declarations.set(d.name.text, d);
        }
      }
    }
  }
  return { named: [...out].sort(), hasDefault, declarations };
}
function functionOf(decl) {
  if (FUNCTION_LIKE.has(decl.kind)) return decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer && FUNCTION_LIKE.has(decl.initializer.kind)) {
    return decl.initializer;
  }
  return null;
}
function nameOfFunction(node, sf) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    const owner = node.parent && ts.isClassDeclaration(node.parent) ? node.parent.name?.text : void 0;
    const member = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
    if (!member) return null;
    return owner ? `${owner}.${member}` : member;
  }
  if (ts.isConstructorDeclaration(node)) {
    const owner = node.parent && ts.isClassDeclaration(node.parent) ? node.parent.name?.text : void 0;
    return owner ? `${owner}.constructor` : "constructor";
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  void sf;
  return null;
}
function collectTypeNames(node, into) {
  if (!node) return;
  const visit = (n) => {
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
      const name = n.typeName.text;
      if (!BUILTIN_TYPES.has(name)) into.add(name);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}
function signatureOf(fn, sf, name) {
  const parameters = fn.parameters.map((p) => ({
    // a destructuring pattern keeps its literal text — it shows which keys the code reads
    name: p.name.getText(sf),
    optional: p.questionToken !== void 0 || p.initializer !== void 0,
    type: p.type ? p.type.getText(sf).slice(0, 200) : null,
    rest: p.dotDotDotToken !== void 0
  }));
  const returnType = fn.type ? fn.type.getText(sf).slice(0, 200) : null;
  const typeNames = /* @__PURE__ */ new Set();
  for (const p of fn.parameters) collectTypeNames(p.type, typeNames);
  collectTypeNames(fn.type, typeNames);
  const rendered = parameters.map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}${p.type ? `: ${p.type}` : ""}`).join(", ");
  return {
    name,
    signature: `${name}(${rendered})${returnType ? `: ${returnType}` : ""}`,
    parameters,
    returnType,
    isAsync: hasModifier(fn, ts.SyntaxKind.AsyncKeyword),
    typeNames: [...typeNames]
  };
}
function buildCallGraph(sf) {
  const nodes = /* @__PURE__ */ new Map();
  const collect = (n) => {
    if (FUNCTION_LIKE.has(n.kind)) {
      const name = nameOfFunction(n, sf);
      if (name && !nodes.has(name)) nodes.set(name, { name, fn: n, calls: /* @__PURE__ */ new Map() });
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (const node of nodes.values()) {
    const body = node.fn.body;
    if (!body) continue;
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        let callee = null;
        if (ts.isIdentifier(n.expression)) callee = n.expression.text;
        else if (ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const cls = ts.findAncestor(n, ts.isClassDeclaration)?.name?.text;
          callee = cls ? `${cls}.${n.expression.name.text}` : n.expression.name.text;
        }
        if (callee && !node.calls.has(callee)) {
          const line = lineOf(sf, n.getStart(sf));
          const text = sf.text.split("\n")[line - 1]?.trim() ?? "";
          node.calls.set(callee, `${line}: ${text.slice(0, 200)}`);
        }
      }
      if (ts.isIdentifier(n) && nodes.has(n.text) && n.text !== node.name) {
        const p = n.parent;
        const isMemberName = p !== void 0 && ts.isPropertyAccessExpression(p) && p.name === n;
        const isObjectKey = p !== void 0 && (ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === n;
        const isDeclName = p !== void 0 && p.name === n && !ts.isCallExpression(p);
        if (!isMemberName && !isObjectKey && !isDeclName && !node.calls.has(n.text)) {
          const line = lineOf(sf, n.getStart(sf));
          node.calls.set(n.text, `${line}: ${sf.text.split("\n")[line - 1]?.trim().slice(0, 200) ?? ""}`);
        }
      }
      if (n !== body && FUNCTION_LIKE.has(n.kind)) {
        const nested = nameOfFunction(n, sf);
        if (nested) {
          if (!node.calls.has(nested) && nested !== node.name) {
            const line = lineOf(sf, n.getStart(sf));
            node.calls.set(nested, `${line}: ${sf.text.split("\n")[line - 1]?.trim().slice(0, 200) ?? ""}`);
          }
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
  }
  return nodes;
}
var UNAVAILABLE = (surface) => ({
  quality: "unavailable",
  reachability: "unknown",
  enclosing: null,
  entryPoints: [],
  exportSurface: surface,
  serviceImports: []
});
var EMPTY_SURFACE = { named: [], hasDefault: false, declarations: /* @__PURE__ */ new Map() };
function importedSpecifiers(sf) {
  const out = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require" && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0])) {
      out.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
function analyzeReachability(input) {
  const maxEntryPoints = input.maxEntryPoints ?? 3;
  const maxDepth = input.maxDepth ?? 4;
  let parsed;
  try {
    parsed = parseSource(input.fileName, input.source);
  } catch {
    return UNAVAILABLE(EMPTY_SURFACE);
  }
  if (!parsed.parseOk) return UNAVAILABLE(EMPTY_SURFACE);
  const sf = parsed.sourceFile;
  let surface;
  try {
    surface = moduleExportSurface(sf);
  } catch {
    return UNAVAILABLE(EMPTY_SURFACE);
  }
  const serviceImports = [...new Set(importedSpecifiers(sf).filter((spec) => SERVICE_MODULES.some((m) => spec === m || spec.startsWith(m))))];
  const containers = enclosingNodes(sf, input.startOffset, input.endOffset);
  const fnNode = containers.find((n) => FUNCTION_LIKE.has(n.kind));
  if (!fnNode) {
    return {
      quality: "complete",
      reachability: "exported-directly",
      enclosing: null,
      entryPoints: [],
      exportSurface: surface,
      serviceImports
    };
  }
  const fnName = nameOfFunction(fnNode, sf);
  const enclosing = {
    name: fnName,
    // getStart(sf, true) includes leading JSDoc — the comment often states the contract the test
    // must exercise, and dropping it loses the most useful sentence in the file
    text: sf.text.slice(fnNode.getStart(sf, true), fnNode.getEnd()),
    startLine: lineOf(sf, fnNode.getStart(sf)),
    endLine: lineOf(sf, fnNode.getEnd()),
    exported: false,
    typeNames: (() => {
      const into = /* @__PURE__ */ new Set();
      const sig = fnNode;
      for (const p of sig.parameters ?? []) collectTypeNames(p.type, into);
      collectTypeNames(sig.type, into);
      return [...into];
    })()
  };
  const exportedNames = /* @__PURE__ */ new Set([...surface.declarations.keys()]);
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isIdentifier(stmt.expression)) exportedNames.add(stmt.expression.text);
  }
  const isExportedLocally = (name) => exportedNames.has(name) || surface.named.includes(name);
  const directName = fnName && exportedNames.has(fnName) ? fnName : fnName && surface.named.includes(fnName) ? fnName : null;
  if (directName) {
    enclosing.exported = true;
    const fn = functionOf(surface.declarations.get(directName) ?? fnNode) ?? fnNode;
    return {
      quality: "complete",
      reachability: "exported-directly",
      enclosing,
      entryPoints: [{ ...signatureOf(fn, sf, directName), kind: "function", path: [directName], callSites: [] }],
      exportSurface: surface,
      serviceImports
    };
  }
  if (!fnName) {
    return { quality: "unavailable", reachability: "unknown", enclosing, entryPoints: [], exportSurface: surface, serviceImports };
  }
  const graph = buildCallGraph(sf);
  const roots = [...surface.declarations.entries()].map(([name, decl]) => ({ name, node: functionOf(decl) ? nameOfFunction(functionOf(decl), sf) ?? name : name })).sort((a, b) => a.name.localeCompare(b.name));
  const routesTo = (target, tail = []) => {
    const out = [];
    for (const root of roots) {
      if (out.length >= maxEntryPoints) break;
      const start = graph.get(root.node) ?? graph.get(root.name);
      if (!start) continue;
      const queue = [{ name: start.name, path: [start.name], sites: [] }];
      const seen = /* @__PURE__ */ new Set([start.name]);
      while (queue.length > 0) {
        const cur = queue.shift();
        if (cur.path.length > maxDepth) continue;
        if (cur.name === target) {
          const decl = surface.declarations.get(root.name);
          const fn = (decl && functionOf(decl)) ?? start.fn;
          out.push({
            ...signatureOf(fn, sf, root.name),
            kind: decl && ts.isVariableDeclaration(decl) ? "variable" : root.name === "default" ? "default" : ts.isMethodDeclaration(fn) ? "method" : "function",
            path: [...cur.path, ...tail],
            callSites: cur.sites
          });
          break;
        }
        const node = graph.get(cur.name);
        if (!node) continue;
        for (const [callee, site] of node.calls) {
          if (seen.has(callee)) continue;
          seen.add(callee);
          queue.push({ name: callee, path: [...cur.path, callee], sites: [...cur.sites, site] });
        }
      }
    }
    return out;
  };
  const found = routesTo(fnName);
  if (found.length === 0) {
    const ancestors = containers.filter((n) => n !== fnNode && FUNCTION_LIKE.has(n.kind));
    const tail = [fnName];
    for (const anc of ancestors) {
      const ancName = nameOfFunction(anc, sf);
      if (!ancName) continue;
      if (isExportedLocally(ancName)) {
        const decl = surface.declarations.get(ancName);
        const fn = (decl && functionOf(decl)) ?? anc;
        found.push({
          ...signatureOf(fn, sf, ancName),
          kind: decl && ts.isVariableDeclaration(decl) ? "variable" : "function",
          path: [ancName, ...tail],
          callSites: []
        });
        break;
      }
      found.push(...routesTo(ancName, tail));
      if (found.length > 0) break;
      tail.unshift(ancName);
    }
  }
  if (found.length === 0) {
    const cls = ts.findAncestor(fnNode, ts.isClassDeclaration);
    const clsName = cls?.name?.text;
    if (clsName && isExportedLocally(clsName)) {
      found.push({
        ...signatureOf(fnNode, sf, fnName),
        kind: "method",
        path: [clsName, fnName],
        callSites: []
      });
    }
  }
  if (found.length === 0) {
    const owner = ts.findAncestor(fnNode, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return isExportedLocally(n.name.text);
      if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) return isExportedLocally(n.name.text);
      return false;
    });
    const ownerName = owner ? owner.name?.text ?? null : null;
    if (ownerName) {
      found.push({
        ...signatureOf(fnNode, sf, fnName),
        kind: "variable",
        path: [ownerName, fnName],
        callSites: []
      });
    }
  }
  found.sort((a, b) => a.path.length - b.path.length || a.name.localeCompare(b.name));
  const referencedElsewhere = () => {
    const own = fnNode.getStart(sf);
    const ownEnd = fnNode.getEnd();
    const bare = fnName.includes(".") ? fnName.slice(fnName.lastIndexOf(".") + 1) : fnName;
    let hit = false;
    const scan = (n) => {
      if (hit) return;
      if (ts.isIdentifier(n) && (n.text === fnName || n.text === bare)) {
        const at = n.getStart(sf);
        if (at < own || at >= ownEnd) hit = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(sf);
    return hit;
  };
  const reachability = found.length > 0 ? "reachable-via" : referencedElsewhere() ? "unknown" : "unreachable";
  return {
    quality: "complete",
    reachability,
    enclosing,
    entryPoints: found.slice(0, maxEntryPoints),
    exportSurface: surface,
    serviceImports
  };
}
var TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
function collectTypeContext(input) {
  const maxChars = input.maxChars ?? 6e3;
  const wanted = [...new Set(input.names)].filter((n) => !BUILTIN_TYPES.has(n));
  if (wanted.length === 0) return { text: "", resolved: [], unresolved: [] };
  let parsed;
  try {
    parsed = parseSource(input.fileName, input.source);
  } catch {
    return { text: "", resolved: [], unresolved: [...wanted] };
  }
  if (!parsed.parseOk) return { text: "", resolved: [], unresolved: [...wanted] };
  const sf = parsed.sourceFile;
  const localNode = (file, name) => {
    for (const stmt of file.statements) {
      if ((ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === name) {
        return stmt;
      }
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return stmt;
        }
      }
    }
    return null;
  };
  const textOf = (file, stmt) => file.text.slice(stmt.getStart(file, true), stmt.getEnd());
  const localDecl = (file, name) => {
    const stmt = localNode(file, name);
    return stmt ? textOf(file, stmt) : null;
  };
  const deferredTo = (stmt) => {
    if (ts.isInterfaceDeclaration(stmt)) {
      if (stmt.members.length > 0) return [];
      const out2 = /* @__PURE__ */ new Set();
      for (const h of stmt.heritageClauses ?? []) {
        for (const e of h.types) if (ts.isIdentifier(e.expression)) out2.add(e.expression.text);
      }
      return [...out2];
    }
    if (ts.isEnumDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isVariableStatement(stmt)) return [];
    if (!ts.isTypeAliasDeclaration(stmt)) return [];
    if (ts.isTypeLiteralNode(stmt.type) && stmt.type.members.length > 0) return [];
    const out = /* @__PURE__ */ new Set();
    const visit = (n) => {
      if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && !BUILTIN_TYPES.has(n.typeName.text)) out.add(n.typeName.text);
      if (ts.isTypeQueryNode(n) && ts.isIdentifier(n.exprName)) out.add(n.exprName.text);
      ts.forEachChild(n, visit);
    };
    visit(stmt.type);
    out.delete(stmt.name.text);
    return [...out];
  };
  const forwardedFrom = (file, name) => {
    for (const stmt of file.statements) {
      if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
      for (const el of stmt.exportClause.elements) {
        if (el.name.text !== name) continue;
        return { spec: stmt.moduleSpecifier.text, original: (el.propertyName ?? el.name).text };
      }
    }
    return null;
  };
  const importedFrom = /* @__PURE__ */ new Map();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const el of clause.namedBindings.elements) importedFrom.set(el.name.text, spec);
  }
  const chunks = [];
  const resolved = [];
  const unresolved = [];
  let used = 0;
  const cache = /* @__PURE__ */ new Map();
  const emitted = /* @__PURE__ */ new Set();
  const emitWithShape = (file, stmt, label, depth) => {
    const key = `${file.fileName}\0${stmt.getStart(file)}`;
    if (emitted.has(key)) return true;
    const text = textOf(file, stmt);
    if (used + text.length > maxChars) return false;
    emitted.add(key);
    chunks.push(label ? `// from ${label}
${text}` : text);
    used += text.length + (label ? label.length + 10 : 0);
    const defers = deferredTo(stmt);
    if (defers.length === 0) return true;
    if (depth <= 0) return false;
    let any = false;
    for (const next of defers) {
      const nextStmt = localNode(file, next);
      if (nextStmt && emitWithShape(file, nextStmt, null, depth - 1)) any = true;
    }
    return any;
  };
  for (const name of wanted) {
    const localStmt = localNode(sf, name);
    if (localStmt) {
      if (emitWithShape(sf, localStmt, null, 2)) resolved.push(name);
      else unresolved.push(name);
      continue;
    }
    const spec = importedFrom.get(name);
    if (!spec || !(spec.startsWith("./") || spec.startsWith("../"))) {
      unresolved.push(name);
      continue;
    }
    const resolveSpec = (fromFile, spec2) => {
      const key = `${fromFile}\0${spec2}`;
      const hit = cache.get(key);
      if (hit !== void 0) return hit;
      let out = null;
      const base = isAbsolute2(spec2) ? spec2 : resolvePath(dirname(fromFile), spec2);
      const jsToTs = {
        ".js": [".ts", ".tsx", ".d.ts", ".js", ".jsx"],
        ".mjs": [".mts", ".d.mts", ".mjs"],
        ".cjs": [".cts", ".d.cts", ".cjs"]
      };
      const extMatch = /\.[a-z]+$/i.exec(base);
      const stripped = extMatch ? base.slice(0, -extMatch[0].length) : base;
      const candidates = extMatch ? [...(jsToTs[extMatch[0].toLowerCase()] ?? []).map((e) => `${stripped}${e}`), base] : [...TS_EXTS.map((e) => `${base}${e}`), ...TS_EXTS.map((e) => `${base}/index${e}`)];
      for (const cand of candidates) {
        const text = input.readFile(cand);
        if (text === null) continue;
        try {
          const p = parseSource(cand, text);
          if (p.parseOk) {
            out = p.sourceFile;
            break;
          }
        } catch {
        }
      }
      cache.set(key, out);
      return out;
    };
    let file = resolveSpec(input.fileName, spec);
    let want = name;
    const seen = /* @__PURE__ */ new Set();
    for (let hop = 0; hop < 3 && file; hop += 1) {
      if (localDecl(file, want)) break;
      const fwd = forwardedFrom(file, want);
      if (!fwd || !(fwd.spec.startsWith("./") || fwd.spec.startsWith("../"))) break;
      const key = `${file.fileName}\0${fwd.spec}\0${fwd.original}`;
      if (seen.has(key)) break;
      seen.add(key);
      const next = resolveSpec(file.fileName, fwd.spec);
      if (!next) break;
      file = next;
      want = fwd.original;
    }
    const stmt = file ? localNode(file, want) : null;
    if (stmt && file && emitWithShape(file, stmt, spec, 2)) resolved.push(name);
    else unresolved.push(name);
  }
  return { text: chunks.join("\n\n"), resolved, unresolved };
}

// src/findings.ts
var MUTATOR_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

// src/source-analysis/cluster.ts
function locate(source, m) {
  if (m.startColumn === void 0 || m.endColumn === void 0) {
    return { reason: "no column recorded \u2014 the engine report carried line granularity only" };
  }
  const candidates = [];
  const push = (sc, ec) => {
    const s = strictOffsetOf(source, m.startLine, sc);
    const e = strictOffsetOf(source, m.endLine, ec);
    if (s !== null && e !== null && e >= s) candidates.push([s, e]);
  };
  push(m.startColumn, m.endColumn);
  push(m.startColumn + 1, m.endColumn + 1);
  if (candidates.length === 0) return { reason: "column does not lie on its declared line" };
  if (m.originalText === void 0) {
    const [s, e] = candidates[0];
    return { start: s, end: e };
  }
  for (const [s, e] of candidates) {
    if (source.slice(s, e) === m.originalText) return { start: s, end: e };
  }
  return { reason: "the recorded original text is not at the reported coordinates (source drift?)" };
}
function lineKey(m) {
  return `${m.file} ${m.startLine} ${m.endLine}`;
}
function statementKey(sf, start, end) {
  const stmt = enclosingNodes(sf, start, end).find((n) => ts.isStatement(n));
  if (!stmt) return null;
  return `${stmt.getStart(sf)}-${stmt.getEnd()}`;
}
var MAX_CONTAINMENT_CHARS = 2e3;
var clusterOf = (by, members) => {
  const first = members[0];
  return {
    id: first.mutantId,
    file: first.file,
    startLine: Math.min(...members.map((m) => m.startLine)),
    endLine: Math.max(...members.map((m) => m.endLine)),
    members,
    // a token that is not a bare identifier is dropped from the LIST, never from the COUNT —
    // the egress validator rejects anything else, and the count is the load-bearing number. The
    // grammar is core's, because core's validator is what does that rejecting (audit F56).
    mutators: members.map((m) => m.mutator).filter((t) => MUTATOR_TOKEN_RE.test(t)),
    by
  };
};
function clusterMutants(mutants, sources, strategy) {
  const degraded = [];
  const buckets = /* @__PURE__ */ new Map();
  const put = (key, by, m) => {
    const b = buckets.get(key);
    if (b) {
      b.members.push(m);
      if (b.by !== by) b.by = "line";
    } else buckets.set(key, { members: [m], by });
  };
  if (strategy === "line") {
    for (const m of mutants) put(lineKey(m), "line", m);
    return { clusters: [...buckets].map(([, b]) => clusterOf(b.by, b.members)), requested: strategy, degraded };
  }
  const parsed = /* @__PURE__ */ new Map();
  const parseFor = (file) => {
    if (parsed.has(file)) return parsed.get(file);
    const source = sources.get(file);
    let result = null;
    if (source !== void 0) {
      const { sourceFile, parseOk } = parseSource(file, source);
      if (parseOk) result = { sf: sourceFile };
    }
    parsed.set(file, result);
    return result;
  };
  const located = [];
  for (const m of mutants) {
    const source = sources.get(m.file);
    if (source === void 0) {
      degraded.push({ mutantId: m.mutantId, reason: "source not available for this file" });
      located.push({ mutant: m, key: lineKey(m), by: "line" });
      continue;
    }
    const p = parseFor(m.file);
    if (!p) {
      degraded.push({ mutantId: m.mutantId, reason: "file did not parse cleanly" });
      located.push({ mutant: m, key: lineKey(m), by: "line" });
      continue;
    }
    const span = locate(source, m);
    if ("reason" in span) {
      degraded.push({ mutantId: m.mutantId, reason: span.reason });
      located.push({ mutant: m, key: lineKey(m), by: "line" });
      continue;
    }
    const key = statementKey(p.sf, span.start, span.end);
    if (key === null) {
      degraded.push({ mutantId: m.mutantId, reason: "no enclosing statement (mutant outside any statement)" });
      located.push({ mutant: m, key: lineKey(m), by: "line" });
      continue;
    }
    const [ks, ke] = key.split("-");
    located.push({
      mutant: m,
      key: `${m.file} stmt ${key}`,
      by: "structural",
      stmt: { start: Number(ks), end: Number(ke) }
    });
  }
  const spanOf = /* @__PURE__ */ new Map();
  for (const l of located) if (l.stmt && !spanOf.has(l.key)) spanOf.set(l.key, l.stmt);
  const foldedInto = /* @__PURE__ */ new Map();
  const bySize = [...spanOf.entries()].sort(
    (a, b) => b[1].end - b[1].start - (a[1].end - a[1].start) || (a[0] < b[0] ? -1 : 1)
  );
  for (let i = 0; i < bySize.length; i++) {
    const [outerKey, outer] = bySize[i];
    if (foldedInto.has(outerKey)) continue;
    if (outer.end - outer.start > MAX_CONTAINMENT_CHARS) continue;
    for (let j = i + 1; j < bySize.length; j++) {
      const [innerKey, inner] = bySize[j];
      if (foldedInto.has(innerKey)) continue;
      if (outer.start <= inner.start && outer.end >= inner.end) foldedInto.set(innerKey, outerKey);
    }
  }
  const folded = (key) => foldedInto.get(key) ?? key;
  for (const l of located) put(folded(l.key), l.by, l.mutant);
  return { clusters: [...buckets].map(([, b]) => clusterOf(b.by, b.members)), requested: strategy, degraded };
}

// src/source-analysis/scope.ts
var FUNCTION_SCOPE = /* @__PURE__ */ new Set([
  ts.SyntaxKind.SourceFile,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ClassStaticBlockDeclaration
]);
var BLOCK_SCOPE = /* @__PURE__ */ new Set([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.CaseBlock,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression
]);
var opensScope = (n) => FUNCTION_SCOPE.has(n.kind) || BLOCK_SCOPE.has(n.kind);
var declKind = (list) => (list.flags & ts.NodeFlags.Const) !== 0 ? "const" : (list.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
function declareName(name, kind, decl, into) {
  if (ts.isIdentifier(name)) {
    into({ name: name.text, decl, kind });
    return;
  }
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    declareName(el.name, kind, el, into);
  }
}
function buildScopes(sourceFile) {
  const byNode = /* @__PURE__ */ new Map();
  const scopeFor = (node, parent) => {
    const existing = byNode.get(node);
    if (existing) return existing;
    const s = { parent, isFunctionScope: FUNCTION_SCOPE.has(node.kind), bindings: /* @__PURE__ */ new Map() };
    byNode.set(node, s);
    return s;
  };
  const functionScopeOf = (s) => {
    let cur = s;
    while (!cur.isFunctionScope && cur.parent) cur = cur.parent;
    return cur;
  };
  const add = (s, b) => {
    if (!s.bindings.has(b.name)) s.bindings.set(b.name, b);
  };
  const visit = (node, scope) => {
    const inner = opensScope(node) && node !== sourceFile ? scopeFor(node, scope) : scope;
    if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
      const kind = declKind(node.parent);
      const target = kind === "var" ? functionScopeOf(scope) : scope;
      declareName(node.name, kind, node, (b) => add(target, b));
    } else if (ts.isParameter(node)) {
      declareName(node.name, "param", node, (b) => add(scope, b));
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      add(functionScopeOf(scope), { name: node.name.text, decl: node, kind: "function" });
    } else if (ts.isClassDeclaration(node) && node.name) {
      add(scope, { name: node.name.text, decl: node, kind: "class" });
    } else if (ts.isClassExpression(node) && node.name) {
      add(inner, { name: node.name.text, decl: node, kind: "class" });
    } else if (ts.isFunctionExpression(node) && node.name) {
      add(inner, { name: node.name.text, decl: node, kind: "function" });
    } else if (ts.isImportClause(node) && node.name) {
      add(scope, { name: node.name.text, decl: node, kind: "import" });
    } else if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node)) {
      add(scope, { name: node.name.text, decl: node, kind: "import" });
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      declareName(node.variableDeclaration.name, "catch", node.variableDeclaration, (b) => add(inner, b));
    } else if (ts.isEnumDeclaration(node) && node.name) {
      add(scope, { name: node.name.text, decl: node, kind: "class" });
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  const root = scopeFor(sourceFile, null);
  ts.forEachChild(sourceFile, (child) => visit(child, root));
  return { byNode, sourceFile, reassigned: /* @__PURE__ */ new Map() };
}
function scopeAt(table, node) {
  let cur = node;
  while (cur) {
    const s = table.byNode.get(cur);
    if (s) return s;
    cur = cur.parent;
  }
  return table.byNode.get(table.sourceFile);
}
function isReferencePosition(id) {
  const p = id.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if (ts.isMethodDeclaration(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isImportSpecifier(p) && p.propertyName === id) return false;
  if (ts.isExportSpecifier(p) && p.propertyName === id) return false;
  if (ts.isLabeledStatement(p) && p.label === id) return false;
  if (ts.isBreakOrContinueStatement(p) && p.label === id) return false;
  const named = p;
  if (named.name === id && !ts.isCallExpression(p) && !ts.isNewExpression(p)) return false;
  return true;
}
function resolveBinding(table, id) {
  if (!isReferencePosition(id)) return null;
  let scope = scopeAt(table, id);
  while (scope) {
    const b = scope.bindings.get(id.text);
    if (b) return b.decl;
    scope = scope.parent;
  }
  return null;
}
var ASSIGN_OPS = /* @__PURE__ */ new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);
function isReassigned(table, decl) {
  const memo = table.reassigned.get(decl);
  if (memo !== void 0) return memo;
  if (ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) && declKind(decl.parent) === "const") {
    table.reassigned.set(decl, false);
    return false;
  }
  let found = false;
  const check = (target) => {
    if (found || !ts.isIdentifier(target)) return;
    if (resolveBinding(table, target) === decl) found = true;
  };
  const visit = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n) && ASSIGN_OPS.has(n.operatorToken.kind)) check(n.left);
    else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      check(n.operand);
    } else if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      check(n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(table.sourceFile);
  table.reassigned.set(decl, found);
  return found;
}
var MAX_ALIAS_DEPTH = 8;
function resolveThroughAliases(table, id) {
  let decl = resolveBinding(table, id);
  if (!decl) return null;
  const seen = /* @__PURE__ */ new Set([decl]);
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isIdentifier(decl.initializer)) return decl;
    const target = resolveBinding(table, decl.initializer);
    if (!target || seen.has(target)) return decl;
    if (isReassigned(table, decl) || isReassigned(table, target)) return decl;
    seen.add(target);
    decl = target;
  }
  return decl;
}
function namesInScopeAt(table, node) {
  const out = /* @__PURE__ */ new Set();
  let scope = scopeAt(table, node);
  while (scope) {
    for (const name of scope.bindings.keys()) out.add(name);
    scope = scope.parent;
  }
  return out;
}

// src/source-analysis/sampling.ts
var SAMPLING_ALGORITHM = "line-first-rr-v1";
var mutantKey = (m) => `${m.file}:${m.startLine}:${m.startColumn}-${m.endLine}:${m.endColumn}:${m.mutatorName}:${m.replacement ?? ""}`;
function spanContains(outer, inner) {
  if (outer.file !== inner.file) return false;
  const startsAfter = inner.startLine > outer.startLine || inner.startLine === outer.startLine && inner.startColumn >= outer.startColumn;
  const endsBefore = inner.endLine < outer.endLine || inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn;
  return startsAfter && endsBefore;
}
function containmentClosures(mutants) {
  const byFile = /* @__PURE__ */ new Map();
  for (const m of mutants) {
    const arr = byFile.get(m.file);
    if (arr) arr.push(m);
    else byFile.set(m.file, [m]);
  }
  const out = /* @__PURE__ */ new Map();
  for (const arr of byFile.values()) {
    for (const outer of arr) {
      out.set(mutantKey(outer), arr.filter((inner) => spanContains(outer, inner)));
    }
  }
  return out;
}
var lineKey2 = (m) => `${m.file}:${m.startLine}`;
var rank = (seed, ...parts) => sha256(`${seed}|${parts.join("|")}`);
function lineFirstSample(mutants, cap, seed) {
  const byLine = /* @__PURE__ */ new Map();
  for (const m of mutants) {
    const k = lineKey2(m);
    const arr = byLine.get(k);
    if (arr) arr.push(m);
    else byLine.set(k, [m]);
  }
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  for (const [k, arr] of byLine) {
    arr.sort((a, b) => cmp(rank(seed, k, mutantKey(a)), rank(seed, k, mutantKey(b))));
  }
  const lines = [...byLine.keys()].sort((a, b) => cmp(rank(seed, a), rank(seed, b)));
  const closures = containmentClosures(mutants);
  const sampled = [];
  const executedByKey = /* @__PURE__ */ new Map();
  const probed = /* @__PURE__ */ new Set();
  let skippedOversizeClosures = 0;
  if (cap > 0) {
    for (let round = 0; executedByKey.size < cap; round++) {
      let tookAny = false;
      let sawUnpicked = false;
      for (const k of lines) {
        if (executedByKey.size >= cap) break;
        const arr = byLine.get(k);
        if (round >= arr.length) continue;
        sawUnpicked = true;
        const pick = arr[round];
        const closure = closures.get(mutantKey(pick)) ?? [pick];
        const fresh = closure.filter((m) => !executedByKey.has(mutantKey(m)));
        if (fresh.length > cap - executedByKey.size) {
          skippedOversizeClosures++;
          continue;
        }
        sampled.push(pick);
        for (const m of fresh) executedByKey.set(mutantKey(m), m);
        for (const m of closure) probed.add(lineKey2(m));
        tookAny = true;
      }
      if (!tookAny && !sawUnpicked) break;
    }
  }
  return {
    algorithm: SAMPLING_ALGORITHM,
    seed,
    cap,
    eligible: mutants.length,
    sampled,
    executed: [...executedByKey.values()],
    linesEligible: byLine.size,
    linesProbed: probed.size,
    skippedOversizeClosures
  };
}
function sampleToMutateTargets(plan, subdir) {
  const prefix = subdir ? `${subdir}/` : "";
  return plan.sampled.map((m) => {
    const rel = m.file.startsWith(prefix) ? m.file.slice(prefix.length) : m.file;
    return `${escapeMutatePath(rel)}:${m.startLine}:${m.startColumn}-${m.endLine}:${m.endColumn}`;
  });
}

// src/source-analysis/deterministic-operators.ts
var DETERMINISTIC_CATEGORIES = [
  "missing-await",
  "exception-swallow",
  "argument-order",
  "off-by-one",
  "wrong-variable",
  "wrong-constant"
];
var DEFAULT_MAX_PER_CATEGORY = 25;
function lineOf2(source, offset) {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    const c = source[i];
    if (c === "\r") {
      if (source[i + 1] === "\n") i++;
      line++;
    } else if (c === "\n" || c === "\u2028" || c === "\u2029") line++;
  }
  return line;
}
function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function isConfusableIdentifier(a, b) {
  if (a === b) return false;
  if (a.length < 3 || b.length < 3) return false;
  const d = editDistance(a, b);
  return d > 0 && d <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 4) + 1);
}
function plausibleConstants(literal) {
  if (literal === "true") return ["false"];
  if (literal === "false") return ["true"];
  const n = Number(literal);
  if (!Number.isFinite(n)) return [];
  const out = /* @__PURE__ */ new Set();
  out.add(String(n + 1));
  out.add(String(n - 1));
  if (n !== 0) out.add(String(-n));
  if (n === 1e3) out.add("60");
  if (n === 60) out.add("1000");
  if (n === 24) out.add("12");
  if (n === 12) out.add("24");
  out.delete(literal);
  return [...out];
}
var BOUNDARY_FLIP = {
  [ts.SyntaxKind.LessThanToken]: "<=",
  [ts.SyntaxKind.LessThanEqualsToken]: "<",
  [ts.SyntaxKind.GreaterThanToken]: ">=",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">"
};
function deterministicRecipes(file, source, opts = {}) {
  const parsed = parseSource(file, source);
  if (!parsed.parseOk) return [];
  const sf = parsed.sourceFile;
  const cap = opts.maxPerCategory ?? DEFAULT_MAX_PER_CATEGORY;
  const counts = /* @__PURE__ */ new Map();
  const out = [];
  const emit = (start, end, replacement, category) => {
    if ((counts.get(category) ?? 0) >= cap) return;
    if (start >= end || end > source.length) return;
    if (source.slice(start, end) === replacement) return;
    if (opts.changedLines) {
      const from = lineOf2(source, start);
      const to = lineOf2(source, end);
      let hit = false;
      for (let l = from; l <= to && !hit; l++) if (opts.changedLines.has(l)) hit = true;
      if (!hit) return;
    }
    counts.set(category, (counts.get(category) ?? 0) + 1);
    out.push(recipeFromOffsets(file, source, start, end, replacement, category));
  };
  const identifiers = /* @__PURE__ */ new Set();
  const collect = (node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const scopes = buildScopes(sf);
  const visit = (node) => {
    if (ts.isAwaitExpression(node)) {
      const start = node.getStart(sf);
      const inner = node.expression.getStart(sf);
      emit(start, inner, "", "missing-await");
    }
    if (ts.isThrowStatement(node)) {
      const start = node.getStart(sf);
      const inner = node.expression.getStart(sf);
      emit(start, inner, "", "exception-swallow");
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments && node.arguments.length >= 2) {
      for (let i = 0; i + 1 < node.arguments.length; i++) {
        const a = node.arguments[i];
        const b = node.arguments[i + 1];
        const aText = source.slice(a.getStart(sf), a.getEnd());
        const bText = source.slice(b.getStart(sf), b.getEnd());
        if (aText === bText) continue;
        const sep = source.slice(a.getEnd(), b.getStart(sf));
        emit(a.getStart(sf), b.getEnd(), `${bText}${sep}${aText}`, "argument-order");
      }
    }
    if (ts.isBinaryExpression(node)) {
      const flip = BOUNDARY_FLIP[node.operatorToken.kind];
      if (flip) emit(node.operatorToken.getStart(sf), node.operatorToken.getEnd(), flip, "off-by-one");
    }
    if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      const text = source.slice(start, end);
      const options = plausibleConstants(text);
      if (options.length > 0) {
        const n = Number(text);
        const offByOne = Number.isFinite(n) ? options.filter((o) => Number(o) === n + 1 || Number(o) === n - 1) : [];
        const others = options.filter((o) => !offByOne.includes(o));
        if (offByOne.length > 0) emit(start, end, offByOne[0], "off-by-one");
        if (others.length > 0) emit(start, end, others[0], "wrong-constant");
      }
    }
    if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent) && !ts.isPropertyAssignment(node.parent)) {
      const name = node.text;
      const visible = namesInScopeAt(scopes, node);
      for (const other of identifiers) {
        if (visible.has(other) && isConfusableIdentifier(name, other)) {
          emit(node.getStart(sf), node.getEnd(), other, "wrong-variable");
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
function categoryCounts(recipes) {
  const out = {};
  for (const c of DETERMINISTIC_CATEGORIES) out[c] = 0;
  for (const r of recipes) if (r.category) out[r.category] = (out[r.category] ?? 0) + 1;
  return out;
}

// src/source-analysis/production-operators.ts
var PRODUCTION_OPERATOR_VERSION = "production-operators-v2";
var PRODUCTION_OPERATOR_CATEGORIES = [
  "statement-deletion",
  "return-deletion",
  "control-flow-deletion",
  "argument-omission",
  "argument-order",
  "argument-replacement",
  "identifier-replacement",
  "property-substitution",
  "assignment-operator",
  "assignment-rhs",
  "missing-await",
  "nullish-fallback",
  "optional-chain-removal",
  "call-chain-omission",
  "parameter-default-removal",
  "class-field-initializer-removal"
];
var DEFAULT_MAX_PER_CATEGORY2 = 20;
function lineOf3(source, offset) {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source[i] === "\r") {
      if (source[i + 1] === "\n") i++;
      line++;
    } else if (source[i] === "\n" || source[i] === "\u2028" || source[i] === "\u2029") {
      line++;
    }
  }
  return line;
}
function intersectsChanged(source, start, end, changed) {
  if (!changed) return true;
  for (let line = lineOf3(source, start); line <= lineOf3(source, end); line++) {
    if (changed.has(line)) return true;
  }
  return false;
}
function syntaxKindTag(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return "string";
  if (ts.isNumericLiteral(node)) return "number";
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isArrayLiteralExpression(node)) return "array";
  if (ts.isObjectLiteralExpression(node)) return "object";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "function";
  if (ts.isIdentifier(node)) return "identifier";
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return "call";
  return null;
}
function declarationTypeTags(sf) {
  const out = /* @__PURE__ */ new Map();
  const add = (name, tag) => {
    if (!tag) return;
    const tags = out.get(name) ?? /* @__PURE__ */ new Set();
    tags.add(tag);
    out.set(name, tags);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      add(node.name.text, node.type ? `type:${node.type.getText(sf)}` : syntaxKindTag(node.initializer));
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      add(node.name.text, node.type ? `type:${node.type.getText(sf)}` : syntaxKindTag(node.initializer));
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, "function");
    } else if (ts.isClassDeclaration(node) && node.name) {
      add(node.name.text, "class");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
function typeCompatible(a, b, tags) {
  const aa = tags.get(a);
  const bb = tags.get(b);
  if (!aa || !bb || aa.size === 0 || bb.size === 0) return false;
  for (const tag of aa) if (bb.has(tag)) return true;
  return false;
}
function isReferenceIdentifier(node) {
  const p = node.parent;
  if (ts.isVariableDeclaration(p) && p.name === node || ts.isBindingElement(p) && p.name === node || ts.isParameter(p) && p.name === node || ts.isFunctionDeclaration(p) && p.name === node || ts.isFunctionExpression(p) && p.name === node || ts.isClassDeclaration(p) && p.name === node || ts.isClassExpression(p) && p.name === node || ts.isPropertyAccessExpression(p) && p.name === node || ts.isPropertyAssignment(p) && p.name === node || ts.isPropertyDeclaration(p) && p.name === node || ts.isMethodDeclaration(p) && p.name === node || (ts.isImportSpecifier(p) || ts.isExportSpecifier(p))) {
    return false;
  }
  return true;
}
function referenceIdentifierSpans(sf) {
  const spans = /* @__PURE__ */ new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      spans.add(`${node.getStart(sf)}:${node.getEnd()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return spans;
}
var ASSIGNMENT_REPLACEMENTS = /* @__PURE__ */ new Map([
  [ts.SyntaxKind.EqualsToken, "+="],
  [ts.SyntaxKind.PlusEqualsToken, "="],
  [ts.SyntaxKind.MinusEqualsToken, "="],
  [ts.SyntaxKind.AsteriskEqualsToken, "="],
  [ts.SyntaxKind.SlashEqualsToken, "="],
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken, "??="],
  [ts.SyntaxKind.BarBarEqualsToken, "??="],
  [ts.SyntaxKind.QuestionQuestionEqualsToken, "="]
]);
function argumentRemovalSpan(args, index, sf) {
  const arg = args[index];
  if (args.length === 1) return [arg.getStart(sf), arg.getEnd()];
  if (index < args.length - 1) return [arg.getStart(sf), args[index + 1].getStart(sf)];
  return [args[index - 1].getEnd(), arg.getEnd()];
}
function propertyGroups(sf, source) {
  const groups = /* @__PURE__ */ new Map();
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = source.slice(node.expression.getStart(sf), node.expression.getEnd());
      const names = groups.get(receiver) ?? /* @__PURE__ */ new Set();
      names.add(node.name.text);
      groups.set(receiver, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return groups;
}
function productionRecipes(file, source, options = {}) {
  const parsed = parseSource(file, source);
  if (!parsed.parseOk) return [];
  const sf = parsed.sourceFile;
  const scopes = buildScopes(sf);
  const tags = declarationTypeTags(sf);
  const properties = propertyGroups(sf, source);
  const referenceSpans = referenceIdentifierSpans(sf);
  const cap = options.maxPerCategory ?? DEFAULT_MAX_PER_CATEGORY2;
  const counts = /* @__PURE__ */ new Map();
  const recipes = /* @__PURE__ */ new Map();
  const emit = (start, end, replacement, category) => {
    if ((counts.get(category) ?? 0) >= cap) return;
    if (start < 0 || start >= end || end > source.length) return;
    if (source.slice(start, end) === replacement) return;
    if (!intersectsChanged(source, start, end, options.changedLines)) return;
    const recipe = recipeFromOffsets(file, source, start, end, replacement, category);
    const mutated = source.slice(0, start) + replacement + source.slice(end);
    if (!parseSource(file, mutated).parseOk) return;
    if (recipes.has(recipe.id)) return;
    recipes.set(recipe.id, recipe);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  };
  if (options.includeControl !== false) {
    for (const recipe of deterministicRecipes(file, source, {
      changedLines: options.changedLines,
      maxPerCategory: cap
    })) {
      const category = recipe.category ?? "unknown";
      if (category === "wrong-variable" && !referenceSpans.has(`${recipe.startOffset}:${recipe.endOffset}`)) {
        continue;
      }
      if ((counts.get(category) ?? 0) >= cap) continue;
      recipes.set(recipe.id, recipe);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  const visit = (node) => {
    if (ts.isExpressionStatement(node) && (ts.isCallExpression(node.expression) || ts.isAwaitExpression(node.expression) && ts.isCallExpression(node.expression.expression))) {
      emit(node.getStart(sf), node.getEnd(), ";", "statement-deletion");
    }
    if (ts.isReturnStatement(node) && node.expression) {
      emit(node.expression.getStart(sf), node.expression.getEnd(), "undefined", "return-deletion");
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      emit(node.getStart(sf), node.getEnd(), ";", "control-flow-deletion");
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      for (let index = 0; index < node.arguments.length; index++) {
        const [start, end] = argumentRemovalSpan(node.arguments, index, sf);
        emit(start, end, "", "argument-omission");
        const arg = node.arguments[index];
        if (ts.isIdentifier(arg)) {
          const visible = namesInScopeAt(scopes, arg);
          for (const candidate of visible) {
            if (candidate !== arg.text && typeCompatible(arg.text, candidate, tags)) {
              emit(arg.getStart(sf), arg.getEnd(), candidate, "argument-replacement");
              break;
            }
          }
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && (ts.isCallExpression(node.expression.expression) || ts.isPropertyAccessExpression(node.expression.expression))) {
        const receiver = node.expression.expression;
        emit(node.getStart(sf), node.getEnd(), source.slice(receiver.getStart(sf), receiver.getEnd()), "call-chain-omission");
      }
    }
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      const visible = namesInScopeAt(scopes, node);
      for (const candidate of visible) {
        if (candidate !== node.text && typeCompatible(node.text, candidate, tags)) {
          emit(node.getStart(sf), node.getEnd(), candidate, "identifier-replacement");
          break;
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = source.slice(node.expression.getStart(sf), node.expression.getEnd());
      const candidates = properties.get(receiver);
      if (candidates) {
        for (const candidate of candidates) {
          if (candidate !== node.name.text) {
            emit(node.name.getStart(sf), node.name.getEnd(), candidate, "property-substitution");
            break;
          }
        }
      }
      if (node.questionDotToken) {
        emit(node.questionDotToken.getStart(sf), node.questionDotToken.getEnd(), ".", "optional-chain-removal");
      }
    }
    if (ts.isCallExpression(node) && node.questionDotToken) {
      emit(node.questionDotToken.getStart(sf), node.questionDotToken.getEnd(), "", "optional-chain-removal");
    }
    if (ts.isBinaryExpression(node)) {
      const assignment = ASSIGNMENT_REPLACEMENTS.get(node.operatorToken.kind);
      if (assignment) {
        emit(node.operatorToken.getStart(sf), node.operatorToken.getEnd(), assignment, "assignment-operator");
        if (ts.isIdentifier(node.right)) {
          const visible = namesInScopeAt(scopes, node.right);
          for (const candidate of visible) {
            if (candidate !== node.right.text && typeCompatible(node.right.text, candidate, tags)) {
              emit(node.right.getStart(sf), node.right.getEnd(), candidate, "assignment-rhs");
              break;
            }
          }
        }
      }
      if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        emit(node.getStart(sf), node.getEnd(), source.slice(node.left.getStart(sf), node.left.getEnd()), "nullish-fallback");
      }
    }
    if (ts.isParameter(node) && node.initializer) {
      emit(node.name.getEnd(), node.initializer.getEnd(), "", "parameter-default-removal");
    }
    if (ts.isPropertyDeclaration(node) && node.initializer) {
      emit(node.name.getEnd(), node.initializer.getEnd(), "", "class-field-initializer-removal");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...recipes.values()];
}
function productionCategoryCounts(recipes) {
  const counts = {};
  for (const category of PRODUCTION_OPERATOR_CATEGORIES) counts[category] = 0;
  for (const recipe of recipes) {
    const category = recipe.category ?? "unknown";
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

// src/source-analysis/classic-operator-inventory.ts
var STRYKER_BUILTIN_OPERATORS = [
  { id: "ArithmeticOperator", rewrite: "swaps one arithmetic operator for its counterpart: + for -, * for /, % for *" },
  { id: "ArrayDeclaration", rewrite: "empties an array literal, or fills an empty one with a single element" },
  { id: "ArrowFunction", rewrite: "replaces an arrow function's body with `undefined`" },
  { id: "AssignmentOperator", rewrite: "swaps a compound assignment for its counterpart: += for -=, *= for /=, ??= for &&=" },
  { id: "BlockStatement", rewrite: "empties a block, so everything the braces held stops running" },
  { id: "BooleanLiteral", rewrite: "flips `true` and `false`, and removes or adds a leading `!`" },
  { id: "ConditionalExpression", rewrite: "forces a condition to always-true or always-false, or empties a switch case" },
  { id: "EqualityOperator", rewrite: "swaps one comparison for another: == for !=, < for <=, > for >=, and their negations" },
  { id: "LogicalOperator", rewrite: "swaps && for ||, || for &&, and ?? for &&" },
  { id: "MethodExpression", rewrite: "swaps a built-in method for its opposite: startsWith for endsWith, filter for every, min for max, slice/substr removed" },
  { id: "ObjectLiteral", rewrite: "empties an object literal" },
  { id: "OptionalChaining", rewrite: "removes the `?.` so the access is no longer guarded" },
  { id: "Regex", rewrite: "alters a regular expression literal's pattern" },
  { id: "StringLiteral", rewrite: "replaces a string literal with an empty string, or an empty one with a placeholder" },
  { id: "UnaryOperator", rewrite: "flips the sign of a unary operator: +x for -x, ~x for x" },
  { id: "UpdateOperator", rewrite: "swaps ++ for -- and -- for ++" }
];
var DETERMINISTIC_PASS_OPERATORS = [
  // the frozen six-family control inventory
  { id: "missing-await", rewrite: "removes an `await`, so the promise is never waited on" },
  { id: "exception-swallow", rewrite: "removes a `throw`, leaving its expression evaluated but never raised" },
  { id: "argument-order", rewrite: "swaps two ADJACENT arguments of one call, whatever they mean" },
  { id: "off-by-one", rewrite: "moves a comparison boundary by one (< for <=, > for >=), or a numeric literal by \xB11" },
  { id: "wrong-variable", rewrite: "replaces an identifier with a confusably similar one that is in scope here" },
  { id: "wrong-constant", rewrite: "replaces a literal with a plausible neighbour: its negation, 1000 for 60, 24 for 12" },
  // the production operators
  { id: "statement-deletion", rewrite: "replaces a whole call statement with `;`, so it no longer runs" },
  { id: "return-deletion", rewrite: "replaces a returned expression with `undefined`" },
  { id: "control-flow-deletion", rewrite: "removes a `break` or a `continue`" },
  { id: "argument-omission", rewrite: "removes one argument from a call, shifting the rest along" },
  { id: "argument-replacement", rewrite: "replaces one argument identifier with another in-scope name of a compatible type" },
  { id: "identifier-replacement", rewrite: "replaces any referenced identifier with another in-scope name of a compatible type" },
  { id: "property-substitution", rewrite: "replaces a property name with another property seen on the same receiver" },
  { id: "assignment-operator", rewrite: "swaps a compound assignment for its counterpart, and = for +=" },
  { id: "assignment-rhs", rewrite: "replaces the right-hand side identifier of an assignment with a compatible in-scope name" },
  { id: "nullish-fallback", rewrite: "drops the `?? fallback`, leaving only the left-hand side" },
  { id: "optional-chain-removal", rewrite: "turns `?.` into `.`, or removes it from a call" },
  { id: "call-chain-omission", rewrite: "drops the last call of a chain, returning its receiver instead" },
  { id: "parameter-default-removal", rewrite: "removes a parameter's default value" },
  { id: "class-field-initializer-removal", rewrite: "removes a class field's initializer" }
];
function classicOperatorInventory(input) {
  return input.deterministic ? [...STRYKER_BUILTIN_OPERATORS, ...DETERMINISTIC_PASS_OPERATORS] : [...STRYKER_BUILTIN_OPERATORS];
}
var DETERMINISTIC_PASS_CATEGORIES = [
  .../* @__PURE__ */ new Set([...DETERMINISTIC_CATEGORIES, ...PRODUCTION_OPERATOR_CATEGORIES])
];
export {
  DESCRIBE_FNS,
  DETERMINISTIC_CATEGORIES,
  DETERMINISTIC_PASS_CATEGORIES,
  DETERMINISTIC_PASS_OPERATORS,
  PRODUCTION_OPERATOR_CATEGORIES,
  PRODUCTION_OPERATOR_VERSION,
  SAMPLING_ALGORITHM,
  STRYKER_BUILTIN_OPERATORS,
  TEST_FNS,
  analyzeReachability,
  applyRecipe,
  buildScopes,
  categoryCounts,
  classicOperatorInventory,
  clusterMutants,
  collectTypeContext,
  commentInNodeMatches,
  deterministicRecipes,
  enclosingNodes,
  escapeMutatePath,
  forcedHandlerRecipes,
  isConfusableIdentifier,
  isParameterized,
  isReassigned,
  lineFirstSample,
  lineKey,
  lineOf,
  moduleExportSurface,
  mutantKey,
  namesInScopeAt,
  offsetOf,
  parseSource,
  plausibleConstants,
  productionCategoryCounts,
  productionRecipes,
  recipeFromOffsets,
  recipeFromSpan,
  recipeId,
  sha256 as recipeSha256,
  resolveBinding,
  resolveThroughAliases,
  sampleToMutateTargets,
  scanErrorHandlers,
  scanFileHandlers,
  scanTautologies,
  strictOffsetOf,
  stringArg,
  testCallName,
  tryRecipeFromSpan,
  ts
};
