/**
 * Thema 5A (Referat Cloud Computing, P. Schröder): In-Memory-Ersatz für Redis,
 * Prisma und das Pairing-Register.
 *
 * Ziel: Die echte Autorisierung aus `lib/hostAuth.ts` und
 * `lib/moderationQaContext.ts#loadAuthorizedModerationState` laufen lassen,
 * ohne PostgreSQL/Redis zu starten. Die Fakes bilden nur die Felder ab, die
 * diese Pfade lesen. Sie sind Laborwerkzeug, kein Produktivcode.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type FakeSession = {
  id: string;
  code: string;
  type: 'QUIZ' | 'Q_AND_A';
  status: 'LOBBY' | 'ACTIVE' | 'RESULTS' | 'FINISHED';
  endedAt: Date | null;
  expiresAt: Date;
  hostCredentialVersion: number;
  qaEnabled: boolean;
  qaOpen: boolean;
  qaClosesAt: Date | null;
  qaModerationMode: boolean;
  sessionLifecycleRevision: number;
  qaRankingRevision: number;
  qaQuestionCount: number;
  onboardingAnonymousMode: boolean;
  participantRevision: number;
  learningContextRevision: number;
  learningContextConfigured: boolean;
};

export type FakeHostCredential = {
  id: string;
  sessionCode: string;
  generation: number;
  status: 'ACTIVE' | 'REVOKED';
};

type RedisEntry = { value: string; expiresAt: number | null };

export function createFakeRedis() {
  const store = new Map<string, RedisEntry>();
  const live = (key: string): RedisEntry | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    store,
    async get(key: string) {
      return live(key)?.value ?? null;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      let expiresAt: number | null = null;
      const exIndex = args.findIndex((arg) => String(arg).toUpperCase() === 'EX');
      if (exIndex >= 0) expiresAt = Date.now() + Number(args[exIndex + 1]) * 1000;
      const pxIndex = args.findIndex((arg) => String(arg).toUpperCase() === 'PX');
      if (pxIndex >= 0) expiresAt = Date.now() + Number(args[pxIndex + 1]);
      if (args.some((arg) => String(arg).toUpperCase() === 'NX') && live(key)) return null;
      store.set(key, { value, expiresAt });
      return 'OK';
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys.flat()) if (store.delete(key)) removed += 1;
      return removed;
    },
    async exists(key: string) {
      return live(key) ? 1 : 0;
    },
    async incr(key: string) {
      const next = Number(live(key)?.value ?? '0') + 1;
      store.set(key, { value: String(next), expiresAt: live(key)?.expiresAt ?? null });
      return next;
    },
    async expire() {
      return 1;
    },
    async pexpire() {
      return 1;
    },
    async publish() {
      return 0;
    },
    async eval() {
      return null;
    },
    on() {
      return undefined;
    },
    duplicate() {
      return this;
    },
  };
}

export function createFakeDb() {
  const sessions = new Map<string, FakeSession>();
  const credentials: FakeHostCredential[] = [];

  const findSession = (where: { id?: string; code?: string }) => {
    if (where.id) return sessions.get(where.id) ?? null;
    if (where.code) {
      const code = where.code.trim().toUpperCase();
      return [...sessions.values()].find((session) => session.code === code) ?? null;
    }
    return null;
  };

  const prisma = {
    session: {
      async findUnique(args: { where: { id?: string; code?: string } }) {
        const session = findSession(args.where);
        if (!session) return null;
        return { ...session, _count: { participants: 40 } };
      },
    },
    hostCredential: {
      async findFirst(args: {
        where: {
          session?: { code?: string; hostCredentialVersion?: number };
          generation?: number;
          status?: string;
        };
      }) {
        const where = args.where;
        const code = where.session?.code?.trim().toUpperCase();
        const session = code ? findSession({ code }) : null;
        if (where.session?.hostCredentialVersion !== undefined) {
          if (!session || session.hostCredentialVersion !== where.session.hostCredentialVersion) {
            return null;
          }
        }
        const match = credentials.find(
          (credential) =>
            (!code || credential.sessionCode === code) &&
            (where.generation === undefined || credential.generation === where.generation) &&
            (where.status === undefined || credential.status === where.status),
        );
        return match ? { id: match.id, generation: match.generation } : null;
      },
    },
    participant: {
      async count() {
        return 40;
      },
    },
  };

  return {
    prisma,
    sessions,
    credentials,
    addSession(session: FakeSession) {
      sessions.set(session.id, session);
      credentials.push({
        id: `cred-${session.code}-${session.hostCredentialVersion}`,
        sessionCode: session.code,
        generation: session.hostCredentialVersion,
        status: 'ACTIVE',
      });
    },
    /** Host wechselt das Gerät bzw. widerruft alle alten Zugänge (Credential-Rotation). */
    rotateCredential(code: string) {
      const session = findSession({ code });
      if (!session) throw new Error(`unbekannte Session ${code}`);
      for (const credential of credentials) {
        if (credential.sessionCode === session.code) credential.status = 'REVOKED';
      }
      session.hostCredentialVersion += 1;
      credentials.push({
        id: `cred-${session.code}-${session.hostCredentialVersion}`,
        sessionCode: session.code,
        generation: session.hostCredentialVersion,
        status: 'ACTIVE',
      });
      return session.hostCredentialVersion;
    },
  };
}

