/**
 * 英语小课（和情景对话）用的图标与状态栏，画法：实心、圆角、粗描边。
 *
 * 换掉原来的 emoji（🇬🇧🔥⚡✓🔒🏆★🎙）：emoji 的样子随系统字体变，在演示机上和整体风格差得最远
 * 只是外观，没有交互。
 */

import type { ReactElement } from "react";

/** 手机顶上的状态栏：时间 + 信号 + 电池，深色字。 */
export function EnStatusBar(): ReactElement {
  return (
    <div className="m-status en-status" data-dark="true">
      <span>9:41</span>
      <span className="m-status-right">
        <svg viewBox="0 0 18 12" width="17" height="11" fill="currentColor">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="4.6" y="5.6" width="3" height="6.4" rx="1" />
          <rect x="9.2" y="3" width="3" height="9" rx="1" />
          <rect x="13.8" y="0.4" width="3" height="11.6" rx="1" />
        </svg>
        <svg viewBox="0 0 16 12" width="15" height="11" fill="currentColor">
          <path d="M8 2.6c2.2 0 4.2.8 5.7 2.2l1.3-1.4A10 10 0 0 0 8 .6 10 10 0 0 0 1 3.4l1.3 1.4A8 8 0 0 1 8 2.6Z" />
          <path d="M8 5.8c1.3 0 2.5.5 3.4 1.3l1.3-1.4A7 7 0 0 0 8 3.8a7 7 0 0 0-4.7 1.9l1.3 1.4A5 5 0 0 1 8 5.8Z" />
          <path d="M8 9.2c.5 0 1 .2 1.3.5L8 11.2 6.7 9.7c.3-.3.8-.5 1.3-.5Z" />
        </svg>
        <span className="m-battery" />
      </span>
    </div>
  );
}

export function IconClose(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  );
}

export function IconFlame({ size = 22 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 28" width={size} height={size * (28 / 24)}>
      <path
        fill="currentColor"
        d="M12 1.5c.6 3.4 3.3 5.6 5.4 8.1 1.9 2.2 3.1 4.6 3.1 7.6 0 5.4-4 9.3-8.5 9.3S3.5 22.6 3.5 17.4c0-3.3 1.6-5.9 3.6-7.6.3 1.8 1.1 3.1 2.4 3.8-.3-4.4.9-8.8 2.5-12.1Z"
      />
      <path fill="#fff" opacity="0.55" d="M12.2 13.5c2.4 2 3.7 3.6 3.7 5.9 0 2.4-1.7 4.1-3.9 4.1s-3.9-1.6-3.9-3.8c0-2.4 1.6-4 4.1-6.2Z" />
    </svg>
  );
}

export function IconBolt({ size = 22 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path fill="currentColor" d="M14.2 1.8 4.6 13.4c-.5.6-.1 1.5.7 1.5h5.4l-1.8 7c-.2.9.9 1.4 1.5.7l9.4-11.7c.5-.6.1-1.5-.7-1.5h-5.3l1.9-6.9c.2-.9-.9-1.4-1.5-.7Z" />
    </svg>
  );
}

export function IconStar({ size = 34 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path
        fill="currentColor"
        d="M12 2.2c.5 0 .9.3 1.1.7l2.4 4.9 5.4.8c1 .1 1.4 1.4.7 2.1l-3.9 3.8.9 5.4c.2 1-.9 1.8-1.8 1.3L12 18.7l-4.8 2.5c-.9.5-2-.3-1.8-1.3l.9-5.4-3.9-3.8c-.7-.7-.3-2 .7-2.1l5.4-.8 2.4-4.9c.2-.4.6-.7 1.1-.7Z"
      />
    </svg>
  );
}

export function IconCheck({ size = 30, stroke = 4 }: { size?: number; stroke?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconTrophy({ size = 34 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d="M7 3h10c.6 0 1 .4 1 1v1h2.2c.5 0 .9.4.8.9-.3 2.8-1.9 4.8-4.4 5.4A6 6 0 0 1 13 14.9V17h2.5c.8 0 1.5.7 1.5 1.5V20c0 .6-.4 1-1 1H8c-.6 0-1-.4-1-1v-1.5c0-.8.7-1.5 1.5-1.5H11v-2.1a6 6 0 0 1-3.6-3.6C4.9 10.7 3.3 8.7 3 5.9c0-.5.3-.9.8-.9H6V4c0-.6.4-1 1-1Zm11 4v2.6c.8-.5 1.3-1.4 1.6-2.6H18ZM6 7H4.4c.3 1.2.8 2.1 1.6 2.6V7Z" />
    </svg>
  );
}

export function IconSpeaker({ size = 32 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path fill="currentColor" d="M3.5 9.2c0-.6.5-1.1 1.1-1.1h2.8l4.1-3.6c.7-.6 1.8-.1 1.8.8v13.4c0 .9-1.1 1.4-1.8.8l-4.1-3.6H4.6c-.6 0-1.1-.5-1.1-1.1V9.2Z" />
      <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" d="M16 9a4.2 4.2 0 0 1 0 6M18.8 6.2a8.2 8.2 0 0 1 0 11.6" />
    </svg>
  );
}

export function IconMic({ size = 24 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <rect x="8" y="2" width="8" height="13" rx="4" fill="currentColor" />
      <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" d="M5 11a7 7 0 0 0 14 0M12 18v3.5" />
    </svg>
  );
}

export function IconTarget({ size = 20 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="3">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconClock({ size = 20 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/** 课程旗：英国国旗的简化画法（顶栏左上角那面小旗）。 */
export function FlagGB(): ReactElement {
  return (
    <svg viewBox="0 0 60 40" width="34" height="24" className="en-flag" aria-hidden="true">
      <clipPath id="en-flag-clip">
        <rect width="60" height="40" rx="7" />
      </clipPath>
      <g clipPath="url(#en-flag-clip)">
        <rect width="60" height="40" fill="#1e3f9a" />
        <path d="M0 0l60 40M60 0L0 40" stroke="#fff" strokeWidth="8" />
        <path d="M0 0l60 40M60 0L0 40" stroke="#e8343b" strokeWidth="3" />
        <path d="M30 0v40M0 20h60" stroke="#fff" strokeWidth="12" />
        <path d="M30 0v40M0 20h60" stroke="#e8343b" strokeWidth="7" />
      </g>
    </svg>
  );
}
