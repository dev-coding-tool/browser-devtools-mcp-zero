const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync, mkdtempSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');

const serverPath = join(__dirname, '..', 'chrome-devtools-mcp.js');

function sendMessage(server, message) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function readResponse(lines, id) {
  const line = await lines.next();
  assert.equal(line.done, false, `MCP 응답 ${id}을 받기 전에 서버 출력이 종료됐습니다.`);
  let response;
  try {
    response = JSON.parse(line.value);
  } catch {
    assert.fail('stdout에 JSON-RPC 형식이 아닌 출력이 있습니다.');
  }
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, id);
  return response;
}

async function startServer(t, args, profileDirectory) {
  assert.ok(existsSync(serverPath), '프로젝트 루트에 chrome-devtools-mcp.js가 필요합니다.');

  const server = spawn(process.execPath, args, {
    env: { ...process.env, CHROME_USER_DATA_DIR: profileDirectory },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const closed = new Promise((resolve) => server.once('close', resolve));
  const output = createInterface({ input: server.stdout, crlfDelay: Infinity });
  const lines = output[Symbol.asyncIterator]();
  const deadline = setTimeout(() => server.kill(), 5_000);
  let inputError;
  server.stdin.on('error', (error) => {
    inputError = error;
  });

  t.after(async () => {
    clearTimeout(deadline);
    output.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
    }
    await closed;
  });

  await once(server, 'spawn');
  return { server, lines, closed, inputError: () => inputError };
}

async function initialize({ server, lines }) {
  sendMessage(server, {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'stdio-smoke-test', version: '1.0.0' },
    },
  });
  const initialized = await readResponse(lines, 1);
  assert.equal(initialized.result?.protocolVersion, '2025-11-25');
  assert.ok(initialized.result.capabilities?.tools);
  assert.equal(initialized.result.serverInfo?.name, 'browser-devtools-mcp-zero');
  sendMessage(server, { method: 'notifications/initialized' });
}

async function finishServer({ server, lines, closed, inputError }) {
  server.stdin.end();
  assert.equal((await lines.next()).done, true, '예상한 MCP 메시지 외의 출력이 있습니다.');
  assert.equal(await closed, 0);
  assert.ifError(inputError());
}

test('stdio에서 MCP 초기화, 도구 목록, 오류 처리를 확인한다', { timeout: 8_000 }, async (t) => {
  const profileDirectory = mkdtempSync(join(tmpdir(), 'browser-devtools-mcp-zero-'));
  t.after(() => rmdirSync(profileDirectory));
  const session = await startServer(t, [serverPath], profileDirectory);
  const { server, lines } = session;
  await initialize(session);

  sendMessage(server, { id: 2, method: 'tools/list' });
  const listed = await readResponse(lines, 2);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [
    'connect_chrome',
    'evaluate_script',
    'list_pages',
    'navigate_page',
  ]);

  sendMessage(server, { id: 3, method: 'smoke_test/unknown' });
  const unknown = await readResponse(lines, 3);
  assert.equal(unknown.error?.code, -32601);

  sendMessage(server, {
    id: 4,
    method: 'tools/call',
    params: { name: 'navigate_page', arguments: { url: 'about:blank', pageId: false } },
  });
  const invalidPage = await readResponse(lines, 4);
  assert.equal(invalidPage.result?.isError, true);
  assert.match(invalidPage.result.content[0].text, /pageId/);

  sendMessage(server, { id: 5, method: 'tools/call', params: { name: 'list_pages', arguments: {} } });
  const disconnected = await readResponse(lines, 5);
  assert.ok(disconnected.error || disconnected.result?.isError === true, '연결 전 탭 조회는 오류를 반환해야 합니다.');
  assert.equal(JSON.stringify(disconnected).includes(basename(profileDirectory)), false, '오류 응답에 로컬 프로필 경로가 포함되면 안 됩니다.');

  await finishServer(session);
});

test('프로필 경로를 설정하지 않으면 디버깅 연결 정보를 읽지 않는다', { timeout: 8_000 }, async (t) => {
  // 회귀가 생겨도 테스트에서 실제 Chrome 프로필을 읽지 않도록 차단합니다.
  const guard = `
    require('node:fs').promises.readFile = () => {
      process.exitCode = 1;
      throw new Error('Unexpected profile file read in smoke test');
    };
    require(process.argv[1]);
  `;
  const session = await startServer(t, ['-e', guard, serverPath], '');
  const { server, lines } = session;
  await initialize(session);

  sendMessage(server, { id: 2, method: 'tools/call', params: { name: 'list_pages', arguments: {} } });
  const rejected = await readResponse(lines, 2);
  assert.equal(rejected.result?.isError, true);
  assert.match(rejected.result.content[0].text, /CHROME_USER_DATA_DIR/);

  await finishServer(session);
});
