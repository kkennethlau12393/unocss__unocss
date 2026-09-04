#!/bin/bash
# Second probe: the checkout-built image with and without CI=true inside the seal, sampled every 10 s.
set -u
OUT=$RUNNER_TEMP/ci-probe; mkdir -p "$OUT"
BASE="node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3"
DF=$RUNNER_TEMP/Dockerfile.probe
cat > "$DF" <<EOD
FROM $BASE
RUN ["sh","-c","set -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update && apt-get install -y --no-install-recommends git ca-certificates procps && rm -rf /var/lib/apt/lists/*\ncorepack enable && corepack prepare pnpm@11.24.0 --activate"]
WORKDIR /work
COPY . /work
EOD
printf '# nothing excluded\n' > "$DF.dockerignore"
FULL="--init --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g"
docker build -f "$DF" -t probe:checkout . > "$OUT/build.log" 2>&1; echo "build exit=$?"
echo "=== .modules.yaml store and virtual store recorded by the maintainer's install"
grep -E "^(storeDir|virtualStoreDir|layoutVersion|prunedAt)" node_modules/.modules.yaml
probe() { # arm cap cmd [extra docker flags]
  ARM=$1; CAP=$2; CMD=$3; shift 3
  NAME=probe-$ARM-$$
  echo "=== $ARM $(date -u +%T) flags: $*"
  T0=$(date +%s)
  ( for i in $(seq 1 12); do docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^$NAME$" && break; sleep 1; done
    while docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^$NAME$"; do
      docker exec "$NAME" sh -c 'echo "--- $(date +%T) pids=$(cat /sys/fs/cgroup/pids.current) node_modules_entries=$(ls /work/node_modules 2>/dev/null | wc -l) vitest_bin=$(test -e /work/node_modules/.bin/vitest && echo present || echo gone)"; ps -eo pid,ppid,pcpu,etime,args --sort=-pcpu | head -9 | cut -c1-170' >> "$OUT/$ARM.ps" 2>/dev/null
      sleep 10
    done ) &
  SAMP=$!
  timeout -k 5 $CAP docker run --rm --name "$NAME" $FULL "$@" probe:checkout sh -c "cd /work && $CMD" > "$OUT/$ARM.out" 2>&1
  RC=$?
  echo "exit=$RC wall_s=$(( $(date +%s) - T0 ))"
  [ $RC -eq 124 ] && docker rm -f "$NAME" > /dev/null 2>&1
  kill $SAMP 2>/dev/null; wait $SAMP 2>/dev/null
  echo "--- output tail"; tail -c 1200 "$OUT/$ARM.out" | tr -d '\r'; echo
  echo "--- samples"; grep -E "^--- " "$OUT/$ARM.ps" 2>/dev/null | head -40
}
probe exec-ci 240 'pnpm exec node -e "console.log(\"exec ok\")"' -e CI=true
probe suite-ci 300 'npx --no-install vitest run --reporter=json' -e CI=true
probe suite-noci 300 'npx --no-install vitest run --reporter=json'
echo "=== done $(date -u +%T)"
