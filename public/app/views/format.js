// 날짜·마감 표시(언어별). 순수 함수 — DOM 을 쓰지 않는다.
const TAGS = { ko: 'ko-KR', ja: 'ja-JP', en: 'en-US' };

export function parseDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

// 'YYYY-MM-DD' 는 시간대 없는 날짜다. UTC 로 만들어 UTC 로 찍어 하루가 밀리지 않게 한다
export function formatDate(value, locale, { weekday = true, year = true } = {}) {
  const p = parseDateOnly(value);
  if (!p) return '';
  return new Intl.DateTimeFormat(TAGS[locale] || TAGS.ko, { ...(year ? { year: 'numeric' } : {}), month: 'long', day: 'numeric', ...(weekday ? { weekday: 'short' } : {}), timeZone: 'UTC' }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)));
}

// 같은 해면 끝 날짜의 연도를 줄인다. weekday:false 는 카드용(짧게)
export function formatRange(startsOn, endsOn, locale, { weekday = true } = {}) {
  if (!startsOn) return '';
  if (!endsOn || endsOn === startsOn) return formatDate(startsOn, locale, { weekday });
  const sameYear = startsOn.slice(0, 4) === endsOn.slice(0, 4);
  return `${formatDate(startsOn, locale, { weekday })} – ${formatDate(endsOn, locale, { weekday, year: !sameYear })}`;
}

export function formatDeadline(iso, locale, timeZone, { weekday = true } = {}) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(TAGS[locale] || TAGS.ko, { year: 'numeric', month: 'long', day: 'numeric', ...(weekday ? { weekday: 'short' } : {}), hour: 'numeric', minute: '2-digit', timeZone }).format(date);
}

function ymdInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// 시간대 달력 기준으로 오늘부터 마감일까지 남은 날 수(오늘 = 0). 마감이 없거나 지났으면 null
export function daysUntil(iso, now, timeZone) {
  if (!iso) return null;
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) return null;
  const a = parseDateOnly(ymdInZone(now, timeZone));
  const b = parseDateOnly(ymdInZone(end, timeZone));
  if (!a || !b) return null;
  const days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  return days < 0 ? null : days;
}

// D-day 보이는 글자('D-3'·'D-day')와 읽는 문장 키. 마감 항목·마감일 없음은 null
export function ddayInfo(item, now, timeZone) {
  if (!item || item.status === 'closed') return null;
  const days = daysUntil(item.deadline, now, timeZone);
  if (days == null) return null;
  if (days === 0) return { text: 'D-day', days, key: 'dday.today' };
  return { text: `D-${days}`, days, key: days === 1 ? 'dday.leftOne' : 'dday.left' };
}
