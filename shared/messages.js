export const MESSAGE = {
  CHECKIN_COMPLETED: "CHECKIN_COMPLETED",
  REWARD_ALREADY_CLAIMED: "REWARD_ALREADY_CLAIMED",
  ALREADY_CHECKED_IN_TODAY: "ALREADY_CHECKED_IN_TODAY",
  OPEN_SIGNIN_PAGE_AFTER_LOGIN: "OPEN_SIGNIN_PAGE_AFTER_LOGIN",
  AUTO_CHECKIN_DISABLED: "AUTO_CHECKIN_DISABLED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SIGNING_TOKEN_NOT_FOUND: "SIGNING_TOKEN_NOT_FOUND",
  TIME_SYNC_REQUIRED: "TIME_SYNC_REQUIRED",
  REWARD_NOT_GRANTED: "REWARD_NOT_GRANTED",
  LOGIN_RATE_LIMITED: "LOGIN_RATE_LIMITED",
  SERVER_BUSY: "SERVER_BUSY",
  NETWORK_ERROR: "NETWORK_ERROR",
  SIGN_ERROR: "SIGN_ERROR",
  ROLE_MISMATCH: "ROLE_MISMATCH",
  EVENT_UNAVAILABLE: "EVENT_UNAVAILABLE",
  GAME_ROLE_NOT_LINKED: "GAME_ROLE_NOT_LINKED",
  MANUAL_COOLDOWN: "MANUAL_COOLDOWN",
  UNKNOWN_CHECKIN_ERROR: "UNKNOWN_CHECKIN_ERROR"
};

export const MESSAGE_TEXT = {
  OK: "출석 체크가 완료되었습니다.",
  [MESSAGE.CHECKIN_COMPLETED]: "출석 체크가 완료되었습니다.",
  [MESSAGE.REWARD_ALREADY_CLAIMED]: "오늘 보상을 이미 수령했습니다.",
  [MESSAGE.ALREADY_CHECKED_IN_TODAY]: "오늘 출석 체크가 이미 완료되었습니다.",
  [MESSAGE.OPEN_SIGNIN_PAGE_AFTER_LOGIN]: "로그인 후 공식 출석 페이지를 한 번 새로고침하세요.",
  [MESSAGE.AUTO_CHECKIN_DISABLED]: "자동 출석이 비활성화되어 있습니다.",
  [MESSAGE.SESSION_EXPIRED]: "세션이 만료되었습니다. 다시 로그인하세요.",
  [MESSAGE.SIGNING_TOKEN_NOT_FOUND]: "인증 갱신은 성공했지만 서명 토큰을 찾지 못했습니다.",
  [MESSAGE.TIME_SYNC_REQUIRED]: "기기 시간이 서버와 맞지 않습니다. 운영체제 시간을 자동 동기화한 뒤 다시 시도하세요.",
  [MESSAGE.REWARD_NOT_GRANTED]: "출석 요청은 서버에 전달됐지만 보상이 지급되지 않았습니다(awardIds 비어 있음). 잠시 후 지금 체크로 다시 시도하세요.",
  [MESSAGE.LOGIN_RATE_LIMITED]: "요청이 너무 잦아 서버가 일시적으로 재인증을 제한하고 있습니다. 지금은 다시 로그인하지 말고 시간을 두고 다시 시도하세요.",
  [MESSAGE.SERVER_BUSY]: "출석 서버 응답이 불안정합니다. 잠시 후 다시 시도하세요.",
  [MESSAGE.NETWORK_ERROR]: "네트워크 요청에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.",
  [MESSAGE.SIGN_ERROR]: "요청 서명 검증에 실패했습니다. 공식 출석 페이지를 새로고침한 뒤 다시 시도하세요.",
  [MESSAGE.ROLE_MISMATCH]: "현재 로그인된 계정과 저장된 게임 계정 정보가 맞지 않습니다. 로그아웃 후 다시 로그인하고 공식 출석 페이지를 새로고침하세요.",
  [MESSAGE.EVENT_UNAVAILABLE]: "현재 출석 이벤트를 사용할 수 없습니다. 공식 출석 페이지에서 이벤트 상태를 확인하세요.",
  [MESSAGE.GAME_ROLE_NOT_LINKED]: "현재 계정에 연동된 게임 계정이 없어 출석 체크를 할 수 없습니다.",
  [MESSAGE.MANUAL_COOLDOWN]: "너무 빠르게 다시 시도했습니다. 잠시 후 다시 눌러주세요.",
  [MESSAGE.UNKNOWN_CHECKIN_ERROR]: "알 수 없는 출석 체크 오류가 발생했습니다."
};

