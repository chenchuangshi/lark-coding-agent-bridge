import { sendManagedCard, updateManagedCard } from '../card/managed';
import type { CommandContext } from '../commands/index';
import {
  loadRobotConfig,
  publicRobotConfig,
  robotConfigProblem,
} from './config';
import {
  robotActiveCard,
  robotCandidatesCard,
  robotListCard,
  robotWriteConfirmCard,
} from './cards';
import {
  extractMachineKeys,
  fetchRosterDevices,
  fetchRosterStats,
  formatDeviceBrief,
  normalizeMachineKey,
  resolveMachine,
} from './roster';
import { sshRun, sshStatus } from './ssh';
import { isClearlyReadOnlyRobotCommand } from './read-only';
import { RobotStore } from './store';
import type { RosterDevice } from './types';

type ReplyFn = (ctx: CommandContext, markdown: string) => Promise<void>;

export async function handleRobotCommand(
  args: string,
  ctx: CommandContext,
  reply: ReplyFn,
): Promise<void> {
  const trimmed = args.trim();
  const [subRaw, ...rest] = trimmed ? trimmed.split(/\s+/) : [''];
  const sub = (subRaw || 'help').toLowerCase();
  const restJoined = rest.join(' ').trim();

  switch (sub) {
    case 'help':
    case '':
      await reply(ctx, robotHelpText());
      return;
    case 'config':
      await handleConfigShow(ctx, reply);
      return;
    case 'list':
      await handleList(ctx, reply);
      return;
    case 'stats':
      await handleStats(ctx, reply);
      return;
    case 'use':
    case 'bind':
      await handleUse(restJoined, ctx, reply);
      return;
    case 'clear':
    case 'unbind':
      await handleClear(ctx, reply);
      return;
    case 'status':
      await handleStatus(restJoined, ctx, reply);
      return;
    case 'write':
      await handleWrite(restJoined, ctx, reply);
      return;
    case 'approve':
      await handleApprove(restJoined, ctx, reply);
      return;
    case 'deny':
      await handleDeny(restJoined, ctx, reply);
      return;
    case 'run':
      await handleRunReadonly(restJoined, ctx, reply);
      return;
    default: {
      // `/robot 57` or `/robot 57号` → bind
      const asKey = normalizeMachineKey(sub) ?? normalizeMachineKey(trimmed);
      if (asKey) {
        await handleUse(asKey, ctx, reply);
        return;
      }
      await reply(ctx, `未知子命令：\`${sub}\`\n\n${robotHelpText()}`);
    }
  }
}

function robotHelpText(): string {
  return [
    '**机器人命令**（名单来自 Robot Roster）',
    '',
    '- `/robot 57` / `/robot use 57` — 绑定当前会话到该机',
    '- `/robot status [57]` — 只读：hostname / docker / tp-status',
    '- `/robot run <cmd>` — 只读远程命令（需已绑定；危险写操作请用 write）',
    '- `/robot write <cmd>` — 申请写操作（发确认卡，同意后才 SSH）',
    '- `/robot list` — 名单节选',
    '- `/robot stats` — Roster 统计',
    '- `/robot clear` — 解绑',
    '- `/robot config` — 查看 SSH/Roster 配置（不含密码）',
    '- SSH 凭据仅在运行 bridge 的机器上配置，不接受聊天传密码',
    '',
    '自然语言也可：例如「去57号机器看 docker」。写操作仍需确认卡。',
  ].join('\n');
}

async function handleConfigShow(ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const cfg = await loadRobotConfig(ctx.controls.profile);
  const pub = publicRobotConfig(cfg);
  await reply(
    ctx,
    [
      '**Robot 配置**',
      '```json',
      JSON.stringify(pub, null, 2),
      '```',
      pub.hasPassword
        ? '已配置密码（或可用 identityFile / 本机 ssh agent）。'
        : '⚠️ 尚未配置凭据。请在运行 bridge 的机器上为 robot.json 设置 identityFile（推荐），或设置 LARK_ROBOT_SSH_PASSWORD。',
    ].join('\n'),
  );
}

