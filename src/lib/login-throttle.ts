/**
 * ログイン試行のレート制限パラメータ（総当たり・クレデンシャルスタッフィング対策）。
 * メール単位・IP単位の両方で数え、いずれかが上限を超えたらロックする。
 */
export const LOGIN_WINDOW_MIN = 15; // 集計ウィンドウ（分）
export const LOGIN_MAX_FAILS_EMAIL = 5; // 同一メールの連続失敗の上限（15分）
export const LOGIN_MAX_FAILS_IP = 20; // 同一IPの失敗の上限（15分・共有回線を考慮しやや広め）

/** 上限に達しているか（メール失敗数・IP失敗数のどちらかが上限以上） */
export function isLoginLocked(emailFails: number, ipFails: number): boolean {
  return emailFails >= LOGIN_MAX_FAILS_EMAIL || ipFails >= LOGIN_MAX_FAILS_IP;
}

export const LOGIN_LOCK_MESSAGE = `ログインの試行回数が上限に達しました。約${LOGIN_WINDOW_MIN}分後に再度お試しください。パスワードをお忘れの場合は再設定をご利用ください。`;
