import { useEffect, useRef, useCallback } from 'react';
import { Modal, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import 'emoji-picker-element';

interface EmojiPickerProps {
  open: boolean;
  onClose: () => void;
  onEmojiSelect: (emoji: string) => void;
}

export function EmojiPicker({ open, onClose, onEmojiSelect }: EmojiPickerProps) {
  const pickerRef = useRef<HTMLElement | null>(null);
  const { token } = theme.useToken();
  const { t, i18n } = useTranslation();
  const themeMode = useSettingsStore((s) => s.settings.theme_mode);
  const isDark = useResolvedDarkMode(themeMode);

  const onEmojiSelectRef = useRef(onEmojiSelect);
  onEmojiSelectRef.current = onEmojiSelect;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handleClick = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.unicode) {
      onEmojiSelectRef.current(detail.unicode);
      onCloseRef.current();
    }
  }, []);

  // Use callback ref to attach event listener when the element is available
  const setPickerRef = useCallback((node: HTMLElement | null) => {
    // Detach from old node
    if (pickerRef.current) {
      pickerRef.current.removeEventListener('emoji-click', handleClick);
    }
    pickerRef.current = node;
    // Attach to new node
    if (node) {
      node.addEventListener('emoji-click', handleClick);
    }
  }, [handleClick]);

  // Sync locale + i18n translations
  useEffect(() => {
    const picker = pickerRef.current as any;
    if (!picker) return;
    const lang = i18n.language;
    if (lang.startsWith('zh')) {
      import('emoji-picker-element/i18n/zh_CN').then((mod) => {
        picker.locale = 'zh';
        picker.i18n = mod.default;
        picker.dataSource = 'https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/zh/emojibase/data.json';
      });
    } else {
      import('emoji-picker-element/i18n/en').then((mod) => {
        picker.locale = 'en';
        picker.i18n = mod.default;
        picker.dataSource = 'https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json';
      });
    }
  }, [i18n.language, open]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={t('common.selectEmoji', '选择表情')}
      width={400}
      centered
      destroyOnClose
    >
      <div style={{
        borderRadius: token.borderRadius,
        overflow: 'hidden',
      }}>
        {/* @ts-ignore - web component */}
        <emoji-picker
          ref={setPickerRef}
          class={isDark ? 'dark' : 'light'}
          style={{
            '--num-columns': '8',
            '--emoji-padding': '0.25rem',
            '--border-radius': `${token.borderRadius}px`,
            '--background': isDark ? token.colorBgElevated : token.colorBgContainer,
            '--border-color': 'transparent',
            '--indicator-color': token.colorPrimary,
            '--input-border-color': token.colorBorder,
            '--input-font-size': '14px',
            '--input-padding': '0.4rem',
            '--button-hover-background': token.colorFillSecondary,
            '--button-active-background': token.colorFillTertiary,
            '--outline-color': token.colorPrimary,
            width: '100%',
          } as React.CSSProperties}
        />
      </div>
    </Modal>
  );
}
