const assert = require('node:assert/strict');
const test = require('node:test');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const {
  ChatService,
  getPiMessageStatus,
} = require('../dist/chat/chat.service.js');
const { ChatPromptDto } = require('../dist/chat/dto/chat-prompt.dto.js');
const { encodeChatSseEvent } = require('../dist/chat/chat-sse.js');
const {
  LlmService,
  LlmResponseTruncatedError,
} = require('../dist/llm/llm.service.js');

/** Minimal long-term memory double; the chat suite does not exercise storage. */
const memoryStub = {
  buildChatContext: async () => '',
  captureUserMessage: () => {},
};

/** Collects every value from an async generator for one local test assertion. */
async function collect(generator) {
  const values = [];
  for await (const value of generator) values.push(value);
  return values;
}

test('ChatService delegates the prompt and request signal to the configured model', async () => {
  const signal = new AbortController().signal;
  const calls = [];
  const piEvents = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'knowledge_search',
      args: { query: '缓存雪崩' },
    },
    {
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'knowledge_search',
      args: { query: '缓存雪崩' },
      partialResult: { chunks: ['must stay private'] },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'knowledge_search',
      result: { chunks: ['must stay private'] },
      isError: false,
      durationMs: 24,
    },
    {
      type: 'turn_end',
      message: { content: 'must stay private' },
      toolResults: [{ content: 'must stay private' }],
    },
    {
      type: 'message_update',
      message: { content: 'must stay private' },
      assistantMessageEvent: { type: 'text_delta', delta: '第一段' },
    },
    {
      type: 'message_update',
      message: { content: 'private reasoning' },
      assistantMessageEvent: { type: 'thinking_delta', delta: 'private reasoning' },
    },
    { type: 'agent_end', messages: [{ content: 'must stay private' }] },
  ];
  const llm = {
    stream(prompt, options) {
      calls.push({ prompt, options });
      return (async function* () {
        yield* piEvents;
      })();
    },
  };

  const conversations = {
    beginTurn: async () => ({
      history: [],
      userMessageId: 'user-1',
      assistantTurnId: 'turn-1',
      loadedChunkIds: [],
      attachedDocuments: [],
    }),
    mergeUserMessageContextRefs: async () => undefined,
    startToolExecution: async () => 'tool-row-1',
    updateToolExecution: async () => undefined,
    finishTurn: async () => undefined,
  };
  const rehearsals = {
    buildConversationDigest: async () => ({
      text: '',
      refsJson: null,
      rehearsalIds: [],
    }),
    markDigestDelivered: async () => undefined,
  };
  const service = new ChatService(
    llm,
    conversations,
    undefined,
    undefined,
    undefined,
    rehearsals,
    memoryStub,
  );
  assert.deepEqual(
    await collect(
      service.stream(
        '讲解缓存雪崩',
        '11111111-1111-4111-8111-111111111111',
        signal,
      ),
    ),
    [
    { type: 'conversation', conversationId: '11111111-1111-4111-8111-111111111111' },
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'knowledge_search',
      args: { query: '缓存雪崩' },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'knowledge_search',
      isError: false,
      durationMs: 24,
    },
    { type: 'turn_end' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '第一段' },
    },
    { type: 'agent_end' },
    ],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, '讲解缓存雪崩');
  assert.equal(calls[0].options.signal, signal);
  assert.equal(
    calls[0].options.conversation.id,
    '11111111-1111-4111-8111-111111111111',
  );
});

