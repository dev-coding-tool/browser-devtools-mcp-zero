/**
 * 기존 브라우저 프로필에 연결하는 로컬 DevTools MCP 서버입니다.
 * Node.js 22.4.0 이상, 외부 npm 패키지 없이 실행합니다.
 *
 * 원격 디버깅을 활성화한 Chrome 또는 Edge를 사용합니다.
 * 연결 승인 요청이 표시되면 브라우저에서 승인해야 합니다.
 *
 * BROWSER_CHROME_USER_DATA_DIR 및 BROWSER_EDGE_USER_DATA_DIR로 전용 데이터 폴더를 지정합니다.
 * 단일 기존 브라우저에는 BROWSER_USER_DATA_DIR 설정도 사용할 수 있습니다.
 * 브라우저별 경로가 지정되면 선택한 브라우저를 전용 프로필로 자동 실행할 수 있습니다.
 * connect_browser의 normal 모드는 기존 일반 탭을 사용합니다.
 * incognito 모드는 기존 시크릿 탭이 CDP에서 식별되는 경우에만 연결합니다.
 * new_page는 일반 프로필에 새 탭을 엽니다.
 * 브라우저 버전/연결 방식에 따라 기존 시크릿 탭의 자동 식별이 제한될 수 있습니다.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { parseEnv } = require('node:util');

if (typeof globalThis.WebSocket !== 'function') {
  process.stderr.write('Node.js 22.4.0 이상이 필요합니다(내장 WebSocket 사용).\n');
  process.exit(1);
}

const SERVER_NAME = 'browser-devtools-mcp-zero';
const SERVER_VERSION = '0.4.0';
const MCP_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const CONNECT_TIMEOUT_MS = 45000; // 브라우저 연결 승인에 필요한 시간을 고려합니다.
const COMMAND_TIMEOUT_MS = 20000;

const BROWSER_SETTINGS = {
  chrome: { profile: 'BROWSER_CHROME_USER_DATA_DIR', executable: 'BROWSER_CHROME_EXECUTABLE' },
  edge: { profile: 'BROWSER_EDGE_USER_DATA_DIR', executable: 'BROWSER_EDGE_EXECUTABLE' },
};
const browserStates = new Map();
let activeBrowser = null;
let shuttingDown = false;
let localSettings;

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function setting(name) {
  if (process.env[name] !== undefined) return process.env[name];
  if (!localSettings) {
    try {
      localSettings = parseEnv(fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('.env.local 파일을 읽지 못했습니다.');
      localSettings = {};
    }
  }
  return localSettings[name];
}

function profilePath(folder) {
  const absolute = path.resolve(folder);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') return absolute;
    throw new Error('브라우저 사용자 데이터 폴더에 접근할 수 없습니다.');
  }
}

function sameProfile(first, second) {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function stateFor(browser) {
  if (browser !== undefined && (typeof browser !== 'string' || !Object.hasOwn(BROWSER_SETTINGS, browser))) {
    throw new Error('browser는 chrome 또는 edge여야 합니다.');
  }
  if (browser === undefined && activeBrowser) return activeBrowser;
  if (browser === undefined) {
    if (setting('BROWSER_USER_DATA_DIR')?.trim()) {
      browser = 'default';
    } else {
      const named = Object.keys(BROWSER_SETTINGS).filter((key) => setting(BROWSER_SETTINGS[key].profile)?.trim());
      if (named.length > 1) throw new Error('Chrome과 Edge가 설정되어 있습니다. browser를 chrome 또는 edge로 지정하세요.');
      browser = named[0] || 'default';
    }
  }

  let state = browserStates.get(browser);
  if (state) return state;
  const key = BROWSER_SETTINGS[browser]?.profile || 'BROWSER_USER_DATA_DIR';
  const directory = setting(key);
  if (!directory?.trim()) throw new Error(`${key}에 연결할 브라우저 사용자 데이터 폴더를 지정하세요.`);
  const folder = profilePath(directory);
  if (browser !== 'default') {
    const other = setting(BROWSER_SETTINGS[browser === 'chrome' ? 'edge' : 'chrome'].profile);
    if (other?.trim() && sameProfile(folder, profilePath(other))) {
      throw new Error('Chrome과 Edge는 서로 다른 전용 사용자 데이터 폴더를 지정하세요.');
    }
  }
  state = {
    browser, folder, key, client: null, connecting: null,
    mode: 'normal', normalContextId: null, contextId: null, activities: new Map(),
  };
  browserStates.set(browser, state);
  return state;
}

function standardDataDirs() {
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA;
    if (!root) return [];
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome SxS',
      'Microsoft/Edge', 'Microsoft/Edge Beta', 'Microsoft/Edge Dev', 'Microsoft/Edge SxS']
      .map((prefix) => path.join(root, prefix, 'User Data'));
  }
  if (process.platform === 'darwin') {
    const root = path.join(os.homedir(), 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary',
      'Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary']
      .map((prefix) => path.join(root, prefix));
  }
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'microsoft-edge',
    'microsoft-edge-beta', 'microsoft-edge-dev'].map((prefix) => path.join(root, prefix));
}

function browserExecutable(browser) {
  const key = BROWSER_SETTINGS[browser].executable;
  const configured = setting(key);
  if (configured?.trim()) {
    if (!path.isAbsolute(configured) || !fs.statSync(configured, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${key}에 실행 파일의 절대 경로를 지정하세요.`);
    }
    return configured;
  }
  if (process.platform === 'win32') {
    const relative = browser === 'chrome'
      ? 'Google/Chrome/Application/chrome.exe'
      : 'Microsoft/Edge/Application/msedge.exe';
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
    for (const root of roots) {
      if (!root) continue;
      const candidate = path.join(root, relative);
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
  }
  throw new Error(`브라우저 실행 파일을 찾지 못했습니다. ${key}에 절대 경로를 지정하세요.`);
}

function localPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.setTimeout(500);
  });
}

async function endpointFor(state) {
  let endpoint;
  try { endpoint = await readActiveEndpoint(state); }
  catch (error) {
    if (state.browser === 'default' || error.cause?.code !== 'ENOENT') throw error;
  }
  if (endpoint && (state.browser === 'default' || await localPortOpen(endpoint.port))) return endpoint;

  const canonicalFolder = profilePath(state.folder);
  if (standardDataDirs().some((candidate) => sameProfile(canonicalFolder, candidate) ||
    (fs.existsSync(candidate) && sameProfile(canonicalFolder, profilePath(candidate))))) {
    throw new Error('자동 실행에는 별도의 전용 사용자 데이터 폴더를 지정하세요.');
  }
  const binary = browserExecutable(state.browser);
  let child;
  try {
    child = spawn(binary, [
      `--user-data-dir=${state.folder}`, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    await once(child, 'spawn');
  } catch {
    throw new Error('전용 브라우저를 실행하지 못했습니다.');
  }
  child.unref();

  const deadline = Date.now() + 12_000;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const candidate = await readActiveEndpoint(state);
      if (await localPortOpen(candidate.port)) return candidate;
    } catch (error) {
      if (error.cause?.code !== 'ENOENT' && error.code !== 'INVALID_DEVTOOLS_ENDPOINT') throw error;
    }
    await delay(100);
  }
  throw new Error('전용 브라우저의 원격 디버깅을 열지 못했습니다. 같은 폴더를 사용 중인 브라우저를 확인하세요.');
}

async function readActiveEndpoint(state) {
  const file = path.join(state.folder, 'DevToolsActivePort');
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'DevToolsActivePort 파일이 없습니다. ' +
        '브라우저의 원격 디버깅을 활성화하세요. ' +
        `${state.key}에는 브라우저의 사용자 데이터 최상위 폴더를 지정하세요.`,
        { cause: error }
      );
    }
    throw new Error(`DevToolsActivePort를 읽지 못했습니다 (${error.code || 'UNKNOWN'}). 데이터 폴더 경로와 접근 권한을 확인하세요.`);
  }

  const [portText, wsPath] = raw.split(/\r?\n/).map((line) => line.trim());
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^\/devtools\/browser\/[\w-]+$/.test(wsPath || '')) {
    const error = new Error('DevToolsActivePort 형식이 올바르지 않습니다(포트와 브라우저 WebSocket 경로 필요).');
    error.code = 'INVALID_DEVTOOLS_ENDPOINT';
    throw error;
  }
  // 연결 대상은 로컬 호스트로 고정하여 외부 브라우저 접속을 방지합니다.
  return { url: `ws://127.0.0.1:${port}${wsPath}`, port };
}

function createClient(ws, endpointUrl, state) {
  const pending = new Map();
  const watchers = new Map();
  let nextId = 1;
  let closed = false;
  const client = {
    ws,
    endpointUrl,
    get isOpen() { return !closed && ws.readyState === WebSocket.OPEN; },
    request(method, params = {}, sessionId, timeoutMs = COMMAND_TIMEOUT_MS) {
      if (!client.isOpen) return Promise.reject(new Error('브라우저 CDP 연결이 종료되었습니다.'));
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
    watch(sessionId, onEvent, onClose) { watchers.set(sessionId, { onEvent, onClose }); },
    unwatch(sessionId) { watchers.delete(sessionId); },
    close() { try { ws.close(); } catch { /* 연결 해제 오류는 무시합니다. */ } },
  };

  function failAll(reason) {
    if (closed) return;
    closed = true;
    if (state.client === client) {
      state.client = null;
      state.mode = 'normal';
      state.normalContextId = null;
      state.contextId = null;
    }
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
    for (const watcher of watchers.values()) watcher.onClose();
    watchers.clear();
  }

  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (typeof message.id !== 'number') {
      if (message.method === 'Target.detachedFromTarget') {
        const id = message.params?.sessionId;
        const watcher = watchers.get(id);
        watchers.delete(id);
        watcher?.onClose();
      } else if (message.params) {
        try { watchers.get(message.sessionId)?.onEvent(message); }
        catch { log('탭 이벤트를 처리하지 못했습니다.'); }
      }
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(`CDP 오류 ${message.error.code}: ${message.error.message}`));
    else item.resolve(message.result || {});
  });
  ws.addEventListener('close', () => failAll('브라우저 CDP 연결이 종료되었습니다.'));
  ws.addEventListener('error', () => failAll('브라우저 CDP WebSocket 오류가 발생했습니다.'));
  return client;
}

