/**
 * Runs the compiled unit tests on any Node from 18 up.
 *
 * `node --test "dir/*.test.js"` only expands globs from Node 21, and
 * `node --test dir` behaves differently again across versions — so the file
 * list is built here and passed explicitly. One less thing to be surprised by
 * on a machine with a different runtime than the one it was written on.
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dir = join('out-test', 'test');

if (!existsSync(dir)) {
  console.error(`No compiled tests in ${dir}. Run: npx tsc -p tsconfig.test.json`);
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(dir, name));

if (files.length === 0) {
  console.error(`No *.test.js files in ${dir}.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
