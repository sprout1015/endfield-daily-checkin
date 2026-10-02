import { md5 } from "./lib/md5.js";
import {
  MESSAGE,
  translateMessage,
  isAlreadyClaimedMessage,
  isGameRoleUnauthorizedMessage,
  isTimeSyncErrorMessage,
  isLoginRateLimitedMessage,
  isSessionExpiredMessage,
  isServerBusyMessage,
  isNetworkErrorMessage,
  isSignErrorMessage,
  isRoleMismatchMessage,
  isEventUnavailableMessage
} from "./shared/messages.js";

const CHECKIN_ALARM = "endfield-daily-checkin";
const RETRY_ALARM = "endfield-checkin-retry";
const CHECKIN_PATH = "/web/v1/game/endfield/attendance";
const API_ORIGIN = "https://zonai.skport.com";
const GAME_ORIGIN = "https://game.skport.com";
// 공식 웹 페이지가 로그인 후 cred를 캐시해 두는 쿠키(localStorage에도 동일 값 존재).
// webRequest 헤더 스니핑과 달리, 사용자가 공식 페이지에서 XHR을 유발하지 않아도
// 로그인 세션이 살아 있는 한 이 쿠키로 최신 cred를 확보할 수 있다.
const CRED_COOKIE_NAME = "SK_OAUTH_CRED_KEY";
const LANGUAGE = "ko";
const PLATFORM = "3";
const VERSION_NAME = "1.0.0";
const CHECKIN_TIMEZONE_OFFSET_HOURS = 8;
const CHECKIN_HOUR = 0;
const CHECKIN_MINUTE = 5;
const IMMEDIATE_RETRY_DELAY_MS = 3000;
const RETRY_ALARM_INTERVAL_MINUTES = 45;
const MAX_DAILY_RETRY_ALARMS = 3;
const MANUAL_CHECKIN_COOLDOWN_MS = 10000;
const CHECKIN_LOCK_TTL_MS = 60000;
const RETRYABLE_STATUSES = ["reward_not_granted", "server_busy", "network_error", "login_rate_limited", "error"];
let activeCheckin = null;

chrome.runtime.onInstalled.addListener(async () => {
  const { autoCheckinEnabled } = await chrome.storage.local.get("autoCheckinEnabled");
  if (typeof autoCheckinEnabled !== "boolean") {
    await chrome.storage.local.set({ autoCheckinEnabled: true });
  }
  scheduleDailyAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  scheduleDailyAlarm();
  await runMissedCheckin();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECKIN_ALARM) {
    runCheckin("alarm");
  }

  if (alarm.name === RETRY_ALARM) {
    runCheckin("retry");
  }
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (!isGameCookieChange(changeInfo.cookie)) return;

  chrome.storage.local.set({
    lastCookieChangeAt: new Date().toISOString(),
    lastCookieChangeCause: changeInfo.cause,
    lastCookieRemoved: changeInfo.removed
  });

  if (changeInfo.removed) {
    chrome.storage.local.set({
      lastStatus: "session_expired",
      lastMessage: MESSAGE.SESSION_EXPIRED,
      lastCheckinAt: new Date().toISOString()
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATUS") {
    getStatus().then(sendResponse);
    return true;
  }

  if (message?.type === "RUN_CHECKIN") {
    runCheckin("manual").then(sendResponse);
    return true;
  }

  if (message?.type === "SET_AUTO_CHECKIN") {
    setAutoCheckin(Boolean(message.enabled)).then(sendResponse);
    return true;
  }

  return false;
});

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    handleCapturedCredentials(details);
  },
  { urls: [`${API_ORIGIN}/*`], types: ["xmlhttprequest", "other"] },
  ["requestHeaders", "extraHeaders"]
);

