#!/bin/bash
# Third probe: abloh's worktree shape with a working sampler and a full process-state dump at 120 s.
set -u
OUT=$RUNNER_TEMP/wt-probe2; mkdir -p "$OUT"
BASE="node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3"
DF=$RUNNER_TEMP/Dockerfile.probe
cat > "$DF" <<EOD
FROM $BASE
RUN ["sh","-c","set -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update && apt-get install -y --no-install-recommends git ca-certificates procps iproute2 && rm -rf /var/lib/apt/lists/*\ncorepack enable && corepack prepare pnpm@11.24.0 --activate"]
WORKDIR /work
COPY . /work
EOD
printf '# nothing excluded\n' > "$DF.dockerignore"
FULL="--init --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g"
WT=$RUNNER_TEMP/wt
git worktree add --detach "$WT" HEAD > /dev/null 2>&1
# abloh's rule: every ignored untracked directory git lists that is a dependency root, copied with cp -a
git ls-files --others --ignored --exclude-standard --directory -z | tr '\0' '\n' | grep -E '(^|/)node_modules/$' > "$OUT/roots.txt"
n=0; while read -r r; do r=${r%/}; mkdir -p "$WT/$(dirname "$r")"; cp -a --reflink=auto "$r" "$WT/$r" && n=$((n+1)); done < "$OUT/roots.txt"
echo "copied $n dependency roots (git listed $(wc -l < "$OUT/roots.txt"))"
echo "worktree has .modules.yaml: $(test -f $WT/node_modules/.modules.yaml && echo yes || echo no), dist dirs: $(find $WT -maxdepth 3 -name dist -type d | wc -l)"
(cd "$WT" && docker build -f "$DF" -t probe:worktree . > "$OUT/build.log" 2>&1; echo "build exit=$?")
dump() { # name
  docker exec "$1" sh -c '
    echo "##### dump $(date +%T) pids=$(cat /sys/fs/cgroup/pids.current) node_modules_entries=$(ls /work/node_modules 2>/dev/null | wc -l)"
    ps -eo pid,ppid,pcpu,etime,stat,wchan:24,args --sort=pid | cut -c1-200
    for p in $(ps -eo pid,args | grep -E "node|pnpm|tsx" | grep -v grep | awk "{print \$1}"); do
      echo "== pid $p wchan=$(cat /proc/$p/wchan 2>/dev/null) state=$(grep -E "^State" /proc/$p/status | tr -s " ")"
      ls -l /proc/$p/fd 2>/dev/null | awk "{print \$NF}" | sort | uniq -c | sort -rn | head -6
    done
    echo "== sockets"; ss -tanp 2>/dev/null | head -12; cat /proc/net/tcp 2>/dev/null | head -5
    echo "== /work/_temp"; ls /work/_temp 2>/dev/null | head -5
  ' >> "$OUT/$2.dump" 2>&1
}
probe() { # arm cap cmd [extra docker flags]
  ARM=$1; CAP=$2; CMD=$3; shift 3
  NAME=probe-$ARM-$$
  echo "=== $ARM $(date -u +%T) flags: $*"
  T0=$(date +%s)
  ( for i in $(seq 1 15); do docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^$NAME$" && break; sleep 1; done
    t=0
    while docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^$NAME$"; do
      docker exec "$NAME" sh -c 'echo "--- $(date +%T) pids=$(cat /sys/fs/cgroup/pids.current) nm=$(ls /work/node_modules 2>/dev/null | wc -l)"; ps -eo pid,ppid,pcpu,etime,args --sort=-pcpu | head -8 | cut -c1-160' >> "$OUT/$ARM.ps" 2>/dev/null
      t=$((t+10)); [ $t -eq 120 ] && dump "$NAME" "$ARM"
      sleep 10
    done ) &
  SAMP=$!
  timeout -k 5 $CAP docker run --rm --name "$NAME" $FULL "$@" probe:worktree sh -c "cd /work && $CMD" > "$OUT/$ARM.out" 2>&1
  RC=$?
  echo "exit=$RC wall_s=$(( $(date +%s) - T0 ))"
  [ $RC -eq 124 ] && docker rm -f "$NAME" > /dev/null 2>&1
  kill $SAMP 2>/dev/null; wait $SAMP 2>/dev/null
  echo "--- output tail"; sed 's/\x1b\[[0-9;]*m//g' "$OUT/$ARM.out" | tail -c 900; echo
  echo "--- samples"; grep -E "^--- " "$OUT/$ARM.ps" 2>/dev/null | head -30
  [ -f "$OUT/$ARM.dump" ] && { echo "--- dump"; head -80 "$OUT/$ARM.dump"; }
}
probe suite-wt 240 'npx --no-install vitest run --reporter=default'
probe suite-wt-ci 240 'npx --no-install vitest run --reporter=default' -e CI=true
probe exec-wt 120 'pnpm exec node -e "console.log(\"exec ok\")"'
echo "=== done $(date -u +%T)"
