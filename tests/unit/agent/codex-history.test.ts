import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexHistoryError,
  archiveCodexThread,
  forkCodexThread,
  listIndexedCodexThreadHistory,
  listCodexThreadHistory,
  readCodexThread,
  setCodexThreadName,
  unarchiveCodexThread,
} from '../../../src/session/codex-history.js';
import { buildAgentPrompt } from '../../../src/agent/prompt.js';

interface FakeCodex {
  dir: string;
  path: string;
  recordPath: string;
}

describe('Codex thread history provider', () => {
  const cleanup: string[] = [];
  const oldCodexHome = process.env.CODEX_HOME;

  afterEach(async () => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('lists cwd-filtered Codex threads through app-server without exposing sub-agent sources', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);

    const entries = await listCodexThreadHistory({
      binary: fake.path,
      cwd: '/repo',
      limit: 2,
      profileStateDir: fake.dir,
      timeoutMs: 5000,
    });

    expect(entries).toEqual([
      {
        threadId: 'thread-new',
        sessionId: 'session-new',
        preview: 'new thread prompt',
        cwd: '/repo',
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_050_000,
        source: 'exec',
        name: 'New work',
      },
      {
        threadId: 'thread-old',
        sessionId: 'session-old',
        preview: '(空会话)',
        cwd: '/repo',
        createdAtMs: 1_699_999_000_000,
        updatedAtMs: 1_699_999_500_000,
        source: 'cli',
        name: undefined,
      },
    ]);

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      argv: string[];
      env: Record<string, string | undefined>;
      requests: Array<{ method: string; params?: unknown }>;
    };
    expect(record.argv).toEqual(['app-server', '--listen', 'stdio://']);
    expect(record.env.CODEX_HOME).toBe('/outer/codex-home');
    expect(record.requests).toMatchObject([
      { method: 'initialize' },
      {
        method: 'thread/list',
        params: {
          cwd: '/repo',
          limit: 2,
          archived: false,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          useStateDbOnly: true,
          sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
        },
      },
    ]);
  });

  it('uses the profile-local Codex home when inheritance is disabled', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);

    await listCodexThreadHistory({
      binary: fake.path,
      cwd: '/repo',
      limit: 1,
      profileStateDir: fake.dir,
      inheritCodexHome: false,
      timeoutMs: 5000,
    });

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      env: Record<string, string | undefined>;
    };
    expect(record.env.CODEX_HOME).toBe(join(fake.dir, 'codex-home'));
  });

  it('recovers UI-indexed threads only after app-server validates cwd and source', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);
    await writeFile(join(fake.dir, 'session_index.jsonl'), [
      JSON.stringify({
        id: 'thread-new',
        thread_name: 'Respond to greeting',
        updated_at: '2023-11-14T22:14:10.000Z',
      }),
      '{malformed',
    ].join('\n'), 'utf8');

    const entries = await listIndexedCodexThreadHistory({
      binary: fake.path,
      codexHome: fake.dir,
      cwd: '/repo',
      limit: 5,
      profileStateDir: fake.dir,
      sourceKinds: ['vscode', 'appServer'],
      timeoutMs: 5000,
    });

    expect(entries).toEqual([{
      threadId: 'thread-new',
      preview: 'first question [图片] [技能: inspect]',
      cwd: '/repo',
      createdAtMs: 1_700_000_050_000,
      updatedAtMs: 1_700_000_050_000,
      source: 'vscode',
      name: 'Respond to greeting',
    }]);
  });

  it('throws a typed error when app-server rejects the history request', async () => {
    const fake = await createFakeCodex({ failList: true });
    cleanup.push(fake.dir);

    await expect(
      listCodexThreadHistory({
        binary: fake.path,
        cwd: '/repo',
        limit: 1,
        profileStateDir: fake.dir,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({
      name: 'CodexHistoryError',
      code: 'app-server-error',
    } satisfies Partial<CodexHistoryError>);
  });

  it('summarizes bridge-prefixed Codex previews using the real user input section', async () => {
    const fake = await createFakeCodex({
      firstPreview: `# lark-channel-bridge 运行约定\n\n## user_message\n\n${buildAgentPrompt({
        context: {
          chatId: 'oc_secret',
          chatType: 'p2p',
          senderId: 'ou_secret',
          source: 'im',
        },
        instructions: ['internal bridge instruction'],
        userInput: 'Codex 真实用户问题\n\n第二行',
      })}`,
    });
    cleanup.push(fake.dir);

    const entries = await listCodexThreadHistory({
      binary: fake.path,
      cwd: '/repo',
      limit: 1,
      profileStateDir: fake.dir,
      timeoutMs: 5000,
    });

    expect(entries[0]?.preview).toBe('Codex 真实用户问题 第二行');
  });
  it('lists archived threads when archived=true', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);

    await listCodexThreadHistory({
      binary: fake.path,
      cwd: '/repo',
      limit: 3,
      profileStateDir: fake.dir,
      archived: true,
      timeoutMs: 5000,
    });

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      requests: Array<{ method: string; params?: { archived?: boolean } }>;
    };
    expect(record.requests[1]).toMatchObject({
      method: 'thread/list',
      params: { archived: true },
    });
  });

  it('forwards explicit Feishu resume sourceKinds (exec only)', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);

    await listCodexThreadHistory({
      binary: fake.path,
      cwd: '/repo',
      limit: 5,
      profileStateDir: fake.dir,
      sourceKinds: ['exec'],
      timeoutMs: 5000,
    });

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      requests: Array<{ method: string; params?: { sourceKinds?: string[] } }>;
    };
    expect(record.requests[1]).toMatchObject({
      method: 'thread/list',
      params: { sourceKinds: ['exec'] },
    });
  });

  it('reads persisted turns while exposing only user and assistant messages', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);

    const thread = await readCodexThread({
      binary: fake.path,
      profileStateDir: fake.dir,
      timeoutMs: 5000,
    }, 'thread-new');

    expect(thread).toEqual({
      threadId: 'thread-new',
      cwd: '/repo',
      source: 'vscode',
      updatedAtMs: 1_700_000_050_000,
      status: 'notLoaded',
      turns: [
        {
          turnId: 'turn-1',
          status: 'completed',
          messages: [
            { role: 'user', text: 'first question\n[图片]\n[技能: inspect]' },
            { role: 'assistant', text: 'first answer' },
          ],
        },
        {
          turnId: 'turn-2',
          status: 'inProgress',
          messages: [{ role: 'user', text: 'unfinished question' }],
        },
      ],
    });
    expect(JSON.stringify(thread)).not.toContain('/private/');

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      requests: Array<{ method: string; params?: unknown }>;
    };
    expect(record.requests[1]).toEqual({
      method: 'thread/read',
      params: { threadId: 'thread-new', includeTurns: true },
    });
  });

  it('forks through the last requested completed turn and parses provenance', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);

    const fork = await forkCodexThread({
      binary: fake.path,
      profileStateDir: fake.dir,
      timeoutMs: 5000,
    }, 'thread-new', 'turn-1');

    expect(fork.threadId).toBe('thread-fork');
    expect(fork.forkedFromId).toBe('thread-new');
    expect(fork.turns.map((turn) => turn.turnId)).toEqual(['turn-1']);
    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      requests: Array<{ method: string; params?: unknown }>;
    };
    expect(record.requests[1]).toEqual({
      method: 'thread/fork',
      params: { threadId: 'thread-new', lastTurnId: 'turn-1' },
    });
  });

  it('rejects malformed thread/read responses with a typed error', async () => {
    const fake = await createFakeCodex({ malformedRead: true });
    cleanup.push(fake.dir);

    await expect(readCodexThread({
      binary: fake.path,
      profileStateDir: fake.dir,
      timeoutMs: 5000,
    }, 'thread-new')).rejects.toMatchObject({
      name: 'CodexHistoryError',
      code: 'malformed-response',
    } satisfies Partial<CodexHistoryError>);
  });

  it('archives, unarchives, and renames threads through app-server', async () => {
    const archiveFake = await createFakeCodex();
    const unarchiveFake = await createFakeCodex();
    const renameFake = await createFakeCodex();
    cleanup.push(archiveFake.dir, unarchiveFake.dir, renameFake.dir);

    await archiveCodexThread({
      binary: archiveFake.path,
      profileStateDir: archiveFake.dir,
      timeoutMs: 5000,
    }, 'thread-new');
    await unarchiveCodexThread({
      binary: unarchiveFake.path,
      profileStateDir: unarchiveFake.dir,
      timeoutMs: 5000,
    }, 'thread-new');
    await setCodexThreadName({
      binary: renameFake.path,
      profileStateDir: renameFake.dir,
      timeoutMs: 5000,
    }, 'thread-new', 'Renamed');

    const archiveRecord = JSON.parse(await readFile(archiveFake.recordPath, 'utf8')) as {
      requests: Array<{ method: string; params?: unknown }>;
    };
    const unarchiveRecord = JSON.parse(await readFile(unarchiveFake.recordPath, 'utf8')) as {
      requests: Array<{ method: string; params?: unknown }>;
    };
    const renameRecord = JSON.parse(await readFile(renameFake.recordPath, 'utf8')) as {
      requests: Array<{ method: string; params?: unknown }>;
    };
    expect(archiveRecord.requests.map((r) => r.method)).toEqual(['initialize', 'thread/archive']);
    expect(archiveRecord.requests[1]?.params).toEqual({ threadId: 'thread-new' });
    expect(unarchiveRecord.requests.map((r) => r.method)).toEqual(['initialize', 'thread/unarchive']);
    expect(unarchiveRecord.requests[1]?.params).toEqual({ threadId: 'thread-new' });
    expect(renameRecord.requests.map((r) => r.method)).toEqual(['initialize', 'thread/name/set']);
    expect(renameRecord.requests[1]?.params).toEqual({ threadId: 'thread-new', name: 'Renamed' });
  });
});

