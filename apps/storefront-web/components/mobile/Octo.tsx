"use client";

/**
 * 小章鱼老师。
 *
 * 用的是官方那张 PNG（`/brand/agenthub-mark-192.png`），不重绘、不改色——原画是
 * 生成式出图没有矢量源，照着描一版等于换掉这个角色。表情和动作全部做在图外面：
 * 呼吸、点头、跳一下，加一副眼镜和几个环绕的小气泡。
 *
 * 这不是装饰：小孩子对着一个会动的角色上课，和对着一段文字上课，是两件事。
 */

import type { CSSProperties } from "react";

export type OctoMood = "idle" | "talking" | "cheer" | "think";

export function Octo({
  mood = "idle",
  size = 72,
  glasses = true,
  style,
}: {
  mood?: OctoMood;
  size?: number;
  /** 戴眼镜 = 老师。去掉就是普通小章鱼。 */
  glasses?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span className="octo" data-mood={mood} style={{ width: size, height: size, ...style }}>
      <span className="octo-shadow" />
      <img className="octo-art" src="/brand/agenthub-mark-192.png" alt="" draggable={false} />
      {glasses ? (
        <svg className="octo-glasses" viewBox="0 0 100 100" aria-hidden>
          <g fill="none" stroke="#1b3a2c" strokeWidth="3.4" strokeLinecap="round">
            <circle cx="36" cy="45" r="12.5" />
            <circle cx="64" cy="45" r="12.5" />
            <path d="M48.5 44.5h3" />
            <path d="M23.5 42.5c-3 0-5 1-6.5 2.5M76.5 42.5c3 0 5 1 6.5 2.5" />
          </g>
        </svg>
      ) : null}
      {mood === "cheer" ? (
        <span className="octo-spark" aria-hidden>
          <i>✦</i>
          <i>✦</i>
          <i>✦</i>
        </span>
      ) : null}
      {mood === "think" ? <span className="octo-think" aria-hidden>💭</span> : null}
    </span>
  );
}
