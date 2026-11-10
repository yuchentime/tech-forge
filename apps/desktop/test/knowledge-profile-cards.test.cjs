const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapKnowledgeCards,
  masteryPriority,
} = require('../dist-electron/src/features/knowledge-profile/knowledge-profile-cards.js');

/** Builds one collection row with the published fields the card grid consumes. */
function factItem(overrides = {}) {
  return {
    conversationId: '11111111-1111-4111-8111-111111111111',
    summary: '已生成的评估摘要。',
    tags: ['力学'],
    masteryLevel: 'basic',
    generationStatus: 'completed',
    lastError: null,
    generatedAt: '2026-11-10T08:00:00.000Z',
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...overrides,
  };
}

test('a published fact with null overall mastery still becomes a card', () => {
  const cards = mapKnowledgeCards(
    [factItem({ masteryLevel: null, summary: '整体证据不足，但已有摘要。' })],
    [{ id: '11111111-1111-4111-8111-111111111111', title: '系统思考' }],
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].masteryLevel, null);
  assert.equal(cards[0].conversationTitle, '系统思考');
  assert.equal(cards[0].summary, '整体证据不足，但已有摘要。');
});

test('pre-publication rows stay hidden while failed rows with old content remain', () => {
  const cards = mapKnowledgeCards(
    [
      factItem({ generatedAt: null, summary: null, tags: null, masteryLevel: null }),
      factItem({
        conversationId: '22222222-2222-4222-8222-222222222222',
        generationStatus: 'failed',
        lastError: '生成超时，已保留上次结果。',
      }),
    ],
    [],
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].conversationId, '22222222-2222-4222-8222-222222222222');
});

test('cards sort weak, insufficient, basic, proficient then newest first', () => {
  const cards = mapKnowledgeCards(
    [
      factItem({ conversationId: 'a', masteryLevel: 'proficient', updatedAt: '2026-11-10T09:00:00.000Z' }),
      factItem({ conversationId: 'b', masteryLevel: 'basic', updatedAt: '2026-11-10T09:00:00.000Z' }),
      factItem({ conversationId: 'c', masteryLevel: null, updatedAt: '2026-11-10T09:00:00.000Z' }),
      factItem({ conversationId: 'd', masteryLevel: 'needs_improvement', updatedAt: '2026-11-10T08:00:00.000Z' }),
      factItem({ conversationId: 'e', masteryLevel: 'needs_improvement', updatedAt: '2026-11-10T09:00:00.000Z' }),
    ],
    [],
  );
  assert.deepEqual(
    cards.map((card) => card.conversationId),
    ['e', 'd', 'c', 'b', 'a'],
  );
  assert.deepEqual(
    [masteryPriority('needs_improvement'), masteryPriority(null), masteryPriority('basic'), masteryPriority('proficient')],
    [0, 1, 2, 3],
  );
});