async function ensureConnection(state) {
  if (state.client?.isOpen) return state.client;
  if (state.connecting) return state.connecting;
  if (shuttingDown) throw new Error('MCP 서버가 종료 중입니다.');

  state.connecting = (async () => {
    const { url } = await endpointFor(state);
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
        const onError = () => finish(new Error('브라우저 CDP WebSocket을 열지 못했습니다.'));
        const onClose = () => finish(new Error('브라우저가 디버깅 연결을 거부하거나 종료했습니다.'));
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onError);
        ws.addEventListener('close', onClose);
        timer = setTimeout(() => finish(new Error('브라우저 연결 시간 초과: 브라우저의 연결 승인 창을 확인하세요.')), CONNECT_TIMEOUT_MS);
      });
      const client = createClient(ws, url, state);
      const version = await client.request('Browser.getVersion');
      const edge = /^Edg\//.test(version.product || '') || /\bEdg\//.test(version.userAgent || '');
      const matches = state.browser === 'default' ||
        (state.browser === 'edge' ? edge : !edge && /^Chrome\//.test(version.product || ''));
      if (!matches) throw new Error('설정된 폴더에 연결된 브라우저 종류가 요청과 일치하지 않습니다.');
      if (shuttingDown) { client.close(); throw new Error('MCP 서버가 종료 중입니다.'); }
      client.version = version;
      state.client = client;
      log(`기존 브라우저에 연결: ${version.product || '브라우저'}`);
      return client;
    } catch (error) {
      try { ws.close(); } catch { /* 정리 중 오류는 무시합니다. */ }
      throw new Error(`${error.message} 브라우저의 원격 디버깅 설정과 연결 승인 여부를 확인하세요.`);
    }
  })();

  try { return await state.connecting; }
  finally { state.connecting = null; }
}

