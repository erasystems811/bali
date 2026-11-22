SELECT format('CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD %L', :'dbpass') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') \gexec
SELECT 'CREATE ROLE anon NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') \gexec
SELECT 'CREATE ROLE bali_service NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bali_service') \gexec
-- dashboard-only objects (were never in schema.sql; hand-edited on the old server)
ALTER TABLE sops ADD COLUMN IF NOT EXISTS file_name text, ADD COLUMN IF NOT EXISTS file_path text, ADD COLUMN IF NOT EXISTS file_mime text;
CREATE TABLE IF NOT EXISTS dashboard_users (id serial PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
GRANT anon, bali_service TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, bali_service;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO bali_service;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO bali_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO bali_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO bali_service;
