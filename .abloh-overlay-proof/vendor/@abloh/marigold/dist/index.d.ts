import { ProposalsUnavailableCode, TriageVerdict as TriageVerdict$1, MutantStatus, RoutePurityRung, ReportUnavailable, ScoreComponent, NormalizedMutant, PROPOSALS_BLOCK_SCHEMA, ProposalsSummaryWire, ProposalsFeatureState, ModelUsage, PROPOSALS_SIDECAR_SCHEMA, EvidenceCustody, BugBehaviourVerdict, BugSeverity, POOL2_EVIDENCE_SCHEMA, DeclaredPackageManager, SealedRuntime, SystemPackage, PackageManagerName, RateCard, ModelRate } from '@abloh/core';
export { BUG_BEHAVIOUR_VERDICTS, BUG_SEVERITIES, BugBehaviourVerdict, BugSeverity, COMPUTE_RATE_ENV, MAX_BUG_RATIONALE_LEN, MAX_BUG_SENTENCE_LEN, MAX_BUG_TYPE_LEN, ModelRate, ModelUsage, PROPOSALS_BLOCK_SCHEMA, PROPOSALS_GAP_ORIGINS, PROPOSALS_SIDECAR_SCHEMA, PROPOSALS_VERDICTS, ProposalsFeatureState, ProposalsGapOrigin, ProposalsVerdict, RATE_CARD_ENV, RATE_CARD_SCHEMA, ROUTE_PURITY_RUNGS, RateCard, RateCardFailure, RateCardResolution, RoutePurityRung, ScoreComponent, acceptBugType, bugIdentity, callCeilingDollars, canonicalJson, percentOfMeasured as componentRate, installCommandNeedsCorepackEnable, looksLikeRunnerFailureSummary, rateCardFromEnvironment, sha256, sha256Bytes, structuralDigest, usageDollars } from '@abloh/core';

/**
 * Engine v2 domain contract.
 *
 * TIERLESS BY CONSTRUCTION. There is no tier field, no tier parameter and no tier-conditional
 * branch anywhere in this package: one flat mode, every organ on, for every repository. The v1
 * path keeps its tiers untouched until it is retired (design doc, 2026-08-13).
 *
 * NOTHING HERE IS TERMINAL EXCEPT BUDGET AND THE EXIT VERDICT. Every stage below reports a
 * `HoldReason` rather than a rejection: a candidate that fails a stage returns to the next round's
 * prompt carrying the evidence of how it failed. The v1 funnel - where one small check silently
 * killed a whole answer and the check run said nothing at all - is the defect this shape exists to
 * not rebuild.
 */
/** One survivor the loop may attempt, reduced to what the loop actually needs. */
interface SurvivorGap {
    /**
     * Identity that survives between runs: derived from WHAT was mutated (file, span, mutator,
     * replacement), never from the engine report's ordinal `id`. Two runs of the same commit produce
     * the same `gapId` for the same physical mutation.
     */
    gapId: string;
    /**
     * Identity of the SPAN this gap sits in, shared by every mutant over the same expression.
     *
     * IT DECIDES WHAT IS ASKED, NEVER WHAT IS SCORED. Gaps sharing a `spanKey` are one question - one
     * generation slot, one prompt listing every replacement at that span - because a test that
     * distinguishes one of them usually distinguishes its siblings and the kill matrix already
     * credits that. Every such gap keeps its own `gapId`, its own verdict and its own row in the
     * artifact. See {@link spanIdentity} for the measurement.
     */
    spanKey: string;
    /** run-local engine id, kept only so an artifact reader can join back to the mutant record */
    mutantId: string;
    file: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    mutator: string;
    /** the mutated text: without it there is no patch to replay and no gap to close */
    replacement: string;
    /** the exact source text the mutation replaced; used to locate the span unambiguously */
    originalText: string;
    /** how many tests cover the location (0 means the loop is generating first coverage) */
    coveredBy: number;
}
/**
 * WHERE THE ENVIRONMENT A RUN MEASURED IN CAME FROM.
 *
 * `borrowed` - the caller handed over a working tree it had already installed and built, and the
 * sealed image is that tree copied onto the pinned proof base with no install step at all. This is
 * what a hosted pull-request check does from the ambient-build release onwards: the customer's own
 * workflow runs its own install and build steps first, and abloh measures inside what they left.
 *
 * `rebuilt` - the environment is reconstructed inside the image from `abloh.yml`'s install command,
 * which is what every run did before borrowing existed and what a run with no prepared tree still
 * does.
 *
 * IT IS NEVER GUESSED AND IT NEVER SILENTLY DOWNGRADES. Each value has a fact behind it - a
 * dependency root present in the tree, or an install command in the policy - and the value travels
 * into the artifact so two runs in two different environments can be told apart rather than
 * averaged. It is in the preparation recipe for that reason: a borrowed run and a rebuilt run are
 * not the same environment and may never share a carried verdict.
 */
type EnvironmentSource = "borrowed" | "rebuilt";
/**
 * WHAT A BORROWED RUN INHERITED, split by what it is allowed to invalidate.
 *
 * The split is the whole design and it is not cosmetic. The first four fields are what the
 * environment IS, so they are hashed into the preparation recipe: a node patch bump, a different
 * package-manager version, a new runtime or a changed lockfile are real environment changes and a
 * verdict earned before one of them is not valid after it.
 *
 * {@link runnerImage} is what PRODUCED the environment, and it is disclosed without being hashed.
 * GitHub reissues its hosted runner images roughly weekly. Hashing the image id would drop every
 * stored verdict of every customer every week for a change that in almost every case moved nothing
 * a test can see, and carry-forward plus the shared triage cache are worth 38 points of rerun
 * saving - one measured run went from $1.59 to $0.98 on the triage half alone (2026-08-23). A
 * runner-image bump that moved node, the package manager, a runtime or a lockfile is caught by the
 * four fields above; one that moved none of them changes no verdict's validity. So the rule is:
 * hash what the environment IS, disclose what produced it. Kenneth's ruling of 2026-08-26.
 */
interface InheritedEnvironment {
    /** the node that ran the caller's own install and build, `null` when it could not be read */
    node: string | null;
    /** the package manager as `name@version`, `null` when the caller's tree names no version */
    packageManager: string | null;
    /** every declared extra runtime as `name@version`, sorted, empty when none is declared */
    runtimes: readonly string[];
    /** the governing lockfiles and their digests, sorted by path - WHICH dependency set was installed */
    lockfiles: ReadonlyArray<{
        path: string;
        digest: string;
    }>;
    /**
     * The CI runner image that produced all of the above. DISCLOSED, NEVER HASHED - see the type's
     * own header for the measurement that decides it. Every field is null off a GitHub runner.
     */
    runnerImage: {
        imageOs: string | null;
        imageVersion: string | null;
        platform: string | null;
        arch: string | null;
    };
}
/** A survivor the loop did not take, with the reason - disclosed, never silently dropped. */
interface IntakeExclusion {
    mutantId: string;
    file: string;
    startLine: number;
    mutator: string;
    reason: IntakeExclusionReason;
}
declare const INTAKE_EXCLUSION_REASONS: readonly ["not-a-survivor", "no-replacement-text", "no-original-text", "no-span-columns", "duplicate-identity"];
type IntakeExclusionReason = (typeof INTAKE_EXCLUSION_REASONS)[number];
/** Where a candidate is currently held. Ordered: each stage feeds the next. */
declare const LOOP_STAGES: readonly ["intake", "normalization", "triage", "generation", "admission", "light-check", "kill-matrix", "exit-proof"];
type LoopStage = (typeof LOOP_STAGES)[number];
/**
 * Why a candidate did not advance past a stage.
 *
 * A hold is FEEDBACK: it names the stage, the reason and the evidence, and all three go back into
 * the next round's prompt. Only `budget-exhausted` and the exit proof's verdict end an attempt.
 */
interface Hold {
    stage: LoopStage;
    reason: string;
    /** bounded verbatim evidence (runner output, admission finding, parse error) - stays local */
    evidence?: string;
    /**
     * The model call's failure KIND, as a value, when this hold exists because a call did not answer.
     *
     * WHY IT IS A FIELD AND NOT LEFT IN `reason`. The dollar cost limit is enforced inside the model
     * client and comes back as `failure.kind === "budget"`; the loop's budget attribution reads its
     * OWN counters - call slots, execution ceiling, wall clock - and nothing set it from a refused
     * call. So a round that asked nothing because the money ran out was recorded as
     * `stoppedOnDryRound: true, stoppedOnBudget: false`, and a reader of the funnel concluded the
     * engine ran out of ideas when it ran out of money. Measured on both affected runs of the
     * complete-fix benchmark, and `repair.refusedByBudget` read 0 on a run where 6 of 6 repair calls
     * were refused for money (`data/abloh-unfixed-gaps-investigation/report.md` BUG 3).
     *
     * The alternative was parsing the reason string, which is prose that exists to be read by people.
     * The loop tests a value.
     */
    failureKind?: string;
}
/** One generated candidate test, before any execution. */
interface Candidate {
    /** stable within a run: sha256 over (gapId, round, test file path, body, support files) */
    candidateId: string;
    gapId: string;
    round: number;
    /** repo-relative path the test would occupy */
    testFile: string;
    testName: string;
    /** the generated test source - LOCAL ONLY, never egresses */
    testBody: string;
    supportFiles: readonly CandidateSupportFile[];
    model: string | null;
    promptVersion: string;
    /**
     * The candidate this one repaired, when in-round repair produced it. Present only on repaired
     * candidates, so "which tests did a repair call write" is answerable per candidate rather than
     * only in aggregate. `promptVersion` carries the same fact in the signed block.
     */
    repairedFrom?: string;
}
interface CandidateSupportFile {
    path: string;
    source: string;
}
/** One side of a differential execution. */
interface SideRun {
    /** did the suite/test report success */
    passed: boolean;
    /** did the candidate test actually execute (a test the runner never collected is not evidence) */
    executed: boolean;
    /** the failure was an assertion, not a crash, compile error or missing module */
    failedAssertion: boolean;
    /** bounded verbatim runner output - LOCAL ONLY */
    report: string;
    wallMs: number;
}
declare const LIGHT_CHECK_VERDICTS: readonly ["distinguishes", "real-not-passing", "mutant-not-failing", "not-executed", "errored"];
type LightCheckVerdict = (typeof LIGHT_CHECK_VERDICTS)[number];
interface LightCheckResult {
    candidateId: string;
    gapId: string;
    verdict: LightCheckVerdict;
    real: SideRun | null;
    mutant: SideRun | null;
    /** how many container executions this check cost (the reused-vs-executed disclosure feeds on it) */
    executions: number;
    /**
     * The `real-not-passing` verdict came from a run of the project's own test COMMAND that failed
     * with no test report at all - the shape of a lint, typecheck or build stage chained in front of
     * the runner, not of the candidate failing.
     *
     * It is not a separate verdict because the verdict is still true: the real side did not pass. It
     * changes only what the hold reason SAYS, so a repository whose script gates its runner reads a
     * sentence naming that possibility instead of one blaming a test the runner never saw.
     */
    gateShaped?: boolean;
}
/** One cell of the kill matrix: candidate C replayed against survivor patch G. */
interface KillMatrixCell {
    candidateId: string;
    gapId: string;
    /** the candidate fails on this gap's patch and passes on the real source */
    kills: boolean;
    executions: number;
    hold?: Hold;
}
declare const EXIT_VERDICTS: readonly ["proven", "rejected", "not-attempted-budget"];
type ExitVerdict = (typeof EXIT_VERDICTS)[number];
/**
 * How the suite gate reached its verdict about one candidate.
 *
 * Each value is a different QUALITY of evidence, and the difference matters to anyone reading a
 * run: `named` is a set difference over the tests themselves and is the strongest; `counted` is a
 * rise in a number the runner stated without naming anything, and can be cancelled out by an
 * unrelated pre-existing failure that stopped failing; `unattributable` is the honest admission
 * that this run cannot say, and it never convicts.
 *
 *   - `no-failures`     the suite passed with the candidate present; there is nothing to attribute
 *   - `baseline-green`  the suite passed without any candidate, so every failure with it is new
 *   - `named`           both runs named their failing tests; the delta is the set difference
 *   - `counted`         neither named them, both counted them; the delta is the rise in the count
 *   - `unattributable`  the baseline could not be measured, or neither run named or counted
 *   - `error`           the suite could not be executed with the candidate present, and could
 *                       without it
 */
declare const SUITE_DELTA_BASES: readonly ["no-failures", "baseline-green", "named", "counted", "unattributable", "error"];
type SuiteDeltaBasis = (typeof SUITE_DELTA_BASES)[number];
interface ExitProofResult {
    candidateId: string;
    gapId: string;
    verdict: ExitVerdict;
    /** every repetition of the differential, alternating which side runs first */
    repetitions: Array<{
        realFirst: boolean;
        real: SideRun;
        mutant: SideRun;
    }>;
    /**
     * The whole-suite gate's record. `green` is the raw colour of the run carrying this candidate;
     * `regressed` is the judgement, and THEY ARE NOT THE SAME FACT - a suite that was already red for
     * its own reasons is not green and did not regress, which is the case this record exists to be
     * able to state. A rejection follows `regressed`, never `green`.
     */
    suite: {
        /** the suite passed with the candidate present */
        green: boolean;
        /** the candidate made previously-passing tests fail; the only grounds for a suite rejection */
        regressed: boolean;
        /** failing tests with the candidate present, when the report says */
        failed: number | null;
        /** how the judgement was reached */
        basis: SuiteDeltaBasis;
        /** the tests that fail with the candidate and passed without it. LOCAL ONLY - names, not counts */
        newFailures: readonly string[];
        /** the same suite with no candidate present; absent when the run never needed to ask */
        baseline?: {
            green: boolean;
            failed: number | null;
            error?: string;
        };
        /** bounded verbatim output - LOCAL ONLY */
        report: string;
    } | null;
    /** the runner demonstrably collects a test at the candidate's path */
    discovery: {
        confirmed: boolean;
        detail: string;
    } | null;
    /** every other gap this candidate also closes, from the kill matrix */
    alsoCloses: readonly string[];
    hold?: Hold;
    executions: number;
}
/**
 * One logical model call, as the local sidecar records it.
 *
 * WHY PER CALL AND NOT PER RUN. `data/abloh-final-config-rerun/report.md` section 4 could not say
 * how much of a run's 3,081 s of repair was two calls that hung and how much was the endpoint being
 * slow, because only totals were kept. The transport already measures every one of these fields
 * (`model/client.ts`, `CallTiming`); what was missing was writing them down.
 *
 * `throttleRetries` is extra HTTP attempts inside ONE logical call, so calls and retries are never
 * added together (`model/throttle.ts`).
 */
interface ModelCallRecord {
    task: "generation" | "repair";
    round: number;
    /** the gaps this call was asked about */
    gapIds: readonly string[];
    ok: boolean;
    /** the transport failure kind, when the call did not answer */
    failure?: string;
    latencyMs: number;
    /** null when the transport did not measure it (a scripted client in a test) */
    timeToFirstTokenMs: number | null;
    tokensPerSecond: number | null;
    /** the wall this call was actually given */
    deadlineMs: number | null;
    effort: string;
    throttleRetries: number;
    /**
     * The longest this call went without a response byte, or null when nothing measured it.
     *
     * RECORDED BECAUSE THIS RECORD IS WHERE THE LAST ONE WAS DIAGNOSED FROM. The endpoint regression
     * of 2026-08-20 was dated by reading `ttft` off these rows three days after the fact; what they
     * could not say was how close a SUCCEEDING call had come to the intermediary's ~60 s idle wall, so
     * a lane that was one slow round from failing looked exactly like a healthy one. This number is
     * that distance. See `CallTiming.longestSilenceMs` in `model/client.ts`.
     */
    longestSilenceMs?: number | null;
    /** which API surface answered - `responses` normally, `chat` on an endpoint that has no other */
    surface?: string | null;
}
/** Per-stage funnel counters. `held` is not `died`: a held candidate is next round's input. */
interface FunnelStage {
    entered: number;
    advanced: number;
    held: number;
    /** reasons and their counts, so "where did candidates die" has an answer without a re-run */
    holdReasons: Record<string, number>;
}
type Funnel = Record<LoopStage, FunnelStage>;
declare function emptyFunnel(): Funnel;
/** Hard limits. Budget is one of the two things that is genuinely terminal. */
interface LoopBudget {
    /**
     * Wall-clock FLOOR for the whole loop. The effective ceiling scales with the number of gaps -
     * see {@link effectiveTotalMs} - because a flat number is a different budget for a 3-gap diff
     * than for a 35-gap one.
     */
    totalMs: number;
    /**
     * Wall-clock allowed per attemptable gap, added on top of the floor.
     *
     * WHY IT EXISTS. The first live run over node-cron's 35 gaps averaged 38.9 s per gap end to end,
     * and a flat 20-minute budget stopped that run with four proven-ready candidates still queued at
     * the exit proof - so the run reported zero for a reason that had nothing to do with the engine's
     * ability to close gaps.
     *
     * RECALIBRATED TO 150 s, 2026-08-21, and the old 90 s was measurably too small. The derivation
     * written here - "38.9 s measured, with headroom for a slower suite" - stopped being true twice
     * over (`data/abloh-nodecron-aws-regression/report.md` 4.1):
     *
     * | run | engine | per-gap allowance USED, net of the floor | how it ended |
     * |---|---|---|---|
     * | node-cron, 2026-08-13 | no repair | 38.9 s | finished |
     * | `e2c`, 2026-08-14 | repair on | 33 s | ran out of ROUNDS, 46 minutes to spare |
     * | replicate 1, 2026-08-21 | repair on | 91.3 s | CLOCK, 86 executions and 45 calls unspent |
     * | replicate 2, 2026-08-21 | repair on | 91.2 s | CLOCK, never reached round 3 |
     *
     * BOTH 2026-08-21 REPLICATES CONSUMED THEIR ENTIRE ALLOWANCE AND WERE STILL WORKING, which is
     * why 91 s is not the number to calibrate to: it is the ceiling that cut them off, so the figure
     * is censored and the true need is above it, not equal to it. What moved between `e2c` and them
     * is per-call latency, which roughly doubled on the same task at the same pin (repair 44.6 s to
     * 84.7 and 105.2 s per call). Doubling `e2c`'s 33 s gives about 66 s, and 150 s is that with the
     * same kind of headroom the original 90 carried - enough for a third round the clock has been
     * taking away.
     *
     * IT IS A CEILING, NOT A TARGET. A run that closes its gaps stops on a dry round long before it
     * reaches this, which is what `e2c` did with 46 minutes left; raising it costs a run that was
     * already finishing nothing at all, and costs a run that was being cut off the difference between
     * two rounds and three. The concurrent repair pass landing alongside this is expected to bring
     * the real number back down toward `e2c`'s - `repair.ms` against `repair.modelMs` is what will
     * say by how much - and this value should be re-derived once that has been measured rather than
     * left to go stale a third time.
     */
    msPerGap: number;
    /** ceiling on model calls across all rounds */
    modelCalls: number;
    /** ceiling on sealed-container executions across all rounds */
    executions: number;
    /** ceiling on rounds; a dry round stops earlier */
    rounds: number;
}
declare const DEFAULT_BUDGET: LoopBudget;
/**
 * The run's actual wall-clock ceiling: the floor, plus time proportional to the work in front of it.
 *
 * A budget that does not scale is not a budget, it is a coin flip on diff size - and the flip lands
 * as a reported zero that looks like an engine failure.
 */
declare function effectiveTotalMs(budget: LoopBudget, gapCount: number): number;
/** Bounded evidence: verbatim runner output is local, but it is not unbounded local. */
declare const MAX_EVIDENCE_CHARS = 4000;
declare function boundEvidence(text: string, max?: number): string;
/**
 * Bounded evidence that keeps the END of the text rather than the beginning.
 *
 * For output whose USEFUL part is written last. A docker build is the case this exists for:
 * buildkit opens with a progress header ("#0 building with \"desktop-linux\" instance...") and
 * writes the failing step's own output at the very bottom, so a head-bound excerpt of a failed
 * build names the driver and never the cause - three artifacts of 2026-08-16 carried a reason that
 * ended mid-word in `#1 DONE 0.` and said nothing about why the build failed.
 */
declare function boundEvidenceTail(text: string, max?: number): string;

/**
 * The v2 engine's own way of saying "no block, and here is which kind of failure that was".
 *
 * THE CODE IS DECLARED AT THE THROW AND IT IS REQUIRED, for the reason `PyCoverageError` and
 * `CoverageAcquisitionError` state at length: the throw site is the only place that knows its own
 * failure class for certain, and a consumer that guesses the class back out of a sentence gets it
 * wrong the first time it meets a sentence nobody wrote a rule for.
 *
 * WHAT IT IS FOR HERE IS DIFFERENT FROM THOSE TWO, THOUGH. Coverage codes exist so a completed
 * artifact is not thrown away at ingest. This exists because the field the dispatch used to fill was
 * an EGRESS BOUNDARY nobody had read as one: it carried `error.message`, and a v2 exception's
 * message is the repository's own build log or its runner's own output. See
 * `PROPOSALS_UNAVAILABLE_COPY` in `@abloh/core` for what replaced it.
 *
 * SO THERE ARE TWO HALVES AND THEY GO TO DIFFERENT PLACES. `code` is the closed thing that egresses.
 * `detail` is the real diagnosis - a build log, a failing step, a stack - and it stays on the
 * machine, scrubbed, in the run log its reader already has.
 */

declare class EngineUnavailableError extends Error {
    /** The closed wire code. Nothing else about this error may leave the machine. */
    readonly code: ProposalsUnavailableCode;
    /**
     * The full local diagnosis - LOCAL ONLY, and untrusted.
     *
     * It holds whatever the failure held: a docker build log, a runner's stderr, a customer's setup
     * script output. It is scrubbed before it reaches even the local log, because a secret in a build
     * log is a secret in a build log wherever that log is read.
     */
    readonly detail: string;
    constructor(code: ProposalsUnavailableCode, message: string, detail?: string);
}
/**
 * The code an escaped exception should be reported under.
 *
 * ANYTHING UNDECLARED IS `engine-error`, and that is the safe direction rather than a shrug: an
 * exception this engine did not classify is one abloh did not anticipate, which is a defect in abloh
 * and is exactly what that sentence says. It is never a reason to reach into the message for a
 * better guess - the message is the thing that must not travel.
 */
declare function unavailableCode(error: unknown): ProposalsUnavailableCode;
/** The local-only diagnosis for any thrown value. Still requires scrubbing before it is written. */
declare function unavailableDetail(error: unknown): string;

/**
 * CARRY-FORWARD: what one run may answer from an earlier run of the same repository, and the one
 * rule that decides it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREAT, STATED BEFORE THE MECHANISM
 * ---------------------------------------------------------------------------------------------
 *
 * Abloh runs the customer's own test suite, and that suite is code the customer wrote. It runs as
 * the same OS user as the CLI, so it can write anything the CLI can read - including this store and
 * the shared triage stage's verdict cache. On CI there is a second copy of the same problem: a store
 * restored from `actions/cache` is repository-controlled input, which is exactly why the Action
 * refuses to restore the coverage provider cache and why baseline history is confined to reviewer
 * disclosure.
 *
 * The sealed container does not remove this on the pull-request lane. The v2 execution organ is
 * genuinely sealed, but the lane's INTAKE is the classic Stryker pass, which runs on the host, and
 * Stryker's own sandbox is a directory copy with `node_modules` symlinked back rather than a
 * security boundary. So repository test code executes as the same OS user on every run.
 *
 * A triage verdict changes the score: `likely-equivalent` removes a survivor from the reported gaps.
 * A suite that writes a `likely-equivalent` record for every mutant therefore makes its own weak
 * tests look strong - and it can write those records, because it runs as us.
 *
 * ---------------------------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------------------------
 *
 *   A CARRIED RECORD MAY NEVER BE THE REASON A GAP DISAPPEARS FROM THE REPORT.
 *
 * This is not a new principle. It is the one already written beside the refusal it replaces -
 * "proof, not cache content, decides their outcome" - applied per carried item:
 *
 *   generated candidate bytes    carry freely; the light check and exit proof execute them fresh
 *   triage `real-gap`            carry freely; it can only cause MORE work
 *   triage `unclear`             carry freely; `unclear` counts as a real gap by design
 *   triage `likely-equivalent`   NEVER carried - re-asked live, every run, no exception
 *   execution `survived` on a reported gap   never carried (the existing no-exception rule)
 *
 * The rule is fail-closed by construction: the only direction a carried record can move the report
 * is towards more work and more gaps, never fewer. A poisoned store costs money and wall clock; it
 * cannot hide a gap.
 *
 * IT IS ENFORCED AT THE TYPE BOUNDARY, not by a check a caller could forget. {@link StoredTriage}'s
 * verdict field admits exactly {@link CarriableTriageVerdict}, so storing an equivalence for reuse
 * is structurally impossible rather than policy-forbidden - the same technique the baseline-history
 * store uses to keep flakiness out of a score.
 *
 * MEASURED COST: 5 of 71 triage verdicts across the five benchmark runs, 7%. 93% of the carry
 * survives the rule, so the safe version of this feature is not a compromised version of it.
 *
 * A re-asked equivalence is also not wasted work. It is a SECOND INDEPENDENT SAMPLE of the only
 * verdict that can suppress a gap, and that verdict is the one measured to flip: two cold runs of
 * the same commit at the same prompt and model disagreed on 1 verdict in 34, and the flip was a
 * `likely-equivalent` hiding a gap the other run reported.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY BYTE-EXACT KEYING IS SOUND
 * ---------------------------------------------------------------------------------------------
 *
 * Not "the bytes are the same so the answer is probably still right". Stronger: a triage call is a
 * DETERMINISTIC FUNCTION. Given the same prompt bytes, the same model identity, the same decoding
 * parameters and the same reasoning effort, the endpoint is being asked the identical question, so
 * carrying its answer forward MEMOIZES A PURE FUNCTION rather than re-using a measurement. The key
 * therefore has to name every argument of that function, and nothing else needs to be in it.
 *
 * A generated candidate is not even that. It is a PROPOSAL, re-executed from scratch every run, so
 * carrying it cannot make a wrong answer look right; it can only save the model call that would
 * have proposed the same thing again.
 *
 * A mutation execution verdict IS genuinely a measurement, which is why the reuse layer beside this
 * file refuses to carry one a customer-facing gap claim would rest on.
 *
 * @see {@link carryKey} for the arguments, {@link forcedFullReasons} for what voids them wholesale.
 */

declare const CARRY_STORE_SCHEMA = "abloh-marigold-carry/v1";
/**
 * The only triage verdicts a carried record may hold.
 *
 * Spelled as a literal list rather than derived with `Exclude<TriageVerdict, "likely-equivalent">`,
 * because a derivation would silently ADMIT any verdict added to the enum later. A new verdict has
 * to be added here by hand, which is where someone has to think about whether it can suppress a gap.
 */
declare const CARRIABLE_TRIAGE_VERDICTS: readonly ["real-gap", "unclear"];
type CarriableTriageVerdict = (typeof CARRIABLE_TRIAGE_VERDICTS)[number];
/**
 * Narrow a verdict to the carriable set, or `null` when the direction rule forbids carrying it.
 *
 * The single gate every write and every read passes through. `null` is not an error: it is the rule
 * firing, and the caller's answer to it is one live model call.
 */
declare function carriableVerdict(verdict: TriageVerdict$1 | string): CarriableTriageVerdict | null;
/** True when this verdict can only ever move the report towards more gaps. */
declare function movesAgainstTheScore(verdict: TriageVerdict$1 | string): boolean;
/**
 * Everything a carried model answer is a function of.
 *
 * Five digests - what was mutated, the source bytes around it, which tests could notice it, the
 * environment it was judged in, and the customer policy that decides what counts as a gap - and
 * four version strings naming the code that asked the question.
 *
 * `fileDigest` is what makes "source bytes" real, and it binds more than it looks like it does: the
 * context slice the prompt embeds is derived ENTIRELY from that file's bytes (the enclosing function
 * or a window, plus the exported names read from the same bytes). The two things the prompt varies
 * on that are NOT read from that file - the import specifier the generated test would use, and
 * whether coverage was attributable - are named separately below for exactly that reason.
 */
interface CarryKeyInput {
    /** the mutation itself: file path, exact span, mutator, replacement text */
    gapId: string;
    /** sha256 of the mutated file's bytes */
    fileDigest: string;
    /** sha256 over the sorted canonical identities of the tests that reach the span */
    reachDigest: string;
    /** the prepared environment the answer was produced against */
    recipeDigest: string;
    /** the customer policy that shapes what counts as a gap */
    policyDigest: string;
    /** the exact prompt template that asked */
    promptVersion: string;
    /** the model AS RESOLVED LIVE, never a declared placeholder, with effort and completion ceiling */
    modelPin: string;
    /** the engine that produced it */
    engineVersion: string;
    /**
     * Solo or batched, plus the batch composition digest when batched.
     *
     * A batched verdict depends on what it was batched WITH, so a mode change is a different question
     * even at an identical prompt version. `"solo"` today; triage batching is a separate lever and
     * this field is where its evidence lands.
     */
    triageMode: string;
    /**
     * Where the generated test would be placed and how it would import the module under test.
     *
     * NOT derivable from `fileDigest`: it depends on the placement decision and the module format, so
     * two runs with identical source bytes can build different prompts. Empty for a triage key, which
     * embeds no import line.
     */
    importSpecifier?: string;
    /**
     * `false` when coverage attribution was unavailable for this span.
     *
     * A verdict reached WITHOUT coverage was reached on different prompt wording and a different
     * premise, so it must not answer a key computed WITH it. Unknown reach is treated as changed,
     * never as equal - the same fail-closed direction the shared triage key's `|nocov` marker takes.
     */
    coverageAttributed: boolean;
}
/**
 * The memoization key. Canonical JSON so field order never decides the digest, and every field
 * required so a record missing one cannot compute a key at all.
 */
declare function carryKey(input: CarryKeyInput): string;
/** A model pin as the key names it: the resolved id, the effort it ran at, and its output ceiling. */
declare function modelPinString(pin: {
    model: string;
    effort: string;
    maxCompletionTokens: number;
}): string;
/**
 * The run-level facts that void EVERY carried record at once rather than one at a time.
 *
 * These are held in the store as well as folded into each key, because a mismatch here is news the
 * run must be able to say out loud - "the base moved, so nothing carried" is a sentence a reader
 * needs, and a silent universal key miss is the same behaviour with no explanation.
 */
interface CarryIdentity {
    /**
     * The merge base the store's records were produced against.
     *
     * A pull request's base moves whenever the target branch moves, and the mutation scope is computed
     * against the base. A different base is a different set of changed lines, therefore a different
     * set of mutants and a different pool sizing. The bug pool's own store learned this and put the
     * plan digest in its key for it; base identity goes in the STORE, not only in the key, so a base
     * move forces a full run rather than silently answering with another base's records.
     */
    baseSha: string;
    policyDigest: string;
    engineVersion: string;
    triagePromptVersion: string;
    generationPromptVersion: string;
    /** task name -> the pin that task ran under, so a change to any one task's model is visible */
    modelPins: Record<string, string>;
    /** the container recipe the environment was prepared under */
    recipeDigest: string;
}
declare const FORCED_FULL_REASONS: readonly ["base-changed", "policy-changed", "triage-prompt-changed", "generation-prompt-changed", "engine-changed", "model-pin-changed", "recipe-changed", "wholesale-invalidated", "rebaseline-due", "identity-indeterminate", "repository-mismatch", "operator-forced"];
type ForcedFullReason = (typeof FORCED_FULL_REASONS)[number];
/**
 * Compare the identity a store was written under against this run's, and name every difference.
 *
 * FAIL-CLOSED, STATED AS A RULE: reuse is permitted only when every input is POSITIVELY PROVEN
 * unchanged, and absence of evidence is treated as change. An absent field, an empty digest, a model
 * id that could not be probed - each is `identity-indeterminate` and each forces the full run. This
 * is why the return is a list of REASONS rather than a boolean: a run that carries nothing has to be
 * able to say which of them fired.
 *
 * A store with no identity at all (`stored === null`, a cold start) is NOT a forced full run - it is
 * simply an empty store, and every lookup misses on its own. Forcing here would be indistinguishable
 * from a real invalidation on every first run of every repository.
 */
declare function forcedFullReasons(input: {
    stored: CarryIdentity | null;
    current: CarryIdentity;
}): ForcedFullReason[];
/** Order-independent digest of the pin map, so key insertion order never reads as a pin change. */
declare function modelPinsDigest(pins: Record<string, string>): string;
/** The identity digest a record is stamped with, for the artifact's provenance line. */
declare function carryIdentityDigest(identity: CarryIdentity): string;
/**
 * A carried triage verdict.
 *
 * `verdict` is {@link CarriableTriageVerdict}, so an equivalence cannot be written here at all. The
 * advisory prose rides along because it is part of the same model answer and re-deriving it would
 * mean the model call the carry exists to avoid; it is re-checked through the egress guard on the
 * way out exactly as a cache hit is, because this file is untrusted input.
 */
interface StoredTriage {
    /** the memoization key: every argument of the function whose answer this is */
    key: string;
    gapId: string;
    verdict: CarriableTriageVerdict;
    reasonCode: string;
    confidence: number;
    rationale?: string;
    description?: string;
    about?: string;
    severity?: string;
    severityBasis?: string;
    modelId: string;
    promptVersion: string;
    effort?: string;
    /** commit the verdict was produced at, so a report can say which push asked */
    producedAtSha: string;
    producedAtRun: number;
}
/**
 * A carried generation proposal.
 *
 * PROPOSED SOURCE, NEVER A RESULT. Every use runs a fresh light check, fault proof, target execution
 * and whole-suite proof at today's HEAD; nothing about carrying the bytes lets an unproven candidate
 * reach a report.
 *
 * `rejectedAtRun` is the eviction the design names. A proposal its light check rejected must be
 * evicted rather than re-carried, or the store pins a permanently failing candidate and the gap is
 * never regenerated - the carry would then SUPPRESS work, which is the direction rule's forbidden
 * direction wearing a different hat.
 */
interface StoredCandidate {
    key: string;
    gapId: string;
    candidateId: string;
    testFile: string;
    testBody: string;
    supportFiles: Array<{
        path: string;
        source: string;
    }>;
    producedAtSha: string;
    producedAtRun: number;
    rejectedAtRun: number | null;
}
/**
 * Sized against the baseline-history store, which is the persistence pattern this one copies.
 *
 * Candidate bodies are the only genuinely new storage pressure - everything else in the schema is
 * counts and digests - so the 16 MB file bound is what actually binds: 2,000 candidates at roughly
 * 4 KB each is about 8 MB, leaving headroom for the digest-only records.
 */
declare const CARRY_BOUNDS: {
    readonly maxFileBytes: number;
    readonly maxTriageRecords: 20000;
    readonly maxCandidateRecords: 2000;
    readonly maxCandidateSourceBytes: number;
    readonly maxSupportFiles: 16;
};
/**
 * Validate one triage record read back from disk.
 *
 * THE STORE IS UNTRUSTED INPUT, so every field is type-checked and range-checked and anything
 * malformed reads as absent. The verdict check is the load-bearing one: a hand-written record
 * carrying `likely-equivalent` is rejected here as well as being unrepresentable in the type, so
 * the rule holds against a file this process did not write.
 */
declare function readValidTriage(value: unknown): StoredTriage | null;
/** Validate one candidate record read back from disk, on the same untrusted-input terms. */
declare function readValidCandidate(value: unknown): StoredCandidate | null;
/** Validate the stored identity block; anything malformed reads as no identity, which forces full. */
declare function readValidIdentity(value: unknown): CarryIdentity | null;
/** The per-repository digest a prefix-matched cache restore is checked against. */
declare function repositoryDigest(repoKey: string): string;

/**
 * v2 carries the adaptive re-baseline interval as per-repository persistent state. A v1 file has no
 * interval to carry, so it is read as no store at all - reuse degrades to full execution, which is
 * the same safe direction every other unreadable-store path takes.
 *
 * v3 adds the carry-forward half: the run identity the forced-full triggers compare against, the
 * repository digest a prefix-matched cache restore is checked with, and the two model-output record
 * types. A v2 file has no identity to compare, and "no identity" is indeterminate rather than
 * matching, so it reads as no store at all for the same reason v1 does.
 */
declare const REUSE_STORE_SCHEMA = "abloh-marigold-reuse/v3";
/** One recorded verdict, with everything its validity depends on. */
interface StoredVerdict {
    gapId: string;
    status: MutantStatus;
    /** sha256 of the mutated file's bytes when this verdict was produced */
    fileDigest: string;
    /** sha256 over the sorted canonical identities of the tests that reached the span */
    reachDigest: string;
    /** the environment preparation recipe the verdict ran in */
    recipeDigest: string;
    /** commit the verdict was executed at, for the artifact's provenance line */
    executedAtSha: string;
    /** run counter at which this verdict was last EXECUTED (not reused) */
    executedAtRun: number;
}
/** Per-file reach map: which tests reach this file, from the run's own coverage. */
interface StoredReach {
    file: string;
    fileDigest: string;
    /** canonical `<file>::<fullName>` test identities */
    tests: string[];
}
interface ReuseStoreData {
    schema: typeof REUSE_STORE_SCHEMA;
    /**
     * WHICH REPOSITORY THIS STORE BELONGS TO, checked on every read.
     *
     * On CI a store arrives through `actions/cache`, whose `restore-keys` is a PREFIX match: a run can
     * be handed a store another checkout wrote. The key's repository id is part of the cache key, but a
     * prefix match is not an equality check, so the store says who it belongs to and the reader
     * compares - exactly as the baseline-history store compares its own before counting an observation.
     * Empty on a store written before this field existed, which reads as a mismatch and a cold run.
     */
    repositoryDigest: string;
    /** monotone run counter; the re-baseline runs rail counts these */
    runCounter: number;
    /** epoch ms of this store's first ever run; the days rail's anchor before any re-baseline */
    firstRunAtMs: number;
    /**
     * The adaptive re-baseline interval for THIS repository. Per-repo persistent data, not
     * configuration: it is a measured property of how stable this repository's verdicts are.
     */
    rebaseline: RebaselineState;
    lockfileDigest: string;
    configDigest: string;
    /**
     * The run identity the carried records were produced under. `null` until a run writes one, which
     * is a cold store rather than an invalidation - see {@link forcedFullReasons}.
     */
    identity: CarryIdentity | null;
    verdicts: StoredVerdict[];
    reach: StoredReach[];
    /** carried model output: triage verdicts the direction rule permits, and generation proposals */
    triage: StoredTriage[];
    candidates: StoredCandidate[];
}
/** A cold-start store: no history, and the interval sitting on the ruled floor. */
declare function emptyStore(policy: RebaselinePolicy, repositoryDigest?: string): ReuseStoreData;
/**
 * Digest of a file set, order-independent; absent files digest as absent, not as empty.
 *
 * THE BYTES, NOT A DECODING OF THEM. Each file was read with `"utf8"`, which is not a transform a
 * digest may survive: UTF-8 decoding maps every invalid byte to U+FFFD, so a file holding `0x80` and
 * a file holding `0x81` decode to the same replacement character and hash identically. That is not a
 * corner case here - {@link LOCKFILE_CANDIDATES} names `bun.lockb`, which is Bun's BINARY lockfile,
 * so a legacy Bun repository could change its dependency tree and the wholesale digest would not
 * move. A digest that cannot see a lockfile change is the documented StrykerJS-incremental
 * unsoundness with its one guard removed, which is the same defect `wholesalePaths` above exists to
 * close from the other direction.
 *
 * Text files are unaffected: for valid UTF-8 the bytes and the decoding are the same information,
 * so this is strictly more binding than what it replaces.
 */
declare function fileSetDigest(repoDir: string, files: readonly string[]): string;
/**
 * Every path a wholesale candidate could occupy, from the MEASURED PACKAGE upward to the repository
 * root, inclusive of both ends.
 *
 * WHY THIS IS NOT "THE REPOSITORY ROOT". `fileSetDigest(repoDir, LOCKFILE_CANDIDATES)` joined each
 * candidate name straight onto `repoDir`, so on a monorepo it looked only at the root. This
 * repository's own lockfile is `product/pnpm-lock.yaml`: every candidate digested as `<absent>`, the
 * digest was therefore a constant, and a lockfile change could NEVER invalidate a stored verdict.
 * That is the documented StrykerJS-incremental unsoundness with its one guard removed - and it is
 * not hypothetical, because a package's `package.json` and `tsconfig.json` live beside its source,
 * not at the root, so the CONFIG digest was blind in exactly the same way.
 *
 * ABSENT PATHS ARE ENUMERATED, NOT SKIPPED. The candidate name is recorded at every level whether
 * the file is there or not, so ADDING a lockfile - a yarn repo that gains a `package-lock.json`, a
 * package that gains its first `vitest.config.ts` - moves the digest. A set built only from what
 * exists today cannot see an arrival, and an arrival changes the dependency tree exactly as much as
 * an edit does.
 *
 * `subdir` is repository-relative and may be null, empty or `"."` for a single-package repository,
 * which resolves to the root and reproduces the old behaviour on the only shape where it was right.
 */
declare function wholesalePaths(repoDir: string, subdir: string | null | undefined, candidates: readonly string[]): string[];
/** Reach digest: the sorted test identities that could notice a mutation at this location. */
declare function reachDigest(tests: readonly string[]): string;
/**
 * The lockfiles and runner configs whose change invalidates EVERY stored verdict at once.
 * The set is deliberately over-inclusive: a digest over a file the repo does not have costs one
 * "<absent>" marker, while a missed config is the documented unsoundness.
 */
declare const LOCKFILE_CANDIDATES: readonly ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
declare const CONFIG_CANDIDATES: readonly ["package.json", "vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vite.config.ts", "vite.config.js", "jest.config.js", "jest.config.ts", "jest.config.json", "tsconfig.json", "babel.config.js", ".babelrc"];
/**
 * The identity ONE store file belongs to: a repository AND the package that run measured.
 *
 * WHY THE PACKAGE IS IN THE KEY. A composed run dispatches the loop once per measurable package,
 * sequentially (`apps/cli/src/index.ts`), and every one of those dispatches opened the same store -
 * keyed on the repository alone - while writing that package's own path-bearing wholesale digests
 * into it. `beginRun` treats a different wholesale digest as a changed dependency tree and drops
 * EVERY carried record, so an A, B, A sequence over two packages invalidated the store three times:
 * A's proposals died when B measured, B's died when A came back, and the run reported
 * `wholesale-invalidated` to the reader each time. Nothing had changed; the two packages simply have
 * different lockfiles and configs, which is what a monorepo is.
 *
 * One file per repository-and-package therefore partitions everything inside it at once - carried
 * proposals, carried triage, verdicts, the reach map, and the re-baseline cadence, which is a
 * measured property of one package's stability and not of a checkout.
 *
 * THE ROOT KEEPS ITS OLD KEY, and that is the migration. A run measuring the repository root - a
 * single-package repository, or any caller that passes no package - produces exactly the key and
 * the file path it produced before this existed, so those stores stay warm across the upgrade. A
 * monorepo package moves to a file of its own once and starts cold there, which costs one run of
 * what the thrashing was already costing on every run.
 */
declare function storePartitionKey(repoKey: string, subdir?: string | null): string;
/**
 * Why a store opened with nothing in it. Named rather than counted, because "there was no store"
 * and "the store belonged to another repository" are different news for a reader wondering why a
 * rerun cost full price.
 */
declare const STORE_OPEN_REASONS: readonly ["warm", "absent", "unreadable", "oversized", "corrupt", "wrong-schema", "repository-mismatch"];
type StoreOpenReason = (typeof STORE_OPEN_REASONS)[number];
/**
 * WHAT THIS STORE LOST, COUNTED (junction audit CARRY-04, CARRY-05 and CARRY-06, 2026-08-28).
 *
 * The store had three ways of losing records and no way of saying it had:
 *
 *   AT 16 MiB IT ERASED EVERYTHING. `save` re-serialized with `triage: []` and `candidates: []`,
 *   so a store one byte over its bound went from twenty thousand verdicts to none, and the run that
 *   did it reported a successful save. The next push paid full price and read `warm`.
 *
 *   AT THE RECORD CAPS IT DROPPED THE OLDEST silently, which is the right POLICY and the wrong
 *   DISCLOSURE: the reader of a suddenly-expensive run had nothing to read.
 *
 *   ON THE WAY IN IT FILTERED MALFORMED RECORDS one at a time - also right - while the store still
 *   opened `warm`, so a file that had lost half its contents to a partial write was indistinguishable
 *   from one that never held them.
 *
 * All three now count what went and say which gaps went with it. Nothing here changes what is kept;
 * it changes what the run is able to tell you about what is not.
 */
interface ReuseStoreLoss {
    /** Records that failed re-validation when the file was read. */
    corrupt: {
        triage: number;
        candidates: number;
    };
    /** Records dropped to stay inside the record caps, oldest first. */
    evicted: {
        triage: number;
        candidates: number;
    };
    /** Records dropped to stay inside the file's byte bound, oldest first. */
    overBytes: {
        triage: number;
        candidates: number;
    };
    /**
     * The gaps whose carried proposals were dropped, so the next run's cost has names against it.
     * Bounded at 50: this is a disclosure, not a second copy of the store.
     */
    droppedGapIds: string[];
}
/** True when nothing was lost, which is every ordinary run. */
declare function storeLossIsEmpty(loss: ReuseStoreLoss): boolean;
declare class ReuseStore {
    #private;
    private constructor();
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
    static open(storeDir: string, repoKey: string, policy: RebaselinePolicy, subdir?: string | null): ReuseStore;
    /** Why this store opened cold, for the disclosure line; `"warm"` when it did not. */
    get openReason(): StoreOpenReason;
    /** What this store lost reading in, evicting, or writing out. Counts, never records. */
    get loss(): ReuseStoreLoss;
    get data(): ReuseStoreData;
    /** Start a run: bumps the counter, anchors the days rail, and rechecks the whole-store digests. */
    beginRun(current: {
        lockfileDigest: string;
        configDigest: string;
    }, nowMs: number): {
        run: number;
        wholesaleInvalidated: boolean;
    };
    /** The identity the stored records were produced under; `null` on a cold store. */
    get identity(): CarryIdentity | null;
    /**
     * Adopt this run's identity and drop everything the old one produced.
     *
     * Called when {@link forcedFullReasons} named at least one difference. The records are DROPPED
     * rather than left for their keys to miss on: a key miss and a wholesale drop cost the same money,
     * and a store that keeps records it has already decided are invalid is a store waiting for the
     * next reader to be less careful.
     */
    adoptIdentity(identity: CarryIdentity, forced: boolean): void;
    /**
     * The carried triage verdict for this key, or `null`.
     *
     * BYTE-EXACT: the key already names every argument of the function whose answer this is, so a
     * match is a memoized answer to the identical question rather than a guess that the question is
     * close enough. There is no partial match and no nearest neighbour.
     */
    carriedTriage(key: string): StoredTriage | null;
    /**
     * Write a carried triage verdict.
     *
     * The verdict argument is {@link CarriableTriageVerdict}, so a caller holding a `likely-equivalent`
     * cannot reach this method without narrowing first - and narrowing is where the rule fires.
     */
    recordTriage(record: StoredTriage): void;
    /**
     * The carried generation proposal for this key, or `null`.
     *
     * A proposal a previous run's light check REJECTED is not returned. Re-carrying it would pin a
     * permanently failing candidate to the gap and the gap would never be regenerated - a carry that
     * suppresses work rather than saving it.
     */
    carriedCandidate(key: string): StoredCandidate | null;
    recordCandidate(record: StoredCandidate): void;
    /**
     * Mark a proposal this run's light check rejected, so the next run regenerates the gap.
     *
     * A TOMBSTONE, NOT A DELETE. Deleting would let the next run carry the same bytes again the moment
     * a model re-proposed them; the marked record says "these exact bytes were tried and did not
     * survive the light check", and {@link carriedCandidate} refuses to return it. The gap goes back
     * into the generation batch, which is the whole point.
     */
    rejectCandidate(key: string, atRun: number): void;
    /** A verdict is reusable only when every recorded digest matches today's. */
    lookup(input: {
        gapId: string;
        fileDigest: string;
        reachDigest: string;
        recipeDigest: string;
    }): StoredVerdict | null;
    record(verdict: StoredVerdict): void;
    recordReach(reach: StoredReach): void;
    reachFor(file: string, fileDigest: string): StoredReach | null;
    /**
     * Distrust everything and start over. Used when a re-baseline's disagreement reaches tolerance:
     * the rate says the digests are not binding something that moves verdicts, so the entries that
     * happened to agree are no more trustworthy than the ones that did not. The run counter and the
     * days anchor survive - they describe the STORE's history, not the verdicts' validity.
     */
    rebuildFromScratch(): void;
    /** Record the new interval after a completed re-baseline. */
    setRebaselineState(state: RebaselineState): void;
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
    save(): void;
}

/**
 * The periodic full re-baseline - reuse's licence to exist.
 *
 * Reuse keyed on digests is sound for everything the digests SEE. What they cannot see (an
 * undeclared config file, a runner version drifting inside an un-pinned range, plain machine
 * nondeterminism) is why accumulated reused verdicts are periodically checked against a fresh
 * full execution. The re-baseline re-executes every reusable verdict live, compares, and reports
 * the disagreement rate; agreement under tolerance renews the licence, disagreement at or above it
 * drops the store - re-measure, never mask.
 *
 * THE VALUES BELOW ARE KENNETH'S, RULED 2026-08-13, and they are named rather than defaulted.
 * `RULED_REBASELINE_POLICY` is a constant a caller passes deliberately; nothing here falls back to
 * it. `validateRebaselinePolicy` still refuses an under-specified policy, so a caller that forgets
 * a rail gets an error rather than a number this file chose.
 *
 * THE CADENCE IS ADAPTIVE WITH STATIC RAILS, PER REPOSITORY.
 *
 *   floor            every 7 days or every 25 runs, whichever comes first;
 *   clean re-baseline (zero disagreement) stretches the interval by 1.5x;
 *   hard cap         30 days;
 *   breach           a rate at or above tolerance snaps the interval back to the floor;
 *   cold start       at the floor.
 *
 * The interval is per-repository PERSISTENT DATA, carried in that repository's own reuse store, not
 * configuration. Two repositories on the same machine stretch and snap independently, because the
 * thing being measured - how stable this repository's verdicts are across runs - is a property of
 * the repository, not of the installation.
 *
 * ONE CONSEQUENCE OF THE LITERAL RULING, stated rather than smoothed over: the cap is expressed in
 * days, so the runs rail stretches without a ceiling. After four clean re-baselines the days rail
 * has reached 30 and stops moving while the runs rail keeps multiplying, which makes the 30-day cap
 * the binding rail on any repository with a long clean streak. That follows from the ruling; this
 * file does not invent a runs ceiling to tidy it up.
 */

declare const MS_PER_DAY = 86400000;
interface RebaselinePolicy {
    /** floor rail, in runs: the cold-start and post-breach interval */
    floorRuns: number;
    /** floor rail, in days: the cold-start and post-breach interval */
    floorDays: number;
    /** multiplier applied to the interval after a re-baseline with ZERO disagreement */
    stretchFactor: number;
    /** hard ceiling on the stretched days rail */
    capDays: number;
    /**
     * Disagreement fraction at or above which the reuse store is distrusted and rebuilt.
     * The comparison is `rate >= tolerance` - "at or above" is a breach, per the ruling.
     */
    disagreementTolerance: number;
}
/**
 * Kenneth's ruled values, 2026-08-13. A NAMED CONSTANT, NOT A DEFAULT: callers pass it explicitly,
 * and no function in this package reaches for it when an argument is missing.
 */
declare const RULED_REBASELINE_POLICY: RebaselinePolicy;
declare function validateRebaselinePolicy(policy: RebaselinePolicy): void;
/** The per-repository interval state, as it lives in that repository's store. */
interface RebaselineState {
    /** current runs rail; stretches from the floor, snaps back to it on a breach */
    intervalRuns: number;
    /** current days rail; stretches from the floor, capped, snaps back to it on a breach */
    intervalDays: number;
    /** run counter of the last re-baseline; 0 means one has never run */
    lastRunAt: number;
    /** epoch ms of the last re-baseline; 0 means one has never run */
    lastAtMs: number;
}
declare function floorState(policy: RebaselinePolicy): RebaselineState;
/**
 * Is this run a forced full re-baseline? Either rail firing forces it - "whichever comes first".
 *
 * The days rail needs an anchor. Until a re-baseline has ever run there is none, so it is measured
 * from the store's FIRST RUN, stamped when the store first begins one. Without that anchor a
 * repository that runs a handful of times a month would never reach the runs rail and never
 * re-baseline at all, which is the failure the days rail exists to prevent.
 */
declare function rebaselineDue(store: ReuseStoreData, policy: RebaselinePolicy, nowMs: number): boolean;
/** How the two rails read right now, for the artifact's disclosure. */
declare function rebaselineStatus(store: ReuseStoreData, policy: RebaselinePolicy, nowMs: number): {
    intervalRuns: number;
    intervalDays: number;
    runsSince: number;
    daysSince: number | null;
    due: boolean;
};
interface RebaselineDisagreement {
    gapId: string;
    stored: MutantStatus;
    fresh: MutantStatus;
    /**
     * The harmful direction: the store said the suite noticed, the fresh run says it does not.
     * Reuse therefore suppressed a gap that should have been reported - a HIDDEN GAP.
     */
    hiddenGap: boolean;
}
interface RebaselineComparison {
    compared: number;
    agreed: number;
    disagreed: RebaselineDisagreement[];
    /** both directions, in one rate, per the ruling */
    disagreementRate: number;
    /** stored "the suite noticed" whose fresh verdict is "it does not": suppressed gaps */
    hiddenGaps: number;
    /** the other direction: stored "it got away" whose fresh verdict is "noticed" - noise, not a gap */
    staleSurvivors: number;
    tolerance: number;
    /** rate is strictly below tolerance; AT the tolerance is a breach, per the ruling */
    withinTolerance: boolean;
}
/**
 * Compare accumulated stored verdicts against a fresh full execution of the same gaps.
 * The caller supplies the fresh verdicts (it just executed them); this only does the arithmetic
 * and the honesty: every disagreement is itemised, never just counted, and the harmful direction is
 * labeled where a reader cannot miss it.
 */
declare function compareRebaseline(stored: readonly StoredVerdict[], fresh: ReadonlyMap<string, MutantStatus>, policy: RebaselinePolicy): RebaselineComparison;
/**
 * REPLAY BEFORE COUNT - the fix for a counter that could not tell drift from noise.
 *
 * The first gate run over node-cron read 2.5% disagreement against a 1% tolerance and called it a
 * breach. Re-running the three flipped verdicts showed what the counter could not: one was a
 * genuinely unstable mutant (a timeout constant in a scheduler library, killed 4 times in 5) and two
 * survived every repeat, so their single opposing reading was noise. A counter that treats "this
 * mutant answers differently run to run" as "the stored verdict drifted" makes every repository with
 * timing-sensitive tests breach forever and rebuild its store forever, which deletes reuse's whole
 * value. The tolerance was not the problem; the counter was.
 *
 * So a flip is now re-executed before it is counted, under the discipline already frozen in
 * `engine-scenarios/src/replay-proof.ts`: EVERY repetition must reproduce, and nothing is
 * majority-voted. One replay landing on the stored verdict is enough to call the mutant flaky.
 *
 * A flaky flip is EXCLUDED FROM BOTH SIDES OF THE RATE, not quietly counted as agreement. Its stored
 * verdict was never validated, so crediting it as agreement would be a false credit in the direction
 * that flatters reuse - the one direction this file is least willing to be wrong in.
 *
 * WHAT THIS STILL DOES NOT SEE, stated rather than implied: only flips are replayed. A stored verdict
 * that AGREED with the fresh run could be just as unstable and would never be caught, because
 * catching it costs a full replay of every agreement. That is a deliberate cost choice, and it means
 * the rate below is a floor on instability, not a census of it.
 */
declare const REPLAY_REPETITION_RANGE: {
    readonly min: 1;
    readonly max: 10;
};
type FlipVerdict = "reproduced" | "flaky" | "inconclusive";
interface ConfirmedFlip extends RebaselineDisagreement {
    verdict: FlipVerdict;
    /** how many replays ran before the answer was known */
    replayed: number;
    /** the replayed statuses, in order - the evidence, not a summary of it */
    replays: Array<MutantStatus | null>;
}
interface ConfirmedRebaselineComparison {
    compared: number;
    /** compared, minus the flips whose replay could not validate them */
    effectiveCompared: number;
    agreed: number;
    flips: ConfirmedFlip[];
    /** flips that reproduced on every replay: the real disagreements */
    reproduced: number;
    /** flips whose replays disagreed with each other: the mutant is unstable, not the store */
    flaky: number;
    /** flips whose replay could not execute at all: no answer, never guessed */
    inconclusive: number;
    disagreementRate: number;
    /** reproduced flips in the harmful direction */
    hiddenGaps: number;
    staleSurvivors: number;
    tolerance: number;
    withinTolerance: boolean;
}
/**
 * Re-execute every flipped verdict and classify it before it reaches the rate.
 *
 * `replay` returns the live status for one repetition, or null when the repetition could not be
 * executed at all. A null is never read as agreement or disagreement - it makes the flip
 * `inconclusive`, which is excluded and disclosed rather than guessed.
 */
declare function confirmDisagreements(input: {
    comparison: RebaselineComparison;
    policy: RebaselinePolicy;
    replayRepetitions: number;
    replay: (flip: RebaselineDisagreement, repetition: number) => Promise<MutantStatus | null>;
}): Promise<ConfirmedRebaselineComparison>;
interface RebaselineOutcome {
    /** the store was distrusted and rebuilt from scratch */
    storeRebuilt: boolean;
    /** the interval moved outward because the re-baseline was perfectly clean */
    stretched: boolean;
    /** the interval snapped back to the floor because the rate reached the tolerance */
    snapped: boolean;
    /** the days rail is sitting on the hard cap */
    atCap: boolean;
    state: RebaselineState;
}
/**
 * Apply a completed re-baseline to the repository's own interval state.
 *
 *   rate at or above tolerance  → the store is distrusted: every verdict dropped, interval to floor;
 *   zero disagreement           → interval x1.5, days rail capped at 30;
 *   disagreement under tolerance→ interval HOLDS.
 *
 * The middle case is the ruling read literally: stretching is earned by a clean redo and snapping is
 * triggered by a breach. A run that disagreed a little did neither, so it moves nothing - and this
 * file does not invent a third movement Kenneth did not rule.
 */
declare function applyRebaselineOutcome(input: {
    store: ReuseStore;
    /**
     * The CONFIRMED comparison, never the raw one. Taking only this type is deliberate: counting a
     * flip without replaying it is the defect this file just fixed, and a signature that still
     * accepted the unconfirmed shape would leave the old path one call site away.
     */
    comparison: ConfirmedRebaselineComparison;
    policy: RebaselinePolicy;
    nowMs: number;
}): RebaselineOutcome;

/**
 * What the scan decided, and the two facts a reader needs to check it.
 *
 * `route` is entry point first, mutated function last, so `route[0]` is the export a test would call
 * and `route.length` is how many hops away the mutation sits. `contacts` names every real-world
 * contact that decided the rung - `node:fs`, `run:git`, `node:net` - so a rung is auditable against
 * the file rather than taken on trust.
 */
interface RoutePurity {
    rung: RoutePurityRung;
    route: string[];
    contacts: string[];
}
/**
 * The answer when nothing could be measured, and the one a caller uses to say it measured nothing.
 *
 * Exported so a fixture states "no route was read here" by naming it, rather than by spelling out a
 * literal that would silently stop matching if the shape ever grew a field.
 */
declare const UNCLASSIFIED_ROUTE: RoutePurity;
/**
 * The walled modules that are walled because they talk to a NETWORK PEER.
 *
 * Exported because the router downstream has to tell the two halves of the wall apart. A route
 * through `node:http` is out of reach for a reason no test shape can answer - standing policy opens
 * no egress - while a route through `node:vm` is out of reach only for a self-contained unit test,
 * and a harness-level test through a public entry point reaches it. One rung, two remedies, and the
 * router may not guess which is which (`test-shape.ts`).
 */
declare const NETWORK_MODULES: ReadonlySet<string>;
/**
 * Classify the shortest public route from this file's exports to `line`.
 *
 * Everything it needs is the source and the line, so it is callable from a test with a string and
 * has no dependency on a checkout - which is what lets the exemplar shapes from the benchmark be
 * asserted directly.
 */
declare function classifyRoutePurity(input: {
    source: string;
    fileName: string;
    line: number;
}): RoutePurity;

/** The shapes a gutting mutant can be built for, named so a test can assert one by one. */
declare const FUNCTION_SHAPES: readonly ["function-declaration", "function-expression", "arrow-block", "method", "accessor"];
type FunctionShape = (typeof FUNCTION_SHAPES)[number];
interface DetectedFunction {
    /** 1-based inclusive line the function's own text starts on, modifiers included, JSDoc excluded */
    startLine: number;
    /** 1-based inclusive line the body's closing brace sits on */
    endLine: number;
    /** 0-based offset of the first character INSIDE the body braces */
    bodyStart: number;
    /** 0-based offset of the body's closing brace, so `slice(bodyStart, bodyEnd)` is the interior */
    bodyEnd: number;
    shape: FunctionShape;
    /**
     * WHAT THIS FUNCTION IS CALLED, from the parser rather than from its declaration line.
     *
     * WHY IT IS HERE AND NOT IN THE SLICE (the captain's D8 of 2026-09-05). The neighborhood slice
     * derived a name by matching two patterns against the declaration line, which saw
     * `function f(` and `const f =` and nothing else - so every class method and every
     * `export default function` read as unnamed, and a changed function with no name is refused
     * before a single candidate is derived. Two whole census rows (`luxon`, `swagger-ui`) were lost
     * to exactly that, and 24 of run 6's 49 refusals were method calls.
     *
     * The parser already walks every declaration this file admits, so the name is free here and a
     * second derivation anywhere else would be a second answer.
     *
     * NULL WHERE THE DECLARATION GENUINELY CARRIES NONE - `export default function () {}`, a callback
     * argument, an arrow assigned to nothing. A computed member name (`{ [k]() {} }`) is null too:
     * the key is a runtime value, which is the same refusal `x.f()` gets.
     */
    name: string | null;
    /**
     * The class whose body this function is declared in, or null when it is not a class member.
     *
     * It is what lets `this.f()` resolve: the receiver of a `this` call is the enclosing class, which
     * is a STATIC fact even though `x.f()`'s receiver is not.
     */
    owner: string | null;
}
/**
 * Every function in a file, outermost first, nested functions included.
 *
 * A nested function is its own gutting target: removing the outer body removes the inner one too,
 * but the inner one on its own is a smaller, sharper mutant, and the dayjs plugin shape - an arrow
 * that assigns a function expression onto a prototype - has all of its behaviour in the inner one.
 */
declare function detectFunctions(source: string, fileName: string): DetectedFunction[];
/**
 * THE NIGHT'S ROTATION NAME, DERIVED FROM THE DECLARATION LINE AND NOT FROM THE PARSER.
 *
 * IT LOOKS LIKE A WORSE {@link DetectedFunction.name} AND IT IS NOT THE SAME QUESTION. The night's
 * free sweep counts in `functionKey(file, name, startLine)`, and a key that changes reads as a
 * function the night believes it has NEVER SWEPT - so deriving these names the parser's way would
 * re-key every already-swept function on every existing repository and restart its rotation from
 * empty. The rule is that widening detection may ADD functions and must not MOVE an existing one's
 * key (`AGENTS.md`, 2026-08-15), which is why this grammar is frozen where it stands.
 *
 * IT MOVED HERE FROM `slice.ts` ON 2026-09-05, when the neighborhood slice stopped using it. The
 * slice's own naming is the parser's now (the captain's D8), because an unnamed CHANGED function is
 * refused before a single candidate is derived and this grammar reads every class method and every
 * `export default function` as unnamed - two whole census rows were lost to it. Nothing about that
 * ruling reaches the night, whose question is stability rather than reach, so the two derivations
 * are two functions on purpose and neither is the other's fallback.
 *
 * `packages/overnight-lane/src/hunt.ts` is the only caller, and its own comment carries the rest.
 */
declare function functionName(declarationLine: string): string | null;
/**
 * The innermost function containing `line`, or null when the line sits outside every function.
 *
 * Innermost is the one the previous scan-backwards finder returned and the one the callers want: a
 * mutated line inside a nested helper describes the helper, not the function that happens to
 * enclose it. A line between two sibling functions belongs to neither and gets null, which is what
 * makes the caller fall back to a line window rather than present a wrong slice as a function.
 */
declare function enclosingFunction(source: string, fileName: string, line: number): DetectedFunction | null;

/**
 * Reading a test runner's own report.
 *
 * Three facts have to come out of one execution, and an exit code carries only the first:
 *   1. did the run pass,
 *   2. did OUR test actually execute,
 *   3. when it failed, was it an assertion or the machinery.
 *
 * (2) is the one that matters most and the one v1 learned the hard way: a generated test placed
 * where the runner never looks produces a green run, which reads as "the candidate did not
 * distinguish the mutant" when the truth is that nothing ran at all. (3) matters because a
 * candidate that fails on the mutant by failing to COMPILE has not detected anything.
 *
 * When a runner's report cannot be parsed, `executed` is reported as `unknown` rather than guessed
 * in either direction, and the caller establishes execution with the discovery sentinel instead.
 */

interface ParsedTestReport {
    passed: boolean;
    /** null when the report format did not say */
    executed: boolean | null;
    failedAssertion: boolean;
    /** total failing tests, when the report says */
    failed: number | null;
    /**
     * The failing tests the report NAMED, deduplicated, in report order. `null` when the format
     * cannot name them - the exit-code fallback has only a number to offer, and not even that.
     *
     * WHY THE NAMES AND NOT JUST THE COUNT. The exit proof convicts a candidate on the tests it
     * BREAKS, which is the difference between the suite with it present and the same suite without
     * it. A count-only difference answers that question wrongly in the one case that matters: a
     * suite already red for its own reasons where a candidate breaks one test and, by coincidence of
     * ordering or shared state, another pre-existing failure stops failing. The count is unchanged
     * and the candidate walks. The names make the comparison a set difference, which cannot be
     * cancelled out that way.
     *
     * THESE ARE THE CUSTOMER'S OWN WORDS and they never leave the machine: a test identity's name
     * half is free text the customer wrote (see `catch-profile.ts` for where that boundary sits and
     * why). They reach the local sidecar and the hold evidence; every egressing field derived from
     * them carries a COUNT.
     */
    failures: readonly string[] | null;
    format: "json" | "junit" | "tap" | "exit-code";
    /**
     * WHY THERE IS NO REPORT, when there is none (external refusal review, rank 4).
     *
     * `format: "exit-code"` says a verdict was reached from an exit code and nothing else. It does
     * not say WHY, and the four facts abloh held at that moment - which dialect it asked for, which
     * file, what reading it failed on, and whether the run was cut off at its wall - were dropped.
     * Downstream the absence was published as a claim about the customer's tests.
     *
     * Absent whenever a report WAS read. Present on every execution that reached a verdict without
     * one, so a reader is told which of those two they have.
     */
    unavailable?: ReportUnavailable;
}
declare function parseTestReport(input: {
    stdout: string;
    stderr: string;
    exitCode: number;
    /** the test name the candidate declares, matched against the report's test names */
    testName?: string;
    /** the file abloh asked the runner to write, for the diagnostic when no report parses */
    reportPath?: string | null;
    /** whether this execution was stopped at its wall rather than finishing */
    timedOut?: boolean;
    /**
     * THE REPORTING FLAGS ABLOH ITSELF PUT ON THE COMMAND LINE.
     *
     * Handed in rather than guessed, because it is what makes the runner-cannot-report arm of
     * `classifyReportUnavailable` structural: a rejection sentence only reads as "the runner will not
     * write what WE asked for" when the output names one of OUR flags. A caller that passes none can
     * never reach that arm, which is the safe direction.
     */
    askedWith?: readonly string[];
}): ParsedTestReport;
/**
 * Did this failure look like a stage in FRONT of the runner rather than the test failing?
 *
 * Only ever asked of an execution that ran the project's own test command, because only a script
 * can chain `lint && typecheck && build &&` before its runner. When it does, the gate's non-zero
 * exit carries no test report of any kind, and reading it as "the generated test did not pass
 * against the real source" is how a correct test gets marked bad without ever being run - the whole
 * v2 engine scored zero on every such repository until `sealed-test-command.ts` existed.
 *
 * THIS IS A READING, NOT A PROOF, and the hold reasons built on it say "may be" for that reason.
 * `exit-code` format means no JSON and no TAP report appeared, and no assertion-shaped text means
 * nothing in the output looked like a runner reporting a mismatch. A runner that prints neither on
 * a genuine failure would be read the same way; what that costs is one hold reason naming two
 * possibilities instead of one, which is strictly better than the one it replaces naming the wrong
 * one with certainty.
 *
 * THE OUTPUT IS PART OF THE JUDGEMENT, measured 2026-08-16 on `ozgurg/vergihesaplayici.com`
 * (`docs/research/2026-08-16-framework-wrapped-vitest.md`, defect 2). A candidate whose captured
 * output ended
 *
 *     Test Files  1 failed (1)
 *          Tests  1 failed (1)
 *
 * was still read as a gate, because `npm test` runs vitest's default HUMAN reporter: `parseTestReport`
 * finds no machine-readable report, falls back to `exit-code`, and the assertion vocabulary did not
 * fire on what survived the evidence bound. The customer was then told to declare
 * `environment.sealedTestCommand` for a lint stage they do not have, and the true answer - the
 * generated test did not pass against the real source - was hidden. A runner's own end-of-run
 * failure summary is proof that the runner RAN, so nothing in front of it can be what exited
 * non-zero, and that veto is independent of whether the assertion text survived.
 */
declare function looksLikeGateFailure(report: ParsedTestReport, output: string): boolean;

declare function looksLikeAssertion(output: string): boolean;
/**
 * The machinery half of that judgement on its own, for a caller that already knows a test ran and
 * failed and only needs to know whether the failure was the runner or the environment under it.
 * The TAP branch is that caller: a `not ok` point IS the runner reporting a failed test, so the
 * ASSERTION vocabulary has nothing left to establish and only its veto matters.
 */
declare function looksLikeMachinery(output: string): boolean;

/**
 * THE CAPTURED-OUTPUT MASKING BOUNDARY - every runner in this engine passes its spawn through here.
 *
 * Everything a customer's suite prints enters the engine as these two strings and nowhere else: the
 * parsed report, the gate judgement, the hold evidence, the repair prompt and the local sidecar are
 * all downstream of them. Masking as the capture resolves means a printed secret never becomes part
 * of the run's data, rather than being chased out of each field that later holds it.
 *
 * IT USED TO BE ABSENT HERE, AND THAT WAS THE WHOLE DEFECT (ENG-SEC-001, junction audit rank 1).
 * The v1 engine has masked at this exact seam since it shipped (`maskCapturedOutput` in
 * `measure/src/exec.ts`); v2 grew its own execution organ without it, so raw stdout reached
 * the repair prompt and the feedback block - and therefore the model - while the only scrub in the
 * path ran much later, at the CLI's artifact write. A secret that egressed to a model provider had
 * already left before that scrub was reached.
 *
 * `scrubSecrets` returns its input by identity when nothing is registered, which is most runs.
 */
declare function maskCapturedOutput<T extends {
    stdout: string;
    stderr: string;
}>(captured: T): T;
interface PreparedEnvironment {
    /** identity of the preparation recipe: image, install command, test command, service set */
    recipeDigest: string;
    /** true when this run reused an environment prepared earlier rather than building a new one */
    reused: boolean;
    /** what the environment can promise */
    sealed: boolean;
    runnerId: string;
    /** the test runner the repository uses, as the artifact will name it */
    runner: string;
    /**
     * Where this environment came from - see {@link EnvironmentSource}.
     *
     * OPTIONAL, and absent means "this runner does not answer the question" rather than "rebuilt".
     * The local unsealed runner prepares nothing at all, and a disclosure that read its silence as a
     * cold rebuild would put a claim in the artifact nobody measured.
     */
    environmentSource?: EnvironmentSource;
    /** What a borrowed environment inherited. Present only on a borrowed preparation. */
    inherited?: InheritedEnvironment;
    /**
     * THE PROCESS CEILING THIS RUN ENFORCED, and the core count it was derived from.
     *
     * DISCLOSED, NEVER HASHED, for the same reason the runner image id is: the ceiling is a property
     * of the MACHINE, not of the environment under measurement, so folding it into the recipe digest
     * would invalidate every carried verdict the moment a run moved between a four-core runner and a
     * sixteen-core audit box, for a change no test can see.
     *
     * It exists because a flat 512 silently lost tests on any host with enough cores and no error
     * named the cause (`sealedPidsLimit` in `@abloh/core`). A future mystery failure can now read
     * what ceiling its run actually had. Absent on a runner that bounds no processes at all.
     */
    processCeiling?: {
        pidsLimit: number;
        hostCores: number;
    };
}
interface ExecutionRequest {
    /** generated files placed before the run; paths are repo-relative and already admitted */
    files: ReadonlyArray<{
        path: string;
        source: string;
    }>;
    /** survivor patches applied to the source; empty means the real, unmutated source */
    patches: readonly SurvivorGap[];
    /** targeted runs one test file; suite runs everything the project's own command runs */
    mode: "targeted" | "suite";
    /** repo-relative test file for a targeted run */
    testFile?: string;
    /** the test name, so the report parser can prove OUR test executed */
    testName?: string;
    timeoutMs: number;
}
interface ExecutionResult {
    report: ParsedTestReport;
    exitCode: number;
    /**
     * Bounded verbatim output, already masked - see {@link maskCapturedOutput}.
     *
     * IT USED TO SAY "LOCAL ONLY, never egresses" AND THAT WAS NOT TRUE. It is the customer's own
     * words and it stays local as EVIDENCE, but `repair` and `feedback` put it in the next model
     * prompt, so the sentence described an intention rather than a boundary. Masking at the capture is
     * what makes the part that matters - a declared secret - actually stay behind.
     */
    output: string;
    wallMs: number;
    /** set when the request could not be executed at all (patch unresolvable, container refused) */
    error?: string;
    /**
     * SET WHEN ABLOH'S OWN WALL STOPPED THIS EXECUTION, rather than the suite finishing.
     *
     * IT IS NOT AN `error`. `error` says the request could not be executed at all - a patch that would
     * not resolve, a container the daemon refused - and every reader treats it as abloh failing before
     * the suite. A timeout is the opposite shape: the suite really started, really ran, and was cut
     * off part-way with whatever it had printed by then. So the two are separate fields and a reader
     * that means "nothing was measured here" has to ask for both.
     *
     * WHY IT EXISTS AT ALL. Without it a killed run is a red run, and red is what "the tests noticed
     * the mutant" looks like. `unocss/unocss` published `testsFightBack: 1` and `covered: 2` about
     * three executions that were killed at abloh's 600 s ceiling with their suites hung
     * (`data/abloh-sealed-execution-slowness-design-review/report.md` section 1.5). The report's own
     * `unavailable.timedOut` was meant to carry this and could not: it exists only when NO report
     * parsed, and the runners never passed the fact in, so it read `false` on every timeout there has
     * ever been. It is passed in now AND stated here, because a run cut off after its reporter had
     * written something has a parsed report and no `unavailable` to put the fact in.
     */
    timedOut?: true;
    /**
     * The execution ran the project's own test COMMAND rather than its runner directly, and failed in
     * the shape a stage in front of the runner fails in: a non-zero exit carrying no test report.
     *
     * It exists so a hold reason can say which of the two things happened. `lint && typecheck &&
     * vitest --run` is the modern default for a TypeScript library, and a generated test that is
     * correct but formatted differently fails the first stage - reporting that as "the test did not
     * pass against the real source" is a true sentence about a test the runner never saw, and it is
     * what scored the whole engine at zero on every such repository. Absent on every execution whose
     * command invokes the runner directly, which is the normal case now (`sealed-test-command.ts`).
     */
    gateShapedFailure?: boolean;
}
interface SealedRunner {
    readonly id: string;
    readonly sealed: boolean;
    prepare(): Promise<PreparedEnvironment>;
    execute(request: ExecutionRequest): Promise<ExecutionResult>;
    dispose(): Promise<void>;
    /** how many executions this runner has performed - the budget counter's source of truth */
    readonly executions: number;
}

/** Repetitions per side. 2, because 1 has nothing to alternate and disables its own defence. */
declare const DEFAULT_PROOF_REPETITIONS = 2;
interface ExitProofOptions {
    runner: SealedRunner;
    timeoutMs: number;
    suiteTimeoutMs: number;
    /** repetitions per side; {@link DEFAULT_PROOF_REPETITIONS} by default */
    repetitions?: number;
}
declare const SENTINEL_TEST_NAME = "abloh discovery sentinel";
declare function sentinelSource(runner: string): string;
/** Whether the runner demonstrably collects a test at one path, and the sentence saying so. */
interface DiscoveryOutcome {
    confirmed: boolean;
    detail: string;
}
/**
 * ONE candidate's own evidence: the discovery sentinel at its path, then its repetitions.
 *
 * The result carries `suite: null` and no `alsoCloses`, because neither is this candidate's to
 * answer: the suite is the set's, and what else a test closes is the kill matrix's. A caller
 * proving candidates as they qualify fills those in later.
 *
 * `discoveryByPath` is shared across calls so a set of candidates sharing a test path pays for one
 * sentinel, exactly as the single-pass version did.
 */
declare function proveCandidate(input: {
    candidate: Candidate;
    /** the gap this candidate targets; absent means the loop lost it, which is a rejection */
    gap: SurvivorGap | undefined;
    runnerName: string;
    options: ExitProofOptions;
    discoveryByPath?: Map<string, DiscoveryOutcome>;
}): Promise<ExitProofResult>;
/**
 * THE SUITE AS IT ALREADY IS, with nothing of ours in it.
 *
 * WHY THIS EXISTS, measured 2026-08-23 (`data/abloh-prompt5-prb-confirm/report.md`, section 5).
 * The suite check used to read the raw COLOUR of a run carrying the candidates: red meant the
 * candidate broke something. That is only true of a repository whose suite is green to begin with,
 * and the engine never checked. The sealed image has no `git` binary and the package under
 * measurement drives `git` from its own tests, so that package's suite inside the real sealed image
 * with ZERO candidate files present was 92 tests, 66 pass, 26 FAIL - matching the rejection's
 * `suite.failed` exactly, every one of them `spawnSync git ENOENT`. Every candidate was thrown out
 * for it, including the first correct, mutation-distinguishing test that package had ever produced.
 *
 * So the suite gate is a DIFFERENCE, not a colour. A candidate is convicted on the tests that fail
 * with it present and passed without it, and on nothing else. A suite that was already red stays
 * red, says so in the artifact, and convicts nobody for it.
 *
 * SAME SHAPE BOTH SIDES or the difference is not a difference: same runner, same prepared
 * environment, same `mode: "suite"` command and reporter, same timeout. The ONLY difference between
 * this execution and the one it is compared against is whether the candidate's files are on disk.
 */
interface SuiteBaseline {
    /** the repository's own suite passes with nothing generated in it */
    green: boolean;
    /** failing tests it counted; null when the report format did not say */
    failed: number | null;
    /** the failing tests it NAMED; null when the format cannot name them. Never egresses. */
    failures: readonly string[] | null;
    /** set when the baseline could not be executed at all, which makes every delta unattributable */
    error?: string;
    /** bounded verbatim output - LOCAL ONLY */
    report: string;
    /**
     * What THIS call cost: 1 on the call that executed it, 0 on every reuse afterwards.
     *
     * The caller adds this straight into the run's execution counter, so a memoised baseline is
     * counted once no matter how many times it is asked for.
     */
    executions: 0 | 1;
}
/**
 * The run's baseline, measured at most once.
 *
 * ONCE PER RUN AND PER PACKAGE, which is the same thing here: the loop prepares one sealed
 * environment around one package's suite (`loop.ts`), so the runner handed to this probe IS the
 * package. A baseline per candidate would multiply the whole suite's wall time by the size of the
 * winning set for a fact that cannot change between them.
 *
 * LAZY, because the common case never needs it. A suite that stays green with the entire winning
 * set present has already proved nobody broke anything, and asking what it looked like without them
 * would spend a full suite run to learn nothing. The probe is therefore only asked once a run comes
 * back red, and a healthy repository pays exactly what it paid before this existed.
 */
interface SuiteBaselineProbe {
    measure(): Promise<SuiteBaseline>;
}
declare function measureSuiteBaseline(options: Pick<ExitProofOptions, "runner" | "suiteTimeoutMs">): SuiteBaselineProbe;
/** What one suite run changed relative to the baseline, and what that is grounds for. */
interface SuiteDelta {
    /** tests that fail here and did not fail in the baseline; the ONLY grounds for a rejection */
    newFailures: readonly string[];
    basis: SuiteDeltaBasis;
    regressed: boolean;
    /** the hold sentence when `regressed`; counts only, never a test name - see `catch-profile.ts` */
    reason: string | null;
}
/**
 * The judgement itself, on the LIVE parsed reports rather than on stored evidence.
 *
 * `suite.report` is bounded at `MAX_EVIDENCE_CHARS` and on the package that produced this defect it
 * truncated before a single failure line, so a comparison built on the stored text would have found
 * no failures on either side and admitted everything. The parsed report is the input, always.
 */
declare function suiteDelta(baseline: SuiteBaseline, run: Pick<ExecutionResult, "error" | "report">): SuiteDelta;
/**
 * THE SET's evidence: the whole suite, once, with every candidate present that got this far.
 *
 * `resultsById` is updated in place - a suite result belongs to the per-candidate record the
 * repetitions already wrote, and splitting it onto a second object would let the two disagree.
 *
 * WHAT IT COSTS, and why the per-candidate loop is guarded rather than entered whenever the run is
 * red. On a repository whose suite is already red the combined run is ALWAYS red, so an attribution
 * loop keyed off the colour would re-run the whole suite once per candidate on every such run
 * forever. It is keyed off the DELTA instead: the set adds nothing new, nobody is under suspicion,
 * and there is nothing to attribute. Three shapes, three prices:
 *
 *   green with the whole set present          1 execution   (unchanged from before the baseline)
 *   red, and the set adds no new failure      2 executions  (the set, then the baseline)
 *   red, and the set DOES add new failures    2 + N         (only then is each candidate asked alone)
 */
declare function proveSuite(input: {
    /** candidates whose own proof came back `proven`; nothing else may reach a customer */
    proven: readonly Candidate[];
    resultsById: Map<string, ExitProofResult>;
    options: Pick<ExitProofOptions, "runner" | "suiteTimeoutMs">;
    /**
     * The run's baseline. A caller that runs several proofs against one prepared environment passes
     * its own so the suite is measured once for the whole run; one is created for this call when it
     * does not, which is the same number of executions for a single-call caller.
     */
    baseline?: SuiteBaselineProbe;
}): Promise<{
    executions: number;
    baseline: SuiteBaseline | null;
}>;
declare function proveExit(input: {
    candidates: readonly Candidate[];
    gapsByCandidate: ReadonlyMap<string, SurvivorGap>;
    alsoCloses: ReadonlyMap<string, readonly string[]>;
    runnerName: string;
    options: ExitProofOptions;
}): Promise<{
    results: ExitProofResult[];
    executions: number;
}>;

declare const GUTTING_MUTATOR = "WholeBodyGutting";
declare const GUTTING_LABELS: readonly ["return-gutting", "void-gutting", "not-measurable"];
type GuttingLabel = (typeof GUTTING_LABELS)[number];
declare const GUTTING_ROUTES: readonly ["pseudo-tested", "tests-fight-back", "not-measurable", "not-executed"];
type GuttingRoute = (typeof GUTTING_ROUTES)[number];
interface ChangedFunction {
    file: string;
    /** 1-based inclusive body-owning range, from `detectFunctions` over the file */
    startLine: number;
    endLine: number;
    /**
     * The body interior, as offsets into the file the range was found in.
     *
     * CARRIED RATHER THAN RE-FOUND. A line range alone does not identify a body: two functions can
     * share one - `const f = () => { const g = () => { return 1 }; return g }` is two functions
     * starting and ending on the same line - and re-deriving the braces from the range's text picks
     * up whatever else shares the closing line, which in an object literal is the literal's own
     * brace. These offsets come from the parser that found the function, so the bytes the mutant
     * replaces are the bytes the parser called the body.
     */
    bodyStart: number;
    bodyEnd: number;
    /** which of the detected shapes this is, carried for disclosure and tests */
    shape: FunctionShape;
}
interface GuttingPlanEntry {
    file: string;
    startLine: number;
    endLine: number;
    label: GuttingLabel;
    /** present for measurable guttings: the whole-body mutant, in the loop's own gap shape */
    gap?: SurvivorGap;
}
/**
 * Find the changed functions in a file from its changed line ranges. One function appears once
 * however many of its lines changed - the pass is one mutant per FUNCTION, which is where the
 * 10x economy comes from.
 *
 * A changed line inside a nested function names BOTH it and the function enclosing it, because both
 * are real gutting targets and the outer one's body changed too. What a line does not name is a
 * function it merely sits next to: a top-level statement has no body to gut, and the fine pool
 * covers it.
 */
declare function changedFunctions(repoDir: string, file: string, changedLines: readonly number[]): ChangedFunction[];
/** Every function in a file, in the shape the gutting pass takes. */
declare function fileFunctions(repoDir: string, file: string): ChangedFunction[];
/**
 * Build the whole-body mutant for one function, or the honest label when there is nothing to gut.
 *
 * The gutted body keeps the braces and replaces the interior: `{ ... }` becomes `{}` for a void
 * shape and `{ return undefined; }` when the body contains a value-returning `return` or a
 * `throw` - removing a value entirely would often be a TYPE error rather than a behaviour change,
 * and a mutant that does not build measures the compiler, not the suite.
 *
 * The interior is the range the finder recorded, re-checked against the file as it stands now. A
 * function whose braces are no longer where it was found is a function the file changed underneath
 * us, and it is labelled `not-measurable` rather than patched at a guessed offset.
 */
declare function planGutting(repoDir: string, fn: ChangedFunction): GuttingPlanEntry;
interface GuttingResult {
    entry: GuttingPlanEntry;
    route: GuttingRoute;
    executions: number;
}
interface GuttingSummary {
    functionsChanged: number;
    gutted: number;
    pseudoTested: number;
    testsFightBack: number;
    notMeasurable: number;
    notExecuted: number;
    executions: number;
    /**
     * SET WHEN {@link runGuttingPass}'S CALLER STOPPED THE PASS, with how far it got.
     *
     * NULL AND NOT ABSENT ON EVERY OTHER PASS, because "the suite noticed nothing in any of these
     * forty functions" and "abloh gutted eleven of forty and ran out of the job's clock" are two
     * different pieces of news and the routing that reads this summary must not confuse them.
     *
     * WHY THE PASS CAN BE STOPPED AT ALL (captain's ruling, 2026-09-03, census run 5 F2). Each entry
     * here costs ONE WHOLE SUITE EXECUTION, so a change with forty uncovered functions costs forty
     * runs of the repository's suite - and on `sveltejs/svelte` and `prettier/prettier` GitHub
     * cancelled the whole job part-way through, taking a green baseline and a diff-coverage verdict
     * with it. A pass that stops on a function boundary publishes what it measured.
     */
    stoppedEarly: {
        gutted: number;
        total: number;
    } | null;
}
/**
 * Execute the gutting pass: each measurable whole-body mutant runs once against the suite in the
 * sealed environment. Survival routes the function straight to the loop; a kill routes it to the
 * fine pool. `not-executed` is its own route - an unexecuted gutting must not masquerade as either
 * answer - and it now covers the two shapes it always should have: a run stopped at abloh's own wall
 * and a run there is no baseline to compare against.
 *
 * THE ROUTE IS A DIFFERENCE AND NOT A COLOUR (census run 6). This pass read `report.passed` alone,
 * so a suite already red inside the seal for its own reasons - a network test with `--network none`,
 * a browser test in a tree carrying no browser - routed every function it gutted to `tests-fight-back`
 * without a single test having noticed anything. `mutant-difference.ts` carries the whole argument
 * and `exit-proof.ts` carries the arithmetic, which is where this rule has lived since 2026-08-23.
 */
declare function runGuttingPass(input: {
    repoDir: string;
    functions: readonly ChangedFunction[];
    runner: SealedRunner;
    timeoutMs: number;
    /**
     * THE SAME SUITE WITH NO MUTANT IN IT, which is what makes a route a difference.
     *
     * REQUIRED, and a PORT rather than a probe built here, because it is the RUN's fact and not this
     * pass's: one measurement is bought at most once and every pass that needs it reads the same
     * answer. The night hands the same port to every function it sweeps, and a check hands one probe's
     * two shapes to this pass and to the neighbourhood slice.
     *
     * SAME SHAPE OR THE DIFFERENCE IS NOT A DIFFERENCE - it must be THIS runner running the whole
     * suite under the same ceiling, or the two sides are not the same measurement. `measureSuiteBaseline`
     * and pool 2's `measureBugBaselines` both answer it; both are lazy and both charge once.
     */
    suiteBaseline: () => Promise<SuiteBaseline>;
    /**
     * ASKED BEFORE EVERY FUNCTION AFTER THE FIRST MEASURED ONE. Answer false and the pass stops on
     * that boundary and reports how far it got, rather than being killed part-way through the next
     * whole-suite execution.
     *
     * `unitMs` IS THE MEAN OF THE EXECUTIONS THIS PASS HAS ALREADY SPENT, not of the entries it has
     * walked: a function with nothing to gut costs no execution at all, and averaging over it would
     * report a suite run as cheaper than it is. Before the first execution there is no mean, so the
     * first one is never refused here - a caller that wants to refuse the pass outright refuses it
     * before calling.
     *
     * WHOSE DECISION IT IS. This pass knows what one gutted suite run costs and nothing else; whether
     * that fits inside somebody's budget is the run's question. See `apps/cli/src/job-time-budget.ts`.
     */
    admitNextFunction?: (progress: {
        done: number;
        total: number;
        unitMs: number;
    }) => boolean;
}): Promise<{
    results: GuttingResult[];
    summary: GuttingSummary;
}>;
/** The pseudo-tested gaps, in the shape the loop takes - the routing's whole purpose. */
declare function pseudoTestedGaps(results: readonly GuttingResult[]): SurvivorGap[];

declare const SLICE_ROLES: readonly ["caller", "callee"];
type SliceRole = (typeof SLICE_ROLES)[number];
/** One function exactly one hop from a changed function, with the hop's direction. */
interface NeighborhoodFunction {
    /** repo-relative path of the file the neighbor lives in */
    file: string;
    /** 1-based inclusive body-owning range, from the same finder the gutting pass uses */
    startLine: number;
    endLine: number;
    /** the body interior's offsets in the neighbor's file, so the planner guts what was found */
    bodyStart: number;
    bodyEnd: number;
    shape: FunctionShape;
    role: SliceRole;
    /** the changed function whose neighborhood this is, by name */
    ofFunction: string;
    /** the file that changed function lives in, so the ranking and the fold can key on it */
    ofFile: string;
    /** the neighbor's own name, when its declaration carries one */
    name: string | null;
}
/**
 * The closed list of reasons a call target is refused rather than resolved.
 *
 * Every reason names a shape static resolution genuinely cannot bind, not a shortcut:
 *   method-call         - `x.f()` / `this.f()`: the receiver is a runtime value
 *   constructor-call    - `new F()`: the target is a class body, not a guttable function
 *   external-module     - the callee is imported from a bare specifier; it is not in the repository
 *   not-resolved        - no same-file definition and no import edge names it (globals, builtins,
 *                         locals, dynamic values, re-exports)
 *   top-level-call-site - the call site has no enclosing function to gut
 *   unnamed-function    - the changed function's declaration carries no name to search callers for
 */
declare const SLICE_REFUSAL_REASONS: readonly ["method-call", "constructor-call", "external-module", "not-resolved", "top-level-call-site", "unnamed-function"];
type SliceRefusalReason = (typeof SLICE_REFUSAL_REASONS)[number];
interface SliceRefusal {
    reason: SliceRefusalReason;
    /** what could not be resolved, as `file:line name` - stays local, counted by reason in the artifact */
    detail: string;
}
interface Neighborhood {
    neighbors: NeighborhoodFunction[];
    refusals: SliceRefusal[];
}
/**
 * Which files this engine measures, walked from a checkout.
 *
 * The PREDICATE is `@abloh/core`'s `isAuditableSourcePath`, shared with the scope picker so a file
 * list somebody confirms in the dashboard is the file list a run here would produce. The walk stays
 * local because only this side has a filesystem.
 */
declare function sliceSourceFiles(repoDir: string): string[];
/**
 * The name and the owning class of the function whose body-owning range starts on `startLine`.
 *
 * FROM THE PARSER, NOT FROM THE LINE (the captain's D8 of 2026-09-05). This was two regular
 * expressions against the declaration line - `function f(` and `const f =` - so a class method and
 * an `export default function` both read as unnamed, and an unnamed CHANGED function is refused
 * before a single candidate is derived. `luxon` and `swagger-ui` were both lost that way in census
 * run 6, and 24 of that run's 49 refusals were method calls the same blindness produced.
 *
 * Null where the declaration genuinely carries no name, which is still a refusal and still says so.
 */
declare function declarationAt(source: string, file: string, startLine: number): {
    name: string | null;
    owner: string | null;
};
interface CallSite {
    name: string;
    /** 1-based line within the scanned text */
    line: number;
    /** the char before the name is `.`: a member call */
    method: boolean;
    /**
     * The member call's receiver is the literal word `this`.
     *
     * SEPARATED FROM {@link CallSite.method} BECAUSE THE TWO RESOLVE DIFFERENTLY (the captain's D8).
     * `x.f()`'s receiver is a runtime value and stays refused; `this.f()`'s receiver is the class the
     * call site is written in, which the parser names, so it binds.
     */
    thisReceiver: boolean;
    /** the word before the name is `new`: a constructor call */
    constructorCall: boolean;
}
declare function callSites(text: string): CallSite[];
/** One local name an import statement binds, and where it points. */
interface ImportBinding {
    localName: string;
    specifier: string;
    /** the exported name at the target; "default" and "*" cannot be matched to a named function */
    imported: string;
}
declare function importBindings(source: string): ImportBinding[];
/**
 * A relative import specifier resolved to the repo-relative file it names, or null when it does not
 * land on a file in the repository. Extension handling mirrors `importSpecifierFor` in reverse: a
 * cjs project omits the extension, and an esm TypeScript project writes `.js` for a `.ts` on disk.
 */
declare function resolveImport(repoDir: string, fromFile: string, specifier: string): string | null;
/**
 * Direct callers and callees of the changed functions, one static hop out.
 *
 * Callees come from call sites inside each changed function's body, resolved through same-file
 * definitions and import edges. Callers come from scanning the repository's production sources for
 * files that import the changed function (or share its file) and call it inside a function body.
 * Everything that cannot be bound statically lands in `refusals` under a named reason.
 */
declare function deriveNeighborhood(input: {
    repoDir: string;
    changed: readonly ChangedFunction[];
}): Neighborhood;
/**
 * THE CAP IS AN EXPLICIT REQUIRED KNOB WITH NO DEFAULT. The stage-4 FINALIZE block names the slice
 * cap as a number Kenneth sets; until a caller writes it down, construction refuses - the
 * `validateRebaselinePolicy` discipline, applied to the slice's one knob.
 */
interface SlicePolicy {
    /** most gutting mutants the slice may plant in one run; Kenneth sets it (FINALIZE, stage 4) */
    cap: number;
}
declare function validateSlicePolicy(policy: SlicePolicy): void;
/**
 * The cap Kenneth ruled on 2026-08-13, filling the stage-4 FINALIZE blank.
 *
 * NOT A DEFAULT, and the distinction is load-bearing. `planNeighborhoodSlice` still refuses to run
 * without a cap in its policy - there is no fallback inside the planner, so nothing of ours can
 * quietly become the shipped value. This is the value CALLERS write down, recorded once and named
 * for its provenance so a reader can see whose number it is.
 *
 * Seven is also where the literature sits: Google ships changed-lines mutation in review at a
 * median of 7 mutants per change with 89% rated productive (TSE 2021), and the slice is strictly
 * additional non-scoring work riding beside that.
 */
declare const RULED_SLICE_CAP = 7;
/** The ruled policy, in the shape the explicit cap intake expects. */
declare const RULED_SLICE_POLICY: SlicePolicy;
/**
 * Why a discovered neighbor did NOT get a mutant. Every drop is named - the disclosure's
 * planned/dropped arithmetic is recomputed server-side, so an unnamed drop would be a lie by count.
 *
 *   already-in-diff - the neighbor overlaps a changed function; the gutting pass already owns it
 *   duplicate       - the same function was reached twice (both roles, or two changed functions)
 *   not-measurable  - its gutting is invisible in principle (empty body, no body), per planGutting
 *   widely-executed - more than {@link RULED_SLICE_COVERING_FILES} test files execute it. A function
 *                     that many test files reach is not the pseudo-tested shape this looks for, and
 *                     it is the dearest one to ask about
 *   not-measured    - there was no per-test-file map, or its census was incomplete, so which test
 *                     files execute this function CANNOT BE KNOWN and nothing was run
 *   capped          - measurable, but past the execution budget Kenneth's cap sets
 *   job-time-budget - planned, and the customer's own job clock stopped the stage before it was
 *                     answered for. The only way a planted neighbour goes unanswered
 */
declare const SLICE_DROP_REASONS: readonly ["already-in-diff", "duplicate", "not-measurable", "widely-executed", "not-measured", "capped", "job-time-budget"];
type SliceDropReason = (typeof SLICE_DROP_REASONS)[number];
interface SliceDrop {
    fn: NeighborhoodFunction;
    reason: SliceDropReason;
}
interface SlicePlanEntry {
    fn: NeighborhoodFunction;
    label: GuttingLabel;
    gap: SurvivorGap;
    /**
     * THE TEST FILES THAT CAN POSSIBLY NOTICE THIS GUTTING, read off the run's own map.
     *
     * EMPTY IS THE FREE ANSWER AND THE VALUABLE ONE: no green test file executes the body, so no test
     * can notice it going away, the verdict is `unexecuted` and nothing runs. Otherwise these are the
     * only files a targeted execution is worth spending on.
     */
    coveringFiles: readonly string[];
    /** whether this neighbour's changed function is itself unguarded - see {@link SlicePlanInput} */
    foldsIntoUnguarded: boolean;
}
interface SlicePlan {
    planted: SlicePlanEntry[];
    drops: SliceDrop[];
    refusals: SliceRefusal[];
    cap: number;
    /** neighborhood functions the derivation offered the planner */
    candidates: number;
    /** false when no map could be read, which is what makes every outcome `not-measured` */
    mapRead: boolean;
}
/**
 * THE PER-TEST-FILE LINE MAP, AS THE SLICE ASKS IT.
 *
 * `coveringFiles` IS `CoverageIndex`'S OWN METHOD BY EXACTLY ITS CONTRACT (`pool2/covering-tests.ts`
 * and `aster/src/line-map.ts` both answer it), so the slice, pool 2 and the mutant driver read one
 * interface rather than three.
 *
 * ONE THING IS DIFFERENT HERE AND IT IS WHY THE MAP IS PASSED AS A WHOLE-OR-NOTHING OBJECT. `null`
 * from `coveringFiles` means "this map has no measurement for that file", which under a COMPLETE
 * census is the strongest answer there is - nothing in the suite executes it - and under an
 * incomplete one is simply unknown. The caller therefore hands this object over only when the
 * census is complete, and its absence is what produces `not-measured`. See
 * `aster/src/map-coverage.ts`, which refuses on the same field for the same reason.
 */
interface SliceCoverageMap {
    coveringFiles(file: string, startLine: number, endLine: number): readonly string[] | null;
}
/**
 * HOW MANY TEST FILES MAY EXECUTE A NEIGHBOUR BEFORE THE SLICE STOPS ASKING ABOUT IT.
 *
 * K = 3, the captain's D1 of 2026-09-05. A function three test files or fewer execute is the shape
 * a gutting can plausibly go unnoticed in, and asking costs at most three targeted runs. Past that
 * the ask is the dearest in the stage and the answer is nearly always `covered`, so the neighbour is
 * dropped by name (`widely-executed`) rather than paid for.
 */
declare const RULED_SLICE_COVERING_FILES = 3;
interface SlicePlanInput {
    repoDir: string;
    changed: readonly ChangedFunction[];
    neighborhood: Neighborhood;
    policy: SlicePolicy;
    /**
     * The run's own per-test-file map, or null when there is none to read.
     *
     * NULL IS `not-measured` FOR EVERY CANDIDATE, and nothing runs. It is handed over only when the
     * map's census is COMPLETE, because an absence in an incomplete map is unknown rather than
     * uncovered - see {@link SliceCoverageMap}.
     */
    map: SliceCoverageMap | null;
    /** how many test files may execute a neighbour before it is dropped; {@link RULED_SLICE_COVERING_FILES} */
    coveringFileCap: number;
    /**
     * The changed functions the run itself found unguarded - no test executes them, or the gutting
     * pass found nothing noticing them.
     *
     * WHAT IT IS FOR (the captain's D5). When the changed function is already reported as untested, an
     * unexecuted neighbour of it is THE SAME ABSENCE said again: `babel/babel`'s whole slice finding in
     * census run 6 was "this plugin has no tests", which the unguarded row had already said. Those
     * neighbours are folded into that row as "and N functions around it" instead of being named as
     * findings of their own. Keyed `<file>:<name>`, because two files can hold a `parse`.
     */
    unguardedChanged: ReadonlySet<string>;
}
/** The key {@link SlicePlanInput.unguardedChanged} is written in, so both sides spell it once. */
declare function changedFunctionKey(file: string, name: string): string;
/**
 * Decide what the slice will answer for, and how much of it costs a run.
 *
 * THE MAP ANSWERS BEFORE THE BUDGET IS SPENT, which is the whole of the captain's D1. A neighbour no
 * green test file executes is planted and costs nothing; one that too many execute is dropped by
 * name; one nothing can be known about is dropped by name. Only the ones in between are charged.
 *
 * THE CAP COUNTS EXECUTIONS AND NOT CANDIDATES (the captain's D5). A free `unexecuted` answer must
 * not crowd out a paid one, and a neighbour that would cost three targeted runs is charged three.
 * Candidates are walked in reader order and a neighbour that does not fit is dropped `capped` while
 * the walk carries on, so a cheap high-value neighbour behind an expensive one is still reached.
 */
declare function planNeighborhoodSlice(input: SlicePlanInput): SlicePlan;
/**
 * What one planted neighbor's answer means, in plain words on purpose:
 *   unexecuted   - no green test file executes its body, so no test can notice its gutting. A
 *                  COVERAGE fact, decided off the map, and it costs no execution at all
 *   unnoticed    - the test files that DO execute it stayed green with its body gone
 *   covered      - one of those test files fought back; the neighbor is measured by the suite
 *   not-executed - a run itself failed; disclosed, never counted as either answer
 */
declare const SLICE_OUTCOMES: readonly ["unexecuted", "unnoticed", "covered", "not-executed"];
type SliceOutcome = (typeof SLICE_OUTCOMES)[number];
interface SliceResult {
    entry: SlicePlanEntry;
    outcome: SliceOutcome;
    executions: number;
    /**
     * THE RUN THAT MEASURED IT, when this answer was CARRIED rather than taken here (the captain's
     * D6). Null is this run's own measurement.
     *
     * A CARRIED ANSWER IS DISCLOSED AND NEVER PASSED OFF, which is the whole of what makes the ledger
     * honest: the row and the run page say "carried from run X", so a reader can tell a measurement
     * this run took from one it looked up.
     */
    carriedFromRunId?: string;
}
/**
 * One nearby function nothing noticed, named and located.
 *
 * WHY THE LIST EXISTS. Aggregate counts told a reader that two nearby functions were unnoticed and
 * then left them to find out which (Kenneth's display-contract review, 2026-08-13). A finding
 * nobody can locate is not a finding. Every field here is structural - a path, a name, a line, a
 * call relationship - so this stays inside what the block may carry: names and counts, never source
 * text.
 *
 * THE RELATIONSHIP IS INCLUDED BECAUSE THE SLICE ALREADY KNOWS IT. `role` says which direction the
 * hop went and `ofChangedFunction` says from what, so a reader sees why this function is adjacent to
 * their change rather than having to reconstruct it.
 *
 * `verdict` IS WHICH OF THE TWO ABSENCES THIS IS (the captain's D4). "No test runs it" and "no test
 * notices when its body is removed" are different facts about a suite and the surfaces say them in
 * different words, so the producer states which one rather than letting each renderer guess.
 */
interface SliceNeighborhoodGap {
    file: string;
    /** the neighbor's own name, or null when its declaration carries none */
    name: string | null;
    /** 1-based line its body-owning range starts at, so the finding is locatable without a name */
    startLine: number;
    /** `caller` calls the changed function; `callee` is called by it */
    role: SliceRole;
    /** the changed function this one is one hop from */
    ofChangedFunction: string;
    /** `unexecuted` is a coverage fact and `unnoticed` is an oracle one */
    verdict: "unexecuted" | "unnoticed";
    /**
     * The run this answer was CARRIED from, when it was not measured here (the captain's D6).
     *
     * ABSENT IS THIS RUN'S OWN MEASUREMENT. A carried answer that did not say so would present a
     * lookup as a measurement, which is the one thing a ledger must not be allowed to do.
     */
    carriedFromRunId?: string;
}
/** The slice disclosure, mirrored by `sanitizeProposals` server-side (recompute-not-trust). */
interface SliceDisclosure {
    /**
     * Stated in the block itself, as a literal `false`: nothing here reaches the signed catch rate,
     * and nothing here delays the diff verdict. Permanent (Kenneth, 2026-08-14).
     */
    countsTowardScore: false;
    cap: number;
    candidates: number;
    planned: number;
    /** container executions the slice performed - zero on a run whose every answer came off the map */
    executed: number;
    /** nearby functions no green test file executes at all */
    unexecuted: number;
    /** nearby functions the tests execute and whose gutting none of them noticed */
    unnoticed: number;
    covered: number;
    notExecuted: number;
    /** convenience mirror of dropReasons.capped, so a reader sees cap pressure without arithmetic */
    capped: number;
    /**
     * Unexecuted neighbours of a changed function the run already reported as untested.
     *
     * FOLDED INTO THE UNGUARDED ROW AND KEPT OUT OF {@link SliceDisclosure.gaps} (the captain's D5).
     * They are the same absence the unguarded row already states, said a second time, which is what
     * `babel/babel`'s whole slice finding was in census run 6.
     */
    folded: number;
    /** false when no per-test-file map could be read, and then nothing was measured or run */
    mapRead: boolean;
    /**
     * TRUE WHEN THE CUSTOMER'S OWN JOB CLOCK STOPPED THIS STAGE (the captain's D2 of 2026-09-05).
     *
     * A DIFFERENT FACT FROM EVERY OTHER ZERO IN THIS BLOCK. "abloh looked one hop out and found
     * nothing to say" and "abloh ran out of the job's budget before it looked" are two pieces of news,
     * and the sentence with the numbers and the edit in it was printed where the clock ran out. The
     * run still publishes: nothing here scores, so nothing here can hold up a verdict.
     */
    stoppedByJobClock: boolean;
    /**
     * How many of the answers above were CARRIED from an earlier run rather than measured here.
     *
     * DISCLOSED BECAUSE THE CARRY IS ONLY HONEST IF IT IS SAID (the captain's D6). A reader comparing
     * this run's slice against the last one's should be able to see that nothing was re-measured, and
     * a run that carried everything paid nothing - which `executed: 0` beside this says exactly.
     */
    carried: number;
    /** every drop named: reason -> count; sums to candidates - planned */
    dropReasons: Record<string, number>;
    /** every refused call target named: reason -> count */
    unresolved: Record<string, number>;
    /** the findings themselves, one entry per `unexecuted + unnoticed` MINUS the folded ones */
    gaps: SliceNeighborhoodGap[];
}
/**
 * Run the planted slice.
 *
 * NOTHING RUNS FOR A NEIGHBOUR NO TEST FILE EXECUTES, which is the whole of the captain's D1: the
 * map already proved no test can notice it, and a whole sealed suite spent to confirm a certainty is
 * the twenty minutes `unocss/unocss` paid in census run 6.
 *
 * THE FIRST RED FILE IS THE VERDICT. A gutting that any covering file notices is covered, so the
 * loop stops at the first one rather than paying for the rest - and the files are asked in the map's
 * own order so two runs of one commit ask in the same order.
 *
 * `covered` IS A DIFFERENCE AND NOT A COLOUR, and red alone is not it. This loop read the raw colour
 * of one run, so `unocss/unocss`'s artifact said `covered: 2` about two executions that were killed
 * at abloh's own ceiling with their suites hung, and would say the same of a test file that is red
 * inside a seal for reasons of its own. A file convicts only on a test that fails with the body gone
 * and passed with it there. `mutant-difference.ts` carries the argument.
 */
/**
 * THE LEDGER, AS THE SLICE ASKS IT (the captain's D6 of 2026-09-05).
 *
 * A PORT RATHER THAN THE STORE, because a store is a file on a disk and this package is driven from
 * three places that do not all have one - the pull-request seam, the night, and every test in this
 * file. `SliceLedger` in `slice-ledger.ts` is the shipped implementation; anything answering these
 * two methods is a ledger as far as the slice is concerned.
 *
 * ABSENT IS ALWAYS SAFE and is what every run did before this existed: nothing is looked up, nothing
 * is written, and every neighbour that needs an execution gets one.
 */
interface SliceCarryPort {
    /** the answer held for this neighbour, or null - which is the same as never having asked */
    lookup(input: {
        file: string;
        bodyDigest: string;
        coveringTestFileDigests: readonly string[];
    }): {
        outcome: SliceOutcome;
        runId: string;
    } | null;
    /** this run's own answer, for the next one to find */
    record(input: {
        file: string;
        name: string | null;
        bodyDigest: string;
        coveringTestFileDigests: readonly string[];
        outcome: SliceOutcome;
    }): void;
}
declare function runNeighborhoodSlice(input: {
    plan: SlicePlan;
    /** the locality ledger, when this run has one to read. See {@link SliceCarryPort} */
    carry?: SliceCarryPort;
    /** the digest of each planned neighbour's body and of the test files that execute it */
    digestsFor?: (entry: SlicePlanEntry) => {
        bodyDigest: string;
        coveringTestFileDigests: string[];
    } | null;
    /**
     * THE VERDICTS THE MAP ALREADY DECIDED, taken before the loop ran and carried here.
     *
     * They cost no execution, so the caller takes them the moment the plan exists and feeds the
     * unexecuted ones to the proposal arm (the captain's D7). This half only ever ADDS to them: every
     * entry here is one the loop below skips, and both halves compose one disclosure.
     *
     * Omitted is a caller that took none early, which is what a run does when the map answered
     * nothing for free.
     */
    alreadyAnswered?: readonly SliceResult[];
    runner: SealedRunner;
    timeoutMs: number;
    /**
     * THAT SAME TEST FILE RUN WITH NO MUTANT IN IT, which is what makes a verdict a difference.
     *
     * A PORT, like the ledger above, and PER FILE rather than per run: this loop convicts on ONE test
     * file's own report, so the unpatched side has to be that same file. Handing it the whole suite's
     * baseline would set every other file's failures against this neighbour, which is the reason
     * pool 2's probe (`measureBugBaselines`) is keyed per shape, and it is that probe a check hands
     * in - one measurement of a file, however many neighbours are convicted against it.
     *
     * ASKED ONLY WHERE A FILE COMES BACK RED, so a repository whose covering files are green pays
     * nothing for it at all.
     */
    baselineFor: (testFile: string) => Promise<SuiteBaseline>;
    /**
     * ANNOUNCED BEFORE THE FIRST EXECUTION, never after the last (census run 6 F2, 2026-09-04).
     *
     * THIS STAGE USED TO SAY NOTHING UNTIL IT FINISHED: on `unocss` that was twenty minutes of silence
     * in a maintainer's job log, and on `sveltejs/svelte` the job's own `timeout-minutes` fell inside
     * it, so the log ended on the stage before and GitHub's `Terminate orphan process: pid (12972)
     * (docker)` was the only record of what was running.
     *
     * IT STILL EARNS ITS PLACE NOW THAT THE MAP ANSWERS MOST NEIGHBOURS FOR FREE (the captain's D1 of
     * 2026-09-05), because what it announces is exactly the half that is NOT free - the neighbours
     * that cost a targeted execution - and that is the half a cancelled log needs to name.
     *
     * THE WORDING IS THE CALLER'S AND THE MOMENT IS THIS FUNCTION'S. `marigold-dispatch.ts` composes
     * this stage's sentences so they read as one set, and the point of the line is that it lands
     * before the executions rather than beside the call, which only this loop can promise.
     */
    onStart?: (paid: number) => void;
    /**
     * ASKED BEFORE EVERY NEIGHBOUR AFTER THE FIRST EXECUTED ONE, on the gutting pass's own terms.
     *
     * `unitMs` IS THE MEAN OF THE EXECUTIONS THIS SLICE HAS ALREADY SPENT, never of the neighbours it
     * has walked: an `unexecuted` neighbour costs no run at all and averaging over it would report a
     * targeted execution as cheaper than it is.
     */
    admitNextNeighbor?: (progress: {
        done: number;
        total: number;
        unitMs: number;
    }) => boolean;
}): Promise<{
    results: SliceResult[];
    disclosure: SliceDisclosure;
    stoppedEarly: {
        answered: number;
        total: number;
    } | null;
}>;
declare function buildSliceDisclosure(plan: SlicePlan, results: readonly SliceResult[], stoppedByJobClock?: boolean): SliceDisclosure;

/**
 * The two catch rates a v2 run reports, and the composed number that no longer exists.
 *
 * KENNETH'S LOCKED RULING, 2026-08-14. A run reports TWO catch rates, as two separate percentages.
 *
 *   1. THE CLASSIC MUTATION CATCH RATE. The deterministic population, unchanged semantics. This is
 *      the rate the threshold reads and the only rate that gates anything.
 *   2. THE AI-PLANTED CATCH RATE. Pool 2's own population - the witness-proven agent-written bugs
 *      the repository's suite was actually run against. It is displayed honestly beside the classic
 *      rate as its own percentage, and NO threshold is bound to it. AMENDED 2026-08-15: that
 *      percentage is now INTERNAL - the customer surfaces print planted/caught/escaped counts -
 *      and this module's arithmetic is unchanged by that.
 *
 * NO BLENDED NUMBER EXISTS. There is no composed rate, no weighted average and no headline made of
 * the two, anywhere customer-facing and nowhere in this module. The composition this file used to
 * compute (`composeSignedScore`, which summed both populations into one numerator and one
 * denominator) is REMOVED from the shipped path by that ruling, and it is not parked behind a flag:
 * a flag would leave the tree saying one thing while the check run and the dashboard say another,
 * which is the contradiction the ruling was made to end.
 *
 * WHY IT WAS REMOVED, in measurements rather than opinion. On the acceptance cohort the composition
 * raised the customer's grade in 13 of the 14 items where pool 2 measured anything, by a median of
 * 8.3 points and a maximum of 46.7, and lowered it in none; four items crossed the default 70
 * threshold from fail to pass purely because our own generator's bugs entered the denominator. The
 * claim this file previously made - that adding verdicts to one numerator and denominator "cannot"
 * let a small pool-2 component swing the headline - was false in the shipped path: an 8-bug pool
 * against a 3-mutant classic population turned 33.3% into 80.0%, and small classic populations are
 * the normal case on a pull request.
 *
 * ONLY WHAT EXECUTED IS MEASURED, and this rule survives the ruling unchanged for both rates. A
 * proven bug the run never put in front of the suite (the predictor removed its execution, or the
 * suite run itself failed) answered nothing, so it is in neither the numerator nor the denominator
 * of the AI-planted rate.
 *
 * A RATE WITH NOTHING BEHIND IT IS NULL, NEVER ZERO. A pool that produced no measured verdict - the
 * case on every TypeScript-plus-vitest repository measured so far - reports `rate: null`, and the
 * surfaces then show the classic rate alone with one plain sentence. A zero would read as "your
 * tests caught none of them", which is the opposite of what was measured.
 *
 * WHILE THE FLAG IS OFF there is no pool-2 component and no disclosure at all, so a run without the
 * pool scores and renders byte for byte what it did before.
 */

/**
 * The two rates a v2 run discloses, each over its own population.
 *
 * `classic` is THE signed number: the rate the gate reads, computed over the deterministic
 * population exactly as it always was. `pool2` is the AI-planted rate, disclosed beside it as a
 * measurement with no threshold on it.
 *
 * THERE IS NO THIRD FIELD, and its absence is the ruling made structural. A `composed` member here
 * is all it would take for a downstream reader to print a blended headline, so the shape does not
 * offer one - and `scoring.test.ts` pins the key set so it cannot come back by accident.
 */
interface SignedScoreDisclosure {
    /** the classic seeded mutation population - the gated rate */
    classic: ScoreComponent;
    /** witness-proven agent-written bugs the suite was actually run against - measurement only */
    pool2: ScoreComponent;
}

/**
 * Build a component, refusing counts that cannot be verdicts.
 *
 * THE RULES ARE THE CONTRACT'S, THE SENTENCES ARE THIS ENGINE'S. A bad count here is this engine's
 * own bug and throws; the ingest door applies the same two rules to an uploaded block and returns a
 * refusal naming the field instead. What must not differ is the rule, and it does not (audit F12).
 */
declare function scoreComponent(caught: number, measured: number): ScoreComponent;
/**
 * Pool 2's contribution, read off its own disclosure.
 *
 * A killed bug is one the suite caught; a survivor is one it missed. `notExecuted` is neither: the
 * bug was proven but never put to the suite, so it is outside the measurement entirely.
 *
 * GRADUATED BUGS SCORE TOO, and they do so without a line of code here. The overnight lane's
 * graduated members ride the same pool, take the same witness proof and the same live suite
 * execution, and land in the same three routes as a generated bug - so they are already inside
 * `suiteKilled` and `suiteSurvived`. `generated` and `graduated` exist to tell a reader where a bug
 * came from, never what its verdict is worth. Splitting the score by provenance would rebuild the
 * caste Kenneth's ruling removed.
 */
declare function pool2ScoreComponent(agentBugs: AgentBugDisclosure): ScoreComponent;
/**
 * The two rates, side by side, and nothing else.
 *
 * This is deliberately a pair rather than a computation. It replaced `composeSignedScore`, which
 * summed the two populations into a third number; under Kenneth's locked ruling that third number
 * does not exist, so the function that produced it is gone rather than disabled. What remains is
 * the honest shape: each population's own caught-over-measured, each carrying its own rate.
 */
declare function twoRates(input: {
    classic: ScoreComponent;
    pool2: ScoreComponent;
}): SignedScoreDisclosure;

/**
 * WHERE THE PLANTED BUGS WERE, AND WHICH TEST FILES CAUGHT THEM.
 *
 * Two facts a v2 run already measures and used to throw away. The classic mutation population knows
 * the source file every planted bug went into, and the runner report names the tests that killed
 * each one; both were read for the score and then dropped, so the only per-location evidence that
 * survived a run was the list of MISSES. That answers "what did you not catch" and cannot answer
 * "where is my suite thin" or "which of my test files is carrying the run", which are the two
 * questions the run page's last two sections ask.
 *
 * WHAT MAY LEAVE THE CUSTOMER'S MACHINE HERE, and nothing else: PATHS AND COUNTS. A source file
 * path with two integers, and a TEST FILE path with one. No test names, no source text, no line
 * numbers, no per-mutant rows. A canonical test identity is `<file>::<full test name>` and the name
 * half is free text the customer wrote, so it is cut off here rather than at a later boundary - the
 * path is the whole of what the surface renders, and it is all this block carries.
 *
 * WHY THE BLOCK IS V2-ONLY. The v1 engine's privacy tiers decide what travels, and at tier 0 a test
 * identity does not; the v2 engine is tierless and already uploads the witness test bodies it
 * proved, together with the path each one belongs at. So this adds a kind of fact the v2 boundary
 * already carries, and adds nothing at all to the v1 one.
 *
 * ONLY WHAT EXECUTED IS COUNTED. A mutant the run could not build or run answers nothing about a
 * test suite, so it is in neither `planted` nor `missed` - the same rule the two catch rates live
 * under. `planted` is therefore what the suite was actually given a chance to notice in that file.
 */

/** One source file the classic population planted bugs in. */
interface CatchProfileFile {
    file: string;
    /** planted bugs in this file the suite was actually run against */
    planted: number;
    /** how many of those the suite did not notice: survivors plus the ones no test ran at all */
    missed: number;
}
/** One test file that caught at least one planted bug. */
interface CatchProfileTest {
    testFile: string;
    /** planted bugs this file's tests caught; a bug caught by two files counts once for each */
    catches: number;
}
/**
 * Where the planted bugs were and which test files caught them, as the artifact carries it.
 *
 * Both lists are ranked here rather than at render time, and truncated here rather than by a reader:
 * a surface that cut the list itself would be deciding what a signed document says. `filesTruncated`
 * and `catchingTestsTruncated` say how many entries the cap removed, so a reader can tell a short
 * list from a shortened one.
 */
interface CatchProfileDisclosure {
    files: CatchProfileFile[];
    catchingTests: CatchProfileTest[];
    filesTruncated: number;
    catchingTestsTruncated: number;
}
/**
 * The ceiling on each list.
 *
 * A pull request touching a hundred files is a real pull request, and a block carrying a row for
 * every one of them is a block nobody reads and a payload the ingest boundary has to bound anyway.
 * Fifty is far more than either section renders and small enough that the cap is a formality on an
 * ordinary change; when it does bind, the count that says so travels with it.
 */
declare const CATCH_PROFILE_LIMIT = 50;
/**
 * Build the block from the run's own normalized mutants.
 *
 * Pure and total: same mutants in, same block out, no clock and no filesystem. A population with
 * nothing executed in it produces two empty lists rather than no block - the run measured, and
 * "measured nothing here" is a different fact from "did not look", which is the distinction the
 * absence of the whole block carries.
 */
declare function buildCatchProfile(mutants: readonly NormalizedMutant[], 
/**
 * The test FILES that caught a given mutant, when the producer proved it per FILE rather than per
 * test.
 *
 * WHY IT IS A SECOND SOURCE AND NOT A REPLACEMENT. This block's test half asks "which of your test
 * files catches the most bugs", and it has always answered from `killedByTests` - canonical
 * `<file>::<name>` identities reduced to their file half. A producer that proves a kill by running
 * covering test FILES has no name to put after the `::`, and putting the bare path there would be
 * a fabricated identity in a field every reader parses as one. So it answers the question directly
 * instead, and the identity path stays for producers that have identities.
 *
 * IT IS EXACT RATHER THAN APPROXIMATE, which is what makes it admissible: that producer's batches
 * BISECT on failure, so a `killed` verdict is only ever returned from an execution carrying ONE
 * mutant, and the files that execution ran are precisely the files that caught it.
 *
 * Absent means "ask the identities", which is what every existing caller does.
 */
killerFilesOf?: (mutant: NormalizedMutant) => readonly string[] | undefined): CatchProfileDisclosure;

/**
 * The v2 artifact block.
 *
 * NO TIER FIELD, and no field whose meaning depends on one. The engine has one flat mode; a reader
 * of this block never has to ask which capabilities were switched off for this customer.
 *
 * WHAT EGRESSES. Digests, counts, verdicts and named reasons. Never a generated test body, never a
 * source slice, never a runner report. The bodies and the reports live in the local sidecar, and
 * the block binds them by digest so a reader can tell they were not edited afterwards.
 *
 * THE CHECK BODY IS A DIFFERENT SURFACE, and the distinction matters when reading the rule above.
 * Since Kenneth's display-contract review (2026-08-13) a proven test's source is rendered into the
 * pull request itself - v2 is tierless, so no privacy tier keeps it out, and a proposal nobody
 * reads is worth nothing. That is `streaming.ts` rendering from the loop's own candidates. THIS
 * block is unchanged: it still carries the digest and never the body, so what a run attests to is
 * exactly what it attested to before.
 *
 * REUSED VERSUS EXECUTED IS DISCLOSED. A run that reused a prepared image did less work than one
 * that built it, and a reader comparing two runs' wall-clock has to be able to see that. This is
 * the scaffolding stage 2's warm reuse fills in: the counters exist now, and stage 2 adds reused
 * VERDICTS beside the reused image.
 */

/**
 * WHAT A GAP WITH NO TEST IS TOLD TO THE CUSTOMER AS, and why there are two sentences and not one.
 *
 * A gap the loop closed nothing on used to carry exactly one hold reason - "the model returned no
 * test for this gap" - whatever the reason was. That sentence reads as the engine giving up, and on
 * the complete-fix benchmark's run B it was wrong seventeen times out of eighteen.
 *
 * Measured (`data/abloh-unfixed-gaps-investigation/report.md` F3): the mutated logic in that package
 * is private and reachable only through an entry point that runs `execFileSync("git", …)` and then
 * builds a Docker image. The repository's OWN test for it is built on `mkdtempSync`, `writeFileSync`
 * and `execFileSync`, all three refused by generation rules 4 and 5. The model declined eight of
 * them in writing, naming exactly that, and it was right each time. "This logic is private behind a
 * container build, and no self-contained unit test can reach it" is a true and useful thing to tell
 * a customer about their own code; "the model returned no test" is not the same sentence and is not
 * the true one.
 *
 * THE SIGNAL IS DECLARED, NOT INFERRED FROM PROSE. The generation reply carries a `declined` field
 * with a fixed vocabulary ({@link prompt.DECLINE_REASONS}), and this maps it. Reading the model's
 * free-text `note` with a regex was the alternative and is the rule-written-from-assumption that
 * `docs/lessons/verifying-rules.md` exists about; an exact match on a declared value cannot drift.
 *
 * NEITHER IS A SCORE. A structurally untestable gap is still an open gap and still counts against
 * the run exactly as it did. What changes is only what the reader is told about it.
 */
declare const NO_TEST_HOLD_REASON = "the model returned no test for this gap";
/**
 * THE ONE THAT WAS A CLAIM ABOUT THE CUSTOMER'S CODE, and now is not.
 *
 * It read "no self-contained test can reach this code: its only route runs through the filesystem,
 * a process or a container" - which is what `not-self-containable` was taken to mean back when the
 * engine asked for exactly one shape of test. Since the reachability router (/7, 2026-08-26) that
 * decline means something narrower and states it in the prompt itself: the model followed THIS
 * GAP'S TEST SHAPE line and it did not reach. That is a fact about abloh's ask.
 *
 * MEASURED WRONG on cheerio's `_matchUntil` (`data/abloh-model-call-proof/report.md` section 5): a
 * pure DOM traversal helper with no filesystem, no process and no container anywhere on its route,
 * routed to a harness shape it had no way to build, declined in writing - and the customer would
 * have read that their code was unreachable. The prompt had already been narrowed; the sentence
 * downstream had not moved with it.
 *
 * THE SENTENCE IS THE REGISTRY'S, not this file's. `proposals-gap-shape-did-not-reach` in
 * `packages/core/src/refusal.ts` declares it with an owner (`abloh`) and a remedy beside it, which
 * is what the captain's 2026-08-31 message contract asks of any sentence a customer reads and what
 * a bare exported string here could never carry. What crosses the wire is still one string, because
 * a hold reason is one string - {@link shapeDidNotReachSentence} says why and what it would take to
 * carry the rest.
 */
declare const SHAPE_DID_NOT_REACH_HOLD_REASON: string;
declare const CANNOT_DISTINGUISH_HOLD_REASON = "no test can distinguish this change: the mutation is not observable through this code's public entry points";
/**
 * The wall that is not ours.
 *
 * SEPARATE FROM {@link SHAPE_DID_NOT_REACH_HOLD_REASON} BECAUSE THE READER CAN ACT ON ONE AND
 * NOT THE OTHER. That one names abloh's own ask failing to reach, and an ask moves - F3 Option A
 * moved it on 2026-08-21 and turned seventeen refusals into reachable gaps. This one names a route
 * that runs through something live, and no rule this engine could adopt would reach it. Told apart,
 * the first is a backlog item and the second is a fact about the code; told as one sentence, a
 * customer cannot know which they are holding.
 */
declare const LIVE_DEPENDENCY_HOLD_REASON = "no self-contained test can reach this code: its only route runs through something live - a running container or daemon, a network peer, or a real clock";
/**
 * Does this hold reason say the CODE is unreachable rather than that the engine failed?
 *
 * ONE WALL, NOT TWO, since 2026-09-01. It used to answer true for both `not-self-containable` and
 * `structurally-untestable`, on the reasoning that they were two roads onto one rung of
 * `route-purity`'s ladder. That reasoning outlived the sentence it was written for: the first now
 * says abloh's own ask did not reach, which is precisely "the engine failed", so answering true for
 * it would put the question's own wrong answer back one level up - a count claiming the customer's
 * code is unreachable, assembled out of gaps where nothing of the kind was established.
 *
 * NO SHIPPED COUNT MOVES FOR IT. This predicate has no caller outside its own tests today, which is
 * what makes the narrowing safe to take with the sentence rather than to defer. A future caller
 * gets the honest answer rather than the one this comment used to defend.
 */
declare function isStructurallyUntestable(reason: string): boolean;
/**
 * The route-purity split: how many of this run's gaps sit on each rung, and how many closed.
 *
 * WHY A RUN CARRIES THIS AND NOT ONLY THE PER-GAP FIELD. "18 gaps, 0 closed" and "3 gaps, 3 closed"
 * read as a bad run and a good one, and on the complete-fix benchmark they were the same engine
 * meeting two shapes of code. The split is the denominator that makes the numerator mean something:
 * a run whose gaps are all `structurally-out-of-reach` closing none of them is the honest answer,
 * and a reader cannot tell that from a closed count alone
 * (`data/abloh-unfixed-gaps-investigation/report.md` F6).
 *
 * `closed` COUNTS GAPS, matching `gapsClosed` above rather than the proven-candidate count: a
 * candidate that closes four gaps closed four, and the kill matrix's own attribution says which
 * gaps those were, so each is credited to the rung it actually sits on.
 *
 * ROWS WITH NO GAP ARE OMITTED. A rung nothing landed on is not a fact about the run, and a table of
 * five rows where four read zero invites a reader to compare rungs that were never measured.
 *
 * NOT A SCORE AND NOT A THRESHOLD. Nothing gates on this. It is the shape of the work, disclosed
 * beside the result rather than folded into it.
 */
interface RoutePurityDisclosure {
    rows: Array<{
        rung: RoutePurityRung;
        gaps: number;
        closed: number;
    }>;
}
/**
 * One offered (or refused) candidate, in the form that may leave the customer's machine.
 *
 * THE SHAPE IS THE WIRE CONTRACT'S, narrowed by exactly the four fields this producer always
 * writes. `@abloh/core` declares which keys exist, what each may hold and how long it may be; the
 * door accepts `origin`, `file`, `startLine` and `routePurity` as absent because a block written
 * before those fields existed is still a real measurement and must still ingest. This engine is not
 * that producer, so it writes them - and saying so by narrowing keeps one owner of the field names
 * rather than restating seventeen of them here.
 *
 * WHAT EGRESSES IS UNCHANGED: digests, counts, verdicts and named reasons. Never a generated test
 * body, never a source slice, never a runner report.
 */
type ProposalsSummary = ProposalsSummaryWire & Required<Pick<ProposalsSummaryWire, "origin" | "file" | "startLine">>;
/**
 * The last re-baseline's agreement, and the two directions it can disagree in.
 *
 * BOTH DIRECTIONS COUNT IN THE ONE RATE, and the harmful one is still named on its own line. A
 * reused "the suite noticed this" whose fresh verdict is "it does not" means reuse SUPPRESSED a gap
 * the customer should have seen; a reused "it got away" the fresh run kills is noise in the other
 * direction, costing an unnecessary execution and no claim. A single blended rate would let ten of
 * the harmless kind hide one of the harmful kind, so the disclosure refuses to blend them.
 */
interface RebaselineDisclosure {
    atRun: number;
    compared: number;
    /** compared, minus flips the replay could not validate; the rate's real denominator */
    effectiveCompared: number;
    agreed: number;
    disagreementRate: number;
    /** flips that reproduced on every replay: the disagreements the rate is made of */
    reproduced: number;
    /**
     * Flips whose replays disagreed with each other. The MUTANT is unstable, not the stored verdict,
     * so counting these as drift would make any repository with timing-sensitive tests breach forever.
     * Excluded from both sides of the rate and disclosed here instead of being silently dropped.
     */
    flakyFlips: number;
    /** flips whose replay could not execute at all: no answer, never guessed */
    inconclusiveFlips: number;
    /** how many times each flip was replayed before it was counted */
    replayRepetitions: number;
    /** HARMFUL: reused "killed"/"timeout" whose fresh verdict does not notice - a hidden gap */
    hiddenGaps: number;
    /** the other direction: a reused survivor the fresh run kills - noise, no false claim */
    staleSurvivors: number;
    /** the tolerance this rate was judged against */
    tolerance: number;
    /** rate strictly below tolerance; at or above it is a breach */
    withinTolerance: boolean;
    /** the breach distrusted the store and rebuilt it from scratch */
    storeRebuilt: boolean;
}
/**
 * C4 disclosure: how much of this run's evidence was reused, and under what licence.
 *
 * THE DISHONEST VERSION OF THIS FEATURE is a run that says "12 gaps found" without saying that 11 of
 * the 12 verdicts came from a previous push. Carried work never renders as new measurement anywhere,
 * which is why the counts below are split by SOURCE and not merely totalled: a reader has to be able
 * to finish the sentence "how much of this run was fresh".
 */
interface ReuseDisclosure {
    /** verdicts answered from the store */
    reusedVerdicts: number;
    /** verdicts executed live, with each execution reason counted by name */
    executedVerdicts: number;
    executionReasons: Record<string, number>;
    /** true when a lockfile/config change dropped the whole store this run */
    wholesaleInvalidated: boolean;
    /** this run was a forced full re-baseline */
    rebaselineRun: boolean;
    /** the last re-baseline's agreement, when one has ever run */
    lastRebaseline?: RebaselineDisclosure;
    /** this repository's adaptive interval as it stands after this run */
    interval: {
        runs: number;
        days: number;
    };
    /** the carried model output: triage verdicts and generation proposals, when carry-forward ran */
    carry?: CarryDisclosure;
}
/**
 * What this run carried rather than paid for, and what the direction rule made it pay for anyway.
 *
 * `directionRuleReasks` is the one number that must never be dropped for being small. It is the
 * proof that every gap-suppressing verdict on this run was asked LIVE - the whole security argument
 * for carry-forward is that number being equal to the count of matched-but-unusable records, and a
 * disclosure that omits it asks the reader to take the rule on trust.
 */
interface CarryDisclosure {
    /** triage verdicts answered from a previous push */
    carriedTriage: number;
    /** triage verdicts asked live this run */
    freshTriage: number;
    /**
     * Matched records the direction rule refused, and re-asked.
     *
     * Not a cache miss. The record was there and every digest matched; it was re-asked because
     * answering from it could only ever have REMOVED a gap from this report.
     */
    directionRuleReasks: number;
    /** generation proposals carried from a previous push, each still proved fresh this run */
    carriedCandidates: number;
    /** generation proposals written this run */
    freshCandidates: number;
    /**
     * Why this run carried nothing, named. Empty when the store's identity matched today's.
     * A base, policy, prompt, engine, model or recipe change voids every record at once.
     */
    forcedFullReasons: string[];
    /** `"warm"`, or why the store opened with nothing in it */
    storeState: string;
    /**
     * Where the store's KEY came from: `"github-repository-id"`, `"github-repository"`, or
     * `"local-path"`.
     *
     * A cold store has two explanations and `storeState` alone cannot separate them. A repository
     * keyed on a stable GitHub identity that reads `absent` has simply never run before. A repository
     * keyed on its own local path that reads `absent` may have run twenty times from twenty different
     * directories and found none of them - which is the shape the 2026-08-23 benchmark measured, and
     * the reason this field exists. Optional because artifacts written before it carry no such field.
     */
    storeIdentitySource?: string;
    /**
     * WHAT THE STORE LOST, AND WHY (junction audit CARRY-04 to CARRY-06, 2026-08-28).
     *
     * Absent on the ordinary run, which loses nothing. Present when the store dropped carried records
     * on the way in (a partial write, a hand-edited file), at its record caps, or at its file byte
     * bound - three losses that were previously invisible, one of which erased the entire history and
     * still reported a successful save. The counts are what makes the next run's price explicable.
     */
    dropped?: {
        corruptTriage: number;
        corruptCandidates: number;
        evictedTriage: number;
        evictedCandidates: number;
        overBytesTriage: number;
        overBytesCandidates: number;
        /** The gaps whose carried proposals went, bounded at 50. */
        gapIds: string[];
    };
}
/** C1 disclosure: the gutting pass's routing, every function accounted for by name. */
/**
 * The router's split: how many gaps were asked for in each shape, and how many were not asked for.
 *
 * `skipped` IS OUTSIDE THE THREE SHAPES, on purpose. A gap the router refused was given no shape and
 * no instructions, and adding it to one of the three would let a run report as though it had asked.
 * `skippedReasons` is keyed on the policy reason - `browser-dependent`, `open-network` - so a reader
 * can tell a closed tier from an environment posture without reading prose.
 */
interface TestShapeDisclosure {
    unit: number;
    "service-backed": number;
    "harness-level": number;
    /** gaps the router refused before any model call, for a standing-policy reason */
    skipped: number;
    skippedReasons: Record<string, number>;
}
interface GuttingDisclosure {
    functionsChanged: number;
    gutted: number;
    pseudoTested: number;
    testsFightBack: number;
    notMeasurable: number;
    notExecuted: number;
    executions: number;
}
/**
 * The predictor's rolling audit window as the artifact carries it. The threshold and both
 * qualifying facts ride along, so a reader recomputes the licence rather than trusting the label:
 * `licensed` is `sufficient && withinThreshold`, and `withinThreshold` is STRICT - a rate at the
 * threshold is a breach.
 */
interface PredictorWindowDisclosure {
    rounds: number;
    compared: number;
    disagreed: number;
    disagreementRate: number;
    threshold: number;
    withinThreshold: boolean;
    /** the window holds at least the ruled minimum of audited predictions */
    sufficient: boolean;
    licensed: boolean;
}
/** This run's own audit round, before it was folded into the window. */
interface PredictorRoundDisclosure {
    scope: "slice" | "full";
    compared: number;
    agreed: number;
    disagreed: number;
    /** audited executions whose status answered nothing decisive; excluded from `compared` */
    undecided: number;
}
/**
 * C2 disclosure: what the predictor did to this run's execution set, every mutant accounted for.
 *
 * `skippedPredictedKills` is the only count that ever reduces execution, it can be non-zero only in
 * skipping mode, and a skipped mutant is EXCLUDED from the signed score rather than assumed killed
 * - the score covers executed mutants only. The label counts and the routing counts are the same
 * population twice, so the server recomputes one against the other.
 *
 * NOTHING IN THIS BLOCK SCORES, and the block says so itself. `countsTowardScore` is a required
 * literal `false`, the same declaration the neighborhood slice carries and the control plane checks
 * on ingest. The predictor's audit slice is work done to measure the PREDICTOR: the verdicts it
 * produces are already counted once as ordinary verdicts of the population they belong to, and no
 * count here is ever added to a numerator or a denominator. An ACTIVE predictor whose `mode` is
 * `cold` or `shadow` removed no execution at all, so the run's score is the score the same run
 * would have had with no predictor - which is the property the engine's own tests pin.
 */
interface PredictorDisclosure {
    /** permanent, stated rather than assumed: this block is disclosed and never scored */
    countsTowardScore: false;
    mode: "cold" | "shadow" | "skipping";
    predictedKilled: number;
    predictedSurvived: number;
    noHistory: number;
    executed: number;
    auditSliceSize: number;
    skippedPredictedKills: number;
    /** the window the mode was chosen under */
    windowAtPlan: PredictorWindowDisclosure;
    /** the window after this run's round folded in; absent when the run produced no audit evidence */
    windowAfter?: PredictorWindowDisclosure;
    round?: PredictorRoundDisclosure;
    /** true when this run's round put the accumulated window at or above the threshold */
    breached?: boolean;
}
/**
 * G disclosure: the agent bug pool.
 *
 * A MEASURED POPULATION WITH ITS OWN RATE (Kenneth's locked ruling, 2026-08-14). The bugs counted
 * here produce the AI-planted catch rate - `suiteKilled` is caught, `suiteSurvived` is missed - and
 * `disclosure.signedScore.pool2` carries that rate for a reader to recompute. They do NOT enter the
 * classic rate and no threshold is bound to them: the two rates are reported side by side and never
 * summed. This block therefore carries no label saying what it is worth; it carries the verdicts.
 *
 * Survivor entries carry the bug's digest identity and its location only; the bug's own text and
 * its witness test stay on the customer's disk.
 */
interface AgentBugDisclosure {
    /**
     * sha256 of the local evidence sidecar this run wrote beside the artifact
     * (`abloh-proposals-pool2.json`): every bug's description and its witness test body.
     *
     * The commitment lives HERE rather than beside `proofsDigest` because the pool attaches to the
     * block after the loop has already committed to its own sidecar's bytes; a second commitment is
     * how the pool's document gets the same property - uploaded bytes are checked against a promise
     * made before anyone offered to send them.
     *
     * Absent on blocks written before the sidecar existed, and on any pool that measured nothing.
     * Nothing infers content from its presence: what a customer may be shown is decided by joining
     * that sidecar to `survivors` below, which the artifact SIGNED.
     */
    evidenceDigest?: string;
    /**
     * WHAT THE PLANTING CALL WAS AIMED AT (architecture E, 2026-08-15).
     *
     * Present exactly when at least one file's prompt carried an aim block - spans a mechanical
     * mutation pass proved the suite does not notice. `sources` names where each proof came from, so a
     * later night and the next benchmark can compare an aimed run's survivor rate against an unaimed
     * baseline instead of guessing which runs had the block.
     *
     * COUNTS AND SOURCES ONLY. The spans themselves stay local: they are a map of where a customer's
     * suite is weak, and nothing in this block needs them to make the comparison.
     *
     * ABSENT IS THE UNAIMED RUN, which is every run before this existed and every run whose mechanical
     * passes proved nothing - E adds a block or it adds nothing at all.
     */
    aim?: {
        sources: string[];
        files: number;
        spans: number;
        lines: number;
    };
    /**
     * THE COVERAGE CLAIM (Kenneth, 2026-08-15), and the numbers the check run states it from.
     *
     * The denominator is the DETERMINISTIC ENGINE'S OWN site list on this change, cross-checked rather
     * than asked for: a generator invited to enumerate its own denominator can make three sites read
     * as completeness, and the classic list that defuses that is already computed for this run. So the
     * claim is either "attempted all N identified sites" or, when the wall allowance stopped the plan
     * short, "covered N of M" - and the shortfall is disclosed here rather than left to be inferred
     * from a bug count nobody can check.
     *
     * Absent on a block whose pool predates the sizing law, where no such plan existed.
     */
    coverage?: {
        identifiedSites: number;
        coveredSites: number;
        zeroSiteFiles: number;
        filesIdentified: number;
        filesCovered: number;
        attemptsPlanned: number;
        truncated: boolean;
    };
    /**
     * THE SUBSET PLANTED WHERE NO TEST RUNS (Kenneth, 2026-08-30), and the one block on this
     * disclosure that is subtracted rather than added.
     *
     * Since the sizing law started counting the unexecuted changed lines, a pool can hold two
     * populations. A bug on a covered line asks the suite a question it could answer. A bug on a line
     * no test executes cannot be caught by anything, so its survival is not a measurement of the
     * tests - and a guaranteed miss inside a denominator we chose is the same objection that made
     * this pool report counts instead of a percentage. `signedScore.pool2` is therefore computed over
     * the pool MINUS these, and the control plane recomputes it the same way.
     *
     * A SUBSET OF THE COUNTS BELOW, never a separate population: these bugs are in `generated`, in
     * `suiteKilled`/`suiteSurvived` and in `survivors`, so every arithmetic that closed before still
     * closes. What they are excluded from is the rate, and nothing else.
     *
     * ABSENT is the run that planted nothing on an unexecuted line, which is every run before this
     * existed and every change whose lines are all covered.
     */
    untestedLines?: {
        /** bugs located on an unexecuted changed line, whatever route they took */
        planted: number;
        /** of those, the ones the suite caught anyway - proof a covering test the report missed exists */
        suiteKilled: number;
        /** of those, the ones nothing noticed */
        suiteSurvived: number;
    };
    promptVersion: string;
    model: string;
    /** the commit the pool was generated and pinned at */
    generatedAtSha: string;
    /** true when this run replayed the pinned pool rather than generating one */
    pinned: boolean;
    /**
     * WHEN THE WITNESS WAS WRITTEN, which decides how the counts below add up.
     *
     * `at-generation` is the original pipeline: every bug arrived with a witness, every bug was proven
     * before the suite ran, and `witnessProven` therefore covered the killed and the not-executed as
     * well as the survivors. Absent means this - every block written before 2026-08-15.
     *
     * `deferred` is the pipeline since then: planting asks for no witness, the suite runs first, and
     * only a survivor earns a witness. `witnessProven` is then exactly `suiteSurvived`, and the
     * routes close over the pool as unplaceable + notExecuted + suiteKilled + suiteSurvived +
     * witnessRefused. The field exists so the server checks the arithmetic the run actually has
     * rather than inferring the pipeline from a prompt version.
     */
    witnessMode?: "at-generation" | "deferred";
    /** bugs generated for THIS commit and pinned to it */
    generated: number;
    /**
     * Of `generated`, how many came from a stored file version rather than a call made this run.
     *
     * A file whose bytes have not moved since it was last planted replays its bugs; they are measured
     * live exactly like fresh ones, and this says how much of the pool was not paid for again. Absent
     * on every block written before the content key existed, where the answer is zero.
     */
    replayed?: number;
    /**
     * Commit-independent members the overnight lane graduated into this repository's pool. They ran
     * this run like every other bug; they are counted separately so a reader can tell a weak spot
     * carried forward from one found for this change.
     */
    graduated: number;
    generationRefused: number;
    /**
     * WHY THE GENERATOR REFUSED WHAT IT REFUSED (junction audit POOL-02, 2026-08-28).
     *
     * `generationRefused` above is one integer, and the generator has always known more than that: it
     * refuses each entry by a named reason from a closed vocabulary - `unknown-file`, `off-diff`,
     * `unlocatable-text`, `replacement-identical`, `empty-original-text`, `no-witness`. A pool that
     * reported "9 refused" with no cause sent whoever read it to re-run the generator by hand to find
     * out whether the model was writing bugs off the change or naming files that do not exist, which
     * are opposite problems with opposite fixes.
     *
     * COUNTS BY REASON ONLY. The refused entry's own text is model output about a customer's file and
     * stays in the run; the reason is a closed enum and the counts sum to `generationRefused`.
     * Absent on a run that refused nothing, and on every block written before this existed.
     */
    generationRefusedReasons?: Record<string, number>;
    /**
     * WHAT HAPPENED TO EACH FILE THE PLAN NAMED (junction audit POOL-03, 2026-08-28).
     *
     * The pool knew every file's fate and published none of them. A run where every call failed
     * reported the FIRST failure's kind and dropped the rest; a run where one file of nine failed
     * reported nothing at all about that file, and its absence was inferrable only by noticing that
     * `coverage.truncated` was true; a funded file that was not on disk to show the model looked
     * exactly like a file with nothing to plant.
     *
     * One row per planned file, with what it produced. `reason` carries the model failure's closed
     * kind for a failed call and nothing else. Absent on a pinned or replayed run, which generated
     * nothing and has no per-file story to tell.
     */
    files?: Array<{
        file: string;
        outcome: "generated" | "replayed" | "generation-failed" | "source-unreadable" | "unfunded";
        bugs: number;
        refused: number;
        reason?: string;
    }>;
    unplaceable: number;
    witnessProven: number;
    witnessRefused: number;
    /** placement and witness refusals counted by name */
    holdReasons: Record<string, number>;
    suiteKilled: number;
    suiteSurvived: number;
    notExecuted: number;
    executions: number;
    survivors: Array<{
        bugId: string;
        file: string;
        startLine: number;
        witness: "proven";
    }>;
}
/**
 * The kill matrix's per-round replay ceiling, disclosed only in the runs where it actually bound.
 *
 * A truncated matrix is an incomplete measurement, so it is never silent: `execution.matrixSkipped`
 * already counts every replay refused for any reason, and this block says how much of that was the
 * ruled per-round cap rather than the whole run's execution budget running out.
 */
interface MatrixCapDisclosure {
    /** the ceiling in force, in replay executions per round */
    cellsPerRound: number;
    /** rounds in which the cap - not the remaining execution budget - was the binding limit */
    roundsBound: number;
    /** replays those rounds refused */
    cellsRefused: number;
}
/**
 * THE REPOSITORY'S OWN SUITE, MEASURED WITH NOTHING GENERATED IN IT.
 *
 * The suite gate convicts a candidate on the difference it makes, so the run has to know what the
 * suite looked like before it made any. When that measurement says the suite was ALREADY RED, the
 * fact belongs in the signed block rather than only in the engine's head: a reader seeing several
 * `pre-red-unchanged` verdicts is owed the reason, and a repository whose suite cannot pass inside
 * the sealed environment is a real finding about that repository even though it is not a finding
 * about any candidate.
 *
 * COUNTS, NEVER NAMES. A test identity's name half is free text the customer wrote and stops at the
 * machine - the same boundary `catch-profile.ts` states and for the same reason. `named` says how
 * many of the failures the runner's report could identify, which is what tells a reader whether the
 * comparison behind the verdicts was a set difference or a count.
 *
 * ABSENT ON A HEALTHY RUN, and that absence is not a gap: a suite that stayed green with the whole
 * winning set present has proved on its own that nobody broke anything, so the baseline is never
 * measured and there is nothing to disclose. Absent, too, on a run that proved no candidate at all.
 */
interface SuiteBaselineDisclosure {
    /** the suite passes with nothing generated in it */
    green: boolean;
    /** failing tests it counted; null when the report format did not say */
    failed: number | null;
    /** how many of those the report NAMED; null when the format cannot name any */
    named: number | null;
    /**
     * The baseline could not be EXECUTED - the container refused, the command did not start. Present
     * only then, and while it is present no candidate can be convicted on the suite at all, because
     * there is nothing to compare against.
     */
    error?: string;
}
interface ProposalsDisclosure {
    /** absent when the run had no store to reuse from (first run, or reuse not configured) */
    reuse?: ReuseDisclosure;
    /**
     * The package suite with no candidate present. Absent when the run never needed to measure it -
     * see {@link SuiteBaselineDisclosure}.
     */
    suiteBaseline?: SuiteBaselineDisclosure;
    /** absent when no diff was available to derive changed functions from */
    gutting?: GuttingDisclosure;
    /**
     * C2, stage 3: absent when the predictor is off, or had no population to predict.
     *
     * Present on a run whose predictor was merely ACTIVE - the default since 2026-08-21 - and then it
     * reports `mode: "cold"` or `mode: "shadow"` with `skippedPredictedKills: 0`, which is a run
     * whose execution set the predictor ordered and did not shrink.
     */
    predictor?: PredictorDisclosure;
    /** G, stage 3: absent when the agent-bug-pool flag is off, or the pool was unavailable */
    agentBugs?: AgentBugDisclosure;
    /**
     * Where the classic population's bugs were planted, and which test files caught them.
     *
     * Paths and counts, never a test name and never source - see `catch-profile.ts` for what the
     * boundary is and why it sits there. Absent on a block written before this existed, and a reader
     * that finds it absent renders the sections it feeds not at all rather than empty.
     */
    catchProfile?: CatchProfileDisclosure;
    /**
     * The run's TWO catch rates, each over its own population: the classic one the gate reads, and
     * the AI-planted one disclosed beside it. There is no third, composed number - see `scoring.ts`.
     *
     * Absent when the run had no pool-2 component, and then the classic rate stands alone exactly as
     * it always did, with nothing new to disclose.
     */
    signedScore?: SignedScoreDisclosure;
    /**
     * C5 disclosure: the neighborhood slice. Absent when the slice did not run (no cap configured, or
     * no neighborhood). Findings one hop outside the change are reported, never scored: the block
     * declares `countsTowardScore: false`, and it never delays the diff verdict.
     * Planned/dropped/refused arithmetic is recomputed server-side.
     */
    slice?: SliceDisclosure;
    /**
     * F6: this run's gaps split by the purity of the shortest public route to each of them.
     *
     * Absent on a block written before the classifier existed, and on a run that classified nothing.
     * A reader that finds it absent renders no split rather than an empty one.
     */
    routePurity?: RoutePurityDisclosure;
    /**
     * What the reachability router decided for this run's gaps.
     *
     * THE COMPANION TO `routePurity`, AND NOT THE SAME FACT. That one says how far from an export a
     * gap sits, which is a property of the customer's code. This one says what the engine DID about
     * it - which shape of test it asked for, or which standing-policy wall it recorded instead. A run
     * whose gaps are all `structurally-out-of-reach` used to be indistinguishable from a run that
     * asked for nothing; now the split says whether they were routed or refused.
     *
     * Absent on a block written before the router existed, and on a run that routed nothing.
     *
     * LOCAL ONLY FOR NOW. The control plane's ingest allowlist-copies this block field by field
     * (`apps/api/src/draft.ts`), so an undeclared key is dropped rather than refused: the split is in
     * the artifact on the customer's disk and in the run log, and it does not reach a hosted surface
     * until the ingest declares it. That is a deliberate order - a number the server renders is a
     * number the server has to recompute, and the router's counts have no invariant to check them
     * against until the shapes have been measured on real rows.
     */
    testShapes?: TestShapeDisclosure;
    /**
     * The per-round kill-matrix ceiling, present ONLY when it bound at least one round - a ceiling
     * that never truncated anything is not a fact about the run. When present, it says which round
     * count it bound and how many replays it refused, so a reader can tell a matrix cut short by the
     * ruled cap from one cut short by the whole run's execution budget.
     */
    matrixCap?: MatrixCapDisclosure;
    execution: {
        /** identity of the runner that executed model-written code */
        runnerId: string;
        /**
         * Whether that runner is sealed. FALSE travels into the artifact and downstream must not
         * present an unsealed run's candidate as a sealed proof.
         */
        sealed: boolean;
        /** container executions this run performed */
        executed: number;
        /** executions avoided by reusing the prepared environment instead of re-preparing it */
        reusedPreparation: boolean;
        /** replays the kill-matrix ceiling refused; > 0 means the matrix is incomplete */
        matrixSkipped: number;
        /**
         * Where the environment this ran in came from - `borrowed` from the caller's own prepared tree,
         * or `rebuilt` from `abloh.yml` inside the image. See `EnvironmentSource` in `types.ts`.
         *
         * ABSENT rather than defaulted on a runner that does not prepare an environment at all, and on
         * a composed block whose packages did not agree. An absent field says "this run does not
         * answer that"; `rebuilt` would be a claim about an environment nobody described.
         */
        environmentSource?: EnvironmentSource;
        /**
         * What a borrowed environment inherited, whole: the four fields that are hashed into the
         * recipe and the runner image id that is deliberately not.
         *
         * THIS IS THE FIELD THE REPRODUCIBILITY PROMISE RESTS ON. Abloh does not claim to reconstruct
         * a customer's environment from a recipe; it claims to measure inside the one their own CI
         * built, and to record the fingerprint of it so a reader can tell when that stopped being the
         * same environment. Absent on every rebuilt run, which inherited nothing.
         */
        inheritedEnvironment?: InheritedEnvironment;
        /**
         * The process ceiling the sealed container enforced, and the host core count it was scaled
         * from. Disclosed and never hashed, for the reason `PreparedEnvironment.processCeiling` gives.
         *
         * IT IS HERE SO A MYSTERY FAILURE CAN BE READ LATER. A flat 512 lost tests on any host with
         * enough cores while every visible error named something else, and no artifact recorded what
         * ceiling its run had. Absent on a runner that bounds no processes at all.
         */
        processCeiling?: {
            pidsLimit: number;
            hostCores: number;
        };
    };
    budget: {
        rounds: number;
        roundsRun: number;
        modelCalls: number;
        modelCallsUsed: number;
        executionCap: number;
        /** true when the loop stopped because a round closed nothing new, not because it ran out */
        stoppedOnDryRound: boolean;
        /** true when a ceiling ended the loop; the artifact says which one */
        stoppedOnBudget: boolean;
        /**
         * The ceiling that ended it was the WALL CLOCK, rather than a count the run could still have
         * spent.
         *
         * WHY THE DISTINCTION IS WORTH A FIELD. `stoppedOnBudget` is true for the clock, the model-call
         * ceiling, the execution ceiling and the dollar limit alike, so a reader could not tell "the
         * engine was cut off before it could look" from "the engine spent everything it had". Both
         * replicates of the node-cron regression stopped on the clock with executions and model calls
         * unspent - replicate 2 never reached its third round, and every prior run of that
         * configuration closed gaps in round 3 - and nothing in the block said which
         * (`data/abloh-nodecron-aws-regression/report.md` 4.1).
         *
         * The two are not exclusive: a run can exhaust a count and then run out of clock. `executionCap`
         * against `execution.executed`, and `modelCalls` against `modelCallsUsed`, are what say how much
         * was left when the clock took it.
         *
         * OPTIONAL, because a block written before 2026-08-21 does not carry it and an absent field is
         * honest about that where `false` would not be.
         */
        stoppedOnWallClock?: boolean;
    };
}
interface ProposalsCompletedBlock {
    schema: typeof PROPOSALS_BLOCK_SCHEMA;
    state: "completed";
    engineVersion: string;
    /**
     * Gaps the loop was handed: the survivors the mutation engine reported, plus the functions the
     * gutting pass proved pseudo-tested. Both are a demonstration that the suite does not notice
     * this code, and the loop's denominator is every one of them.
     */
    survivorsIn: number;
    /** survivors intake could physically replay */
    gapsAttemptable: number;
    /** gaps closed by a proven candidate */
    gapsClosed: number;
    proven: number;
    rejected: number;
    notAttempted: number;
    summaries: ProposalsSummary[];
    funnel: Record<LoopStage, {
        entered: number;
        advanced: number;
        held: number;
        holdReasons: Record<string, number>;
    }>;
    disclosure: ProposalsDisclosure;
    /**
     * sha256 of the local sidecar bytes carrying bodies, reports and the full ledger.
     *
     * On a COMPOSED block this is a roll-up rather than a file digest - `composedProofsDigest` says
     * exactly what it is a digest of - because a composed run wrote one sidecar per package and no
     * single file carries all of it. Each package's own block keeps the digest of its own file.
     */
    proofsDigest: string;
    /**
     * Present exactly when this run measured MORE THAN ONE package, one entry per touched measurable
     * package in directory order.
     *
     * ABSENT ON A SINGLE-PACKAGE RUN, which is what makes the composition provably inapplicable
     * there: a repository that measures one package writes the identical block it always wrote.
     *
     * When present, the fields above are the stated composition of these entries - counts summed,
     * summaries concatenated, funnel summed stage by stage - and the STRUCTURED disclosures that
     * commit to bytes or to one sealed context (the agent-bug evidence digest, the neighborhood
     * slice, the catch profile, gutting, reuse, the predictor, the matrix cap) are NOT merged up.
     * They live in the entry that measured them, where their digests still mean something; a merged
     * `evidenceDigest` would name a file no run ever wrote.
     */
    packages?: ProposalsPackageBlock[];
}
/**
 * One touched package's own v2 run, inside a composed multi-package block.
 *
 * The loop prepares ONE sealed image around ONE package's suite, so a pull request spanning
 * packages is N sealed contexts, not one. Each keeps its own block exactly as a single-package run
 * would have written it - its own funnel, its own summaries, its own sidecar digest - because those
 * are facts about that package's sealed context and merging them would produce numbers nobody
 * measured.
 */
interface ProposalsPackageBlock {
    /** Repo-relative package directory, matching this run's `packages[]` row. */
    directory: string;
    block: ProposalsBlock;
}
type ProposalsBlock = ProposalsCompletedBlock | {
    schema: typeof PROPOSALS_BLOCK_SCHEMA;
    state: Exclude<ProposalsFeatureState, "completed">;
    reason?: string;
    packages?: ProposalsPackageBlock[];
};
declare const PROPOSALS_VERSION = "0.1.0";
declare function buildProposalsBlock(input: {
    survivorsIn: number;
    gapsAttemptable: number;
    summaries: ProposalsSummary[];
    funnel: Funnel;
    disclosure: ProposalsDisclosure;
    proofsDigest: string;
}): ProposalsCompletedBlock;
/**
 * Fold this run's per-gap rungs into the split the artifact discloses.
 *
 * `closedGapIds` is the gaps a proven candidate actually closed, the kill matrix's `alsoCloses`
 * included, so the `closed` column adds up to the block's own `gapsClosed` rather than to the number
 * of proven candidates. Rows come out purest first and a rung nothing landed on is dropped.
 *
 * Returns undefined when no gap was classified at all, so the disclosure is ABSENT rather than an
 * empty table on a run that measured nothing.
 */
declare function buildRoutePurityDisclosure(gaps: ReadonlyArray<{
    gapId: string;
    rung: RoutePurityRung;
}>, closedGapIds: ReadonlySet<string>): RoutePurityDisclosure | undefined;
/** Fold a completed re-baseline into the shape the artifact discloses. */
declare function buildRebaselineDisclosure(input: {
    atRun: number;
    comparison: ConfirmedRebaselineComparison;
    outcome: RebaselineOutcome;
    replayRepetitions: number;
}): RebaselineDisclosure;
/**
 * The reuse disclosure as a reader sees it in the check's report.
 *
 * The hidden-gap count gets its OWN SENTENCE whenever it is not zero, because a reader scanning a
 * report reads the headline rate and stops. "0.4% disagreement" and "0.4% disagreement, 3 of them
 * hidden gaps" are the same number and different news.
 */
declare function describeReuseDisclosure(disclosure: ReuseDisclosure): string[];
/**
 * The carry half of the reuse disclosure, in a reader's terms.
 *
 * THE RULE IS STATED WHENEVER ANYTHING WAS CARRIED, not only when it fired. A reader looking at a
 * run that cost almost nothing needs to know what made that safe, and the sentence that makes it
 * safe is that no carried record can remove a gap. Printing it only on the runs where it happened to
 * cost something would put the reassurance on the wrong runs.
 *
 * "0 fresh verdicts" and "0 fresh verdicts, 19 carried from an earlier push" are the same number and
 * different news - the same standard the hidden-gap sentence above is held to.
 */
declare function describeCarry(carry: CarryDisclosure | undefined): string[];
/** Digest the sidecar's ACTUAL BYTES, so the block binds what a reader will open. */
declare function sidecarDigest(text: string): string;

/**
 * THE REACHABILITY ROUTER - which SHAPE of test a gap needs, decided before the model is asked.
 *
 * WHAT THIS REPLACES, and it is a change of job rather than of threshold. `route-purity.ts` has
 * classified every gap since it shipped, and its own header says the classification "is not a score
 * and not a priority": it travelled to the artifact and the customer's surfaces and never into the
 * call. `context.ts` said so out loud - "NOT PROMPT MATERIAL ... telling a model that its gap is
 * structurally out of reach invites it to decline rather than to look". That reasoning was right
 * about the thing it was refusing to send. What it left in place was a model asked for exactly one
 * kind of test, a plain self-contained unit test, for every gap in every shape of code, and then
 * declining - correctly, in writing - whenever the code was not that shape.
 *
 * MEASURED, on round 3's own row data (`data/abloh-proposal-loop-autopsy` §5.2): of 31 candidate
 * items processed inside the rows that got an at-bat, TWENTY died because the model said a
 * self-contained test cannot reach this code, and two more were refused at admission for importing
 * the modules that code needs. Eight of 31 were model quality in the ordinary sense. The dominant
 * failure was the shape of the code against the only shape of test the engine would ask for.
 *
 * SO THE SCAN STOPS BEING A BOUNCER AND BECOMES A ROUTER (Kenneth's refinement of 2026-08-26). For
 * each gap it decides which shape reaches the code and instructs the model in that shape:
 *
 *   unit           - a plain self-contained test. Call the export, assert on what it returns. The
 *                    temp-root allowance is part of this shape, not an exception to it.
 *   service-backed - the code talks to a service this repository declares and its own suite already
 *                    drives. The witness drives it the same way, through the same client.
 *   harness-level  - the code has no public route this scan can vouch for, or its route runs
 *                    something a unit test may not run in-process. Drive the PUBLIC entry point and
 *                    let it reach what it reaches.
 *
 * SKIPPING SURVIVES FOR EXACTLY TWO CASES, and both are properties of standing policy rather than
 * of the code: a route that drives a real browser (a closed tier) and a route that opens the
 * network (a sealed execution has no egress by design). Those carry a NAMED reason and cost no model
 * call. Everything else routes, because a gap the engine cannot instruct is a gap the engine has not
 * finished thinking about.
 *
 * A RICHER SHAPE CANNOT LOWER QUALITY, which is why the ruling could be taken on cost alone. Every
 * candidate still has to fail against the mutant and pass against the real source before it is
 * reported, whatever shape it is written in. The worst a wrong route can do is spend a call.
 */

/** The three shapes a witness can take. Ordered least to most machinery. */
declare const TEST_SHAPES: readonly ["unit", "service-backed", "harness-level"];
type TestShape = (typeof TEST_SHAPES)[number];
/**
 * The only two reasons a gap is skipped without asking.
 *
 * BOTH ARE POLICY, NOT CODE. That is what makes them safe to decide here: neither depends on
 * reading the customer's intent, and both would produce a candidate that cannot execute in this
 * run's environment however well it were written.
 */
declare const POLICY_SKIP_REASONS: readonly ["browser-dependent", "open-network"];
type PolicySkipReason = (typeof POLICY_SKIP_REASONS)[number];
type ShapeRouting = {
    kind: "route";
    shape: TestShape;
    /** one sentence naming the fact that decided the shape, for the ledger and the artifact */
    why: string;
    /** the lines the prompt puts in this gap's block, in order */
    instructions: string[];
} | {
    kind: "skip";
    policy: PolicySkipReason;
    /** the sentence the hold carries; owned by `artifact.ts` so a customer reads one wording */
    why: string;
};
/**
 * The shape this gap needs, and the instructions that go with it.
 *
 * EVERY INPUT IS A FACT THE RUN ALREADY HAS. The route purity is read off the file under test, the
 * specifiers are its own imports, the declared services come from the repository's committed policy
 * and the suite's services come from the test files the run watched the runner collect. Nothing here
 * is a guess about the customer's intent, and nothing here reads the model's prose.
 */
declare function routeTestShape(input: {
    purity: RoutePurity;
    /** module specifiers the FILE UNDER TEST imports */
    moduleSpecifiers: readonly string[];
    /** the service names `abloh.yml` declares for this repository - `db`, `cache` */
    declaredServices: readonly string[];
    /** the packages this repository's OWN test files import; see {@link suiteTestPackages} */
    suitePackages: readonly string[];
    /** exported names the file offers, so an instruction can name the entry point */
    exportedNames: readonly string[];
}): ShapeRouting;
/**
 * The sentences a skipped gap carries.
 *
 * OWNED HERE AND NOWHERE ELSE, on the same rule `artifact.ts` follows for the decline reasons: a
 * customer reads one wording for one fact, and a second copy is how two surfaces start describing
 * one thing two ways. They say what was refused, why, and - where there is one - what the customer
 * could do about it.
 */
declare const BROWSER_DRIVEN_SKIP_REASON: string;
declare const OPEN_NETWORK_SKIP_REASON: string;
/** Is this hold reason the router refusing on policy rather than a model declining? */
declare function isPolicySkip(reason: string): boolean;
/**
 * Which packages this repository's OWN test files import.
 *
 * THE EVIDENCE THAT A SERVICE-BACKED WITNESS IS POSSIBLE, and it is a reading rather than a
 * judgement. The old version of this function asked "does the suite drive postgres or redis" and
 * could only answer for seven package names. This one asks what the suite imports and answers for
 * every package there is; whether any of them is a database driver is a question the proof gate
 * settles, not this scan.
 *
 * BEST-EFFORT AND ABSENT-SAFE, like every other read of the customer's tree here. A file that
 * cannot be read is a file that answers nothing, and answering nothing routes gaps to a shape that
 * claims less.
 */
declare function suiteTestPackages(input: {
    readFile: (path: string) => string | null;
    testFilePaths: readonly string[];
    /** the same extractor `context.ts` uses, passed in so one reading of "what does this import" exists */
    specifiersOf: (source: string) => readonly string[];
}): string[];

interface GapContext {
    /** the enclosing function, or a bounded window when no enclosing function could be identified */
    slice: string;
    sliceStartLine: number;
    /** true when `slice` is a real enclosing function rather than a line window */
    enclosingFunction: boolean;
    /** the mutated line, exactly as it appears */
    mutatedLine: string;
    /** specifier a test at `testFile` would use to import the file under test */
    importSpecifier: string;
    /** exported names the file offers, so the prompt does not invent an entry point */
    exportedNames: string[];
    /**
     * One line per export, carrying its SIGNATURE rather than only its name.
     *
     * THE DEFECT THIS CLOSES, and it is the second largest single cause of unfixed gaps measured on
     * the complete-fix benchmark. The unit of context is the ENCLOSING FUNCTION, which is right for
     * the line-level problem this file's header describes and leaves a second one open: when the
     * enclosing function is PRIVATE, the model can see the code but not the route to it, and a bare
     * comma-separated list of names does not tell it what that route accepts or returns.
     *
     * Measured, run A: the mutants sat in a private `mergeCoverage`. The model invented
     * `readRunReports([{ tests: [], mutantCoverage: {…} }, …])` and asserted on
     * `result.mutantCoverage.perTest`; the real declaration, twenty lines below in the same file, is
     * `export function readRunReports(runDir: string): RunReport` and the field is `coverage`. Three
     * gaps, one wrong call shape, and a repair pass that re-asked with the same bare name list and
     * kept the invented call. One correctly shaped 14-line test closes all three.
     *
     * Measured, run B: a 2,422-line file with 26 exports. Given names only, the model picked the one
     * whose name says "for tests" - `__generatedValidationScriptForTests` - and drove eight candidates
     * through it. Its signature, `(input: { roots, digest, count, logicalBytes })`, has nothing to do
     * with the mutated regex and says so on sight. Roughly $0.9 of that run's $1.84 was spent chasing
     * it (`data/abloh-unfixed-gaps-investigation/report.md` F2).
     *
     * BOUNDED BY CONSTRUCTION. A signature ends at the body, so this is one line per export however
     * large the file is - 26 lines for the run-B file, against 2,422 for the whole-file arm that
     * carries the same fact.
     */
    exportSignatures: string[];
    /**
     * Exported `interface` and `type` declarations from the same file, in full.
     *
     * A signature naming `RunReport` is only half the answer: the model still has to know that the
     * field is `coverage` and not `mutantCoverage`. These are the RETURN SHAPES the signatures point
     * at, and they are what turns "call it correctly" into "assert on it correctly".
     */
    exportedTypes: string[];
    /**
     * The default export's name, when the file has one.
     *
     * SEPARATE FROM `exportedNames` because a default export is imported differently - without braces
     * - and a model told only "none detected" guesses a named import that cannot resolve. E3's
     * forensics traced a night of `is not a constructor` failures to exactly that: every gap the
     * engine closed reliably was in a file whose exports the extractor could see, and the file with
     * 21 gaps exported only a default.
     */
    defaultExportName: string | null;
    /**
     * How pure the shortest PUBLIC route from this file's exports to the mutated line is.
     *
     * DERIVED HERE BECAUSE THIS IS WHERE THE GAP IS READ. The file is already open, the route is a
     * fact about the same bytes the slice and the signatures come from, and computing it anywhere else
     * would mean reading the file twice and risking two answers about one gap.
     *
     * NOT PROMPT MATERIAL ON ITS OWN, and that has not changed: a model told its gap is "structurally
     * out of reach" declines rather than looks, which is the whole reason the rung never travelled
     * into the call. What travels now is what the rung ROUTES TO - a test shape and the instructions
     * for writing one - which is the opposite instruction. See {@link GapContext.shape} and
     * `test-shape.ts`.
     */
    routePurity: RoutePurity;
    /**
     * Every module specifier the file under test imports or requires.
     *
     * FOR THE ROUTER, and it is the fact `routePurity` cannot carry. That scan reads Node's OWN
     * built-ins on purpose, so a file that opens a database through `pg` or drives a browser through
     * `playwright` looks, to it, like ordinary code calling ordinary functions. Those two packages are
     * exactly what decides whether a witness is service-backed or is not asked for at all.
     *
     * OPTIONAL FOR THE SAME REASON `shape` IS, one line down.
     */
    moduleSpecifiers?: string[];
    /**
     * WHICH SHAPE OF TEST THIS GAP NEEDS, and the instructions the prompt carries for writing it.
     *
     * THE ROUTER'S ANSWER, computed here for the reason `routePurity` is: this is where the file is
     * open. A `skip` here costs no model call at all - the loop holds the gap with the named reason
     * before generation - and every other answer is a shape with instructions. See `test-shape.ts`.
     *
     * ABSENT MEANS NOTHING ROUTED THIS GAP, and it is the honest value rather than a default shape.
     * `buildGapContext` always fills it, so every production gap has one; a context assembled by hand
     * for a seam that does not care about routing has none, and the prompt then asks exactly what it
     * asked before the router existed. A default of `unit` would put instructions in front of a model
     * that no scan stands behind, which is the kind of claim `docs/lessons/verifying-rules.md` exists
     * about.
     */
    shape?: ShapeRouting;
}
declare function buildGapContext(input: {
    repoDir: string;
    gap: SurvivorGap;
    testFile: string;
    moduleFormat: "cjs" | "esm";
    /** decides the extension the specifier carries; see {@link importSpecifierFor} */
    runner: string;
    /** the service names `abloh.yml` declares; the router needs them. Omitted means none declared. */
    declaredServices?: readonly string[];
    /** the packages this repository's own test files import; see {@link GapContext.shape} */
    suitePackages?: readonly string[];
}): GapContext;
/**
 * One line per exported value, carrying the declaration up to its body.
 *
 * WHAT "UP TO ITS BODY" MEANS PER SHAPE, and each cut is where the information stops:
 *
 *   - `export function f(a: A): B {` cuts at the `{` that opens the body.
 *   - `export const f = (a: A): B => {` cuts at the `=>`, which is the last token that is still
 *     signature; everything after it is implementation.
 *   - `export const X = ` with no callable on the right is a VALUE, and its initialiser is not a
 *     signature, so only `export const X` is carried.
 *   - `export class C extends D {` cuts at the `{`: the heading is the fact a test needs, and the
 *     members below are the enclosing-function slice's job.
 *
 * Newlines inside a multi-line signature are collapsed, because this is a one-line-per-export list
 * and a signature broken over six lines would read as six exports.
 *
 * PARENTHESES ARE BALANCED RATHER THAN MATCHED TO THE FIRST `)`. A parameter that is itself a
 * function - `(items: T[], compare: (a: T, b: T) => number)` - closes twice, and stopping at the
 * first `)` would emit a signature that is not valid TypeScript and cannot be read.
 */
declare function exportSignatures(source: string): string[];
/**
 * Exported `interface` and `type` declarations, in full.
 *
 * An interface is carried to its balanced closing brace; a `type` alias to its terminating `;` or
 * the end of its line, whichever comes first. Both are bounded per declaration, and a declaration
 * over the bound is dropped rather than truncated - half a shape is worse than no shape, because a
 * model reads a truncated field list as the complete one.
 */
declare function exportedTypes(source: string): string[];
/**
 * The name bound to the file's default export, or null when it has none or exports one anonymously.
 *
 * `export default Name;`, `export default function Name`, `export default class Name` and CommonJS's
 * `module.exports = Name` all name something the test can import. An anonymous default - an object
 * literal, an arrow, `export default function () {}` - names nothing, and null says so rather than
 * inventing a binding.
 */
declare function defaultExportName(source: string): string | null;
declare function exportedNames(source: string): string[];
/**
 * The import specifier is computed, never guessed.
 *
 * A cjs project drops the extension and an esm project keeps it; a wrong specifier is a candidate
 * that fails on both sides and reads as "the model wrote a bad test" when it wrote a fine test that
 * could not resolve its subject.
 *
 * THE RUNNER IS PART OF THE ANSWER, not context (Kenneth's ruling of 2026-08-23, option B on the
 * `/6` prompt amendment). The extension a TypeScript source is imported by is decided by what runs
 * it, and generation rule 4 states the same fact in words; this is the half that fixes the
 * mechanism, and the rule is the belt for a repository whose runner this function cannot see.
 * Taken as a required field rather than an optional one so a new call site is a compile error
 * instead of a silent return to the old behaviour.
 */
declare function importSpecifierFor(input: {
    testFile: string;
    targetFile: string;
    moduleFormat: "cjs" | "esm";
    /** the project's runner name, spelled as `detect.ts` spells it: `node-test`, `deno`, `vitest`, … */
    runner: string;
}): string;

interface EndpointConfig {
    /** chat-completions URL, derived from whatever form the environment carries */
    chatUrl: string;
    /**
     * The Responses URL, when this endpoint could have one; null when the environment pinned a
     * chat-completions path explicitly and that routing must be honoured.
     *
     * PREFERRED, BECAUSE SILENCE IS WHAT KILLS A CALL HERE. See the header of
     * {@link client.AzureModelClient} for the measurement. A URL that names `/chat/completions`
     * outright is a deliberate route, so it is left alone and null says so rather than the transport
     * guessing.
     *
     * ABLOH'S OWN GATEWAY NOW HAS A RESPONSES SURFACE, since 2026-08-27 - `/api/v1/model/responses`
     * beside `/api/v1/model/chat/completions`, added for the signed-in local lane because without it a
     * run on Abloh's model passes triage and dies at the endpoint's idle wall on generation. So an
     * environment naming the gateway's BASE (`.../api/v1/model`) resolves both, which is what
     * `abloh login` writes. An environment naming the gateway's chat path outright still resolves only
     * that one, and `apps/action/action.yml` pins exactly that - so the HOSTED lane is on chat until
     * that default is moved to the base, which is a change to CI's own boundary and not this module's.
     */
    responsesUrl: string | null;
    /**
     * The static credential, or the empty string when this endpoint is reached by a MINTED identity.
     *
     * Empty is a valid configuration rather than a missing one: see {@link mintCredential}. Nothing may
     * read this field alone to decide whether a call can be made - `resolveEndpoint` already decided
     * that, and answering it again here is how the hosted path came to generate nothing.
     */
    apiKey: string;
    /**
     * Mint a fresh credential for this request, when the run's identity is short-lived.
     *
     * THE HOSTED PATH'S ONLY CREDENTIAL. The Action writes `MODEL_OIDC_*` and no key, so on a customer
     * run this is set and {@link apiKey} is empty; on a local or BYO run it is the other way round. A
     * caller that has it MUST call it while building the request - the whole reason it exists is that a
     * GitHub OIDC token minted at start-up has expired by the time a model call is made. See
     * `@abloh/core`'s `model-oidc.ts`.
     */
    mintCredential?: () => Promise<string>;
    /** Azure OpenAI presents the key as `api-key`; a gateway may want `Authorization: Bearer` */
    authHeader: "api-key" | "authorization";
    /** host only, safe to log and to record in an artifact */
    host: string;
}
interface EndpointUnavailable {
    available: false;
    /** names the missing variable, never its value */
    reason: string;
}
type EndpointResolution = ({
    available: true;
} & EndpointConfig) | EndpointUnavailable;
declare const ENDPOINT_URL_VAR = "MODEL_ENDPOINT";
declare const ENDPOINT_KEY_VAR = "MODEL_API_KEY";
declare const ENDPOINT_AUTH_VAR = "MODEL_AUTH";
/**
 * ONE KEY IS THE WHOLE COMMON CASE (Kenneth, 2026-08-24). Both variables and the auth style are
 * resolved by `@abloh/core`'s `resolveModelAccess`, which is also what triage's registry reads, so
 * a local run cannot have the model half enabled for one step and disabled for the other. With only
 * `MODEL_API_KEY` set it hands back OpenAI's chat-completions URL and a bearer header; anything the
 * environment names explicitly is passed through untouched.
 *
 * AND A KEY IS NOT THE ONLY CREDENTIAL. A hosted run carries no key at all - the Action mints a
 * short-lived identity per call against `MODEL_OIDC_*` and the gateway holds the provider key server
 * side - so this resolves AVAILABLE with an empty `apiKey` and a `mintCredential` beside it. Reading
 * the key alone was the whole of defect 9: every hosted v2 run measured and generated nothing.
 */
declare function resolveEndpoint(env?: NodeJS.ProcessEnv): EndpointResolution;
/**
 * An Azure AI Foundry PROJECT url (`/api/projects/<name>`) is a management path, not an inference
 * one, and calling it produces a 404 with no explanation of what was wrong. It is the string the
 * portal shows, so it is accepted and rewritten. A base that already carries an inference path
 * keeps it: rebuilding from the host would discard the caller's routing silently.
 */
declare function resolveChatUrl(configured: string): string;
/**
 * The Responses sibling of the same base, or null when there cannot honestly be one.
 *
 * Null in exactly one case: the environment named `/chat/completions` itself. That is a routing
 * decision somebody made on purpose - a single-route gateway, a proxy, a pinned deployment path -
 * and rewriting it to `/responses` would send the call somewhere nobody configured. Every other
 * form gets the sibling built the same way {@link resolveChatUrl} builds its own, and the transport
 * finds out whether it is really there by asking once (a 404 demotes it for that client's life).
 */
declare function resolveResponsesUrl(configured: string): string | null;
/** Sibling of the chat URL: the deployment/model catalog, used to verify a pin before it ships. */
declare function resolveModelsUrl(chatUrl: string): string;

/**
 * Engine v2 model policy.
 *
 * ONE FAMILY, ONE ENDPOINT. Every model call this engine makes - triage, candidate generation, and
 * anything a later stage adds - goes to Kenneth's Azure endpoint and names a model from the GPT
 * sol / terra / luna family. No other provider ships inside the engine (design doc, 2026-08-13).
 * Effort is unconstrained: any level the endpoint accepts is allowed, and per-task pins are chosen
 * by benchmark within the family.
 *
 * NOT A TIER. Per-task pinned identities are benchmark-derived and stay; they are not a tier ladder
 * and no capability in this package is gated on one.
 *
 * THE CREDENTIAL IS NEVER HERE. The endpoint URL and key come from the environment. A key in a
 * committed file is a shared key.
 */
/** The complete allowed model family. A name outside it is refused, not silently substituted. */
declare const ALLOWED_MODEL_FAMILY: readonly ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
type AllowedModel = (typeof ALLOWED_MODEL_FAMILY)[number];
/**
 * The endpoint's own answer to "which efforts do you accept", quoted verbatim.
 *
 * PROBED, NOT READ OFF A DOC. `POST /openai/v1/chat/completions` with `reasoning_effort: "minimal"`
 * and again with `"ultra"` both come back HTTP 400 carrying this sentence, and
 * `reasoning_effort: "none"` comes back 200 with `reasoning_tokens: 0`
 * (`data/abloh-cost-mechanics/report.md` section 3, 2026-08-15, agent-infra-codex).
 *
 * It is kept as the endpoint's SENTENCE rather than as a second hand-written list because a second
 * list is a second thing to get wrong: `MODEL_EFFORTS` below is checked against this string by
 * `model-efforts.test.ts`, so the ladder can only be corrected by correcting what the endpoint said.
 */
declare const ENDPOINT_EFFORT_CATALOG_MESSAGE = "Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.";
/** The quoted names in the endpoint's catalog sentence, in the order it lists them. */
declare function effortsFromCatalogMessage(message: string): string[];
/**
 * The effort ladder, cheapest first - and it is the endpoint's ladder, not ours.
 *
 * CORRECTED 2026-08-15, wrong in both directions before that. It listed `ultra`, which this endpoint
 * refuses with an HTTP 400, and omitted `none`, which it accepts and which is the cheapest working
 * configuration on this task by a factor of 12 (690 generated tokens for 5 bugs against `high`'s
 * 8,901 for 8). A ladder carrying a level the endpoint refuses is a retry that cannot succeed, and a
 * ladder missing its bottom rung is a floor `effortBelow` invents.
 */
declare const MODEL_EFFORTS: readonly ["none", "low", "medium", "high", "xhigh"];
type ModelEffort = (typeof MODEL_EFFORTS)[number];
/**
 * One step down the effort ladder, or null at the bottom.
 *
 * Exists so a retry can be a genuinely DIFFERENT call without any module writing down an effort
 * name that a later pin change would turn into a same-shape retry. `generation.ts` states the rule
 * this serves; the ladder itself lives here, beside the list it walks.
 */
declare function effortBelow(effort: ModelEffort): ModelEffort | null;
/**
 * Every model-backed task this engine pins an identity for.
 *
 * `pool2` IS IN THE LIST BECAUSE IT IS PLANTED BY TWO LANES. Triage and generation are asked for by
 * one caller each; the agent bug pool is asked for by the pull-request seam AND by the night, and
 * each of them used to write the same four-field literal down at its own call site. Nothing but a
 * source-reading test connected the two, so the two surfaces could plant with different models while
 * every report implied one governed population (audit F35). The pins are the catalogue's now; a
 * caller still passes one explicitly, which is the rule that matters - no engine module defaults it.
 */
type MarigoldTask = "triage" | "generation" | "pool2";
interface TaskModelPin {
    model: AllowedModel;
    effort: ModelEffort;
    /**
     * Generated-token ceiling FOR ONE GAP. A batched call scales it - see {@link batchCompletionCeiling}.
     *
     * A truncated reply truncates identically on retry, so it is never retried; it is simply lost
     * output that was paid for.
     */
    maxCompletionTokens: number;
    /** client-side ceiling for one call; above ~300s Node's fetch aborts first and the name is wrong */
    timeoutMs: number;
}
/**
 * THE PIN CATALOGUE: one record of which model and which effort each task plants with, read by every
 * lane rather than restated in each.
 *
 * `triage` runs terra at `high`: benchmarked at zero wrong equivalence calls at `high` against two
 * at `medium`. `generation` runs sol at `medium`, the arm the stage-2 effort sweep replicated
 * (see the pin below). `pool2` runs terra at `high` on BOTH the pull-request seam and the night, and
 * that entry exists here because those were two literals in two packages until the divergence audit.
 * All three are re-measurable and none is a default anyone has to accept - they are recorded here so
 * the artifact can state the identity that produced a candidate.
 *
 * luna's deployment name is VERIFIED: `verifyModelPin("gpt-5.6-luna")` against the live endpoint
 * catalog returned exactly that id (2026-08-13, agent-infra-codex). It still carries no per-task
 * pin here, because pins are benchmark-derived and no task benchmark has selected luna yet - the
 * name being real is necessary, not sufficient.
 */
declare const DEFAULT_TASK_PINS: Readonly<Record<MarigoldTask, TaskModelPin>>;
/**
 * The ceiling for a call carrying `gapCount` gaps.
 *
 * Reasoning overhead is paid once for the call; the visible test bodies scale with the gaps. So the
 * budget is the one-gap ceiling plus a per-gap increment, not a flat number and not a naive
 * multiplication that would ask for a quarter of a million tokens on a large batch.
 */
declare const PER_GAP_COMPLETION_TOKENS = 8000;
/** Ceiling on the ceiling: a request above this is refused by the endpoint, which helps nobody. */
declare const MAX_COMPLETION_TOKENS = 128000;
declare function batchCompletionCeiling(pin: TaskModelPin, gapCount: number): number;
/**
 * THE DEADLINE DERIVES FROM THE CEILING, instead of sitting beside it.
 *
 * A flat wall and a token ceiling set independently can contradict each other, and did: 32,000
 * tokens cannot be produced inside 290 s at any rate this endpoint has been measured at, so the
 * ceiling promised work the deadline forbade and 28 of 55 calls died at the wall.
 *
 * 70 tokens/second is the measured FLOOR rate (16,000 tokens in at most 217.7 s, rounded down), so
 * the derived wall is the time that many tokens actually take, plus 45 s for connection, queueing
 * and the reasoning that precedes the first visible token. `MAX_DERIVED_CALL_MS` is the starting
 * cap Kenneth approved: 480 s, which is 73% headroom over the worst gap yet observed at batch 1
 * (278 s). `HARD_CALL_CEILING_MS` is the outer bound no derivation may exceed.
 *
 * THE RESULT IS WHOLE MILLISECONDS, and that is a correctness rule rather than tidiness. The
 * division by 70 is only whole when the ceiling divides by 7, and the deadline is handed on to
 * undici as `headersTimeout`, which REFUSES a fraction (`UND_ERR_INVALID_ARG`, "headersTimeout must
 * be a positive integer or zero"). undici's `Agent` accepts the fraction at construction and refuses
 * it at dispatch, so fetch reports it as `TypeError: fetch failed` and the call dies in about 4 ms
 * without a byte leaving this process.
 *
 * That is exactly the shape of `DEFAULT_TASK_PINS.triage`: its 8,000-token ceiling derives 159,285.71
 * ms, below the 480 s clamp that rounds the generation pin off by accident. It failed INTERMITTENTLY,
 * because a caller passing an integer `remainingBudgetMs` smaller than the derived wall clamped it
 * back to a whole number - so the same pin worked or died by where in a run the call fell.
 * Found by the DeepSeek arm on 2026-08-15 (`data/abloh-deepseek-arm/report.md`, section 6).
 *
 * FLOOR rather than round: the derived wall is a promise about how long we will wait, and rounding
 * up would hand out a millisecond nobody measured.
 */
declare const MEASURED_TOKENS_PER_SECOND = 70;
declare const CALL_OVERHEAD_MS = 45000;
declare const MAX_DERIVED_CALL_MS = 480000;
declare const HARD_CALL_CEILING_MS = 600000;
declare function derivedCallDeadlineMs(input: {
    completionCeiling: number;
    /** what remains of the loop's own wall-clock; a call may never outlive the run */
    remainingBudgetMs?: number;
}): number;
declare function isAllowedModel(name: string): name is AllowedModel;
declare function assertAllowedModel(name: string): AllowedModel;
/** Secret-free identity for a task's model configuration, safe to record in an artifact. */
declare function taskModelIdentity(task: MarigoldTask, pin: TaskModelPin): string;

interface ThrottleRetryPolicy {
    /** retries AFTER the first attempt; 0 means the current behaviour of surrendering on a 429 */
    maxRetries: number;
    /** the first wait when the endpoint names no time of its own */
    baseDelayMs: number;
    /** ceiling on a computed wait, so doubling cannot run away */
    maxDelayMs: number;
}
/** Refuses a missing or nonsensical number rather than substituting one, as every v2 knob does. */
declare function validateThrottleRetryPolicy(policy: ThrottleRetryPolicy): void;
/**
 * The values callers write down, named for their provenance rather than hidden inside the transport,
 * exactly as `RULED_SLICE_POLICY` is for stage 4. `AzureModelClient` still refuses a missing policy,
 * so this constant is a call-site value and never a fallback.
 *
 * PROVISIONAL, PENDING A RULING - marked so nobody reads these as measured. No abloh run has yet
 * recorded a 429 from this deployment, so there is no throttle data to derive them from; they are
 * sized off the shape of the limit instead, and the first parallel night that logs throttle retries
 * is what re-rules them:
 *   `maxRetries` 4: Azure meters this deployment per minute, so a caller that is going to get in at
 *   all gets in within one window. Four waits of 1, 2, 4 and 8 seconds plus jitter span roughly 15 s
 *   of a 60 s window, and every one of them is still checked against the call's own deadline before
 *   it is taken, so the bound that matters is never this number alone.
 *   `baseDelayMs` 1000: below a second the retry lands inside the same throttled instant and buys
 *   nothing but another 429.
 *   `maxDelayMs` 20000: a computed wait longer than this is a wait that should have been a
 *   `Retry-After`; the endpoint's own number is honoured whatever its size, and the deadline check
 *   is what refuses one that will not fit.
 */
declare const RULED_THROTTLE_RETRY: ThrottleRetryPolicy;
/** The minimum headers shape this module reads, so a test need not build a whole `Response`. */
interface ThrottleHeaders {
    get(name: string): string | null;
}
/**
 * `Retry-After`, in whichever of its two legal forms the endpoint chose, plus the `retry-after-ms`
 * extension OpenAI-compatible gateways send.
 *
 * Returns null when no header names a time, and clamps a past date to 0 rather than returning a
 * negative wait. A malformed value is null, not a guess - the backoff ladder is the fallback, and it
 * is a better one than a number nobody can parse.
 */
declare function parseRetryAfterMs(headers: ThrottleHeaders, nowMs: number): number | null;
/**
 * Exponential backoff with EQUAL JITTER: the wait is half the doubled delay plus a random half.
 *
 * Full jitter - a uniform draw over the whole window - can return near zero, which is a retry into
 * the same closed window that just refused us. Equal jitter keeps the floor that doubling is for and
 * still spreads parallel callers across the second half of the window, which is the whole reason
 * jitter is here.
 *
 * `attempt` is the number of retries ALREADY made, so the first retry is attempt 0.
 */
declare function throttleBackoffMs(input: {
    attempt: number;
    policy: ThrottleRetryPolicy;
    random: number;
}): number;
type ThrottleRetryPlan = {
    retry: true;
    waitMs: number;
    source: "retry-after" | "backoff";
} | {
    retry: false;
    reason: "exhausted" | "deadline";
    waitMs: number;
};
/**
 * Whether this throttle earns another attempt, and how long to wait first.
 *
 * THE DEADLINE IS THE OUTER BOUND, not the retry count. A retry is worth making only if the wait
 * AND a call's measured overhead both still fit inside what remains of the derived deadline:
 * `CALL_OVERHEAD_MS` is the connection, queueing and pre-first-token time every call on this
 * endpoint pays, so an attempt with less than that left cannot produce a single token and would only
 * convert a named throttle into an anonymous timeout.
 */
declare function planThrottleRetry(input: {
    /** retries already made */
    attempt: number;
    policy: ThrottleRetryPolicy;
    /** what the endpoint asked for, when it asked */
    retryAfterMs: number | null;
    /** what is left of the call's derived deadline */
    remainingMs: number;
    /** [0, 1) jitter draw */
    random: number;
}): ThrottleRetryPlan;

/** Per-call transport measurements, so the derived deadline's constants become measured. */
interface CallTiming {
    /** the whole logical call, including any throttle backoff it waited out */
    latencyMs: number;
    /**
     * time to the first streamed chunk; the number that says whether streaming bought the wall.
     *
     * Measured from the start of the ATTEMPT that produced it, not from the start of the logical call,
     * so a throttle wait does not get recorded as endpoint slowness.
     */
    timeToFirstTokenMs: number | null;
    /** realised completion tokens per second for the answering attempt, once usage is known */
    tokensPerSecond: number | null;
    /** the wall this call was actually given */
    deadlineMs: number;
    /** the effort this call was made at, which the retry may lower */
    effort: string;
    /** extra HTTP attempts this one logical call spent waiting out a throttle; 0 in the normal case */
    throttleRetries: number;
    /**
     * The longest the answering attempt went WITHOUT a response byte, first byte included.
     *
     * MEASURED BECAUSE SOMETHING IN FRONT OF THE ENDPOINT COUNTS IT. See the surface note on
     * {@link AzureModelClient}: an intermediary on the production endpoint closes any request whose
     * response has been silent for about 60 s, and it re-arms that timer on every byte. Our own wall
     * is the derived deadline and says nothing about how close a call came to somebody else's.
     *
     * A call that completed with 6 s of silence and a call that completed with 58 s are the same
     * "ok" and are not the same health, and only this number tells them apart before the second one
     * turns into a night of `network` failures. On a call that WAS cut, it is the silence at the cut.
     *
     * Optional, because a scripted client in a test has no stream to measure.
     */
    longestSilenceMs?: number;
    /** which API surface answered: `responses` normally, `chat` on an endpoint that has no other */
    surface?: ModelSurface;
}
/**
 * The two OpenAI-compatible shapes this transport can speak.
 *
 * NOT A KNOB AND NOT A PREFERENCE. `responses` is chosen wherever it exists because it is the one
 * that does not go silent - see {@link AzureModelClient}. `chat` is what is left when an endpoint
 * has no Responses surface, which is a fact about that endpoint, discovered by asking it once.
 */
type ModelSurface = "responses" | "chat";
type ModelCallResult = {
    ok: true;
    text: string;
    usage: ModelUsage;
    latencyMs: number;
    timing?: CallTiming;
} | {
    ok: false;
    failure: ModelFailure;
    latencyMs: number;
    timing?: CallTiming;
    /**
     * THIS CALL'S OWN USAGE, when the endpoint reported a usage frame for it.
     *
     * A FAILED CALL STILL BURNED TOKENS in most of its shapes - `truncated` is a reply that ran to
     * the completion ceiling, and the stream carries its usage frame like any other. The result
     * used to carry none, so the meter read the DELTA of a shared cumulative counter across the
     * call instead, and a concurrent call's usage update landing inside that window was charged to
     * this one: a 50-input truncation overlapping a 100-input success was billed 150 (external
     * review, rank 8). A result that carries its own usage cannot be confused with another call's.
     *
     * Absent means the endpoint reported nothing for this call, which is a THIRD state and not a
     * zero - see {@link requestSent} for how the meter separates the two.
     */
    usage?: ModelUsage;
    /**
     * Did the request leave this process?
     *
     * `false` is a PROOF that nothing was spent, and it is the only thing that lets a call with no
     * usage frame settle at zero rather than at its own worst case. `undefined` is "the client
     * could not tell", which is treated as sent - the safe direction, since it charges the ceiling
     * against the budget rather than assuming a free call.
     */
    requestSent?: boolean;
};
/**
 * THE FAILURE VOCABULARY MOVED DOWN TO `@abloh/core`, AND IT IS THE SAME LIST RATHER THAN A TWIN.
 *
 * Same reasoning as `ModelUsage` above and the same shape: `packages/core/src/model-outage.ts` holds
 * a table that is TOTAL over these words - saying for each one whether it is an outage of abloh's
 * model service, a sentence some other code already owns, abloh's own defect, or one call's own
 * fact - and a table can only be total over a list it can see. Two literals with the same words and
 * a text pin between them is the divergence this codebase keeps paying for; an alias cannot drift.
 *
 * WHAT STAYS HERE IS WHAT EACH ONE MEANS AT THE MOMENT IT IS RAISED, which is the comment beside
 * every `kind:` below - why a mint failure is `authentication` and never `network`, why our own
 * arithmetic is `request-not-sent`, why a throttle only reaches a caller once its budget is spent.
 * The two comments that used to sit inside this list moved down with it, to the declaration.
 * Core knows the set is closed; this file knows why a call landed in it.
 */
declare const MODEL_FAILURES: readonly ["timeout", "network", "authentication", "rate-limit", "content-filter", "context-window", "truncated", "empty", "server-error", "request-not-sent", "budget"];
type ModelFailureKind = (typeof MODEL_FAILURES)[number];
interface ModelFailure {
    kind: ModelFailureKind;
    /** bounded, credential-free detail; goes into the next round's prompt as feedback */
    detail: string;
}
/**
 * A strict output schema for one call: the reply shape, handed to the decoder rather than described.
 *
 * SUPPORTED HERE, AND MEASURED. `response_format: {type: "json_schema", strict: true}` was probed
 * against this deployment on 2026-08-15 and returned valid JSON on every call, and on one real
 * planting call it cut generated tokens by 22% at the same eight bugs
 * (`data/abloh-cost-mechanics/report.md` sections 3 and 6).
 *
 * WHAT IT IS WORTH BEYOND THE TOKENS. `empty-original-text` and `replacement-identical` stop being
 * refusal classes we catch after the fact and become shapes the decoder cannot emit, and the
 * `unparseable` re-ask path stops being reachable. It is a mechanism, not a gate.
 *
 * THE SCHEMA IS THE CALLER'S. This transport does not know what any task's reply looks like and must
 * not invent one; it carries the schema the caller derived from its own reply shape.
 */
interface ModelJsonSchema {
    /** the schema's name, which the endpoint echoes; task-scoped, never a secret */
    name: string;
    /** a JSON Schema object; strict mode requires every property listed in `required` */
    schema: Record<string, unknown>;
}
interface ModelClient {
    readonly endpointHost: string;
    call(input: {
        task: string;
        pin: TaskModelPin;
        prompt: string;
        /** ask for a JSON object back; the parser refuses anything else regardless */
        jsonObject?: boolean;
        /**
         * Constrain the reply to a schema. Takes precedence over `jsonObject`, which is the same ask
         * without the shape - sending both would be one request carrying two answers to one question.
         */
        jsonSchema?: ModelJsonSchema;
        /** gaps carried by this call; the completion ceiling scales with it */
        gapCount?: number;
        /** override the pin's effort, e.g. the one retry a deadline miss earns */
        effort?: string;
        /** what remains of the loop's wall-clock; the derived deadline is clamped to it */
        remainingBudgetMs?: number;
        signal?: AbortSignal;
    }): Promise<ModelCallResult>;
    readonly usage: ModelUsage;
    readonly calls: number;
}
/**
 * THE HEADER WALL IS THE CALL WALL.
 *
 * `headersTimeout` used to be a flat 60 s, on the premise that with `stream: true` the first bytes
 * arrive in about a second, so a minute of silence meant a dead call rather than a slow one.
 * Measured against this endpoint on 2026-08-13, that premise is false: the first chunk arrived at
 * 148,257 ms streamed, and 214,647 ms unstreamed. The endpoint BUFFERS - streaming buys no early
 * header here.
 *
 * So a 60 s header wall killed every call whose answer took longer than a minute, and killed it as
 * `network` rather than `timeout`, because our own AbortController had not fired. The derived
 * deadline the fix introduced never got to decide anything. On node-cron's 36 survivors that cost
 * 23 of 36 generation calls and closed 0 gaps, against run C's 15.
 *
 * Since no header arrives before the answer does, silence before a header cannot be distinguished
 * from work still in progress, and the only honest wall for either is the call's own derived
 * deadline. One wall, derived once, advertised to the transport for both phases.
 *
 * BOTH NUMBERS ARE WHOLE MILLISECONDS, because that is undici's contract: a fraction is refused at
 * dispatch with `UND_ERR_INVALID_ARG` and the request never reaches the socket. `derivedCallDeadlineMs`
 * already floors, so this floor is the same rule stated where the transport's arguments are actually
 * made - the elapsed subtraction that produces an attempt's share of the wall happens here, not there.
 */
declare function transportTimeoutsMs(deadlineMs: number): {
    headersTimeout: number;
    bodyTimeout: number;
};
/** The request shape this transport issues; `dispatcher` is undici's and opaque to everything else. */
interface TransportRequest {
    method: string;
    headers: Record<string, string>;
    dispatcher?: unknown;
    signal: AbortSignal;
    body: string;
}
/** The part of a `Response` this transport reads. */
interface TransportResponse {
    ok: boolean;
    status: number;
    /**
     * The reason phrase beside the status, where the response carried one.
     *
     * OPTIONAL BECAUSE THE SEAM HAS TWO IMPLEMENTATIONS AND ONLY ONE OF THEM HAS A WIRE.
     * `NETWORK_TRANSPORT` hands through a real `Response`, which always has this; a scripted transport
     * in a test builds the three fields the retry loop reads and should not have to invent a fourth.
     * It reaches a reader only as evidence on `model-service-unavailable`, which prints the status
     * alone when there is no phrase.
     */
    statusText?: string;
    headers: ThrottleHeaders;
    text(): Promise<string>;
    body: unknown;
}
/**
 * The network seam.
 *
 * It exists because the throttle retry loop has three inputs no test can otherwise reach - what the
 * endpoint answered, what the clock says, and which way the jitter fell - and a retry policy that is
 * only exercised against a live rate-limited endpoint is a policy nobody has checked. Production
 * always uses {@link NETWORK_TRANSPORT}; nothing here is a knob.
 */
interface ModelTransport {
    fetch(url: string, init: TransportRequest): Promise<TransportResponse>;
    /** resolves early when the signal aborts, so a cancelled run does not sit out a backoff */
    sleep(ms: number, signal: AbortSignal): Promise<void>;
    /** [0, 1), the jitter draw */
    random(): number;
    now(): number;
}
declare const NETWORK_TRANSPORT: ModelTransport;
/**
 * SILENCE IS WHAT KILLS A CALL HERE, NOT LENGTH - SO THE TRANSPORT ASKS ON THE SURFACE THAT NEVER
 * GOES QUIET.
 *
 * Since about 2026-08-20 something in front of `agent-infra-codex.openai.azure.com` closes any
 * request whose RESPONSE has produced no bytes for ~60 s, and it re-arms that timer on every byte.
 * Measured on 2026-08-23, with our own undici wall set to 480 s so the cut could not be ours, one
 * 45,411-character prompt asked two ways:
 *
 * | surface            | first byte | longest silence | outcome                     |
 * |--------------------|-----------:|----------------:|-----------------------------|
 * | `/chat/completions`|  59,453 ms |               - | KILLED at 119,357 ms        |
 * | `/responses`       |   1,789 ms |        5,839 ms | COMPLETED at 148,922 ms     |
 *
 * The chat row is the whole diagnosis in one line: it died 59,904 ms after its last byte, not at
 * any multiple of the call's start, and the Responses row then ran 148.9 s - two and a half times
 * the wall - and finished, because it was never silent for more than six seconds.
 *
 * WHY THE TWO DIFFER. On `/chat/completions` the endpoint emits nothing until the first OUTPUT
 * token, so a reasoning model's whole thinking phase is dead air; production generation prompts
 * reasoned 115-155 s before their first byte on 2026-08-20 and every one of them would be cut
 * today. `/responses` emits `response.created` at stream open, before the model does any work at
 * all, then a steady run of lifecycle events. The socket is never idle, so the timer never fires.
 *
 * WHAT WAS RULED OUT, AND WHY IT IS NOT ONE OF THEM. Lowering the completion pin to fit the answer
 * inside a minute would change a ruled default to accommodate somebody else's fault and would
 * degrade every call's ceiling - it is refused. `stream_options: {include_usage: true}` was already
 * set and buys nothing, since the usage frame arrives at the END. Request-side keepalive is not the
 * lever either: an attempt with `keepAliveTimeout` at 480 s and TCP keepalive at a 5 s initial
 * delay was cut anyway, 60,004 ms after its last response byte, because the timer being counted is
 * an application-layer response-idle timer and socket liveness cannot reach it.
 *
 * THE ENDPOINT MIGHT NOT HAVE THE SURFACE. abloh's own model gateway serves exactly one path,
 * `/api/v1/model/chat/completions`, and an environment that names a chat path outright is honoured
 * verbatim (`endpoint.ts`, {@link EndpointConfig.responsesUrl}). Anything else is asked once: a 404
 * demotes this client to `chat` for its lifetime, inside the same logical call, and it is asked
 * once per client rather than once per call.
 *
 * The behaviour asked for is IDENTICAL on both. Same model, same effort ladder - all five rungs
 * accepted, probed 2026-08-23 - same completion ceiling (`max_output_tokens` counts reasoning and
 * output exactly as `max_completion_tokens` does), same strict schema, same streamed harvest. What
 * changes is only which door the same question goes through.
 */
declare class AzureModelClient implements ModelClient {
    #private;
    readonly endpointHost: string;
    readonly usage: ModelUsage;
    /**
     * LOGICAL calls, one per `call()`, which is what the loop budgets and what the ledger charges.
     *
     * A throttle retry is not a second call: the same prompt is being asked once, and counting the
     * wait as an extra attempt would inflate every count and every spend estimate built on it. What
     * the retries cost is disclosed beside this number in {@link throttleRetries} and per call in
     * `CallTiming.throttleRetries`, so they are visible without being double-counted.
     */
    calls: number;
    /** HTTP attempts spent waiting out throttles across every call this client has made */
    throttleRetries: number;
    constructor(config: EndpointConfig, throttle: ThrottleRetryPolicy, transport?: ModelTransport);
    /** Which surface this client is talking to, so a run's report can say which door it used. */
    get surface(): ModelSurface;
    /** Returns null with a named reason when the environment carries no endpoint. */
    static fromEnvironment(input: {
        /** explicit value required, named at the call site: there is no throttle policy default here */
        throttle: ThrottleRetryPolicy;
        env?: NodeJS.ProcessEnv;
        transport?: ModelTransport;
    }): {
        ok: true;
        client: AzureModelClient;
    } | {
        ok: false;
        reason: string;
    };
    call(input: {
        task: string;
        pin: TaskModelPin;
        prompt: string;
        jsonObject?: boolean;
        jsonSchema?: ModelJsonSchema;
        gapCount?: number;
        effort?: string;
        remainingBudgetMs?: number;
        signal?: AbortSignal;
    }): Promise<ModelCallResult>;
}
declare function classifyHttpFailure(status: number, raw: string): ModelFailure;

declare const TRIAGE_VERDICTS: readonly ["real-gap", "equivalent", "unclear"];
type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];
interface TriageRecord {
    gapId: string;
    verdict: TriageVerdict;
    /**
     * `normalization` when the two strings settled it, `model` when a call was made, and `upstream`
     * when the caller had already classified this survivor and said so - the CLI seam triages once
     * for the score and hands the loop the result rather than paying for the same judgement twice.
     */
    source: "normalization" | "model" | "upstream";
    reason: string;
    promptVersion: string;
    model: string | null;
    hold?: Hold;
}
interface TriageOutcome {
    records: TriageRecord[];
    /** gaps the loop will attempt: everything not positively called equivalent */
    attemptable: SurvivorGap[];
    modelCalls: number;
}
declare function triageGaps(input: {
    gaps: readonly SurvivorGap[];
    contexts: ReadonlyMap<string, GapContext>;
    client: ModelClient | null;
    pin: TaskModelPin;
    signal?: AbortSignal;
    /** ceiling on triage calls; gaps past it are attempted, never discarded */
    maxModelCalls?: number;
    /**
     * The caller already classified these survivors as real gaps.
     *
     * Normalization still runs - it is free and it is provable - but no model call is made, because
     * the answer already exists. Set by the CLI seam, where the score-side triage has just run.
     */
    upstreamTriaged?: boolean;
    /** independent triage calls in flight at once (default 8) */
    concurrency?: number;
}): Promise<TriageOutcome>;
declare function parseTriageReply(text: string): {
    verdict: TriageVerdict;
    reason: string;
    malformed: boolean;
};

/**
 * C3 - streaming delivery: the check posts monotone progress while the run is still happening.
 *
 * WHY IT EXISTS. A composed check takes minutes. Today a pull-request author sees one in-progress
 * spinner and then, eventually, an answer. The platform supports updating a check run in place, and
 * no product streams progressively improving verdicts inside a check (industry sweep, 2026), so the
 * whole waiting period is currently wasted screen.
 *
 * THE DISPLAY CONTRACT, which is the thing being sold and therefore the thing enforced here:
 *
 *   1. COUNTS ONLY GROW. Every counter is fed by non-negative deltas and nothing else - there is no
 *      "set" event to write a smaller number with. A number that could be revised downward is not
 *      reported at all: triage setting a gap aside does not shrink `gapsFound`, it grows a separate
 *      counter. This is mechanism, not a gate: a decrease is unrepresentable rather than rejected.
 *   2. NO SCORE BEFORE THE END. The in-progress snapshot type carries no score field, so an
 *      in-progress update cannot render one even by mistake. The score exists only on the verdict.
 *   3. STILL MEASURING IS SAID OUT LOUD. Every in-progress update is headed "Still measuring" and
 *      its number column is headed "Count so far", so no reader mistakes a partial count for final.
 *   4. ROWS ONLY APPEAR, NEVER VANISH. A row shows once its producing stage has started, and the
 *      verdict's row set is a superset of the last in-progress one. A reader who saw a measurement
 *      never has to wonder where it went.
 *   5. PROPOSALS ATTACH AS THEY PROVE, append-only, and only when actually proven.
 *   6. THE NEIGHBORHOOD SLICE IS NOT ON THIS STREAM AT ALL, and the rule that used to sit here was
 *      about a road nobody travelled. `renderNearbyCode` and `nearbyCode()` appended a section to
 *      the published verdict and were dead code from the day they were written: `verdict()` is never
 *      called on the shipped path, so the check run's answer comes from the control plane at ingest
 *      and no stream of ours had a verdict to append to. Meanwhile the SLICE genuinely did delay the
 *      answer a maintainer sees - by its whole wall time, because the artifact is written after it
 *      finishes - so the contract stated here was true of a verdict nobody published and false of
 *      the one everybody reads. Both are gone (the captain's D3 of 2026-09-05): the slice is a ROW
 *      on the check run and the sticky comment, written once by the control plane with everything
 *      else, and its cost is on the job clock behind the scoring pool.
 *
 * RATE LIMITS. Updates are batched per stage: events accumulate silently, and a publish is only
 * ever attempted at a stage boundary, never per candidate. A minimum interval coalesces boundaries
 * that arrive in a burst - a throttled update is never dropped, it merges into the next one, and
 * the verdict bypasses the interval entirely so the answer always lands.
 *
 * PLATFORM-NEUTRAL. This module renders `CheckUpdate` values and hands them to a publisher the
 * caller supplies. It performs no HTTP and knows no vendor: marigold may not reach application
 * code (import-boundary.test.ts), and the check-run client lives there.
 */
/**
 * The stages a reader is shown, in pipeline order, in CUSTOMER words.
 *
 * Deliberately not `LOOP_STAGES`: those are the loop's internal organs (admission, light-check,
 * kill-matrix), and a pull-request author has no vocabulary for them. The internal funnel is
 * disclosed in the artifact, where somebody debugging the engine will look for it.
 *
 * The neighborhood slice is NOT a stage here, on purpose. Listing it in the progress line would
 * tell a reader the verdict is waiting for it, and the verdict never waits for it.
 */
declare const CHECK_STREAM_STAGES: readonly ["reuse", "gutting", "mutation", "loop", "proof"];
type CheckStreamStage = (typeof CHECK_STREAM_STAGES)[number];
declare const CHECK_STREAM_STAGE_LABELS: Record<CheckStreamStage, string>;
declare const CHECK_STREAM_STAGE_STATES: readonly ["pending", "running", "done", "skipped"];
type CheckStreamStageState = (typeof CHECK_STREAM_STAGE_STATES)[number];
/**
 * Every counter the check shows, and every one of them cumulative BY CONSTRUCTION.
 *
 * `gapsSetAside` is why there is no revision problem: triage deciding a survivor is equivalent is a
 * real event that must be visible, and the honest way to show it is a second growing number rather
 * than a first one that shrinks.
 */
interface CheckStreamCounts {
    /** bugs planted so far, by any stage that plants them */
    bugsPlanted: number;
    /** planted bugs the existing suite did not notice */
    gapsFound: number;
    /** gaps set aside as equivalent to the real code; never subtracted from `gapsFound` */
    gapsSetAside: number;
    /** candidate tests written */
    testsWritten: number;
    /** candidate tests proven against the whole suite */
    testsProven: number;
    /** test-suite or single-test executions performed */
    testRuns: number;
}
declare const CHECK_STREAM_COUNTERS: readonly ["bugsPlanted", "gapsFound", "gapsSetAside", "testsWritten", "testsProven", "testRuns"];
/**
 * One proposed test, attached when it proves.
 *
 * CARRIES ITS SOURCE. A reviewer decides on a proposed test by reading it, so the check body shows
 * it (Kenneth, 2026-08-13). This is the RENDERING path only: the signed artifact block still
 * carries a digest of the body and never the body itself, so what a run attests to is unchanged.
 */
interface StreamProposal {
    /** repo-relative path the test occupies */
    testFile: string;
    testName: string;
    /** other gaps the same test closes, from the kill matrix */
    alsoClosesCount: number;
    /** the generated test source, rendered inline behind a disclosure triangle */
    testBody: string;
}
type CheckStreamEvent = {
    kind: "stage-started";
    stage: CheckStreamStage;
} | {
    kind: "stage-finished";
    stage: CheckStreamStage;
} | {
    kind: "stage-skipped";
    stage: CheckStreamStage;
    reason: string;
}
/** non-negative deltas only; a negative one throws, because a decrease is a defect upstream */
 | {
    kind: "counts";
    add: Partial<CheckStreamCounts>;
} | {
    kind: "proposal";
    proposal: StreamProposal;
};
declare const CHECK_CONCLUSIONS: readonly ["success", "failure", "neutral", "action_required"];
type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];
interface CheckUpdate {
    status: "in_progress" | "completed";
    title: string;
    summary: string;
    /** present only on a completed update; an in-progress update has no verdict to carry */
    conclusion?: CheckConclusion;
}
interface CheckStreamPublisher {
    publish(update: CheckUpdate): Promise<void>;
}
/**
 * The same progress, as DATA rather than as a page — for the surface that has to remember it.
 *
 * The check run is written and forgotten: every update replaces the last, nothing is stored, and
 * the page dies with the pull request. The run page is the opposite — a reader opens it during the
 * run and again a week later — so the control plane has to keep what the check merely showed.
 *
 * This is that state, and it is deliberately the SAME state the summary above was rendered from
 * rather than a second tally beside it. A stored count that disagreed with the one on the pull
 * request would be the worst possible bug here: two numbers about the same run, both ours, and no
 * way for a reader to tell which lied.
 *
 * NO TEST BODIES. The check run shows a proposed test's source because a reviewer decides by
 * reading it, and that rendering is forwarded to GitHub and thrown away. What is KEPT is the
 * structural fact that a test exists and what it closes — the same rule the signed artifact block
 * already follows, where the body is a digest and never the bytes.
 */
interface CheckStreamProposalRecord {
    testFile: string;
    testName: string;
    alsoClosesCount: number;
}
interface CheckStreamProgress {
    counts: CheckStreamCounts;
    stages: ReadonlyArray<{
        stage: CheckStreamStage;
        state: CheckStreamStageState;
        reason?: string;
    }>;
    proposals: CheckStreamProposalRecord[];
}
/** Identity, rendered into every update so a reader can tell which commit they are looking at. */
interface CheckStreamIdentity {
    /** `owner/name` */
    repository: string;
    headSha: string;
    dashboardUrl: string;
}
declare const CHECK_EVIDENCE_STATES: readonly ["complete", "incomplete", "cannot-attest"];
type CheckEvidence = (typeof CHECK_EVIDENCE_STATES)[number];
declare const CHECK_GATE_STATES: readonly ["pass", "fail", "cannot-attest"];
type CheckGate = (typeof CHECK_GATE_STATES)[number];
interface CheckVerdict {
    evidence: CheckEvidence;
    gate: CheckGate;
    enforcement: "advisory" | "required";
    /** the signed score, or null when the run produced none; never shown before this point */
    score: number | null;
}
/**
 * The conclusion the two status axes imply, rewritten from the documented contract rather than
 * imported: marigold may not reach application code, and the v1 renderer lives there.
 *
 * The axes are never conflated. Evidence completeness answers "did we measure everything we said we
 * would"; the gate answers "did the measurement clear the threshold". A run can pass the gate on
 * incomplete evidence, and that is not a success.
 */
declare function conclusionFor(verdict: Pick<CheckVerdict, "evidence" | "gate" | "enforcement">): CheckConclusion;
/**
 * GitHub accepts 65535 characters in a check run's summary, and a proposed test's source is the
 * only part of this page whose size we do not control. The budget is the cap minus what the rest of
 * the summary already costs, minus this margin - so a body is only ever included when the whole
 * page still fits, and the page can never be truncated by the platform mid-render.
 */
declare const CHECK_BODY_LIMIT = 65535;
interface StageView {
    stage: CheckStreamStage;
    state: CheckStreamStageState;
    reason?: string;
}
/** The in-progress snapshot. It has NO score field: rule 2 is a type, not a review item. */
interface MeasuringSnapshot {
    identity: CheckStreamIdentity;
    counts: CheckStreamCounts;
    stages: readonly StageView[];
    proposals: readonly StreamProposal[];
}
interface VerdictSnapshot extends MeasuringSnapshot {
    verdict: CheckVerdict;
}
/** The in-progress summary. Rule 3 lives in the heading and the column header. */
declare function renderMeasuring(snapshot: MeasuringSnapshot): string;
/** The verdict summary: the same rows, plus the score row that could not exist until now. */
declare function renderVerdict(snapshot: VerdictSnapshot): string;
/**
 * The minimum gap between two published updates, in milliseconds.
 *
 * GitHub's documented secondary rate limits ask for serial mutating requests to one endpoint and
 * bound a REST endpoint's cost per minute; a check run's updates are one endpoint. A ten-second
 * floor puts the ceiling at six updates a minute for one run, while the stage-boundary trigger
 * keeps the realistic number far below that (two boundaries per stage, five stages). It is a
 * transport constant, not a product budget: nothing about what a reader sees depends on it.
 */
declare const CHECK_STREAM_MIN_INTERVAL_MS = 10000;
/** What the loop needs from a stream, so the loop depends on the contract rather than the class. */
interface CheckProgressSink {
    record(event: CheckStreamEvent): void;
    flush(): Promise<unknown>;
}
interface CheckStreamOptions {
    identity: CheckStreamIdentity;
    publisher: CheckStreamPublisher;
    /** stages this run will actually attempt, fixed at construction so the plan cannot shrink */
    plan: readonly CheckStreamStage[];
    /**
     * How many times each planned stage will be driven - one per package the run measures.
     *
     * A change spanning workspace packages runs the loop ONCE PER PACKAGE, each in its own sealed
     * context, through this one stream. Without this the second package's `stage-started` moved the
     * `loop` row from done back to running, which is a row moving BACKWARDS in front of a reader who
     * has already read it - the same thing the counts rule forbids. With it, a stage is running from
     * its first start and done only when every part has finished.
     *
     * Defaults to 1, so a single-package run behaves exactly as it always did.
     */
    parts?: number;
    minIntervalMs?: number;
    /** injectable clock; the batching window is the only thing that reads it */
    now?: () => number;
}
declare class CheckStream implements CheckProgressSink {
    #private;
    constructor(options: CheckStreamOptions);
    /** Updates actually handed to the publisher. Batching means this is far below the event count. */
    get updatesPublished(): number;
    get counts(): Readonly<CheckStreamCounts>;
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
    progress(): CheckStreamProgress;
    record(event: CheckStreamEvent): void;
    /**
     * Publish the accumulated state, if anything changed and the rate-limit window allows it.
     *
     * A throttled flush is not a lost update: the state stays dirty and merges into the next one.
     */
    flush(): Promise<boolean>;
    /** The terminal update. It bypasses the rate-limit window: the answer always lands. */
    verdict(verdict: CheckVerdict): Promise<void>;
}

/**
 * Gaps per generation call, from the 2x2 (`artifacts/2x2-comparison.txt`), locked in by Kenneth on
 * 2026-08-14. Named rather than written inline so the number carries its provenance and a drift has
 * to come past `stage1-timeout-fix.test.ts`.
 */
declare const RULED_GENERATION_BATCH_SIZE = 2;
/**
 * Kill-matrix replays allowed PER ROUND, ruled by Kenneth on 2026-08-14 from
 * `data/abloh-experiment-night/report.md` section 5.2.
 *
 * Before this, the matrix was bounded only by whatever was left of the whole run's execution budget,
 * so it expanded to fill it: on the measured artifact the uncapped arm spent 330 matrix cells of 476
 * total executions and never reached round 3. Capped at 50, the matrix closed 2 fewer gaps itself
 * and the run closed 2 MORE overall (17 to 19), on 126 fewer executions, because generation entered
 * 83 gaps instead of 60 and a third round ran for the first time in this project's history. The cap
 * is also what makes the freed budget available to repair; both capped arms then stopped on the
 * round counter rather than on budget, and neither had gone dry.
 *
 * Read as SUGGESTIVE, not settled: +2 sits inside the control's own replicate spread of 3 gaps
 * (report section 7). It is adopted because it is free - fewer executions for more closures - not
 * because the +2 is proven.
 */
declare const RULED_MATRIX_CELLS_PER_ROUND = 50;
/**
 * In-round repair, ON, ruled by Kenneth on 2026-08-14 from `data/abloh-experiment-night/report.md`
 * section 5.4.
 *
 * One repair call per candidate that fails against the real source, inside the round that produced
 * it. Measured on the same 36-gap artifact: gaps closed went 17 to 26 of 36 (47% to 72%), the
 * real-not-passing hold bucket fell from 26 to 11, and the light-check pass rate went from 27-31%
 * to 52%. The control configuration closed 17, 17 and 15 gaps across three identical runs, so +9 is
 * roughly three times that noise floor - the only result of that night clearing its own spread.
 *
 * It costs model calls: 30 became 62 on the measured run, and wall clock 2.2x, because repairs run
 * serially inside the candidate loop while generation runs concurrently.
 */
declare const RULED_IN_ROUND_REPAIR = true;
/**
 * A test somebody else already wrote and proved for one of these gaps, offered to the loop as that
 * gap's FIRST CANDIDATE (architecture G, Kenneth's ruling of 2026-08-15).
 *
 * THE REDUNDANCY IT REMOVES. A pool-2 survivor arrives here with a witness that was proven to pass
 * on the real source and fail on the bug. The loop's own specification for a candidate is the same
 * sentence, so the night used to pay a second model call to have the same test written again and
 * throw the first one away (`data/abloh-cost-mechanics/report.md` section 10, architecture G).
 *
 * WHAT IT IS NOT. It is not a shortcut past anything. A promoted candidate faces admission, the
 * light check, the exit proof and the whole-suite check exactly as a generated one does, and it
 * closes its gap only by passing all of them. What it saves is the generation call, and only when
 * it earns it: a gap whose promoted candidate is refused is open when the rounds begin and is asked
 * about like any other.
 */
interface PromotedCandidate {
    /** the gap this test was written and proved against */
    gapId: string;
    /** where the test was placed when it was proved - the path it belongs at in the customer's tree */
    testFile: string;
    testName: string;
    /** the test source - LOCAL ONLY, never egresses */
    testBody: string;
    /** support files the test needs; a carried proposal may have them, a proven witness does not */
    supportFiles?: readonly CandidateSupportFile[];
    /** who wrote it, as the artifact will record it against this candidate */
    model: string | null;
    /** the prompt version that wrote it, so the two asks stay tellable apart in the artifact */
    promptVersion: string;
    /**
     * WHERE THIS TEST CAME FROM. Both origins face identical gates; they are told apart because they
     * are different news for a reader and because only one of them can be evicted.
     *
     *   `proven-witness`     a test proved against this gap somewhere else - a night's run, the bug
     *                        pool's witness. It is offered here because it already distinguished.
     *   `carried-proposal`   a test an EARLIER PUSH of this same pull request proposed for this exact
     *                        gap, carried forward because every input the proposal is a function of
     *                        is byte-identical today. It carries no claim of ever having been proved.
     *
     * Omitted is `proven-witness`, which is what every caller before carry-forward existed offers.
     */
    origin?: PromotedOrigin;
}
declare const PROMOTED_ORIGINS: readonly ["proven-witness", "carried-proposal"];
type PromotedOrigin = (typeof PROMOTED_ORIGINS)[number];
/**
 * CARRY-FORWARD, as a port rather than a dependency.
 *
 * The store this talks to lives outside this package, and it should: what may be carried is decided
 * by rules this loop does not own, and the loop's job is to run the gates. So the loop asks, offers
 * whatever comes back as promoted candidates, and reports back what happened.
 *
 * WHY IT IS ASKED AFTER `prepare()` AND NOT BEFORE. The prepared environment's recipe digest is one
 * of the inputs a carried proposal is a function of, and it does not exist until the environment is
 * built. Asking earlier would mean keying on an environment nobody had yet checked.
 *
 * NOTHING HERE IS A SHORTCUT. A carried proposal is proposed SOURCE. It faces admission, the light
 * check, the exit proof and the whole-suite check on today's HEAD exactly as a generated one does,
 * and closes its gap only by passing all of them. What it saves is the model call that would have
 * written the same test again.
 */
interface CarryPort {
    /**
     * Proposals this run may offer as first candidates, for the gaps it is about to attempt.
     *
     * Returning nothing is always valid and always safe: the loop generates, as it always did.
     */
    proposals(input: {
        gaps: readonly SurvivorGap[];
        recipeDigest: string;
    }): readonly PromotedCandidate[];
    /**
     * What this run learned, so the next one is warm and no worse informed than this one.
     *
     * `rejectedGapIds` are the carried proposals a gate refused HERE; the caller evicts them, or they
     * are re-offered and refused forever while their gap goes unasked. `carriable` is every candidate
     * this run wrote that no gate refused - the proven ones and the ones the budget never reached,
     * which on a budget-starved run is most of them and is exactly the work worth not paying for twice.
     */
    record(outcome: {
        recipeDigest: string;
        rejectedGapIds: readonly string[];
        carriable: readonly Candidate[];
    }): void;
}
/**
 * The round number a promoted candidate carries: 0, which is no round.
 *
 * Rounds are numbered from 1 and a round is a model call this loop made. A promoted candidate is a
 * test this loop did not write, offered before round 1 begins, so 0 says exactly that - and the
 * artifact's per-candidate `round` stays readable as "which of this loop's asks produced it".
 */
declare const PROMOTED_ROUND = 0;
/** What the promotion pass did, kept beside `repair` for the same reason: it is not the funnel's. */
interface PromotionStats {
    /** promoted candidates the caller offered */
    offered: number;
    /** offers naming a gap this run is not attempting, so there was nothing to promote them to */
    unmatched: number;
    /** promoted candidates admission accepted */
    admitted: number;
    /** promoted candidates that distinguished their gap and therefore closed it */
    distinguishing: number;
    /** gaps a promoted candidate closed, so generation was never asked about them */
    gapsClosedBeforeGeneration: number;
    /**
     * The carry-forward share of the numbers above, and the one thing only carry needs back.
     *
     * Counted apart because "this run proposed 12 tests" and "this run proposed 12 tests, 11 of them
     * written on an earlier push" are the same artifact and different news, and a disclosure that
     * cannot tell them apart cannot say the second one.
     */
    carried: {
        offered: number;
        admitted: number;
        distinguishing: number;
        /**
         * Gaps whose carried proposal did not survive a gate HERE.
         *
         * The caller evicts these from its store. A rejected proposal that stayed carriable would be
         * re-offered every run, fail every run, and the gap behind it would never be regenerated - a
         * carry that suppresses work instead of saving it, which is the forbidden direction wearing a
         * different hat.
         */
        rejectedGapIds: string[];
    };
}
interface ProposalsInput {
    repoDir: string;
    sha: string;
    /** the mutation run's normalized mutants; survivors are taken from here */
    mutants: readonly NormalizedMutant[];
    runner: SealedRunner;
    /** the project's test runner name, as the artifact will record it */
    runnerName: string;
    moduleFormat: "cjs" | "esm";
    /** test files the run observed the runner collect */
    testFilePaths: readonly string[];
    /** null runs the loop with no model: intake, normalization and the funnel still report */
    client: ModelClient | null;
    /** the caller already classified these survivors as real gaps; skip the loop's own triage call */
    upstreamTriaged?: boolean;
    /**
     * C1. Gaps the GUTTING PASS routed straight here, already in the loop's own shape.
     *
     * THE STARVED CASE, AND WHY IT ARRIVES AS A GAP RATHER THAN AS A MUTANT. A changed line no test
     * executes is never mutated - there is nothing to fool - so it can never appear in `mutants` and
     * `intakeSurvivors` can never produce it. The gutting pass measures those functions directly: it
     * removes a whole body, runs the suite once, and a suite that stays green has PROVED the function
     * pseudo-tested. That proof is a gap in exactly the shape intake produces, so it joins the same
     * queue rather than opening a second path through the loop (`gutting.ts` header; the routing's
     * whole purpose).
     *
     * THEY COUNT AS INTAKE, not as a bonus. The funnel adds them to `intake.entered` and
     * `intake.advanced` so the loop's denominator is every gap it was handed, however it arrived.
     * Absent is what every run did before this existed.
     */
    firstCoverageGaps?: readonly SurvivorGap[];
    /**
     * The service names this repository's `abloh.yml` declares, for the reachability router.
     *
     * WHY THE CALLER DECLARES IT. Policy is the CLI's to read - the loop has never opened `abloh.yml`
     * and must not start - and the router needs to know whether a service-backed witness is even a
     * thing this repository has. Omitted is none declared, which is what almost every repository is.
     */
    declaredServices?: readonly string[];
    /**
     * Tests already written and proved for some of these gaps, offered as those gaps' first
     * candidates. See {@link PromotedCandidate}. Omitted is the shape the pull-request path runs:
     * nothing upstream of it has written a test for a gap.
     */
    promoted?: readonly PromotedCandidate[];
    /** carry-forward, when the caller has a store to carry from; see {@link CarryPort} */
    carry?: CarryPort;
    /**
     * Gaps whose bug the AGENT BUG POOL wrote, named by gap identity.
     *
     * WHY THE CALLER DECLARES THIS AND THE LOOP DOES NOT DERIVE IT. The loop is handed normalized
     * mutants and cannot tell from one whether the change it describes came from a mutation operator
     * or from a bug the pool planted; only the caller that assembled the gap set knows, and the
     * overnight lane is the one caller that assembles it from two populations.
     *
     * NOT THE SAME SET AS `promoted`, and conflating them would be wrong in both directions. A pool-2
     * gap whose promoted witness is refused is still a pool-2 gap, and it keeps this origin when
     * generation closes it in round 1. Every gap not named here is `mechanical`, which is what the
     * pull-request path's whole gap set is.
     *
     * Ids naming a gap this run is not attempting are simply not matched; declaring one is not an
     * error, because the caller filters its own populations before the loop sees them.
     */
    plantedGapIds?: readonly string[];
    /**
     * Gaps that are ONE CALL AWAY from the change rather than inside it, named by gap identity.
     *
     * WHY THEY ARE HERE AT ALL (the captain's D7 of 2026-09-05). A test is the form a finding gets
     * acted on in - all of Vera-Perez's fix pull requests were merged and 73% of Meta's generated
     * tests were accepted, while a finding handed over on its own often is not - so the neighborhood
     * slice's own gaps are offered to the same loop. They arrive through `firstCoverageGaps` and AFTER
     * the diff's own, so a budget that closes only some of its gaps spends it on the change first.
     *
     * WHY THE CALLER DECLARES IT, on `plantedGapIds`'s own reasoning: the loop is handed gaps in one
     * shape and cannot tell from one whether the function it describes is inside the change or beside
     * it. Only the caller that assembled the queue knows.
     *
     * NOTHING HERE SCORES. It never did - the slice's findings are about code the change did not
     * touch - and this changes only which population a proposal SAYS it closed.
     */
    nearbyGapIds?: readonly string[];
    pins?: {
        triage: TaskModelPin;
        generation: TaskModelPin;
    };
    budget?: Partial<LoopBudget>;
    /** gaps per generation call */
    batchSize?: number;
    /** independent generation calls in flight at once (default 6) */
    generationConcurrency?: number;
    targetedTimeoutMs?: number;
    suiteTimeoutMs?: number;
    proofRepetitions?: number;
    /** an existing test from the repository, so candidates match local conventions */
    exampleTest?: {
        path: string;
        source: string;
    };
    /**
     * Kill-matrix replays allowed per round. Omitted is {@link RULED_MATRIX_CELLS_PER_ROUND}, which
     * is the ruled default and what production runs; a caller passes a value only to measure another
     * one against it.
     */
    matrixCellsPerRound?: number;
    /**
     * One repair call per candidate that fails against the real source. Omitted is
     * {@link RULED_IN_ROUND_REPAIR} - on - which is the ruled default and what production runs.
     */
    repairOnRealNotPassing?: boolean;
    onProgress?: (line: string) => void;
    /**
     * C3. The loop feeds the check stream TYPED EVENTS at the moments the facts occur - a gap taken
     * in, a test written, a proof landed - rather than the caller parsing `onProgress` text. Progress
     * lines are for a human reading a terminal; a display contract cannot be built on them.
     *
     * The loop drives in-progress updates only. The verdict is the whole run's, not the loop's: the
     * score comes from the mutation stage and the gate from policy, so the orchestrator publishes it.
     */
    stream?: CheckProgressSink;
    signal?: AbortSignal;
}
/** Everything the loop produced. The block egresses; the sidecar does not. */
interface ProposalsResult {
    block: ProposalsBlock;
    sidecar: ProposalsSidecar;
    /**
     * The FULL ledger, as JSON. Local only, written `0600`, and never offered to the uploader.
     *
     * It is what an operator reads to find out why a candidate was rejected, and it holds the bodies
     * of candidates that were - which is exactly why it does not travel. See {@link uploadSidecarText}.
     */
    sidecarText: string;
    /**
     * The bytes that DO travel: the survivor projection, scrubbed, and what `block.proofsDigest`
     * commits to. `upload-projection.ts` states what is dropped and why the selection is the
     * artifact's rather than the producer's.
     */
    uploadSidecarText: string;
    metrics: {
        totalMs: number;
        generationMs: number;
        lightCheckMs: number;
        matrixMs: number;
        exitProofMs: number;
    };
}
interface ProposalsSidecar {
    schema: typeof PROPOSALS_SIDECAR_SCHEMA;
    sha: string;
    intakeExclusions: IntakeExclusion[];
    triage: TriageRecord[];
    candidates: Array<{
        candidateId: string;
        gapId: string;
        round: number;
        testFile: string;
        testName: string;
        /** LOCAL ONLY */
        testBody: string;
        /**
         * The other files this candidate needs to run - LOCAL ONLY, same class as `testBody`.
         *
         * DROPPED UNTIL 2026-08-28 (junction audit EVID-01). `candidateId` is a digest over the gap, the
         * round, the test path, the body AND these files, so a sidecar without them cannot recompute the
         * identity it is keyed on, and a proven candidate that needed a fixture could not be reproduced
         * from the evidence that proved it. Absent when the candidate needed none, which is most of them.
         */
        supportFiles?: CandidateSupportFile[];
        /**
         * WHICH MODEL WROTE THIS ONE, AND UNDER WHICH PROMPT VERSION.
         *
         * The block's per-gap summary carries a model and a prompt version, and a repaired or promoted
         * candidate need not have been written by that one - the summary describes the proof that won,
         * this describes the row. Provenance was the field this ledger existed to hold and the projection
         * dropped it (EVID-01). `model` is null on a candidate no model wrote.
         */
        model?: string | null;
        promptVersion?: string;
        /** present on a candidate an in-round repair call wrote, naming the candidate it repaired */
        repairedFrom?: string;
        /** present on a candidate this loop did not write: a proven witness promoted into round 0 */
        promoted?: true;
    }>;
    lightChecks: LightCheckResult[];
    /**
     * THE WHOLE CELL, not three of its five fields (junction audit EVID-02, 2026-08-28).
     *
     * `executions` is what a replay cost and `hold` is why a cell reached no verdict; both were
     * computed, both were dropped here, and the separate hold ledger that survived carries no
     * candidate identity - so "which candidate's replay was held, and why" was unanswerable from the
     * evidence document while being answerable in the process that wrote it.
     */
    matrix: KillMatrixCell[];
    /**
     * Every generation and repair call this run sent, in the order they finished, with the
     * transport's own measurement of each. Aggregates cannot say whether a slow run was two calls
     * that hung or an endpoint that was slow all evening; this can.
     */
    modelCallTimings: ModelCallRecord[];
    exitProofs: ExitProofResult[];
    /** every hold, in order, with its evidence: the funnel's raw material */
    ledger: Array<{
        gapId: string;
        round: number;
        stage: LoopStage;
        reason: string;
        evidence?: string;
    }>;
    /**
     * What the in-round repair pass did. The funnel deliberately does NOT count repair attempts - one
     * funnel row per GENERATED candidate is what keeps a repaired run comparable with one that had no
     * repair - so the repair pass's own arithmetic lives here.
     */
    repair: RepairStats;
    /**
     * What the promotion pass did (architecture G).
     *
     * A promoted candidate is counted in the ADMISSION, LIGHT-CHECK and EXIT-PROOF funnels, because
     * it genuinely faces all three, and NOT in the generation funnel, because this loop did not
     * generate it. That is the honest reading and it is also the readable one: `generation.entered`
     * stays the number of gaps this loop asked a model about, which is the number the saving is
     * measured against.
     */
    promotion: PromotionStats;
}
/** The in-round repair pass's own arithmetic, kept out of the funnel on purpose. */
interface RepairStats {
    /** candidates that failed against the real source and were eligible for a repair call */
    eligible: number;
    /** repair calls actually sent (eligible minus those the budget refused) */
    attempted: number;
    modelCalls: number;
    /** repair calls that came back with a test body carrying a declared name */
    returnedCandidate: number;
    /** repaired candidates that passed admission */
    admitted: number;
    /** repaired candidates that went on to distinguish their gap */
    distinguishing: number;
    /** repairs the budget refused to attempt */
    refusedByBudget: number;
    /**
     * Summed latency of the repair calls themselves, where `ms` is the WALL CLOCK the repair phase
     * consumed.
     *
     * THE TWO WERE THE SAME NUMBER while repair ran serially, and the node-cron regression is what
     * made them different: repair calls now run under the same concurrency generation uses, so a run
     * whose calls total 2,881 s may spend 400 s of wall clock on them. Reporting only the sum would
     * keep quoting the serial cost; reporting only the wall clock would hide that the model time did
     * not go away, it went sideways. Both, and the ratio between them is the speed-up.
     */
    modelMs: number;
    /**
     * Repairs NOT attempted because the failure named a runner capability the runtime does not have.
     *
     * Counted rather than silent, because it is the number that says how much of a run's repair
     * budget was being spent on failures no prompt could fix. See `repair-routing.ts`.
     */
    refusedByCapability: number;
    /** candidateIds of the repaired candidates that distinguished, so their proof rate is checkable */
    distinguishingCandidateIds: string[];
    ms: number;
}
declare function runMarigold(input: ProposalsInput): Promise<ProposalsResult>;

/**
 * Where a file's proven blind spots were proven, named so an aimed run can be measured against an
 * unaimed one afterwards.
 *
 * Each value is a different EXPERIMENT rather than a different confidence:
 *
 *   `night-per-line`  the night's own per-line mechanical pass, over this file's exact bytes.
 *   `night-sweep`     the coarser function-level gutting sweep, for a file the per-line pass has not
 *                     reached yet. A whole body removed and nothing noticed is the same class of
 *                     proof at a coarser granularity.
 *   `diff-survivors`  the pull-request path's own classic mutants that SURVIVED on this change.
 *   `warm-start`      a night's stored map, read by a pull-request check through seam 1.
 */
declare const AIM_SOURCES: readonly ["night-per-line", "night-sweep", "diff-survivors", "warm-start"];
type AimSource = (typeof AIM_SOURCES)[number];
/** One file's proven blind spans, inclusive [start, end], and where the proof came from. */
interface BugPoolAim {
    spans: ReadonlyArray<readonly [number, number]>;
    source: AimSource;
}
/**
 * The aim's identity, so a pool generated with one aim is never replayed for a different one.
 *
 * `undefined` for an absent or empty aim, which is what keeps every key this joins byte-identical to
 * what it was before E existed.
 */
declare function aimDigest(aims: readonly BugPoolAim[] | undefined): string | undefined;
/**
 * A file's aims with the empty ones dropped.
 *
 * "WE LOOKED AND FOUND NOTHING PROVEN" IS NOT AN AIM. Every caller assembles its aims from whatever
 * proofs it has, and a proof that named no span has to leave no trace at all: no block in the
 * prompt, no change to any key, nothing in the disclosure. Filtering in one place is what stops that
 * rule from being re-implemented, differently, at each of them.
 */
declare function nonEmptyAims(aims: readonly BugPoolAim[] | undefined): BugPoolAim[];
/**
 * What a run aimed at, as the artifact and the morning report state it.
 *
 * COUNTS AND SOURCE NAMES, NEVER SPANS. The disclosure exists so the second night and the next
 * benchmark can tell an aimed run from an unaimed one and compare their survivor rates; naming which
 * lines were aimed at adds nothing to that comparison and would put a map of a customer's weak spots
 * into an egressing document.
 */
interface AgentBugAimDisclosure {
    /** distinct sources, sorted, so two runs with the same provenance read the same */
    sources: AimSource[];
    /** files whose prompt carried an aim block */
    files: number;
    /** spans named across those files, after merging */
    spans: number;
    /** lines those spans cover */
    lines: number;
}
/** The disclosure for a run's targets, or undefined when nothing was aimed - E did not run. */
declare function buildAimDisclosure(targets: ReadonlyArray<{
    aims?: readonly BugPoolAim[];
}>): AgentBugAimDisclosure | undefined;
/**
 * Fold overlapping and touching spans into the smallest equivalent list, in line order.
 *
 * The aim is assembled from more than one proof at a time - a diff's own survivors plus a night's
 * map, several operators on one line - and the same line listed twice is the same fact listed twice.
 */
declare function mergeAimSpans(spans: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]>;
/**
 * The part of an aim that lies inside the ranges a bug is allowed to be placed on.
 *
 * WHY THE INTERSECTION EXISTS AT ALL. On the pull-request path the placement rule is Kenneth's, and
 * it is absolute: every bug's replaced text must overlap a changed line, or the bug measures code
 * this commit did not touch while being reported as written against it. A night's map and a classic
 * survivor list both know about lines outside the diff, and aiming the generator at one of those
 * would ask for a bug the pool then refuses as `off-diff` - the ask would look aimed and the run
 * would report nothing.
 *
 * So the pull-request path aims only INSIDE the diff, and what the night's map adds there is real:
 * the lines this change touched that an earlier night already proved nothing asserts on. Whether the
 * pool may ever plant off the diff is an open ruling (`plant-off-diff`), and until it is ruled this
 * function is where the answer would change.
 *
 * An empty `within` means the caller has no placement surface - the night, which plants over whole
 * files - and the aim passes through whole.
 */
declare function aimWithin(spans: ReadonlyArray<readonly [number, number]>, within: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]>;

/**
 * The negative catalog - what the planting call is told NOT to spend a bug on.
 *
 * KENNETH'S RULING, 2026-08-27 ("smarter AI planting"). Pool 2 pays a model to write bugs on the
 * same changed lines a free deterministic pass has already mutated. Every proposal that lands on a
 * mistake that pass can express is a paid call buying a mutant the run already owns. The prompt's
 * cure is to state the overlap and forbid it.
 *
 * WHAT IT MEASURED, both ways, because the ruling's premise deserves numbers rather than a reading
 * of the prompt. `apps/cli/src/__bench-pool2-planting.ts` is the instrument in each case.
 *
 *   THE LIVE BEFORE/AFTER, three planting calls per arm against one fixture file, same model, same
 *   ask, same grader. The /10 prompt returned 24 proposals of which 7 were reproducible by a classic
 *   operator - 5.67 per call landed outside. The /11 prompt returned 22 of which NONE were - 7.33
 *   per call outside. The block removed the duplication entirely on this file and cost no yield.
 *
 *   THE OFFLINE CORPUS, `--stored`, which grades the pools real /10 runs already wrote: of the 74
 *   gradeable against this repository, 10 were classic-expressible and 64 were not. So the shipped
 *   ask was already mostly clear of the free arm on real diffs, and the overlap the block removes is
 *   a real but minority fraction - the fixture's 29% is the high end, not the typical case.
 *
 * Both numbers are upper bounds on "outside" for the reason `pool2-classic-expressibility.ts` gives:
 * ten of Stryker's babel-side mutators are not enumerated, so an edit only those could express is
 * counted outside. The bound applies identically to both arms, which is what the comparison needs.
 *
 * THE EXCLUSION IS BY EXPRESSIBILITY, NOT BY SIZE, and that distinction is the whole ruling. A
 * one-character edit that no classic operator can produce is worth a call; a twenty-line rewrite
 * that decomposes into one operator flip is not. Nothing here reads the length of an edit.
 *
 * WHY THE CATALOG IS DERIVED AND NEVER WRITTEN OUT AS PROSE. The obvious way to write this block is
 * a list of English labels - "no off-by-one, no swapped operand, no dropped condition". Those labels
 * lie at exactly the margin that matters. "Argument swap" reads like something classic cannot do,
 * and in THIS product `argument-order` swaps two adjacent arguments of any call, so half of what the
 * label would have waved through is already covered. Run the other way, "off-by-one" reads like a
 * blanket ban and would forbid a unit confusion that happens to move a number by one. So the block
 * carries two mechanical surfaces instead:
 *
 *   THE OPERATOR SET, handed in by the layer that runs classic. Each entry is an operator identity
 *   and the REWRITE it performs, stated as a transformation of source text. A model reading
 *   "replaces `<` with `<=` and `>` with `>=`" can decide expressibility; a model reading "boundary
 *   errors" is guessing at a category boundary nobody defined.
 *
 *   THE MUTANTS ALREADY PLANTED IN THIS FILE, this run, by that same pass. Not a class of edit - the
 *   actual edits, at their actual lines. This is the half that cannot drift: it is what happened.
 *
 * WHY BOTH AND NOT ONE. The planted list is precise and incomplete - the deterministic pass caps
 * itself per category and per file, so a file can offer a hundred sites and report twelve. The
 * operator set is complete and general. Together they say "here is the shape of what is covered, and
 * here is what was actually taken".
 *
 * NOTHING HERE IS ENFORCED AT ACCEPTANCE, deliberately. `generateBugPool` refuses a bug for being
 * unlocatable, off-diff or identical - all facts about the edit itself. Whether a proposal is
 * classic-expressible is a judgement over another pass's operator set, and a refusal built on it
 * would throw away a real bug whenever the judgement was wrong. The prompt asks;
 * `apps/cli/src/pool2-classic-expressibility.ts` is what says how well the ask worked.
 */
/**
 * One operator the product's classic passes actually run.
 *
 * IT IS HANDED IN, NEVER IMPORTED. `import-boundary.test.ts` allows this package exactly one
 * workspace dependency, so the inventory cannot be read from `@abloh/core/source-analysis` where it lives. The
 * layer that runs both - the CLI dispatch - passes it down, which is also the honest seam: the pool
 * is told what classic runs by the code that runs classic, rather than keeping a second opinion.
 */
interface ClassicOperator {
    /** the operator's identity in the engine that runs it, e.g. `argument-order`, `EqualityOperator` */
    id: string;
    /**
     * What it rewrites, as a transformation of source text.
     *
     * A SENTENCE ABOUT THE EDIT, NOT ABOUT THE BUG. "swaps two adjacent arguments of a call" is
     * checkable against a proposal; "argument confusion" is a category the reader has to guess the
     * edges of, and guessing the edges is the failure this whole block exists to remove.
     */
    rewrite: string;
}
/**
 * One mutant the classic pass already planted in a file, this run.
 *
 * `replacement` is nullable because the engine's own normalized mutant is - a mutant that deletes
 * text carries no replacement, and inventing an empty string for it here would print a rewrite the
 * engine never made.
 */
interface ClassicPlantedMutant {
    startLine: number;
    endLine: number;
    /** the operator identity that produced it, as the engine reported it */
    operator: string;
    originalText?: string;
    replacement: string | null;
}
/**
 * The minimum of a run's mutant this module reads. Anything wider is the caller's business - the
 * same contract, and the same reason, as `ClassicMutantLocation` in `sizing.ts`.
 */
interface ClassicMutantRecord {
    file: string;
    startLine: number;
    endLine: number;
    mutator: string;
    replacement: string | null;
    originalText?: string;
    origin?: string;
}
/**
 * What the free pass planted in each scoped file, on that file's changed lines.
 *
 * THE SAME TWO GATES THE SIZING LAW USES, and they are here rather than at the call site so the two
 * derivations cannot disagree about what "classic planted this" means. ONLY THE DETERMINISTIC
 * PASSES COUNT: a `realistic` mutant is this pool's own output from an earlier lane and an
 * `error-path` mutant is a forced handler change, and telling the planter its own past proposals
 * are already covered for free would exclude exactly the work this call exists to do.
 */
declare function classicPlantedByFile(input: {
    scopes: ReadonlyArray<{
        file: string;
        ranges: ReadonlyArray<readonly [number, number]>;
    }>;
    mutants: readonly ClassicMutantRecord[];
    overlaps: (startLine: number, endLine: number, ranges: ReadonlyArray<readonly [number, number]>) => boolean;
}): Map<string, ClassicPlantedMutant[]>;
/**
 * How many already-planted mutants one file may contribute to the block.
 *
 * Twelve. The list is evidence of the shape of the coverage, not a census: a dense file offers
 * hundreds and printing them would cost more prompt than the file's own source. Twelve is enough to
 * show several operators at several sites, which is what a reader needs in order to generalise, and
 * `stridedSample` below is what keeps those twelve spread over the file rather than taken off the
 * top of it.
 */
declare const MAX_PLANTED_PER_FILE = 12;
/** How much of one planted mutant's text may be printed; past this it is cut with a marker. */
declare const MAX_PLANTED_TEXT_CHARS = 120;
/**
 * At most `cap` entries, spread across the list rather than taken off its top.
 *
 * The same rule, and the same reason, as `selectLineMutants`: given a list in source order, the
 * first twelve of two hundred describe the top of the file and say nothing about the rest of it -
 * and the rest of it is where the model is being asked not to go.
 */
declare function stridedSample<T>(items: readonly T[], cap: number): T[];
/**
 * The identity of everything /11 added to a file's question, or undefined when it added nothing.
 *
 * WHY IT IS PART OF THE CONTENT KEY, and it is the aim digest's argument applied to the same shape
 * of change. A file's pinned pool is replayed whenever its BYTES have not moved, and neither the
 * exclusion block nor the domain block is derived from those bytes: the classic pass can sample
 * different mutants on a later run, a neighbouring type can gain a field, a README can be rewritten,
 * an owner can add an invariant to `abloh.yml`. Replaying the old pool for the new question would
 * report bugs written against material this run never showed the model - and would make the
 * measurement of the new prompt read the old prompt's answers.
 *
 * ABSENT WHEN THERE IS NOTHING, which leaves the key byte-identical to what it was before /11 for
 * any caller that supplies neither block - the overnight lane, and every existing test.
 */
declare function catalogDigest(input: {
    operators: readonly ClassicOperator[];
    planted: readonly ClassicPlantedMutant[];
    domainLines: readonly string[];
    digest: (value: unknown) => string;
}): string | undefined;
/**
 * The exclusion block, appended like every other rule block in this prompt.
 *
 * WHY APPENDED. The placement rule won its A/B as an appended block and nothing else, and every
 * block since has been added the same way for the same reason: a rule woven into the body ships a
 * prompt no experiment ever measured. The reading order is stated in the text, because three rules
 * that can pull against each other must resolve in one direction only - placement decides where a
 * bug is ALLOWED, aim decides where it is most VALUABLE, and this decides what KIND is worth paying
 * for. None of them relaxes the ones above.
 *
 * NO OPERATORS AND NO PLANTED MUTANTS MEANS NO BLOCK, and the prompt is then byte-identical to one
 * built without the catalog. That is the state of the overnight lane, which runs no classic pass at
 * all, and of any caller that has not looked.
 */
declare function exclusionBlock(input: {
    operators: readonly ClassicOperator[];
    planted: ReadonlyArray<{
        file: string;
        mutants: readonly ClassicPlantedMutant[];
    }>;
}): string[];

/**
 * LAMBDA, the completeness the product promises (Kenneth, 2026-08-15).
 *
 * `c(s) = 1 - e^{-s/k}` puts one attempt per site at 63% of the reachable faults, two at 86% and
 * three at 95%. Two is the ruled value. It is a promise level rather than a measurement, which is
 * exactly why it is Kenneth's and is written down here instead of being chosen inside a function.
 */
declare const RULED_SIZING_LAMBDA = 2;
/**
 * The floor a changed file with at least one classic site gets (Kenneth, 2026-08-15).
 *
 * At LAMBDA = 2 the law already returns 2 for a single-site file, so the floor binds nothing today.
 * It is stated anyway because it is the ruled behaviour and not an artefact of the current lambda: a
 * changed file the deterministic engine found something in is never examined by one attempt alone.
 */
declare const RULED_MIN_ATTEMPTS_PER_FILE = 2;
/** The whole pool's share of one check run (Kenneth, 2026-08-15). Twenty minutes, and no more. */
declare const RULED_POOL2_WALL_ALLOWANCE_MS: number;
/**
 * The same pool's share of ONE NIGHT (Kenneth, 2026-08-15). Four hours.
 *
 * A SECOND CONSTANT RATHER THAN A LARGER FIRST ONE, because the two surfaces are two different
 * promises. Twenty minutes is what a pull-request check may take before a reviewer is waiting on us.
 * A night is eight hours nobody is waiting through, and until this ruling it was planting under the
 * pull request's number: the lane passed the check run's allowance through unchanged, so an
 * eight-hour night funded four files.
 *
 * WHAT THE TWENTY MINUTES ACTUALLY DID, measured by running the shipped law over the maiden night's
 * own target set (`data/abloh-hunt-economics/report.md` section 2). The night selected six files and
 * the allowance funded four of them, thirty-two bugs. Worse, the constraint sharpens as the hunt
 * widens - each block of eight files costs another generation round out of the same twenty minutes -
 * so asking for sixty files funded ONE. The derived planted-bug cap going up would have made night 2
 * plant fewer bugs than night 1.
 *
 * WHY FOUR HOURS AND NOT EIGHT. Four is what the night can spend on planting and still leave the
 * phases either side of it - the sweep before, the closing loop and graduation after - the rest of
 * the window; the lane's own wall-clock rail, not this number, is what ends the night. At four hours
 * a twenty-file selection is funded in full and the law's own ceiling is fifty-one files, which is
 * past anything the $5.00 nightly limit can pay for. Eight hours would buy nine more files the money
 * cannot fund, so the money would be the only bound and this constant would stop meaning anything.
 */
declare const RULED_NIGHT_POOL2_WALL_ALLOWANCE_MS: number;
/**
 * What one attempt costs in wall clock once it has been generated.
 *
 * MEASURED, not assumed: `executions(N) = 3 per witness-proven bug` (two witness runs plus the
 * suite verdict), and one execution took 9.5 to 13.3 s on the repositories whose baseline suite runs
 * in 8 to 9 s (`data/abloh-pool-scaling-research/report.md` section 2.5, isolated `run.log`
 * intervals, confirmed by an independent least-squares fit over 17 item-arm wall-clock deltas).
 * Eleven seconds times three executions is the per-attempt figure the cap divides the allowance by.
 *
 * IT SCALES WITH THE CUSTOMER'S SUITE, NOT WITH US. `e` is dominated by the whole-suite execution,
 * so a repository with a five-minute suite costs far more than this per attempt and the cap derived
 * from it will be optimistic there. That is a known limit of a fixed constant, recorded rather than
 * hidden; the honest fix is to measure `e` on the run itself, which no measurement has yet earned.
 */
declare const MEASURED_EXECUTIONS_PER_ATTEMPT = 3;
declare const MEASURED_EXECUTION_MS = 11000;
declare const MEASURED_ATTEMPT_EXECUTION_MS: number;
/**
 * What one round of generation costs, charged against the allowance before the cap is derived.
 *
 * MEASURED on the placement A/B's 78 calls: mean generation latency 129 s on the shipped prompt and
 * 128 s once the placement rule was added, so telling the model where the change is costs nothing in
 * wall clock. Rounded up to 130 s. Calls inside a round run concurrently, so a round costs about one
 * call rather than the sum of its calls.
 */
declare const MEASURED_GENERATION_ROUND_MS = 130000;
/**
 * How many generation calls may be in flight at once.
 *
 * The same 8 the candidate loop runs its own generation at, which is where this endpoint's
 * concurrent throughput was measured. The allowance's role is not to lower this number but to charge
 * what it costs: with F changed files the plan pays `ceil(F / 8)` rounds of `MEASURED_GENERATION_
 * ROUND_MS` out of the allowance and caps the attempts with what is left, so a 40-file diff funds
 * fewer bugs BECAUSE its generation takes five rounds, and says so.
 */
declare const RULED_GENERATION_CONCURRENCY = 8;
/** A changed file, its changed lines, and the classic surface those lines carry. */
interface PoolTargetScope {
    /** repo-relative path */
    file: string;
    /** inclusive [start, end] changed line ranges - the placement surface the prompt lists */
    ranges: ReadonlyArray<readonly [number, number]>;
    /** distinct classic mutation sites on those changed lines - the sizing surface */
    classicSites: number;
    /**
     * Distinct PARSER-DERIVED mutation sites on this file's changed lines that no test executes.
     *
     * THE OTHER HALF OF THE SAME SURFACE (Kenneth, 2026-08-30), counted by `uncovered-sites.ts`
     * because the classic engine cannot: it does not mutate a line no test runs, so those sites are
     * absent from the mutant list `classicSites` is deduplicated out of. They are added to the ask
     * under the same lambda and the same floor.
     *
     * DISJOINT FROM `classicSites` BY CONSTRUCTION, and the caller is what keeps it so: this is
     * counted over the UNCOVERED changed ranges alone, and a classic site can only exist on a covered
     * one. Absent - not zero - on every caller that predates this, which is what leaves their plan
     * digests byte-identical.
     */
    uncoveredSites?: number;
    /**
     * The uncovered changed line ranges themselves, for the layer that has to tell one of this file's
     * planted bugs from another after they have run.
     *
     * THEY SIZE NOTHING - `uncoveredSites` above is what the law reads, and these are the lines that
     * count was taken over. They travel so the pool can answer which of its verdicts came off an
     * unexecuted line and keep exactly those out of the rate; nothing about the ask, the placement or
     * the prompt reads them, which is why they are NOT in the plan digest.
     */
    uncoveredRanges?: ReadonlyArray<readonly [number, number]>;
    /**
     * An explicit ask for this file, for a caller with no change to size against.
     *
     * THE OVERNIGHT LANE'S SEAM, and nobody else's. The night plants beyond the diff - it hunts whole
     * files the sweep found the suite fighting back on - so it has no changed lines, no site count and
     * therefore nothing the sizing law can read. Rather than feed the law a fabricated surface, the
     * night states its own per-file number. A target that carries one also carries no ranges, and a
     * pool with no ranges anywhere makes no coverage claim, because there is no change to claim
     * coverage of.
     */
    attempts?: number;
    /**
     * The spans this file's suite is PROVEN blind to, one entry per proof (architecture E).
     *
     * THEY SIZE NOTHING. The law reads sites and attempts; an aim changes only WHERE the generator is
     * asked to look, so a file with one earns exactly the attempts it would have earned without it.
     * They travel through the plan for one reason: a pool generated with an aim answered a different
     * question from one generated without it, so the aim belongs in the plan digest that keys the pin.
     * Absent leaves the digest byte-identical to what it was before E.
     */
    aims?: readonly BugPoolAim[];
    /**
     * The mutants the free deterministic pass already planted in this file, this run.
     *
     * THEY SIZE NOTHING EITHER, for the aim block's reason exactly: the law reads sites and attempts.
     * They travel with the scope because they change the QUESTION the generating call is asked - see
     * `catalogDigest` - and the caller that ran the pass is the only layer that knows them.
     */
    classicPlanted?: readonly ClassicPlantedMutant[];
}
/** The minimum of a classic mutant this module reads. Anything wider is the caller's business. */
interface ClassicMutantLocation {
    file: string;
    startLine: number;
    endLine: number;
    startColumn?: number;
    endColumn?: number;
    origin?: string;
}
interface FileAttemptPlan {
    file: string;
    classicSites: number;
    /** parser-derived sites on this file's unexecuted changed lines; 0 when the caller named none */
    uncoveredSites: number;
    /** attempts this file is funded for; 0 for a zero-site file and for one the allowance dropped */
    attempts: number;
    /** what the law asked for before the allowance was applied */
    requested: number;
    /** how many of this file's sites those attempts cover - `classicSites` unless the allowance bound */
    coveredSites: number;
    /** true when this file was asked for at all */
    funded: boolean;
}
interface PoolSizingPlan {
    /** every changed file, in the order the plan funded them */
    files: FileAttemptPlan[];
    /** M - distinct mutation sites this change put on changed lines, across every file */
    identifiedSites: number;
    /**
     * How many of `identifiedSites` sit on changed lines no test executes.
     *
     * A COMPONENT OF THE SAME DENOMINATOR, not a second one: the coverage claim is over the whole
     * change, and a site the classic pass could not reach is still a place this change can go wrong.
     * It is named separately because the verdicts it buys are guaranteed misses and are therefore
     * kept out of every rate - a reader of the plan should be able to see how much of the ask that
     * is. Zero on every change whose lines are all executed.
     */
    uncoveredSites: number;
    /** N - the sites on the files this run actually asked for; equals M when nothing was truncated */
    coveredSites: number;
    /** changed files nothing found a mutable site on, covered or not; they get no attempts */
    zeroSiteFiles: number;
    /** files the plan asked the generator for */
    filesFunded: number;
    /** attempts the law asked for across every file, before the allowance */
    attemptsRequested: number;
    /** attempts the plan funds */
    attemptsPlanned: number;
    /** the allowance's own ceiling on attempts */
    attemptCap: number;
    maxConcurrentGeneration: number;
    generationRounds: number;
    /** true exactly when the allowance stopped this plan short of every identified site */
    truncated: boolean;
    /**
     * Whether any target named changed lines at all.
     *
     * False is the overnight lane, which plants over whole files with no diff behind them. A pool with
     * no changed surface makes NO COVERAGE CLAIM: "covered 0 of 0 sites" on a night that planted
     * sixteen bugs would be a sentence about a change that does not exist.
     */
    hasDiffSurface: boolean;
    /**
     * The plan's identity, and the third component of the pool's pin key.
     *
     * A POOL SIZED BY THE DIFF IS NOT IDENTIFIED BY THE COMMIT ALONE. The same commit measured
     * against a different merge base has different changed lines, different sites and therefore a
     * different plan, and a key of (sha, promptVersion) would replay the pool generated for the other
     * base as though it answered this one. The digest closes that hole without touching per-commit
     * semantics: the pool is still generated once and replayed for every later run of the same commit
     * against the same base.
     */
    planDigest: string;
}
interface SizingPolicy {
    lambda: number;
    minAttemptsPerFile: number;
    wallAllowanceMs: number;
}
/**
 * Distinct classic mutation sites per file, on that file's changed lines.
 *
 * A SITE IS A LOCATION, NOT A MUTANT. Operator multiplicity at one location is exactly the 30x
 * artefact the site decomposition exists to remove, so mutants sharing a span collapse to one site.
 * Columns join the key when the engine reported them, because two mutable expressions can share a
 * line; a report without columns degrades to line granularity rather than refusing.
 *
 * ONLY THE DETERMINISTIC PASSES COUNT. `realistic` mutants are LLM-shaped and `error-path` mutants
 * are forced changed-handler ones - neither is the deterministic surface this law is derived from,
 * and counting them would size pool 2 partly against another model's output.
 */
declare function classicSitesByFile(input: {
    scopes: ReadonlyArray<{
        file: string;
        ranges: ReadonlyArray<readonly [number, number]>;
    }>;
    mutants: readonly ClassicMutantLocation[];
}): Map<string, number>;
declare function overlapsAnyRange(startLine: number, endLine: number, ranges: ReadonlyArray<readonly [number, number]>): boolean;
/**
 * The law itself, for one file: sites in, attempts out.
 *
 * `sites` IS THE WHOLE SURFACE - the classic pass's sites on the covered changed lines plus the
 * parser's on the unexecuted ones. One number because it is one law: an unexecuted line does not
 * earn a different lambda or a different floor, it earns the same attention for the same reason.
 */
declare function attemptsForFile(sites: number, policy: SizingPolicy, explicit?: number): number;
/** The sizing surface of one target: both halves of it, and the law reads nothing else. */
declare function sizingSitesOf(scope: Pick<PoolTargetScope, "classicSites" | "uncoveredSites">): number;
declare function validateSizingPolicy(policy: SizingPolicy): void;
/**
 * The whole plan: the law per file, then the allowance, then the identity.
 *
 * FUNDING ORDER IS THE RICHEST SURFACE FIRST, then the path, so the plan is a pure function of the
 * change and two runs of the same commit produce the same plan and therefore the same pin.
 *
 * A FILE WHOSE FULL ALLOCATION DOES NOT FIT IS FUNDED PARTIALLY, and then it covers only the sites
 * its attempts pay for - `floor(attempts / lambda)` of them. Dropping such a file whole would give a
 * single-file change with a large surface no pool at all, which is 29 of 29 of everything this
 * project has measured; partial funding turns the allowance into "covered N of M" instead, which is
 * the ruled behaviour. A remainder below the per-file floor buys nothing and funds nothing.
 */
declare function planPoolSizing(input: {
    scopes: readonly PoolTargetScope[];
    policy: SizingPolicy;
}): PoolSizingPlan;
/**
 * The largest number of equally-asked files this allowance funds IN FULL, at most `ceiling`.
 *
 * WHY A CALLER NEEDS THIS AND CANNOT JUST ASK FOR MORE. `planPoolSizing` funds the richest files
 * first and drops the tail, so a caller that sizes its selection by some other rule - the overnight
 * lane sizes it by money - can hand over more files than the allowance pays for and get FEWER bugs
 * than a smaller ask would have bought: each block of `RULED_GENERATION_CONCURRENCY` files costs
 * another generation round out of the same allowance, and the rounds eat the attempts. Sixty files
 * at the check run's twenty minutes fund one. So a caller with its own sizing rule asks this what
 * the allowance can carry and takes the smaller of the two numbers, which is what makes the two
 * sizing systems agree on one funded count instead of silently overruling each other.
 *
 * IT IS THE LAW ITSELF ANSWERING, not a rearrangement of it. The search runs `planPoolSizing` over
 * the very targets the caller would pass and accepts a size only when every one of them is funded in
 * full, so the answer cannot drift from what the pool then does with it.
 *
 * `attemptsPerFile` is the caller's own explicit per-file ask - the seam `PoolTargetScope.attempts`
 * exists for. This has nothing to say to a caller sizing against a diff, whose files each earn a
 * different number.
 */
declare function fundedFileCeiling(input: {
    attemptsPerFile: number;
    policy: SizingPolicy;
    /** never answer above this; the caller's own bound, so the search stays as small as the ask */
    ceiling: number;
}): number;
/**
 * The longest PREFIX of `attempts` this allowance funds IN FULL, in the caller's own order.
 *
 * THE VARIABLE-ASK FORM, and why one was needed. `fundedFileCeiling` answers a caller whose files
 * each ask for the same number. Since Kenneth's density ruling of 2026-08-15 the overnight lane's
 * files do not: each one's ask is sized to its own surface, so a selection of five files can be
 * cheaper or dearer than another five and no single per-file number describes it. This takes the
 * asks themselves, in the order the caller would hand them over, and answers how many of them fit.
 *
 * A PREFIX, NOT A SUBSET, because the caller's order is a rotation and re-ordering it would retire
 * files the night never planted in - the silent skip `hunt.ts` exists to prevent. The answer is the
 * cut point, and the caller keeps everything before it.
 *
 * THE SEARCH STOPS AT THE FIRST FAILURE, exactly as the equal-ask form does, and for the same
 * reason: the attempt cap never RISES with another file (generation rounds only grow) while the
 * running ask strictly does, so once the ask passes the cap it stays past it.
 *
 * IT IS THE LAW ITSELF ANSWERING. Each candidate prefix is run through `planPoolSizing` over the
 * very targets the caller would pass, and a prefix counts as funded only when the plan drops nothing
 * from it, so this answer cannot drift from what the pool then does with the same list.
 */
declare function fundedAskPrefix(input: {
    attempts: readonly number[];
    policy: SizingPolicy;
}): number;
/**
 * What the run actually covered, as the pin records it.
 *
 * IT IS STORED WITH THE POOL, NOT RECOMPUTED. The claim has to replay byte for byte with the bugs it
 * describes, and a file whose generation call failed is a file whose sites were identified and never
 * attempted - a fact only the generating run saw. Recomputing the claim from the plan on a later
 * replay would quietly promote those sites back to covered.
 */
interface PoolCoverage {
    /** M - distinct mutation sites this change put on changed lines, executed or not */
    identifiedSites: number;
    /** N - the sites this run asked the generator to cover */
    coveredSites: number;
    /** changed files nothing found a mutable site on, covered or not */
    zeroSiteFiles: number;
    /** every changed file the pool was given */
    filesIdentified: number;
    /** the files it asked for */
    filesCovered: number;
    /** attempts the sizing law funded across those files */
    attemptsPlanned: number;
    /** true exactly when some identified site went unattempted */
    truncated: boolean;
}
/**
 * The coverage claim, in one sentence, from the plan and nothing else.
 *
 * IT NAMES ITS SURFACE. The denominator is the deterministic engine's own site list on this change,
 * not the generator's opinion of how many places it found - a model asked to enumerate its own
 * denominator can make three sites read as completeness, and the cross-check that defuses that is
 * free because the classic list is already computed. When the allowance stopped the plan short the
 * sentence says what was not reached and refuses to read as a clean bill.
 */
declare function coverageClaimSentence(coverage: PoolCoverage): string;

declare const BUG_POOL_STORE_SCHEMA = "abloh-marigold-bug-pool/v2";
/**
 * A file version's identity: the digest of its exact bytes.
 *
 * THE BYTES, NOT A NORMALISATION OF THEM. A whitespace-insensitive digest would call two files the
 * same version when the model was shown two different texts, and every bug this pool stores is
 * located later by quoting source text back exactly (`locateBug`).
 */
declare function fileContentDigest(source: string): string;
/** One agent-written bug, exactly as generated - the unit the pin preserves. */
interface StoredAgentBug {
    /** structural digest over (file, originalText, replacement): the bug's cross-run identity */
    bugId: string;
    file: string;
    /** the exact source text the bug replaces; located by content, refused when ambiguous */
    originalText: string;
    replacement: string;
    /**
     * The category of mistake this bug simulates, in the generator's own two or three words.
     *
     * ASKED FOR, NEVER DERIVED - see `acceptBugType`. Absent on every bug pinned before prompt
     * version /4 and on any reply that wrote nothing usable, and the absence renders nothing rather
     * than a guessed category.
     */
    bugType?: string;
    /** the model's one-line intent note, kept local as prompt provenance */
    note?: string;
    /**
     * The test that demonstrates this bug - ABSENT UNTIL THE BUG SURVIVES A SUITE.
     *
     * OPTIONAL SINCE THE WITNESS WAS DEFERRED (2026-08-15). Planting no longer asks for witnesses: the
     * witness is 69% of a planting call's payload and most of its reasoning, and a bug the suite
     * catches never needed one, so it is written afterwards and only for survivors (`pool.ts`).
     * A bug pinned before that carries its witness here and is replayed with it, which costs nothing
     * and skips the witness call it already paid for.
     *
     * LOCAL ONLY - a witness body is model-written test source and never egresses.
     */
    witness?: {
        testName: string;
        testBody: string;
    };
    /**
     * What the witness call said ABOUT the bug, written in the same reply as the test.
     *
     * Stored beside the witness and for the same reason: a survivor replayed from its file version
     * skips the witness call entirely, so a diagnosis held only in the run's memory would vanish on
     * the next visit and the lane would fall back to its templates. Absent on every bug pinned before
     * prompt version /9 and on any reply that wrote nothing usable.
     */
    diagnosis?: BugDiagnosis;
}
interface StoredBugPool {
    sha: string;
    promptVersion: string;
    /**
     * The sizing plan's digest - the third component of the key.
     *
     * Absent on every pool pinned before the sizing law landed. Those pools were generated at a flat
     * count with no plan at all, so they are looked up by (sha, promptVersion) exactly as they always
     * were and a new lookup never matches one: prompt version /3 is a different generator.
     */
    planDigest?: string;
    /**
     * What this pool covered of the change's identified sites, as the generating run saw it.
     *
     * PINNED WITH THE BUGS. The check run's coverage sentence is made of these numbers, so they have
     * to replay with the pool rather than be recomputed later: a file whose generation call failed is
     * a file whose sites were identified and never attempted, and only the run that made the call
     * knows that. Absent on pools pinned before the sizing law.
     */
    coverage?: PoolCoverage;
    /** the model identity that generated this pool, for the disclosure's provenance line */
    model: string;
    /** reply entries generation refused by name at generation time; recorded so replays disclose it */
    generationRefused: number;
    /**
     * When this pin stops being kept, stamped by the store from the custody it was opened under.
     *
     * NOT SUPPLIED BY THE CALLER, deliberately. A deadline a writer passes in is a deadline a writer
     * can leave out, and the whole defect this closes was source text stored under no policy.
     */
    deleteAfter: string;
    bugs: StoredAgentBug[];
}
/**
 * A bug the overnight lane graduated into this repository's pool through the promotion protocol.
 *
 * NOT PINNED TO A COMMIT, and that is the whole point of graduating: a generated pool answers one
 * commit, while a graduated bug is a weak spot worth re-checking at every commit until the code it
 * touches changes. It self-invalidates without any expiry rule, because `locateBug` finds it by its
 * exact original text and refuses with `text-not-found` once that text is gone.
 *
 * STILL RE-PROVEN EVERY RUN. Graduation grants a bug a seat in the pool, never a verdict: it goes
 * through the same witness proof and the same live suite execution as a freshly generated one. A
 * previous night's proof is evidence about a previous night.
 */
interface GraduatedBug extends StoredAgentBug {
    /**
     * When this weak spot stops being kept, stamped by the store. Re-graduating refreshes it, because
     * a re-proof rewrites the entry - and a rolling window runs from the write, not from the
     * discovery, which is why `graduatedOnNight` beside it is deliberately NOT refreshed.
     */
    deleteAfter: string;
    /** the commit the lane proved it at */
    graduatedAtSha: string;
    /** the lane's own night counter, for the morning report and for ordering */
    graduatedOnNight: number;
    graduatedAtMs: number;
    /**
     * The replay round this entry was last re-checked in, absent until it has been re-checked once.
     *
     * THIS IS THE ROTATION RAIL, and it is the reason the ceiling stopped shedding weak spots. The
     * pool takes at most `graduatedCeiling` graduated members into one run; while the set was ordered
     * newest-night-first and truncated, the ninth weak spot a repository graduated was dropped from
     * every later run in silence, and the page went on saying each of them was checked on every run
     * (`data/abloh-night3/report.md`). Stamping what was re-checked turns the truncation into a
     * rotation: the stalest members go first, so every one of them comes round inside
     * ceil(carried / ceiling) runs however many there are.
     *
     * COUNTED IN ROUNDS, NOT DATED, for the same reason `reuses` is: a clock would make the pool's
     * composition depend on when a run happened, and the pool is a pure function of the store and the
     * change. A round is one pool run that took graduated members.
     */
    lastReplayedRound?: number;
}
/**
 * RULED N=4 (Kenneth, 2026-08-15). How many visits an unchanged file may replay its stored pool
 * before it earns one fresh generation.
 *
 * The report proposed 3 to 5 as the band that keeps almost all of the saving while preserving
 * re-sampling, and registered the number itself as Kenneth's (`content-pool-decay`). At 4, a file
 * visited every night is regenerated on one night in five: the steady-state planting bill is a fifth
 * of what memoising nothing costs, and the model still gets to draw a different part of the mutant
 * space out of the same source text five times a month rather than once ever.
 */
declare const CONTENT_POOL_REUSE_LIMIT = 4;
/**
 * One file version's pool, keyed by what the model was actually shown.
 *
 * THE ASK IS PART OF THE KEY. A file planted for 3 attempts and a file planted for 8 are different
 * questions with different answers, and replaying the 3-bug pool for an 8-bug ask would silently
 * under-deliver a plan that had funded more.
 */
interface StoredFilePool {
    /** sha256 of the file's exact bytes as the generating run read them */
    contentDigest: string;
    promptVersion: string;
    /** how many bugs the generating call was asked for */
    ask: number;
    /**
     * The aim block's identity, when the generating call carried one (architecture E).
     *
     * ABSENT MEANS UNAIMED, which is every entry written before 2026-08-15 and every run with no
     * proven blind spot to name. It is part of the key because an aimed ask and an unaimed ask over
     * the same bytes are different questions: replaying the unaimed pool for an aimed ask would report
     * E as having run while delivering exactly the pool it was meant to replace, which is the one way
     * this architecture could look like it worked without ever running.
     */
    aimDigest?: string;
    /**
     * The identity of the /11 catalog and domain material the generating call carried.
     *
     * ABSENT MEANS NEITHER BLOCK, which is every entry written before 2026-08-27 and every caller
     * that runs no classic pass and finds no domain signal. It is part of the key for the aim
     * digest's own reason, restated in `catalogDigest`: this material is NOT derived from the file's
     * bytes, so the content digest cannot notice when it moves.
     */
    catalogDigest?: string;
    /**
     * The repo-relative path this pool was planted for, and PART OF THE KEY.
     *
     * IT WAS NOT, and the comment here used to say so ("for the store's own readability; never part
     * of the key"). The key was the file's bytes and nothing about where they were, while every bug
     * in `bugs` carries the path it was planted for - so two byte-identical files shared one entry
     * and the second one to be visited replayed bugs naming the first one's path. On a composed run
     * that is a whole package losing its AI-planted pool: the witness placement handed the measured
     * package's runner a spec under a SIBLING package's directory, `SpecNotFoundError` refused, and
     * the pool the ruling of 2026-08-14 makes mandatory did not exist for that package
     * (`data/abloh-manifest-smoke-3/report.md`, finding K).
     *
     * IT COSTS NO REUSE. What the content key buys is a file whose bytes have not moved since its
     * last visit not being re-planted, and that file is at the same path both times. What the path
     * stops is a DIFFERENT file spending an answer computed for somebody else's path - which is not a
     * saving, it is a wrong pool.
     *
     * A REPOSITORY-WIDE STORE IS WHY IT BELONGS IN THE KEY RATHER THAN AROUND IT. One store serves
     * every package of a composed run, and even a per-package store would still collide on two
     * identical files inside one package.
     */
    file: string;
    model: string;
    generationRefused: number;
    /**
     * Visits served from this entry since it was written.
     *
     * COUNTED, NOT DATED. A decay in nights would drift with how often the repository is hunted and
     * would expire an entry that was never reused; a decay in visits spends exactly what it saved.
     */
    reuses: number;
    /** when this file version's pool stops being kept, stamped by the store */
    deleteAfter: string;
    bugs: StoredAgentBug[];
}
interface BugPoolStoreData {
    schema: typeof BUG_POOL_STORE_SCHEMA;
    pools: StoredBugPool[];
    /** commit-independent members, added by the overnight lane; absent in stores written before it */
    graduated?: GraduatedBug[];
    /**
     * How many replay rounds the graduated set has been through. Absent before the rotation existed,
     * where it reads as zero and every entry is equally stale - which is the migration: the first run
     * after this lands orders on `graduatedOnNight` exactly as the old truncation did.
     */
    graduatedReplayRound?: number;
    /**
     * Per-file-version pools, the content-addressed key. Absent in every store written before
     * 2026-08-15, which is exactly the read-through migration: those stores keep answering commit
     * lookups from `pools` above and simply have nothing to answer a content lookup with.
     */
    filePools?: StoredFilePool[];
}
/** What a content lookup answered, and what the caller owes the store for it. */
type ContentPoolLookup = 
/** replay these bugs; the visit has already been counted against the decay */
{
    state: "replay";
    entry: StoredFilePool;
}
/** the file version is known but has spent its reuses: generate once, then the count resets */
 | {
    state: "decayed";
    entry: StoredFilePool;
}
/** never planted at this content, prompt version and ask */
 | {
    state: "absent";
};
/**
 * Where one repository's working copy sits under a state directory.
 *
 * EXPORTED FOR THE CUSTODY SEAM AND FOR NOTHING ELSE. The night has to plant a file here before the
 * run and remove it afterwards, and a caller that computed the name itself would be a second place
 * that decides what a pin store is called.
 */
declare function bugPoolStorePath(storeDir: string, repoKey: string): string;
declare class BugPoolStore {
    #private;
    private constructor();
    /**
     * A corrupt or wrong-schema file is no store at all: the pool regenerates, never guesses.
     *
     * AND AN EXPIRED ENTRY IS NOT A STORE EITHER. Every entry past its deadline is dropped here,
     * before a single lookup can be answered from it, so an expired pin cannot be replayed and cannot
     * be disclosed. The drop is in memory until `save()`; a night that reads and never writes leaves
     * the file alone, and the next write is what removes the bytes.
     */
    static open(storeDir: string, repoKey: string, custody?: EvidenceCustody): BugPoolStore;
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
    static plantWorkingCopy(storeDir: string, repoKey: string, data: BugPoolStoreData | null): void;
    /**
     * What the working copy holds now, for the sync that sends it back - or null when it holds nothing.
     *
     * NOT `open().data`, deliberately. `open` purges expired entries in memory, and the sync must send
     * what the night actually wrote rather than a filtered view of it; the control plane runs the same
     * purge under the same window on its own rows, so filtering twice would only hide a disagreement
     * between the two if there ever were one.
     */
    static readWorkingCopy(storeDir: string, repoKey: string): BugPoolStoreData | null;
    /** Remove the working copy from this host. Nothing there is not an error - it is the goal. */
    static clearWorkingCopy(storeDir: string, repoKey: string): void;
    get data(): BugPoolStoreData;
    /** The deadline this store stamps on anything written right now. */
    get deleteAfter(): string;
    lookup(sha: string, promptVersion: string, planDigest?: string): StoredBugPool | null;
    /** The commit-independent graduated members, newest night first. */
    graduated(): GraduatedBug[];
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
    graduatedStalestFirst(): GraduatedBug[];
    /** Which round the graduated set has reached; zero before any run took a member. */
    graduatedReplayRound(): number;
    /**
     * Record that these members were re-checked, as one round, and answer the round it counted as.
     *
     * ONE ROUND PER RUN, not one per member: the point of the number is to say who has waited longer
     * than whom, and a per-member stamp would make a run that took eight members eight rounds old.
     * The caller still has to `save()`, exactly as it does for the content decay.
     */
    markGraduatedReplayed(bugIds: readonly string[]): number;
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
    graduate(bug: Omit<GraduatedBug, "deleteAfter">): void;
    /**
     * Look up one file version's pool and SPEND a reuse if it answers.
     *
     * The spend happens here rather than at the call site because the two must not drift: a lookup
     * that replays without counting is a file that never decays, and a count taken somewhere else is a
     * count that a `continue` can skip. The caller still has to `save()`.
     */
    lookupByContent(key: {
        contentDigest: string;
        promptVersion: string;
        ask: number;
        file: string;
        aimDigest?: string;
        catalogDigest?: string;
    }): ContentPoolLookup;
    /**
     * Record what one file version's generation produced, under its content key.
     *
     * Re-recording the same key replaces it and RESETS the reuse count, which is what makes the decay
     * a cycle rather than a one-off: the fresh generation an exhausted entry earned becomes the entry
     * the next four visits replay.
     */
    recordByContent(entry: Omit<StoredFilePool, "reuses" | "deleteAfter">): void;
    /**
     * Attach a proven witness to a stored bug wherever the store holds it.
     *
     * WHY THE STORE LEARNS IT. Under the deferred witness a survivor pays a model call for its test,
     * and a survivor replayed from a content key would survive again and pay again every visit -
     * which would hand back the saving the deferral just bought. Writing it down once makes the second
     * visit free. It changes nothing about proof: the witness is still executed live, both sides, on
     * every run that replays it.
     */
    attachWitness(bugId: string, witness: {
        testName: string;
        testBody: string;
    }, diagnosis?: BugDiagnosis): void;
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
    detachWitness(bugId: string): void;
    /** Record a freshly generated pool. Re-recording the same key replaces it - the pin is singular. */
    record(pool: Omit<StoredBugPool, "deleteAfter">): void;
    /**
     * PRIVATE AND ATOMIC, because this file holds a customer's original source, the replacement that
     * was planted into it, and the witness test written against it (junction audit rank 8). It used
     * to be written with the ambient umask, which is `0644` on the measured default - readable by
     * every account on the host and by every other job sharing a CI runner. The rename also means a
     * half-written store can never be read as a corrupt one, which for this store would throw away a
     * night of model spend.
     */
    save(): void;
}

/** One module a witness may import, with the names it really offers. */
interface WitnessModule {
    /** repo-relative POSIX path of the module */
    file: string;
    /** the specifier a test at the witness file imports it with - computed here, never guessed */
    specifier: string;
    /** the names this module exports, sorted; cut at `MAX_EXPORTED_NAMES` when there are more */
    exportedNames: string[];
    /** the name bound to its default export, when it has one that can be named */
    defaultExportName: string | null;
    /** true when `exportedNames` was cut, so the prompt can say so rather than imply completeness */
    truncated: boolean;
}

/**
 * How many of the file's own imported modules are read for types and constants.
 *
 * Six. A source file that reaches for more than six first-party modules is a composition root, and
 * the seventh module's type barrel says less about what this file means than the first one's did.
 */
declare const MAX_DOMAIN_MODULES = 6;
/** A module larger than this is skipped rather than read; it is generated or a bundle. */
declare const MAX_DOMAIN_MODULE_CHARS = 96000;
/** How many type declarations the block may carry, across every module. */
declare const MAX_DOMAIN_TYPES = 8;
/** How long one type declaration may be before it is dropped rather than cut in half. */
declare const MAX_DOMAIN_TYPE_CHARS = 900;
/** How many named constants the block may carry, across every module. */
declare const MAX_DOMAIN_CONSTANTS = 16;
/** How long one constant's printed value may be before the constant is dropped. */
declare const MAX_DOMAIN_CONSTANT_CHARS = 120;
/** How many README paragraphs may survive the relevance gate. */
declare const MAX_README_FRAGMENTS = 3;
/** How long one README paragraph may be before it is cut with a marker. */
declare const MAX_README_FRAGMENT_CHARS = 600;
/**
 * The shortest exported name that may pull a README paragraph in.
 *
 * FOUR, AND THE NUMBER WAS MEASURED RATHER THAN CHOSEN. The first version of this gate accepted any
 * exported name as a substring anywhere in a paragraph. Run over 400 real source files of this
 * repository (the check `verifying-rules.md` asks for, before the rule ships rather than after), it
 * attached README prose to 26 of them and the hits were mostly noise: `apps/api/src/auth.ts` drew a
 * paragraph about deterministic mutation operators, because some short export of its own occurs
 * inside an unrelated word. A domain block that quotes the wrong paragraph is worse than one that
 * quotes none - it tells the planter this file is about something it is not.
 *
 * The length floor and the word boundary in {@link mentions} are one rule in two parts: a needle
 * must be long enough to be a name and must appear as a name rather than inside another word.
 */
declare const MIN_README_NEEDLE = 4;
/** How many customer-supplied invariants are carried. Past this the caller is writing a document. */
declare const MAX_DOMAIN_INVARIANTS = 12;
/** How long one customer-supplied invariant may be before it is dropped rather than cut. */
declare const MAX_DOMAIN_INVARIANT_CHARS = 300;
/** One constant this file's neighbourhood names, and the value it was given. */
interface DomainConstant {
    /** the module it is declared in, repo-relative */
    file: string;
    name: string;
    /** the initializer as written, when it is short enough to be a value rather than a program */
    value: string;
}
/** One type declaration this file's neighbourhood carries, as written. */
interface DomainType {
    file: string;
    declaration: string;
}
/**
 * What the planting call is told about the meaning of the code it is mutating.
 *
 * EVERY FIELD MAY BE EMPTY, AND EMPTY IS A STATEMENT. A repository with no types, no constants
 * module and no README says nothing here, and the prompt then carries no domain block at all rather
 * than a heading over nothing.
 */
interface DomainContext {
    types: readonly DomainType[];
    constants: readonly DomainConstant[];
    /** README paragraphs that mention this file or a name it exports, nearest README first */
    readme: readonly string[];
    /** the customer's own rules, verbatim - see `domainInvariants` in the policy */
    invariants: readonly string[];
}
declare const EMPTY_DOMAIN_CONTEXT: DomainContext;
/** True when the context carries nothing at all, so the prompt can leave the block out entirely. */
declare function isEmptyDomainContext(context: DomainContext): boolean;
/**
 * `export const NAME = <initializer>` from a module, for initializers that are values.
 *
 * A LITERAL OR A SHORT EXPRESSION, NEVER A PROGRAM. What this block is for is the DECIDED VALUE
 * behind a name - `MINUTE_MS = 60_000` is the whole point and `handlers = buildHandlers(registry)`
 * is a call whose value this module cannot know. So the initializer is taken only up to the end of
 * its line and only when it is short; anything longer is a constant whose value is not readable
 * here, and printing half of it would print a value the module does not have.
 */
declare function constantsIn(source: string, file: string): DomainConstant[];
/**
 * The README paragraphs that talk about this file.
 *
 * TWO GATES, AND BOTH ARE NEEDED. The first is the WALK: the nearest README from the file's own
 * directory up to the repository root, so a monorepo package's README beats the root's marketing
 * one. The second is RELEVANCE: within that file, only paragraphs naming this module or one of the
 * names it exports. A README passed whole would spend hundreds of tokens telling a planting call
 * how to install the repository.
 *
 * HEADINGS AND FENCES ARE DROPPED. A heading carries no sentence, and a fenced block is source -
 * which this prompt already has more of, in the file itself, and better placed.
 */
declare function readmeFragments(input: {
    repoDir: string;
    targetFile: string;
    source: string;
}): string[];
/**
 * The domain signals around one file, all of them bounded.
 *
 * THE WALK IS THE RELEVANCE GATE. Types and constants come only from modules this file's own import
 * statements name and that resolve to a file inside the repository. That is one hop and no further:
 * a two-hop walk would reach the whole dependency graph, which is a description of the repository
 * rather than of this file.
 */
declare function collectDomainContext(input: {
    repoDir: string;
    targetFile: string;
    source: string;
    /** the customer's own rules, from the policy; carried verbatim */
    invariants?: readonly string[];
}): DomainContext;
/**
 * The domain block, appended like every other rule block in this prompt.
 *
 * IT STATES WHAT IT IS AND WHAT IT IS NOT. The signals here are read off the repository by pattern
 * matching, not by a compiler, so the block says the list is a sample. A model told these are all
 * the types would read an absent one as proof that a value has no declared shape, which is the same
 * closed-world mistake the `/5` module list made and the `/8` fix-forward corrected.
 *
 * THE CUSTOMER'S INVARIANTS ARE SET APART, because they are the one part of this block a person
 * asserted rather than a scanner derived, and a bug that breaks a rule the customer wrote down is
 * worth more than one that breaks a rule nobody has stated.
 *
 * NOTHING TO SAY MEANS NO BLOCK, and the prompt is then byte-identical to one built without it.
 */
declare function domainBlock(entries: ReadonlyArray<{
    file: string;
    domain: DomainContext;
}>): string[];

/**
 * Pool-2 generation: the model writes the bugs, once per file version.
 *
 * TWO ENTRY POINTS SINCE 2026-08-15, because the pipeline has two questions and they are asked at
 * different times:
 *
 *   `generateBugPool`  where a realistic mistake could hide, and what it is. Once per file version.
 *   `generateWitness`  how to demonstrate ONE bug. After the suite, only for a bug it missed.
 *
 * The split is the deferred-witness architecture: the witness was 69% of a planting call's payload
 * and most of its reasoning, and roughly two bugs in three are caught by the suite and never needed
 * one. Measured, removing the witness ask cut a planting call by 55-64% at the same bug count.
 *
 * Every call routes through the engine's model policy - the Azure endpoint from the environment,
 * a model from the allowed family - via the same `ModelClient` the loop uses. The reply is one
 * JSON object CONSTRAINED BY A SCHEMA the endpoint enforces; parsing is still strict and its
 * failures are still named, and the call is re-asked ONCE carrying the failure text (the same
 * mechanism-improving retry `generateBatch` uses).
 *
 * A BUG PROPOSAL IS A CLAIM, NOT A BUG. What comes back here has proven nothing: it becomes a bug
 * only after the witness proof in pool.ts shows its witness test passes on the real source and
 * fails once the bug is applied. Generation's own refusals (no file, empty replacement, identical
 * replacement) are named and disclosed rather than silently dropped.
 */

/**
 * The generator's identity, and half the pin key.
 *
 * BUMPED TO /11 ON 2026-08-27 for SMARTER PLANTING, Kenneth's ruling of the same day. Three changes
 * arrive together and they are one change: stop paying a model to write what a free pass already
 * writes, and give it what it needs to write something else.
 *
 *  - THE ASK IS SEMANTIC NOW. The five worked examples the ask carried - off-by-one, swapped
 *    operand, wrong boundary, dropped condition, wrong early return - are five names for edits the
 *    deterministic pass performs for nothing, on the same changed lines, before this call is made.
 *    A prompt whose only examples are those five is a prompt asking a model to duplicate the free
 *    arm. They are replaced by the classes classic cannot express at all: wrong order of operations,
 *    a semantic swap of two same-typed values, unit confusion, a plausible-but-wrong formula, a
 *    dropped or reordered await, error-path rot, a legal-but-wrong state transition, and one code
 *    path forgetting an invariant the others keep. Several of those need more than one statement to
 *    write, so the ask now says multi-statement edits are welcome where it used to imply otherwise.
 *  - THE NEGATIVE CATALOG. `negative-catalog.ts` states what the free pass covers, as the operator
 *    set that pass really runs and as the mutants it really planted in this file this run, and
 *    forbids anything expressible by them. Read that module for why it is mechanical rather than a
 *    list of English labels, and for why the rule is expressibility and never edit size.
 *  - THE DOMAIN BLOCK. `domain-context.ts` carries the imported types, the reachable constants, the
 *    README fragments about this file, and any invariants the customer wrote down. Without them the
 *    new ask is unanswerable: a model cannot confuse a unit it was never shown, and cannot swap two
 *    values whose meanings it has to guess.
 *
 * THE BUMP IS REQUIRED, for /9's and /10's reason exactly: the ask is inside the pin key, so a /10
 * pool replayed under this prompt would be reported as bugs written against the new ask when they
 * were written against the old one. /10's pins stay addressable beside /11's.
 * BUMPED TO /10 ON 2026-08-18 for the ACCOUNT and the CALIBRATED RUBRIC, Kenneth's authorization of
 * the same day. Three things move together, and all three exist to put the two lanes on one scale:
 *
 *  - THE ACCOUNT. The witness reply now carries `about`, three paragraphs answering what the bug is,
 *    how it would be encountered and what happens if it ships. Until now this lane's "About this bug"
 *    was one sentence - `consequence` - while the mechanical lane's had been three paragraphs since
 *    prompt p10. Same three questions, same 800-character ask, same guard: the account travels
 *    through `sanitizeFindingAbout`, the mechanical lane's own, so one section drawn by one component
 *    from two producers cannot be bounded by two different rules.
 *  - THE MONEY FLOOR in the severity rubric, word for word from prompt p11. A repeat pass over nine
 *    real mechanical gaps found a silently wrong checkout total grading `low` on one of three passes
 *    because its reach was a single boundary value; a witness call grading the same shape of bug must
 *    not be free to do what the mechanical lane is now forbidden.
 *  - THE LIBRARY SENTENCE in paragraph two, also p11's, for the case where the file shows no entry
 *    point at all and a route paragraph can only repeat itself.
 *
 * The bump is required rather than cosmetic, for /9's reason exactly: the witness ask is inside the
 * pin key, so a /9 pool replayed under this prompt would attach witnesses with no account and the
 * lane would silently keep the single sentence. /9's pins stay addressable beside /10's.
 * BUMPED TO /9 ON 2026-08-17 for the WITNESS DIAGNOSIS, Kenneth's ruling from the findings-surfaces
 * review. The witness call now returns five bounded fields beside the test it already wrote: whether
 * the behaviour the bug broke is one the code PROMISES or is merely incidental, one sentence saying
 * how somebody meets the bug, why the suite did not fail, what a reader should worry about, and a
 * graded severity with its basis. Every one of them lands on the AI lane's finding page, which
 * carried two model-written fields against the mechanical lane's five and filled the rest with
 * templates - "your N tests ran against this change and passed" was the same sentence under every
 * finding in the queue. The bump is required rather than cosmetic: the witness ask is inside the pin
 * key, so a /8 pool replayed under this prompt would attach witnesses with no diagnosis and the
 * lane would silently keep its templates. See `buildWitnessPrompt` for what each field may say and,
 * more importantly, what it may not.
 * BUMPED TO /8 ON 2026-08-15 for the WIDENED IMPORT RULE, Kenneth's fix-forward ruling on the yield
 * regression the luna experiment caught (`data/abloh-luna-stage2/report.md` section 6). `/5`'s form
 * of the anti-invention rule - "never an import you have not been shown", over a list built from the
 * repository's MOST-imported modules - forbade exactly the imports a working witness on these
 * targets needs: the pinned `gpt-5.6-terra` planter obeyed it and returned `{"bugs":[]}` after
 * 10,168 reasoning tokens on two items that prove 6 of 6 and 8 of 8 bugs, and produced nothing at
 * all on four of ten. The rule now permits two classes the list cannot enumerate - any source file
 * of this repository by relative path, and the packages the repository's own test files import -
 * while the half that closes D3 is unchanged: on a module that IS listed, only the names it is shown
 * to export. See `witness-modules.ts` for how each class is derived and `pool2-witness-imports.test.ts`
 * for both killed shapes reproduced. THE AIM BLOCK IS UNTOUCHED by this bump: it lives in the
 * planting ask and this rule lives in the witness ask, and /7's pins stay addressable beside /8's.
 * BUMPED TO /7 ON 2026-08-15 for the AIM BLOCK: architecture E, negative-space planting. When the
 * caller can name spans the suite is PROVEN blind to - a mechanical mutant of those lines ran and
 * nothing failed - the prompt now lists them, quoted and numbered like the placement block, and asks
 * the generator to spend its bugs there first. The claim behind the block is a demonstration and not
 * a prediction, which is the distinction the architecture rests on: the pipeline used to write bugs
 * and hope some escaped, and on the maiden night 22 of 32 were caught and produced a green tick and
 * nothing else. `aimBlock` below carries what the block says, where each kind of proof comes from,
 * and why it never overrides the placement rule. A run with no proven spans emits NO block, and its
 * prompt is byte-identical to /6's - E is a pure addition when it has nothing to aim at.
 * BUMPED TO /6 ON 2026-08-15 for two changes made together, both from the cost-mechanics report:
 *
 *  - THE WITNESS ASK IS GONE from planting. The witness is 69% of a planting call's delivered
 *    payload and most of its reasoning, and measured on two real files, removing the ask cut the
 *    call by 64% and 55% while delivering the same eight bugs, all locatable exactly once. A bug the
 *    suite catches never needed a witness at all, so witnesses are now written afterwards and only
 *    for survivors - see `buildWitnessPrompt` below and the route in `pool.ts`.
 *  - THE REPLY IS SCHEMA-CONSTRAINED. `response_format: {type: "json_schema", strict: true}` is
 *    accepted by this endpoint and cut one real call by a further 22%. It also makes the
 *    `empty-original-text` and `replacement-identical` refusal classes structurally impossible
 *    rather than merely rare, and removes the `unparseable` re-ask path.
 *
 * Both are disclosed by this label, which is the point of the label: a prompt change is a new
 * generator, and every /5 pin stays untouched beside the new ones rather than being reinterpreted.
 * BUMPED TO /5 ON 2026-08-15 for the export block: the prompt now names every module the witness may
 * import and the names each one really offers, and forbids importing anything else (D3 of the
 * official benchmark - the witness that needed a second module invented its API, `createEvent` from
 * an h3 entry that does not export it, and three items across three trials lost their whole pool to
 * that shape). `witness-modules.ts` carries how the list is built and why it is neither of the
 * report's two candidate fixes alone.
 * BUMPED TO /4 ON 2026-08-15 for the bug TYPE: every proposal now names the category of mistake it
 * simulates in two or three words, and that phrase is carried all the way to the customer's finding
 * row (Kenneth: "tell the AI planting bug model to show a type"). It is asked for rather than
 * inferred here because only the generator knows what it meant to write - a category guessed from
 * the replaced text afterwards would be our claim about their bug, and this surface states nothing
 * a machine did not establish. A bug that arrives without one is still a bug; the type is decorative
 * and its absence renders nothing.
 * BUMPED TO /3 ON 2026-08-15 for the placement rule: the prompt now carries each file's changed
 * line ranges and requires every bug's `originalText` to overlap one of them (Kenneth's ruling, from
 * the A/B that put 207 of 207 bugs on a changed line against the shipped prompt's 28 of 208).
 * BUMPED TO /2 ON 2026-08-14 for the public-API rule added to the witness specification below. A
 * prompt change is a new generator: leaving the label alone would put two different generators
 * behind one pin, which is the exact silent rewrite of history the store's key exists to prevent.
 * Every older pin stays untouched beside the new ones, so nothing already measured changes its
 * answer.
 */
declare const BUG_POOL_PROMPT_VERSION = "marigold-bug-pool/11";
declare const BUG_POOL_TASK = "bug-pool-generation";
/** The second, smaller call: one witness for one survivor. Named apart so a ledger can see it. */
declare const BUG_WITNESS_TASK = "bug-pool-witness";
/**
 * The pool's knobs, ALL EXPLICIT AND REQUIRED - the stage-2 discipline, applied here. Construction
 * refuses a missing number, so nothing of ours can quietly become the shipped value; the values
 * callers write down live in `RULED_AGENT_BUG_POOL_POLICY` below.
 */
interface AgentBugPoolPolicy extends SizingPolicy {
    /**
     * Ceiling on overnight-lane members riding this run's pool.
     *
     * SEPARATE FROM THE SIZING LAW, because a graduated bug is not sized by this change: it is a weak
     * spot from a previous night that rides every commit until its own source text moves. This is the
     * bound the flat `maxBugs` used to serve for them, kept at the same value and renamed for what it
     * actually bounds now that the generated pool is sized from the diff.
     */
    graduatedCeiling: number;
    /** wall for one witness execution */
    targetedTimeoutMs: number;
    /** wall for one whole-suite execution against a proven bug */
    suiteTimeoutMs: number;
}
declare function validateAgentBugPoolPolicy(policy: AgentBugPoolPolicy): void;
/**
 * The values callers write down, named for their provenance rather than hidden inside the pool -
 * the same shape as stage 4's `RULED_SLICE_POLICY`.
 *
 * RULED 2026-08-15. The flat eight per commit is gone: `lambda` and `minAttemptsPerFile` are the
 * sizing law's ruled constants and `wallAllowanceMs` is the twenty minutes Kenneth gave the pool of
 * one check run - each carries its derivation in `sizing.ts`. `graduatedCeiling` keeps the old flat
 * value where it still belongs, over the overnight lane's commit-independent members. The timeouts
 * match the loop's own walls.
 */
declare const RULED_AGENT_BUG_POOL_POLICY: AgentBugPoolPolicy;
interface BugPoolTarget {
    /** repo-relative path of a file the pool may plant bugs in (the diff's changed files) */
    file: string;
    source: string;
    /** where this file's witness will be written, so its imports are relative to a known location */
    witnessFile: string;
    /** the specifier a test at `witnessFile` uses to import `file` - computed, never guessed */
    importSpecifier: string;
    /**
     * This file's changed line ranges, inclusive [start, end] - the placement surface.
     *
     * THE WHOLE FILE STAYS IN THE PROMPT (the ruled lesson). What was rejected is generating without
     * full-file context; what this adds is which part of that file the change touched. The model still
     * reads everything and is simply told where to aim.
     */
    changedRanges: ReadonlyArray<readonly [number, number]>;
    /**
     * Every module this file's witness may import, with the names each one really exports.
     *
     * REQUIRED, AND EMPTY IS A STATEMENT. An empty list says the repository showed us nothing - no
     * target on disk, no test importing anything relative - and the prompt then says nothing about
     * imports rather than a silent half-truth. A caller that has not looked has to write `[]` down.
     *
     * IT IS A SAMPLE, NOT A CENSUS, and since 2026-08-15 the prompt says so. See `dependencies` below
     * and the widened rule in `buildWitnessPrompt`.
     */
    modules: readonly WitnessModule[];
    /**
     * The spans in this file the suite is PROVEN blind to - architecture E's target list.
     *
     * A LIST, ONE ENTRY PER PROOF, because a pull-request run can hold two at once: its own classic
     * survivors on the change, and a night's stored map read through seam 1. Merging them into one
     * entry would throw away which proof found what, which is the comparison the disclosure exists to
     * support.
     *
     * ABSENT OR EMPTY IS THE DEFAULT AND CHANGES NOTHING. No proof, no block, and the prompt is
     * byte-identical to the one that shipped before E. That is the state of every repository on its
     * first night and of every pull-request run whose classic pass found no survivor on the change.
     */
    aims?: readonly BugPoolAim[];
    /**
     * The packages the repository's own test files import, which this witness may import too.
     *
     * REQUIRED FOR THE SAME REASON AS `modules`, and empty means the tests here import no package
     * this repository declares. Built by `collectWitnessDependencies`; the `mockdate` class of
     * Kenneth's fix-forward ruling of 2026-08-15.
     */
    dependencies: readonly string[];
    /**
     * The mutants the free deterministic pass ALREADY PLANTED in this file, this run - half (b) of
     * the negative catalog.
     *
     * ABSENT OR EMPTY IS THE DEFAULT AND CHANGES NOTHING, which is the honest state of the overnight
     * lane: it runs no classic pass, so it has no planted list and makes no claim about one. A caller
     * that ran a pass passes what it planted; a caller that did not says nothing rather than implying
     * the file is uncovered.
     */
    classicPlanted?: readonly ClassicPlantedMutant[];
    /**
     * What this file's neighbourhood says the code MEANS - the domain block.
     *
     * ABSENT IS A REAL STATE, not a degraded one: a file that imports nothing first-party, sits under
     * no README and whose owners wrote no invariants has nothing here, and the prompt then carries no
     * domain block at all. Built by `collectDomainContext`.
     */
    domain?: DomainContext;
}
/**
 * The placement block - arm Q of the 2026-08-15 A/B, reproduced as it won.
 *
 * WHY IT IS APPENDED AND NOT WOVEN IN. The experiment's arms differed from the shipped prompt by an
 * appended block and nothing else, asserted byte for byte on every one of its 78 calls. Rebuilding
 * the rule inside the body would ship a prompt the experiment never measured.
 *
 * WHY THE LINES ARE QUOTED AS WELL AS NUMBERED. The file block above carries no line numbers, so a
 * model asked to hit line 18 of an unnumbered listing is being tested on counting rather than on
 * placement.
 *
 * WHY LINE SCOPE AND NOT FUNCTION SCOPE. Arm R obeyed "stay inside the enclosing function" perfectly
 * and that is why it lost: told to stay inside a 7-, 42- or 5-line function, the generator spread
 * across the function and off the two or three lines that actually changed - 12%, 25% and 19%
 * on-diff against arm Q's 100%.
 */
declare function placementBlock(targets: readonly BugPoolTarget[]): string[];
/**
 * The AIM block - architecture E, and the second half of prompt version /7.
 *
 * WHAT IT CLAIMS AND WHY THAT IS DIFFERENT FROM A HINT. Every line listed here has had a mechanical
 * mutation applied to it and the repository's own suite run against the result, and nothing failed.
 * That is a DEMONSTRATION that the suite asserts nothing about the line, not a prediction that it
 * probably does not: the distinction is the whole reason the architecture survives the finding that
 * learned budget allocation barely helps, which is a result about predictors.
 *
 * WHY IT IS APPENDED, LIKE THE PLACEMENT BLOCK. The placement rule won its A/B as an appended block
 * and nothing else, and the two rules are read in order: placement decides where a bug is ALLOWED,
 * aim decides where it is most valuable. That ordering is stated in the text so the model cannot
 * resolve the tension the wrong way - a bug outside the changed lines is discarded whether or not it
 * lands on a proven blind span.
 *
 * WHY THE LINES ARE QUOTED. Same reason as placement: the file block above carries no line numbers,
 * so a model asked to aim at line 40 of an unnumbered listing is being tested on counting.
 *
 * NO PROOF, NO BLOCK. A target with no aim, or with an empty span list, contributes nothing, and a
 * prompt where no target has one is byte-identical to the prompt before E existed.
 */
declare function aimBlock(targets: readonly BugPoolTarget[]): string[];
/**
 * What one file's witness may import, stated beside that file rather than in a section of its own.
 *
 * WHY NAMES AND NOT SOURCE. The failure being closed is an invented identifier, and an identifier
 * list answers it exactly. Pasting a second module's body would carry the same fact at the cost of
 * the whole file, and a package entry is mostly re-export lines carrying nothing else.
 *
 * WHY THE SPECIFIER IS REPEATED PER MODULE. It is computed from where the witness will actually sit
 * (`importSpecifierFor`), and a model given a name without the specifier that reaches it is being
 * asked to derive a relative path from a repo-relative one - the guess that made every dayjs witness
 * unresolvable before the witness path was stated at all.
 *
 * WHY IT NOW SAYS THE LIST IS NOT THE LIMIT (2026-08-15, Kenneth's fix-forward ruling). The list is
 * the target plus the few modules the repository's test files import MOST often. Read as the set of
 * modules that exist, it forbids the sibling a target needs: dayjs's `weekYear` needs
 * `../src/plugin/weekOfYear` and its `timezone` needs `../src/plugin/utc`, neither of which any
 * ranking of most-imported modules will ever surface. The two lines below state the two classes
 * that are always available - this repository's own files, and the packages its own tests import -
 * so the block stays a list of NAMES, which is what stops invention, without becoming a list of
 * PATHS, which is what stopped the pool.
 */
declare function moduleBlock(target: BugPoolTarget): string[];
declare function buildBugPoolPrompt(input: {
    targets: readonly BugPoolTarget[];
    maxBugs: number;
    /**
     * The operator set the free deterministic pass really runs - half (a) of the negative catalog.
     *
     * HANDED IN, NOT IMPORTED, and `negative-catalog.ts` says why: this package may reach exactly one
     * workspace package, and the inventory lives with the engine that runs it. An absent or empty set
     * emits no operator list, which is what a caller running no classic pass should produce.
     */
    classicOperators?: readonly ClassicOperator[];
}): string;
/**
 * The reply shape, handed to the decoder instead of only described above.
 *
 * STRICT MODE'S RULES, AND WHY EVERY FIELD IS REQUIRED. `strict: true` demands that every declared
 * property appear in `required` and that `additionalProperties` be false. `type` and `note` are
 * decorative - a bug that arrives without them is still a bug - so making them required here would
 * be a constraint the product does not have. They are declared nullable instead, which is strict
 * mode's way of saying optional and which `acceptBugType` and the note check below already handle.
 *
 * STRUCTURE ONLY, NO VALUE KEYWORDS. `minLength` and friends are exactly the sort of keyword a
 * strict-mode implementation may refuse outright, and a refused schema is an HTTP 400 that loses the
 * whole planting call rather than one bad proposal. What was PROBED on this endpoint is the
 * `json_schema` envelope itself (report section 3), so this schema stays inside what that probe
 * covers: types, required, nullability and no unlisted property.
 *
 * WHAT IT BUYS, STATED HONESTLY. Every field arrives, typed, with nothing extra - which is what
 * removes the `unparseable` re-ask path and the 22% the constrained decoder measured. It does NOT
 * make `empty-original-text` or `replacement-identical` unemittable: both stay checks in
 * `generateBugPool` below, where they have always been.
 */
declare const BUG_POOL_REPLY_SCHEMA: Record<string, unknown>;
/**
 * The witness ask, run AFTER the suite and only for a bug it did not notice.
 *
 * WHY IT CARRIES THE BUG. This call is not being asked to find anything: the span, the replacement
 * and the category are already decided and already measured, so the only judgement left is how to
 * demonstrate them. Stating the bug rather than the file's whole story is what makes this call
 * small - one measured witness-only call for three bugs cost 2,161 tokens against a planting call's
 * ~9,000.
 *
 * WHY IT CARRIES THE EXPORT BLOCK. Unchanged from the /5 fix, and for the unchanged reason: a
 * witness told to build the real thing and not shown what can build it invents an import. The block
 * is the same `moduleBlock` the planting prompt used to carry, moved to the call that now needs it.
 */
declare function buildWitnessPrompt(input: {
    target: BugPoolTarget;
    bug: {
        originalText: string;
        replacement: string;
        bugType?: string;
        note?: string;
    };
    runner: string;
    moduleFormat: "cjs" | "esm";
    exampleTest?: {
        path: string;
        source: string;
    };
}): string;
/** The witness reply's shape, structure only, for the same reasons as the pool's reply above. */
declare const BUG_WITNESS_REPLY_SCHEMA: Record<string, unknown>;
declare const BUG_REFUSAL_REASONS: readonly ["unknown-file", "empty-original-text", "replacement-identical", "no-witness", "off-diff", "unlocatable-text"];
type BugRefusalReason = (typeof BUG_REFUSAL_REASONS)[number];
interface BugPoolGeneration {
    bugs: StoredAgentBug[];
    /** entries the reply carried that could not become bugs, each with its named reason */
    refused: Array<{
        reason: BugRefusalReason;
        file: string;
    }>;
    modelCalls: number;
    failure?: ModelFailure | {
        kind: "unparseable";
        detail: string;
    };
}
interface ReplyBug {
    file?: unknown;
    originalText?: unknown;
    replacement?: unknown;
    type?: unknown;
    note?: unknown;
}

declare function generateBugPool(input: {
    targets: readonly BugPoolTarget[];
    client: ModelClient;
    pin: TaskModelPin;
    maxBugs: number;
    /** the free pass's operator set, for the exclusion block; absent emits no operator list */
    classicOperators?: readonly ClassicOperator[];
    signal?: AbortSignal;
}): Promise<BugPoolGeneration>;
/**
 * Where a proposal landed, checked against the same source the model was shown.
 *
 * A target with no changed ranges is not checked: that is the caller saying it has no diff for this
 * file, and inventing a placement verdict from an absent surface would refuse every bug on it.
 */
declare function placementOf(target: BugPoolTarget, originalText: string): "on-diff" | "off-diff" | "unlocatable-text";
type ParsedBugReply = {
    ok: true;
    bugs: ReplyBug[];
} | {
    ok: false;
    reason: string;
};
declare function parseBugPoolReply(text: string): ParsedBugReply;

/**
 * What the witness call says about the bug it just demonstrated, beyond the test.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY FIELD IS INDEPENDENT. A witness that graded the bug and wrote
 * no consequence is more useful than one refused for the missing half, and the surfaces render each
 * field only when it is there. `behaviour` is the one with teeth: `incidental` removes the finding
 * on the far side of the boundary, so a missing verdict must never be read as one.
 */
interface BugDiagnosis {
    behaviour?: BugBehaviourVerdict;
    /** one sentence: how somebody meets this bug, in the code's own domain terms */
    behaviourReason?: string;
    /** up to 120 words: why the existing tests do not fail. Never names a test - see the prompt. */
    whyUnnoticed?: string;
    /** one sentence: what a reader should worry about if this stays untested */
    consequence?: string;
    severity?: BugSeverity;
    /** one sentence: what breaks, and how widely it can be reached. Never a rate. */
    severityBasis?: string;
    /**
     * THE ACCOUNT OF THE BUG, from witness ask /10 onwards: what fills "About this bug".
     *
     * Three paragraphs separated by a blank line - what the bug is, how it would be encountered, what
     * happens if it ships - and the surfaces render one paragraph per part. It does NOT replace
     * {@link consequence} in the reply, only in the section: the account is one long field behind an
     * all-or-nothing guard, so the sentence survives beside it and the renderer falls back to it. The
     * same argument, and the same pair of fields, as the mechanical lane's `about` and `impact`.
     *
     * Absent on every bug from before /10, and nothing is back-filled for them - prose about one
     * specific bug cannot be reconstructed by a layer that never saw the model write it.
     */
    about?: string;
}

/** Read the diagnosis off a witness reply. Anything unusable is absent, never guessed. */
declare function acceptBugDiagnosis(entry: Record<string, unknown>): BugDiagnosis | undefined;
type ParsedWitnessReply = {
    ok: true;
    testName: string;
    testBody: string;
    diagnosis?: BugDiagnosis;
} | {
    ok: false;
    reason: string;
};
/**
 * Read the witness-only reply.
 *
 * It shares `parseBugPoolReply`'s tolerance for a fenced block, because the tolerance is about how a
 * model presents JSON rather than about which JSON it is - and under the schema neither path is
 * reachable in the normal case.
 */
declare function parseWitnessReply(text: string): ParsedWitnessReply;
interface WitnessGeneration {
    witness?: {
        testName: string;
        testBody: string;
    };
    /** What the same call said about the bug, when it wrote anything usable. See `BugDiagnosis`. */
    diagnosis?: BugDiagnosis;
    /** named when nothing usable came back; the pool routes it as `no-witness` */
    refused?: BugRefusalReason;
    modelCalls: number;
    failure?: ModelFailure | {
        kind: "unparseable";
        detail: string;
    };
}
/**
 * Write one witness, for one bug the suite did not notice.
 *
 * THE SECOND ENTRY POINT, AND THE SMALLER ONE. It exists because the first one no longer asks for
 * witnesses: a bug the suite catches is finished at the suite, and only a survivor has anything left
 * to prove. It retries once on a mechanism failure carrying the failure text, which is the same
 * mechanism-improving retry the planting call and `generateBatch` use.
 */
declare function generateWitness(input: {
    target: BugPoolTarget;
    bug: {
        originalText: string;
        replacement: string;
        bugType?: string;
        note?: string;
    };
    client: ModelClient;
    pin: TaskModelPin;
    runner: string;
    moduleFormat: "cjs" | "esm";
    exampleTest?: {
        path: string;
        source: string;
    };
    signal?: AbortSignal;
}): Promise<WitnessGeneration>;

/**
 * Which tests could possibly notice a planted bug - read off the classic pass's own coverage.
 *
 * THE FIRST PRINCIPLE. A test that never executes the mutated line cannot observe the mutation, so
 * the only tests that can kill a planted bug are the tests that cover its lines. Until 2026-08-15
 * pool 2 ran the repository's WHOLE suite once per planted bug, which is one full suite execution
 * to learn what a handful of test files could have said (architecture H,
 * `data/abloh-cost-mechanics/report.md` section 10).
 *
 * WHERE THE COVERAGE COMES FROM. Nothing new is measured here. The classic mutation pass already
 * records, per mutant, the canonical `<file>::<fullName>` identity of every test that covered it
 * (`coveredByTests`, written in `measure/src/index.ts`). A classic mutant is a span in a
 * source file, so its covering set is a statement about the LINES that span occupies. This index is
 * that statement, gathered per file and answerable per line.
 *
 * WHAT IT REFUSES TO SAY, and why the refusal is the whole design. `coveredByTests` is ABSENT - not
 * empty - when coverage could not be attributed: Stryker's command runner has no per-test data at
 * all (`measure/src/baseline.ts`), and an older report carries no test dictionary. Absent is
 * not "covered by nothing"; treating it as such would select no tests, find no failure, and call a
 * caught bug a survivor. So a query is answered ONLY when every line of the asked-for span is
 * covered by at least one classic mutant that CARRIED an attribution. Anything else returns `null`,
 * which the caller reads as "run the whole suite, as before".
 *
 * AN EMPTY ANSWER IS STILL AN ANSWER. A line whose classic mutants were attributed to zero tests is
 * a line no test reaches. That returns `[]`, not `null`, and it is the most valuable answer the
 * index gives: no test can catch a bug there, so the selective pass has nothing to run.
 */

/**
 * The covering-test lookup a pool run is handed.
 *
 * A function rather than a map because the question is about a SPAN, and the spans a pool asks
 * about are not the spans the classic pass measured.
 */
interface CoverageIndex {
    /**
     * The canonical identities of every test that could observe a change on `startLine..endLine` of
     * `file`, or `null` when the classic pass did not attribute coverage for all of those lines.
     *
     * `null` NEVER means "no tests". It means "not known", and the only honest response to it is the
     * behaviour that needed no coverage in the first place.
     */
    coveringTests(file: string, startLine: number, endLine: number): readonly string[] | null;
    /**
     * The same answer reduced to test FILES, which is the unit the runner executes in.
     *
     * A METHOD RATHER THAN A CONVERSION AT THE CALL SITE, since 2026-08-15. The classic index knows
     * `<file>::<fullName>` identities and reduces them; the night's per-line pass knows only files -
     * it proves coverage by running a test FILE against a mutation and watching it fail, and there is
     * no test name in that fact. Asking every index for identities would have forced the night's to
     * invent a name to put after the `::`, which is a fabricated fact in a durable store. So the
     * question the caller actually asks is the one the interface carries.
     */
    coveringFiles(file: string, startLine: number, endLine: number): readonly string[] | null;
}
/**
 * Build the index from the run's own classic mutants.
 *
 * Only mutants that CARRIED an attribution contribute. A mutant with no `coveredByTests` is not
 * evidence that its lines are uncovered - it is evidence that this run could not say - so it is
 * left out entirely and its lines stay unanswerable.
 */
declare function buildCoverageIndex(mutants: readonly NormalizedMutant[]): CoverageIndex;
/**
 * The index the night's per-line pass answers with: spans and the test FILES proven to catch them.
 *
 * WHY IT ANSWERS NO IDENTITIES. The proof behind each entry is "this test file, run alone against
 * this mutation, failed". There is no test name in that, and inventing one to satisfy the
 * `<file>::<name>` shape would put a fabricated fact into a durable store and into a selection the
 * runner then acts on. So `coveringTests` answers `null` here - not known - and `coveringFiles`
 * answers what was actually proven.
 *
 * THE SAME COMPLETENESS RULE AS THE CLASSIC INDEX: every line of the asked-for span must be answered
 * by at least one recorded span, or the whole query is `null`. A partial answer selects a partial
 * test set, which is a wrong verdict rather than a slower one.
 */
declare function buildLineCoverageIndex(spans: ReadonlyArray<{
    file: string;
    startLine: number;
    endLine: number;
    testFiles: readonly string[];
}>): CoverageIndex;
/**
 * The test FILES a covering set names, in the order they first appear.
 *
 * SELECTION IS BY FILE, NOT BY NAME, and that is a cost decision made from the runner's contract.
 * `SealedRunner.execute` selects ONE test file and at most ONE test name per execution
 * (`execution/runner.ts`), so selecting twelve covering tests by name is twelve executions - worse
 * than the one whole-suite run it replaces. Their files are usually one or two. Running a covering
 * file whole also runs tests that do not reach the bug, which costs nothing and can mislead
 * nobody: a test that cannot observe the mutation cannot fail because of it, and the whole suite
 * this replaces contained those same tests and every other one besides.
 *
 * Returns `null` when any identity is not of the canonical `<file>::<fullName>` form - an identity
 * this code cannot read is a fact it does not have, and the caller falls back rather than guessing
 * which file was meant.
 */
declare function coveringTestFiles(identities: readonly string[]): readonly string[] | null;

declare const AGENT_BUG_MUTATOR = "AgentBug";
declare const BUG_ROUTES: readonly ["unplaceable", "witness-refused", "suite-killed", "suite-survived", "not-executed"];
type BugRoute = (typeof BUG_ROUTES)[number];
declare const BUG_HOLD_REASONS: readonly ["file-absent", "text-not-found", "ambiguous-text", "witness-not-passing", "witness-not-admitted", "witness-gate-failed", "witness-not-executed", "witness-not-failing-on-bug", "witness-errored", "no-witness", "witness-unavailable", "suite-run-failed", "verdict-unattributable", "predicted-killed"];
type BugHoldReason = (typeof BUG_HOLD_REASONS)[number];
/**
 * Locate a stored bug in today's source, by content. The text must occur EXACTLY ONCE in its file:
 * zero occurrences means the source moved since generation, more than one makes the span
 * unknowable, and both refuse rather than guess (the patch organ's own doctrine).
 */
declare function locateBug(repoDir: string, bug: StoredAgentBug): {
    ok: true;
    gap: SurvivorGap;
} | {
    ok: false;
    reason: BugHoldReason;
};
interface WitnessProof {
    proven: boolean;
    reason?: BugHoldReason;
    executions: number;
    /**
     * Where this witness was placed, which is the path the test belongs at in the customer's tree.
     *
     * Reported by the proof rather than recomputed later: placement depends on the observed test
     * files and the bug's own discriminator, so a second computation elsewhere is a copy that can
     * drift from the path the proof actually ran the test at.
     */
    witnessFile: string;
    /** bounded runner output from the failing side - LOCAL ONLY */
    evidence?: string;
}
/**
 * The witness proof: pass on real, assert-fail on the bug. The same two facts the light check
 * demands of a candidate test, demanded here of the bug's own witness - and for the same recorded
 * reason: a test that fails on machinery rather than an assertion is the bug breaking the test,
 * not the test detecting the bug.
 *
 * ADMISSION COMES FIRST, AND IT IS THE SAME ORGAN THE ORDINARY LOOP USES (2026-08-27, external
 * engine review rank 9). The two facts this proof checks are both true of a test that reads the
 * target file as text and asserts the original bytes are present: it passes on the real source and
 * fails once the bug is applied, while knowing nothing at all about behaviour. That is the
 * source-reading fake `admission.ts` exists for, and the pool used to send its witnesses straight to
 * the runner - the prompt's "never read source files as text" was the only thing standing in its
 * way, and prompt text is advice, not a gate. Measured: the same source-reading test produced
 * `admission.admitted=false, rules=["denied-module"]` and `proveWitness.proven=true`.
 *
 * EXECUTION IS PROVED BY THE DISTINCTION, not only by the report. `executed === false` is the
 * runner saying our test did not run, and that refuses. `null` is the report FORMAT not saying -
 * node:test's default reporter emits neither TAP nor JSON, and most repositories run their own test
 * command - and refusing on that would refuse every witness on every such repository, which is a
 * gate standing in for a mechanism. The proof does not need it: the same file, run by the same
 * command, passing on the real source and failing on an assertion once the bug is applied, cannot
 * be a test that never ran, because a test that never ran cannot change verdict between the two
 * sides. This mirrors the light check, which likewise refuses only on an explicit `false`.
 */
declare function proveWitness(input: {
    bug: StoredAgentBug;
    /**
     * The test to prove, passed in rather than read off the bug.
     *
     * A bug carries a witness only once one has been written for it, and under the deferred witness
     * that happens at the call site, after the suite. Taking it as an argument is what keeps the proof
     * one thing - the same two executions whether the test came from the store, from a graduated bug,
     * or from a call made a moment ago.
     */
    witness: {
        testName: string;
        testBody: string;
    };
    gap: SurvivorGap;
    runner: SealedRunner;
    testFilePaths: readonly string[];
    timeoutMs: number;
    /**
     * The bare package specifiers this repository's own tests import and declare, which the witness
     * prompt explicitly permits ("the packages named above as ones this repository's own tests
     * import"). Passed to admission so a witness that took the prompt at its word is not refused as an
     * undeclared import; absent leaves admission on its base list alone, which is the strict reading.
     */
    allowedBareImports?: readonly string[];
}): Promise<WitnessProof>;
/**
 * Which execution produced this bug's suite verdict.
 *
 * `covering-tests` is a kill by the tests the classic pass recorded as covering the bug's lines;
 * `whole-suite` is the repository's whole suite, which is what every survivor is confirmed by and
 * what a bug with no usable coverage is measured by.
 */
declare const SUITE_VERDICT_SOURCES: readonly ["covering-tests", "whole-suite"];
type SuiteVerdictSource = (typeof SUITE_VERDICT_SOURCES)[number];
interface AgentBugRunResult {
    bug: StoredAgentBug;
    route: BugRoute;
    holdReason?: BugHoldReason;
    gap?: SurvivorGap;
    executions: number;
    /**
     * Which execution decided this bug's suite verdict, present exactly on the routes that reached
     * one - `suite-killed`, `suite-survived`, and the `suite-run-failed` hold.
     *
     * LOCAL, and for reading the mechanism rather than for scoring: a run whose coverage answered
     * nothing spends the same executions it always did, and this is what says so without anyone
     * having to infer it from a total. A survivor's is always `whole-suite`, by construction.
     */
    verdictBy?: SuiteVerdictSource;
    /**
     * Where this bug's witness test was placed, as the proof itself reported it.
     *
     * Absent exactly when the witness proof never ran, which is the `unplaceable` route: the bug's
     * text is not in today's source, so there is no span to prove anything against and no evidence to
     * write. Every other route has one.
     */
    witnessFile?: string;
    /**
     * The test that demonstrated this bug, present exactly on the `suite-survived` route.
     *
     * ON THE RESULT RATHER THAN ONLY ON THE BUG, because under the deferred witness the test is
     * written during this run and belongs to this run's outcome: the bug the pool was handed did not
     * have one. Everything downstream that needs the witness - the evidence sidecar, the lane's
     * graduation record - reads it from here, so none of them has to know where it came from.
     *
     * LOCAL ONLY - a witness body is model-written test source.
     */
    witness?: {
        testName: string;
        testBody: string;
    };
    /**
     * What the witness call said about the bug, present on the same routes its test is.
     *
     * Read off the result rather than only off the bug for the reason the witness is: under the
     * deferred witness both are written during THIS run. A replayed survivor carries its own from the
     * store, and the fallback below picks whichever exists.
     */
    diagnosis?: BugDiagnosis;
    /** LOCAL ONLY */
    evidence?: string;
}
/**
 * How C2 routes this pool's executions: which bugs get measured, and in what order.
 *
 * `execute` is the only thing that can ever REMOVE work; a gap identity missing from it is
 * `not-executed` and enters no arithmetic. `order` cannot remove anything - it is a permutation of
 * the measurements the run was going to take anyway, put in the order that pays first if the run is
 * cut short. A located gap the order does not name keeps its position behind the ones it does, so a
 * routing that names nothing behaves exactly as this pool did before the field existed.
 */
interface ExecutionRouting {
    execute: ReadonlySet<string>;
    order: readonly string[];
}
interface AgentBugPoolInput {
    repoDir: string;
    /** the commit the pool is pinned at */
    sha: string;
    storeDir: string;
    repoKey: string;
    /**
     * How long the pin store may keep the source text it writes, and the clock it dates from.
     *
     * OPTIONAL, AND THE DEFAULT IS THE RULED SIXTY DAYS - `BugPoolStore.open` says why the argument is
     * defaulted rather than required. A caller that knows the organization's window passes it; a
     * caller that does not still gets a governed store rather than an ungoverned one.
     */
    custody?: EvidenceCustody;
    /**
     * The diff's changed files, each with its changed line ranges and its classic site count.
     *
     * THREE FACTS, ONE LIST. The path says which file the pool may plant in, the ranges say where in
     * it (the placement rule the prompt states and generation enforces), and the site count says how
     * many attempts that file earns. All three come off the same change; deriving any of them here
     * would be a second derivation that can disagree with the run's own.
     */
    targets: readonly PoolTargetScope[];
    runner: SealedRunner;
    runnerName: string;
    moduleFormat: "cjs" | "esm";
    testFilePaths: readonly string[];
    /** null replays a pinned pool; with no pin AND no client the pool is honestly unavailable */
    client: ModelClient | null;
    /**
     * The model identity, EXPLICIT: task pins are benchmark-derived and no benchmark has selected a
     * pool-2 identity yet, so there is no default to inherit - the caller writes the pin down.
     */
    pin: TaskModelPin;
    /** every knob explicit; the pool refuses to run without them */
    policy: AgentBugPoolPolicy;
    /**
     * C2's seam, and the ONLY way an execution is ever removed from this pool.
     *
     * Given every witness-proven bug, it returns the gap identities that get a suite execution. It is
     * absent whenever the predictor flag is off, and then every proven bug executes. A bug it leaves
     * out is `not-executed` with the reason `predicted-killed`, and a not-executed bug is never
     * reported as a survivor and never enters the score - this pool, like the classic base, only ever
     * names and counts gaps a live execution found.
     *
     * The two flags stay independent by construction: the pool does not know what a predictor is, and
     * the predictor does not know what a bug pool is.
     *
     * IT NOW SEES THE LOCATED SET, NOT THE PROVEN SET. Under the deferred witness the suite runs
     * first, so there is no proven set at selection time. The rule the ordering protected is intact:
     * a predictor may skip MEASURING a bug and can never skip proving one, because proving now happens
     * after measurement and only for bugs a measurement kept.
     *
     * IT ANSWERS WITH BOTH FACTS AT ONCE, and that is deliberate. A predictor that is active but not
     * licensed to skip returns every located gap in `execute` and a non-trivial `order` - it changes
     * WHEN each bug is measured and never WHETHER - so a seam that could only answer "which" would
     * have no way to express the default state. One callback over one population answers both rather
     * than two callbacks that could disagree about what the population was.
     */
    selectForExecution?: (located: ReadonlyArray<{
        gapId: string;
        gap: SurvivorGap;
    }>) => ExecutionRouting;
    /**
     * Per-line coverage from this run's own classic mutation pass, for architecture H.
     *
     * ABSENT IS THE FALLBACK, and it is a real state rather than a degraded one: the overnight lane
     * runs no classic pass, and Stryker's command runner produces no per-test attribution at all. A
     * pool with no index measures every bug against the whole suite exactly as it always has.
     */
    coverage?: CoverageIndex;
    /**
     * The operator set the free deterministic pass really runs - half (a) of the negative catalog.
     *
     * ABSENT IS A REAL STATE. The overnight lane runs no classic pass, so it has no operator set to
     * name and the prompt then carries no operator list rather than a guess at one. The pull-request
     * path passes the inventory the pass it just ran actually holds; `negative-catalog.ts` says why
     * this arrives as data rather than as an import.
     */
    classicOperators?: readonly ClassicOperator[];
    /**
     * The customer's own domain rules, from `domainInvariants` in `abloh.yml`.
     *
     * HANDED TO THE PLANTER VERBATIM, never summarised and never rewritten - a rule somebody wrote
     * about their own domain is the one thing in the domain block that nothing on disk derives.
     */
    domainInvariants?: readonly string[];
    exampleTest?: {
        path: string;
        source: string;
    };
    signal?: AbortSignal;
}
/**
 * The UNPATCHED side of every pool-2 verdict, measured at most once per shape.
 *
 * WHY IT EXISTS (2026-08-27, external engine review rank 15). This pool ran only the bugged side and
 * called any red report a kill. That is only sound on a suite that is green to begin with, and the
 * pool never checked - the identical mistake the candidate loop already paid for and fixed in
 * `exit-proof.ts`, whose comment records a sealed image with no `git` binary turning 26 pre-existing
 * failures into a conviction of every candidate. Reproduced here with the real local runner: an
 * unrelated test named `already red` failed before the bug, the planted discount bug was outside the
 * original test's reach, and the pool still reported `suiteKilled=1`.
 *
 * SO A CATCH IS A DIFFERENCE, NOT A COLOUR: the planted bug must make a test fail that passed
 * without it, judged by the same `suiteDelta` the candidate loop uses, on the same parsed reports.
 *
 * LAZY AND MEMOISED, for the reason `measureSuiteBaseline` is: a green run needs no baseline at all,
 * so a healthy repository pays exactly what it paid before this existed, and a red one pays one
 * extra execution per SHAPE - once for the whole suite, once per covering test file - however many
 * bugs are measured against it.
 *
 * PER SHAPE, because a selective verdict and a whole-suite verdict are different questions. A
 * covering-tests kill is convicted against that same test file run without the patch; comparing it
 * to the whole suite's baseline would set the failures of every other file against it.
 */
interface BugBaselineProbe {
    measure(request: {
        mode: "suite";
    } | {
        mode: "targeted";
        testFile: string;
    }): Promise<SuiteBaseline>;
}
declare function measureBugBaselines(input: {
    runner: SealedRunner;
    targetedTimeoutMs: number;
    suiteTimeoutMs: number;
}): BugBaselineProbe;
interface AgentBugPoolOutcome {
    state: "completed" | "unavailable";
    reason?: string;
    results: AgentBugRunResult[];
    disclosure: AgentBugDisclosure | null;
    /**
     * The FULL local ledger's bytes. Written beside the artifact, mode `0600`, and never uploaded.
     *
     * Null exactly when there is no disclosure - an unavailable pool measured nothing and has nothing
     * to write. It holds every bug the pool handled with its witness body and, for a held bug, the
     * runner's own output; the disclosure commits to {@link uploadEvidenceText} instead, because a
     * commitment must name the bytes that travel.
     */
    evidenceText: string | null;
    /**
     * The bytes that TRAVEL: the survivor projection, scrubbed, and what `evidenceDigest` commits to.
     *
     * Null on the same terms as {@link AgentBugPoolOutcome.evidenceText}. See
     * `upload-projection.ts` for what is dropped and why the selection is the artifact's rather than
     * this producer's.
     */
    uploadEvidenceText: string | null;
    modelCalls: number;
    /**
     * Bugs the SIZING LAW asked for across every changed file, before anything could stop the pool.
     *
     * THE DENOMINATOR THAT DOES NOT SHRINK, which is why it is here and not read off the disclosure.
     * `disclosure.coverage.attemptsPlanned` sums the attempts on the files that ANSWERED, so a file
     * whose generation call was refused leaves that number as well as the numerator - correct for the
     * coverage claim, useless for "how much of what this run set out to do did it do". A run stopped
     * by its cost limit has to be able to say "4 bugs planted of the 12 this change was sized for",
     * and the 12 exists only in the plan.
     */
    attemptsPlanned: number;
}
/**
 * Which of this pool's verdicts came off a changed line NO TEST EXECUTES.
 *
 * WHY THE POOL HAS TO ANSWER THIS (Kenneth, 2026-08-30). Since the sizing law started counting the
 * unexecuted changed lines, a pool can contain two populations that mean different things. A bug on
 * a covered line is a question about the suite - it could have been caught, and whether it was is a
 * measurement of the tests. A bug on a line no test runs cannot be caught by anything, so its
 * survival measures nothing about the suite's quality and everything about the change's exposure.
 * Feeding the second into a rate would divide a guaranteed miss by a denominator we chose, which is
 * the same objection that made this pool report counts rather than a percentage in the first place.
 *
 * SO IT IS COUNTED, NOT DROPPED. The verdicts stay in the pool's own totals - they were planted,
 * they ran, they are real findings and they become the proposed tests - and `pool2ScoreComponent`
 * subtracts exactly this subset before it computes a rate.
 */
interface UntestedLineVerdicts {
    /** bugs this run LOCATED on an unexecuted changed line, whatever route they then took */
    planted: number;
    /** of those, the ones the suite caught anyway - a covering test the coverage report did not see */
    suiteKilled: number;
    /** of those, the ones nothing noticed. Expected to be all of them, and proven rather than assumed */
    suiteSurvived: number;
}
/**
 * The subset, from the targets that named the unexecuted lines and the results that were placed.
 *
 * A BUG WITH NO LOCATION IS IN NEITHER POPULATION. The `unplaceable` route means the bug's text is
 * not in today's source, so there is no line to attribute it to and no verdict to attribute either.
 */
declare function untestedLineVerdicts(targets: readonly PoolTargetScope[], results: readonly AgentBugRunResult[]): UntestedLineVerdicts;
declare function runAgentBugPool(input: AgentBugPoolInput): Promise<AgentBugPoolOutcome>;
declare function buildAgentBugDisclosure(pool: Omit<StoredBugPool, "deleteAfter">, pinned: boolean, results: readonly AgentBugRunResult[], graduated?: number, 
/**
 * sha256 of the local evidence sidecar this run wrote, when it wrote one.
 *
 * Optional because the disclosure's arithmetic is meaningful without it and several callers build
 * one to check counts alone. On a real run it is always present: `runAgentBugPool` serializes the
 * sidecar and passes its digest, which is what binds those bytes to the signed artifact.
 */
evidenceDigest?: string, 
/** bugs this run replayed from a stored file version instead of paying to generate */
replayed?: number, 
/** what the planting call was aimed at, absent when nothing was proven blind (E did not run) */
aim?: AgentBugAimDisclosure, 
/**
 * The per-file outcomes and refusal causes this run learned (junction audit POOL-02, POOL-03).
 *
 * Optional because a pinned or content-replayed run generated nothing and has neither, and
 * because several callers build a disclosure to check the counts alone.
 */
generation?: {
    files?: NonNullable<AgentBugDisclosure["files"]>;
    refusedReasons?: Record<string, number>;
}, 
/**
 * The subset of these verdicts planted on changed lines no test executes.
 *
 * Optional, and OMITTED WHEN IT IS EMPTY rather than written as three zeros: a block that says
 * "no bug here was planted on an unexecuted line" is exactly what every run before 2026-08-30
 * produced, and their disclosures must stay byte-identical.
 */
untestedLines?: UntestedLineVerdicts): AgentBugDisclosure;

/** One bug's local evidence. `route` is the pool's own record of what happened to it. */
interface Pool2EvidenceEntry {
    bugId: string;
    route: BugRoute;
    /**
     * The bug's one-line description, as the generator wrote it.
     *
     * Absent when the generator returned none. It is prose about the planted change, never source
     * text, and it is the only sentence on this path that a machine did not measure - which is why
     * the surface renders it as the bug's own description and never as a verdict about the code.
     */
    description?: string;
    /**
     * The category of mistake the generator says it planted, in two or three words.
     *
     * Carried beside the description for the same reason and under the same rule: it is the
     * generator's own account of its own change, never a measurement, so the surface renders it as
     * the bug's type and never as a verdict about the customer's code. Absent when the generator
     * wrote none, which is every bug from before prompt version /4.
     */
    bugType?: string;
    /**
     * Why this bug did not reach a suite verdict, exactly as the pool named it.
     *
     * Absent on a bug that did - `suite-killed` and `suite-survived` carry no hold. Present on every
     * other route, because a route without its reason is a count without a cause: `dayjs-3b1060f9`
     * published `holdReasons: {"witness-not-passing": 10}` and nothing else, and reading why ten bugs
     * were lost took re-running a witness by hand in a preserved work tree (D2, 2026-08-15).
     */
    holdReason?: BugHoldReason;
    /**
     * The runner's own output from the side that refused, bounded.
     *
     * WHY IT IS SAFE HERE, AND WHY THAT IS A PROPERTY RATHER THAN A PROMISE. This is a LOCAL ledger;
     * what a customer may see is the intersection with the artifact's SIGNED survivor list, taken on
     * the far side of the boundary (`apps/api/src/pool2-evidence.ts`), and it reads a named set of
     * fields that does not include this one. An entry carrying evidence has a hold reason, and a bug
     * with a hold reason is never a survivor - so this text has no path to a customer by construction,
     * not by a rule someone has to keep.
     *
     * Bounded to `MAX_POOL2_HOLD_EVIDENCE_CHARS` rather than the pool's own 4,000: one item can lose a
     * whole pool at once, and ten stack traces are the failing frames repeated ten times.
     */
    evidence?: string;
    /**
     * Where the witness test was placed, what it calls itself, and its source.
     *
     * ABSENT WHEN NO WITNESS WAS EVER WRITTEN, which since 2026-08-15 is the normal case for a bug the
     * suite caught: the witness is deferred to the survivors, so a killed bug has a route, a
     * description and a category and nothing to demonstrate. The entry is still written, because the
     * ledger's job is to hold every bug the pool handled; what a customer may be shown is decided on
     * the far side by joining these to the SIGNED survivor list, and a survivor always has one.
     */
    witness?: {
        testFile: string;
        testName: string;
        testBody: string;
    };
    /**
     * THE CHANGE ITSELF: the exact text the bug replaced, and what it put there.
     *
     * ADDED 2026-08-17, Kenneth's ruling. Both strings were already written by the planting call and
     * both were already stored - the bug's cross-run identity is `structuralDigest({file,
     * originalText, replacement})`, computed FROM them - and neither reached the customer's page. The
     * AI lane showed a test proving a bug and never showed the bug.
     *
     * THEY DO NOT WEAKEN THE BOUNDARY, and that is why they can be carried. Everything else a
     * customer may see comes from the SIGNED survivor list rather than from this document; these two
     * come from here, and the far side recomputes the digest over them and refuses a mismatch
     * (`apps/api/src/pool2-evidence.ts`). A sidecar cannot lie about what the bug was, because the
     * `bugId` the signed list carries is that lie's own checksum.
     */
    originalText?: string;
    replacement?: string;
    /**
     * What the witness call said about the bug beside the test it wrote.
     *
     * Local like everything else here; the far side reads a named set of these fields and drops an
     * `incidental` bug rather than serving it. Absent on every bug from before prompt version /9.
     */
    diagnosis?: BugDiagnosis;
}
interface Pool2Evidence {
    schema: typeof POOL2_EVIDENCE_SCHEMA;
    /** the commit the pool ran at */
    sha: string;
    entries: Pool2EvidenceEntry[];
}

/**
 * The loop's sidecar reduced to the candidates its own exit proofs declare proven.
 *
 * `exitProofs` travels too, and must: the acceptor joins candidates to it by `candidateId`, so a
 * projection that dropped it would upload bodies nothing could admit. It is filtered to the proven
 * verdicts for the same reason the candidates are - a rejected proof names the candidate it
 * rejected, and the far side has no use for one whose body is not here.
 *
 * EVERYTHING ELSE IS GONE, and each of those was a separate disclosure. `triage` holds the model's
 * reasoning about the customer's code; `ledger` holds every hold with bounded verbatim runner
 * output; `lightChecks` holds report text; `intakeExclusions` names files. The acceptor stored none
 * of it, so nothing downstream loses anything - it simply stops travelling.
 *
 * `modelCallTimings`, `matrix`, `repair` and `promotion` are measurements rather than content, and
 * they go with the rest: the block already carries the aggregates every surface renders, and an
 * upload is not the place to keep a diagnostic the acceptor throws away.
 */
declare function survivorProofsProjection(sidecar: ProposalsSidecar): {
    schema: string;
    sha: string;
    projection: "survivors-only";
    candidates: UploadedCandidate[];
    exitProofs: ProposalsSidecar["exitProofs"];
};
/**
 * A PROVEN CANDIDATE'S ROW IS AN ALLOWLIST, NOT THE LOCAL ROW MINUS WHAT ANYONE REMEMBERED.
 *
 * The projection used to copy the candidate whole, which made every future field added to the local
 * ledger an upload decision nobody took. It took one immediately: `supportFiles` joined that ledger
 * on 2026-08-28 so the local document can recompute the `candidateId` it is keyed on (junction audit
 * EVID-01), and copying the row whole would have put those files' SOURCE on the wire - a category
 * that has never crossed it, for a field the acceptor does not read.
 *
 * SO THE LOCAL LEDGER KEEPS THEM AND THE WIRE DOES NOT, which is both laws at once: the document
 * that has to reconstruct a proof holds everything the proof needed, and what leaves the customer's
 * CI is still the proven test and the facts the acceptor joins it by.
 *
 * The five fields below are exactly what `apps/api/src/proposals-proofs.ts` reads. A field it starts
 * reading is a field to add here deliberately, in the same change.
 */
interface UploadedCandidate {
    candidateId: string;
    gapId: string;
    round: number;
    testFile: string;
    testName: string;
    testBody: string;
}
/**
 * Pool 2's ledger reduced to the bugs the signed disclosure lists as proven survivors.
 *
 * SELECTED BY `bugId` AGAINST THE SIGNED LIST, not by the sidecar's own `route`. The far side does
 * exactly that and says why: `route` is the pool's own account of what happened, and the boundary is
 * the artifact's. Using the same key here means the two agree by construction rather than by two
 * rules that could drift.
 *
 * WHAT STOPS TRAVELLING IS THE PART THAT WAS NEVER SERVABLE. A held bug's `evidence` is bounded
 * verbatim runner output, and `evidence.ts` argues it is safe because a bug with a hold reason is
 * never a survivor and the far side reads a field set that excludes it - both true, and both about
 * what is STORED. It still left the machine. Now it does not.
 */
declare function survivorPool2Projection(ledger: Pool2Evidence, survivors: ReadonlyArray<{
    bugId?: unknown;
    witness?: unknown;
}>): Pool2Evidence & {
    projection: "survivors-only";
};
/**
 * The bytes that will be uploaded, scrubbed before they are digested.
 *
 * THE ORDER IS THE POINT. Every commitment in the artifact is a digest of the exact bytes on disk,
 * so a scrub applied after digesting would produce a file that matches no commitment and an upload
 * the acceptor refuses. Masking first means the digest covers the masked bytes and the two agree by
 * construction - the same rule the CLI's artifact write follows.
 *
 * BOTH MASKERS, because they answer different questions. `scrubSecretsDeep` removes values the
 * customer DECLARED under `environment.requiredVariables`. The shape scan then catches a credential
 * that was never declared - a key hardcoded in the file a candidate was written against, which
 * reaches a test body by being quoted in it.
 */
declare function uploadableSidecarText(projection: unknown): string;

/** The identity of a mutation: file, exact span, mutator and the text it substituted. */
declare function gapIdentity(input: {
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    mutator: string;
    replacement: string;
}): string;
/**
 * The identity of a SPAN: file and exact coordinates, with no mutator and no replacement.
 *
 * WHAT IT IS FOR. A mutation engine emits many mutants over one expression - the complete-fix
 * benchmark's run B carried `Regex` through `Regex#12` on a single regex literal at
 * `preparation.ts:850:10`, of which eleven survived and became eleven separate gaps, each drawing
 * its own share of the batched generation calls. The differences between them are one character of
 * a whitespace class, and one test that feeds the predicate a handful of spellings kills most of
 * them together (`data/abloh-unfixed-gaps-investigation/report.md` F5).
 *
 * DELIBERATELY NOT `gapIdentity` MINUS TWO FIELDS. `gapIdentity` is what a verdict is stored
 * against and what a cross-run join keys on, and it must keep naming ONE physical mutation. This is
 * a second, coarser key used only to decide what to ASK about; scoring, the kill matrix and the
 * artifact all still work in gaps.
 */
declare function spanIdentity(input: {
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}): string;
/** The identity of a candidate bundle: its path, its body and every support file it carries. */
declare function candidateIdentity(input: {
    gapId: string;
    round: number;
    testFile: string;
    testBody: string;
    supportFiles: ReadonlyArray<{
        path: string;
        source: string;
    }>;
}): string;
/** Digest of only the generated bytes, for the artifact (the bytes themselves stay local). */
declare function candidateDigest(input: {
    testFile: string;
    testBody: string;
    supportFiles: ReadonlyArray<{
        path: string;
        source: string;
    }>;
}): string;

/**
 * Survivor intake.
 *
 * The mutation engine's normalized mutants come in; loop-eligible gaps come out, plus one named
 * exclusion record for every survivor the loop cannot attempt. The exclusions are DISCLOSED, not
 * dropped: "the engine reported 40 survivors and the loop attempted 12" is a sentence a reader must
 * be able to complete, and in v1 it could only be completed by reading the source.
 *
 * Intake makes no judgement about whether a survivor is worth attempting - that is triage's call,
 * one stage later, and it is a model call rather than a filter. Intake only refuses what it cannot
 * physically replay: a survivor with no replacement text is not a patch, and a span with no columns
 * cannot be located unambiguously inside a line.
 */

interface IntakeResult {
    gaps: SurvivorGap[];
    excluded: IntakeExclusion[];
}
declare function intakeSurvivors(mutants: readonly NormalizedMutant[]): IntakeResult;

/**
 * Trivial normalization before model triage (C6).
 *
 * WHY IT EXISTS. Meta's equivalence detector went from precision 0.79 / recall 0.47 to 0.95 / 0.96
 * mostly by normalizing trivia before the model saw it (FSE 2025). The cheap half of that result is
 * available here: a mutation whose replacement text is the ORIGINAL text modulo comments and
 * whitespace changed nothing at all, and asking a model about it spends a call to be told so.
 *
 * WHAT THIS IS NOT. It is not a heuristic filter and carries no threshold. The only verdict it may
 * reach on its own is `identical-after-normalization`, which is a PROVABLE claim about two strings,
 * not a judgement about program behaviour. Everything else - every mutation that actually changed
 * the source - goes to the model. A filter that guesses at equivalence would be the v1 funnel
 * rebuilt one stage earlier.
 *
 * WHERE IT REFUSES. The scanner understands string literals, template literals and comments. It
 * does NOT parse regular expressions, and a regex character class may legally contain `//`, which
 * a comment-stripping scanner would read as the start of a comment and delete the rest of the line.
 * Rather than guess, a span carrying an unresolvable `/` is marked unsafe and compared verbatim.
 * (Rule 1 of docs/lessons/verifying-rules.md: show what the rule keeps and what it excludes; the
 * exclusions here are visible in the returned `safe` flag and covered by named tests.)
 */
interface NormalizedSpan {
    normalized: string;
    /**
     * False when the scanner met a `/` it could not classify as comment, division or regex. The
     * normalized form is then not trustworthy and callers must compare the raw text instead.
     */
    safe: boolean;
}
/**
 * Strip comments, collapse insignificant whitespace, drop a trailing semicolon and any fully
 * redundant wrapping parentheses. String and template literal contents are preserved byte for byte.
 */
declare function normalizeSpan(text: string): NormalizedSpan;
declare const TRIVIAL_VERDICTS: readonly ["identical-after-normalization", "needs-model"];
type TrivialVerdict = (typeof TRIVIAL_VERDICTS)[number];
interface TrivialTriageResult {
    verdict: TrivialVerdict;
    /** the comparison that produced the verdict, so a reader never has to re-derive it */
    evidence: {
        original: string;
        replacement: string;
        safeToNormalize: boolean;
    };
}
/**
 * The only claim this stage may make on its own: the mutation changed nothing in the source.
 * Everything else is handed to the model with the normalized text, which is the half of C6 that
 * improves the model's own accuracy rather than saving a call.
 */
declare function trivialTriage(input: {
    originalText: string;
    replacement: string;
}): TrivialTriageResult;

interface PlacementInput {
    /** test files the run actually observed the runner collect */
    testFilePaths: readonly string[];
    /** repo-relative file under test */
    targetFile: string;
    /** short unique suffix, so two candidates never collide */
    discriminator: string;
}
interface Placement {
    testFile: string;
    /** the file the convention was copied from, null when none was observed */
    anchor: string | null;
}
declare function placeCandidate(input: PlacementInput): Placement;
/** Nearest by shared directory prefix; ties go to the shortest path, which is the most central. */
declare function chooseAnchor(testFilePaths: readonly string[], targetFile: string): string | null;

/**
 * Rejection as feedback.
 *
 * THE DEFECT THIS REPLACES. In v1 a candidate that failed any check produced nothing: no candidate
 * in the artifact, no line in the check run, and no way for the next attempt to know what happened.
 * A whole answer died behind one small check, silently, and "why do I still not see proposed fixes"
 * had no answer that did not involve reading model-call caches by hash.
 *
 * HERE. Every hold - a model that returned nothing, an admission refusal, a candidate that passed
 * on both sides, a candidate that killed its own gap but nothing else - is appended to this ledger
 * with the stage, the reason and bounded verbatim evidence. The ledger is prompt material for the
 * next round and the funnel's source of truth for the report. Nothing is lost, and nothing is
 * terminal except the budget and the exit proof's verdict.
 */

interface FeedbackEntry extends Hold {
    round: number;
}
declare class FeedbackLedger {
    #private;
    record(gapId: string, round: number, hold: Hold): void;
    for(gapId: string): readonly FeedbackEntry[];
    gaps(): readonly string[];
    /** The prompt-facing form: most recent first, bounded, newest evidence kept in full. */
    promptBlock(gapId: string, maxEntries?: number): string;
    /** Every hold, grouped by stage, for the funnel. */
    byStage(): Record<LoopStage, FeedbackEntry[]>;
}

/**
 * The prompt builder.
 *
 * ONE CALL CARRIES A BATCH. Gaps are asked for together, because latency is the second priority
 * after performance and one round trip for four gaps is three round trips saved. The reply is one
 * JSON object keyed by gap, so a single unparseable reply cannot take out one gap and leave the
 * others in an unknown state - the whole batch is re-asked once with the parse error as feedback,
 * and anything still unparsed becomes a hold rather than a loss.
 *
 * THE PROHIBITIONS ARE STATED, not merely enforced. Admission refuses a source-reading or
 * implementation-replacing test after the fact; saying so in the prompt is how the mechanism gets
 * better rather than how the gate gets busier. Both prohibitions name what a reader of the recorded
 * incidents would recognise.
 */

declare const PROMPT_VERSION = "marigold-generation/8";
declare const TRIAGE_PROMPT_VERSION = "marigold-triage/1";
/**
 * The fixed vocabulary a decline may use, so a truthful blank says WHICH truth.
 *
 * A VALUE, NOT A SENTENCE. `artifact.ts` turns each of these into the hold reason a customer reads,
 * and it matches them exactly; a free-text `note` still travels beside it as evidence, and nothing
 * reads that with a pattern. See {@link artifact.SHAPE_DID_NOT_REACH_HOLD_REASON}.
 *
 * WHY THERE IS A THIRD ONE (2026-08-23). Until F3 Option A widened rules 4 and 5, "the rules forbid
 * this" and "nothing could ever reach this" were the same sentence, so one value carried both. They
 * are no longer the same fact: `node:fs`, `node:os` and `node:child_process` are now ADMITTED under
 * a temp root, so a decline that means "your rules stop me" is a statement about this engine, while
 * a decline that means "the only route runs through a live container, service or network peer" is a
 * statement about the customer's code that no rule change could soften.
 *
 * The data model could not tell those apart, and the difference is the whole value of the decline:
 * the first is a gap worth returning to when the rules move, the second is a wall and reporting it
 * as anything else wastes the reader's time. `structurally-untestable` is the wall said out loud.
 * Both still sit on the same rung - see {@link artifact.isStructurallyUntestable}, which answers for
 * both, so no count that existed before this value moves because of it.
 */
declare const DECLINE_REASONS: readonly ["not-self-containable", "cannot-distinguish", "structurally-untestable"];
type DeclineReason = (typeof DECLINE_REASONS)[number];
/**
 * Rules 4 and 5: what a candidate may import, and what it may do with the filesystem and a process.
 *
 * ONE DEFINITION, TWO PROMPTS. The generation ask and the repair ask must state the same rules
 * word for word - a repair asked under a stricter import rule than the candidate was written under
 * is told to undo the pattern half of this engine's candidates rely on. They were duplicated as two
 * string literals in two files, which is exactly how a drift happens, so they are a function now.
 *
 * F3 OPTION A (Kenneth, 2026-08-21). The blanket ban was refusing the test the repository already
 * writes: 17 of one benchmark package's 18 gaps sit behind logic its own suite reaches with
 * `mkdtempSync` and `execFileSync("git", …)`, and the model declined every one of them, correctly,
 * because these two rules forbade it (`data/abloh-unfixed-gaps-investigation/report.md` F3).
 *
 * The recorded incident these rules exist for is READING A PATH INSIDE THE REPOSITORY - seven fake
 * proofs on one bun repository, from tests that read the source under test as text - so that is
 * what they now say, and building your own fixture under a fresh temporary root is admitted.
 *
 * IMPORTING A SECOND MODULE OF THE REPOSITORY IS NOT THAT EITHER (/8, 2026-09-01,
 * `data/abloh-model-call-proof/report.md` section 5). Rule 4 used to permit "the module under test"
 * and nothing else of the customer's, which left a gap unanswerable between two rules: rule 2 says
 * build the real object the way the repository's own tests build it, and rule 4 said the factory
 * that builds it may not be imported. Cheerio's `_matchUntil` was declined in exactly those words.
 * A test that imports the repository's own factory is doing what the repository's own suite does,
 * and the ban that carries the incident is on READING a repository path as data, which rule 5a
 * states and `temp-root.ts` enforces.
 *
 * THIS HALF WAS NEVER ENFORCED, and that is the argument for stating it the wider way rather than
 * for building an enforcement to match. `admission.ts` skips any specifier beginning with `.`
 * before it asks whether the project declares it, so a relative import of another module of the
 * repository has always been admitted; only the sentence said otherwise, and a rule the gate does
 * not hold is a rule that costs proposals and buys nothing.
 *
 * EVERY SENTENCE BELOW IS ENFORCED, not merely asked for: `admission.ts` calls `temp-root.ts`,
 * which refuses anything its provenance analysis cannot follow. The rules are stated here for the
 * reason this file's header gives - saying the prohibition is how the mechanism gets better rather
 * than how the gate gets busier - and the adversarial battery in `temp-root.test.ts` is what proves
 * the two agree.
 *
 * RULE 4 CARRIES THE EXTENSION SENTENCE (/6, 2026-08-23, F4 and D3). It sits here rather than beside
 * the per-gap block for the reason this whole function exists: generation and repair must ask the
 * same question, and a repair told to spell the import the old way would undo the candidate it is
 * repairing. It is worded against the runner AND the file's extension.
 *
 * THE SENTENCE IS THE BELT, NOT THE FIX (Kenneth's option-B ruling, 2026-08-23). `importSpecifierFor`
 * used to rewrite `.ts` to `.js` for every esm project, so the per-gap `import the code under test
 * as:` line HANDED node:test the exact spelling F4 measured as dead, and this rule would have been
 * the weaker of two contradicting instructions. That function is now runner-aware and the two agree.
 * The rule stays, and still says it overrides that line, for the case the mechanism cannot cover: a
 * repository whose runner is detected as something else, or a target the specifier logic never saw.
 *
 * RULE 5 CARRIES A WORKED EXAMPLE (/6, 2026-08-23, `data/abloh-prompt5-prb-confirm/report.md`
 * section 4). Four of one benchmark package's 18 gaps were denied at admission for provenance the
 * model got NEARLY right, and the one candidate that got the shape exactly right sailed through. A
 * model copying three literal lines lands on a shape `temp-root.ts` can follow; a model translating
 * prose into code lands near it. `prompt-worked-example.test.ts` runs the example through
 * `admitCandidate` so this block cannot drift out of compliance with the analysis it teaches.
 */
/**
 * The three lines rule 5 shows, exported so a test can put them through `admitCandidate`.
 *
 * A CONSTANT RATHER THAN PROSE INSIDE THE RULE, for one reason: an example that the enforcer would
 * refuse is worse than no example, and the only way to know is to run it. `prompt-worked-example.
 * test.ts` wraps these lines in a candidate and asserts admission returns no findings, so a later
 * tightening of `temp-root.ts` that outlawed this shape would fail there rather than silently start
 * teaching the model a refused pattern.
 *
 * ALL THREE HALVES OF RULE 5 IN THREE LINES: the root, a path built from it, and a `git` invocation
 * whose cwd is under it. Those are the two shapes PR-B's four denied gaps got wrong.
 */
declare const WORKED_TEMP_ROOT_EXAMPLE: string[];
declare function importRules(): string[];
interface BatchPromptItem {
    gap: SurvivorGap;
    context: GapContext;
    /** repo-relative path the candidate must occupy */
    testFile: string;
    /**
     * Every OTHER replacement still open at this gap's exact span.
     *
     * The loop asks one question per span rather than one per replacement, and this is the rest of
     * that span's mutations put in front of the model so one test can be written to catch all of
     * them. Empty on a span carrying a single mutation, which is most of them.
     */
    siblingReplacements?: readonly string[];
}
/**
 * What the file offers a test as an entry point.
 *
 * A DEFAULT EXPORT IS NAMED, NOT OMITTED. Saying "none detected" to a model looking at a file whose
 * only export is `export default Thing` sends it guessing a named import, and the candidate dies on
 * `is not a constructor` having tested nothing. E3's forensics found every reliably closed gap sat
 * in a file whose exports the extractor could see; the 21-gap file exported only a default.
 *
 * SIGNATURES WHEN THERE ARE ANY, NAMES ONLY WHEN THERE ARE NOT. A bare name list is what let three
 * of run A's gaps die on an invented `readRunReports([documents])` whose real declaration takes a
 * directory path, and what sent eight of run B's candidates through an export whose name says "for
 * tests" and whose signature says it is unrelated. {@link GapContext.exportSignatures} carries the
 * measurement.
 */
declare function exportsLine(context: GapContext): string;
declare function buildBatchGenerationPrompt(input: {
    items: readonly BatchPromptItem[];
    ledger: FeedbackLedger;
    runner: string;
    moduleFormat: "cjs" | "esm";
    /** an existing test from the repository, so the candidate matches local conventions */
    exampleTest?: {
        path: string;
        source: string;
    };
}): string;
declare function buildTriagePrompt(input: {
    gap: SurvivorGap;
    context: GapContext;
    /** normalized forms from the trivial-normalization pass, which is what the model should compare */
    normalized: {
        original: string;
        replacement: string;
    };
}): string;

/**
 * Candidate admission.
 *
 * WHAT THIS IS FOR. Two cheat channels have recorded reproductions in this product's own history,
 * and both produced candidates labelled PROVEN that tested nothing:
 *
 *   1. The source-reading fake. A generated test read the source file as text and asserted it
 *      contained the unmutated line. It passes on the real source, fails on the mutant, and knows
 *      nothing about behaviour. Seven of these were once labelled proven on one bun repository.
 *   2. The implementation-rewrite fake. A generated test stubbed or replaced the function under
 *      test and asserted on its own replacement. Two of three proven candidates on one repository
 *      got there this way.
 *
 * Those two reproductions are the justification for this stage existing at all; every rule below
 * traces to one of them, to path containment, or to a byte cap. Nothing here is a quality filter,
 * a style rule or a threshold - a candidate is refused only when it would prove something other
 * than what the proof claims.
 *
 * AND IT IS NOT TERMINAL. A refusal returns as feedback naming the rule and the offending line, and
 * the gap is re-asked with that text in the prompt. In v1 an admission refusal ended the gap
 * silently and the check run said nothing at all.
 */
interface AdmissionInput {
    /** repo-relative path the caller reserved for the test */
    testFile: string;
    testSource: string;
    supportFiles?: ReadonlyArray<{
        path: string;
        source: string;
    }>;
    /** support paths the caller reserved; anything else is not admitted */
    allowedSupportPaths?: readonly string[];
    /** bare package specifiers the project actually declares */
    allowedBareImports?: readonly string[];
    /** repo-relative path of the file under test, so its module cannot be replaced */
    targetFile: string;
    maxSourceBytes?: number;
    maxTotalBytes?: number;
    maxFiles?: number;
}
interface AdmissionFinding {
    rule: AdmissionRule;
    detail: string;
}
declare const ADMISSION_RULES: readonly ["path-not-contained", "path-not-reserved", "file-empty-or-binary", "byte-cap", "file-count", "denied-module", "undeclared-import", "dynamic-code", "target-replacement", "no-test-declared"];
type AdmissionRule = (typeof ADMISSION_RULES)[number];
interface AdmissionResult {
    admitted: boolean;
    findings: AdmissionFinding[];
    /** every module specifier the bundle imports, for the artifact's disclosure */
    imports: string[];
    /** the first declared test name, which the report parser needs to prove execution */
    testName: string | null;
}
declare function admitCandidate(input: AdmissionInput): AdmissionResult;
/** Does `specifier`, written in a test at `testFile`, resolve to `targetFile`? */
declare function mocksTargetModule(specifier: string, testFile: string, targetFile: string): boolean;
declare function isContainedRelativePath(path: string): boolean;
/**
 * Static `import ... from "x"`, `import "x"`, `export ... from "x"` and literal `require("x")`.
 *
 * MATCHED IN BLANKED SOURCE, READ OUT OF REAL SOURCE, and the two halves are why this is not a
 * one-line regex any more.
 *
 * The scan used to run its patterns over `stripComments(source)`, which keeps string CONTENTS
 * because a specifier lives inside one. `/\bimport\s*['"]([^'"]+)['"]/` has `\s*` - zero or more -
 * so the WORD `import` at the end of a test name, immediately followed by that string's closing
 * quote, matched, and everything up to the next quote in the file was captured as a module
 * specifier. Measured on the complete-fix benchmark's run A: a candidate that passed against the
 * real source and failed against its planted mutant was refused as `undeclared-import` for
 * importing `", () => {\n  const source = generatedConfigSource({\n    baseConfig: "`
 * (`data/abloh-unfixed-gaps-investigation/report.md` BUG 1).
 *
 * The blast radius was never one candidate: ANY test whose name ends in `import`, and any assertion
 * on generated code that contains an import statement, was refused - both ordinary in a repository
 * that generates config files, which is what the file under test did.
 *
 * So the patterns run over {@link stripLiteralsAndComments}, where a string's contents are spaces
 * and its quotes are kept in place, and the specifier is read back OUT OF THE ORIGINAL at the
 * capture group's offsets. A real import still yields its specifier exactly; a sentence inside a
 * string no longer contains the word `import` at all. The `d` flag is what makes the offsets
 * available, and it is the whole mechanism.
 */
declare function moduleSpecifiers(source: string): string[];
declare function firstDeclaredTestName(source: string): string | null;
/** Comments only: string contents survive, because a module specifier lives inside one. */
declare function stripComments(source: string): string;
/**
 * Replace the CONTENTS of strings, template literals and comments with spaces, keeping offsets, so
 * a pattern search sees code and never a sentence inside a string. Without it a test whose message
 * reads "does not call jest.mock" would be refused for calling it.
 */
declare function stripLiteralsAndComments(source: string): string;

interface GenerationOutcome {
    candidates: Candidate[];
    /** gaps in this batch that produced nothing, each with the reason to re-ask on */
    holds: Array<{
        gapId: string;
        hold: Hold;
    }>;
    modelCalls: number;
    /** one entry per call this batch actually sent, including an effort-down retry */
    timings: ModelCallRecord[];
}
interface ReplyCandidate {
    gapId?: unknown;
    testName?: unknown;
    testBody?: unknown;
    declined?: unknown;
    note?: unknown;
}
declare function generateBatch(input: {
    items: readonly BatchPromptItem[];
    ledger: FeedbackLedger;
    client: ModelClient;
    pin: TaskModelPin;
    runner: string;
    moduleFormat: "cjs" | "esm";
    exampleTest?: {
        path: string;
        source: string;
    };
    round: number;
    /** what remains of the loop's wall-clock; each call's derived deadline is clamped to it */
    remainingBudgetMs?: number;
    signal?: AbortSignal;
}): Promise<GenerationOutcome>;
type ParsedReply = {
    ok: true;
    candidates: ReplyCandidate[];
} | {
    ok: false;
    reason: string;
};
/**
 * NDJSON: one JSON object per line, no wrapper.
 *
 * Every complete line is harvested and a trailing partial one is ignored, which is the whole point
 * of the shape: a reply cut off by a deadline still yields every gap already written, where a
 * truncated single object yielded nothing. A legacy `{"candidates":[...]}` reply is still accepted,
 * because the model occasionally answers in the older shape and refusing it would spend a call to
 * punish punctuation.
 */
declare function parseCandidatesReply(text: string): ParsedReply;

/**
 * The light check: one run per side, on the reused image.
 *
 * WHY ONE RUN. The expensive proof - repetitions with alternating order, the whole suite, the
 * discovery sentinel - is worth paying for a candidate that is going to be offered. It is not worth
 * paying for a candidate that passes on both sides, and most rejected candidates fail that cheaply.
 * So the loop separates the two: a cheap two-execution screen here, and one full exit proof later
 * on the winning set only. Performance first, latency second: two executions per candidate is the
 * smallest evidence that can distinguish a mutant at all.
 *
 * WHAT A FAILURE MEANS. Nothing terminal. Each verdict below names what the runner did, and that
 * text goes into the next round's prompt for the same gap.
 */

interface LightCheckOptions {
    runner: SealedRunner;
    timeoutMs: number;
}
declare function lightCheck(candidate: Candidate, gap: SurvivorGap, options: LightCheckOptions): Promise<LightCheckResult>;
declare function toSideRun(result: {
    report: {
        passed: boolean;
        executed: boolean | null;
        failedAssertion: boolean;
    };
    output: string;
    wallMs: number;
}): SideRun;
declare function lightCheckHoldReason(verdict: LightCheckResult["verdict"], gateShaped?: boolean): string;

/**
 * The kill matrix.
 *
 * THE ONE STRUCTURAL IDEA IN THIS ENGINE. A test written for one gap frequently kills several: it
 * exercises a code path, and every surviving mutation on that path now has a test that notices it.
 * v1 never found out, because it proved a candidate against its own target and moved on.
 *
 * So after the light check, each surviving candidate is REPLAYED against every gap still open. The
 * mutation engine is not involved: replaying means applying a survivor's recorded patch and running
 * one already-written test, which is one container execution and no model call. Mutation never
 * re-runs inside the loop.
 *
 * The matrix then decides which candidates to keep: the fewest candidates that close the most gaps,
 * greedily. Candidates that close nothing new are held with that reason rather than discarded, and
 * gaps still open after the matrix are re-prompted next round carrying what the replay showed.
 */

interface KillMatrixOptions {
    runner: SealedRunner;
    timeoutMs: number;
    /** ceiling on replay executions; a truncated matrix is disclosed, never silently truncated */
    maxExecutions: number;
}
interface KillMatrixResult {
    cells: KillMatrixCell[];
    /** candidateId -> gapIds it kills, including its own */
    kills: Map<string, Set<string>>;
    executions: number;
    /** replays the ceiling refused; > 0 means the matrix is incomplete and says so */
    skipped: number;
}
/**
 * `candidates` are those that already distinguish their own gap; `openGaps` are the gaps still
 * unclosed. A candidate's own gap is already known and is not replayed.
 */
declare function buildKillMatrix(input: {
    candidates: readonly Candidate[];
    openGaps: readonly SurvivorGap[];
    options: KillMatrixOptions;
}): Promise<KillMatrixResult>;
interface WinningSet {
    /** the candidates to take to the exit proof */
    chosen: string[];
    /** gapId -> candidateId that closes it */
    closedBy: Map<string, string>;
    /** candidates that close nothing the chosen set does not already close */
    redundant: string[];
}
/**
 * Greedy set cover: repeatedly take the candidate closing the most still-open gaps.
 *
 * Greedy rather than optimal on purpose. The optimal cover is NP-hard, the sets here are small, and
 * greedy is within a log factor - but more importantly the cost being minimised is EXIT PROOFS, and
 * a cover one candidate larger than optimal costs one extra proof, not a wrong answer.
 */
declare function chooseWinningSet(kills: ReadonlyMap<string, Set<string>>, openGapIds: readonly string[]): WinningSet;

/**
 * WHAT ONE WHOLE-SUITE MUTANT RUN PROVED, read as a DIFFERENCE and never as a colour.
 *
 * THE RULE IS NOT NEW AND THIS IS NOT A SECOND ONE. `docs/lessons/a-gate-measures-the-difference.md`
 * settled it on 2026-08-23 for the exit proof: a suite that is already red for its own reasons
 * convicts nobody, so a run is judged on the tests that fail with the mutant present and passed
 * without it. `suiteDelta` in `exit-proof.ts` is that arithmetic and this module calls it. What is
 * added here is the two answers a mutant needs that a candidate does not - "nothing was measured"
 * and "nothing noticed" - and the laziness that keeps the baseline free on a healthy repository.
 *
 * WHY THE GUTTING PASS AND THE SLICE NEEDED IT (census run 6, and
 * `data/abloh-sealed-execution-slowness-design-review/report.md` section 1.5). Both read
 * `run.report.passed` and nothing else: red meant "the tests caught it". Two shapes make that false
 * and both are ordinary inside a seal. `unocss/unocss`'s `preset-web-fonts` test fetches over a
 * network `--network none` does not have, and `sveltejs/svelte`'s `runtime-browser/test.ts` launches
 * a chromium the borrowed tree does not carry - so EVERY sealed run of those suites is red before a
 * mutant is reached. And three of unocss's executions were killed at abloh's own 600 s ceiling with
 * their suites hung. The artifact published `gutting.testsFightBack: 1` and `slice.covered: 2`:
 * three claims that a repository's tests noticed a removed function body, about three runs that
 * never finished.
 *
 * THE THREE ANSWERS, and each is a different piece of news:
 *
 *   noticed       tests fail with the body gone that passed with it there. The only grounds for
 *                 saying the suite fought back.
 *   unnoticed     the suite is green, or it is red in exactly the ways it was already red. Nothing
 *                 in it can see the body go.
 *   not-executed  abloh could not measure: the request never ran, the wall stopped it part-way, or
 *                 there is no baseline to take a difference against.
 *
 * LAZY, for the reason `measureSuiteBaseline` is lazy: a run that comes back GREEN needs no baseline
 * at all - nothing failed, so nothing new failed - and that is the whole of a healthy repository's
 * pass. The baseline is asked for the first time a mutant run comes back red, at most once per
 * probe, and what it costs is charged to the result that asked for it.
 */

declare const MUTANT_READINGS: readonly ["noticed", "unnoticed", "not-executed"];
type MutantReading = (typeof MUTANT_READINGS)[number];
/** Why the reading is what it is. The first two are this module's; the rest are `suiteDelta`'s. */
type MutantReadingBasis = "timed-out" | "not-run" | SuiteDeltaBasis;
interface MutantDifference {
    reading: MutantReading;
    basis: MutantReadingBasis;
    /** tests that fail with the mutant and passed without it. Customer prose - never egresses. */
    newFailures: readonly string[];
    /**
     * What the BASELINE cost: 1 on the run that first measured it, 0 on every one after, and 0
     * whenever it was never needed.
     *
     * IT IS THE RUN'S EXECUTION AND NOT THE PASS'S, which is why it is reported separately rather
     * than folded in. A pass's own counter says how many MUTANTS it ran - the slice's `cap` is a
     * promise about exactly that, and an ingest door recomputes it - while the unpatched side is one
     * shared measurement that pool 2 asks the same probe for. What it belongs in is the pass's own
     * PRICE: a work-item boundary is priced from what the stage spent, and the stage spent both.
     * Nothing is lost either way, because `runner.executions` counts every execution a run made.
     */
    baselineExecutions: 0 | 1;
}
/**
 * Read one whole-suite mutant execution against the suite with no mutant in it.
 *
 * `run` IS THE LIVE RESULT and not stored evidence, for `suiteDelta`'s own reason: the bounded
 * `output` beside it truncates, and a comparison built on truncated text finds no failures on
 * either side and admits everything.
 */
declare function readMutantRun(input: {
    run: Pick<ExecutionResult, "error" | "report" | "timedOut">;
    /**
     * THE SAME MEASUREMENT WITH NO MUTANT IN IT, as a function, so this reader never has to know WHICH
     * measurement that is. The gutting pass removes a body and runs the whole suite, so its baseline is
     * the whole suite; the slice runs one covering test FILE, so its baseline is that same file run
     * unpatched - comparing it against the whole suite's would set every other file's failures against
     * it, which is the reason pool 2's probe is keyed per shape.
     *
     * CALLED AT MOST ONCE PER READING, and only where a difference is really needed. Whoever supplies
     * it owns the memoisation and the charging; both probes already do.
     */
    baseline: () => Promise<SuiteBaseline>;
}): Promise<MutantDifference>;

/** One package's dispatched result, in the order the run measured them. */
interface ProposalsPackageResult {
    directory: string;
    block: ProposalsBlock;
}
/**
 * The run-level `proofsDigest` of a composed block.
 *
 * A composed run wrote one sidecar PER PACKAGE, so there is no single file this could be the digest
 * of. It is instead a commitment to the ordered list of (directory, that package's own digest)
 * pairs: checking it means checking that the set of per-package sidecars is the set this block was
 * built from, and each package's own digest still checks its own bytes. Stated here rather than
 * left to be inferred, because a digest whose meaning is guessed is a digest nobody verifies.
 */
declare function composedProofsDigest(entries: readonly ProposalsPackageResult[]): string;
/**
 * Recompose the run-level `signedScore` from entries that have since acquired one.
 *
 * BOTH RATES READ THE CLASSIC MEASUREMENT, which is not finished when the blocks are composed - the
 * CLI writes each entry's rates after the classic counts are final, and this folds them up again.
 * Composing at build time and never revisiting would leave a composed run with no rates at all,
 * which is the shape a reader would take as "this run had no pool-2 component".
 *
 * A no-op on a block with no entries, so the single-package path is untouched.
 */
declare function recomposeProposalsScore(block: ProposalsBlock): void;
/**
 * Compose the run's block from one entry per measurable touched package.
 *
 * A single entry returns its own block VERBATIM and with no `packages` array - the composition must
 * be invisible where it does not apply, and "invisible" here means byte-identical, which
 * `composition.test.ts` and the single-package acceptance fixtures both hold it to.
 */
declare function composeProposalsBlocks(entries: readonly ProposalsPackageResult[]): ProposalsBlock;

declare const LINE_MUTATOR = "LineOperator";
/**
 * The operator classes, named so a map entry says what was tried on a line.
 *
 * Six classes, each one token rewrite. They are deliberately few: the pass is a blind-spot detector
 * and its value is per-line coverage of the file, not variety at one site. A second mutation of the
 * same line answers a question the first already answered.
 */
declare const LINE_OPERATORS: readonly ["boundary", "equality", "logical", "arithmetic", "literal-increment", "boolean-flip"];
type LineOperator = (typeof LINE_OPERATORS)[number];
/** One planned per-line mutation: the operator class, and the patch that realises it. */
interface LineMutant {
    file: string;
    startLine: number;
    endLine: number;
    operator: LineOperator;
    gap: SurvivorGap;
}
/**
 * EVERY REWRITE THIS PASS ACTUALLY RUNS, by its own operator name.
 *
 * WHY IT LIVES HERE AND NOT BESIDE ITS READER. Its one consumer is the bug pool's exclusion block,
 * which tells a model "anything the free pass can express is bought and paid for, so a bug of yours
 * that repeats it buys this run nothing". That sentence is only worth anything if the list is the
 * list, and the only way to keep it the list is to derive it from {@link BINARY_SWAPS} and the two
 * literal rules below - the very table {@link planLineMutants} reads. A hand-written copy beside the
 * consumer is how the previous one came to name fifteen operators for an engine that ran six.
 *
 * A SENTENCE ABOUT THE EDIT, NOT ABOUT THE BUG, which is the shape that block requires: "swaps a
 * comparison for the one next to it" is checkable against a proposal, where "boundary confusion" is a
 * category whose edges the reader has to guess.
 */
declare function lineOperatorInventory(): Array<{
    id: string;
    rewrite: string;
}>;
/**
 * Every per-line mutation this pass can build for one file, in source order.
 *
 * A FILE THE PARSER CANNOT READ YIELDS NOTHING, exactly as `functions.ts` refuses one: error
 * recovery invents nodes, and a token span taken from an invented node patches the wrong bytes.
 *
 * ONE MUTATION PER SITE. The site is the token, so a line carrying three comparisons offers three -
 * that is three different lines' worth of behaviour on one physical line, and the selection below is
 * what bounds the total.
 */
declare function planLineMutants(source: string, file: string): LineMutant[];
/**
 * At most `cap` mutants for one file, spread across it rather than taken off the top.
 *
 * WHY A CAP AT ALL. One execution per mutant is the whole cost of this pass, and a 400-line file
 * offers hundreds. Without a bound one file would consume a night's mechanical share and the
 * rotation would never reach a second one.
 *
 * WHY EVENLY SPREAD AND NOT THE FIRST N. The cap is spent every visit to the same file, so taking
 * the first N would measure the top of every large file forever and never the rest. Striding takes
 * every k-th site, which covers the file's whole length at low density; the rotation then brings the
 * file back on a later night for a different pass only if its bytes changed, which is the honest
 * limit of a fixed cap and is stated in the map's `complete` flag rather than hidden.
 *
 * DETERMINISTIC. The same file at the same bytes selects the same mutants on every night and on
 * every machine, which is what lets two nights' maps be compared at all.
 */
declare function selectLineMutants(mutants: readonly LineMutant[], cap: number): LineMutant[];
declare const LINE_VERDICTS: readonly ["survived", "killed", "not-measured"];
type LineVerdict = (typeof LINE_VERDICTS)[number];
/** One measured mutation: where it was, what was tried, what the suite said. */
interface LineOutcome {
    startLine: number;
    endLine: number;
    operator: LineOperator;
    verdict: LineVerdict;
    /**
     * Test files PROVEN to observe this line, when the attribution scan found one.
     *
     * Absent means not known - the scan was capped, or the mutation was not measured. Never read it as
     * "no test covers this line": that fact is carried by a `survived` verdict, which is the whole
     * suite having run and said nothing.
     */
    coveringTestFiles?: readonly string[];
}
/** What the pass learned about one file, and whether it finished it. */
interface LineFileResult {
    file: string;
    /** sha256 of the exact bytes measured; the freshness key every reader checks */
    contentDigest: string;
    outcomes: LineOutcome[];
    /** every planned mutant was measured; a false here is a file the caller must offer again */
    complete: boolean;
    executions: number;
}
interface LinePassResult {
    files: LineFileResult[];
    /** files the caller put in front of the pass */
    offered: number;
    /** files measured end to end */
    measured: number;
    /** files left for a later night, first in line when it comes */
    deferred: number;
    /** the pass stopped because its share of the window closed rather than because work ran out */
    budgetSpent: boolean;
    executions: number;
}
/**
 * How many mutants one file's pass may spend, per visit (RULED, 2026-08-15).
 *
 * TWELVE, derived from the two numbers either side of it. One execution costs ~11 s
 * (`MEASURED_EXECUTION_MS` in `sizing.ts`, measured), so twelve mutants is about two and a quarter
 * minutes of a file's whole-suite runs before attribution - the same order as the night's per-file
 * planting ask of eight, which is the ask this map exists to aim. Larger would let one file eat the
 * mechanical share; smaller would produce a map too sparse for a planting prompt to aim with.
 */
declare const RULED_LINE_PASS_MUTANTS_PER_FILE = 12;
/**
 * How many test files a killed line's attribution scan may try (RULED, 2026-08-15).
 *
 * FOUR. The scan exists to name the tests that can catch a bug on a line, which is architecture H's
 * input, and H's own selection is by FILE because the runner executes one test file per call
 * (`covering-tests.ts`). Four is the point where the scan costs less than the whole-suite run it is
 * trying to replace on a repository of ordinary shape; past it the scan is the expensive thing. A
 * line whose catcher is not in the first four tried is recorded with no covering set, which reads as
 * "not known" and costs the pool exactly the whole-suite run it always had.
 */
declare const RULED_LINE_PASS_ATTRIBUTION_TEST_FILES = 4;
interface LinePassInput {
    repoDir: string;
    /** the files to measure, in the caller's own rotation order */
    files: readonly string[];
    runner: SealedRunner;
    /** every test file the run observed; the attribution scan tries these, in this order */
    testFilePaths: readonly string[];
    suiteTimeoutMs: number;
    targetedTimeoutMs: number;
    /** explicit, no default: `RULED_LINE_PASS_MUTANTS_PER_FILE` is what a caller writes down */
    mutantsPerFile: number;
    /** explicit, no default: `RULED_LINE_PASS_ATTRIBUTION_TEST_FILES` */
    attributionTestFiles: number;
    /** asked before every mutant; true ends the pass on a file boundary and defers the rest */
    stop: () => boolean;
}
/**
 * Run the pass.
 *
 * THE ORDER IS SUITE FIRST, ATTRIBUTION SECOND, and that ordering is the cost model. The verdict is
 * the whole suite, which is the same one execution a gutting mutant costs and the only execution a
 * survivor ever costs; attribution is bought only for a line the suite DID notice, because a line
 * nothing noticed has no covering test to name.
 */
declare function runLinePass(input: LinePassInput): Promise<LinePassResult>;

declare const LINE_MAP_SCHEMA = "abloh-marigold-line-maps/v1";
/** One span the suite was proven blind to. */
interface BlindSpan {
    startLine: number;
    endLine: number;
    /** which operator class demonstrated it; kept so a second night can compare like with like */
    operator: LineOperator;
}
/** One span and the test files proven to observe it. */
interface CoveredSpan {
    startLine: number;
    endLine: number;
    /** repo-relative test file paths, in the order the attribution scan proved them */
    testFiles: string[];
}
interface StoredLineMap {
    file: string;
    /** sha256 of the exact bytes measured - the freshness key */
    contentDigest: string;
    /** the night that measured it, for the report and for ordering */
    nightId: number;
    measuredAtMs: number;
    /** spans the whole suite did not notice: the blind-spot map */
    survivors: BlindSpan[];
    /** spans with a proven catcher: the coverage map. A lower bound, never a census */
    coverage: CoveredSpan[];
    /** mutations measured for this file, so a reader can tell a defended file from a thin pass */
    measured: number;
}
interface LineMapStoreData {
    schema: typeof LINE_MAP_SCHEMA;
    files: StoredLineMap[];
}
/** How many file records one repository's store keeps. Bounded so a long-lived store cannot grow without end. */
declare const LINE_MAP_FILE_LIMIT = 2000;
declare class LineMapStore {
    #private;
    private constructor();
    /** A corrupt or wrong-schema file is no store: every read answers absent, which changes nothing. */
    static open(storeDir: string, repoKey: string): LineMapStore;
    get data(): LineMapStoreData;
    get path(): string;
    /**
     * The record for a file, ONLY when it describes the bytes on disk right now.
     *
     * The caller supplies the digest because the caller is the one holding the source; recomputing it
     * here from a path would make this store read a repository, which is not its job and is not always
     * possible (the night's checkout is gone by the time a later reader asks).
     */
    fresh(file: string, contentDigest: string): StoredLineMap | null;
    /** Every fresh record among the files the caller has digests for. */
    freshAmong(digests: ReadonlyMap<string, string>): StoredLineMap[];
    /** Write one finished file's maps. Re-measuring a file replaces its record: the map is singular. */
    record(input: {
        result: LineFileResult;
        nightId: number;
        nowMs: number;
    }): void;
    save(): void;
}
/**
 * The coverage index these maps answer, for the pool's covering-tests selection (architecture H).
 *
 * Only FRESH records contribute, and a file with no proven catcher contributes nothing rather than
 * an empty answer - the index's own rule: absent means "not known", and the caller then runs the
 * whole suite exactly as it did before any of this existed.
 */
declare function lineMapCoverageIndex(maps: readonly StoredLineMap[]): CoverageIndex;

declare const SLICE_LEDGER_SCHEMA = "abloh-marigold-slice-ledger/v1";
/** One neighbour's one answer, under the key that makes it still true. */
interface StoredSliceAnswer {
    /** `(file, body digest, covering test file digests, runner)`, hashed - see {@link sliceAnswerKey} */
    key: string;
    /** repo-relative path, kept beside the key so a reader of the file can see what it is about */
    file: string;
    /** the neighbour's own name, or null where its declaration carries none */
    name: string | null;
    /** the one word: what happened when this function's body was removed */
    outcome: SliceOutcome;
    /**
     * WHICH RUN MEASURED IT, so a surface can say "carried from run X" rather than presenting a
     * carried answer as one this run took. A carried measurement a reader cannot date is a claim.
     */
    runId: string;
    /** when it was measured, epoch milliseconds, so the eviction below has an order to work in */
    measuredAtMs: number;
}
interface SliceLedgerData {
    schema: typeof SLICE_LEDGER_SCHEMA;
    answers: StoredSliceAnswer[];
}
/**
 * How many answers one repository's ledger keeps.
 *
 * BOUNDED SO A LONG-LIVED STORE CANNOT GROW WITHOUT END, on `LINE_MAP_FILE_LIMIT`'s own reasoning.
 * The cap is per repository and each entry is a few hundred bytes, so a thousand of them is a file
 * a reader can still open. Eviction is oldest-measured first, which is also stalest-key first: an
 * answer nothing has re-asked for is the one whose function is most likely to have moved.
 */
declare const SLICE_LEDGER_LIMIT = 1000;
/**
 * The key one answer is true under.
 *
 * THE COVERING FILES ARE SORTED AND JOINED rather than hashed one at a time, because the SET is the
 * fact: two runs that find the same three test files in a different order are asking one question.
 * A neighbour NO test file executes has an empty set, which is a real key and the commonest one -
 * and it is exactly right that it changes the moment a test starts executing the function.
 */
declare function sliceAnswerKey(input: {
    file: string;
    bodyDigest: string;
    coveringTestFileDigests: readonly string[];
    runner: string;
}): string;
declare class SliceLedger {
    #private;
    private constructor();
    /** A corrupt or wrong-schema file is no ledger: every read answers absent, which measures. */
    static open(storeDir: string, repoKey: string): SliceLedger;
    get data(): SliceLedgerData;
    get path(): string;
    /** The answer held under this key, or null - which is the same as never having asked. */
    lookup(key: string): StoredSliceAnswer | null;
    /**
     * Write one neighbour's answer, replacing whatever stood under the same key.
     *
     * `not-executed` IS NOT AN ANSWER AND IS NOT KEPT. It says the run itself failed, which is a fact
     * about a container rather than about the function - carrying it would make a machine that was
     * briefly broken look like a measurement, and the next run would trust it.
     */
    record(answer: StoredSliceAnswer): void;
    save(): void;
}

/**
 * The reuse decision for one run: which survivors' verdicts are reused, which execute live, and
 * why - every exclusion named, because "how much of this run was fresh" is a sentence the artifact
 * must let a reader finish.
 *
 * ONE RULE HAS NO EXCEPTION: a REPORTED gap always re-executes live. Reuse may skip re-proving
 * that a killed mutant is still killed; it never lets a customer-facing gap claim rest on a cached
 * answer. A survivor whose stored verdict says "survived" is therefore still executed when it is
 * about to be reported - the cache saves the kills, which are the bulk, and never the claims.
 */

declare const REUSE_DECISIONS: readonly ["reused", "execute-fresh-no-record", "execute-invalidated-file", "execute-invalidated-reach", "execute-invalidated-recipe", "execute-rebaseline", "execute-reported-gap", "execute-direction-rule", "execute-forced-full"];
type ReuseDecision = (typeof REUSE_DECISIONS)[number];
interface ReusePlanEntry {
    gapId: string;
    decision: ReuseDecision;
    /** the stored status when a record existed, whatever the decision */
    storedStatus?: MutantStatus;
}
interface ReusePlan {
    entries: ReusePlanEntry[];
    rebaseline: boolean;
    wholesaleInvalidated: boolean;
    reused: number;
    executed: number;
}
interface ReuseCandidate {
    gapId: string;
    file: string;
    fileDigest: string;
    /** canonical identities of the tests reaching the span; empty means reach is unknown */
    reachingTests: readonly string[];
    /** will this gap be REPORTED as surviving if the verdict holds? */
    wouldBeReported: boolean;
}
/**
 * The two whole-store digests, computed over every level from the MEASURED PACKAGE up to the
 * repository root.
 *
 * `subdir` is optional so the existing callers keep compiling, and omitting it reproduces the
 * repository-root-only behaviour - which is correct for a single-package repository and was the
 * documented unsoundness on every monorepo. Any caller that knows which package it is measuring
 * should pass it; the CLI's detection already carries it.
 */
declare function currentWholesaleDigests(repoDir: string, subdir?: string | null): {
    lockfileDigest: string;
    configDigest: string;
};
declare function planReuse(input: {
    store: ReuseStore;
    repoDir: string;
    recipeDigest: string;
    candidates: readonly ReuseCandidate[];
    policy: RebaselinePolicy;
    /** the clock, passed in rather than read: the days rail must be reproducible in a test */
    nowMs: number;
}): ReusePlan;
/**
 * One survivor as the carry planner sees it.
 *
 * `reachAttributed` is separate from `reachingTests` on purpose. An empty reach set means two
 * different things - "no test reaches this span", which is a fact, and "coverage attribution was
 * unavailable", which is an absence of one - and they must not digest alike. Unknown reach is
 * treated as CHANGED, never as equal, so a run that could not attribute coverage carries nothing
 * rather than carrying answers reached on a different premise.
 */
interface CarryCandidate {
    gapId: string;
    file: string;
    fileDigest: string;
    reachingTests: readonly string[];
    reachAttributed: boolean;
    /** where a generated test would import the module from; empty for a triage-only lookup */
    importSpecifier?: string;
}
interface CarryPlanEntry {
    gapId: string;
    key: string;
    decision: ReuseDecision;
    /** the carried record, present only when `decision === "reused"` */
    triage?: StoredTriage;
    candidate?: StoredCandidate;
}
interface CarryPlan {
    /** per-survivor triage decisions, every exclusion named */
    triage: CarryPlanEntry[];
    /** per-open-gap generation decisions */
    candidates: CarryPlanEntry[];
    /** why this run carried nothing at all; empty when the store's identity matched */
    forcedFull: ForcedFullReason[];
    carriedTriage: number;
    freshTriage: number;
    /** the direction rule's own cost: matched records that were re-asked because they could hide a gap */
    directionRuleReasks: number;
    carriedCandidates: number;
    freshCandidates: number;
}
/**
 * Plan the carry for one run.
 *
 * FAIL-CLOSED THROUGHOUT. The order below is the order the design states, and every branch that is
 * not a positive proof of "unchanged" lands on an execute decision:
 *
 *   1. the store's identity against this run's; any difference forces the full run;
 *   2. the wholesale digests, already dropped by `beginRun` before this is called;
 *   3. per record, the byte-exact key, which either matches or does not - there is no near miss;
 *   4. the direction rule, which re-asks a matched record whose answer could remove a gap.
 *
 * Step 4 CANNOT be reached by a carried equivalence, because an equivalence is not storable. It
 * exists for the case a hand-written store file gets past `readValidTriage`, and for the honest
 * accounting: `directionRuleReasks` is what the rule costs, and a run that cannot count it cannot
 * report it.
 */
declare function planCarry(input: {
    store: ReuseStore;
    identity: CarryIdentity;
    /** the run-level facts the key needs and the candidate does not carry */
    keyContext: Pick<CarryKeyInput, "recipeDigest" | "policyDigest" | "engineVersion" | "triageMode">;
    triagePromptVersion: string;
    generationPromptVersion: string;
    triageModelPin: string;
    generationModelPin: string;
    /** every survivor whose triage verdict this run needs */
    survivors: readonly CarryCandidate[];
    /** the gaps still open after triage, whose generation proposal this run needs */
    openGaps: readonly CarryCandidate[];
    /** the operator's escape hatch and the re-baseline cadence, folded in by the caller */
    forceFull?: readonly ForcedFullReason[];
}): CarryPlan;
/**
 * Build the record a carried triage verdict is written from, or `null` when the direction rule
 * forbids storing this answer.
 *
 * THE ONLY WAY A TRIAGE VERDICT ENTERS THE STORE. Callers hold a full verdict with any of the three
 * words in it; this narrows, and a `likely-equivalent` narrows to `null`. The alternative - letting
 * the caller cast - is the shape that lets one forgetful call site undo the rule everywhere.
 */
declare function carriableTriageRecord(input: {
    key: string;
    gapId: string;
    verdict: string;
    reasonCode: string;
    confidence: number;
    rationale?: string;
    description?: string;
    about?: string;
    severity?: string;
    severityBasis?: string;
    modelId: string;
    promptVersion: string;
    effort?: string;
    producedAtSha: string;
    producedAtRun: number;
}): StoredTriage | null;

/**
 * The predictor's feature set: what a mutant is described by, and nothing else.
 *
 * TWO KINDS OF FEATURE, BOTH MECHANICAL.
 *
 *   STRUCTURAL - the file the mutation lives in, and the mutator that made it. These were always
 *   available: they are report facts, not source.
 *
 *   SNIPPET - the shape of the substitution itself (what kind of edit it is) and whether it spans
 *   more than one line. These read the mutated snippet, which v2 may now do: Kenneth's 2026-08-13
 *   source-redaction ruling keeps the whole-file-source storage ban and drops the mutated-snippet
 *   redaction, so the snippet is available to this package. Nothing here egresses - the features
 *   live in the local reuse store beside the verdicts they describe, and the artifact carries
 *   counts only.
 *
 * WHY A CLOSED SET OF SHAPES AND NOT A LEARNED EMBEDDING. `docs/lessons/verifying-rules.md`: a rule
 * written from assumption and run in bulk is how this codebase has lost time before. Every shape
 * below is a small, named, individually testable rule over the substitution, so the exclusions can
 * be read; `features.test` in `stage3.test.ts` writes a case for each. What no unit test can settle
 * is whether these shapes DISCRIMINATE on real repositories - that is measured, per repository, by
 * the predictor's own rolling audit (see `plan.ts`), which is why the predictor may not skip a
 * single execution until that audit has cleared on this repository's own data.
 *
 * THE VERSION IS PART OF THE MODEL. Change a rule below and `FEATURE_VERSION` changes with it:
 * examples recorded under an older version train nothing, because a model fitted on different
 * features is a different model and its audit history described a predictor that no longer exists.
 */
/** Bump on ANY change to the shape rules or the feature record's meaning. */
declare const FEATURE_VERSION = "marigold-predictor-features/1";
/**
 * What kind of substitution this is. Closed set: an unrecognised substitution is `other`, which is
 * a real bucket the model can learn from, never a silent drop.
 */
declare const MUTATION_SHAPES: readonly ["emptied", "literal-swap", "string-literal", "comparison", "logical", "arithmetic", "call", "other"];
type MutationShape = (typeof MUTATION_SHAPES)[number];
declare const MUTATION_SPANS: readonly ["single-line", "multi-line"];
type MutationSpan = (typeof MUTATION_SPANS)[number];
/** One mutant, described. Every field is a closed set or a repository path - never free text. */
interface PredictorFeatures {
    file: string;
    mutator: string;
    shape: MutationShape;
    span: MutationSpan;
}
/** The substitution a mutant performs, which is all the shape rules are allowed to read. */
interface MutationSnippet {
    file: string;
    mutator: string;
    /** the source text the mutation replaced */
    originalText: string;
    /** the text it replaced that source with */
    replacement: string;
}
/**
 * The shape of one substitution. Rules are tried in order and the FIRST match wins, most specific
 * first: an emptied body is emptied even though the text it removed contained a comparison, and a
 * swap to `true` is a literal swap even though the text it replaced was a call.
 */
declare function mutationShape(input: {
    originalText: string;
    replacement: string;
}): MutationShape;
/**
 * One line or several. Kept as its own feature because about 9% of mutants span more than one line
 * (EMSE 2018, cited in the design doc), and a multi-line substitution is a different kind of change
 * from an operator swap regardless of what the shape rules make of its text.
 */
declare function mutationSpan(originalText: string): MutationSpan;
declare function describeMutant(snippet: MutationSnippet): PredictorFeatures;
/**
 * The specificity ladder: the keys a prediction may consult, most specific first.
 *
 * A rung is consulted only when it has enough decisive samples (the policy's `minSamplesPerRung`),
 * so a single fluke verdict for one file never labels a mutant. Falling through every rung is
 * `no-history`, which executes - the conservative direction is always toward execution.
 */
declare const LADDER_RUNGS: readonly ["file-mutator-shape-span", "file-mutator", "mutator-shape-span", "mutator"];
type LadderRung = (typeof LADDER_RUNGS)[number];
declare function rungKey(rung: LadderRung, features: PredictorFeatures): string;

declare const PREDICTOR_STORE_SCHEMA = "abloh-marigold-predictor/v1";
/**
 * One labeled outcome the predictor trains on: a described mutant and what execution actually said
 * about it. Recorded where the descriptors are known - reconstructing them later from a gap
 * identity digest would mean guessing a file and a mutator, which is training on an invented
 * example.
 */
interface StoredPredictorExample {
    features: PredictorFeatures;
    outcome: "killed" | "survived";
    /** run counter at which the outcome was executed */
    atRun: number;
}
/**
 * One finished audit round: predicted kills that executed anyway, and how many of them execution
 * contradicted. Rounds ACCUMULATE - Kenneth ruled on 2026-08-13 that disagreement is judged on a
 * rolling accumulated window and never per run, because one small slice's rate swings on a single
 * disagreement.
 */
interface StoredAuditRound {
    atRun: number;
    /** `slice` from a skipping run's seeded slice; `full` from a shadow run's whole population */
    scope: "slice" | "full";
    compared: number;
    disagreed: number;
}
interface PredictorStoreData {
    schema: typeof PREDICTOR_STORE_SCHEMA;
    /** the feature set every example below was described under */
    featureVersion: string;
    /** monotone run counter, so an example and an audit round can say when they happened */
    runCounter: number;
    lockfileDigest: string;
    configDigest: string;
    examples: StoredPredictorExample[];
    auditRounds: StoredAuditRound[];
}
declare function emptyPredictorStore(): PredictorStoreData;
declare class PredictorStore {
    #private;
    private constructor();
    /**
     * Open the store for one repository. A corrupt file, a wrong schema or a stale feature version is
     * treated as NO store: the predictor degrades to cold, which executes everything. It never
     * degrades to a guess.
     */
    static open(storeDir: string, repoKey: string): PredictorStore;
    get data(): PredictorStoreData;
    get path(): string;
    /**
     * Start a run: bump the counter, and drop everything if the environment the outcomes were
     * recorded under has changed.
     */
    beginRun(current: {
        lockfileDigest: string;
        configDigest: string;
    }): {
        run: number;
        environmentChanged: boolean;
    };
    /**
     * Add this run's labeled outcomes, keeping the most recent `windowExamples`. The window is the
     * caller's explicit number - there is no default here, for the same reason the rebaseline cadence
     * has none.
     */
    recordExamples(examples: readonly StoredPredictorExample[], windowExamples: number): void;
    /**
     * Add one finished audit round to the ROLLING window, then drop the oldest rounds until the
     * window holds at most `windowPredictions` compared predictions. The newest round is always kept
     * whole, even when it alone exceeds the window: a window that dropped the freshest evidence would
     * judge the predictor on nothing.
     */
    recordAuditRound(round: StoredAuditRound, windowPredictions: number): void;
    /**
     * Drop the audit window, keeping the training set. Called on a breach: Kenneth ruled that
     * re-enabling happens only after re-clearing on FRESH audits, so the rounds that recorded a
     * breach cannot be averaged away by the next few good ones.
     */
    clearAuditWindow(): void;
    save(): void;
}

/**
 * C2 - the per-repository predictor, trained on that repository's own accumulated runs.
 *
 * WHAT IT IS. A kill-rate table over the feature set in `features.ts`, fitted on the outcomes this
 * repository's own runs recorded, and nothing else: no cross-repository model, no shipped weights,
 * no model training. The literature's record on covered mutants is bad - AUC 0.51 for the older
 * general predictors (design doc, evidence section) - which is exactly why the bet is per-repo and
 * audit-gated: a repository whose history does not predict its present is caught by its own audit
 * and stops being trusted, mechanically, without anyone reading a dashboard.
 *
 * WHAT A LABEL MAY DO. A `likely-survived` label routes a mutant TO execution. A `likely-killed`
 * label may route a mutant AWAY from execution only in skipping mode (see `plan.ts`), and even
 * then a seeded audit slice of predicted kills executes anyway. Every gap the check REPORTS is
 * backed by a live execution on that run, by construction: predicted survivors all execute, and a
 * skipped mutant is never reported as anything.
 *
 * WHEN THERE IS NO HISTORY. A mutant no ladder rung has enough samples for is `no-history` and
 * executes. A repository with no recorded outcomes at all has no model and runs cold: everything
 * executes. Cold repositories run everything (stage-3 brief).
 */

declare const PREDICTION_LABELS: readonly ["likely-killed", "likely-survived", "no-history"];
type PredictionLabel = (typeof PREDICTION_LABELS)[number];
/**
 * EVERY KNOB IS EXPLICIT AND REQUIRED, following the rebaseline policy's refusal pattern from stage
 * 2: construction refuses until each number is written down, so no default of ours can quietly
 * become the shipped value. `RULED_PREDICTOR_POLICY` below is the one place values are named.
 */
interface PredictorPolicy {
    /** highest tolerated audited disagreement; a rate AT this value is a breach, not a pass */
    disagreementThreshold: number;
    /** audited predictions the rolling window must hold before the predictor may skip anything */
    minAuditedPredictions: number;
    /** rolling audit window size, in audited predictions */
    auditWindowPredictions: number;
    /** fraction of predicted kills executed as the seeded audit slice, in (0, 1] */
    auditFraction: number;
    /** decisive samples a ladder rung needs before a prediction may rest on it */
    minSamplesPerRung: number;
    /** most recent training examples kept per repository */
    trainingWindowExamples: number;
}
declare function validatePredictorPolicy(policy: PredictorPolicy): void;
/**
 * The values callers write down, named for their provenance rather than hidden inside the planner,
 * exactly as `RULED_SLICE_POLICY` is for stage 4. `planPredictor` still refuses a missing number,
 * so this constant is a call-site value and never a fallback.
 *
 * RULED BY KENNETH, 2026-08-13:
 *   `disagreementThreshold` 3%, judged on the ROLLING ACCUMULATED window and never per run; a rate
 *   AT the threshold is a breach and disables instantly.
 *   `minAuditedPredictions` 100: below that the predictor may not skip a single execution, however
 *   good the arithmetic on a handful of audits looks. Cold repositories run everything.
 *
 * PROVISIONAL, PENDING A RULING - marked so nobody reads them as settled. Each is inert while the
 * flag is off, and the flag's default is off:
 *   `auditWindowPredictions` 400: four times the minimum, so the window holds several runs of
 *   evidence and one bad slice cannot dominate it, while still being short enough that a
 *   repository that drifts is caught rather than averaged over its whole history.
 *   `auditFraction` 0.10: one predicted kill in ten executes anyway. The audit is what pays for the
 *   licence, so this is the price of skipping, and 10% reaches the 100-prediction minimum inside a
 *   few normal runs rather than a quarter.
 *   `minSamplesPerRung` 5: a rung backed by fewer decisive outcomes than this is one repository
 *   accident, not a pattern.
 *   `trainingWindowExamples` 20000: bounds the local store, and is far above any single run.
 */
declare const RULED_PREDICTOR_POLICY: PredictorPolicy;
interface Tally {
    killed: number;
    survived: number;
}
/** The fitted model: kill tallies per ladder rung, from this repository's recorded outcomes only. */
interface PredictorModel {
    featureVersion: typeof FEATURE_VERSION;
    /** examples the fit actually used */
    trainedOn: number;
    rungs: Map<LadderRung, Map<string, Tally>>;
}
/**
 * A recorded status trains the model only when it was DECISIVE: it answered whether the suite
 * noticed the mutation. Errors and caps answered a different question and train nothing.
 */
declare function decisiveOutcome(status: MutantStatus): "killed" | "survived" | null;
declare function trainPredictor(examples: readonly StoredPredictorExample[]): PredictorModel | null;
/** The mutant being labeled: its described features, joined to the gap identity it belongs to. */
interface PredictableMutant {
    gapId: string;
    features: PredictorFeatures;
}
interface Prediction {
    gapId: string;
    label: PredictionLabel;
    /** what the label rests on, disclosed: the rung consulted, its sample count and its kill rate */
    basis: {
        rung: LadderRung | null;
        samples: number;
        killRate: number | null;
    };
}
/**
 * One mutant's label. The ladder is walked most-specific first and the first rung with at least
 * `minSamplesPerRung` decisive samples decides; falling off the end is `no-history`.
 *
 * The decision boundary is the MAJORITY of observed outcomes - not a tunable knob, because a
 * tunable boundary is a second threshold nobody measured. An exact tie predicts SURVIVED, since
 * the conservative direction is toward execution.
 */
declare function predictGap(model: PredictorModel, mutant: PredictableMutant, policy: PredictorPolicy): Prediction;

/**
 * The predictor's execution plan for one run, and the rolling audit that licenses it.
 *
 * THREE MODES, CHOSEN BY EVIDENCE, NONE TERMINAL:
 *
 *   cold     - this repository has no model yet (no recorded outcomes, or its recorded outcomes
 *              were described under a different feature set). Everything executes; nothing is
 *              predicted. Cold repositories run everything.
 *   shadow   - predictions exist but the rolling audit window does not license skipping: it holds
 *              fewer than `minAuditedPredictions` audited predictions, or its accumulated
 *              disagreement is at or above the threshold. Everything still executes, and the FULL
 *              population of predicted kills becomes audit evidence - the predictor is measured
 *              against reality at zero extra execution cost, which is how a cold repository walks
 *              itself up to a licence and how a breached one walks itself back.
 *   skipping - the window holds at least `minAuditedPredictions` audited predictions and its
 *              accumulated disagreement is under the threshold. Predicted survivors execute, a
 *              seeded audit slice of predicted kills executes, the rest of the predicted kills are
 *              skipped - which is the whole saving.
 *
 * THE WINDOW IS ROLLING AND ACCUMULATED, NEVER PER RUN (Kenneth, 2026-08-13). One run's slice is a
 * handful of predictions whose rate swings on a single disagreement; the licence is judged on the
 * accumulated window instead, and a run that produces no audit evidence at all changes nothing.
 *
 * A BREACH DISABLES INSTANTLY AND CLEARS THE WINDOW. `withinThreshold` is a STRICT comparison: a
 * rate AT the threshold is a breach. On a breach the accumulated rounds are dropped, so re-enabling
 * requires `minAuditedPredictions` FRESH audited predictions that clear the threshold on their own.
 * The breach is loop feedback, not a verdict: the next run is a shadow run, it measures the full
 * population, and skipping resumes when fresh audits clear.
 *
 * TWO RULES WITHOUT EXCEPTION. Only a `likely-killed` label can ever be skipped, and a skipped
 * mutant is never reported as anything - so every gap the check reports is backed by an execution
 * on this run. The seeded slice is deterministic in (seed, gapId): the same run replayed audits the
 * same mutants, so the audit itself is reproducible evidence.
 *
 * SKIPPING IS A SEPARATE LICENCE FROM BEING ACTIVE (Kenneth's accepted design, 2026-08-21). The
 * predictor is ACTIVE by default wherever this repository has memory to predict from, and an active
 * predictor changes the ORDER and the FOCUS of execution and nothing else: every mutant still
 * executes, so the run's verdict multiset - and therefore its score - is bit-identical to the same
 * run with no predictor at all. `maySkip` is the second, separate licence that lets an active
 * predictor REMOVE an execution, it is Kenneth's alone to grant, and `planPredictor` requires it
 * explicitly so no call site can acquire it by omission. With `maySkip: false` the mode can only
 * ever be `cold` or `shadow`, which is what the warm-versus-cold score equivalence rests on.
 */

declare const PREDICTOR_MODES: readonly ["cold", "shadow", "skipping"];
type PredictorMode = (typeof PREDICTOR_MODES)[number];
declare const PREDICTOR_DECISIONS: readonly ["execute-predicted-survivor", "execute-no-history", "execute-audit-slice", "execute-shadow", "execute-cold", "skip-predicted-kill"];
type PredictorDecision = (typeof PREDICTOR_DECISIONS)[number];
interface PredictorPlanEntry {
    gapId: string;
    decision: PredictorDecision;
    prediction: Prediction | null;
}
interface PredictorPlan {
    mode: PredictorMode;
    entries: PredictorPlanEntry[];
    predictedKilled: number;
    predictedSurvived: number;
    noHistory: number;
    auditSliceSize: number;
    skipped: number;
    executed: number;
    /**
     * The order the executions are taken in, most informative first. See {@link executionOrder}.
     *
     * Every executing gap identity appears exactly once and nothing else does, so a consumer can sort
     * by it without deciding what to do with a name it did not plan.
     */
    order: string[];
}
declare function executionOrder(entries: readonly PredictorPlanEntry[]): string[];
/** The rolling window's accumulated state, and whether it licenses skipping. */
interface AuditWindow {
    rounds: number;
    compared: number;
    disagreed: number;
    disagreementRate: number;
    threshold: number;
    /** strict: a rate AT the threshold is a breach */
    withinThreshold: boolean;
    /** the window holds at least `minAuditedPredictions` audited predictions */
    sufficient: boolean;
    /** sufficient AND within threshold - the only state that licenses skipping */
    licensed: boolean;
}
declare function summarizeAuditWindow(rounds: readonly StoredAuditRound[], policy: PredictorPolicy): AuditWindow;
/**
 * Which mode does this run get? Skipping needs a model, a licensing window AND the separate skip
 * licence. "Enabled per repo only while audited disagreement stays under threshold" means under
 * audits that happened, in enough quantity to mean something - not under an audit nobody ran.
 *
 * `maySkip` is required rather than optional. An optional argument defaulting to `true` would let a
 * caller that has not thought about the score acquire the one power that changes it by writing
 * nothing, and defaulting to `false` would make a real licence look like a bug at every call site
 * that forgot it. Neither is a default this file may pick, so it picks none.
 */
declare function predictorMode(model: PredictorModel | null, window: AuditWindow, maySkip: boolean): PredictorMode;
/** Deterministic slice membership: order predicted kills by sha256(seed:gapId), take the head. */
declare function seededAuditSlice(predictedKillGapIds: readonly string[], seed: string, auditFraction: number): Set<string>;
declare function planPredictor(input: {
    mutants: readonly PredictableMutant[];
    model: PredictorModel | null;
    window: AuditWindow;
    policy: PredictorPolicy;
    /** the commit sha (or another run-stable string): the slice is reproducible per run, not per roll */
    seed: string;
    /**
     * Kenneth's separate licence to REMOVE an execution. `false` keeps the predictor active and
     * score-neutral: it orders and it audits, and every mutant still executes.
     */
    maySkip: boolean;
}): PredictorPlan;
/**
 * One run's audit round: predicted kills that executed, against what execution actually said.
 *
 * THE DANGEROUS DIRECTION IS THE ONLY ONE COUNTED. A wrong `likely-killed` hides a gap from the
 * customer; a wrong `likely-survived` merely cost one execution and was corrected by it. Every
 * disagreement is itemised, never only counted (the rebaseline's honesty rule), and an execution
 * that answered nothing decisive is excluded from `compared` rather than counted as agreement.
 */
interface PredictorAuditRound {
    scope: "slice" | "full";
    compared: number;
    agreed: number;
    disagreed: Array<{
        gapId: string;
        fresh: MutantStatus;
    }>;
    /** executed audit members whose fresh status was not decisive (errors, caps): excluded, disclosed */
    undecided: number;
}
declare function auditRound(plan: PredictorPlan, fresh: ReadonlyMap<string, MutantStatus>): PredictorAuditRound;
/**
 * Fold one round into the rolling window and re-judge the licence.
 *
 * A round that compared nothing is not recorded - an empty round would occupy window space and
 * carry no evidence. Otherwise the round joins the window, the accumulated rate is recomputed, and
 * a breach (rate AT or above threshold, once the window is decision-capable) clears the window on
 * the spot: skipping stops with this run's record, and re-enabling needs fresh audits.
 *
 * A window that is not yet decision-capable is never cleared. It is a repository still earning its
 * first licence, and clearing it on every early disagreement would mean no repository could ever
 * accumulate the minimum.
 */
declare function foldAuditRound(input: {
    store: PredictorStore;
    round: PredictorAuditRound;
    atRun: number;
    policy: PredictorPolicy;
}): {
    window: AuditWindow;
    breached: boolean;
    recorded: boolean;
};
/**
 * The artifact's C2 block, straight from the plan and the window - counts, never claims.
 *
 * IT DECLARES ITS OWN EXCLUSION, the same way the neighborhood slice does (`slice.ts`,
 * `countsTowardScore: false`, Kenneth 2026-08-14). The predictor's audit slice is work done to
 * measure the predictor, not to measure the repository: an audited execution's verdict is already
 * counted once as an ordinary verdict of the population it belongs to, and nothing in this block is
 * ever added to a numerator or a denominator anywhere. Stating it as a required literal rather than
 * a comment is what makes it checkable - the control plane refuses a block that claims otherwise,
 * exactly as it refuses a slice that does.
 */
declare function predictorDisclosure(input: {
    plan: PredictorPlan;
    /** the window the MODE was chosen under, before this run's own round folded in */
    windowAtPlan: AuditWindow;
    /** the window after this run's round folded in, when the run produced one */
    windowAfter?: AuditWindow;
    round?: PredictorAuditRound;
    breached?: boolean;
}): PredictorDisclosure;

/**
 * Distinct mutable sites in `source` that START on one of `ranges`.
 *
 * Zero for a file the parser cannot read, and zero for a range that names no line of it - both are
 * "this counter found nothing", which is the only claim it is entitled to make.
 */
declare function mutableSitesOnLines(input: {
    file: string;
    source: string;
    ranges: ReadonlyArray<readonly [number, number]>;
}): number;
/**
 * The same count per file, for the caller that has a scope list and the sources to read.
 *
 * A scope with no source - a file the run could not read, a deletion - contributes nothing rather
 * than throwing: the pool already has an honest shape for a file it cannot show a model, and a
 * sizing law that refuses the whole run over one unreadable path would trade a smaller pool for no
 * pool at all.
 */
declare function uncoveredSitesByFile(input: {
    scopes: ReadonlyArray<{
        file: string;
        ranges: ReadonlyArray<readonly [number, number]>;
    }>;
    /** the file's current bytes, or null when this run could not read it */
    readSource: (file: string) => string | null;
}): Map<string, number>;

/**
 * Applying a survivor's patch to a source file.
 *
 * LOCATE AND REFUSE, never locate and hope. A mutation span arrives as (line, column) pairs whose
 * column base cannot be confirmed from the engine report itself, so the span is located and then
 * CHECKED against the original text the report carried. A one-column drift would otherwise mutate
 * the wrong bytes and every downstream verdict would be about a mutation nobody intended - with
 * nothing able to notice, because the run would look entirely normal.
 */

type PatchResult = {
    ok: true;
    source: string;
} | {
    ok: false;
    reason: string;
};
declare function applyGapPatch(source: string, gap: SurvivorGap): PatchResult;
/**
 * Resolve a REPORTED span - (file, line, maybe-column, captured text) as a mutation report states
 * it - to byte offsets, or refuse.
 *
 * TWO RECORDED INCIDENTS LIVE HERE.
 *
 * The first: a span search confined to the single declared line can never find a span that runs
 * past it, and that silently dropped an entire mutator class - 14 of 160 mutants (8.8%) across two
 * repositories, with no line of output saying so. The search below runs over the whole source and
 * only requires the match to BEGIN on the declared line.
 *
 * The second: a report's column base cannot be confirmed from the report itself. When more than one
 * occurrence of the captured text begins on the declared line, the column decides between them
 * only if exactly one of its two possible readings (0-based, 1-based) lands on an occurrence. When
 * both readings land, or neither, or no column was reported, the answer is unknowable and the
 * resolution REFUSES - a coin flip here mutates the wrong bytes with nothing able to notice.
 */
interface ReportedSpan {
    startLine: number;
    startColumn?: number;
    originalText?: string;
}
interface ResolvedSpan {
    start: number;
    end: number;
    replacedText: string;
}
declare function resolveReportedSpan(source: string, span: ReportedSpan): ResolvedSpan | null;
type Offsets = {
    ok: true;
    start: number;
    end: number;
} | {
    ok: false;
    reason: string;
};
/** 1-based line, 1-based column, end column exclusive - the engine report's own convention. */
declare function spanOffsets(source: string, gap: SurvivorGap): Offsets;

interface LocalRunnerOptions {
    repoDir: string;
    /** what every execution runs, argv form; no shell. `sealed-test-command.ts` decides what it is */
    testCommand: readonly string[];
    /**
     * True when `testCommand` is the project's own test command rather than a direct runner
     * invocation, and therefore may execute lint, typecheck or build stages before the runner.
     * A failure with no test report is then reported as possibly that gate (`gateShapedFailure`).
     */
    testCommandRunsProjectScript?: boolean;
    /**
     * how the command is told to run one file: `%f` is the repo-relative test path, and `%t` - in the
     * single-token form, `--test-name-pattern=%t` - is the escaped, anchored name filter
     * (`test-filter.ts`). A name filter is a regex to every runner the engine drives, so it is escaped
     * here and never passed verbatim.
     */
    targetedArgs?: readonly string[];
    /** install command run once during preparation; omit when the scratch copy is already installed */
    installCommand?: readonly string[];
    /** package subdirectory that owns the suite, when the repository is a monorepo */
    subdir?: string | null;
    /**
     * Where `installCommand` runs, repo-relative, `null` or `"."` meaning the repository root.
     * Same fact and same reason as `DockerRunnerOptions.installSubdir`: in a workspace the manifest
     * and lockfile the package manager owns live at the root, not in the measured package.
     */
    installSubdir?: string | null;
    runner: string;
    /** copy the repository into scratch (default) or run in place; in place is for read-only fixtures */
    copyRepository?: boolean;
    env?: Record<string, string>;
}
declare class LocalUnsealedRunner implements SealedRunner {
    #private;
    readonly id = "local-unsealed";
    readonly sealed = false;
    executions: number;
    /** the selection template a targeted request is run with; see `DockerSealedRunner.targetedArgs` */
    readonly targetedArgs: readonly string[];
    /**
     * The directory every execution runs the test command in, repo-relative, `null` for the root.
     *
     * Readable, and read by BOTH the spawn's `cwd` and the targeted `%f`, for the reason
     * `DockerSealedRunner.executionSubdir` is: a targeted path is relative to this directory, and two
     * places deriving that separately is the defect `test-filter.ts` now owns the fix for.
     */
    readonly executionSubdir: string | null;
    constructor(options: LocalRunnerOptions);
    prepare(): Promise<PreparedEnvironment>;
    execute(request: ExecutionRequest): Promise<ExecutionResult>;
    dispose(): Promise<void>;
}

/** One backing service, exactly as the signed environment contract binds it. */
interface SealedServiceDeclaration {
    /** The workflow's own key for this service. Becomes the container's network alias. */
    name: string;
    /** The pinned image reference, digest and all. */
    ref: string;
    /** The bare 64-hex digest `ref` carries, which must agree with it. */
    digest: string;
    /** The declared `env:`, verbatim: what the database actually starts with. */
    env: ReadonlyArray<{
        name: string;
        value: string;
    }>;
    /** The declared `--health-cmd`, or null when a TCP connect on {@link healthPort} answers instead. */
    healthCommand: string | null;
    /** The port a TCP readiness probe connects to, or null when a health command answers instead. */
    healthPort: number | null;
}

interface DockerRunnerOptions {
    repoDir: string;
    /** base image, pinned by digest wherever the caller can supply one */
    image: string;
    /**
     * Install command run once, inside the image build. OPTIONAL, and an absent or empty one is the
     * BORROW path rather than a misconfiguration: see {@link DockerRunnerOptions.environmentSource}.
     *
     * The Dockerfile emission below has always been conditional on this being non-empty, so an empty
     * command already produced exactly the image a borrowed tree needs - base, toolchain, floor,
     * `COPY`, and nothing that runs a customer command. What used to be missing was a caller allowed
     * to ask for it.
     */
    installCommand?: readonly string[];
    /**
     * Where the environment in this image comes from - see `EnvironmentSource` in `../types.ts`.
     *
     * Defaults to `rebuilt`, which is what every caller before borrowing existed meant. It is in the
     * recipe digest because a borrowed environment and a reconstructed one are not the same
     * environment, and a tag that could not tell them apart would hand one run the other's image and
     * let a verdict earned in one be carried into the other.
     */
    environmentSource?: EnvironmentSource;
    /**
     * What a BORROWED environment inherited from the machine that prepared it.
     *
     * Supplied only alongside `environmentSource: "borrowed"`, and only the four identity fields
     * reach the recipe digest - the runner image id is disclosed and never hashed. `../types.ts`
     * carries the measurement that decides that split.
     */
    inheritedEnvironment?: InheritedEnvironment;
    /**
     * THE `packageManager` PIN THE OFFLINE COREPACK STORE IN THIS IMAGE MUST HOLD.
     *
     * SUPPLIED ON BOTH LANES, unlike `inheritedEnvironment` above, because both need it for the same
     * reason: the measured container runs `--network none`, and a `corepack <manager> ...` command
     * inside it can only resolve a version the BUILD fetched. The cold lane's install command usually
     * warms the store as a side effect; the borrow lane's install command is empty by construction and
     * warms nothing, which is the wall wave 3 of the census measured on three repositories.
     *
     * Absent where the repository declares no `packageManager` - then the image carries the documented
     * defaults (`SEALED_PNPM_VERSION`, `SEALED_YARN_VERSION`) and its recipe digest does not move.
     */
    declaredPackageManager?: DeclaredPackageManager | null;
    /**
     * THE CUSTOMER'S OWN SETUP SCRIPT, ONE STEP AT A TIME, and when it is here it is the whole build.
     *
     * WHAT IT REPLACES IN THE BUILD: the declared-OS-package step, the conditional `corepack enable`,
     * and the install command. Those three were abloh re-deriving the customer's build at every run
     * from config keys it had to invent first. The steps here come from a file in the customer's own
     * repository, read once into the environment contract, and the build executes them and nothing
     * else. See `setup-script.ts` in `@abloh/core` for the file and Kenneth's ruling of 2026-08-26.
     *
     * ONLY THE COLD LANE SUPPLIES IT. A borrowed environment arrived installed and built from the
     * caller's own CI, so it runs no build at all and no script with it.
     *
     * ONE `RUN` PER STEP, not one `RUN` for the script. Two reasons, and both are the design:
     *
     *   1. A FAILURE HAS TO NAME ITS STEP. Buildkit fences the failing instruction in its own output,
     *      so one instruction per step is what makes "setup stopped at step 4" a fact read out of the
     *      build rather than a guess. `#setupFailure` is the reader.
     *   2. A STEP THAT DID NOT CHANGE IS A CACHED LAYER. Editing step 5 re-runs step 5, not the
     *      install above it, which is the difference between a one-line fix costing seconds and
     *      costing a full reinstall.
     *
     * NOTHING ABOUT THE EXECUTION CHANGES. These run in the BUILD, which has had a network and run as
     * root since the image shipped. Every execution below is still `--network none`, `--cap-drop ALL`,
     * `no-new-privileges` and non-root.
     */
    setupSteps?: readonly {
        what: string;
        source: string;
        command: string;
    }[];
    /**
     * THE LEGACY `environment.setupCommands`, RUN AFTER THE INSTALL (junction audit SETUP-09).
     *
     * The environment contract has always carried these and its own field comment has always said
     * they are "direct argv executed after the frozen install in every materialized proof image".
     * Nothing executed them. A repository still on the older keys therefore signed a contract naming
     * commands the proof image never ran, and the run reported success over an environment that was
     * missing whatever they set up.
     *
     * THE OLDER KEYS ONLY. A repository with `environment.setup` states its whole build in that file
     * and `setupSteps` above is the whole of it; these are for the lane that has no script. Empty or
     * absent for every repository that has migrated, which is why this changes no image digest that
     * was not already describing a build it did not do.
     */
    postInstallCommands?: readonly (readonly string[])[];
    /** Where the script came from, for the failure sentence. Defaults to `.abloh/setup.sh`. */
    setupScriptPath?: string;
    /**
     * THE DECLARED VARIABLES THE BUILD MAY NEED, BY NAME, AND WHETHER THIS MACHINE HAS ONE.
     *
     * Kenneth's ruling of 2026-08-26, the private-registry lane. A repository with a scoped `.npmrc`
     * needs its token at INSTALL time, and the install happens here, in the image build.
     * `environment.requiredVariables` was consumed only by the test process, so there was no path by
     * which a token reached `npm ci` in a cold rebuild at all: `COPY . /workspace` carried the
     * `.npmrc`, `${NPM_TOKEN}` expanded to empty, and the install died `npm error code E401` on the
     * first scoped package with nothing in the run to say why.
     *
     * NAMES ONLY, AND THAT IS THE WHOLE SECURITY STORY. Abloh never holds the value. What is emitted
     * is `--secret id=NAME,env=NAME` on the build and `--mount=type=secret,id=NAME` on the steps that
     * install, so BuildKit reads the variable out of the build client's own environment and presents
     * it to one instruction as a tmpfs file. It enters no image layer, no `docker history`, and no
     * field of this object. Nothing is written to disk by abloh and nothing is stored anywhere.
     *
     * `available: false` IS A DECLARATION WITH NO VALUE HERE, which is every run on abloh's own
     * infrastructure - we keep no registry credential of a customer's, so a hosted cold run has none
     * by construction. Those names are not mounted. They are carried so that when the build dies on a
     * registry refusal, `registry-auth.ts` can name the variable in the refusal instead of reporting
     * buildkit's output at somebody.
     *
     * MOUNTED ON EVERY SETUP STEP RATHER THAN ONE. abloh's own workflow template scopes its token to
     * the install step and says why, and the reason is specific to GitHub Actions: a job-level `env:`
     * reaches every third-party action in the job. There are no third-party steps inside this build -
     * every instruction is the customer's own script - and a monorepo whose BUILD step pulls a
     * private package is an ordinary shape, so the narrower rule would buy nothing and break that.
     */
    buildSecrets?: readonly {
        name: string;
        available: boolean;
    }[];
    /** what every execution runs; `sealed-test-command.ts` in `@abloh/core` decides what this is */
    testCommand: readonly string[];
    /**
     * True when `testCommand` is the project's own test command rather than a direct runner
     * invocation, and therefore may execute lint, typecheck or build stages before the runner.
     * A failure with no test report is then reported as possibly that gate (`gateShapedFailure`).
     */
    testCommandRunsProjectScript?: boolean;
    /**
     * The run log. Used for what a reader would otherwise have to reconstruct from a container
     * argument list - today, a declared glob and the file names abloh expanded it to.
     */
    log?: (line: string) => void;
    /**
     * how the command is told to run one file: `%f` is the repo-relative test path, and `%t` - in the
     * single-token form, `--testNamePattern=%t` - is the escaped, anchored name filter (`test-filter.ts`)
     */
    targetedArgs?: readonly string[];
    subdir?: string | null;
    /**
     * Where the install command runs, repo-relative, `null` or `"."` meaning the repository root.
     *
     * SEPARATE FROM `subdir`, because the two are separate facts about a repository and this runner
     * used to hold only one of them. `subdir` is the package whose suite is measured; the install
     * directory is the directory whose manifest and lockfile the package manager owns, which in a
     * workspace is the ROOT and not the measured package. v1 has carried both since it shipped
     * (`environment.installDirectory` in `abloh.yml`, default `"."`); running the install inside the
     * measured package instead was v2 inventing a value the run had already declared.
     */
    installSubdir?: string | null;
    runner: string;
    /**
     * `environment.runtimes` - extra runtimes the image must carry that the RUNNER does not imply.
     *
     * The runner implies bun only when the runner IS bun. A repository that installs with bun but
     * tests with a node runner, or that reaches bun inside its own test script, needs one just as much
     * and names it here instead. See `sealedExtrasNeeded` in `@abloh/core`.
     */
    runtimes?: readonly SealedRuntime[];
    /**
     * `environment.browser` - the declaration that this repository's suite drives a real browser.
     *
     * The runner implies a browser only when the runner IS `angular-karma`. A vitest suite one of
     * whose projects declares browser mode needs one just as much and names it here instead, which is
     * the shape round 5's wall census measured on `storybookjs/storybook` and filed as M17. Declaring
     * it puts Chromium in the image and every execution on the browser posture; `browser-lane-seal.ts`
     * in `@abloh/core` states what that posture is, clause by clause.
     */
    browser?: "chromium" | null;
    /**
     * `environment.systemPackages` - pinned OS packages this image must carry beyond its base.
     *
     * The class beneath the runtimes above: not a language runtime, a SYSTEM LIBRARY that a native
     * module links against and that no package manager installs. Installed as one apt step in the
     * build, which is the unsealed phase and the only one with a network; the execution below is
     * unchanged in every respect. See `system-packages.ts` in `@abloh/core` for the grammar and the
     * security posture.
     */
    systemPackages?: readonly SystemPackage[];
    /** literal non-secret values the suite needs; the host environment is never inherited */
    syntheticEnvironment?: Readonly<Record<string, string>>;
    /**
     * `environment.environmentValues`: the literal values the repository's own policy declares.
     *
     * WHY IT IS SEPARATE FROM {@link DockerRunnerOptions.syntheticEnvironment}. That channel is
     * engine-owned - it carries abloh's own `ATTEST_TEST_*` names - and it meant the ONE variable a
     * repository with a database actually needs, its own `DATABASE_URL`, reached the baseline and
     * never the container that proves against that database. A suite whose services were standing up
     * correctly still had no address to connect to.
     *
     * WHAT MAKES IT SAFE IS THE SCHEMA. `environment.environmentValues` is validated by `@abloh/core`
     * before it can be written: names are portable and non-reserved, values are literal text with no
     * shell evaluation and no expansion, and anything credential-shaped is refused with a message
     * sending it to `environment.requiredVariables`, which is the SECRETS path and does not come
     * through here. These are values committed to the repository, readable by anyone who can read it,
     * and they are the values the customer's own CI already runs the suite with.
     *
     * SET BEFORE THE ENGINE'S OWN, so an engine-owned name always wins - the same ordering the
     * browser lane's variables already rely on.
     */
    declaredEnvironment?: Readonly<Record<string, string>>;
    /**
     * `environment.services`: the backing services this repository's own CI declares.
     *
     * ABSENT FOR ALMOST EVERY REPOSITORY, and absent is what keeps `--network none` the default. When
     * it is present the measured container joins one network namespace with these services, so
     * `localhost:5432` inside the suite IS the declared database exactly as it is on a GitHub runner.
     * `services.ts` beside this file carries the whole mechanism, the confinement and the one measured
     * deviation from it.
     */
    services?: readonly SealedServiceDeclaration[];
    memory?: string;
    /**
     * `--pids-limit` for every execution. Defaults to `sealedPidsLimit()` in `@abloh/core`, which
     * SCALES WITH THIS HOST'S CORES and floors at the 512 that used to be flat. The formula, the
     * measurement behind each of its numbers and the failure class a flat 512 produced are all at the
     * definition site. Pass a number only to override that deliberately.
     */
    pidsLimit?: number;
    dockerBin?: string;
    /**
     * NETWORK REPLAY INSIDE THE SEAL: the absolute host path of this package's own replay preload, and the
     * repo-relative recordings file it serves from. Absent on every run without recordings, which is
     * almost all of them.
     *
     * IT RIDES THE INPUT MOUNT AND NOT THE IMAGE, which is the whole reason this is two strings and
     * not a Dockerfile change. The preload is abloh's own code arriving from the host, and the image
     * is what a signed artifact BINDS: adding a `COPY` to it would change the recipe digest, which is
     * an attestation-surface change, on every run whether or not it replays anything. The container
     * already has a read-only mount for exactly this shape of input, so the preload is written into it
     * beside the candidate files and reached at `/candidate`.
     *
     * THE RECORDINGS FILE NEEDS NOTHING: it is a committed file in the repository, so the image's own
     * `COPY . /work` already carries it, at the path the repository declares.
     *
     * NO CHANNEL IS OPENED. The container still runs `--network none`; the preload answers requests
     * from bytes and errors the ones it cannot answer. What changes is that a test which used to die
     * on DNS now gets the response its own repository recorded - or a failure that names why.
     */
    replay?: {
        /** host path of `replay-preload.mjs`, copied into the input mount for each execution */
        preloadPath: string;
        /** the recordings file, repo-relative, as it exists inside `/work` */
        recordingsRelative: string;
        scope: "external" | "all";
    };
    /**
     * HOW THE CHECKOUT REACHES THE CONTAINER: baked into the image, or mounted as an overlay volume.
     *
     * `"image"` is what shipped: `COPY . /work`, which pays three passes over the checkout before the
     * first execution - the digest walk, the build context transfer and the layer write. Measured on
     * a real `ubuntu-latest` runner in census run 6's follow-up (`report.md` section 1.3): 44 s on
     * `swagger-api/swagger-ui`, 46 s on `unocss/unocss` and 37 s on `sveltejs/svelte`, against sealed
     * suites of 12 s, 23 s and 93 s. The copy was never the measurement - it exists to give the
     * container a private writable tree that cannot reach the customer's checkout.
     *
     * `"overlay"` buys that same property from the kernel instead. The volume's LOWER layer is the
     * checkout, read-only; the UPPER and WORK directories are this run's own scratch. Every byte the
     * container can read is the byte it could read before, and every byte it writes lands in the upper
     * directory - so what changes is the bill, not the boundary.
     *
     * ASKING IS NOT GETTING. {@link DockerSealedRunner.workspaceRoad} is the road actually taken and
     * {@link DockerSealedRunner.workspaceFallback} is the sentence saying why, because the overlay
     * road needs a root daemon on a filesystem overlayfs accepts and Docker Desktop on macOS is not
     * one. The capability is PROVEN by a probe rather than inferred from `docker info`, and a probe
     * that does not prove it takes the image road.
     *
     * Defaults to `sealedWorkspaceDefault()`, which is the mode this build ships with.
     */
    workspace?: SealedWorkspace;
}

/**
 * The half of an inherited environment that is allowed to invalidate a verdict.
 *
 * `InheritedEnvironment` carries five things and only four of them belong in the recipe digest.
 * This function is where that line is drawn, in one place, so the rule is checkable rather than
 * repeated: node, the package manager, the declared runtimes and the governing lockfiles are what
 * the environment IS; the runner image id is what produced it, and hashing that would cost every
 * customer their carry-forward every time GitHub reissues its weekly image.
 *
 * Sorted on the way out, because two spellings of the same inheritance must be one digest.
 */
declare function inheritedRecipeFields(inherited: InheritedEnvironment): {
    node: string | null;
    packageManager: string | null;
    runtimes: readonly string[];
    lockfiles: ReadonlyArray<{
        path: string;
        digest: string;
    }>;
};
/**
 * The `--mount` flags one build step carries, and the shell that turns those files into variables.
 *
 * WHY A FILE AND NOT `env=`. BuildKit's `--mount=type=secret,...,env=NAME` form would put the value
 * straight into the instruction's environment and save these three lines, and it is a Dockerfile
 * 1.10 feature (2024) - which means emitting it would require a `# syntax=` directive pinning a
 * frontend image pulled from the network at build time. That is an attestation-surface change for a
 * convenience. The file form has been in BuildKit's own built-in frontend for years and needs no
 * directive, so the Dockerfile abloh writes stays a Dockerfile the daemon already understands.
 *
 * `-r` RATHER THAN `-f`, and the `if` rather than a bare `cat`: a step must not fail because a
 * secret it did not need was absent. What is absent stays absent, which is exactly what the
 * repository's own `${NPM_TOKEN}` expansion already does.
 */
declare function buildSecretMountFlags(names: readonly string[]): string;
declare function buildSecretPrelude(names: readonly string[]): string;
/**
 * What a failed `docker build` says, written so its FIRST characters name the cause.
 *
 * THE DEFECT THIS ANSWERS. Preparation used to report `boundEvidence(stderr + stdout)`, the first
 * 4,000 characters, of which the artifact keeps 200 - and buildkit writes its progress header
 * first and the failing step last. Three artifacts of 2026-08-16 carried
 * `#0 building with "desktop-linux" instance using docker driver` and named nothing at all, while
 * the actual cause (`sh: 1: pnpm: not found`) sat at the bottom of the same output.
 *
 * WHAT IT KEEPS, in this order, because the first 200 characters are all a reader is guaranteed:
 *   1. the TAIL of the failing step's own output - the compiler error, the missing binary
 *   2. the failing step itself, so the reader knows which `RUN` line produced it
 *
 * Buildkit fences the failing step between `------` rules, opening with ` > [4/4] RUN <command>:`.
 * When that fence is absent - an older client, or a failure before any step ran - the whole
 * output's tail is the honest answer, and it is still the end rather than the header.
 */
declare function dockerBuildFailureEvidence(stdout: string, stderr: string): string;
/**
 * The label every sealed container carries, valued with the runner's run token.
 *
 * It is the leak's only handle after the fact: `docker ps --filter label=abloh.sealed-run=<token>`
 * is how an operator, and the regression test, asks whether a run left anything behind.
 */
declare const SEALED_RUN_LABEL = "abloh.sealed-run";
/**
 * THE ONE VARIABLE THAT STOPS pnpm DELETING `node_modules` INSIDE A CONTAINER WITH NO NETWORK.
 *
 * IT IS ON THE EXECUTION AND NOT IN THE IMAGE, which is the whole of the captain's ruling of
 * 2026-09-05: `ENV CI=true` stays exactly where it is, because the BUILD needs it (see the comment
 * above that line) and the build has a network it can reinstall from. The execution does not.
 *
 * THE CHAIN IT BREAKS, measured on `unocss/unocss` at census run 6 and reproduced on a real runner
 * (`data/abloh-sealed-execution-slowness-design-review/report.md` section 1.6). The image carries
 * `CI=true`. pnpm 11 defaults `verifyDepsBeforeRun` to `install`, so every `pnpm exec` and every
 * `pnpm run` first checks `node_modules` against the lockfile. The copied `node_modules/.modules.yaml`
 * names the store the CUSTOMER'S OWN job installed from - a path under their runner's home that this
 * container has never had - so pnpm judges the directory incompatible and wants to recreate it. With
 * `CI` set it does not ask: it deletes `node_modules` under the running suite, then tries to fetch
 * 1,512 packages from a registry `--network none` puts out of reach, retries with backoff for 81 s,
 * and leaves a suite whose test runner is no longer on disk. Three sealed executions on that
 * repository each ran to abloh's own 600 s ceiling with the suite's own work finished 20 s in, and
 * each was then recorded as the tests catching the mutant.
 *
 * WHY THIS SPELLING AND NOT ANOTHER. Six candidates were measured on the fork under abloh's exact
 * argv (run 33894264892): `npm_config_verify_deps_before_run` in both `false` and `warn` spellings,
 * `npm_config_store_dir` pointing at the runner's own store, and `npm_config_offline=true` all still
 * recreated the directory and took 81 to 83 s. `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` returned
 * in 1 s with all 1,040 entries intact.
 *
 * WHAT IT DOES NOT CLAIM. It reaches pnpm 11's verify path and nothing else: a test that runs
 * `pnpm install` itself still installs, which is the repository's own instruction and not ours to
 * countermand.
 */
declare const SEALED_PNPM_VERIFY_DEPS = "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false";
/** How the checkout reaches the container; see {@link DockerRunnerOptions.workspace}. */
type SealedWorkspace = "image" | "overlay";
/**
 * THE FLAG. `ABLOH_SEALED_WORKSPACE=image` forces the copy, `=overlay` asks for the mount.
 *
 * AN ENVIRONMENT VARIABLE AND NEVER A CONFIG KEY, for the reason {@link UNSEALED_RUNNER_ENV} in the
 * CLI's dispatch gives: policy is committed and shared, and how abloh's own infrastructure delivers
 * a checkout into its own container is not something a repository may decide for itself. Nothing in
 * `abloh.yml` reads it and nothing in the artifact reports it.
 *
 * An unrecognised value is the DEFAULT rather than a refusal: this variable chooses between two
 * roads that measure the same thing, so a typo may cost the saving and may not cost the run.
 */
declare const SEALED_WORKSPACE_ENV = "ABLOH_SEALED_WORKSPACE";
/**
 * The road this build takes when nothing asks for one.
 *
 * `image`, which is what shipped. The captain's ruling on call B of 2026-09-05 is "build it behind a
 * flag and prove it on the census forks first", so this moves when the proof exists and not before.
 */
declare function sealedWorkspaceDefault(): SealedWorkspace;
/** What this process was asked for, read once from the environment. */
declare function sealedWorkspaceRequested(environment?: Readonly<Record<string, string | undefined>>): SealedWorkspace;
/**
 * THE VOLUME OPTIONS, spelled once, because they are the whole mechanism.
 *
 * Docker's `local` driver hands `--opt type=`, `--opt device=` and `--opt o=` to the mount syscall
 * unchanged, so this is `mount -t overlay overlay -o lowerdir=...,upperdir=...,workdir=...` written
 * as a volume. The mount happens when the first container uses the volume, which is why a daemon
 * that cannot perform it reports at `docker run` and not at `docker volume create` - and why the
 * capability check below is a container and not a volume.
 *
 * A COMMA OR A COLON IN A PATH WOULD BE A DIFFERENT MOUNT, because `o=` is a comma-separated list
 * and `lowerdir=` is a colon-separated one. Both are refused here rather than escaped: the scratch
 * paths are abloh's own `mkdtemp` and carry neither, and a checkout that carries one takes the image
 * road with a sentence rather than a mount that means something else.
 */
/**
 * THE ONE CAPABILITY THE OVERLAY ROAD ADDS BACK, and it is PARITY WITH THE IMAGE ROAD rather than a
 * widening of it.
 *
 * WHY IT IS NEEDED. `COPY . /work` runs as root in the build, so on the image road every byte of the
 * workspace is ROOT-OWNED and the container's root writes anywhere in it. A mounted checkout keeps
 * the HOST user's ownership - uid 1001 on a GitHub runner, mode 0755 on its directories - and a
 * container that has dropped `CAP_DAC_OVERRIDE` is an ordinary user against that mode. It cannot
 * create a file in any directory of the tree, and it cannot open an existing one for writing.
 *
 * WHAT THAT BREAKS, measured on the census forks (runs 33980913379 and 33980919561): `unocss/unocss`
 * died in vite's `loadConfigFromFile` in 1.5 s against a 27 s suite, and `sveltejs/svelte` reported
 * 6,869 failures against 0. Only the top of the mount was writable, because overlayfs takes the
 * merged ROOT's mode from the upper directory, which is abloh's own - which is also why the first
 * probe passed over a road two of three suites could not run on.
 *
 * WHAT IT DOES NOT ADD. `DAC_OVERRIDE` bypasses file permission checks and nothing else: no network,
 * no mount, no ptrace, no setuid, no new privileges. `/candidate` stays read-only because that is
 * enforced by the MOUNT rather than by a mode. And every write it permits lands in this execution's
 * own upper layer, which the host deletes when the execution ends - it can never reach the checkout.
 * So the reach it restores is exactly the reach the image road already had, and no more.
 *
 * IT IS ON THE OVERLAY ROAD ONLY. An image-road container's argv is byte for byte what it was.
 */
declare const OVERLAY_WORKSPACE_CAPABILITY = "DAC_OVERRIDE";
declare const OVERLAY_UNMOUNTABLE_CHARACTERS: RegExp;
declare function overlayVolumeOptions(input: {
    lowerdir: string;
    upperdir: string;
    workdir: string;
}): readonly string[];
declare class DockerSealedRunner implements SealedRunner {
    #private;
    readonly id = "docker-sealed";
    readonly sealed = true;
    executions: number;
    /** the value of `SEALED_RUN_LABEL` on every container this runner starts */
    readonly runToken: string;
    /**
     * The selection template a targeted request is run with, resolved once and readable.
     *
     * It is part of what this runner IS rather than a private detail: `["%f"]` selects a file and a
     * `%t` form selects one test by name, and which of the two a construction site handed over is the
     * difference between proving our test ran and hoping it did.
     */
    readonly targetedArgs: readonly string[];
    /**
     * What every execution actually runs, resolved once and readable, for the same reason
     * `targetedArgs` is: a construction site that hands over the project's gated test script instead
     * of the runner is the difference between proving a generated test and refusing every one of
     * them, and a test that rebuilt the construction by hand would prove nothing about the seam.
     */
    readonly testCommand: readonly string[];
    /**
     * The directory the install command runs in, resolved once and readable, `null` for the
     * repository root.
     *
     * Readable for the same reason `targetedArgs` and `testCommand` are: installing at the workspace
     * root and installing inside the measured package build two different images from one repository,
     * and which of the two a construction site handed over is not something a caller should have to
     * rebuild a Dockerfile to find out.
     */
    readonly installSubdir: string | null;
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
    readonly executionSubdir: string | null;
    /**
     * What this runner will serve the network from, or null when it serves nothing.
     *
     * Readable for the same reason the three fields above are: whether the sealed container answers a
     * candidate's HTTP calls from a recording or lets them die on a network that is not there is a
     * fact about the run, and a test that rebuilt the container argv by hand to find it out would
     * prove nothing about the seam that builds it.
     */
    readonly replay: DockerRunnerOptions["replay"] | null;
    /**
     * The install command as everything below reads it: an absent one normalizes to empty, and empty
     * is the borrow path rather than a caller mistake.
     *
     * Normalized ONCE, in the constructor, because four separate places read it - the extras
     * detector, the recipe digest, the corepack line and the install line - and a runner where the
     * digest and the Dockerfile disagreed about whether anything installs would be a tag that names
     * an image it is not.
     */
    readonly installCommand: readonly string[];
    /** Where this environment comes from; `rebuilt` unless the caller borrowed a prepared tree. */
    readonly environmentSource: EnvironmentSource;
    /**
     * The cores this host reports, and the `--pids-limit` derived from them.
     *
     * RESOLVED ONCE, in the constructor, because three places read them - the container arguments,
     * the preparation's disclosure block and the notice a denied fork produces - and a run whose
     * disclosure named a ceiling different from the one it enforced would be worse than no field.
     */
    readonly hostCores: number;
    readonly pidsLimit: number;
    /**
     * WHICH ROAD WAS ASKED FOR, resolved once in the constructor.
     *
     * Readable for the reason {@link testCommand} is: which of two delivery mechanisms a run used is a
     * fact about the run, and a test that rebuilt the decision by hand would prove nothing about the
     * seam that makes it.
     */
    readonly workspace: SealedWorkspace;
    constructor(options: DockerRunnerOptions);
    /**
     * The road this preparation actually took, or null before {@link prepare} has decided.
     *
     * READ RATHER THAN ASSUMED, for the same reason {@link imageTag} is readable: a caller that wants
     * to know whether this run paid for a build context has exactly one honest source, and it is the
     * runner that built it.
     */
    get workspaceRoad(): SealedWorkspace | null;
    /** The sentence saying why the overlay road was declined, or null when it was not. */
    get workspaceFallback(): string | null;
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
    get imageTag(): string | null;
    prepare(): Promise<PreparedEnvironment>;
    execute(request: ExecutionRequest): Promise<ExecutionResult>;
    dispose(): Promise<void>;
}
/**
 * The candidate input directory, readable by a container that has dropped every capability.
 *
 * `mkdtempSync` creates 0700. The container runs with `--cap-drop ALL`, which takes away
 * `CAP_DAC_OVERRIDE`, so root inside the container can no longer bypass a permission check the way
 * root normally does - and 0700 owned by the host user is exactly such a check. The container could
 * not read the read-only mount of its own candidate, and every execution failed with
 * `cp: cannot stat '/candidate/...': Permission denied`, which the loop reports as
 * "the test did not pass against the real source": a generated test marked bad without being run.
 *
 * This is invisible on macOS, where Docker Desktop's file-sharing layer does not project host modes
 * into the container, and fatal on Linux, which is where CI runs. Measured 2026-08-13: 17 of 17
 * generated tests held for this reason on a Linux host; with this mode set, 4 of 4 gaps closed.
 *
 * 0755 is the widest this needs to be and no wider: the mount is read-only, the directory holds only
 * model-written test files that are about to be copied into the container, and it lives under a
 * 0700 scratch root that stays private to this process.
 */
declare function createInputRoot(scratchRoot: string): string;

/** True when a daemon answered. False when it is absent, erroring, or wedged - all of which skip. */
declare function dockerDaemonAvailable(dockerBin?: string): boolean;

/** The content identity of a `docker build` context directory. */
declare function buildContextDigest(contextDir: string): string;
/**
 * The sealed image's tag: the recipe AND the tree, so a different repository or a different commit
 * can never inspect its way into another's image.
 */
declare function sealedImageTag(input: {
    recipeDigest: string;
    contextDigest: string;
}): string;
declare function sealedWorkspaceImageTag(recipeDigest: string): string;

/**
 * Selecting ONE test by name, when the runner's filter is a regular expression.
 *
 * Every runner the engine drives - jest `-t`/`--testNamePattern`, vitest `-t`, node
 * `--test-name-pattern` - takes a REGEX, not a literal. Handing it a test name verbatim is therefore
 * correct only for names made of ordinary characters, and silently wrong for the rest: the filter
 * matches nothing, the runner exits 0 with everything skipped, and a caller reading the exit code
 * sees a green run where in truth no test ran at all.
 *
 * Measured on the pool-2 acceptance run, 2026-08-14. Two of the 15 dayjs items had answer-key test
 * names carrying metacharacters - `Update locale Partial update to nested object (formats)` and
 * `$isDayjsObject` - and both replayed as a vacuous no-op:
 *
 *     exit=0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 7 skipped, 7 total
 *
 * Every survivor in those two items was recorded as uncoupled without a single test executing. With
 * the pattern escaped, 4 of 11 and 3 of 4 of them are coupled.
 *
 * Anchoring matters for the opposite failure: an unanchored literal is a substring match, so
 * selecting `parses a date` also selects `parses a date range`, and a filter meant to run one test
 * runs a family of them.
 *
 * WHICH NAME THE FILTER IS MATCHED AGAINST, and the defect that anchoring the wrong end caused.
 * mocha and vitest match their pattern against the FULL title - every enclosing `describe` joined to
 * the test's own name by a space - while the engine records `candidate.testName` as the leaf. So a
 * generated test wrapped in a `describe`, which is what a model writes when the file it is modelled
 * on is written that way, was selected by `^leaf$` and matched NOTHING.
 *
 * Measured 2026-08-15, three runners, one `describe("res.send(String)")` containing two tests:
 *
 *   | runner | `^sets the length$` | `(?:^|\s)sets the length$` |
 *   |---|---|---|
 *   | mocha 11.8.0 | 0 tests selected | exactly 1 |
 *   | vitest 3.2.4 | 2 SKIPPED, exit 0 | 1 passed, 1 skipped |
 *   | node:test, node 24.7.0 | 1 pass (it matches per level) | 1 pass |
 *
 * and in production on express at `18e5985b`, where every one of its test files is describe-wrapped:
 * the light check held its only candidate with "the runner did not execute the test at that path"
 * and all 8 pool-2 witnesses were refused `witness-not-executed`, on a repository whose suite is
 * green and whose runner works. vitest's row is the alarming one - vitest is a runner v2 is
 * otherwise proven on, and it reports the vacuous selection as a green skipped run.
 *
 * The start anchor is therefore a TITLE-BOUNDARY anchor rather than a start-of-string anchor. It is
 * a strict superset of `^name$`: everything that matched before still matches, so no selection that
 * worked can start selecting nothing. What it additionally admits is a test in another `describe`
 * whose leaf name is identical, which is the right trade against selecting none at all - and the end
 * anchor, which is the one that stops `parses a date` from dragging in `parses a date range`, is
 * untouched.
 */

/**
 * WHETHER THIS ARGV'S APPENDED ARGUMENTS HAVE TO CROSS A PACKAGE MANAGER is asked of
 * `separatorForCommand` in `@abloh/core`, and this package no longer spells a wrapper of its own.
 *
 * WHY THE WRAPPER WENT. It collapsed the answer to a boolean - "this is a package script, so emit a
 * `--`" - and the answer is not a boolean: it turns on the manager, on its major version, and on
 * whether the hop is `<pm> run <script>` or the built-in `<pm> test`. `pnpm run` has forwarded the
 * separator verbatim since 7.33.7, so the `true` this function returned put a bare `--` in front of
 * every selection on every pnpm repository, vitest read it as end-of-options, and `TanStack/query`'s
 * whole map came back empty. The measured table and that census row are in `command-plan.ts`.
 *
 * WHAT DID NOT MOVE. `planCommand` is still the one reading of the string - finding F34, where the
 * two engines' hand-spelled versions disagreed about `cross-env TZ=… npm run x` and could therefore
 * run different tests on one repository - and the refusal to add a SECOND separator to a command
 * that already carries one is inside the core decision now rather than beside a caller.
 */
/**
 * The targeted-selection template for one repository's runner and test command.
 *
 * This is what a production construction site passes as `targetedArgs`, and it is derived in ONE
 * place because both sites - the CLI dispatch seam and the overnight lane - drive the same runner
 * over the same runners. Without it a sealed runner falls back to `["%f"]`, which selects a FILE:
 * every other test in that file runs too, and nothing selects the one test the request named, so
 * the escaping this file provides is never reached on the shipped path.
 */
declare function targetedArgsFor(input: {
    runner: string;
    testCommand: readonly string[];
    /**
     * THE REPOSITORY'S OWN `packageManager` PIN, when the run recorded one.
     *
     * WHY A VERSION REACHES A SELECTION TEMPLATE AT ALL. Whether abloh's arguments need a `--` to
     * survive a package-manager hop is a fact about the manager AND its version AND the spelling of
     * the hop - `separatorForCommand` in `@abloh/core` carries the measured table and the census row
     * that paid for it. A caller that omits the pin gets the version-independent answer, which is
     * right for npm and for `pnpm run` and is the older answer everywhere else.
     */
    packageManager?: {
        name: PackageManagerName;
        version: string | null;
    } | null;
}): string[];
/**
 * Escape a literal test name for a runner's regular-expression name filter, and anchor it.
 *
 * `(?:^|\s)` rather than `^`: the runners match the whole title, the engine holds the leaf. See the
 * measurement table in this file's header for why, and for what it cost on express.
 */
declare function exactTestNamePattern(fullName: string): string;
/**
 * THE ONE OWNER of the test file's name as a RUNNER sees it.
 *
 * The engine names every file it touches relative to the REPOSITORY ROOT - that is the form a gap
 * carries, the form `placeCandidate` mints, and the form both runners write the generated file at.
 * The test command does not run at the repository root. It runs in the measured package
 * (`subdir`), because that is where the project's own runner and its config live.
 *
 * So the path that is correct everywhere else is wrong in exactly one place: the argv.
 *
 * THE DEFECT THIS FIXES, measured on the ruled replay sweep of 2026-08-20. The generated file was
 * written to `/work/product/packages/stryker-angular-runner/src/x.abloh-2ebd4c94.test.ts` - the
 * right place - and the container then ran, from inside
 * `/work/product/packages/stryker-angular-runner`, a command naming
 * `product/packages/stryker-angular-runner/src/x.abloh-2ebd4c94.test.ts`, which resolves to that
 * package's name repeated twice and does not exist. node:test answered
 * `Could not find '<path>'`, the loop read the failure as "the test did not pass against the real
 * source", and 55 of 55 candidates across three runs were judged on a file nobody ran.
 *
 * Deriving it here, from the repo-relative name, is what makes the three sites agree by
 * construction: one name is minted, one file is written at it, and the argv is a FUNCTION of that
 * same name rather than a second copy of it.
 *
 * IT IS THE RIGHT FORM FOR EVERY RUNNER, and the two families need it for different reasons. For a
 * runner whose selection is a real PATH resolved against the working directory - node:test, mocha,
 * ava, bun, deno - it is the only form that resolves at all. For a runner whose selection is a
 * PATTERN matched against the full path - jest's positional is a regex, vitest's a substring - the
 * subdir-relative form is a suffix of the repo-relative one, so everything that matched before
 * still matches and nothing new can.
 */
declare function runnerRelativeTestFile(input: {
    testFile: string;
    executionSubdir: string | null;
}): string;
/**
 * Substitute a targeted run's placeholders: `%f` is the test file AS THE RUNNER SEES IT, `%t` is the
 * escaped and anchored name pattern.
 *
 * `executionSubdir` is required and not optional. It is the directory the test command runs in, and
 * a caller that does not state it cannot produce a correct `%f` - see {@link runnerRelativeTestFile}
 * for the month this was silently wrong. `null` is the repository root and is a stated answer.
 *
 * An argument carrying `%t` is DROPPED when the request names no test, rather than filtered on the
 * empty string - `^$` matches only a test literally named "", so keeping it would turn "run this
 * file" into "run nothing". `%t` therefore belongs in the single-token form the runners all accept
 * (`--test-name-pattern=%t`, `--testNamePattern=%t`), so that dropping it cannot leave a flag behind
 * without its value.
 */
declare function substituteTargetedArgs(input: {
    targetedArgs: readonly string[];
    /** repo-relative, as the engine names every file */
    testFile: string;
    /** where the test command runs, repo-relative; `null` is the repository root */
    executionSubdir: string | null;
    testName?: string;
}): string[];

/**
 * Refusing to report a verdict about a test the runner never saw.
 *
 * THE DEFECT THIS EXISTS FOR, measured on the ruled replay sweep of 2026-08-20. Fifty-five of
 * fifty-five generated candidates across three real runs came back
 * `{ passed: false, executed: false, failedAssertion: false }` carrying node:test's own
 * `Could not find '<path>'`, and the loop turned every one of them into the hold reason "the test
 * did not pass against the real source". Nothing had run. The engine had never once measured
 * whether a generated test passes, and every "failed light check" verdict in its history was a
 * sentence about a file that was not there.
 *
 * Two separate things have to be refused, because they fail for different reasons:
 *
 *   THE FILE WAS NEVER PLACED. The request names a test file that is neither among the files this
 *   execution is placing nor already in the tree. That is the engine contradicting itself - the
 *   caller minted a path, wrote nothing there, and asked for it to be run - and no execution can
 *   turn it into evidence about a candidate.
 *
 *   THE RUNNER SAYS IT COULD NOT FIND IT. The file may be on disk and the runner's own collection
 *   still refuses the path it was handed: a wrong base directory, a config whose `include` does not
 *   reach it, a filter language that read the path as something else. Every runner the engine
 *   drives reports this, and every one of them reports it in a DIFFERENT sentence, which is why the
 *   table below is measured rather than assumed.
 *
 * Both raise {@link SpecNotFoundError} rather than returning a verdict. A verdict in either
 * direction is a lie: "did not pass" blames a candidate that never ran, and "passed" would invent a
 * proof. The engine's own dispatch turns a throw into `state: "unavailable"` with the reason on the
 * block, which is the visible failure this defect went a month without.
 */
/** Colour codes a runner writes when it thinks it has a terminal, removed before a line is read. */

/**
 * The runner's own statement that it could not find the spec it was given, or null.
 *
 * `requestedPath` is the path as the command carried it - what `%f` was substituted with - because
 * that, and not the engine's repo-relative name, is the string a runner echoes back.
 */
declare function specNotFoundEvidence(output: string, requestedPath: string): string | null;
/**
 * A targeted execution was asked to run a test file the runner cannot see.
 *
 * It is an ENGINE fault and never a candidate fault, which is why it is thrown rather than
 * returned: nothing downstream is entitled to read it as evidence about the generated test.
 */
declare class SpecNotFoundError extends EngineUnavailableError {
    /** the engine's repo-relative name for the test file */
    readonly testFile: string;
    /** the path as the runner command carried it, which is what the runner echoed back */
    readonly requestedPath: string;
    /**
     * IT CARRIES ITS OWN CODE (raw-message review, entry 211).
     *
     * A plain `Error` here was `unavailableCode`'s undeclared case, so both shapes reached every
     * surface as `proposals-unavailable:engine-error` - pooled with every exception this engine did not
     * anticipate, which is the grouping that hides a cause rather than naming it. Subclassing
     * `EngineUnavailableError` is what puts the code at the throw; the sentence below is unchanged
     * and stays local, as this class's `detail`.
     */
    constructor(input: {
        testFile: string;
        requestedPath: string;
        detail: string;
    });
}
/**
 * Before the run: the request names a test file that this execution is actually materialising.
 *
 * A path that is neither being placed now nor already in the tree cannot become a test, and asking
 * a container to run it wastes an execution to learn nothing. Checked here rather than after the
 * fact because it is decidable without spending the execution at all.
 */
declare function assertTargetedSpecIsPlaced(input: {
    testFile: string;
    requestedPath: string;
    placed: readonly string[];
    existsInTree: (repoRelative: string) => boolean;
}): void;
/**
 * After the run: the runner itself said the spec was not there.
 *
 * The backstop for everything the placement check cannot decide - a config whose `include` does not
 * reach the path, a base directory the runner resolves differently, a filter language that read the
 * path as a pattern and matched nothing. The file is on disk in all three and the run is still
 * vacuous.
 */
declare function assertRunnerFoundSpec(input: {
    testFile: string;
    requestedPath: string;
    output: string;
}): void;

interface CatalogEntry {
    id: string;
}
type CatalogResult = {
    ok: true;
    models: string[];
} | {
    ok: false;
    reason: string;
};
declare function fetchModelCatalog(env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<CatalogResult>;
type PinVerification = {
    state: "verified";
    deployment: string;
} | {
    state: "absent";
    available: string[];
} | {
    state: "unverified-open";
    reason: string;
};
/**
 * `unverified-open` is a real answer, not an error. Without endpoint credentials in the environment
 * the question cannot be asked, and recording the pin as verified anyway would be the false claim
 * this check exists to prevent.
 */
declare function verifyModelPin(model: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<PinVerification>;
/** Convenience for the wiring step: verify every name in the allowed family at once. */
declare function verifyModelFamily(env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Record<string, PinVerification>>;

/**
 * Characters per input token, MEASURED on this repository's own recorded prompts.
 *
 * `__fixtures__/metering/benchmark-meter-proxy.json` keeps the usage frame the endpoint itself
 * returned for 29 calls of one benchmark item, alongside the character count of each prompt that
 * produced it: 290,626 characters became 100,673 input tokens, which is 2.887 characters per token
 * in aggregate and 3.33 at the median call. Three is that number, rounded to something a reader can
 * hold, and it is why the old input side was about 4x too big - it priced one token per character,
 * a bound that is true of every tokenisation and near none of them.
 *
 * IT IS NOT A BOUND AND MUST NOT BE READ AS ONE. A prompt of unusual shape - dense punctuation, a
 * minified bundle, a language this tokeniser handles badly - tokenises below three characters each
 * and costs more than this says. That is the trade {@link callTypicalDollars} exists to make; the
 * bound is still {@link callCeilingDollars}, and it is still what the night holds.
 */
declare const TYPICAL_PROMPT_CHARS_PER_TOKEN = 3;
/**
 * The share of its completion ceiling a real call generates, MEASURED on the benchmark's own runs.
 *
 * The per-call spend traces under `firstmate/data/abloh-pr-cost-benchmark/artifacts/runs` hold
 * every v2 generation call the five-run benchmark made - 14, all completed. Against the 40,000-token
 * ceiling a two-gap batch carries, the four calls on PR-B generated 9,554 / 10,051 / 8,305 / 7,735
 * tokens: 19% to 25% of what they were allowed. Across all 14 the mean is 14% and the single
 * largest call in the set, 12,633 tokens, is 32%.
 *
 * A QUARTER is the top of the band the ruled two-gap batch actually lands in, not its middle, and
 * that is deliberate: this figure decides how many calls fit alongside each other, so a hold set at
 * the mean would admit calls the run cannot really afford and one set at the maximum would bring
 * back the jam it exists to remove. At the shipped generation pin and the verified card it puts one
 * call's hold at about $0.32 against a measured $0.26-$0.32 - the number Kenneth's ruling asked for
 * in the words "reserve measured typical cost".
 *
 * A SHARE RATHER THAN A TOKEN COUNT, because the ceiling itself already scales with the ask
 * (`batchCompletionCeiling`: one gap's ceiling plus 8,000 per further gap). A bigger batch is
 * genuinely a bigger call and holds proportionally more; a triage call against its 8,000-token pin
 * holds a fraction of what a generation call does, which is the truth about those two calls.
 */
declare const TYPICAL_COMPLETION_SHARE = 0.25;
/**
 * What one call of this shape has been MEASURED to cost, computed before the call.
 *
 * The sibling of {@link callCeilingDollars} and deliberately not a replacement for it. Same two
 * sides, same rate card, neither figure guessed: the prompt's characters become tokens at the
 * recorded {@link TYPICAL_PROMPT_CHARS_PER_TOKEN}, and the completion ceiling becomes generated
 * tokens at the recorded {@link TYPICAL_COMPLETION_SHARE}. Nothing here is a dollar constant - move
 * the rate card or the pin and this figure moves with them, which is the property that stops it
 * from going stale the way a hardcoded $0.30 would.
 *
 * WHAT IT IS FOR is admission on a pot small enough that the worst case jams it, and NOT for saying
 * what a run may spend: a ledger that holds this still charges what the call really cost, and still
 * refuses the next call once those real charges have reached its limit.
 */
declare function callTypicalDollars(rate: ModelRate, promptChars: number, completionCeiling: number): number;
/**
 * A call's expected cost, HELD against the ledger until the call settles - the worst case in the
 * night, the measured typical in a check run, whichever the paying ledger's policy binds on.
 *
 * WHY A HOLD RATHER THAN A CHECK, and this is the correction the pull-request lane forced. Both
 * lanes issue their generation calls CONCURRENTLY - one per changed file, at the plan's own
 * concurrency - and a rail that merely ASKS "does this fit in what is left?" is answered by every
 * one of those calls before any of them has charged anything. Eight parallel calls each see the
 * full remaining balance, all eight are admitted, and the limit is crossed by seven of them. It was
 * reproduced the first time `pool2-cost-ceiling.test.ts` drove two real files through a real meter:
 * a $1.20 ceiling admitted two $0.70 calls.
 *
 * So an admitted call's ceiling leaves the balance immediately and comes back when the call
 * settles, which is what makes "the limit is a hard stop" true of a run rather than of a call.
 */
interface SpendReservation {
    /**
     * The call is over. Release the hold and charge what it actually cost.
     *
     * ALWAYS CALLED, including when the call failed or threw: a named failure still burned tokens at
     * the endpoint in most of its shapes, and a hold nobody releases would shrink the run's budget by
     * a call's worst case for the rest of the run. Calling it twice is a no-op.
     *
     * `usageKnown` is what the ledger's REPORT is built on, and it is a separate question from the
     * balance. `true` means this figure is priced from a usage frame the endpoint sent for THIS call,
     * so it is a dollar amount a customer can be shown. `false` means the call was sent and reported
     * no usage at all: `dollars` is then the call's own worst case, consumed against the budget so the
     * ceiling still bounds the run, and reported as EXPOSURE rather than as a charge. A ledger that
     * summed the two would be printing a guess as a measurement. Defaults to `true`, which is what
     * every non-model charge is.
     */
    settle(item: string, dollars: number, usageKnown?: boolean): void;
}
/**
 * Everything {@link MeteredModelClient} needs from whichever ledger is paying.
 *
 * It is deliberately two methods and no state. The night's ledger has two envelopes and the check
 * run's has one pot; if this interface knew which, one lane's policy would be sitting in the other
 * lane's transport. What it asks instead is the only question both lanes answer the same way: may
 * this call, which could cost up to this much, start - and if not, in what words.
 */
interface SpendLedger {
    /**
     * Hold a call that is about to be made, or refuse it with the sentence saying why - which becomes
     * the `budget` failure's own detail.
     *
     * TWO PRICES ARRIVE AND THE LEDGER CHOOSES, because how much of a pot one in-flight call should
     * tie up is the one question the two lanes answer differently and neither answer belongs in the
     * transport. `ceilingDollars` is the call's true worst case ({@link callCeilingDollars}); the
     * night holds it and gets a stop no call can cross. `typicalDollars` is what a call of this shape
     * has been measured to cost ({@link callTypicalDollars}); a check run holds it, because against a
     * $2.00 pot the worst case admits one call at a time and serialises a loop that asked for eight.
     * Whichever a ledger holds is the same figure it admits against, so a call is never refused for a
     * cost the ledger was not prepared to reserve.
     *
     * THE LEDGER WRITES THE REFUSAL because the ledger is what has the numbers and the policy name.
     * "the night's derived model-call cap is spent" and "the generation arm is at its cost limit" are the
     * same event to the transport and different facts to a reader. The ledger also COUNTS the
     * refusal, and counts the admitted call, so a caller cannot forget to.
     *
     * `task` is the caller's own name for the ask - "generation", "repair", "bug-pool" - so a run
     * that was cut short can say WHICH phase was cut rather than only how many calls went unmade.
     */
    reserve(input: {
        ceilingDollars: number;
        typicalDollars: number;
        task: string;
    }): Promise<{
        ok: true;
        reservation: SpendReservation;
    } | {
        ok: false;
        reason: string;
    }>;
    /**
     * A call refused before any reservation could be made, because it cannot be priced at all.
     *
     * Separate from a refusal `reserve` returns, because there is no ceiling to offer: a model the
     * card does not name has no worst case to hold. It counts the same way, so a run that lost work
     * to an unpriced model reports the loss rather than looking like a run that had less to do.
     */
    recordUnpriceableCall(task: string): void;
    /** Extra HTTP attempts the transport absorbed inside a call already counted by `reserve`. */
    recordThrottleRetries(count: number): void;
}
/**
 * A `ModelClient` that spends a ledger's money.
 *
 * It wraps the real client rather than replacing it, so the loop, the bug pool and triage all meter
 * identically without knowing that a budget exists. Four things happen per call:
 *
 *   1. the model's rate is looked up; an unpriced model is refused, never estimated;
 *   2. the call's true ceiling AND its measured typical cost are computed and offered to the ledger,
 *      which HOLDS whichever its lane's policy binds on; a call the ledger declines is refused with
 *      a `budget` failure - a value the loop already handles, not a throw;
 *   3. the call is made;
 *   4. the hold is released and the realised usage charged, so the ledger holds actual dollars.
 *      What is charged is what happened, which under a typical hold can exceed what was held.
 */
declare class MeteredModelClient implements ModelClient {
    #private;
    readonly endpointHost: string;
    /**
     * OBSERVED usage only, summed over the calls that reported one.
     *
     * It is a floor on what this run spent, not a total, and {@link unknownUsageCalls} is how many
     * calls are missing from it. Adding a fabricated figure here would make the one number a report
     * treats as measured into a mixture of measurement and guess.
     */
    readonly usage: ModelUsage;
    calls: number;
    /** calls that were sent and reported no usage; their cost is unknown, never zero */
    unknownUsageCalls: number;
    constructor(inner: ModelClient, ledger: SpendLedger, card: RateCard);
    call(input: Parameters<ModelClient["call"]>[0]): Promise<ModelCallResult>;
}
/**
 * THE PER-RUN LOOP GUARD: $2.00 of model spend in one pull-request check run, on every plan.
 *
 * WHERE THE NUMBER COMES FROM. `data/abloh-benchmark-trials/report.md` section 5 measured a check
 * run on a mature library at $0.38 to $0.42 of model spend across three trials of six repositories,
 * and `MEASURED_DOLLARS_PER_CHECK_RUN` (`apps/api/src/check-allowance.ts`) carries the all-in figure
 * of $0.401 that the allowances are derived from. This bound is five times that, so no honest run
 * reaches it and a run whose diff is five times the size still finishes. Kenneth ruled it on
 * 2026-08-16 and the captain restated it on 2026-09-01 against the same arithmetic.
 *
 * IT IS A LOOP GUARD AND IT IS NOT A PRICE (captain, 2026-09-01). A run that crosses it is a run
 * repeating work, which is the same shape `RUNS_PER_PULL_REQUEST` catches one level up: twenty runs
 * on one pull request is a workflow pushing in a loop, and $2.00 in one run is a run looping inside
 * itself. So it never appears in customer copy, never on the pricing page, never in a plan
 * description, and never as a number a customer could plan around - `plan-limits.ts` states the same
 * rule for the sentences it owns. When it fires, `run-spend-bound-reached` in
 * `packages/core/src/refusal.ts` says a safety bound stopped the run and does NOT say what the bound
 * is. The one figure this file prints beside the number is a log line for the operator, not copy.
 *
 * ONE VALUE, EVERY PLAN. It is not a per-plan number and must never become one: a plan-dependent
 * loop guard is a price, and a price is what the monthly allowance already is.
 *
 * WHAT IT BOUNDS IS NOW THE WHOLE RUN, which is the 2026-09-01 correction. It has always bound the
 * GENERATION arm, and that left the hole the ruling names: triage charged nothing against this pot,
 * so "the ceiling on a run" was the ceiling on part of a run and the run itself was bounded by
 * nothing. Triage now charges the same ledger through {@link RunLedger.chargeCall} - see the CLI,
 * which builds one ledger before triage and hands the same object to both arms.
 *
 * THE OTHER RAIL STAYS EXACTLY WHERE IT IS. 128 gateway calls per run, held in a per-process `Map`
 * (`apps/api/src/model-gateway.ts`), guards abloh's own credential and is the backstop behind this.
 * At the $0.104 planting call the same report measured, 128 calls is about $13 in one check run,
 * priced by nothing - the quantity anybody agreed to is dollars, so dollars are what bind.
 *
 * THE NUMBER IS THE CAPTAIN'S TO MOVE AND THE MECHANISM DOES NOT MOVE WITH IT. Changing it changes
 * this constant and nothing else; nothing below reads it except through the ledger it is handed to.
 */
declare const RULED_CHECK_RUN_DOLLAR_CEILING = 2;
/** What one run spent, and what the ceiling refused it. */
interface RunSpend {
    /**
     * Dollars priced from usage the endpoint actually reported. EXACT, and exact is the point.
     *
     * It excludes {@link unknownUsageCeilingDollars}, which the balance consumed but nobody measured.
     * Summing the two here would print a worst case as a charge, and a customer reading "this run
     * cost $1.47" has to be reading a figure every cent of which came off a usage frame.
     */
    dollars: number;
    /**
     * Calls that were SENT and reported no usage at all.
     *
     * Not failures - a failed call that reported usage is priced exactly like a successful one. These
     * are the calls whose cost is genuinely unknown: an error status with no stream, a connection cut
     * before the usage frame, a wrapped client that threw. Reported as a count because "the run's cost
     * is $X plus whatever these N calls cost" is the honest sentence, and `$X` alone is not.
     */
    unknownUsageCalls: number;
    /**
     * What those calls consumed from the ceiling: each one's own computed worst case.
     *
     * THE BUDGET SPENDS IT, THE REPORT DOES NOT ADD IT. It is subtracted from the balance so the
     * ceiling still bounds a run whose endpoint stopped reporting usage, and it is stated separately
     * so nobody reads a worst case as a measurement.
     */
    unknownUsageCeilingDollars: number;
    /** logical model calls made; a throttle retry is not a second call */
    modelCalls: number;
    /** calls the ceiling refused before they were sent; each one is work this run did not do */
    refusedCalls: number;
    /**
     * Calls that WAITED for an in-flight call's hold to clear before they were admitted.
     *
     * NOT A FAILURE AND NOT FREE. Nothing was lost - every one of these calls happened - but the run
     * ran them one behind another instead of alongside, and it did so because the holds in flight
     * used up the pot. It is disclosed because it is the only evidence that the ceiling is costing
     * the run WALL rather than work, which is the measurement a decision to move the ceiling would be
     * made from - and it is the line Kenneth named as the proof that the hold now fits the call: a
     * run that queues most of an eight-wide loop is a run holding far more than its calls cost.
     */
    queuedCalls: number;
    /** refusals counted by the task that asked, so a report can say which phase was cut */
    refusedByTask: Record<string, number>;
    /** extra HTTP attempts the transport absorbed inside calls already counted in `modelCalls` */
    throttleRetries: number;
}
/**
 * One pull-request check run's money, in one place.
 *
 * ONE POT, NOT TWO. The night partitions its cap into a hunt envelope and a close envelope because
 * it runs two phases whose priorities differ and whose money must not be borrowable in the wrong
 * direction. A check run has one job - measure this change - and no such partition exists to
 * enforce, so inventing one here would be a second policy standing in for the ruled one.
 *
 * ONE LEDGER PER RUN, NOT PER PACKAGE. A pull request spanning workspace packages dispatches the
 * loop once per measurable package (`apps/cli/src/index.ts`), and a ledger built inside that
 * dispatch would give a five-package change five ceilings. The run builds it and hands it down.
 */
declare class RunLedger implements SpendLedger {
    #private;
    readonly ceilingDollars: number;
    readonly card: RateCard;
    /** every settlement, in order; `usageKnown: false` marks a worst case rather than a charge */
    readonly entries: Array<{
        item: string;
        dollars: number;
        usageKnown?: false;
    }>;
    constructor(ceilingDollars: number, card: RateCard);
    get spend(): RunSpend;
    /**
     * Dollars a NEW call may be admitted against: the ceiling, less what has been committed and less
     * every in-flight call's hold. Never negative - a run whose realised charges overshot the ceiling
     * reads as zero here and refuses everything, which is the stop doing its job.
     */
    get remaining(): number;
    /** True once the ceiling has refused at least one call, which is what a report must disclose. */
    get bound(): boolean;
    reserve(input: {
        ceilingDollars: number;
        typicalDollars: number;
        task: string;
    }): Promise<{
        ok: true;
        reservation: SpendReservation;
    } | {
        ok: false;
        reason: string;
    }>;
    recordUnpriceableCall(task: string): void;
    recordThrottleRetries(count: number): void;
    /**
     * Charge the run directly, outside a model call.
     *
     * The one caller is a test scripting a run that has already spent most of its ceiling; production
     * money reaches this ledger only through {@link reserve} for the generation arm and
     * {@link chargeOtherLane} for every arm that prices itself.
     */
    chargeCall(item: string, dollars: number): void;
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
    chargeOtherLane(item: string, dollars: number): void;
}

interface ModelConfigurationCheck {
    /** lines that must stop the run before it starts; empty when the configuration is usable */
    refusals: string[];
    /** lines to print and carry on: a deprecated variable name, an absent rate card */
    warnings: string[];
}
interface ModelConfigurationRequirements {
    /**
     * True when this lane cannot do its job without an endpoint, so a missing one is a REFUSAL.
     *
     * False for a lane that has mechanical work worth doing without a model - a check run still
     * measures, and its marigold block says `unavailable` with the named reason. Either way the
     * missing variable is reported HERE, at the start, rather than discovered at the moment the first
     * model call was going to be made.
     */
    endpointRequired: boolean;
    /**
     * True when this lane's spend limit is a promise it must keep, so an ABSENT card is a refusal
     * too - the night's case. A MALFORMED card is a refusal for every lane regardless of this flag.
     */
    rateCardRequired: boolean;
}
declare function checkModelConfiguration(env: NodeJS.ProcessEnv, requirements: ModelConfigurationRequirements): ModelConfigurationCheck;

export { ADMISSION_RULES, AGENT_BUG_MUTATOR, AIM_SOURCES, ALLOWED_MODEL_FAMILY, type AdmissionFinding, type AdmissionInput, type AdmissionResult, type AdmissionRule, type AgentBugAimDisclosure, type AgentBugDisclosure, type AgentBugPoolInput, type AgentBugPoolOutcome, type AgentBugPoolPolicy, type AgentBugRunResult, type AimSource, type AllowedModel, type AuditWindow, AzureModelClient, BROWSER_DRIVEN_SKIP_REASON, BUG_HOLD_REASONS, BUG_POOL_PROMPT_VERSION, BUG_POOL_REPLY_SCHEMA, BUG_POOL_STORE_SCHEMA, BUG_POOL_TASK, BUG_REFUSAL_REASONS, BUG_ROUTES, BUG_WITNESS_REPLY_SCHEMA, BUG_WITNESS_TASK, type BatchPromptItem, type BlindSpan, type BugBaselineProbe, type BugDiagnosis, type BugHoldReason, type BugPoolAim, type BugPoolGeneration, BugPoolStore, type BugPoolStoreData, type BugPoolTarget, type BugRefusalReason, type BugRoute, CALL_OVERHEAD_MS, CANNOT_DISTINGUISH_HOLD_REASON, CARRIABLE_TRIAGE_VERDICTS, CARRY_BOUNDS, CARRY_STORE_SCHEMA, CATCH_PROFILE_LIMIT, CHECK_BODY_LIMIT, CHECK_CONCLUSIONS, CHECK_EVIDENCE_STATES, CHECK_GATE_STATES, CHECK_STREAM_COUNTERS, CHECK_STREAM_MIN_INTERVAL_MS, CHECK_STREAM_STAGES, CHECK_STREAM_STAGE_LABELS, CHECK_STREAM_STAGE_STATES, CONFIG_CANDIDATES, CONTENT_POOL_REUSE_LIMIT, type CallSite, type CallTiming, type Candidate, type CandidateSupportFile, type CarriableTriageVerdict, type CarryCandidate, type CarryDisclosure, type CarryIdentity, type CarryKeyInput, type CarryPlan, type CarryPlanEntry, type CarryPort, type CatalogEntry, type CatalogResult, type CatchProfileDisclosure, type CatchProfileFile, type CatchProfileTest, type ChangedFunction, type CheckConclusion, type CheckEvidence, type CheckGate, type CheckProgressSink, CheckStream, type CheckStreamCounts, type CheckStreamEvent, type CheckStreamIdentity, type CheckStreamOptions, type CheckStreamProgress, type CheckStreamProposalRecord, type CheckStreamPublisher, type CheckStreamStage, type CheckStreamStageState, type CheckUpdate, type CheckVerdict, type ClassicMutantLocation, type ClassicMutantRecord, type ClassicOperator, type ClassicPlantedMutant, type ConfirmedFlip, type ConfirmedRebaselineComparison, type ContentPoolLookup, type CoverageIndex, type CoveredSpan, DECLINE_REASONS, DEFAULT_BUDGET, DEFAULT_PROOF_REPETITIONS, DEFAULT_TASK_PINS, type DeclineReason, type DetectedFunction, type DiscoveryOutcome, type DockerRunnerOptions, DockerSealedRunner, type DomainConstant, type DomainContext, type DomainType, EMPTY_DOMAIN_CONTEXT, ENDPOINT_AUTH_VAR, ENDPOINT_EFFORT_CATALOG_MESSAGE, ENDPOINT_KEY_VAR, ENDPOINT_URL_VAR, EXIT_VERDICTS, type EndpointConfig, type EndpointResolution, type EndpointUnavailable, EngineUnavailableError, type EnvironmentSource, type ExecutionRequest, type ExecutionResult, type ExecutionRouting, type ExitProofOptions, type ExitProofResult, type ExitVerdict, FEATURE_VERSION, FORCED_FULL_REASONS, FUNCTION_SHAPES, type FeedbackEntry, FeedbackLedger, type FileAttemptPlan, type FlipVerdict, type ForcedFullReason, type FunctionShape, type Funnel, type FunnelStage, GUTTING_LABELS, GUTTING_MUTATOR, GUTTING_ROUTES, type GapContext, type GenerationOutcome, type GraduatedBug, type GuttingDisclosure, type GuttingLabel, type GuttingPlanEntry, type GuttingResult, type GuttingRoute, type GuttingSummary, HARD_CALL_CEILING_MS, type Hold, INTAKE_EXCLUSION_REASONS, type ImportBinding, type InheritedEnvironment, type IntakeExclusion, type IntakeExclusionReason, type IntakeResult, type KillMatrixCell, type KillMatrixOptions, type KillMatrixResult, LADDER_RUNGS, LIGHT_CHECK_VERDICTS, LINE_MAP_FILE_LIMIT, LINE_MAP_SCHEMA, LINE_MUTATOR, LINE_OPERATORS, LINE_VERDICTS, LIVE_DEPENDENCY_HOLD_REASON, LOCKFILE_CANDIDATES, LOOP_STAGES, type LadderRung, type LightCheckOptions, type LightCheckResult, type LightCheckVerdict, type LineFileResult, LineMapStore, type LineMapStoreData, type LineMutant, type LineOperator, type LineOutcome, type LinePassInput, type LinePassResult, type LineVerdict, type LocalRunnerOptions, LocalUnsealedRunner, type LoopBudget, type LoopStage, MAX_COMPLETION_TOKENS, MAX_DERIVED_CALL_MS, MAX_DOMAIN_CONSTANTS, MAX_DOMAIN_CONSTANT_CHARS, MAX_DOMAIN_INVARIANTS, MAX_DOMAIN_INVARIANT_CHARS, MAX_DOMAIN_MODULES, MAX_DOMAIN_MODULE_CHARS, MAX_DOMAIN_TYPES, MAX_DOMAIN_TYPE_CHARS, MAX_EVIDENCE_CHARS, MAX_PLANTED_PER_FILE, MAX_PLANTED_TEXT_CHARS, MAX_README_FRAGMENTS, MAX_README_FRAGMENT_CHARS, MEASURED_ATTEMPT_EXECUTION_MS, MEASURED_EXECUTIONS_PER_ATTEMPT, MEASURED_EXECUTION_MS, MEASURED_GENERATION_ROUND_MS, MEASURED_TOKENS_PER_SECOND, MIN_README_NEEDLE, MODEL_EFFORTS, MODEL_FAILURES, MS_PER_DAY, MUTANT_READINGS, MUTATION_SHAPES, MUTATION_SPANS, type MarigoldTask, type MatrixCapDisclosure, type MeasuringSnapshot, MeteredModelClient, type ModelCallRecord, type ModelCallResult, type ModelClient, type ModelConfigurationCheck, type ModelConfigurationRequirements, type ModelEffort, type ModelFailure, type ModelFailureKind, type ModelJsonSchema, type ModelSurface, type ModelTransport, type MutantDifference, type MutantReading, type MutantReadingBasis, type MutationShape, type MutationSnippet, type MutationSpan, NETWORK_MODULES, NETWORK_TRANSPORT, NO_TEST_HOLD_REASON, type Neighborhood, type NeighborhoodFunction, type NormalizedSpan, OPEN_NETWORK_SKIP_REASON, OVERLAY_UNMOUNTABLE_CHARACTERS, OVERLAY_WORKSPACE_CAPABILITY, PER_GAP_COMPLETION_TOKENS, POLICY_SKIP_REASONS, PREDICTION_LABELS, PREDICTOR_DECISIONS, PREDICTOR_MODES, PREDICTOR_STORE_SCHEMA, PROMOTED_ORIGINS, PROMOTED_ROUND, PROMPT_VERSION, PROPOSALS_VERSION, type ParsedBugReply, type ParsedReply, type ParsedTestReport, type ParsedWitnessReply, type PatchResult, type PinVerification, type Placement, type PlacementInput, type PolicySkipReason, type PoolCoverage, type PoolSizingPlan, type PoolTargetScope, type PredictableMutant, type Prediction, type PredictionLabel, type PredictorAuditRound, type PredictorDecision, type PredictorDisclosure, type PredictorFeatures, type PredictorMode, type PredictorModel, type PredictorPlan, type PredictorPlanEntry, type PredictorPolicy, type PredictorRoundDisclosure, PredictorStore, type PredictorStoreData, type PredictorWindowDisclosure, type PreparedEnvironment, type PromotedCandidate, type PromotedOrigin, type PromotionStats, type ProposalsBlock, type ProposalsCompletedBlock, type ProposalsDisclosure, type ProposalsInput, type ProposalsPackageBlock, type ProposalsPackageResult, type ProposalsResult, type ProposalsSidecar, type ProposalsSummary, REPLAY_REPETITION_RANGE, REUSE_DECISIONS, REUSE_STORE_SCHEMA, RULED_AGENT_BUG_POOL_POLICY, RULED_CHECK_RUN_DOLLAR_CEILING, RULED_GENERATION_BATCH_SIZE, RULED_GENERATION_CONCURRENCY, RULED_IN_ROUND_REPAIR, RULED_LINE_PASS_ATTRIBUTION_TEST_FILES, RULED_LINE_PASS_MUTANTS_PER_FILE, RULED_MATRIX_CELLS_PER_ROUND, RULED_MIN_ATTEMPTS_PER_FILE, RULED_NIGHT_POOL2_WALL_ALLOWANCE_MS, RULED_POOL2_WALL_ALLOWANCE_MS, RULED_PREDICTOR_POLICY, RULED_REBASELINE_POLICY, RULED_SIZING_LAMBDA, RULED_SLICE_CAP, RULED_SLICE_COVERING_FILES, RULED_SLICE_POLICY, RULED_THROTTLE_RETRY, type RebaselineComparison, type RebaselineDisagreement, type RebaselineDisclosure, type RebaselineOutcome, type RebaselinePolicy, type RebaselineState, type RepairStats, type ReportedSpan, type ResolvedSpan, type ReuseCandidate, type ReuseDecision, type ReuseDisclosure, type ReusePlan, type ReusePlanEntry, ReuseStore, type ReuseStoreData, type ReuseStoreLoss, type RoutePurity, type RoutePurityDisclosure, RunLedger, type RunSpend, SEALED_PNPM_VERIFY_DEPS, SEALED_RUN_LABEL, SEALED_WORKSPACE_ENV, SENTINEL_TEST_NAME, SHAPE_DID_NOT_REACH_HOLD_REASON, SLICE_DROP_REASONS, SLICE_LEDGER_LIMIT, SLICE_LEDGER_SCHEMA, SLICE_OUTCOMES, SLICE_REFUSAL_REASONS, SLICE_ROLES, STORE_OPEN_REASONS, SUITE_DELTA_BASES, SUITE_VERDICT_SOURCES, type SealedRunner, type SealedWorkspace, type ShapeRouting, type SideRun, type SignedScoreDisclosure, type SizingPolicy, type SliceCarryPort, type SliceCoverageMap, type SliceDisclosure, type SliceDrop, type SliceDropReason, SliceLedger, type SliceLedgerData, type SliceNeighborhoodGap, type SliceOutcome, type SlicePlan, type SlicePlanEntry, type SlicePlanInput, type SlicePolicy, type SliceRefusal, type SliceRefusalReason, type SliceResult, type SliceRole, SpecNotFoundError, type SpendLedger, type SpendReservation, type StoreOpenReason, type StoredAgentBug, type StoredAuditRound, type StoredBugPool, type StoredCandidate, type StoredFilePool, type StoredLineMap, type StoredPredictorExample, type StoredReach, type StoredSliceAnswer, type StoredTriage, type StoredVerdict, type StreamProposal, type SuiteBaseline, type SuiteBaselineDisclosure, type SuiteBaselineProbe, type SuiteDelta, type SuiteDeltaBasis, type SuiteVerdictSource, type SurvivorGap, TEST_SHAPES, TRIAGE_PROMPT_VERSION, TRIAGE_VERDICTS, TRIVIAL_VERDICTS, TYPICAL_COMPLETION_SHARE, TYPICAL_PROMPT_CHARS_PER_TOKEN, type TaskModelPin, type TestShape, type TestShapeDisclosure, type ThrottleHeaders, type ThrottleRetryPlan, type ThrottleRetryPolicy, type TransportRequest, type TransportResponse, type TriageOutcome, type TriageRecord, type TriageVerdict, type TrivialTriageResult, type TrivialVerdict, UNCLASSIFIED_ROUTE, type UntestedLineVerdicts, type VerdictSnapshot, WORKED_TEMP_ROOT_EXAMPLE, type WinningSet, type WitnessGeneration, type WitnessProof, acceptBugDiagnosis, admitCandidate, aimBlock, aimDigest, aimWithin, applyGapPatch, applyRebaselineOutcome, assertAllowedModel, assertRunnerFoundSpec, assertTargetedSpecIsPlaced, attemptsForFile, auditRound, batchCompletionCeiling, boundEvidence, boundEvidenceTail, bugPoolStorePath, buildAgentBugDisclosure, buildAimDisclosure, buildBatchGenerationPrompt, buildBugPoolPrompt, buildCatchProfile, buildContextDigest, buildCoverageIndex, buildGapContext, buildKillMatrix, buildLineCoverageIndex, buildProposalsBlock, buildRebaselineDisclosure, buildRoutePurityDisclosure, buildSecretMountFlags, buildSecretPrelude, buildSliceDisclosure, buildTriagePrompt, buildWitnessPrompt, callSites, callTypicalDollars, candidateDigest, candidateIdentity, carriableTriageRecord, carriableVerdict, carryIdentityDigest, carryKey, catalogDigest, changedFunctionKey, changedFunctions, checkModelConfiguration, chooseAnchor, chooseWinningSet, classicPlantedByFile, classicSitesByFile, classifyHttpFailure, classifyRoutePurity, collectDomainContext, compareRebaseline, composeProposalsBlocks, composedProofsDigest, conclusionFor, confirmDisagreements, constantsIn, coverageClaimSentence, coveringTestFiles, createInputRoot, currentWholesaleDigests, decisiveOutcome, declarationAt, defaultExportName, deriveNeighborhood, derivedCallDeadlineMs, describeCarry, describeMutant, describeReuseDisclosure, detectFunctions, dockerBuildFailureEvidence, dockerDaemonAvailable, domainBlock, effectiveTotalMs, effortBelow, effortsFromCatalogMessage, emptyFunnel, emptyPredictorStore, emptyStore, enclosingFunction, exactTestNamePattern, exclusionBlock, executionOrder, exportSignatures, exportedNames, exportedTypes, exportsLine, fetchModelCatalog, fileContentDigest, fileFunctions, fileSetDigest, firstDeclaredTestName, floorState, foldAuditRound, forcedFullReasons, functionName, fundedAskPrefix, fundedFileCeiling, gapIdentity, generateBatch, generateBugPool, generateWitness, importBindings, importRules, importSpecifierFor, inheritedRecipeFields, intakeSurvivors, isAllowedModel, isContainedRelativePath, isEmptyDomainContext, isPolicySkip, isStructurallyUntestable, lightCheck, lightCheckHoldReason, lineMapCoverageIndex, lineOperatorInventory, locateBug, looksLikeAssertion, looksLikeGateFailure, looksLikeMachinery, maskCapturedOutput, measureBugBaselines, measureSuiteBaseline, mergeAimSpans, mocksTargetModule, modelPinString, modelPinsDigest, moduleBlock, moduleSpecifiers, movesAgainstTheScore, mutableSitesOnLines, mutationShape, mutationSpan, nonEmptyAims, normalizeSpan, overlapsAnyRange, overlayVolumeOptions, parseBugPoolReply, parseCandidatesReply, parseRetryAfterMs, parseTestReport, parseTriageReply, parseWitnessReply, placeCandidate, placementBlock, placementOf, planCarry, planGutting, planLineMutants, planNeighborhoodSlice, planPoolSizing, planPredictor, planReuse, planThrottleRetry, pool2ScoreComponent, predictGap, predictorDisclosure, predictorMode, proveCandidate, proveExit, proveSuite, proveWitness, pseudoTestedGaps, reachDigest, readMutantRun, readValidCandidate, readValidIdentity, readValidTriage, readmeFragments, rebaselineDue, rebaselineStatus, recomposeProposalsScore, renderMeasuring, renderVerdict, repositoryDigest, resolveChatUrl, resolveEndpoint, resolveImport, resolveModelsUrl, resolveReportedSpan, resolveResponsesUrl, routeTestShape, runAgentBugPool, runGuttingPass, runLinePass, runMarigold, runNeighborhoodSlice, rungKey, runnerRelativeTestFile, scoreComponent, sealedImageTag, sealedWorkspaceDefault, sealedWorkspaceImageTag, sealedWorkspaceRequested, seededAuditSlice, selectLineMutants, sentinelSource, sidecarDigest, sizingSitesOf, sliceAnswerKey, sliceSourceFiles, spanIdentity, spanOffsets, specNotFoundEvidence, storeLossIsEmpty, storePartitionKey, stridedSample, stripComments, stripLiteralsAndComments, substituteTargetedArgs, suiteDelta, suiteTestPackages, summarizeAuditWindow, survivorPool2Projection, survivorProofsProjection, targetedArgsFor, taskModelIdentity, throttleBackoffMs, toSideRun, trainPredictor, transportTimeoutsMs, triageGaps, trivialTriage, twoRates, unavailableCode, unavailableDetail, uncoveredSitesByFile, untestedLineVerdicts, uploadableSidecarText, validateAgentBugPoolPolicy, validatePredictorPolicy, validateRebaselinePolicy, validateSizingPolicy, validateSlicePolicy, validateThrottleRetryPolicy, verifyModelFamily, verifyModelPin, wholesalePaths };
