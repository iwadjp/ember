# Ember — rescue source a running Node still holds

Ember reads the JavaScript source text a live Node process's V8 isolate has
retained, over the Inspector protocol, and compares it against the current
contents on disk, Git HEAD, and the index. Anything that differs from disk —
lost, overwritten, or never committed — is saved to a separate, non-overwriting
location, keyed by PID and content hash so different processes' different
versions of the same path are never merged into one.

Against a plain Node process (no `--inspect`), rescue only happens if you
pass the exact PID **and** explicitly opt in with `--activate-inspector`.
Ember never turns on the Inspector on its own.

## What is Ember

You edited a file while a Node process had it loaded, then lost the version
that process is running on — overwritten on disk, reverted, or never saved.
If that process is still running, its V8 isolate may still hold the exact
source text. Ember connects to the Inspector, reads that text back out, and
tells you whether it still matches disk, still matches a Git ref, or exists
only in that process's memory — without evaluating any code in the target.

## Why

- The source can be gone from disk, HEAD, and the index, and still be sitting
  in a process's memory, unrecoverable through Git alone.
- Multiple processes running different edits of the same file hold different
  versions; Ember keeps them separate instead of overwriting one with another.
- Doing this by hand means finding the right Inspector endpoint, listing
  scripts, diffing each one against disk and Git, and copying out only what's
  actually different — Ember runs that as one command and writes a manifest
  you can check afterward.

## Quick start

Windows, `powershell.exe` (CIM / `Get-NetTCPConnection`), Git, Node.js.
Verified against Node **24.15.0**. Run inside the target Git repository — the
one whose files the target process loaded. Ember itself needs no `npm
install`, no Git repository of its own, and no `.gitignore` entry.

```powershell
node path\to\ember.cjs scan
```

