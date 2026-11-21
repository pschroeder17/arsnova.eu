# Evidenz Thema 5A – Autorisierung, Freigaben und Datenminimierung

Referatsprüfung Cloud Computing (DSCC0127), Gruppe 5 „Sicherheit“, Auftrag 5A – Paul Schröder.
Handout-Titel: „Rechte, die während der Analyse verfallen: Autorisierung und Freigabegrenzen am
Ausgabepunkt des Moderationskompasses (arsnova.eu 1.3)“.

Dieser Branch basiert unverändert auf dem Release-Tag **`v1.3.0`** (`87c39334`). Ergänzt sind ausschließlich:

- `apps/backend/src/__tests__/thema5a/` – eigene Testsuite (4 Dateien, 65 Fälle),
- `evidence/5a/` – Manifest, Startskript der Laborruntime, Rohdaten.

Produktivcode wurde **nicht** verändert. Die Gegenvarianten V1/V2 existieren nur als Test-Hooks.

## Hypothese und Gegenalternative

- **H:** Weder Session-Code noch Clientzustand begründen eine Berechtigung; Rechte und Freigabestatus
  werden an jedem Ausgabepunkt erneut geprüft, auch während eines laufenden Summary-Auftrags.
- **G (Gegenvariante):** Eine Prüfung beim Start genügt.
  - **V1** cacht die Autorisierungsentscheidung je (Session, Token) („Startprüfung am Ausgabepunkt“).
  - **V2** verzichtet auf die Neuprüfung nach der Inferenz.
- **Schwelle (vorab):** Jede Auslieferung von Inhalt an einen entzogenen Akteur und jeder nach dem
  Entzug erzeugte Inhalt im Laufzeitzustand ist ein Verstoß (Toleranz 0).

## Tests

| Datei                              | Inhalt                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t1-zugriffsmatrix.test.ts`        | 8 Akteure × 5 Prozeduren + 4 Zustandsfälle; echte `hostAuth.ts` und `loadAuthorizedModerationState`, Speicher als In-Memory-Fake                                        |
| `t2-rechteentzug.test.ts`          | Rechteentzug **während** der Inferenz (S1 Credential-Rotation, S2 Paired-Host-Entkopplung, S3 Ende des Nachbereitungsfensters) × Baseline/V1/V2, deterministischer Stub |
| `t2-real-runtime.test.ts`          | dasselbe mit **echter privater Runtime** (llama-server, gepinntes GGUF) hinter einem Metadaten-Proxy; plus R0: unberechtigte Aufträge erzeugen 0 Runtime-Requests       |
| `t3-freigabe-ausgabepunkt.test.ts` | Kanal schließen / Deadline / deaktiviert / anonym: Teilnehmeransicht `qa.list` vs. öffentliche Beamer-Projektion `qa.presentProjection`                                 |
| `fakes.ts`                         | In-Memory-Redis/Prisma/Pairing-Register, Evidenz-Writer                                                                                                                 |

Ausführen (Repo-Root, nach `npm ci` und `npm run prisma:generate`):

```bash
# ohne Runtime (T1, T2-Stub, T3; T2-real wird übersprungen)
npm run test -w @arsnova/backend -- --run src/__tests__/thema5a

# alle Tests, 3 Wiederholungen, mit laufender Laborruntime (siehe MANIFEST.md)
RUN_5A_REAL_RUNTIME=1 THEMA5A_LLM_TOKEN_FILE=<pfad-zum-token> bash evidence/5a/run-all.sh
```

## Ergebnisse (3 Läufe, jeweils 65/65 bestanden, Ergebnisse in allen Läufen identisch)

**T1 Zugriffsmatrix:** Alle 40 Matrixfälle wie erwartet. Kein Token, Session-Code als Token, gültiges Token
einer fremden Session, rotiertes Token, abgelaufenes Token (TTL 900 s) und entkoppelter Paired Host →
`UNAUTHORIZED`; dabei 0 Aufrufe von Runtime oder Lernziel-Service. Aktiver Paired Host und Original-Host →
Zugriff. Zustandsfälle: Session beendet + Q&A-Kanal offen → Lesen und neuer Auftrag möglich (mehrtägige Q&A);
Session beendet + Kanal zu → neuer Auftrag `FORBIDDEN`; Nachbereitungsfenster abgelaufen → `FORBIDDEN` trotz
gültigem Token; unbekannte `sessionId` ohne Token → `NOT_FOUND` vor der Autorisierung.

**T2 Rechteentzug während der Inferenz:**

| Szenario                     | Baseline 1.3                                                  | V1 (Prüfentscheid gecacht)                              | V2 (keine Neuprüfung)                                |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| S1 Credential-Rotation       | `failed/permission_changed`, 0 Aussagen; Leser `UNAUTHORIZED` | entzogener Token liest Ergebnis                         | Inhalt nach Entzug im Speicher; Leser `UNAUTHORIZED` |
| S2 Paired Host entkoppelt    | wie S1                                                        | entkoppeltes Gerät liest Ergebnis                       | wie S1                                               |
| S3 Nachbereitungsfrist endet | `permission_changed`; Leser `FORBIDDEN`                       | **geschützt** (Fristprüfung unabhängig vom Token-Cache) | Inhalt im Speicher                                   |

Echte Runtime (S1/S2, 18 Läufe): Entzug 4–12 ms nach Auftragsstart, Inferenz lief jeweils bis zum
Queue-Limit von 30 s; Runtime-Requests trugen ausschließlich das Dienst-Token, kein Host-Token im Request;
R0: 3 unberechtigte `requestSummary`-Aufrufe → 0 Runtime-Requests.

**T3 Freigabe am Ausgabepunkt:** Kanal geschlossen bzw. Deadline abgelaufen → Teilnehmende 0 Fragen,
öffentliche Beamer-Projektion **6 Fragen inkl. 6 Nicknames** ohne jede Zugangsberechtigung
(`sessionId` ist über `session.getInfo` per Session-Code öffentlich). Anonymer Modus: keine Nicknames;
Kanal deaktiviert: beide leer.

## Rohdaten

- `baseline/upstream-tests-v1.3.0.json` – Upstream-Tests der betroffenen Module auf v1.3.0 (7 Dateien, 134 bestanden)
- `results/*-run{1,2,3}.json` – Messwerte je Lauf, `results/vitest-run{1,2,3}.json` – Vitest-Berichte

Die Proxy-Protokolle enthalten nur Metadaten (Pfad, Status, Dauer, Bytes, Token-Vergleich als Boolean),
keine Prompts, keine Tokens, keine Personendaten. Alle Daten sind synthetisch (Sechs-Fragen-Szenario #456 §12).
