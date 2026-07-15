import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeConfig } from '@/types';
import { useVoiceChat } from '../useVoiceChat';

const errorMock = vi.hoisted(() => vi.fn());

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: errorMock } }) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const config: RealtimeConfig = {
  model_id: 'voice-model',
  voice: null,
  audio_format: { sample_rate: 24_000, channels: 1, encoding: 'Pcm16' },
};

const trackStop = vi.fn();
const audioTrack = { stop: trackStop, enabled: true };
const stream = {
  getTracks: () => [audioTrack],
  getAudioTracks: () => [audioTrack],
} as unknown as MediaStream;

const sourceDisconnect = vi.fn();
const sourceConnect = vi.fn();
const analyserDisconnect = vi.fn();
const analyser = {
  fftSize: 0,
  disconnect: analyserDisconnect,
  getFloatTimeDomainData: vi.fn(),
};

const addModuleMock = vi.fn<() => Promise<void>>();
const audioClose = vi.fn(async () => {});
const audioContext = {
  state: 'running',
  audioWorklet: { addModule: addModuleMock },
  createMediaStreamSource: vi.fn(() => ({ connect: sourceConnect, disconnect: sourceDisconnect })),
  createAnalyser: vi.fn(() => analyser),
  close: audioClose,
};

const workletDisconnect = vi.fn();
const workletPortClose = vi.fn();
const workletPort = {
  onmessage: null as ((event: MessageEvent) => void) | null,
  close: workletPortClose,
};

class FakeAudioWorkletNode {
  port = workletPort;
  disconnect = workletDisconnect;
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = FakeWebSocket.CLOSED; });
}

const sockets: FakeWebSocket[] = [];
const getUserMediaMock = vi.fn<() => Promise<MediaStream>>();
const audioContextConstructor = vi.fn(function AudioContextMock() {
  return audioContext;
});

describe('useVoiceChat lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    errorMock.mockReset();
    trackStop.mockReset();
    sourceDisconnect.mockReset();
    sourceConnect.mockReset();
    analyserDisconnect.mockReset();
    workletDisconnect.mockReset();
    workletPortClose.mockReset();
    workletPort.onmessage = null;
    audioClose.mockClear();
    audioContext.state = 'running';
    audioContext.createMediaStreamSource.mockClear();
    audioContext.createAnalyser.mockClear();
    addModuleMock.mockReset().mockResolvedValue();
    getUserMediaMock.mockReset().mockResolvedValue(stream);
    sockets.length = 0;

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
    audioContextConstructor.mockClear();
    vi.stubGlobal('AudioContext', audioContextConstructor);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 73));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops a media stream that resolves after the session was cancelled', async () => {
    const pendingStream = deferred<MediaStream>();
    getUserMediaMock.mockReturnValueOnce(pendingStream.promise);
    const { result } = renderHook(() => useVoiceChat({ config }));

    act(() => { void result.current.start(); });
    expect(result.current.state).toBe('Connecting');
    act(() => result.current.stop());
    await act(async () => { pendingStream.resolve(stream); });

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(audioContextConstructor).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('invalidates a pending worklet setup and releases every acquired resource', async () => {
    const pendingModule = deferred<void>();
    addModuleMock.mockReturnValueOnce(pendingModule.promise);
    const { result } = renderHook(() => useVoiceChat({ config }));

    act(() => { void result.current.start(); });
    await act(async () => {});
    act(() => result.current.stop());
    await act(async () => { pendingModule.resolve(); });

    expect(trackStop).toHaveBeenCalled();
    expect(audioClose).toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('clears callbacks, animation work and the delayed speaking transition on stop', async () => {
    const { result } = renderHook(() => useVoiceChat({ config }));
    await act(async () => { await result.current.start(); });
    const ws = sockets[0];
    expect(ws).toBeDefined();

    const staleOpen = ws.onopen;
    act(() => {
      ws.readyState = FakeWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    act(() => result.current.stop());

    expect(cancelAnimationFrame).toHaveBeenCalledWith(73);
    expect(vi.getTimerCount()).toBe(0);
    expect(workletPort.onmessage).toBeNull();
    expect(workletPortClose).toHaveBeenCalled();
    expect(workletDisconnect).toHaveBeenCalled();
    expect(sourceDisconnect).toHaveBeenCalled();
    expect(analyserDisconnect).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(audioClose).toHaveBeenCalled();
    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onerror).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(ws.close).toHaveBeenCalled();

    act(() => staleOpen?.(new Event('open')));
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.state).toBe('Idle');
  });

  it('invalidates and releases a late stream after effect cleanup', async () => {
    const pendingStream = deferred<MediaStream>();
    getUserMediaMock.mockReturnValueOnce(pendingStream.promise);
    const { result, unmount } = renderHook(() => useVoiceChat({ config }));

    act(() => { void result.current.start(); });
    unmount();
    await act(async () => { pendingStream.resolve(stream); });

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
    expect(errorMock).not.toHaveBeenCalled();
  });
});
