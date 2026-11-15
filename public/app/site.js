// 새 사이트가 바꿀 곳: 이 파일 하나. 사이트 이름·메뉴·꼬리말·시간대.
// 문구는 { ko, ja, en } 객체. 화면 문구와 오류 문구는 messages.js 에 있다.

export const SITE = {
  // 머리말 왼쪽 이름과 <title> 뒤에 붙는 이름
  name: { ko: '내 사이트', ja: 'マイサイト', en: 'My Site' },

  // 머리말 메뉴. match: 현재 위치 표시에 쓰는 이름(items | members). requiresAuth: 로그인한 사람에게만 보임
  nav: [
    { id: 'items', href: '/#/items', match: 'items', label: { ko: '항목', ja: '項目', en: 'Items' } },
    { id: 'members', href: '/members/', match: 'members', requiresAuth: true, label: { ko: '회원', ja: '会員', en: 'Members' } },
  ],

  // 꼬리말. links 는 [{ href, label: {ko,ja,en} }] — 개인정보 처리방침·문의 링크 등을 여기에 넣는다
  footer: {
    text: { ko: '내 사이트 · 시작 템플릿', ja: 'マイサイト · スターターテンプレート', en: 'My Site · starter template' },
    links: [],
  },

  // 날짜·마감 표시에 쓰는 시간대와 안내 문구(목록·상세에 한 줄로 나온다)
  timeZone: 'Asia/Seoul',
  timeZoneNote: {
    ko: '모든 시각은 한국 표준시(KST) 기준입니다.',
    ja: 'すべての時刻は韓国標準時(KST)です。',
    en: 'All times are in Korea Standard Time (KST).',
  },

  // 언어를 저장하는 localStorage 키
  storageKey: 'site.locale',
};

export function pick(obj, locale) {
  if (!obj) return '';
  return obj[locale] || obj.ko || obj.en || '';
}
