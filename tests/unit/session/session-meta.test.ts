import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SESSION_TITLE_MAX_CHARS,
  SessionMetaStore,
  normalizeSessionTitle,
} from '../../../src/session/session-meta.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SessionMetaStore', () => {
  it('persists archive state and custom titles with private file permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-meta-'));
    roots.push(root);
    const path = join(root, 'session-meta.json');
    const identity = {
      agentId: 'codex' as const,
      cwdRealpath: '/workspace',
      threadId: 'thread-1',
    };
    const store = new SessionMetaStore(path);
    store.setArchived(identity, true, { preview: 'old preview', source: 'exec', updatedAt: 100 }, 200);
    store.setTitle(identity, '  示教器\n 网络  ', 300);
    await store.flush();

    const reloaded = new SessionMetaStore(path);
    await reloaded.load();
    expect(reloaded.get(identity)).toMatchObject({
      archived: true,
      archivedAt: 200,
      customTitle: '示教器 网络',
      previewSnapshot: 'old preview',
      sourceSnapshot: 'exec',
    });
    // Windows does not implement POSIX permission bits; the privacy guarantee
    // is meaningful and testable only on POSIX filesystems.
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1);
  });

  it('keeps metadata isolated by agent, real cwd, and session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-meta-'));
    roots.push(root);
    const store = new SessionMetaStore(join(root, 'session-meta.json'));
    store.setArchived({ agentId: 'claude', cwdRealpath: '/one', sessionId: 'same' }, true);
    store.setArchived({ agentId: 'claude', cwdRealpath: '/two', sessionId: 'same' }, true);
    store.setArchived({ agentId: 'codex', cwdRealpath: '/one', threadId: 'same' }, true);

    expect(store.listArchived('claude', '/one')).toHaveLength(1);
    expect(store.listArchived('claude', '/two')).toHaveLength(1);
    expect(store.listArchived('codex', '/one')).toHaveLength(1);
    await store.flush();
  });

  it('normalizes whitespace and limits titles by Unicode characters', () => {
    expect(normalizeSessionTitle('  alpha\n beta  ')).toBe('alpha beta');
    expect(Array.from(normalizeSessionTitle('会'.repeat(SESSION_TITLE_MAX_CHARS + 5)))).toHaveLength(
      SESSION_TITLE_MAX_CHARS,
    );
  });
});
