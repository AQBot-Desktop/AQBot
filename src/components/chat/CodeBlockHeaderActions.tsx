import React from 'react';
import { Tooltip, theme } from 'antd';
import { Copy, Check, ChevronRight, Maximize2, Minimize2, Minus, Plus, RotateCcw, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CodeBlockActionContext } from 'markstream-react';

interface Props {
  ctx: CodeBlockActionContext;
}

export const CodeBlockHeaderActions: React.FC<Props> = ({ ctx }) => {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    padding: 0,
    border: 'none',
    borderRadius: token.borderRadiusSM,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    opacity: 0.7,
  };

  const disabledStyle: React.CSSProperties = {
    ...btnStyle,
    opacity: 0.3,
    cursor: 'not-allowed',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {/* Collapse/Expand */}
      <Tooltip title={ctx.collapsed ? t('common.expand') : t('common.collapse')} mouseEnterDelay={0.4}>
        <button
          type="button"
          className="code-action-btn"
          style={btnStyle}
          onClick={ctx.toggleCollapse}
        >
          <ChevronRight
            size={14}
            style={{
              transform: ctx.collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
              transition: 'transform 0.2s',
            }}
          />
        </button>
      </Tooltip>

      {/* Font Decrease */}
      <Tooltip title={t('common.decrease', { defaultValue: 'Decrease' })} mouseEnterDelay={0.4}>
        <button
          type="button"
          className="code-action-btn"
          style={ctx.fontSize <= 10 ? disabledStyle : btnStyle}
          disabled={ctx.fontSize <= 10}
          onClick={ctx.decreaseFontSize}
        >
          <Minus size={14} />
        </button>
      </Tooltip>

      {/* Font Reset */}
      <Tooltip title={t('common.reset', { defaultValue: 'Reset' })} mouseEnterDelay={0.4}>
        <button
          type="button"
          className="code-action-btn"
          style={ctx.fontSize === ctx.defaultFontSize ? disabledStyle : btnStyle}
          disabled={ctx.fontSize === ctx.defaultFontSize}
          onClick={ctx.resetFontSize}
        >
          <RotateCcw size={14} />
        </button>
      </Tooltip>

      {/* Font Increase */}
      <Tooltip title={t('common.increase', { defaultValue: 'Increase' })} mouseEnterDelay={0.4}>
        <button
          type="button"
          className="code-action-btn"
          style={ctx.fontSize >= 36 ? disabledStyle : btnStyle}
          disabled={ctx.fontSize >= 36}
          onClick={ctx.increaseFontSize}
        >
          <Plus size={14} />
        </button>
      </Tooltip>

      {/* Copy */}
      <Tooltip title={ctx.copied ? t('common.copied') : t('common.copy')} mouseEnterDelay={0.4}>
        <button
          type="button"
          className="code-action-btn"
          style={btnStyle}
          onClick={() => ctx.copy()}
        >
          {ctx.copied
            ? <Check size={14} style={{ color: token.colorSuccess }} />
            : <Copy size={14} />
          }
        </button>
      </Tooltip>

      {/* Fullscreen */}
      <Tooltip title={ctx.expanded ? t('common.collapse') : t('settings.fullscreen')} mouseEnterDelay={0.4}>
        <button
          type="button"
          className="code-action-btn"
          style={btnStyle}
          onClick={ctx.toggleExpand}
        >
          {ctx.expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </Tooltip>

      {/* Preview (only for HTML/SVG) */}
      {ctx.isPreviewable && (
        <Tooltip title={t('common.preview')} mouseEnterDelay={0.4}>
          <button
            type="button"
            className="code-action-btn"
            style={btnStyle}
            onClick={ctx.previewCode}
          >
            <Eye size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  );
};
