# browser-devtools-mcp-zero

**외부 npm 패키지 0개.** Google Chrome과 Microsoft Edge에서 동작을 검증한 단일 파일 DevTools MCP 서버입니다.

Node.js 내장 API로 Chrome DevTools Protocol(CDP)에 연결하는 독립 프로젝트입니다.

**폐쇄망에서도 사용할 수 있습니다.** Node.js와 Chrome 또는 Edge가 설치되어 있으면 인터넷 연결이나 `npm install` 없이 MCP 서버를 실행할 수 있습니다. 같은 PC의 브라우저에 연결해 로컬 페이지와 사내 웹앱을 디버깅할 수 있습니다.

에이전트까지 폐쇄망에서 사용하려면 MCP 클라이언트와 모델도 해당 환경에서 동작해야 합니다.

## 실행 환경

- Node.js 내장 `WebSocket`이 필요합니다. 이 API는 Node.js 22.4.0에서 안정화되었습니다. [Node.js WebSocket 문서](https://nodejs.org/download/release/v22.4.0/docs/api/globals.html#class-websocket)
- 원격 디버깅을 활성화한 로컬 Chrome 또는 Edge와 로그인하지 않은 전용 사용자 데이터 폴더가 필요합니다.
- MCP 클라이언트는 로컬 프로세스를 `stdio`로 실행할 수 있어야 합니다.

Windows와 Node.js 24.19.0에서 Chrome 157.0.8103.51, Edge 158.0.4370.33의 전용 일반 프로필로 검증했습니다.

## 전용 브라우저 시작

### Chrome 설정으로 켜기

Chrome 144 이상에서 사용할 수 있습니다. 아래 예시의 `--user-data-dir` 옵션으로 로그인하지 않은 전용 Chrome을 실행합니다.

```powershell
$zeroBrowserData = Join-Path $env:TEMP 'browser-devtools-mcp-zero-profile'
& 'C:/Program Files/Google/Chrome/Application/chrome.exe' "--user-data-dir=$zeroBrowserData" 'about:blank'
$zeroBrowserData
```

1. 전용 Chrome의 주소창에 `chrome://inspect/#remote-debugging`을 입력합니다.
2. 원격 디버깅을 활성화합니다.
3. 아래 예시대로 같은 폴더를 `BROWSER_USER_DATA_DIR`에 지정하고 MCP 클라이언트에서 `connect_browser`를 호출합니다.
4. Chrome에 연결 승인 창이 나타나면 테스트 전용 Chrome인지 확인한 뒤 **허용**을 누릅니다.

[Chrome의 연결 승인 절차](https://developer.chrome.com/docs/devtools/agents/get-started/configuration/#automatic-connection-chrome-144)

### Chrome 실행 옵션으로 켜기

Windows PowerShell 예시입니다. Chrome이 다른 폴더에 설치되어 있으면 실행 파일 경로를 바꿉니다.

```powershell
$zeroBrowserData = Join-Path $env:TEMP 'browser-devtools-mcp-zero-profile'
& 'C:/Program Files/Google/Chrome/Application/chrome.exe' `
  "--user-data-dir=$zeroBrowserData" '--remote-debugging-port=0' 'about:blank'
$zeroBrowserData
```

Chrome이 전용 폴더에 만든 `DevToolsActivePort`를 서버가 읽고 `127.0.0.1`로 연결합니다. Chrome 실행과 종료는 사용자가 관리합니다. [Chrome 원격 디버깅 안내](https://developer.chrome.com/blog/remote-debugging-port)

### Edge 실행 옵션으로 켜기

Windows PowerShell에서 로그인하지 않은 전용 Edge를 실행합니다. Edge 설치 경로가 다르면 실행 파일 경로를 바꿉니다.

```powershell
$zeroBrowserData = Join-Path $env:TEMP 'browser-devtools-mcp-zero-edge-profile'
& 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' `
  "--user-data-dir=$zeroBrowserData" '--remote-debugging-port=0' 'about:blank'
$zeroBrowserData
```

실행 결과에 나온 폴더 경로를 `BROWSER_USER_DATA_DIR`에 지정한 뒤 `connect_browser`를 호출합니다. 서버가 이 폴더의 `DevToolsActivePort`를 읽어 `127.0.0.1`로 연결합니다. [Microsoft Edge 원격 디버깅 안내](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/#using-the-devtools-protocol)

## MCP 등록

이전에 등록한 MCP 설정은 아래 예시에 맞춰 실행 파일 경로와 환경변수 이름을 업데이트하세요. 연결에는 `connect_browser`를 사용합니다.

JSON `mcpServers` 형식을 사용하는 클라이언트의 Edge 등록 예시입니다. 실행 파일 경로는 실제 파일 경로로 바꿉니다. `BROWSER_USER_DATA_DIR`에는 위에서 선택한 브라우저에 지정한 `$zeroBrowserData`의 실제 경로를 입력합니다. Chrome과 Edge를 함께 사용할 때는 브라우저별로 MCP 항목과 데이터 폴더를 하나씩 지정합니다.

```json
{
  "mcpServers": {
    "browser-devtools-mcp-zero": {
      "command": "node",
      "args": ["C:/path/to/browser-devtools-mcp-zero/browser-devtools-mcp.js"],
      "env": {
        "BROWSER_USER_DATA_DIR": "C:/Users/you/AppData/Local/Temp/browser-devtools-mcp-zero-edge-profile"
      }
    }
  }
}
```

## 도구

| 도구 | 기능 |
| --- | --- |
| `connect_browser` | 실행 중인 Chrome 또는 Edge의 기존 탭에 연결합니다. `mode` 기본값은 `normal`입니다. |
| `list_pages` | 선택한 컨텍스트의 탭과 URL을 조회합니다. `scope=all`은 브라우저가 CDP에 노출한 전체 탭을 조회합니다. |
| `navigate_page` | 선택한 탭을 `http:`, `https:` 또는 `about:blank` URL로 이동합니다. |
| `evaluate_script` | 선택한 탭에서 JavaScript를 실행하고 결과를 반환합니다. |
| `new_page` | 선택한 일반 브라우저 프로필에 새 탭을 엽니다. 기본 주소는 `about:blank`이며, 반환된 `pageId`를 다른 도구에 넘길 수 있습니다. |
| `take_screenshot` | 지정한 탭의 현재 화면을 PNG 이미지로 반환합니다. |
| `start_console_capture` | 지정한 탭에서 콘솔 메시지와 JavaScript 오류 수집을 시작합니다. |
| `list_console_messages` | 최근 콘솔 메시지를 조회합니다. `stop: true`로 마지막 기록을 읽고 수집을 종료할 수 있습니다. |
| `list_network_requests` | 첫 호출에서 지정한 탭의 네트워크 요약 수집을 시작합니다. 이후 메서드, URL 경로, 응답 상태, 소요 시간을 조회할 수 있습니다. |
| `mock_api_response` | 지정한 로컬 테스트 API의 GET 응답 한 번을 JSON 테스트 데이터로 대체합니다. |

`navigate_page`와 `evaluate_script`를 호출할 때 `list_pages`에서 확인한 `pageId`를 지정합니다. `incognito`는 브라우저가 기존 비공개 탭의 컨텍스트를 CDP에 노출하는 조건에 따라 동작합니다. 통합 검증 범위는 Chrome과 Edge의 일반 탭입니다.

### 탭에서 오류 재현하기

1. `new_page`로 열린 탭의 `pageId`를 확인합니다.
2. `start_console_capture`와 `list_network_requests`로 해당 탭의 수집을 시작합니다.
3. `navigate_page`로 테스트 페이지를 열고 문제를 재현합니다.
4. `list_console_messages`, `list_network_requests`, `take_screenshot`으로 결과를 확인합니다.

콘솔과 네트워크는 수집을 시작한 탭별로 최근 100개를 메모리에 보관합니다. 조회는 기본 20개, 최대 50개입니다. 두 목록 도구에 `stop: true`를 넣으면 마지막 기록을 받고 수집을 종료합니다. 네트워크 목록에는 URL 쿼리, 헤더, 쿠키, 요청·응답 본문을 포함하지 않습니다.

API 모의 응답에는 현재 탭과 같은 오리진의 `127.0.0.1` 또는 `[::1]` 주소를 사용합니다. `pageId`, 정확한 API `url`, 반환할 JSON `body`를 지정합니다. `status`의 기본값은 `200`입니다. 설정 후 30초 안에 발생한 첫 일치 GET 요청에 적용됩니다.

## 연결 권한

연결을 허용한 MCP 클라이언트는 해당 탭을 읽거나 변경할 수 있습니다. 탭 주소와 스크립트 결과, 조회한 로그와 화면은 MCP 클라이언트에 전달되며, 클라이언트 설정에 따라 외부 모델에도 전달될 수 있습니다. 서버는 `BROWSER_USER_DATA_DIR`에 명시한 사용자 데이터 폴더의 디버깅 연결 정보만 읽습니다. 위 예시처럼 로그인하지 않은 전용 폴더를 지정하고 로컬 테스트 페이지에서 시작하세요. [Chrome 디버깅 연결 안내](https://developer.chrome.com/docs/devtools/agents/get-started/configuration/)

## 확인 방법

```sh
node --check browser-devtools-mcp.js
node --test test/smoke.test.cjs
```

`stdio` 테스트는 MCP 초기화, 도구 목록, 오류 응답, 경로 미설정 시 연결 차단을 확인합니다. 전용 Chrome·Edge 프로필과 로컬 테스트 페이지에서 기본 도구, 새 탭, PNG, 콘솔·네트워크 수집, 일회성 API 모의 응답을 확인했습니다.

## 라이선스

MIT 라이선스를 적용합니다. [라이선스 전문](LICENSE)
