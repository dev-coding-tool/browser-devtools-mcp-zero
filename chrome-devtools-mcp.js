/**
 * 기존 Chrome 프로필에 연결하는 로컬 Chrome DevTools MCP 서버입니다.
 * Node.js 22.4.0 이상, 외부 npm 패키지 없이 실행합니다.
 *
 * 원격 디버깅을 활성화한 Chrome을 사용합니다.
 * 연결 승인 요청이 표시되면 Chrome에서 승인해야 합니다.
 *
 * 필수 환경 변수:
 *   CHROME_USER_DATA_DIR  Chrome 사용자 데이터 최상위 폴더
 *                         (Default, Profile 1 등의 하위 폴더가 아님)
 *
 * Chrome 프로세스를 실행하거나 종료하지 않으며, 프로필 파일도 변경하지 않습니다.
 * connect_chrome의 normal 모드는 기존 일반 탭을 사용합니다.
 * incognito 모드는 기존 시크릿 탭이 CDP에서 식별되는 경우에만 연결합니다.
 * 브라우저 컨텍스트나 탭을 새로 만들지 않으며 기존 탭을 닫지도 않습니다.
 * Chrome 버전/연결 방식에 따라 기존 시크릿 탭의 자동 식별이 제한될 수 있습니다.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (typeof globalThis.WebSocket !== 'function') {
  process.stderr.write('Node.js 22.4.0 이상이 필요합니다(내장 WebSocket 사용).\n');
  process.exit(1);
}

const SERVER_NAME = 'chrome-devtools-mcp-zero';
const SERVER_VERSION = '0.4.0';
const MCP_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const CONNECT_TIMEOUT_MS = 45000; // Chrome 연결 승인에 필요한 시간을 고려합니다.
const COMMAND_TIMEOUT_MS = 20000;

let cdp = null;
let connecting = null;
let shuttingDown = false;
let activeMode = 'normal';
let normalContextId = null;
let selectedContextId = null;

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function userDataDir() {
  const folder = process.env.CHROME_USER_DATA_DIR;
  if (!folder?.trim()) {
    throw new Error('CHROME_USER_DATA_DIR에 연결할 Chrome 사용자 데이터 폴더를 지정하세요.');
  }
  return path.resolve(folder);
}

async function readActiveEndpoint() {
  const file = path.join(userDataDir(), 'DevToolsActivePort');
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'DevToolsActivePort 파일이 없습니다. ' +
        'Chrome의 원격 디버깅을 활성화하세요. ' +
        'CHROME_USER_DATA_DIR에는 실행 중인 Chrome의 사용자 데이터 최상위 폴더를 지정하세요.'
      );
    }
    throw new Error(`DevToolsActivePort를 읽지 못했습니다 (${error.code || 'UNKNOWN'}). 데이터 폴더 경로와 접근 권한을 확인하세요.`);
  }

  const [portText, wsPath] = raw.split(/\r?\n/).map((line) => line.trim());
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^\/devtools\/browser\/[\w-]+$/.test(wsPath || '')) {
    throw new Error('DevToolsActivePort 형식이 올바르지 않습니다(포트와 브라우저 WebSocket 경로 필요).');
  }
  // 연결 대상은 로컬 호스트로 고정하여 외부 브라우저 접속을 방지합니다.
  return { url: `ws://127.0.0.1:${port}${wsPath}`, port };
}

function createClient(ws, endpointUrl) {
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const client = {
    ws,
    endpointUrl,
    get isOpen() { return !closed && ws.readyState === WebSocket.OPEN; },
    request(method, params = {}, sessionId, timeoutMs = COMMAND_TIMEOUT_MS) {
      if (!client.isOpen) return Promise.reject(new Error('Chrome CDP 연결이 종료되었습니다.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 명령 시간 초과: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          const message = { id, method, params };
          if (sessionId) message.sessionId = sessionId;
          ws.send(JSON.stringify(message));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() { try { ws.close(); } catch { /* 연결 해제 오류는 무시합니다. */ } },
  };

  function failAll(reason) {
    if (closed) return;
    closed = true;
    if (cdp === client) {
      cdp = null;
      activeMode = 'normal';
      normalContextId = null;
      selectedContextId = null;
    }
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
  }

  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (typeof message.id !== 'number') return; // CDP 이벤트는 현재 버전에서 처리하지 않습니다.
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(`CDP 오류 ${message.error.code}: ${message.error.message}`));
    else item.resolve(message.result || {});
  });
  ws.addEventListener('close', () => failAll('Chrome CDP 연결이 종료되었습니다.'));
  ws.addEventListener('error', () => failAll('Chrome CDP WebSocket 오류가 발생했습니다.'));
  return client;
}

