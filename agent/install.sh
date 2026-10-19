#!/bin/sh
# Installs only void0 OS. Docker and K3s require a later explicit Web command.
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run this installer with sudo or as root.' >&2
  exit 1
fi
if [ ! -r /etc/os-release ] || [ ! -d /run/systemd/system ]; then
  printf '%s\n' 'void0 OS requires Ubuntu or Debian with systemd.' >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) printf '%s\n' 'Supported systems: Ubuntu and Debian.' >&2; exit 1;; esac
if [ "$#" -gt 1 ]; then
  printf '%s\n' 'Usage: sudo sh install.sh [https://your-void0-domain]' >&2
  exit 1
fi
if [ "$#" -eq 1 ]; then
  management_url=$1
else
  printf '%s' 'void0 management URL: ' > /dev/tty
  IFS= read -r management_url < /dev/tty
fi

if ! command -v python3 >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1 || [ ! -r /etc/ssl/certs/ca-certificates.crt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends python3 ca-certificates openssl
fi
# Inspect existing ancestors before install -d or install can follow a symlink.
# Every writable directory involved must already be controlled solely by root.
python3 - <<'PY'
import os, pathlib, stat, sys
directories = ('/etc/serverdesk-agent', '/var/lib/serverdesk-agent', '/opt/serverdesk-agent')
files = ('/etc/serverdesk-agent/config.json', '/opt/serverdesk-agent/daemon.py',
         '/opt/serverdesk-agent/programs.json', '/etc/systemd/system/serverdesk-agent.service')
try:
    checked = set()
    for name in directories + files:
        target = pathlib.Path(name)
        for path in reversed((target,) + tuple(target.parents)):
            if str(path) in checked:
                continue
            checked.add(str(path))
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError()
            if path != target or name in directories:
                if not stat.S_ISDIR(info.st_mode):
                    raise ValueError()
            elif not stat.S_ISREG(info.st_mode):
                raise ValueError()
except Exception:
    sys.exit('Unsafe void0 installation path: root ownership, safe permissions and no symlinks are required.')
PY
install -d -o root -g root -m 0700 /etc/serverdesk-agent /var/lib/serverdesk-agent
install -d -o root -g root -m 0755 /opt/serverdesk-agent
agent_download=$(mktemp -d /var/lib/serverdesk-agent/.install-XXXXXX)
trap 'rm -rf "$agent_download"' EXIT HUP INT TERM

# Python's TLS verifier checks the management host. Reject redirects and limit both
# downloads; the manifest digest pins the bundle obtained from that same origin.
python3 - "$management_url" "$agent_download" <<'PY'
import hashlib, io, json, os, pathlib, re, sys, tarfile, urllib.parse, urllib.request
url, destination = sys.argv[1], pathlib.Path(sys.argv[2])
parsed = urllib.parse.urlsplit(url)
if ((parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1')) or
    not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
    sys.exit('Use an HTTPS management origin (127.0.0.1 HTTP is allowed for development).')
url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError('Management downloads must not redirect.')
opener = urllib.request.build_opener(NoRedirect())
def download(path, limit):
    with opener.open(url + path, timeout=60) as response:
        value = response.read(limit + 1)
    if len(value) > limit:
        raise ValueError('Management download exceeds size limit.')
    return value
try:
    manifest = json.loads(download('/api/agent/manifest', 65536))
    expected = manifest.get('sha256', '')
    if not isinstance(expected, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', expected):
        raise ValueError('Invalid agent bundle checksum.')
    bundle = download('/api/agent/bundle', 8 * 1024 * 1024)
    if hashlib.sha256(bundle).hexdigest() != expected.lower():
        raise ValueError('Agent bundle checksum did not match; installation stopped.')
    required = {'daemon.py', 'programs.json', 'serverdesk-agent.service', 'install.sh'}
    with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:gz') as archive:
        members = archive.getmembers()
        if len(members) != len(required) or {item.name for item in members} != required:
            raise ValueError('Unexpected files in the agent bundle.')
        for member in members:
            if not member.isfile() or member.size > 4 * 1024 * 1024:
                raise ValueError('Unsafe agent bundle entry.')
            source = archive.extractfile(member)
            if source is None:
                raise ValueError('Cannot read agent bundle entry.')
            target = destination / member.name
            with target.open('xb') as handle:
                handle.write(source.read())
            target.chmod(0o600)
    (destination / 'management-url').write_text(url, encoding='utf-8')
    (destination / 'management-url').chmod(0o600)
except Exception:
    # Do not leak request data, tokens or responses into shell/systemd logs.
    sys.exit('Could not verify the void0 OS download; no files were installed.')
PY

install -o root -g root -m 0644 "$agent_download/daemon.py" /opt/serverdesk-agent/daemon.py
install -o root -g root -m 0644 "$agent_download/programs.json" /opt/serverdesk-agent/programs.json
# A successful new registration atomically replaces config.json. A failed pairing
# leaves the previous token and running service untouched.
python3 /opt/serverdesk-agent/daemon.py register --url "$management_url" < /dev/tty
install -o root -g root -m 0644 "$agent_download/serverdesk-agent.service" /etc/systemd/system/serverdesk-agent.service
systemctl daemon-reload
systemctl enable --now serverdesk-agent.service
systemctl restart serverdesk-agent.service
printf '%s\n' 'void0 OS installed. No inbound port was opened; Docker and K3s were not installed.'
if [ ! -e /etc/serverdesk-agent/release-policy.json ]; then
  printf '%s\n' 'Compatibility mode: deployments are authorized by the management panel. Independent publisher verification is NOT enabled.'
  printf '%s\n' 'A local root administrator must install a release-policy.json and trusted publisher key to enable strict mode.'
fi
