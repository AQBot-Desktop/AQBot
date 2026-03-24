import { useMemo } from 'react';
import { Button, Typography, Spin } from 'antd';
import { Mic, MicOff, Phone, Loader, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVoiceChat } from '@/hooks/useVoiceChat';
import type { RealtimeConfig, VoiceSessionState } from '@/types';

interface VoiceCallProps {
  visible: boolean;
  onClose: () => void;
  port?: number;
  config: RealtimeConfig;
}

function StatusDisplay({ state }: { state: VoiceSessionState }) {
  const { t } = useTranslation();

  const content = useMemo(() => {
    switch (state) {
      case 'Connecting':
        return (
          <div className="flex flex-col items-center gap-4">
            <Spin indicator={<Loader size={48} style={{ color: '#fff', animation: 'spin 1s linear infinite' }} />} />
            <Typography.Text style={{ color: '#fff', fontSize: 18 }}>
              {t('voice.connecting')}
            </Typography.Text>
          </div>
        );
      case 'Connected':
        return (
          <div className="flex flex-col items-center gap-4">
            <Mic size={48} style={{ color: '#52c41a' }} />
            <Typography.Text style={{ color: '#fff', fontSize: 18 }}>
              {t('voice.connected')}
            </Typography.Text>
          </div>
        );
      case 'Speaking':
        return (
          <div className="flex flex-col items-center gap-4">
            <div className="voice-waveform">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="voice-bar"
                  style={{
                    animationDelay: `${i * 0.1}s`,
                  }}
                />
              ))}
            </div>
            <Typography.Text style={{ color: '#fff', fontSize: 18 }}>
              {t('voice.speaking')}
            </Typography.Text>
          </div>
        );
      case 'Listening':
        return (
          <div className="flex flex-col items-center gap-4">
            <Volume2 size={48} style={{ color: '#1677ff' }} className="animate-pulse" />
            <Typography.Text style={{ color: '#fff', fontSize: 18 }}>
              {t('voice.listening')}
            </Typography.Text>
          </div>
        );
      case 'Disconnecting':
        return (
          <div className="flex flex-col items-center gap-4">
            <Spin indicator={<Loader size={48} style={{ color: '#fff', animation: 'spin 1s linear infinite' }} />} />
            <Typography.Text style={{ color: '#fff', fontSize: 18 }}>
              {t('voice.disconnecting')}
            </Typography.Text>
          </div>
        );
      default:
        return null;
    }
  }, [state, t]);

  return <>{content}</>;
}

export function VoiceCall({ visible, onClose, port, config }: VoiceCallProps) {
  const { t } = useTranslation();
  const { state, isMuted, start, stop, toggleMute } = useVoiceChat({ port, config });

  // Auto-start when overlay becomes visible
  if (visible && state === 'Idle') {
    start();
  }

  const handleEndCall = () => {
    stop();
    onClose();
  };

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex flex-col items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.85)' }}
    >
      {/* Status display */}
      <div className="flex-1 flex items-center justify-center">
        <StatusDisplay state={state} />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-8 pb-16">
        <Button
          shape="circle"
          size="large"
          icon={isMuted ? <MicOff size={20} /> : <Mic size={20} />}
          onClick={toggleMute}
          style={{
            width: 56,
            height: 56,
            background: isMuted ? '#ff4d4f' : 'rgba(255,255,255,0.2)',
            border: 'none',
            color: '#fff',
          }}
          title={t('voice.toggleMute')}
        />
        <Button
          shape="circle"
          size="large"
          icon={<Phone size={24} style={{ transform: 'rotate(225deg)' }} />}
          onClick={handleEndCall}
          style={{
            width: 72,
            height: 72,
            background: '#ff4d4f',
            border: 'none',
            color: '#fff',
            fontSize: 24,
          }}
          title={t('voice.endCall')}
        />
      </div>

      {/* Waveform CSS */}
      <style>{`
        .voice-waveform {
          display: flex;
          align-items: center;
          gap: 6px;
          height: 60px;
        }
        .voice-bar {
          width: 6px;
          height: 20px;
          background: #52c41a;
          border-radius: 3px;
          animation: voiceWave 0.8s ease-in-out infinite alternate;
        }
        @keyframes voiceWave {
          0% { height: 12px; }
          100% { height: 48px; }
        }
      `}</style>
    </div>
  );
}
