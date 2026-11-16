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
