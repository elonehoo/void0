#!/bin/sh
set -eu
app_password=${VOID0_DB_PASSWORD:-${SERVERDESK_DB_PASSWORD:-}}
# Only generated hexadecimal passwords are accepted; no SQL or shell interpolation from users.
case "${app_password:-}" in ''|*[!a-f0-9]*) echo 'Invalid application database password' >&2; exit 1;; esac
[ "${#app_password}" -eq 64 ] || exit 1
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE serverdesk_app LOGIN PASSWORD '${app_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA serverdesk AUTHORIZATION serverdesk_app;
GRANT CONNECT ON DATABASE serverdesk TO serverdesk_app;
SQL
