/** Classify SDK errors without exposing server messages, request frames, IDs or credentials. */
export function wecomDiagnostic(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message.startsWith('Authentication failed:')) {
    const code = /\(code: (-?\d+)\)$/.exec(message)?.[1];
    return `认证被企微拒绝${code ? `（错误码 ${code}）` : ''}：核对机器人类型、Bot ID 和重置后的 Secret 是否属于同一机器人。`;
  }
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'WS_AUTH_FAILURE_EXHAUSTED') return '认证重试次数耗尽：核对机器人类型、Bot ID 和重置后的 Secret 是否属于同一机器人。';
  if (code === 'WS_RECONNECT_EXHAUSTED') return '网络重连次数耗尽：核对本机网络、代理、证书和 DNS。';
  if (/^(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(code)) {
    return `连接失败（${code}）：核对网络、代理、证书和 DNS。`;
  }
  return '连接失败（未能安全识别类型）：检查本机网络与机器人配置，不要分享原始错误对象或 Secret。';
}
