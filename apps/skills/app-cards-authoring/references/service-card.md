# Complete service-card example

This example uses an already deployed systemd service, not a required platform. Read the [preparation assumptions](systemd-example.md) first. It adapts the researched remote-service skeleton with placeholder identity and English labels; it is not a live machine export or a claim of remote deployment.

Replace `example-host`, revision (current + 1), audited `service-control` path, executable paths, fixed unit, URL, and readiness criterion from actual facts. Verify the path permits the proposed effects. Separate observe/change contexts if policy requires it. The Host execution ceiling must accommodate the operation limits. Do not publish or execute this example merely to validate its syntax.

```json
{
  "apiVersion": "dsh.app-cards/v1",
  "kind": "MachineAppCards",
  "machineId": "example-host",
  "revision": 1,
  "apps": {
    "demo": { "name": "Managed demo", "description": "Service state and HTTP readiness are separate observations." }
  },
  "contexts": {
    "vm": { "kind": "ssh", "pathId": "service-control", "cwd": "/" }
  },
  "data": {},
  "operations": {
    "start": {
      "kind": "exec",
      "effect": "change",
      "context": "vm",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
      "program": {
        "kind": "argv",
        "executable": "/usr/bin/sudo",
        "args": [
          { "literal": "-n" }, { "literal": "/usr/bin/systemctl" },
          { "literal": "--no-ask-password" }, { "literal": "start" }, { "literal": "demo.service" }
        ]
      },
      "output": { "decode": "text", "schema": { "type": "string" } },
      "successExitCodes": [0],
      "timeoutMs": 45000,
      "outputLimitBytes": 8192
    },
    "stop": {
      "kind": "exec",
      "effect": "change",
      "context": "vm",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
      "program": {
        "kind": "argv",
        "executable": "/usr/bin/sudo",
        "args": [
          { "literal": "-n" }, { "literal": "/usr/bin/systemctl" },
          { "literal": "--no-ask-password" }, { "literal": "stop" }, { "literal": "demo.service" }
        ]
      },
      "output": { "decode": "text", "schema": { "type": "string" } },
      "successExitCodes": [0],
      "timeoutMs": 45000,
      "outputLimitBytes": 8192
    },
    "inspectUnit": {
      "kind": "exec",
      "effect": "observe",
      "context": "vm",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
      "program": {
        "kind": "argv",
        "executable": "/usr/bin/systemctl",
        "args": [
          { "literal": "--no-pager" }, { "literal": "--no-ask-password" }, { "literal": "show" },
          { "literal": "--property=LoadState,ActiveState,SubState,MainPID,Result" }, { "literal": "demo.service" }
        ]
      },
      "output": { "decode": "text", "schema": { "type": "string" } },
      "successExitCodes": [0],
      "timeoutMs": 10000,
      "outputLimitBytes": 8192
    },
    "probeHttp": {
      "kind": "exec",
      "effect": "observe",
      "context": "vm",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
      "program": {
        "kind": "argv",
        "executable": "/usr/bin/curl",
        "args": [
          { "literal": "-q" }, { "literal": "--silent" }, { "literal": "--show-error" },
          { "literal": "--noproxy" }, { "literal": "*" },
          { "literal": "--connect-timeout" }, { "literal": "1" }, { "literal": "--max-time" }, { "literal": "3" },
          { "literal": "--output" }, { "literal": "/dev/null" },
          { "literal": "--write-out" }, { "literal": "%{http_code}" }, { "literal": "http://127.0.0.1:8080/" }
        ]
      },
      "output": { "decode": "text", "schema": { "type": "string" } },
      "successExitCodes": [0, 7, 28],
      "timeoutMs": 10000,
      "outputLimitBytes": 8192
    }
  },
  "actions": {
    "start": {
      "appId": "demo", "label": "Start", "operation": "start", "input": { "literal": {} },
      "availability": { "kind": "always" }, "invalidates": ["unitState", "httpReady"]
    },
    "stop": {
      "appId": "demo", "label": "Stop", "operation": "stop", "input": { "literal": {} },
      "availability": { "kind": "always" }, "invalidates": ["unitState", "httpReady"]
    }
  },
  "checks": {
    "unitState": {
      "appId": "demo", "label": "Service state", "operation": "inspectUnit", "input": { "literal": {} },
      "evaluate": {
        "language": "jsonata",
        "source": "($lines := $split(value, '\\n'); $loaded := 'LoadState=loaded' in $lines; $running := ('ActiveState=active' in $lines) and ('SubState=running' in $lines); {'health': $loaded ? ($running ? 'healthy' : 'unhealthy') : 'unknown', 'summary': $loaded ? ($running ? 'Service running; see separate readiness evidence' : 'Service not running or transitioning; inspect receipt') : 'Unit not loaded; verify configuration'})"
      },
      "freshForMs": 10000
    },
    "httpReady": {
      "appId": "demo", "label": "HTTP readiness", "operation": "probeHttp", "input": { "literal": {} },
      "evaluate": {
        "language": "jsonata",
        "source": "{'health': process.exitCode = 0 and $trim(value) = '200' ? 'healthy' : 'unhealthy', 'summary': process.exitCode = 7 ? 'Cannot connect; not proof of a stopped process' : process.exitCode = 28 ? 'Probe timed out; not proof of a stopped process' : process.exitCode = 0 and $trim(value) = '200' ? 'HTTP 200 at observation time; verify service identity separately' : 'Unexpected HTTP response: ' & $trim(value)}"
      },
      "freshForMs": 10000
    }
  },
  "ui": {
    "a2uiVersion": "0.9.1", "catalogId": "urn:dsh:app-cards:catalog:1",
    "surfaces": [{
      "id": "demo", "appId": "demo", "order": 10, "formInitial": {},
      "components": [
        { "id": "root", "component": "Column", "children": ["title", "unit", "http", "startButton", "startReceipt", "stopButton", "stopReceipt"] },
        { "id": "title", "component": "Text", "text": "Managed demo: refresh checks after actions settle" },
        { "id": "unit", "component": "Status", "checkId": "unitState" },
        { "id": "http", "component": "Status", "checkId": "httpReady" },
        { "id": "startButton", "component": "Button", "child": "startLabel", "action": { "event": { "name": "app.invoke", "context": { "actionId": "start", "input": { "path": "/form" } } } } },
        { "id": "startLabel", "component": "Text", "text": "Start" },
        { "id": "startReceipt", "component": "RunReceipt", "actionId": "start" },
        { "id": "stopButton", "component": "Button", "child": "stopLabel", "action": { "event": { "name": "app.invoke", "context": { "actionId": "stop", "input": { "path": "/form" } } } } },
        { "id": "stopLabel", "component": "Text", "text": "Stop" },
        { "id": "stopReceipt", "component": "RunReceipt", "actionId": "stop" }
      ]
    }]
  }
}
```

## Interpretation rules

Mutations accept only exit 0. The HTTP probe also accepts curl's completed negative observations 7 (connection failure) and 28 (curl's own timeout), so JSONata can label those unhealthy. Missing tools, invalid options, and other unexpected errors remain failed runs and unknown observations; SSH 255 or the outer execution timeout remains uncertain. Do not generalize these success codes to another command.

`-q` is first to disable default curl configuration. `--noproxy "*"`, bounded waits, and `--silent --show-error` keep the loopback probe explicit without hiding diagnostics. HTTP errors are deliberately interpreted from the status text, not assumed from curl's process status. HTTP 200 is only a minimal demo criterion, not proof of service identity or complete business readiness.

The unit expression splits the original text by newline. Do not `$trim` the whole property list first: JSONata normalizes internal whitespace. Properties missing or not loaded produce unknown; inactive, failed, and transitional states are not reported as running.

Always-available start/stop controls rely on manager convergence, not cached health. Admission stales both checks; the runtime reconciles them once after settlement. Refresh again if readiness takes longer. RunReceipt and Status show different evidence. There is no automatic action retry, rollback, or remote deployment.
