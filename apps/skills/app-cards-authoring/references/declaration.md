# Declaration and receipt reference

Use `app_cards_describe` for the installed primitive schema and UI catalog before authoring; shorthand expansion is described below. Resolve the declared machine with `machine_list` / `machine_inspect`, then read its current declaration with `app_cards_read`. These are agent tools, not commands to ask the user to run.

## Execution choices

| Primitive | Appropriate use | Important limit |
| --- | --- | --- |
| `exec` | Fixed command with `program.kind: argv`, or bounded POSIX-shell glue with `program.kind: script` | Not a daemon API; `effect: observe` is an assertion of purpose, not a sandbox |
| `transform` | Bounded JSONata interpretation of explicit input | Not an external command |
| `agent` | Reasoning over input, with declared `allowedOperations` and output schema | `completion: submitted` proves submission, not a completed result |
| `flow` | Finite dependency graph, explicit inputs and success/settled handling | Not a recurring scheduler, cross-machine transaction, or rollback engine |

`command` lifts `executable` / `args` into an argv program. `script` lifts `interpreter` / `source` / `args` into a script program. `probe` is an argv command whose effect is fixed to `observe`. `agent-task` and `inspection-report` alias `agent` and `flow`. Presets expand before strict validation, review, and persistence; they do not add service semantics or omit other required fields.

Bindings are `{"literal": ...}`, `{"ref": "/input/..."}`, `{"object": {...}}`, or `{"array": [...]}`. References begin at `/input`, `/data`, or available `/steps`; they are not string interpolation. Executable/source are static. Each argument and environment value must resolve to a NUL-free string; `{"literal":"start"}` is an argument, bare `"start"` is not.

Script programs use a POSIX-compatible interpreter and execute as `interpreter -c source app-cards ...args`; arguments begin at `$1`. Other interpreters require an explicit argv program. Prefer argv when no shell interpretation is required.

## Context and authority

Host contexts need a real working directory within configured `hostRoots`. SSH contexts specify an audited machine-mgmt `pathId` and remote `cwd`, not an endpoint or arbitrary SSH options. A ready path must resolve to the exact reviewed `ssh -F config alias` prefix; there is no automatic alternate route. Verify the path's constraints and operational permission rather than inferring authority from a name such as `inspect`.

SSH transports a POSIX-quoted command of the form `cd '<cwd>' && exec env ... '<executable>' '<arg>' ...`. Even argv operations therefore depend on the remote command environment; script operations add their explicit interpreter. Do not alter generated SSH configuration or consult ambient user SSH files.

`app_cards_propose` takes complete `declaration_json`, `expected_revision`, and `ask_ref`. The candidate revision is current revision + 1. Proposal creation validates but neither publishes nor executes. `app_cards_publish` consumes the proposal identifier and obtains human approval of the frozen declaration, unless matching active execution authority can be reused.

The execution digest includes machine identity, resolved contexts, static `data`, `operations`, `actions`, and `checks` (plus executor version). It excludes `revision`, `apps`, and `ui`. Even an action/check label change is inside this digest; do not assume every text edit is presentation-only. UI and app metadata edits still need valid publication, but an unchanged execution digest can reuse its existing grant without another human question.

The digest covers resolved SSH identity, not remote script, unit, or dependency bytes. See [deployment trust](service-lifecycle.md#deployment-trust) before claiming that a fixed path identifies an approved implementation.

## Checks interpret successful runs, not arbitrary output

The check expression receives the complete `OperationResult` and runs only when `state === "succeeded"`. Text-decoded stdout is `value`; JSON-decoded stdout is the parsed `value`. Process stderr and exit status are `process.stderr` and `process.exitCode`. The expression must return an object containing `health: "healthy" | "unhealthy" | "unknown"` and a string `summary`; additional fields can retain evidence.

Failed, cancelled, indeterminate, or otherwise non-successful runs yield unknown observations without evaluating the expression. Invalid expression output also stays unknown with a diagnostic. Adding JSONata branches for failed runs cannot override this rule.

`successExitCodes` means the operation completed well enough to decode and interpret its output, not that the application is healthy. Accept a negative probe code only when that tool documents it as a meaningful observation and the expression distinguishes it. Keep unexpected observer errors outside this set. Never accept SSH 255 as ordinary success.

An action's `invalidates` marks those observations stale at admission. After settlement the Host runs those checks once, without retrying the action. Open/manual refresh also initiates observation. Optional top-level `monitoring: {intervalMs: 15000}` permits deterministic checks while the panel and page are visible; it is part of the execution digest. A notification/read alone does not execute a check.

## Invocation and reconciliation

`app_cards_invoke` takes the current revision, declared action, JSON input, and a request identity. Admission returns a durable receipt; use `app_cards_run_read` until that run settles. An identical request retrieves its receipt, while conflicting reuse rejects. Agent submission remains distinct from final task completion.

Receipts retain operation state, stdout/value, process exit code and stderr, with timeout/cancellation/truncation facts. SSH loss (including exit 255), a signal, or a deadline cannot prove whether the remote effect completed: the result is `indeterminate` / `REMOTE_UNCERTAIN`, without automatic retry. Cancellation is not proof of remote rollback.

Reconcile with new read-only observations of the same object and consider intervening operators before any deliberate new invocation. `app_cards_remove` withdraws cards after review; it does not uninstall or stop the application.
