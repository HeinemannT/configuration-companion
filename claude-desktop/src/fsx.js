/**
 * Small atomic file steps that every copy of the server uses on the shared folder. No step leaves a half-written
 * file under its real name: content is written to a temporary name first and moved into place in one rename,
 * or linked into place only when no file of that name exists.
 */
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
/** Block this thread for a few milliseconds. Used only for very short retries. */
export const sleepSync = (ms) => { Atomics.wait(sleepCell, 0, 0, ms); };

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const tmpName = (path) => `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Replace a file in one step. Windows can refuse a rename for a moment while another process reads the target. */
export function replaceFile(path, data) {
  const tmp = tmpName(path);
  writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); return; }
    catch (e) {
      if (!BUSY.has(e?.code) || i >= 20) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
      sleepSync(10);
    }
  }
}
export const writeJson = (path, obj) => replaceFile(path, JSON.stringify(obj));

/** Create a file with its whole content only when no file of that name exists. True when this call created it. */
export function createOnce(path, obj) {
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const tmp = tmpName(path);
  writeFileSync(tmp, data);
  try { linkSync(tmp, path); return true; }
  catch (e) {
    if (e?.code === 'EEXIST') return false;
    // A file system without hard links: exclusive create. A reader may meet it half written and reads again.
    try { writeFileSync(path, data, { flag: 'wx' }); return true; }
    catch (e2) { if (e2?.code === 'EEXIST') return false; throw e2; }
  } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}

/** Move a file out of the way and delete it, so no reader ever meets half of it. True when this call removed it. */
export function retire(path) {
  const gone = tmpName(path);
  try { renameSync(path, gone); } catch { return false; }
  try { unlinkSync(gone); } catch { /* gone */ }
  return true;
}

/** A lock older than this belongs to a copy that died while it held it. State changes hold it for milliseconds. */
export const LOCK_STALE_MS = 5_000;

/**
 * Run `fn` while holding the lock file `path`. Waits up to `waitMs` for another holder, breaks a lock older than
 * LOCK_STALE_MS (by its age on either side of the clock, so a clock set back does not keep it forever).
 * Throws { code: 'LOCKED' } when it cannot get the lock in time.
 */
export function withLock(path, fn, { waitMs = 3_000, now = Date.now } = {}) {
  const mine = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const start = now();
  for (let i = 0; ; i++) {
    if (createOnce(path, mine)) break;
    try {
      // A holder whose process has ended (killed while it held the lock) is passed over at once.
      const seen = readFileSync(path, 'utf8');
      const holder = Number(/^(\d+)-/.exec(seen)?.[1]);
      const age = Math.abs(now() - statSync(path).mtimeMs);
      if (age > LOCK_STALE_MS || (holder && !pidAlive(holder))) { breakLock(path, seen); continue; }
    } catch { continue; /* released meanwhile */ }
    if (Math.abs(now() - start) > waitMs) { const e = new Error('The session folder is busy.'); e.code = 'LOCKED'; throw e; }
    sleepSync(i < 20 ? 2 : 10);
  }
  try { return fn(); }
  finally {
    try { if (readFileSync(path, 'utf8') === mine) retire(path); } catch { /* broken by another copy */ }
  }
}

/**
 * Remove a lock judged dead from its content `seen`. Another copy may have broken it and taken a new one meanwhile:
 * then the moved file holds other content, and it is put back.
 */
function breakLock(path, seen) {
  const moved = tmpName(path);
  try { renameSync(path, moved); } catch { return; }
  let now = null;
  try { now = readFileSync(moved, 'utf8'); } catch { /* gone */ }
  if (now !== null && now !== seen) { try { linkSync(moved, path); } catch { /* a newer lock is there already */ } }
  try { unlinkSync(moved); } catch { /* gone */ }
}

/** True when a process with this id runs on this computer. Another user's process counts as running. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); } catch (e) { return e?.code === 'EPERM'; }
  // On Linux a killed process stays in the table as a zombie until its parent collects it: that one is gone.
  if (process.platform === 'linux') {
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false; } catch { /* no /proc: the signal's word stands */ }
  }
  return true;
}
