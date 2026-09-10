"use client";

/** Line icons for the phone UI. Stroke-based so they inherit `currentColor` and
 * stay legible at 21px, which lucide-style filled sets do not at this size. */

import type { ReactElement } from "react";

const P = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const F = { fill: "currentColor" };

export function IconHome({ active }: { active?: boolean }): ReactElement {
  return active ? (
    <svg viewBox="0 0 24 24" {...F}>
      <path d="M11.3 2.9a1.1 1.1 0 0 1 1.4 0l8.1 6.8c.3.2.4.5.4.9v10a1.2 1.2 0 0 1-1.2 1.2h-5v-6.2h-3.9V21.8h-5A1.2 1.2 0 0 1 4.8 20.6v-10c0-.4.1-.7.4-.9l8.1-6.8z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" {...P}>
      <path d="M4 10.2 12 3.5l8 6.7v9.4a.9.9 0 0 1-.9.9h-4.7v-6.2H9.6v6.2H4.9a.9.9 0 0 1-.9-.9v-9.4z" />
    </svg>
  );
}

export function IconGrid({ active }: { active?: boolean }): ReactElement {
  const r = active ? F : P;
  return (
    <svg viewBox="0 0 24 24" {...r}>
      <rect x="3.4" y="3.4" width="7.2" height="7.2" rx="2" />
      <rect x="13.4" y="3.4" width="7.2" height="7.2" rx="2" />
      <rect x="3.4" y="13.4" width="7.2" height="7.2" rx="2" />
      <rect x="13.4" y="13.4" width="7.2" height="7.2" rx="2" />
    </svg>
  );
}

export function IconCart({ active }: { active?: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" {...P} strokeWidth={active ? 2.1 : 1.7}>
      <path d="M2.6 3.6h2.6l2.3 11.2a1.7 1.7 0 0 0 1.7 1.4h8.2a1.7 1.7 0 0 0 1.7-1.3l1.5-6.6H6" />
      <circle cx="9.4" cy="20" r="1.3" />
      <circle cx="17.6" cy="20" r="1.3" />
    </svg>
  );
}

export function IconUser({ active }: { active?: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" {...P} strokeWidth={active ? 2.1 : 1.7}>
      <circle cx="12" cy="8" r="3.9" />
      <path d="M4.4 20.4a7.8 7.8 0 0 1 15.2 0" />
    </svg>
  );
}

export function IconSparkle(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="#fff">
      <path d="M12 2.6c.3 3.9 1.7 5.7 5.6 6.4-3.9.7-5.3 2.5-5.6 6.4-.3-3.9-1.7-5.7-5.6-6.4 3.9-.7 5.3-2.5 5.6-6.4z" />
      <path d="M18.4 14.4c.15 2 .85 2.9 2.85 3.25-2 .35-2.7 1.25-2.85 3.25-.15-2-.85-2.9-2.85-3.25 2-.35 2.7-1.25 2.85-3.25z" opacity="0.85" />
    </svg>
  );
}

export function IconSearch(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" {...P} stroke="#b7bcc4" strokeWidth={2}>
      <circle cx="10.6" cy="10.6" r="6.6" />
      <path d="m15.5 15.5 4.2 4.2" />
    </svg>
  );
}

export function IconSend(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" {...P} strokeWidth={1.9}>
      <path d="M21 3 10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8 21 3z" />
    </svg>
  );
}

export function IconBack(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" {...P} strokeWidth={2.2}>
      <path d="M15 4.5 7.5 12l7.5 7.5" />
    </svg>
  );
}

export function IconChevron(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" {...P} stroke="#c3c7ce" strokeWidth={2.2}>
      <path d="m9 4.5 7.5 7.5L9 19.5" />
    </svg>
  );
}

export function IconStar(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="#ffb020">
      <path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.2 6.1L12 16.9 6.5 19.8l1.2-6.1-4.5-4.3 6.1-.8L12 3z" />
    </svg>
  );
}
