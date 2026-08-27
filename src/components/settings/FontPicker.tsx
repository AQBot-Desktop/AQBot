import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSystemFontFaces } from '@/hooks/useSystemFontFaces';
import { useSystemFonts } from '@/hooks/useSystemFonts';
import { quoteCssFontFamily } from '@/lib/cssFontFamily';
import {
  fontFaceValue,
  genericFaceLabelKey,
  matchFontFace,
  parseFontFaceValue,
  resolvePickerFaces,
  type CssFontStyle,
} from '@/lib/systemFonts';
import { SettingsSelect } from './SettingsSelect';

export interface FontPickerValue {
  family: string;
  weight: number;
  style: CssFontStyle;
}

interface FontPickerProps {
  value: FontPickerValue;
  onChange: (value: FontPickerValue) => void;
  familyAriaLabel: string;
  styleAriaLabel: string;
}

export function FontPicker({
  value,
  onChange,
  familyAriaLabel,
  styleAriaLabel,
}: FontPickerProps) {
  const { t } = useTranslation();
  const families = useSystemFonts();
  const systemFaces = useSystemFontFaces(value.family);
  const faces = useMemo(() => resolvePickerFaces(systemFaces), [systemFaces]);
  const selectedFace = matchFontFace(faces, value.weight, value.style) ?? faces[0];
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (systemFaces.length === 0) return;
    const matched = matchFontFace(systemFaces, value.weight, value.style);
    if (!matched) return;
    if (matched.weight === value.weight && matched.style === value.style) return;
    onChangeRef.current({
      family: value.family,
      weight: matched.weight,
      style: matched.style,
    });
  }, [systemFaces, value.family, value.weight, value.style]);

  const familyOptions = useMemo(
    () => [
      { label: t('settings.fontDefault'), value: '' },
      ...families.map((family) => ({
        label: (
          <span style={{ fontFamily: quoteCssFontFamily(family) }}>{family}</span>
        ),
        value: family,
      })),
    ],
    [families, t],
  );

  const styleOptions = useMemo(
    () => faces.map((face) => {
      const labelKey = genericFaceLabelKey(face.name);
      return {
        label: labelKey ? t(labelKey) : face.name,
        value: fontFaceValue(face),
      };
    }),
    [faces, t],
  );

  return (
    <div className="flex items-center gap-1">
      <SettingsSelect
        searchable
        ariaLabel={familyAriaLabel}
        labelMaxWidth={168}
        value={value.family}
        onChange={(family) => onChange({
          family,
          weight: value.weight,
          style: family ? value.style : 'normal',
        })}
        options={familyOptions}
      />
      <SettingsSelect
        ariaLabel={styleAriaLabel}
        labelMaxWidth={132}
        value={selectedFace ? fontFaceValue(selectedFace) : ''}
        onChange={(next) => {
          const parsed = parseFontFaceValue(next);
          if (!parsed) return;
          onChange({
            family: value.family,
            weight: parsed.weight,
            style: parsed.style,
          });
        }}
        options={styleOptions}
      />
    </div>
  );
}
