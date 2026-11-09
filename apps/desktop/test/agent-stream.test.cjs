const assert = require('node:assert/strict');
const test = require('node:test');
const { SseParser } = require('../dist-electron/electron/main/sse-parser.js');
const { decodeChatSseMessage } = require('../dist-electron/electron/main/stream-protocol.js');
const { routeChatStreamEvent } = require('../dist-electron/electron/main/stream-routing.js');
const { isChatStreamEvent } = require('../dist-electron/src/types/chat-stream-event.js');
const { AgentEventBus } = require('../dist-electron/src/features/agent/agent-event-bus.js');
const { agentChatAdapter } = require('../dist-electron/src/features/agent/agent-chat-adapter.js');

test('SSE parser preserves frames across CRLF and text chunk boundaries', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed('event: message_update\r'), []);
  assert.deepEqual(parser.feed('\ndata: {"assistantMessageEvent":{"type":"text_delta","delta":"hello"}}\r\n\r'), []);
  assert.deepEqual(parser.feed('\n'), [
    {
      event: 'message_update',
      data: '{"assistantMessageEvent":{"type":"text_delta","delta":"hello"}}',
    },
  ]);
});

test('UTF-8 decoder and SSE parser preserve a character split across byte chunks', () => {
  const frame = 'event: message_update\r\ndata: {"assistantMessageEvent":{"type":"text_delta","delta":"备课进行中"}}\r\n\r\n';
  const bytes = new TextEncoder().encode(frame);
  const prefixLength = new TextEncoder().encode('event: message_update\r\ndata: {"assistantMessageEvent":{"type":"text_delta","delta":"').length;
  const splitAt = prefixLength + 1;
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const first = parser.feed(decoder.decode(bytes.slice(0, splitAt), { stream: true }));
  const secondText = decoder.decode(bytes.slice(splitAt), { stream: true }) + decoder.decode();
  const second = parser.feed(secondText);

  assert.deepEqual(first, []);
  assert.deepEqual(second, [
    {
      event: 'message_update',
      data: '{"assistantMessageEvent":{"type":"text_delta","delta":"备课进行中"}}',
    },
  ]);
  assert.deepEqual(
    decodeChatSseMessage(second[0]),
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '备课进行中' },
    },
  );
});

test('Agent SSE protocol rejects unknown events and malformed payloads', () => {
  assert.equal(
    decodeChatSseMessage({ event: 'message_update', data: '{bad json' }),
    undefined,
  );
  assert.equal(
    decodeChatSseMessage({ event: 'tool_call', data: '{"name":"subagent"}' }),
    undefined,
  );
  assert.deepEqual(
    decodeChatSseMessage({ event: 'error', data: '{"message":"network"}' }),
    { type: 'error', message: 'network' },
  );
  assert.equal(
    decodeChatSseMessage({
      event: 'tool_execution_end',
      data: '{"toolCallId":"tool-1","toolName":"search","isError":false,"result":{"secret":"no"}}',
    }),
    undefined,
  );
  assert.deepEqual(
    decodeChatSseMessage({
      event: 'tool_execution_start',
      data: '{"toolCallId":"tool-1","toolName":"search","args":{"query":"q"}}',
    }),
    {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'q' },
    },
  );
});

test('bridge event validator accepts only exact, safe Pi event projections', () => {
  assert.equal(
    isChatStreamEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'x' },
      message: { hidden: true },
    }),
    false,
  );
  assert.equal(
    isChatStreamEvent({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'q' },
    }),
    true,
  );
});

test('SSE parser rejects oversized complete frames', () => {
  const parser = new SseParser();
  assert.throws(
    () => parser.feed(`data: ${'x'.repeat(1_048_576)}\n\n`),
    /SSE frame exceeded the allowed size/,
  );
});

test('request IDs route stream events to only their own MessagePort', () => {
  const firstEvents = [];
  const secondEvents = [];
  const streams = new Map([
    ['chat-1-1', { port: { postMessage: (event) => firstEvents.push(event) } }],
    ['chat-1-2', { port: { postMessage: (event) => secondEvents.push(event) } }],
  ]);

  assert.equal(
    routeChatStreamEvent(streams, 'chat-1-2', {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: '第二条' },
    }),
    true,
  );
  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, [
    {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: '第二条' },
    },
  ]);
  assert.equal(
    routeChatStreamEvent(streams, 'chat-missing-1', {
      type: 'done',
      finishReason: 'stop',
    }),
    false,
  );
});

test('Renderer AgentEventBus tracks parallel tools and ignores stale runs', () => {
  const bus = new AgentEventBus();
  const first = [];
  const stopListening = bus.subscribe(() => first.push(bus.getSnapshot()));
  bus.begin('run-1');
  bus.publish('run-1', {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'search',
    args: { query: 'q' },
  });
  bus.publish('run-1', {
    type: 'tool_execution_start',
    toolCallId: 'tool-2',
    toolName: 'outline',
    args: {},
  });
  bus.publish('run-1', {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'search',
    isError: false,
  });
  bus.begin('run-2');
  bus.publish('run-1', { type: 'agent_end' });

  assert.equal(bus.getSnapshot().requestId, 'run-2');
  assert.deepEqual(bus.getSnapshot().tools, []);
  assert.equal(first.length > 0, true);
  stopListening();
});

test('Renderer AgentEventBus retains completed tool activity until the next run', () => {
  const bus = new AgentEventBus();
  bus.begin('run-history');
  bus.publish('run-history', {
    type: 'tool_execution_start',
    toolCallId: 'tool-write',
    toolName: 'write',
    args: { path: 'Redis-Introduction.md' },
  });
  bus.publish('run-history', {
    type: 'tool_execution_end',
    toolCallId: 'tool-write',
    toolName: 'write',
    isError: false,
    durationMs: 12,
  });
  bus.clear('run-history');

  assert.equal(bus.getSnapshot().requestId, null);
  assert.equal(bus.getSnapshot().phase, 'idle');
  assert.deepEqual(bus.getSnapshot().tools, [
    {
      toolCallId: 'tool-write',
      toolName: 'write',
      args: { path: 'Redis-Introduction.md' },
      status: 'completed',
      durationMs: 12,
    },
  ]);

  bus.begin('next-run');
  assert.deepEqual(bus.getSnapshot().tools, []);
});

test('Renderer AgentEventBus exposes live activity only to its source thread', () => {
  const bus = new AgentEventBus();
  bus.begin('turn-a', 'request-a', 'local-thread-a');

  assert.equal(bus.getSnapshotForThread('local-thread-a').phase, 'working');
  assert.equal(bus.getSnapshotForThread('local-thread-b').phase, 'idle');

  bus.clear('request-a');
  assert.equal(bus.getSnapshotForThread('local-thread-a').phase, 'idle');
});

test('Assistant adapter shows tool activity separately and streams cumulative Pi text deltas', async () => {
  const originalWindow = global.window;
  const abortController = new AbortController();
  const events = [
    { type: 'agent_start' },
    {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'q' },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'search',
      isError: false,
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '答' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '案' },
    },
    { type: 'done', finishReason: 'stop' },
  ];
  global.window = {
    teachforge: {
      streamChat(_prompt, onEvent) {
        setImmediate(() => events.forEach(onEvent));
        return 'run-adapter-1';
      },
      cancelChatStream() {},
    },
  };

  try {
    const output = [];
    for await (const state of agentChatAdapter.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: '提问' }] }],
      abortSignal: abortController.signal,
    })) {
      output.push(state.content[0].text);
    }
    assert.deepEqual(output, ['答', '答案']);
  } finally {
    global.window = originalWindow;
  }
});
