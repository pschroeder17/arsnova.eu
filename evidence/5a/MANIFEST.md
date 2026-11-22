# Referenzmanifest Laborinstanz 5A (22.11.2026)

## Code

| Punkt         | Wert                                                                             |
| ------------- | -------------------------------------------------------------------------------- |
| Upstream      | `kqc-real/arsnova.eu`, Tag `v1.3.0` = `87c39334619fbcb0c5782b061da1ba0df0ba3142` |
| Änderungen    | nur `apps/backend/src/__tests__/thema5a/*`, `evidence/5a/*` (kein Produktivcode) |
| Node.js / npm | 24.13.0 / 11.6.2                                                                 |
| Testframework | Vitest 4.1.10                                                                    |

## Host

Windows 11 Pro, AMD Ryzen 9 7950X3D (16 Kerne), 64 GB RAM. Docker Desktop (Engine 29.1.3, Hyper-V-VM mit
8 GB Speicher). Backend-Code läuft als ein Node-Prozess im Testrunner. Laborumgebung, kein Produktionsprofil
(kanonisch: zweiter Host mit 8 vCPU / 16 GB, ADR-0035).

## Infrastruktur (THEMA5A_REAL_INFRA=1, `lab/start-infra.sh`)

| Dienst     | Image                                                                                                | Hinweise                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| PostgreSQL | `postgres:16-alpine@sha256:1d5b02d3a9941fbd52437db4107f8c52d6297dac553ca1e5c299ebb3756b4857` (16.16) | Schema per `prisma migrate deploy` aus dem Release, inkl. Lifecycle-Trigger |
| Redis      | `redis:7.4-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe` (7.4.12)  | ohne Persistenz                                                             |

Beide nur an `127.0.0.1` veröffentlicht, ohne Volumes. Testdateien laufen nacheinander (`--no-file-parallelism`).

## Private Runtime (`lab/start-llm-container.sh`)

| Punkt      | Wert                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image      | gebaut aus `docker/open-weight-llm/Dockerfile` des Release: `ghcr.io/ggml-org/llama.cpp:server-b10524@sha256:57e505f69c3a55fa5dd9c15fced47cff7a899f5b5b504ea93d75b2f401b87830`; lokale Image-ID `sha256:968acc5d8054a24680f89d32d2baad4d0e393a56f41c845fdaac156b065ebc3a` |
| Modell     | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, SHA-256 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` – vom Entry-Point beim Start geprüft                                                                                                                     |
| Flags      | unverändert aus `entrypoint.sh` (`--parallel 1 --ctx-size 4096 --n-predict 768 --threads 4 --api-key …`), `OPEN_WEIGHT_LLM_THREADS=4`                                                                                                                                     |
| Härtung    | wie `docker-compose.llm.yml`: read-only, `cap_drop ALL`, `no-new-privileges`, `init`, `pids_limit 128`, `mem_limit 5g`, `cpus 4`, tmpfs `/tmp`, Modell read-only                                                                                                          |
| Abweichung | `network_mode: host` ist unter Docker Desktop nicht nutzbar → Bridge-Netz `172.30.0.0/24`, Bindung an `172.30.0.10` (von `validate-bind.sh` akzeptiert), veröffentlicht nur auf `127.0.0.1:8080`                                                                          |
| Kontrolle  | `/slots` ohne API-Key → 401, mit Key → 200; Healthcheck des Images `healthy`                                                                                                                                                                                              |

Der frühere Lauf mit nativem Windows-Build (llama.cpp b12606, 16 Threads) ist in `results/t2-real-runtime-run*.json`
erhalten und durch den Container-Lauf ersetzt.

## Feature-Flags im Test

`QA_SUMMARY_ENABLED=true`, `QA_SUMMARY_TIMEOUT_MS=30000`, `OPEN_WEIGHT_LLM_ENABLED=true`,
`OPEN_WEIGHT_LLM_URL=http://127.0.0.1:<proxy>`, `OPEN_WEIGHT_LLM_SUMMARY_TIMEOUT_MS=30000`,
`OPEN_WEIGHT_LLM_TOKEN=<Lab-Token>`; `QA_NLP_ENABLED`, `WORD_CLOUD_SEMANTIC_ENABLED` aus.

## Gültigkeitsgrenzen

- Ein Backend-Prozess: Race Conditions über mehrere Backend-Instanzen an derselben Datenbank nicht geprüft.
- Fristende über vorgestellte Backend-Uhr nachgestellt, weil der Lifecycle-Trigger Rückdatierung verbietet.
- Lernziel-Service hinter der Autorisierung in T1 durch einen Sentinel ersetzt (gemessen wird nur, ob die
  Autorisierung ihn erreicht).
- Belegt sind nur die getesteten Zustandsübergänge. Keine Aussage „sicher“; entfernte Kennungen ≠ Anonymität.
