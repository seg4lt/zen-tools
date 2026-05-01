#!/usr/bin/env bash
# Sidecar init container entrypoint. Runs once `mssql` reports healthy
# and applies docker/mssql/01-init.sql via sqlcmd. Idempotent.
set -euo pipefail

# Pick whichever sqlcmd is available — full mssql/server image ships
# tools18, azure-sql-edge ships the older path.
SQLCMD=""
for candidate in /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; do
  if [ -x "$candidate" ]; then
    SQLCMD="$candidate"
    break
  fi
done

if [ -z "$SQLCMD" ]; then
  echo "init: no sqlcmd binary found in this image" >&2
  exit 1
fi

echo "init: using $SQLCMD"
echo "init: applying /work/01-init.sql against mssql:1433…"

# -C trusts the self-signed cert that the dev image ships with.
"$SQLCMD" -C -S mssql,1433 -U sa -P "$MSSQL_SA_PASSWORD" -i /work/01-init.sql

echo "init: done"
