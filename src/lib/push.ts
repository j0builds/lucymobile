import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { registerDevice } from './api';
import { hasBackend } from './config';

// Lucy push payloads. Mirrors the server's `data` contract.
export type PushType = 'reinforce' | 'needs_you' | 'interception';

export type LucyPushData = {
  type: PushType;
  id: string;
};

/** Show alerts even when the app is foregrounded (Lucy nudges are short-lived). */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Request permission, fetch the Expo push token, and register it with Lucy.
 * Returns the token on success, null otherwise (sim, denied, no backend).
 * Safe to call repeatedly — registration is idempotent server-side.
 */
export async function registerForPush(): Promise<string | null> {
  if (!hasBackend) return null;
  if (!Device.isDevice) return null; // simulators have no push token

  const settings = await Notifications.getPermissionsAsync();
  let granted = settings.granted;
  if (!granted) {
    const req = await Notifications.requestPermissionsAsync();
    granted = req.granted;
  }
  if (!granted) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Lucy',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  let pushToken: string;
  try {
    const tokenResult = await Notifications.getExpoPushTokenAsync();
    pushToken = tokenResult.data;
  } catch {
    return null;
  }

  const platform: 'ios' | 'android' = Platform.OS === 'android' ? 'android' : 'ios';
  await registerDevice(pushToken, platform);
  return pushToken;
}

/** Narrow an unknown notification `data` blob into our typed shape. */
export function parsePushData(data: unknown): LucyPushData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'string') return null;
  if (d.type === 'reinforce' || d.type === 'needs_you' || d.type === 'interception') {
    return { type: d.type, id: d.id };
  }
  return null;
}