async function handleList(ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const cfg = await loadRobotConfig(ctx.controls.profile);
  if (!(await ensureRobotConfigured(cfg, ctx, reply))) return;
  const store = RobotStore.forProfile(ctx.controls.profile);
  await store.ensureLoaded();
  let devices: RosterDevice[];
  try {
    devices = await fetchRosterDevices(cfg.rosterBaseUrl, { robot: true });
  } catch (err) {
    await reply(ctx, `❌ 拉名单失败：${errMsg(err)}`);
    return;
  }
  const online = devices.filter((d) => d.status === 'online').slice(0, 20);
  const rows = (online.length > 0 ? online : devices.slice(0, 20)).map((d) => {
    const key =
      normalizeMachineKey(d.unit) ||
      normalizeMachineKey(d.alias) ||
      normalizeMachineKey(d.hostname) ||
      d.unit ||
      d.alias;
    return {
      key,
      device: d,
      host: d.primary_ip || d.ips?.[0] || '',
    };
  });
  const card = robotListCard(rows, store.activeKey(ctx.scope));
  await sendCard(ctx, card);
}

async function handleStats(ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const cfg = await loadRobotConfig(ctx.controls.profile);
  if (!(await ensureRobotConfigured(cfg, ctx, reply))) return;
  try {
    const stats = await fetchRosterStats(cfg.rosterBaseUrl);
    await reply(ctx, ['**Roster 统计**', '```json', JSON.stringify(stats, null, 2), '```'].join('\n'));
  } catch (err) {
    await reply(ctx, `❌ ${errMsg(err)}`);
  }
}

async function handleUse(raw: string, ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const { key, preferHost } = parseUseArg(raw);
  if (!key) {
    await reply(ctx, '用法：`/robot use 57` 或 `/robot 57`');
    return;
  }
  const cfg = await loadRobotConfig(ctx.controls.profile);
  if (!(await ensureRobotConfigured(cfg, ctx, reply))) return;
  let resolved;
  try {
    resolved = await resolveMachine(cfg.rosterBaseUrl, key);
  } catch (err) {
    await reply(ctx, `❌ 解析失败：${errMsg(err)}`);
    return;
  }
  if (!resolved.ok) {
    await reply(ctx, `❌ ${resolved.reason}`);
    return;
  }
  let device = resolved.device;
  if (preferHost) {
    const hit = resolved.candidates.find(
      (d) => d.primary_ip === preferHost || d.ips?.includes(preferHost),
    );
    if (!hit) {
      await reply(ctx, `❌ 未找到 IP 为 \`${preferHost}\` 的 ${key} 号机器`);
      return;
    }
    device = hit;
  } else if (resolved.candidates.length > 1 && scoreGap(resolved.candidates) === 0) {
    await sendCard(ctx, robotCandidatesCard(key, resolved.candidates));
    return;
  }
  const host = preferHost || pickHost(device);
  if (!host) {
    await reply(ctx, `❌ ${key} 号机器没有可用 IP（${formatDeviceBrief(device)}）`);
    return;
  }
  const store = RobotStore.forProfile(ctx.controls.profile);
  await store.ensureLoaded();
  store.setActive(ctx.scope, key);
  await sendCard(ctx, robotActiveCard({ key, device, host }));
}

function parseUseArg(raw: string): { key?: string; preferHost?: string } {
  const s = raw.trim();
  const at = s.match(/^([^@]+)@([\d.]+)$/);
  if (at) {
    return {
      key: normalizeMachineKey(at[1] ?? ''),
      preferHost: at[2],
    };
  }
  return { key: normalizeMachineKey(s) };
}

async function handleClear(ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const store = RobotStore.forProfile(ctx.controls.profile);
  await store.ensureLoaded();
  store.clearActive(ctx.scope);
  await reply(ctx, '已解绑当前会话的机器人。');
}

async function handleStatus(raw: string, ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const target = await resolveTarget(raw, ctx, reply);
  if (!target) return;
  const cfg = await loadRobotConfig(ctx.controls.profile);
  if (!cfg.sshPassword && !cfg.identityFile) {
    await reply(ctx, '⚠️ 未配置 SSH 凭据。请在运行 bridge 的机器上配置 identityFile。');
    return;
  }
  await reply(ctx, `⏳ 正在只读检查 \`${target.key}\` @ \`${target.host}\` …`);
  const result = await sshStatus(cfg, target.host);
  await reply(
    ctx,
    [
      result.ok ? `✅ **${target.key}** @ \`${target.host}\`` : `⚠️ **${target.key}** SSH 异常 @ \`${target.host}\``,
      '```',
      result.output,
      '```',
    ].join('\n'),
  );
}

