'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const { targets, HASH, textReport } = require('../ember.cjs');
const { makeRepo } = require('./helpers.cjs');
const workload = path.join(__dirname, 'fixtures', 'workload.cjs');
const preload = path.join(__dirname, 'fixtures', 'stale-discovery.cjs');

async function start(t, root, file, port = 0) {
  const child = fork(workload, [file], { cwd: root, execArgv: port === null ? [] : [`--inspect=127.0.0.1:${port}`],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  child.stderr.resume();
  t.after(() => stop(child));
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('scratch workload exited'); })]);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}
async function cli(root, pids, output, snapshot) {
  const args = snapshot ? ['--require', preload] : [];
  args.push(require.resolve('../ember.cjs'), 'rescue', '--json', '--output', output);
  for (const pid of pids) args.push('--pid', String(pid));
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true,
    env: { ...process.env, EMBER_TEST_DISCOVERY: snapshot || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [code] = await once(child, 'exit');
    assert.ok(stdout.trim(), `CLI returned no report: ${stderr}`);
    return { code, report: JSON.parse(stdout) };
  } finally { clearTimeout(timer); }
}
function snapshotFile(output, name, found) {
  const file = path.join(output, name + '.json');
  fs.writeFileSync(file, JSON.stringify(found));
  return file;
}
function saved(result, pid, source) {
  assert.equal(result.code, 0);
  assert.equal(result.report.failures.length, 0);
  const entries = result.report.recovery.saved;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].pid, pid);
  assert.equal(entries[0].sha256, HASH(source));
  assert.equal(HASH(fs.readFileSync(path.join(result.report.recovery.output, entries[0].filename))), HASH(source));
}

test('CLI refuses a reused inspector port instead of rescuing B under exited PID A', { timeout: 120000 }, async t => {
  const root = makeRepo('ember-identity-');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-identity-output-'));
  const file = path.join(root, 'presenter.js');
  const aSource = "module.exports=()=>({version:'A-original'});\n";
  const bSource = "module.exports=()=>({version:'B-restarted'});\n";
  fs.writeFileSync(file, aSource);
  const a = await start(t, root, file);
  const selected = (await targets([a.pid])).found;
  assert.equal(selected.length, 1);
  const selectedMetadata = await (await fetch(`http://127.0.0.1:${selected[0].port}/json/list`)).json();
  const stale = snapshotFile(output, 'selected-a', selected);
  fs.writeFileSync(file, 'module.exports=()=>({version:"disk"});\n');
  saved(await cli(root, [a.pid], output), a.pid, aSource);
  await stop(a);
  fs.writeFileSync(file, bSource);
  const b = await start(t, root, file, selected[0].port);
  const replacement = (await targets([b.pid])).found;
  assert.equal(replacement.length, 1);
  assert.equal(replacement[0].port, selected[0].port);
  assert.notEqual(replacement[0].websocket, selected[0].websocket);
  const replacementMetadata = await (await fetch(`http://127.0.0.1:${replacement[0].port}/json/list`)).json();
  fs.writeFileSync(path.join(output, 'identity-evidence.json'), JSON.stringify({
    selected: selected[0], selectedMetadata, replacement: replacement[0], replacementMetadata,
  }, null, 2));
  t.diagnostic('scratch identity evidence: ' + output);
  fs.writeFileSync(file, 'module.exports=()=>({version:"disk-again"});\n');

  // Exactly the discovery/read race: an A-owned port snapshot followed by B's
  // real /json/list and real Inspector at that same address, without PID reuse.
  const wrong = await cli(root, [a.pid], output, stale);
  assert.equal(wrong.code, 2, `wrong success: B source rescued under A=${a.pid}: ${wrong.report.rows.some(r => r.pid === a.pid && r.sourceSha256 === HASH(bSource))}`);
  assert.equal(wrong.report.rows.length, 0);
  assert.equal(wrong.report.recovery, undefined);
  assert.deepEqual(wrong.report.failures, [{ pid: a.pid, reason: 'PID_INSPECTOR_MISMATCH' }]);
  const repeat = await cli(root, [a.pid], output, stale);
  assert.deepEqual(repeat.report.failures, wrong.report.failures);
  assert.equal(repeat.report.rows.length, 0);
  saved(await cli(root, [b.pid], output), b.pid, bSource);

  const goodFile = path.join(root, 'other.js');
  const goodSource = "module.exports=()=>({version:'C-selected'});\n";
  fs.writeFileSync(goodFile, goodSource);
  const c = await start(t, root, goodFile);
  const good = (await targets([c.pid])).found;
  fs.writeFileSync(goodFile, 'module.exports=()=>({version:"C-on-disk"});\n');
  const mixed = await cli(root, [a.pid, c.pid], output, snapshotFile(output, 'mixed', [...selected, ...good]));
  assert.equal(mixed.code, 2);
  assert.deepEqual(mixed.report.failures, wrong.report.failures);
  assert.equal(mixed.report.recovery.saved.length, 1);
  assert.equal(mixed.report.recovery.saved[0].pid, c.pid);
  assert.equal(mixed.report.recovery.saved[0].sha256, HASH(goodSource));
  assert.ok(mixed.report.rows.every(row => row.pid === c.pid));
  const plain = await start(t, root, goodFile, null);
  const withPlain = await cli(root, [c.pid, plain.pid], output);
  saved(withPlain, c.pid, goodSource);
  assert.ok(withPlain.report.rows.every(row => row.pid === c.pid));
  assert.match(textReport(withPlain.report), new RegExp('NO_INSPECTOR  PID ' + plain.pid));
  assert.deepEqual(withPlain.report.activation.activatedPids, []);
  // Capture after discovery but with no replacement must also fail explicitly.
  await stop(c);
  const exited = await cli(root, [c.pid], output, snapshotFile(output, 'exited', good));
  assert.equal(exited.code, 2);
  assert.equal(exited.report.rows.length, 0);
  assert.equal(exited.report.failures.length, 1);
});

test('CLI rejects a same-PID creation-time change instead of capturing a replacement incarnation', { timeout: 45000 }, async t => {
  const root = makeRepo('ember-pid-reuse-');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-pid-reuse-output-'));
  const file = path.join(root, 'presenter.js');
  fs.writeFileSync(file, 'module.exports=()=>({version:"replacement"});\n');
  const child = await start(t, root, file);
  const selected = (await targets([child.pid])).found;
  assert.equal(selected.length, 1);
  // Deterministic PID reuse equivalent: same PID, executable, command and port,
  // but selection refers to a different process creation time.
  selected[0].identity = { ...selected[0].identity, created: '2000-01-01T00:00:00.0000000Z' };
  const result = await cli(root, [child.pid], output, snapshotFile(output, 'previous-incarnation', selected));
  assert.equal(result.code, 2);
  assert.deepEqual(result.report.failures, [{ pid: child.pid, reason: 'PID_IDENTITY_CHANGED' }]);
  assert.equal(result.report.rows.length, 0);
  assert.equal(result.report.recovery, undefined);
});
