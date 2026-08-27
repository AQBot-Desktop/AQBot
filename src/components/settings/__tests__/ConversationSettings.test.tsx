import type React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@/types';
import { ConversationSettings } from '../ConversationSettings';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
}));

let settings: Partial<AppSettings> = {};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const labels: Record<string, string> = {
        'settings.additionalFeatures': '附加功能',
        'settings.chatFontFamily': '对话字体',
        'settings.chatFontSize': '对话字号',
        'settings.chatFontWeight': '对话字重',
        'settings.chatInput': '输入框',
        'settings.chatInputActionsScale': '底部操作区缩放',
        'settings.chatMessageAreaStyle': '消息区域背景边框',
        'settings.chatMessageAreaStyleDesc': '分别控制用户消息和 AI 消息的背景色或边框。',
        'settings.messageAreaStyleNone': '关闭',
        'settings.messageAreaStyleBackground': '背景色',
        'settings.messageAreaStyleBorder': '边框',
        'settings.chatUserMessageAreaStyle': '用户消息样式',
        'settings.chatUserMessageAreaLightColor': '用户消息日光颜色',
        'settings.chatUserMessageAreaDarkColor': '用户消息暗黑颜色',
        'settings.chatUserMessageAreaBorderWidth': '用户消息边框粗细',
        'settings.chatAiMessageAreaStyle': 'AI 消息样式',
        'settings.chatAiMessageAreaLightColor': 'AI 消息日光颜色',
        'settings.chatAiMessageAreaDarkColor': 'AI 消息暗黑颜色',
        'settings.chatAiMessageAreaBorderWidth': 'AI 消息边框粗细',
        'settings.chatLineHeight': '对话行高',
        'settings.chatMinimap': '对话导航',
        'settings.newConversationDefaults': '新建对话',
        'settings.inheritConversationPreferencesOnCreate': '继承当前对话能力配置',
        'settings.inheritConversationPreferencesOnCreateDesc': '开启后，新建对话会沿用当前对话的联网、知识库、记忆、工具、思考设置，以及多模型选择与续问方式。',
        'settings.chatStreamTimeouts': '流式响应超时',
        'settings.chatStreamTimeoutsDesc': '设置模型流式响应的首包和空闲等待时间，填 0 表示不限制。',
        'settings.chatStreamFirstPacketTimeout': '首包超时',
        'settings.chatStreamIdleTimeout': '空闲超时',
        'settings.mcpToolLoopMaxIterations': 'MCP 工具调用最大轮次',
        'settings.mcpToolLoopMaxIterationsDesc': '限制单次回复中模型连续调用 MCP 工具的最大轮次，数值过高会增加耗时、Token 与工具执行成本。',
        'settings.chatSidebar': '左侧对话栏',
        'settings.chatSidebarCollapsed': '左侧对话栏默认折叠',
        'settings.chatSidebarCollapsedDesc': '开启后，对话页左侧对话栏会默认收起，聊天区域获得更多横向空间。',
        'settings.conversationTabs': '顶部会话标签',
        'settings.conversationTabsEnabled': '显示顶部会话标签',
        'settings.conversationTabsEnabledDesc': '开启后，聊天页顶部导航栏会显示最近打开的会话标签，便于在侧栏收起时快速切换。',
        'settings.documentAttachmentReading': '读取文档附件',
        'settings.documentAttachmentReadingDesc': '开启后，PDF、DOC、DOCX 附件会解析为文本并发送给模型，不会加入知识库。',
        'settings.showImageModelsInModelSelector': '模型选择器中显示绘画模型',
        'settings.codeFontFamily': '代码字体',
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
        'settings.groupMessageStyle': '消息样式',
        'settings.contextCompression': '上下文压缩',
        'settings.contextCompressionGroupDesc': '控制对话过长时如何压缩历史上下文。',
        'settings.contextStrategy': '上下文策略',
        'settings.contextStrategyTooltip': '选择上下文处理方式',
        'settings.contextStrategySmartSummary': '智能摘要',
        'settings.contextStrategyRawTruncate': '仅原文截断',
        'settings.contextStrategyRawStrict': '严格原文',
        'settings.compressionKeepLastN': '压缩时保留最近消息数',
        'settings.compressionKeepLastNTooltip': '保留最近 N 条不压入摘要',
        'settings.compressionKeepLastNHint': '此为全局默认',
        'settings.agentSettings': 'Agent',
        'settings.agentWorkspaceRoot': '默认工作目录',
        'settings.agentWorkspaceRootDesc': '新 Agent 对话会在该目录下自动创建独立工作目录。留空时使用 ~/.aqbot/workspace。',
        'settings.agentWorkspaceRootPlaceholder': '留空使用默认目录',
        'settings.selectAgentWorkspaceRoot': '选择默认工作目录',
        'settings.agentWorkspaceNameStrategy': '目录命名格式',
        'settings.agentWorkspaceNameStrategyUuid': 'UUID',
        'settings.agentWorkspaceNameStrategyConversationId': '对话 ID',
        'settings.agentWorkspaceNameStrategyCreatedTimestamp': '创建时间戳',
        'settings.agentWorkspaceNameStrategyCreatedDatetime': '格式化创建时间',
        'settings.agentWorkspaceDatetimeFormat': '时间命名格式',
        'settings.agentWorkspaceDatetimeFormatDesc': '支持 YYYY、MM、DD、HH、mm、ss；非法文件名字符会自动替换为 -。',
        'settings.agentWorkspacePreview': '预览：2023-11-14-22-13-20',
        'settings.resetAgentWorkspaceRoot': '重置默认目录',
        'settings.multiModelDisplayMode': '默认多模型布局',
        'settings.multiModelDisplayModeDesc': '新会话以及选择“跟随全局”的会话，后续多模型回答使用此布局。',
        'settings.multiModelDisplayModeTabs': '标签切换',
        'settings.multiModelDisplayModeSideBySide': '并排对比',
        'settings.multiModelDisplayModeStacked': '上下堆叠',
        'settings.multiModelExecutionMode': '多模型执行方式',
        'settings.multiModelExecutionModeDesc': '控制同一轮多个模型是同时回答，还是按会话中保存的顺序逐个回答。',
        'settings.multiModelExecutionModeParallel': '并行',
        'settings.multiModelExecutionModeSequential': '顺序',
        'settings.multiModelSequentialInterval': '模型间隔（秒）',
        'settings.multiModelSequentialIntervalDesc': '从上一个模型回答结束或中断后开始计时。0 表示结束后立即开始下一个。',
      };
      return labels[key] ?? fallback ?? key;
    },
  }),
}));

