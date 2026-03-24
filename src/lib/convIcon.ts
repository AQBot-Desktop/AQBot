export type ConvIconType = 'model' | 'emoji' | 'url' | 'file';

export interface ConvIcon {
  type: ConvIconType;
  value: string;
}

export const CONV_ICON_KEY = (id: string) => `aqbot_conv_icon_${id}`;

export function getConvIcon(conversationId: string): ConvIcon | null {
  const stored = localStorage.getItem(CONV_ICON_KEY(conversationId));
  if (!stored) return null;
  try {
    return JSON.parse(stored) as ConvIcon;
  } catch {
    return null;
  }
}
