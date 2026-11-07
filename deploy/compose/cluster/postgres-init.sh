#!/bin/sh
# Run once by the postgres image when its data folder is new
# (/docker-entrypoint-initdb.d, as the image's superuser POSTGRES_USER).
#
# Flowplan's own role, `flowplan`: it owns the database `flowplan` (and so
# its public schema) and may do everything Flowplan needs there – but it is
# no superuser. The image would make POSTGRES_USER one; a superuser can run
# programs on the database host (COPY … TO PROGRAM), so Flowplan connects as
# this role instead, and the superuser stays for administration.
# The extensions Flowplan uses are installed here, into their own schema
# flowplan_ext (lib/pg-extensions.ts): pg_trgm always (the postgres image
# has it), pgvector when the image has it (pgvector/pgvector:pg16).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v password="$FLOWPLAN_DB_PASSWORD" <<'SQL'
CREATE ROLE flowplan LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'password';
CREATE DATABASE flowplan OWNER flowplan;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname flowplan <<'SQL'
CREATE SCHEMA IF NOT EXISTS flowplan_ext AUTHORIZATION flowplan;
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA flowplan_ext;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA flowplan_ext;
  END IF;
END $$;
SQL