async function ensureConnection() {
  if (cdp?.isOpen) return cdp;
  if (connecting) return connecting;

  connecting = (async () => {
    const { url } = await readActiveEndpoint();
    const ws = new WebSocket(url);
    let timer;
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        function finish(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onError);
          ws.removeEventListener('close', onClose);
          if (error) reject(error);
          else resolve();
        }
        const onOpen = () => finish();
        const onError = () => finish(new Error('Chrome CDP WebSocket을 열지 못했습니다.'));
        const onClose = () => finish(new Error('Chrome이 디버깅 연결을 거부하거나 종료했습니다.'));
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onError);
        ws.addEventListener('close', onClose);
        timer = setTimeout(() => finish(new Error('Chrome 연결 시간 초과: Chrome의 연결 승인 창을 확인하세요.')), CONNECT_TIMEOUT_MS);
      });
      const client = createClient(ws, url);
      const version = await client.request('Browser.getVersion');
      if (shuttingDown) { client.close(); throw new Error('MCP 서버가 종료 중입니다.'); }
      cdp = client;
      log(`기존 Chrome에 연결: ${version.product || 'Chrome'}`);
      return client;
    } catch (error) {
      try { ws.close(); } catch { /* 정리 중 오류는 무시합니다. */ }
      throw new Error(`${error.message} chrome://inspect/#remote-debugging 설정과 Chrome 승인 여부를 확인하세요.`);
    }
  })();

  try { return await connecting; }
  finally { connecting = null; }
}

/** Chrome이 노출한 기존 페이지 타깃을 조회합니다. 어떠한 탭도 생성하지 않습니다. */
async function getExistingPages(client) {
  const { targetInfos = [] } = await client.request('Target.getTargets', {
    filter: [{ type: 'page', exclude: false }],
  });
  return targetInfos.filter((item) => item.type === 'page');
}

/** CDP에서 제공하는 브라우저 컨텍스트를 조회합니다. */
async function getContextInfo(client) {
  const { browserContextIds = [], defaultBrowserContextId } =
    await client.request('Target.getBrowserContexts');
  return { createdIds: new Set(browserContextIds), defaultId: defaultBrowserContextId || null };
}

/**
 * 정상 프로필을 가리키는 컨텍스트를 식별합니다.
 * Chrome이 기본 컨텍스트 ID를 제공하지 않으면 유일하게 남은 그룹일 때만 선택합니다.
 * 사용자 시크릿 창과 다른 프로필을 명확히 구분할 수 없으면 추측하지 않습니다.
 */
function findNormalContext(pages, info) {
  const ids = new Set(pages.map((page) => page.browserContextId).filter(Boolean));
  if (info.defaultId) return info.defaultId;
  if (normalContextId && ids.has(normalContextId)) return normalContextId;
  const candidates = [...ids].filter((id) => !info.createdIds.has(id));
  return candidates.length === 1 ? candidates[0] : null;
}

function validatePageId(pageId) {
  if (pageId !== undefined && (typeof pageId !== 'string' || !pageId.trim())) {
    throw new Error('pageId는 탭 ID 문자열이어야 합니다.');
  }
}

