import ts from 'typescript';
export { default as ts } from 'typescript';

/**
 * Shared TypeScript-AST utility (Extensions 2 + 5). Regex cannot safely reason about TSX,
 * template literals, nested braces, comments, or modern syntax, so both the error-handler scanner
 * (Extension 5) and the tautological-assertion scanner (Extension 2) parse with the real compiler.
 *
 * Parsing is best-effort and NEVER throws: `createSourceFile` recovers from syntax errors, so we
 * surface a `parseOk` flag from the parser's own diagnostics. Callers MUST degrade to a
 * `partial`/`unavailable` result on `parseOk === false` rather than reporting a clean empty scan —
 * a file we could not fully parse must not read as "no findings".
 */

interface ParsedSource {
    sourceFile: ts.SourceFile;
    /** false when the parser recorded syntax errors — treat the scan of this file as partial */
    parseOk: boolean;
}
/** Parse TS/TSX/JS/JSX source into a SourceFile with parent pointers set. Never throws. */
declare function parseSource(fileName: string, source: string): ParsedSource;
/** 1-based source line of a character position. */
declare function lineOf(sourceFile: ts.SourceFile, pos: number): number;
/**
 * True when the text span of `node` contains a real COMMENT token (single- or multi-line) whose
 * text matches `pattern`. Uses the scanner (not a regex over source) so a `TODO` inside a string
 * literal or identifier is never mistaken for a comment.
 */
declare function commentInNodeMatches(node: ts.Node, sourceFile: ts.SourceFile, source: string, pattern: RegExp): boolean;

interface MutationRecipe {
    /** workdir-relative file the edit targets */
    file: string;
    /** UTF-16 code-unit offsets of the span to replace, half-open [startOffset, endOffset) */
    startOffset: number;
    endOffset: number;
    /** the exact source slice at [startOffset,endOffset) when the recipe was built (drift guard) */
    original: string;
    /** the replacement text */
    replacement: string;
    /** sha256 of the whole file source when the recipe was built (drift guard) */
    sourceDigest: string;
    /** stable content-hash id — independent of LLM/report order (dedup + selection key) */
    id: string;
    /** realistic-mutant category, e.g. "missing-await" (presentational + composition metadata) */
    category?: string;
}
declare function sha256(text: string): string;
/**
 * Line/column → UTF-16 offset. `line` is 1-based; `column` is 1-based (the mutation-testing report
 * schema convention). `\n` is the line separator, so a `\r` in a CRLF file stays as the last code
 * unit of its line and is counted by the column offset — the recipe operates on the exact bytes,
 * CRLF included. Out-of-range coordinates clamp to the source length.
 */
declare function offsetOf(source: string, line: number, column: number): number;
/**
 * Resolve a 1-based (line, column) to an offset that provably lies ON that line, or null.
 *
 * `offsetOf` clamps only against the whole file, so a column past the end of its line silently walks
 * into LATER lines. Scope validation checks a proposal's line numbers, so that clamping is a scope
 * escape: a proposal declaring a changed line can land on unchanged code. Out-of-range coordinates
 * are therefore REJECTED here rather than clamped.
 */
declare function strictOffsetOf(source: string, line: number, column: number): number | null;
/** Build a recipe's stable content-hash id from its source-derived fields (order-independent). */
declare function recipeId(file: string, startOffset: number, endOffset: number, original: string, replacement: string): string;
/**
 * Build a recipe from 1-based line/column span coordinates. The BOM (if present) is part of the
 * source and counted in offsets, so digests + slices stay exact.
 */
declare function recipeFromSpan(file: string, source: string, span: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}, replacement: string, category?: string): MutationRecipe;
/**
 * Span → recipe, or null when the coordinates do not lie within their declared lines. Callers
 * handling UNTRUSTED coordinates (model proposals) must use this and reject the null rather than
 * let an out-of-line column clamp into unchanged code — see {@link strictOffsetOf}.
 */
declare function tryRecipeFromSpan(file: string, source: string, span: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}, replacement: string, category?: string): MutationRecipe | null;
/**
 * Build a recipe directly from UTF-16 offsets (half-open [startOffset, endOffset)). Used where a
 * span is already known in offset form (e.g. AST node bounds) so no line/column round-trip is needed.
 */
