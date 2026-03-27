import type { ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { theme } from 'antd';

interface AvatarEditBadgeProps {
  children: ReactNode;
  /** Avatar size in px — used to calculate badge size proportionally */
  size?: number;
}

/**
 * Overlays a small pencil badge at the bottom-right of an avatar
 * to indicate it is user-editable.
 */
export function AvatarEditBadge({ children, size = 64 }: AvatarEditBadgeProps) {
  const { token } = theme.useToken();
  const badgeSize = Math.max(18, Math.round(size * 0.3));
  const iconSize = Math.round(badgeSize * 0.55);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      {children}
      <div
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: badgeSize,
          height: badgeSize,
          borderRadius: '50%',
          backgroundColor: token.colorPrimary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `2px solid ${token.colorBgElevated}`,
          pointerEvents: 'none',
        }}
      >
        <Pencil size={iconSize} color="#fff" />
      </div>
    </div>
  );
}
