import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dropdown, theme } from 'antd';
import { MoreHorizontal } from 'lucide-react';
import { countVisibleToolbarItems } from '@/lib/overflowToolbarCount';

export interface OverflowIconToolbarItem {
  key: string;
  node: ReactNode;
  overflowLabel?: string;
}

export function OverflowIconToolbar({
  items,
  moreLabel,
}: {
  items: OverflowIconToolbarItem[];
  moreLabel: string;
}) {
  const { token } = theme.useToken();
  const hostRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const measure = () => {
      setVisibleCount(countVisibleToolbarItems({
        availableWidth: host.clientWidth,
        itemCount: items.length,
      }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [items.length]);

  const visibleItems = items.slice(0, visibleCount);
  const overflowItems = items.slice(visibleCount);

  return (
    <div
      ref={hostRef}
      data-testid="overflow-icon-toolbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 2,
        minWidth: 0,
        flex: 1,
      }}
    >
      {visibleItems.map((item) => (
        <span key={item.key} style={{ display: 'inline-flex', flexShrink: 0 }}>
          {item.node}
        </span>
      ))}
      {overflowItems.length > 0 ? (
        <Dropdown
          trigger={['click']}
          popupRender={() => (
            <div
              data-testid="overflow-icon-toolbar-menu"
              onClick={(event) => event.stopPropagation()}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: 6,
                background: token.colorBgElevated,
                borderRadius: token.borderRadiusLG,
                boxShadow: token.boxShadowSecondary,
              }}
            >
              {overflowItems.map((item) => (
                <div
                  key={item.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '2px 4px',
                  }}
                >
                  {item.node}
                  {item.overflowLabel ? (
                    <span style={{ fontSize: 12, color: token.colorText }}>{item.overflowLabel}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        >
          <Button
            type="text"
            size="small"
            aria-label={moreLabel}
            data-testid="overflow-icon-toolbar-more"
            icon={<MoreHorizontal size={13} />}
          />
        </Dropdown>
      ) : null}
    </div>
  );
}