declare function recipeFromOffsets(file: string, source: string, startOffset: number, endOffset: number, replacement: string, category?: string): MutationRecipe;
type ApplyResult = {
    ok: true;
    result: string;
} | {
    ok: false;
    reason: "source-drift" | "slice-mismatch" | "bad-span";
};
/**
 * Materialize a recipe against `source`, returning the mutated text. Fails closed on any drift:
 * a changed file (digest mismatch), a moved span (original-slice mismatch), or an inverted span.
 */
declare function applyRecipe(source: string, recipe: MutationRecipe): ApplyResult;
/**
 * Make a file path safe to use as a Stryker `mutate` entry that carries a line range.
 *
 * Stryker validates a ranged entry with `new Minimatch(entry).hasMagic()` and REFUSES it when the
 * pattern looks like a glob — "Cannot combine a glob expression with a mutation range". A Next.js
 * App Router directory is literally named `[workspaceId]`, so every changed file under a dynamic
 * route made the whole mutation run exit 1 before a single mutant was generated. It is not a rare
 * shape: it took one real repository to hit it across 50+ files at once.
 *
 * Backslash-escaping the magic characters clears `hasMagic()` while still matching the literal
 * path, which is the behaviour Minimatch documents and what the fix is verified against.
 */
declare function escapeMutatePath(path: string): string;

/**
 * Normalized result contract `attest-results/v2` (build plan §4.2.1).
 *
 * Two-layer rule: raw engine reports (Stryker's mutation-testing report-schema) are
 * preserved verbatim as evidence; THIS schema is what every downstream consumer reads.
 * `@abloh/measure` maps raw → this; future engines implement the same mapping. We never
 * extend or mutate someone else's schema.
 */

type HandlerAntiPatternKind = "empty-catch" | "catch-all-abort" | "todo-in-handler";
interface HandlerFinding {
    file: string;
    startLine: number;
    endLine: number;
    kind: HandlerAntiPatternKind;
}

interface HandlerSpan {
    file: string;
    startLine: number;
    endLine: number;
}
interface FileHandlerScan {
    antiPatterns: HandlerFinding[];
    /** every changed catch-handler span (mutant classification keys off these later) */
    changedHandlers: HandlerSpan[];
    /** false when the file did not parse cleanly — caller must treat the scan as partial */
    parseOk: boolean;
}
/** Scan one file's source for changed-handler anti-patterns. `changedLines` are 1-based. */
declare function scanFileHandlers(fileName: string, source: string, changedLines: ReadonlySet<number>): FileHandlerScan;
/**
 * Materialize deterministic FORCED handler mutations (Extension 5 reserve). For each changed catch
 * clause we neuter its FIRST executable statement (`stmt` → `;`), a real handler-behavior change
 * that the carrier smuggles through Stryker so the handler is always probed even when the sampler
 * would not have reached it. No LLM — purely structural, so it runs at every tier. Empty handlers
 * and handlers whose first statement is not carriable are skipped (nothing to force). Deterministic
 * ordering by (file, offset); a file that does not parse yields no recipes.
 */
declare function forcedHandlerRecipes(fileName: string, source: string, changedLines: ReadonlySet<number>): MutationRecipe[];
interface HandlerScanInput {
    file: string;
    source: string;
    /** 1-based changed lines for this file (from diff-scope inspectionScopes) */
    changedLines: ReadonlySet<number>;
}
interface ErrorHandlerScan {
    antiPatterns: HandlerFinding[];
    changedHandlers: HandlerSpan[];
    quality: "complete" | "partial";
}
/** Scan several files; a single unparseable file downgrades overall `quality` to `partial`. */
declare function scanErrorHandlers(inputs: readonly HandlerScanInput[]): ErrorHandlerScan;

/**
 * Tautological-assertion scanner (Extension 2). Conservative and high-confidence: it flags a test
 * ONLY when every assertion it makes is a recognized self-confirming form (`assert.equal(x, x)`,
 * `expect(x).toBe(x)`, `assert(true)`, …) AND no unrecognized assertion shape appears — so a test
 * doing real work is never mislabeled. Assertion SOURCE is never emitted; only the canonical test
 * identity (`<file>::<fullName>`) is returned, and the CLI reduces even that to a digest at egress.
 *
 * Uses the shared TS-AST utility (a regex cannot tell a `TODO` in a comment from one in a string,
 * nor `toBe(x)` on `x` from `toBe(y)`). A file that fails to parse downgrades quality to `partial`.
 */

