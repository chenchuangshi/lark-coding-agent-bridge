import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { RobotAuthConfig } from './types';

const READONLY_STATUS_SCRIPT = [
  'set +e',
  'echo "=== host ==="',
  'hostname; uptime; whoami; date',
  'echo',
  'echo "=== docker ==="',
  "docker ps --format 'table {{.Names}}\\t{{.Status}}' 2>/dev/null | head -20 || echo '(no docker)'",
  'echo',
  'echo "=== teach pendant ==="',
  'if command -v tp-status >/dev/null 2>&1; then tp-status;',
  'elif command -v tp-ctl >/dev/null 2>&1; then tp-ctl status;',
  "else echo '(no tp-status/tp-ctl)'; fi",
].join('\n');

export async function sshStatus(
  cfg: RobotAuthConfig,
  host: string,
  timeoutMs = 45_000,
): Promise<{ ok: boolean; output: string }> {
  return sshRun(cfg, host, READONLY_STATUS_SCRIPT, timeoutMs);
}

export async function sshRun(
  cfg: RobotAuthConfig,
  host: string,
  remoteCommand: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; output: string }> {
  if (!isSafeHost(host)) {
    return { ok: false, output: 'invalid SSH host from roster' };
  }
  if (!isSafeUser(cfg.sshUser)) {
    return { ok: false, output: 'invalid SSH user in robot config' };
  }
  const sshArgs = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=5',
    '-p',
    String(cfg.sshPort || 22),
  ];
  if (cfg.identityFile) {
    sshArgs.push('-i', expandHome(cfg.identityFile));
  }
  sshArgs.push(`${cfg.sshUser}@${host}`, 'bash', '-lc', remoteCommand);

  if (cfg.sshPassword) {
    return spawnCaptured('sshpass', ['-e', 'ssh', ...sshArgs], timeoutMs, {
      SSHPASS: cfg.sshPassword,
    });
  }
  return spawnCaptured('ssh', ['-o', 'BatchMode=yes', ...sshArgs], timeoutMs);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function spawnCaptured(
  command: string,
  args: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; output: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        output: trim(
          `${stdout}\n${stderr}\n[timeout after ${Math.round(timeoutMs / 1000)}s]`,
        ),
      });
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, output: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const merged = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      finish({
        ok: code === 0,
        output: trim(merged || `(exit ${code ?? 'unknown'})`),
      });
    });
  });
}

function isSafeHost(host: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(host);
}

function isSafeUser(user: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/i.test(user);
}

function trim(text: string, max = 3500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(已截断)`;
}