/** 연결 대상을 기존 탭에서만 선택합니다. pageId로 직접 지정할 수도 있습니다. */
async function connectChrome({ mode = 'normal', pageId } = {}) {
  if (!['normal', 'incognito'].includes(mode)) {
    throw new Error('mode는 normal 또는 incognito여야 합니다.');
  }
  validatePageId(pageId);

  const wasConnected = Boolean(cdp?.isOpen);
  const client = await ensureConnection();
  const pages = await getExistingPages(client);
  if (pages.length === 0) {
    throw new Error('Chrome에서 CDP로 접근할 수 있는 기존 탭을 찾지 못했습니다.');
  }
  const info = await getContextInfo(client);
  const verifiedNormalId = findNormalContext(pages, info);
  const explicitPage = pageId ? pages.find((page) => page.targetId === pageId) : null;
  if (pageId && !explicitPage) {
    throw new Error(`Chrome에서 해당 탭을 찾지 못했습니다: ${pageId}. list_pages의 scope=all로 확인하세요.`);
  }

  let contextId;
  let identification = 'automatic';
  if (mode === 'normal') {
    if (explicitPage) {
      if (info.createdIds.has(explicitPage.browserContextId) ||
          (info.defaultId && explicitPage.browserContextId !== info.defaultId)) {
        throw new Error('지정한 pageId는 기본 프로필에 속하지 않습니다.');
      }
      contextId = explicitPage.browserContextId;
      identification = info.defaultId ? 'verified' : 'manual';
    } else {
      contextId = verifiedNormalId;
    }
    if (!contextId) {
      throw new Error('일반 프로필을 자동으로 구분할 수 없습니다. list_pages(scope=all)로 탭 ID를 확인한 후 connect_chrome(mode=normal, pageId=...)으로 지정하세요.');
    }
    normalContextId = contextId;
  } else {
    if (explicitPage) {
      if ((info.defaultId && explicitPage.browserContextId === info.defaultId) ||
          (normalContextId && explicitPage.browserContextId === normalContextId)) {
        throw new Error('지정한 pageId가 일반 프로필에 속합니다. 기존 시크릿 탭 ID를 지정하세요.');
      }
      contextId = explicitPage.browserContextId;
      identification = 'manual';
    } else {
      const baseId = verifiedNormalId || normalContextId;
      if (!baseId) {
        throw new Error('기본 프로필과 시크릿 프로필을 구분할 수 없습니다. list_pages(scope=all)로 기존 시크릿 탭의 ID를 확인한 뒤 connect_chrome(mode=incognito, pageId=...)으로 지정하세요.');
      }
      const others = [...new Set(pages
        .map((page) => page.browserContextId)
        .filter((id) => id && id !== baseId))];
      if (others.length !== 1) {
        throw new Error(others.length === 0
          ? 'CDP에서 일반 프로필과 구별되는 기존 시크릿 탭을 찾지 못했습니다. Chrome에서 시크릿 창을 열고 재시도하세요. 시크릿 탭이 CDP에 노출되지 않으면 자동 연결할 수 없습니다.'
          : '일반 프로필 외 여러 컨텍스트가 있어 시크릿 탭을 자동 확정할 수 없습니다. list_pages(scope=all)에서 ID를 확인해 pageId로 지정하세요.');
      }
      contextId = others[0];
    }
  }

  if (!pages.some((page) => page.browserContextId === contextId)) {
    throw new Error('선택한 프로필에 접근 가능한 기존 탭이 없습니다.');
  }
  // 성공한 경우에만 작업 모드를 교체하며, 시크릿 창을 생성하거나 종료하지 않습니다.
  selectedContextId = contextId;
  activeMode = mode;
  const version = await client.request('Browser.getVersion');
  return {
    status: wasConnected ? 'already_connected' : 'connected',
    mode: activeMode,
    browser: version.product,
    userAgent: version.userAgent,
    pageCount: pages.filter((page) => page.browserContextId === contextId).length,
    identification,
    note: identification === 'manual'
      ? '요청하신 기존 탭의 컨텍스트에 연결했습니다. Chrome이 시크릿 여부를 명시적으로 제공하지 않아 탭의 모드 자체는 검증하지 못했습니다.'
      : mode === 'normal'
        ? '기존 일반 탭에 연결했습니다. 새 탭이나 창을 생성하지 않았습니다.'
        : '일반 프로필과 다른 기존 컨텍스트의 탭에 연결했습니다. 시크릿 여부는 Chrome의 CDP 정보만으로 확정할 수 없습니다.',
  };
}

async function getPageTargets(client) {
  if (!selectedContextId) {
    await connectChrome({ mode: 'normal' });
  }
  const pages = await getExistingPages(client);
  return pages.filter((page) => page.browserContextId === selectedContextId);
}

async function listPages({ scope = 'selected' } = {}) {
  if (!['selected', 'all'].includes(scope)) {
    throw new Error('scope는 selected 또는 all이어야 합니다.');
  }
  const client = await ensureConnection();
  const pages = scope === 'all' ? await getExistingPages(client) : await getPageTargets(client);
  return pages.map(({ targetId, title, url, browserContextId }) => ({
    id: targetId,
    title,
    url,
    ...(scope === 'all' ? { browserContextId: browserContextId || null } : {}),
  }));
}

async function withPageSession(pageId, operation) {
  validatePageId(pageId);
  const client = await ensureConnection();
  const pages = await getPageTargets(client);
  const page = pageId ? pages.find((target) => target.targetId === pageId) : pages[0];
  if (!page) {
    throw new Error(pageId
      ? `현재 ${activeMode} 모드에서 접근할 수 없는 탭입니다: ${pageId}`
      : `현재 ${activeMode} 모드에 사용 가능한 탭이 없습니다.`);
  }
  const { sessionId } = await client.request('Target.attachToTarget', {
    targetId: page.targetId, flatten: true,
  });
  if (!sessionId) throw new Error('Chrome이 CDP 페이지 세션을 생성하지 않았습니다.');
  try {
    return await operation({
      pageId: page.targetId,
      send(method, params) { return client.request(method, params, sessionId); },
    });
  } finally {
    // 브라우저가 아닌 페이지 디버거 세션만 해제합니다.
    if (client.isOpen) {
      try { await client.request('Target.detachFromTarget', { sessionId }, undefined, 2000); }
      catch { /* 이동 중 탭이 닫혔을 수 있습니다. */ }
    }
  }
}