async function handleRunReadonly(raw: string, ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const cmd = raw.trim();
  if (!cmd) {
    await reply(ctx, '用法：`/robot run <remote command>`（需已绑定机器；默认按只读意图使用）');
    return;
  }
  if (!isClearlyReadOnlyRobotCommand(cmd)) {
    await reply(
      ctx,
      '这条命令看起来会改机器状态。请改用 `/robot write <cmd>`，确认卡同意后再执行。',
    );
    return;
  }
  const target = await resolveTarget('', ctx, reply);
  if (!target) return;
  const cfg = await loadRobotConfig(ctx.controls.profile);
  if (!cfg.sshPassword && !cfg.identityFile) {
    await reply(ctx, '⚠️ 未配置 SSH 凭据。请在运行 bridge 的机器上配置 identityFile。');
    return;
  }
  const result = await sshRun(cfg, target.host, cmd);
  await reply(
    ctx,
    [
      result.ok ? `✅ 只读执行 @ \`${target.host}\`` : `⚠️ 执行失败 @ \`${target.host}\``,
      '```',
      result.output,
      '```',
    ].join('\n'),
  );
}

async function handleWrite(raw: string, ctx: CommandContext, reply: ReplyFn): Promise<void> {
  // Optional leading machine key: `/robot write 57 -- tp-stop` or `/robot write tp-stop`
  let machineRaw = '';
  let command = raw.trim();
  const m = command.match(/^(\S+)\s+--\s+(.+)$/);
  if (m) {
    machineRaw = m[1] ?? '';
    command = (m[2] ?? '').trim();
  } else {
    const maybeKey = normalizeMachineKey(command.split(/\s+/)[0] ?? '');
    if (maybeKey && command.includes(' ')) {
      // ambiguous; prefer bind-target + full rest as command unless first token is only a key
      const parts = command.split(/\s+/);
      if (normalizeMachineKey(parts[0] ?? '') && parts.length > 1) {
        // keep as full command on active machine unless user used `--`
      }
    }
  }
  if (!command) {
    await reply(
      ctx,
      '用法：\n- `/robot write <cmd>`（对当前绑定机器）\n- `/robot write 57 -- <cmd>`',
    );
    return;
  }
  const target = await resolveTarget(machineRaw, ctx, reply);
  if (!target) return;

  const store = RobotStore.forProfile(ctx.controls.profile);
  await store.ensureLoaded();
  const pending = store.createPending({
    scope: ctx.scope,
    machineKey: target.key,
    host: target.host,
    command,
    reason: '飞书 /robot write 申请',
    requesterId: ctx.msg.senderId,
  });
  await sendCard(
    ctx,
    robotWriteConfirmCard({
      ticketId: pending.id,
      machineKey: target.key,
      host: target.host,
      reason: pending.reason,
      command,
    }),
  );
}

async function handleApprove(ticketId: string, ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const id = ticketId.trim();
  if (!id) {
    await reply(ctx, '缺少 ticket id。');
    return;
  }
  const store = RobotStore.forProfile(ctx.controls.profile);
  await store.ensureLoaded();
  const pending = store.takePending(id, ctx.scope, ctx.msg.senderId);
  if (!pending) {
    await reply(ctx, '❌ 确认单无效、已过期，或你不是申请人。');
    return;
  }
  const cfg = await loadRobotConfig(ctx.controls.profile);
  const problem = robotConfigProblem(cfg);
  if (problem) {
    await reply(ctx, `⚠️ Robot 配置不完整：${problem}`);
    return undefined;
  }
  if (!cfg.sshPassword && !cfg.identityFile) {
    await reply(ctx, '⚠️ 未配置 SSH 凭据，无法执行。');
    return;
  }
  await reply(ctx, `⏳ 已同意，正在 SSH 执行 @ \`${pending.host}\` …`);
  const result = await sshRun(cfg, pending.host, pending.command);
  const body = [
    result.ok ? `✅ 写操作完成` : `⚠️ 写操作执行异常`,
    `🎯 ${pending.machineKey} @ \`${pending.host}\``,
    '```',
    result.output,
    '```',
  ].join('\n');
  if (ctx.fromCardAction) {
    try {
      await updateManagedCard(ctx.channel, ctx.msg.messageId, {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: result.ok ? '✅ 已执行' : '⚠️ 执行异常' } },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }],
      });
      return;
    } catch {
      // fall through to reply
    }
  }
  await reply(ctx, body);
}

