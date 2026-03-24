import { Menu, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { FILE_CATEGORIES, type FileCategory } from './fileCategories';

interface FilesSidebarProps {
  activeCategory: FileCategory;
  onSelect: (category: FileCategory) => void;
}

export function FilesSidebar({ activeCategory, onSelect }: FilesSidebarProps) {
  const { token } = theme.useToken();
  const { t } = useTranslation();

  const items = FILE_CATEGORIES.map(({ id, labelKey, icon: Icon }) => ({
    key: id,
    icon: <Icon size={16} />,
    label: t(labelKey),
  }));

  return (
    <div
      data-testid="files-sidebar"
      className="h-full"
      style={{ backgroundColor: token.colorBgContainer }}
    >
      <Menu
        mode="inline"
        selectedKeys={[activeCategory]}
        items={items}
        onClick={({ key }) => onSelect(key as FileCategory)}
      />
    </div>
  );
}
