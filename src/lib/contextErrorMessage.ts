import type { TFunction } from 'i18next';
import { getErrorMessage } from '@/lib/errorMessage';

export type CodedError = {
  code: string;
  args?: Record<string, unknown>;
};

export function parseCodedError(error: unknown): CodedError | null {
  const raw = getErrorMessage(error).trim();
  const jsonText = raw.replace(/^Validation error:\s*/i, '');
  const start = jsonText.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(jsonText.slice(start)) as { code?: unknown; args?: unknown };
    if (typeof parsed.code !== 'string' || !parsed.code) return null;
    const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
      ? parsed.args as Record<string, unknown>
      : {};
    return { code: parsed.code, args };
  } catch {
    return null;
  }
}

export function getContextErrorMessage(error: unknown, t: TFunction): string {
  const coded = parseCodedError(error);
  if (!coded) return getErrorMessage(error);
  const key = `errors.${coded.code}`;
  const translated = t(key, coded.args);
  return translated === key ? getErrorMessage(error) : translated;
}
