import React, { useCallback, useState } from 'react';
import { Tooltip, theme } from 'antd';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MermaidBlockActionContext } from 'markstream-react';

interface Props {
  ctx: MermaidBlockActionContext;
}

export const MermaidZoomControls: React.FC<Props> = ({ ctx }) => {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const getBtnStyle = useCallback((idx: number): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 28,
    height: 28,
    borderRadius: token.borderRadiusSM,
    border: 'none',
    background: hoveredIdx === idx ? (token.colorFillSecondary || 'rgba(255,255,255,0.1)') : 'transparent',
    color: hoveredIdx === idx ? token.colorText : token.colorTextSecondary,
    cursor: 'pointer',
    padding: '0 4px',
    transition: 'color 0.2s, background 0.2s',
    whiteSpace: 'nowrap',
  }), [hoveredIdx, token]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        borderRadius: token.borderRadiusLG,
        backdropFilter: 'blur(8px)',
        backgroundColor: token.colorBgElevated + 'cc',
        padding: '2px 4px',
      }}
    >
      <Tooltip title={t('common.increase')} mouseEnterDelay={0.4}>
        <button type="button" style={getBtnStyle(0)} onClick={ctx.zoomIn}
          onMouseEnter={() => setHoveredIdx(0)} onMouseLeave={() => setHoveredIdx(null)}>
          <ZoomIn size={14} />
        </button>
      </Tooltip>
      <Tooltip title={t('common.decrease')} mouseEnterDelay={0.4}>
        <button type="button" style={getBtnStyle(1)} onClick={ctx.zoomOut}
          onMouseEnter={() => setHoveredIdx(1)} onMouseLeave={() => setHoveredIdx(null)}>
          <ZoomOut size={14} />
        </button>
      </Tooltip>
      <Tooltip title={t('common.reset')} mouseEnterDelay={0.4}>
        <button type="button" style={getBtnStyle(2)} onClick={ctx.resetZoom}
          onMouseEnter={() => setHoveredIdx(2)} onMouseLeave={() => setHoveredIdx(null)}>
          <span style={{ fontSize: 11, fontWeight: 500 }}>{Math.round(ctx.zoom * 100)}%</span>
        </button>
      </Tooltip>
    </div>
  );
};
