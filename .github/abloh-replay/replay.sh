#!/bin/bash
# usage: replay.sh <base-sha>   Runs the census's own abloh step shape (CLI from the census tarballs), with a sampler beside it.
set -u
BASE=$1
OUT=$RUNNER_TEMP/abloh-replay; mkdir -p "$OUT/state/baseline-history" "$OUT/state/coverage-providers" "$OUT/state/engine-v2" "$OUT/state/triage-cache" "$OUT/output" "$OUT/runs"
( while :; do { echo "=== $(date -u +%T)"; uptime; free -m | sed -n 2,3p; docker ps --no-trunc --format '{{.Names}} {{.Status}} {{.Command}}'; docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}} io={{.BlockIO}}' 2>/dev/null; ps -eo pid,ppid,pcpu,pmem,rss,etime,stat,args --sort=-pcpu | head -14 | cut -c1-200; } >> "$OUT/sampler.log" 2>&1; sleep 15; done ) &
SAMPLER=$!
PREFIX=$RUNNER_TEMP/abloh-cli
echo "=== install the census CLI closure"
npx -y npm@11.6.1 install -g --prefix "$PREFIX" --ignore-scripts --no-audit --no-fund -- .abloh-census/engine/*.tgz 2>&1 | tail -5
ls -la "$PREFIX/bin"
export ABLOH_BASELINE_HISTORY_DIR="$OUT/state/baseline-history" ABLOH_COVERAGE_PROVIDER_CACHE_DIR="$OUT/state/coverage-providers" ABLOH_V2_STORE_DIR="$OUT/state/engine-v2" ABLOH_RUNS_DIR="$OUT/runs"
echo "=== abloh run $(date -u +%T) base=$BASE head=$(git rev-parse HEAD)"
T0=$(date +%s)
node "$PREFIX/bin/abloh" run --repo "$PWD" --base "$BASE" --head "$(git rev-parse HEAD)" --cache-dir "$OUT/state/triage-cache" --json "$OUT/output/abloh-run.json" 2>&1 | awk '{ print strftime("[%H:%M:%S]"), $0; fflush() }' | tee "$OUT/abloh.log"
echo "ABLOH exit=${PIPESTATUS[0]} wall_s=$(( $(date +%s) - T0 ))"
kill $SAMPLER 2>/dev/null
docker ps -a --no-trunc --format '{{.Names}} {{.Status}}' >> "$OUT/sampler.log"
ls -la "$OUT/output" "$OUT/runs" 2>/dev/null | head -30
