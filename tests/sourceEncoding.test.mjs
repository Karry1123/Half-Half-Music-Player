import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function javascriptFiles(directory, recursive = false) {
  if (directory instanceof URL) directory = fileURLToPath(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => entry.isDirectory()
    ? recursive ? javascriptFiles(path.join(directory, entry.name), true) : []
    : entry.name.endsWith('.js') ? [path.join(directory, entry.name)] : []));
  return groups.flat();
}

// Delimiters distinguish damaged UI strings/markup from optional chaining and ternaries.
const damagedText = /['"`>]\s*\?{3,}/;
test('UI and service sources retain UTF-8 text instead of question-mark replacements', async () => {
  const root = new URL('../', import.meta.url);
  const files = [
    ...await javascriptFiles(new URL('public/', root)),
    ...await javascriptFiles(new URL('music-service/src/', root), true),
    new URL('public/dashboard.html', root),
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.equal(damagedText.test(source), false, `Question-mark replacement text in ${file}`);
    assert.equal(source.includes('\uFFFD'), false, `Invalid UTF-8 in ${file}`);
  }
});

test('encoding guard permits JavaScript operators and rejects damaged labels', () => {
  for (const source of ['value?.title ?? ""', 'ok ? "yes" : "no"']) assert.equal(damagedText.test(source), false);
  for (const source of ['"???"', "'????label'", '`???`', '<span>????</span>']) assert.equal(damagedText.test(source), true);
});