interface TautologyScanInput {
    /** test file path (report key) */
    file: string;
    source: string;
}
interface TautologyResult {
    /** canonical `<file>::<fullName>` of tests whose every recognized assertion is tautological */
    tautologicalTests: string[];
    quality: "complete" | "partial";
}
/** Exported so corpus mining derives fullNames by the SAME rule the runner matches on. */
declare const TEST_FNS: Set<string>;
declare const DESCRIBE_FNS: Set<string>;
/**
 * The base test/describe identifier for a call, following modifier chains, or null.
 *
 * `it("…")` is an identifier call, but `it.only("…")`, `test.each(table)("…")` and
 * `describe.concurrent("…")` are property-access (and, for `each`, call) chains. Recognizing only
 * the bare identifiers meant modified tests were never scanned at all — while the scan still
 * reported `complete` quality, which overstates coverage of the file.
 */
/** Is this a parameterized declaration (`test.each(...)`) whose real test names we cannot know? */
declare function isParameterized(expr: ts.Expression): boolean;
declare function testCallName(expr: ts.Expression): string | null;
declare function stringArg(call: ts.CallExpression): string | null;
/**
 * Scan test files for fully-tautological tests. One unparseable file → `quality: "partial"`.
 *
 * SCANNING NOTHING IS NOT SCANNING CLEANLY. `quality` began as `"complete"` and was only ever
 * downgraded inside the loop, so an empty input list — a runner whose report carries no test
 * sources, coverage switched off, a command runner — returned `{ tautologicalTests: [], quality:
 * "complete" }`. That is a positive claim: we read your suite and found no test whose every
 * assertion is a tautology. We had read nothing. An empty input is reported `partial`, which is the
 * existing word for "this scan did not cover everything".
 */
declare function scanTautologies(inputs: readonly TautologyScanInput[], workDir?: string): TautologyResult;

/** How the mutated code can be reached from outside its module. */
type Reachability = 
/** the function holding the mutation is itself exported */
"exported-directly"
/** private, but an exported symbol calls it (see `entryPoints`) */
 | "reachable-via"
/** private, and nothing exported in this file reaches it — the decline signal */
 | "unreachable"
/** we could not tell; callers must NOT decline on this */
 | "unknown";
interface ParameterInfo {
    name: string;
    optional: boolean;
    /** the type as WRITTEN (`Packet`, `{ a: number }`, `string[]`), or null when untyped */
    type: string | null;
    rest: boolean;
}
interface EntryPoint {
    /** exported symbol name, or "default" */
    name: string;
    kind: "function" | "method" | "variable" | "default";
    /** rendered from the syntax, e.g. `tableBlock(packet: Packet, view: View): Block` */
    signature: string;
    parameters: ParameterInfo[];
    returnType: string | null;
    isAsync: boolean;
    /** ["tableBlock", "buildFlatTable"] — first is the export, last holds the mutation */
    path: string[];
    /** the source line of each call along the path (one fewer than `path`) */
    callSites: string[];
    /** distinct type names named in the signature — what `collectTypeContext` resolves */
    typeNames: string[];
}
interface EnclosingFunction {
    /** `buildFlatTable`, `Class.method`, or null when anonymous */
    name: string | null;
    /** the FULL declaration text including leading JSDoc — not a character window */
    text: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    /**
     * Type names in THIS function's own signature.
     *
     * Separate from the entry point's, and both are needed. A private worker is usually called with
     * values the entry point derives rather than with its own arguments — `tableBlock(packet, view)`
     * calls `buildFlatTable(columns: Column[], …)`, and `Column` appears in no entry signature. On a
     * real run the model therefore never saw `Column`, passed plain strings where `{ key }` objects
     * were required, and the test failed identically on real and mutated code.
     */
    typeNames: string[];
}
interface ExportSurface {
    /** sorted export names — byte-identical to the CLI's previous listModuleExports */
    named: string[];
    hasDefault: boolean;
    /** name → declaration, so a signature can be read. `named` never depends on this. */
    declarations: ReadonlyMap<string, ts.Declaration>;
}
interface ReachabilityAnalysis {
    /** "unavailable" ⇔ the file did not parse, or the offsets landed in no node */
    quality: "complete" | "unavailable";
    reachability: Reachability;
    enclosing: EnclosingFunction | null;
    /** shortest paths first, then lexicographic — deterministic across runs */
    entryPoints: EntryPoint[];
    exportSurface: ExportSurface;
    /** module specifiers this file imports that name a known external service */
    serviceImports: string[];
}
/**
 * Every node containing [start, end], smallest span first. Lifted from carrier.ts, which had it
 * privately; that file now imports it so the two can never drift.
 */
