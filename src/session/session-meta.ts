import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

export type SessionMetaAgentId = 'claude' | 'codex';

export interface SessionMetaIdentity {
  agentId: SessionMetaAgentId;
  cwdRealpath: string;
  sessionId?: string;
  threadId?: string;
}

export interface SessionMetaSnapshot {
  preview?: string;
  source?: string;
  updatedAt?: number;
  lineCount?: number;
}

export interface SessionMetaEntry extends SessionMetaIdentity {
  key: string;
  archived: boolean;
  archivedAt?: number;
  customTitle?: string;
  titleUpdatedAt?: number;
  previewSnapshot?: string;
  sourceSnapshot?: string;
  updatedAtSnapshot?: number;
  lineCountSnapshot?: number;
  updatedAt: number;
}

const KEY_SEPARATOR = '\x1f';
export const SESSION_TITLE_MAX_CHARS = 80;

export function sessionMetaKey(input: SessionMetaIdentity): string {
  assertIdentity(input);
  return [
    input.agentId,
    input.cwdRealpath,
    input.agentId === 'codex' ? input.threadId : input.sessionId,
  ].join(KEY_SEPARATOR);
}

export class SessionMetaStore {
  private data = new Map<string, SessionMetaEntry>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      this.data.clear();
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        const entry = normalizeEntry(item);
        if (entry) this.data.set(entry.key, entry);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('session-meta', err, { step: 'load' });
      this.data.clear();
    }
  }

  get(identity: SessionMetaIdentity): SessionMetaEntry | undefined {
    const entry = this.data.get(sessionMetaKey(identity));
    return entry ? { ...entry } : undefined;
  }

  isArchived(identity: SessionMetaIdentity): boolean {
    return this.get(identity)?.archived === true;
  }

  listArchived(agentId: SessionMetaAgentId, cwdRealpath: string): SessionMetaEntry[] {
    return [...this.data.values()]
      .filter((entry) => entry.agentId === agentId && entry.cwdRealpath === cwdRealpath && entry.archived)
      .sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt))
      .map((entry) => ({ ...entry }));
  }

  setArchived(
    identity: SessionMetaIdentity,
    archived: boolean,
    snapshot: SessionMetaSnapshot = {},
    now = Date.now(),
  ): SessionMetaEntry {
    const key = sessionMetaKey(identity);
    const previous = this.data.get(key);
    const entry: SessionMetaEntry = {
      ...(previous ?? { ...identity, key, archived: false, updatedAt: now }),
      archived,
      updatedAt: now,
      ...(archived ? { archivedAt: now } : {}),
      ...(snapshot.preview ? { previewSnapshot: snapshot.preview } : {}),
      ...(snapshot.source ? { sourceSnapshot: snapshot.source } : {}),
      ...(snapshot.updatedAt !== undefined ? { updatedAtSnapshot: snapshot.updatedAt } : {}),
      ...(snapshot.lineCount !== undefined ? { lineCountSnapshot: snapshot.lineCount } : {}),
    };
    if (!archived) delete entry.archivedAt;
    this.data.set(key, entry);
    this.schedulePersist();
    return { ...entry };
  }

  setTitle(identity: SessionMetaIdentity, title: string, now = Date.now()): SessionMetaEntry {
    const normalized = normalizeSessionTitle(title);
    const key = sessionMetaKey(identity);
    const previous = this.data.get(key);
    const entry: SessionMetaEntry = {
      ...(previous ?? { ...identity, key, archived: false, updatedAt: now }),
      updatedAt: now,
    };
    if (normalized) {
      entry.customTitle = normalized;
      entry.titleUpdatedAt = now;
    } else {
      delete entry.customTitle;
      delete entry.titleUpdatedAt;
    }
    this.data.set(key, entry);
    this.schedulePersist();
    return { ...entry };
  }

  entries(): SessionMetaEntry[] {
    return [...this.data.values()].map((entry) => ({ ...entry }));
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(() => writeFileAtomic(this.path, `${JSON.stringify(this.entries(), null, 2)}\n`, { mode: 0o600 }))
      .catch((err: unknown) => log.fail('session-meta', err, { step: 'persist' }));
  }
}

export function normalizeSessionTitle(input: string): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  return Array.from(normalized).slice(0, SESSION_TITLE_MAX_CHARS).join('');
}

function normalizeEntry(input: unknown): SessionMetaEntry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<SessionMetaEntry>;
  if (
    typeof raw.key !== 'string' ||
    (raw.agentId !== 'claude' && raw.agentId !== 'codex') ||
    typeof raw.cwdRealpath !== 'string' ||
    typeof raw.archived !== 'boolean' ||
    typeof raw.updatedAt !== 'number'
  ) return undefined;
  const identity: SessionMetaIdentity = {
    agentId: raw.agentId,
    cwdRealpath: raw.cwdRealpath,
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
  };
  try {
    if (sessionMetaKey(identity) !== raw.key) return undefined;
  } catch {
    return undefined;
  }
  return {
    ...identity,
    key: raw.key,
    archived: raw.archived,
    updatedAt: raw.updatedAt,
    ...(typeof raw.archivedAt === 'number' ? { archivedAt: raw.archivedAt } : {}),
    ...(typeof raw.customTitle === 'string' ? { customTitle: normalizeSessionTitle(raw.customTitle) } : {}),
    ...(typeof raw.titleUpdatedAt === 'number' ? { titleUpdatedAt: raw.titleUpdatedAt } : {}),
    ...(typeof raw.previewSnapshot === 'string' ? { previewSnapshot: raw.previewSnapshot } : {}),
    ...(typeof raw.sourceSnapshot === 'string' ? { sourceSnapshot: raw.sourceSnapshot } : {}),
    ...(typeof raw.updatedAtSnapshot === 'number' ? { updatedAtSnapshot: raw.updatedAtSnapshot } : {}),
    ...(typeof raw.lineCountSnapshot === 'number' ? { lineCountSnapshot: raw.lineCountSnapshot } : {}),
  };
}

function assertIdentity(input: SessionMetaIdentity): void {
  if (!input.cwdRealpath) throw new Error('session metadata requires cwdRealpath');
  if (input.agentId === 'codex') {
    if (!input.threadId || input.sessionId) throw new Error('Codex metadata requires only threadId');
  } else if (!input.sessionId || input.threadId) {
    throw new Error('Claude metadata requires only sessionId');
  }
}
