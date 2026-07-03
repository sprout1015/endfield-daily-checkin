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

const statusTitle = document.querySelector("#statusTitle");
const statusMessage = document.querySelector("#statusMessage");
const todayBadge = document.querySelector("#todayBadge");
const autoTitle = document.querySelector("#autoTitle");
const autoSub = document.querySelector("#autoSub");
const autoToggle = document.querySelector("#autoToggle");
const completionState = document.querySelector("#completionState");
const nextRun = document.querySelector("#nextRun");
const credentialState = document.querySelector("#credentialState");
const lastCheck = document.querySelector("#lastCheck");
const checkButton = document.querySelector("#checkButton");
const hintText = document.querySelector("#hintText");

const TEXT = {
  enabled: "활성",
  disabled: "비활성",
  enabledSub: "매일 00:05 UTC+8 기준 자동 실행",
  disabledSub: "자동 실행이 꺼져 있습니다",
  loadingTitle: "불러오는 중...",
  loadingMessage: "확장 상태를 확인하고 있습니다",
  checkingTitle: "체크 중...",
  checkingMessage: "출석 API를 호출하고 있습니다",
  readyState: "출석 준비 완료",
  refreshNeeded: "공식 페이지 새로고침 필요",
  popupError: "팝업 오류",
  popupErrorMessage: "확장 상태를 읽지 못했습니다.",
  visitPage: "로그인 후 공식 출석 페이지를 한 번 새로고침하세요.",
  ready: "수동 체크와 자동 체크를 실행할 수 있습니다.",
  checkNow: "지금 체크",
  readyTitle: "준비됨",
  notDone: "오늘 미완료",
  doneSuffix: "출석 완료",
  noSchedule: "자동 출석 꺼짐",
  error: "오류"
};

const STATUS_LABELS = {
  success: ["성공", "ok"],
  already_claimed: ["이미 수령됨", "ok"],
  already_done: ["오늘 완료", "ok"],
  missing_credentials: ["출석 준비 필요", "warn"],
  session_expired: ["세션 만료", "warn"],
  time_sync_required: ["시간 동기화 필요", "warn"],
  reward_not_granted: ["보상 미지급 - 재시도 필요", "warn"],
  login_rate_limited: ["재인증 제한 - 잠시 후 재시도", "warn"],
  server_busy: ["서버 응답 불안정", "warn"],
  network_error: ["네트워크 오류", "warn"],
  sign_error: ["서명 검증 실패", "warn"],
  role_mismatch: ["계정 정보 불일치", "warn"],
  event_unavailable: ["이벤트 확인 필요", "warn"],
  game_role_not_linked: ["게임 계정 연동 필요", "warn"],
  error: ["오류", "warn"],
  disabled: ["자동 비활성", "warn"],
  cooldown: ["잠시 후 재시도", "warn"]
};

statusTitle.textContent = TEXT.loadingTitle;
statusMessage.textContent = TEXT.loadingMessage;

document.addEventListener("DOMContentLoaded", refreshStatus);
checkButton.addEventListener("click", runManualCheckin);
autoToggle.addEventListener("change", updateAutoCheckin);

async function refreshStatus() {
  setButtonBusy(false);

  try {
    const status = await sendMessage({ type: "GET_STATUS" });
    renderStatus(status);
  } catch (error) {
    renderError(error);
  }
}

async function runManualCheckin() {
  setButtonBusy(true);
  statusTitle.textContent = TEXT.checkingTitle;
  statusMessage.textContent = TEXT.checkingMessage;

  try {
    const result = await sendMessage({ type: "RUN_CHECKIN" });
    statusTitle.textContent = labelFor(result.status)[0];
    statusMessage.textContent = translateMessage(result.message) || result.message || "";
    await refreshStatus();
  } catch (error) {
    renderError(error);
  } finally {
    setButtonBusy(false);
  }
}

async function updateAutoCheckin() {
  autoToggle.disabled = true;

  try {
    await sendMessage({
      type: "SET_AUTO_CHECKIN",
      enabled: autoToggle.checked
    });
    await refreshStatus();
  } catch (error) {
    renderError(error);
  } finally {
    autoToggle.disabled = false;
  }
}

