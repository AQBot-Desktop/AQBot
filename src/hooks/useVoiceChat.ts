import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VoiceSessionState, RealtimeConfig } from '@/types';

const VAD_THRESHOLD = 0.015;
const VAD_SILENCE_MS = 1500;
const CONNECTED_TO_SPEAKING_MS = 300;

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

  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const stateRef = useRef<VoiceSessionState>('Idle');
  const isMutedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    generationRef.current += 1;
    stateRef.current = 'Idle';

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (vadTimerRef.current !== null) {
      clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    if (speakingTimerRef.current !== null) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }

    if (workletRef.current) {
      workletRef.current.port.onmessage = null;
      workletRef.current.port.close();
      workletRef.current.disconnect();
    }
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
      const audioCtx = audioCtxRef.current;
      void audioCtx.close().catch((error: unknown) => {
        console.warn('Failed to close voice AudioContext', error);
      });
    }
    audioCtxRef.current = null;
    if (wsRef.current) {
      const ws = wsRef.current;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    wsRef.current = null;
  }, []);

  const setSessionState = useCallback((nextState: VoiceSessionState) => {
    stateRef.current = nextState;
    if (mountedRef.current) setState(nextState);
  }, []);

  const isCurrentGeneration = useCallback((generation: number) => (
    mountedRef.current && generationRef.current === generation
  ), []);

  const runVAD = useCallback((generation: number) => {
    if (!isCurrentGeneration(generation)) return;
    const initialAnalyser = analyserRef.current;
    if (!initialAnalyser) return;

    const data = new Float32Array(initialAnalyser.fftSize);

    const tick = () => {
      if (!isCurrentGeneration(generation)) return;
      const analyser = analyserRef.current;
      if (!analyser) return;

      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
      }
      const rms = Math.sqrt(sum / data.length);

      const currentState = stateRef.current;
      if (currentState === 'Speaking' || currentState === 'Listening') {
        if (rms > VAD_THRESHOLD) {
          if (vadTimerRef.current !== null) {
            clearTimeout(vadTimerRef.current);
            vadTimerRef.current = null;
          }
          setSessionState('Speaking');
        } else if (currentState === 'Speaking' && vadTimerRef.current === null) {
          vadTimerRef.current = setTimeout(() => {
            vadTimerRef.current = null;
            if (isCurrentGeneration(generation)) setSessionState('Listening');
          }, VAD_SILENCE_MS);
        }
      }

      if (isCurrentGeneration(generation)) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [isCurrentGeneration, setSessionState]);

  const start = useCallback(async () => {
    if (!mountedRef.current || stateRef.current !== 'Idle') return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setSessionState('Connecting');

    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: config.audio_format.sample_rate, channelCount: 1, echoCancellation: true },
      });
      if (!isCurrentGeneration(generation)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: config.audio_format.sample_rate });
      audioCtxRef.current = audioCtx;

      await audioCtx.audioWorklet.addModule('/audio-processor.js');
      if (!isCurrentGeneration(generation)) return;

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
        if (!isCurrentGeneration(generation) || wsRef.current !== ws) return;
        ws.send(JSON.stringify({ type: 'session.config', config }));
        setSessionState('Connected');
        speakingTimerRef.current = setTimeout(() => {
          speakingTimerRef.current = null;
          if (isCurrentGeneration(generation)) setSessionState('Speaking');
        }, CONNECTED_TO_SPEAKING_MS);
        runVAD(generation);
      };

      worklet.port.onmessage = (e: MessageEvent) => {
        if (
          isCurrentGeneration(generation)
          && wsRef.current === ws
          && ws.readyState === WebSocket.OPEN
          && !isMutedRef.current
        ) {
          ws.send(e.data as ArrayBuffer);
        }
      };

      ws.onmessage = (_e: MessageEvent) => {
        if (!isCurrentGeneration(generation) || wsRef.current !== ws) return;
        // Audio playback from server would be handled here
      };

      ws.onerror = () => {
        if (!isCurrentGeneration(generation) || wsRef.current !== ws) return;
        message.error(t('voice.connectionError'));
        cleanup();
        setSessionState('Idle');
      };

      ws.onclose = () => {
        if (!isCurrentGeneration(generation) || wsRef.current !== ws) return;
        cleanup();
        setSessionState('Idle');
      };
    } catch (err) {
      if (!isCurrentGeneration(generation)) return;
      const errMsg = err instanceof DOMException && err.name === 'NotAllowedError'
        ? t('voice.micPermissionDenied')
        : t('voice.micError');
      message.error(errMsg);
      cleanup();
      setSessionState('Idle');
    }
  }, [cleanup, config, isCurrentGeneration, message, port, runVAD, setSessionState, t]);

  const stop = useCallback(() => {
    if (stateRef.current === 'Idle' || stateRef.current === 'Disconnecting') return;
    setSessionState('Disconnecting');
    cleanup();
    setSessionState('Idle');
  }, [cleanup, setSessionState]);

  const toggleMute = useCallback(() => {
    const newMuted = !isMutedRef.current;
    isMutedRef.current = newMuted;
    setIsMuted(newMuted);
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !newMuted;
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  return { state, isMuted, start, stop, toggleMute };
}
