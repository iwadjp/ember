'use strict';
// Synthetic public fixture: loads the module named on argv[2] and serves its
// output over a throwaway loopback HTTP server, so a test/demo can compare
// output before and after a rescue. No dependency outside this repository.
const http = require('node:http');
const present = require(process.argv[2]);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ pid: process.pid, ...present() }));
});
server.listen(0, '127.0.0.1', () => {
  if (process.send) process.send({ port: server.address().port });
});
setTimeout(() => server.close(() => process.exit(0)), 90000).unref();
