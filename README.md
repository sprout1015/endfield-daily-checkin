# Endfield Daily Check-in

Arknights: Endfield 일일 출석 페이지를 위한 Chrome 확장 프로그램입니다. `game.skport.com`에 로그인된 상태에서 공식 페이지가 사용하는 인증 헤더를 캡처한 뒤, 매일 출석 체크를 자동으로 시도합니다.

> 개인 사용 목적의 확장 프로그램입니다. Hypergryph, Gryphline, SKLAND, Arknights: Endfield와 관련이 없습니다.

## 기능

- 사이트 출석 기준 시간인 `00:05` UTC+8에 맞춰 매일 자동 출석을 실행합니다.
- 팝업에서 자동 출석을 활성화하거나 비활성화할 수 있습니다.
- `5월 29일 출석 완료`처럼 오늘 출석 상태를 표시합니다.
- `game.skport.com`에서 발생하는 요청의 `cred`, `sk-game-role` 헤더를 캡처합니다.
- 수동 실행용 **지금 체크** 버튼을 제공합니다(연속 클릭 남용 방지를 위해 최소 10초 간격 제한이 있습니다).
- 마지막 결과를 로컬에 저장하고 Chrome 알림으로 알려줍니다.
- 최초 로그인 후 출석 준비가 완료되거나 게임 계정이 바뀌면, 자동 출석이 켜져 있는 경우 즉시 1회 출석을 시도합니다.
- 보상이 지급되지 않았거나(`awardIds` 비어 있음) 서버 오류·네트워크 오류로 실패하면, 같은 실행 안에서 3초 뒤 한 번 더 자동 재시도합니다.
- 그래도 실패하면 45분 뒤 다시 시도하는 보조 알람을 예약합니다(하루 최대 3회까지).

## 설치

1. Chrome에서 `chrome://extensions/`를 엽니다.
2. **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 누릅니다.
4. 아래 폴더를 선택합니다.

```text
C:\Private_Project\Endfiled_Extension
```

## 최초 설정

1. 공식 출석 페이지에 접속합니다.

```text
https://game.skport.com/endfield/sign-in?header=0&hg_media=launcher&hg_link_campaign=banner&hg_link_name=signin
```

2. 필요한 경우 로그인합니다.
3. 페이지를 한 번 새로고침하거나 조작해서 공식 사이트가 API 요청을 보내도록 합니다.
4. 확장 프로그램 팝업에서 **출석 준비 완료**로 표시되는지 확인합니다.
5. 자동 출석이 켜져 있으면 출석 준비 완료 시점에 즉시 1회 출석을 시도합니다. 필요하면 **지금 체크**로 수동 검증도 할 수 있습니다.

## 팝업 상태

- **자동 출석**: 예약 실행을 켜거나 끕니다.
- **출석 현황**: UTC+8 기준 오늘 출석 완료 여부를 표시합니다.
- **다음 자동 실행**: 다음 예약 시간을 표시합니다. `00:05` UTC+8은 한국 시간으로 `01:05` KST입니다.
- **출석 준비**: `cred`와 `sk-game-role`이 캡처되었는지 표시합니다.
- **마지막 체크**: 마지막 수동 또는 자동 출석 시도 시간을 표시합니다.

자동 출석을 비활성화하면 예약 알람과 Chrome 시작 시 복구 실행이 출석을 건너뜁니다. 수동 **지금 체크**는 자동 출석 설정과 관계없이 실행할 수 있습니다.

## 동작 방식

공식 사이트는 `zonai.skport.com`으로 인증된 API 요청을 보냅니다. 확장 프로그램은 이 요청의 헤더를 읽어 이후 출석에 필요한 값을 로컬에 저장합니다.

```text
game.skport.com 페이지
  -> zonai.skport.com API 요청
  -> 확장 프로그램이 cred, sk-game-role 헤더 캡처
  -> chrome.storage.local에 저장
```

출석 체크는 다음 순서로 진행됩니다.