async function handleCapturedCredentials(details) {
  const headers = details.requestHeaders || [];
  const cred = findHeader(headers, "cred");
  const roleId = findHeader(headers, "sk-game-role");

  if (!cred && !roleId) return;

  const saved = await chrome.storage.local.get([
    "autoCheckinEnabled",
    "cred",
    "roleId",
    "lastCheckinDate",
    "lastStatus"
  ]);
  const nextCred = cred || saved.cred;
  const nextRoleId = roleId || saved.roleId;
  const hadCredentials = Boolean(saved.cred && saved.roleId);
  const hasCredentials = Boolean(nextCred && nextRoleId);
  const becameReady = !hadCredentials && hasCredentials;

  // 계정이 실제로 바뀌었는지는 sk-game-role(게임 계정/캐릭터 식별자)로만 판단한다.
  // cred(세션 토큰)는 같은 계정이어도 주기적으로 갱신될 수 있어서, cred만 바뀐 것을
  // 계정 전환으로 취급하면 이미 완료된 오늘 출석까지 매번 다시 시도하게 된다.
  const accountChanged = Boolean(roleId && saved.roleId && roleId !== saved.roleId);

  const updates = {
    credentialsCapturedAt: new Date().toISOString()
  };

  if (cred) updates.cred = cred;
  if (roleId) updates.roleId = roleId;

  if (accountChanged) {
    updates.lastCheckinDate = "";
  }

  await chrome.storage.local.set(updates);

  if (
    saved.autoCheckinEnabled !== false
    && hasCredentials
    && (becameReady || accountChanged)
    && (accountChanged || !isTodayCompleted(saved))
  ) {
    runCheckin("credentials");
  }
}

function findHeader(headers, name) {
  const lowerName = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lowerName)?.value || "";
}

function isGameCookieChange(cookie) {
  if (!cookie?.domain) return false;
  return cookie.domain.includes("skport.com") || cookie.domain.includes("gryphline.com");
}

function scheduleDailyAlarm() {
  chrome.alarms.create(CHECKIN_ALARM, {
    when: nextCheckinTime(),
    periodInMinutes: 24 * 60
  });
}

function nextCheckinTime() {
  const now = new Date();
  const serverNow = new Date(now.getTime() + CHECKIN_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
  const targetServerTime = new Date(serverNow);

  targetServerTime.setUTCHours(CHECKIN_HOUR, CHECKIN_MINUTE, 0, 0);

  if (targetServerTime <= serverNow) {
    targetServerTime.setUTCDate(targetServerTime.getUTCDate() + 1);
  }

  return targetServerTime.getTime() - CHECKIN_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
}

async function maybeScheduleRetryAlarm(status) {
  if (!RETRYABLE_STATUSES.includes(status)) return;

  const today = todayServerDate();
  const { retryAlarmCount, retryAlarmDate } = await chrome.storage.local.get([
    "retryAlarmCount",
    "retryAlarmDate"
  ]);
  const currentCount = retryAlarmDate === today ? (retryAlarmCount || 0) : 0;

  if (currentCount >= MAX_DAILY_RETRY_ALARMS) {
    debugLog("maybeScheduleRetryAlarm:max-retries-reached", { status, currentCount });
    return;
  }

  await chrome.storage.local.set({
    retryAlarmCount: currentCount + 1,
    retryAlarmDate: today
  });

  chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_ALARM_INTERVAL_MINUTES });
  debugLog("maybeScheduleRetryAlarm:scheduled", {
    status,
    attempt: currentCount + 1,
    inMinutes: RETRY_ALARM_INTERVAL_MINUTES
  });
}

async function runMissedCheckin() {
  const { autoCheckinEnabled, lastCheckinDate } = await chrome.storage.local.get([
    "autoCheckinEnabled",
    "lastCheckinDate"
  ]);

  if (autoCheckinEnabled === false) return;

  if (lastCheckinDate !== todayServerDate()) {
    await runCheckin("startup");
  }
}

function runCheckin(source = "manual") {
  if (activeCheckin) return activeCheckin;

  activeCheckin = runCheckinWithLock(source)
    .then(async (result) => {
      await maybeScheduleRetryAlarm(result?.status);
      return result;
    })
    .finally(() => {
      activeCheckin = null;
    });

  return activeCheckin;
}

async function runCheckinWithLock(source) {
  // activeCheckin은 서비스 워커가 켜져 있는 동안에만 유효한 메모리 값이라, 서비스
  // 워커가 재시작되면(할 일이 없을 때 자동으로 꺼졌다 켜짐) 초기화된다. 그 재시작
  // 타이밍에 다른 트리거가 겹치면 중복 요청이 나갈 수 있어, chrome.storage.local에
  // 남기는 잠금으로 재시작에도 살아남는 보호를 추가한다. TTL은 한 번의 시도가
  // 걸릴 수 있는 최대 시간(즉시 재시도 포함)보다 넉넉하게 잡아, 잠금이 영영 안
  // 풀리는 경우를 방지한다.
  const { checkinLockAt } = await chrome.storage.local.get("checkinLockAt");
  const lockElapsedMs = checkinLockAt ? Date.now() - checkinLockAt : Infinity;

  if (lockElapsedMs < CHECKIN_LOCK_TTL_MS) {
    debugLog("runCheckin:skip:locked-by-another-run", { source, lockElapsedMs });
    return { ok: true, status: "locked", message: MESSAGE.CHECKIN_IN_PROGRESS };
  }

  await chrome.storage.local.set({ checkinLockAt: Date.now() });

  try {
    return await performCheckin(source);
  } finally {
    await chrome.storage.local.remove("checkinLockAt");
  }
}

