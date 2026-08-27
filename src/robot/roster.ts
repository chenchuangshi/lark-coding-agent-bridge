import type { RosterDevice } from './types';

export async function fetchRosterDevices(
  baseUrl: string,
  opts: { q?: string; robot?: boolean; status?: string } = {},
): Promise<RosterDevice[]> {
  const url = new URL('/api/devices', baseUrl.replace(/\/$/, ''));
  if (opts.robot !== false) url.searchParams.set('robot', '1');
  if (opts.q) url.searchParams.set('q', opts.q);
  if (opts.status) url.searchParams.set('status', opts.status);

  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    throw new Error(`Roster HTTP ${res.status} for ${url}`);
  }
  const data = (await res.json()) as { devices?: RosterDevice[] };
  return data.devices ?? [];
}

export async function fetchRosterStats(baseUrl: string): Promise<Record<string, unknown>> {
  const url = new URL('/api/stats', baseUrl.replace(/\/$/, ''));
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Roster stats HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Extract machine number tokens from free text: 57 / 57号 / kitt-57 / kitt15-057 */
export function extractMachineKeys(text: string): string[] {
  const keys = new Set<string>();
  const patterns = [
    /\bkitt\s*-?\s*(\d{1,4})\b/gi,
    /\bkitt15\s*-?\s*0*(\d{1,4})\b/gi,
    /(\d{1,4})\s*号(?:机器|机)?/g,
    /(?:去|到|连|看|查)\s*(\d{1,4})\s*号/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = Number.parseInt(m[1] ?? '', 10);
      if (Number.isFinite(n)) keys.add(String(n));
    }
  }
  // bare "/robot 57" style already handled by commands; also allow "机器57"
  for (const m of text.matchAll(/机器\s*(\d{1,4})\b/g)) {
    const n = Number.parseInt(m[1] ?? '', 10);
    if (Number.isFinite(n)) keys.add(String(n));
  }
  return [...keys];
}

export function normalizeMachineKey(input: string): string | undefined {
  const s = input.trim();
  if (!s) return undefined;
  const m =
    s.match(/^kitt-?(\d{1,4})$/i) ||
    s.match(/^kitt15-?0*(\d{1,4})$/i) ||
    s.match(/^(\d{1,4})号?$/) ||
    s.match(/^0*(\d{1,4})$/);
  if (!m?.[1]) return undefined;
  return String(Number.parseInt(m[1], 10));
}

function unitNumber(unit: string): string | undefined {
  const m = unit.trim().match(/^0*(\d{1,4})/);
  if (!m?.[1]) return undefined;
  return String(Number.parseInt(m[1], 10));
}

function aliasNumber(alias: string): string | undefined {
  const m = alias.trim().match(/kitt-?(\d{1,4})$/i);
  if (!m?.[1]) return undefined;
  return String(Number.parseInt(m[1], 10));
}

function hostnameNumber(hostname: string): string | undefined {
  const m = hostname.trim().match(/kitt15-0*(\d{1,4})/i);
  if (!m?.[1]) return undefined;
  return String(Number.parseInt(m[1], 10));
}

export function deviceMatchesKey(device: RosterDevice, key: string): boolean {
  const want = normalizeMachineKey(key);
  if (!want) return false;
  return (
    unitNumber(device.unit || '') === want ||
    aliasNumber(device.alias || '') === want ||
    hostnameNumber(device.hostname || '') === want
  );
}

export type ResolveResult =
  | { ok: true; key: string; device: RosterDevice; candidates: RosterDevice[] }
  | { ok: false; key: string; reason: string; candidates: RosterDevice[] };

export async function resolveMachine(
  baseUrl: string,
  rawKey: string,
): Promise<ResolveResult> {
  const key = normalizeMachineKey(rawKey);
  if (!key) {
    return { ok: false, key: rawKey, reason: `无法解析机器号：${rawKey}`, candidates: [] };
  }

  // Broad search then precise filter (API q=57 can return fuzzy hits).
  const devices = await fetchRosterDevices(baseUrl, { q: key, robot: true });
  const exact = devices.filter((d) => deviceMatchesKey(d, key));
  const pool = exact.length > 0 ? exact : devices.filter((d) => deviceMatchesKey(d, key));

  // If API returned unrelated fuzzy hits only, try fetching all robots and filter locally.
  let candidates = pool;
  if (candidates.length === 0) {
    const all = await fetchRosterDevices(baseUrl, { robot: true });
    candidates = all.filter((d) => deviceMatchesKey(d, key));
  }

  if (candidates.length === 0) {
    return { ok: false, key, reason: `名单中未找到 ${key} 号机器`, candidates: [] };
  }

  // Prefer online with a primary_ip.
  const ranked = [...candidates].sort((a, b) => scoreDevice(b) - scoreDevice(a));
  const best = ranked[0]!;
  if (ranked.length > 1 && scoreDevice(ranked[0]!) === scoreDevice(ranked[1]!)) {
    // Ambiguous equals — still return best but keep candidates for UI.
  }
  return { ok: true, key, device: best, candidates: ranked };
}

function scoreDevice(d: RosterDevice): number {
  let s = 0;
  if (d.status === 'online') s += 100;
  if (d.primary_ip) s += 20;
  if (d.is_robot) s += 5;
  return s;
}

export function formatDeviceBrief(d: RosterDevice): string {
  const ip = d.primary_ip || (d.ips?.[0] ?? '(无IP)');
  return `${d.alias || d.hostname} · ${ip} · ${d.status}`;
}
