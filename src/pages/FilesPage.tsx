import { useState } from 'react';
import { Tabs } from 'antd';
import { useTranslation } from 'react-i18next';
import { FILE_CATEGORIES, type FileCategory } from '@/components/files/fileCategories';
import { FilesContent } from '@/components/files/FilesContent';

export function FilesPage() {
  const { t } = useTranslation();
  const [activeKey, setActiveKey] = useState<FileCategory>('images');

  const items = FILE_CATEGORIES.map(({ id, labelKey, icon: Icon }) => ({
    key: id,
    label: t(labelKey),
    icon: <Icon size={16} />,
    children: <FilesContent key={id} activeCategory={id} />,
  }));

  return (
    <div className="h-full flex flex-col px-2" style={{ overflow: 'hidden' }}>
      <Tabs
        items={items}
        activeKey={activeKey}
        onChange={(key) => setActiveKey(key as FileCategory)}
        destroyOnHidden
        className="flex-1"
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
        tabBarStyle={{ flexShrink: 0 }}
      />
      <style>{`
        .h-full > .ant-tabs > .ant-tabs-content-holder {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          min-height: 0;
        }
      `}</style>
    </div>
  );
}
