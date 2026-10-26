import { Button, Typography } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getConversationRoleModels } from '@/lib/applyRole';
import { RoleModelBindingError, resolveRoleModelBinding } from '@/lib/roleModels';
import type { Model, ProviderConfig } from '@/types';

interface Props {
  conversationId: string;
  providers: ProviderConfig[];
  onManage: () => void;
  renderModel: (item: {
    providerId: string;
    modelId: string;
    name: string;
    providerName: string;
    model?: Model;
    disabled: boolean;
    onSelect: () => void;
  }) => ReactNode;
  onSelect: (providerId: string, modelId: string) => Promise<void>;
}

/** Candidates come from the applied snapshot, never from a subsequently edited preset. */
export function RoleModelCandidates({ conversationId, providers, renderModel, onSelect, onManage }: Props) {
  const { t } = useTranslation();
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
    <section style={{ padding: '4px 0' }} aria-label={t('chat.role.boundModels')}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('chat.role.boundModels')}</Typography.Text>
        <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} onClick={onManage}>{t('chat.role.manage')}</Button>
      </div>
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
        const provider = providers.find((item) => item.id === binding.provider_id);
        const model = provider?.models.find((item) => item.model_id === binding.model_id);
        return (
          <div key={JSON.stringify([binding.provider_id, binding.model_id])}>
            {renderModel({
              providerId: binding.provider_id,
              modelId: binding.model_id,
              name: model?.name ?? binding.model_id,
              providerName: provider?.name ?? binding.provider_id,
              model,
              disabled: !available,
              onSelect: () => {
                setSelectionFailed(false);
                void onSelect(binding.provider_id, binding.model_id).catch((error) => {
                  console.error('[RoleModelCandidates] failed to switch model', error);
                  setSelectionFailed(true);
                });
              },
            })}
            {!available && <Typography.Text type="secondary" style={{ fontSize: 11, padding: '0 16px' }}>{t('chat.role.modelUnavailable')}</Typography.Text>}
          </div>
        );
      })}
    </section>
  );
}
