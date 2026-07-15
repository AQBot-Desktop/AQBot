import { Activity, memo, useLayoutEffect, useState, type ReactNode } from 'react';
import type { PageKey } from '@/types';
import { beginPageRender, recordPageCommit } from '@/lib/performanceInstrumentation';
import { ChatPage } from '@/pages/ChatPage';
import { DrawingPage } from '@/pages/DrawingPage';
import { KnowledgePage } from '@/pages/KnowledgePage';
import { MemoryPage } from '@/pages/MemoryPage';
import { GatewayPage } from '@/pages/GatewayPage';
import { FilesPage } from '@/pages/FilesPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { SkillsPage } from '@/pages/SkillsPage';
import { RolesPage } from '@/pages/RolesPage';
import {
  PageLifecycleProvider,
  type PageCachePolicy,
} from '@/components/layout/PageLifecycle';

interface ContentAreaProps {
  activePage: PageKey;
}

const PAGE_CACHE_POLICIES: Record<PageKey, PageCachePolicy> = {
  chat: 'activity',
  drawing: 'activity',
  knowledge: 'unmount',
  memory: 'unmount',
  gateway: 'unmount',
  files: 'unmount',
  settings: 'unmount',
  skills: 'unmount',
  roles: 'unmount',
};

type CachedPageKey = 'chat' | 'drawing';
const ActivityChatPage = memo(ChatPage);
const ActivityDrawingPage = memo(DrawingPage);

function isCachedPage(page: PageKey): page is CachedPageKey {
  return PAGE_CACHE_POLICIES[page] === 'activity';
}

function PageCommitMarker({
  page,
  renderStartedAt,
}: {
  page: PageKey;
  renderStartedAt: number | null;
}) {
  useLayoutEffect(() => {
    recordPageCommit(page, renderStartedAt);
  }, [page, renderStartedAt]);
  return null;
}

function renderUnmountedPage(activePage: PageKey): ReactNode {
  switch (activePage) {
    case 'knowledge':
      return <KnowledgePage />;
    case 'memory':
      return <MemoryPage />;
    case 'gateway':
      return <GatewayPage />;
    case 'files':
      return <FilesPage />;
    case 'settings':
      return <SettingsPage />;
    case 'skills':
      return <SkillsPage />;
    case 'roles':
      return <RolesPage />;
    case 'chat':
    case 'drawing':
      return null;
    default: {
      const _exhaustive: never = activePage;
      throw new Error(`Unhandled page key: ${_exhaustive}`);
    }
  }
}

interface CachedPageProps {
  active: boolean;
  page: CachedPageKey;
  children: ReactNode;
}

function CachedPage({ active, page, children }: CachedPageProps) {
  return (
    <PageLifecycleProvider active={active}>
      <div
        data-page-scroll-scope={page}
        data-page-active={active ? 'true' : 'false'}
        style={{ display: 'contents' }}
      >
        <Activity mode={active ? 'visible' : 'hidden'}>{children}</Activity>
      </div>
    </PageLifecycleProvider>
  );
}

export function ContentArea({ activePage }: ContentAreaProps) {
  const renderStartedAt = beginPageRender();
  const [visitedCachedPages, setVisitedCachedPages] = useState<Set<CachedPageKey>>(
    () => new Set(isCachedPage(activePage) ? [activePage] : []),
  );

  if (isCachedPage(activePage) && !visitedCachedPages.has(activePage)) {
    // A same-component render update is applied before commit, so the page is
    // mounted once on first visit without a blank frame or an effect-driven remount.
    setVisitedCachedPages((current) => new Set(current).add(activePage));
  }

  return (
    <>
      {visitedCachedPages.has('chat') && (
        <CachedPage key="chat" active={activePage === 'chat'} page="chat">
          <ActivityChatPage />
        </CachedPage>
      )}
      {visitedCachedPages.has('drawing') && (
        <CachedPage key="drawing" active={activePage === 'drawing'} page="drawing">
          <ActivityDrawingPage />
        </CachedPage>
      )}
      {!isCachedPage(activePage) && (
        <div
          className="h-full min-w-0"
          data-page-scroll-scope={activePage}
          data-page-active="true"
        >
          {renderUnmountedPage(activePage)}
        </div>
      )}
      <PageCommitMarker page={activePage} renderStartedAt={renderStartedAt} />
    </>
  );
}
