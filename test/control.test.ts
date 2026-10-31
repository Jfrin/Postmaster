import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  heartbeatAgeMs,
  readControl,
  readStatus,
  touchHeartbeat,
  writeControl,
  writeStatus,
} from '../src/control.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pm-ctl-'));

describe('control files', () => {
  it('defaults to stopped when the file is missing or garbage', () => {
    const d = dir();
    expect(readControl(d).running).toBe(false);
    writeFileSync(join(d, 'control.json'), 'not json');
    expect(readControl(d).running).toBe(false);
    writeFileSync(join(d, 'control.json'), '{"running":"yes"}');
    expect(readControl(d).running).toBe(false);
  });

  it('round-trips the running flag and the status', () => {
    const d = dir();
    writeControl(d, true);
    expect(readControl(d).running).toBe(true);
    expect(readStatus(d)).toBeNull();
    const s = {
      state: 'idle' as const,
      progress: null,
      lastCycle: null,
      lastError: null,
      updatedAt: 'x',
    };
    writeStatus(d, s);
    expect(readStatus(d)).toEqual(s);
  });

  it('measures heartbeat age', () => {
    const d = dir();
    const now = new Date();
    expect(heartbeatAgeMs(d, now)).toBeNull();
    touchHeartbeat(d);
    touchHeartbeat(d); // second call updates the existing file
    expect(heartbeatAgeMs(d, new Date())).toBeLessThan(2000);
    const old = new Date(Date.now() - 600_000);
    utimesSync(join(d, 'heartbeat'), old, old);
    expect(heartbeatAgeMs(d, new Date())).toBeGreaterThan(500_000);
  });
});
