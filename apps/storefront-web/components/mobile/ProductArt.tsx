"use client";

/**
 * 商品图形。固定数据集 87 件商品里 78 件没有图，所以全部画出来：按分类配色 +
 * 手绘图形，色相按商品 id 哈希微调，免得相邻两格长得一样。确定性的，服务端和
 * 客户端渲染结果一致，不会 hydration 不匹配。
 *
 * 货架、购物车缩略图、对话里的商品卡都用这一个组件，同一件商品在哪都长一样。
 */

import type { CSSProperties } from "react";

type Glyph = (props: { className?: string }) => React.ReactElement;

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const GLYPHS: Record<string, Glyph> = {
  "beauty-personal-care": () => (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M12 3c-4 6-5 8.6-5 10.5a5 5 0 0 0 10 0C17 11.6 16 9 12 3z" />
      <path d="M9.5 13.8a2.5 2.5 0 0 0 2.5 2.4" />
    </svg>
  ),
  grocery: () => (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M3 9h18l-1.7 9.2a2 2 0 0 1-2 1.8H6.7a2 2 0 0 1-2-1.8L3 9z" />
      <path d="M8.5 9 11 3.5M15.5 9 13 3.5M9.5 13v3M14.5 13v3" />
    </svg>
  ),
  "kids-room": () => (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="13" width="8" height="8" rx="1.4" />
      <rect x="13" y="13" width="8" height="8" rx="1.4" />
      <rect x="8" y="4" width="8" height="8" rx="1.4" />
      <path d="M11 8h2" />
    </svg>
  ),
  "home-kitchen": () => (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M4 9h13v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9z" />
      <path d="M17 11h2.2a2.3 2.3 0 0 1 0 4.6H17" />
      <path d="M7.5 6c0-1.2 1-1.4 1-2.5M11 6c0-1.2 1-1.4 1-2.5" />
    </svg>
  ),
  "office-electronics": () => (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="5" width="18" height="11" rx="1.6" />
      <path d="M2 19.5h20M9.5 16.2h5" />
    </svg>
  ),
  "outdoor-camping": () => (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M12 4 2.5 20h19L12 4z" />
      <path d="M12 10.5 7.5 20h9L12 10.5z" />
    </svg>
  ),
  fitness: () => (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2.5" y="8.5" width="3.6" height="7" rx="1.2" />
      <rect x="17.9" y="8.5" width="3.6" height="7" rx="1.2" />
      <path d="M6.1 12h11.8M7.6 6.8v10.4M16.4 6.8v10.4" />
    </svg>
  ),
  "toys-games": () => (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M14.5 3.5c3.5 1.4 6 4 6.2 6.5-2.6 4.3-7 8-11.4 9.7C6.6 18.8 5 16 4.6 13.4 6.6 9 10 5.4 14.5 3.5z" />
      <circle cx="14.4" cy="9.6" r="1.9" />
      <path d="M4.6 17.5c-1 1.2-1.3 2.5-1.1 3.2 1 .3 2.3-.1 3.4-1.1" />
    </svg>
  ),
  "pet-supplies": () => (
    <svg viewBox="0 0 24 24" {...S}>
      <ellipse cx="7" cy="8" rx="1.9" ry="2.4" />
      <ellipse cx="12" cy="6.3" rx="1.9" ry="2.4" />
      <ellipse cx="17" cy="8" rx="1.9" ry="2.4" />
      <path d="M12 11.4c2.9 0 5.3 2.4 5.3 4.7 0 2-1.7 3-3.4 2.7-1.3-.2-2.5-.2-3.8 0-1.7.3-3.4-.7-3.4-2.7 0-2.3 2.4-4.7 5.3-4.7z" />
    </svg>
  ),
  travel: () => (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2.6" y="7.5" width="18.8" height="12.4" rx="2" />
      <path d="M8.6 7.5V5.2a1.6 1.6 0 0 1 1.6-1.6h3.6a1.6 1.6 0 0 1 1.6 1.6v2.3M9 20v1.4M15 20v1.4M2.6 12.6h18.8" />
    </svg>
  ),
  "furniture-bedroom": () => (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M2.6 19V7M2.6 12.4h18.8V19M21.4 15.2v3.8" />
      <path d="M5.6 12.4v-2.6a1.6 1.6 0 0 1 1.6-1.6h3a1.6 1.6 0 0 1 1.6 1.6v2.6" />
    </svg>
  ),
  _default: () => (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M12 3 3.4 7.4v9.2L12 21l8.6-4.4V7.4L12 3z" />
      <path d="M3.4 7.4 12 11.9l8.6-4.5M12 21v-9.1" />
    </svg>
  ),
};

/** Two-stop backgrounds, one per category. Tuned as a set, not picked per tile. */
const PALETTE: Record<string, [string, string, string]> = {
  //                          from       to         glyph ink
  "beauty-personal-care": ["#ffe3ec", "#ffc9dd", "#c2547f"],
  grocery: ["#e2f5e0", "#c4ebc2", "#3f8248"],
  "kids-room": ["#fff0d6", "#ffe0ad", "#c58a2b"],
  "home-kitchen": ["#dff2f1", "#bde5e3", "#337d7a"],
  "office-electronics": ["#e5eaf4", "#ccd8ec", "#4a628f"],
  "outdoor-camping": ["#dcefe4", "#bbe0cb", "#2f7a55"],
  fitness: ["#eae3fb", "#d6c9f6", "#6a4fb5"],
  "toys-games": ["#ffe8dc", "#ffd0b8", "#c26236"],
  "pet-supplies": ["#f6e9dc", "#ecd6bd", "#9a6c3f"],
  travel: ["#dff0fb", "#c0e2f7", "#2e6f99"],
  "furniture-bedroom": ["#f0ece6", "#ded6cb", "#7c6c58"],
  _default: ["#e9ecf1", "#d6dbe4", "#5b6478"],
};

/** Stable small hash — same value on server and client. */
function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function ProductArt({
  productId,
  category,
  badge,
  style,
  className = "m-art",
}: {
  productId: string;
  category?: string | null;
  /** Small corner label, e.g. 热卖 / 缺货. */
  badge?: string | null;
  style?: CSSProperties;
  className?: string;
}) {
  const key = category && PALETTE[category] ? category : "_default";
  const [from, to, ink] = PALETTE[key];
  const Glyph = GLYPHS[key] ?? GLYPHS._default;
  const h = hash(productId);
  // ±14° of hue and a shifted gradient angle: enough that a grid of same-category
  // tiles is visibly varied, small enough that the category stays recognisable.
  const rotate = (h % 29) - 14;
  const angle = 120 + (h % 7) * 12;

  return (
    <div
      className={className}
      style={{
        background: `linear-gradient(${angle}deg, ${from}, ${to})`,
        filter: `hue-rotate(${rotate}deg)`,
        color: ink,
        ...style,
      }}
    >
      <Glyph />
      {badge ? <span className="m-art-badge">{badge}</span> : null}
    </div>
  );
}

/** Category glyph on its own, for the category grid / chips. */
export function CategoryGlyph({ category }: { category: string }) {
  const key = PALETTE[category] ? category : "_default";
  const Glyph = GLYPHS[key] ?? GLYPHS._default;
  return <Glyph />;
}

export function categoryColors(category: string): [string, string, string] {
  return PALETTE[PALETTE[category] ? category : "_default"];
}
