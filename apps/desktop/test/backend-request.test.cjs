const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  describeBackendFailure,
  getNetworkErrorCode,
  requestBackend,
} = require('../dist-electron/electron/main/backend-request.js');

/** Boots a loopback server whose behaviour is supplied per test. */
async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a reset connection is retried once and the second attempt is returned', async () => {
  let requests = 0;
  const server = await startServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ documents: [] }));
  });

  try {
    const result = await requestBackend(
      { port: server.port, token: 'local-token' },
      { method: 'GET', path: '/api/documents' },
      { delayImpl: async () => undefined },
    );
    assert.deepEqual(result, { status: 200, data: { documents: [] } });
    assert.equal(requests, 2);
  } finally {
    await server.close();
  }
});

test('a repeated reset surfaces a Chinese message instead of a raw fetch error', async () => {
  const server = await startServer((request) => {
    request.socket.destroy();
  });

  try {
    await assert.rejects(
      () =>
        requestBackend(
          { port: server.port, token: 'local-token' },
          { method: 'POST', path: '/api/documents/import', body: { filePath: 'C:/x/a.docx' } },
          { delayImpl: async () => undefined },
        ),
      (error) => {
        assert.match(error.message, /本地服务连接中断/);
        assert.match(error.message, /ECONNRESET|UND_ERR_SOCKET|EPIPE/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('a non-network failure is not retried', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    const error = new Error('getaddrinfo ENOTFOUND 127.0.0.1');
    error.code = 'ENOTFOUND';
    throw error;
  };

  await assert.rejects(
    () =>
      requestBackend(
        { port: 1, token: 'local-token' },
        { method: 'GET', path: '/api/settings' },
        { fetchImpl, delayImpl: async () => undefined },
      ),
    /本地服务连接中断[\s\S]*ENOTFOUND/,
  );
  assert.equal(attempts, 1);
});

test('requests carry the local token, a close header and a JSON body', async () => {
  let seen;
  const server = await startServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen = {
        token: request.headers['x-teachforge-token'],
        connection: request.headers.connection,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });

  try {
    const result = await requestBackend(
      { port: server.port, token: 'local-token' },
      { method: 'POST', path: '/api/documents/import', body: { filePath: 'C:/x/a.docx' } },
    );
    assert.deepEqual(result, { status: 200, data: { ok: true } });
    assert.deepEqual(seen, {
      token: 'local-token',
      connection: 'close',
      contentType: 'application/json',
      body: JSON.stringify({ filePath: 'C:/x/a.docx' }),
    });
  } finally {
    await server.close();
  }
});

test('the failure description keeps the socket code for support', () => {
  const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  const error = Object.assign(new TypeError('fetch failed'), { cause });
  assert.equal(getNetworkErrorCode(error), 'ECONNRESET');
  assert.match(describeBackendFailure(error), /本地服务连接中断.*ECONNRESET/);
});
