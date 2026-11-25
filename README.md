# browser-devtools-mcp-zero

**외부 npm 패키지 0개.** Google Chrome과 Microsoft Edge에서 동작을 검증한 단일 파일 DevTools MCP 서버입니다.

Node.js 내장 API로 Chrome DevTools Protocol(CDP)에 연결하는 독립 프로젝트입니다.

**폐쇄망에서도 사용할 수 있습니다.** Node.js와 Chrome 또는 Edge가 설치되어 있으면 인터넷 연결이나 `npm install` 없이 MCP 서버를 실행할 수 있습니다. 같은 PC의 브라우저에 연결해 로컬 페이지와 사내 웹앱을 디버깅할 수 있습니다.

에이전트까지 폐쇄망에서 사용하려면 MCP 클라이언트와 모델도 해당 환경에서 동작해야 합니다.

## 실행 환경

- Node.js 내장 `WebSocket`이 필요합니다. 이 API는 Node.js 22.4.0에서 안정화되었습니다. [Node.js WebSocket 문서](https://nodejs.org/download/release/v22.4.0/docs/api/globals.html#class-websocket)
- 로컬 Chrome 또는 Edge와 원격 디버깅을 활성화한 브라우저 프로필이 필요합니다.
- MCP 클라이언트는 로컬 프로세스를 `stdio`로 실행할 수 있어야 합니다.

Windows와 Node.js 24.19.0에서 Chrome 157.0.8103.51, Edge 158.0.4370.33의 전용 일반 프로필로 검증했습니다.

## Chrome과 Edge의 기존 프로필 사용

MCP를 한 번 등록한 뒤 `connect_browser`나 `new_page`에서 `browser: "chrome"` 또는 `browser: "edge"`를 선택합니다. 경로 설정이 비어 있으면 브라우저의 기본 사용자 데이터 폴더를 사용합니다.

Windows 안정 버전의 기본 폴더는 다음과 같습니다.

- Chrome `%LOCALAPPDATA%\Google\Chrome\User Data`
- Edge `%LOCALAPPDATA%\Microsoft\Edge\User Data`

예를 들어 `new_page`에 `{"browser":"edge","url":"about:blank"}`를 전달하면 Edge에서 새 탭을 엽니다. 마지막으로 연결하거나 탭을 연 브라우저가 다음 호출의 기본값입니다. 다른 도구에서도 `browser`를 지정해 대상을 선택할 수 있습니다.

### 기존 프로필에서 원격 디버깅 켜기

- **Chrome 144 이상** `chrome://inspect/#remote-debugging`을 열고 원격 디버깅을 활성화합니다. [Chrome 연결 승인 안내](https://developer.chrome.com/docs/devtools/agents/get-started/configuration/#automatic-connection-chrome-144)
- **Microsoft Edge** `edge://inspect/#remote-debugging`을 열고 원격 디버깅을 활성화합니다. [Edge 연결 안내](https://learn.microsoft.com/en-us/microsoft-edge/web-ai/devtools-mcp-server#option-b-use-edgeinspect-to-enable-remote-debugging)

연결할 수 없으면 MCP가 기존 프로필로 브라우저의 디버깅 설정 화면을 엽니다. 원격 디버깅을 켠 뒤 다시 호출하고, 브라우저에 연결 승인 창이 표시되면 **허용**을 누릅니다.

### 다른 데이터 폴더를 쓰는 경우

기존에 기본 위치 외의 폴더를 사용 중이라면 `browser-devtools-mcp.js` 옆의 `.env.local` 또는 MCP 환경변수에 `BROWSER_CHROME_USER_DATA_DIR`이나 `BROWSER_EDGE_USER_DATA_DIR`을 지정할 수 있습니다. 환경변수 값이 파일 값보다 우선합니다. 이전에 테스트 폴더 경로를 등록했다면 해당 값을 제거하면 기본 폴더를 사용합니다.

브라우저 실행 파일을 Windows 기본 설치 경로에서 찾을 수 없으면 `BROWSER_CHROME_EXECUTABLE` 또는 `BROWSER_EDGE_EXECUTABLE`에 실행 파일의 절대 경로를 지정합니다. 기존 `BROWSER_USER_DATA_DIR` 설정은 실행 중인 브라우저 한 개에 연결하는 데 사용할 수 있습니다.

## MCP 등록

JSON `mcpServers` 형식을 사용하는 클라이언트의 등록 예시입니다. 실행 파일 경로를 실제 경로로 바꿉니다. 기본 프로필을 사용할 때는 사용자 데이터 폴더를 별도로 입력할 필요가 없습니다. MCP 항목 하나로 Chrome과 Edge를 선택할 수 있습니다.

```json
{
  "mcpServers": {
    "browser-devtools-mcp-zero": {
      "command": "node",
      "args": ["C:/path/to/browser-devtools-mcp-zero/browser-devtools-mcp.js"]
    }
  }
}
```

## 도구

| 도구 | 기능 |
| --- | --- |
| `connect_browser` | `browser`로 Chrome 또는 Edge를 선택하고 기존 탭에 연결합니다. 필요하면 기존 프로필로 브라우저를 시작합니다. `mode` 기본값은 `normal`입니다. |
| `list_pages` | 선택한 컨텍스트의 탭과 URL을 조회합니다. `scope=all`은 브라우저가 CDP에 노출한 전체 탭을 조회합니다. |
| `navigate_page` | 선택한 탭을 `http:`, `https:` 또는 `about:blank` URL로 이동합니다. |
| `evaluate_script` | 선택한 탭에서 JavaScript를 실행하고 결과를 반환합니다. |
| `new_page` | `browser`로 지정한 브라우저의 일반 프로필에 새 탭을 엽니다. 기본 주소는 `about:blank`이며, 반환된 `pageId`를 다른 도구에 넘길 수 있습니다. |
| `take_screenshot` | 지정한 탭을 캡처합니다. `output: "file"`로 PNG를 저장하고 절대 경로를 받을 수 있습니다. |
| `start_console_capture` | 지정한 탭에서 콘솔 메시지와 JavaScript 오류 수집을 시작합니다. |
| `list_console_messages` | 최근 콘솔 메시지를 조회합니다. `stop: true`로 마지막 기록을 읽고 수집을 종료할 수 있습니다. |
| `list_network_requests` | 첫 호출에서 지정한 탭의 네트워크 요약 수집을 시작합니다. 이후 메서드, URL 경로, 응답 상태, 소요 시간을 조회할 수 있습니다. |
| `mock_api_response` | 네트워크 목록의 요청 ID 또는 URL로 로컬 테스트 API를 선택해 다음 GET 응답 한 번을 JSON으로 대체합니다. |

`navigate_page`와 `evaluate_script`를 호출할 때 `list_pages`에서 확인한 `pageId`를 지정합니다. `incognito`는 브라우저가 기존 비공개 탭의 컨텍스트를 CDP에 노출하는 조건에 따라 동작합니다. 통합 검증 범위는 Chrome과 Edge의 일반 탭입니다.

### 탭에서 오류 재현하기

1. `new_page`로 열린 탭의 `pageId`를 확인합니다.
2. `start_console_capture`와 `list_network_requests`로 해당 탭의 수집을 시작합니다.
3. `navigate_page`로 테스트 페이지를 열고 문제를 재현합니다.
4. `list_console_messages`, `list_network_requests`, `take_screenshot`으로 결과를 확인합니다.

콘솔과 네트워크는 수집을 시작한 탭별로 최근 100개를 메모리에 보관합니다. 조회는 기본 20개, 최대 50개입니다. 두 목록 도구에 `stop: true`를 넣으면 마지막 기록을 받고 수집을 종료합니다. 네트워크 목록에는 URL 쿼리, 헤더, 쿠키, 요청·응답 본문을 포함하지 않습니다.

### 스크린샷을 로컬 파일로 저장하기

이미지를 표시하기 어려운 클라이언트에서는 `take_screenshot`에 `output: "file"`을 지정합니다. 서버가 PNG를 저장하고 절대 경로를 텍스트로 반환합니다. 기본 저장 폴더는 실행 파일 옆 `screenshots/`이며, `BROWSER_SCREENSHOT_DIR`에 다른 로컬 폴더를 지정할 수 있습니다. `output`을 생략하면 PNG 이미지가 MCP 응답으로 반환됩니다.

### 네트워크 목록에서 API 응답 바꾸기

1. 로컬 테스트 탭에서 `list_network_requests`로 수집을 시작한 뒤 API 요청을 발생시킵니다.
2. 같은 탭에서 다시 조회해 `mockable: true`인 요청의 `requestId`를 선택합니다.
3. `mock_api_response`에 같은 `pageId`, 선택한 `requestId`, 원하는 JSON `body`를 넣습니다. `status` 기본값은 `200`입니다.
4. 앱에서 같은 API 요청을 다시 발생시킵니다. 30초 안에 들어온 첫 일치 요청에 모의 응답이 적용됩니다.

요청 ID는 해당 탭의 수집을 유지하는 동안 사용할 수 있습니다. 주소를 알고 있다면 `requestId` 대신 정확한 `url`을 지정할 수도 있습니다. 적용 대상은 현재 탭과 같은 오리진의 `127.0.0.1` 또는 `[::1]`을 사용하는 GET API입니다. 요청을 가로챈 브라우저 탭에 지정한 JSON 응답을 전달합니다.

## 연결 권한

연결을 허용한 MCP 클라이언트는 해당 탭을 읽거나 변경할 수 있습니다. 탭 주소와 스크립트 결과, 조회한 로그와 화면은 MCP 클라이언트에 전달되며, 클라이언트 설정에 따라 외부 모델에도 전달될 수 있습니다. 서버는 선택한 사용자 데이터 폴더의 디버깅 연결 정보를 읽습니다. 기존 프로필을 연결할 때는 로그인한 탭에도 에이전트가 접근할 수 있으므로, 신뢰하는 MCP 클라이언트에서 연결을 승인하세요. [Chrome 디버깅 연결 안내](https://developer.chrome.com/docs/devtools/agents/get-started/configuration/)

## 확인 방법

```sh
node --check browser-devtools-mcp.js
node --test test/smoke.test.cjs
```

`stdio` 테스트는 MCP 초기화, 도구 목록, 오류 응답, 경로 미설정 시 연결 차단을 확인합니다. 전용 Chrome·Edge 프로필과 로컬 테스트 페이지에서 기본 도구, 새 탭, PNG, 콘솔·네트워크 수집, 일회성 API 모의 응답을 확인했습니다.

## 라이선스

MIT 라이선스를 적용합니다. [라이선스 전문](LICENSE)
