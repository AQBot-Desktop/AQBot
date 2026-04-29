import { useState } from 'react';
import { Tooltip, Avatar, theme } from 'antd';
import { MessageSquare, BookOpen, Brain, Router, FolderOpen, User, Sparkles, ImagePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore, useSettingsStore } from '@/stores';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { getShortcutBinding, formatShortcutForDisplay } from '@/lib/shortcuts';
import type { ShortcutAction } from '@/lib/shortcuts';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import { UserProfileModal } from './UserProfileModal';
import type { PageKey } from '@/types';

const mainNavItems: { key: PageKey; icon: React.ReactNode; labelKey: string }[] = [
  { key: 'chat', icon: <MessageSquare size={18} />, labelKey: 'nav.chat' },
  { key: 'drawing', icon: <ImagePlus size={18} />, labelKey: 'nav.drawing' },
  { key: 'skills', icon: <Sparkles size={18} />, labelKey: 'nav.skills' },
  { key: 'knowledge', icon: <BookOpen size={18} />, labelKey: 'nav.knowledge' },
  { key: 'memory', icon: <Brain size={18} />, labelKey: 'nav.memory' },
  { key: 'gateway', icon: <Router size={18} />, labelKey: 'nav.gateway' },
  { key: 'files', icon: <FolderOpen size={18} />, labelKey: 'nav.files' },
];

export function Sidebar() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const activePage = useUIStore((s) => s.activePage);
  const setActivePage = useUIStore((s) => s.setActivePage);
  const profile = useUserProfileStore((s) => s.profile);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const resolvedAvatarSrc = useResolvedAvatarSrc(profile.avatarType, profile.avatarValue);
  const settings = useSettingsStore((s) => s.settings);

  const NAV_SHORTCUT_MAP: Partial<Record<PageKey, ShortcutAction>> = {
    gateway: 'toggleGateway',
  };

  const renderNavButton = (item: { key: PageKey; icon: React.ReactNode; labelKey: string }) => {
    const isActive = activePage === item.key;
    const label = t(item.labelKey);
    const action = NAV_SHORTCUT_MAP[item.key];
    const title = action
      ? `${label} (${formatShortcutForDisplay(getShortcutBinding(settings, action))})`
      : label;
    return (
      <Tooltip key={item.key} title={title} placement="right">
        <button
          onClick={() => setActivePage(item.key)}
          className="flex items-center justify-center text-base transition-colors"
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            backgroundColor: isActive ? token.colorPrimaryBg : 'transparent',
            color: isActive ? token.colorPrimary : token.colorTextSecondary,
          }}
          onMouseEnter={(e) => {
            if (!isActive) {
              e.currentTarget.style.backgroundColor = token.colorFillSecondary;
              e.currentTarget.style.color = token.colorTextBase;
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = token.colorTextSecondary;
            }
          }}
        >
          {item.icon}
        </button>
      </Tooltip>
    );
  };

  const renderUserAvatar = () => {
    const size = 32;
    if (profile.avatarType === 'emoji' && profile.avatarValue) {
      return (
        <div
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            backgroundColor: token.colorFillSecondary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          {profile.avatarValue}
        </div>
      );
    }
    if ((profile.avatarType === 'url' || profile.avatarType === 'file') && profile.avatarValue) {
      const src = profile.avatarType === 'file' ? resolvedAvatarSrc : profile.avatarValue;
      return <Avatar size={size} src={src} style={{ cursor: 'pointer' }} />;
    }
    return (
      <Avatar
        size={size}
        icon={<User size={16} />}
        style={{ cursor: 'pointer', backgroundColor: token.colorPrimary }}
      />
    );
  };

  return (
    <div className="flex flex-col items-center h-full" style={{ paddingTop: 8, paddingBottom: 12 }}>
      <nav className="flex flex-col gap-2">
        {mainNavItems.map(renderNavButton)}
      </nav>

      <div className="flex-1" />

      {/* User Avatar */}
      <Tooltip title={profile.name || t('userProfile.title')} placement="right">
        <button
          onClick={() => setProfileModalOpen(true)}
          style={{ background: 'none', border: 'none', padding: 0 }}
        >
          {renderUserAvatar()}
        </button>
      </Tooltip>

      <UserProfileModal open={profileModalOpen} onClose={() => setProfileModalOpen(false)} />
    </div>
  );
}