test('deep research forces knowledge retrieval and loads the bundled skill', async () => {
  const streamOptions = [];
  const knowledgeCalls = [];
  const llm = {
    stream(prompt, options) {
      streamOptions.push({ prompt, options });
      return (async function* () {})();
    },
  };
  const conversations = {
    beginTurn: async () => ({
      history: [],
      userMessageId: 'user-1',
      assistantTurnId: 'turn-1',
      loadedChunkIds: [],
      attachedDocuments: [],
    }),
    mergeUserMessageContextRefs: async () => undefined,
    getKnowledgeScope: async () => ({ documentIds: [] }),
    finishTurn: async () => undefined,
  };
  const knowledge = {
    loadForAgent: async () => {
      knowledgeCalls.push('load');
      return {
        text: '## 资料库检索结果\n\n### 片段 1（资料：生物讲义；页码：1）\n光合作用',
        revision: 'revision-1',
      };
    },
    renderLoadedContext: (context) => context.text,
  };
  const rehearsals = {
    buildConversationDigest: async () => ({
      text: '',
      refsJson: null,
      rehearsalIds: [],
    }),
    markDigestDelivered: async () => undefined,
  };
  const service = new ChatService(
    llm,
    conversations,
    knowledge,
    undefined,
    undefined,
    rehearsals,
    memoryStub,
  );

  await collect(
    service.stream(
      '/探索主题 光合作用',
      '11111111-1111-4111-8111-111111111111',
      new AbortController().signal,
    ),
  );

  assert.equal(knowledgeCalls.length, 1);
  assert.deepEqual(knowledgeCalls, ['load']);
  assert.equal(streamOptions.length, 1);
  // The stored message and snapshot keep the user's topic; the skill is only in the model prompt.
  assert.equal(streamOptions[0].prompt, '光合作用');
  assert.equal(streamOptions[0].options.skillName, 'deep-research');
  assert.equal(streamOptions[0].options.promptContext, undefined);
  const knowledgeMessage = streamOptions[0].options.contextMessages.find(
    (message) => message.type === 'knowledge_index',
  );
  assert.match(knowledgeMessage.text, /## 资料库检索结果/);
});

test('a plain turn does not retrieve knowledge or load a skill', async () => {
  const streamOptions = [];
  let knowledgeCalls = 0;
  const llm = {
    stream(prompt, options) {
      streamOptions.push({ prompt, options });
      return (async function* () {})();
    },
  };
  const conversations = {
    beginTurn: async () => ({
      history: [],
      userMessageId: 'user-1',
      assistantTurnId: 'turn-1',
      loadedChunkIds: [],
      attachedDocuments: [],
    }),
    mergeUserMessageContextRefs: async () => undefined,
    finishTurn: async () => undefined,
  };
  const knowledge = {
    loadForAgent: async () => {
      knowledgeCalls += 1;
      throw new Error('must not load the directory without a command');
    },
    renderLoadedContext: () => '',
  };
  const rehearsals = {
    buildConversationDigest: async () => ({
      text: '',
      refsJson: null,
      rehearsalIds: [],
    }),
    markDigestDelivered: async () => undefined,
  };
  const service = new ChatService(
    llm,
    conversations,
    knowledge,
    undefined,
    undefined,
    rehearsals,
    memoryStub,
  );

  await collect(
    service.stream(
      '光合作用是什么',
      '11111111-1111-4111-8111-111111111111',
      new AbortController().signal,
    ),
  );

  assert.equal(knowledgeCalls, 0);
  assert.equal(streamOptions[0].prompt, '光合作用是什么');
  assert.equal(streamOptions[0].options.skillName, undefined);
});

test('ChatPromptDto trims input and counts Unicode characters', async () => {
  const valid = plainToInstance(ChatPromptDto, { prompt: '  备课问题  ' });
  assert.equal(valid.prompt, '备课问题');
  assert.deepEqual(await validate(valid), []);

  const maxLength = plainToInstance(ChatPromptDto, {
    prompt: '😀'.repeat(10_000),
  });
  assert.deepEqual(await validate(maxLength), []);

  const tooLong = plainToInstance(ChatPromptDto, {
    prompt: '😀'.repeat(10_001),
  });
  assert.ok((await validate(tooLong)).some((error) => error.property === 'prompt'));

  const blank = plainToInstance(ChatPromptDto, { prompt: '  \n ' });
  assert.ok((await validate(blank)).some((error) => error.property === 'prompt'));
});

test('SSE encoder preserves Pi event names and JSON-escapes text deltas', () => {
  assert.equal(
    encodeChatSseEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '一行\n二行' },
    }),
    'event: message_update\ndata: {"assistantMessageEvent":{"type":"text_delta","delta":"一行\\n二行"}}\n\n',
  );
  assert.equal(
    encodeChatSseEvent({ type: 'done', finishReason: 'stop' }),
    'event: done\ndata: {"finishReason":"stop"}\n\n',
  );
});

test('LlmService queues Pi session events in subscription order', async () => {
  const received = [];
  const session = {
    subscribe(callback) {
      received.push(callback);
      return () => undefined;
    },
    prompt() {
      received[0]({ type: 'turn_start' });
      received[0]({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'search',
        args: { query: 'q' },
      });
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
    dispose() {},
    messages: [],
    getLastAssistantText() {
      return '回答';
    },
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
  };
  const service = new LlmService(
    {},
    {
      getLlmSettings: async () => ({
        deepseek: { apiKey: 'test', modelId: 'deepseek-flash' },
      }),
    },
    {},
  );
  service.createSession = async () => session;

  assert.deepEqual(await collect(service.stream('prompt')), [
    { type: 'turn_start' },
    {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'q' },
    },
  ]);
});

