import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../platform/spawn';
import { normalizeSessionPreview } from './preview';
import { buildAgentProxyEnv } from '../agent/agent-proxy-env';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export type CodexThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown';

export interface CodexThreadHistoryEntry {
  threadId: string;
  sessionId?: string;
  preview: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  source: string;
  name?: string;
}

export interface CodexAppServerOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
}

export interface ListCodexThreadHistoryOptions extends CodexAppServerOptions {
  cwd: string;
  limit: number;
  /** When true, list archived threads only. Default false (active threads). */
  archived?: boolean;
  sourceKinds?: readonly CodexThreadSourceKind[];
  useStateDbOnly?: boolean;
}

export interface CodexThreadMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface CodexThreadTurn {
  turnId: string;
  status: string;
  messages: CodexThreadMessage[];
}

export interface CodexThreadDetails {
  threadId: string;
  cwd: string;
  source: string;
  updatedAtMs: number;
  status: string;
  forkedFromId?: string;
  turns: CodexThreadTurn[];
}

export type CodexHistoryErrorCode =
  | 'spawn-failed'
  | 'timeout'
  | 'app-server-error'
  | 'malformed-response';

export class CodexHistoryError extends Error {
  readonly code: CodexHistoryErrorCode;

  constructor(code: CodexHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexHistoryError';
    this.code = code;
  }
}

const DEFAULT_HISTORY_TIMEOUT_MS = 5000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 15_000;
/** Broad default for low-level callers that opt into full Shared Codex Home listing. */
const DEFAULT_SOURCE_KINDS: readonly CodexThreadSourceKind[] = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'unknown',
];
/**
 * Feishu `/resume` History Isolation: only `codex exec` threads (bridge + terminal exec).
 * Desktop/plugin default lists are interactive-only (`cli`/`vscode`), so lists stay mutually hidden.
 */
export const FEISHU_RESUME_SOURCE_KINDS: readonly CodexThreadSourceKind[] = ['exec'];

export async function listCodexThreadHistory(
  options: ListCodexThreadHistoryOptions,
): Promise<CodexThreadHistoryEntry[]> {
  return callCodexAppServer(
    options,
    listRequest(options),
    parseThreadListResponse,
    options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS,
  );
}

/**
 * Recovers Desktop/VS Code threads still present in Codex's UI index but
 * absent from thread/list. Every candidate is re-read through app-server
 * before it is exposed, so stale index rows and other workspaces stay hidden.
 */
export async function listIndexedCodexThreadHistory(
  options: ListCodexThreadHistoryOptions,
  excludeThreadIds: ReadonlySet<string> = new Set(),
): Promise<CodexThreadHistoryEntry[]> {
  const indexPath = join(resolveCodexHome(options), 'session_index.jsonl');
  let contents: string;
  try {
    contents = await readFile(indexPath, 'utf8');
  } catch (err) {
    if (recordValue(err)?.code === 'ENOENT') return [];
    throw err;
  }

  const candidates = contents
    .split(/\r?\n/u)
    .map(parseSessionIndexEntry)
    .filter((entry): entry is CodexSessionIndexEntry => Boolean(entry))
    .filter((entry) => !excludeThreadIds.has(entry.threadId))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, Math.max(options.limit * 4, 20));
  const sourceKinds = new Set(options.sourceKinds ?? DEFAULT_SOURCE_KINDS);
  const recovered: CodexThreadHistoryEntry[] = [];

  for (let offset = 0; offset < candidates.length && recovered.length < options.limit; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const reads = await Promise.allSettled(
      batch.map((entry) => readCodexThread(options, entry.threadId)),
    );
    for (let index = 0; index < reads.length && recovered.length < options.limit; index += 1) {
      const result = reads[index];
      const candidate = batch[index];
      if (!candidate || result?.status !== 'fulfilled') continue;
      const thread = result.value;
      if (
        thread.threadId !== candidate.threadId ||
        thread.cwd !== options.cwd ||
        !sourceKinds.has(thread.source as CodexThreadSourceKind)
      ) continue;
      recovered.push({
        threadId: thread.threadId,
        preview: firstUserMessage(thread) ?? '(空会话)',
        cwd: thread.cwd,
        createdAtMs: candidate.updatedAtMs,
        updatedAtMs: thread.updatedAtMs,
        source: thread.source,
        name: candidate.name,
      });
    }
  }

  return recovered.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export async function archiveCodexThread(
  options: CodexAppServerOptions,
  threadId: string,
): Promise<void> {
  await callCodexAppServer(
    options,
    {
      method: 'thread/archive',
      id: 2,
      params: { threadId },
    },
    parseEmptyResult('thread/archive'),
    options.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
  );
}

