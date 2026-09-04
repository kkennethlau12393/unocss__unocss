#!/bin/bash
# Rebuild abloh's two image shapes on the runner and probe pnpm's verify-deps behaviour inside the seal.
set -u
OUT=$RUNNER_TEMP/worktree-probe; mkdir -p "$OUT"
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
echo "=== image A: built from the checkout"
docker build -f "$DF" -t probe:checkout . > "$OUT/build-checkout.log" 2>&1; echo "build A exit=$?"
echo "=== image B: built from an isolated worktree with only the ignored dependency roots copied in (abloh's shape)"
WT=$RUNNER_TEMP/wt
git worktree add --detach "$WT" HEAD > /dev/null 2>&1
ROOTS=$(git ls-files --others --ignored --exclude-standard --directory | grep -E '(^|/)node_modules/$' | sed 's#/$##')
n=0; for r in $ROOTS; do mkdir -p "$WT/$(dirname "$r")"; cp -a --reflink=auto "$r" "$WT/$r" && n=$((n+1)); done
echo "copied $n dependency roots into the worktree"; (cd "$WT" && ls -d packages-engine/core/dist 2>/dev/null || echo "no dist in the worktree, as in abloh's worktree")
(cd "$WT" && docker build -f "$DF" -t probe:worktree . > "$OUT/build-worktree.log" 2>&1; echo "build B exit=$?")
probe() { # image arm cap cmd [extra docker flags]
  IMG=$1; ARM=$2; CAP=$3; CMD=$4; shift 4
  NAME=probe-$ARM-$$
  echo "=== $ARM ($IMG) $(date -u +%T)"
  T0=$(date +%s)
  ( while docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^$NAME$"; do docker exec "$NAME" sh -c 'echo "--- $(date +%T) pids=$(cat /sys/fs/cgroup/pids.current)"; ps -eo pid,ppid,pcpu,etime,args --sort=-pcpu | head -12 | cut -c1-170' >> "$OUT/$ARM.ps" 2>/dev/null; sleep 10; done ) &
  SAMP=$!
  timeout -k 5 $CAP docker run --rm --name "$NAME" $FULL "$@" "$IMG" sh -c "cd /work && $CMD" > "$OUT/$ARM.out" 2>&1
  RC=$?
  echo "exit=$RC wall_s=$(( $(date +%s) - T0 ))"
  [ $RC -eq 124 ] && docker rm -f "$NAME" > /dev/null 2>&1
  kill $SAMP 2>/dev/null; wait $SAMP 2>/dev/null
  echo "--- output head"; head -c 1200 "$OUT/$ARM.out" | tr -d '\r'; echo; echo "--- output tail"; tail -c 1500 "$OUT/$ARM.out" | tr -d '\r'; echo
}
for IMG in probe:checkout probe:worktree; do
  tag=${IMG#probe:}
  probe "$IMG" "exec-$tag" 150 'pnpm --loglevel debug exec node -e "console.log(\"exec ok\")"'
  probe "$IMG" "offline-install-$tag" 150 'pnpm install --frozen-lockfile --offline --reporter=append-only'
  probe "$IMG" "suite-$tag" 200 'npx --no-install vitest run --reporter=default'
done
probe probe:worktree "suite-worktree-noverify" 200 'npx --no-install vitest run --reporter=default' -e PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
echo "=== done $(date -u +%T)"
