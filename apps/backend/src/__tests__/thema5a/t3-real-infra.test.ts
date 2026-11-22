/**
 * Thema 5A / T3 mit echter Infrastruktur (THEMA5A_REAL_INFRA=1):
 * dieselbe Frage wie t3-freigabe-ausgabepunkt.test.ts, aber ohne gemockte SQL-Ebene.
 * PostgreSQL enthält sechs echte Q&A-Fragen (Sechs-Fragen-Szenario #456 §12) von sechs
 * Teilnehmenden; die Teilnehmeransicht nutzt eine echte Participant-Capability
 * (rejoinCapabilityHash), die Beamer-Projektion wird ohne jede Zugangsangabe aufgerufen.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MODERATION_PROMPT_REFERENCE_TEXT_FIXTURE_V1 } from '@arsnova/shared-types';
import { prisma } from '../../db';
import { hashCapability } from '../../lib/capabilityCrypto';
import { clearAllQaPresenterSortModes } from '../../lib/qaPresenterSortMode';
import { qaRouter, resetSharedQaRankingCacheForTests } from '../../routers/qa';
import { sessionRouter } from '../../routers/session';
import { baseSession, outcomeOf, writeEvidence, type FakeSession } from './fakes';
import { REAL_INFRA, createWorld, type WorldEnv } from './world';

const SESSION = { id: '5a000000-0000-4000-8000-0000000000e3', code: 'BEAM5A' };
const READER_ID = '5a000000-0000-4000-8000-0000000000e4';
const NICKNAMES = ['Mia', 'Jonas', 'Lea', 'Ben', 'Emma', 'Noah'];
const world = createWorld({ db: null, redis: null, pairing: null } satisfies WorldEnv);
const readerCapability = randomBytes(32).toString('base64url');

const states: Array<{ id: string; label: string; patch: Partial<FakeSession> }> = [
  { id: 'F1', label: 'Kanal offen (Referenz)', patch: {} },
  { id: 'F2', label: 'Host schließt den Q&A-Kanal (qaOpen=false)', patch: { qaOpen: false } },
  {
    id: 'F3',
    label: 'Deadline abgelaufen (qaClosesAt in der Vergangenheit)',
    patch: { qaClosesAt: new Date(Date.now() - 60 * 1000) },
  },
  { id: 'F4', label: 'Q&A-Kanal deaktiviert (qaEnabled=false)', patch: { qaEnabled: false } },
  {
    id: 'F5',
    label: 'anonymer Modus aktiv (Kanal offen)',
    patch: { onboardingAnonymousMode: true },
  },
];

async function seed() {
  await world.reset([
    baseSession({ ...SESSION, type: 'QUIZ', qaRankingRevision: 3, qaQuestionCount: 6 }),
  ]);
  await prisma.participant.create({
    data: {
      id: READER_ID,
      sessionId: SESSION.id,
      nickname: 'Leser',
      rejoinCapabilityHash: hashCapability(readerCapability),
    },
  });
  for (const [index, entry] of MODERATION_PROMPT_REFERENCE_TEXT_FIXTURE_V1.entries()) {
    const participant = await prisma.participant.create({
      data: { sessionId: SESSION.id, nickname: NICKNAMES[index]! },
    });
    await prisma.qaQuestion.create({
      data: {
        sessionId: SESSION.id,
        participantId: participant.id,
        text: entry.text,
        status: index === 0 ? 'PINNED' : 'ACTIVE',
        upvoteCount: 10,
        positiveVoteCount: 10,
      },
    });
  }
}

const records: Array<Record<string, unknown>> = [];

function ctx(headers: Record<string, string>) {
  return { req: { headers } as unknown as IncomingMessage };
}

describe.skipIf(!REAL_INFRA)(
  'Thema 5A / T3 – echte Datenbank: Teilnehmeransicht vs. Beamer',
  () => {
    beforeEach(() => {
      resetSharedQaRankingCacheForTests();
      clearAllQaPresenterSortModes();
    });

    afterAll(() => writeEvidence('t3-freigabe-ausgabepunkt', records));

    it('W Weg zur Beamer-Anzeige: Session-Code → öffentliche Session-Info → sessionId', async () => {
      await seed();
      let outcome = 'OK';
      let sessionId: string | null = null;
      try {
        const info = await sessionRouter.createCaller(ctx({})).getInfo({ code: SESSION.code });
        sessionId = info.id;
      } catch (error) {
        outcome = outcomeOf(error);
      }
      records.push({
        state: 'W session.getInfo ohne Zugangsdaten',
        outcome,
        sessionIdMatches: sessionId === SESSION.id,
      });
      expect(sessionId).toBe(SESSION.id);
    });

    for (const state of states) {
      it(`${state.id} ${state.label}`, async () => {
        await seed();
        if (Object.keys(state.patch).length > 0) await world.updateSession(SESSION.id, state.patch);

        let participant:
          { state: string; questions: number; nicknames: number } | { error: string };
        try {
          const list = await qaRouter
            .createCaller(ctx({ 'x-participant-capability': readerCapability }))
            .list({ sessionId: SESSION.id, participantId: READER_ID });
          participant = {
            state: list.state,
            questions: list.questions.length,
            nicknames: list.questions.filter((question) => question.authorNickname).length,
          };
        } catch (error) {
          participant = { error: outcomeOf(error) };
        }

        let presenter: { state: string; questions: number; nicknames: number } | { error: string };
        try {
          const projection = await qaRouter
            .createCaller(ctx({}))
            .presentProjection({ sessionId: SESSION.id });
          presenter = {
            state: projection.state,
            questions: projection.questions.length,
            nicknames: projection.questions.filter((question) => question.authorNickname).length,
          };
        } catch (error) {
          presenter = { error: outcomeOf(error) };
        }

        const participantQuestions = 'questions' in participant ? participant.questions : 0;
        const presenterQuestions = 'questions' in presenter ? presenter.questions : 0;
        records.push({
          state: `${state.id} ${state.label}`,
          participantView: participant,
          presenterViewWithoutAnyCredential: presenter,
          divergent: participantQuestions !== presenterQuestions,
        });

        if (state.id === 'F1') {
          expect(participantQuestions).toBe(6);
          expect(presenterQuestions).toBe(6);
        }
        if (state.id === 'F2' || state.id === 'F3') {
          expect(participantQuestions).toBe(0);
          expect(presenterQuestions).toBe(6);
        }
        if (state.id === 'F4') {
          expect(participantQuestions).toBe(0);
          expect(presenterQuestions).toBe(0);
        }
        if (state.id === 'F5' && 'nicknames' in presenter) {
          expect(presenter.nicknames).toBe(0);
        }
      });
    }
  },
);
