import { existsSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The UI container and the poller container talk through two small files in the data volume.
//   control.json  written by the UI (and reset by the poller at boot): should the poller run?
//   status.json   written by the poller: what it is doing right now
//   heartbeat     touched by the poller constantly, so the UI can tell it is alive

export interface CycleSummary {
  at: string;
  seen: number;
  processed: number;
  failed: number;
  dryRun: boolean;
  stopped?: boolean;
}

export interface Status {
  state: 'stopped' | 'idle' | 'scanning'; // idle = running, waiting for the next check
  progress: { done: number; total: number } | null;
  lastCycle: CycleSummary | null;
  lastError: string | null;
  updatedAt: string;
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Missing or unreadable means stopped. Postmaster never runs unless told to. */
export function readControl(dir: string): { running: boolean } {
  const c = readJson<{ running?: unknown }>(join(dir, 'control.json'));
  return { running: c?.running === true };
}

export function writeControl(dir: string, running: boolean): void {
  writeJson(join(dir, 'control.json'), { running });
}

export function readStatus(dir: string): Status | null {
  return readJson<Status>(join(dir, 'status.json'));
}

export function writeStatus(dir: string, status: Status): void {
  writeJson(join(dir, 'status.json'), status);
}

export function touchHeartbeat(dir: string): void {
  const path = join(dir, 'heartbeat');
  if (existsSync(path)) utimesSync(path, new Date(), new Date());
  else writeFileSync(path, '');
}

export function heartbeatAgeMs(dir: string, now: Date): number | null {
  try {
    return now.getTime() - statSync(join(dir, 'heartbeat')).mtime.getTime();
  } catch {
    return null;
  }
}
