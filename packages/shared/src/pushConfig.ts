export const PORTABLE_EXPO_PROJECT_ID = '114bef50-b96c-4db6-9c47-3c610bcdf321';
export const PORTABLE_IOS_APP_ID = 'cloud.umair.portable';
export const PORTABLE_ANDROID_APP_ID = 'dev.portable.app';
export const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

export function isExpoPushToken(value: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(value);
}

export function isTrustedPortableExpoSubscription(subscription: {
  endpoint: string;
  platform?: string;
  pushProvider?: string;
  projectId?: string;
  appId?: string;
}): boolean {
  return (
    subscription.pushProvider === 'expo' &&
    subscription.platform === 'ios' &&
    subscription.projectId === PORTABLE_EXPO_PROJECT_ID &&
    subscription.appId === PORTABLE_IOS_APP_ID &&
    isExpoPushToken(subscription.endpoint)
  );
}
