import { useState, useRef } from 'react';
import { Modal, Input, Avatar, Dropdown, theme } from 'antd';
import type { MenuProps } from 'antd';
import { User, FileImage, Link, Smile } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUserProfileStore } from '@/stores/userProfileStore';
import type { AvatarType } from '@/stores/userProfileStore';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';

interface UserProfileModalProps {
  open: boolean;
  onClose: () => void;
}

const EMOJI_PICKS = [
  '😀', '😎', '🤖', '👨‍💻', '👩‍💻', '🦊', '🐱', '🐶',
  '🦄', '🐼', '🦁', '🐯', '🐸', '🐵', '🐰', '🐲',
  '🌟', '🔥', '💎', '🚀', '🎯', '🎨', '🎵', '🌈',
];

export function UserProfileModal({ open, onClose }: UserProfileModalProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const profile = useUserProfileStore((s) => s.profile);
  const updateProfile = useUserProfileStore((s) => s.updateProfile);
  const saveAvatarFile = useUserProfileStore((s) => s.saveAvatarFile);

  const [name, setName] = useState(profile.name);
  const [avatarType, setAvatarType] = useState<AvatarType>(profile.avatarType);
  const [avatarValue, setAvatarValue] = useState(profile.avatarValue);
  const [urlInput, setUrlInput] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resolvedAvatarSrc = useResolvedAvatarSrc(avatarType, avatarValue);

  const handleSave = () => {
    updateProfile({ name: name.trim(), avatarType, avatarValue });
    onClose();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = reader.result as string;
      saveAvatarFile(dataUri)
        .then(() => {
          const stored = useUserProfileStore.getState().profile;
          setAvatarType(stored.avatarType);
          setAvatarValue(stored.avatarValue);
        })
        .catch(() => {
          // Fallback: store data URI directly
          setAvatarType('file');
          setAvatarValue(dataUri);
        });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleUrlConfirm = () => {
    if (urlInput.trim()) {
      setAvatarType('url');
      setAvatarValue(urlInput.trim());
      setShowUrlInput(false);
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    setAvatarType('emoji');
    setAvatarValue(emoji);
    setShowEmojiPicker(false);
  };

  const avatarMenuItems: MenuProps['items'] = [
    {
      key: 'file',
      icon: <FileImage size={14} />,
      label: t('userProfile.selectImage'),
      onClick: () => fileInputRef.current?.click(),
    },
    {
      key: 'url',
      icon: <Link size={14} />,
      label: t('userProfile.imageUrl'),
      onClick: () => {
        setShowUrlInput(true);
        setShowEmojiPicker(false);
      },
    },
    {
      key: 'emoji',
      icon: <Smile size={14} />,
      label: t('userProfile.emoji'),
      onClick: () => {
        setShowEmojiPicker(true);
        setShowUrlInput(false);
      },
    },
  ];

  const renderAvatar = () => {
    const size = 72;
    if (avatarType === 'emoji' && avatarValue) {
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
            fontSize: 36,
            cursor: 'pointer',
          }}
        >
          {avatarValue}
        </div>
      );
    }
    if ((avatarType === 'url' || avatarType === 'file') && avatarValue) {
      const src = avatarType === 'file' ? resolvedAvatarSrc : avatarValue;
      return (
        <Avatar
          size={size}
          src={src}
          style={{ cursor: 'pointer' }}
        />
      );
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
    <Modal
      open={open}
      onCancel={onClose}
      mask={{ enabled: true, blur: true }}
      onOk={handleSave}
      title={t('userProfile.title')}
      width={400}
      destroyOnHidden
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '16px 0' }}>
        {/* Avatar with dropdown */}
        <Dropdown
          menu={{ items: avatarMenuItems }}
          trigger={['click']}
          placement="bottom"
        >
          {renderAvatar()}
        </Dropdown>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />

        {/* URL input */}
        {showUrlInput && (
          <Input
            placeholder={t('userProfile.urlPlaceholder')}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onPressEnter={handleUrlConfirm}
            addonAfter={
              <span style={{ cursor: 'pointer' }} onClick={handleUrlConfirm}>
                OK
              </span>
            }
            size="small"
            style={{ maxWidth: 280 }}
          />
        )}

        {/* Emoji picker */}
        {showEmojiPicker && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(8, 1fr)',
              gap: 4,
              padding: 8,
              borderRadius: token.borderRadius,
              backgroundColor: token.colorFillQuaternary,
              maxWidth: 280,
            }}
          >
            {EMOJI_PICKS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => handleEmojiSelect(emoji)}
                style={{
                  width: 32,
                  height: 32,
                  fontSize: 18,
                  border: 'none',
                  borderRadius: token.borderRadiusSM,
                  backgroundColor: avatarValue === emoji ? token.colorPrimaryBg : 'transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {/* Name input */}
        <Input
          placeholder={t('userProfile.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ maxWidth: 280 }}
        />
      </div>
    </Modal>
  );
}
