import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VoiceSessionState, RealtimeConfig } from '@/types';

const VAD_THRESHOLD = 0.015;
const VAD_SILENCE_MS = 1500;

interface UseVoiceChatOptions {
  port?: number;
  config: RealtimeConfig;
}

interface UseVoiceChatReturn {
  state: VoiceSessionState;
  isMuted: boolean;
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
}

export function useVoiceChat({ port = 8080, config }: UseVoiceChatOptions): UseVoiceChatReturn {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const [state, setState] = useState<VoiceSessionState>('Idle');
  const [isMuted, setIsMuted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (vadTimerRef.current !== null) {
      clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    workletRef.current?.disconnect();
    workletRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const runVAD = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const data = new Float32Array(analyser.fftSize);

    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
      }
      const rms = Math.sqrt(sum / data.length);

      setState((prev) => {
        if (prev !== 'Speaking' && prev !== 'Listening') return prev;

        if (rms > VAD_THRESHOLD) {
          if (vadTimerRef.current !== null) {
            clearTimeout(vadTimerRef.current);
            vadTimerRef.current = null;
          }
          return 'Speaking';
        }

        if (prev === 'Speaking' && vadTimerRef.current === null) {
          vadTimerRef.current = setTimeout(() => {
            vadTimerRef.current = null;
            setState('Listening');
          }, VAD_SILENCE_MS);
        }
        return prev;
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async () => {
    if (state !== 'Idle') return;
    setState('Connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: config.audio_format.sample_rate, channelCount: 1, echoCancellation: true },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: config.audio_format.sample_rate });
      audioCtxRef.current = audioCtx;

      await audioCtx.audioWorklet.addModule('/audio-processor.js');

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      source.connect(analyser);

      const worklet = new AudioWorkletNode(audioCtx, 'audio-pcm16-processor');
      workletRef.current = worklet;
      source.connect(worklet);

      const ws = new WebSocket(`ws://localhost:${port}/v1/realtime`);
      wsRef.current = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'session.config', config }));
        setState('Connected');
        setTimeout(() => setState('Speaking'), 300);
        runVAD();
      };

      worklet.port.onmessage = (e: MessageEvent) => {
        if (ws.readyState === WebSocket.OPEN && !isMuted) {
          ws.send(e.data as ArrayBuffer);
        }
      };

      ws.onmessage = (_e: MessageEvent) => {
        // Audio playback from server would be handled here
      };

      ws.onerror = () => {
        message.error(t('voice.connectionError'));
        cleanup();
        setState('Idle');
      };

      ws.onclose = () => {
        cleanup();
        setState('Idle');
      };
    } catch (err) {
      const errMsg = err instanceof DOMException && err.name === 'NotAllowedError'
        ? t('voice.micPermissionDenied')
        : t('voice.micError');
      message.error(errMsg);
      cleanup();
      setState('Idle');
    }
  }, [state, port, config, isMuted, cleanup, runVAD, message, t]);

  const stop = useCallback(() => {
    if (state === 'Idle' || state === 'Disconnecting') return;
    setState('Disconnecting');
    cleanup();
    setState('Idle');
  }, [state, cleanup]);

  const toggleMute = useCallback(() => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !newMuted;
      });
    }
  }, [isMuted]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return { state, isMuted, start, stop, toggleMute };
}
