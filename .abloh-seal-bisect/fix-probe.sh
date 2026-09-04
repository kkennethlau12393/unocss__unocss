#!/bin/bash
# Fourth probe: which environment stops pnpm 11 recreating node_modules inside the seal, with CI=true kept.
set -u
OUT=$RUNNER_TEMP/fix-probe; mkdir -p "$OUT"
BASE="node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3"
DF=$RUNNER_TEMP/Dockerfile.probe
cat > "$DF" <<EOD
FROM $BASE
RUN ["sh","-c","set -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update && apt-get install -y --no-install-recommends git ca-certificates procps && rm -rf /var/lib/apt/lists/*\ncorepack enable && corepack prepare pnpm@11.24.0 --activate"]
ENV CI=true
WORKDIR /work
COPY . /work
EOD
printf '# nothing excluded\n' > "$DF.dockerignore"
FULL="--init --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g"
docker build -f "$DF" -t probe:ci . > "$OUT/build.log" 2>&1; echo "build exit=$?"
echo "=== .modules.yaml as the maintainer's install left it"; grep -E "^(storeDir|virtualStoreDir|layoutVersion)" node_modules/.modules.yaml; echo "pnpm store path on the runner: $(pnpm store path)"
probe() { # arm cap cmd [extra docker flags]
  ARM=$1; CAP=$2; CMD=$3; shift 3
  NAME=probe-$ARM-$$
  echo "=== $ARM $(date -u +%T) flags: $*"
  T0=$(date +%s)
  timeout -k 5 $CAP docker run --rm --name "$NAME" $FULL "$@" probe:ci sh -c "cd /work && $CMD; echo \"node_modules entries after: \$(ls /work/node_modules | wc -l)\"" > "$OUT/$ARM.out" 2>&1
  RC=$?
  echo "exit=$RC wall_s=$(( $(date +%s) - T0 ))"
  [ $RC -eq 124 ] && docker rm -f "$NAME" > /dev/null 2>&1
  echo "--- output"; sed 's/\x1b\[[0-9;]*m//g' "$OUT/$ARM.out" | grep -v "^\[WARN\] GET" | head -c 700; echo
}
probe exec-ci-plain 200 'pnpm exec node -e "console.log(\"exec ok\")"'
probe exec-ci-envfalse 200 'pnpm exec node -e "console.log(\"exec ok\")"' -e npm_config_verify_deps_before_run=false
probe exec-ci-pnpmconfig 200 'pnpm exec node -e "console.log(\"exec ok\")"' -e PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
probe exec-ci-storedir 200 'pnpm exec node -e "console.log(\"exec ok\")"' -e npm_config_store_dir=/home/runner/setup-pnpm/node_modules/.bin/store/v11
probe exec-ci-offline 200 'pnpm exec node -e "console.log(\"exec ok\")"' -e npm_config_offline=true
probe exec-ci-warn 200 'pnpm exec node -e "console.log(\"exec ok\")"' -e npm_config_verify_deps_before_run=warn
probe run-ci-plain 200 'pnpm run --if-present nonexistent-script'
echo "=== done $(date -u +%T)"
