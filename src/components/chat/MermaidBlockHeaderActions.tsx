import React, { useCallback, useState } from 'react';
import { Tooltip, theme } from 'antd';
import { Copy, Check, ChevronRight, Download, Maximize2, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MermaidBlockActionContext } from 'markstream-react';

interface Props {
  ctx: MermaidBlockActionContext;
}

export const MermaidBlockHeaderActions: React.FC<Props> = ({ ctx }) => {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const getBtnStyle = useCallback((idx: number, disabled?: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: token.borderRadiusSM,
    border: 'none',
    background: !disabled && hoveredIdx === idx ? (token.colorFillSecondary || 'rgba(255,255,255,0.1)') : 'transparent',
    color: !disabled && hoveredIdx === idx ? token.colorText : token.colorTextSecondary,
    cursor: disabled ? 'not-allowed' : 'pointer',
    padding: 0,
    transition: 'color 0.2s, background 0.2s',
    opacity: disabled ? 0.4 : 1,
  }), [hoveredIdx, token]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {/* Collapse */}
      <Tooltip title={ctx.collapsed ? t('common.expand') : t('common.collapse')} mouseEnterDelay={0.4}>
        <button type="button" style={getBtnStyle(0)} onClick={ctx.toggleCollapse}
          onMouseEnter={() => setHoveredIdx(0)} onMouseLeave={() => setHoveredIdx(null)}>
          <ChevronRight
            size={14}
            style={{
              transform: ctx.collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
              transition: 'transform 0.2s',
            }}
          />
        </button>
      </Tooltip>

      {/* Copy */}
      <Tooltip title={ctx.copied ? t('common.copied') : t('common.copy')} mouseEnterDelay={0.4}>
        <button type="button" style={getBtnStyle(1)} onClick={ctx.copy}
          onMouseEnter={() => setHoveredIdx(1)} onMouseLeave={() => setHoveredIdx(null)}>
          {ctx.copied
            ? <Check size={14} style={{ color: token.colorSuccess }} />
            : <Copy size={14} />
          }
        </button>
      </Tooltip>

      {/* Export / Download */}
      {ctx.mermaidAvailable && (
        <Tooltip title={t('common.export')} mouseEnterDelay={0.4}>
          <button
            type="button"
            style={getBtnStyle(2, ctx.isExportDisabled)}
            disabled={ctx.isExportDisabled}
            onClick={ctx.exportSvg}
            onMouseEnter={() => setHoveredIdx(2)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            <Download size={14} />
          </button>
        </Tooltip>
      )}

      {/* Fullscreen */}
      {ctx.mermaidAvailable && (
        <Tooltip title={ctx.modalOpen ? t('settings.exitFullscreen') : t('settings.fullscreen')} mouseEnterDelay={0.4}>
          <button
            type="button"
            style={getBtnStyle(3, ctx.isExportDisabled)}
            disabled={ctx.isExportDisabled}
            onClick={ctx.toggleFullscreen}
            onMouseEnter={() => setHoveredIdx(3)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {ctx.modalOpen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </Tooltip>
      )}
    </div>
  );
};
