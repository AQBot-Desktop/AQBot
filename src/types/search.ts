export type SearchProviderType = 'tavily' | 'zhipu' | 'bocha';

export type SearchProvider = {
  id: string;
  name: string;
  providerType: SearchProviderType;
  endpoint?: string;
  hasApiKey: boolean;
  enabled: boolean;
  region?: string;
  language?: string;
  safeSearch?: boolean;
  resultLimit: number;
  timeoutMs: number;
};

export type SearchCitation = {
  id: string;
  conversationId: string;
  messageId: string;
  title: string;
  url: string;
  snippet?: string;
  providerId: string;
  rank: number;
};

export type CreateSearchProviderInput = {
  name: string;
  providerType: SearchProviderType;
  endpoint?: string;
  apiKey?: string;
  enabled?: boolean;
  region?: string;
  language?: string;
  safeSearch?: boolean;
  resultLimit?: number;
  timeoutMs?: number;
};

export type UpdateSearchProviderInput = Partial<CreateSearchProviderInput>;

/** A single search result item returned by execute_search */
export type SearchResultItem = {
  title: string;
  content: string;
  url: string;
};

/** Response from the execute_search Tauri command */
export type SearchExecuteResponse = {
  ok: boolean;
  query: string;
  results: SearchResultItem[];
  latencyMs: number;
  error?: string;
};