export async function unarchiveCodexThread(
  options: CodexAppServerOptions,
  threadId: string,
): Promise<void> {
  await callCodexAppServer(
    options,
    {
      method: 'thread/unarchive',
      id: 2,
      params: { threadId },
    },
    parseUnarchiveResult,
    options.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
  );
}

export async function setCodexThreadName(
  options: CodexAppServerOptions,
  threadId: string,
  name: string,
): Promise<void> {
  await callCodexAppServer(
    options,
    {
      method: 'thread/name/set',
      id: 2,
      params: { threadId, name },
    },
    parseEmptyResult('thread/name/set'),
    options.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
  );
}

export async function readCodexThread(
  options: CodexAppServerOptions,
  threadId: string,
): Promise<CodexThreadDetails> {
  return callCodexAppServer(
    options,
    {
      method: 'thread/read',
      id: 2,
      params: { threadId, includeTurns: true },
    },
    parseThreadDetailsResponse('thread/read'),
    options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
  );
}

export async function forkCodexThread(
  options: CodexAppServerOptions,
  threadId: string,
  lastTurnId: string,
): Promise<CodexThreadDetails> {
  return callCodexAppServer(
    options,
    {
      method: 'thread/fork',
      id: 2,
      params: { threadId, lastTurnId },
    },
    parseThreadDetailsResponse('thread/fork'),
    options.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
  );
}

async function callCodexAppServer<T>(
  options: CodexAppServerOptions,
  request: { method: string; id: number; params: unknown },
  parse: (result: unknown) => T,
  timeoutMs: number,
): Promise<T> {
  const child = spawnCodexAppServer(options);
  const stderrChunks: Buffer[] = [];
  let settled = false;

  const result = await new Promise<T>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (err: unknown): void => {
      if (settled) return;
      reject(
        err instanceof CodexHistoryError
          ? err
          : new CodexHistoryError('spawn-failed', errorMessage(err)),
      );
      cleanup({ kill: true });
    };

    const cleanup = (cleanupOptions: { kill: boolean }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      child.removeListener('error', fail);
      child.stdin.removeListener('error', fail);
      child.stderr.removeAllListeners('data');
      if (
        cleanupOptions.kill &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill('SIGTERM');
      }
    };

    timer = setTimeout(() => {
      reject(
        new CodexHistoryError(
          'timeout',
          `codex ${request.method} timed out after ${timeoutMs}ms`,
        ),
      );
      cleanup({ kill: true });
    }, timeoutMs);

    child.once('error', fail);
    child.stdin.once('error', fail);
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      const response = recordValue(msg);
      if (!response || response.id !== request.id) return;
      if (response.error) {
        const err = recordValue(response.error);
        reject(
          new CodexHistoryError(
            'app-server-error',
            typeof err?.message === 'string'
              ? err.message
              : `codex app-server rejected ${request.method}`,
          ),
        );
        cleanup({ kill: true });
        return;
      }
      try {
        resolve(parse(response.result));
      } catch (err) {
        fail(err);
        return;
      }
      cleanup({ kill: true });
    });

    child.once('exit', (code) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(
        new CodexHistoryError(
          'spawn-failed',
          `codex app-server exited before ${request.method} response: ${code ?? 'signal'}${stderr ? `: ${stderr}` : ''}`,
        ),
      );
      cleanup({ kill: true });
    });

    try {
      child.stdin.write(
        `${JSON.stringify(initializeRequest())}\n${JSON.stringify(request)}\n`,
        'utf8',
        (err?: Error | null) => {
          if (err) fail(err);
        },
      );
    } catch (err) {
      fail(err);
    }
  });

  await waitForChildExit(child, 250);
  return result;
}

