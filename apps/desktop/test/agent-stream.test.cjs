const assert = require('node:assert/strict');
const test = require('node:test');
const { SseParser } = require('../dist-electron/electron/main/sse-parser.js');
const { decodeAgentSseMessage } = require('../dist-electron/electron/main/stream-protocol.js');
const { routeAgentStreamEvent } = require('../dist-electron/electron/main/stream-routing.js');

test('SSE parser preserves frames across CRLF and text chunk boundaries', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed('event: delta\r'), []);
  assert.deepEqual(parser.feed('\ndata: {"text":"hello"}\r\n\r'), []);
  assert.deepEqual(parser.feed('\n'), [
    { event: 'delta', data: '{"text":"hello"}' },
  ]);
});

test('UTF-8 decoder and SSE parser preserve a character split across byte chunks', () => {
  const frame = 'event: delta\r\ndata: {"text":"备课进行中"}\r\n\r\n';
  const bytes = new TextEncoder().encode(frame);
  const prefixLength = new TextEncoder().encode('event: delta\r\ndata: {"text":"').length;
  const splitAt = prefixLength + 1;
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const first = parser.feed(decoder.decode(bytes.slice(0, splitAt), { stream: true }));
  const secondText = decoder.decode(bytes.slice(splitAt), { stream: true }) + decoder.decode();
  const second = parser.feed(secondText);

  assert.deepEqual(first, []);
  assert.deepEqual(second, [
    { event: 'delta', data: '{"text":"备课进行中"}' },
  ]);
  assert.deepEqual(
    decodeAgentSseMessage(second[0]),
    { type: 'delta', text: '备课进行中' },
  );
});

test('Agent SSE protocol rejects unknown events and malformed payloads', () => {
  assert.equal(
    decodeAgentSseMessage({ event: 'delta', data: '{bad json' }),
    undefined,
  );
  assert.equal(
    decodeAgentSseMessage({ event: 'tool_call', data: '{"name":"subagent"}' }),
    undefined,
  );
  assert.deepEqual(
    decodeAgentSseMessage({ event: 'error', data: '{"message":"network"}' }),
    { type: 'error', message: 'network' },
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
    ['agent-1-1', { port: { postMessage: (event) => firstEvents.push(event) } }],
    ['agent-1-2', { port: { postMessage: (event) => secondEvents.push(event) } }],
  ]);

  assert.equal(
    routeAgentStreamEvent(streams, 'agent-1-2', { type: 'delta', text: '第二条' }),
    true,
  );
  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, [{ type: 'delta', text: '第二条' }]);
  assert.equal(
    routeAgentStreamEvent(streams, 'agent-missing-1', { type: 'done' }),
    false,
  );
});
