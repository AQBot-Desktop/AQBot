import { Input, Modal, Tabs, theme } from 'antd';
import { Search } from 'lucide-react';
import { ModelIcon, ProviderIcon } from '@lobehub/icons';
import toc from '@lobehub/icons/es/toc';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface IconPickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (iconId: string) => void;
}

export default function IconPickerModal({ open, onClose, onSelect }: IconPickerModalProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('model');

  const filteredIcons = useMemo(() => {
    const s = search.toLowerCase();
    return toc.filter(
      (icon) =>
        icon.group === activeTab &&
        (icon.title.toLowerCase().includes(s) || icon.fullTitle.toLowerCase().includes(s)),
    );
  }, [search, activeTab]);

  const handleSelect = (iconId: string) => {
    onSelect(iconId);
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
          { key: 'model', label: `模型 (${toc.filter((i) => i.group === 'model').length})` },
          { key: 'provider', label: `厂商 (${toc.filter((i) => i.group === 'provider').length})` },
        ]}
      />

      <div
        className="grid grid-cols-6 gap-2 overflow-y-auto pr-1"
        style={{ maxHeight: 360 }}
      >
        {filteredIcons.map((icon) => (
          <div
            key={icon.id}
            className="flex flex-col items-center gap-1 p-2 rounded-lg cursor-pointer transition-colors"
            style={{ border: '1px solid var(--border-color)' }}
            onClick={() => handleSelect(icon.title)}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = token.colorPrimaryBg;
              (e.currentTarget as HTMLElement).style.borderColor = token.colorPrimary;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
              (e.currentTarget as HTMLElement).style.borderColor = '';
            }}
            title={icon.fullTitle}
          >
            {activeTab === 'provider' ? (
              <ProviderIcon provider={icon.title} size={24} type="color" />
            ) : (
              <ModelIcon model={icon.title} size={24} type="avatar" />
            )}
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
    </Modal>
  );
}