function isTodayCompleted(status) {
  return status.lastCheckinDate === todayServerDate()
    && ["success", "already_claimed", "already_done"].includes(status.lastStatus);
}

async function getStatus() {
  const data = await chrome.storage.local.get([
    "autoCheckinEnabled",
    "cred",
    "roleId",
    "credentialsCapturedAt",
    "lastCheckinDate",
    "lastCheckinAt",
    "lastStatus",
    "lastMessage",
    "lastCookieChangeAt",
    "lastCookieChangeCause",
    "lastCookieRemoved"
  ]);

  const accountToken = await getAccountToken();
  // 저장된 cred가 있으면 준비 상태가 이미 충족되므로 쿠키를 읽지 않는다(불필요한 조회 회피).
  const credCookie = data.cred ? "" : await getCredFromCookie();

  return {
    ...data,
    hasCred: Boolean(data.cred),
    hasCredCookie: Boolean(credCookie),
    hasRoleId: Boolean(data.roleId),
    hasAccountToken: Boolean(accountToken?.value),
    autoCheckinEnabled: data.autoCheckinEnabled !== false,
    today: todayServerDate(),
    nextRunAt: new Date(nextCheckinTime()).toISOString()
  };
}

async function performCheckin(source = "manual") {
  debugLog("performCheckin:start", { source });

  if (source === "manual") {
    const { lastManualCheckinAt } = await chrome.storage.local.get("lastManualCheckinAt");
    const elapsedMs = lastManualCheckinAt ? Date.now() - lastManualCheckinAt : Infinity;

    if (elapsedMs < MANUAL_CHECKIN_COOLDOWN_MS) {
      debugLog("performCheckin:short-circuit:manual-cooldown", { elapsedMs });
      return { ok: true, status: "cooldown", message: MESSAGE.MANUAL_COOLDOWN };
    }

    await chrome.storage.local.set({ lastManualCheckinAt: Date.now() });
  }

  if (source !== "manual") {
    const { autoCheckinEnabled } = await chrome.storage.local.get("autoCheckinEnabled");
    if (autoCheckinEnabled === false) {
      debugLog("performCheckin:auto-disabled", {});
      return { ok: true, status: "disabled", message: MESSAGE.AUTO_CHECKIN_DISABLED };
    }
  }

  const today = todayServerDate();
  const saved = await chrome.storage.local.get([
    "cred",
    "roleId",
    "lastCheckinDate",
    "lastStatus"
  ]);

  debugLog("performCheckin:saved-state", {
    today,
    hasCred: Boolean(saved.cred),
    hasRoleId: Boolean(saved.roleId),
    lastCheckinDate: saved.lastCheckinDate,
    lastStatus: saved.lastStatus
  });

  if (saved.lastCheckinDate === today && ["success", "already_claimed", "already_done"].includes(saved.lastStatus)) {
    debugLog("performCheckin:short-circuit:cached-result", {});
    return await saveResult({
      status: "already_done",
      message: MESSAGE.ALREADY_CHECKED_IN_TODAY,
      notify: source === "manual"
    });
  }

  // 저장된 cred가 없으면(최초 실행·저장소 초기화·헤더 미캡처 등) 공식 페이지가
  // 로그인 후 남겨둔 쿠키에서 cred를 확보한다. 저장된 cred가 있을 때는 기존
  // 동작을 그대로 두어(스니핑 우선) 회귀 위험을 만들지 않는다.
  if (!saved.cred) {
    const cookieCred = await getCredFromCookie();
    if (cookieCred) {
      // 검증 전이라 저장소에 쓰지 않고 이번 실행에서만 사용한다. 쿠키의 cred가
      // 만료/무효여도 저장소를 오염시키지 않아, 다음 실행의 안내("공식 페이지
      // 새로고침 필요")가 어긋나지 않는다. refresh가 새 cred를 돌려주면 기존
      // 로직이 그때 저장한다.
      saved.cred = cookieCred;
      debugLog("performCheckin:cred-from-cookie", {});
    }
  }

  if (!saved.cred) {
    debugLog("performCheckin:short-circuit:missing-cred", {});
    return await saveResult({
      status: "missing_credentials",
      message: MESSAGE.OPEN_SIGNIN_PAGE_AFTER_LOGIN,
      notify: true
    });
  }

  try {
    const refresh = await refreshAuth(saved.cred);
    debugLog("refreshAuth:response", refresh);

    if (Number(refresh?.code) === 40101) {
      debugLog("performCheckin:short-circuit:time-sync-required", {});
      return await handleAttendanceResult(refresh);
    }

    const signToken = pickValue(refresh, [
      "token",
      "salt",
      "signSalt",
      "authSalt",
      "sign_salt",
      "signingSalt",
      "secret",
      "secretKey"
    ]);
    const nextCred = pickValue(refresh, ["cred", "credential"]);
    const cred = nextCred || saved.cred;
    const attendanceTimestamp = normalizeTimestamp(pickValue(refresh, [
      "timestamp",
      "serverTimestamp",
      "server_time",
      "ts"
    ]));

    if (nextCred && nextCred !== saved.cred) {
      await chrome.storage.local.set({ cred: nextCred });
    }

    if (!signToken) {
      debugLog("performCheckin:short-circuit:no-sign-token", {});
      return await saveResult({
        status: "error",
        message: MESSAGE.SIGNING_TOKEN_NOT_FOUND,
        notify: true
      });
    }

    const roleId = saved.roleId || "";
    let outcome = await attemptClaim({ cred, roleId, signToken, timestamp: attendanceTimestamp || timestampSeconds() });

    if (isInconclusiveClaim(outcome)) {
      debugLog("performCheckin:retry:awardIds-empty-first-attempt", {});
      await delay(IMMEDIATE_RETRY_DELAY_MS);
      outcome = await attemptClaim({ cred, roleId, signToken, timestamp: timestampSeconds() });
    }

    return await handleAttendanceResult(outcome);
  } catch (error) {
    debugLog("performCheckin:exception", { message: error?.message, stack: error?.stack });
    const normalizedMessage = normalizeThrownError(error);
    return await saveResult({
      status: statusForMessage(normalizedMessage),
      message: normalizedMessage,
      notify: true
    });
  }
}

