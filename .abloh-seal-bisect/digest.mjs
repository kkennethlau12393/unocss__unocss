// A re-statement of abloh's buildContextDigest walk (context-identity.ts): every entry's path, kind,
// executable bit, size and bytes, sorted, in 1 MiB slices, nothing excluded. Timing instrument only.
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, readlinkSync, statSync, lstatSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2] ?? ".";
const hash = createHash("sha256");
const buffer = Buffer.allocUnsafe(1 << 20);
let files = 0, bytes = 0, links = 0, dirs = 0;
function walk(relative) {
  const abs = relative === "" ? root : join(root, relative);
  const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const path = relative === "" ? e.name : `${relative}/${e.name}`;
    const full = join(root, path);
    if (e.isSymbolicLink()) { links++; hash.update(`L ${path} ${readlinkSync(full)}\n`); continue; }
    if (e.isDirectory()) { dirs++; hash.update(`D ${path}\n`); walk(path); continue; }
    if (!e.isFile()) continue;
    const st = statSync(full); files++; bytes += st.size;
    hash.update(`F ${path} ${(st.mode & 0o111) !== 0 ? "x" : "-"} ${st.size}\n`);
    const fd = openSync(full, "r");
    try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(n === buffer.length ? buffer : buffer.subarray(0, n)); } finally { closeSync(fd); }
  }
}
const t0 = performance.now();
walk("");
const ms = Math.round(performance.now() - t0);
console.log(`DIGEST ${hash.digest("hex").slice(0, 16)} files=${files} dirs=${dirs} symlinks=${links} bytes=${bytes} ms=${ms} MBps=${(bytes / 1048576 / (ms / 1000)).toFixed(1)}`);
