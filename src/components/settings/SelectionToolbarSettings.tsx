import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Steps,
  Switch,
  Tag,
  Tooltip,
  message,
  theme,
  type InputRef,
} from 'antd';
import { AlertTriangle, AppWindow, GripVertical, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import { useProviderStore, useSettingsStore } from '@/stores';
import { ModelParamSliders } from '@/components/common/ModelParamSliders';
import { ModelSelect, parseModelValue } from '@/components/shared/ModelSelect';
import { LucideToolIcon } from '@/components/shared/LucideToolIcon';
import {
  SelectionToolbarStrip,
  type SelectionToolbarStripItem,
} from '@/components/shared/SelectionToolbarStrip';
import {
  GLOBAL_SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_LABEL_KEYS,
  findExternalConflict,
  formatShortcutForDisplay,
  getShortcutBinding,
  normalizeShortcutFromKeyboardEvent,
  toTauriAccelerator,
} from '@/lib/shortcuts';
import {
  SELECTION_TRANSLATE_LANGUAGES,
  type SelectionTranslateLanguage,
} from '@/constants/selectionTranslateLanguages';
import {
  createDefaultSelectionToolbarSettings,
  matchSelectionToolbarSearchPreset,
  SELECTION_TOOLBAR_DEFAULT_SEARCH_URL,
  SELECTION_TOOLBAR_DEFAULT_SHORTCUT,
  SELECTION_TOOLBAR_MAX_VISIBLE_TOOLS,
  SELECTION_TOOLBAR_SEARCH_PRESETS,
  type SelectionToolbarAppEntry,
  type SelectionToolbarAppFilterMode,
  type SelectionToolbarDisplayMode,
  type SelectionToolbarInstalledApp,
  type SelectionToolbarPlacement,
  type SelectionToolbarPermissionSettingsOutcome,
  type SelectionToolbarRuntimeStatus,
  type SelectionToolbarSearchPresetId,
  type SelectionToolbarSettings as SelectionToolbarConfig,
  type SelectionToolbarTool,
  type SelectionToolbarTriggerMode,
} from '@/types';
import { SettingsGroup } from './SettingsGroup';

const LucideIconPickerModal = lazy(() => import('@/components/shared/LucideIconPickerModal'));

const { TextArea } = Input;

function toolId(tool: SelectionToolbarTool) {
  return tool.kind === 'custom_ai' ? tool.id : tool.builtin_key;
}

function toolIconName(tool: SelectionToolbarTool): string {
  if (tool.kind === 'builtin_action') {
    return tool.builtin_key === 'search' ? 'search' : 'copy';
  }
  if (tool.kind === 'builtin_ai') {
    return {
      translate: 'languages',
      explain: 'lightbulb',
      polish: 'spell-check',
      summarize: 'list-collapse',
    }[tool.builtin_key];
  }
  return tool.icon;
}

function isValidSearchUrl(url: string): boolean {
  const value = url.trim();
  if (!value || value.length > 512) return false;
  if (!value.startsWith('http://') && !value.startsWith('https://')) return false;
  return value.includes('%s');
}

function toolName(tool: SelectionToolbarTool, t: (key: string) => string) {
  return tool.kind === 'custom_ai'
    ? tool.name
    : t(`settings.selectionToolbar.tools.${tool.builtin_key}`);
}

function AppIcon({
  src,
  size = 28,
}: {
  src?: string | null;
  size?: number;
}) {
  const { token } = theme.useToken();
  if (src) {
    return (
      <img
        alt=""
        src={src}
        style={{
          borderRadius: 6,
          flex: '0 0 auto',
          height: size,
          objectFit: 'contain',
          width: size,
        }}
      />
    );
  }
  return (
    <span
      style={{
        alignItems: 'center',
        background: token.colorFillTertiary,
        borderRadius: 6,
        color: token.colorTextSecondary,
        display: 'inline-flex',
        flex: '0 0 auto',
        height: size,
        justifyContent: 'center',
        width: size,
      }}
    >
      <AppWindow size={Math.max(14, size - 10)} />
    </span>
  );
}

type AppPickerPlatform = 'macos' | 'windows' | 'linux' | 'unsupported';

function appPickerDefaults(platform: AppPickerPlatform): {
  defaultPath?: string;
  filters: Array<{ name: string; extensions: string[] }>;
} {
  switch (platform) {
    case 'macos':
      return {
        defaultPath: '/Applications',
        filters: [{ name: 'Applications', extensions: ['app'] }],
      };
    case 'windows':
      return {
        defaultPath: 'C:\\Program Files',
        filters: [
          { name: 'Executables', extensions: ['exe'] },
          { name: 'Shortcuts', extensions: ['lnk'] },
        ],
      };
    case 'linux':
      return {
        defaultPath: '/usr/share/applications',
        filters: [
          { name: 'Desktop entries', extensions: ['desktop'] },
        ],
      };
    default:
      return {
        filters: [{ name: 'All', extensions: ['*'] }],
      };
  }
}

function normalizeDialogPaths(selected: string | string[] | null): string[] {
  if (!selected) return [];
  return (Array.isArray(selected) ? selected : [selected])
    .map((path) => path.trim())
    .filter(Boolean);
}

function mergeInstalledApps(
  current: SelectionToolbarInstalledApp[],
  incoming: SelectionToolbarInstalledApp[],
): SelectionToolbarInstalledApp[] {
  const map = new Map(current.map((app) => [app.id, app]));
  for (const app of incoming) {
    const existing = map.get(app.id);
    map.set(app.id, {
      ...existing,
      ...app,
      icon_data_url: app.icon_data_url ?? existing?.icon_data_url ?? null,
    });
  }
  return [...map.values()];
}

const appIconCache = new Map<string, string>();
const appIconRequests = new Map<string, Promise<string | null>>();

function cacheInstalledAppIcons(apps: SelectionToolbarInstalledApp[]): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const app of apps) {
    if (!app.icon_data_url) continue;
    appIconCache.set(app.id, app.icon_data_url);
    icons[app.id] = app.icon_data_url;
  }
  return icons;
}

function cachedAppIcons(ids: string[]): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const id of ids) {
    const icon = appIconCache.get(id);
    if (icon) icons[id] = icon;
  }
  return icons;
}

