jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key: string, value: string) => void store.set(key, value)),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => void store.delete(key)),
  };
});

import {
  clearWakeCapability,
  getWakeCapability,
  saveWakeCapability,
} from '../src/features/pc-connect/deviceTokenStore';
import {
  requestConnectedPcWakeOnce,
  resetConnectedPcWakeOutage,
} from '../src/features/health/wakeOnDemand';

const PC_ID = 'pc_wake';
const CAPABILITY = {
  wakeUrl: 'https://wake.example.net/v1/wake',
  wakeToken: 'ab'.repeat(32),
};

const secureStore = jest.requireMock('expo-secure-store') as { __store: Map<string, string> };

beforeEach(async () => {
  secureStore.__store.clear();
  resetConnectedPcWakeOutage(PC_ID);
  jest.restoreAllMocks();
});

describe('wake capability storage', () => {
  it('round-trips the endpoint and bearer through SecureStore', async () => {
    await saveWakeCapability(PC_ID, CAPABILITY);
    await expect(getWakeCapability(PC_ID)).resolves.toEqual(CAPABILITY);
  });

  it('clears both values with the pairing', async () => {
    await saveWakeCapability(PC_ID, CAPABILITY);
    await clearWakeCapability(PC_ID);
    await expect(getWakeCapability(PC_ID)).resolves.toBeNull();
  });
});

describe('requestConnectedPcWakeOnce', () => {
  it('posts one authenticated wake request per outage and never logs the bearer', async () => {
    await saveWakeCapability(PC_ID, CAPABILITY);
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 202 })) as unknown as typeof fetch;
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const deps = {
      getPcId: async () => PC_ID,
      fetchImpl,
      timeoutSignal: () => undefined,
    };
    await expect(requestConnectedPcWakeOnce(deps)).resolves.toBe('requested');
    await expect(requestConnectedPcWakeOnce(deps)).resolves.toBe('already-requested');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(CAPABILITY.wakeUrl, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${CAPABILITY.wakeToken}`,
      },
    });
    expect(consoleSpy).not.toHaveBeenCalled();

    resetConnectedPcWakeOutage(PC_ID);
    await expect(requestConnectedPcWakeOnce(deps)).resolves.toBe('requested');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is a backward-compatible no-op when the QR had no wake capability', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    await expect(
      requestConnectedPcWakeOnce({ getPcId: async () => PC_ID, fetchImpl })
    ).resolves.toBe('unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not retry the POST during the same outage when the wake service fails', async () => {
    await saveWakeCapability(PC_ID, CAPABILITY);
    const fetchImpl = jest.fn(async () => {
      throw new Error(`request failed for ${CAPABILITY.wakeToken}`);
    }) as unknown as typeof fetch;

    const deps = { getPcId: async () => PC_ID, fetchImpl, timeoutSignal: () => undefined };
    await expect(requestConnectedPcWakeOnce(deps)).resolves.toBe('failed');
    await expect(requestConnectedPcWakeOnce(deps)).resolves.toBe('already-requested');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
