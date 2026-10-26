import { Button, Space, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getConversationRoleModels } from '@/lib/applyRole';
import { RoleModelBindingError, resolveRoleModelBinding } from '@/lib/roleModels';
import { useUIStore } from '@/stores';
import type { ProviderConfig } from '@/types';

interface Props {
  conversationId: string;
  providers: ProviderConfig[];
  currentModel: { providerId: string; modelId: string };
  onSelect: (providerId: string, modelId: string) => Promise<void>;
}

/** Candidates come from the applied snapshot, never from a subsequently edited preset. */
export function RoleModelCandidates({ conversationId, providers, currentModel, onSelect }: Props) {
  const { t } = useTranslation();
  const setActivePage = useUIStore((s) => s.setActivePage);
  const [selectionFailed, setSelectionFailed] = useState(false);
  const snapshot = useMemo(() => {
    try {
      return { bindings: getConversationRoleModels(conversationId), error: false };
    } catch (error) {
      console.error('[RoleModelCandidates] failed to read snapshot', error);
      return { bindings: [], error: true };
    }
  }, [conversationId]);
  if (!snapshot.error && snapshot.bindings.length === 0) return null;
  return (
    <section style={{ padding: '4px 12px' }} aria-label={t('chat.role.boundModels')}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('chat.role.boundModels')}</Typography.Text>
      {(snapshot.error || selectionFailed) && <div role="alert">{t('roles.applyFailed')}</div>}
      {snapshot.bindings.map((binding) => {
        let selection;
        try {
          selection = resolveRoleModelBinding(binding, providers);
        } catch (error) {
          if (!(error instanceof RoleModelBindingError)) throw error;
          // Keep unavailable snapshot candidates visible so users can repair the preset.
        }
        const available = selection !== undefined;
        return (
          <Space direction="vertical" size={0} style={{ display: 'flex' }} key={JSON.stringify([binding.provider_id, binding.model_id])}>
            <Button
              type={currentModel.providerId === binding.provider_id && currentModel.modelId === binding.model_id ? 'primary' : 'text'}
              size="small"
              block
              aria-pressed={currentModel.providerId === binding.provider_id && currentModel.modelId === binding.model_id}
              style={{ textAlign: 'left', justifyContent: 'flex-start', marginTop: 4 }}
              disabled={!available}
              title={available ? undefined : t('chat.role.modelUnavailable')}
              onClick={() => {
                setSelectionFailed(false);
                void onSelect(binding.provider_id, binding.model_id).catch((error) => {
                  console.error('[RoleModelCandidates] failed to switch model', error);
                  setSelectionFailed(true);
                });
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selection ? `${selection.provider.name} / ${selection.model.name}` : `${binding.provider_id} / ${binding.model_id}`}</span>
            </Button>
            {!available && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('chat.role.modelUnavailable')}</Typography.Text>}
          </Space>
        );
      })}
      <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setActivePage('roles')}>{t('chat.role.manage')}</Button>
    </section>
  );
}
