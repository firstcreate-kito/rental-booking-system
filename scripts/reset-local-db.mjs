// ローカルD1の状態を削除する（クロスプラットフォーム）。
// Windows/Mac/Linux いずれでも動くよう Node の fs を使用。
import { rmSync } from 'node:fs';

rmSync('.wrangler/state/v3/d1', { recursive: true, force: true });
console.log('ローカルD1の状態をクリアしました');
