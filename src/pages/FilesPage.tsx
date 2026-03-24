import { useState } from 'react';
import { theme } from 'antd';
import { FilesSidebar } from '@/components/files/FilesSidebar';
import { FilesContent } from '@/components/files/FilesContent';
import type { FileCategory } from '@/components/files/fileCategories';

export function FilesPage() {
  const { token } = theme.useToken();
  const [activeCategory, setActiveCategory] = useState<FileCategory>('images');

  return (
    <div className="flex h-full">
      <div
        className="w-56 shrink-0 h-full"
        style={{ borderRight: '1px solid var(--border-color)', backgroundColor: token.colorBgContainer }}
      >
        <FilesSidebar activeCategory={activeCategory} onSelect={setActiveCategory} />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto" style={{ backgroundColor: token.colorBgElevated }}>
        <FilesContent key={activeCategory} activeCategory={activeCategory} />
      </div>
    </div>
  );
}

