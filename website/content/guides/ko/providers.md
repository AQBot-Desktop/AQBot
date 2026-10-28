# 제공업체 설정

AQBot은 동시에 여러 AI 제공업체에 연결할 수 있습니다. 각 제공업체는 자체 API 키, 모델 목록, 매개변수 기본값을 갖습니다.

## 지원되는 제공업체

AQBot은 다음 제공업체를 최우선으로 지원합니다. OpenAI 호환 API를 공개하는 모든 서비스도 즉시 사용 가능합니다.

| 제공업체 | 모델 예시 |
|---------|---------|
| **OpenAI** | GPT-4o, GPT-4, o3, o4-mini |
| **Anthropic** | Claude 4 Sonnet, Claude 4 Opus, Claude 3.5 Sonnet |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 |
| **DeepSeek** | DeepSeek V3, DeepSeek R1 |
| **Alibaba Cloud** | Qwen 시리즈 |
| **Zhipu AI** | GLM 시리즈 |
| **xAI** | Grok 시리즈 |
| **OpenAI 호환 API** | Ollama, vLLM, LiteLLM, 서드파티 릴레이 등 |

---

## 제공업체 추가

1. **설정 → 제공업체**로 이동합니다.
2. 왼쪽 하단의 **+** 버튼을 클릭합니다.
3. 제공업체 세부 정보를 입력합니다:

| 필드 | 설명 |
|------|------|
| **이름** | 사이드바 표시 이름(예: *OpenAI*) |
| **유형** | 제공업체 유형 — 기본 Base URL과 API 동작 결정 |
| **아이콘** | 시각적 식별을 위한 선택적 아이콘 |
| **API 키** | 제공업체 대시보드의 시크릿 키 |
| **Base URL** | API 엔드포인트(내장 유형에는 미리 채워짐, 릴레이용으로 변경 가능) |
| **API 경로** | 요청 경로 — 기본값은 `/v1/chat/completions` |

::: tip
서드파티 릴레이 서비스의 경우 유형을 **OpenAI**(또는 해당 업스트림 유형)로 설정하고 **Base URL**을 릴레이의 엔드포인트로 변경합니다.
:::

---

## 웹사이트 링크에서 가져오기

제공업체 웹사이트, 릴레이 서비스 대시보드, 프라이빗 모델 플랫폼, 로컬 게이트웨이 관리 페이지는 **AQBot에서 열기** 링크를 제공할 수 있습니다. 사용자가 클릭하면 브라우저가 AQBot 데스크톱 앱을 열고, AQBot은 **설정 → 제공업체**로 이동해 확인 대화상자를 표시합니다. 가져오기는 사용자가 확인한 뒤에만 실행됩니다.

### 사용자 흐름

1. 제공업체 링크 가져오기를 지원하는 AQBot 버전을 설치하고 엽니다.
2. 브라우저에서 제공업체가 제공한 **AQBot에서 열기** 링크를 클릭합니다.
3. AQBot 확인 대화상자에서 제공업체 이름, Base URL, 제공업체 유형, API 키 접두사를 확인합니다.
4. AQBot은 같은 **Base URL + 유형**의 기존 제공업체를 재사용합니다. 없으면 새 제공업체를 만들고, API 키가 아직 없을 때만 추가합니다.

AQBot은 API 키를 자동으로 검증하거나 모델 목록을 자동으로 가져오지 않습니다. 가져온 뒤 **모델 가져오기**를 클릭하거나 모델 ID를 수동으로 추가하세요.

### 링크 형식

```text
aqbot://providers?name=<name>&baseurl=<base-url>&apikey=<api-key>&type=<provider-type>
```

예:

```text
aqbot://providers?name=OpenAI&baseurl=https%3A%2F%2Fapi.openai.com&apikey=sk-xxx&type=openai
```

### 매개변수

| 매개변수 | 필수 | 설명 |
|----------|------|------|
| `name` | 예 | AQBot에 표시할 이름. 예: `OpenAI`, `My Relay` |
| `baseurl` | 예 | URL 인코딩된 Base URL. `http` / `https`만 허용되며 query와 hash는 거부됩니다. |
| `apikey` | 예 | AQBot에 저장할 API 키. 확인 대화상자에는 접두사만 표시됩니다. |
| `type` | 예 | 제공업체 유형. 허용 값: `openai`, `openai_responses`, `anthropic`, `gemini`, `custom`. |

`baseurl`은 AQBot의 기존 강제 접미사도 사용할 수 있습니다(예: `https://example.com!`). 링크로 가져올 때는 `api_path`가 설정되지 않으며, 선택한 제공업체 유형의 기본 경로가 계속 사용됩니다.

### 웹사이트 설정

모든 동적 값은 `encodeURIComponent` 또는 `URLSearchParams`로 인코딩하세요:

```html
<a id="open-aqbot" href="#">AQBot에서 열기</a>

<script>
  const provider = {
    name: 'My Relay',
    baseurl: 'https://api.example.com',
    apikey: 'sk-user-key',
    type: 'openai',
  };

  const params = new URLSearchParams({
    name: provider.name,
    baseurl: provider.baseurl,
    apikey: provider.apikey,
    type: provider.type,
  });

  document.getElementById('open-aqbot').href = `aqbot://providers?${params.toString()}`;
