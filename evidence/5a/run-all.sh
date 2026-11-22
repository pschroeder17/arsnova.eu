#!/usr/bin/env bash
# Thema 5A – alle eigenen Tests reproduzierbar ausführen (3 Wiederholungen).
# Voraussetzungen: npm ci, npm run prisma:generate (Repo-Root, Tag v1.3.0 + dieser Branch).
#
# Betriebsarten:
#   (Standard)              In-Memory-Ersatz für PostgreSQL/Redis, keine Container nötig.
#   THEMA5A_REAL_INFRA=1    echte PostgreSQL-16- und Redis-7.4-Container, siehe lab/start-infra.sh
#                           (setzt DATABASE_URL und REDIS_URL voraus).
#   RUN_5A_REAL_RUNTIME=1   zusätzlich echte private Runtime (Release-Container, lab/start-llm-container.sh),
#                           THEMA5A_LLM_TOKEN_FILE=<pfad>.
set -euo pipefail
cd "$(dirname "$0")/../../apps/backend"
suffix=""
parallel=()
if [ "${THEMA5A_REAL_INFRA:-0}" = "1" ]; then
  suffix="-real-infra"
  # Eine gemeinsame Datenbank/Redis-Instanz: Testdateien nacheinander ausführen.
  parallel=(--no-file-parallelism)
fi
for run in 1 2 3; do
  echo "=== Lauf $run${suffix} ==="
  THEMA5A_RUN_ID=$run npx vitest run src/__tests__/thema5a "${parallel[@]}" \
    --reporter=default --reporter=json \
    --outputFile.json="../../evidence/5a/results/vitest${suffix}-run$run.json" 2>&1 \
    | grep -E "✓|×|↓|Test Files|Tests " || true
done
