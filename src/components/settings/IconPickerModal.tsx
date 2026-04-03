import { Input, Modal, Tabs, theme } from 'antd';
import { Search } from 'lucide-react';
import toc from '@lobehub/icons/es/toc';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DynamicLobeIcon } from '@/components/shared/DynamicLobeIcon';

interface IconPickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (iconId: string, group: 'model' | 'provider') => void;
  defaultTab?: 'model' | 'provider';
}

export default function IconPickerModal({ open, onClose, onSelect, defaultTab = 'model' }: IconPickerModalProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<string>(defaultTab);

  useEffect(() => {
    if (open) setActiveTab(defaultTab);
  }, [open, defaultTab]);

  const filteredIcons = useMemo(() => {
    const s = search.toLowerCase();
    return toc.filter(
      (icon) =>
        icon.group === activeTab &&
        (icon.title.toLowerCase().includes(s) || icon.fullTitle.toLowerCase().includes(s)),
    );
  }, [search, activeTab]);

  const handleSelect = (iconId: string) => {
    onSelect(iconId, activeTab as 'model' | 'provider');
    onClose();
    setSearch('');
  };

  return (
    <Modal
      title={t('settings.chooseIcon')}
      open={open}
      mask={{ enabled: true, blur: true }}
      onCancel={() => {
        onClose();
        setSearch('');
      }}
      footer={null}
      width={520}
      destroyOnHidden
    >
      <Input
        prefix={<Search size={14} />}
        placeholder={t('settings.searchIcon')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        allowClear
        className="mb-3"
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        size="small"
        items={[
          { key: 'model', label: `${t('settings.iconGroupModel')} (${toc.filter((i) => i.group === 'model').length})` },
          { key: 'provider', label: `${t('settings.iconGroupProvider')} (${toc.filter((i) => i.group === 'provider').length})` },
        ]}
      />

      <div
        className="grid grid-cols-6 gap-2 overflow-y-auto pr-1"
        data-os-scrollbar
        style={{ maxHeight: 360 }}
      >
        {filteredIcons.map((icon) => (
          <div
            key={icon.id}
            className="icon-picker-item flex flex-col items-center gap-1 p-2 rounded-lg cursor-pointer transition-colors"
            style={{
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
            onClick={() => handleSelect(icon.id)}
            title={icon.fullTitle}
          >
            <DynamicLobeIcon
              iconId={icon.id}
              size={24}
              type={icon.param.hasColor ? 'color' : 'avatar'}
            />
            <span
              className="text-xs text-center truncate w-full"
              style={{ color: token.colorTextSecondary }}
            >
              {icon.title}
            </span>
          </div>
        ))}
        {filteredIcons.length === 0 && (
          <div
            className="col-span-6 py-8 text-center"
            style={{ color: token.colorTextQuaternary }}
          >
            No icons found
          </div>
        )}
      </div>

      <style>{`
        .icon-picker-item:hover {
          background-color: ${token.colorPrimaryBg} !important;
          border-color: ${token.colorPrimary} !important;
        }
      `}</style>
    </Modal>
  );
}
