/**
 * Conservative allowlist for commands that may run without a confirmation card.
 * Shell composition and expansion are rejected even when the first command is safe.
 */
export function isClearlyReadOnlyRobotCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || /[;&|><`$(){}\n\r]/.test(cmd)) return false;
  return /^(hostname|uptime|whoami|date|uname(?:\s+-[a-z]+)?|df(?:\s+-[a-z]+)?|free(?:\s+-[a-z]+)?|ps(?:\s+[-a-z0-9 ]+)?|docker\s+(ps|images|inspect|logs|stats)\b|systemctl\s+(status|show|is-active)\b|journalctl\b|tp-status\b|tp-ctl\s+status\b)/i.test(cmd);
}