export function translateMessage(message) {
  if (typeof message === "string" && Object.prototype.hasOwnProperty.call(MESSAGE_TEXT, message)) {
    return MESSAGE_TEXT[message];
  }

  if (message?.startsWith?.("UNEXPECTED_API_CODE:")) {
    return `예상하지 못한 API 응답 코드: ${message.split(":")[1] || "unknown"}`;
  }

  if (isAlreadyClaimedMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.REWARD_ALREADY_CLAIMED];
  }

  if (isGameRoleUnauthorizedMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.GAME_ROLE_NOT_LINKED];
  }

  if (isTimeSyncErrorMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.TIME_SYNC_REQUIRED];
  }

  if (isLoginRateLimitedMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.LOGIN_RATE_LIMITED];
  }

  if (isSessionExpiredMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.SESSION_EXPIRED];
  }

  if (isServerBusyMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.SERVER_BUSY];
  }

  if (isNetworkErrorMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.NETWORK_ERROR];
  }

  if (isSignErrorMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.SIGN_ERROR];
  }

  if (isRoleMismatchMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.ROLE_MISMATCH];
  }

  if (isEventUnavailableMessage(message)) {
    return MESSAGE_TEXT[MESSAGE.EVENT_UNAVAILABLE];
  }

  return MESSAGE_TEXT[message] || message || "";
}

export function isAlreadyClaimedMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return message.includes("请勿重复签到")
    || lowerMessage.includes("already")
    || lowerMessage.includes("duplicate")
    || lowerMessage.includes("repeat");
}

export function isGameRoleUnauthorizedMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return message.includes("当前用户未经授权")
    || message.includes("参数错误")
    || message.includes("매개변수 오류")
    || lowerMessage.includes("parameter")
    || lowerMessage.includes("invalid parameter")
    || lowerMessage.includes("unauthorized");
}

export function isTimeSyncErrorMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return message.includes("请勿修改设备本地时间")
    || lowerMessage.includes("local time")
    || lowerMessage.includes("device time")
    || lowerMessage.includes("time sync")
    || lowerMessage.includes("timestamp");
}

export function isLoginRateLimitedMessage(message) {
  if (typeof message !== "string") return false;

  return message.includes("다시 로그인하지");
}

export function isSessionExpiredMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return message.includes("登录")
    || message.includes("登陆")
    || message.includes("未授权")
    || lowerMessage.includes("login")
    || lowerMessage.includes("session")
    || lowerMessage.includes("expired")
    || lowerMessage.includes("token")
    || lowerMessage.includes("credential");
}

export function isServerBusyMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return lowerMessage.includes("too many")
    || lowerMessage.includes("rate limit")
    || lowerMessage.includes("server")
    || lowerMessage.includes("maintenance")
    || lowerMessage.includes("temporarily")
    || lowerMessage.includes("timeout")
    || message.includes("服务器")
    || message.includes("维护")
    || message.includes("繁忙");
}

export function isNetworkErrorMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return lowerMessage.includes("failed to fetch")
    || lowerMessage.includes("network")
    || lowerMessage.includes("load failed")
    || lowerMessage.includes("connection");
}

export function isSignErrorMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return message.includes("签名")
    || lowerMessage.includes("sign error")
    || lowerMessage.includes("invalid sign")
    || lowerMessage.includes("signature")
    || lowerMessage.includes("hmac");
}

export function isRoleMismatchMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return message.includes("角色")
    || message.includes("캐릭터를 찾을 수 없습니다")
    || lowerMessage.includes("role not found")
    || lowerMessage.includes("role invalid")
    || lowerMessage.includes("character not found")
    || lowerMessage.includes("character invalid");
}

export function isEventUnavailableMessage(message) {
  if (typeof message !== "string") return false;

  const lowerMessage = message.toLowerCase();
  return message.includes("活动结束")
    || message.includes("活动未开始")
    || message.includes("活动不存在")
    || lowerMessage.includes("event not active")
    || lowerMessage.includes("activity closed")
    || lowerMessage.includes("activity not started")
    || lowerMessage.includes("event closed")
    || lowerMessage.includes("event unavailable");
}
