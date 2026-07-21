#!/usr/bin/env bash
#
# Run a command against a deployed environment's RDS database.
#
#   ./scripts/with-remote-env.sh qa npm run typeorm -- migration:show -d src/db/migration-data-source.ts
#   ./scripts/with-remote-env.sh qa npm run seed:admin -- alice 'correct horse battery'
#   ./scripts/with-remote-env.sh qa psql -c 'select count(*) from documents'
#   ./scripts/with-remote-env.sh production npm run migration:run
#
# Everything (host, port, user, database, password) is read from that
# environment's ECS task definition, so there is nothing to hardcode, nothing to
# paste, and no way to point a QA command at production by mistake.
#
# Why this exists, in one line each:
#   - `.env.local` sets DATABASE_SSL=false for the local docker database, and
#     src/db/data-source.ts honours it, which silently disables TLS against RDS.
#     This forces it back on.
#   - Long `export DATABASE_URL=...` lines wrap in terminals and inject newlines
#     into the hostname. Building it here avoids that entirely.
#   - Passwords with URL-unsafe characters must be percent-encoded in the URL.
#
# Requires: aws CLI with a valid session (`aws login --region us-east-2`), and
# your current IP allowed on the RDS security group (see the cutover runbooks).
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"

usage() {
  echo "Usage: $0 <qa|production> <command> [args...]" >&2
  echo "Example: $0 qa npm run seed:admin -- alice 'a password'" >&2
  exit 2
}

[ $# -ge 2 ] || usage
ENVIRONMENT="$1"; shift
case "$ENVIRONMENT" in
  qa|production) ;;
  *) echo "Unknown environment '$ENVIRONMENT'." >&2; usage ;;
esac

TASK_FAMILY="askwri-app-${ENVIRONMENT}"

# One API call; pull every DB_* var the task definition carries.
DB_JSON=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$REGION" \
  --query "taskDefinition.containerDefinitions[].environment[?starts_with(name,'DB_')].{n:name,v:value} | []" \
  --output json)

eval "$(
  DB_JSON="$DB_JSON" ENVIRONMENT="$ENVIRONMENT" python3 <<'PY'
import json, os, shlex, sys, urllib.parse

vars = {e["n"]: e["v"] for e in json.loads(os.environ["DB_JSON"])}
missing = [k for k in ("DB_HOST", "DB_PORT", "DB_USER", "DB_NAME", "DB_PASSWORD") if k not in vars]
if missing:
    sys.exit(f"echo 'Task definition is missing {', '.join(missing)}' >&2; exit 1")

# No sslmode= in the URL on purpose. node-postgres parses sslmode out of the
# connection string and it then overrides the TypeORM ssl object, so
# rejectUnauthorized:false is ignored and Node fails with
# SELF_SIGNED_CERT_IN_CHAIN (the RDS CA is not in the local trust store).
# TLS is still enforced for both runtimes: Node via DATABASE_SSL below, and
# psycopg/psql via PGSSLMODE=require, which libpq reads from the environment.
#
# NOTE: this heredoc sits inside a $(...) substitution, so bash still scans it
# for quotes and backticks. Keep apostrophes and backticks out of these comments
# or the shell fails to parse the script.
url = "postgresql://{u}:{p}@{h}:{port}/{db}".format(
    u=urllib.parse.quote(vars["DB_USER"], safe=""),
    p=urllib.parse.quote(vars["DB_PASSWORD"], safe=""),
    h=vars["DB_HOST"], port=vars["DB_PORT"], db=vars["DB_NAME"],
)
# Assert the URL parses back to what we intended — catches stray whitespace or
# newlines in a task-definition value before it becomes a confusing timeout.
p = urllib.parse.urlparse(url)
assert p.hostname == vars["DB_HOST"] and p.path == "/" + vars["DB_NAME"], "malformed DATABASE_URL"

for k, v in (
    ("DATABASE_URL", url),
    ("DATABASE_SSL", "true"),
    ("DATABASE_SSL_REJECT_UNAUTHORIZED", "false"),
    ("PGHOST", vars["DB_HOST"]),
    ("PGPORT", vars["DB_PORT"]),
    ("PGUSER", vars["DB_USER"]),
    ("PGDATABASE", vars["DB_NAME"]),
    ("PGPASSWORD", vars["DB_PASSWORD"]),
    ("PGSSLMODE", "require"),
):
    print(f"export {k}={shlex.quote(v)}")
print(f"echo '→ {vars['DB_USER']}@{vars['DB_HOST']}/{vars['DB_NAME']} ({os.environ.get('ENVIRONMENT','')})' >&2")
PY
)"

cd "$(dirname "$0")/.."
exec "$@"
