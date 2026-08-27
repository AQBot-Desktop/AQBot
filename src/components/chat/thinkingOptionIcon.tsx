import { Atom, CircleOff, Signal, SignalHigh, SignalLow, SignalMedium } from 'lucide-react';
import type { ReasoningOption } from '@/lib/reasoningProfile';

export function thinkingOptionIcon(icon: ReasoningOption['icon'], size = 14) {
  switch (icon) {
    case 'off': return <CircleOff size={size} />;
    case 'low': return <SignalLow size={size} />;
    case 'medium': return <SignalMedium size={size} />;
    case 'high': return <SignalHigh size={size} />;
    case 'xhigh':
    case 'max': return <Signal size={size} />;
    default: return <Atom size={size} />;
  }
}
