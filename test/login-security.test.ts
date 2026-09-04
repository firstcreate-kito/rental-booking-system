import { describe, it, expect } from 'vitest';
import { isLoginLocked, LOGIN_MAX_FAILS_EMAIL, LOGIN_MAX_FAILS_IP } from '../src/lib/login-throttle';
import { turnstileEnabled, turnstileSiteKey, verifyTurnstile } from '../src/lib/turnstile';

describe('isLoginLocked（ログイン回数制限）', () => {
  it('メール失敗が上限未満・IPも未満なら未ロック', () => {
    expect(isLoginLocked(LOGIN_MAX_FAILS_EMAIL - 1, LOGIN_MAX_FAILS_IP - 1)).toBe(false);
  });
  it('メール失敗が上限以上でロック', () => {
    expect(isLoginLocked(LOGIN_MAX_FAILS_EMAIL, 0)).toBe(true);
  });
  it('IP失敗が上限以上でロック（共有回線からの総当たり）', () => {
    expect(isLoginLocked(0, LOGIN_MAX_FAILS_IP)).toBe(true);
  });
});

describe('turnstile（CAPTCHA）', () => {
  it('SECRET未設定なら無効・検証は素通り', async () => {
    expect(turnstileEnabled({})).toBe(false);
    expect(turnstileSiteKey({})).toBe('');
    // 未設定時は token 無しでも true（＝導入前は既存フローを止めない）
    expect(await verifyTurnstile({}, '')).toBe(true);
  });
  it('SECRET設定済みなら有効・トークン空は false', async () => {
    expect(turnstileEnabled({ TURNSTILE_SECRET_KEY: 'x' })).toBe(true);
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: 'x' }, '')).toBe(false);
  });
});
