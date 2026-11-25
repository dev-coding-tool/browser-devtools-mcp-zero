const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { copyFileSync, existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');

const serverPath = join(__dirname, '..', 'browser-devtools-mcp.js');

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

async function startServer(t, args, profileDirectory, settings = {}) {
  assert.ok(existsSync(serverPath), '프로젝트 루트에 browser-devtools-mcp.js가 필요합니다.');

  const server = spawn(process.execPath, args, {
    env: { ...process.env, BROWSER_USER_DATA_DIR: profileDirectory, BROWSER_CHROME_USER_DATA_DIR: '', BROWSER_EDGE_USER_DATA_DIR: '', ...settings },
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
    'connect_browser',
    'evaluate_script',
    'list_console_messages',
    'list_network_requests',
    'list_pages',
    'mock_api_response',
    'navigate_page',
    'new_page',
    'start_console_capture',
    'take_screenshot',
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

  sendMessage(server, {
    id: 6,
    method: 'tools/call',
    params: { name: 'mock_api_response', arguments: { pageId: 'example', url: 'https://example.test/api', body: {} } },
  });
  const externalMock = await readResponse(lines, 6);
  assert.equal(externalMock.result?.isError, true);
  assert.match(externalMock.result.content[0].text, /루프백/);

  sendMessage(server, { id: 7, method: 'tools/call', params: { name: 'take_screenshot', arguments: {} } });
  const unnamedScreenshot = await readResponse(lines, 7);
  assert.equal(unnamedScreenshot.result?.isError, true);
  assert.match(unnamedScreenshot.result.content[0].text, /pageId/);

  await finishServer(session);
});

test('프로필 경로를 설정하지 않으면 디버깅 연결 정보를 읽지 않는다', { timeout: 8_000 }, async (t) => {
  // 회귀가 생겨도 테스트에서 실제 브라우저 프로필을 읽지 않도록 차단합니다.
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
  assert.match(rejected.result.content[0].text, /BROWSER_USER_DATA_DIR/);

  await finishServer(session);
});

test('한 서버에서 브라우저별 경로를 선택하고 환경변수가 파일보다 우선한다', { timeout: 8_000 }, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'browser-devtools-mcp-zero-config-'));
  const entry = join(fixture, 'browser-devtools-mcp.js');
  const settingsFile = join(fixture, '.env.local');
  t.after(() => {
    unlinkSync(entry);
    unlinkSync(settingsFile);
    rmdirSync(fixture);
  });
  copyFileSync(serverPath, entry);
  const chrome = join(fixture, 'chrome-fixture');
  const edge = join(fixture, 'edge-fixture');
  writeFileSync(settingsFile, 'BROWSER_CHROME_USER_DATA_DIR="' + chrome + '"\nBROWSER_EDGE_USER_DATA_DIR="' + join(fixture, 'unused-edge') + '"\n');
  const fixtureCodes = {
    [join(chrome, 'DevToolsActivePort')]: 'CHROME_FIXTURE',
    [join(edge, 'DevToolsActivePort')]: 'EDGE_FIXTURE',
  };
  const guard = 'const codes = ' + JSON.stringify(fixtureCodes) + '; ' +
    "require('node:fs').promises.readFile = async (file) => { " +
    "throw Object.assign(new Error('Fixture only'), { code: codes[file] || 'UNEXPECTED_FIXTURE' }); }; " +
    'require(process.argv[1]);';

  const session = await startServer(t, ['-e', guard, entry], '', {
    BROWSER_CHROME_USER_DATA_DIR: undefined,
    BROWSER_EDGE_USER_DATA_DIR: edge,
  });
  const { server, lines } = session;
  await initialize(session);
  for (const [id, args, expected] of [
    [2, {}, /browser를 chrome 또는 edge/],
    [3, { browser: 'chrome' }, /CHROME_FIXTURE/],
    [4, { browser: 'edge' }, /EDGE_FIXTURE/],
    [5, { browser: ['edge'] }, /browser는 chrome 또는 edge/],
  ]) {
    sendMessage(server, { id, method: 'tools/call', params: { name: 'connect_browser', arguments: args } });
    const response = await readResponse(lines, id);
    assert.equal(response.result?.isError, true);
    assert.match(response.result.content[0].text, expected);
  }
  await finishServer(session);
});

test('기본 프로필은 브라우저 설정 화면을 열고 디버깅 플래그를 넘기지 않는다', {
  timeout: 8_000,
  skip: !['win32', 'darwin', 'linux'].includes(process.platform),
}, async (t) => {
  const { homedir } = require('node:os');
  let chrome;
  let edge;
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    chrome = join(root, 'Google', 'Chrome', 'User Data');
    edge = join(root, 'Microsoft', 'Edge', 'User Data');
  } else if (process.platform === 'darwin') {
    const root = join(homedir(), 'Library', 'Application Support');
    chrome = join(root, 'Google', 'Chrome');
    edge = join(root, 'Microsoft Edge');
  } else {
    const root = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    chrome = join(process.env.CHROME_CONFIG_HOME || root, 'google-chrome');
    edge = join(root, 'microsoft-edge');
  }
  const expected = [
    { folder: chrome, inspect: 'chrome://inspect/#remote-debugging' },
    { folder: edge, inspect: 'edge://inspect' },
  ];
  const guard = 'const expected = ' + JSON.stringify(expected) + '; ' +
    "const fs = require('node:fs'); const path = require('node:path'); let i = 0; " +
    'const realpath = fs.realpathSync; ' +
    'fs.realpathSync = (folder, ...rest) => expected.some((entry) => entry.folder === folder) ? folder : realpath(folder, ...rest); ' +
    'fs.promises.readFile = async (file) => { ' +
    "if (file !== path.join(expected[i].folder, 'DevToolsActivePort')) process.exitCode = 1; " +
    "throw Object.assign(new Error('Fixture only'), { code: 'ENOENT' }); }; " +
    "require('node:child_process').spawn = (binary, args) => { " +
    "const target = expected[i++]; " +
    "if (binary !== process.execPath || args.length !== 2 || args[0] !== '--user-data-dir=' + target.folder || args[1] !== target.inspect) process.exitCode = 1; " +
    "throw new Error('Fixture only'); }; " +
    "process.on('exit', () => { if (i !== expected.length) process.exitCode = 1; }); " +
    'require(process.argv[1]);';
  const session = await startServer(t, ['-e', guard, serverPath], '', {
    BROWSER_CHROME_EXECUTABLE: process.execPath,
    BROWSER_EDGE_EXECUTABLE: process.execPath,
  });
  const { server, lines } = session;
  await initialize(session);
  for (const [id, browser] of [[2, 'chrome'], [3, 'edge']]) {
    sendMessage(server, { id, method: 'tools/call', params: { name: 'connect_browser', arguments: { browser } } });
    const result = await readResponse(lines, id);
    assert.equal(result.result?.isError, true);
    assert.match(result.result.content[0].text, /브라우저를 실행하지 못했습니다/);
  }
  await finishServer(session);
});