function debugLog(label, payload) {
  try {
    console.log(`[EF-DEBUG] ${label}`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[EF-DEBUG] ${label}`, payload);
  }
}

async function refreshAuth(cred) {
  const timestamp = timestampSeconds();
  const response = await fetch(`${API_ORIGIN}/web/v1/auth/refresh`, {
    method: "GET",
    headers: {
      "cred": cred,
      "platform": PLATFORM,
      "vName": VERSION_NAME,
      "timestamp": timestamp,
      "sk-language": LANGUAGE
    },
    credentials: "include"
  });

  return await parseApiResponse(response, "Auth refresh failed");
}

async function claimAttendance({ cred, roleId, signToken, timestamp = timestampSeconds() }) {
  const body = "";
  const sign = await computeSign(CHECKIN_PATH, body, timestamp, signToken);

  const response = await fetch(`${API_ORIGIN}${CHECKIN_PATH}`, {
    method: "POST",
    headers: {
      "accept": "*/*",
      "content-type": "application/json",
      "cred": cred,
      "platform": PLATFORM,
      "vName": VERSION_NAME,
      "timestamp": timestamp,
      "sk-language": LANGUAGE,
      "sk-game-role": roleId,
      "sign": sign
    },
    body,
    credentials: "include"
  });

  return await parseApiResponse(response, "Attendance request failed");
}

async function getAttendanceInfo({ cred, roleId, signToken, timestamp = timestampSeconds() }) {
  const body = "";
  const sign = await computeSign(CHECKIN_PATH, body, timestamp, signToken);

  const response = await fetch(`${API_ORIGIN}${CHECKIN_PATH}`, {
    method: "GET",
    headers: {
      "accept": "*/*",
      "content-type": "application/json",
      "cred": cred,
      "platform": PLATFORM,
      "vName": VERSION_NAME,
      "timestamp": timestamp,
      "sk-language": LANGUAGE,
      "sk-game-role": roleId,
      "sign": sign
    },
    credentials: "include"
  });

  return await parseApiResponse(response, "Attendance info request failed");
}

async function attemptClaim({ cred, roleId, signToken, timestamp }) {
  // 공식 사이트는 지금 체크 시 같은 timestamp로 GET을 먼저 보낸 뒤 곧바로 POST를 보낸다.
  // GET 없이 POST만 단독으로 보내면 code:0/OK는 받아도 awardIds가 비어 오는 것이 확인되어,
  // 완료 판정용이 아니라 이 선행 조건을 맞추기 위한 용도로 GET을 먼저 호출한다.
  const attendanceInfo = await getAttendanceInfo({ cred, roleId, signToken, timestamp });
  debugLog("getAttendanceInfo:response", attendanceInfo);

  if (Number(attendanceInfo?.code) !== 0) {
    return attendanceInfo;
  }

  const result = await claimAttendance({ cred, roleId, signToken, timestamp });
  debugLog("claimAttendance:POST:response", result);

  return result;
}

function isInconclusiveClaim(result) {
  return Number(result?.code) === 0 && !hasClaimedAwards(result);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseApiResponse(response, fallbackMessage) {
  const text = await response.text();
  let json = {};

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${fallbackMessage}: invalid JSON response`);
    }
  }

  if (!response.ok) {
    if (isAlreadyClaimedResponse(response, json)) {
      return alreadyClaimedResponse(response, json);
    }

    if (isGameRoleUnauthorizedResponse(response, json)) {
      return gameRoleUnauthorizedResponse(response, json);
    }

    if (isTimeSyncResponse(response, json)) {
      return timeSyncResponse(response, json);
    }

    if (isLoginRateLimitedResponse(response, json)) {
      return loginRateLimitedResponse(response, json);
    }

    if (isSessionExpiredResponse(response, json)) {
      return sessionExpiredResponse(response, json);
    }

    if (isServerBusyResponse(response, json)) {
      return serverBusyResponse(response, json);
    }

    if (isSignErrorResponse(response, json)) {
      return signErrorResponse(response, json);
    }

    if (isRoleMismatchResponse(response, json)) {
      return roleMismatchResponse(response, json);
    }

    if (isEventUnavailableResponse(response, json)) {
      return eventUnavailableResponse(response, json);
    }

    const message = pickValue(json, ["message", "msg", "error"]) || response.statusText;
    throw new Error(`${fallbackMessage}: ${response.status} ${message}`);
  }

  return json;
}