function spawnCodexAppServer(options: CodexAppServerOptions): CodexAppServerChild {
  const envOverrides: NodeJS.ProcessEnv = {};
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }

  return spawnProcess(options.binary, ['app-server', '--listen', 'stdio://'], {
    env: mergeProcessEnv(process.env, {
      ...envOverrides,
      ...buildAgentProxyEnv(),
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexAppServerChild;
}

function initializeRequest() {
  return {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: '0.2.3',
      },
      capabilities: null,
    },
  };
}

function listRequest(options: ListCodexThreadHistoryOptions) {
  return {
    method: 'thread/list',
    id: 2,
    params: {
      limit: options.limit,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: options.archived === true,
      cwd: options.cwd,
      useStateDbOnly: options.useStateDbOnly ?? true,
      sourceKinds: [...(options.sourceKinds ?? DEFAULT_SOURCE_KINDS)],
    },
  };
}

interface CodexSessionIndexEntry {
  threadId: string;
  name?: string;
  updatedAtMs: number;
}

function parseSessionIndexEntry(line: string): CodexSessionIndexEntry | undefined {
  if (!line.trim()) return undefined;
  try {
    const raw = recordValue(JSON.parse(line));
    const threadId = stringValue(raw?.id);
    const updatedAt = stringValue(raw?.updated_at);
    const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    if (!threadId || !Number.isFinite(updatedAtMs)) return undefined;
    const name = stringValue(raw?.thread_name);
    return { threadId, updatedAtMs, ...(name ? { name } : {}) };
  } catch {
    return undefined;
  }
}

function resolveCodexHome(options: CodexAppServerOptions): string {
  if (options.codexHome) return options.codexHome;
  if (options.inheritCodexHome === false) return join(options.profileStateDir, 'codex-home');
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function firstUserMessage(thread: CodexThreadDetails): string | undefined {
  for (const turn of thread.turns) {
    const message = turn.messages.find((item) => item.role === 'user');
    if (message) return normalizeSessionPreview(message.text);
  }
  return undefined;
}

function parseThreadListResponse(input: unknown): CodexThreadHistoryEntry[] {
  const raw = recordValue(input);
  if (!raw || !Array.isArray(raw.data)) {
    throw new CodexHistoryError(
      'malformed-response',
      'codex app-server returned malformed thread/list response',
    );
  }
  return raw.data
    .map(normalizeThread)
    .filter((entry): entry is CodexThreadHistoryEntry => Boolean(entry));
}

function parseEmptyResult(method: string): (input: unknown) => void {
  return (input: unknown) => {
    if (input === undefined || input === null) return;
    if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0) {
      return;
    }
    // Some builds return a thread object; treat non-error payloads as success.
    if (typeof input === 'object') return;
    throw new CodexHistoryError(
      'malformed-response',
      `codex app-server returned unexpected ${method} result`,
    );
  };
}

function parseUnarchiveResult(input: unknown): void {
  if (input === undefined || input === null) return;
  if (typeof input === 'object') return;
  throw new CodexHistoryError(
    'malformed-response',
    'codex app-server returned unexpected thread/unarchive result',
  );
}

function parseThreadDetailsResponse(method: string): (input: unknown) => CodexThreadDetails {
  return (input: unknown) => {
    const result = recordValue(input);
    const rawThread = recordValue(result?.thread);
    if (!rawThread) {
      throw new CodexHistoryError(
        'malformed-response',
        `codex app-server returned malformed ${method} response`,
      );
    }
    const threadId = stringValue(rawThread.id);
    const cwd = stringValue(rawThread.cwd);
    const updatedAt = numberValue(rawThread.updatedAt);
    if (!threadId || !cwd || updatedAt === undefined || !Array.isArray(rawThread.turns)) {
      throw new CodexHistoryError(
        'malformed-response',
        `codex app-server returned incomplete ${method} thread`,
      );
    }
    const turns = rawThread.turns.map(normalizeTurn);
    if (turns.some((turn) => turn === undefined)) {
      throw new CodexHistoryError(
        'malformed-response',
        `codex app-server returned malformed ${method} turns`,
      );
    }
    return {
      threadId,
      cwd,
      source: sourceValue(rawThread.source),
      updatedAtMs: Math.round(updatedAt * 1000),
      status: statusValue(rawThread.status),
      ...(stringValue(rawThread.forkedFromId)
        ? { forkedFromId: stringValue(rawThread.forkedFromId) }
        : {}),
      turns: turns as CodexThreadTurn[],
    };
  };
}

function normalizeTurn(input: unknown): CodexThreadTurn | undefined {
  const raw = recordValue(input);
  const turnId = stringValue(raw?.id);
  if (!raw || !turnId || !Array.isArray(raw.items)) return undefined;
  return {
    turnId,
    status: statusValue(raw.status),
    messages: raw.items
      .map(normalizeMessage)
      .filter((message): message is CodexThreadMessage => Boolean(message)),
  };
}

function normalizeMessage(input: unknown): CodexThreadMessage | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const type = stringValue(raw.type);
  if (type === 'agentMessage') {
    const text = stringValue(raw.text)?.trim();
    return text ? { role: 'assistant', text } : undefined;
  }
  if (type !== 'userMessage') return undefined;
  const text = userMessageText(raw.content);
  return text ? { role: 'user', text } : undefined;
}