/** 브라우저가 노출한 기존 페이지 타깃을 조회합니다. 어떠한 탭도 생성하지 않습니다. */
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
 * 브라우저가 기본 컨텍스트 ID를 제공하지 않으면 유일하게 남은 그룹일 때만 선택합니다.
 * 사용자 시크릿 창과 다른 프로필을 명확히 구분할 수 없으면 추측하지 않습니다.
 */
function findNormalContext(pages, info, normalContextId) {
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
async function connectBrowser({ mode = 'normal', pageId, browser } = {}) {
  if (!['normal', 'incognito'].includes(mode)) {
    throw new Error('mode는 normal 또는 incognito여야 합니다.');
  }
  validatePageId(pageId);
  const state = stateFor(browser);
  const wasConnected = Boolean(state.client?.isOpen);
  const client = await ensureConnection(state);
  const target = await selectContext(state, client, mode, pageId);
  activeBrowser = state;
  return {
    status: wasConnected ? 'already_connected' : 'connected',
    ...target,
    browser: client.version.product,
    userAgent: client.version.userAgent,
  };
}

async function selectContext(state, client, mode, pageId) {
  const pages = await getExistingPages(client);
  if (pages.length === 0) {
    throw new Error('브라우저에서 CDP로 접근할 수 있는 기존 탭을 찾지 못했습니다.');
  }
  const info = await getContextInfo(client);
  const { normalContextId } = state;
  const verifiedNormalId = findNormalContext(pages, info, normalContextId);
  const explicitPage = pageId ? pages.find((page) => page.targetId === pageId) : null;
  if (pageId && !explicitPage) {
    throw new Error(`브라우저에서 해당 탭을 찾지 못했습니다: ${pageId}. list_pages의 scope=all로 확인하세요.`);
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
      throw new Error('일반 프로필을 자동으로 구분할 수 없습니다. list_pages(scope=all)로 탭 ID를 확인한 후 connect_browser(mode=normal, pageId=...)으로 지정하세요.');
    }
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
        throw new Error('기본 프로필과 시크릿 프로필을 구분할 수 없습니다. list_pages(scope=all)로 기존 시크릿 탭의 ID를 확인한 뒤 connect_browser(mode=incognito, pageId=...)으로 지정하세요.');
      }
      const others = [...new Set(pages
        .map((page) => page.browserContextId)
        .filter((id) => id && id !== baseId))];
      if (others.length !== 1) {
        throw new Error(others.length === 0
          ? 'CDP에서 일반 프로필과 구별되는 기존 시크릿 탭을 찾지 못했습니다. 브라우저에서 시크릿 창을 열고 재시도하세요. 시크릿 탭이 CDP에 노출되지 않으면 자동 연결할 수 없습니다.'
          : '일반 프로필 외 여러 컨텍스트가 있어 시크릿 탭을 자동 확정할 수 없습니다. list_pages(scope=all)에서 ID를 확인해 pageId로 지정하세요.');
      }
      contextId = others[0];
    }
  }

  if (!pages.some((page) => page.browserContextId === contextId)) {
    throw new Error('선택한 프로필에 접근 가능한 기존 탭이 없습니다.');
  }
  // 성공한 경우에만 작업 모드를 교체하며, 시크릿 창을 생성하거나 종료하지 않습니다.
  if (state.client !== client) throw new Error('브라우저 CDP 연결이 종료되었습니다.');
  const previousContext = state.contextId;
  state.contextId = contextId;
  state.mode = mode;
  if (mode === 'normal') state.normalContextId = contextId;
  if (previousContext && previousContext !== contextId) {
    await Promise.all([...state.activities.values()].map((activity) => activity.stop()));
  }
  return {
    mode,
    pageCount: pages.filter((page) => page.browserContextId === contextId).length,
    identification,
    note: identification === 'manual'
      ? '요청하신 기존 탭의 컨텍스트에 연결했습니다. 브라우저가 시크릿 여부를 명시적으로 제공하지 않아 탭의 모드 자체는 검증하지 못했습니다.'
      : mode === 'normal'
        ? '기존 일반 탭에 연결했습니다. 새 탭이나 창을 생성하지 않았습니다.'
        : '일반 프로필과 다른 기존 컨텍스트의 탭에 연결했습니다. 시크릿 여부는 브라우저의 CDP 정보만으로 확정할 수 없습니다.',
  };
}

