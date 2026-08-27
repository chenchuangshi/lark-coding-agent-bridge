export interface RosterAddress {
  ip: string;
  segment?: string;
  iftype?: string;
  ifname?: string;
  signal?: number | null;
  speed?: number | null;
}

export interface RosterDevice {
  serial: string;
  hostname: string;
  alias: string;
  series: string;
  unit: string;
  model: string;
  is_robot: boolean;
  status: 'online' | 'offline' | string;
  primary_ip: string;
  ips: string[];
  addresses: RosterAddress[];
  last_seen?: number;
  first_seen?: number;
}

export interface RobotAuthConfig {
  rosterBaseUrl: string;
  sshUser: string;
  sshPassword?: string;
  sshPort: number;
  identityFile?: string;
}

export interface RobotBindingState {
  /** scope -> machine unit/alias key like "57" */
  activeByScope: Record<string, string>;
}

export interface PendingRobotWrite {
  id: string;
  scope: string;
  machineKey: string;
  host: string;
  command: string;
  reason: string;
  requesterId: string;
  createdAt: number;
  expiresAt: number;
}
