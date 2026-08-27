/**
 * Proxy env for agent CLI children only (Codex/Claude).
 * Bridge/Feishu should stay direct; set LARK_AGENT_* on the systemd unit
 * instead of HTTP(S)_PROXY on the bridge process.
 */
export function buildAgentProxyEnv(
  from: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const http = nonEmpty(from.LARK_AGENT_HTTP_PROXY) ?? nonEmpty(from.LARK_AGENT_HTTPS_PROXY);
  const https = nonEmpty(from.LARK_AGENT_HTTPS_PROXY) ?? nonEmpty(from.LARK_AGENT_HTTP_PROXY);
  const all = nonEmpty(from.LARK_AGENT_ALL_PROXY) ?? https ?? http;
  const noProxy = nonEmpty(from.LARK_AGENT_NO_PROXY);

  const out: NodeJS.ProcessEnv = {};
  if (http) {
    out.HTTP_PROXY = http;
    out.http_proxy = http;
  }
  if (https) {
    out.HTTPS_PROXY = https;
    out.https_proxy = https;
  }
  if (all) {
    out.ALL_PROXY = all;
    out.all_proxy = all;
  }
  if (noProxy) {
    out.NO_PROXY = noProxy;
    out.no_proxy = noProxy;
  }
  return out;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
