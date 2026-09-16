'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { recoveryBase, HASH } = require('../ember.cjs');
test('standalone output needs no tool Git or ignore rule; preserves versions and existing files', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-output-test-'));
  const root = path.join(sandbox, 'target'), destination = path.join(sandbox, 'output'), tool = path.join(sandbox, 'tool');
  for (const dir of [root, destination, tool]) fs.mkdirSync(dir);
  const original = path.join(root, 'source.cjs'); fs.writeFileSync(original, 'C');
  const sentinel = path.join(destination, 'keep.txt'); fs.writeFileSync(sentinel, 'untouched');
  fs.copyFileSync(require.resolve('../ember.cjs'), path.join(tool, 'ember.cjs'));
  const standalone = require(path.join(tool, 'ember.cjs')), report = { root, rows: [], summary: { rescueCandidates: 2 } };
  const rows = ['A', 'B'].map((source, i) => ({ pid: 100 + i, scriptId: '1', path: 'source.cjs', status: 'MEMORY_ONLY_VS_DISK_HEAD_INDEX', sourceSha256: HASH(source), source }));
  rows.push({ ...rows[0], status: 'IN_SYNC' }, { ...rows[0], status: 'DISK_UNREADABLE' });
  const first = standalone.saveRecovery(report, rows, destination), second = standalone.saveRecovery(report, rows, destination);
  assert.notEqual(first.output, second.output); assert.equal(first.saved.length, 2);
  assert.equal(new Set(first.saved.map(r => r.filename)).size, 2);
  for (const r of first.saved) assert.equal(HASH(fs.readFileSync(path.join(first.output, r.filename))), r.sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.output, 'manifest.json'))).saved, first.saved);
  assert.equal(fs.readFileSync(original, 'utf8'), 'C'); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  const automatic = standalone.saveRecovery(report, []);
  assert.equal(path.dirname(automatic.output), fs.realpathSync(os.tmpdir())); assert.equal(automatic.saved.length, 0);
  assert.equal(fs.existsSync(path.join(tool, 'recovered')), false); assert.equal(fs.existsSync(path.join(tool, '.git')), false);
});
test('invalid output parents and a junction into the target are rejected', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-output-boundary-')), root = path.join(sandbox, 'target'), child = path.join(root, 'nested'); fs.mkdirSync(child, { recursive: true });
  assert.throws(() => recoveryBase(root, root), /outside/); assert.throws(() => recoveryBase(root, child), /outside/);
  assert.throws(() => recoveryBase(root, __dirname), /outside/);
  assert.throws(() => recoveryBase(root, path.join(sandbox, 'missing')), /ENOENT/);
  const file = path.join(sandbox, 'file'); fs.writeFileSync(file, 'x'); assert.throws(() => recoveryBase(root, file), /existing directory/);
  const alias = path.join(sandbox, 'alias'); fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => recoveryBase(root, alias), /outside/);
});
test('CLI rejects missing, duplicate and scan-only output flags before discovery', () => {
  for (const args of [['rescue', '--output'], ['rescue', '--output', 'a', '--output', 'b'], ['scan', '--output', os.tmpdir()]]) {
    const r = spawnSync(process.execPath, [require.resolve('../ember.cjs'), ...args], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /output|Usage/);
  }
});
