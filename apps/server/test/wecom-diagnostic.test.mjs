import assert from 'node:assert/strict';
import test from 'node:test';
import { wecomDiagnostic } from '../../../scripts/wecom-diagnostic.mjs';

test('WeCom discovery reports authentication code or network category without credential or server details', () => {
  const secret = 'private-secret-must-not-leak';
  const auth = wecomDiagnostic(new Error(`Authentication failed: ${secret} (code: 401)`));
  assert.match(auth, /认证被企微拒绝.*401/);
  assert.doesNotMatch(auth, /private-secret/);
  assert.match(wecomDiagnostic(Object.assign(new Error(secret), { code: 'ETIMEDOUT' })), /ETIMEDOUT/);
  assert.doesNotMatch(wecomDiagnostic(Object.assign(new Error(secret), { code: 'ETIMEDOUT' })), /private-secret/);
  assert.doesNotMatch(wecomDiagnostic(new Error(secret)), /private-secret/);
  for (const [code, category] of [['WS_AUTH_FAILURE_EXHAUSTED', /认证重试次数耗尽/], ['WS_RECONNECT_EXHAUSTED', /网络重连次数耗尽/]]) {
    const diagnostic = wecomDiagnostic(Object.assign(new Error(secret), { code }));
    assert.match(diagnostic, category);
    assert.doesNotMatch(diagnostic, /private-secret/);
  }
});
