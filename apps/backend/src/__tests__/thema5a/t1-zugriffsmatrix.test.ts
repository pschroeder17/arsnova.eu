/**
 * Thema 5A / T1 – Zugriffsmatrix am unveränderten Release 1.3.0.
 *
 * Unterschied zu den Upstream-Routertests (qa.summary.test.ts): Dort ist
 * `isHostSessionTokenValid` pauschal auf `true` gemockt. Hier laufen die echten
 * Funktionen aus lib/hostAuth.ts (Credential-gebundene Tokens, Rotation, TTL)
 * und lib/moderationQaContext.ts (N5-Autorisierung im Kontextaufbau).
 * Ersetzt sind nur Speicher (Redis/Prisma als In-Memory-Fake), das
 * Pairing-Register und der Lernziel-Service (Sentinel hinter der Auth-Schicht).
 */
import type { IncomingMessage } from 'node:http';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
  MODERATION_PROMPT_CONTEXT_REFERENCE_FIXTURE_V1,
  ModerationAnalysisContextV1Schema,
  QaSummaryExecutionV2Schema,
} from '@arsnova/shared-types';
import { TRPCError } from '@trpc/server';
import { baseSession, outcomeOf, writeEvidence } from './fakes';
import { createWorld, type PairedDevice } from './world';

const env = vi.hoisted(() => ({
  real: process.env['THEMA5A_REAL_INFRA'] === '1',
  db: null as ReturnType<typeof import('./fakes').createFakeDb> | null,
  redis: null as ReturnType<typeof import('./fakes').createFakeRedis> | null,
  pairing: null as ReturnType<typeof import('./fakes').createPairingRegistry> | null,
  serviceCalls: 0,
}));

// THEMA5A_REAL_INFRA=1: echte Module (PostgreSQL/Redis in Docker), sonst In-Memory-Ersatz.
vi.mock('../../db', async (importOriginal) =>
  env.real
    ? importOriginal()
    : {
        prisma: new Proxy(
          {},
          { get: (_target, key) => (env.db!.prisma as Record<string | symbol, unknown>)[key] },
        ),
      },
);
vi.mock('../../redis', async (importOriginal) =>
  env.real ? importOriginal() : { getRedis: () => env.redis! },
);
vi.mock('../../lib/hostPairing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hostPairing')>();
  if (env.real) return actual;
  return {
    ...actual,
    findPairedHostByToken: (code: string, token: string) =>
      env.pairing!.findPairedHostByToken(code, token),
  };
});
vi.mock('../../lib/sessionLearningObjectives', async (importOriginal) => {
  const sentinel = () => {
    env.serviceCalls += 1;
    throw new TRPCError({ code: 'CONFLICT', message: '5A-SENTINEL: Service hinter Auth erreicht' });
  };
  return {
    ...(await importOriginal<typeof import('../../lib/sessionLearningObjectives')>()),
    getSessionLearningObjectives: sentinel,
    saveSessionLearningObjectives: sentinel,
  };
});

import { createCredentialBoundHostToken } from '../../lib/hostAuth';
import { loadAuthorizedModerationState } from '../../lib/moderationQaContext';
import {
  QA_SUMMARY_ADAPTER_CAPABILITIES,
  prepareModerationSummaryContextFromAnalysis,
} from '../../lib/moderationSummaryContext';
import {
  resetQaSummaryQueueForTests,
  waitForQaSummaryIdleForTests,
} from '../../lib/qaSummaryQueue';
import { qaRouter } from '../../routers/qa';
import { sessionRouter } from '../../routers/session';

const SESSION_A = { id: '5a000000-0000-4000-8000-00000000000a', code: 'KURS5A' };
const SESSION_B = { id: '5a000000-0000-4000-8000-00000000000b', code: 'FREMDB' };

const plan = {
  capabilities: QA_SUMMARY_ADAPTER_CAPABILITIES,
  selectedMode: 'full-context' as const,
  fallback: null,
  inferenceConfigured: true,
};
// Sechs-Fragen-Szenario aus #456 §12 als feste Kontext-Fixture.
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
const sourceId = prepared.request.promptContext.context.sources[0]!.id;

let processorCalls = 0;

function ctx(token: string | null) {
  return { req: { headers: token ? { 'x-host-token': token } : {} } as IncomingMessage };
}

type Actor = {
  id: string;
  label: string;
  token: () => Promise<string | null>;
  expectGranted: boolean;
  /** optional: Zustand nach Tokenausgabe verändern (Rotation, Widerruf, Zeit). */
  after?: () => unknown;
};

const world = createWorld(env);
const devices = new Map<string, PairedDevice>();

const records: Array<{
  actor: string;
  procedure: string;
  outcome: string;
  granted: boolean;
  processorCalls: number;
}> = [];

