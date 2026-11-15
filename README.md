# Guild War Tracker

Wynncraft 길드 전쟁의 **참여 / 승리 / 패배 / 이탈**을 기록하는 프로그램입니다. 두 부분으로 되어 있어요.

- `mod/`: Fabric 1.21.11 클라이언트 모드. 내가 참여한 전쟁만 감지해서 서버로 보냅니다.
- `worker/`: Cloudflare Worker와 D1 데이터베이스. 기록을 저장하고, 이탈을 판정하고, 조회 페이지를 보여줍니다.

서버에 `API_KEY`를 등록하지 않으면 키 없이 기록할 수 있어요(선택 사항).

## 판정 규칙

| 결과 | 조건 |
|---|---|
| 승리 / 패배 | 참여 후 30분 안에 승리 또는 패배 메시지를 받음 |
| 이탈 | 참여 후 30분 동안 결과가 없음, 또는 결과 없이 새 전쟁에 참여함 |
| 진행 중 | 참여 후 30분이 아직 지나지 않음 |

전쟁 참여 횟수는 승리, 패배, 이탈을 모두 더한 값입니다(진행 중인 전쟁도 포함). 소속 길드는 비워 두면 서버가 Wynncraft API로 조회합니다. 조회 결과는 6시간 동안 캐시하고, 전쟁 당시의 길드로 기록돼요.

---

## 1. Worker 배포

Node.js가 필요합니다. `worker` 폴더에서 아래 명령을 실행하세요.

```bash
npm install -D wrangler
npx wrangler login

# D1 데이터베이스 생성 → 출력된 database_id를 wrangler.toml에 붙여넣기
npx wrangler d1 create guild-war-tracker

# 테이블 생성
npx wrangler d1 execute guild-war-tracker --remote --file=schema.sql

# 모드와 같이 쓸 API 키 등록 (아무 긴 랜덤 문자열)
npx wrangler secret put API_KEY

# (선택) 조회 페이지에 비밀번호를 걸려면
npx wrangler secret put VIEW_KEY

npx wrangler deploy
```

배포가 끝나면 `https://guild-war-tracker.<계정>.workers.dev` 주소가 나옵니다. 이 주소가 조회 페이지예요.

로컬 테스트는 `npm test`로 실행합니다(Node 22 이상, 실제 DB 없이 로직만 검증).

## 2. 모드 빌드와 설치

JDK 21이 필요합니다. `mod` 폴더에서 아래 명령을 실행하세요.

```bash
./gradlew build        # Windows: gradlew.bat build
```

`build/libs/guild-war-tracker-1.0.0.jar`를 `.minecraft/mods`에 넣으세요. Fabric API(1.21.11용)도 함께 있어야 합니다. Wynntils는 있어도 되고 없어도 됩니다.

게임을 한 번 실행하면 `config/guildwartracker.json`이 생깁니다. 여기에 아래 두 값을 넣고 게임 안에서 `/gwt reload`를 입력하세요.

```json
"serverUrl": "https://guild-war-tracker.<계정>.workers.dev",
"apiKey": "API_KEY로 등록한 값",
```

빌드가 버전 문제로 실패하면 https://fabricmc.net/develop 에서 1.21.11 기준 `loader_version`, `loom_version`, `fabric_version`을 확인해 `gradle.properties`를 고쳐 주세요.

## 3. 전쟁 메시지 측정 (패턴 맞추기)

현재 기본 정규식은 **추정값**입니다. 실제 메시지는 아래 순서로 측정하세요.

1. 게임에서 `/gwt capture on`을 입력합니다.
2. 전쟁을 진행합니다. 가능하면 승리 한 판, 패배 한 판을 모두 해 주세요.
3. `/gwt capture off`를 입력합니다.
4. `config/guildwartracker-capture.log` 파일을 열어 전쟁 관련 줄을 찾습니다. 채팅, 타이틀, 서브타이틀이 모두 기록되고, 색상 코드와 아이콘 글자는 정리된 상태예요.

찾은 메시지를 `guildwartracker.json`의 `startPatterns`, `winPatterns`, `lossPatterns`에 넣고 `/gwt reload`를 입력하세요. `/gwt test <문장>`으로 각 문장이 어떤 패턴에 걸리는지 미리 확인할 수 있습니다.

## 명령어

| 명령어 | 설명 |
|---|---|
| `/gwt` 또는 `/gwt status` | 서버 설정, 진행 중인 전쟁, 전송 대기 건수 |
| `/gwt capture on\|off` | 메시지를 파일에 기록 |
| `/gwt test <문장>` | 패턴 판정 확인 (서버로 전송하지 않음) |
| `/gwt reload` | 설정 파일 다시 읽기 |
| `/gwt seturl <주소>` | Worker 주소 변경 (기본: guild-war-tracker.wartracker.workers.dev, `default`로 되돌림) |
| `/gwt setkey <키>` | API 키 저장 |
| `/gwt setguild <이름>` | 길드명 고정 (`auto`면 자동 조회) |
| `/gwt flush` | 미전송 기록 즉시 재전송 |

전송에 실패한 기록은 `config/guildwartracker-queue.json`에 보관됩니다. 게임을 다시 켜도 자동으로 재전송돼요.

---

웹 브라우저만으로 배포하는 방법(Cloudflare 대시보드, GitHub Actions)은 별도 가이드 문서를 참고하세요. 대시보드용 Worker는 `worker/dist/worker.js` 한 파일입니다.
