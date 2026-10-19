"""Run with python3 -m unittest discover -s agent/tests -v.

Linux root runs the complete policy constructor and filesystem checks. On macOS,
the authorization unit cases use an in-memory policy fixture and the available
OpenSSL 3; root ownership itself is tested separately with a synthetic stat.
"""
import base64
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("serverdesk_agent", Path(__file__).parents[1] / "daemon.py")
AGENT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AGENT)
OPENSSL = "/usr/bin/openssl"
if os.uname().sysname == "Darwin":
    OPENSSL = "/opt/homebrew/opt/openssl@3/bin/openssl"


class ReleasePolicyTests(unittest.TestCase):
    def setUp(self):
        self.root = os.geteuid() == 0
        parent = None
        if self.root:
            parent = "/var/lib/serverdesk-release-policy-tests"
            Path(parent).mkdir(mode=0o700, exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="serverdesk-policy-", dir=parent))
        self.addCleanup(lambda: shutil.rmtree(self.directory))
        self.private_key = self.directory / "publisher.key"
        self.public_key = self.directory / "publisher.pub"
        subprocess.run([OPENSSL, "genpkey", "-algorithm", "ED25519", "-out", str(self.private_key)], check=True, capture_output=True)
        subprocess.run([OPENSSL, "pkey", "-in", str(self.private_key), "-pubout", "-out", str(self.public_key)], check=True, capture_output=True)
        self.public_key.chmod(0o600)
        self.service = {"id": "web", "name": "测试网站", "kind": "image", "serverId": "node-one", "target": {},
                        "repository": "acme/web", "branch": "main", "autoDeploy": True, "environment": {},
                        "volumes": [{"name": "uploads", "mountPath": "/data"}], "containerPort": 8080,
                        "hostPort": 18080, "createdAt": "2026-10-19T00:00:00Z", "updatedAt": "2026-10-19T00:00:00Z"}
        self.template_hash = hashlib.sha256(AGENT.canonical_bytes(self.service)).hexdigest()
        self.value = {"version": 1, "mode": "strict", "serverId": "node-one", "maxReleaseLifetimeSeconds": 900,
                      "keys": {"publisher-v1": str(self.public_key)}, "services": {"web": {
                          "repository": "acme/web", "branch": "main", "serviceSha256": self.template_hash,
                          "imageRepositories": ["registry.example/acme/web"]}}}
        self.policy_path = self.directory / "release-policy.json"
        self.policy_path.write_text(json.dumps(self.value))
        self.policy_path.chmod(0o600)
        self.state = self.directory / "releases"
        if self.root:
            self.policy = AGENT.ReleasePolicy(self.policy_path, "node-one", self.state)
        else:
            self.policy = object.__new__(AGENT.ReleasePolicy)
            self.policy.path, self.policy.server_id = self.policy_path, "node-one"
            self.policy.state_directory, self.policy.policy = self.state, copy.deepcopy(self.value)
            self.state.mkdir(mode=0o700)
            # Only filesystem ownership is substituted on macOS; real Ed25519
            # signing/verifying, exact programs, receipts and all rejection logic run.
            replacement = patch.object(AGENT, "trusted_root_file", side_effect=lambda path, **_: Path(path).read_bytes())
            replacement.start()
            self.addCleanup(replacement.stop)
        self.policy.OPENSSL = OPENSSL

    def request(self, sequence=1, mutate=None, manifest_change=None):
        service = {**copy.deepcopy(self.service), "image": "registry.example/acme/web@sha256:" + "a" * 64,
                   "lastCommit": "b" * 40}
        plan = {"service": service, "server": {"id": "node-one"},
                "job": {"id": "job-" + str(sequence), "serverId": "node-one", "serviceId": "web", "type": "deploy"}}
        payload = {"plan": plan}
        if mutate:
            mutate(payload)
        now = int(time.time())
        manifest = {"version": 1, "keyId": "publisher-v1", "releaseId": "release-" + str(sequence),
                    "sequence": sequence, "issuedAt": now - 1, "expiresAt": now + 299, "serverId": "node-one",
                    "serviceId": "web", "repository": "acme/web", "branch": "main", "commit": "b" * 40,
                    "payloadSha256": hashlib.sha256(AGENT.canonical_bytes(payload)).hexdigest()}
        if manifest_change:
            manifest.update(manifest_change)
        raw = AGENT.canonical_bytes(manifest)
        manifest_path, sig_path = self.directory / "manifest", self.directory / "signature"
        manifest_path.write_bytes(raw)
        subprocess.run([OPENSSL, "pkeyutl", "-sign", "-inkey", str(self.private_key), "-rawin", "-in",
                        str(manifest_path), "-out", str(sig_path)], check=True, capture_output=True)
        return {**payload, "authorization": {"manifest": base64.b64encode(raw).decode(),
                                             "signature": base64.b64encode(sig_path.read_bytes()).decode()}}

    def reject(self, payload, message=None):
        with self.assertRaises(AGENT.AgentError) as error:
            self.policy.authorize("submit", payload)
        if message:
            self.assertIn(message, str(error.exception))

    def test_valid_signed_image_is_executed_and_authorization_is_removed(self):
        result = self.policy.authorize("submit", self.request())
        self.assertEqual(set(result), {"plan"})
        self.assertEqual(result["plan"]["service"]["image"], "registry.example/acme/web@sha256:" + "a" * 64)
        self.assertEqual(self.policy.summary, {"mode": "strict", "policyVersion": 1})

    def test_payload_tampering_and_invalid_signatures_never_consume_a_release(self):
        payload = self.request()
        payload["plan"]["service"]["hostPort"] = 22
        self.reject(payload, "changed after")
        payload = self.request()
        payload["authorization"]["signature"] = base64.b64encode(b"x" * 64).decode()
        self.reject(payload, "signature is invalid")
        self.assertEqual(list(self.state.glob("*.json")), [])
        self.policy.authorize("submit", self.request())

    def test_wrong_public_key_algorithm_is_not_accepted_as_an_ed25519_key(self):
        payload = self.request()
        subprocess.run([OPENSSL, "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(self.private_key)], check=True, capture_output=True)
        subprocess.run([OPENSSL, "pkey", "-in", str(self.private_key), "-pubout", "-out", str(self.public_key)], check=True, capture_output=True)
        self.reject(payload, "Ed25519")

    def test_expired_future_overlong_and_wrong_targets_are_rejected(self):
        now = int(time.time())
        for changes in ({"expiresAt": now - 1}, {"issuedAt": now + 100}, {"expiresAt": now + 1000},
                        {"serverId": "node-two"}, {"serviceId": "other"}, {"repository": "attacker/web"},
                        {"branch": "untrusted"}, {"commit": "c" * 40}, {"sequence": True}):
            with self.subTest(changes=changes):
                self.reject(self.request(manifest_change=changes))

    def test_exact_replay_and_older_sequences_rejected_after_new_policy_instance(self):
        payload = self.request(2)
        self.policy.authorize("submit", payload)
        if self.root:
            self.policy = AGENT.ReleasePolicy(self.policy_path, "node-one", self.state)
        else:
            self.policy = copy.copy(self.policy)
        self.policy.OPENSSL = OPENSSL
        self.reject(payload, "replay")
        self.reject(self.request(1), "replay")
        self.policy.authorize("submit", self.request(3))

    def test_even_validly_signed_images_cannot_expand_the_local_service_rule(self):
        mutations = [lambda p: p["plan"]["service"].update(hostPort=22),
                     lambda p: p["plan"]["service"].update(privileged=True),
                     lambda p: p["plan"]["service"].update(kind="source"),
                     lambda p: p["plan"]["service"].update(kind="compose", target={"composeProject": "production", "composeService": "db"}),
                     lambda p: p["plan"]["service"].update(volumes=[{"name": "/", "mountPath": "/host"}]),
                     lambda p: p["plan"]["service"].update(image="registry.example/acme/web:latest"),
                     lambda p: p["plan"]["service"].update(image="attacker.example/web@sha256:" + "a" * 64),
                     lambda p: p["plan"]["server"].update(id="node-two"),
                     lambda p: p["plan"]["job"].update(serviceId="database"),
                     lambda p: p["plan"].update(repository={"owner": "attacker", "repo": "web", "commit": "a" * 40})]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.reject(self.request(mutate=mutate))

    def test_unsigned_archives_and_unexpected_fields_are_rejected(self):
        self.reject({"plan": self.request()["plan"]})
        self.reject({**self.request(), "archive": "ZWNobyBhdHRhY2s="})
        self.reject({**self.request(), "script": "touch /must-never-run"})

    def test_local_named_volume_policy_still_cannot_approve_host_socket_or_privileged_fields(self):
        self.service["volumes"] = [{"name": "socket", "mountPath": "/var/run/docker.sock"}]
        self.policy.policy["services"]["web"]["serviceSha256"] = hashlib.sha256(AGENT.canonical_bytes(self.service)).hexdigest()
        self.reject(self.request(), "Docker sockets")

    def test_app_secrets_only_enter_from_local_private_environment_file(self):
        secret = self.directory / "environment.json"
        secret.write_text(json.dumps({"APP_SECRET": "local-only-value", "LITERAL": "$TOKEN/${UNCHANGED}"}))
        secret.chmod(0o600)
        self.policy.policy["services"]["web"]["environmentFile"] = str(secret)
        result = self.policy.authorize("submit", self.request())
        self.assertEqual(result["plan"]["service"]["environment"]["APP_SECRET"], "local-only-value")
        self.assertNotIn("local-only-value", "".join(file.read_text() for file in self.state.glob("*.json")))
        self.service["environment"] = {"APP_SECRET": "controller-value"}
        self.policy.policy["services"]["web"]["serviceSha256"] = hashlib.sha256(AGENT.canonical_bytes(self.service)).hexdigest()
        self.reject(self.request(2), "local environment")

    def test_fixed_programs_are_not_a_mutation_bypass(self):
        marker = self.directory / "executed"
        programs_path = self.directory / "programs.json"
        script = "from pathlib import Path\nPath(%r).write_text('executed')\nprint('{}')" % str(marker)
        programs_path.write_text(json.dumps({operation: {"script": script} for operation in ("submit", "probe", "status", "kubernetes-action")} | {"bootstrap": {"docker": {"language": "shell", "script": "touch " + str(marker)}}}))
        programs_path.chmod(0o600)
        programs = AGENT.Programs(programs_path, self.policy)
        for operation, payload in (("bootstrap", {"runtime": "docker"}), ("kubernetes-action", {"action": "restart"}),
                                   ("submit", {"plan": {}}), ("probe", {"script": "bad"}), ("status", {"jobId": "../../etc/shadow"})):
            with self.subTest(operation=operation):
                result = programs.execute(operation, payload, threading.Event())
                self.assertFalse(result["ok"])
                self.assertTrue(result["outcomeKnown"])
                self.assertFalse(marker.exists())
        self.assertTrue(programs.execute("submit", self.request(), threading.Event())["ok"])
        self.assertTrue(marker.exists())

    def test_probe_and_safe_status_remain_available(self):
        self.assertEqual(self.policy.authorize("probe", {}), {})
        self.assertEqual(self.policy.authorize("status", {"jobId": "job-one"}), {"jobId": "job-one"})

    @unittest.skipUnless(os.geteuid() == 0, "full daemon trust checks require the Linux root test VM")
    def test_compromised_http_controller_cannot_bypass_node_policy_or_replay_after_restart(self):
        valid = self.request()
        tampered = copy.deepcopy(valid)
        tampered["plan"]["service"]["hostPort"] = 22
        marker = self.directory / "only-approved-deployments"
        programs_path = self.directory / "programs.json"
        script = "from pathlib import Path\np=Path(%r)\np.write_text(p.read_text()+'approved\\n' if p.exists() else 'approved\\n')\nprint('{}')" % str(marker)
        programs_path.write_text(json.dumps({"submit": {"script": script}, "probe": {"script": "print('{}')"},
                                            "status": {"script": "print('{}')"}, "kubernetes-action": {"script": script},
                                            "bootstrap": {"docker": {"language": "shell", "script": "touch " + str(marker)}}}))
        programs_path.chmod(0o600)
        commands = [{"id": "unsigned", "operation": "submit", "payload": {"plan": valid["plan"]}},
                    {"id": "bootstrap", "operation": "bootstrap", "payload": {"runtime": "docker"}},
                    {"id": "kubernetes", "operation": "kubernetes-action", "payload": {"action": "restart"}},
                    {"id": "tampered", "operation": "submit", "payload": tampered},
                    {"id": "valid", "operation": "submit", "payload": valid},
                    {"id": "probe", "operation": "probe", "payload": {}},
                    {"id": "status", "operation": "status", "payload": {"jobId": "job-1"}}]
        results, polls = {}, []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                if self.headers.get("Authorization") != "Bearer fixture-token":
                    self.send_error(401)
                    return
                response = {}
                if self.path == "/api/agent/poll":
                    polls.append(body)
                    response = {"command": None if body.get("busy") or not commands else commands.pop(0), "pollIntervalSeconds": 0.1}
                elif self.path.endswith("/result"):
                    results[self.path.split("/")[-2]] = body
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(response).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        config = self.directory / "config.json"
        config.write_text(json.dumps({"url": "http://127.0.0.1:" + str(server.server_port), "token": "fixture-token", "serverId": "node-one"}))
        config.chmod(0o600)
        state = self.directory / "commands"
        def start():
            return subprocess.Popen(["python3", str(Path(__file__).parents[1] / "daemon.py"), "run", "--config", str(config),
                                     "--programs", str(programs_path), "--state-dir", str(state), "--policy", str(self.policy_path)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def stop(child):
            if child.poll() is None:
                child.terminate()
            stdout, stderr = child.communicate(timeout=5)
            self.assertNotIn(b"fixture-token", stdout + stderr)
            self.assertEqual(child.returncode, 0, stderr.decode())
        def wait_for(identifier):
            deadline = time.monotonic() + 12
            while identifier not in results and time.monotonic() < deadline:
                time.sleep(0.03)
            self.assertIn(identifier, results)
        child = start()
        try:
            wait_for("status")
            for identifier in ("unsigned", "bootstrap", "kubernetes", "tampered"):
                self.assertFalse(results[identifier]["ok"])
                self.assertTrue(results[identifier]["outcomeKnown"])
            for identifier in ("valid", "probe", "status"):
                self.assertTrue(results[identifier]["ok"])
            self.assertTrue(polls)
            self.assertTrue(all(poll.get("deploymentProtection", {}).get("mode") == "strict" for poll in polls))
            self.assertEqual(marker.read_text(), "approved\n")
        finally:
            stop(child)
        commands.append({"id": "replayed-with-new-command-id", "operation": "submit", "payload": valid})
        child = start()
        try:
            wait_for("replayed-with-new-command-id")
            self.assertFalse(results["replayed-with-new-command-id"]["ok"])
            self.assertIn("replay", results["replayed-with-new-command-id"]["error"])
            self.assertEqual(marker.read_text(), "approved\n")
        finally:
            stop(child)

    def test_canonical_bytes_match_cross_language_fixture_and_reject_ambiguous_values(self):
        self.assertEqual(AGENT.canonical_bytes({"z": "中文😀\n\t", "a": [1, True, None, {"x": "${ABC}"}]}),
                         '{"a":[1,true,null,{"x":"${ABC}"}],"z":"中文😀\\n\\t"}'.encode())
        for value in (1.5, 9007199254740992, {"中文": "value"}, "\ud800", float("nan")):
            with self.assertRaises(AGENT.AgentError):
                AGENT.canonical_bytes(value)


class PolicyFilesystemTests(unittest.TestCase):
    def test_root_file_validation_rejects_nonroot_writable_symlink_and_unsafe_directories(self):
        safe_dir = type("Info", (), {"st_uid": 0, "st_mode": stat.S_IFDIR | 0o755, "st_size": 0})()
        safe_file = type("Info", (), {"st_uid": 0, "st_mode": stat.S_IFREG | 0o600, "st_size": 3})()
        for field, value in (("st_uid", 501), ("st_mode", stat.S_IFREG | 0o666), ("st_mode", stat.S_IFLNK | 0o777)):
            bad_file = type("Info", (), {"st_uid": 0, "st_mode": stat.S_IFREG | 0o600, "st_size": 3, field: value})()
            with patch.object(Path, "lstat", autospec=True, side_effect=lambda p: bad_file if str(p) == "/etc/policy.json" else safe_dir):
                with self.assertRaises(AGENT.AgentError):
                    AGENT.trusted_root_file("/etc/policy.json")
        with patch.object(Path, "lstat", autospec=True, side_effect=lambda p: safe_file if str(p) == "/etc/policy.json" else safe_dir), patch.object(Path, "read_bytes", return_value=b"{}"):
            self.assertEqual(AGENT.trusted_root_file("/etc/policy.json", private=True), b"{}")

    def test_missing_policy_is_explicitly_compatibility_and_never_claims_strict(self):
        policy = AGENT.ReleasePolicy("/nonexistent/serverdesk/release-policy.json", "node-one", "/unused")
        self.assertEqual(policy.summary["mode"], "compatibility")
        self.assertEqual(policy.authorize("submit", {"legacy": True}), {"legacy": True})


if __name__ == "__main__":
    unittest.main()
