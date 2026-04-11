const SESSION_LIMITS = {
  dailySessionMs: 7_200_000,
  warningThresholdRatio: 0.8,
} as const;

const RATE_LIMITS = {
  perUserRequestsPerMinute: 30,
} as const;

export interface DeviceBinding {
  userId: string;
  deviceId: string;
  registeredAtIso: string;
  lastRotationAtIso: string;
}

export interface SessionUsageState {
  activeMsToday: number;
  requestsInCurrentMinute: number;
  concurrentRequests: number;
  minuteBucket: string;
}

export interface SessionWarnings {
  nearDailyLimit: boolean;
  nearRateLimit: boolean;
}

const minuteBucket = (now: Date): string => {
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${now.getUTCDate()}`.padStart(2, "0");
  const hour = `${now.getUTCHours()}`.padStart(2, "0");
  const minute = `${now.getUTCMinutes()}`.padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
};

export const createSessionUsageState = (now: Date): SessionUsageState => ({
  activeMsToday: 0,
  requestsInCurrentMinute: 0,
  concurrentRequests: 0,
  minuteBucket: minuteBucket(now),
});

export const updateRateWindow = (
  state: SessionUsageState,
  now: Date,
): SessionUsageState => {
  const nextBucket = minuteBucket(now);

  if (state.minuteBucket === nextBucket) {
    return state;
  }

  return {
    ...state,
    minuteBucket: nextBucket,
    requestsInCurrentMinute: 0,
  };
};

export const recordRequest = (
  state: SessionUsageState,
  now: Date,
): SessionUsageState => {
  const bucketUpdated = updateRateWindow(state, now);

  return {
    ...bucketUpdated,
    requestsInCurrentMinute: bucketUpdated.requestsInCurrentMinute + 1,
  };
};

export const computeWarnings = (state: SessionUsageState): SessionWarnings => {
  const nearDailyLimit =
    state.activeMsToday >=
    SESSION_LIMITS.dailySessionMs * SESSION_LIMITS.warningThresholdRatio;

  const nearRateLimit =
    state.requestsInCurrentMinute >=
    RATE_LIMITS.perUserRequestsPerMinute * SESSION_LIMITS.warningThresholdRatio;

  return {
    nearDailyLimit,
    nearRateLimit,
  };
};
