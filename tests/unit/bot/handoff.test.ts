import { describe, expect, it } from 'vitest';
import { HandoffTracker, formatBotHandoff, parseBotHandoff } from '../../../src/bot/handoff.js';

describe('bot handoff protocol', () => {
  it('parses a valid marker and hides it from the ordinary answer', () => {
    const result = parseBotHandoff(
      '已收到，稍后同步。\n\n[[bot_handoff target="ou_target" task_id="task-123" hop="0"]]\n检查版本和日志\n[[/bot_handoff]]',
    );
    expect(result.errors).toEqual([]);
    expect(result.cleanText).toBe('已收到，稍后同步。');
    expect(result.handoff).toEqual({
      target: 'ou_target',
      taskId: 'task-123',
      hop: 0,
      body: '检查版本和日志',
    });
  });

  it('rejects malformed metadata without leaking marker syntax', () => {
    const result = parseBotHandoff('[[bot_handoff target="not-an-open-id" hop="9"]]secret[[/bot_handoff]]');
    expect(result.handoff).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.cleanText).toBe('');
    expect(result.cleanText).not.toContain('bot_handoff');
  });

  it('round-trips escaped attributes', () => {
    const encoded = formatBotHandoff({
      target: 'ou_target',
      taskId: 'task-1',
      hop: 1,
      returnTo: 'ou_source',
      body: '结果：通过',
    });
    expect(parseBotHandoff(encoded).handoff).toEqual({
      target: 'ou_target',
      taskId: 'task-1',
      hop: 1,
      returnTo: 'ou_source',
      body: '结果：通过',
    });
  });
});
describe('handoff tracker', () => {
  it('deduplicates tasks and only permits return to the original source', () => {
    const tracker = new HandoffTracker(1000);
    expect(tracker.begin('task-1', 'ou_a', 'ou_b', 10)).toBe(true);
    expect(tracker.begin('task-1', 'ou_a', 'ou_b', 11)).toBe(false);
    expect(tracker.allowReturn('task-1', 'ou_a', 12)).toBe(true);
    expect(tracker.allowReturn('task-1', 'ou_b', 12)).toBe(false);
    expect(tracker.allowReturn('task-1', 'ou_a', 1011)).toBe(false);
  });

  it('authorizes a receiver to return an accepted inbound task', () => {
    const tracker = new HandoffTracker(1000);
    expect(tracker.acceptIncoming('task-2', 'ou_source', 'ou_receiver', 10)).toBe(true);
    expect(tracker.allowReturn('task-2', 'ou_source', 11)).toBe(true);
    expect(tracker.allowReturn('task-2', 'ou_other', 11)).toBe(false);
    expect(tracker.acceptIncoming('task-2', 'ou_other', 'ou_receiver', 12)).toBe(false);
  });
});
