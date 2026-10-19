#!/usr/bin/env python3
"""void0's outbound-only, fixed-operation server agent (Python 3 stdlib)."""
import argparse
import base64
import binascii
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import selectors
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.3.0"
MAX_RESPONSE = 80 * 1024 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
OPERATIONS = frozenset(("probe", "bootstrap", "submit", "status", "kubernetes-action"))
MUTATIONS = frozenset(("bootstrap", "submit", "kubernetes-action"))


class AgentError(Exception):
    pass


class RequestRejected(AgentError):
    def __init__(self, status):
        self.status = status
        super().__init__("Management request rejected (HTTP %d)." % status)

    @property
    def permanent(self):
        return 400 <= self.status < 500 and self.status not in (408, 425, 429)


def central_url(value):
    parsed = urllib.parse.urlsplit(value.strip())
    if (parsed.scheme != "https" and not
            (parsed.scheme == "http" and parsed.hostname == "127.0.0.1")):
        raise AgentError("The management URL must use HTTPS (127.0.0.1 HTTP is allowed for development).")
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or
            parsed.fragment or parsed.path not in ("", "/")):
        raise AgentError("Use the management URL's origin, without credentials or a path.")
    try:
        parsed.port
    except ValueError:
        raise AgentError("Invalid management URL port.")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def private_json(path, value):
    """Replace private state atomically; never follow an existing file symlink."""
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink():
        raise AgentError("Refusing a symlink in agent state.")
    fd, temporary = tempfile.mkstemp(prefix=".serverdesk-", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        descriptor = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def read_private_json(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise AgentError("Agent configuration is missing or unsafe.")
    info = path.stat()
    if info.st_mode & 0o077:
        raise AgentError("Agent configuration must have mode 0600.")
    if info.st_uid != os.geteuid():
        raise AgentError("Agent configuration must belong to the service user.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        raise AgentError("Agent configuration cannot be read.")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise AgentError("The management server must not redirect agent requests.")


class Central:
    def __init__(self, url, token=None):
        self.url = central_url(url)
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def post(self, path, value):
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json",
                   "User-Agent": "void0-OS/" + VERSION}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(self.url + path, body, headers, method="POST")
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise AgentError("The management response exceeds the size limit.")
            result = json.loads(raw) if raw else {}
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except urllib.error.HTTPError as error:
            # Never include URLs, request bodies, response bodies or credential headers.
            raise RequestRejected(error.code)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            raise AgentError("The management server is unavailable or returned invalid data.")


def register(config_path, management_url=None):
    # Interactive input keeps both pairing codes and tokens out of shell history/argv.
    url = central_url(management_url or input("void0 management URL: ").strip())
    pairing_token = getpass.getpass("One-time pairing code: ").strip()
    if not pairing_token or len(pairing_token) > 1024:
        raise AgentError("A valid one-time pairing code is required.")
    result = Central(url).post("/api/agent/register", {
        "pairingToken": pairing_token, "hostname": socket.gethostname(), "version": VERSION,
    })
    token, server_id = result.get("token"), result.get("serverId")
    if not isinstance(token, str) or not token or not isinstance(server_id, str) or not server_id:
        raise AgentError("The registration response is incomplete.")
    private_json(config_path, {"url": url, "token": token, "serverId": server_id})
    print("void0 OS registered successfully.")


def sensitive_strings(value):
    result = set()

    def visit(item, sensitive=False):
        if isinstance(item, dict):
            for key, child in item.items():
                visit(child, sensitive or key.lower() in
                      ("environment", "token", "password", "privatekey", "secret", "authorization"))
        elif isinstance(item, list):
            for child in item:
                visit(child, sensitive)
        elif sensitive and isinstance(item, str) and len(item) >= 3:
            result.add(item)

    visit(value)
    return sorted(result, key=len, reverse=True)


def redact_result(value, secrets):
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, dict):
        return {key: redact_result(child, secrets) for key, child in value.items()}
    if isinstance(value, list):
        return [redact_result(child, secrets) for child in value]
    return value


def unique_object(pairs):
    value = {}
    for key, child in pairs:
        if key in value:
            raise AgentError("Duplicate JSON fields are not permitted in release authorization.")
        value[key] = child
    return value


def canonical_bytes(value):
    """Shared publisher format: ASCII keys, UTF-8 values, safe integers, no floats."""
    def check(item):
        if item is None or type(item) is bool:
            return
        if type(item) is int and abs(item) <= 9007199254740991:
            return
        if isinstance(item, str):
            if any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                raise AgentError("Release strings must be valid Unicode.")
            return
        if isinstance(item, list):
            for child in item:
                check(child)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str) or not re.fullmatch(r"[\x20-\x7e]+", key):
                    raise AgentError("Release object fields must be ASCII strings.")
                check(key)
                check(child)
            return
        raise AgentError("Release data must use safe JSON integers and values.")
    check(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def trusted_root_file(path, maximum=1024 * 1024, private=False):
    """The control plane cannot change a root-owned local trust anchor."""
    path = Path(path)
    if not path.is_absolute() or os.path.normpath(str(path)) != str(path):
        raise AgentError("Release policy paths must be absolute and normalized.")
    for ancestor in reversed((path,) + tuple(path.parents)):
        try:
            info = ancestor.lstat()
        except OSError:
            raise AgentError("A local release policy file is unavailable.")
        if (stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or
                (ancestor != path and not stat.S_ISDIR(info.st_mode))):
            raise AgentError("Local release policy files and directories must be root-owned and not writable by others.")
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or (private and info.st_mode & 0o077):
        raise AgentError("A local release policy file has unsafe permissions or size.")
    return path.read_bytes()


def trusted_ed25519_key(path):
    raw = trusted_root_file(path, maximum=16384)
    try:
        lines = raw.decode("ascii").strip().splitlines()
        if lines[0] != "-----BEGIN PUBLIC KEY-----" or lines[-1] != "-----END PUBLIC KEY-----":
            raise ValueError()
        der = base64.b64decode("".join(lines[1:-1]), validate=True)
        # RFC 8410 SubjectPublicKeyInfo: id-Ed25519, no parameters, 32-bitstring bytes.
        if len(der) != 44 or not der.startswith(bytes.fromhex("302a300506032b6570032100")):
            raise ValueError()
    except (ValueError, UnicodeError, IndexError, binascii.Error):
        raise AgentError("Trusted publisher keys must be Ed25519 SubjectPublicKeyInfo PEM files.")
    return raw


class ReleasePolicy:
    """Authorization is checked on the business node before ANY installed program."""
    OPENSSL = "/usr/bin/openssl"
    SERVICE_FIELDS = frozenset(("id", "name", "kind", "serverId", "target", "image", "repository",
                                "branch", "dockerfile", "context", "containerPort", "hostPort", "environment",
                                "volumes", "autoDeploy", "lastCommit", "createdAt", "updatedAt"))
    MANIFEST_FIELDS = frozenset(("version", "keyId", "releaseId", "sequence", "issuedAt", "expiresAt",
                                 "serverId", "serviceId", "repository", "branch", "payloadSha256"))

    def __init__(self, path, server_id, state_directory):
        self.path = Path(path)
        self.server_id = server_id
        self.state_directory = Path(state_directory)
        self.policy = {"version": 1, "mode": "compatibility"}
        if self.path.is_symlink():
            raise AgentError("The release policy must not be a symlink.")
        if self.path.exists():
            try:
                self.policy = json.loads(trusted_root_file(self.path), object_pairs_hook=unique_object)
            except (ValueError, OSError):
                raise AgentError("The local release policy is invalid.")
        if not isinstance(self.policy, dict) or type(self.policy.get("version")) is not int or self.policy.get("version") != 1 or self.policy.get("mode") not in ("strict", "compatibility"):
            raise AgentError("The local release policy version or mode is invalid.")
        if self.mode == "strict":
            if os.geteuid() != 0:
                raise AgentError("Strict release verification requires the root-owned system service.")
            if self.policy.get("serverId") != server_id:
                raise AgentError("The release policy belongs to another server.")
            keys, services = self.policy.get("keys"), self.policy.get("services")
            if not isinstance(keys, dict) or not keys or len(keys) > 16 or not isinstance(services, dict) or len(services) > 1024:
                raise AgentError("The release policy needs trusted keys and explicit service rules.")
            lifetime = self.policy.get("maxReleaseLifetimeSeconds", 900)
            if type(lifetime) is not int or not 1 <= lifetime <= 3600:
                raise AgentError("The maximum release lifetime must be 1–3600 seconds.")
            trusted_root_file(self.OPENSSL, maximum=32 * 1024 * 1024)
            for key_id, filename in keys.items():
                if not isinstance(key_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", key_id) or not isinstance(filename, str):
                    raise AgentError("A trusted publisher key identifier or path is invalid.")
                trusted_ed25519_key(filename)
            for service_id, rule in services.items():
                if (not isinstance(service_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", service_id) or
                        not isinstance(rule, dict) or set(rule) - {"repository", "branch", "serviceSha256", "imageRepositories", "environmentFile"} or
                        not isinstance(rule.get("repository"), str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", rule["repository"]) or
                        not isinstance(rule.get("branch"), str) or not 1 <= len(rule["branch"]) <= 200 or
                        not isinstance(rule.get("serviceSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", rule["serviceSha256"]) or
                        not isinstance(rule.get("imageRepositories"), list) or not 1 <= len(rule["imageRepositories"]) <= 16 or
                        any(not isinstance(image, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:-]{0,450}", image) for image in rule["imageRepositories"])):
                    raise AgentError("A local service authorization rule is incomplete or invalid.")
                if "environmentFile" in rule:
                    if not isinstance(rule["environmentFile"], str):
                        raise AgentError("A local service environment path is invalid.")
                    trusted_root_file(rule["environmentFile"], private=True)
            self._prepare_state()

    @property
    def mode(self):
        return self.policy["mode"]

    @property
    def summary(self):
        return {"mode": self.mode, "policyVersion": 1}

    def _prepare_state(self):
        self.state_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        for path in reversed((self.state_directory,) + tuple(self.state_directory.parents)):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise AgentError("The local release ledger must use a root-owned directory.")
        if self.state_directory.stat().st_mode & 0o077:
            raise AgentError("The local release ledger directory must have mode 0700.")

    def _verify(self, raw, signature, key_path):
        # No publisher key or command-line argument is supplied by the controller.
        trusted_ed25519_key(key_path)
        with tempfile.TemporaryDirectory(prefix=".verify-", dir=self.state_directory) as folder:
            manifest = Path(folder) / "manifest"
            signed = Path(folder) / "signature"
            manifest.write_bytes(raw)
            signed.write_bytes(signature)
            command = [self.OPENSSL, "pkeyutl", "-verify", "-pubin", "-inkey", key_path,
                       "-rawin", "-in", str(manifest), "-sigfile", str(signed)]
            try:
                result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, timeout=10,
                                        env={"PATH": "/usr/bin:/bin", "LANG": "C"})
            except (OSError, subprocess.SubprocessError):
                raise AgentError("The publisher signature could not be verified.")
            if result.returncode != 0:
                raise AgentError("The publisher signature is invalid.")

    def _consume(self, manifest):
        # Fail closed: record before submit, even if a later Docker operation fails.
        # A retry needs a newly approved, increasing release sequence.
        digest = hashlib.sha256(manifest["serviceId"].encode("utf-8")).hexdigest()
        path = self.state_directory / (digest + ".json")
        lock_path = self.state_directory / (digest + ".lock")
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            if path.exists() or path.is_symlink():
                previous = read_private_json(path)
                if (not isinstance(previous, dict) or type(previous.get("sequence")) is not int or
                        manifest["sequence"] <= previous["sequence"]):
                    raise AgentError("This release is a replay or an unauthorized downgrade.")
            private_json(path, {"sequence": manifest["sequence"], "releaseId": manifest["releaseId"],
                                "payloadSha256": manifest["payloadSha256"]})
        finally:
            os.close(fd)

    def authorize(self, operation, payload):
        if self.mode != "strict":
            return payload
        if operation == "probe":
            if payload:
                raise AgentError("Strict server probes do not accept parameters.")
            return payload
        if operation == "status":
            if set(payload) != {"jobId"} or not isinstance(payload["jobId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", payload["jobId"]):
                raise AgentError("Strict status queries only accept a valid job identifier.")
            return payload
        if operation != "submit":
            raise AgentError("Strict mode blocks remote installation and Kubernetes changes; use the server's local administrator.")
        if set(payload) != {"plan", "authorization"} or not isinstance(payload.get("plan"), dict):
            raise AgentError("Strict deployments require an exact signed image plan; source archives and extra fields are not allowed.")
        authorization = payload["authorization"]
        if not isinstance(authorization, dict) or set(authorization) != {"manifest", "signature"}:
            raise AgentError("An independent publisher authorization is required.")
        try:
            if (not isinstance(authorization["manifest"], str) or len(authorization["manifest"]) > 32768 or
                    not isinstance(authorization["signature"], str) or len(authorization["signature"]) > 128):
                raise ValueError()
            raw = base64.b64decode(authorization["manifest"], validate=True)
            signature = base64.b64decode(authorization["signature"], validate=True)
            manifest = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
        except (ValueError, UnicodeError, binascii.Error):
            raise AgentError("The publisher authorization encoding is invalid.")
        if (not isinstance(manifest, dict) or set(manifest) not in (self.MANIFEST_FIELDS, self.MANIFEST_FIELDS | {"commit"}) or
                type(manifest.get("version")) is not int or manifest.get("version") != 1 or len(signature) != 64 or
                any(not isinstance(manifest.get(key), str) for key in ("keyId", "serverId", "serviceId", "repository", "branch", "payloadSha256"))):
            raise AgentError("The publisher authorization format is invalid.")
        key_path = self.policy["keys"].get(manifest.get("keyId"))
        if not key_path:
            raise AgentError("This publisher key is not trusted by the server.")
        self._verify(raw, signature, key_path)
        now = int(time.time())
        if (any(type(manifest.get(key)) is not int for key in ("sequence", "issuedAt", "expiresAt")) or
                not 1 <= manifest["sequence"] <= 9007199254740991 or manifest["issuedAt"] > now + 30 or
                manifest["expiresAt"] <= now or manifest["expiresAt"] <= manifest["issuedAt"] or
                manifest["expiresAt"] - manifest["issuedAt"] > self.policy.get("maxReleaseLifetimeSeconds", 900)):
            raise AgentError("The publisher authorization expired or has invalid time/version limits.")
        if not isinstance(manifest.get("releaseId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", manifest["releaseId"]):
            raise AgentError("The release identifier is invalid.")
        if manifest.get("serverId") != self.server_id:
            raise AgentError("The release targets another server.")
        plan = payload["plan"]
        if set(plan) != {"service", "server", "job"}:
            raise AgentError("Strict mode does not build source or accept additional plan fields.")
        service, server, job = plan.get("service"), plan.get("server"), plan.get("job")
        if not all(isinstance(value, dict) for value in (service, server, job)):
            raise AgentError("The signed deployment plan is incomplete.")
        service_id = service.get("id")
        if not isinstance(service_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", service_id):
            raise AgentError("The release service identifier is invalid.")
        rule = self.policy["services"].get(service_id)
        if not isinstance(rule, dict) or manifest.get("serviceId") != service_id:
            raise AgentError("This service is not authorized on the server.")
        if (server.get("id") != self.server_id or service.get("serverId") != self.server_id or
                job.get("serverId") != self.server_id or job.get("serviceId") != service_id or
                job.get("type") != "deploy" or not isinstance(job.get("id"), str) or
                not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job["id"])):
            raise AgentError("The signed release contains inconsistent server, service or job targets.")
        service_repository = service.get("repository")
        if not isinstance(service_repository, str) or not re.fullmatch(r"(?:https://github\.com/)?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", service_repository):
            raise AgentError("The service repository must use an exact GitHub repository name or HTTPS URL.")
        if service_repository.startswith("https://github.com/"):
            service_repository = service_repository[len("https://github.com/"):]
        if (manifest.get("repository") != rule.get("repository") or manifest.get("branch") != rule.get("branch") or
                service_repository != rule.get("repository") or service.get("branch") != rule.get("branch")):
            raise AgentError("The release source does not match the server's local policy.")
        if "commit" in manifest and (not isinstance(manifest["commit"], str) or not re.fullmatch(r"[a-f0-9]{40,64}", manifest["commit"]) or service.get("lastCommit") != manifest["commit"]):
            raise AgentError("The release source revision is inconsistent.")
        unsigned = {"plan": plan}
        actual = hashlib.sha256(canonical_bytes(unsigned)).hexdigest()
        if manifest.get("payloadSha256") != actual:
            raise AgentError("The deployment plan was changed after publisher approval.")
        if set(service) - self.SERVICE_FIELDS or service.get("kind") != "image" or service.get("target") != {}:
            raise AgentError("Strict releases support owned image services only, without host or existing Compose targets.")
        # Every service field apart from its immutable image and last source revision
        # is pinned locally. An independent signature alone cannot broaden privileges.
        template = {key: value for key, value in service.items() if key not in ("image", "lastCommit")}
        if hashlib.sha256(canonical_bytes(template)).hexdigest() != rule.get("serviceSha256"):
            raise AgentError("The release changes the service configuration authorized on this server.")
        image = service.get("image")
        if not isinstance(image, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:-]{0,450}@sha256:[a-f0-9]{64}", image):
            raise AgentError("Strict releases require an immutable image digest.")
        repositories = rule.get("imageRepositories")
        if not isinstance(repositories, list) or image.split("@", 1)[0] not in repositories:
            raise AgentError("The image repository is not approved by the local policy.")
        if service.get("environment") not in (None, {}):
            raise AgentError("Strict release secrets belong in a root-owned local environment file.")
        volumes = service.get("volumes") or []
        if not isinstance(volumes, list):
            raise AgentError("Strict release volumes must be a list of approved named volumes.")
        for volume in volumes:
            if (not isinstance(volume, dict) or set(volume) != {"name", "mountPath"} or
                    not isinstance(volume.get("name"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}", volume["name"]) or
                    not isinstance(volume.get("mountPath"), str) or not volume["mountPath"].startswith("/") or
                    ".." in volume["mountPath"].split("/") or ":" in volume["mountPath"] or
                    any(ord(char) < 32 for char in volume["mountPath"]) or
                    volume["mountPath"].rstrip("/") in ("/var/run/docker.sock", "/run/docker.sock")):
                raise AgentError("Strict releases only allow pinned named volumes, without Docker sockets or host paths.")
        environment = None
        if "environmentFile" in rule:
            try:
                environment = json.loads(trusted_root_file(rule["environmentFile"], private=True), object_pairs_hook=unique_object)
            except (ValueError, OSError, TypeError):
                raise AgentError("The service's local environment file is invalid.")
            if not isinstance(environment, dict) or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str) or "\x00" in value for key, value in environment.items()):
                raise AgentError("The service's local environment must contain valid string variables.")
        self._consume(manifest)
        if environment is not None:
            # This value comes only from the node's local root policy, never the panel.
            return {"plan": {**plan, "service": {**service, "environment": environment}}}
        return unsigned


class Programs:
    def __init__(self, path, release_policy=None):
        # This file is installed with the agent, never accepted from a command payload.
        path = Path(path)
        if path.is_symlink() or not path.is_file():
            raise AgentError("The installed operation programs are missing or unsafe.")
        info = path.stat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise AgentError("Operation programs must be owned by the service user and not writable by others.")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            self.programs = value.get("programs", value)
            if not isinstance(self.programs, dict):
                raise ValueError()
        except (OSError, ValueError):
            raise AgentError("The installed operation programs are invalid.")
        self.release_policy = release_policy

    def execute(self, operation, payload, stop):
        if operation not in OPERATIONS:
            return {"ok": False, "error": "This operation is not supported.", "outcomeKnown": True}
        if not isinstance(payload, dict):
            return {"ok": False, "error": "The operation payload must be an object.", "outcomeKnown": True}
        try:
            if self.release_policy is not None:
                payload = self.release_policy.authorize(operation, payload)
        except AgentError as error:
            return {"ok": False, "error": str(error), "outcomeKnown": True}
        spec = self.programs.get(operation)
        if operation == "bootstrap":
            runtime = payload.get("runtime", "docker")
            if runtime not in ("docker", "k3s"):
                return {"ok": False, "error": "Unsupported server runtime.", "outcomeKnown": True}
            spec = spec.get(runtime) if isinstance(spec, dict) else None
        if not isinstance(spec, dict) or not isinstance(spec.get("script"), str):
            return {"ok": False, "error": "This operation is unavailable in the installed agent.", "outcomeKnown": True}
        language = spec.get("language", "python")
        if language not in ("python", "shell"):
            return {"ok": False, "error": "Invalid installed operation language.", "outcomeKnown": True}
        command = [sys.executable, "-c", spec["script"]] if language == "python" else ["/bin/sh", "-c", spec["script"]]
        timeout = min(max(float(spec.get("timeoutSeconds", 3600 if operation in MUTATIONS else 60)), 1), 7200)
        output_limit = min(max(int(spec.get("outputLimit", MAX_OUTPUT)), 1024), MAX_OUTPUT)
        secrets = sensitive_strings(payload)
        child = None
        try:
            child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, start_new_session=True,
                                     env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                                          "HOME": "/root", "LANG": "C.UTF-8"})
            # Feeding stdin in a helper avoids deadlock if an operation writes before reading stdin.
            raw_input = json.dumps(payload, separators=(",", ":")).encode("utf-8")

            def feed():
                try:
                    child.stdin.write(raw_input)
                    child.stdin.close()
                except (BrokenPipeError, OSError, ValueError):
                    pass

            feeder = threading.Thread(target=feed, daemon=True)
            feeder.start()
            output, errors = bytearray(), bytearray()
            start = time.monotonic()
            with selectors.DefaultSelector() as reader:
                reader.register(child.stdout, selectors.EVENT_READ, output)
                reader.register(child.stderr, selectors.EVENT_READ, errors)
                while reader.get_map() or child.poll() is None:
                    if stop.is_set() or time.monotonic() - start > timeout:
                        raise AgentError("The operation was interrupted or timed out.")
                    if not reader.get_map():
                        stop.wait(0.2)
                        continue
                    for key, _ in reader.select(timeout=0.2):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            reader.unregister(key.fileobj)
                        else:
                            key.data.extend(chunk)
                            if len(output) + len(errors) > output_limit:
                                raise AgentError("The operation output exceeded the size limit.")
            code = child.wait(timeout=5)
            feeder.join(timeout=1)
            if code != 0:
                raise AgentError("The installed operation failed (exit %d)." % code)
            if operation == "bootstrap" or spec.get("format") == "text":
                value = {"log": (output + errors).decode("utf-8", errors="replace")}
            else:
                value = json.loads(output.decode("utf-8"))
            return {"ok": True, "value": redact_result(value, secrets)}
        except (AgentError, OSError, ValueError, subprocess.SubprocessError) as error:
            message = str(error) if isinstance(error, AgentError) else "The installed operation did not return valid output."
            return {"ok": False, "error": message, "outcomeKnown": operation not in MUTATIONS}
        finally:
            if child is not None:
                # Detached deployment workers intentionally survive; only the operation process
                # group is stopped here if the submit/probe/bootstrap wrapper did not finish.
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                        child.wait(timeout=3)
                    except (ProcessLookupError, subprocess.TimeoutExpired):
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.wait()
                for stream in (child.stdin, child.stdout, child.stderr):
                    if stream is not None:
                        stream.close()


class Agent:
    def __init__(self, config_path, programs_path, state_dir, policy_path="/etc/serverdesk-agent/release-policy.json"):
        config = read_private_json(config_path)
        if not isinstance(config, dict) or not all(isinstance(config.get(key), str) and config[key] for key in ("url", "token", "serverId")):
            raise AgentError("The registered agent configuration is incomplete.")
        self.central = Central(config["url"], config["token"])
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.state_dir.is_symlink() or self.state_dir.stat().st_mode & 0o077 or self.state_dir.stat().st_uid != os.geteuid():
            raise AgentError("Agent state must be a private directory.")
        self.release_policy = ReleasePolicy(policy_path, config["serverId"], self.state_dir.parent / "releases")
        if self.release_policy.mode == "strict":
            trusted_root_file(config_path, private=True)
            trusted_root_file(programs_path, maximum=8 * 1024 * 1024)
        self.programs = Programs(programs_path, self.release_policy)
        self.stop = threading.Event()
        self.pending = queue.Queue(maxsize=1)
        self.busy = threading.Event()
        self.lock = None

    def record_path(self, command_id):
        return self.state_dir / (hashlib.sha256(command_id.encode("utf-8")).hexdigest() + ".json")

    def report(self, command_id, result):
        encoded = urllib.parse.quote(command_id, safe="")
        # Idempotent ack also recovers an ack whose response was lost before a restart.
        self.central.post("/api/agent/commands/" + encoded + "/ack", {})
        self.central.post("/api/agent/commands/" + encoded + "/result", result)

    def recover(self):
        for path in self.state_dir.glob("*.json"):
            record = read_private_json(path)
            if not isinstance(record, dict) or not isinstance(record.get("id"), str):
                raise AgentError("Agent command history is invalid.")
            if record.get("state") in ("received", "running"):
                record = {"id": record["id"], "state": "completed", "result": {
                    "ok": False, "error": "The agent restarted after receiving this command; its outcome is unknown.",
                    "outcomeKnown": False}}
                private_json(path, record)

    def flush_results(self):
        for path in self.state_dir.glob("*.json"):
            record = read_private_json(path)
            if record.get("state") == "completed":
                try:
                    self.report(record["id"], record["result"])
                except RequestRejected as error:
                    if not error.permanent:
                        raise
                    # A backend timeout/restart may already have made the result unknown.
                    # Do not let an obsolete receipt block heartbeats and subsequent probes.
                    private_json(path, {"id": record["id"], "state": "rejected"})
                    continue
                # Retain the receipt id, never the payload/result after the server confirms.
                private_json(path, {"id": record["id"], "state": "reported"})

    def worker(self):
        while not self.stop.is_set():
            try:
                command = self.pending.get(timeout=0.2)
            except queue.Empty:
                continue
            command_id = command["id"]
            path = self.record_path(command_id)
            try:
                acknowledged = False
                while not self.stop.is_set():
                    try:
                        self.central.post("/api/agent/commands/" + urllib.parse.quote(command_id, safe="") + "/ack", {})
                        acknowledged = True
                        break
                    except RequestRejected as error:
                        if error.permanent:
                            private_json(path, {"id": command_id, "state": "rejected"})
                            break
                        self.stop.wait(2)
                    except AgentError:
                        self.stop.wait(2)
                if self.stop.is_set() or not acknowledged:
                    continue
                private_json(path, {"id": command_id, "state": "running"})
                result = self.programs.execute(command["operation"], command["payload"], self.stop)
                private_json(path, {"id": command_id, "state": "completed", "result": result})
                # Poll thread performs result delivery, so a slow management connection never
                # prevents the worker from making its result durable.
            except Exception:
                # Never print exception values: dependencies may include sensitive stdin.
                print("Agent command could not complete; the server will show an unknown outcome.", file=sys.stderr, flush=True)
                try:
                    private_json(path, {"id": command_id, "state": "completed", "result": {
                        "ok": False, "error": "The agent could not confirm the operation outcome.", "outcomeKnown": False}})
                except OSError:
                    pass
            finally:
                self.busy.clear()
                self.pending.task_done()

    def accept(self, command):
        if not isinstance(command, dict):
            raise AgentError("Invalid command response.")
        command_id = command.get("id")
        if not isinstance(command_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", command_id):
            raise AgentError("Invalid command identifier.")
        path = self.record_path(command_id)
        if path.exists():
            # A repeated network delivery must never repeat a destructive operation.
            return
        if self.busy.is_set():
            raise AgentError("The server issued a command while the agent is busy.")
        if command.get("operation") not in OPERATIONS or not isinstance(command.get("payload"), dict):
            private_json(path, {"id": command_id, "state": "completed", "result": {
                "ok": False, "error": "Unsupported operation or invalid payload.", "outcomeKnown": True}})
            return
        private_json(path, {"id": command_id, "state": "received"})
        self.busy.set()
        self.pending.put_nowait(command)

    def run(self):
        self.lock = (self.state_dir / "daemon.lock").open("a")
        os.chmod(self.state_dir / "daemon.lock", 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AgentError("Another void0 OS is already running.")
        self.recover()
        worker = threading.Thread(target=self.worker, daemon=True)
        worker.start()
        print("void0 OS started; outbound management connection only.", flush=True)
        print("Release authorization: " + ("strict independent publisher verification." if self.release_policy.mode == "strict" else
              "compatibility; independent publisher verification is NOT enabled."), flush=True)
        while not self.stop.is_set():
            interval = 2
            try:
                self.flush_results()
                result = self.central.post("/api/agent/poll", {
                    "version": VERSION, "hostname": socket.gethostname(), "busy": self.busy.is_set(),
                    "deploymentProtection": self.release_policy.summary})
                command = result.get("command")
                if command is not None:
                    self.accept(command)
                candidate = result.get("pollIntervalSeconds", 2)
                if isinstance(candidate, (int, float)):
                    interval = min(max(candidate, 0.1), 30)
            except AgentError:
                # A generic status message is deliberately used instead of response content.
                print("Agent management connection unavailable; retrying.", file=sys.stderr, flush=True)
            self.stop.wait(interval)
        worker.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description="void0 OS outbound management service")
    parser.add_argument("mode", choices=("run", "register", "version"), nargs="?", default="run")
    parser.add_argument("--config", default="/etc/serverdesk-agent/config.json")
    parser.add_argument("--programs", default="/opt/serverdesk-agent/programs.json")
    parser.add_argument("--state-dir", default="/var/lib/serverdesk-agent/commands")
    parser.add_argument("--policy", default="/etc/serverdesk-agent/release-policy.json",
                        help="Root-owned local release policy; the management panel cannot change it")
    parser.add_argument("--url", help="Management origin for interactive registration (never a pairing code)")
    args = parser.parse_args()
    if args.mode == "version":
        print(VERSION)
        return 0
    try:
        if args.mode == "register":
            register(args.config, args.url)
            return 0
        agent = Agent(args.config, args.programs, args.state_dir, args.policy)
        signal.signal(signal.SIGTERM, lambda *_: agent.stop.set())
        signal.signal(signal.SIGINT, lambda *_: agent.stop.set())
        agent.run()
        return 0
    except (AgentError, OSError, KeyboardInterrupt, EOFError) as error:
        print(str(error) if isinstance(error, AgentError) else "Agent startup failed.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