declare function enclosingNodes(sf: ts.SourceFile, start: number, end: number): ts.Node[];
/**
 * A module's export surface.
 *
 * `named` and `hasDefault` are byte-identical to the CLI's previous `listModuleExports`, which is
 * load-bearing rather than tidy: the invariant engine hashes that list into its cache key, so a
 * change of even one name silently invalidates every cached proposal. `declarations` is additive —
 * the old function returned strings and discarded the node, which made it impossible to read a
 * signature back off an export.
 */
declare function moduleExportSurface(sourceFile: ts.SourceFile): ExportSurface;
interface AnalyzeInput {
    fileName: string;
    source: string;
    /** byte offsets of the mutated span */
    startOffset: number;
    endOffset: number;
    maxEntryPoints?: number;
    maxDepth?: number;
}
/**
 * Analyze how (and whether) a test can reach the mutated span. Never throws; see the module header
 * for the degradation contract that callers must honor.
 */
declare function analyzeReachability(input: AnalyzeInput): ReachabilityAnalysis;
interface TypeContextInput {
    fileName: string;
    source: string;
    names: readonly string[];
    /** injected so this stays pure and unit-testable; the CLI passes a sandbox-scoped reader */
    readFile: (absPath: string) => string | null;
    maxChars?: number;
}
/**
 * The TEXT of the type declarations a signature names — the difference between a model knowing a
 * `Packet` exists and being able to construct one.
 *
 * Local declarations first, then ONE hop through this file's own relative imports. One hop, not
 * transitive: it bounds both the cost and the prompt, and a type two modules away is rarely the
 * one the entry point takes. Anything unresolved is reported by name so the prompt can tell the
 * model to build a minimal object and cast it, rather than leaving it to guess in silence.
 */
declare function collectTypeContext(input: TypeContextInput): {
    text: string;
    resolved: string[];
    unresolved: string[];
};

/**
 * How several survivors in one place are presented as ONE finding.
 *
 * Declared here, in core, because it is a config value the engine reads — the engine depends on
 * core, never the reverse, so the closed set has to live on this side of that edge.
 *
 *  - `line`        — group by source line. Wrong in both directions: two operands of one `if` on
 *                    separate lines render as two gaps, while two unrelated statements sharing a
 *                    line render as one. Retained ONLY because the hosted control plane never
 *                    receives source and so cannot do better.
 *  - `structural`  — group by the smallest enclosing STATEMENT, with containment capped so a
 *                    whole-function survivor cannot absorb everything inside it. A fact about the
 *                    syntax tree, so no merge can be wrong. Fixes both of line's errors. THE DEFAULT.
 *
 * TWO STRATEGIES WERE REMOVED, both on measurement rather than taste:
 *
 *  - `data-flow` merged clusters sharing a resolved binding inside one function. On 189 real
 *    survivors across 17 files it produced **2 merges beyond structural**, in 2 files. A setting
 *    that changes nothing is worse than an absent one, because someone eventually enables it and
 *    wonders why their output is identical. The scope resolver it was built on REMAINS — see
 *    `core/src/source-analysis/scope.ts`; the `wrong-variable` mutator depends on it to avoid substituting
 *    a name that is not in scope, and nothing else can tell two same-named variables apart.
 *  - `semantic` asked a model to merge. gpt-5.6-terra at `xhigh` also managed **2 merges** on the
 *    same corpus — a mechanical analyser and the best available model independently agreeing there is
 *    nothing to merge beyond the syntax tree. What the model IS good at is naming the gap, which is
 *    now {@link FindingsConfig.naming} and never touches the grouping.
 *
 * Every strategy keeps each mutant individually in the artifact and displays each cluster's member
 * count, so no signed number depends on this setting.
 */
declare const CLUSTER_STRATEGIES: readonly ["line", "structural"];
type ClusterStrategy = (typeof CLUSTER_STRATEGIES)[number];

