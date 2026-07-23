import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ImageProtocolEditor } from '../ImageProtocolEditor';

describe('ImageProtocolEditor', () => {
  it('shows localized labels while preserving protocol values', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ImageProtocolEditor
        value={{ adapter_id: 'generic_json' }}
        providerType="custom"
        modelId="custom-image"
        onChange={onChange}
      />,
    );

    expect(screen.getByText('适配器预设')).toBeDefined();
    expect(screen.getByText('生成')).toBeDefined();
    expect(screen.getByText('区域编辑')).toBeDefined();

    const [adapterSelect, authSelect] = screen.getAllByRole('combobox');
    await user.click(adapterSelect);
    await user.click(await screen.findByText('自动识别', {
      selector: '.ant-select-item-option-content',
    }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ adapter_id: null }));

    await user.click(screen.getByText('区域编辑'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      operation_overrides: ['mask_edit'],
    }));

    await user.click(authSelect);
    await user.click(await screen.findByText('无认证', {
      selector: '.ant-select-item-option-content',
    }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ auth_mode: 'none' }));
  });

  it('explains the automatic xAI profile for custom grok image models', () => {
    render(
      <ImageProtocolEditor
        value={null}
        providerType="custom"
        modelId="grok-imagine-image"
        onChange={() => {}}
      />,
    );

    expect(
      screen.getByText('当前模型默认识别为 xAI Images，可在下方显式覆盖。'),
    ).toBeDefined();
  });

  it('persists only structured JSON objects', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ImageProtocolEditor
        value={{ adapter_id: 'generic_json' }}
        providerType="custom"
        modelId="custom-image"
        onChange={onChange}
      />,
    );
    const textareas = container.querySelectorAll('textarea');
    const extraBody = textareas[0];
    const mapping = textareas[1];

    fireEvent.change(extraBody, { target: { value: '{"seed":42}' } });
    fireEvent.blur(extraBody);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      extra_body: { seed: 42 },
    }));

    fireEvent.change(mapping, { target: { value: '["scripts are not allowed"]' } });
    fireEvent.blur(mapping);
    expect(screen.getByText('图片协议 JSON 无效')).toBeDefined();
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.change(mapping, { target: { value: '{' } });
    fireEvent.blur(mapping);
    expect(screen.queryByText(/SyntaxError/)).toBeNull();
  });
});
