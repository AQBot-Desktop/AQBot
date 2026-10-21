import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Divider, Input, message, theme } from 'antd';
import { useProviderStore } from '@/stores/providerStore';
import { invoke } from '@/lib/invoke';
import type { ProviderConfig } from '@/types';

/** Mirrors backend `is_valid_gateway_prefix`: lowercase segments joined by single `-`. */
const GATEWAY_PREFIX_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GATEWAY_PREFIX_MAX_LENGTH = 32;

export type GatewayPrefixError = 'invalid' | 'duplicate';

export function validateGatewayPrefix(
  prefix: string,
  providerId: string,
  providers: ProviderConfig[],
): GatewayPrefixError | null {
  if (!prefix) return null;
  if (prefix.length > GATEWAY_PREFIX_MAX_LENGTH || !GATEWAY_PREFIX_PATTERN.test(prefix)) {
    return 'invalid';
  }
  const taken = providers.some((p) => p.id !== providerId && p.gateway_prefix === prefix);
  return taken ? 'duplicate' : null;
}

export function GatewayProviderPrefixes() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const providers = useProviderStore((s) => s.providers);
  const ensureProvidersLoaded = useProviderStore((s) => s.ensureProvidersLoaded);
  const updateProvider = useProviderStore((s) => s.updateProvider);
  const [effectivePrefixes, setEffectivePrefixes] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers]);

  useEffect(() => {
    void ensureProvidersLoaded();
  }, [ensureProvidersLoaded]);

  useEffect(() => {
    let cancelled = false;
    invoke<Record<string, string>>('get_gateway_provider_prefixes')
      .then((prefixes) => {
        if (!cancelled) setEffectivePrefixes(prefixes);
      })
      .catch(() => {
        if (!cancelled) setEffectivePrefixes({});
      });
    return () => {
      cancelled = true;
    };
  }, [providers]);

  const commit = useCallback(async (provider: ProviderConfig) => {
    const draft = drafts[provider.id];
    if (draft === undefined) return;
    const prefix = draft.trim().toLowerCase();
    const clearDraft = () => setDrafts((prev) => {
      const { [provider.id]: _removed, ...rest } = prev;
      return rest;
    });
    if (prefix === (provider.gateway_prefix ?? '')) {
      clearDraft();
      return;
    }
    const error = validateGatewayPrefix(prefix, provider.id, providers);
    if (error) {
      message.error(t(error === 'invalid' ? 'gateway.providerPrefixInvalid' : 'gateway.providerPrefixDuplicate'));
      return;
    }
    try {
      await updateProvider(provider.id, { gateway_prefix: prefix || null });
      clearDraft();
      message.success(t('common.saveSuccess'));
    } catch {
      message.error(t('error.saveFailed'));
    }
  }, [drafts, providers, t, updateProvider]);

  return (
    <Card size="small" title={t('gateway.providerPrefixes')} style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: token.colorTextSecondary, lineHeight: 1.5, marginBottom: 8 }}>
        {t('gateway.providerPrefixesDesc')}
      </div>
      {enabledProviders.length === 0 ? (
        <div style={{ padding: '4px 0', color: token.colorTextSecondary }}>
          {t('gateway.providerPrefixesEmpty')}
        </div>
      ) : (
        enabledProviders.map((provider, index) => (
          <div key={provider.id}>
            {index > 0 && <Divider style={{ margin: '4px 0' }} />}
            <div style={{ padding: '4px 0' }} className="flex items-center justify-between gap-4">
              <span style={{ flex: 1, minWidth: 0 }} className="truncate">{provider.name}</span>
              <Input
                style={{ width: 200 }}
                maxLength={GATEWAY_PREFIX_MAX_LENGTH}
                aria-label={t('gateway.providerPrefixInputLabel', { name: provider.name })}
                placeholder={effectivePrefixes[provider.id]}
                value={drafts[provider.id] ?? provider.gateway_prefix ?? ''}
                onChange={(e) => {
                  const { value } = e.target;
                  setDrafts((prev) => ({ ...prev, [provider.id]: value }));
                }}
                onBlur={() => void commit(provider)}
                onPressEnter={() => void commit(provider)}
                suffix={<span style={{ color: token.colorTextTertiary }}>/</span>}
              />
            </div>
          </div>
        ))
      )}
    </Card>
  );
}
