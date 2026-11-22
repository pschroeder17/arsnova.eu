# Evidenz Thema 5A – Autorisierung, Freigaben und Datenminimierung

Referatsprüfung Cloud Computing (DSCC0127), Gruppe 5 „Sicherheit“, Auftrag 5A – Paul Schröder.
Handout-Titel: „Rechte, die während der Analyse verfallen: Autorisierung und Freigabegrenzen am
Ausgabepunkt des Moderationskompasses (arsnova.eu 1.3)“.

Dieser Branch basiert unverändert auf dem Release-Tag **`v1.3.0`** (`87c39334`). Ergänzt sind ausschließlich:

- `apps/backend/src/__tests__/thema5a/` – eigene Testsuite (5 Dateien, 71 Fälle),
- `evidence/5a/` – Manifest, Startskripte der Laborinstanz, Rohdaten.

Produktivcode wurde **nicht** verändert. Die Gegenvarianten existieren nur als Test-Hooks.

## Hypothese und Gegenalternative

- **H:** Weder Session-Code noch Clientzustand begründen eine Berechtigung; Rechte und Freigabestatus
  werden an jedem Ausgabepunkt erneut geprüft, auch während eines laufenden Summary-Auftrags.
- **G (Gegenalternative):** Eine Prüfung beim Start genügt.
  - **V1 „Auth-Cache“** cacht die Autorisierungsentscheidung je (Session, Token).
  - **V2 „ohne Nachprüfung“** verzichtet auf die Neuprüfung nach der Inferenz.
- **Schwelle (vorab):** Jede Auslieferung von Inhalt an einen entzogenen Akteur und jeder nach dem
  Entzug erzeugte Inhalt im Laufzeitzustand ist ein Verstoß (Toleranz 0).

## Zwei Betriebsarten

| Betriebsart                     | Datenbank / Redis                             | Paired Host                                         | Runtime                                                        |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| **Echte Infrastruktur** (Haupt) | PostgreSQL 16, Redis 7.4 als Docker-Container | echter Ablauf `lib/hostPairing.ts` (Invite → Token) | Release-Container `docker/open-weight-llm` (b10524, 4 Threads) |
| In-Memory (schnell)             | In-Memory-Ersatz (`fakes.ts`)                 | Registry-Ersatz                                     | – (T2-real übersprungen)                                       |

Rohdaten der echten Infrastruktur tragen `-real-infra` im Dateinamen und den Block `infra` im JSON.

## Tests

| Datei                              | Inhalt                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t1-zugriffsmatrix.test.ts`        | 8 Akteure × 5 Prozeduren + 4 Zustandsfälle; echte `hostAuth.ts`, `loadAuthorizedModerationState`, Pairing                                                              |
| `t2-rechteentzug.test.ts`          | Rechteentzug **während** der Inferenz (S1 Credential-Rotation, S2 Paired Host entkoppelt, S3 Ende der Nachbereitungsfrist) × Baseline/V1/V2, deterministischer Adapter |
| `t2-real-runtime.test.ts`          | S1/S2 mit **echter privater Runtime** hinter einem Metadaten-Proxy; R0: unberechtigte Aufträge erzeugen 0 Runtime-Requests                                             |
| `t3-freigabe-ausgabepunkt.test.ts` | Kanal schließen / Deadline / deaktiviert / anonym: `qa.list` vs. `qa.presentProjection` (SQL-Ebene als Fixture)                                                        |
| `t3-real-infra.test.ts`            | dasselbe mit echten Fragen, Teilnehmenden und Participant-Capability in PostgreSQL; plus Weg `session.getInfo` → `sessionId`                                           |
| `world.ts`, `fakes.ts`             | Testwelt für beide Betriebsarten, In-Memory-Ersatz, Evidenz-Writer                                                                                                     |

Ausführen (Repo-Root, nach `npm ci` und `npm run prisma:generate`):

```bash
# schnell, ohne Container
npm run test -w @arsnova/backend -- --run src/__tests__/thema5a

# echte Infrastruktur, 3 Wiederholungen (Docker Desktop mit ≥ 6 GB Speicher)
bash evidence/5a/lab/start-infra.sh                       # gibt DATABASE_URL/REDIS_URL aus
THEMA5A_LAB_DIR=<lab> bash evidence/5a/lab/start-llm-container.sh
THEMA5A_REAL_INFRA=1 RUN_5A_REAL_RUNTIME=1 THEMA5A_LLM_TOKEN_FILE=<lab>/llm-token.txt \
  DATABASE_URL=... REDIS_URL=... bash evidence/5a/run-all.sh