/** One mutant, as the clusterer needs it. A subset of `GapFinding` — no triage, no status. */
interface ClusterInput {
    mutantId: string;
    file: string;
    startLine: number;
    endLine: number;
    mutator: string;
    /** 1-based, optional — absent on historical artifacts */
    startColumn?: number;
    endColumn?: number;
    /** the exact source slice this mutant replaced; used to VERIFY the span, never to render */
    originalText?: string;
}
interface Cluster {
    /** stable id, derived from the first member — matches the previous `mutant:<id>` convention */
    id: string;
    file: string;
    startLine: number;
    endLine: number;
    /** every mutant in this cluster. `members.length` is the count a surface must display. */
    members: ClusterInput[];
    mutators: string[];
    /**
     * The strategy that actually decided THIS cluster. It can be `line` even when a different
     * strategy was requested — see {@link ClusterResult.degraded}. Recording it per cluster is the
     * point: a run must never present a fallback as if it were the thing that was asked for.
     */
    by: ClusterStrategy;
}
interface ClusterResult {
    clusters: Cluster[];
    /** the strategy that was requested */
    requested: ClusterStrategy;
    /**
     * Mutants that fell back to line grouping because their span could not be located.
     *
     * Reported, never swallowed. A stage that silently degrades and renders its own failure as a fact
     * about the customer's code is the defect class this repo spent a week removing; a clusterer that
     * quietly grouped by line while claiming to group structurally would be another instance of it.
     */
    degraded: {
        mutantId: string;
        reason: string;
    }[];
}
/** Today's rule, kept verbatim so the hosted path can call it instead of re-implementing it. */
declare function lineKey(m: {
    file: string;
    startLine: number;
    endLine: number;
}): string;
/**
 * Group mutants into clusters.
 *
 * `sources` maps a workdir-relative file path to its current source. A file that is missing from
 * the map is not an error — its mutants fall back to line grouping and are reported in `degraded`.
 */
declare function clusterMutants(mutants: readonly ClusterInput[], sources: ReadonlyMap<string, string>, strategy: ClusterStrategy): ClusterResult;

/**
 * Lexical scope resolution — which DECLARATION does this identifier refer to.
 *
 * Everything else in this engine answers that question by comparing `Identifier.text` against a
 * flat, file-global namespace. `buildCallGraph` keys functions by bare name and the first
 * declaration wins, so two same-named functions collapse into one node. `localNode` looks only at
 * top-level statements. `referencedElsewhere` counts any identifier whose text happens to match.
 * `ts.isBlock` appears nowhere in the repo. That is fine for the heuristics those functions feed —
 * they widen a search or add a call edge, and a spurious match costs recall, not correctness.
 *
 * It is NOT fine for finding clustering, where the question is "do these two mutants touch the same
 * data". There, matching on spelling merges
 *
 *     const total = a + b;          // mutant 1
 *     { const total = c + d; }      // mutant 2  — a DIFFERENT variable
 *
 * into one finding, and one of the two mutants stops being visible as its own gap. A merge that
 * hides a gap is the one failure this product cannot ship: everywhere else in the pipeline we spent
 * the week removing places where our own silence was rendered as a fact about the customer.
 *
 * So this module resolves properly. SYNTAX ONLY, like the rest of the engine — no `ts.Program`, no
 * `TypeChecker`, no customer tsconfig, no module resolution. A scope chain built from the syntax
 * tree answers shadowing exactly; what it cannot answer, it declines by returning null.
 *
 * The bias is deliberate and one-directional: an identifier we cannot resolve merges with NOTHING.
 * Unresolved is never treated as "matches everything", so every failure of this module costs the
 * author an extra finding, never a missing one.
 */

/** How a name was introduced. `var` and `function` hoist to the function scope; the rest do not. */
type BindingKind = "const" | "let" | "var" | "param" | "function" | "class" | "import" | "catch";
interface Binding {
    name: string;
    /**
     * The declaration node — this is the IDENTITY. Two identifiers refer to the same thing when they
     * resolve to the same node, never when they merely spell the same. Destructuring gives each bound
     * name its own `BindingElement`, so `const { a, b } = x` yields two distinct identities.
     */
    decl: ts.Declaration;
    kind: BindingKind;
}
interface Scope {
    parent: Scope | null;
    /** var/function declarations hoist past block scopes to the nearest scope with this set */
    isFunctionScope: boolean;
    bindings: Map<string, Binding>;
}
/** The scope table for one file: every scope-opening node mapped to its bindings. */
interface ScopeTable {
    byNode: Map<ts.Node, Scope>;
    sourceFile: ts.SourceFile;
    /**
     * Memo for {@link isReassigned}, which walks the whole file per query. Clustering asks about the
     * same handful of bindings once per mutant, so without this a file with 200 survivors re-walks
     * its own AST hundreds of times.
     */
    reassigned: Map<ts.Declaration, boolean>;
}
/**
 * Build the scope chain for a file.
 *
 * One pass. Declarations are routed to the scope that actually owns them: a `var` or function
 * declaration walks out to the nearest function scope, everything else lands in the innermost
 * scope. A function's NAME belongs to the enclosing scope while its PARAMETERS belong to its own —
 * getting that backwards is what makes a parameter appear to shadow nothing.
 */
