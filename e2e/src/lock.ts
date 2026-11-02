import fs from 'fs';
import os from 'os';
import path from 'path';
import { env } from './env';

/**
 * Cross-worker, cross-file mutex for demo-clinic state that several spec files write (e.g. the single
 * webhook secret). mkdir is atomic; the lock is keyed by API_URL, so every run against the same backend
 * shares it. A lock older than STALE_MS is left over from a crashed run and is taken over.
 */
const STALE_MS = 5 * 60_000;
const lockDir = (name: string) =>
  path.join(os.tmpdir(), `cm-e2e-lock-${env.API_URL.replace(/[^a-z0-9]+/gi, '_')}-${name}`);

export async function acquireLock(name: string, timeoutMs = 90_000): Promise<void> {
  const dir = lockDir(name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      return;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > deadline) throw new Error(`lock "${name}" still held after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export function releaseLock(name: string): void {
  fs.rmSync(lockDir(name), { recursive: true, force: true });
}
