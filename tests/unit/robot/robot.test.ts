import { describe, expect, it } from 'vitest';
import { robotConfigProblem } from '../../../src/robot/config.js';
import { isClearlyReadOnlyRobotCommand } from '../../../src/robot/read-only.js';
import { extractMachineKeys, normalizeMachineKey } from '../../../src/robot/roster.js';

describe('robot safety helpers', () => {
  it('normalizes and extracts supported machine references', () => {
    expect(normalizeMachineKey('kitt15-0057')).toBe('57');
    expect(extractMachineKeys('去57号机器看 docker，再查 kitt-69')).toEqual(['69', '57']);
  });

  it('allows known read-only commands and rejects shell composition or writes', () => {
    expect(isClearlyReadOnlyRobotCommand('docker ps')).toBe(true);
    expect(isClearlyReadOnlyRobotCommand('systemctl status bridge')).toBe(true);
    expect(isClearlyReadOnlyRobotCommand('docker ps; reboot')).toBe(false);
    expect(isClearlyReadOnlyRobotCommand('rm -rf /tmp/example')).toBe(false);
    expect(isClearlyReadOnlyRobotCommand('curl https://example.com')).toBe(false);
  });

  it('requires machine-local roster and SSH identity configuration', () => {
    expect(robotConfigProblem({ rosterBaseUrl: '', sshUser: '', sshPort: 22 })).toContain('rosterBaseUrl');
    expect(robotConfigProblem({ rosterBaseUrl: 'ftp://example.com', sshUser: 'robot', sshPort: 22 })).toContain('http/https');
    expect(robotConfigProblem({ rosterBaseUrl: 'https://roster.example.com', sshUser: '', sshPort: 22 })).toContain('sshUser');
    expect(robotConfigProblem({ rosterBaseUrl: 'https://roster.example.com', sshUser: 'robot', sshPort: 22 })).toBeUndefined();
  });
});
