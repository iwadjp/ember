#!/usr/bin/env node
'use strict';
// Synthetic public demo. Every process here is one this script starts itself,
// inside a throwaway temporary Git repository. Ember never attaches to, and
// this script never reads from, any pre-existing process on the machine.
// Cleanup only ever kills the processes this script itself forked.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const { run, HASH } = require('../ember.cjs');
const { makeRepo } = require('../test/helpers.cjs');

const workload = path.join(__dirname, '..', 'test', 'fixtures', 'workload.cjs');

async function ready(child) {
  const [message] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('workload exited before ready'); }),
  ]);
  return message;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function scenarioPreInspected(root) {
  const file = path.join(root, 'pre-inspected.js');
  const original = "module.exports=()=>({version:'original-pre-inspected'});\n";
  fs.writeFileSync(file, original);
  const child = fork(workload, [file], { cwd: root, execArgv: ['--inspect=127.0.0.1:0'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  try {
    child.stderr.resume();
    await ready(child);
    fs.writeFileSync(file, "module.exports=()=>({version:'overwritten-on-disk'});\n");
    const report = await run({ cwd: root, rescue: true, selectedPids: [child.pid] });
    const row = report.recovery.saved.find(r => r.pid === child.pid && r.path.endsWith('pre-inspected.js'));
    assert.ok(row, 'expected a rescued row for the pre-inspected target');
    const recoveredHash = HASH(fs.readFileSync(path.join(report.recovery.output, row.filename)));
    const diskHash = HASH(fs.readFileSync(file, 'utf8'));
    assert.equal(recoveredHash, HASH(original), 'recovered text must match the original version');
    assert.notEqual(diskHash, HASH(original), 'disk must still hold the overwrite');
    assert.notEqual(recoveredHash, diskHash, 'recovered and disk hashes must differ');
    record('A. pre-inspected rescue', true, `recovered=${recoveredHash.slice(0, 12)} disk=${diskHash.slice(0, 12)}`);
  } finally {
    child.kill();
  }
}

async function scenarioPlainActivation(root) {
  const file = path.join(root, 'plain.js');
  const source = "module.exports=()=>({version:'plain-activation-token'});\n";
  fs.writeFileSync(file, source);
  const child = fork(workload, [file], { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  try {
    child.stderr.resume();
    await ready(child);
    const before = await run({ cwd: root, activateInspector: false, selectedPids: [child.pid] });
    assert.ok(!before.rows.some(r => r.pid === child.pid), 'default run must not activate or see a plain process');
    const after = await run({ cwd: root, activateInspector: true, selectedPids: [child.pid] });
    const row = after.rows.find(r => r.pid === child.pid && r.path.endsWith('plain.js'));
    assert.ok(row, 'plain process must be recovered once --activate-inspector opts in');
    assert.equal(row.sourceSha256, HASH(source), 'recovered hash must match the source exactly');
    record('B. plain Node --pid --activate-inspector rescue', true, `hash=${row.sourceSha256.slice(0, 12)}`);
  } finally {
    child.kill();
  }
}

async function scenarioMultiVersion(root) {
  const file = path.join(root, 'multi.js');
  const variants = [
    "module.exports=()=>({version:'A'});\n",
    "module.exports=()=>({version:'B'});\n",
  ];
  const children = [];
  try {
    for (const source of variants) {
      fs.writeFileSync(file, source);
      const child = fork(workload, [file], { cwd: root, execArgv: ['--inspect=127.0.0.1:0'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
      children.push(child);
      child.stderr.resume();
      await ready(child);
    }
    fs.writeFileSync(file, "module.exports=()=>({version:'C-on-disk'});\n");
    const report = await run({ cwd: root, rescue: true, selectedPids: children.map(c => c.pid) });
    const saved = report.recovery.saved.filter(r => r.path.endsWith('multi.js'));
    assert.equal(saved.length, 2, 'both process versions must be rescued separately');
    assert.deepEqual(new Set(saved.map(r => r.sha256)), new Set(variants.map(HASH)));
    assert.equal(new Set(saved.map(r => r.filename)).size, 2, 'each version must get its own filename');
    const diskHash = HASH(fs.readFileSync(file, 'utf8'));
    assert.ok(!saved.some(r => r.sha256 === diskHash), 'neither rescued version may equal the current disk content');
    record('C. multi-version rescue', true, `saved=${saved.map(r => r.sha256.slice(0, 8)).join(',')} disk=${diskHash.slice(0, 8)}`);
  } finally {
    for (const child of children) child.kill();
  }
}

async function scenarioNegative(root) {
  const dying = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: root, windowsHide: true });
  await new Promise(r => setTimeout(r, 400));
  const deadPid = dying.pid;
  dying.kill();
  await once(dying, 'exit');
  await new Promise(r => setTimeout(r, 200));
  const report = await run({ cwd: root, activateInspector: true, selectedPids: [deadPid] });
  const failed = report.activation.failed.some(f => f.pid === deadPid);
  const activated = report.activation.activatedPids.includes(deadPid);
  assert.ok(failed, 'an already-exited PID must be reported as a failure');
  assert.ok(!activated, 'an already-exited PID must never be reported as activated');
  record('D. negative case (exited PID)', failed && !activated, `failed=${failed} activated=${activated}`);
}

async function main() {
  const root = makeRepo('ember-demo-repo-');
  console.log(`Synthetic demo repository: ${root}`);
  await scenarioPreInspected(root);
  await scenarioPlainActivation(root);
  await scenarioMultiVersion(root);
  await scenarioNegative(root);
  const failures = results.filter(r => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} scenarios PASS`);
  if (failures.length) process.exitCode = 1;
}

main().catch(e => { console.error('Demo failed: ' + e.stack); process.exitCode = 1; });
