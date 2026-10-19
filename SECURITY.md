# Security

void0 can manage Docker workloads and server credentials. Use a dedicated
installation, keep the control plane and OS component updated, and read the
[deployment boundaries](README.md#无人值守发布与安全边界) before connecting servers.

Do not post passwords, tokens, private keys, database backups, pairing codes,
or live server details in public issues or pull requests. Use synthetic examples
and redact logs before sharing them.

Report security vulnerabilities through GitHub's **Security → Report a
vulnerability** feature for this repository. Include affected versions, impact,
and reproduction steps using disposable resources. If private reporting is not
available, open an issue requesting a private reporting channel without sharing
the vulnerability details or any credentials.

If a credential is exposed, revoke or rotate it immediately. Removing it from
the latest file does not remove it from Git history, clones, or backups.

The repository excludes runtime databases, environment files, keys, local
verification data, and backups. Before publishing changes, review the staged
file list and run `npm run check:public`; a secret scanner such as Gitleaks can
provide an additional check. Automated scans reduce mistakes but do not prove
that a credential has never been exposed.