async function resolveAppIcons(ids: string[]): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(ids)];
  const missingIds = uniqueIds.filter(
    (id) => !appIconCache.has(id) && !appIconRequests.has(id),
  );
  if (missingIds.length > 0) {
    const batch = invoke<Record<string, string>>(
      'selection_toolbar_resolve_app_icons',
      { ids: missingIds },
    );
    for (const id of missingIds) {
      const request = batch
        .then((icons) => {
          const icon = icons[id] ?? null;
          if (icon) appIconCache.set(id, icon);
          return icon;
        })
        .finally(() => {
          if (appIconRequests.get(id) === request) appIconRequests.delete(id);
        });
      appIconRequests.set(id, request);
    }
  }

  await Promise.all(uniqueIds.map((id) => appIconRequests.get(id)));
  return cachedAppIcons(uniqueIds);
}

/** Native file dialog + confirmation list (add more / remove before saving). */
function AppFilterConfirmModal({
  open,
  apps,
  icons,
  resolving,
  platform,
  onClose,
  onChangeApps,
  onConfirm,
  onAddMore,
}: {
  open: boolean;
  apps: SelectionToolbarInstalledApp[];
  icons: Record<string, string>;
  resolving: boolean;
  platform: AppPickerPlatform;
  onClose: () => void;
  onChangeApps: (apps: SelectionToolbarInstalledApp[]) => void;
  onConfirm: () => void;
  onAddMore: () => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  return (
    <Modal
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onClose}>{t('common.cancel')}</Button>,
        <Button key="more" disabled={resolving} onClick={onAddMore}>
          {t('settings.selectionToolbar.appFilterAddMore')}
        </Button>,
        <Button
          key="ok"
          disabled={apps.length === 0 || resolving}
          type="primary"
          onClick={onConfirm}
        >
          {t('settings.selectionToolbar.appFilterConfirm')}
        </Button>,
      ]}
      open={open}
      title={t('settings.selectionToolbar.appFilterConfirmTitle')}
      width={520}
      onCancel={onClose}
    >
      <div style={{ color: token.colorTextDescription, fontSize: 12, marginBottom: 12 }}>
        {t(
          platform === 'macos'
            ? 'settings.selectionToolbar.appFilterPickHintMac'
            : platform === 'windows'
              ? 'settings.selectionToolbar.appFilterPickHintWin'
              : platform === 'linux'
                ? 'settings.selectionToolbar.appFilterPickHintLinux'
                : 'settings.selectionToolbar.appFilterPickHint',
        )}
      </div>
      {apps.length === 0 ? (
        <Empty description={t('settings.selectionToolbar.appFilterConfirmEmpty')} />
      ) : (
        <div
          style={{
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            maxHeight: 360,
            overflow: 'auto',
          }}
        >
          {apps.map((app) => (
            <div
              key={app.id}
              style={{
                alignItems: 'center',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                display: 'flex',
                gap: 10,
                padding: '8px 10px',
              }}
            >
              <AppIcon src={app.icon_data_url ?? icons[app.id]} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {app.name}
                </div>
                <div
                  style={{
                    color: token.colorTextDescription,
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={app.id}
                >
                  {app.id}
                </div>
              </div>
              <Tooltip title={t('settings.selectionToolbar.appFilterRemove')}>
                <Button
                  aria-label={t('settings.selectionToolbar.appFilterRemove')}
                  danger
                  icon={<Trash2 size={14} />}
                  size="small"
                  type="text"
                  onClick={() => onChangeApps(apps.filter((item) => item.id !== app.id))}
                />
              </Tooltip>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function SortableToolRow({
  tool,
  onToggle,
  onEdit,
  onReset,
  onDelete,
}: {
  tool: SelectionToolbarTool;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const sortable = useSortable({ id: toolId(tool) });

  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        alignItems: 'center',
        display: 'flex',
        gap: 10,
        opacity: sortable.isDragging ? 0.5 : 1,
        padding: '10px 4px',
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      <button
        aria-label={t('settings.selectionToolbar.reorder')}
        {...sortable.attributes}
        {...sortable.listeners}
        style={{
          background: 'none',
          border: 0,
          color: token.colorTextQuaternary,
          cursor: sortable.isDragging ? 'grabbing' : 'grab',
          padding: 2,
          touchAction: 'none',
        }}
        type="button"
      >
        <GripVertical size={16} />
      </button>
      <LucideToolIcon name={toolIconName(tool)} size={18} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ alignItems: 'center', display: 'flex', gap: 6 }}>
          <span style={{ fontWeight: 500 }}>{toolName(tool, t)}</span>
          <Tag bordered={false}>
            {t(`settings.selectionToolbar.${tool.kind === 'custom_ai' ? 'custom' : 'builtin'}`)}
          </Tag>
        </div>
        <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
          {t(`settings.selectionToolbar.${tool.kind === 'builtin_action' ? 'actionTool' : 'aiTool'}`)}
        </div>
      </div>
      {(tool.kind !== 'builtin_action' || tool.builtin_key === 'search') && (
        <Button size="small" type="text" onClick={onEdit}>
          {t('common.edit')}
        </Button>
      )}
      {tool.kind !== 'custom_ai' && (
        <Tooltip title={t('settings.selectionToolbar.reset')}>
          <Button aria-label={t('settings.selectionToolbar.reset')} icon={<RotateCcw size={14} />} size="small" type="text" onClick={onReset} />
        </Tooltip>
      )}
      {tool.kind === 'custom_ai' && (
        <Tooltip title={t('common.delete')}>
          <Button aria-label={t('common.delete')} danger icon={<Trash2 size={14} />} size="small" type="text" onClick={onDelete} />
        </Tooltip>
      )}
      <Switch aria-label={toolName(tool, t)} checked={tool.enabled} size="small" onChange={onToggle} />
    </div>
  );
}

function SearchToolEditor({
  searchUrl,
  onClose,
  onSave,
}: {
  searchUrl: string;
  onClose: () => void;
  onSave: (searchUrl: string) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [draftUrl, setDraftUrl] = useState(searchUrl || SELECTION_TOOLBAR_DEFAULT_SEARCH_URL);
  const [preset, setPreset] = useState<SelectionToolbarSearchPresetId>(
    () => matchSelectionToolbarSearchPreset(searchUrl || SELECTION_TOOLBAR_DEFAULT_SEARCH_URL),
  );

  useEffect(() => {
    const next = searchUrl || SELECTION_TOOLBAR_DEFAULT_SEARCH_URL;
    setDraftUrl(next);
    setPreset(matchSelectionToolbarSearchPreset(next));
  }, [searchUrl]);

  const applyPreset = (value: SelectionToolbarSearchPresetId) => {
    setPreset(value);
    if (value === 'custom') return;
    const matched = SELECTION_TOOLBAR_SEARCH_PRESETS.find((item) => item.id === value);
    if (matched) setDraftUrl(matched.url);
  };

  const submit = () => {
    if (!isValidSearchUrl(draftUrl)) {
      message.error(t('settings.selectionToolbar.searchUrlInvalid'));
      return;
    }
    onSave(draftUrl.trim());
  };

  return (
    <Modal
      open
      destroyOnHidden
      title={t('settings.selectionToolbar.tools.search')}
      okText={t('common.save')}
      onCancel={onClose}
      onOk={submit}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        {t('settings.selectionToolbar.searchEngine')}
      </div>
      <Select<SelectionToolbarSearchPresetId>
        aria-label={t('settings.selectionToolbar.searchEngine')}
        style={{ width: '100%', marginBottom: 16 }}
        value={preset}
        options={[
          ...SELECTION_TOOLBAR_SEARCH_PRESETS.map((item) => ({
            value: item.id,
            label: t(`settings.selectionToolbar.searchPresets.${item.id}`),
          })),
          {
            value: 'custom',
            label: t('settings.selectionToolbar.searchPresets.custom'),
          },
        ]}
        onChange={applyPreset}
      />
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        {t('settings.selectionToolbar.searchUrl')}
      </div>
      <Input
        aria-label={t('settings.selectionToolbar.searchUrl')}
        value={draftUrl}
        onChange={(event) => {
          const next = event.target.value;
          setDraftUrl(next);
          setPreset(matchSelectionToolbarSearchPreset(next));
        }}
      />
      <div style={{ color: token.colorTextDescription, fontSize: 12, marginTop: 6 }}>
        {t('settings.selectionToolbar.searchUrlHint')}
      </div>
    </Modal>
  );
}

function ToolEditor({
  tool,
  translateTargetLanguage,
  onClose,
  onSave,
}: {
  tool: SelectionToolbarTool | null;
  translateTargetLanguage: string | null;
  onClose: () => void;
  onSave: (tool: SelectionToolbarTool, translateTargetLanguage: string | null) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [draft, setDraft] = useState<SelectionToolbarTool | null>(tool);
  const [draftTranslateTarget, setDraftTranslateTarget] = useState(translateTargetLanguage);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  useEffect(() => {
    setDraft(tool);
    setDraftTranslateTarget(translateTargetLanguage);
    setIconPickerOpen(false);
  }, [tool, translateTargetLanguage]);
  if (!draft || draft.kind === 'builtin_action') return null;

  const modelValue = draft.ai.provider_id && draft.ai.model_id
    ? `${draft.ai.provider_id}::${draft.ai.model_id}`
    : undefined;

  const submit = () => {
    if (draft.kind === 'custom_ai' && !draft.name.trim()) {
      message.error(t('settings.selectionToolbar.nameRequired'));
      return;
    }
    if (!draft.ai.prompt.includes('{selection}')) {
      message.error(t('settings.selectionToolbar.placeholderRequired'));
      return;
    }
    onSave(draft, draftTranslateTarget);
  };

  return (
    <Modal
      footer={[
        <Button key="cancel" onClick={onClose}>{t('common.cancel')}</Button>,
        <Button key="save" type="primary" onClick={submit}>{t('common.save')}</Button>,
      ]}
      mask={{ enabled: true, blur: true }}
      open
      title={toolName(draft, t)}
      width={560}
      onCancel={onClose}
    >
      {draft.kind === 'custom_ai' && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr auto', marginBottom: 16 }}>
          <Input
            aria-label={t('settings.selectionToolbar.name')}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <Button
            aria-label={t('settings.selectionToolbar.icon')}
            icon={<LucideToolIcon name={draft.icon} size={16} />}
            title={draft.icon}
            onClick={() => setIconPickerOpen(true)}
          >
            {t('settings.selectionToolbar.icon')}
          </Button>
          {iconPickerOpen && (
            <Suspense fallback={null}>
              <LucideIconPickerModal
                open
                value={draft.icon}
                onClose={() => setIconPickerOpen(false)}
                onSelect={(icon) => setDraft({ ...draft, icon })}
              />
            </Suspense>
          )}
        </div>
      )}
      {draft.kind === 'builtin_ai' && draft.builtin_key === 'translate' && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {t('settings.selectionToolbar.translateTargetLanguage')}
          </div>
          <Select<string, { value: string; label: string; english: string }>
            aria-label={t('settings.selectionToolbar.translateTargetLanguage')}
            filterOption={(input, option) => {
              const query = input.trim().toLowerCase();
              if (!query || !option) return true;
              return option.value.toLowerCase().includes(query)
                || option.label.toLowerCase().includes(query)
                || option.english.toLowerCase().includes(query);
            }}
            options={[
              {
                value: 'follow',
                label: t('settings.selectionToolbar.translateFollowApp'),
                english: 'follow application language',
              },
              ...SELECTION_TRANSLATE_LANGUAGES.map((language: SelectionTranslateLanguage) => ({
                value: language.code,
                label: language.native,
                english: language.english,
              })),
            ]}
            showSearch
            style={{ width: '100%' }}
            value={draftTranslateTarget ?? 'follow'}
            onChange={(value) => setDraftTranslateTarget(value === 'follow' ? null : value)}
          />
          <div style={{ color: token.colorTextDescription, fontSize: 12, marginTop: 6 }}>
            {t('settings.selectionToolbar.translateTargetHint')}
          </div>
        </div>
      )}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        {t('settings.selectionToolbar.prompt')}
      </div>
      <TextArea
        aria-label={t('settings.selectionToolbar.prompt')}
        rows={6}
        value={draft.ai.prompt}
        onChange={(event) => setDraft({ ...draft, ai: { ...draft.ai, prompt: event.target.value } })}
      />
      <div style={{ color: token.colorTextDescription, fontSize: 12, margin: '6px 0 16px' }}>
        {t(
          draft.kind === 'builtin_ai' && draft.builtin_key === 'translate'
            ? 'settings.selectionToolbar.promptHintTranslate'
            : 'settings.selectionToolbar.promptHint',
        )}
      </div>
      <ModelSelect
        modelType="Chat"
        placeholder={t('settings.selectionToolbar.inheritModel')}
        style={{ width: '100%' }}
        value={modelValue}
        onChange={(value) => {
          const parsed = parseModelValue(value);
          setDraft({
            ...draft,
            ai: {
              ...draft.ai,
              provider_id: parsed?.providerId ?? null,
              model_id: parsed?.modelId ?? null,
            },
          });
        }}
      />
      <Divider />
      {([
        ['text_direct_send', 'textDirectSend', 'textDirectSendHint'],
        ['screenshot_direct_send', 'screenshotDirectSend', 'screenshotDirectSendHint'],
      ] as const).map(([field, labelKey, hintKey]) => (
        <div key={field} style={{ alignItems: 'center', display: 'flex', gap: 16, justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div>{t(`settings.selectionToolbar.${labelKey}`)}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t(`settings.selectionToolbar.${hintKey}`)}
            </div>
          </div>
          <Switch
            aria-label={t(`settings.selectionToolbar.${labelKey}`)}
            checked={draft.ai[field]}
            onChange={(checked) => setDraft({ ...draft, ai: { ...draft.ai, [field]: checked } })}
          />
        </div>
      ))}
      <ModelParamSliders
        values={{
          temperature: draft.ai.temperature,
          topP: draft.ai.top_p,
          maxTokens: draft.ai.max_tokens,
          frequencyPenalty: null,
        }}
        visibleParams={['temperature', 'topP', 'maxTokens']}
        onChange={(values) => setDraft({
          ...draft,
          ai: {
            ...draft.ai,
            ...('temperature' in values ? { temperature: values.temperature ?? null } : {}),
            ...('topP' in values ? { top_p: values.topP ?? null } : {}),
            ...('maxTokens' in values ? { max_tokens: values.maxTokens ?? null } : {}),
          },
        })}
      />
    </Modal>
  );
}

function ToolbarPreview({
  items,
  displayMode,
}: {
  items: SelectionToolbarStripItem[];
  displayMode: SelectionToolbarDisplayMode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(
    Math.min(items.length, SELECTION_TOOLBAR_MAX_VISIBLE_TOOLS),
  );

  useEffect(() => {
    if (visibleCount >= items.length) setExpanded(false);
  }, [items.length, visibleCount]);

  return (
    <SelectionToolbarStrip
      copiedLabel={t('common.copied')}
      displayMode={displayMode}
      dragLabel={t('settings.selectionToolbar.drag')}
      expanded={expanded}
      items={items}
      moreLabel={t('settings.selectionToolbar.more')}
      preview
      previewLabel={t('settings.selectionToolbar.preview')}
      onMorePointerDown={() => setExpanded((current) => !current)}
      onVisibleCountChange={setVisibleCount}
    />
  );
}

function ToolbarShortcutSetting({
  kind,
  binding,
  otherBinding,
  onChange,
}: {
  kind: 'triggerShortcut' | 'screenshotShortcut';
  binding: string;
  otherBinding: string;
  onChange: (binding: string) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const appSettings = useSettingsStore((state) => state.settings);
  const status = useSettingsStore((state) => state.globalShortcutStatus);
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<InputRef>(null);
  const accelerator = toTauriAccelerator(binding);
  const conflictAction = binding.trim() && GLOBAL_SHORTCUT_ACTIONS.find((action) =>
    toTauriAccelerator(getShortcutBinding(appSettings, action)).toLowerCase()
      === accelerator.toLowerCase());
  const conflictLabel = conflictAction
    ? SHORTCUT_ACTION_LABEL_KEYS[conflictAction]
    : binding.trim() && otherBinding.trim()
      && toTauriAccelerator(otherBinding).toLowerCase() === accelerator.toLowerCase()
      ? `settings.selectionToolbar.${kind === 'triggerShortcut' ? 'screenshotShortcut' : 'triggerShortcut'}`
      : null;
  const externalConflict = findExternalConflict(accelerator);
  const failure = binding.trim() && status?.failed.find((item) =>
    item.shortcut === accelerator || item.shortcut === '*');

  useEffect(() => {
    if (recording) inputRef.current?.focus();
  }, [recording]);

  const update = (shortcut: string) => {
    setRecording(false);
    onChange(shortcut);
  };

  return (
    <div aria-label={t(`settings.selectionToolbar.${kind}`)} role="group" style={{ padding: '12px 0' }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div>{t(`settings.selectionToolbar.${kind}`)}</div>
          <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
            {t(`settings.selectionToolbar.${kind}Hint`)}
          </div>
        </div>
        <Space>
          <Input
            aria-label={t(`settings.selectionToolbar.${kind}`)}
            readOnly
            ref={inputRef}
            status={conflictLabel ? 'error' : undefined}
            style={{ width: 180 }}
            value={recording ? t('settings.pressShortcut') : formatShortcutForDisplay(binding)}
            onKeyDown={(event) => {
              if (!recording) return;
              event.preventDefault();
              event.stopPropagation();
              const shortcut = normalizeShortcutFromKeyboardEvent(event.nativeEvent);
              if (shortcut) update(shortcut);
            }}
          />
          <Button type={recording ? 'primary' : 'default'} onClick={() => setRecording(true)}>
            {t('settings.recordShortcut')}
          </Button>
          <Tooltip title={t(kind === 'triggerShortcut' ? 'settings.resetShortcutSingle' : 'settings.clearShortcut')}>
            <Button
              aria-label={t(kind === 'triggerShortcut' ? 'settings.resetShortcutSingle' : 'settings.clearShortcut')}
              icon={kind === 'triggerShortcut' ? <RotateCcw size={14} /> : <Trash2 size={14} />}
              size="small"
              type="text"
              onClick={() => update(kind === 'triggerShortcut' ? SELECTION_TOOLBAR_DEFAULT_SHORTCUT : '')}
            />
          </Tooltip>
        </Space>
      </div>
      {!appSettings.global_shortcuts_enabled && binding.trim() && (
        <Alert message={t('settings.selectionToolbar.globalShortcutsDisabled')} showIcon style={{ marginTop: 10 }} type="warning" />
      )}
      {conflictLabel && (
        <div style={{ color: token.colorError, fontSize: 12, marginTop: 8 }}>
          <AlertTriangle size={13} style={{ marginInlineEnd: 4, verticalAlign: -2 }} />
          {t('settings.selectionToolbar.shortcutConflict', { target: t(conflictLabel) })}
        </div>
      )}
      {!conflictLabel && externalConflict && (
        <div style={{ color: token.colorWarning, fontSize: 12, marginTop: 8 }}>
          <AlertTriangle size={13} style={{ marginInlineEnd: 4, verticalAlign: -2 }} />
          {t('settings.selectionToolbar.shortcutExternalConflict', { apps: externalConflict })}
        </div>
      )}
      {failure && (
        <div style={{ color: token.colorError, fontSize: 12, marginTop: 8 }}>
          {t('settings.selectionToolbar.shortcutRegisterFailed', { reason: failure.reason })}
        </div>
      )}
    </div>
  );
}

export function SelectionToolbarSettings() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const appSettings = useSettingsStore((state) => state.settings);
  const settings = appSettings.selection_toolbar;
  const saveSettings = useSettingsStore((state) => state.saveSettings);
  const ensureProvidersLoaded = useProviderStore((state) => state.ensureProvidersLoaded);
  const [runtime, setRuntime] = useState<SelectionToolbarRuntimeStatus | null>(null);
  const [editing, setEditing] = useState<SelectionToolbarTool | null>(null);
  const [manualPermissionPath, setManualPermissionPath] = useState<string | null>(null);
  const [permissionGuideOpen, setPermissionGuideOpen] = useState(false);
  const [appConfirmOpen, setAppConfirmOpen] = useState(false);
  const [pendingApps, setPendingApps] = useState<SelectionToolbarInstalledApp[]>([]);
  const [appPickResolving, setAppPickResolving] = useState(false);
  const [appIcons, setAppIcons] = useState<Record<string, string>>(
    () => cachedAppIcons((settings.app_filter ?? []).map((entry) => entry.id)),
  );
  const runtimeRefreshInFlight = useRef<Promise<SelectionToolbarRuntimeStatus> | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const appFilterMode: SelectionToolbarAppFilterMode = settings.app_filter_mode ?? 'off';
  const appFilter: SelectionToolbarAppEntry[] = settings.app_filter ?? [];
  const pickerPlatform: AppPickerPlatform = runtime?.platform ?? 'unsupported';
  const displayMode: SelectionToolbarDisplayMode = settings.display_mode ?? 'full';
  const placement: SelectionToolbarPlacement = settings.placement ?? 'below';
  const resultPinnedByDefault = settings.result_pinned_by_default ?? false;
  const triggerMode: SelectionToolbarTriggerMode = settings.trigger_mode ?? 'selection';
  const triggerShortcut = settings.trigger_shortcut ?? SELECTION_TOOLBAR_DEFAULT_SHORTCUT;
  const screenshotShortcut = settings.screenshot_shortcut ?? '';

  useEffect(() => {
    if (appFilterMode === 'off' || appFilter.length === 0) return;
    const ids = appFilter.map((entry) => entry.id);
    void resolveAppIcons(ids)
      .then((icons) => setAppIcons((current) => ({ ...current, ...icons })))
      .catch(() => {
        // Icons are decorative; ignore resolution failures.
      });
  }, [appFilter, appFilterMode]);

  useEffect(() => {
    if (!appConfirmOpen || pendingApps.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      void resolveAppIcons(pendingApps.map((app) => app.id))
        .then((icons) => setAppIcons((current) => ({ ...current, ...icons })))
        .catch(() => {
          // Icons are decorative; keep the confirmation usable without them.
        });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [appConfirmOpen, pendingApps]);

  const pickAppsNative = useCallback(async (): Promise<SelectionToolbarInstalledApp[] | null> => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const defaults = appPickerDefaults(pickerPlatform);
      const selected = await open({
        multiple: true,
        directory: false,
        defaultPath: defaults.defaultPath,
        filters: defaults.filters,
        title: t('settings.selectionToolbar.appFilterNativeTitle'),
      });
      const paths = normalizeDialogPaths(selected);
      if (paths.length === 0) return null;
      setAppPickResolving(true);
      try {
        const resolved = await invoke<SelectionToolbarInstalledApp[]>(
          'selection_toolbar_resolve_app_paths',
          { paths },
        );
        if (resolved.length === 0) {
          message.warning(t('settings.selectionToolbar.appFilterResolveEmpty'));
          return [];
        }
        const icons = cacheInstalledAppIcons(resolved);
        if (Object.keys(icons).length > 0) {
          setAppIcons((current) => ({ ...current, ...icons }));
        }
        return resolved;
      } finally {
        setAppPickResolving(false);
      }
    } catch (error) {
      message.error(String(error) || t('settings.selectionToolbar.appFilterPickFailed'));
      return null;
    }
  }, [pickerPlatform, t]);

  const startAddApps = useCallback(async () => {
    const resolved = await pickAppsNative();
    if (resolved === null) return;
    if (resolved.length === 0) return;
    setPendingApps(resolved);
    setAppConfirmOpen(true);
  }, [pickAppsNative]);

  const addMorePendingApps = useCallback(async () => {
    const resolved = await pickAppsNative();
    if (resolved === null || resolved.length === 0) return;
    setPendingApps((current) => mergeInstalledApps(current, resolved));
  }, [pickAppsNative]);

  const reportRuntimeError = useCallback((error: unknown) => setRuntime({
    state: 'error',
    platform: 'unsupported',
    permission: 'unknown',
    last_error: { code: 'status_failed', message: String(error) },
    global_dismissal_supported: false,
  }), []);

  const refreshRuntime = useCallback(() => {
    if (runtimeRefreshInFlight.current) return runtimeRefreshInFlight.current;
    const request = (async () => {
      let next = await invoke<SelectionToolbarRuntimeStatus>(
        'selection_toolbar_get_runtime_status',
      );
      if (
        settings.enabled
        && next.permission === 'granted'
        && next.state === 'permission_required'
      ) {
        next = await invoke<SelectionToolbarRuntimeStatus>(
          'selection_toolbar_retry_monitoring',
        );
      }
      setRuntime(next);
      return next;
    })();
    runtimeRefreshInFlight.current = request;
    const clearRequest = () => {
      if (runtimeRefreshInFlight.current === request) {
        runtimeRefreshInFlight.current = null;
      }
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }, [settings.enabled]);

  useEffect(() => {
    void ensureProvidersLoaded();
  }, [ensureProvidersLoaded]);

  useEffect(() => {
    const refresh = () => {
      void refreshRuntime().catch(reportRuntimeError);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    void refreshRuntime()
      .catch(reportRuntimeError);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshRuntime, reportRuntimeError]);

  useEffect(() => {
    if (runtime?.platform !== 'macos') return;
    const interval = window.setInterval(() => {
      void refreshRuntime().catch(reportRuntimeError);
    }, 1500);
    return () => window.clearInterval(interval);
  }, [refreshRuntime, reportRuntimeError, runtime?.platform]);

  const persist = async (next: SelectionToolbarConfig) => {
    try {
      await saveSettings({ selection_toolbar: next });
      const state = useSettingsStore.getState();
      if (state.settings.selection_toolbar !== next) {
        message.error(state.error ?? t('settings.selectionToolbar.saveFailed'));
        return;
      }
      await refreshRuntime();
    } catch (error) {
      message.error(String(error));
    }
  };
  const ids = useMemo(() => settings.tools.map(toolId), [settings.tools]);
  const permission = runtime?.permission ?? 'unknown';
  const platform = runtime?.platform ?? 'unsupported';
  const permissionColor = permission === 'granted' || permission === 'not_required'
    ? 'success'
    : permission === 'denied'
      ? 'error'
      : 'default';
  const permissionHintKey = platform === 'macos'
    ? permission === 'granted'
      ? 'settings.selectionToolbar.permissionGrantedHint'
      : permission === 'denied'
        ? 'settings.selectionToolbar.permissionDeniedHint'
        : null
    : platform === 'windows'
      ? 'settings.selectionToolbar.permissionWindowsHint'
      : platform === 'linux'
        ? 'settings.selectionToolbar.permissionLinuxHint'
        : null;
  const openPermissionSettings = () => {
    void invoke<SelectionToolbarPermissionSettingsOutcome>(
      'selection_toolbar_open_permission_settings',
    )
      .then((outcome) => {
        setManualPermissionPath(
          outcome.kind === 'manual_add_required'
            ? outcome.executable_path
            : null,
        );
      })
      .catch((error) => message.error(String(error)));
  };

  const startPermissionGuide = () => {
    setPermissionGuideOpen(true);
    void invoke('selection_toolbar_request_permission')
      .then(openPermissionSettings)
      .catch((error) => message.error(String(error)));
  };

  const replaceTool = (nextTool: SelectionToolbarTool) => {
    persist({
      ...settings,
      tools: settings.tools.map((tool) => toolId(tool) === toolId(nextTool) ? nextTool : tool),
    });
    setEditing(null);
  };

  const addTool = () => {
    const id = crypto.randomUUID();
    setEditing({
      kind: 'custom_ai',
      id,
      name: t('settings.selectionToolbar.newTool'),
      icon: 'wand-sparkles',
      enabled: true,
      ai: {
        prompt: '{selection}',
        text_direct_send: true,
        screenshot_direct_send: true,
        provider_id: null,
        model_id: null,
        temperature: null,
        top_p: null,
        max_tokens: null,
      },
    });
  };

  const saveEditor = (
    tool: SelectionToolbarTool,
    translateTargetLanguage: string | null,
  ) => {
    const exists = settings.tools.some((item) => toolId(item) === toolId(tool));
    const tools = exists
      ? settings.tools.map((item) => toolId(item) === toolId(tool) ? tool : item)
      : [...settings.tools, tool];
    void persist({
      ...settings,
      tools,
      ...(tool.kind === 'builtin_ai' && tool.builtin_key === 'translate'
        ? { translate_target_language: translateTargetLanguage }
        : {}),
    });
    setEditing(null);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = settings.tools.findIndex((tool) => toolId(tool) === active.id);
    const to = settings.tools.findIndex((tool) => toolId(tool) === over.id);
    if (from < 0 || to < 0) return;
    const tools = [...settings.tools];
    const [moved] = tools.splice(from, 1);
    tools.splice(to, 0, moved);
    persist({ ...settings, tools });
  };

  const previewItems = settings.tools
    .filter((tool) => tool.enabled)
    .map((tool) => ({
      id: toolId(tool),
      icon: toolIconName(tool),
      label: toolName(tool, t),
    }));

  return (
    <div
      className="p-6 pb-12"
      data-testid="selection-toolbar-settings"
      style={{ boxSizing: 'border-box', width: '100%' }}
    >
      <SettingsGroup title={t('settings.selectionToolbar.title')}>
        <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
          <div>
            <div>{t('settings.selectionToolbar.enabled')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t('settings.selectionToolbar.enabledHint')}
            </div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t('settings.selectionToolbar.supportedAppsHint')}
            </div>
          </div>
          <Switch
            aria-label={t('settings.selectionToolbar.enabled')}
            checked={settings.enabled}
            onChange={(enabled) => persist({ ...settings, enabled })}
          />
        </div>
        <Divider style={{ margin: 0 }} />
        <div style={{ alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between', padding: '12px 0' }}>
          <div>
            <div>{t('settings.selectionToolbar.triggerMode')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t('settings.selectionToolbar.triggerModeHint')}
            </div>
          </div>
          <Segmented
            aria-label={t('settings.selectionToolbar.triggerMode')}
            options={[
              {
                label: t('settings.selectionToolbar.triggerModeSelection'),
                value: 'selection',
              },
              {
                label: t('settings.selectionToolbar.triggerModeShortcut'),
                value: 'shortcut',
              },
            ]}
            value={triggerMode}
            onChange={(trigger_mode) => {
              void persist({
                ...settings,
                trigger_mode: trigger_mode as SelectionToolbarTriggerMode,
              });
            }}
          />
        </div>
        {triggerMode === 'shortcut' && (
          <>
            <Divider style={{ margin: 0 }} />
            <ToolbarShortcutSetting
              binding={triggerShortcut}
              kind="triggerShortcut"
              otherBinding={screenshotShortcut}
              onChange={(trigger_shortcut) => { void persist({ ...settings, trigger_shortcut }); }}
            />
          </>
        )}
        <Divider style={{ margin: 0 }} />
        <ToolbarShortcutSetting
          binding={screenshotShortcut}
          kind="screenshotShortcut"
          otherBinding={triggerMode === 'shortcut' ? triggerShortcut : ''}
          onChange={(screenshot_shortcut) => { void persist({ ...settings, screenshot_shortcut }); }}
        />
        <Divider style={{ margin: 0 }} />
        <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', padding: '12px 0' }}>
          <span>{t('settings.selectionToolbar.themeFollow')}</span>
          <Switch
            aria-label={t('settings.selectionToolbar.themeFollow')}
            checked={settings.theme_follow}
            onChange={(theme_follow) => persist({ ...settings, theme_follow })}
          />
        </div>
        <Divider style={{ margin: 0 }} />
        <div style={{ alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between', padding: '12px 0 4px' }}>
          <div style={{ minWidth: 0 }}>
            <div>{t('settings.selectionToolbar.displayMode')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t('settings.selectionToolbar.displayModeHint')}
            </div>
          </div>
          <Segmented
            aria-label={t('settings.selectionToolbar.displayMode')}
            options={[
              {
                value: 'full',
                label: t('settings.selectionToolbar.displayModeFull'),
              },
              {
                value: 'compact',
                label: t('settings.selectionToolbar.displayModeCompact'),
              },
            ]}
            value={displayMode}
            onChange={(display_mode) => persist({
              ...settings,
              display_mode: display_mode as SelectionToolbarDisplayMode,
            })}
          />
        </div>
        <Divider style={{ margin: 0 }} />
        <div style={{ alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between', padding: '12px 0' }}>
          <div style={{ minWidth: 0 }}>
            <div>{t('settings.selectionToolbar.placement')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t('settings.selectionToolbar.placementHint')}
            </div>
          </div>
          <Segmented
            aria-label={t('settings.selectionToolbar.placement')}
            options={[
              {
                value: 'above',
                label: t('settings.selectionToolbar.placementAbove'),
              },
              {
                value: 'below',
                label: t('settings.selectionToolbar.placementBelow'),
              },
            ]}
            value={placement}
            onChange={(nextPlacement) => persist({
              ...settings,
              placement: nextPlacement as SelectionToolbarPlacement,
            })}
          />
        </div>
        <Divider style={{ margin: 0 }} />
        <div style={{ alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between', padding: '12px 0 4px' }}>
          <div style={{ minWidth: 0 }}>
            <div>{t('settings.selectionToolbar.resultPinnedByDefault')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t('settings.selectionToolbar.resultPinnedByDefaultHint')}
            </div>
          </div>
          <Switch
            aria-label={t('settings.selectionToolbar.resultPinnedByDefault')}
            checked={resultPinnedByDefault}
            onChange={(result_pinned_by_default) => persist({
              ...settings,
              result_pinned_by_default,
            })}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.selectionToolbar.permissionGroupTitle')}>
        <div style={{ padding: '8px 0 4px' }}>
          <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <span>{t('settings.selectionToolbar.permissionTitle')}</span>
                <Tag color={permissionColor} style={{ marginInlineEnd: 0 }}>
                  {t(`settings.selectionToolbar.permission.${permission}`)}
                </Tag>
              </div>
              <div style={{ color: token.colorTextDescription, fontSize: 12, marginTop: 4 }}>
                {t(`settings.selectionToolbar.platformMechanism.${platform}`)}
              </div>
            </div>
            {platform === 'macos' && permission !== 'granted' && (
              <div style={{ alignItems: 'center', display: 'flex', flex: '0 0 auto', gap: 4 }}>
                <Button size="small" type="primary" onClick={startPermissionGuide}>
                  {t('settings.selectionToolbar.requestPermission')}
                </Button>
                <Button size="small" type="link" onClick={openPermissionSettings}>
                  {t('settings.selectionToolbar.openPermission')}
                </Button>
              </div>
            )}
          </div>
          {permissionHintKey && (
            <div style={{ color: token.colorTextDescription, fontSize: 12, marginTop: 6 }}>
              {t(permissionHintKey)}
            </div>
          )}
          {manualPermissionPath && (
            <div
              role="alert"
              style={{
                background: token.colorWarningBg,
                border: `1px solid ${token.colorWarningBorder}`,
                borderRadius: token.borderRadius,
                color: token.colorText,
                fontSize: 12,
                marginTop: 10,
                padding: '8px 10px',
                wordBreak: 'break-all',
              }}
            >
              {t('settings.selectionToolbar.developmentPermissionHint', {
                path: manualPermissionPath,
              })}
            </div>
          )}
        </div>
      </SettingsGroup>
      <Modal
        footer={permission === 'granted'
          ? [
              <Button key="done" type="primary" onClick={() => setPermissionGuideOpen(false)}>
                {t('settings.selectionToolbar.guideDone')}
              </Button>,
            ]
          : [
              <Button key="close" onClick={() => setPermissionGuideOpen(false)}>
                {t('common.close')}
              </Button>,
              <Button key="open" type="primary" onClick={openPermissionSettings}>
                {t('settings.selectionToolbar.openPermission')}
              </Button>,
            ]}
        onCancel={() => setPermissionGuideOpen(false)}
        open={permissionGuideOpen}
        title={t('settings.selectionToolbar.guideTitle')}
      >
        {permission === 'granted' ? (
          <Alert
            message={t('settings.selectionToolbar.guideGranted')}
            showIcon
            type="success"
          />
        ) : (
          <>
            <div style={{ color: token.colorTextDescription, marginBottom: 16 }}>
              {t('settings.selectionToolbar.guideIntro')}
            </div>
            <Steps
              current={0}
              direction="vertical"
              items={[
                { title: t('settings.selectionToolbar.guideStepOpen') },
                { title: t('settings.selectionToolbar.guideStepEnable') },
                { title: t('settings.selectionToolbar.guideStepReturn') },
              ]}
              size="small"
            />
          </>
        )}
        <div style={{ alignItems: 'center', display: 'flex', gap: 8, marginTop: 18 }}>
          <span>{t('settings.selectionToolbar.permissionTitle')}</span>
          <Tag color={permissionColor} style={{ marginInlineEnd: 0 }}>
            {t(`settings.selectionToolbar.permission.${permission}`)}
          </Tag>
        </div>
      </Modal>

      <SettingsGroup
        style={{ position: 'relative', zIndex: 10 }}
        title={t('settings.selectionToolbar.previewTitle')}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '12px 0',
            position: 'relative',
          }}
        >
          <ToolbarPreview
            displayMode={displayMode}
            items={previewItems}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        extra={<Button icon={<Plus size={14} />} size="small" onClick={addTool}>{t('settings.selectionToolbar.addTool')}</Button>}
        title={t('settings.selectionToolbar.toolsTitle')}
      >
        <DndContext collisionDetection={closestCenter} sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {settings.tools.map((tool, index) => (
              <div key={toolId(tool)}>
                {index > 0 && <Divider style={{ margin: 0 }} />}
                <SortableToolRow
                  tool={tool}
                  onDelete={() => persist({ ...settings, tools: settings.tools.filter((item) => toolId(item) !== toolId(tool)) })}
                  onEdit={() => setEditing(tool)}
                  onReset={() => {
                    const defaults = createDefaultSelectionToolbarSettings();
                    const defaultTool = defaults.tools.find((item) => toolId(item) === toolId(tool));
                    if (!defaultTool) return;
                    if (tool.kind === 'builtin_action' && tool.builtin_key === 'search') {
                      void persist({
                        ...settings,
                        tools: settings.tools.map((item) =>
                          toolId(item) === toolId(tool) ? defaultTool : item),
                        search_url: defaults.search_url,
                      });
                      return;
                    }
                    replaceTool(defaultTool);
                  }}
                  onToggle={(enabled) => replaceTool({ ...tool, enabled })}
                />
              </div>
            ))}
          </SortableContext>
        </DndContext>
      </SettingsGroup>

      <SettingsGroup
        extra={appFilterMode !== 'off' ? (
          <Button
            icon={<Plus size={14} />}
            loading={appPickResolving && !appConfirmOpen}
            size="small"
            onClick={() => void startAddApps()}
          >
            {t('settings.selectionToolbar.appFilterAdd')}
          </Button>
        ) : undefined}
        title={t('settings.selectionToolbar.appFilterTitle')}
      >
        <div style={{ alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between', padding: '8px 0' }}>
          <div style={{ minWidth: 0 }}>
            <div>{t('settings.selectionToolbar.appFilterMode')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t(
                appFilterMode === 'allowlist'
                  ? 'settings.selectionToolbar.appFilterHintAllowlist'
                  : appFilterMode === 'blocklist'
                    ? 'settings.selectionToolbar.appFilterHintBlocklist'
                    : 'settings.selectionToolbar.appFilterHintOff',
              )}
            </div>
          </div>
          <Select<SelectionToolbarAppFilterMode>
            aria-label={t('settings.selectionToolbar.appFilterMode')}
            options={[
              { value: 'off', label: t('settings.selectionToolbar.appFilterModeOff') },
              { value: 'allowlist', label: t('settings.selectionToolbar.appFilterModeAllowlist') },
              { value: 'blocklist', label: t('settings.selectionToolbar.appFilterModeBlocklist') },
            ]}
            style={{ flex: '0 0 auto', width: 200 }}
            value={appFilterMode}
            onChange={(mode) => persist({
              ...settings,
              app_filter_mode: mode,
              app_filter: settings.app_filter ?? [],
            })}
          />
        </div>
        {appFilterMode !== 'off' && (
          <>
            <Divider style={{ margin: 0 }} />
            {appFilter.length === 0 ? (
              <div style={{ color: token.colorTextDescription, fontSize: 12, padding: '12px 0' }}>
                {t('settings.selectionToolbar.appFilterEmpty')}
                {appFilterMode === 'allowlist' && (
                  <div style={{ color: token.colorWarning, marginTop: 4 }}>
                    {t('settings.selectionToolbar.appFilterHintAllowlist')}
                  </div>
                )}
              </div>
            ) : (
              appFilter.map((entry, index) => (
                <div key={entry.id}>
                  {index > 0 && <Divider style={{ margin: 0 }} />}
                  <div
                    style={{
                      alignItems: 'center',
                      display: 'flex',
                      gap: 10,
                      padding: '10px 4px',
                    }}
                  >
                    <AppIcon src={appIcons[entry.id] ?? null} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entry.name}
                      </div>
                      <div
                        style={{
                          color: token.colorTextDescription,
                          fontSize: 12,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={entry.id}
                      >
                        {entry.id}
                      </div>
                    </div>
                    <Tooltip title={t('settings.selectionToolbar.appFilterRemove')}>
                      <Button
                        aria-label={t('settings.selectionToolbar.appFilterRemove')}
                        danger
                        icon={<Trash2 size={14} />}
                        size="small"
                        type="text"
                        onClick={() => persist({
                          ...settings,
                          app_filter_mode: appFilterMode,
                          app_filter: appFilter.filter((item) => item.id !== entry.id),
                        })}
                      />
                    </Tooltip>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </SettingsGroup>
      <AppFilterConfirmModal
        apps={pendingApps}
        icons={appIcons}
        open={appConfirmOpen}
        platform={pickerPlatform}
        resolving={appPickResolving}
        onAddMore={() => void addMorePendingApps()}
        onChangeApps={setPendingApps}
        onClose={() => {
          setAppConfirmOpen(false);
          setPendingApps([]);
        }}
        onConfirm={() => {
          const merged = new Map(appFilter.map((entry) => [entry.id, entry]));
          for (const app of pendingApps) {
            merged.set(app.id, { id: app.id, name: app.name });
          }
          void persist({
            ...settings,
            app_filter_mode: appFilterMode,
            app_filter: [...merged.values()],
          });
          setAppConfirmOpen(false);
          setPendingApps([]);
        }}
      />

      {editing?.kind === 'builtin_action' && editing.builtin_key === 'search' ? (
        <SearchToolEditor
          searchUrl={settings.search_url || SELECTION_TOOLBAR_DEFAULT_SEARCH_URL}
          onClose={() => setEditing(null)}
          onSave={(search_url) => {
            void persist({ ...settings, search_url });
            setEditing(null);
          }}
        />
      ) : (
        <ToolEditor
          tool={editing}
          translateTargetLanguage={settings.translate_target_language ?? null}
          onClose={() => setEditing(null)}
          onSave={saveEditor}
        />
      )}
    </div>
  );
}
