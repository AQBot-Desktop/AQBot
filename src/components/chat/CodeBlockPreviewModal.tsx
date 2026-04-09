import React, { useMemo } from 'react';
import { Modal, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import type { CodeBlockPreviewPayload } from 'markstream-react';

interface Props {
  payload: CodeBlockPreviewPayload | null;
  open: boolean;
  onClose: () => void;
}

export const CodeBlockPreviewModal: React.FC<Props> = ({ payload, open, onClose }) => {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const srcdoc = useMemo(() => {
    if (!payload) return '';
    const base = payload.node.code ?? '';
    const lowered = base.trim().toLowerCase();
    if (lowered.startsWith('<!doctype') || lowered.startsWith('<html') || lowered.startsWith('<body'))
      return base;

    const bg = token.colorBgElevated;
    const fg = token.colorText;
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        height: 100%;
        background-color: ${bg};
        color: ${fg};
      }
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', ui-sans-serif, sans-serif;
      }
    </style>
  </head>
  <body>
    ${base}
  </body>
</html>`;
  }, [payload, token.colorBgElevated, token.colorText]);

  const title = payload?.artifactTitle || t('common.preview');

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width="80vw"
      style={{ top: 40 }}
      styles={{
        body: {
          padding: 0,
          overflow: 'hidden',
          borderRadius: token.borderRadiusLG,
        },
      }}
      destroyOnClose
    >
      {payload && (
        <iframe
          sandbox="allow-scripts allow-same-origin"
          src="about:blank"
          srcDoc={srcdoc}
          title={title}
          style={{
            width: '100%',
            height: 'calc(80vh - 80px)',
            border: 'none',
            display: 'block',
            borderRadius: token.borderRadiusLG,
            backgroundColor: token.colorBgElevated,
          }}
        />
      )}
    </Modal>
  );
};
