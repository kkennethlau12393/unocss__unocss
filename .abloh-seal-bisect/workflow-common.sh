#!/bin/bash
# usage: workflow-common.sh <repo-key> <base-image> <toolchain-line> <inner-cmd> [arms...]
# Runs on the GitHub runner after the maintainer's own install (and build where their job builds).
set -u
KEY=$1; BASE=$2; TOOLCHAIN=$3; INNER=$4; shift 4
OUT=$RUNNER_TEMP/seal-bisect; mkdir -p "$OUT"
HERE=$(cd "$(dirname "$0")" && pwd)
{
bash "$HERE/facts.sh"
echo "=== native ambient x2 (the runner's own shell, no container)"
for i in 1 2; do
  T0=$(date +%s.%N); /usr/bin/time -v sh -c "$INNER" > "$OUT/native-$i.json" 2> "$OUT/native-$i.err"; RC=$?; T1=$(date +%s.%N)
  echo "NATIVE $i exit=$RC wall_s=$(echo "$T1 - $T0" | bc) maxrss_kb=$(grep 'Maximum resident' "$OUT/native-$i.err" | awk '{print $NF}')"
  node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");const i=t.indexOf("{\"numTotalTestSuites\"");try{const r=JSON.parse(t.slice(i<0?t.indexOf("{"):i));console.log("  tests="+r.numTotalTests,"passed="+r.numPassedTests,"failed="+r.numFailedTests,"success="+r.success)}catch(e){console.log("  no-json-report")}' "$OUT/native-$i.json"
done
echo "=== abloh-shaped image build: digest walk, then docker build with an empty dockerignore"
node "$HERE/digest.mjs" .
PIDS=$(( $(nproc) * 128 )); [ $PIDS -lt 512 ] && PIDS=512
DF=$RUNNER_TEMP/Dockerfile.seal
cat > "$DF" <<EOD
FROM $BASE
RUN ["sh","-c","set -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*\n$TOOLCHAIN"]
RUN ["sh","-c","set -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update && apt-get install -y --no-install-recommends python3 make g++ pkg-config fontconfig fonts-dejavu-core fonts-liberation unixodbc procps && rm -rf /var/lib/apt/lists/*"]
WORKDIR /work
COPY . /work
EOD
printf '# Abloh borrows the tree your CI built, whole. Nothing is excluded.\n' > "$DF.dockerignore"
T0=$(date +%s.%N); docker build --network default -f "$DF" -t seal-bisect:$KEY . > "$OUT/docker-build.log" 2>&1; RC=$?; T1=$(date +%s.%N)
echo "DOCKER_BUILD exit=$RC wall_s=$(echo "$T1 - $T0" | bc)"; tail -5 "$OUT/docker-build.log"
docker image inspect seal-bisect:$KEY --format 'IMAGE size_bytes={{.Size}}'
echo "=== arms (pids=$PIDS)"
CAP=${CAP:-720} bash "$HERE/run-arms.sh" seal-bisect:$KEY "$INNER" "$OUT/arms" "$PIDS" "$@"
echo "=== done $(date -u +%FT%TZ)"
} 2>&1 | tee "$OUT/summary.txt"
