import { Drawer } from 'antd';
import type { Message } from '@/types';
import { useTranslation } from 'react-i18next';
import { MultiModelVersionContent } from './MultiModelDisplay';

export function MultiModelAnswerFocusLayer({
  open,
  message,
  isVersionStreaming,
  getContainer,
  renderContent,
  onClose,
}: {
  open: boolean;
  message: Message | null;
  isVersionStreaming: boolean;
  getContainer: () => HTMLElement | null;
  renderContent: (msg: Message, isVersionStreaming: boolean) => React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Drawer
      open={open}
      getContainer={() => getContainer() ?? document.body}
      rootStyle={{ position: 'absolute' }}
      size="100%"
      mask={false}
      keyboard
      destroyOnHidden
      title={t('chat.multiModel.focusAnswer')}
      extra={null}
      onClose={onClose}
      aria-label={t('chat.multiModel.focusLayerLabel')}
      styles={{
        wrapper: { boxShadow: 'none' },
        body: { padding: 16, overflow: 'auto' },
      }}
    >
      {message ? (
        <MultiModelVersionContent
          message={message}
          isVersionStreaming={isVersionStreaming}
          renderContent={renderContent}
        />
      ) : null}
    </Drawer>
  );
}
