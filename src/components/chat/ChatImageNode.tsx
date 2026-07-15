import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Image as AntImage, Spin, Tooltip, Typography, theme } from 'antd';
import { Check, Copy, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  copyChatImage,
  getDefaultImageFilename,
  saveChatImage,
} from '@/lib/chatImageActions';
import { usePageTransientOpenState } from '@/components/layout/PageLifecycle';

type ChatImageNodeData = {
  type: 'image' | 'img';
  src?: string;
  alt?: string | null;
  title?: string | null;
  raw?: string;
  attrs?:
    | Record<string, string | boolean>
    | [string, string][]
    | Array<{ name: string; value: string | boolean }>;
  loading?: boolean;
};

type MarkdownImageProps = {
  node: ChatImageNodeData;
};

type HtmlImageProps = {
  src?: string;
  alt?: string;
  title?: string;
};

type ChatImageNodeProps = MarkdownImageProps | HtmlImageProps;

function isMarkdownImageProps(props: ChatImageNodeProps): props is MarkdownImageProps {
  return 'node' in props;
}

function getNodeAttr(node: ChatImageNodeData, name: string) {
  const attrs = node.attrs;
  if (!attrs) return undefined;

  if (Array.isArray(attrs)) {
    for (const attr of attrs) {
      if (Array.isArray(attr)) {
        const [attrName, value] = attr;
        if (attrName === name) return value;
        continue;
      }

      if (attr.name === name && typeof attr.value === 'string') {
        return attr.value;
      }
    }
    return undefined;
  }

  const value = attrs[name];
  return typeof value === 'string' ? value : undefined;
}

function normalizeImageProps(props: ChatImageNodeProps) {
  if (isMarkdownImageProps(props)) {
    const src = props.node.src ?? getNodeAttr(props.node, 'src') ?? '';
    const alt = props.node.alt ?? getNodeAttr(props.node, 'alt') ?? '';
    const title = props.node.title ?? getNodeAttr(props.node, 'title') ?? alt;
    return {
      src,
      alt,
      title,
      raw: props.node.raw ?? '',
      loading: Boolean(props.node.loading),
    };
  }

  return {
    src: props.src ?? '',
    alt: props.alt ?? '',
    title: props.title ?? props.alt ?? '',
    raw: props.src ?? '',
    loading: false,
  };
}

export function ChatImageNode(props: ChatImageNodeProps) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const { t } = useTranslation();
  const { src, alt, title, raw, loading } = normalizeImageProps(props);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(() => (
    src || loading ? 'loading' : 'error'
  ));
  const [copying, setCopying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = usePageTransientOpenState();

  useEffect(() => {
    setStatus(src || loading ? 'loading' : 'error');
    setCopied(false);
  }, [src, loading]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const filename = useMemo(() => getDefaultImageFilename(src, alt), [alt, src]);
  const sourceLabel = src || raw || t('chat.imageMissingSource', '图片链接为空');
  const altText = alt || title || t('chat.imagePreview', '图片预览');

  const handleCopy = useCallback(async () => {
    if (!src || status !== 'loaded') return;
    setCopying(true);
    try {
      await copyChatImage(src);
      setCopied(true);
      message.success(t('chat.imageCopySuccess', '图片已复制'));
    } catch (error) {
      console.error('copy chat image failed:', error);
      message.error(t('chat.imageCopyFailed', '复制图片失败'));
    } finally {
      setCopying(false);
    }
  }, [message, src, status, t]);

  const handleSave = useCallback(async () => {
    if (!src || status !== 'loaded') return;
    setSaving(true);
    try {
      const saved = await saveChatImage(src, filename);
      if (saved) {
        message.success(t('chat.imageSaveSuccess', '图片已保存'));
      }
    } catch (error) {
      console.error('save chat image failed:', error);
      message.error(t('chat.imageSaveFailed', '保存图片失败'));
    } finally {
      setSaving(false);
    }
  }, [filename, message, src, status, t]);

  const shellStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    maxWidth: '100%',
    verticalAlign: 'top',
    margin: '6px 0',
  };

  const loadingStyle: React.CSSProperties = {
    minWidth: 220,
    minHeight: 132,
    maxWidth: '100%',
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadius,
    background: token.colorFillQuaternary,
    color: token.colorTextSecondary,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
  };

  if (status === 'error') {
    return (
      <span style={shellStyle}>
        <Alert
          type="error"
          showIcon
          message={t('chat.imageLoadFailed', '图片加载失败')}
          description={(
            <Typography.Text
              copyable={src ? { text: src } : false}
              style={{
                display: 'block',
                maxWidth: 520,
                maxHeight: 120,
                overflow: 'auto',
                wordBreak: 'break-all',
              }}
            >
              {sourceLabel}
            </Typography.Text>
          )}
          style={{ maxWidth: 560, textAlign: 'left' }}
        />
      </span>
    );
  }

  return (
    <span style={shellStyle}>
      {status === 'loading' && (
        <span style={loadingStyle}>
          <Spin size="small" />
          <Typography.Text type="secondary">
            {t('chat.imageLoading', '图片加载中...')}
          </Typography.Text>
        </span>
      )}

      {status === 'loading' && src && (
        <img
          src={src}
          alt={altText}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: 'none',
          }}
        />
      )}

      {status === 'loaded' && (
        <>
          <AntImage
            src={src}
            alt={altText}
            title={title || undefined}
            style={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: 520,
              borderRadius: token.borderRadius,
              objectFit: 'contain',
            }}
            preview={{
              open: previewOpen,
              onOpenChange: setPreviewOpen,
              mask: { blur: true },
              scaleStep: 0.5,
            }}
            onError={() => setStatus('error')}
          />
          <span
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'inline-flex',
              gap: 4,
              padding: 3,
              borderRadius: token.borderRadiusSM,
              background: token.colorBgElevated,
              boxShadow: token.boxShadowSecondary,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Tooltip title={copied ? t('common.copied') : t('chat.copyImage', '复制图片')}>
              <Button
                type="text"
                size="small"
                aria-label={t('chat.copyImage', '复制图片')}
                icon={copied ? <Check size={14} style={{ color: token.colorSuccess }} /> : <Copy size={14} />}
                loading={copying}
                onClick={handleCopy}
                style={{ width: 26, height: 26, padding: 0 }}
              />
            </Tooltip>
            <Tooltip title={t('chat.saveImage', '保存图片')}>
              <Button
                type="text"
                size="small"
                aria-label={t('chat.saveImage', '保存图片')}
                icon={<Download size={14} />}
                loading={saving}
                onClick={handleSave}
                style={{ width: 26, height: 26, padding: 0 }}
              />
            </Tooltip>
          </span>
        </>
      )}
    </span>
  );
}
