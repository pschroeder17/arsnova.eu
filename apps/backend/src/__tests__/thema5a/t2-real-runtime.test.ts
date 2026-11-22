/**
 * Thema 5A / T2-real – derselbe Rechteentzug wie in t2-rechteentzug.test.ts,
 * aber mit ECHTER privater Runtime: llama-server (CPU) mit dem in
 * docker/open-weight-llm/model-manifest.json gepinnten GGUF, hinter einem
 * protokollierenden Loopback-Proxy. Der Entzug wird ausgelöst, sobald der
 * Chat-Completion-Request die Runtime erreicht, also während das Modell rechnet.
 *
 * Opt-in (Laborinstanz nötig):
 *   RUN_5A_REAL_RUNTIME=1  THEMA5A_LLM_TOKEN_FILE=<Pfad>  [THEMA5A_LLM_UPSTREAM=http://127.0.0.1:8080]
 *
 * Protokolliert werden nur Metadaten (Pfad, Status, Dauer, Bytes, ob der
 * Runtime-Header dem Dienst-Token entspricht, ob der Host-Token irgendwo im
 * Request auftaucht) – keine Prompts, keine Tokens.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
  MODERATION_PROMPT_CONTEXT_REFERENCE_FIXTURE_V1,
  ModerationAnalysisContextV1Schema,
} from '@arsnova/shared-types';
import { baseSession, outcomeOf, writeEvidence } from './fakes';
import { createWorld, type PairedDevice } from './world';

const RUN = process.env['RUN_5A_REAL_RUNTIME'] === '1';

const env = vi.hoisted(() => ({
  real: process.env['THEMA5A_REAL_INFRA'] === '1',
  db: null as ReturnType<typeof import('./fakes').createFakeDb> | null,
  redis: null as ReturnType<typeof import('./fakes').createFakeRedis> | null,
  pairing: null as ReturnType<typeof import('./fakes').createPairingRegistry> | null,
  variant: 'BASELINE' as 'BASELINE' | 'V1' | 'V2',
  decisionCache: new Set<string>(),
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
import { resetOpenWeightLlmClientForTests } from '../../lib/openWeightLlmClient';
import {
  getQaSummaryRuntime,
  resetQaSummaryQueueForTests,
  waitForQaSummaryIdleForTests,
} from '../../lib/qaSummaryQueue';
import { qaRouter } from '../../routers/qa';

const SESSION = { id: '5a000000-0000-4000-8000-0000000000d3', code: 'REAL5A' };
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

type ProxyRecord = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  runtimeAuthIsServiceToken: boolean;
  hostTokenInRequest: boolean;
};

let proxy: Server;
let proxyPort = 0;
let serviceToken = '';
let currentHostTokens: string[] = [];
let onCompletionRequest: (() => void) | null = null;
const proxyLog: ProxyRecord[] = [];
const measurements: unknown[] = [];

function ctx(token: string | null) {
  return { req: { headers: token ? { 'x-host-token': token } : {} } as IncomingMessage };
}

async function issueHostToken(code: string, version: number) {
  return (await createCredentialBoundHostToken({ sessionCode: code, credentialVersion: version }))
    .token;
}

async function read(token: string | null) {
  try {
    const runtime = await qaRouter
      .createCaller(ctx(token))
      .summaryRuntime({ sessionId: SESSION.id });
    return {
      outcome: 'OK',
      statements: runtime.result?.statements.length ?? 0,
      sources: runtime.result?.sources.length ?? 0,
      modelVersion: runtime.result?.modelVersion ?? null,
    };
  } catch (error) {
    return { outcome: outcomeOf(error), statements: 0, sources: 0, modelVersion: null };
  }
}

const world = createWorld(env);

async function resetWorld(variant: 'BASELINE' | 'V1' | 'V2') {
  env.variant = variant;
  env.decisionCache.clear();
  await world.reset([baseSession(SESSION)]);
  proxyLog.length = 0;
  onCompletionRequest = null;
  resetOpenWeightLlmClientForTests();
  const authorizedOnce = new Set<string>();
  resetQaSummaryQueueForTests({
    prepare: async ({ sessionId, access }) => {
      if (variant === 'V2' && authorizedOnce.has(sessionId)) return prepared;
      await loadAuthorizedModerationState({ sessionId, access });
      authorizedOnce.add(sessionId);
      return prepared;
    },
    plan: () => plan,
    // processor: Default = runPreparedQaSummary → openWeightLlmClient → Proxy → llama-server
  });
}

describe.skipIf(!RUN)('Thema 5A / T2-real – Rechteentzug bei echter privater Runtime', () => {
  beforeAll(async () => {
    serviceToken = readFileSync(
      process.env['THEMA5A_LLM_TOKEN_FILE'] ?? 'C:/repos/cc-referat-5a/lab/llm-token.txt',
      'utf8',
    ).trim();
    const upstream = new URL(process.env['THEMA5A_LLM_UPSTREAM'] ?? 'http://127.0.0.1:8080');
    proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const started = Date.now();
        const headerText = JSON.stringify(req.headers);
        const bodyText = body.toString('utf8');
        const record: ProxyRecord = {
          method: req.method ?? '',
          path: (req.url ?? '').split('?')[0] ?? '',
          status: 0,
          durationMs: 0,
          requestBytes: body.length,
          responseBytes: 0,
          runtimeAuthIsServiceToken: req.headers['authorization'] === `Bearer ${serviceToken}`,
          hostTokenInRequest: currentHostTokens.some(
            (token) => token.length > 0 && (bodyText.includes(token) || headerText.includes(token)),
          ),
        };
        proxyLog.push(record); // sofort erfassen, Status/Dauer folgen bei Antwortende
        const dumpFile = process.env['THEMA5A_DUMP_BODY_FILE'];
        if (dumpFile && record.path === '/v1/chat/completions') {
          // nur Labor: synthetischer Fixture-Request zum Nachmessen, nie in evidence/
          writeFileSync(dumpFile, body);
        }
        if (record.path === '/v1/chat/completions' && onCompletionRequest) {
          const trigger = onCompletionRequest;
          onCompletionRequest = null;
          trigger(); // Entzug, während das Modell rechnet
        }
        const forward = httpRequest(
          {
            host: upstream.hostname,
            port: upstream.port,
            method: req.method,
            path: req.url,
            headers: req.headers,
          },
          (upstreamRes) => {
            const out: Buffer[] = [];
            upstreamRes.on('data', (chunk: Buffer) => out.push(chunk));
            upstreamRes.on('end', () => {
              const payload = Buffer.concat(out);
              record.status = upstreamRes.statusCode ?? 0;
              record.durationMs = Date.now() - started;
              record.responseBytes = payload.length;
              res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
              res.end(payload);
            });
          },
        );
        forward.on('error', () => {
          record.status = 502;
          record.durationMs = Date.now() - started;
          res.writeHead(502).end();
        });
        res.on('close', () => {
          if (record.status === 0) {
            record.durationMs = Date.now() - started; // Client hat abgebrochen (Timeout)
            forward.destroy();
          }
        });
        forward.end(body);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    writeEvidence('t2-real-runtime', measurements);
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  /** Eine Runtime mit genau einem Slot: vor jedem Fall abwarten, bis er frei ist. */
  async function waitForIdleSlot(timeoutMs = 120_000) {
    const upstream = process.env['THEMA5A_LLM_UPSTREAM'] ?? 'http://127.0.0.1:8080';
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const response = await fetch(`${upstream}/slots`, {
          headers: { authorization: `Bearer ${serviceToken}` },
        });
        const slots = (await response.json()) as Array<{ is_processing?: boolean }>;
        if (slots.every((slot) => slot.is_processing !== true)) return Date.now() - started;
      } catch {
        // Runtime startet evtl. noch
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Runtime-Slot wurde nicht frei');
  }

  function stubRuntimeEnv() {
    vi.unstubAllEnvs();
    vi.stubEnv('QA_SUMMARY_ENABLED', 'true');
    vi.stubEnv('QA_SUMMARY_TIMEOUT_MS', '30000');
    vi.stubEnv('OPEN_WEIGHT_LLM_ENABLED', 'true');
    vi.stubEnv('OPEN_WEIGHT_LLM_URL', `http://127.0.0.1:${proxyPort}`);
    vi.stubEnv('OPEN_WEIGHT_LLM_TOKEN', serviceToken);
    vi.stubEnv('OPEN_WEIGHT_LLM_SUMMARY_TIMEOUT_MS', '30000');
  }

  it('R0 unberechtigte Aufträge erreichen die Runtime nicht (0 Requests)', async () => {
    stubRuntimeEnv();
    await resetWorld('BASELINE');
    const foreign = 'f'.repeat(43);
    currentHostTokens = [foreign];
    const outcomes: string[] = [];
    for (const token of [null, SESSION.code, foreign]) {
      try {
        await qaRouter
          .createCaller(ctx(token))
          .requestSummary({ sessionId: SESSION.id, locale: 'de' });
        outcomes.push('OK');
      } catch (error) {
        outcomes.push(outcomeOf(error));
      }
    }
    await waitForQaSummaryIdleForTests(5_000).catch(() => undefined);
    measurements.push({
      case: 'R0 unberechtigte requestSummary-Aufrufe',
      outcomes,
      proxyLog: [...proxyLog],
    });
    expect(outcomes).toEqual(['UNAUTHORIZED', 'UNAUTHORIZED', 'UNAUTHORIZED']);
    expect(proxyLog).toHaveLength(0);
  });

  type Tokens = { starter: string; legit: string | null; device?: PairedDevice };
  const scenarios = [
    {
      id: 'S1',
      label: 'Credential-Rotation während der Inferenz',
      setup: async (): Promise<Tokens> => ({
        starter: await issueHostToken(SESSION.code, 1),
        legit: null,
      }),
      revoke: (_tokens: Tokens) => world.rotateCredential(SESSION.code),
    },
    {
      id: 'S2',
      label: 'Paired Host wird während der Inferenz entkoppelt',
      setup: async (): Promise<Tokens> => {
        const device = await world.pairDevice(SESSION, 'real-s2');
        return { starter: device.token, legit: await issueHostToken(SESSION.code, 1), device };
      },
      revoke: (tokens: Tokens) => world.revokePaired(SESSION, tokens.device!),
    },
  ];

  for (const scenario of scenarios) {
    for (const variant of ['BASELINE', 'V1', 'V2'] as const) {
      it(`${scenario.id} ${variant} (echte Runtime): ${scenario.label}`, async () => {
        await waitForIdleSlot();
        stubRuntimeEnv();
        await resetWorld(variant);
        const tokens = await scenario.setup();
        currentHostTokens = [tokens.starter, tokens.legit ?? ''];
        let revokedAt: number | null = null;
        let revocation: Promise<unknown> = Promise.resolve();
        onCompletionRequest = () => {
          revokedAt = Date.now();
          revocation = Promise.resolve(scenario.revoke(tokens));
        };
        const startedAt = Date.now();
        await qaRouter
          .createCaller(ctx(tokens.starter))
          .requestSummary({ sessionId: SESSION.id, locale: 'de' });
        await waitForQaSummaryIdleForTests(60_000);
        await revocation;
        const finishedAt = Date.now();
        const state = getQaSummaryRuntime(SESSION.id).result;
        const revokedRead = await read(tokens.starter);
        const legitimateRead = tokens.legit ? await read(tokens.legit) : null;
        const completion = proxyLog.find((entry) => entry.path === '/v1/chat/completions');
        const record = {
          case: `${scenario.id} ${scenario.label}`,
          variant,
          runtimeRequests: proxyLog.map(({ method, path, status, durationMs }) => ({
            method,
            path,
            status,
            durationMs,
          })),
          inferenceMs: completion?.durationMs ?? null,
          revokedAfterMs: revokedAt === null ? null : revokedAt - startedAt,
          totalMs: finishedAt - startedAt,
          runtimeAuthAlwaysServiceToken: proxyLog.every((entry) => entry.runtimeAuthIsServiceToken),
          hostTokenSeenByRuntime: proxyLog.some((entry) => entry.hostTokenInRequest),
          job: {
            status: state?.status ?? 'none',
            effectiveMode: state?.execution.effectiveMode ?? null,
            fallbackReason: state?.execution.fallback?.reason ?? null,
            statements: state?.statements.length ?? 0,
            sources: state?.sources.length ?? 0,
            modelVersion: state?.modelVersion ?? null,
          },
          revokedRead,
          legitimateRead,
        };
        measurements.push(record);
        // Der Auftrag muss die Runtime tatsächlich erreicht haben (Entzug während Inferenz).
        expect(completion).toBeDefined();
        expect(revokedAt).not.toBeNull();
        expect(record.hostTokenSeenByRuntime).toBe(false);
        expect(record.runtimeAuthAlwaysServiceToken).toBe(true);
        if (variant === 'BASELINE') {
          expect(record.job.fallbackReason).toBe('permission_changed');
          expect(record.job.statements).toBe(0);
          expect(revokedRead.statements).toBe(0);
        } else {
          expect(record.job.statements + revokedRead.statements).toBeGreaterThan(0);
        }
      }, 120_000);
    }
  }
});
