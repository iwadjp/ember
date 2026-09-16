'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const ember = require('../ember.cjs');

test('activation requires explicit PIDs before discovery or Git access', async () => {
  await assert.rejects(ember.run({ cwd: 'missing', activateInspector: true }), /requires explicit --pid/);
  await assert.rejects(ember.run({ selectedPids: [process.pid] }), /non-self/);
  await assert.rejects(ember.run({ selectedPids: [-1] }), /Invalid PID/);
  await assert.rejects(ember.run({ selectedPids: [] }), /Select 1/);
});
test('path text never grants activation; only explicit PID selection does', () => {
  for (const root of ['C:\\fixture\\repo', 'C:\\fixture\\repo-old', 'C:\\fixture\\repo-copy']) {
    assert.deepEqual(ember.discoverPlainPids(root, []), []);
    assert.deepEqual(ember.discoverPlainPids(root, [202], [101, 202, 101, process.pid]), [101]);
  }
  assert.throws(() => ember.discoverPlainPids('unused', [], ['101']), /Invalid PID/);
});
test('self PID cannot be signalled through either low-level guard', () => {
  assert.equal(ember.verifyPlainNodeTarget(process.pid), 'SELF');
  assert.deepEqual(ember.activateInspectorSignal(process.pid), { ok: false, error: 'SELF' });
});
test('query failure and access denied are failures, not missing or activation success (injected)', () => {
  const module = { exports: {} };
  const mockRequire = name => name === 'node:child_process' ? { execFileSync() { throw new Error('Access is denied'); } } : require(name);
  vm.runInNewContext(fs.readFileSync(require.resolve('../ember.cjs'), 'utf8'), { require: mockRequire, module, exports: module.exports, process, console, WebSocket, URL, Buffer, setTimeout, clearTimeout, __dirname: require('node:path').dirname(require.resolve('../ember.cjs')) });
  assert.equal(module.exports.verifyPlainNodeTarget(999999), 'QUERY_FAILED');
  const signal = module.exports.activateInspectorSignal(999999);
  assert.equal(signal.ok, false); assert.match(signal.error, /Access is denied/);
});