async function issueHostToken(code: string, version = 1) {
  return (await createCredentialBoundHostToken({ sessionCode: code, credentialVersion: version }))
    .token;
}

async function resetWorld() {
  env.serviceCalls = 0;
  devices.clear();
  await world.reset([baseSession(SESSION_A), baseSession(SESSION_B)]);
  processorCalls = 0;
  resetQaSummaryQueueForTests({
    // Ersatz nur für den Analysekontext; die Autorisierung ist der echte N5-Pfad.
    prepare: async ({ sessionId, access }) => {
      await loadAuthorizedModerationState({ sessionId, access });
      return prepared;
    },
    plan: () => plan,
    processor: async () => {
      processorCalls += 1;
      return {
        output: {
          status: 'ready',
          statements: [
            { text: 'Mehr Übungsbeispiele zur Regression gewünscht.', sourceIds: [sourceId] },
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
}

const actors: Actor[] = [
  { id: 'A0', label: 'kein Token', token: async () => null, expectGranted: false },
  {
    id: 'A1',
    label: 'Session-Code als Token (Clientwissen)',
    token: async () => SESSION_A.code,
    expectGranted: false,
  },
  {
    id: 'A2',
    label: 'gültiger Host-Token einer fremden Session',
    token: () => issueHostToken(SESSION_B.code),
    expectGranted: false,
  },
  {
    id: 'A3',
    label: 'Host-Token nach Credential-Rotation',
    token: () => issueHostToken(SESSION_A.code),
    after: () => world.rotateCredential(SESSION_A.code),
    expectGranted: false,
  },
  {
    id: 'A4',
    label: 'Host-Token nach TTL-Ablauf (900 s)',
    token: () => issueHostToken(SESSION_A.code),
    after: () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    },
    expectGranted: false,
  },
  {
    id: 'A5',
    label: 'widerrufener Paired Host',
    token: async () => {
      const device = await world.pairDevice(SESSION_A, 'widerrufen');
      devices.set('A5', device);
      return device.token;
    },
    after: () => world.revokePaired(SESSION_A, devices.get('A5')!),
    expectGranted: false,
  },
  {
    id: 'A6',
    label: 'aktiver Paired Host',
    token: async () => (await world.pairDevice(SESSION_A, 'aktiv')).token,
    expectGranted: true,
  },
  {
    id: 'A7',
    label: 'Original-Host',
    token: () => issueHostToken(SESSION_A.code),
    expectGranted: true,
  },
];

const procedures: Array<{
  name: string;
  call: (token: string | null) => Promise<unknown>;
}> = [
  {
    name: 'qa.summaryRuntime',
    call: (t) => qaRouter.createCaller(ctx(t)).summaryRuntime({ sessionId: SESSION_A.id }),
  },
  {
    name: 'qa.summaryContextPreview',
    call: (t) =>
      qaRouter
        .createCaller(ctx(t))
        .summaryContextPreview({ sessionId: SESSION_A.id, locale: 'de' }),
  },
  {
    name: 'qa.requestSummary',
    call: async (t) => {
      const result = await qaRouter
        .createCaller(ctx(t))
        .requestSummary({ sessionId: SESSION_A.id, locale: 'de' });
      await waitForQaSummaryIdleForTests();
      return result;
    },
  },
  {
    name: 'session.getLearningObjectives',
    call: (t) => sessionRouter.createCaller(ctx(t)).getLearningObjectives({ code: SESSION_A.code }),
  },
  {
    name: 'session.saveLearningObjectives',
    call: (t) =>
      sessionRouter
        .createCaller(ctx(t))
        // Eingabe bewusst minimal: hostProcedure prüft den Token vor der Zod-Validierung.
        .saveLearningObjectives({ code: SESSION_A.code } as never),
  },
];

describe('Thema 5A / T1 – Zugriffsmatrix (echte Host-Autorisierung)', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.stubEnv('QA_SUMMARY_ENABLED', 'true');
    await resetWorld();
  });

  afterAll(() => {
    vi.useRealTimers();
    writeEvidence('t1-zugriffsmatrix', records);
  });

  for (const actor of actors) {
    for (const procedure of procedures) {
      it(`${actor.id} ${actor.label} → ${procedure.name}`, async () => {
        const token = await actor.token();
        await actor.after?.();
        let outcome = 'OK';
        try {
          await procedure.call(token);
        } catch (error) {
          outcome = outcomeOf(error);
        } finally {
          vi.useRealTimers();
        }
        // UNAUTHORIZED/FORBIDDEN = verweigert; alles andere hat die Auth-Schicht passiert
        // (OK bzw. Sentinel des gemockten Lernziel-Service oder Validierungsfehler danach).
        const granted = outcome !== 'UNAUTHORIZED' && outcome !== 'FORBIDDEN';
        records.push({
          actor: `${actor.id} ${actor.label}`,
          procedure: procedure.name,
          outcome,
          granted,
          processorCalls,
        });
        expect(granted).toBe(actor.expectGranted);
        if (!actor.expectGranted) {
          // Kein unberechtigter Aufruf erreicht die Runtime oder einen Service.
          expect(processorCalls).toBe(0);
          expect(env.serviceCalls).toBe(0);
        }
      });
    }
  }

  it('Z1 Original-Host, Session beendet, im Nachbereitungsfenster', async () => {
    const token = await issueHostToken(SESSION_A.code);
    await world.updateSession(SESSION_A.id, {
      status: 'FINISHED',
      endedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    for (const procedure of procedures.slice(0, 3)) {
      let outcome = 'OK';
      try {
        await procedure.call(token);
      } catch (error) {
        outcome = outcomeOf(error);
      }
      records.push({
        actor: 'Z1 Original-Host, Session beendet (Nachbereitung offen)',
        procedure: procedure.name,
        outcome,
        granted: outcome !== 'UNAUTHORIZED' && outcome !== 'FORBIDDEN',
        processorCalls,
      });
    }
    expect(records.at(-3)!.granted).toBe(true); // summaryRuntime lesbar
    expect(records.at(-2)!.granted).toBe(true); // Vorschau lesbar
    // Ist-Befund: Neuer Auftrag bleibt möglich, solange der Q&A-Kanal offen ist
    // (mehrtägige Q&A, qaClosesAt in der Zukunft) – Gate ist kanal-, nicht sessiongebunden.
    expect(records.at(-1)!.outcome).toBe('OK');
  });

  it('Z1b Original-Host, Session beendet und Q&A-Kanal geschlossen', async () => {
    const token = await issueHostToken(SESSION_A.code);
    await world.updateSession(SESSION_A.id, {
      status: 'FINISHED',
      endedAt: new Date(Date.now() - 60 * 60 * 1000),
      qaOpen: false,
    });
    for (const procedure of procedures.slice(0, 3)) {
      let outcome = 'OK';
      try {
        await procedure.call(token);
      } catch (error) {
        outcome = outcomeOf(error);
      }
      records.push({
        actor: 'Z1b Original-Host, Session beendet + Kanal geschlossen',
        procedure: procedure.name,
        outcome,
        granted: outcome !== 'UNAUTHORIZED' && outcome !== 'FORBIDDEN',
        processorCalls,
      });
    }
    expect(records.at(-3)!.granted).toBe(true);
    expect(records.at(-2)!.granted).toBe(true);
    expect(records.at(-1)!.outcome).toBe('FORBIDDEN');
    expect(processorCalls).toBe(0);
  });

  it('Z2 Original-Host mit noch lebendem Token, Nachbereitungsfenster abgelaufen', async () => {
    const token = await issueHostToken(SESSION_A.code);
    await world.expirePostProcessingWindow(SESSION_A.id);
    try {
      for (const procedure of procedures.slice(0, 3)) {
        let outcome = 'OK';
        try {
          await procedure.call(token);
        } catch (error) {
          outcome = outcomeOf(error);
        }
        records.push({
          actor: 'Z2 Original-Host, Nachbereitungsfenster abgelaufen',
          procedure: procedure.name,
          outcome,
          granted: outcome !== 'UNAUTHORIZED' && outcome !== 'FORBIDDEN',
          processorCalls,
        });
        // In-Memory (rückdatiert): Token gilt noch, Fristprüfung → FORBIDDEN.
        // Echte DB (Uhr vorgestellt): Token-Laufzeit ist an das Fristende gekappt → UNAUTHORIZED.
        expect(['FORBIDDEN', 'UNAUTHORIZED']).toContain(outcome);
        if (world.mode === 'fake') expect(outcome).toBe('FORBIDDEN');
      }
    } finally {
      vi.useRealTimers();
    }
    expect(processorCalls).toBe(0);
  });

  it('Z3 unbekannte sessionId ohne Token (Reihenfolge NOT_FOUND vs. UNAUTHORIZED)', async () => {
    let outcome = 'OK';
    try {
      await qaRouter
        .createCaller(ctx(null))
        .summaryRuntime({ sessionId: '5a000000-0000-4000-8000-0000000000ff' });
    } catch (error) {
      outcome = outcomeOf(error);
    }
    records.push({
      actor: 'Z3 kein Token, unbekannte sessionId',
      procedure: 'qa.summaryRuntime',
      outcome,
      granted: false,
      processorCalls,
    });
    // Ist-Zustand dokumentieren: Existenzprüfung vor Autorisierung.
    expect(outcome).toBe('NOT_FOUND');
  });
});
