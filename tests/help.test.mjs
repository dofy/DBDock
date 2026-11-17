import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { HEALTH_CHECK_CONCURRENCY } from '../src/healthCheckQueue.ts';

const ids = ['start', 'connections', 'import', 'ssh', 'ssh-hosts', 'sql', 'redis', 'mongodb', 'vim', 'shortcuts', 'data', 'trouble'];
for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
  test(`${locale} help covers every section`, async () => {
    const help = JSON.parse(await readFile(new URL(`../public/help.${locale}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(help.sections), ids);
    assert.equal(help.labels.length, 4);
    for (const id of ids) {
      assert.ok(help.sections[id].title.trim(), `${id}: title`);
      assert.ok(help.sections[id].html.includes('<p>'), `${id}: body`);
    }
  });
}

test('offline translation script matches the language resources', async () => {
  const script = await readFile(new URL('../public/help.translations.js', import.meta.url), 'utf8');
  const context = { window: {} };
  runInNewContext(script, context);
  for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
    const resource = JSON.parse(await readFile(new URL(`../public/help.${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(JSON.stringify(context.window.DBDOCK_HELP_TRANSLATIONS[locale]), JSON.stringify(resource));
  }
  const html = await readFile(new URL('../public/help.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="help\.translations\.js"><\/script>/);
  assert.doesNotMatch(html, /<script type="module">/);
  assert.doesNotMatch(html, /dbdock\.help-language|id="help-language"/);
  assert.match(html, /localStorage\.getItem\("dbdock\.settings"\)/);
});

test('help documents batch health checks and drag handles in each language', async () => {
  const english = await readFile(new URL('../public/help.html', import.meta.url), 'utf8');
  assert.match(english, /<h3>Connection health<\/h3>/);
  assert.match(english, /drag the handle/);
  assert.match(english, /up to four tests at once/);
  assert.equal(HEALTH_CHECK_CONCURRENCY, 4);
  for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
    const help = JSON.parse(await readFile(new URL(`../public/help.${locale}.json`, import.meta.url), 'utf8'));
    const section = help.sections.connections.html;
    assert.match(section, /<h3>[^<]*(?:健康檢查|健康检查|ヘルスチェック)<\/h3>/);
    assert.match(section, /(?:手柄|把手|ハンドル)/);
    assert.match(section, /4/);
  }
});

test('keyboard shortcuts use matching tables in every language', async () => {
  const english = await readFile(new URL('../public/help.html', import.meta.url), 'utf8');
  const section = english.match(/<section id="shortcuts"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  const keys = (html) => [...html.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((match) => match[1]);
  const expected = keys(section);
  assert.ok(expected.includes('⇧⌘P'));
  assert.ok(expected.includes('⌃1–9'));
  assert.ok(expected.includes('⌘1–9'));
  assert.ok(expected.includes('⇧⌘↵'));
  for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
    const help = JSON.parse(await readFile(new URL(`../public/help.${locale}.json`, import.meta.url), 'utf8'));
    const html = help.sections.shortcuts.html;
    assert.match(html, /<table><thead>/);
    assert.match(html, /<th scope="col">/);
    assert.deepEqual(keys(html), expected, `${locale}: shortcuts`);
    assert.equal((html.match(/<tr>/g) || []).length, (section.match(/<tr>/g) || []).length);
  }
});

test('help takes its version from package.json instead of hard-coding it', async () => {
  const html = await readFile(new URL('../public/help.html', import.meta.url), 'utf8');
  assert.equal(html.match(/%APP_VERSION%/g)?.length, 2);
  assert.doesNotMatch(html, /Help · \d|DBDock \d/);
});
