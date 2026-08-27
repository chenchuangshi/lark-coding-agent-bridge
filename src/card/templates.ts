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

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  displayId: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
  available?: boolean;
  useNonce?: string;
  archiveNonce?: string;
  unarchiveNonce?: string;
  renameNonce?: string;
}

export function resumeCard(
  cwd: string,
  entries: ResumeEntry[],
  mode: 'active' | 'archived' = 'active',
): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));
  if (mode === 'archived') {
    elements.push(divMd('归档仅从默认列表隐藏，**不会删除本机会话数据**。'));
  }

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd(mode === 'archived' ? '此 cwd 下没有归档会话。' : '此 cwd 下没有历史会话。'));
    elements.push(actions([
      mode === 'archived'
        ? { text: '← 返回历史列表', value: { cmd: 'resume' }, style: 'primary' }
        : { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      ...(mode === 'active'
        ? [{ text: '📦 查看归档', value: { cmd: 'resume.archived' } }]
        : []),
    ]));
    return shell(mode === 'archived' ? '📦 归档的会话' : '🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    const buttons: Array<{ text: string; value: Record<string, unknown>; style?: 'primary' | 'default' | 'danger' }> = [];
    if (e.useNonce) {
      buttons.push({
        text: e.current ? '已是当前会话' : '▸ 恢复此会话',
        value: { cmd: 'resume.use', arg: e.useNonce },
        style: e.current ? 'default' : 'primary',
      });
    }
    if (mode === 'active' && e.archiveNonce) {
      buttons.push({ text: '归档', value: { cmd: 'resume.archive', arg: e.archiveNonce } });
    }
    if (mode === 'archived' && e.unarchiveNonce) {
      buttons.push({ text: '取消归档', value: { cmd: 'resume.unarchive', arg: e.unarchiveNonce } });
    }
    if (e.renameNonce) {
      buttons.push({ text: '重命名', value: { cmd: 'resume.rename', arg: e.renameNonce } });
    }
    if (buttons.length > 0) elements.push(actions(buttons));
    if (i < entries.length - 1) elements.push(HR);
  });

  elements.push(HR);
  elements.push(actions([
    ...(mode === 'active'
      ? [{ text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' as const }]
      : []),
    mode === 'archived'
      ? { text: '← 返回历史列表', value: { cmd: 'resume' }, style: 'primary' }
      : { text: '📦 查看归档', value: { cmd: 'resume.archived' } },
  ]));
  return shell(mode === 'archived' ? '📦 归档的会话' : '🔁 恢复历史会话', elements);
}

export function resumeRenameCard(nonce: string, currentTitle = ''): object {
  return {
    schema: '2.0',
    config: { summary: { content: '重命名会话' } },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'resume_rename_form',
          elements: [
            { tag: 'markdown', content: '✏️ **重命名会话**\n\n输入一个新名称（最多 80 个字符）。' },
            {
              tag: 'input',
              name: 'session_title',
              ...(currentTitle ? { default_value: currentTitle } : {}),
              placeholder: { tag: 'plain_text', content: '例如：修复会话历史' },
              input_type: 'text',
              required: true,
              max_length: 80,
            },
            {
              tag: 'button',
              name: 'submit_btn',
              text: { tag: 'plain_text', content: '保存名称' },
              type: 'primary',
              form_action_type: 'submit',
              behaviors: [{ type: 'callback', value: { cmd: 'resume.rename', arg: nonce } }],
            },
          ],
        },
      ],
    },
  };
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/resume [N]` — 历史会话，可恢复、归档和重命名',
        '- `/resume archived [N]` — 查看归档会话（归档不会删除数据）',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list|save <name>|use <name>|remove <name>` — 工作目录',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好、访问控制和 lark-cli 身份策略',
        '- `/status` — 当前状态',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
        '- `/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
        '- `/ps` — 列出本机所有 bot,标识当前正在回复的那个',
        '- `/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        `- \`/doctor [描述]\` — 把日志和描述交给 ${escapedAgentName} 自助诊断`,
        '- `/help` — 本帮助',
        '- `/robot 57` `/robot status` `/robot write` — 机器人名单 / 只读状态 / 写操作确认',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