declare function buildScopes(sourceFile: ts.SourceFile): ScopeTable;
/**
 * Resolve an identifier to the declaration it names, or null.
 *
 * Null means "we could not tell", and every caller must treat it as "matches nothing" rather than
 * "matches anything" — see the module header. Null is returned for globals, for names imported via
 * paths we do not follow, and for identifiers in a naming rather than referencing position.
 */
declare function resolveBinding(table: ScopeTable, id: ts.Identifier): ts.Declaration | null;
/**
 * Is this binding ever REASSIGNED anywhere in the file?
 *
 * This is what makes alias-following sound. `const b = a` says `b` and `a` are the same value —
 * but only while `a` cannot change under it:
 *
 *     let a = 1; const b = a; a = 2;    // b is a SNAPSHOT, not an alias
 *
 * Merging findings on `b` with findings on `a` there would be a genuine over-merge, the one
 * direction that can hide a gap. So the alias chain refuses to follow whenever either end is
 * reassigned.
 *
 * Assignment to a PROPERTY (`obj.x = 1`) is not reassignment of `obj` — the binding still names the
 * same object — so only a bare identifier on the left counts.
 */
declare function isReassigned(table: ScopeTable, decl: ts.Declaration): boolean;
/**
 * Resolve an identifier, then follow `const b = a` alias chains to the ORIGINAL binding.
 *
 * Without this, `b.total` and `a.total` cluster separately even though they are the same data —
 * an under-merge, harmless but avoidable. With it they cluster together, and the reassignment gate
 * above keeps the merge sound.
 *
 * ONLY a bare identifier initializer is followed. `const b = a.x` is deliberately NOT followed:
 * `b` and `a` are different data (the second is a whole object, the first one of its properties),
 * so resolving `b` to `a`'s declaration would merge two findings that are not the same gap. That
 * case is an under-merge and stays one. Calls, `await` and `new` are never followed for the same
 * reason — their result is a new value, not the named one.
 */
declare function resolveThroughAliases(table: ScopeTable, id: ts.Identifier): ts.Declaration | null;
/**
 * Every name in scope at a position, as a set.
 *
 * Used by the `wrong-variable` mutator, which today collects every identifier in the FILE and
 * substitutes one, reasoning that "an invented name would be a compile error". A real name that is
 * not in scope at the mutation site is equally a compile error — those mutants consume a run slot
 * and come back `build-error`, which is wasted budget, not evidence.
 */
declare function namesInScopeAt(table: ScopeTable, node: ts.Node): Set<string>;

declare const SAMPLING_ALGORITHM = "line-first-rr-v1";
/**
 * One enumerated (not yet run) mutant. Lines are 1-BASED here (matching FileScope, git diffs, and
 * the human-facing config strings); columns are 0-based babel columns, end exclusive.
 *
 * CONVENTION MAP (each verified in the respective package's source, not assumed):
 * - config string "file.js:5:4-6:4": 1-based lines, 0-based columns (core project-reader.js
 *   parses with parseInt(line) - 1 and passes columns through).
 * - FileDescription.mutate: 0-based lines (instrumenter's toBabelLineNumber ADDS 1 for babel).
 * - api Mutant.location (what instrument() returns): 0-based lines, 0-based columns.
 * This module converts at its boundaries so callers only ever see 1-based lines.
 */
