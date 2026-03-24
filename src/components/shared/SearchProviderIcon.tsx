import { ProviderIcon } from '@lobehub/icons';
import Tavily from '@lobehub/icons/es/Tavily';
import { Search as SearchIcon } from 'lucide-react';

/** Renders the correct icon for a given SearchProviderType */
export function SearchProviderTypeIcon({ type, size = 20 }: { type: string; size?: number }) {
  switch (type) {
    case 'tavily':
      return <Tavily.Color size={size} />;
    case 'zhipu':
      return <ProviderIcon provider="zhipu" size={size} type="color" />;
    case 'bocha':
      return <img src="/icons/bocha.ico" alt="Bocha" style={{ width: size, height: size }} />;
    default:
      return <SearchIcon size={size - 2} />;
  }
}

export const PROVIDER_TYPE_LABELS: Record<string, string> = {
  tavily: 'Tavily',
  zhipu: '智谱',
  bocha: '博查',
};
