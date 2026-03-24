import { useMemo } from 'react';
import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

/**
 * shadcn/ui-inspired Ant Design theme.
 * Clean borders, consistent radius, subtle shadows.
 * Adapts to dark/light via Ant Design's algorithm.
 */
export function useShadcnTheme(isDark: boolean, primaryColor: string, fontSize: number, borderRadius: number): ThemeConfig {
  return useMemo<ThemeConfig>(
    () => {
      // Derive proportional radii from the base value
      const radiusSM = Math.max(0, Math.round(borderRadius * 0.6));
      const radiusXS = Math.max(0, Math.round(borderRadius * 0.2));
      const radiusLG = Math.max(0, Math.round(borderRadius * 1.4));

      return {
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: primaryColor,
          colorLink: primaryColor,
          fontSize,
          fontWeightStrong: 500,

          // Border radius — configurable base with proportional variants
          borderRadius,
          borderRadiusXS: radiusXS,
          borderRadiusSM: radiusSM,
          borderRadiusLG: radiusLG,

          // Spacing
          padding: 16,
          paddingSM: 12,
          paddingLG: 24,
          margin: 16,
          marginSM: 12,
          marginLG: 24,

          // Shadows — subtle, layered
          boxShadow:
            '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)',
          boxShadowSecondary:
            '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)',
        },
        components: {
          Button: {
            primaryShadow: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
          },
          Input: {
            activeShadow: 'none',
          },
          Select: {
            optionSelectedFontWeight: 500,
          },
          Modal: {
            borderRadiusLG: Math.max(radiusLG, 8),
          },
          Switch: {
            trackHeight: 24,
            trackMinWidth: 44,
            innerMinMargin: 4,
            innerMaxMargin: 24,
          },
          Slider: {
            handleSize: 8,
            handleSizeHover: 10,
            railSize: 4,
          },
        },
      };
    },
    [isDark, primaryColor, fontSize, borderRadius],
  );
}
