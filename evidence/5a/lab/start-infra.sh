#!/usr/bin/env bash
# Thema 5A – echte PostgreSQL- und Redis-Instanz für THEMA5A_REAL_INFRA=1 (nur Labor, nur Loopback).
# Gleiche Images wie docker-compose.yml (postgres:16-alpine, redis:7.4-alpine), eigene Ports,
# keine Volumes (jeder Start ist leer). Danach Migrationen des Release-Stands anwenden.
set -euo pipefail
PGPASS="${THEMA5A_PG_PASSWORD:-t5a-lab-only}"
docker rm -f t5a-postgres t5a-redis >/dev/null 2>&1 || true
docker run -d --name t5a-postgres \
  -e POSTGRES_USER=arsnova_user -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=arsnova_5a \
  -p 127.0.0.1:55432:5432 postgres:16-alpine >/dev/null
docker run -d --name t5a-redis -p 127.0.0.1:56379:6379 \
  redis:7.4-alpine redis-server --save "" --appendonly no >/dev/null
for _ in $(seq 1 30); do
  docker exec t5a-postgres pg_isready -U arsnova_user -d arsnova_5a >/dev/null 2>&1 && break
  sleep 1
done
export DATABASE_URL="postgresql://arsnova_user:${PGPASS}@127.0.0.1:55432/arsnova_5a?schema=public"
cd "$(dirname "$0")/../../.."
npx prisma migrate deploy --schema prisma/schema.prisma
echo "export THEMA5A_REAL_INFRA=1 DATABASE_URL='${DATABASE_URL}' REDIS_URL='redis://127.0.0.1:56379'"
