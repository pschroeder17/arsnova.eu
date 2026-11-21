#!/usr/bin/env bash
# Thema 5A – alle eigenen Tests reproduzierbar ausführen (3 Wiederholungen).
# Voraussetzungen: npm ci, npm run prisma:generate (Repo-Root, Tag v1.3.0 + dieser Branch).
# Für T2-real zusätzlich eine laufende private Runtime (siehe evidence/5a/MANIFEST.md):
#   RUN_5A_REAL_RUNTIME=1 THEMA5A_LLM_TOKEN_FILE=<pfad> bash evidence/5a/run-all.sh
set -euo pipefail
cd "$(dirname "$0")/../../apps/backend"
for run in 1 2 3; do
  echo "=== Lauf $run ==="
  THEMA5A_RUN_ID=$run npx vitest run src/__tests__/thema5a \
    --reporter=default --reporter=json \
    --outputFile.json="../../evidence/5a/results/vitest-run$run.json" 2>&1 \
    | grep -E "✓|×|↓|Test Files|Tests " || true
done