vi.mock('antd', () => {
  const Input = ({
    value,
    onChange,
    placeholder,
    'aria-label': ariaLabel,
  }: {
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    placeholder?: string;
    'aria-label'?: string;
  }) => (
    <input
      aria-label={ariaLabel ?? placeholder}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={onChange}
    />
  );
  Input.TextArea = ({
    value,
    onChange,
    placeholder,
  }: {
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
    placeholder?: string;
  }) => (
    <textarea
      placeholder={placeholder}
      value={value}
      onChange={onChange}
    />
  );

  return {
    Divider: () => <hr />,
    Input,
    Switch: ({
      checked,
      onChange,
    }: {
      checked?: boolean;
      onChange?: (checked: boolean) => void;
    }) => (
      <button
        aria-checked={checked}
        role="switch"
        type="button"
        onClick={() => onChange?.(!checked)}
      />
    ),
    ColorPicker: ({
      value,
      disabled,
      onChangeComplete,
      'aria-label': ariaLabel,
    }: {
      value?: string;
      disabled?: boolean;
      onChangeComplete?: (color: { toRgbString: () => string }) => void;
      'aria-label'?: string;
    }) => (
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        value={value ?? ''}
        onChange={(event) => onChangeComplete?.({ toRgbString: () => event.target.value })}
      />
    ),
    InputNumber: ({
      value,
      onChange,
      disabled,
      min,
      max,
      step,
      'aria-label': ariaLabel,
    }: {
      value?: number;
      onChange?: (value: number | null) => void;
      disabled?: boolean;
      min?: number;
      max?: number;
      step?: number;
      'aria-label'?: string;
    }) => (
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        type="number"
        value={value ?? ''}
        onChange={(event) => onChange?.(event.target.value === '' ? null : Number(event.target.value))}
      />
    ),
    Card: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
    Button: ({
      children,
      onClick,
      'aria-label': ariaLabel,
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
      'aria-label'?: string;
    }) => (
      <button aria-label={ariaLabel} type="button" onClick={onClick}>
        {children}
      </button>
    ),
    Dropdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Tooltip: ({ children }: { children?: React.ReactNode; title?: React.ReactNode }) => <>{children}</>,
    theme: {
      useToken: () => ({
        token: {
          colorBgBase: '#ffffff',
          colorBgContainer: '#ffffff',
          colorBorderSecondary: '#eeeeee',
          colorFillSecondary: '#f5f5f5',
          colorFillTertiary: '#fafafa',
          colorText: '#111111',
          colorTextDescription: '#666666',
          colorTextSecondary: '#444444',
        },
      }),
    },
  };
});

