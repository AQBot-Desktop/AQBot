import { usePageSuspendCleanup } from '@/components/layout/PageLifecycle';
import { NamespaceIcon } from '@/components/shared/NamespaceIcon';
import { useMemoryStore, useUIStore } from '@/stores';
import { App, Button, Popover, Spin, Typography } from 'antd';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface SaveToMemoryPopoverProps {
  content: string;
  disabled?: boolean;
  children: ReactElement;
}

export function SaveToMemoryPopover({
  content,
  disabled = false,
  children,
}: SaveToMemoryPopoverProps) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const namespaces = useMemoryStore((state) => state.namespaces);
  const namespacesMeta = useMemoryStore((state) => state.namespacesMeta);
  const loadError = useMemoryStore((state) => state.error);
  const ensureNamespacesLoaded = useMemoryStore((state) => state.ensureNamespacesLoaded);
  const loadNamespaces = useMemoryStore((state) => state.loadNamespaces);
  const saveText = useMemoryStore((state) => state.saveText);
  const setActivePage = useUIStore((state) => state.setActivePage);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState('');
  const [savingNamespaceId, setSavingNamespaceId] = useState<string | null>(null);
  const savingRef = useRef(false);

  usePageSuspendCleanup(() => setOpen(false));

  const sortedNamespaces = useMemo(
    () => [...namespaces].sort((left, right) => left.sortOrder - right.sortOrder),
    [namespaces],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      setOpen(false);
      return;
    }

    const nextSnapshot = content.trim();
    if (disabled || !nextSnapshot) return;

    setSnapshot(nextSnapshot);
    setOpen(true);
    void ensureNamespacesLoaded();
  }, [content, disabled, ensureNamespacesLoaded]);

  const handleManage = useCallback(() => {
    setOpen(false);
    setActivePage('memory');
  }, [setActivePage]);

  const handleSave = useCallback(async (namespaceId: string, namespaceName: string) => {
    if (savingRef.current || !snapshot) return;

    savingRef.current = true;
    setSavingNamespaceId(namespaceId);
    try {
      const saved = await saveText(namespaceId, snapshot);
      if (saved.indexStatus === 'skipped') {
        messageApi.warning(t('chat.memory.saveSkipped', { namespace: namespaceName }));
      } else {
        messageApi.success(t('chat.memory.saveSuccess', { namespace: namespaceName }));
      }
      setOpen(false);
    } catch (error) {
      messageApi.error(t('chat.memory.saveFailed', { error: String(error) }));
    } finally {
      savingRef.current = false;
      setSavingNamespaceId(null);
    }
  }, [messageApi, saveText, snapshot, t]);

  const popoverContent = (() => {
    if (namespacesMeta.status === 'loading') {
      return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}>
          <Spin size="small" />
        </div>
      );
    }

    if (namespacesMeta.status === 'error') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
          <Typography.Text type="danger">
            {t('chat.memory.loadFailed', { error: loadError ?? '' })}
          </Typography.Text>
          <Button size="small" onClick={() => void loadNamespaces()}>
            {t('chat.memory.retry')}
          </Button>
        </div>
      );
    }

    if (sortedNamespaces.length === 0) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
          <Typography.Text type="secondary">{t('chat.memory.empty')}</Typography.Text>
          <Button type="link" size="small" onClick={handleManage} style={{ padding: 0, alignSelf: 'flex-start' }}>
            {t('chat.memory.manage')}
          </Button>
        </div>
      );
    }

    return sortedNamespaces.map((namespace) => (
      <Button
        key={namespace.id}
        type="text"
        block
        role="menuitem"
        aria-label={savingNamespaceId === namespace.id ? t('chat.memory.saving') : namespace.name}
        loading={savingNamespaceId === namespace.id}
        disabled={savingNamespaceId !== null}
        onClick={() => void handleSave(namespace.id, namespace.name)}
        style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 8 }}
      >
        <NamespaceIcon ns={namespace} size={16} />
        <span>{namespace.name}</span>
      </Button>
    ));
  })();

  return (
    <Popover
      trigger="click"
      placement="top"
      open={open}
      onOpenChange={handleOpenChange}
      content={(
        <div
          role="menu"
          aria-label={t('chat.memory.selectNamespace')}
          style={{ minWidth: 220, maxHeight: 320, overflowY: 'auto' }}
        >
          {popoverContent}
        </div>
      )}
    >
      {children}
    </Popover>
  );
}