interface EnumeratedMutant {
    /** workdir-relative file (posix separators) */
    file: string;
    mutatorName: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    /**
     * The mutated text this mutant substitutes.
     *
     * Load-bearing for IDENTITY, not decoration: file + span + operator is NOT unique — one operator
     * routinely emits several mutants at the same span (measured on a real 315-mutant file: 57 of
     * them shared a span+operator with another, so keying without the replacement collapsed 315
     * distinct mutants into 258 and made the executed-set accounting undercount). Optional because a
     * mutant may legitimately carry no replacement text.
     */
    replacement?: string;
}
interface SamplePlan {
    algorithm: typeof SAMPLING_ALGORITHM;
    seed: string;
    cap: number;
    /** every mutant the changed ranges allow (the honest denominator for disclosure) */
    eligible: number;
    /** the picked subset — the mutants this plan deliberately selected */
    sampled: EnumeratedMutant[];
    /**
     * Every mutant that will ACTUALLY RUN: the picks plus their containment closure.
     *
     * A Stryker `mutate` entry is a RANGE, so selecting a mutant also selects every mutant nested
     * inside its span (an arrow-function pick drags in each mutant in its body). Before this was
     * charged at plan time a cap of 500 executed 717 mutants and the run summary contradicted
     * itself. The budget is charged against this set, so `executed.length <= cap` holds.
     */
    executed: EnumeratedMutant[];
    /** changed lines bearing at least one eligible mutant */
    linesEligible: number;
    /** lines with at least one EXECUTED mutant — breadth, the disclosed metric */
    linesProbed: number;
    /**
     * Picks skipped because their containment closure alone exceeded the remaining budget. Disclosed
     * rather than silently dropped: a large pick that never fits means those lines were probed only
     * by smaller mutants, or not at all.
     */
    skippedOversizeClosures: number;
}
/**
 * Stable identity of an enumerated mutant: file + exact span + operator + REPLACEMENT.
 * The replacement is part of the identity because one operator emits several mutants at the same
 * span (see {@link EnumeratedMutant.replacement}); dropping it silently merges distinct mutants.
 */
declare const mutantKey: (m: EnumeratedMutant) => string;
/**
 * Line-first round-robin sample of `cap` mutants. Line order and the within-line order are both
 * seeded-deterministic; round k takes each line's (k+1)-th mutant while budget remains, so every
 * mutant-bearing line is probed once before any line is probed twice.
 */
declare function lineFirstSample(mutants: readonly EnumeratedMutant[], cap: number, seed: string): SamplePlan;
/**
 * Express the picks as Stryker `mutate` entries, column-precise, one per sampled mutant
 * ("src/a.js:5:4-5:12"). Stryker's range columns are the instrumenter's own convention — the
 * locations came from the same package that will re-place the mutants, so a pick selects exactly
 * the mutant it enumerated (asserted by the round-trip unit test).
 */
declare function sampleToMutateTargets(plan: SamplePlan, subdir?: string | null): string[];

/** Categories this baseline covers — the same six the model is asked for. */
declare const DETERMINISTIC_CATEGORIES: readonly ["missing-await", "exception-swallow", "argument-order", "off-by-one", "wrong-variable", "wrong-constant"];
interface DeterministicOptions {
    /** only emit recipes whose span intersects these 1-based lines (the diff scope) */
    changedLines?: ReadonlySet<number>;
    /** cap per category, so one dense file cannot crowd out every other rule */
    maxPerCategory?: number;
}
/**
 * "Similar identifier", made executable rather than left as prose. Two names are confusable when
 * they are close in edit distance but NOT the same name — the mistake being modelled is reaching for
 * the wrong one of two names that look alike (`startIndex` / `startIdx`, `res` / `req`).
 * Very short names are excluded: at length 2 every name is within distance 2 of every other, which
 * would make the rule fire everywhere and mean nothing.
 */
declare function isConfusableIdentifier(a: string, b: string): boolean;
/**
 * "Plausible constant", made executable. A replacement is plausible when it is the kind of value
 * someone would actually type by mistake: an adjacent number, a unit confusion, an off-by-a-power,
 * or the opposite boolean. Arbitrary values are not — replacing 7 with 913 tests nothing a real
 * mistake would produce.
 */
declare function plausibleConstants(literal: string): string[];
/**
 * Generate the deterministic baseline's recipes for one file.
 *
 * Returns recipes in the same shape the validated LLM proposals take, so both arms can be run
 * through one pipeline and compared on identical terms.
 */
declare function deterministicRecipes(file: string, source: string, opts?: DeterministicOptions): MutationRecipe[];
/** Per-category tally, so a run can report which rules actually had opportunity in a corpus. */
declare function categoryCounts(recipes: readonly MutationRecipe[]): Record<string, number>;

