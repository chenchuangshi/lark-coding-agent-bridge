import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { canUseDm } from '../../../src/policy/access.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionMetaStore } from '../../../src/session/session-meta.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import type {
  CodexThreadDetails,
  CodexThreadHistoryEntry,
  ListCodexThreadHistoryOptions,
} from '../../../src/session/codex-history.js';
import type { SessionSummary } from '../../../src/session/history.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  sessionMeta: SessionMetaStore;
  controls: Controls;
  identity: SessionCatalogIdentity;
  claudeHistory: SessionSummary[];
  codexHistory: CodexThreadHistoryEntry[];
  codexDetails: Map<string, CodexThreadDetails>;
  forkCalls: Array<{ threadId: string; lastTurnId: string }>;
  invalidForkSources: Set<string>;
  lastCodexHistoryOptions?: ListCodexThreadHistoryOptions;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  archiveThread(threadId: string): Promise<void>;
  run(content: string, options?: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' }): Promise<boolean>;
  dispatchResumeArg(arg: string): Promise<void>;
  dispatchCard(value: Record<string, unknown>, formValue?: Record<string, unknown>): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware resume commands', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('archives only the current catalog entry when starting a new conversation', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      agentId: 'codex',
      threadId: 'thread-other-agent',
      now: 1000,
    });

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.catalog.activeFor({ ...h.identity, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-other-agent',
    });
  });

  it('allows resume use only for the current agent/cwd/policy catalog entry', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      policyFingerprint: 'stale-fp',
      sessionId: 'sess-stale',
      now: 1000,
    });

    await expect(h.run('/resume use sess-stale')).resolves.toBe(true);
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');

    await expect(h.run('/resume use sess-current')).resolves.toBe(true);
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes the selected Claude history entry from the card button callback', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'sess-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.claudeHistory.push(
      claudeSession('sess-current', 'current prompt', 1_700_000_100_000),
      claudeSession('sess-target', 'target prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('current prompt');
    expect(rendered).toContain('target prompt');
    expect(rendered).toContain('sess-tar');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).not.toBe('sess-target');
    await h.dispatchResumeArg(nonces[1]!);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-target');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      sessionId: 'sess-target',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('accepts the current Codex thread without writing it into legacy SessionStore', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('falls back to an audit-safe reply when resume confirmation is rejected', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    const originalSend = h.channel.send.bind(h.channel);
    let attempts = 0;
    h.channel.send = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('The messages do NOT pass the audit.') as Error & { code: number };
        err.code = 230028;
        throw err;
      }
      return originalSend(...args);
    };

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(attempts).toBe(2);
    expect(lastMarkdown(h.channel)).toBe('命令已处理。');
  });

  it('shows only the current catalog-backed Codex thread in /resume', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('当前 Codex 会话');
    expect(resumeArgsFromCard(lastContent(h.channel))).toHaveLength(1);
    expect(rendered).not.toContain('thread-current');
  });

  it('does not accept raw Codex thread ids as resume candidates', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume use thread-current')).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('请先用 `/resume`');
  });

  it('does not fall back to legacy SessionStore when Codex catalog identity is missing', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume use thread-current', { withCatalogIdentity: false })).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('当前上下文没有可恢复的 Codex thread');
  });

  it('does not list Claude local history for Codex when no current thread is recorded', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastContentString(h.channel)).toContain('此 cwd 下没有历史会话');
  });

  it('lists Codex history for the current cwd and resumes the selected thread through a nonce', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(
      codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000),
      codexThread('thread-beta-secret', 'beta prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('alpha prompt');
    expect(rendered).toContain('beta prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
    expect(rendered).not.toContain('thread-beta-secret');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    await expect(h.run(`/resume use ${nonces[1]}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: 'thread-beta-secret',
    });
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes a Codex history selection from the card button callback', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    expect(nonce).toBeTypeOf('string');
    await h.dispatchResumeArg(nonce!);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: 'thread-alpha-secret',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('archives, lists, renames, and unarchives a Codex history entry without exposing its id', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-archive-secret', 'automatic title', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);
    const [archiveNonce] = actionArgsFromCard(lastContent(h.channel), 'resume.archive');
    expect(archiveNonce).toBeTypeOf('string');
    await expect(h.run(`/resume archive ${archiveNonce}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已写入 Codex 本地状态');

    await expect(h.run('/resume')).resolves.toBe(true);
    expect(lastContentString(h.channel)).not.toContain('automatic title');

    await expect(h.run('/resume archived')).resolves.toBe(true);
    const archivedCard = lastContent(h.channel);
    expect(JSON.stringify(archivedCard)).toContain('automatic title');
    expect(JSON.stringify(archivedCard)).not.toContain('thread-archive-secret');
    const [renameNonce] = actionArgsFromCard(archivedCard, 'resume.rename');
    const [unarchiveNonce] = actionArgsFromCard(archivedCard, 'resume.unarchive');

    await expect(h.run(`/resume rename ${renameNonce} 示教器网络`)).resolves.toBe(true);
    await expect(h.run('/resume archived')).resolves.toBe(true);
    expect(lastContentString(h.channel)).toContain('示教器网络');

    await expect(h.run(`/resume unarchive ${unarchiveNonce}`)).resolves.toBe(true);
    await expect(h.run('/resume')).resolves.toBe(true);
    expect(lastContentString(h.channel)).toContain('示教器网络');
  });

  it('lists only exec-sourced Codex threads for active and archived resume (History Isolation)', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(
      codexThread('thread-feishu-exec', 'feishu work', 1_700_000_200_000, 'exec'),
      codexThread('thread-desktop-vscode', 'desktop work', 1_700_000_100_000, 'vscode'),
      codexThread('thread-cli', 'cli work', 1_700_000_050_000, 'cli'),
    );

    await expect(h.run('/resume')).resolves.toBe(true);
    const active = lastContentString(h.channel);
    expect(active).toContain('feishu work');
    expect(active).not.toContain('desktop work');
    expect(active).not.toContain('cli work');
    expect(h.lastCodexHistoryOptions?.sourceKinds).toEqual(['exec']);
    expect(h.lastCodexHistoryOptions?.archived).toBeFalsy();

    const [archiveNonce] = actionArgsFromCard(lastContent(h.channel), 'resume.archive');
    await expect(h.run(`/resume archive ${archiveNonce}`)).resolves.toBe(true);

    h.codexHistory.push(
      codexThread('thread-archived-vscode', 'archived desktop', 1_700_000_010_000, 'vscode'),
    );
    // Mark the vscode thread as archived in the fake store so archived=true would
    // return it unless sourceKinds filters it out.
    await h.archiveThread('thread-archived-vscode');

    await expect(h.run('/resume archived')).resolves.toBe(true);
    const archived = lastContentString(h.channel);
    expect(archived).toContain('feishu work');
    expect(archived).not.toContain('archived desktop');
    expect(archived).not.toContain('desktop work');
    expect(h.lastCodexHistoryOptions?.sourceKinds).toEqual(['exec']);
    expect(h.lastCodexHistoryOptions?.archived).toBe(true);
  });

  it('renames a Codex session through the card form without requiring a text command', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-rename-secret', 'automatic title', 1_700_000_100_000));

    await h.run('/resume');
    const [renameNonce] = actionArgsFromCard(lastContent(h.channel), 'resume.rename');
    await h.dispatchCard({ cmd: 'resume.rename', arg: renameNonce });

    const form = lastContentString(h.channel);
    expect(form).toContain('resume_rename_form');
    expect(form).toContain('session_title');

    await h.dispatchCard(
      { cmd: 'resume.rename', arg: renameNonce },
      { session_title: '修复会话历史' },
    );
    expect(lastMarkdown(h.channel)).toContain('会话已命名为「修复会话历史」');

    await h.run('/resume');
    expect(lastContentString(h.channel)).toContain('修复会话历史');
  });

  it('offers new, archived, and external actions in one resume-list action row', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-current', 'current title', 1_700_000_100_000));

    await h.run('/resume');

    expect(actionCommandRows(lastContent(h.channel))).toContainEqual([
      'new',
      'resume.archived',
      'resume.external',
    ]);
  });

  it('clears the active binding when the current Codex thread is archived', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    h.codexHistory.push(codexThread('thread-current', 'current title', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = actionArgsFromCard(lastContent(h.channel), 'resume.archive');
    await expect(h.run(`/resume archive ${nonce}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('下一条普通消息会开始新会话');
    expect(lastMarkdown(h.channel)).toContain('已写入 Codex 本地状态');
  });

  it('keeps Codex resume history details out of group chats like Claude', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('私聊');
    expect(rendered).not.toContain('alpha prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
  });

  it('lists and reads only current-cwd Desktop and VS Code threads without exposing ids or internals', async () => {
    const h = await createHarness('codex');
    const external = {
      ...externalCodexThread(h.identity.cwdRealpath),
      threadId: 'desktop-secret-id',
      source: 'appServer',
    };
    h.codexHistory.push(
      codexThreadForCwd('desktop-secret-id', 'desktop preview', external.updatedAtMs, 'appServer', h.identity.cwdRealpath),
      codexThreadForCwd('wrong-source-id', 'cli preview', external.updatedAtMs - 1, 'cli', h.identity.cwdRealpath),
      codexThreadForCwd('wrong-cwd-id', 'other cwd preview', external.updatedAtMs - 2, 'vscode', '/other/repo'),
    );
    h.codexDetails.set('desktop-secret-id', external);

    await expect(h.run('/resume')).resolves.toBe(true);
    expect(lastContentString(h.channel)).toContain('"cmd":"resume.external"');
    await h.dispatchCard({ cmd: 'resume.external' });
    const listCard = lastContent(h.channel);
    const rendered = JSON.stringify(listCard);
    expect(h.lastCodexHistoryOptions?.sourceKinds).toEqual(['vscode', 'appServer']);
    expect(h.lastCodexHistoryOptions?.cwd).toBe(h.identity.cwdRealpath);
    expect(rendered).toContain('desktop preview');
    expect(rendered).not.toContain('desktop-secret-id');
    expect(rendered).not.toContain('cli preview');
    expect(rendered).not.toContain('other cwd preview');

    const [readArg] = actionArgsFromCard(listCard, 'resume.external.read');
    expect(readArg).toMatch(/^.{12} 1$/);
    await expect(h.run(`/resume external read ${readArg}`)).resolves.toBe(true);
    const content = lastContentString(h.channel);
    expect(content).toContain('visible question');
    expect(content).toContain('visible answer');
    expect(content).not.toContain('private reasoning');
    expect(content).not.toContain('tool output');
    const [nextArg] = actionArgsFromCard(lastContent(h.channel), 'resume.external.read');
    expect(nextArg).toMatch(/^.{12} 2$/);
    await h.run(`/resume external read ${nextArg}`);
    expect(lastContentString(h.channel)).toContain('page-two-content');
    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
  });

  it('forks the last completed turn, verifies it, binds only the fork, and keeps it in normal resume', async () => {
    const h = await createHarness('codex');
    const source = externalCodexThread(h.identity.cwdRealpath);
    h.codexHistory.push(codexThreadForCwd(
      source.threadId,
      'desktop preview',
      source.updatedAtMs,
      'vscode',
      h.identity.cwdRealpath,
    ));
    h.codexDetails.set(source.threadId, source);

    await h.run('/resume external');
    const [forkNonce] = actionArgsFromCard(lastContent(h.channel), 'resume.external.fork');
    await expect(h.run(`/resume external fork ${forkNonce}`)).resolves.toBe(true);

    expect(h.forkCalls).toEqual([{ threadId: source.threadId, lastTurnId: 'turn-completed' }]);
    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: `fork-${source.threadId}`,
      lastSummary: 'desktop preview',
    });
    expect(h.catalog.activeFor(h.identity)?.threadId).not.toBe(source.threadId);
    expect(h.sessionMeta.get({
      agentId: 'codex',
      cwdRealpath: h.identity.cwdRealpath,
      threadId: `fork-${source.threadId}`,
    })).toMatchObject({
      bridgeOwned: true,
      forkedFromThreadId: source.threadId,
    });
    expect(lastMarkdown(h.channel)).toContain('已复制并切换');

    await h.run('/resume');
    const normalResume = lastContentString(h.channel);
    expect(normalResume).toContain('desktop preview');
    expect(normalResume).not.toContain(source.threadId);
    expect(normalResume).toContain('bridge-fork');

    h.codexHistory.push(codexThreadForCwd(
      `fork-${source.threadId}`,
      'must not return to external list',
      source.updatedAtMs + 1,
      'vscode',
      h.identity.cwdRealpath,
    ));
    await h.run('/resume external');
    expect(lastContentString(h.channel)).not.toContain('must not return to external list');
  });

  it('does not fork a stale source or overwrite the current binding when verification fails', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'current-thread', now: 1000 });
    const source = externalCodexThread(h.identity.cwdRealpath);
    h.codexHistory.push(codexThreadForCwd(
      source.threadId,
      'desktop preview',
      source.updatedAtMs,
      'vscode',
      h.identity.cwdRealpath,
    ));
    h.codexDetails.set(source.threadId, source);

    await h.run('/resume external');
    let [forkNonce] = actionArgsFromCard(lastContent(h.channel), 'resume.external.fork');
    h.codexDetails.set(source.threadId, { ...source, updatedAtMs: source.updatedAtMs + 1000 });
    await h.run(`/resume external fork ${forkNonce}`);
    expect(h.forkCalls).toHaveLength(0);
    expect(h.catalog.activeFor(h.identity)?.threadId).toBe('current-thread');
    expect(lastMarkdown(h.channel)).toContain('源会话已发生变化');

    const refreshed = { ...source, updatedAtMs: source.updatedAtMs + 1000 };
    h.codexHistory[0] = codexThreadForCwd(
      source.threadId,
      'desktop preview',
      refreshed.updatedAtMs,
      'vscode',
      h.identity.cwdRealpath,
    );
    h.codexDetails.set(source.threadId, refreshed);
    h.invalidForkSources.add(source.threadId);
    await h.run('/resume external');
    [forkNonce] = actionArgsFromCard(lastContent(h.channel), 'resume.external.fork');
    await h.run(`/resume external fork ${forkNonce}`);
    expect(h.catalog.activeFor(h.identity)?.threadId).toBe('current-thread');
    expect(lastMarkdown(h.channel)).toContain('当前会话保持不变');
  });

  it('refuses external history in groups and refuses fork while the scope is running', async () => {
    const h = await createHarness('codex');
    const source = externalCodexThread(h.identity.cwdRealpath);
    h.codexHistory.push(codexThreadForCwd(
      source.threadId,
      'desktop preview',
      source.updatedAtMs,
      'vscode',
      h.identity.cwdRealpath,
    ));
    h.codexDetails.set(source.threadId, source);

    await h.run('/resume external', { chatMode: 'group' });
    expect(lastMarkdown(h.channel)).toContain('私聊');

    await h.run('/resume external');
    const [forkNonce] = actionArgsFromCard(lastContent(h.channel), 'resume.external.fork');
    const run = { stop: async () => {}, waitForExit: async () => {} };
    h.activeRuns.register('chat-1', run as never);
    await h.run(`/resume external fork ${forkNonce}`);
    expect(h.forkCalls).toHaveLength(0);
    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('正在运行');
    h.activeRuns.unregister('chat-1', run as never);
  });

  it('labels Codex status as session while reading the recorded thread id', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/status')).resolves.toBe(true);
    let status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('未建立');
    expect(status).toContain('"content":"🔁 切换会话"');
    expect(status).toContain('"type":"primary","value":{"cmd":"resume"}');
    expect(status).not.toContain('"cmd":"new"');
    expect(status).not.toContain('**thread**');
    expect(status).not.toContain('**conversation**');

    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await expect(h.run('/status')).resolves.toBe(true);

    status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('thread-c');
    expect(status).not.toContain('未建立');
  });

  it('does not list local history from home when no workspace is bound', async () => {
    const h = await createHarness('claude', { bindWorkspace: false, defaultWorkspace: false });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');
  });
});

async function createHarness(
  agentKind: AgentKind,
  options: { bindWorkspace?: boolean; defaultWorkspace?: boolean } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile(`resume-command-${agentKind}-`);
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const sessionMeta = new SessionMetaStore(join(tmp.profile, 'session-meta.json'));
  const claudeHistory: SessionSummary[] = [];
  const codexHistory: CodexThreadHistoryEntry[] = [];
  const codexDetails = new Map<string, CodexThreadDetails>();
  const forkCalls: Array<{ threadId: string; lastTurnId: string }> = [];
  const invalidForkSources = new Set<string>();
  const archivedThreadIds = new Set<string>();
  const renamedTitles = new Map<string, string>();
  const harnessState: { lastCodexHistoryOptions?: ListCodexThreadHistoryOptions } = {};
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const agent = createFakeAgent();
  const profileConfig = appConfig(agentKind);
  if (options.defaultWorkspace !== false) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: agentKind,
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const identity = await commandIdentity(agentKind, profileConfig, controls, tmp.workspace);
  const chatModeCache = {
    resolve: async () => 'p2p',
  } as unknown as ChatModeCache;

  const listCodex = async (
    listOptions: ListCodexThreadHistoryOptions,
  ): Promise<CodexThreadHistoryEntry[]> => {
    harnessState.lastCodexHistoryOptions = listOptions;
    const kinds = new Set(listOptions.sourceKinds ?? ['cli', 'vscode', 'exec', 'appServer', 'unknown']);
    const wantArchived = listOptions.archived === true;
    return codexHistory
      .filter((thread) => kinds.has(thread.source))
      .filter((thread) => archivedThreadIds.has(thread.threadId) === wantArchived)
      .map((thread) => ({
        ...thread,
        name: renamedTitles.get(thread.threadId) ?? thread.name,
        preview: renamedTitles.get(thread.threadId) ?? thread.preview,
      }));
  };

  const archiveThread = async (threadId: string): Promise<void> => {
    archivedThreadIds.add(threadId);
  };

  const readThread = async (_ops: unknown, threadId: string): Promise<CodexThreadDetails> => {
    const details = codexDetails.get(threadId);
    if (!details) throw new Error(`missing fake thread: ${threadId}`);
    return structuredClone(details);
  };

  const forkThread = async (
    _ops: unknown,
    threadId: string,
    lastTurnId: string,
  ): Promise<CodexThreadDetails> => {
    forkCalls.push({ threadId, lastTurnId });
    const source = codexDetails.get(threadId);
    if (!source) throw new Error(`missing fake source thread: ${threadId}`);
    const lastIndex = source.turns.findIndex((turn) => turn.turnId === lastTurnId);
    if (lastIndex < 0) throw new Error(`missing fake turn: ${lastTurnId}`);
    const fork: CodexThreadDetails = {
      threadId: `fork-${threadId}`,
      cwd: source.cwd,
      source: 'appServer',
      updatedAtMs: source.updatedAtMs + 1,
      status: 'notLoaded',
      forkedFromId: source.threadId,
      turns: structuredClone(source.turns.slice(0, lastIndex + 1)),
    };
    if (invalidForkSources.has(threadId)) fork.forkedFromId = 'wrong-source';
    codexDetails.set(fork.threadId, fork);
    return structuredClone(fork);
  };

  const run = (
    content: string,
    runOptions: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      sessionCatalog: catalog,
      sessionMeta,
      sessionCatalogIdentity: runOptions.withCatalogIdentity === false ? undefined : identity,
      workspaces,
      agent,
      activeRuns,
      controls,
      claudeHistoryProvider: async () => claudeHistory,
      codexHistoryProvider: listCodex,
      codexArchiveThread: async (_ops, threadId) => {
        archivedThreadIds.add(threadId);
      },
      codexUnarchiveThread: async (_ops, threadId) => {
        archivedThreadIds.delete(threadId);
      },
      codexSetThreadName: async (_ops, threadId, name) => {
        renamedTitles.set(threadId, name);
      },
      codexReadThread: readThread,
      codexForkThread: forkThread,
    });

  const dispatchCard = (
    value: Record<string, unknown>,
    formValue?: Record<string, unknown>,
  ): Promise<void> => handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent(value, formValue),
      sessions,
      sessionCatalog: catalog,
      sessionMeta,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
      codexHistoryProvider: listCodex,
      codexArchiveThread: async (_ops, threadId) => {
        archivedThreadIds.add(threadId);
      },
      codexUnarchiveThread: async (_ops, threadId) => {
        archivedThreadIds.delete(threadId);
      },
      codexSetThreadName: async (_ops, threadId, name) => {
        renamedTitles.set(threadId, name);
      },
      codexReadThread: readThread,
      codexForkThread: forkThread,
    });

  const dispatchResumeArg = (arg: string): Promise<void> =>
    dispatchCard({ cmd: 'resume.use', arg });

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush(), sessionMeta.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    catalog,
    sessionMeta,
    controls,
    identity,
    claudeHistory,
    codexHistory,
    codexDetails,
    forkCalls,
    invalidForkSources,
    get lastCodexHistoryOptions() {
      return harnessState.lastCodexHistoryOptions;
    },
    activeRuns,
    pending,
    archiveThread,
    run,
    dispatchResumeArg,
    dispatchCard,
  };
}

function claudeSession(
  sessionId: string,
  preview: string,
  mtime: number,
): SessionSummary {
  return {
    sessionId,
    preview,
    mtime,
    lineCount: 1,
  };
}

async function commandIdentity(
  agentKind: AgentKind,
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const capability = agentKind === 'codex' ? codexCapability(profileConfig) : claudeCapability(profileConfig);
  const access = canUseDm(profileConfig, controls, 'ou-user');
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: 'chat-1',
      actorId: 'ou-user',
    },
    attachments: [],
    prompt: '',
    requestedCwd: cwd,
    cwdRealpath: workspace.cwdRealpath,
    access,
    capability,
    profileConfig,
    now: Date.now(),
    codexHome: profileConfig.codex?.codexHome,
    inheritCodexHome: profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return {
    scopeId: 'chat-1',
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function appConfig(agentKind: AgentKind): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'chat-1',
    messageId: 'om-card',
    operator: {
      openId: 'ou-user',
      name: 'User',
    },
    ...(formValue ? { raw: { action: { form_value: formValue } } } : {}),
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown as string;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastContentString(channel: FakeChannel): string {
  return JSON.stringify(lastContent(channel));
}

function resumeArgsFromCard(card: unknown): string[] {
  return actionArgsFromCard(card, 'resume.use');
}

function actionArgsFromCard(card: unknown, cmd: string): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const action = record.value as Record<string, unknown> | undefined;
    if (action?.cmd === cmd && typeof action.arg === 'string') out.push(action.arg);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card);
  return out;
}

function actionCommandRows(card: unknown): string[][] {
  const rows: string[][] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.tag === 'action' && Array.isArray(record.actions)) {
      rows.push(record.actions.flatMap((item) => {
        const action = (item as Record<string, unknown>).value as Record<string, unknown> | undefined;
        return typeof action?.cmd === 'string' ? [action.cmd] : [];
      }));
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card);
  return rows;
}

function codexThread(
  threadId: string,
  preview: string,
  updatedAtMs: number,
  source = 'exec',
): CodexThreadHistoryEntry {
  return {
    threadId,
    sessionId: threadId,
    preview,
    cwd: '/tmp/workspace',
    createdAtMs: updatedAtMs - 1000,
    updatedAtMs,
    source,
  };
}

function codexThreadForCwd(
  threadId: string,
  preview: string,
  updatedAtMs: number,
  source: string,
  cwd: string,
): CodexThreadHistoryEntry {
  return { ...codexThread(threadId, preview, updatedAtMs, source), cwd };
}

function externalCodexThread(cwd: string): CodexThreadDetails {
  return {
    threadId: 'external-source-secret',
    cwd,
    source: 'vscode',
    updatedAtMs: 1_700_000_300_000,
    status: 'notLoaded',
    turns: [
      {
        turnId: 'turn-completed',
        status: 'completed',
        messages: [
          { role: 'user', text: 'visible question' },
          { role: 'assistant', text: 'visible answer' },
        ],
      },
      {
        turnId: 'turn-running',
        status: 'inProgress',
        messages: [
          { role: 'user', text: 'unfinished input' },
          { role: 'assistant', text: 'partial answer' },
          { role: 'user', text: 'page-two-content' },
        ],
      },
    ],
  };
}
