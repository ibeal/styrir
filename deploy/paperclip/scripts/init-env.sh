#!/bin/sh
# Create postgres.env and paperclip.env from their .example templates, with
# freshly generated secrets. Run once, on the laptop, before the first
# scripts/up.sh.
#
# Usage: deploy/paperclip/scripts/init-env.sh
#
# Refuses to overwrite an existing env file: regenerating BETTER_AUTH_SECRET
# invalidates every existing session, and regenerating the Postgres password
# desynchronizes it from the already-initialized database volume. To rotate a
# value, edit the file (and, for the database password, ALTER USER as well).

set -eu

cd "$(dirname "$0")/.."

for f in postgres.env paperclip.env; do
  if [ -e "$f" ]; then
    echo "error: $f already exists; refusing to overwrite it. See the header of this script." >&2
    exit 1
  fi
done

postgres_password="$(openssl rand -hex 24)"
better_auth_secret="$(openssl rand -hex 32)"
tool_action_signing_secret="$(openssl rand -hex 32)"

# The same generated password has to land in both files: postgres.env
# initializes the database role, paperclip.env's DATABASE_URL authenticates
# against it.
sed "s|REPLACE_ME_WITH_A_LONG_RANDOM_VALUE|${postgres_password}|g" \
  postgres.env.example > postgres.env

sed -e "s|REPLACE_ME_WITH_A_LONG_RANDOM_VALUE|${postgres_password}|g" \
    -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${better_auth_secret}|" \
    -e "s|^PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=.*|PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=${tool_action_signing_secret}|" \
  paperclip.env.example > paperclip.env

chmod 600 postgres.env paperclip.env

if grep -q 'REPLACE_ME' postgres.env paperclip.env; then
  echo "error: a placeholder survived generation; inspect postgres.env and paperclip.env." >&2
  exit 1
fi

echo "wrote postgres.env and paperclip.env (0600, git-ignored)."
echo "secrets were generated in-process and never printed."