```

## Ergebnisse (echte Infrastruktur, 3 Läufe, jeweils 71/71 bestanden, Ergebnisse in allen Läufen identisch)

**T1 Zugriffsmatrix:** Alle 40 Matrixfälle wie erwartet. Kein Token, Session-Code als Token, gültiges Token
einer fremden Session, Token nach Credential-Rotation, abgelaufenes Token (TTL 900 s) und entkoppelter Paired
Host → `UNAUTHORIZED`; dabei 0 Aufrufe von Runtime oder Lernziel-Service. Aktiver Paired Host und Original-Host →
Zugriff. Zustandsfälle: Session beendet + Q&A-Kanal offen → Lesen und neuer Auftrag möglich (mehrtägige Q&A);
Session beendet + Kanal zu → neuer Auftrag `FORBIDDEN`; unbekannte `sessionId` ohne Token → `NOT_FOUND` vor der
Autorisierung. Nachbereitungsfrist abgelaufen → mit echter Datenbank `UNAUTHORIZED`, weil die Token-Laufzeit an
das Fristende gekappt ist; im In-Memory-Lauf (rückdatierte Session, Token noch gültig) greift die Fristprüfung
mit `FORBIDDEN`.

**Unterschied echte DB ↔ In-Memory:** Ein Trigger (`20260915080000_session_absolute_lifecycle`) setzt `endedAt`
beim Beenden auf die Datenbankzeit und verbietet Änderungen an beendeten Sessions. Fristende wird mit echter
Datenbank daher über eine vorgestellte Backend-Uhr (`Date`) erreicht, nicht über Rückdatierung.

**T2 Rechteentzug während der Inferenz** (Adapter, identisch in beiden Betriebsarten):

| Szenario                     | Baseline 1.3                                                  | V1 Auth-Cache                                          | V2 ohne Nachprüfung                                  |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| S1 Credential-Rotation       | `failed/permission_changed`, 0 Aussagen; Leser `UNAUTHORIZED` | rotiertes Token liest Ergebnis                         | Inhalt nach Entzug im Speicher; Leser `UNAUTHORIZED` |
| S2 Paired Host entkoppelt    | wie S1                                                        | entkoppelter Paired Host liest Ergebnis                | wie S1                                               |
| S3 Nachbereitungsfrist endet | `permission_changed`; Leser abgewiesen                        | **geschützt** (Fristprüfung unabhängig vom Auth-Cache) | Inhalt im Speicher                                   |

Runtime-Container (S1/S2 × Baseline/V1/V2, 18 Läufe): Entzug 11–37 ms nach Auftragsstart, Inferenz lief
jeweils bis zum Queue-Limit von 30 s (Fallback-Grund `timeout` in V1/V2, `permission_changed` in der
Baseline); Runtime-Requests trugen ausschließlich das Service-Token, nie ein Host-Token;
R0: 3 unberechtigte `requestSummary`-Aufrufe → 0 Runtime-Requests (in allen 3 Läufen).

**T3 Freigabe am Ausgabepunkt** (echte PostgreSQL-Daten): Kanal geschlossen bzw. Deadline abgelaufen →
Teilnehmende mit gültiger Participant-Capability 0 Fragen, öffentliche Beamer-Projektion **6 Fragen inkl.
6 Nicknames** ohne jede Zugangsberechtigung. `session.getInfo` liefert die `sessionId` zum Session-Code ohne
Zugangsdaten (gemessen). Anonymer Modus: keine Nicknames; Kanal deaktiviert: beide leer.

## Rohdaten

- `baseline/upstream-tests-v1.3.0.json` – Upstream-Tests der betroffenen Module auf v1.3.0 (7 Dateien, 134 bestanden)
- `results/*-real-infra-run{1,2,3}.json`, `results/vitest-real-infra-run{1,2,3}.json` – echte Infrastruktur
- `results/*-run{1,2,3}.json`, `results/vitest-run{1,2,3}.json` – In-Memory-Lauf
- `results/t2-real-runtime-run{1,2,3}.json` – früherer Lauf mit nativem Windows-Build (b12606, 16 Threads), ersetzt
  durch `t2-real-runtime-real-infra-run*.json`, aus Transparenz behalten

Die Proxy-Protokolle enthalten nur Metadaten (Pfad, Status, Dauer, Bytes, Token-Vergleich als Boolean),
keine Prompts, keine Tokens, keine Personendaten. Alle Daten sind synthetisch (Sechs-Fragen-Szenario #456 §12).
