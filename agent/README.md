# void0 OS

void0 OS is installed on existing Ubuntu and Debian systems without replacing
the operating system. Its Python 3 agent runs as a root-owned systemd service. It
opens no network listener; it makes authenticated outbound HTTPS requests to the
void0 management origin. Only HTTP on `127.0.0.1` is permitted for local
development. TLS certificate verification and same-origin, no-redirect requests
are mandatory.

`install.sh [management-origin]` downloads the manifest and bundle from that
origin, checks SHA-256, accepts only the four expected regular files, and installs
the agent. The pairing code is entered interactively and is never an argument or
log entry. Credentials are stored in `/etc/serverdesk-agent/config.json` with
mode `0600`. The service must retain access to existing application directories,
Docker, K3s and the host package manager, which is why it runs as root. Installing
the agent does **not** install Docker or K3s.

The `serverdesk-agent.service` name and `/etc/serverdesk-agent`,
`/opt/serverdesk-agent`, and `/var/lib/serverdesk-agent` paths are retained as
compatibility identifiers. They are not the product name and should not be
renamed manually during an upgrade.

## Installation and connection

1. Configure a publicly reachable HTTPS origin in the void0 control panel.
2. Add the server, open **Install void0 OS**, and generate a pairing code.
3. Review the generated installation command and run it on the intended server
   as root or with sudo. Enter the one-time code at the interactive prompt.
4. Confirm the server identity and online state in the control panel. Install
   Docker separately if needed, then import or create services.

Connection alone does not redeploy existing applications. Revoking the pairing
disables control-panel access but does not remove business containers or data.
An OS installation or update executes root code; obtain and review that code
through a trusted process. HTTPS and a checksum do not make an already
compromised management origin trustworthy.

## Fixed command protocol

The management backend generates `programs.json` alongside the bundle. The agent
only accepts `probe`, `bootstrap`, `submit`, `status` and `kubernetes-action`.
Their executable programs are packaged locally; command payloads cannot provide
scripts or shell commands. The shape is:

```json
{
  "probe": {"language": "python", "script": "..."},
  "bootstrap": {
    "docker": {"language": "shell", "script": "..."},
    "k3s": {"language": "shell", "script": "..."}
  },
  "submit": {"language": "python", "script": "..."},
  "status": {"language": "python", "script": "..."},
  "kubernetes-action": {"language": "python", "script": "..."}
}
```

Optional per-program `timeoutSeconds` is bounded to 1–7200 and `outputLimit` to
1 KiB–4 MiB. Programs receive the command payload on stdin. JSON stdout becomes
the command result; bootstrap text becomes `{ "log": "..." }`. Secret values in
environment and credential fields are removed from returned strings. Exceptions
and failed operation output are not printed to the journal.

Only one operation executes at a time; polling heartbeats continue with
`busy: true`. The server must return `command: null` while busy. Receipt ids are
saved privately before acknowledgement; the operation executes only after ack
succeeds. Payloads are never persisted by the agent. Results are held privately
until acknowledged by the backend, after which only the receipt id remains. A
restart does not rerun received operations; unfinished receipts are reported
with `outcomeKnown: false`. There is no arbitrary remote shell or public agent
API.

An acknowledgement or result rejected permanently by the backend (for example,
a command already expired and marked unknown) is retained as a rejected receipt
without replaying the operation. It cannot block subsequent heartbeats or
status queries. Transient errors and rate limits remain retryable.

For local tests, run `daemon.py run --config <0600-file> --programs <programs.json>
--state-dir <0700-directory>` against a loopback fake central. Do not point tests
at production servers or run the systemd installer on the developer machine.

## Independent release verification

The default **compatibility** mode keeps existing installations working. It does
not protect business servers from a compromised management panel: that panel can
still submit supported deployment changes. The installer, journal and heartbeat
explicitly report compatibility mode. SQLite versus PostgreSQL does not change
this authorization boundary.

For unattended releases with independent approval, a local root administrator
installs `/etc/serverdesk-agent/release-policy.json` and the independent
publisher's **public** Ed25519 key. The private key stays on a separately
administered publisher, never on the panel or business node. The file's shape is:

```json
{
  "version": 1,
  "mode": "strict",
  "serverId": "the-registered-server-id",
  "maxReleaseLifetimeSeconds": 900,
  "keys": {"publisher-v1": "/etc/serverdesk-agent/publisher.pub"},
  "services": {
    "web-service-id": {
      "repository": "owner/repository",
      "branch": "main",
      "serviceSha256": "SHA256_OF_CANONICAL_SERVICE_TEMPLATE",
      "imageRepositories": ["registry.example.com/team/web"],
      "environmentFile": "/etc/serverdesk-agent/secrets/web.json"
    }
  }
}
```

All policy files, keys, ancestors, configuration and installed programs must be
root-owned with no group/other write permission and no symlinks. Environment
files must also have no group/other access (normally `0600`). The environment
file is an optional JSON object of string variables, for example
`{"DATABASE_URL":"..."}`; its values stay on the business node and are merged
only after signature verification. Signed service `environment` must be empty.
Restart `serverdesk-agent.service` after a local policy change. Invalid strict
configuration prevents startup rather than silently reverting to compatibility.

`serviceSha256` pins the complete approved Service object after removing only
`image` and `lastCommit`. Fields including `kind`, `target`, repository, branch,
ports, named volumes, `autoDeploy`, `createdAt` and `updatedAt` remain pinned.
The shared canonical JSON encoding recursively sorts ASCII object keys, emits
compact UTF-8 JSON, rejects surrogate strings, floats and integers outside
JavaScript's safe range. Object values may contain Unicode. This is implemented
by `canonical_bytes` in `daemon.py` and the publisher's shared release module.

Strict mode currently supports only void0-owned `kind: "image"` services
with `target: {}` and an approved repository's exact `@sha256:` image digest.
Source builds, imported Compose targets, host bind mounts, Docker socket mounts,
extra privilege fields and remotely supplied source archives are rejected.
Docker/K3s installation and all `kubernetes-action` operations are also blocked;
prepare the runtime locally before enabling strict mode. Empty probes and
`status` requests containing only a valid `jobId` remain available. This check
runs before every locally installed operation program, so another fixed program
cannot serve as an unsigned mutation bypass.

The signed submit wire format is:

```json
{
  "plan": {"service": {}, "server": {}, "job": {}},
  "authorization": {
    "manifest": "BASE64_OF_EXACT_MANIFEST_UTF8_BYTES",
    "signature": "BASE64_OF_ED25519_SIGNATURE_OF_THOSE_BYTES"
  }
}
```

The manifest has exactly `version: 1`, `keyId`, `releaseId`, positive increasing
`sequence`, integer Unix-second `issuedAt` and `expiresAt`, `serverId`,
`serviceId`, `repository`, `branch`, `payloadSha256`, and optional `commit`.
`payloadSha256` is SHA-256 of canonical `{"plan":...}` without `authorization`.
If `commit` is present it must match the Service's `lastCommit`. The node verifies
Ed25519 using the local `/usr/bin/openssl`, checks expiry (at most one hour,
15 minutes by default), targets, source, full payload and local service policy.
The publisher supplies a fully determined image plan, without build archives or
any credentials. Routine approved image changes need no online Mac or manual
per-release approval.

Accepted sequence numbers are saved atomically under
`/var/lib/serverdesk-agent/releases` **before** execution. A replay or lower
sequence is rejected even if the controller changes its command ID or the
daemon restarts. A failed deployment still consumes its authorization; retrying
requires a fresh higher sequence. Restore/backup the release ledger carefully:
do not roll it back independently of the trusted publisher's sequence state.

This protects deployment authority, not all availability or confidentiality.
The panel can withhold releases and can read the status/log data allowed by the
installed programs. Compromise of the trusted publisher, approved source or node
root can still compromise applications. Two containers under the same host's
administrator do not constitute independent trust. Initial installation and OS
updates execute root code: verify and obtain that code through a trusted process;
running a new installer from a compromised panel can replace these protections.

Run the authorization suite with
`python3 -m unittest discover -s agent/tests -v`. For the complete root ownership
and malicious-controller HTTP/restart tests, run it as root in an isolated Linux
VM; the macOS unit run explicitly skips that integration case.