/** Pairing-Register: ersetzt nur `findPairedHostByToken` (Redis-Record + Lock im Original). */
export function createPairingRegistry() {
  const devices = new Map<string, { sessionCode: string; tokenId: string; revoked: boolean }>();
  return {
    devices,
    add(token: string, sessionCode: string, tokenId: string) {
      devices.set(token, { sessionCode, tokenId, revoked: false });
    },
    revoke(token: string) {
      const device = devices.get(token);
      if (device) device.revoked = true;
    },
    async findPairedHostByToken(sessionCode: string, token: string) {
      const device = devices.get(token);
      if (!device || device.revoked) return null;
      if (device.sessionCode !== sessionCode.trim().toUpperCase()) return null;
      return { tokenId: device.tokenId, role: 'PAIRED_HOST' as const };
    },
  };
}

export function baseSession(overrides: Partial<FakeSession> & Pick<FakeSession, 'id' | 'code'>) {
  return {
    type: 'Q_AND_A',
    status: 'ACTIVE',
    endedAt: null,
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    hostCredentialVersion: 1,
    qaEnabled: true,
    qaOpen: true,
    qaClosesAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    qaModerationMode: false,
    sessionLifecycleRevision: 1,
    qaRankingRevision: 1,
    qaQuestionCount: 6,
    onboardingAnonymousMode: false,
    participantRevision: 1,
    learningContextRevision: 0,
    learningContextConfigured: false,
    ...overrides,
  } satisfies FakeSession;
}

// Vitest läuft mit cwd = apps/backend (wie die Upstream-Tests, z. B. ensure-schema.test.ts).
const repoRoot = resolve(process.cwd(), '../..');

/** Schreibt Rohdaten nach evidence/5a/results/<name>-<RUN_ID>.json. */
export function writeEvidence(name: string, data: unknown): string {
  const runId = process.env['THEMA5A_RUN_ID'] ?? 'local';
  const realInfra = process.env['THEMA5A_REAL_INFRA'] === '1';
  // Echte Infrastruktur (PostgreSQL/Redis in Docker) bekommt eigene Dateien.
  const fileName = `${name}${realInfra ? '-real-infra' : ''}-run${runId}.json`;
  const file = resolve(repoRoot, 'evidence/5a/results', fileName);
  const infra = realInfra
    ? {
        database: 'PostgreSQL 16 (Docker)',
        redis: 'Redis 7.4 (Docker)',
        pairing: 'lib/hostPairing.ts',
      }
    : { database: 'In-Memory-Ersatz', redis: 'In-Memory-Ersatz', pairing: 'Registry-Ersatz' };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ name, runId, recordedAt: new Date().toISOString(), infra, data }, null, 2)}\n`,
  );
  return file;
}

export function outcomeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? `Error:${error.message.slice(0, 60)}` : 'Error';
}
