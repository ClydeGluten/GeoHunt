#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=db_name="$POSTGRES_DB" \
  --set=migrator_password="$MIGRATOR_DB_PASSWORD" \
  --set=app_password="$APP_DB_PASSWORD" \
  --set=mcp_password="$MCP_DB_PASSWORD" <<-'EOSQL'
  CREATE EXTENSION IF NOT EXISTS postgis;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  SELECT format('CREATE ROLE geohunter_migrator LOGIN PASSWORD %L', :'migrator_password')
    WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'geohunter_migrator') \gexec
  SELECT format('CREATE ROLE geohunter_app LOGIN PASSWORD %L', :'app_password')
    WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'geohunter_app') \gexec
  SELECT format('CREATE ROLE geohunter_mcp LOGIN PASSWORD %L', :'mcp_password')
    WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'geohunter_mcp') \gexec

  ALTER SCHEMA public OWNER TO geohunter_migrator;
  GRANT CONNECT ON DATABASE :"db_name" TO geohunter_migrator, geohunter_app, geohunter_mcp;
  GRANT USAGE ON SCHEMA public TO geohunter_app, geohunter_mcp;
EOSQL
