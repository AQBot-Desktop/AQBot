import { Form, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, RoleModelBinding } from '@/types';

const bindingKey = (binding: RoleModelBinding) => JSON.stringify([binding.provider_id, binding.model_id]);

export function RoleModelBindingsEditor({ bindings, providers, onChange }: {
  bindings: RoleModelBinding[];
  providers: ProviderConfig[];
  onChange: (bindings: RoleModelBinding[]) => void;
}) {
  const { t } = useTranslation();
  const available = providers.filter((provider) => provider.enabled).flatMap((provider) =>
    provider.models.filter((model) => model.enabled && model.model_type === 'Chat').map((model) => ({
      binding: { provider_id: provider.id, model_id: model.model_id },
      label: `${provider.name} / ${model.name || model.model_id}`,
    })),
  );
  const options = [...available];
  for (const binding of bindings) {
    if (!options.some((option) => bindingKey(option.binding) === bindingKey(binding))) {
      options.push({ binding, label: t('roles.unavailableModel', { model: `${binding.provider_id} / ${binding.model_id}` }) });
    }
  }
  const selectOptions = options.map((option) => ({ value: bindingKey(option.binding), label: option.label }));
  return (
    <>
      <Form.Item label={t('roles.modelBindings')} extra={t('roles.modelBindingsHint')}>
        <Select
          mode="multiple"
          allowClear
          showSearch
          optionFilterProp="label"
          aria-label={t('roles.modelBindings')}
          placeholder={t('roles.modelBindingsPlaceholder')}
          value={bindings.map(bindingKey)}
          options={selectOptions}
          onChange={(keys: string[]) => onChange(keys.map((key) => options.find((option) => bindingKey(option.binding) === key)!.binding))}
        />
      </Form.Item>
      {bindings.length > 0 && (
        <Form.Item label={t('roles.defaultModel')}>
          <Select
            aria-label={t('roles.defaultModel')}
            value={bindingKey(bindings[0])}
            options={selectOptions.filter((option) => bindings.some((binding) => bindingKey(binding) === option.value))}
            onChange={(key: string) => onChange([
              bindings.find((binding) => bindingKey(binding) === key)!,
              ...bindings.filter((binding) => bindingKey(binding) !== key),
            ])}
          />
        </Form.Item>
      )}
    </>
  );
}
