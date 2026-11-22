/**
 * Thema 5A: Testwelt in zwei Betriebsarten.
 *
 *   THEMA5A_REAL_INFRA=1  echte PostgreSQL- und Redis-Instanz (DATABASE_URL, REDIS_URL),
 *                         echte Paired-Host-Kopplung (Invite → Request → Approve → Token)
 *                         und Credential-Rotation als Datenbanktransaktion.
 *   sonst                 In-Memory-Ersatz aus fakes.ts (schnell, ohne Container).
 *
 * Die Tests rufen nur diese Schnittstelle auf; Autorisierung, Router und Queue sind in
 * beiden Betriebsarten der unveränderte Release-Code.
 */
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { prisma } from '../../db';
import { getRedis } from '../../redis';
import {
  approveHostPairing,
  createHostPairingInvite,
  getHostPairingRequest,
  requestHostPairing,
  revokePairedHost,
} from '../../lib/hostPairing';
import { createFakeDb, createFakeRedis, createPairingRegistry, type FakeSession } from './fakes';

export const REAL_INFRA = process.env['THEMA5A_REAL_INFRA'] === '1';

export type WorldEnv = {
  db: ReturnType<typeof createFakeDb> | null;
  redis: ReturnType<typeof createFakeRedis> | null;
  pairing: ReturnType<typeof createPairingRegistry> | null;
};

export type SessionRef = { id: string; code: string };
export type PairedDevice = { token: string; tokenId: string };

export interface World {
  mode: 'fake' | 'real';
  reset(sessions: FakeSession[]): Promise<void>;
  updateSession(id: string, patch: Partial<FakeSession>): Promise<void>;
  rotateCredential(code: string): Promise<number>;
  pairDevice(session: SessionRef, label: string): Promise<PairedDevice>;
  revokePaired(session: SessionRef, device: PairedDevice): Promise<void>;
  /**
   * Nachbereitungsfrist (14 Tage nach Ende) ablaufen lassen.
   * In-Memory: Session-Ende wird zurückdatiert. Echte DB: Ein Trigger setzt endedAt
   * auf die Datenbankzeit und verbietet Rückdatierung; dort wird stattdessen die
   * Backend-Uhr (Date) um 14 Tage + 1 h vorgestellt. Aufrufer setzt danach
   * vi.useRealTimers() zurück.
   */
  expirePostProcessingWindow(id: string): Promise<void>;
}

const POST_PROCESSING_PLUS_ONE_HOUR_MS = (14 * 24 + 1) * 60 * 60 * 1000;

const hex64 = () => randomBytes(32).toString('hex');

/** DB-Constraint: qaClosesAt <= expiresAt. Beide Welten halten ihn ein. */
function clampQaClosesAt(current: FakeSession, patch: Partial<FakeSession>): Partial<FakeSession> {
  const expiresAt = patch.expiresAt ?? current.expiresAt;
  const qaClosesAt = patch.qaClosesAt !== undefined ? patch.qaClosesAt : current.qaClosesAt;
  if (qaClosesAt && qaClosesAt > expiresAt) return { ...patch, qaClosesAt: expiresAt };
  return patch;
}

function createFakeWorld(env: WorldEnv): World {
  return {
    mode: 'fake',
    async reset(sessions) {
      env.db = createFakeDb();
      env.redis = createFakeRedis();
      env.pairing = createPairingRegistry();
      for (const session of sessions) env.db.addSession({ ...session });
    },
    async updateSession(id, patch) {
      const session = env.db!.sessions.get(id);
      if (!session) throw new Error(`unbekannte Session ${id}`);
      Object.assign(session, clampQaClosesAt(session, patch));
    },
    async rotateCredential(code) {
      return env.db!.rotateCredential(code);
    },
    async pairDevice(session, label) {
      const device = { token: `paired-5a-${label}`, tokenId: `device-${label}` };
      env.pairing!.add(device.token, session.code, device.tokenId);
      return device;
    },
    async revokePaired(_session, device) {
      env.pairing!.revoke(device.token);
    },
    async expirePostProcessingWindow(id) {
      const endedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      await this.updateSession(id, { status: 'FINISHED', endedAt, expiresAt: endedAt });
    },
  };
}

