/**
 * ChannelIcon Component
 * Unified channel logo rendering across the application
 */
import { CHANNEL_ICONS, type ChannelType } from '@/types/channel';
import telegramIcon from '@/assets/channels/telegram.svg';
import discordIcon from '@/assets/channels/discord.svg';
import whatsappIcon from '@/assets/channels/whatsapp.svg';
import wechatIcon from '@/assets/channels/wechat.svg';
import dingtalkIcon from '@/assets/channels/dingtalk.svg';
import feishuIcon from '@/assets/channels/feishu.svg';
import wecomIcon from '@/assets/channels/wecom.svg';
import qqIcon from '@/assets/channels/qq.svg';

export type ChannelIconSize = 'sm' | 'md' | 'lg';

const SIZE_MAP: Record<ChannelIconSize, string> = {
  sm: 'w-[18px] h-[18px]',
  md: 'w-[20px] h-[20px]',
  lg: 'w-[22px] h-[22px]',
};

const TEXT_SIZE_MAP: Record<ChannelIconSize, string> = {
  sm: 'text-[18px]',
  md: 'text-[20px]',
  lg: 'text-[22px]',
};

interface ChannelIconProps {
  type: ChannelType;
  size?: ChannelIconSize;
  className?: string;
  invertOnDark?: boolean;
}

const ICON_SRC_MAP: Record<string, string> = {
  telegram: telegramIcon,
  discord: discordIcon,
  whatsapp: whatsappIcon,
  wechat: wechatIcon,
  dingtalk: dingtalkIcon,
  feishu: feishuIcon,
  wecom: wecomIcon,
  qqbot: qqIcon,
};

export function ChannelIcon({
  type,
  size = 'md',
  className = '',
  invertOnDark = true,
}: ChannelIconProps) {
  const src = ICON_SRC_MAP[type];

  if (src) {
    const sizeClass = SIZE_MAP[size];
    const invertClass = invertOnDark ? 'dark:invert' : '';
    return (
      <img
        src={src}
        alt={type}
        className={`${sizeClass} ${invertClass} ${className}`}
      />
    );
  }

  // Fallback to emoji/icon for unknown channel types
  const icon = CHANNEL_ICONS[type] || '💬';
  const textSizeClass = TEXT_SIZE_MAP[size];
  return (
    <span className={`${textSizeClass} leading-none ${className}`}>
      {icon}
    </span>
  );
}

export default ChannelIcon;