declare const PRODUCTION_OPERATOR_VERSION = "production-operators-v2";
declare const PRODUCTION_OPERATOR_CATEGORIES: readonly ["statement-deletion", "return-deletion", "control-flow-deletion", "argument-omission", "argument-order", "argument-replacement", "identifier-replacement", "property-substitution", "assignment-operator", "assignment-rhs", "missing-await", "nullish-fallback", "optional-chain-removal", "call-chain-omission", "parameter-default-removal", "class-field-initializer-removal"];
interface ProductionOperatorOptions {
    changedLines?: ReadonlySet<number>;
    maxPerCategory?: number;
    /** Include the frozen six-family control inventory. Default true. */
    includeControl?: boolean;
}
declare function productionRecipes(file: string, source: string, options?: ProductionOperatorOptions): MutationRecipe[];
declare function productionCategoryCounts(recipes: readonly MutationRecipe[]): Record<string, number>;

/** One operator, and the transformation it performs on source text. */
interface ClassicOperatorEntry {
    /** the operator's identity in the pass that runs it */
    id: string;
    /** what it rewrites - a statement about the EDIT, checkable against a proposal */
    rewrite: string;
}
/**
 * Stryker's built-in mutators, as this product runs them.
 *
 * THE WHOLE SET, because the classic pass writes no `mutator` block and Stryker's default is all of
 * them. Each sentence describes the edit at the level a reader can apply: "replaces a string literal
 * with an empty string" is checkable; "string mutations" is not.
 */
declare const STRYKER_BUILTIN_OPERATORS: readonly ClassicOperatorEntry[];
/**
 * The operators the deterministic pass runs: the frozen control inventory plus the production set.
 *
 * ONE LIST BECAUSE ONE PASS RUNS THEM. `productionRecipes` composes both by default
 * (`includeControl`), so a customer's run either has all of these or none of them, and splitting
 * them here would offer a distinction the prompt could not act on.
 */
declare const DETERMINISTIC_PASS_OPERATORS: readonly ClassicOperatorEntry[];
/**
 * The operator set a run actually ran, for the planting prompt's exclusion block.
 *
 * `deterministic` IS THE POLICY FLAG, NOT AN OPINION. `classicMutation.deterministicMutants.enabled`
 * decides whether the deterministic pass runs at all, and a run that did not run it must not tell
 * the model those rewrites are already covered - the model would then decline to write a bug nobody
 * else is writing. The Stryker built-ins are unconditional because the classic pass is.
 */
declare function classicOperatorInventory(input: {
    deterministic: boolean;
}): ClassicOperatorEntry[];
/**
 * The category names the deterministic pass can emit, as its own modules declare them.
 *
 * Exported so the drift test can compare against this inventory without importing two constants and
 * re-deriving the union at the assertion site.
 */
declare const DETERMINISTIC_PASS_CATEGORIES: readonly string[];

export { type ApplyResult, type Binding, type BindingKind, type ClassicOperatorEntry, type Cluster, type ClusterInput, type ClusterResult, DESCRIBE_FNS, DETERMINISTIC_CATEGORIES, DETERMINISTIC_PASS_CATEGORIES, DETERMINISTIC_PASS_OPERATORS, type DeterministicOptions, type EnclosingFunction, type EntryPoint, type EnumeratedMutant, type ErrorHandlerScan, type ExportSurface, type FileHandlerScan, type HandlerScanInput, type HandlerSpan, type MutationRecipe, PRODUCTION_OPERATOR_CATEGORIES, PRODUCTION_OPERATOR_VERSION, type ParameterInfo, type ParsedSource, type ProductionOperatorOptions, type Reachability, type ReachabilityAnalysis, SAMPLING_ALGORITHM, STRYKER_BUILTIN_OPERATORS, type SamplePlan, type ScopeTable, TEST_FNS, type TautologyResult, type TautologyScanInput, analyzeReachability, applyRecipe, buildScopes, categoryCounts, classicOperatorInventory, clusterMutants, collectTypeContext, commentInNodeMatches, deterministicRecipes, enclosingNodes, escapeMutatePath, forcedHandlerRecipes, isConfusableIdentifier, isParameterized, isReassigned, lineFirstSample, lineKey, lineOf, moduleExportSurface, mutantKey, namesInScopeAt, offsetOf, parseSource, plausibleConstants, productionCategoryCounts, productionRecipes, recipeFromOffsets, recipeFromSpan, recipeId, sha256 as recipeSha256, resolveBinding, resolveThroughAliases, sampleToMutateTargets, scanErrorHandlers, scanFileHandlers, scanTautologies, strictOffsetOf, stringArg, testCallName, tryRecipeFromSpan };
