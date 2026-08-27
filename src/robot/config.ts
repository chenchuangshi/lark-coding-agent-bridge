import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { writeFileAtomic } from '../platform/atomic-write';
import type { RobotAuthConfig } from './types';

const DEFAULTS: RobotAuthConfig = {
  rosterBaseUrl: process.env.LARK_ROBOT_ROSTER_URL?.trim() ?? '',
  sshUser: process.env.LARK_ROBOT_SSH_USER?.trim() ?? '',
  sshPort: 22,
};

export function robotConfigPath(profile = process.env.LARK_CHANNEL_PROFILE || 'codex'): string {
  const root = process.env.LARK_CHANNEL_HOME;
  const appPaths = resolveAppPaths({
    profile,
    ...(root ? { rootDir: root } : {}),
  });
  return join(appPaths.profileDir, 'robot.json');
}

export async function loadRobotConfig(profile?: string): Promise<RobotAuthConfig> {
  const path = robotConfigPath(profile);
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<RobotAuthConfig>;
    return {
      rosterBaseUrl: String(raw.rosterBaseUrl || DEFAULTS.rosterBaseUrl).replace(/\/$/, ''),
      sshUser: String(raw.sshUser || DEFAULTS.sshUser),
      sshPort: Number(raw.sshPort || DEFAULTS.sshPort) || 22,
      ...(typeof raw.sshPassword === 'string' && raw.sshPassword
        ? { sshPassword: raw.sshPassword }
        : {}),
      ...(typeof raw.identityFile === 'string' && raw.identityFile
        ? { identityFile: raw.identityFile }
        : {}),
      ...(process.env.LARK_ROBOT_SSH_PASSWORD
        ? { sshPassword: process.env.LARK_ROBOT_SSH_PASSWORD }
        : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Ensure file exists with safe defaults (no password).
      await saveRobotConfig(DEFAULTS, profile);
      return { ...DEFAULTS };
    }
    throw err;
  }
}

export async function saveRobotConfig(
  cfg: RobotAuthConfig,
  profile?: string,
): Promise<string> {
  const path = robotConfigPath(profile);
  const out: RobotAuthConfig = {
    rosterBaseUrl: cfg.rosterBaseUrl.replace(/\/$/, ''),
    sshUser: cfg.sshUser,
    sshPort: cfg.sshPort,
    ...(cfg.sshPassword ? { sshPassword: cfg.sshPassword } : {}),
    ...(cfg.identityFile ? { identityFile: cfg.identityFile } : {}),
  };
  await writeFileAtomic(path, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function publicRobotConfig(cfg: RobotAuthConfig): Record<string, unknown> {
  return {
    rosterBaseUrl: cfg.rosterBaseUrl,
    sshUser: cfg.sshUser,
    sshPort: cfg.sshPort,
    hasPassword: Boolean(cfg.sshPassword),
    identityFile: cfg.identityFile || null,
    configPath: robotConfigPath(),
  };
}

export function robotConfigProblem(cfg: RobotAuthConfig): string | undefined {
  if (!cfg.rosterBaseUrl) return '未配置 rosterBaseUrl（robot.json 或 LARK_ROBOT_ROSTER_URL）。';
  try {
    const url = new URL(cfg.rosterBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'rosterBaseUrl 只支持 http/https。';
    }
  } catch {
    return 'rosterBaseUrl 不是有效 URL。';
  }
  if (!cfg.sshUser) return '未配置 sshUser（robot.json 或 LARK_ROBOT_SSH_USER）。';
  return undefined;
}