1. UTC+8 기준 오늘 출석이 이미 기록되어 있는지 확인합니다.
2. `/web/v1/auth/refresh`를 호출해 서명 토큰을 받습니다.
3. 공식 페이지와 같은 방식으로 요청 서명을 생성합니다.
4. 같은 timestamp로 `GET /web/v1/game/endfield/attendance`를 먼저 호출합니다. 공식 사이트도 지금 체크 시 GET을 먼저 보낸 뒤 곧바로 같은 timestamp로 POST를 보내는데, 이 GET을 생략하면 POST가 `code: 0/OK`를 반환하고도 실제 보상(`awardIds`)이 지급되지 않는 현상이 확인되었습니다. 이 GET의 응답 내용(`hasToday` 등)은 완료 여부 판단에 쓰지 않고, 오류 코드가 아닐 때만 다음 단계로 진행합니다.
5. 같은 timestamp로 `POST /web/v1/game/endfield/attendance`를 호출합니다.
6. POST 응답의 `data.awardIds`(또는 `awards`)가 채워져 있어야 실제 완료로 인정합니다. 비어 있으면(`reward_not_granted`) 3초 뒤 4~5단계를 한 번 더 시도합니다.
7. 그래도 실패하거나 서버 오류(`server_busy`)·네트워크 오류(`network_error`)로 끝나면 완료로 저장하지 않고, 45분 뒤 재시도하는 별도 알람을 예약합니다(하루 최대 3회, 성공하거나 다음 날이 되면 초기화).
8. 결과를 저장하고 팝업과 알림에 표시합니다.

## API 참고

`GET /web/v1/game/endfield/attendance`와 `POST /web/v1/game/endfield/attendance`는 같은 경로를 쓰고, 요청 헤더(`cred`, `platform`, `vname`, `timestamp`, `sk-language`, `sk-game-role`, `sign`)도 같은 방식으로 서명합니다. 아래는 2026-07-02(UTC+8) 공식 사이트에서 캡처한 실제 응답 구조입니다(민감 정보는 생략).

### GET 응답 (출석 상태 조회)

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "currentTs": "1783014195",
    "calendar": [
      { "awardId": "endfield_attendance_1_2", "available": false, "done": true },
      { "awardId": "endfield_attendance_4_2", "available": false, "done": false }
    ],
    "first": [ { "awardId": "endfield_attendance_8_120", "available": false, "done": true } ],
    "resourceInfoMap": {
      "endfield_attendance_1_2": { "id": "endfield_attendance_1_2", "count": 2, "name": "중급 작전 기록", "icon": "..." }
    },
    "hasToday": true
  }
}
```

- `calendar`는 이벤트 전체 기간(30여 개) 누적 출석 보상 목록이며, 배열 인덱스가 "이번 달 며칠째"를 의미하지 않고 같은 보상 ID가 여러 번 순환 등장합니다. `hasToday`/`calendar[].done`이 정확히 무엇을 뜻하는 필드인지 확인되지 않은 채로 완료 판정에 썼다가 두 번(사전 차단, 사후 오판) 심각한 회귀를 냈던 이력이 있어(아래 트러블슈팅 참고), 지금은 이 필드들을 완료 판정에 전혀 쓰지 않습니다.
- `resourceInfoMap`은 각 `awardId`가 실제로 어떤 보상(이름/개수/아이콘)인지 설명하는 사전입니다.

### POST 응답 (출석 체크 실행)

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "ts": "1783014195",
    "awardIds": [ { "id": "endfield_attendance_4_2", "type": 2 } ],
    "resourceInfoMap": { "endfield_attendance_4_2": { "id": "endfield_attendance_4_2", "count": 2, "name": "무기 점검 장치", "icon": "..." } },
    "tomorrowAwardIds": [ { "id": "endfield_attendance_7_2000", "type": 2 } ]
  }
}
```

