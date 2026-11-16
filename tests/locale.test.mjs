import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocale } from '../src/locale.ts';

test('resolves supported system languages and scripts', () => {
  assert.equal(resolveLocale('system', ['zh-Hans-CN']), 'zh-CN');
  assert.equal(resolveLocale('system', ['zh-Hant', 'en-US']), 'zh-TW');
  assert.equal(resolveLocale('system', ['zh-HK']), 'zh-TW');
  assert.equal(resolveLocale('system', ['ja-JP']), 'ja');
  assert.equal(resolveLocale('system', ['fr-FR', 'en-US']), 'en');
  assert.equal(resolveLocale('system', ['fr-FR']), 'en');
});

test('explicit choice overrides system and invalid choice falls back to English', () => {
  assert.equal(resolveLocale('ja', ['zh-CN']), 'ja');
  assert.equal(resolveLocale('en', ['ja-JP']), 'en');
  assert.equal(resolveLocale('invalid', ['ja-JP']), 'en');
});