vi.mock('../SettingsSelect', () => ({
  SettingsSelect: ({
    value,
    onChange,
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
      onChange={(event) => onChange?.(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {typeof option.label === 'string' ? option.label : option.value}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('@/stores', () => ({
  useSettingsStore: (selector: (state: {
    settings: Partial<AppSettings>;
    saveSettings: typeof mocks.saveSettings;
  }) => unknown) => selector({
    settings,
    saveSettings: mocks.saveSettings,
  }),
}));

vi.mock('@/lib/invoke', () => ({
  isTauri: () => true,
  invoke: vi.fn().mockResolvedValue(['Inter', 'JetBrains Mono']),
}));

vi.mock('@/hooks/useSystemFonts', () => ({
  useSystemFonts: () => ['Inter', 'JetBrains Mono'],
}));

vi.mock('@/hooks/useSystemFontFaces', () => ({
  useSystemFontFaces: () => [],
}));

describe('ConversationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {
      bubble_style: 'minimal',
      chat_minimap_enabled: false,
      chat_minimap_style: 'faq',
      default_system_prompt: null,
      multi_model_display_mode: 'tabs',
      multi_model_execution_mode: 'parallel',
      multi_model_sequential_interval_seconds: 3,
      render_user_markdown: false,
      inherit_conversation_preferences_on_create: true,
      document_attachment_reading_enabled: false,
      show_image_models_in_model_selector: false,
      chat_stream_first_packet_timeout_secs: 180,
      chat_stream_idle_timeout_secs: 90,
      mcp_tool_loop_max_iterations: 100,
      chat_sidebar_collapsed: false,
      conversation_tabs_enabled: false,
      code_font_family: '',
      chat_font_size: 15,
      chat_line_height: 1.7,
      chat_font_family: '',
      chat_font_weight: 400,
      chat_font_style: 'normal',
      chat_input_actions_scale: 100,
      chat_user_message_area_style: 'none',
      chat_user_message_area_light_color: 'rgba(0, 0, 0, 0)',
      chat_user_message_area_dark_color: 'rgba(0, 0, 0, 0)',
      chat_user_message_area_border_width: 1,
      chat_ai_message_area_style: 'none',
      chat_ai_message_area_light_color: '#f5f5f5',
      chat_ai_message_area_dark_color: 'rgba(255, 255, 255, 0.06)',
      chat_ai_message_area_border_width: 1,
      agent_workspace_root: null,
      agent_workspace_name_strategy: 'uuid',
      agent_workspace_datetime_format: 'YYYY-MM-DD-HH-mm-ss',
      default_compression_keep_last_n: null,
      default_context_strategy: 'raw_truncate',
    };
  });

  it('saves default compression keep-last-n from conversation settings', async () => {
    render(<ConversationSettings />);

    const input = screen.getByLabelText('压缩时保留最近消息数');
    fireEvent.change(input, { target: { value: '5' } });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith({
        default_compression_keep_last_n: 5,
      });
    });
  });

  it('supports the full keep-last range and saves the global context strategy', async () => {
    render(<ConversationSettings />);

    const input = screen.getByLabelText('压缩时保留最近消息数');
    expect(input).toHaveAttribute('min', '0');
    expect(input).toHaveAttribute('max', '1000');
    fireEvent.change(input, { target: { value: '1000' } });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({
      default_compression_keep_last_n: 1000,
    });

    fireEvent.change(screen.getByDisplayValue('仅原文截断'), {
      target: { value: 'raw_strict' },
    });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({
      default_context_strategy: 'raw_strict',
    });
  });

  it('renders the additional features group below chat navigation', () => {
    render(<ConversationSettings />);

    const text = document.body.textContent ?? '';
    expect(text.indexOf('对话导航')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('附加功能')).toBeGreaterThan(text.indexOf('对话导航'));
    const additionalGroup = screen.getByText('附加功能').parentElement?.parentElement;
    const timeoutGroup = screen.getByText('流式响应超时').parentElement?.parentElement;
    expect(additionalGroup).not.toBeNull();
    expect(timeoutGroup).not.toBeNull();
    expect(screen.getByText('模型选择器中显示绘画模型')).toBeInTheDocument();
    expect(screen.getByText('读取文档附件')).toBeInTheDocument();
    expect(screen.getByText('开启后，PDF、DOC、DOCX 附件会解析为文本并发送给模型，不会加入知识库。')).toBeInTheDocument();
    expect(within(additionalGroup as HTMLElement).getByText('MCP 工具调用最大轮次')).toBeInTheDocument();
    expect(within(timeoutGroup as HTMLElement).queryByText('MCP 工具调用最大轮次')).not.toBeInTheDocument();
  });

  it('renders chat typography controls in conversation message style', () => {
    render(<ConversationSettings />);

    const messageStyleGroup = screen.getByText('消息样式').parentElement?.parentElement;
    expect(messageStyleGroup).not.toBeNull();
    expect(within(messageStyleGroup as HTMLElement).getByText('对话字号')).toBeInTheDocument();
    expect(within(messageStyleGroup as HTMLElement).getByText('对话行高')).toBeInTheDocument();
    expect(within(messageStyleGroup as HTMLElement).getByText('对话字体')).toBeInTheDocument();
    expect(within(messageStyleGroup as HTMLElement).getByLabelText('对话字重')).toBeInTheDocument();
    expect(within(messageStyleGroup as HTMLElement).getByText('代码字体')).toBeInTheDocument();
  });

  it('saves a normalized chat input actions scale', () => {
    render(<ConversationSettings />);

    const input = screen.getByLabelText('底部操作区缩放');
    expect(input).toHaveValue(100);
    expect(input).toHaveAttribute('min', '50');
    expect(input).toHaveAttribute('max', '150');
    expect(input).toHaveAttribute('step', '10');

    fireEvent.change(input, { target: { value: '44' } });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ chat_input_actions_scale: 50 });

    fireEvent.change(input, { target: { value: '137' } });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ chat_input_actions_scale: 140 });

    fireEvent.change(input, { target: { value: '160' } });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ chat_input_actions_scale: 150 });

    fireEvent.change(input, { target: { value: '' } });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ chat_input_actions_scale: 100 });
  });

  it('saves separate user and ai message area style settings', () => {
    const { rerender } = render(<ConversationSettings />);

    const text = document.body.textContent ?? '';
    expect(text.indexOf('消息区域背景边框')).toBeGreaterThan(text.indexOf('消息样式'));
    const areaGroup = screen.getByText('消息区域背景边框').parentElement?.parentElement as HTMLElement;
    expect(within(areaGroup).getByText('分别控制用户消息和 AI 消息的背景色或边框。')).toBeInTheDocument();
    expect(within(areaGroup).getByText('用户消息样式')).toBeInTheDocument();
    expect(within(areaGroup).getByText('AI 消息样式')).toBeInTheDocument();
    expect(screen.getByLabelText('用户消息日光颜色')).toHaveValue('rgba(0, 0, 0, 0)');
    expect(screen.getByLabelText('用户消息暗黑颜色')).toHaveValue('rgba(0, 0, 0, 0)');
    expect(screen.getByLabelText('AI 消息日光颜色')).toHaveValue('#f5f5f5');
    expect(screen.getByLabelText('AI 消息暗黑颜色')).toHaveValue('rgba(255, 255, 255, 0.06)');
    expect(screen.getByLabelText('用户消息日光颜色')).toBeDisabled();
    expect(screen.getByLabelText('用户消息暗黑颜色')).toBeDisabled();
    expect(screen.getByLabelText('AI 消息日光颜色')).toBeDisabled();
    expect(screen.getByLabelText('AI 消息暗黑颜色')).toBeDisabled();
    expect(screen.getByLabelText('用户消息边框粗细')).toBeDisabled();
    expect(screen.getByLabelText('AI 消息边框粗细')).toBeDisabled();

    const [userStyleSelect, aiStyleSelect] = within(areaGroup).getAllByRole('combobox');
    expect(userStyleSelect).toHaveValue('none');
    expect(aiStyleSelect).toHaveValue('none');
    fireEvent.change(userStyleSelect, { target: { value: 'border' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_user_message_area_style: 'border' });
    fireEvent.change(aiStyleSelect, { target: { value: 'background' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_ai_message_area_style: 'background' });

    settings = {
      ...settings,
      chat_user_message_area_style: 'none',
      chat_ai_message_area_style: 'none',
    };
    rerender(<ConversationSettings />);

    expect(screen.getByLabelText('用户消息日光颜色')).toBeDisabled();
    expect(screen.getByLabelText('用户消息暗黑颜色')).toBeDisabled();
    expect(screen.getByLabelText('用户消息边框粗细')).toBeDisabled();
    expect(screen.getByLabelText('AI 消息日光颜色')).toBeDisabled();
    expect(screen.getByLabelText('AI 消息暗黑颜色')).toBeDisabled();
    expect(screen.getByLabelText('AI 消息边框粗细')).toBeDisabled();

    const noneAreaGroup = screen.getByText('消息区域背景边框').parentElement?.parentElement as HTMLElement;
    const [userNoneStyleSelect] = within(noneAreaGroup).getAllByRole('combobox');
    fireEvent.change(userNoneStyleSelect, { target: { value: 'background' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_user_message_area_style: 'background' });

    settings = {
      ...settings,
      chat_user_message_area_style: 'border',
      chat_ai_message_area_style: 'border',
    };
    rerender(<ConversationSettings />);
    expect(screen.getByLabelText('用户消息边框粗细')).not.toBeDisabled();
    expect(screen.getByLabelText('AI 消息边框粗细')).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText('用户消息日光颜色'), { target: { value: 'rgba(1, 2, 3, 0.4)' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_user_message_area_light_color: 'rgba(1, 2, 3, 0.4)' });

    fireEvent.change(screen.getByLabelText('用户消息边框粗细'), { target: { value: '8' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_user_message_area_border_width: 4 });

    fireEvent.change(screen.getByLabelText('AI 消息暗黑颜色'), { target: { value: 'rgba(4, 5, 6, 0.5)' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_ai_message_area_dark_color: 'rgba(4, 5, 6, 0.5)' });

    fireEvent.change(screen.getByLabelText('AI 消息边框粗细'), { target: { value: '0' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_ai_message_area_border_width: 1 });
  });

  it('saves normalized chat typography settings', () => {
    render(<ConversationSettings />);

    fireEvent.change(screen.getByLabelText('对话字号'), { target: { value: '28' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_font_size: 22 });

    fireEvent.change(screen.getByLabelText('对话行高'), { target: { value: '1.05' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ chat_line_height: 1.3 });

    fireEvent.change(screen.getByLabelText('对话字重'), {
      target: { value: 'bold@@700@@normal' },
    });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      chat_font_family: '',
      chat_font_weight: 700,
      chat_font_style: 'normal',
    });
  });

  it('saves chat and code font family settings from conversation settings', async () => {
    settings = {
      ...settings,
      chat_font_family: '',
      code_font_family: '',
    };

    render(<ConversationSettings />);

    await waitFor(() => expect(screen.getAllByRole('combobox').filter((select) =>
      select.textContent?.includes('Inter'))).toHaveLength(2));
    const fontSelects = screen.getAllByRole('combobox').filter((select) =>
      select.textContent?.includes('Inter'));
    fireEvent.change(fontSelects[0], { target: { value: 'Inter' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      chat_font_family: 'Inter',
      chat_font_weight: 400,
      chat_font_style: 'normal',
    });

    fireEvent.change(fontSelects[1], { target: { value: 'JetBrains Mono' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ code_font_family: 'JetBrains Mono' });
  });

  it('saves the document attachment reading setting when toggled', () => {
    render(<ConversationSettings />);

    const additionalGroup = screen.getByText('附加功能').parentElement?.parentElement;
    expect(additionalGroup).not.toBeNull();
    const toggles = within(additionalGroup as HTMLElement).getAllByRole('switch');

    fireEvent.click(toggles[0]);

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      document_attachment_reading_enabled: true,
    });
  });

  it('saves the image-model selector setting when toggled', () => {
    render(<ConversationSettings />);

    const additionalGroup = screen.getByText('附加功能').parentElement?.parentElement;
    expect(additionalGroup).not.toBeNull();
    const toggles = within(additionalGroup as HTMLElement).getAllByRole('switch');

    fireEvent.click(toggles[1]);

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      show_image_models_in_model_selector: true,
    });
  });

  it('saves the disabled image-model selector setting when toggled off', () => {
    settings = {
      ...settings,
      show_image_models_in_model_selector: true,
    };

    render(<ConversationSettings />);

    const additionalGroup = screen.getByText('附加功能').parentElement?.parentElement;
    expect(additionalGroup).not.toBeNull();
    const toggles = within(additionalGroup as HTMLElement).getAllByRole('switch');

    fireEvent.click(toggles[1]);

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      show_image_models_in_model_selector: false,
    });
  });

  it('saves stream timeout settings from conversation settings', () => {
    render(<ConversationSettings />);

    expect(screen.getByText('流式响应超时')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('首包超时'), { target: { value: '45' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      chat_stream_first_packet_timeout_secs: 45,
    });

    fireEvent.change(screen.getByLabelText('空闲超时'), { target: { value: '0' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      chat_stream_idle_timeout_secs: 0,
    });
  });

  it('saves MCP tool loop iteration settings from conversation settings', () => {
    render(<ConversationSettings />);

    expect(screen.getByText('MCP 工具调用最大轮次')).toBeInTheDocument();
    expect(screen.getByText('限制单次回复中模型连续调用 MCP 工具的最大轮次，数值过高会增加耗时、Token 与工具执行成本。')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('MCP 工具调用最大轮次'), { target: { value: '25' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      mcp_tool_loop_max_iterations: 25,
    });

    fireEvent.change(screen.getByLabelText('MCP 工具调用最大轮次'), { target: { value: '' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      mcp_tool_loop_max_iterations: 100,
    });

    fireEvent.change(screen.getByLabelText('MCP 工具调用最大轮次'), { target: { value: '1000' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      mcp_tool_loop_max_iterations: 100,
    });
  });

  it('saves the chat sidebar collapsed setting when toggled', () => {
    render(<ConversationSettings />);

    const sidebarGroup = screen.getByText('左侧对话栏').parentElement?.parentElement;
    expect(sidebarGroup).not.toBeNull();
    const toggle = within(sidebarGroup as HTMLElement).getByRole('switch');

    fireEvent.click(toggle);

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      chat_sidebar_collapsed: true,
    });
  });

  it('saves the conversation tabs title-bar setting when toggled', () => {
    render(<ConversationSettings />);

    const tabsGroup = screen.getByText('顶部会话标签').parentElement?.parentElement;
    expect(tabsGroup).not.toBeNull();
    const toggle = within(tabsGroup as HTMLElement).getByRole('switch');

    expect(screen.getByText('显示顶部会话标签')).toBeInTheDocument();
    expect(screen.getByText('开启后，聊天页顶部导航栏会显示最近打开的会话标签，便于在侧栏收起时快速切换。')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      conversation_tabs_enabled: true,
    });
  });

  it('saves the new-conversation inheritance setting when toggled', () => {
    render(<ConversationSettings />);

    const inheritanceGroup = screen.getByText('新建对话').parentElement?.parentElement;
    expect(inheritanceGroup).not.toBeNull();
    const toggle = within(inheritanceGroup as HTMLElement).getByRole('switch');

    expect(screen.getByText('继承当前对话能力配置')).toBeInTheDocument();
    expect(screen.getByText('开启后，新建对话会沿用当前对话的联网、知识库、记忆、工具、思考设置，以及多模型选择与续问方式。')).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      inherit_conversation_preferences_on_create: false,
    });
  });

  it('saves agent workspace defaults from conversation settings', () => {
    render(<ConversationSettings />);

    const agentGroup = screen.getByText('Agent').parentElement?.parentElement;
    expect(agentGroup).not.toBeNull();
    expect(within(agentGroup as HTMLElement).getByText('默认工作目录')).toBeInTheDocument();
    expect(within(agentGroup as HTMLElement).getByText('目录命名格式')).toBeInTheDocument();
    expect(within(agentGroup as HTMLElement).getByText('预览：2023-11-14-22-13-20')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('默认工作目录'), { target: { value: '/tmp/aqbot-agents' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      agent_workspace_root: '/tmp/aqbot-agents',
    });

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[selects.length - 1], { target: { value: 'created_timestamp' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      agent_workspace_name_strategy: 'created_timestamp',
    });

    fireEvent.change(screen.getByLabelText('时间命名格式'), { target: { value: 'YYYY-MM-DD-HH:mm:ss' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      agent_workspace_datetime_format: 'YYYY-MM-DD-HH:mm:ss',
    });

    fireEvent.click(screen.getByRole('button', { name: '重置默认目录' }));
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      agent_workspace_root: null,
    });
  });

  it('saves multi-model execution mode and keeps interval while parallel is selected', () => {
    render(<ConversationSettings />);

    expect(screen.getByText('多模型执行方式')).toBeInTheDocument();
    const interval = screen.getByLabelText('模型间隔（秒）');
    expect(interval).toBeDisabled();
    expect(interval).toHaveValue(3);

    const executionSelect = screen.getAllByRole('combobox').find((el) =>
      Array.from(el.querySelectorAll('option')).some((option) => option.getAttribute('value') === 'sequential'),
    );
    expect(executionSelect).toBeDefined();
    fireEvent.change(executionSelect as HTMLElement, { target: { value: 'sequential' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({ multi_model_execution_mode: 'sequential' });
  });

  it('saves a clamped sequential interval when sequential mode is active', () => {
    settings = {
      ...settings,
      multi_model_execution_mode: 'sequential',
      multi_model_sequential_interval_seconds: 3,
    };
    render(<ConversationSettings />);

    const interval = screen.getByLabelText('模型间隔（秒）');
    expect(interval).toBeEnabled();
    fireEvent.change(interval, { target: { value: '301' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      multi_model_sequential_interval_seconds: 300,
    });
    fireEvent.change(interval, { target: { value: '0' } });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      multi_model_sequential_interval_seconds: 0,
    });
  });
});