async function navigatePage({ url, pageId } = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('url이 필요합니다.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('유효한 절대 URL을 입력하세요.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) && url !== 'about:blank') {
    throw new Error('현재 버전에서는 http://, https://, about:blank만 허용합니다.');
  }
  return withPageSession(pageId, async (page) => {
    const result = await page.send('Page.navigate', { url });
    if (result.errorText) throw new Error(result.errorText);
    return { pageId: page.pageId, url, frameId: result.frameId,
      note: '페이지 이동을 시작했습니다. 실제 로딩은 아직 진행 중일 수 있습니다.' };
  });
}

async function evaluateScript({ expression, pageId } = {}) {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('expression이 필요합니다.');
  return withPageSession(pageId, async (page) => {
    const result = await page.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: false,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + (result.exceptionDetails.exception?.description
        ? `: ${result.exceptionDetails.exception.description}` : ''));
    }
    const value = result.result;
    return {
      pageId: page.pageId,
      type: value?.type,
      value: Object.prototype.hasOwnProperty.call(value || {}, 'value')
        ? value.value : (value?.unserializableValue ?? value?.description ?? null),
    };
  });
}

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false };
const tools = [
  {
    name: 'connect_chrome',
    description: '실행 중인 Chrome의 기존 탭에만 연결합니다. normal은 일반 탭, incognito는 기존 시크릿 탭을 대상으로 하며 새 창/탭을 만들지 않습니다. 자동 구분이 어려우면 pageId로 지정할 수 있습니다.',
    inputSchema: {
      type: 'object', properties: {
        mode: { type: 'string', enum: ['normal', 'incognito'], default: 'normal',
          description: '연결 모드: normal(기존 일반 탭, 기본값) 또는 incognito(기존 시크릿 탭)' },
        pageId: { type: 'string', description: '선택 사항: 기존 탭 ID. 프로필 자동 식별이 어려울 때 list_pages(scope=all)로 조회하여 지정' },
      }, additionalProperties: false,
    },
  },
  {
    name: 'list_pages',
    description: '현재 연결된 모드의 기존 탭 목록을 조회합니다. scope=all은 연결 가능한 모든 탭 ID와 컨텍스트를 조회합니다.',
    inputSchema: {
      type: 'object', properties: {
        scope: { type: 'string', enum: ['selected', 'all'], default: 'selected',
          description: 'selected는 현재 선택한 프로필, all은 CDP에서 조회되는 모든 기존 탭' },
      }, additionalProperties: false,
    },
  },
  {
    name: 'navigate_page',
    description: '현재 선택한 모드의 탭을 지정한 URL로 이동합니다. pageId를 생략하면 첫 번째 탭을 사용하며 이동 시작 시 반환합니다.',
    inputSchema: {
      type: 'object', properties: {
        url: { type: 'string', description: '이동할 절대 URL(http://, https:// 또는 about:blank)' },
        pageId: { type: 'string', description: '선택 사항: list_pages가 반환한 탭 ID' },
      }, required: ['url'], additionalProperties: false,
    },
  },
  {
    name: 'evaluate_script',
    description: '현재 선택한 모드의 탭에서 JavaScript를 실행하고 결과를 반환합니다. pageId를 생략하면 첫 번째 탭을 사용합니다.',
    inputSchema: {
      type: 'object', properties: {
        expression: { type: 'string', description: '실행할 JavaScript 표현식' },
        pageId: { type: 'string', description: '선택 사항: list_pages가 반환한 탭 ID' },
      }, required: ['expression'], additionalProperties: false,
    },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function rpcError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}
function toolResult(data, isError = false) {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text: serialized.slice(0, 60000) }], isError };
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (Object.prototype.hasOwnProperty.call(message || {}, 'id')) rpcError(message.id, -32600, '올바르지 않은 JSON-RPC 요청입니다.');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return; // 알림은 응답하지 않습니다.

  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: MCP_VERSIONS.has(params.protocolVersion) ? params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools }); return; }
  if (method !== 'tools/call') { rpcError(id, -32601, `지원하지 않는 메서드: ${method}`); return; }

  try {
    const name = params.name;
    const args = params.arguments || {};
    let result;
    switch (name) {
      case 'connect_chrome': result = await connectChrome(args); break;
      case 'list_pages': result = await listPages(args); break;
      case 'navigate_page': result = await navigatePage(args); break;
      case 'evaluate_script': result = await evaluateScript(args); break;
      default: rpcError(id, -32602, `알 수 없는 도구: ${name}`); return;
    }
    reply(id, toolResult(result));
  } catch (error) {
    reply(id, toolResult(error.message || String(error), true));
  }
}

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  const client = cdp;
  cdp = null;
  if (client) client.close(); // Chrome 프로세스를 종료하지 않습니다.
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { rpcError(null, -32700, 'JSON 파싱 오류'); return; }
  void handleMessage(message).catch((error) => log(`예기치 않은 오류: ${error.stack || error}`));
});
rl.on('close', () => { cleanup(); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