function createRealWorld(): World {
  const snapshots = new Map<string, FakeSession>();
  return {
    mode: 'real',
    async reset(sessions) {
      await getRedis().flushdb();
      await prisma.session.deleteMany({
        where: {
          OR: [
            { id: { in: sessions.map((session) => session.id) } },
            { code: { in: sessions.map((session) => session.code) } },
          ],
        },
      });
      snapshots.clear();
      // createdAt liegt zurück, damit spätere Fristtests (expiresAt in der Vergangenheit)
      // die DB-Constraints expiresAt > createdAt und <= createdAt + 30 Tage einhalten.
      const createdAt = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
      for (const session of sessions) {
        snapshots.set(session.id, { ...session });
        await prisma.session.create({
          data: {
            id: session.id,
            code: session.code,
            type: session.type,
            status: session.status,
            endedAt: session.endedAt,
            expiresAt: session.expiresAt,
            createdAt,
            startedAt: createdAt,
            hostCredentialVersion: session.hostCredentialVersion,
            qaEnabled: session.qaEnabled,
            qaOpen: session.qaOpen,
            qaClosesAt: session.qaClosesAt,
            qaModerationMode: session.qaModerationMode,
            sessionLifecycleRevision: session.sessionLifecycleRevision,
            qaRankingRevision: session.qaRankingRevision,
            qaQuestionCount: session.qaQuestionCount,
            qaQuestionPeakCount: session.qaQuestionCount,
            onboardingAnonymousMode: session.onboardingAnonymousMode,
            participantRevision: session.participantRevision,
            learningContextRevision: session.learningContextRevision,
            learningContextConfigured: session.learningContextConfigured,
          },
        });
        await prisma.hostCredential.create({
          data: {
            sessionId: session.id,
            generation: session.hostCredentialVersion,
            status: 'ACTIVE',
            browserCapabilityHash: hex64(),
            recoveryCodeHash: hex64(),
            activatedAt: createdAt,
          },
        });
      }
    },
    async updateSession(id, patch) {
      const current = snapshots.get(id);
      if (!current) throw new Error(`unbekannte Session ${id}`);
      const effective = clampQaClosesAt(current, patch);
      Object.assign(current, effective);
      await prisma.session.update({ where: { id }, data: effective });
    },
    async rotateCredential(code) {
      // Gleiche DB-Wirkung wie Admin-Reset + Aktivierung (hostCredentialRecovery.ts):
      // alle aktiven Credentials widerrufen, Generation erhöhen, neue Generation aktiv.
      return prisma.$transaction(async (tx) => {
        const session = await tx.session.findUniqueOrThrow({
          where: { code },
          select: { id: true, hostCredentialVersion: true },
        });
        const now = new Date();
        await tx.hostCredential.updateMany({
          where: { sessionId: session.id, status: { in: ['ACTIVE', 'PENDING'] } },
          data: { status: 'REVOKED', revokedAt: now },
        });
        const next = session.hostCredentialVersion + 1;
        await tx.session.update({
          where: { id: session.id },
          data: { hostCredentialVersion: next },
        });
        await tx.hostCredential.create({
          data: {
            sessionId: session.id,
            generation: next,
            status: 'ACTIVE',
            browserCapabilityHash: hex64(),
            recoveryCodeHash: hex64(),
            activatedAt: now,
          },
        });
        const snapshot = snapshots.get(session.id);
        if (snapshot) snapshot.hostCredentialVersion = next;
        return next;
      });
    },
    async pairDevice(session, label) {
      // Echter Kopplungsablauf aus lib/hostPairing.ts (Redis-Record, Lock, Token-Hash).
      const invite = await createHostPairingInvite({
        sessionId: session.id,
        sessionCode: session.code,
        screenVisibility: 'PRIVATE',
      });
      const request = await requestHostPairing({
        sessionId: session.id,
        sessionCode: session.code,
        pairingSecret: invite.pairingSecret,
        deviceLabel: `5A ${label}`,
      });
      if (!request.requestId || !request.requestSecret) {
        throw new Error('Pairing-Anfrage ohne Request-ID');
      }
      await approveHostPairing({
        sessionId: session.id,
        sessionCode: session.code,
        requestId: request.requestId,
      });
      const issued = await getHostPairingRequest({
        sessionId: session.id,
        sessionCode: session.code,
        requestId: request.requestId,
        requestSecret: request.requestSecret,
      });
      if (!issued.token) throw new Error(`Pairing ohne Token (Zustand ${issued.state})`);
      return { token: issued.token.pairedHostToken, tokenId: issued.token.tokenId };
    },
    async revokePaired(session, device) {
      await revokePairedHost({
        sessionId: session.id,
        sessionCode: session.code,
        tokenId: device.tokenId,
      });
    },
    async expirePostProcessingWindow(id) {
      const snapshot = snapshots.get(id);
      if (!snapshot) throw new Error(`unbekannte Session ${id}`);
      if (snapshot.status !== 'FINISHED') {
        // DB-Trigger setzt endedAt := Datenbankzeit (keine Rückdatierung möglich).
        await this.updateSession(id, { status: 'FINISHED', endedAt: new Date() });
      }
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + POST_PROCESSING_PLUS_ONE_HOUR_MS);
    },
  };
}

export function createWorld(env: WorldEnv): World {
  return REAL_INFRA ? createRealWorld() : createFakeWorld(env);
}

/** Für die Rohdaten: in welcher Umgebung lief der Test? */
export function infraDescription() {
  return REAL_INFRA
    ? {
        mode: 'real',
        database: 'PostgreSQL (DATABASE_URL, Docker)',
        redis: 'Redis (REDIS_URL, Docker)',
        pairing: 'lib/hostPairing.ts (echt)',
      }
    : { mode: 'fake', database: 'In-Memory', redis: 'In-Memory', pairing: 'Registry-Ersatz' };
}