async function createFakeCodex(options: {
  failList?: boolean;
  firstPreview?: string;
  malformedRead?: boolean;
} = {}): Promise<FakeCodex> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-history-test-'));
  const scriptPath = process.platform === 'win32' ? join(dir, 'codex-app-server.mjs') : join(dir, 'codex');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const recordPath = join(dir, 'record.json');
  const firstPreview = options.firstPreview ?? 'new thread prompt';
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const requests = [];
const recordPath = ${JSON.stringify(recordPath)};
const failList = ${JSON.stringify(options.failList === true)};
const malformedRead = ${JSON.stringify(options.malformedRead === true)};
let stdinEnded = false;
let persisted = false;

function persist() {
  if (persisted) return;
  persisted = true;
  writeFileSync(recordPath, JSON.stringify({
    argv: process.argv.slice(2),
    env: { CODEX_HOME: process.env.CODEX_HOME },
    requests
  }, null, 2));
}

function ok(id, result = {}) {
  process.stdout.write(JSON.stringify({ id, result }) + '\\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdin.on('end', () => {
  stdinEnded = true;
});
process.on('SIGTERM', () => {
  persist();
  process.exit(0);
});
process.on('exit', persist);

rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  requests.push({ method: req.method, params: req.params });
  if (req.method === 'initialize') {
    ok(req.id, {
      userAgent: 'fake-codex',
      codexHome: process.env.CODEX_HOME ?? '',
      platformFamily: 'unix',
      platformOs: 'macos'
    });
  } else if (req.method === 'thread/archive' || req.method === 'thread/name/set') {
    setTimeout(() => {
      persist();
      ok(req.id, {});
      if (stdinEnded) process.exit(0);
    }, 10);
  } else if (req.method === 'thread/unarchive') {
    setTimeout(() => {
      persist();
      ok(req.id, {
        id: req.params?.threadId ?? 'thread',
        cwd: '/repo',
        preview: 'restored',
        createdAt: 1700000000,
        updatedAt: 1700000050,
        source: 'exec'
      });
      if (stdinEnded) process.exit(0);
    }, 10);
  } else if (req.method === 'thread/read' || req.method === 'thread/fork') {
    setTimeout(() => {
      persist();
      if (malformedRead && req.method === 'thread/read') {
        ok(req.id, { thread: { id: 'thread-new' } });
      } else {
        const isFork = req.method === 'thread/fork';
        ok(req.id, {
          thread: {
            id: isFork ? 'thread-fork' : 'thread-new',
            cwd: '/repo',
            source: 'vscode',
            updatedAt: 1700000050,
            status: { type: 'notLoaded' },
            forkedFromId: isFork ? 'thread-new' : null,
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  { id: 'user-1', type: 'userMessage', content: [
                    { type: 'text', text: 'first question' },
                    { type: 'localImage', path: '/private/image.png' },
                    { type: 'skill', name: 'inspect', path: '/private/skill' }
                  ] },
                  { id: 'reason-1', type: 'reasoning', summary: ['private'] },
                  { id: 'tool-1', type: 'commandExecution', command: 'secret' },
                  { id: 'agent-1', type: 'agentMessage', text: 'first answer' },
                  { id: 'future-1', type: 'futureItem', text: 'must stay hidden' }
                ]
              },
              ...(!isFork ? [{
                id: 'turn-2',
                status: { type: 'inProgress' },
                items: [{ id: 'user-2', type: 'userMessage', content: 'unfinished question' }]
              }] : [])
            ]
          }
        });
      }
      if (stdinEnded) process.exit(0);
    }, 10);
  } else if (req.method === 'thread/list') {
    setTimeout(() => {
      if (stdinEnded) {
        persist();
        process.exit(0);
      }
      persist();
      if (failList) {
        process.stdout.write(JSON.stringify({
          id: req.id,
          error: { code: -32000, message: 'history unavailable' }
        }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({
          id: req.id,
          result: {
            data: [
              {
                id: 'thread-new',
                sessionId: 'session-new',
                preview: ${JSON.stringify(firstPreview)},
                ephemeral: false,
                modelProvider: 'openai',
                createdAt: 1700000000,
                updatedAt: 1700000050,
                status: { type: 'notLoaded' },
                path: '/tmp/thread-new.jsonl',
                cwd: '/repo',
                cliVersion: '0.130.0',
                source: 'exec',
                threadSource: null,
                forkedFromId: null,
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: 'New work',
                turns: []
              },
              {
                id: 'thread-old',
                sessionId: 'session-old',
                preview: '',
                ephemeral: false,
                modelProvider: 'openai',
                createdAt: 1699999000,
                updatedAt: 1699999500,
                status: { type: 'notLoaded' },
                path: '/tmp/thread-old.jsonl',
                cwd: '/repo',
                cliVersion: '0.130.0',
                source: 'cli',
                threadSource: null,
                forkedFromId: null,
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: []
              }
            ],
            nextCursor: null,
            backwardsCursor: null
          }
        }) + '\\n');
      }
    }, 25);
  }
});
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path, recordPath };
}
