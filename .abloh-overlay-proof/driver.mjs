/*
 * Call B's proof: the borrow road's image build against an overlay-volume workspace, on a real
 * GitHub `ubuntu-latest` runner, through the shipped `DockerSealedRunner` and not a re-creation
 * of it.
 *
 * COLD BEFORE EVERY ARM. `docker builder prune -af` and an image removal run in front of each
 * arm, because that is the condition a real run meets: a hosted check gets a fresh runner with an
 * empty docker cache, which is what made the report's 37 to 46 s the whole build rather than a
 * COPY layer. A warm-cache comparison would flatter both arms and answer a question nobody asks.
 *
 * INTERLEAVED, two readings each, because wall clock on one box across a window is not comparable
 * with itself (`AGENTS.md`, the Aster row).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { DockerSealedRunner } from "@abloh/marigold";

const key = process.env.PROOF_KEY;
const repoDir = process.env.PROOF_REPO_DIR ?? process.cwd();
const image = process.env.PROOF_IMAGE;
const testCommand = JSON.parse(process.env.PROOF_TEST_ARGV);
const runnerName = process.env.PROOF_RUNNER ?? "vitest";
const pm = process.env.PROOF_PM ?? "";
const out = process.env.PROOF_OUT ?? "/tmp/overlay-proof.json";

const docker = (argv) => spawnSync("docker", argv, { encoding: "utf8", timeout: 600_000 });
/*
 * OPT-IN, AND ONLY ON A DISPOSABLE RUNNER. `PROOF_COLD=1` empties the daemon's build cache and its
 * unused images, which is the condition a hosted check really meets - a fresh runner has neither -
 * and is exactly what must never be done on somebody's own machine. Unset, the arms run warm and
 * the reading is about the container rather than about the build.
 */
const cold = () => {
  if (process.env.PROOF_COLD !== "1") return;
  docker(["builder", "prune", "-af"]);
  docker(["image", "prune", "-af"]);
};

const declaredPackageManager = pm === "" ? null : { name: pm.split("@")[0], version: pm.split("@")[1] };

function make(workspace) {
  return new DockerSealedRunner({
    repoDir,
    image,
    environmentSource: "borrowed",
    inheritedEnvironment: {
      node: process.version,
      packageManager: pm === "" ? null : pm,
      runtimes: [],
      lockfiles: [],
      runnerImage: { imageOs: "ubuntu24", imageVersion: "proof", platform: "linux", arch: "x64" },
    },
    ...(declaredPackageManager === null ? {} : { declaredPackageManager }),
    installCommand: [],
    testCommand,
    runner: runnerName,
    workspace,
    log: (line) => console.log(`[${workspace}] ${line}`),
  });
}

const rows = [];
const arms = ["image", "overlay", "image", "overlay"];
for (const [index, workspace] of arms.entries()) {
  cold();
  const sealed = make(workspace);
  const row = { key, arm: index + 1, asked: workspace };
  const t0 = Date.now();
  try {
    await sealed.prepare();
    row.prepareMs = Date.now() - t0;
    row.road = sealed.workspaceRoad;
    row.fallback = sealed.workspaceFallback;
    row.tag = sealed.imageTag;
    const size = docker(["image", "inspect", sealed.imageTag, "--format", "{{.Size}}"]);
    row.imageBytes = Number((size.stdout ?? "").trim()) || null;
    const t1 = Date.now();
    const result = await sealed.execute({ files: [], patches: [], mode: "suite", timeoutMs: 900_000 });
    row.executeMs = Date.now() - t1;
    row.exitCode = result.exitCode;
    row.timedOut = result.timedOut === true;
    row.report = {
      passed: result.report.passed,
      executed: result.report.executed,
      failed: result.report.failed,
      format: result.report.format,
    };
    /* THE WHOLE BOUNDED CAPTURE, head included: `boundEvidence` keeps the FIRST 4,000 characters,
       and a tail slice of it threw away the cause of unocss's overlay-arm failure on the first
       pass and cost a whole census cycle to get back. */
    row.output = result.output ?? "";
  } catch (error) {
    row.error = String(error && error.message ? error.message : error).slice(0, 800);
    row.road = sealed.workspaceRoad;
    row.fallback = sealed.workspaceFallback;
  } finally {
    await sealed.dispose();
    if (sealed.imageTag !== null) docker(["image", "rm", "-f", sealed.imageTag]);
  }
  rows.push(row);
  console.log(JSON.stringify({ ...row, output: (row.output ?? "").slice(0, 2500) }));
}

writeFileSync(out, JSON.stringify({ key, node: process.version, rows }, null, 2));
const mean = (road, field) => {
  const values = rows.filter((r) => r.road === road && typeof r[field] === "number").map((r) => r[field]);
  return values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
};
console.log("=== SUMMARY", key);
for (const road of ["image", "overlay"]) {
  console.log(`${road}: prepare=${mean(road, "prepareMs")}ms execute=${mean(road, "executeMs")}ms`);
}
try {
  console.log(execFileSync("du", ["-sh", repoDir], { encoding: "utf8" }).trim());
} catch {}
