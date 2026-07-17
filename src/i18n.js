export function isChineseLocale(value = '') {
  return /^zh(?:-|_|$)/i.test(value);
}

export const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
export const chinese = isChineseLocale(locale);
export const t = (english, simplifiedChinese) => chinese ? simplifiedChinese : english;