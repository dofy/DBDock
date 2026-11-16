import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
