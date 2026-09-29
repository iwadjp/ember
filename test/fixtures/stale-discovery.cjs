'use strict';
// Replay only the first OS discovery snapshot. /json/list, WebSocket traffic,
// and every later identity check use the real scratch processes and OS.
const fs = require('node:fs');
const cp = require('node:child_process');
const exec = cp.execFileSync;
let used = false;
cp.execFileSync = function(file, args, options) {
  if (!used && file === 'powershell.exe' && args.at(-1).includes('$nodes=@')) {
    used = true;
    return fs.readFileSync(process.env.EMBER_TEST_DISCOVERY, 'utf8');
  }
  return exec.call(this, file, args, options);
};
