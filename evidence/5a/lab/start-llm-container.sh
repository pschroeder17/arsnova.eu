#!/usr/bin/env bash
# Thema 5A – private Runtime als Release-Container (docker/open-weight-llm, llama.cpp b10524,
# Image per Digest gepinnt, GGUF per SHA-256 im Entry-Point geprüft).
#
# Übernommen aus docker-compose.llm.yml: read_only, cap_drop ALL, no-new-privileges, init,
# pids_limit 128, mem_limit 5g, cpus 4, tmpfs /tmp, Modell read-only, 4 Threads, HTTP-Transport.
# Abweichung: network_mode host ist unter Docker Desktop (Windows) nicht verfügbar; stattdessen
# eigenes Bridge-Netz, der Server bindet an die private Container-Adresse 172.30.0.10
# (validate-bind.sh erlaubt nur Loopback/private Adressen) und ist nur über 127.0.0.1:8080
# veröffentlicht.
#
# Benötigt: THEMA5A_LAB_DIR mit models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf und llm-token.txt
# (32–512 URL-sichere Zeichen; wird nur als env-file übergeben, nie geloggt).
# Docker Desktop braucht mindestens ca. 6 GB VM-Speicher.
set -euo pipefail
LAB="${THEMA5A_LAB_DIR:?THEMA5A_LAB_DIR setzen}"
cd "$(dirname "$0")/../../.."
docker build -t arsnova-open-weight-llm:5a-lab docker/open-weight-llm
envfile="$LAB/llm-container.env"
printf 'OPEN_WEIGHT_LLM_TOKEN=%s\n' "$(tr -d '\r\n' < "$LAB/llm-token.txt")" > "$envfile"
docker rm -f t5a-llm >/dev/null 2>&1 || true
docker network inspect t5a-llm >/dev/null 2>&1 || docker network create --subnet 172.30.0.0/24 t5a-llm >/dev/null
MSYS_NO_PATHCONV=1 docker run -d --name t5a-llm --network t5a-llm --ip 172.30.0.10 \
  -p 127.0.0.1:8080:8080 \
  --init --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 5g --cpus 4.0 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
  -v "$LAB/models:/models:ro" --env-file "$envfile" \
  -e OPEN_WEIGHT_LLM_TRANSPORT=http -e OPEN_WEIGHT_LLM_THREADS=4 \
  -e OPEN_WEIGHT_LLM_BIND_ADDRESS=172.30.0.10 \
  arsnova-open-weight-llm:5a-lab
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' t5a-llm)" = healthy ] && break
  sleep 5
done
docker inspect -f 'Status: {{.State.Status}} {{.State.Health.Status}}' t5a-llm
