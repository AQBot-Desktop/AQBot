# 빠른 시작

## 설치

[다운로드 페이지](/ko/download) 또는 [GitHub Releases](https://github.com/AQBot-Desktop/AQBot/releases)에서 최신 설치 프로그램을 다운로드하세요.

### macOS

| 칩 | 파일 |
|----|------|
| Apple Silicon (M1 / M2 / M3 / M4) | `AQBot_x.x.x_aarch64.dmg` |
| Intel | `AQBot_x.x.x_x64.dmg` |

1. `.dmg`를 열고 **AQBot**을 **응용 프로그램** 폴더로 드래그합니다.
2. AQBot을 시작합니다. macOS가 앱을 차단하면 **시스템 설정 → 개인 정보 보호 및 보안**으로 이동하여 **그래도 열기**를 클릭하세요.

::: warning macOS: "앱이 손상되었습니다" 또는 "개발자를 확인할 수 없습니다"
AQBot은 Apple Developer ID 인증서가 아닌 프로젝트 자체 코드 서명 인증서로 서명되어 있습니다. 따라서 브라우저에서 다운로드한 후 macOS가 "'AQBot'이(가) 손상되었기 때문에 열 수 없습니다" 또는 "개발자를 확인할 수 없기 때문에 'AQBot'을(를) 열 수 없습니다"라고 표시할 수 있습니다.

Gatekeeper를 시스템 전체에서 끌 필요는 없습니다. AQBot만 허용하세요:

1. Finder에서 Control 키를 누른 채 `AQBot.app`을 클릭하고 **열기**를 선택한 다음, 다시 **열기**를 클릭합니다.
2. 그래도 차단되면 **시스템 설정 → 개인 정보 보호 및 보안**의 **보안** 섹션에서 AQBot을 찾아 **그래도 열기**를 클릭합니다.
3. AQBot을 다시 실행합니다.

Gatekeeper 허용과 손쉬운 사용 권한은 별개의 설정입니다. 텍스트 선택 툴바를 사용하려면 앱 내 안내에 따라 **시스템 설정 → 개인 정보 보호 및 보안 → 손쉬운 사용**에서 AQBot도 활성화하세요.
:::

### Windows

| 아키텍처 | 파일 |
|---------|------|
| x64 (대부분의 PC) | `AQBot_x.x.x_x64-setup.exe` |
| ARM64 | `AQBot_x.x.x_arm64-setup.exe` |

설치 프로그램을 실행하고 마법사를 따릅니다. 시작 메뉴 또는 바탕 화면 바로 가기에서 AQBot을 시작합니다.

### Linux

| 형식 | 아키텍처 | 파일 |
|------|---------|------|
| Debian / Ubuntu | x64 | `AQBot_x.x.x_amd64.deb` |
| Debian / Ubuntu | ARM64 | `AQBot_x.x.x_arm64.deb` |
| Fedora / openSUSE | x64 | `AQBot_x.x.x_x86_64.rpm` |
| Fedora / openSUSE | ARM64 | `AQBot_x.x.x_aarch64.rpm` |
| 모든 배포판 | x64 | `AQBot_x.x.x_amd64.AppImage` |
| 모든 배포판 | ARM64 | `AQBot_x.x.x_aarch64.AppImage` |

```bash
# Debian / Ubuntu
sudo dpkg -i AQBot_x.x.x_amd64.deb

# Fedora / openSUSE
sudo rpm -i AQBot_x.x.x_x86_64.rpm

# AppImage (모든 배포판)
chmod +x AQBot_x.x.x_amd64.AppImage
./AQBot_x.x.x_amd64.AppImage
```

---

## 초기 설정

### 1. 설정 열기

AQBot을 시작하고 사이드바 하단의 **기어 아이콘**을 클릭하거나 <kbd>Cmd/Ctrl</kbd>+<kbd>,</kbd>를 누릅니다.

### 2. 제공업체 추가

**설정 → 제공업체**로 이동하여 **+** 버튼을 클릭합니다.

1. 표시 이름을 입력합니다(예: *OpenAI*).
2. 제공업체 유형을 선택합니다(OpenAI, Anthropic, Google Gemini 등).
3. API 키를 붙여넣습니다.
4. **Base URL**을 확인합니다 — 내장 유형에는 공식 엔드포인트가 미리 채워져 있습니다. 서드파티 릴레이나 프록시를 사용하는 경우에만 변경하세요.

::: tip
원하는 만큼 제공업체를 추가할 수 있습니다. 각 제공업체는 자체 API 키와 모델 세트를 독립적으로 관리합니다.
:::

### 3. 모델 가져오기

**모델 가져오기**를 클릭하여 제공업체의 API에서 사용 가능한 모델 목록을 가져옵니다. 필요한 경우 모델 ID를 수동으로 추가할 수도 있습니다.

### 4. 기본 모델 설정

**설정 → 기본 모델**로 이동하여 새 대화에서 기본으로 사용할 제공업체와 모델을 선택합니다.

---

## 첫 번째 대화

1. 사이드바의 **새 채팅**을 클릭합니다(또는 <kbd>Cmd/Ctrl</kbd>+<kbd>N</kbd>을 누릅니다).
2. 채팅 상단의 모델 선택기에서 모델을 선택합니다.
3. 메시지를 입력하고 <kbd>Enter</kbd>를 누릅니다.
4. AQBot은 실시간으로 응답을 스트리밍합니다. 사고 블록을 지원하는 모델(Claude, DeepSeek R1 등)은 답변 위의 접을 수 있는 섹션에 추론 과정을 표시합니다.

---

## 핵심 개념

### 대화 브랜치

임의의 메시지를 편집하거나 재생성하여 브랜치를 만듭니다. 원래 버전과 새 버전은 같은 대화 트리에 공존합니다 — 각 메시지의 화살표 컨트롤로 탐색할 수 있습니다.

### 메시지 버전

재생성할 때마다 새 버전이 만들어집니다. 메시지 버블의 **◀ ▶** 화살표로 버전을 전환합니다.

### 컨텍스트 첨부

파일, 검색 결과, MCP 도구 출력을 대화 컨텍스트에 직접 첨부하여 프롬프트를 풍부하게 합니다.

---

## 단축키

다음은 기본 키보드 단축키입니다. 모든 단축키는 **설정 → 단축키**에서 사용자 지정할 수 있습니다.

| 단축키 | 작업 |
|--------|------|
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> | 현재 창 표시/숨기기 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> | 모든 창 표시/숨기기 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> | 창 닫기 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>N</kbd> | 새 대화 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>,</kbd> | 설정 열기 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> | 명령 팔레트 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> | 모델 선택기 전환 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd> | 마지막 메시지 입력 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> | 컨텍스트 지우기 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Backspace</kbd> | 대화 메시지 지우기 |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | API 게이트웨이 전환 |

::: info
전역 단축키(창 표시/숨기기)는 AQBot이 백그라운드에 있을 때도 시스템 전체에서 작동합니다. AQBot은 다른 애플리케이션의 단축키와의 충돌을 감지하고 설정에서 경고합니다.
:::

---

## 데스크톱 설정

**설정**을 열어 데스크톱 경험을 구성합니다.

| 설정 | 옵션 |
|------|------|
| **테마** | 다크, 라이트 또는 시스템(자동) |
| **언어** | 简体中文, 繁體中文, English, 日本語, 한국어, Français, Deutsch, Español, Русский, हिन्दी, العربية |
| **시스템 트레이** | 트레이로 최소화, 트레이로 닫기 |
| **자동 시작** | 컴퓨터 시작 시 AQBot 시작 |
| **항상 위에 표시** | 다른 애플리케이션 위에 창 유지 |
| **프록시** | 호스트와 포트를 지정한 HTTP 또는 SOCKS5 프록시 |

---

## 데이터 및 백업

### 데이터 디렉토리

AQBot은 두 위치에 데이터를 저장합니다:

| 경로 | 내용 |
|------|------|
| `~/.aqbot/` | 애플리케이션 상태 — 데이터베이스, 암호화 키, 벡터 DB, SSL 인증서 |
| `~/Documents/aqbot/` | 사용자 파일 — 이미지, 문서, 백업 |

::: tip
Windows에서 경로는 `%USERPROFILE%\.aqbot\`와 `%USERPROFILE%\Documents\aqbot\`입니다.
:::

### 자동 백업

**설정 → 백업**으로 이동하여 자동 백업을 구성합니다:

- **활성화** — 자동 백업 켜기/끄기.
- **간격** — 백업 빈도(시간 단위).
- **최대 수** — 가장 오래된 것이 삭제되기 전에 유지할 백업 수.
- **스토리지 대상** — 로컬 디렉토리(기본값: `~/Documents/aqbot/backups/`) 또는 WebDAV 서버.

### 수동 백업 및 복원

백업 설정 패널에서 언제든지 수동 백업을 만들 수 있습니다. 복원하려면 기록 목록에서 백업을 선택하고 **복원**을 클릭합니다.

### 대화 내보내기

사이드바에서 대화를 오른쪽 클릭하여 내보냅니다:

- **PNG** — 채팅의 렌더링 스크린샷
- **Markdown** — 헤더, 코드 블록, LaTeX가 포함된 형식
- **일반 텍스트** — 메시지 구분 기호가 있는 간단한 텍스트
- **JSON** — 전체 메타데이터를 포함한 구조화된 데이터

---

## 다음 단계

- [제공업체 설정](./providers) — AI 제공업체 추가 및 관리
- [MCP 서버](./mcp) — AI 기능을 확장하는 외부 도구 연결
- [API 게이트웨이](./gateway) — 제공업체를 로컬 API 서버로 노출
