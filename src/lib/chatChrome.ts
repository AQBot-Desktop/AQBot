import { createContext, useContext } from 'react';

export interface ChatChrome {
  kind: 'main' | 'popout';
}

const DEFAULT_CHROME: ChatChrome = { kind: 'main' };

export const ChatChromeContext = createContext<ChatChrome>(DEFAULT_CHROME);

export function useChatChrome(): ChatChrome {
  return useContext(ChatChromeContext);
}