async function getPageTargets(state, client) {
  if (!state.contextId) await selectContext(state, client, 'normal');
  const pages = await getExistingPages(client);
  return pages.filter((page) => page.browserContextId === state.contextId);
}

async function listPages({ scope = 'selected', browser } = {}) {
  if (!['selected', 'all'].includes(scope)) {
    throw new Error('scope는 selected 또는 all이어야 합니다.');
  }
  const state = stateFor(browser);
  const client = await ensureConnection(state);
  const pages = scope === 'all' ? await getExistingPages(client) : await getPageTargets(state, client);
  return pages.map(({ targetId, title, url, browserContextId }) => ({
    id: targetId,
    title,
    url,
    ...(scope === 'all' ? { browserContextId: browserContextId || null } : {}),
  }));
}

async function resolvePage(pageId, browser) {
  validatePageId(pageId);
  const state = stateFor(browser);
  const client = await ensureConnection(state);
  const pages = await getPageTargets(state, client);
  const page = pageId ? pages.find((target) => target.targetId === pageId) : pages[0];
  if (!page) {
    throw new Error(pageId
      ? `현재 ${state.mode} 모드에서 접근할 수 없는 탭입니다: ${pageId}`
      : `현재 ${state.mode} 모드에 사용 가능한 탭이 없습니다.`);
  }
  return { state, client, page };
}

