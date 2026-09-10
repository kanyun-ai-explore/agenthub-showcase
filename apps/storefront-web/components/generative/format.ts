/** 卡片里的金额格式化。 */

export function money(value: number, currency = "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

/** 拆开符号和数字，好让符号排得比数字小一号。 */
export function priceParts(value: number, currency = "CNY"): [string, string] {
  const text = money(value, currency);
  const match = /^([^\d]*)(.*)$/.exec(text);
  return match ? [match[1], match[2]] : ["", text];
}

/** 固定数据里有的是评论数不是销量，所以写「评价」——编个销量数字一查就穿帮。 */
export function reviewLabel(reviewCount?: number | null): string | null {
  if (!reviewCount) return null;
  return `${reviewCount.toLocaleString("zh-CN")} 评价`;
}