function renderStatus(status) {
  const normalized = normalizeStatus(status);
  const statusKey = normalized.lastStatus || "idle";
  const [label, tone] = labelFor(statusKey);
  const completionDate = normalized.lastCheckinDate || (isAlreadyClaimedMessage(normalized.lastMessage) ? status.today : "");
  const isComplete = (
    completionDate === status.today
    && ["success", "already_claimed", "already_done"].includes(statusKey)
  ) || isAlreadyClaimedMessage(normalized.lastMessage);

  statusTitle.textContent = label;
  statusMessage.textContent = translateMessage(normalized.lastMessage) || initialMessage(status);
  todayBadge.textContent = status.autoCheckinEnabled ? TEXT.enabled : TEXT.disabled;
  todayBadge.className = `badge ${status.autoCheckinEnabled ? "" : "warn"}`;

  autoTitle.textContent = status.autoCheckinEnabled ? TEXT.enabled : TEXT.disabled;
  autoSub.textContent = status.autoCheckinEnabled ? TEXT.enabledSub : TEXT.disabledSub;
  autoToggle.checked = status.autoCheckinEnabled;

  completionState.textContent = isComplete
    ? `${formatServerDate(completionDate)} ${TEXT.doneSuffix}`
    : TEXT.notDone;
  nextRun.textContent = status.autoCheckinEnabled ? formatDateTime(status.nextRunAt) : TEXT.noSchedule;
  credentialState.textContent = status.hasCred && status.hasRoleId ? TEXT.readyState : TEXT.refreshNeeded;
  lastCheck.textContent = formatDateTime(status.lastCheckinAt);

  hintText.textContent = status.hasCred && status.hasRoleId ? TEXT.ready : TEXT.visitPage;

  if (tone === "warn") {
    todayBadge.classList.add("warn");
  }
}

function normalizeStatus(status) {
  if (status.lastStatus === "error" && isAlreadyClaimedMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "already_claimed",
      lastMessage: MESSAGE.REWARD_ALREADY_CLAIMED,
      lastCheckinDate: status.lastCheckinDate || status.today
    };
  }

  if (status.lastStatus === "error" && isGameRoleUnauthorizedMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "game_role_not_linked",
      lastMessage: MESSAGE.GAME_ROLE_NOT_LINKED
    };
  }

  if (status.lastStatus === "error" && isTimeSyncErrorMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "time_sync_required",
      lastMessage: MESSAGE.TIME_SYNC_REQUIRED
    };
  }

  if (status.lastStatus === "error" && isLoginRateLimitedMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "login_rate_limited",
      lastMessage: MESSAGE.LOGIN_RATE_LIMITED
    };
  }

  if (status.lastStatus === "error" && isSessionExpiredMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "session_expired",
      lastMessage: MESSAGE.SESSION_EXPIRED
    };
  }

  if (status.lastStatus === "error" && isServerBusyMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "server_busy",
      lastMessage: MESSAGE.SERVER_BUSY
    };
  }

  if (status.lastStatus === "error" && isNetworkErrorMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "network_error",
      lastMessage: MESSAGE.NETWORK_ERROR
    };
  }

  if (status.lastStatus === "error" && isSignErrorMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "sign_error",
      lastMessage: MESSAGE.SIGN_ERROR
    };
  }

  if (status.lastStatus === "error" && isRoleMismatchMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "role_mismatch",
      lastMessage: MESSAGE.ROLE_MISMATCH
    };
  }

  if (status.lastStatus === "error" && isEventUnavailableMessage(status.lastMessage)) {
    return {
      ...status,
      lastStatus: "event_unavailable",
      lastMessage: MESSAGE.EVENT_UNAVAILABLE
    };
  }

  return status;
}

function renderError(error) {
  statusTitle.textContent = TEXT.popupError;
  statusMessage.textContent = error?.message || TEXT.popupErrorMessage;
  todayBadge.textContent = TEXT.error;
  todayBadge.className = "badge warn";
  setButtonBusy(false);
}

function initialMessage(status) {
  if (!status.hasCred || !status.hasRoleId) {
    return TEXT.visitPage;
  }
  return TEXT.ready;
}

function labelFor(status) {
  return STATUS_LABELS[status] || [TEXT.readyTitle, ""];
}

function formatDateTime(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatServerDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";

  const [, month, day] = value.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

function setButtonBusy(isBusy) {
  checkButton.disabled = isBusy;
  checkButton.textContent = isBusy ? TEXT.checkingTitle : TEXT.checkNow;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}
