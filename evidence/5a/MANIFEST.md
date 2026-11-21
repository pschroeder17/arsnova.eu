# Referenzmanifest Laborinstanz 5A (21.11.2026)

## Code

| Punkt         | Wert                                                                             |
| ------------- | -------------------------------------------------------------------------------- |
| Upstream      | `kqc-real/arsnova.eu`, Tag `v1.3.0` = `87c39334619fbcb0c5782b061da1ba0df0ba3142` |
| Änderungen    | nur `apps/backend/src/__tests__/thema5a/*`, `evidence/5a/*` (kein Produktivcode) |
| Node.js / npm | 24.13.0 / 11.6.2                                                                 |
| Testframework | Vitest 4.1.10                                                                    |

## Hardware / Betriebssystem

Windows 11 Pro (nativ, kein Docker/WSL), AMD Ryzen 9 7950X3D (16 Kerne), 64 GB RAM. Laborumgebung, kein
Produktionsprofil (kanonisch: zweiter Host mit 8 vCPU / 16 GB, ADR-0035).

## Private Runtime

| Punkt       | Wert                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Binary      | llama.cpp **b12606** `llama-b12606-bin-win-cpu-x64.zip`, SHA-256 `425eeb2a94a9600dadf369a7c9c7dd0141948921efc0fa9ec7872970fffc845d`                                                                                                        |
| Abweichung  | Release pinnt `ghcr.io/ggml-org/llama.cpp:server-b10524@sha256:57e505f6…` (Linux-Image); für b10524 gibt es keinen Windows-Build, kein Compiler vorhanden                                                                                  |
| Modell      | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, 2 497 281 120 Bytes, SHA-256 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` – geprüft mit `node scripts/open-weight-llm/verify-model.mjs`                                        |
| Flags       | wie `docker/open-weight-llm/entrypoint.sh` (`--parallel 1 --ctx-size 4096 --n-predict 768 --no-webui --slots --api-key … --reasoning off --n-gpu-layers 0 --jinja --offline`), Abweichung `--threads 16` statt 4, Bindung `127.0.0.1:8080` |
| Startskript | `evidence/5a/lab/start-llama.sh` (Token liegt außerhalb des Repos)                                                                                                                                                                         |
| Kontrolle   | `/slots` ohne API-Key → 401, mit Key → 200                                                                                                                                                                                                 |

## Feature-Flags im Test

`QA_SUMMARY_ENABLED=true`, `QA_SUMMARY_TIMEOUT_MS=30000`, `OPEN_WEIGHT_LLM_ENABLED=true`,
`OPEN_WEIGHT_LLM_URL=http://127.0.0.1:<proxy>`, `OPEN_WEIGHT_LLM_SUMMARY_TIMEOUT_MS=30000`,
`OPEN_WEIGHT_LLM_TOKEN=<Lab-Token>`; `QA_NLP_ENABLED`, `WORD_CLOUD_SEMANTIC_ENABLED` aus.

## Einzelmessung Inferenzdauer (Nebenbefund, Zuständigkeit Thema 3/4)

Replay des Summary-Requests aus T2 direkt an die Runtime: 793 Prompt-Token, 640 Completion-Token
(= `max_tokens`, Ausgabe ausgeschöpft), 15,2 Token/s → rund 42 s Generierung. Damit liegt ein realer
V2-Summary-Lauf auf dieser CPU-Konfiguration über dem Queue-Limit von 30 s (`QA_SUMMARY_TIMEOUT_MS`,
Maximum 30 000) und endet im extraktiven Fallback. Für 5A ist das unkritisch: Der Entzug trifft einen
Auftrag, der nachweislich in der Runtime läuft.

## Gültigkeitsgrenzen

- Redis, PostgreSQL und Pairing-Register sind In-Memory-Ersatz; Autorisierungscode, Router, Queue und
  Runtime-Client sind Originalcode. Keine Mehrknoten- oder Datenbank-Races getestet.
- Belegt sind nur die getesteten Zustandsübergänge. Keine Aussage „sicher“; entfernte Kennungen ≠ Anonymität.
