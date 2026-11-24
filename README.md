# chrome-devtools-mcp-zero

**외부 npm 패키지 0개.** Node.js 내장 API로 Chrome DevTools Protocol(CDP)에 연결하는 단일 파일 MCP 서버입니다.

Google Chrome의 개발자 도구 프로토콜을 사용하는 독립 프로젝트입니다.

## 실행 환경

- Node.js 내장 `WebSocket`이 필요합니다. 이 API는 Node.js 22.4.0에서 안정화되었습니다. [Node.js WebSocket 문서](https://nodejs.org/download/release/v22.4.0/docs/api/globals.html#class-websocket)
- 원격 디버깅을 활성화한 로컬 Chrome과 로그인하지 않은 테스트 전용 사용자 데이터 폴더가 필요합니다.
- MCP 클라이언트는 로컬 프로세스를 `stdio`로 실행할 수 있어야 합니다.

실제 검증 환경은 Windows, Node.js 24.19.0, Google Chrome 157.0.8103.51입니다.

## 전용 Chrome 시작

Windows PowerShell 예시입니다. Chrome이 다른 폴더에 설치되어 있으면 실행 파일 경로를 바꿉니다.

```powershell
$zeroChromeData = Join-Path $env:TEMP 'chrome-devtools-mcp-zero-profile'
& 'C:/Program Files/Google/Chrome/Application/chrome.exe' `
  "--user-data-dir=$zeroChromeData" '--remote-debugging-port=0' 'about:blank'
$zeroChromeData
```

Chrome이 전용 폴더에 만든 `DevToolsActivePort`를 서버가 읽고 `127.0.0.1`로 연결합니다. Chrome 실행과 종료는 사용자가 관리합니다. [Chrome 원격 디버깅 안내](https://developer.chrome.com/blog/remote-debugging-port)

## MCP 등록

JSON `mcpServers` 형식을 사용하는 클라이언트의 예시입니다. 아래 실행 파일 경로를 실제 경로로 바꿉니다. 필수 환경변수인 `CHROME_USER_DATA_DIR`에는 Chrome에 지정한 `$zeroChromeData`의 실제 경로를 입력합니다.

```json
{
  "mcpServers": {
    "chrome-devtools-mcp-zero": {
      "command": "node",
      "args": ["C:/path/to/chrome-devtools-mcp-zero/chrome-devtools-mcp.js"],
      "env": {
        "CHROME_USER_DATA_DIR": "C:/Users/you/AppData/Local/Temp/chrome-devtools-mcp-zero-profile"
      }
    }
  }
}
```

## 도구

| 도구 | 기능 |
| --- | --- |
| `connect_chrome` | 실행 중인 Chrome의 기존 탭에 연결합니다. `mode` 기본값은 `normal`입니다. |
| `list_pages` | 선택한 컨텍스트의 탭과 URL을 조회합니다. `scope=all`은 Chrome이 CDP에 노출한 전체 탭을 조회합니다. |
| `navigate_page` | 선택한 탭을 `http:`, `https:` 또는 `about:blank` URL로 이동합니다. |
| `evaluate_script` | 선택한 탭에서 JavaScript를 실행하고 결과를 반환합니다. |

`navigate_page`와 `evaluate_script`를 호출할 때 `list_pages`에서 확인한 `pageId`를 지정합니다. `incognito`는 Chrome이 기존 시크릿 탭의 컨텍스트를 노출하는 조건에 따라 동작하며, CDP 정보만으로 시크릿 여부를 확정하기 어려운 경우가 있습니다.

## 연결 권한

연결을 허용한 MCP 클라이언트는 해당 탭을 읽거나 변경할 수 있습니다. 탭 주소와 스크립트 결과는 MCP 클라이언트에 전달되며, 클라이언트 설정에 따라 외부 모델에도 전달될 수 있습니다. 서버는 `CHROME_USER_DATA_DIR`에 명시한 사용자 데이터 폴더의 디버깅 연결 정보만 읽습니다. 위 예시처럼 로그인하지 않은 전용 폴더를 지정하고 로컬 테스트 페이지에서 시작하세요. [Chrome 디버깅 연결 안내](https://developer.chrome.com/docs/devtools/agents/get-started/configuration/)

## 확인 방법

```sh
node --check chrome-devtools-mcp.js
node --test test/smoke.test.cjs
```

`stdio` 테스트는 MCP 초기화, 네 도구 목록, 오류 응답, 경로 미설정 시 연결 차단을 확인합니다. Chrome 통합 검증은 전용 프로필의 일반 탭에서 연결, 탭 조회, 로컬 페이지 이동, `document.title` 읽기까지 확인했습니다.

## 라이선스

MIT 라이선스를 적용합니다. [라이선스 전문](LICENSE)