- 실제 보상이 지급됐을 때만 `data.awardIds`가 채워집니다. `data.ts`가 `"0"`이고 `awardIds`가 빈 배열이면 형식적으로는 성공(`code: 0`)이지만 실제로는 지급되지 않은 것입니다 — 확장 프로그램은 이 경우를 `reward_not_granted` 상태로 구분해 완료로 저장하지 않고 재시도합니다.
- `tomorrowAwardIds`는 다음 날 받을 보상 미리보기입니다(확장 프로그램은 사용하지 않음).

### GET /web/v1/game/endfield/attendance/record (참고용 — 확장 프로그램은 호출하지 않음)

지금까지 수령한 보상 이력을 시간순으로 보여줍니다. 특정 시점에 실제로 보상을 받았는지 사후 확인할 때 유용합니다.

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "records": [
      { "ts": "1783014195", "awardId": "endfield_attendance_4_2" },
      { "ts": "1782988900", "awardId": "endfield_attendance_1_2" }
    ],
    "resourceInfoMap": { "...": "..." }
  }
}
```

## 권한

| 권한 | 사용 이유 |
| --- | --- |
| `alarms` | 매일 자동 출석 알람을 예약합니다. |
| `storage` | 캡처한 인증 정보와 마지막 출석 결과를 로컬에 저장합니다. |
| `cookies` | 로그인 세션 변경을 감지하는 데 사용합니다. |
| `notifications` | 출석 성공 또는 실패 알림을 표시합니다. |
| `webRequest` | 공식 사이트의 API 요청 헤더를 읽습니다. |
| `https://game.skport.com/*` | 공식 출석 페이지와 로그인 세션을 대상으로 합니다. |
| `https://zonai.skport.com/*` | 인증 갱신과 출석 API를 호출합니다. |

## 트러블슈팅

### 출석 준비 완료로 바뀌지 않음

- `game.skport.com`에 로그인되어 있는지 확인하세요.
- 공식 출석 페이지를 한 번 새로고침하세요.
- 팝업을 다시 열어 상태를 확인하세요.

### 로그인된 것처럼 보이는데 출석이 실패함

공식 페이지가 이미 로그인된 화면을 보여도 확장 프로그램이 아직 `cred`와 `sk-game-role` 헤더를 캡처하지 못했을 수 있습니다. 공식 출석 페이지를 새로고침해서 API 요청이 다시 발생하도록 하면 헤더가 캡처됩니다.

### 401 请勿修改设备本地时间

출석 API가 HTTP `401`과 `请勿修改设备本地时间` 메시지를 반환하면 PC의 로컬 시간이 서버 시간과 맞지 않는 상태일 수 있습니다.

확장 프로그램은 `/web/v1/auth/refresh` 응답의 서버 timestamp를 우선 사용해 출석 요청을 서명합니다. 그래도 같은 오류가 계속되면 운영체제 시간 설정에서 자동 시간 동기화를 켠 뒤 다시 시도하세요.

### 로그아웃 또는 계정 전환

확장 프로그램은 직접 로그인하지 않고 브라우저의 공식 사이트 세션을 따릅니다.

- 로그아웃하면 관련 쿠키 변경을 감지해 세션 만료 상태로 바뀔 수 있습니다.
- 다른 계정으로 로그인하면 다음 공식 API 요청에서 저장된 `cred`와 `sk-game-role`이 새 값으로 덮어써집니다.
- `cred` 또는 `sk-game-role`이 바뀌면 이전 계정의 오늘 출석 완료 기록을 새 계정에 적용하지 않고, 자동 출석이 켜져 있을 때 즉시 1회 출석을 시도합니다.
- 게임 계정이 연동되지 않은 계정은 `sk-game-role`이 내려오지 않을 수 있으므로, `cred`만 바뀌어도 계정 전환으로 처리합니다.
- 계정 전환 후에는 공식 출석 페이지를 한 번 새로고침하세요.

### Auth refresh succeeded, but no signing salt was found

초기 구현에서 `/web/v1/auth/refresh` 응답을 잘못 해석해서 발생했던 문제입니다.