function userMessageText(input: unknown): string | undefined {
  if (typeof input === 'string') return input.trim() || undefined;
  if (!Array.isArray(input)) return undefined;
  const text = input
    .map((part) => {
      if (typeof part === 'string') return part;
      const raw = recordValue(part);
      if (!raw) return '';
      if (raw.type === 'text' || raw.type === 'inputText') return stringValue(raw.text) ?? '';
      if (raw.type === 'image' || raw.type === 'localImage') return '[图片]';
      if (raw.type === 'audio' || raw.type === 'localAudio') return '[音频]';
      if (raw.type === 'skill') return `[技能: ${stringValue(raw.name) ?? '未知'}]`;
      if (raw.type === 'mention') return `[引用: ${stringValue(raw.name) ?? '未知'}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || undefined;
}

function normalizeThread(input: unknown): CodexThreadHistoryEntry | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const threadId = stringValue(raw.id);
  const cwd = stringValue(raw.cwd);
  if (!threadId || !cwd) return undefined;
  const createdAt = numberValue(raw.createdAt);
  const updatedAt = numberValue(raw.updatedAt);
  return {
    threadId,
    ...(stringValue(raw.sessionId) ? { sessionId: stringValue(raw.sessionId) } : {}),
    preview: normalizeSessionPreview(stringValue(raw.preview) ?? '') || '(空会话)',
    cwd,
    createdAtMs: Math.round((createdAt ?? 0) * 1000),
    updatedAtMs: Math.round((updatedAt ?? 0) * 1000),
    source: sourceValue(raw.source),
    ...(stringValue(raw.name) ? { name: stringValue(raw.name) } : {}),
  };
}

async function waitForChildExit(child: CodexAppServerChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sourceValue(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return JSON.stringify(input);
  return 'unknown';
}

function statusValue(input: unknown): string {
  if (typeof input === 'string') return input;
  const raw = recordValue(input);
  return stringValue(raw?.type) ?? 'unknown';
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
