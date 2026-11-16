import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const store = new Map();
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['en-US'] } });
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => vite.close());
const { updateSettings } = await vite.ssrLoadModule('/src/settings.ts');
const { t, tf, localizeError } = await vite.ssrLoadModule('/src/i18n.ts');

test('dynamic messages interpolate without modifying user data', () => {
  updateSettings({ language: 'zh-CN' });
  assert.equal(tf('Delete connection "{name}" and its saved passwords?', { name: 'prod {name}' }), '删除连接“prod {name}”及其已保存的密码？');
  assert.equal(t('SSH login OK'), 'SSH 登录成功');
  assert.equal(tf('Release to move to {group}', { group: 'Demo' }), '松开后移动到 Demo');
  assert.equal(t('Hover over a connection card, then drag its handle to a group on the left.'), '将鼠标移到连接卡片上，再将手柄拖到左侧分组。');
  assert.equal(tf('Delete connection "{name}"? The database is not deleted. Legacy Keychain copies may remain.', { name: 'demo' }), '删除连接“demo”？数据库本身不会被删除，旧版钥匙串副本可能仍会保留。');
  updateSettings({ language: 'ja' });
  assert.equal(tf('Saved {name}', { name: '顧客' }), '顧客 を保存しました');
});

test('backend error gets a localized explanation while original diagnostics stay intact', () => {
  updateSettings({ language: 'zh-TW' });
  const raw = 'Redis connect timed out: server 10.0.0.1';
  const message = localizeError(raw);
  assert.match(message, /Redis 連線逾時/);
  assert.ok(message.includes(raw));
  const dbError = 'ERROR: duplicate key value violates unique constraint';
  assert.ok(localizeError(dbError).includes(dbError));
  updateSettings({ language: 'en' });
  assert.equal(localizeError(raw), raw);
});

test('missing SQLite file and batch actions are localized for every supported language', () => {
  const cases = [
    ['en', 'SQLite database file does not exist', 'Batch test 3 connection(s)'],
    ['zh-CN', 'SQLite 数据库文件不存在', '批量测试 3 个连接'],
    ['zh-TW', 'SQLite 資料庫檔案不存在', '批次測試 3 個連線'],
    ['ja', 'SQLite データベースファイルが存在しません', '3 件の接続を一括テスト'],
  ];
  for (const [language, expectedError, expectedButton] of cases) {
    updateSettings({ language });
    assert.ok(localizeError('SQLite database file does not exist').includes(expectedError));
    assert.equal(tf('Batch test {count} connection(s)', { count: 3 }), expectedButton);
  }
});

test('parallel health check guidance includes the limit in each language', () => {
  const message = 'Required fields are checked locally; credentials are checked only during a connection test. Up to {count} tests run at once and may request Keychain access. Stopping waits for running checks to finish.';
  for (const language of ['en', 'zh-CN', 'zh-TW', 'ja']) {
    updateSettings({ language });
    const translated = tf(message, { count: 4 });
    assert.ok(translated.includes('4'));
    assert.ok(!translated.includes('{count}'));
    if (language !== 'en') assert.notEqual(translated, message.replace('{count}', '4'));
  }
});
