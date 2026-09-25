export function isChineseLocale(value = '') {
  return /^zh(?:-|_|$)/i.test(value);
}

export const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
// TASKWAKE_LANG=zh forces Chinese; any other value forces English.
export function useChinese(env = process.env, system = locale) {
  return isChineseLocale(env.TASKWAKE_LANG || system);
}
export const chinese = useChinese();
export const t = (english, simplifiedChinese) => chinese ? simplifiedChinese : english;