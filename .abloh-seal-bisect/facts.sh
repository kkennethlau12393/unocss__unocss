#!/bin/bash
echo "=== facts"; nproc; free -h; swapon --show; df -h / /mnt "$HOME" 2>/dev/null; grep -m1 "model name" /proc/cpuinfo; uname -r
echo "=== docker"; docker info 2>/dev/null | grep -E "Server Version|Storage Driver|Cgroup|Backing Filesystem|Kernel|Total Memory|CPUs|Docker Root Dir|containerd"
echo "=== mounts"; findmnt -T "$PWD" -o TARGET,SOURCE,FSTYPE,OPTIONS; findmnt -T /var/lib/docker -o TARGET,SOURCE,FSTYPE 2>/dev/null
echo "=== tree"; du -sh . node_modules 2>/dev/null; du -sh --apparent-size . 2>/dev/null
echo "=== sysctl"; sysctl vm.swappiness kernel.pid_max 2>/dev/null; cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null
