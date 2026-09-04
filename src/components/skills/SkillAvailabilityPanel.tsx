import { Button, Space, Tag, Typography } from 'antd';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '@/components/common/CopyButton';
import { formatInspectDiagnostics, inspectItemForSkill, primarySkillReason, skillReasonText } from '@/lib/skillAvailability';
import type { Skill, SkillInspectItem, SkillInspectReport } from '@/types';

const { Text } = Typography;

export function skillStatusTag(item: SkillInspectItem | undefined, t: (key: string) => string) {
  if (!item) return null;
  if (item.callable) return <Tag color="success">{t('skills.availabilityCallable')}</Tag>;
  const reason = primarySkillReason(item);
  if (reason?.code === 'disabled') return <Tag>{t('skills.disabled')}</Tag>;
  if (reason?.code === 'skill_tool_disabled') return <Tag color="warning">{t('skills.availabilitySkillToolOff')}</Tag>;
  if (reason?.code === 'overridden') return <Tag color="warning">{t('skills.availabilityOverridden')}</Tag>;
  if (reason?.code === 'parse_failed') return <Tag color="error">{t('skills.availabilityParseFailed')}</Tag>;
  if (reason?.code === 'unreadable') return <Tag color="error">{t('skills.availabilityUnreadable')}</Tag>;
  if (reason?.code === 'disable_model_invocation') {
    return <Tag color="processing">{t('skills.availabilityManualOnly')}</Tag>;
  }
  return <Tag>{t('skills.availabilityNotCallable')}</Tag>;
}

export function SkillAvailabilityPanel({
  report,
  loading,
  onRecheck,
  onOpenDir,
}: {
  report: SkillInspectReport;
  loading: boolean;
  onRecheck: () => void;
  onOpenDir: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, border: '1px solid var(--ant-color-border-secondary, #f0f0f0)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Text strong>{t('skills.availabilityTitle')}</Text>
        <Tag color={report.skillToolAllowed ? 'success' : 'warning'}>
          {report.skillToolAllowed ? t('skills.availabilitySkillToolOn') : t('skills.availabilitySkillToolOff')}
        </Tag>
        <div style={{ marginLeft: 'auto' }}>
          <Space size={4}>
            <span aria-label={t('skills.copyDiagnostics')}>
              <CopyButton
                text={() => formatInspectDiagnostics(t, report)}
                successMessage={t('skills.copyDiagnosticsSuccess')}
              />
            </span>
            <Button size="small" icon={<RefreshCw size={12} />} loading={loading} onClick={onRecheck}>
              {t('skills.recheck')}
            </Button>
          </Space>
        </div>
      </div>
      {report.items.length === 0 ? (
        <Text type="secondary">{t('skills.availabilityEmpty')}</Text>
      ) : (
        report.items.map((item) => (
          <div key={`${item.sourcePath}-${item.name}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Space size={6} wrap>
                <Text strong>{item.name}</Text>
                {skillStatusTag(item, t)}
              </Space>
              {item.reasons.filter((reason) => reason.code !== 'callable').map((reason) => (
                <div key={reason.code} style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
                  {skillReasonText(t, reason)}
                </div>
              ))}
            </div>
            <Button
              type="text"
              size="small"
              icon={<FolderOpen size={14} />}
              aria-label={t('skills.openDir')}
              onClick={() => onOpenDir(item.sourcePath)}
            />
          </div>
        ))
      )}
      <div style={{ marginTop: 8 }}>
        <Text strong>{t('skills.availabilityScanErrors')}</Text>
        {report.scanErrors.length === 0 ? (
          <div><Text type="secondary">{t('skills.availabilityNoScanErrors')}</Text></div>
        ) : (
          report.scanErrors.map((error) => (
            <div key={error.path} style={{ fontSize: 12, marginTop: 4 }}>
              <Text type="danger">{error.path}</Text>
              <div>{skillReasonText(t, {
                code: error.code,
                params: {
                  message: error.message,
                  ...(error.line != null ? { line: String(error.line) } : {}),
                  ...(error.column != null ? { column: String(error.column) } : {}),
                },
              })}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function skillInspectTagFor(
  report: SkillInspectReport | null,
  skill: Skill,
  t: (key: string) => string,
) {
  return skillStatusTag(inspectItemForSkill(report, skill.sourcePath, skill.name), t);
}
