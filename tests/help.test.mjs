import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

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
