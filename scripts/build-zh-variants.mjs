import { readFile, writeFile } from 'node:fs/promises';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/build-zh-variants.mjs <TSCharacters.txt>');
const entries = new Map();
for (const line of (await readFile(source, 'utf8')).split(/\r?\n/u)) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [key, values] = line.split('\t');
  const value = values?.trim().split(/\s+/u)[0];
  if (!value || [...key].length !== 1 || [...value].length !== 1) throw new Error(`Invalid character entry: ${line}`);
  if (key !== value) entries.set(key, value);
}
const keys = JSON.stringify([...entries.keys()].join(''));
const values = JSON.stringify([...entries.values()].join(''));
await writeFile(new URL('../public/zhVariants.js', import.meta.url), `// Generated from OpenCC TSCharacters.txt (Apache-2.0); first candidate only.
// Regenerate: node scripts/build-zh-variants.mjs <TSCharacters.txt>
const keys = [...${keys}], values = [...${values}];
const variants = new Map(keys.map((key, index) => [key, values[index]]));
export const toSimplified = text => Array.from(text, char => variants.get(char) || char).join('');
`);
