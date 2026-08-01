/**
 * Strict vs lenient keychain reads: the lenient readers swallow a SecureStore
 * failure to `null`, but at the boot gate `null` means "never paired" → scanner,
 * so the strict variants RETHROW; a SUCCESSFUL `null` still means "nothing stored".
 */

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

import {
  getConnectedPcId,
  getConnectedPcIdStrict,
  saveConnectedPcId,
} from '../src/features/pc-connect/connectedPcStore';
import {
  getE2eKey,
  getE2eKeyStrict,
  saveE2eKey,
} from '../src/features/pc-connect/deviceTokenStore';

const secureStore = jest.requireMock('expo-secure-store') as {
  __store: Map<string, string>;
  getItemAsync: jest.Mock;
};

afterEach(() => {
  secureStore.__store.clear();
});

describe('getConnectedPcIdStrict — rethrows storage failures', () => {
  it('resolves the stored pcId / null exactly like the lenient reader on success', async () => {
    expect(await getConnectedPcIdStrict()).toBeNull();
    await saveConnectedPcId('pc_alpha');
    expect(await getConnectedPcIdStrict()).toBe('pc_alpha');
  });

  it('RETHROWS a keychain read failure (never degrades to "never paired")', async () => {
    await saveConnectedPcId('pc_alpha');
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(getConnectedPcIdStrict()).rejects.toThrow('keychain locked');
    expect(await getConnectedPcIdStrict()).toBe('pc_alpha');
  });

  it('the lenient reader still swallows the same failure to null (picker posture)', async () => {
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
    await expect(getConnectedPcId()).resolves.toBeNull();
  });
});

describe('getE2eKeyStrict — rethrows storage failures', () => {
  it('resolves the stored key / null exactly like the lenient reader on success', async () => {
    expect(await getE2eKeyStrict('pc_alpha')).toBeNull();
    await saveE2eKey('pc_alpha', 'psk-base64');
    expect(await getE2eKeyStrict('pc_alpha')).toBe('psk-base64');
  });

  it('RETHROWS a keychain read failure (never degrades to "no key → re-scan")', async () => {
    await saveE2eKey('pc_alpha', 'psk-base64');
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(getE2eKeyStrict('pc_alpha')).rejects.toThrow('keychain locked');
    expect(await getE2eKeyStrict('pc_alpha')).toBe('psk-base64');
  });

  it('the lenient reader still swallows the same failure to null', async () => {
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
    await expect(getE2eKey('pc_alpha')).resolves.toBeNull();
  });
});
