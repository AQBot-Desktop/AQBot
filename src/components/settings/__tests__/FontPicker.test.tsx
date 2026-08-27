import type React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FontPicker } from '../FontPicker';
import { fontFaceValue } from '@/lib/systemFonts';

const onChange = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'settings.fontDefault': '系统默认',
        'settings.fontFaceThin': '极细',
        'settings.fontFaceExtraLight': '特细',
        'settings.fontFaceLight': '细体',
        'settings.fontFaceRegular': '常规',
        'settings.fontFaceMedium': '中等',
        'settings.fontFaceSemiBold': '半粗',
        'settings.fontFaceBold': '粗体',
        'settings.fontFaceExtraBold': '特粗',
        'settings.fontFaceBlack': '超粗',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('@/hooks/useSystemFonts', () => ({
  useSystemFonts: () => ['Alibaba PuHuiTi 3.0', 'Inter'],
}));

vi.mock('@/hooks/useSystemFontFaces', () => ({
  useSystemFontFaces: (family: string) => {
    if (family !== 'Alibaba PuHuiTi 3.0') return [];
    return [
      {
        name: '55 Regular',
        weight: 400,
        style: 'normal',
        local_names: ['Alibaba PuHuiTi 3.0 55 Regular'],
      },
      {
        name: '65 Medium',
        weight: 500,
        style: 'normal',
        local_names: ['Alibaba PuHuiTi 3.0 65 Medium'],
      },
    ];
  },
}));

vi.mock('../SettingsSelect', () => ({
  SettingsSelect: ({
    value,
    onChange: handleChange,
    options,
    ariaLabel,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    options: Array<{ label: React.ReactNode; value: string }>;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value ?? ''}
      onChange={(event) => handleChange?.(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {typeof option.label === 'string' ? option.label : option.value}
        </option>
      ))}
    </select>
  ),
}));

describe('FontPicker', () => {
  beforeEach(() => {
    onChange.mockClear();
  });

  it('lists the installed faces for a family such as Alibaba PuHuiTi 3.0', () => {
    render(
      <FontPicker
        value={{ family: 'Alibaba PuHuiTi 3.0', weight: 500, style: 'normal' }}
        onChange={onChange}
        familyAriaLabel="界面字体"
        styleAriaLabel="界面字重"
      />,
    );

    expect(screen.getByRole('option', { name: '55 Regular' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '65 Medium' })).toBeInTheDocument();
    expect(screen.getByLabelText('界面字重')).toHaveValue(
      fontFaceValue({ name: '65 Medium', weight: 500, style: 'normal' }),
    );
  });

  it('saves the matching weight when a named face is selected', () => {
    render(
      <FontPicker
        value={{ family: 'Alibaba PuHuiTi 3.0', weight: 400, style: 'normal' }}
        onChange={onChange}
        familyAriaLabel="界面字体"
        styleAriaLabel="界面字重"
      />,
    );

    fireEvent.change(screen.getByLabelText('界面字重'), {
      target: { value: fontFaceValue({ name: '65 Medium', weight: 500, style: 'normal' }) },
    });

    expect(onChange).toHaveBeenCalledWith({
      family: 'Alibaba PuHuiTi 3.0',
      weight: 500,
      style: 'normal',
    });
  });

  it('falls back to generic CSS weights when no family is selected', () => {
    render(
      <FontPicker
        value={{ family: '', weight: 400, style: 'normal' }}
        onChange={onChange}
        familyAriaLabel="界面字体"
        styleAriaLabel="界面字重"
      />,
    );

    expect(screen.getByRole('option', { name: '常规' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '中等' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '粗体' })).toBeInTheDocument();
  });
});
