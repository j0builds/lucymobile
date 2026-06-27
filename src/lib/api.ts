import * as SecureStore from 'expo-secure-store';

import { LUCY_API_URL, hasBackend } from './config';

const KEY_STORAGE = 'lucy.apiKey';

export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_STORAGE);
}

export async function setApiKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_STORAGE, key);
}

export type CaptureResult =
  | { ok: true; committed: number; drafts: { id: string; title: string }[]; redactions: number }
  | { ok: false; reason: 'no-backend' }
  | { ok: false; reason: 'no-key' }
  | { ok: false; reason: 'http'; status: number; body: string }
  | { ok: false; reason: 'network'; message: string };

export async function captureText(text: string, ref?: string): Promise<CaptureResult> {
  if (!hasBackend) return { ok: false, reason: 'no-backend' };
  const key = await getApiKey();
  if (!key) return { ok: false, reason: 'no-key' };

  try {
    const res = await fetch(`${LUCY_API_URL.replace(/\/$/, '')}/v1/capture`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ text, ref: ref ?? `mobile:${Date.now()}` }),
    });
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, body: await res.text() };
    }
    const data = (await res.json()) as {
      committed?: number;
      drafts?: { id: string; title: string }[];
      redactions?: number;
    };
    return {
      ok: true,
      committed: data.committed ?? 0,
      drafts: data.drafts ?? [],
      redactions: data.redactions ?? 0,
    };
  } catch (e) {
    return { ok: false, reason: 'network', message: (e as Error).message };
  }
}