function resolveRequiredPage(pageId, browser) {
  if (pageId === undefined) throw new Error('pageId가 필요합니다.');
  return resolvePage(pageId, browser);
}

async function openPageSession(client, pageId) {
  const { sessionId } = await client.request('Target.attachToTarget', { targetId: pageId, flatten: true });
  if (!sessionId) throw new Error('브라우저가 CDP 페이지 세션을 생성하지 않았습니다.');
  let attached = true;
  return {
    pageId,
    send(method, params, timeoutMs) { return client.request(method, params, sessionId, timeoutMs); },
    watch(onEvent, onClose) {
      client.watch(sessionId, onEvent, () => { attached = false; onClose(); });
    },
    async close() {
      if (!attached) return;
      attached = false;
      client.unwatch(sessionId);
      if (!client.isOpen) return;
      try { await client.request('Target.detachFromTarget', { sessionId }, undefined, 2000); }
      catch { /* 이동 중 탭이 닫혔을 수 있습니다. */ }
    },
  };
}

async function withPageSession(pageId, browser, operation) {
  const { client, page } = await resolvePage(pageId, browser);
  const session = await openPageSession(client, page.targetId);
  try { return await operation(session); }
  finally { await session.close(); }
}

function validateNavigationUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('url이 필요합니다.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('유효한 절대 URL을 입력하세요.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) && url !== 'about:blank') {
    throw new Error('현재 버전에서는 http://, https://, about:blank만 허용합니다.');
  }
  return parsed;
}

async function navigatePage({ url, pageId, browser } = {}) {
  validateNavigationUrl(url);
  return withPageSession(pageId, browser, async (page) => {
    const result = await page.send('Page.navigate', { url });
    if (result.errorText) throw new Error(result.errorText);
    return { pageId: page.pageId, url, frameId: result.frameId,
      note: '페이지 이동을 시작했습니다. 실제 로딩은 아직 진행 중일 수 있습니다.' };
  });
}