function alreadyClaimedResponse(response, json) {
  return {
    code: 10001,
    data: json.data || null,
    message: MESSAGE.REWARD_ALREADY_CLAIMED,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function gameRoleUnauthorizedResponse(response, json) {
  return {
    code: 40301,
    data: json.data || null,
    message: MESSAGE.GAME_ROLE_NOT_LINKED,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function timeSyncResponse(response, json) {
  return {
    code: 40101,
    data: json.data || null,
    message: MESSAGE.TIME_SYNC_REQUIRED,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function loginRateLimitedResponse(response, json) {
  return {
    code: 40302,
    data: json.data || null,
    message: MESSAGE.LOGIN_RATE_LIMITED,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function sessionExpiredResponse(response, json) {
  return {
    code: 10000,
    data: json.data || null,
    message: MESSAGE.SESSION_EXPIRED,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function serverBusyResponse(response, json) {
  return {
    code: 50301,
    data: json.data || null,
    message: MESSAGE.SERVER_BUSY,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function signErrorResponse(response, json) {
  return {
    code: 40001,
    data: json.data || null,
    message: MESSAGE.SIGN_ERROR,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function roleMismatchResponse(response, json) {
  return {
    code: 40002,
    data: json.data || null,
    message: MESSAGE.ROLE_MISMATCH,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function eventUnavailableResponse(response, json) {
  return {
    code: 40003,
    data: json.data || null,
    message: MESSAGE.EVENT_UNAVAILABLE,
    status: response.status,
    rawMessage: pickValue(json, ["message", "msg", "error"]) || response.statusText
  };
}

function isAlreadyClaimedResponse(response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return response.status === 403 && isAlreadyClaimedMessage(message);
}

function isGameRoleUnauthorizedResponse(response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return (response.status === 403 || response.status === 400)
    && isGameRoleUnauthorizedMessage(message);
}

function isTimeSyncResponse(response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return response.status === 401 && isTimeSyncErrorMessage(message);
}

function isLoginRateLimitedResponse(response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return response.status === 403 && isLoginRateLimitedMessage(message);
}

function isSessionExpiredResponse(response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return (response.status === 401 || response.status === 403) && isSessionExpiredMessage(message);
}

function isServerBusyResponse(response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return response.status === 429 || response.status >= 500 || isServerBusyMessage(message);
}

function isSignErrorResponse(_response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return isSignErrorMessage(message);
}

function isRoleMismatchResponse(_response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return isRoleMismatchMessage(message);
}

function isEventUnavailableResponse(_response, json) {
  const message = pickValue(json, ["message", "msg", "error"]);
  return isEventUnavailableMessage(message);
}

async function handleAttendanceResult(result) {
  const code = Number(result?.code);
  const message = pickValue(result, ["message", "msg"]) || "";

  if (code === 0) {
    if (!hasClaimedAwards(result)) {
      return await saveResult({
        status: "reward_not_granted",
        message: MESSAGE.REWARD_NOT_GRANTED,
        notify: true
      });
    }

    return await saveResult({
      status: "success",
      message: message === "OK" ? MESSAGE.CHECKIN_COMPLETED : message || MESSAGE.CHECKIN_COMPLETED,
      lastCheckinDate: todayServerDate(),
      notify: true
    });
  }

  if (code === 10001) {
    return await saveResult({
      status: "already_claimed",
      message: message || MESSAGE.REWARD_ALREADY_CLAIMED,
      lastCheckinDate: todayServerDate(),
      notify: true
    });
  }

  if (code === 10000) {
    return await saveResult({
      status: "session_expired",
      message: message || MESSAGE.SESSION_EXPIRED,
      notify: true
    });
  }

  if (code === 40301) {
    return await saveResult({
      status: "game_role_not_linked",
      message: message || MESSAGE.GAME_ROLE_NOT_LINKED,
      notify: true
    });
  }

  if (code === 40302) {
    return await saveResult({
      status: "login_rate_limited",
      message: message || MESSAGE.LOGIN_RATE_LIMITED,
      notify: true
    });
  }

  if (code === 40101) {
    return await saveResult({
      status: "time_sync_required",
      message: message || MESSAGE.TIME_SYNC_REQUIRED,
      notify: true
    });
  }

  if (code === 50301) {
    return await saveResult({
      status: "server_busy",
      message: message || MESSAGE.SERVER_BUSY,
      notify: true
    });
  }

  if (code === 40001) {
    return await saveResult({
      status: "sign_error",
      message: message || MESSAGE.SIGN_ERROR,
      notify: true
    });
  }

  if (code === 40002) {
    return await saveResult({
      status: "role_mismatch",
      message: message || MESSAGE.ROLE_MISMATCH,
      notify: true
    });
  }

  if (code === 40003) {
    return await saveResult({
      status: "event_unavailable",
      message: message || MESSAGE.EVENT_UNAVAILABLE,
      notify: true
    });
  }

  return await saveResult({
    status: "error",
    message: message || `UNEXPECTED_API_CODE:${result?.code ?? "unknown"}`,
    notify: true
  });
}

async function saveResult({ status, message, lastCheckinDate, notify = false }) {
  const payload = {
    lastStatus: status,
    lastMessage: message,
    lastCheckinAt: new Date().toISOString()
  };

  if (lastCheckinDate) {
    payload.lastCheckinDate = lastCheckinDate;
  }

  await chrome.storage.local.set(payload);

  if (notify) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "엔드필드 출석 체크",
      message: translateMessage(message)
    });
  }

  return {
    ok: ["success", "already_claimed", "already_done"].includes(status),
    status,
    message
  };
}

function normalizeThrownError(error) {
  const message = error?.message || "";

  if (isNetworkErrorMessage(message)) {
    return MESSAGE.NETWORK_ERROR;
  }

  if (isLoginRateLimitedMessage(message)) {
    return MESSAGE.LOGIN_RATE_LIMITED;
  }

  if (isSessionExpiredMessage(message)) {
    return MESSAGE.SESSION_EXPIRED;
  }

  if (isServerBusyMessage(message)) {
    return MESSAGE.SERVER_BUSY;
  }

  if (isSignErrorMessage(message)) {
    return MESSAGE.SIGN_ERROR;
  }

  if (isRoleMismatchMessage(message)) {
    return MESSAGE.ROLE_MISMATCH;
  }

  if (isEventUnavailableMessage(message)) {
    return MESSAGE.EVENT_UNAVAILABLE;
  }

  return message || MESSAGE.UNKNOWN_CHECKIN_ERROR;
}

function statusForMessage(message) {
  if (message === MESSAGE.NETWORK_ERROR) return "network_error";
  if (message === MESSAGE.SESSION_EXPIRED) return "session_expired";
  if (message === MESSAGE.SERVER_BUSY) return "server_busy";
  if (message === MESSAGE.TIME_SYNC_REQUIRED) return "time_sync_required";
  if (message === MESSAGE.GAME_ROLE_NOT_LINKED) return "game_role_not_linked";
  if (message === MESSAGE.LOGIN_RATE_LIMITED) return "login_rate_limited";
  if (message === MESSAGE.SIGN_ERROR) return "sign_error";
  if (message === MESSAGE.ROLE_MISMATCH) return "role_mismatch";
  if (message === MESSAGE.EVENT_UNAVAILABLE) return "event_unavailable";
  return "error";
}

async function setAutoCheckin(enabled) {
  await chrome.storage.local.set({ autoCheckinEnabled: enabled });

  if (enabled) {
    scheduleDailyAlarm();
    await runMissedCheckin();
  } else {
    await chrome.alarms.clear(CHECKIN_ALARM);
  }

  return { ok: true, autoCheckinEnabled: enabled };
}

async function getAccountToken() {
  return await chrome.cookies.get({
    url: GAME_ORIGIN,
    name: "ACCOUNT_TOKEN"
  });
}

// 공식 페이지가 캐시해 둔 cred 쿠키를 읽는다. host_permissions에 game.skport.com이
// 있어 chrome.cookies로 접근 가능하며, 쿠키가 없거나 오류면 빈 문자열을 돌려준다.
async function getCredFromCookie() {
  try {
    const cookie = await chrome.cookies.get({
      url: GAME_ORIGIN,
      name: CRED_COOKIE_NAME
    });
    const raw = cookie?.value?.trim();
    if (!raw) return "";

    // 쿠키 값이 퍼센트 인코딩돼 있을 수 있어 best-effort로 디코딩한다(디코딩
    // 실패 시 원본 사용). 헤더로 캡처하는 cred는 디코딩된 형태이므로 맞춘다.
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch (error) {
    debugLog("getCredFromCookie:error", { message: error?.message });
    return "";
  }
}

async function computeSign(path, body, timestamp, salt) {
  const headerJson = JSON.stringify({
    platform: PLATFORM,
    timestamp,
    dId: "",
    vName: VERSION_NAME
  });
  const input = `${path}${body}${timestamp}${headerJson}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encodeUtf8(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const hmac = await crypto.subtle.sign("HMAC", key, encodeUtf8(input));
  return md5(bufferToHex(hmac));
}

function hasClaimedAwards(result) {
  const awardIds = result?.data?.awardIds;
  const awards = result?.data?.awards;

  return (Array.isArray(awardIds) && awardIds.length > 0)
    || (Array.isArray(awards) && awards.length > 0);
}

function pickValue(source, keys) {
  if (!source || typeof source !== "object") return "";

  const wanted = new Set(keys.map((key) => key.toLowerCase()));

  for (const key of keys) {
    if (source[key]) return source[key];
  }

  for (const [key, value] of Object.entries(source)) {
    if (wanted.has(key.toLowerCase()) && value) return value;
  }

  for (const value of Object.values(source)) {
    if (value && typeof value === "object") {
      const nested = pickValue(value, keys);
      if (nested) return nested;
    }
  }

  return "";
}

function encodeUtf8(value) {
  return new TextEncoder().encode(String(value));
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}

function normalizeTimestamp(value) {
  if (!value) return "";

  const timestamp = String(value).trim();
  if (/^\d{10}$/.test(timestamp)) return timestamp;
  if (/^\d{13}$/.test(timestamp)) {
    return Math.floor(Number(timestamp) / 1000).toString();
  }

  return "";
}

function todayServerDate() {
  const serverTime = new Date(Date.now() + CHECKIN_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
  return serverTime.toISOString().slice(0, 10);
}
