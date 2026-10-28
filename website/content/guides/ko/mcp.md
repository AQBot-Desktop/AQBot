# MCP 서버

## MCP란?

[Model Context Protocol(MCP)](https://modelcontextprotocol.io/)은 AI 모델이 외부 도구 및 데이터 소스와 상호 작용할 수 있게 하는 오픈 표준입니다. AQBot은 MCP 클라이언트 역할을 합니다 — MCP 서버를 추가하면 AI가 대화 중에 해당 서버가 노출하는 도구를 호출할 수 있습니다.

---

## 전송 프로토콜

AQBot은 MCP 서버와의 통신을 위해 3가지 전송 프로토콜을 지원합니다:

| 프로토콜 | 연결 | 사용 사례 | 구성 |
|---------|------|---------|------|
| **Stdio** | 로컬 프로세스 | `npx`, `uvx`, `python` 등으로 시작하는 머신에 설치된 도구 | `command` + `args` + 선택적 `env` |
| **SSE** | 원격 서버 | 원격 머신이나 클라우드 서비스에서 호스팅되는 Server-Sent Events 엔드포인트 | `url` |
| **StreamableHTTP** | 원격 서버 | HTTP 스트리밍 엔드포인트(SSE의 새로운 대안) | `url` |

---

## MCP 서버 추가

### 폼으로 만들기

1. **설정 → MCP 서버**로 이동합니다.
2. **MCP 서버 추가**를 클릭합니다.
3. 이름을 입력하고 전송 프로토콜을 선택합니다.
4. 선택한 프로토콜의 필드를 입력합니다:
   - **Stdio** — 실행할 명령, 인수(JSON 배열), 환경 변수(JSON 객체), 타임아웃.
   - **SSE** — 엔드포인트 URL, 타임아웃.
   - **StreamableHTTP** — 엔드포인트 URL, 타임아웃.
5. **저장**을 클릭합니다.

### JSON 가져오기

**JSON 가져오기**를 클릭하고 구성 객체를 붙여넣습니다. AQBot은 표준 MCP JSON 형식을 허용합니다:

#### Stdio 서버

```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

#### SSE 서버

```json
{
  "mcpServers": {
    "remote-tools": {
      "type": "sse",
      "url": "https://example.com/sse"
    }
  }
}
```

#### StreamableHTTP 서버

```json
{
  "mcpServers": {
    "remote-http": {
      "type": "streamablehttp",
      "url": "https://example.com/mcp"
    }
  }
}
```

#### 여러 서버 한 번에

```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    },
    "remote": {
      "type": "sse",
      "url": "https://example.com/sse"
    }
  }
}
```

---

## 구성 예시

### 웹 가져오기 — `mcp-server-fetch`

웹 페이지를 가져와 AI를 위한 읽기 쉬운 텍스트로 변환합니다.

```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

### 파일 작업 — `@modelcontextprotocol/server-filesystem`

AI에게 머신의 특정 디렉토리에 대한 읽기/쓰기 액세스를 제공합니다.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/me/documents",
        "/Users/me/projects"
      ]
    }
  }
}
```

### 원격 SSE 서버

Server-Sent Events를 통해 원격 도구 서버에 연결합니다.

```json
{
  "mcpServers": {
    "cloud-tools": {
      "type": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

### 환경 변수가 있는 Stdio

환경 변수를 통해 API 키나 구성을 서버 프로세스에 전달합니다.

```json
{
  "mcpServers": {
    "weather": {
      "command": "python",
      "args": ["-m", "weather_server"],
      "env": {
        "WEATHER_API_KEY": "your-api-key"
      }
    }
  }
}
```

---

## 내장 도구

AQBot에는 외부 MCP 서버를 추가하지 않고도 사용 가능한 내장 도구가 포함되어 있습니다:

| 도구 | 설명 |
|------|------|
| **@aqbot/fetch** | 웹 페이지 및 HTTP 리소스 가져오기 |
| **@aqbot/search-file** | 로컬 파일 시스템에서 파일 검색 |

내장 도구는 사용자 지정 서버와 함께 MCP 서버 설정에 나열되며 개별적으로 활성화 또는 비활성화할 수 있습니다.

---

## 도구 실행 패널

AI가 대화 중에 MCP 도구를 호출하면 AQBot은 채팅에 인라인으로 **도구 실행 패널**을 표시합니다. 패널에는 다음이 표시됩니다:

- **도구 이름**과 해당 **서버**.
- 도구에 전송된 **입력 인수**.
- 도구에 의해 반환된 **출력**.
- 실행 상태(실행 중, 성공 또는 실패).

대화의 임의의 도구 호출을 클릭하여 세부 정보를 확장합니다. 이를 통해 AI가 무엇을 했는지 확인하고 예상치 못한 결과를 디버그하는 것이 쉬워집니다.

---

## 도구 루프 제한

Settings -> MCP에서 MCP-enabled response의 consecutive tool-call iterations 최대값을 설정할 수 있습니다. unknown servers를 테스트할 때는 낮추고, 여러 도구를 의도적으로 chaining하는 workflows에서는 높일 수 있습니다.

## 다음 단계

- [API 게이트웨이](./gateway) — 제공업체를 로컬 API 서버로 노출
- [빠른 시작](./getting-started) — 빠른 시작 가이드로 돌아가기
