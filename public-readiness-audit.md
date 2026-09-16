# Ember — public-readiness notes

Ember's contribution is not a new source-retrieval primitive; Node's own
Inspector protocol already exposes `Debugger.getScriptSource`. Its
contribution is bundling the operations an accident actually calls for —
target selection, explicit opt-in activation, comparison against disk/HEAD/
index, separation of distinct in-memory versions, non-overwriting output, and
a checkable manifest — into one rescue workflow. Whether that focused
workflow difference is useful enough to a given third party in practice is
not something this document claims to prove.

## Validated behavior

| Scenario | Result |
|---|---|
| Already-inspected process | Overwritten source recovered with an exact SHA-256 match |
| Plain Node process | No activation or rescue by default; only `--pid` + `--activate-inspector` triggers it |
| Multiple processes | Two processes' distinct versions of one path recovered separately, distinct from disk |
| Negative cases | Non-Node PID, missing PID, exited process, port conflict, and query/access failures are all reported as failures — never as a false success |
| Process selection | Repository-path substring matching was removed; only an explicitly selected PID is ever eligible for activation |
| Port identification | A pre-activation listener snapshot vs. a post-activation diff, not a raw "any listener appeared" check |
| Output | Default destination moved to the OS temp directory; `--output DIR` accepts an existing directory outside the target repository and Ember's own directory; each run writes new, uniquely named files and verifies their SHA-256 after writing |

These are captured by `test/ember.test.cjs`, `test/selection.test.cjs`, and
`test/output.test.cjs`, and are reproducible with `demo/run-demo.cjs` against
synthetic, throwaway fixtures only — no real project's source is used or
required.

## Comparison with existing capability

The point of this table is to separate raw retrieval capability (which
already exists) from having a complete rescue workflow around it.
"Buildable" means implementable with existing APIs, not impossible.

| Capability | Node Inspector / DevTools by hand | A CDP client / custom script | Ember |
|---|---|---|---|
| Post-hoc activation | Existing (OS signal / `_debugProcess`) | Separate implementation | `--pid` + explicit opt-in |
| Source discovery | Manual script list | `scriptParsed` / custom dump | Enumerates in-repo scripts |
| Source extraction | Existing | `getScriptSource` | Same mechanism |
| Disk comparison | Manual, separate tooling | Custom | Built in |
| Lost/changed detection | Manual | Custom | Compared against disk/HEAD/index |
| Multiple processes | One connection at a time | Custom connection management | Batched across selected PIDs |
| Multiple versions | Manual organization | Custom | Saved separately, keyed by PID/hash |
| Safe output | Depends on the operator's script | Implementation-dependent | New directory, exclusive write |
| No overwrite | Depends on procedure | Implementation-dependent | Never writes back to the original path |
| Negative-case handling | Operator judgment | Protocol error + custom handling | Explicit failures/status, including zero-result runs |
| One-shot CLI rescue | Requires a prepared script | Buildable | Comparison and manifest included |

Node documents Inspector/DevTools access
([Node debugging](https://nodejs.org/learn/getting-started/debugging)) and
CDP defines `getScriptSource`
([CDP protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)).
Post-hoc activation on Windows is an existing, documented mechanism, with
prior art in tools like
[node-inspector](https://github.com/node-inspector/node-inspector). Recovering
deleted or overwritten Node source through the debugger has prior public
examples going back to at least 2015–2018
([Stack Overflow](https://stackoverflow.com/questions/33644035/how-can-i-get-source-code-of-nodejs-from-running-app)).
[chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface)
is a general CDP client (including Node targets) that source-retrieval
automation could be built on; this project has not verified run-time
compatibility with it. Heap/core-dump tooling
([V8 heap snapshots](https://nodejs.org/api/v8.html),
[llnode](https://github.com/nodejs/llnode),
[ProcDump](https://learn.microsoft.com/en-us/sysinternals/downloads/procdump))
is a different entry point — isolate-wide, dump-based, and not documented as
providing the same disk-comparison-plus-manifest workflow.

**Material difference: as a workflow, yes; as a retrieval primitive, no.**
Ember's distinct contribution is turning "what came out of which process, how
it differs from disk today, and which version ended up where" into a
reproducible result for an accident, not wrapping `getScriptSource` in one
command by itself. A comparably experienced engineer could build the same
thing from the existing APIs; this does not claim technical exclusivity.

## Limitations carried into the public build

- The retrieval mechanism is the existing Node Inspector/CDP, not a new
  memory-forensics technique.
- Only the V8-held source text is recovered — not original byte encoding, not
  guaranteed full source coverage, not a runnable project.
- Exited processes, unloaded/collected scripts, workers, native code, data
  files, and source-map reconstruction are all out of scope.
- Activation inherits the target's own Inspector configuration and does not
  force loopback binding or close its own listener afterward; Ember only
  connects to endpoints it directly observed on loopback.
- OS permissions, PID-reuse races, and port conflicts are not fully within
  Ember's control; the before/after listener diff reduces, but does not
  eliminate, port-conflict misattribution.

## Human Gate

License selection (see [LICENSE](LICENSE)) and the decision to publish this
repository are outside the scope of this document. This file records
technical readiness only; it does not authorize publication by itself.
