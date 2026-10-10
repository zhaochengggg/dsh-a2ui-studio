# Service lifecycle choices and failure patterns

Use this reference for persistent applications. It condenses the remote-service research into reusable choices, not a claim about any currently installed host. Exact flags, capabilities, and permissions must be checked against the selected environment.

## Choose the existing owner

| Candidate | Use when | Failure or trade-off to expose |
| --- | --- | --- |
| A. Fixed system-manager object, direct argv | A persistent service and narrow start/stop authority already exist | Missing/masked objects, denied access, job failures, and readiness remain separate outcomes |
| B. User-manager object | The account's manager, bus, and required logout/reboot lifetime are configured | A working interactive session does not prove persistence or noninteractive accessibility; do not silently switch to system scope |
| C. Fixed remote script alone | It is a deployed, tested lifecycle interface | A short path can hide all the old PID, concurrency, and backgrounding defects |
| D. Existing manager plus versioned adapter | Shared readiness, status normalization, or multi-platform behavior justifies extra code | The deployment owner must maintain its artifact, finite verbs, errors, and concurrency behavior |
| E. Existing container/orchestration platform | It already owns the workload | Pin endpoint/project/namespace/object; change desired state, not a PID that its controller will recreate |
| F. Manager-owned transient task | Deliberately temporary work needs independent ownership | Repeated creation may conflict; transient definitions may not survive reboot; submission is not readiness |
| G. Another installed supervisor | It is the authoritative manager on this platform | Use its actual identity/exit conventions instead of translating another tool's flags mechanically |
| H. Inline background shell | At most a bounded, explicitly disposable diagnostic | Not the default for persistent cards: transport lifetime, identity, supervision, cleanup, and races remain unmanaged |

Configuration-management tools such as Ansible/Salt/Puppet/Chef can provision and converge service objects. SSH command runners such as Fabric or deployment orchestration such as Capistrano do not themselves supervise the resulting process. Terraform provisioners are not a daily lifecycle API. Choose the ownership model, not a brand.

For Compose, `up`, `start`, `stop`, and `down` have different creation/removal semantics. For scheduler-managed workloads, stop by updating the owning object and account for other controllers that can change desired state. Do not install a second manager merely to support a card.

## Deployment trust

Inline source exposes the glue in the card review, but still depends on external interpreters, executables, configuration, and application files. Calling a fixed adapter hides its implementation from that review. Calling a manager exposes the verb/object, not the unit, drop-ins, environment files, or application bytes behind it.

Keep two approvals distinct: the card grants control of an object; deployment determines its implementation. Prefer immutable version paths or content-addressed artifacts with controlled writers, including parent directories. A mutable `current` symlink or a self-reported version is not content integrity. Merely adding `expectedSha256` to declaration data enforces nothing.

If exact bytes matter, use a trusted deployment/integrity mechanism. Hashing a mutable path and then executing it leaves a check/use race. The app-cards runtime does not verify remote artifact content.

A useful adapter binds one service and finite verbs such as `start`, `stop`, `inspect`; it accepts no arbitrary shell, executable, unit, or privilege flags. It returns bounded structured output, keeps diagnostics on stderr, distinguishes accepted from completed work, and rejects invalid input visibly. Its versioning, installation, locking, readiness, and rollback belong to the deployment owner.

## Failure patterns to recognize

| Pattern | Why the evidence is wrong | Safer criterion |
| --- | --- | --- |
| `pgrep -f 'text also present in the script'` | A `bash -c` command line can contain that text and match the invoking shell | Inspect a stable manager object and verify application identity separately |
| `pkill -f` with such a pattern | It can kill the control shell, losing the SSH receipt and producing `REMOTE_UNCERTAIN` | Stop the exact owned object; reconcile any uncertain result |
| `setsid nohup ... &` as a supervisor | In affected call chains, waiting or inherited descriptors can keep SSH open until timeout | Give persistent work to an independent owner; do not equate parent exit with service readiness |
| Start `python3 ./server.py`, stop by matching `demo-service/server.py` | Start and stop disagree on identity and stop can silently miss | One object identifier for every lifecycle verb |
| `curl ... || echo stopped` | Missing curl, invalid options, TLS/configuration errors, and real unreachability collapse into one success-looking message | Preserve exit code/stderr; accept only documented negative observations and interpret HTTP status explicitly |

Ordinary Bash `&` is asynchronous; not every noninteractive shell waits for every child. Diagnose the actual process tree, waiting call, and file descriptors. OpenSSH can retain a channel while descendants hold its output streams. `nohup` does not supervise and does not always redirect nonterminal streams. `setsid --fork` can let a caller return in a particular invocation, but does not prove exec success, readiness, descriptor closure, or escape from a cgroup. It is a diagnostic distinction, not the recommended card recipe.

curl normally returns exit 0 for an HTTP 404/500 response. Either interpret the reported HTTP status or deliberately choose its HTTP-failure option and handle that exit convention. A port response alone does not identify the application. Check a stable service ID/version and explicit readiness fields when available.

## Evidence and reconciliation cases

Exercise repeated start/stop only within authorized scope; record command completion separately from object state and readiness. Include missing object, denied permission, missing probe tool, malformed output, negative readiness, transitional state, and stale observations. Do not make failure cases pass by broadening success codes.

For SSH disconnect/timeout, retain the uncertain receipt, obtain fresh object/job/log evidence, and compare current intent before deciding whether a new mutation is warranted. Per-machine action serialization and request deduplication do not lock out other remote clients. A successful intentional stop can correctly leave a readiness check unhealthy; represent desired state separately rather than relabeling a closed port healthy.

## Selected upstream references

- [Ansible service convergence](https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/systemd_service_module.html), [Salt service states](https://docs.saltproject.io/en/latest/ref/states/all/salt.states.service.html), and [Fabric Connection](https://docs.fabfile.org/en/stable/api/connection.html).
- [Compose up](https://docs.docker.com/reference/cli/docker/compose/up/) and [Kubernetes Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).
- [Bash asynchronous commands](https://www.gnu.org/software/bash/manual/html_node/Lists.html), [nohup](https://www.gnu.org/software/coreutils/manual/html_node/nohup-invocation.html), and [setsid implementation](https://github.com/util-linux/util-linux/blob/b2180371ceb80bb09e2e583419177ebb2864c978/sys-utils/setsid.c#L98-L124).
- [OpenSSH channel completion](https://github.com/openssh/openssh-portable/blob/7fe3b24c922b7af2d743737f7cf37df61ea06426/clientloop.c#L1564-L1568) and [pipe EOF](https://man7.org/linux/man-pages/man7/pipe.7.html).
- [curl exit codes](https://everything.curl.dev/cmdline/exitcode.html) and [command manual](https://curl.se/docs/manpage.html).
