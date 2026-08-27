import type { RosterDevice } from './types';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}

export function robotActiveCard(info: {
  key: string;
  device: RosterDevice;
  host: string;
}): object {
  const d = info.device;
  const lines = [
    `🎯 **当前机器**: \`${escapeCode(info.key)}\` 号`,
    `📛 **别名**: ${escapeMd(d.alias || d.hostname || '-')}`,
    `🖥 **hostname**: \`${escapeCode(d.hostname || '-')}\``,
    `🌐 **IP**: \`${escapeCode(info.host)}\``,
    `📶 **状态**: ${escapeMd(d.status)}`,
    `🧩 **unit / series**: \`${escapeCode(d.unit || '-')}\` / ${escapeMd(d.series || '-')}`,
  ];
  return shell('🤖 机器人已绑定', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '只读状态', value: { cmd: 'robot.status' }, style: 'primary' },
      { text: '解绑', value: { cmd: 'robot.clear' }, style: 'danger' },
    ]),
  ]);
}

export function robotCandidatesCard(key: string, candidates: RosterDevice[]): object {
  const elements: object[] = [
    divMd(`找到多台匹配 **${escapeMd(key)}** 的机器，请选择：`),
    HR,
  ];
  candidates.slice(0, 8).forEach((d, i) => {
    const ip = d.primary_ip || d.ips?.[0] || '';
    const ipLabel = ip || '(无IP)';
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(d.alias || d.hostname)}\n\`${escapeCode(ipLabel)}\` · ${escapeMd(d.status)} · unit \`${escapeCode(d.unit || '-')}\``,
      ),
    );
    const pickArg = ip ? `${key}@${ip}` : key;
    elements.push(
      actions([
        {
          text: `选用 ${d.alias || d.hostname}`,
          value: { cmd: 'robot.use', arg: pickArg },
          style: 'primary',
        },
      ]),
    );
    if (i < Math.min(candidates.length, 8) - 1) elements.push(HR);
  });
  return shell('🤖 选择机器人', elements);
}

export function robotWriteConfirmCard(info: {
  ticketId: string;
  machineKey: string;
  host: string;
  reason: string;
  command: string;
}): object {
  const lines = [
    `⚠️ **写操作需确认后才会 SSH 执行**`,
    '',
    `🎯 **机器**: \`${escapeCode(info.machineKey)}\` @ \`${escapeCode(info.host)}\``,
    `📝 **原因**: ${escapeMd(info.reason)}`,
    '',
    '**将执行的命令**:',
    `\`\`\`\n${escapeCode(info.command)}\n\`\`\``,
    '',
    '_10 分钟内有效；仅申请人可点同意。_',
  ];
  return shell('🛡 机器人写操作确认', [
    divMd(lines.join('\n')),
    HR,
    actions([
      {
        text: '同意执行',
        value: { cmd: 'robot.approve', arg: info.ticketId },
        style: 'danger',
      },
      {
        text: '取消',
        value: { cmd: 'robot.deny', arg: info.ticketId },
        style: 'default',
      },
    ]),
  ]);
}

export function robotListCard(
  devices: Array<{ key: string; device: RosterDevice; host: string }>,
  activeKey?: string,
): object {
  const elements: object[] = [];
  if (devices.length === 0) {
    elements.push(divMd('名单里没有机器人设备。'));
  } else {
    devices.slice(0, 20).forEach((row, i) => {
      const marker = row.key === activeKey ? '  ← 当前会话' : '';
      elements.push(
        divMd(
          `**${escapeMd(row.key)}** ${escapeMd(row.device.alias || row.device.hostname)}${marker}\n\`${escapeCode(row.host)}\` · ${escapeMd(row.device.status)}`,
        ),
      );
      elements.push(
        actions([
          {
            text: '绑定',
            value: { cmd: 'robot.use', arg: row.key },
            style: 'primary',
          },
          { text: '状态', value: { cmd: 'robot.status', arg: row.key } },
        ]),
      );
      if (i < Math.min(devices.length, 20) - 1) elements.push(HR);
    });
  }
  return shell('🤖 机器人名单（节选）', elements);
}
