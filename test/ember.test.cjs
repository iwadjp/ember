'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const { run, HASH, verifyPlainNodeTarget, activateInspectorSignal, pollNewListener, queryListenersForPid } = require('../ember.cjs');
const { makeRepo } = require('./helpers.cjs');
const workload = path.join(__dirname, 'fixtures', 'workload.cjs');

async function ready(child) {
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('workload exited before ready'); }),
  ]);
}

test('two live processes retain two distinct versions of one path', { timeout: 30000 }, async () => {
  const root = makeRepo();
  const file = path.join(root, 'presenter.js');
  const variants = [
    "module.exports=()=>({version:'A',widgets:3});\n",
    "module.exports=()=>({version:'B',widgets:7});\n",
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
    const saved = report.recovery.saved.filter(r => r.path.endsWith('presenter.js') && children.some(c => c.pid === r.pid));
    assert.equal(saved.length, 2);
    assert.deepEqual(new Set(saved.map(r => r.sha256)), new Set(variants.map(HASH)));
    assert.equal(new Set(saved.map(r => r.filename)).size, 2);
    for (const entry of saved) assert.equal(HASH(fs.readFileSync(path.join(report.recovery.output, entry.filename))), entry.sha256);
    assert.ok(fs.readFileSync(file, 'utf8').includes('C-on-disk'));
  } finally {
    for (const child of children) child.kill();
  }
});

test('plain Node process is invisible by default; --activate-inspector opts in and recovers a byte-exact source', { timeout: 30000 }, async () => {
  const root = makeRepo();
  const file = path.join(root, 'presenter.js');
  const source = "module.exports=()=>({version:'plain-activation-token'});\n";
  fs.writeFileSync(file, source);
  const child = fork(workload, [file], { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  try {
    child.stderr.resume();
    await ready(child);
    const before = await run({ cwd: root, activateInspector: false, selectedPids: [child.pid] });
    assert.ok(!before.rows.some(r => r.pid === child.pid), 'plain process must not appear without --activate-inspector');
    assert.equal(before.activation.requested, false);
    const after = await run({ cwd: root, activateInspector: true, selectedPids: [child.pid] });
    assert.ok(after.activation.activatedPids.includes(child.pid), 'activation must report this pid as activated');
    const row = after.rows.find(r => r.pid === child.pid && r.path.endsWith('presenter.js'));
    assert.ok(row, 'plain process source must be recovered once activated');
    assert.equal(row.sourceSha256, HASH(source));
  } finally {
    child.kill();
  }
});

test('activation negative cases: non-node PID, missing PID, and a process that exited before activation are never treated as success', { timeout: 15000 }, async () => {
  const root = makeRepo();
  assert.equal(verifyPlainNodeTarget(4), 'NOT_NODE'); // Windows System process, always PID 4
  assert.equal(verifyPlainNodeTarget(999999), 'MISSING');
  assert.throws(() => verifyPlainNodeTarget(-1), /Invalid PID/);
  assert.throws(() => verifyPlainNodeTarget(1.5), /Invalid PID/);

  const dying = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: root, windowsHide: true });
  await new Promise(r => setTimeout(r, 400));
  const deadPid = dying.pid;
  dying.kill();
  await once(dying, 'exit');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(verifyPlainNodeTarget(deadPid), 'MISSING');
  const signal = activateInspectorSignal(deadPid);
  assert.equal(signal.ok, false, 'signalling an already-exited pid must not report success');

  const idle = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: root, windowsHide: true });
  try {
    await new Promise(r => setTimeout(r, 400));
    const before = new Set(queryListenersForPid(idle.pid).map(l => l.port));
    const started = Date.now();
    const listener = await pollNewListener(idle.pid, before, 1200, 300);
    assert.equal(listener, null, 'must not report a listener that never appeared');
    assert.ok(Date.now() - started < 5000, 'poll must be bounded, not indefinite');
  } finally {
    idle.kill();
  }
});

test('multiple simultaneous processes: activation only touches in-repo plain candidates, and losing the shared port is reported, not swallowed', { timeout: 30000 }, async () => {
  const root = makeRepo();
  const fileA = path.join(root, 'presenterA.js'), fileB = path.join(root, 'presenterB.js');
  fs.writeFileSync(fileA, "module.exports=()=>({v:'A'});\n");
  fs.writeFileSync(fileB, "module.exports=()=>({v:'B'});\n");
  const outsideDir = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'ember-outside-'));
  const outsideFile = path.join(outsideDir, 'unrelated.js');
  fs.writeFileSync(outsideFile, "setInterval(()=>{},1000);\n");
  const children = [];
  try {
    const inspected = fork(workload, [fileA], { cwd: root, execArgv: ['--inspect=127.0.0.1:0'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.push(inspected); inspected.stderr.resume(); await ready(inspected);

    const plain1 = fork(workload, [fileB], { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.push(plain1); plain1.stderr.resume(); await ready(plain1);
    const plain2 = fork(workload, [fileB], { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.push(plain2); plain2.stderr.resume(); await ready(plain2);

    const unrelated = spawn(process.execPath, [outsideFile], { cwd: outsideDir, windowsHide: true });
    children.push(unrelated);
    await new Promise(r => setTimeout(r, 500));

    const report = await run({ cwd: root, activateInspector: true, selectedPids: [inspected.pid, plain1.pid, plain2.pid] });
    assert.ok(report.rows.some(r => r.pid === inspected.pid), 'already-inspected process must still be recovered normally');

    const activatedSet = new Set(report.activation.activatedPids);
    assert.equal(activatedSet.size, 1, 'only one plain in-repo candidate can hold the shared default inspector port at a time');
    assert.ok(activatedSet.has(plain1.pid) || activatedSet.has(plain2.pid));
    assert.ok(!activatedSet.has(unrelated.pid), 'a process outside the repository must never be activated');
    assert.ok(!activatedSet.has(inspected.pid), 'an already-inspected process must not be re-activated');

    const loser = activatedSet.has(plain1.pid) ? plain2.pid : plain1.pid;
    assert.ok(report.activation.failed.some(f => f.pid === loser), 'the process that lost the port race must be reported as a failure, not silently dropped');

    assert.equal(queryListenersForPid(unrelated.pid).length, 0, 'the unrelated outside-repo process must never gain a new listener');
  } finally {
    for (const child of children) child.kill();
  }
});
