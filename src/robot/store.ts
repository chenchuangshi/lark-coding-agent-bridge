import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { PendingRobotWrite, RobotBindingState } from './types';

const PENDING_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, RobotStore>();

export class RobotStore {
  private data: RobotBindingState = { activeByScope: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, PendingRobotWrite>();
  private readonly path: string;
  private loaded = false;

  constructor(path: string) {
    this.path = path;
  }

  static forProfile(profile: string): RobotStore {
    const root = process.env.LARK_CHANNEL_HOME;
    const appPaths = resolveAppPaths({
      profile,
      ...(root ? { rootDir: root } : {}),
    });
    const file = join(appPaths.profileDir, 'robot-bindings.json');
    let store = cache.get(file);
    if (!store) {
      store = new RobotStore(file);
      cache.set(file, store);
    }
    return store;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<RobotBindingState>;
      this.data = { activeByScope: parsed.activeByScope ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.loaded = true;
  }

  activeKey(scope: string): string | undefined {
    return this.data.activeByScope[scope];
  }

  setActive(scope: string, key: string): void {
    if (!key) {
      delete this.data.activeByScope[scope];
    } else {
      this.data.activeByScope[scope] = key;
    }
    this.schedulePersist();
  }

  clearActive(scope: string): void {
    delete this.data.activeByScope[scope];
    this.schedulePersist();
  }

  createPending(input: Omit<PendingRobotWrite, 'id' | 'createdAt' | 'expiresAt'>): PendingRobotWrite {
    this.prune();
    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    const entry: PendingRobotWrite = {
      ...input,
      id,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
    };
    this.pending.set(id, entry);
    return entry;
  }

  takePending(id: string, scope: string, requesterId: string): PendingRobotWrite | undefined {
    this.prune();
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    if (entry.scope !== scope || entry.requesterId !== requesterId) return undefined;
    this.pending.delete(id);
    return entry;
  }

  dropPending(id: string, scope: string, requesterId: string): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.scope !== scope || entry.requesterId !== requesterId) return false;
    this.pending.delete(id);
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, e] of this.pending) {
      if (e.expiresAt <= now) this.pending.delete(id);
    }
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => log.fail('robot', err, { step: 'persist' }));
  }
}