`scan` reports without saving anything. Try it first with the synthetic demo,
which needs no real target process: see [Demo](#demo).

## Rescue from an already-inspected process

If the target was started with `--inspect`, point Ember at it and rescue:

```powershell
node path\to\ember.cjs rescue --pid 12345
```

`--pid` can be repeated to narrow which processes Ember probes before it
queries any Inspector endpoint. Omit it and Ember auto-discovers Node
processes with an `--inspect*` command line whose Inspector is listening on
loopback (`127.0.0.1` / `::1`) — pass `--pid` when you want to limit the scan
to specific targets. `--json` returns the full report, including hashes and
per-script status.

## Rescue from a plain Node process

A Node process started without `--inspect` is invisible to Ember by default.
To rescue from one, opt in explicitly:

```powershell
node path\to\ember.cjs rescue --pid 12345 --activate-inspector
```

## `--pid` / `--activate-inspector`

Activation requires **both** `--pid` and `--activate-inspector`. Ember never
selects a process to activate by matching a repository path substring in its
command line — an unrelated script can receive a repository path as an
argument, so that substring proves nothing about ownership. The PID you pass
is your own selection of the target; it is not a claim that Ember verified
the process belongs to this repository. Relative script paths inside the
target work the same way once you've selected the PID. Immediately before
activating, Ember re-checks that it can read the target's `node.exe` identity
and command line, and it always excludes its own PID.

## Output and the manifest

By default, Ember creates a new `ember-*` directory under the OS temporary
directory. To choose the destination, pass an **existing** directory — Ember
refuses to write inside the target repository or inside its own tool
directory:

```powershell
node path\to\ember.cjs rescue --pid 12345 --output C:\Recovery
```

`C:\Recovery` above is an example destination you create ahead of time. Each
run creates a new directory and unique filenames, writes exclusively (never
overwriting an existing file), and verifies the SHA-256 of what it wrote.
Nothing is ever written back to the original path.

The OS temp directory can be cleaned automatically, so after a rescue, check
the reported output path and move anything you need into durable, private
storage. Rescued files are the plaintext source itself.

`manifest.json` records PID, `scriptId`, the relative path, the saved
filename, the source SHA-256, and status for each row, plus disk/HEAD/index
hashes and retrieval state. It does not include the target's command line or
the raw source URL string. `scriptId` is scoped to the process/Inspector
session — it is not a persistent identifier across runs.

## Multi-version behavior

If two processes have loaded different edits of the same repository-relative
path, Ember rescues both — each keyed by its own PID and content hash, saved
under its own generated filename, distinct from whatever the third version on
disk currently is.

## Failure and negative states

| status | meaning |
|---|---|
| `IN_SYNC` | Source text matches disk. No file is rescued. |
| `HEAD_SURVIVES` / `INDEX_SURVIVES` | Differs from disk, but matches HEAD / the index. |
| `MEMORY_ONLY_VS_DISK_HEAD_INDEX` | Differs from disk, HEAD, and the index alike. |
| `MISSING_ON_DISK` | No file on disk, and no match in HEAD or the index. |
| `DIFFERS_FROM_DISK_GIT_UNKNOWN` | Differs from disk, but the Git comparison itself failed. |
| `DISK_UNREADABLE` | Disk comparison failed outright; excluded from rescue. |

A successful activation is not the same as a successful rescue — check
`recovery.saved` for the actual count and hashes. Failures are kept under
`failures` / per-process errors and never silently dropped. The CLI exits `2`
on a partial failure, `1` when it cannot run at all, and `0` even when zero
sources were rescued — don't infer rescue success from the exit code alone.

## Safety and side effects

**Activation is a real mutation of the target process.** It enables the
Inspector through `process._debugProcess`, and the resulting listener stays
open after Ember exits — Ember does not close it. Activation inherits the
target's own Inspector configuration; Ember cannot force it onto loopback.
Ember only ever connects to an endpoint it directly observed on `127.0.0.1`
or `::1`. If the default port `9229` is already taken, activation on that
target is reported as a failure. A target listening on a different port, or
port `0`, is not limited by Ember to one activation at a time on the machine.

Outside activation, Ember only reads: `Debugger.enable`,
`Debugger.getScriptSource`, and `Debugger.disable` are the only Inspector
methods it ever sends. It never evaluates code, pauses execution, or edits a
target's live source.

## Supported environment

- Windows, `powershell.exe` (CIM / `Get-NetTCPConnection`), Git, Node.js.
  Verified against Node **24.15.0**.
- The target is a Git repository with a HEAD. Run Ember from inside that
  repository.
- Ember itself can live anywhere; no `npm install`, no Git repository of its
  own, and no `.gitignore` entry are required for the tool directory.

## Limitations

- The retrieval mechanism is the existing Node Inspector / CDP — not a new
  memory-forensics technique.
- Only the source text V8 currently holds is recovered. Original byte
  encoding, full source coverage, or a fully runnable project are not
  guaranteed.
- Processes that have already exited, unloaded or garbage-collected scripts,
  workers, native code, data files, and source-map reconstruction are all out
  of scope.
- `node_modules`, `.git`, files outside the repository, and scripts over 8
  MiB are excluded.
- Observation is not atomic. Ember does not prove a file's absence across
  full Git history, the authenticity of a script's reported source URL, or
  that every line was ever executed.
- Only `Debugger.enable` / `getScriptSource` / `disable` are sent — but even
  enabling the debugger has overhead and can interact with any debugger
  already attached to the target.
- OS permissions, PID-reuse races, port conflicts, and the target's own
  Inspector configuration are not fully within Ember's control. The
  before/after listener diff reduces, but does not eliminate, port-conflict
  misattribution, and it is not full proof of process identity.

## Privacy

Rescued files are plaintext source. `manifest.json` includes repository-
relative paths and other local details. Treat rescue output as sensitive:
don't share it, or a report generated with `--json`, without reviewing it
first.

## Demo

`demo/run-demo.cjs` uses only synthetic, throwaway fixtures — a temporary Git
repository and temporary Node processes it starts itself. It never attaches
to, or reads from, any process it did not start, and it only stops the
processes it started. It runs four scenarios and checks each with SHA-256:

1. **Already-inspected rescue** — start a target with `--inspect`, overwrite
   its file on disk, rescue, and confirm the recovered hash matches the
   original version while the disk hash matches the overwrite.
2. **Plain-process rescue** — start a target without `--inspect`, confirm
   Ember does not see it by default, then rescue it with `--pid` +
   `--activate-inspector` and confirm a byte-exact hash match.
3. **Multi-version rescue** — two processes loaded with different versions of
   the same path, a third version on disk; confirm both process versions are
   rescued separately and distinctly from disk.
4. **Negative case** — an already-exited PID (or another case that must not
   be reported as a success) is confirmed as a reported failure, not a false
   positive.

```powershell
node demo\run-demo.cjs
```

## Development status

`test/selection.test.cjs` and `test/output.test.cjs` cover PID-selection
authorization and output-directory safety without needing a live target
process. `test/ember.test.cjs` covers rescue end to end — already-inspected
and plain-activation rescue with SHA-256 verification, multi-version
separation, and activation negative cases — against synthetic fixtures only.

```powershell
npm test
```

License selection (see [LICENSE](LICENSE)) and publication itself are
outside this file's scope; see the project's own release process for that
decision.
