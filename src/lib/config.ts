import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as { lucyApiUrl?: string };

export const LUCY_API_URL = extra.lucyApiUrl?.trim() || '';

export const hasBackend = LUCY_API_URL.length > 0;
