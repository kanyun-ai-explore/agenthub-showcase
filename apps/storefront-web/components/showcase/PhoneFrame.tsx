/**
 * 手机外壳。里面是固定 390×800 的逻辑屏幕——App 按真机写，不按流式视口写。
 *
 * 外壳整体按视口高度缩放（见 globals.css 的 `--phone-scale`），笔记本上也能整台放进
 * 锁定高度的舞台里；缩放的是外壳，屏幕里的布局一个像素都不动。
 */

import type { ReactNode } from "react";

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="phone-fit">
      <div className="phone">
        <div className="phone-screen">
          <div className="phone-notch" />
          {children}
          <div className="phone-home" />
        </div>
      </div>
    </div>
  );
}
