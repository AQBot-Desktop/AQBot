import { describe, expect, it } from 'vitest';
import { getContextErrorMessage, parseCodedError } from '../contextErrorMessage';

describe('parseCodedError', () => {
  it('reads a JSON payload with a stable code', () => {
    expect(parseCodedError('{"code":"MEMORY_L1_TOO_LARGE","args":{"limit":5000,"bytes":5120}}')).toEqual({
      code: 'MEMORY_L1_TOO_LARGE',
      args: { limit: 5000, bytes: 5120 },
    });
  });

  it('strips the validation prefix used by AQBotError::Validation', () => {
    expect(parseCodedError('Validation error: {"code":"TOOL_CAPABILITY_REQUIRED","args":{}}')?.code)
      .toBe('TOOL_CAPABILITY_REQUIRED');
  });
});

describe('getContextErrorMessage', () => {
  it('maps codes through i18n', () => {
    const t = (key: string, args?: Record<string, unknown>) => {
      if (key === 'errors.MEMORY_L1_TOO_LARGE') return `too large ${args?.bytes}/${args?.limit}`;
      return key;
    };
    expect(getContextErrorMessage(
      '{"code":"MEMORY_L1_TOO_LARGE","args":{"limit":5000,"bytes":5120}}',
      t as never,
    )).toBe('too large 5120/5000');
  });
});
