/** Private atomic receipts prevent replay after lost HTTP responses or daemon restart. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secureDirectory } from './node-client.js';
import { nodeHash, nodeSecret } from './node-protocol.js';
import type { NodeResult } from './node-executors.js';
export interface AttemptRecord { job_id: string; attempt_id: string; phase: 'started' | 'finished' | 'uncertain'; outcome?: NodeResult; pid?: number; process_start?: string }
export function processStart(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return undefined; }
}
export class AttemptJournal {
  constructor(private dir: string) { secureDirectory(dir); }
  private path(job: string, attempt: string) { return join(this.dir, nodeHash(job + ':' + attempt) + '.json'); }
  read(job: string, attempt: string): AttemptRecord | undefined {
    const path = this.path(job, attempt);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  }
  write(record: AttemptRecord) {
    const path = this.path(record.job_id, record.attempt_id);
    const temp = path + '.' + nodeSecret();
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const directory = openSync(this.dir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  reconcile() {
    for (const name of readdirSync(this.dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const record = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as AttemptRecord;
      if (record.phase !== 'started') continue;
      // Linux identity check avoids signalling a PID recycled after a reboot.
      if (record.pid && record.process_start && processStart(record.pid) === record.process_start) {
        try { process.kill(-record.pid, 'SIGKILL'); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
      }
      this.write({ ...record, phase: 'uncertain' });
    }
  }
}
