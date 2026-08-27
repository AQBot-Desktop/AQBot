import { Dropdown, Input, theme } from 'antd';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface SettingsSelectOption {
  label: ReactNode;
  value: string;
}

interface SettingsSelectProps {
  value?: string;
  onChange?: (value: string) => void;
  options: SettingsSelectOption[];
  style?: CSSProperties;
  disabled?: boolean;
  searchable?: boolean;
  ariaLabel?: string;
  labelMaxWidth?: number;
}

export function SettingsSelect({
  value,
  onChange,
  options,
  style,
  disabled,
  searchable,
  ariaLabel,
  labelMaxWidth = 180,
}: SettingsSelectProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<any>(null);
  const currentLabel = options.find((o) => o.value === value)?.label ?? value;

  const filteredOptions = useMemo(() => {
    if (!searchable || !search) return options;
    const q = search.toLowerCase();
    return options.filter((o) => {
      const text = typeof o.label === 'string' ? o.label : o.value;
      return text.toLowerCase().includes(q);
    });
  }, [options, search, searchable]);

  const handleSelect = useCallback((val: string) => {
    onChange?.(val);
    setOpen(false);
    setSearch('');
  }, [onChange]);

  const trigger = (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 6,
        border: 'none',
        background: hovered ? token.colorFillTertiary : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 13,
        color: token.colorText,
        userSelect: 'none',
        transition: 'background 0.2s',
        ...style,
      }}
    >
      <span style={{ maxWidth: labelMaxWidth, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentLabel}</span>
      <ChevronsUpDown size={12} style={{ opacity: 0.4 }} />
    </div>
  );

  if (searchable) {
    return (
      <Dropdown
        open={open}
        onOpenChange={(v) => { setOpen(v); if (!v) setSearch(''); }}
        trigger={['click']}
        disabled={disabled}
        dropdownRender={() => (
          <div style={{
            background: token.colorBgElevated,
            borderRadius: 8,
            boxShadow: token.boxShadowSecondary,
            padding: 4,
            maxHeight: 320,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 200,
          }}>
            <div style={{ padding: '4px 4px 2px' }}>
              <Input
                ref={searchRef}
                size="small"
                prefix={<Search size={12} style={{ opacity: 0.4 }} />}
                placeholder={t('common.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                allowClear
                autoFocus
                style={{ borderRadius: 6 }}
              />
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
              {filteredOptions.map((opt) => (
                <div
                  key={opt.value}
                  onClick={() => handleSelect(opt.value)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    padding: '5px 12px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: token.colorText,
                    background: opt.value === value ? token.colorFillTertiary : 'transparent',
                    minWidth: 140,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = token.colorFillSecondary; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = opt.value === value ? token.colorFillTertiary : 'transparent'; }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                  {opt.value === value && <Check size={15} style={{ color: token.colorTextSecondary, flexShrink: 0 }} />}
                </div>
              ))}
              {filteredOptions.length === 0 && (
                <div style={{ padding: '8px 12px', color: token.colorTextDescription, fontSize: 12, textAlign: 'center' }}>
                  {t('common.noResults')}
                </div>
              )}
            </div>
          </div>
        )}
      >
        {trigger}
      </Dropdown>
    );
  }

  return (
    <Dropdown
      menu={{
        items: options.map((opt) => ({
          key: opt.value,
          label: (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minWidth: 140 }}>
              <span>{opt.label}</span>
              {opt.value === value && <Check size={15} style={{ color: token.colorTextSecondary }} />}
            </div>
          ),
        })),
        onClick: ({ key }) => onChange?.(key),
      }}
      trigger={['click']}
      disabled={disabled}
    >
      {trigger}
    </Dropdown>
  );
}