async function handleDeny(ticketId: string, ctx: CommandContext, reply: ReplyFn): Promise<void> {
  const store = RobotStore.forProfile(ctx.controls.profile);
  await store.ensureLoaded();
  const ok = store.dropPending(ticketId.trim(), ctx.scope, ctx.msg.senderId);
  const text = ok ? '已取消写操作。' : '确认单无效或已过期。';
  if (ctx.fromCardAction) {
    try {
      await updateManagedCard(ctx.channel, ctx.msg.messageId, {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '已取消' } },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
      });
      return;
    } catch {
      // fall through
    }
  }
  await reply(ctx, text);
}

async function resolveTarget(
  rawKey: string,
  ctx: CommandContext,
  reply: ReplyFn,
): Promise<{ key: string; host: string; device: RosterDevice } | undefined> {
  const store = RobotStore.forProfile(ctx.controls.profile);
  await store.ensureLoaded();
  const cfg = await loadRobotConfig(ctx.controls.profile);
  let key = normalizeMachineKey(rawKey) || store.activeKey(ctx.scope);
  if (!key) {
    // try extract from recent? no — ask
    await reply(ctx, '请先 `/robot 57` 绑定机器，或在命令里带上机号。');
    return undefined;
  }
  let resolved;
  try {
    resolved = await resolveMachine(cfg.rosterBaseUrl, key);
  } catch (err) {
    await reply(ctx, `❌ 解析失败：${errMsg(err)}`);
    return undefined;
  }
  if (!resolved.ok) {
    await reply(ctx, `❌ ${resolved.reason}`);
    return undefined;
  }
  const host = pickHost(resolved.device);
  if (!host) {
    await reply(ctx, `❌ ${key} 号无可用 IP`);
    return undefined;
  }
  store.setActive(ctx.scope, key);
  return { key, host, device: resolved.device };
}

function pickHost(d: RosterDevice): string | undefined {
  return d.primary_ip || d.ips?.[0] || undefined;
}

function scoreGap(candidates: RosterDevice[]): number {
  if (candidates.length < 2) return 1;
  const score = (d: RosterDevice) =>
    (d.status === 'online' ? 100 : 0) + (d.primary_ip ? 20 : 0);
  return score(candidates[0]!) - score(candidates[1]!);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ensureRobotConfigured(
  cfg: Awaited<ReturnType<typeof loadRobotConfig>>,
  ctx: CommandContext,
  reply: ReplyFn,
): Promise<boolean> {
  const problem = robotConfigProblem(cfg);
  if (!problem) return true;
  await reply(ctx, `⚠️ Robot 配置不完整：${problem}`);
  return false;
}

async function sendCard(ctx: CommandContext, card: object): Promise<void> {
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  });
}

/** Build robot_context payload for NL injection (channel → agent prompt). */
export async function buildRobotContextForText(
  profile: string,
  scope: string,
  text: string,
): Promise<Record<string, unknown> | undefined> {
  const keys = extractMachineKeys(text);
  const store = RobotStore.forProfile(profile);
  await store.ensureLoaded();
  const active = store.activeKey(scope);
  const want = keys[0] || active;
  if (!want && keys.length === 0 && !active) return undefined;

  const cfg = await loadRobotConfig(profile);
  const out: Record<string, unknown> = {
    configured: !robotConfigProblem(cfg),
    hasCredential: Boolean(cfg.sshPassword || cfg.identityFile),
    activeKey: active || null,
    mentionedKeys: keys,
    cli: 'lark-robot',
  };

  if (want) {
    try {
      const resolved = await resolveMachine(cfg.rosterBaseUrl, want);
      if (resolved.ok) {
        const host = pickHost(resolved.device);
        if (keys[0]) store.setActive(scope, resolved.key);
        out.resolved = {
          key: resolved.key,
          host,
          status: resolved.device.status,
          alias: resolved.device.alias,
          hostname: resolved.device.hostname,
          unit: resolved.device.unit,
          brief: formatDeviceBrief(resolved.device),
        };
      } else {
        out.resolveError = resolved.reason;
      }
    } catch (err) {
      out.resolveError = errMsg(err);
    }
  }
  return out;
}
