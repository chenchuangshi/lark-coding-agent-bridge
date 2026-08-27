#!/usr/bin/env node
/**
 * lark-robot — CLI for bridge agents to resolve / read-only SSH robots
 * via Robot Roster + shared profile credentials (~/.lark-channel/profiles/<p>/robot.json).
 *
 * Write ops: prefer Feishu `/robot write` confirm cards. This CLI can print a
 * propose payload but will NOT execute mutating commands without --i-understand-write
 * (and even then, prefer the card path).
 */
import { Command } from 'commander';
import { loadRobotConfig, publicRobotConfig, robotConfigProblem } from '../robot/config';
import {
  fetchRosterDevices,
  fetchRosterStats,
  formatDeviceBrief,
  normalizeMachineKey,
  resolveMachine,
} from '../robot/roster';
import { sshRun, sshStatus } from '../robot/ssh';
import { isClearlyReadOnlyRobotCommand } from '../robot/read-only';
import type { RosterDevice } from '../robot/types';

const program = new Command();
program.name('lark-robot').description('Robot Roster + SSH helper for lark-channel-bridge');

program
  .command('config')
  .description('Show robot.json (no password)')
  .action(async () => {
    const cfg = await loadRobotConfig();
    console.log(JSON.stringify(publicRobotConfig(cfg), null, 2));
  });

program
  .command('stats')
  .description('Roster /api/stats')
  .action(async () => {
    const cfg = await loadRobotConfig();
    ensureConfigured(cfg);
    const stats = await fetchRosterStats(cfg.rosterBaseUrl);
    console.log(JSON.stringify(stats, null, 2));
  });

program
  .command('resolve')
  .argument('<key>', 'machine number, e.g. 57 / kitt-57')
  .description('Resolve machine via roster')
  .action(async (key: string) => {
    const cfg = await loadRobotConfig();
    ensureConfigured(cfg);
    const resolved = await resolveMachine(cfg.rosterBaseUrl, key);
    if (!resolved.ok) {
      console.error(resolved.reason);
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          key: resolved.key,
          host: pickHost(resolved.device),
          device: briefDevice(resolved.device),
          candidates: resolved.candidates.map(briefDevice),
        },
        null,
        2,
      ),
    );
  });

program
  .command('status')
  .argument('<key>', 'machine number')
  .description('Read-only remote status (hostname/docker/tp-status)')
  .action(async (key: string) => {
    const target = await mustResolve(key);
    const cfg = await loadRobotConfig();
    ensureCreds(cfg);
    const result = await sshStatus(cfg, target.host);
    console.log(
      JSON.stringify(
        { ok: result.ok, key: target.key, host: target.host, output: result.output },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('run')
  .argument('<key>', 'machine number')
  .argument('<command...>', 'remote bash -lc command')
  .option('--i-understand-write', 'allow a mutating command from this local terminal', false)
  .description('SSH run remote command (default: refuse obvious write patterns)')
  .action(async (key: string, commandParts: string[], opts: { iUnderstandWrite?: boolean }) => {
    const command = commandParts.join(' ').trim();
    if (!command) {
      console.error('missing remote command');
      process.exitCode = 2;
      return;
    }
    if (!opts.iUnderstandWrite && !isClearlyReadOnlyRobotCommand(command)) {
      console.error(
        'Refusing a command outside the read-only allowlist. Use Feishu `/robot write ...` or pass --i-understand-write locally.',
      );
      process.exitCode = 2;
      return;
    }
    const target = await mustResolve(key);
    const cfg = await loadRobotConfig();
    ensureCreds(cfg);
    const result = await sshRun(cfg, target.host, command);
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          key: target.key,
          host: target.host,
          command,
          output: result.output,
        },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('list')
  .option('--q <query>', 'roster search')
  .option('--limit <n>', 'max rows', '30')
  .description('List robots from roster')
  .action(async (opts: { q?: string; limit?: string }) => {
    const cfg = await loadRobotConfig();
    ensureConfigured(cfg);
    const devices = await fetchRosterDevices(cfg.rosterBaseUrl, {
      robot: true,
      ...(opts.q ? { q: opts.q } : {}),
    });
    const limit = Number(opts.limit) || 30;
    const rows = devices.slice(0, limit).map((d) => ({
      key:
        normalizeMachineKey(d.unit) ||
        normalizeMachineKey(d.alias) ||
        normalizeMachineKey(d.hostname) ||
        d.unit,
      brief: formatDeviceBrief(d),
      host: pickHost(d),
      status: d.status,
    }));
    console.log(JSON.stringify({ count: devices.length, rows }, null, 2));
  });

await program.parseAsync(process.argv);

async function mustResolve(raw: string): Promise<{ key: string; host: string; device: RosterDevice }> {
  const cfg = await loadRobotConfig();
  ensureConfigured(cfg);
  const resolved = await resolveMachine(cfg.rosterBaseUrl, raw);
  if (!resolved.ok) {
    console.error(resolved.reason);
    process.exit(1);
  }
  const host = pickHost(resolved.device);
  if (!host) {
    console.error(`no IP for ${resolved.key}`);
    process.exit(1);
  }
  return { key: resolved.key, host, device: resolved.device };
}

function ensureConfigured(cfg: Awaited<ReturnType<typeof loadRobotConfig>>): void {
  const problem = robotConfigProblem(cfg);
  if (!problem) return;
  console.error(`Robot config incomplete: ${problem}`);
  process.exit(2);
}

function pickHost(d: RosterDevice): string | undefined {
  return d.primary_ip || d.ips?.[0] || undefined;
}

function briefDevice(d: RosterDevice) {
  return {
    alias: d.alias,
    hostname: d.hostname,
    unit: d.unit,
    status: d.status,
    primary_ip: d.primary_ip,
    brief: formatDeviceBrief(d),
  };
}

function ensureCreds(cfg: { sshPassword?: string; identityFile?: string }): void {
  if (!cfg.sshPassword && !cfg.identityFile) {
    console.error('No SSH credential configured. Set identityFile in the profile-local robot.json (recommended).');
    process.exit(2);
  }
}
