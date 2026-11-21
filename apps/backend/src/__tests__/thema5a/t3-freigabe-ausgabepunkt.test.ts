/**
 * Thema 5A / T3 – Freigabeänderung am Ausgabepunkt „Ergebnisanzeige“.
 *
 * Frage: Wirkt das Schließen des Q&A-Kanals bzw. der Ablauf der Deadline an
 * ALLEN Ausgabepunkten gleich? Verglichen werden
 *   - qa.list (Teilnehmeransicht, Participant-Capability nötig) und
 *   - qa.presentProjection (Presenter/Beamer, öffentliche Prozedur ohne Token).
 * Gezählt werden ausgelieferte Fragen und Autor-Nicknames. Die DB-Zeilen sind
 * Fixtures (Sechs-Fragen-Szenario #456 §12, ACTIVE/PINNED), die SQL-Ebene ist gemockt.
 */
import type { IncomingMessage } from 'node:http';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODERATION_PROMPT_REFERENCE_TEXT_FIXTURE_V1 } from '@arsnova/shared-types';
import { outcomeOf, writeEvidence } from './fakes';

const { prismaMock, participantAuth } = vi.hoisted(() => ({
  prismaMock: {
    session: { findUnique: vi.fn() },
    participant: { count: vi.fn() },
    qaQuestion: {
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
    qaUpvote: { findMany: vi.fn(), groupBy: vi.fn() },
    sessionLearningObjectiveReference: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
  participantAuth: { assertParticipantCapability: vi.fn() },
}));

vi.mock('../../db', () => ({ prisma: prismaMock }));
vi.mock('../../lib/participantAuth', () => ({
  assertParticipantCapability: participantAuth.assertParticipantCapability,
}));

import { clearAllQaPresenterSortModes } from '../../lib/qaPresenterSortMode';
import { qaRouter, resetSharedQaRankingCacheForTests } from '../../routers/qa';

const SESSION_ID = '5a000000-0000-4000-8000-0000000000e3';
const PARTICIPANT_ID = '5a000000-0000-4000-8000-0000000000e4';
const NICKNAMES = ['Mia', 'Jonas', 'Lea', 'Ben', 'Emma', 'Noah'];

function fixtureRows() {
  // Sechs-Fragen-Szenario aus #456 §12 (Fragen A–F).
  return MODERATION_PROMPT_REFERENCE_TEXT_FIXTURE_V1.map((entry, index) => ({
    id: `5a000000-0000-4000-8000-0000000001${index}0`,
    participantId: `5a000000-0000-4000-8000-0000000002${index}0`,
    text: entry.text,
    upvoteCount: 10,
    status: index === 0 ? 'PINNED' : 'ACTIVE',
    createdAt: new Date('2026-11-20T10:00:00.000Z'),
    authorNickname: NICKNAMES[index]!,
    authorTeamName: null,
    myVote: null,
    positiveVoteCount: 10,
    negativeVoteCount: 0,
    bestScore: 0.5,
    controversyScore: 0,
    totalCount: 6,
  }));
}

function session(overrides: Record<string, unknown>) {
  return {
    id: SESSION_ID,
    code: 'BEAM5A',
    status: 'ACTIVE',
    endedAt: null,
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    type: 'QUIZ',
    qaEnabled: true,
    qaOpen: true,
    qaClosesAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    sessionLifecycleRevision: 1,
    qaRankingRevision: 3,
    qaQuestionCount: 6,
    qaModerationMode: false,
    onboardingAnonymousMode: false,
    ...overrides,
  };
}

const states = [
  { id: 'F1', label: 'Kanal offen (Referenz)', overrides: {} },
  { id: 'F2', label: 'Host schließt den Q&A-Kanal (qaOpen=false)', overrides: { qaOpen: false } },
  {
    id: 'F3',
    label: 'Deadline abgelaufen (qaClosesAt in der Vergangenheit)',
    overrides: { qaClosesAt: new Date(Date.now() - 60 * 1000) },
  },
  { id: 'F4', label: 'Q&A-Kanal deaktiviert (qaEnabled=false)', overrides: { qaEnabled: false } },
  {
    id: 'F5',
    label: 'anonymer Modus aktiv (Kanal offen)',
    overrides: { onboardingAnonymousMode: true },
  },
];

const records: Array<Record<string, unknown>> = [];

function anonymousCtx() {
  return { req: { headers: {} } as IncomingMessage };
}

describe('Thema 5A / T3 – Freigabegrenze an Teilnehmer- und Presenter-Ausgabe', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetSharedQaRankingCacheForTests();
    clearAllQaPresenterSortModes();
    participantAuth.assertParticipantCapability.mockResolvedValue(undefined);
    prismaMock.participant.count.mockResolvedValue(40);
    prismaMock.qaQuestion.count.mockResolvedValue(6);
    prismaMock.qaQuestion.findMany.mockResolvedValue([]);
    prismaMock.qaQuestion.groupBy.mockResolvedValue([]);
    prismaMock.qaQuestion.aggregate.mockResolvedValue({
      _count: { _all: 6 },
      _max: { updatedAt: null },
      _sum: { upvoteCount: 60 },
    });
    prismaMock.qaUpvote.findMany.mockResolvedValue([]);
    prismaMock.qaUpvote.groupBy.mockResolvedValue([]);
    prismaMock.sessionLearningObjectiveReference.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockImplementation(async () => fixtureRows());
  });

  afterAll(() => writeEvidence('t3-freigabe-ausgabepunkt', records));

  for (const state of states) {
    it(`${state.id} ${state.label}`, async () => {
      prismaMock.session.findUnique.mockResolvedValue(session(state.overrides));
      const caller = qaRouter.createCaller(anonymousCtx());

      let participant: { state: string; questions: number; nicknames: number } | { error: string };
      try {
        const list = await caller.list({ sessionId: SESSION_ID, participantId: PARTICIPANT_ID });
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
        const projection = await caller.presentProjection({ sessionId: SESSION_ID });
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
        // Ist-Befund: Teilnehmeransicht leer, öffentliche Projektion liefert weiter Inhalte.
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
});