</script>
```

서비스에서 API 키를 온라인으로 생성할 수 있다면, 사용자가 로그인하고 명시적으로 키를 선택하거나 생성한 뒤에만 링크를 만드는 것이 좋습니다.

::: warning 보안
URL에 포함된 API 키는 브라우저 기록, 로그, 확장 프로그램, 분석 스크립트에 남을 수 있습니다. 실제 키를 공개 페이지, 정적 HTML, 서드파티 리디렉션 링크에 넣지 마세요. 사용자 전용 계정 페이지에서 확인 후 생성하는 방식을 권장합니다.
:::

::: tip 테스트
`aqbot://`는 설치된 데스크톱 앱이 시스템에 등록하는 사용자 지정 프로토콜입니다. 웹사이트나 Vite 개발 서버만 실행해서는 등록되지 않습니다. 클릭해도 AQBot이 열리지 않으면 최신 AQBot 데스크톱 앱을 먼저 설치하거나 다시 빌드하세요.
:::

---

## CC Switch에서 가져오기

Settings -> Providers에서 CC Switch provider configurations를 스캔할 수 있습니다. 후보를 검토하고 importable rows를 선택하면 providers, Base URLs, API keys, model lists를 AQBot으로 가져옵니다. OAuth-only entries나 reusable keys가 없는 항목은 이유와 함께 건너뜁니다.

## 고급 모델 요청 본문

각 모델은 extra_body JSON object를 정의할 수 있으며 OpenAI-compatible Chat Completions requests에 flatten되어 추가됩니다. enable_thinking 같은 vendor-specific options에 유용합니다. AQBot은 JSON을 검증하고 model, messages, stream, tools, base sampling fields 덮어쓰기를 차단합니다.

## 멀티 키 로테이션

AQBot은 부하 분산과 속도 제한 회피를 위해 제공업체별로 여러 API 키를 지원합니다.

### 키 추가

제공업체 상세 패널에서 **키 추가**를 클릭하여 추가 API 키를 추가합니다. 각 키에는 접두사, 생성 날짜, 마지막 사용 타임스탬프가 표시됩니다.

### 로테이션 작동 방식

AQBot은 라운드 로빈 인덱스를 사용하여 활성화된 키를 자동으로 로테이션합니다. 요청이 완료되면 로테이션 인덱스가 다음 키로 진행됩니다. 키가 비활성화되거나 검증에 실패하면 건너뜁니다.

### 키 검증

키 옆의 **검증** 버튼을 클릭하여 제공업체의 API에 대해 검증합니다. 검증 결과와 오류 메시지가 기록됩니다.

---

## 모델 관리

### 모델 가져오기

제공업체 상세 패널에서 **모델 가져오기**를 클릭하여 제공업체 API에서 사용 가능한 모델의 전체 목록을 가져옵니다. 발견된 모델은 자동으로 로컬 목록에 추가됩니다.

### 모델 수동 추가

API에서 반환되지 않는 모델(예: 파인튜닝된 모델이나 새 릴리스)은 모델 ID를 직접 입력하여 추가할 수 있습니다.

### 모델별 매개변수

각 모델에 자체 기본 매개변수 재정의를 설정할 수 있습니다:

| 매개변수 | 설명 |
|---------|------|
| **온도** | 무작위성 제어(0 = 결정론적, 높을수록 더 창의적) |
| **최대 토큰** | 응답의 최대 토큰 수 |
| **Top P** | 핵 샘플링 임계값 |
| **빈도 페널티** | 토큰 시퀀스 반복 감소 |
| **존재 페널티** | 모델이 새 주제를 도입하도록 장려 |

### 모델 능력

AQBot은 모델별로 **비전**, **함수 호출**, **추론** 등의 능력을 추적하고 태그로 표시합니다. 이러한 능력은 대화 중에 사용 가능한 기능에 영향을 미칩니다.

---

## 사용자 지정 및 로컬 엔드포인트

AQBot은 OpenAI 채팅 완성 API를 구현하는 모든 엔드포인트와 작동합니다.

### Ollama (로컬 모델)

1. [Ollama](https://ollama.com/)를 설치하고 시작합니다.
2. AQBot에서 유형 **OpenAI**로 새 제공업체를 만듭니다.
3. **Base URL**을 `http://localhost:11434`로 설정합니다.
4. **모델 가져오기**를 클릭하여 로컬에 다운로드한 모델을 검색합니다.

### vLLM / TGI

추론 서버의 주소(예: `http://localhost:8000`)에 **Base URL**을 설정하고 평소처럼 모델을 가져오거나 추가합니다.

### API 릴레이 서비스

릴레이 또는 애그리게이터 서비스(예: OpenRouter, one-api)의 경우 유형을 **OpenAI**로 설정하고 릴레이의 Base URL을 입력하고 릴레이의 API 키를 제공합니다.

---

## 기본 모델 설정

### 기본 어시스턴트 모델

**설정 → 기본 모델**로 이동하여 새 대화에서 기본으로 사용할 제공업체와 모델을 선택합니다. 모델 선택기에서 대화별로 항상 모델을 재정의할 수 있습니다.

### 주제 명명 모델

AQBot은 각 대화의 제목을 자동으로 생성할 수 있습니다. 기본 모델 설정에서 제목 생성의 비용과 지연을 절약하기 위해 주제 명명 전용 경량 모델을 할당할 수 있습니다. 제목 생성을 위한 사용자 지정 프롬프트와 컨텍스트 창 크기를 구성할 수 있습니다.

---

## 다음 단계

- [MCP 서버](./mcp) — AI 기능을 확장하는 외부 도구 연결
- [API 게이트웨이](./gateway) — 제공업체를 로컬 API 서버로 노출
