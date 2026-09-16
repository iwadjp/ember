'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
}

// A throwaway Git repository, isolated per test, so tests never touch the
// repository Ember itself was exported into.
function makeRepo(prefix = 'ember-fixture-repo-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'ember-demo@example.invalid']);
  git(root, ['config', 'user.name', 'Ember Fixtures']);
  fs.writeFileSync(path.join(root, '.gitkeep'), '');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

module.exports = { git, makeRepo };
