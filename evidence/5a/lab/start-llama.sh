#!/usr/bin/env bash
# Startet die private Laborruntime nativ unter Windows (Git Bash).
# Flags entsprechen docker/open-weight-llm/entrypoint.sh aus arsnova.eu v1.3.0,
# Abweichungen: Build b12606 statt b10524 (kein Windows-Build der Pin-Version),
# --threads 16 statt 4 (16 physische Kerne, weiterhin nur CPU), Bindung 127.0.0.1:8080.
L=${THEMA5A_LAB_DIR:?Pfad zum Laborordner mit models/, llama-b12606/ und llm-token.txt setzen}
exec "$L/llama-b12606/bin/llama-server.exe" \
  --model "$L/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" \
  --alias qwen3-4b-instruct-2507-q4_k_m \
  --parallel 1 --ctx-size 4096 --n-predict 768 \
  --threads 16 --threads-batch 16 \
  --no-webui --slots --api-key "$(cat "$L/llm-token.txt")" \
  --reasoning off --n-gpu-layers 0 --slot-prompt-similarity 0 \
  --jinja --offline --cors-origins localhost --no-cors-credentials \
  --log-verbosity 2 --host 127.0.0.1 --port 8080