async function evaluateScript({ expression, pageId, browser } = {}) {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('expression이 필요합니다.');
  return withPageSession(pageId, browser, async (page) => {
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

async function newPage({ url = 'about:blank', browser } = {}) {
  validateNavigationUrl(url);
  const state = stateFor(browser);
  const client = await ensureConnection(state);
  if (!state.contextId) await selectContext(state, client, 'normal');
  if (state.mode !== 'normal' || !state.contextId) {
    throw new Error('새 탭을 열려면 일반 프로필에 연결하세요.');
  }
  const { targetId } = await client.request('Target.createTarget', { url, browserContextId: state.contextId });
  if (!targetId) throw new Error('브라우저에서 새 탭 ID를 받지 못했습니다.');
  activeBrowser = state;
  return { pageId: targetId, url };
}

async function takeScreenshot({ pageId, browser } = {}) {
  if (pageId === undefined) throw new Error('pageId가 필요합니다.');
  return withPageSession(pageId, browser, async (page) => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (!data || data.length > 8 * 1024 * 1024) throw new Error('스크린샷을 받지 못했거나 반환 크기 제한을 초과했습니다.');
    return { content: [{ type: 'image', data, mimeType: 'image/png' }], isError: false };
  });
}

function startPageActivity(key, { state, client, page }, enable, onEvent, data = null) {
  const pageActivities = state.activities;
  if (pageActivities.has(key)) throw new Error('이 탭에서 해당 기능이 이미 실행 중입니다.');
  if (pageActivities.size >= 24) throw new Error('탭 수집 한도에 도달했습니다. 사용 중인 수집을 종료하세요.');
  const activity = {
    data,
    timer: null,
    session: null,
    forget() {
      if (pageActivities.get(key) === activity) pageActivities.delete(key);
      clearTimeout(activity.timer);
    },
    async stop() {
      activity.forget();
      await activity.session?.close();
    },
  };
  pageActivities.set(key, activity);
  activity.ready = (async () => {
    try {
      activity.session = await openPageSession(client, page.targetId);
      if (pageActivities.get(key) !== activity || state.client !== client || state.contextId !== page.browserContextId) {
        throw new Error('탭의 연결 범위가 변경되었습니다.');
      }
      activity.session.watch((event) => onEvent(activity, event), activity.forget);
      await enable(activity);
      return activity;
    } catch (error) {
      await activity.stop();
      throw error;
    }
  })();
  return activity.ready;
}

function rememberConsole(messages, { method, params }) {
  let entry;
  if (method === 'Runtime.consoleAPICalled') {
    const message = (params.args || []).slice(0, 10).map((arg) => {
      if (['string', 'number', 'boolean'].includes(typeof arg.value)) return String(arg.value).slice(0, 500);
      return arg.unserializableValue || arg.subtype || arg.type;
    }).join(' ');
    entry = { level: params.type, message, timestamp: params.timestamp };
  } else if (method === 'Runtime.exceptionThrown') {
    const exception = params.exceptionDetails;
    entry = {
      level: 'error',
      message: (exception.exception?.description || exception.text || '').split('\n', 1)[0],
      timestamp: params.timestamp,
    };
  } else {
    return;
  }
  entry.message = entry.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
  messages.push(entry);
  if (messages.length > 100) messages.shift();
}

function rememberNetwork(requests, { method, params }) {
  if (method === 'Network.requestWillBeSent') {
    let url;
    try { url = new URL(params.request.url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (requests.has(params.requestId)) requests.delete(params.requestId);
    if (requests.size >= 100) requests.delete(requests.keys().next().value);
    requests.set(params.requestId, {
      method: params.request.method.slice(0, 16),
      url: (url.origin + url.pathname).slice(0, 300),
      status: null,
      durationMs: null,
      startedAt: params.timestamp,
    });
    return;
  }
  const request = requests.get(params.requestId);
  if (!request) return;
  if (method === 'Network.responseReceived') {
    request.status = params.response.status;
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    request.durationMs = Math.max(0, Math.round((params.timestamp - request.startedAt) * 1000));
    if (method === 'Network.loadingFailed') request.failed = true;
  }
}

async function startConsoleCapture({ pageId, browser } = {}) {
  const selection = await resolveRequiredPage(pageId, browser);
  const pageActivities = selection.state.activities;
  const key = `console:${pageId}`;
  const current = pageActivities.get(key);
  if (current) {
    await current.ready;
  } else {
    const startedAt = Date.now();
    await startPageActivity(
      key, selection, ({ session }) => session.send('Runtime.enable'),
      ({ data }, event) => {
        if (event.params.timestamp >= startedAt) rememberConsole(data, event);
      }, [],
    );
  }
  return { pageId, capturing: pageActivities.has(key) };
}

function validateCaptureOptions(limit, stop) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit은 1부터 50까지의 정수여야 합니다.');
  if (typeof stop !== 'boolean') throw new Error('stop은 불리언이어야 합니다.');
}

async function listConsoleMessages({ pageId, limit = 20, stop = false, browser } = {}) {
  validateCaptureOptions(limit, stop);
  const { state } = await resolveRequiredPage(pageId, browser);
  const pageActivities = state.activities;
  const key = `console:${pageId}`;
  const activity = await pageActivities.get(key)?.ready;
  const messages = activity?.data.slice(-limit) || [];
  if (stop) await activity?.stop();
  return { pageId, capturing: pageActivities.has(key), messages };
}

async function listNetworkRequests({ pageId, limit = 20, stop = false, browser } = {}) {
  validateCaptureOptions(limit, stop);
  const selection = await resolveRequiredPage(pageId, browser);
  const pageActivities = selection.state.activities;
  const key = `network:${pageId}`;
  const existing = pageActivities.get(key);
  let activity;
  if (existing) activity = await existing.ready;
  else if (!stop) {
    activity = await startPageActivity(
      key, selection, ({ session }) => session.send('Network.enable'),
      ({ data }, event) => rememberNetwork(data, event), new Map(),
    );
  }
  const requests = activity ? [...activity.data.values()].slice(-limit).map(({ startedAt, ...request }) => request) : [];
  if (stop) await activity?.stop();
  return { pageId, capturing: pageActivities.has(key), requests };
}

async function mockApiResponse({ pageId, url, status = 200, body, browser } = {}) {
  const target = validateNavigationUrl(url);
  if (!['http:', 'https:'].includes(target.protocol) ||
      !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.hash) {
    throw new Error('모의 응답은 루프백 주소의 HTTP API URL만 지원합니다.');
  }
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error('status는 200부터 599까지의 정수여야 합니다.');
  }
  const emptyResponse = [204, 205, 304].includes(status);
  if (emptyResponse && body !== null) throw new Error('이 상태 코드의 body는 null이어야 합니다.');
  const json = JSON.stringify(body);
  if (json === undefined || Buffer.byteLength(json) > 65536) {
    throw new Error('body에는 64 KiB 이하의 JSON 값을 지정하세요.');
  }
  const selection = await resolveRequiredPage(pageId, browser);
  const pageActivities = selection.state.activities;
  if (new URL(selection.page.url).origin !== target.origin) {
    throw new Error('선택한 탭과 모의 API는 같은 로컬 오리진이어야 합니다.');
  }

  const expiresInMs = 30_000;
  const key = `mock:${pageId}`;
  const urlPattern = target.href.replace(/[\\*?]/g, '\\$&');
  let matched = false;
  await startPageActivity(key, selection, (activity) => {
    activity.timer = setTimeout(() => { void activity.stop(); }, expiresInMs);
    return activity.session.send('Fetch.enable', {
      patterns: ['Fetch', 'XHR'].map((resourceType) => ({ urlPattern, resourceType })),
    });
  }, (activity, event) => {
    if (event.method !== 'Fetch.requestPaused') return;
    const { request, requestId } = event.params;
    const match = !matched && request.method === 'GET' && request.url === target.href;
    if (match) matched = true;
    const finish = async () => {
      try {
        if (match) {
          await activity.session.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: status,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' },
              { name: 'X-Content-Type-Options', value: 'nosniff' },
            ],
            ...(emptyResponse ? {} : { body: Buffer.from(json).toString('base64') }),
          }, 3000);
        } else {
          await activity.session.send('Fetch.continueRequest', { requestId }, 3000);
        }
      } catch {
        await activity.stop();
        return;
      }
      if (match) await activity.stop();
    };
    void finish();
  });
  return { pageId, status, armed: pageActivities.has(key), expiresInMs };
}