test('LlmService aborts the Pi session and removes its listener on cancellation', async () => {
  let listener;
  let finishRun;
  let abortCalled = false;
  let unsubscribeCalled = false;
  let disposeCalled = false;
  const session = {
    subscribe(callback) {
      listener = callback;
      return () => {
        unsubscribeCalled = true;
      };
    },
    prompt() {
      listener({ type: 'agent_start' });
      return new Promise((resolve) => {
        finishRun = resolve;
      });
    },
    abort() {
      abortCalled = true;
      finishRun?.();
      return Promise.resolve();
    },
    dispose() {
      disposeCalled = true;
    },
    messages: [],
    getLastAssistantText() {
      return '部分回答';
    },
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
  };
  const service = new LlmService(
    {},
    {
      getLlmSettings: async () => ({
        deepseek: { apiKey: 'test', modelId: 'deepseek-flash' },
      }),
    },
    {},
  );
  service.createSession = async () => session;
  const controller = new AbortController();
  const iterator = service.stream('prompt', { signal: controller.signal });

  assert.deepEqual(await iterator.next(), {
    value: { type: 'agent_start' },
    done: false,
  });
  controller.abort();
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(abortCalled, true);
  assert.equal(unsubscribeCalled, true);
  assert.equal(disposeCalled, true);
});

