/**
 * Thema 5A / T2 – Rechteentzug und Freigabeänderung WÄHREND eines laufenden
 * Summary-Auftrags. Vergleich Release-Baseline gegen zwei absichtlich
 * abgeschwächte Laborvarianten (nur in diesem Test, kein Produktivcode):
 *
 *   BASELINE  unverändertes 1.3-Verhalten (Prüfung an jedem Ausgabepunkt + Job-Neuprüfung)
 *   V1        Autorisierungsentscheidung wird je (Session, Token) gecacht
 *             („Startprüfung“ am Ausgabepunkt, typisches Performance-Muster)
 *   V2        Kontextaufbau prüft die Berechtigung nur beim ersten Aufbau
 *             (keine Neuprüfung nach der Inferenz)
 *
 * Die Inferenz ist hier ein Stub, der den Entzug deterministisch WÄHREND des
 * Laufs auslöst. Der reale Runtime-Lauf steht in t2-real-runtime.test.ts.
 */
import type { IncomingMessage } from 'node:http';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
  MODERATION_PROMPT_CONTEXT_REFERENCE_FIXTURE_V1,
  ModerationAnalysisContextV1Schema,
  QaSummaryExecutionV2Schema,
} from '@arsnova/shared-types';
import {
  baseSession,
  createFakeDb,
  createFakeRedis,
  createPairingRegistry,
  outcomeOf,
  writeEvidence,
} from './fakes';

type Variant = 'BASELINE' | 'V1' | 'V2';

const env = vi.hoisted(() => ({
  db: null as ReturnType<typeof import('./fakes').createFakeDb> | null,
  redis: null as ReturnType<typeof import('./fakes').createFakeRedis> | null,
  pairing: null as ReturnType<typeof import('./fakes').createPairingRegistry> | null,
  variant: 'BASELINE' as 'BASELINE' | 'V1' | 'V2',
  decisionCache: new Set<string>(),
}));

vi.mock('../../db', () => ({
  prisma: new Proxy(
    {},
    { get: (_target, key) => (env.db!.prisma as Record<string | symbol, unknown>)[key] },
  ),
}));
vi.mock('../../redis', () => ({ getRedis: () => env.redis! }));
vi.mock('../../lib/hostPairing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/hostPairing')>()),
  findPairedHostByToken: (code: string, token: string) =>
    env.pairing!.findPairedHostByToken(code, token),
}));
vi.mock('../../lib/hostAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hostAuth')>();
  return {
    ...actual,
    assertHostSessionAccessFromContext: async (
      context: Parameters<typeof actual.assertHostSessionAccessFromContext>[0],
      sessionCode: string,
    ) => {
      if (env.variant !== 'V1')
        return actual.assertHostSessionAccessFromContext(context, sessionCode);
      // V1: einmal positiv geprüft = für diesen Token „dauerhaft“ berechtigt.
      const token = actual.extractHostTokenFromContext(context);
      const key = `${sessionCode}:${token ?? ''}`;
      if (token && env.decisionCache.has(key)) return token;
      const checked = await actual.assertHostSessionAccessFromContext(context, sessionCode);
      env.decisionCache.add(key);
      return checked;
    },
  };
});

import { createCredentialBoundHostToken } from '../../lib/hostAuth';
import { loadAuthorizedModerationState } from '../../lib/moderationQaContext';
import {
  QA_SUMMARY_ADAPTER_CAPABILITIES,
  prepareModerationSummaryContextFromAnalysis,
} from '../../lib/moderationSummaryContext';
import {
  getQaSummaryRuntime,
  resetQaSummaryQueueForTests,
  waitForQaSummaryIdleForTests,
} from '../../lib/qaSummaryQueue';
import { qaRouter } from '../../routers/qa';

const SESSION = { id: '5a000000-0000-4000-8000-0000000000c2', code: 'LIVE5A' };
const plan = {
  capabilities: QA_SUMMARY_ADAPTER_CAPABILITIES,
  selectedMode: 'full-context' as const,
  fallback: null,
  inferenceConfigured: true,
};
const fixture = structuredClone(MODERATION_PROMPT_CONTEXT_REFERENCE_FIXTURE_V1);
const prepared = prepareModerationSummaryContextFromAnalysis({
  analysis: ModerationAnalysisContextV1Schema.parse({
    schemaVersion: fixture.schemaVersion,
    contractVersion: MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
    assembledAt: '2026-01-15T10:05:00.000Z',
    context: { ...fixture.context, representation: 'analysis-candidates' },
  }),
  plan,
  packedAt: new Date('2026-01-15T10:06:00.000Z'),
});
const sourceIds = prepared.request.promptContext.context.sources.map(
  (source: { id: string }) => source.id,
);

function ctx(token: string | null) {
  return { req: { headers: token ? { 'x-host-token': token } : {} } as IncomingMessage };
}

async function issueHostToken(code: string, version: number) {
  return (await createCredentialBoundHostToken({ sessionCode: code, credentialVersion: version }))
    .token;
}

type Measurement = {
  scenario: string;
  variant: Variant;
  job: { status: string; fallbackReason: string | null; statements: number; sources: number };
  revokedRead: { outcome: string; statements: number; sources: number };
  legitimateRead: { outcome: string; statements: number; sources: number } | null;
  processorCalls: number;
  violation: boolean;
};
const measurements: Measurement[] = [];