const tools = [
  {
    name: 'connect_browser',
    description: '로컬 Chrome 또는 Edge의 기존 탭에 연결합니다. 설정한 전용 브라우저가 꺼져 있으면 시작합니다. normal은 일반 탭, incognito는 기존 비공개 탭을 대상으로 합니다. 자동 구분이 어려우면 pageId로 지정할 수 있습니다.',
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
  {
    name: 'new_page',
    description: '선택한 일반 브라우저 프로필에 새 탭을 열고 pageId를 반환합니다. 기본 주소는 about:blank입니다.',
    inputSchema: {
      type: 'object', properties: {
        url: { type: 'string', description: '이동할 절대 URL(http://, https:// 또는 about:blank)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'take_screenshot',
    description: '지정한 탭의 현재 화면을 PNG 이미지로 반환합니다.',
    inputSchema: {
      type: 'object', properties: {
        pageId: { type: 'string', minLength: 1, description: '선택한 컨텍스트의 탭 ID' },
      },
      required: ['pageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_console_capture',
    description: '지정한 탭에서 콘솔 메시지와 JavaScript 예외 수집을 시작합니다.',
    inputSchema: {
      type: 'object', properties: {
        pageId: { type: 'string', minLength: 1, description: '선택한 컨텍스트의 탭 ID' },
      },
      required: ['pageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_console_messages',
    description: '수집한 최근 콘솔 메시지와 JavaScript 예외를 반환합니다. stop으로 수집을 종료합니다.',
    inputSchema: {
      type: 'object', properties: {
        pageId: { type: 'string', minLength: 1, description: '선택한 컨텍스트의 탭 ID' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        stop: { type: 'boolean', default: false, description: '현재 기록을 반환하고 수집을 종료합니다.' },
      },
      required: ['pageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_network_requests',
    description: '첫 호출에서 지정한 탭의 네트워크 요약 수집을 시작합니다. 이후 호출로 기록을 조회하고 stop으로 수집을 종료합니다.',
    inputSchema: {
      type: 'object', properties: {
        pageId: { type: 'string', minLength: 1, description: '선택한 컨텍스트의 탭 ID' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        stop: { type: 'boolean', default: false, description: '현재 기록을 반환하고 수집을 종료합니다.' },
      },
      required: ['pageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'mock_api_response',
    description: '같은 루프백 오리진의 정확한 API URL에 30초 동안 한 번의 GET 모의 JSON 응답을 준비합니다.',
    inputSchema: {
      type: 'object', properties: {
        pageId: { type: 'string', minLength: 1, description: '선택한 컨텍스트의 탭 ID' },
        url: { type: 'string', description: '같은 로컬 오리진의 API URL' },
        status: { type: 'integer', minimum: 200, maximum: 599, default: 200 },
        body: { description: '반환할 JSON 값. 응답 본문을 가질 수 없는 상태 코드에서는 null.' },
      },
      required: ['pageId', 'url', 'body'],
      additionalProperties: false,
    },
  },
].map((tool) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: {
      ...tool.inputSchema.properties,
      browser: { type: 'string', enum: ['chrome', 'edge'], description: '연결할 브라우저. 생략하면 현재 선택을 사용합니다.' },
    },
  },
}));

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
      case 'connect_browser': result = await connectBrowser(args); break;
      case 'list_pages': result = await listPages(args); break;
      case 'navigate_page': result = await navigatePage(args); break;
      case 'evaluate_script': result = await evaluateScript(args); break;
      case 'new_page': result = await newPage(args); break;
      case 'take_screenshot': reply(id, await takeScreenshot(args)); return;
      case 'start_console_capture': result = await startConsoleCapture(args); break;
      case 'list_console_messages': result = await listConsoleMessages(args); break;
      case 'list_network_requests': result = await listNetworkRequests(args); break;
      case 'mock_api_response': result = await mockApiResponse(args); break;
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
  for (const state of browserStates.values()) {
    for (const activity of state.activities.values()) activity.forget();
    state.client?.close();
  }
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
