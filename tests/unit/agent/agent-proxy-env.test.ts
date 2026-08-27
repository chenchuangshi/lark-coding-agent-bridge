import { describe, expect, it } from 'vitest';
import { buildAgentProxyEnv } from '../../../src/agent/agent-proxy-env.js';

describe('agent proxy environment', () => {
  it('maps bridge-specific proxy settings onto agent child variables', () => {
    expect(buildAgentProxyEnv({
      LARK_AGENT_HTTP_PROXY: ' http://proxy.local:8080 ',
      LARK_AGENT_HTTPS_PROXY: 'https://secure-proxy.local:8443',
      LARK_AGENT_NO_PROXY: 'localhost,127.0.0.1',
    })).toEqual({
      HTTP_PROXY: 'http://proxy.local:8080',
      http_proxy: 'http://proxy.local:8080',
      HTTPS_PROXY: 'https://secure-proxy.local:8443',
      https_proxy: 'https://secure-proxy.local:8443',
      ALL_PROXY: 'https://secure-proxy.local:8443',
      all_proxy: 'https://secure-proxy.local:8443',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    });
  });

  it('does not inherit generic proxy variables into agent overrides', () => {
    expect(buildAgentProxyEnv({ HTTPS_PROXY: 'https://ambient.example' })).toEqual({});
  });
});
