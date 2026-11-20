# Oh My Agent IDE

한 화면에서 Dispatcher에게 일을 말하면, Dispatcher가 Worker 에이전트에게 나눠 맡깁니다. 사용자는 결정할 것과 결과만 봅니다. Electron과 Claude Agent SDK로 만들었고 Windows와 macOS에서 돌아갑니다.

구현하면서 정한 것은 [docs/DECISIONS.md](docs/DECISIONS.md)에 있습니다.

## 설치

Windows: `release/OhMyAgentIDE-Setup-0.1.0.exe`를 실행합니다. 서명하지 않은 파일이라 SmartScreen이 뜨면 "추가 정보 → 실행"을 누르세요.

macOS: Mac에서 아래 명령으로 dmg를 만듭니다.

```bash
npm install
npm run dist:mac
```

## 처음 실행

설정 창이 열립니다.

1. **계정.** 팀 플랜 계정마다 터미널에서 `claude setup-token`을 실행해 받은 토큰을 붙여 넣습니다. 이 PC에 로그인된 Claude Code를 그대로 쓰려면 "이 PC 로그인 쓰기"를 누릅니다.
2. **사내 GitHub 호스트.** 예: `github.company.com`. `gh auth login --hostname github.company.com`으로 미리 로그인해 두세요.
3. **IDE 홈 폴더.** 저장소 클론, worktree, 결과물, 메모리가 여기에 쌓입니다. 기본값은 `~/OhMyAgentIDE`입니다.
4. **메모리 원격 저장소.** 비워 두면 로컬 git에만 기록하고, 넣으면 그곳으로 push합니다.

## 쓰는 법

- 대화창에 일을 말합니다. `@저장소이름`으로 대상을 정할 수 있습니다.
- 저장소 등록도 대화로 합니다. 예: "github.company.com/payments/billing 클론해서 등록해줘. 정산 배치 담당이야."
- 오른쪽에는 결정 대기, 결과(PR 링크, 결과 파일), Dispatcher가 대신 답한 것이 모입니다. 대신 답한 것은 연필 버튼이나 우클릭으로 정정합니다.
- Worker 화면에서 Worker를 누르면 Dispatcher와 주고받은 대화가 보이고, 그 Worker에게 직접 메시지를 보낼 수 있습니다.
- 메모리 화면에서 선호, 저장소 메모, 지난 결정을 보고 고칩니다. 저장소 메모를 열면 CLAUDE.md 반영 PR을 맡길 수 있습니다.

### 단축키

| 키 | 동작 |
|---|---|
| ⌘/Ctrl+1~4 | 화면 전환 |
| ⌘/Ctrl+, | 설정 |
| ⌘/Ctrl+Z | 목록 정리 되돌리기 |
| Enter | 보내기 |
| Shift+Enter | 줄바꿈 |

## 개발

```bash
npm install
npm run typecheck
npm start
```

빌드 결과는 `dist/`, 설치 파일은 `release/`에 생깁니다. 설정과 데이터를 다른 폴더에 두고 띄우려면 `OMA_DATA_DIR=<폴더>`를 지정합니다. 이 폴더의 `settings.json`에서 `home`을 바꿀 수 있습니다.

### 구조

| 위치 | 하는 일 |
|---|---|
| `src/main/agents/session.ts` | Claude Code 세션 하나. 계정 전환, 250K 압축, 사용량 읽기 |
| `src/main/agents/dispatcher.ts` | Dispatcher 세션과 작업판 MCP 도구 |
| `src/main/agents/workers.ts` | Worker 생성과 배정, 질문과 권한 처리, 결과 정리 |
| `src/main/agents/advisor.ts` | Worker 질문에 메모리 근거로 대신 답할지 판단 |
| `src/main/agents/permissions.ts` | 항상 묻는 작업 목록 |
| `src/main/accounts.ts` | 계정 풀, 사용량, 배정 |
| `src/main/prmonitor.ts` | PR 상태 확인, 머지 후 정리, 리뷰 코멘트 반영 |
| `src/main/memory.ts` | 마크다운 메모리와 git 기록 |
| `src/renderer/` | 화면 |
| `resources/plugin/` | Worker에게 기본으로 붙는 토큰 절약 스킬 |
