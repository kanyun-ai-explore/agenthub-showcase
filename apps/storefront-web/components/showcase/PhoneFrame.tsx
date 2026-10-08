/**
 * 手机外壳。里面是固定 390×844 的逻辑屏幕（iPhone 的可视区），外壳四边各 10px、
 * 整台 410×864——App 按真机写，不按流式视口写。尺寸只在 globals.css 的 `--phone-w/-h` 一处。
 *
 * 外壳整体按视口高度缩放（见 globals.css 的 `--phone-scale`），笔记本上也能整台放进
 * 锁定高度的舞台里；缩放的是外壳，屏幕里的布局一个像素都不动。
 *
 * 不画灵动岛（全站去掉）：它压在各 App 顶栏的正中，英语小课的进度条
 * 被它挡住过一截；状态栏由各 App 自己画。
 */

import type { ReactNode } from "react";

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="phone-fit">
      <div className="phone">
        <div className="phone-screen">
          {children}
          <div className="phone-home" />
        </div>
      </div>
    </div>
  );
}
