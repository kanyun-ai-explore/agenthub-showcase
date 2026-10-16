/**
 * 深色代码块。片段都是 yaml / ts 的小节选，只区分三种东西：注释、键、字符串。
 * 不引高亮库——四条正则够用，而且页面上的代码是文案不是可执行物。
 */

import type { ReactNode } from "react";

const KEY = /^(\s*(?:-\s+)?)([\w.$-]+)(\s*:)(?=\s|$)/;
const STRING = /("[^"]*"|'[^']*'|`[^`]*`)/g;
// `//` 只在行首或空白后算注释，否则 `https://…` 会被劈成两半
const COMMENT = /(?:^|(?<=\s))(#|\/\/)/;

function paint(line: string, key: number, mark?: "on" | "off"): ReactNode {
  const cut = line.search(COMMENT);
  const code = cut < 0 ? line : line.slice(0, cut);
  const comment = cut < 0 ? "" : line.slice(cut);

  const parts: ReactNode[] = [];
  const m = KEY.exec(code);
  let rest = code;
  if (m) {
    parts.push(m[1], <i key="k">{m[2]}</i>, m[3]);
    rest = code.slice(m[0].length);
  }
  let last = 0;
  for (const s of rest.matchAll(STRING)) {
    parts.push(rest.slice(last, s.index), <b key={s.index}>{s[0]}</b>);
    last = (s.index ?? 0) + s[0].length;
  }
  parts.push(rest.slice(last));
  if (comment) parts.push(<s key="c">{comment}</s>);

  return (
    <span className="code-line" key={key} data-mark={mark}>
      {parts}
    </span>
  );
}

export function Code({
  children,
  title,
  href,
  mark,
}: {
  children: string;
  title?: string;
  /** 给了就把标题渲染成跳转（公开仓库里对应的文件）。 */
  href?: string;
  /** 要点亮的行段（行号从 0 数，两端都含）。给了之后别的行变暗；不给就是普通代码块。 */
  mark?: [number, number][];
}) {
  const markOf = (i: number) => (mark ? (mark.some(([from, to]) => i >= from && i <= to) ? "on" : "off") : undefined);
  return (
    <div className="code">
      {title ? (
        <div className="code-title">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer">
              {title}
            </a>
          ) : (
            title
          )}
        </div>
      ) : null}
      <pre>{children.split("\n").map((line, i) => paint(line, i, markOf(i)))}</pre>
    </div>
  );
}
