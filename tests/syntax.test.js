// Syntax-checks every script (node --check), so `node --test` alone is the
// whole Verify step and runs the same from cmd, PowerShell or bash.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.join(__dirname, '..', 'scripts');

test('every script parses', () => {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(dir, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
