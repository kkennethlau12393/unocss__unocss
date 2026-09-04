#!/bin/bash
# usage: run-arms.sh <image> <inner-cmd> <outdir> <pids> [arms...]
IMAGE=$1; INNER=$2; OUT=$3; PIDS=$4; shift 4
mkdir -p "$OUT"
HERE=$(cd "$(dirname "$0")" && pwd)
CAP=${CAP:-720}
FULL="--init --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit $PIDS --memory 4g"
arm_flags() {
  case "$1" in
    c-plain) echo "" ;;
    c-full) echo "$FULL" ;;
    c-full-nomem) echo "--init --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit $PIDS" ;;
    c-full-nopids) echo "--init --network none --cap-drop ALL --security-opt no-new-privileges --memory 4g" ;;
    c-full-net) echo "--init --cap-drop ALL --security-opt no-new-privileges --pids-limit $PIDS --memory 4g" ;;
    c-full-caps) echo "--init --network none --pids-limit $PIDS --memory 4g" ;;
    c-full-noinit) echo "--network none --cap-drop ALL --security-opt no-new-privileges --pids-limit $PIDS --memory 4g" ;;
    c-full-noswap) echo "$FULL --memory-swap 4g" ;;
    c-full-mem8g) echo "--init --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit $PIDS --memory 8g" ;;
    c-full-mem6g) echo "--init --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit $PIDS --memory 6g" ;;
    c-plain-warm) echo "" ;;
    c-full-warm) echo "$FULL" ;;
    *) echo "UNKNOWN"; return 1 ;;
  esac
}
for ARM in "$@"; do
  FLAGS=$(arm_flags "$ARM") || { echo "unknown arm $ARM"; continue; }
  NAME="bisect-$ARM-$$"
  LOG="$OUT/$ARM.log"
  {
    echo "ARM $ARM image=$IMAGE cap=${CAP}s"; echo "FLAGS $FLAGS"; echo "INNER $INNER"; echo "START $(date -u +%FT%TZ)"
    T0=$(date +%s.%N)
    timeout -k 5 $CAP docker run --rm --name "$NAME" $FLAGS -e INNER="$INNER" "$IMAGE" sh -c "$(cat "$HERE/wrapper.sh")"
    RC=$?
    T1=$(date +%s.%N)
    echo "OUTER exit=$RC wall_s=$(echo "$T1 - $T0" | bc)"
    if [ $RC -eq 124 ] || [ $RC -eq 137 ]; then
      echo "TIMEOUT: dumping cgroup state before removal"
      docker exec "$NAME" sh -c 'cd /sys/fs/cgroup; for f in memory.peak memory.swap.peak pids.peak; do echo "$f=$(cat $f)"; done; echo "memory.events: $(tr "\n" " " < memory.events)"; echo "memory.stat: $(grep -E "^(anon|file|pgmajfault|workingset_refault_file|pswpin|pswpout) " memory.stat | tr "\n" " ")"; for p in memory cpu io; do echo "$p.pressure: $(tr "\n" " " < $p.pressure)"; done; echo "--- ps"; ps -eo pid,ppid,stat,rss,etime,args | head -80; echo "--- stderr tail"; tail -c 3000 /tmp/abloh-bisect/stderr.txt; echo; echo "--- series"; cat /tmp/abloh-bisect/series.txt' 2>&1
      docker rm -f "$NAME" >/dev/null 2>&1
    fi
    echo "END $(date -u +%FT%TZ)"
  } > "$LOG" 2>&1
  echo "=== $ARM"; grep -E "^(FLAGS|RESULT|OUTER|SUMMARY|memory.peak|memory.swap.peak|pids.peak|memory.events|TIMEOUT)" "$LOG"
done