관측된 응답은 다음 형태였습니다.

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "token": "..."
  }
}
```

`data.token`은 새 `cred`가 아니라 출석 요청 서명에 사용하는 HMAC 키입니다. 현재 구현은 캡처된 `cred`를 유지하고, `refresh.data.token`은 요청 서명에만 사용합니다.

### 이미 출석한 상태에서 403이 반환됨

확장 프로그램 설치 전 이미 보상을 수령한 경우 출석 API가 HTTP `403`과 `请勿重复签到！` 메시지를 반환할 수 있습니다.

이 응답은 실제 실패가 아니라 **오늘 출석 완료**로 처리합니다. 확장 프로그램은 UTC+8 기준 오늘 날짜를 완료로 저장하고 팝업에는 이미 수령된 상태로 표시합니다.

### 출석 API 응답을 어디까지 신뢰하는가

`POST /attendance`가 `code: 0 / OK`를 반환해도 실제로는 보상이 지급되지 않는 경우가 있습니다(예: `data.awardIds`가 빈 배열이고 `data.ts`가 `"0"`인 응답 — 공식 사이트의 "이번 달 누적 출석 일수"도 그대로였음). 그래서 `code: 0`만으로는 완료 여부를 판단하지 않고, **같은 POST 응답 안의 `data.awardIds`(또는 `data.awards`)가 실제로 채워져 있는지**까지 함께 확인합니다.

- `awardIds`가 비어 있지 않으면 → 완료로 저장(`success`)하고 오늘 재시도하지 않습니다.
- `awardIds`가 비어 있으면 → `reward_not_granted` 상태로 표시하고 오늘 완료로 저장하지 않습니다. 즉 다음 **지금 체크** 클릭이나 다음 자동 실행 때 실제로 다시 서버에 요청을 보냅니다.

실제 브라우저 네트워크 캡처를 비교해보니, `awardIds`가 비어 오는 원인은 확장 프로그램이 `POST`만 단독으로 보냈기 때문이었습니다. 공식 사이트는 지금 체크 클릭 시 **같은 timestamp로 `GET`을 먼저 보내고 곧바로 `POST`를 보내는데**(두 요청의 `sign` 값까지 동일하게 캡처됨), 확장 프로그램이 이 GET 없이 POST만 보내면 서버가 `code: 0`은 주지만 실제 보상은 지급하지 않았습니다. 그래서 지금은 완료 판정과 무관하게 POST 직전에 같은 timestamp로 GET을 한 번 선행 호출합니다(GET 응답의 `hasToday` 등은 판단에 쓰지 않음).

한때는 이 GET을 "POST 전에 호출해서 `hasToday`가 true면 POST 자체를 건너뛰는" 방식으로 잘못 구현한 적이 있는데, `hasToday`가 정확히 무엇을 의미하는지 확인되지 않은 채로 완료 판정에 써서 POST 요청 자체가 나가지 않는 심각한 회귀를 냈습니다. 지금은 GET을 완료 판정에는 전혀 쓰지 않고, 오직 서버 선행 조건을 맞추기 위한 용도로만 호출하며, 완료 여부는 오직 POST 응답의 `awardIds`로만 판단합니다.

### 매번 `code: 0`인데 `awardIds`가 계속 비어 있음 (origin/referer 문제)

GET을 먼저 보내는 방식으로 고친 뒤에도(즉시 재시도 포함 2회 모두) `awardIds`가 계속 빈 배열로 오는 경우가 있었습니다. 확장 프로그램의 서비스 워커 DevTools에서 실제로 나가는 요청 헤더를 직접 확인해보니 원인이 나왔습니다.

```
origin: chrome-extension://<확장 프로그램 ID>   (기대값: https://game.skport.com)
referer: (없음)                                  (기대값: https://game.skport.com/)
sec-fetch-site: none                            (기대값: same-site)
```

확장 프로그램의 백그라운드 서비스 워커에서 `fetch()`로 직접 호출하면, 브라우저가 `origin`을 확장 프로그램 자신의 출처(`chrome-extension://...`)로 채우고 `referer`는 아예 보내지 않습니다. 이 두 헤더는 JS 코드(`fetch`의 `headers` 옵션)로 직접 지정해도 브라우저가 스푸핑 방지 차원에서 강제로 덮어씁니다.

서버는 CORS 응답에 `access-control-allow-origin: *`를 달아놔서 요청 자체는 거부하지 않고 `code: 0/OK`를 정상 반환하지만(그래서 에러가 안 뜸), **보상 지급 같은 실제 비즈니스 로직에서는 origin/referer로 "진짜 공식 페이지에서 온 요청인가"를 다시 검사해서 아니면 조용히 무시**하는 것으로 보입니다.

이건 JS 레벨에서는 못 고치고, `declarativeNetRequest`의 `modifyHeaders` 규칙([rules.json](rules.json))으로 네트워크 계층에서 강제로 덮어써야 합니다. 지금은 `zonai.skport.com/web/v1/*` 요청에 대해 `origin`/`referer`/`sec-fetch-site`를 공식 페이지와 동일한 값으로 고정합니다.

### 403 다시 로그인하지 마세요!

`sk-language`를 `ko`로 설정한 뒤로 서버가 한국어 오류 메시지를 반환하기 시작했습니다. `다시 로그인하지 마세요!`는 문자 그대로 재인증(`auth/refresh`)이나 출석 요청을 짧은 시간에 너무 많이 보내서 서버가 일시적으로 재로그인 자체를 막은 상태를 뜻합니다. **"세션 만료 → 다시 로그인하세요"와는 정반대 의미**이므로 `SESSION_EXPIRED`가 아니라 `LOGIN_RATE_LIMITED`라는 별도 상태로 분류합니다.

이 상태는 확장 프로그램이 막은 게 아니라 서버가 막은 것이라, `MAX_DAILY_RETRY_ALARMS`(하루 3회) 자동 재시도 상한과는 무관하게 **수동 지금 체크는 계속 시도할 수 있습니다.** 다만 서버 차단이 풀리기 전까지는 수동으로 눌러도 같은 응답을 받습니다. 보통 짧은 시간(수 분~수 시간) 안에 풀리며, 늦어도 다음 날 자정(UTC+8 `00:05`) 자동 실행 때는 해소되어 있을 가능성이 높습니다.

### 当前用户未经授权

다른 계정으로 로그인했지만 해당 계정에 연동된 Endfield 게임 계정이 없으면 HTTP `403`과 `当前用户未经授权` 메시지가 반환될 수 있습니다. 경우에 따라 `sk-game-role`이 비어 있어 HTTP `400`과 `参数错误`(`sk-language: ko`일 때는 한국어로 `매개변수 오류`)가 반환될 수도 있습니다.

이 경우 팝업에는 **게임 계정 연동 필요**로 표시됩니다. 게임 계정이 연동된 계정으로 로그인한 뒤 공식 출석 페이지를 한 번 새로고침하세요.

### 확장 프로그램 오류 목록의 Extension context invalidated

이전 버전의 content script가 남아 있는 탭에서 확장 프로그램을 다시 로드하면 Chrome이 `Extension context invalidated`를 표시할 수 있습니다. 현재 구현은 content script를 사용하지 않으므로 확장 프로그램을 새로고침하고 기존 공식 페이지 탭도 새로고침하면 더 이상 새 오류가 쌓이지 않아야 합니다. 이미 기록된 오류는 `chrome://extensions/`의 오류 화면에서 삭제할 수 있습니다.

## 프로젝트 파일

```text
manifest.json       Chrome 확장 프로그램 매니페스트
background.js       서비스 워커: 예약, 인증 헤더 캡처, API 호출
popup.html          확장 프로그램 팝업 UI
popup.js            팝업 렌더링과 수동 출석 실행
shared/messages.js  공통 메시지 코드와 API 메시지 번역
lib/md5.js          요청 서명에 사용하는 MD5 구현
icons/              확장 프로그램 아이콘
```

## License

MIT