test('durable context is appended as its own Pi message entry before prompting', async () => {
  const calls = [];
  const session = {
    subscribe() {
      return () => undefined;
    },
    prompt(prompt) {
      calls.push(['prompt', prompt]);
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
    dispose() {},
    messages: [],
    getLastAssistantText() {
      return '回答';
    },
    getContextUsage: () => undefined,
    sessionManager: {
      getEntries: () => [],
      appendCustomMessageEntry(type, content, display) {
        calls.push(['append', type, content, display]);
        return 'entry-1';
      },
    },
  };
  const service = new LlmService(
    {},
    {
      getLlmSettings: async () => ({
        deepseek: { apiKey: 'test', modelId: 'deepseek-flash' },
      }),
    },
    {},
  );
  service.createSession = async () => session;

  await collect(service.stream('问题'));
  await collect(
    service.stream('问题', {
      contextMessage: {
        type: 'rehearsal_digest',
        text: '## 此前的演练记录\n背景',
      },
    }),
  );

  assert.deepEqual(calls, [
    ['prompt', '问题'],
    ['append', 'rehearsal_digest', '## 此前的演练记录\n背景', false],
    ['prompt', '问题'],
  ]);
});

test('a requested skill becomes the first token of the model prompt', async () => {
  const calls = [];
  const session = {
    subscribe() {
      return () => undefined;
    },
    prompt(prompt, options) {
      calls.push([prompt, options]);
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
    dispose() {},
    messages: [],
    getLastAssistantText() {
      return '回答';
    },
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
  };
  const service = new LlmService(
    {},
    {
      getLlmSettings: async () => ({
        deepseek: { apiKey: 'test', modelId: 'deepseek-flash' },
      }),
    },
    {},
  );
  service.createSession = async () => session;

  await collect(
    service.stream('光合作用', {
      skillName: 'deep-research',
      promptContext: '## 资料库检索结果\n证据',
    }),
  );

  assert.deepEqual(calls, [
    [
      '/skill:deep-research ## 资料库检索结果\n证据\n\n## 用户输入\n光合作用',
      { expandPromptTemplates: true },
    ],
  ]);
});

test('ChatService hands the rehearsal digest over once and marks it delivered', async () => {
  const options = [];
  const marked = [];
  const refs = [];
  const llm = {
    stream(prompt, streamOptions) {
      options.push(streamOptions);
      return (async function* () {})();
    },
  };
  const conversations = {
    beginTurn: async () => ({
      history: [],
      userMessageId: 'user-1',
      assistantTurnId: 'turn-1',
      loadedChunkIds: [],
      attachedDocuments: [],
    }),
    mergeUserMessageContextRefs: async (messageId, refsJson) => {
      refs.push([messageId, JSON.parse(refsJson)]);
    },
    startToolExecution: async () => 'tool-row-1',
    updateToolExecution: async () => undefined,
    finishTurn: async () => undefined,
  };
  const rehearsals = {
    buildConversationDigest: async () => ({
      text: '## 此前的演练记录\n薄弱点：MECE',
      refsJson: '{"rehearsals":{"rehearsalIds":["rehearsal-1"],"characters":24}}',
      rehearsalIds: ['rehearsal-1'],
    }),
    markDigestDelivered: async (rehearsalIds) => {
      marked.push(...rehearsalIds);
    },
  };
  const service = new ChatService(
    llm,
    conversations,
    undefined,
    undefined,
    undefined,
    rehearsals,
    memoryStub,
  );

  await collect(
    service.stream(
      '我哪里薄弱',
      '11111111-1111-4111-8111-111111111111',
      new AbortController().signal,
    ),
  );

  assert.equal(options.length, 1);
  // The digest travels as durable context, not as per-turn text that the snapshot would strip.
  assert.deepEqual(options[0].contextMessages, [
    { type: 'rehearsal_digest', text: '## 此前的演练记录\n薄弱点：MECE' },
  ]);
  assert.equal(options[0].promptContext, undefined);
  assert.deepEqual(marked, ['rehearsal-1']);
  assert.deepEqual(refs, [
    [
      'user-1',
      { rehearsals: { rehearsalIds: ['rehearsal-1'], characters: 24 } },
    ],
  ]);
});

test('an output-limit stop is reported as truncation, not as an empty completion', async () => {
  let listener;
  const session = {
    subscribe(callback) {
      listener = callback;
      return () => undefined;
    },
    prompt() {
      listener({ type: 'message_end', message: thinkingOnlyMessage('length') });
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
    dispose() {},
    messages: [thinkingOnlyMessage('length')],
    getLastAssistantText() {
      return undefined;
    },
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
  };
  const service = createLlmService();
  service.createSession = async () => session;

  await assert.rejects(collect(service.stream('画一张逻辑思考知识地图')), (error) => {
    assert.ok(error instanceof LlmResponseTruncatedError);
    return true;
  });
});

test('an aborted thinking-only turn does not break the next turn', async () => {
  let abortedListener;
  const abortedSession = {
    subscribe(callback) {
      abortedListener = callback;
      return () => undefined;
    },
    prompt() {
      abortedListener({ type: 'message_end', message: thinkingOnlyMessage('aborted') });
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
    dispose() {},
    messages: [thinkingOnlyMessage('aborted')],
    getLastAssistantText() {
      return undefined;
    },
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
  };
  const answeredSession = {
    subscribe() {
      return () => undefined;
    },
    prompt() {
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
    dispose() {},
    messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '回答' }] }],
    getLastAssistantText() {
      return '回答';
    },
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
  };
  const sessions = [abortedSession, answeredSession];
  const service = createLlmService();
  service.createSession = async () => sessions.shift();

  assert.deepEqual(await collect(service.stream('确认')), [
    { type: 'message_end', message: thinkingOnlyMessage('aborted') },
  ]);
  assert.deepEqual(await collect(service.stream('A')), []);
});

test('ChatService stores an aborted assistant row as a cancelled turn', async () => {
  const statuses = [];
  const finishes = [];
  const llm = {
    stream(_prompt, options) {
      return (async function* () {
        const messageEnd = { type: 'message_end', message: thinkingOnlyMessage('aborted') };
        await options.persistConversationEvent(messageEnd);
        yield messageEnd;
      })();
    },
  };
  const conversations = {
    beginTurn: async () => ({
      history: [],
      userMessageId: 'user-1',
      assistantTurnId: 'turn-1',
      loadedChunkIds: [],
      attachedDocuments: [],
    }),
    mergeUserMessageContextRefs: async () => undefined,
    startPiMessage: async () => 'message-1',
    updatePiMessage: async (_conversationId, _messageId, _message, status) => {
      statuses.push(status);
    },
    startToolExecution: async () => 'tool-row-1',
    updateToolExecution: async () => undefined,
    finishTurn: async (_conversationId, _turnId, status) => {
      finishes.push(status);
    },
  };
  const rehearsals = {
    buildConversationDigest: async () => ({ text: '', refsJson: null, rehearsalIds: [] }),
    markDigestDelivered: async () => undefined,
  };
  const service = new ChatService(
    llm,
    conversations,
    undefined,
    undefined,
    undefined,
    rehearsals,
    memoryStub,
  );

  await collect(
    service.stream(
      '确认',
      '11111111-1111-4111-8111-111111111111',
      new AbortController().signal,
    ),
  );

  assert.deepEqual(statuses, ['cancelled']);
  assert.deepEqual(finishes, ['cancelled']);
});

test('truncated assistant rows are stored as failed', () => {
  assert.equal(getPiMessageStatus({ role: 'assistant', stopReason: 'length' }), 'failed');
  assert.equal(getPiMessageStatus({ role: 'assistant', stopReason: 'aborted' }), 'cancelled');
  assert.equal(getPiMessageStatus({ role: 'assistant', stopReason: 'stop' }), 'completed');
  assert.equal(getPiMessageStatus({ role: 'toolResult' }), 'completed');
});

/** Builds the thinking-only assistant message that reasoning models emit on abort or truncation. */
function thinkingOnlyMessage(stopReason) {
  return {
    role: 'assistant',
    stopReason,
    content: [{ type: 'thinking', thinking: '规划 SVG 布局' }],
  };
}

/** Builds an LlmService whose Pi session creation is replaced per test. */
function createLlmService() {
  return new LlmService(
    {},
    {
      getLlmSettings: async () => ({
        deepseek: { apiKey: 'test', modelId: 'deepseek-flash' },
      }),
    },
    {},
  );
}
