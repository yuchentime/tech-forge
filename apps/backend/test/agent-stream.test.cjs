const assert = require('node:assert/strict');
const test = require('node:test');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { AgentService } = require('../dist/agent/agent.service.js');
const { AgentPromptDto } = require('../dist/agent/dto/agent-prompt.dto.js');
const { encodeAgentSseEvent } = require('../dist/agent/sse.js');
const { LlmService } = require('../dist/llm/llm.service.js');

/** Collects every value from an async generator for one local test assertion. */
async function collect(generator) {
  const values = [];
  for await (const value of generator) values.push(value);
  return values;
}

test('AgentService delegates the prompt and request signal to the configured model', async () => {
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

  const service = new AgentService(llm);
  assert.deepEqual(await collect(service.stream('讲解缓存雪崩', signal)), [
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
  ]);
  assert.deepEqual(calls, [
    {
      prompt: '讲解缓存雪崩',
      options: { providerId: 'deepseek', modelId: 'deepseek-chat', signal },
    },
  ]);
});

test('AgentPromptDto trims input and counts Unicode characters', async () => {
  const valid = plainToInstance(AgentPromptDto, { prompt: '  备课问题  ' });
  assert.equal(valid.prompt, '备课问题');
  assert.deepEqual(await validate(valid), []);

  const maxLength = plainToInstance(AgentPromptDto, {
    prompt: '😀'.repeat(10_000),
  });
  assert.deepEqual(await validate(maxLength), []);

  const tooLong = plainToInstance(AgentPromptDto, {
    prompt: '😀'.repeat(10_001),
  });
  assert.ok((await validate(tooLong)).some((error) => error.property === 'prompt'));

  const blank = plainToInstance(AgentPromptDto, { prompt: '  \n ' });
  assert.ok((await validate(blank)).some((error) => error.property === 'prompt'));
});

test('SSE encoder preserves Pi event names and JSON-escapes text deltas', () => {
  assert.equal(
    encodeAgentSseEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '一行\n二行' },
    }),
    'event: message_update\ndata: {"assistantMessageEvent":{"type":"text_delta","delta":"一行\\n二行"}}\n\n',
  );
  assert.equal(
    encodeAgentSseEvent({ type: 'done', finishReason: 'stop' }),
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
    getLastAssistantText() {
      return '回答';
    },
  };
  const service = new LlmService({}, {});
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
    getLastAssistantText() {
      return '部分回答';
    },
  };
  const service = new LlmService({}, {});
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