async function read(token: string | null) {
  try {
    const runtime = await qaRouter
      .createCaller(ctx(token))
      .summaryRuntime({ sessionId: SESSION.id });
    return {
      outcome: 'OK',
      statements: runtime.result?.statements.length ?? 0,
      sources: runtime.result?.sources.length ?? 0,
    };
  } catch (error) {
    return { outcome: outcomeOf(error), statements: 0, sources: 0 };
  }
}

type Scenario = {
  id: string;
  label: string;
  setup: () => Promise<{ starter: string; legit: string | null }>;
  /** Wird ausgelöst, während das Modell „rechnet“. */
  revoke: (tokens: { starter: string }) => void;
};

const scenarios: Scenario[] = [
  {
    id: 'S1',
    label: 'Credential-Rotation (z. B. Verdacht auf Tokenabfluss) während der Inferenz',
    setup: async () => ({ starter: await issueHostToken(SESSION.code, 1), legit: null }),
    revoke: () => {
      env.db!.rotateCredential(SESSION.code);
    },
  },
  {
    id: 'S2',
    label: 'Paired Host wird während der Inferenz entkoppelt',
    setup: async () => {
      env.pairing!.add('paired-5a-s2', SESSION.code, 'device-s2');
      return { starter: 'paired-5a-s2', legit: await issueHostToken(SESSION.code, 1) };
    },
    revoke: () => env.pairing!.revoke('paired-5a-s2'),
  },
  {
    id: 'S3',
    label: 'Nachbereitungsfenster endet während der Inferenz (zeitabhängige Zulässigkeit)',
    setup: async () => {
      const token = await issueHostToken(SESSION.code, 1);
      const session = env.db!.sessions.get(SESSION.id)!;
      session.status = 'FINISHED';
      session.endedAt = new Date(Date.now() - 60 * 60 * 1000);
      return { starter: token, legit: null };
    },
    revoke: () => {
      const session = env.db!.sessions.get(SESSION.id)!;
      session.endedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      session.expiresAt = session.endedAt;
    },
  },
];

describe('Thema 5A / T2 – Rechteentzug während der Verarbeitung', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('QA_SUMMARY_ENABLED', 'true');
  });

  afterAll(() => writeEvidence('t2-rechteentzug-stub', measurements));

  for (const scenario of scenarios) {
    for (const variant of ['BASELINE', 'V1', 'V2'] as const) {
      it(`${scenario.id} ${variant}: ${scenario.label}`, async () => {
        env.db = createFakeDb();
        env.redis = createFakeRedis();
        env.pairing = createPairingRegistry();
        env.variant = variant;
        env.decisionCache.clear();
        env.db.addSession(baseSession(SESSION));
        const authorizedOnce = new Set<string>();
        let processorCalls = 0;
        let tokens: { starter: string; legit: string | null } = { starter: '', legit: null };

        resetQaSummaryQueueForTests({
          prepare: async ({ sessionId, access }) => {
            if (variant === 'V2' && authorizedOnce.has(sessionId)) return prepared;
            await loadAuthorizedModerationState({ sessionId, access });
            authorizedOnce.add(sessionId);
            return prepared;
          },
          plan: () => plan,
          processor: async () => {
            processorCalls += 1;
            scenario.revoke(tokens); // Entzug, während das Modell rechnet
            return {
              output: {
                status: 'ready',
                statements: [
                  {
                    text: 'Wunsch nach weiteren Regressionsbeispielen.',
                    sourceIds: [sourceIds[0]!],
                  },
                  {
                    text: 'Prüfungsrelevanz von Kapitel 4 ist unklar.',
                    sourceIds: [sourceIds[2]!],
                  },
                ],
                suggestedNextSteps: [],
                limitations: [],
                modelVersion: 'stub-5a',
              },
              execution: QaSummaryExecutionV2Schema.parse({
                attemptedMode: 'full-context',
                effectiveMode: 'full-context',
                fallback: null,
              }),
            };
          },
        });

        tokens = await scenario.setup();
        const started = await qaRouter
          .createCaller(ctx(tokens.starter))
          .requestSummary({ sessionId: SESSION.id, locale: 'de' });
        expect(started.result?.status).toBe('pending');
        await waitForQaSummaryIdleForTests();

        const state = getQaSummaryRuntime(SESSION.id).result;
        const revokedRead = await read(tokens.starter);
        const legitimateRead = tokens.legit ? await read(tokens.legit) : null;
        const job = {
          status: state?.status ?? 'none',
          fallbackReason: state?.execution.fallback?.reason ?? null,
          statements: state?.statements.length ?? 0,
          sources: state?.sources.length ?? 0,
        };
        // Verstoß = der entzogene Principal sieht Inhalt ODER nach Entzug entstandener
        // Modellinhalt liegt im Laufzeitzustand (Datenminimierung).
        const violation = revokedRead.statements > 0 || job.statements > 0;
        measurements.push({
          scenario: `${scenario.id} ${scenario.label}`,
          variant,
          job,
          revokedRead,
          legitimateRead,
          processorCalls,
          violation,
        });

        if (variant === 'BASELINE') {
          expect(job.status).toBe('failed');
          expect(job.fallbackReason).toBe('permission_changed');
          expect(job.statements).toBe(0);
          expect(revokedRead.statements).toBe(0);
        } else if (variant === 'V1' && scenario.id === 'S3') {
          // Die Fristprüfung (Nachbereitungsfenster) ist vom Token-Entscheid unabhängig:
          // Ein Cache der Tokenprüfung hebelt sie nicht aus (Schutzschichten getrennt).
          expect(violation).toBe(false);
        } else {
          expect(violation).toBe(true);
        }
      });
    }
  }
});
