set -e
cd /work
mkdir -p /tmp/abloh-bisect
( while :; do echo "$(date +%s) $(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo -) $(cat /sys/fs/cgroup/memory.swap.current 2>/dev/null || echo -) $(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo -)"; sleep 5; done ) > /tmp/abloh-bisect/series.txt 2>/dev/null &
SAMPLER=$!
S=$(date +%s%N)
set +e
sh -c "$INNER" > /tmp/abloh-bisect/stdout.txt 2> /tmp/abloh-bisect/stderr.txt
CODE=$?
E=$(date +%s%N)
kill $SAMPLER 2>/dev/null
echo "RESULT exit=$CODE wall_ms=$(( (E - S) / 1000000 ))"
cd /sys/fs/cgroup
for f in memory.peak memory.swap.peak memory.max memory.swap.max pids.peak pids.max cpu.max; do echo "$f=$(cat $f 2>/dev/null | tr '\n' ' ')"; done
echo "memory.events: $(tr '\n' ' ' < memory.events)"
echo "memory.swap.events: $(tr '\n' ' ' < memory.swap.events 2>/dev/null)"
echo "cpu.stat: $(tr '\n' ' ' < cpu.stat)"
echo "memory.stat: $(grep -E '^(anon|file|pgmajfault|pgfault|workingset_refault_file|workingset_refault_anon|pgscan|pgsteal|pswpin|pswpout) ' memory.stat | tr '\n' ' ')"
for p in memory cpu io; do echo "$p.pressure: $(tr '\n' ' ' < $p.pressure)"; done
echo "SUMMARY $(node -e 'try{const fs=require("fs");const t=fs.readFileSync("/tmp/abloh-bisect/stdout.txt","utf8");const i=t.indexOf("{\"numTotalTestSuites\"");const r=JSON.parse(t.slice(i<0?t.indexOf("{"):i));console.log("suites="+r.numTotalTestSuites,"suites_failed="+r.numFailedTestSuites,"tests="+r.numTotalTests,"passed="+r.numPassedTests,"failed="+r.numFailedTests,"success="+r.success)}catch(e){console.log("no-json-report:",String(e.message).slice(0,80))}')"
echo "--- stderr tail"; tail -c 2500 /tmp/abloh-bisect/stderr.txt
echo "--- stdout head"; head -c 400 /tmp/abloh-bisect/stdout.txt | tr -d '\r'; echo
echo "--- series"; cat /tmp/abloh-bisect/series.txt
