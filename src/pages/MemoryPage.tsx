import { theme } from 'antd';
import MemorySettings from '@/components/settings/MemorySettings';

export function MemoryPage() {
  const { token } = theme.useToken();

  return (
    <div className="h-full flex flex-col" style={{ overflow: 'hidden', backgroundColor: token.colorBgElevated }}>
      <div className="min-h-0 flex-1">
        <MemorySettings />
      </div>
    </div>
  );
}
