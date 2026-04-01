import { Slider, InputNumber, Switch, Tooltip, Divider, theme } from 'antd';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// ── Single parameter row with optional switch ──────────────

interface ParamRowProps {
  label: string;
  tooltip?: string;
  value: number | null;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  marks?: Record<string | number, string>;
  inputWidth?: number;
  onChange: (v: number | null) => void;
  showSwitch?: boolean;
  showDivider?: boolean;
}

function ParamRow({
  label,
  tooltip,
  value,
  defaultValue,
  min,
  max,
  step,
  marks,
  inputWidth = 70,
  onChange,
  showSwitch = true,
  showDivider = true,
}: ParamRowProps) {
  const { token } = theme.useToken();
  const isOn = value !== null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
          {label}
          {tooltip && (
            <Tooltip title={tooltip}>
              <Info size={12} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
            </Tooltip>
          )}
        </span>
        {showSwitch && (
          <Switch
            size="small"
            checked={isOn}
            onChange={(checked) => onChange(checked ? defaultValue : null)}
          />
        )}
      </div>
      {isOn && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
          <Slider
            style={{ flex: 1 }}
            min={min}
            max={max}
            step={step}
            marks={marks}
            value={value!}
            onChange={(v) => onChange(v)}
          />
          <InputNumber
            style={{ width: inputWidth }}
            min={min}
            max={max}
            step={step}
            value={value!}
            onChange={(v) => v !== null && onChange(v)}
            size="small"
          />
        </div>
      )}
      {showDivider && <Divider style={{ margin: 0 }} />}
    </>
  );
}

// ── Exported composite component ───────────────────────────

export interface ModelParamValues {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  frequencyPenalty: number | null;
}

export interface ModelParamDefaults {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
}

export interface ModelParamSlidersProps {
  values: ModelParamValues;
  onChange: (values: Partial<ModelParamValues>) => void;
  /** Default values when toggling a param ON (defaults: temp=0.7, topP=1.0, maxTokens=4096, freqPenalty=0) */
  defaults?: ModelParamDefaults;
  /** Show parameter toggle switches (default: true) */
  showSwitch?: boolean;
  /** Show dividers between rows (default: true) */
  showDividers?: boolean;
  /** Which parameters to render (default: all four) */
  visibleParams?: Array<'temperature' | 'topP' | 'maxTokens' | 'frequencyPenalty'>;
}

const MAX_TOKENS_MARKS: Record<string | number, string> = {
  256: '', 32768: '32K', 131072: '128K', 1048576: '1M',
};

const TEMPERATURE_MARKS: Record<string | number, string> = {
  0: '0', 0.5: '', 1: '1', 1.5: '', 2: '2',
};

const TOP_P_MARKS: Record<string | number, string> = {
  0: '0', 0.5: '', 1: '1',
};

const FREQ_PENALTY_MARKS: Record<string | number, string> = {
  '-2': '-2', 0: '0', 2: '2',
};

const DEFAULT_DEFAULTS: Required<ModelParamDefaults> = {
  temperature: 0.7,
  topP: 1.0,
  maxTokens: 4096,
  frequencyPenalty: 0,
};

const ALL_PARAMS = ['temperature', 'topP', 'maxTokens', 'frequencyPenalty'] as const;

export function ModelParamSliders({
  values,
  onChange,
  defaults,
  showSwitch = true,
  showDividers = true,
  visibleParams = [...ALL_PARAMS],
}: ModelParamSlidersProps) {
  const { t } = useTranslation();
  const d = { ...DEFAULT_DEFAULTS, ...defaults };

  const visible = new Set(visibleParams);
  const visibleList = ALL_PARAMS.filter((p) => visible.has(p));

  return (
    <>
      {visibleList.map((param, idx) => {
        const isLast = idx === visibleList.length - 1;

        switch (param) {
          case 'temperature':
            return (
              <ParamRow
                key="temperature"
                label={t('settings.temperature', '温度')}
                tooltip={t('settings.temperatureTooltip', '较高的值会使输出更随机，较低的值会使输出更确定')}
                value={values.temperature}
                defaultValue={d.temperature}
                min={0}
                max={2}
                step={0.1}
                marks={TEMPERATURE_MARKS}
                onChange={(v) => onChange({ temperature: v })}
                showSwitch={showSwitch}
                showDivider={showDividers && !isLast}
              />
            );
          case 'topP':
            return (
              <ParamRow
                key="topP"
                label="Top P"
                tooltip={t('settings.topPTooltip', '控制采样范围，较低的值会限制模型只从最可能的词中选择')}
                value={values.topP}
                defaultValue={d.topP}
                min={0}
                max={1}
                step={0.05}
                marks={TOP_P_MARKS}
                onChange={(v) => onChange({ topP: v })}
                showSwitch={showSwitch}
                showDivider={showDividers && !isLast}
              />
            );
          case 'maxTokens':
            return (
              <ParamRow
                key="maxTokens"
                label={t('settings.maxTokens', '最大 Tokens')}
                tooltip={t('settings.maxTokensTooltip', '模型生成的最大 Token 数量')}
                value={values.maxTokens}
                defaultValue={d.maxTokens}
                min={256}
                max={1048576}
                step={256}
                marks={MAX_TOKENS_MARKS}
                inputWidth={90}
                onChange={(v) => onChange({ maxTokens: v })}
                showSwitch={showSwitch}
                showDivider={showDividers && !isLast}
              />
            );
          case 'frequencyPenalty':
            return (
              <ParamRow
                key="frequencyPenalty"
                label={t('settings.frequencyPenalty', '频率惩罚')}
                tooltip={t('settings.frequencyPenaltyTooltip', '对重复 token 施加惩罚，减少重复内容的生成')}
                value={values.frequencyPenalty}
                defaultValue={d.frequencyPenalty}
                min={-2}
                max={2}
                step={0.1}
                marks={FREQ_PENALTY_MARKS}
                onChange={(v) => onChange({ frequencyPenalty: v })}
                showSwitch={showSwitch}
                showDivider={showDividers && !isLast}
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
}
