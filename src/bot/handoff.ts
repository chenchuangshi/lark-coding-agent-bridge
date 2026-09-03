/**
 * Small, deliberately boring protocol used when one bridge bot delegates work
 * to another bot in the same Feishu chat.  The marker is written by the agent,
 * but parsed by the bridge before anything is sent to Feishu.  This keeps the
 * internal routing metadata out of the user-visible answer and lets us attach
 * a real structured mention to the delegated message.
 */

export interface BotHandoff {
  target: string;
  taskId: string;
  hop: number;
  /** The bot that should receive the result. Present on bridge-generated hops. */
  returnTo?: string;
  body: string;
}
export interface ParsedHandoff {
  cleanText: string;
  handoff?: BotHandoff;
  errors: string[];
}

const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]+$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const OPEN_RE = /\[\[bot_handoff\b([^\]]*)\]\]([\s\S]*?)\[\[\/bot_handoff\]\]/g;
const MARKER_HINT_RE = /\[\[\/?bot_handoff\b/;

/** Parse at most one handoff marker and remove every protocol marker. */
export function parseBotHandoff(text: string): ParsedHandoff {
  const errors: string[] = [];
  const matches = [...text.matchAll(OPEN_RE)];
  let handoff: BotHandoff | undefined;

  if (matches.length > 1) errors.push('multiple handoff markers');
  const match = matches[0];
  if (match) {
    const attrs = parseAttributes(match[1] ?? '');
    const target = attrs.target;
    const taskId = attrs.task_id;
    const hopRaw = attrs.hop;
    const hop = hopRaw === undefined ? NaN : Number(hopRaw);
    const body = (match[2] ?? '').trim();

    if (!target || !OPEN_ID_RE.test(target)) errors.push('invalid target');
    if (!taskId || !TASK_ID_RE.test(taskId)) errors.push('invalid task_id');
    if (!Number.isInteger(hop) || hop < 0 || hop > 1) errors.push('invalid hop');
    if (attrs.return_to !== undefined && !OPEN_ID_RE.test(attrs.return_to)) {
      errors.push('invalid return_to');
    }
    if (!body) errors.push('empty handoff body');

    if (errors.length === 0) {
      handoff = {
        target: target!,
        taskId: taskId!,
        hop,
        ...(attrs.return_to ? { returnTo: attrs.return_to } : {}),
        body,
      };
    }
  } else if (MARKER_HINT_RE.test(text)) {
    errors.push('malformed handoff marker');
  }

  // Never leak a malformed or valid internal marker.  For a valid marker the
  // task body is also internal routing content and is intentionally omitted
  // from the ordinary answer; it is sent separately to the target bot.
  const cleanText = text
    .replace(OPEN_RE, '')
    .replace(/\[\[\/?bot_handoff\b[^\]]*\]\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanText, ...(handoff ? { handoff } : {}), errors };
}

function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z_]+)\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  for (const match of raw.matchAll(re)) {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) continue;
    out[key] = value.replace(/\\([\\"])/g, '$1');
  }
  return out;
}

export function formatBotHandoff(handoff: Omit<BotHandoff, 'body'> & { body: string }): string {
  const attrs = [
    `target="${handoff.target}"`,
    `task_id="${handoff.taskId}"`,
    `hop="${handoff.hop}"`,
    ...(handoff.returnTo ? [`return_to="${handoff.returnTo}"`] : []),
  ].join(' ');
  return `[[bot_handoff ${attrs}]]\n${handoff.body.trim()}\n[[/bot_handoff]]`;
}

export interface HandoffRecord {
  source: string;
  target: string;
  expiresAt: number;
}

/** In-memory task ledger: dedupe retries and constrain hop-1 replies. */
export class HandoffTracker {
  private readonly records = new Map<string, HandoffRecord>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  begin(taskId: string, source: string, target: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.records.has(taskId)) return false;
    this.records.set(taskId, { source, target, expiresAt: now + this.ttlMs });
    return true;
  }

  /**
   * Register a hop-0 task received by this bridge so its eventual hop-1 reply
   * is authorized locally. Each bridge has its own in-memory ledger; the
   * receiver therefore cannot rely on the sender's `begin()` record.
   */
  acceptIncoming(taskId: string, source: string, target: string, now = Date.now()): boolean {
    this.prune(now);
    const existing = this.records.get(taskId);
    if (existing) return existing.source === source && existing.target === target;
    this.records.set(taskId, { source, target, expiresAt: now + this.ttlMs });
    return true;
  }

  allowReturn(taskId: string, target: string, now = Date.now()): boolean {
    this.prune(now);
    const record = this.records.get(taskId);
    return Boolean(record && record.source === target);
  }

  private prune(now: number): void {
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(id);
    }
  }
}
