// 로컬 D1 에 가짜 항목 6개를 넣는다(오늘 날짜 기준 상대 날짜). 운영 DB 에는 쓰지 않는다(--local 만).
//   npm run db:migrate:local   (먼저 한 번)
//   npm run db:seed:local      (다시 실행해도 같은 6개로 지우고 다시 넣는다. 다른 항목은 건드리지 않는다)
// 상태가 open 3·closing 1·closed 2 가 되게 마감을 잡고, 테마색 6종을 하나씩, 그림은 4개만(2개는 null) 쓴다.
// "sample-community-workshop" 의 본문에는 소제목·목록·<script> 문자열을 넣어 화면의 이스케이프를 시험한다.
// 만든 SQL 은 저장소 밖 임시 폴더(기본 ../qa, SITE_QA_DIR 로 바꿈)의 seed-local.sql 에 덮어쓴다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const KST = 9 * 60 * 60 * 1000;

/** 오늘(KST) 'YYYY-MM-DD' */
export function todayKst(now = Date.now()) {
  return new Date(now + KST).toISOString().slice(0, 10);
}
function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/**
 * 가짜 항목 6개. 실존 단체·사람 이름은 쓰지 않는다.
 * @param {string} today 'YYYY-MM-DD'(KST)
 */
export function seedItems(today) {
  const d = (days) => addDays(today, days);
  const deadline = (days, time = '18:00:00') => `${d(days)}T${time}+09:00`;
  return [
    {
      id: 'sample-community-workshop',
      accent: 'blue',
      image: '/samples/poster-1.svg',
      link: 'https://example.com/workshop',
      startsOn: d(40),
      endsOn: d(41),
      deadline: deadline(30),
      expected: 'open',
      texts: {
        ko: {
          title: '동네 글쓰기 워크숍',
          summary: '이틀 동안 짧은 글을 쓰고 서로 읽어 주는 모임입니다.',
          place: '시민회관 2층 세미나실',
          body: '처음 오시는 분도 편하게 참여할 수 있습니다.\n\n## 준비물\n- 필기구\n- 읽고 싶은 짧은 글 한 편\n\n## 안내\n화면 이스케이프 시험용 문자열: <script>alert("x")</script> 와 <b>굵게</b> 는 글자 그대로 보여야 합니다.',
        },
        ja: {
          title: '地域の文章ワークショップ',
          summary: '二日間、短い文章を書いて読み合う集まりです。',
          place: '市民会館2階セミナー室',
          body: '初めての方も気軽に参加できます。\n\n## 持ち物\n- 筆記用具\n- 読みたい短い文章を一つ\n\n## ご案内\nエスケープ確認用の文字列: <script>alert("x")</script> と <b>太字</b> はそのまま表示されるべきです。',
        },
        en: {
          title: 'Neighborhood Writing Workshop',
          summary: 'A two-day meetup where we write short pieces and read them to each other.',
          place: 'Civic Hall, Seminar Room 2F',
          body: 'First-timers are welcome.\n\n## What to bring\n- Something to write with\n- One short piece you would like to read\n\n## Note\nEscape test string: <script>alert("x")</script> and <b>bold</b> must appear as plain text.',
        },
      },
    },
    {
      id: 'sample-city-walk',
      accent: 'aqua',
      image: '/samples/poster-2.svg',
      link: null,
      startsOn: d(25),
      endsOn: d(25),
      deadline: deadline(21),
      expected: 'open',
      texts: {
        ko: { title: '도심 걷기 모임', summary: '오래된 골목을 따라 두 시간 정도 걷습니다.', place: '중앙역 1번 출구 앞', body: '편한 신발을 신고 오세요.\n\n비가 많이 오면 다음 주로 미룹니다.' },
        ja: { title: '街歩きの会', summary: '古い路地に沿って二時間ほど歩きます。', place: '中央駅1番出口前', body: '歩きやすい靴でお越しください。\n\n大雨の場合は翌週に延期します。' },
        en: { title: 'City Walking Meetup', summary: 'A two-hour walk through old alleys.', place: 'Central Station, Exit 1', body: 'Please wear comfortable shoes.\n\nIf it rains heavily, we will move to the next week.' },
      },
    },
    {
      id: 'sample-photo-exhibit',
      accent: 'lavender',
      image: null,
      link: 'https://example.com/photos',
      startsOn: d(-10),
      endsOn: d(60),
      deadline: null,
      expected: 'open',
      texts: {
        ko: { title: '사진 동호회 작품 전시', summary: '회원들이 한 해 동안 찍은 사진을 모았습니다.', place: '구립도서관 1층 전시실', body: '마감 없이 전시 기간 동안 언제든 들를 수 있습니다.\n\n- 월요일 휴관\n- 입장 무료' },
        ja: { title: '写真サークル作品展', summary: '会員が一年間に撮った写真を集めました。', place: '区立図書館1階展示室', body: '締切はなく、会期中いつでもお立ち寄りいただけます。\n\n- 月曜休館\n- 入場無料' },
        en: { title: 'Photo Club Exhibition', summary: 'Photos our members took over the past year.', place: 'District Library, Gallery 1F', body: 'No deadline: drop by any time during the exhibition.\n\n- Closed on Mondays\n- Free admission' },
      },
    },
    {
      id: 'sample-cooking-class',
      accent: 'coral',
      image: '/samples/poster-4.svg',
      link: null,
      startsOn: d(10),
      endsOn: d(10),
      deadline: deadline(3, '23:59:59'),
      expected: 'closing',
      texts: {
        ko: { title: '주말 요리 교실', summary: '제철 채소로 간단한 반찬 세 가지를 만듭니다.', place: '주민센터 조리실', body: '재료는 준비되어 있습니다.\n\n## 순서\n- 재료 다듬기\n- 함께 만들기\n- 나눠 먹기' },
        ja: { title: '週末料理教室', summary: '旬の野菜で簡単なおかずを三品作ります。', place: '住民センター調理室', body: '材料はこちらで用意します。\n\n## 流れ\n- 下ごしらえ\n- 一緒に調理\n- 試食' },
        en: { title: 'Weekend Cooking Class', summary: 'Make three simple side dishes with seasonal vegetables.', place: 'Community Center Kitchen', body: 'All ingredients are provided.\n\n## Steps\n- Prep the ingredients\n- Cook together\n- Share the food' },
      },
    },
    {
      id: 'sample-book-club',
      accent: 'slate',
      image: '/samples/poster-5.svg',
      link: 'https://example.com/books',
      startsOn: d(-3),
      endsOn: d(30),
      deadline: deadline(-5),
      expected: 'closed',
      texts: {
        ko: { title: '독서 모임 가을 시즌', summary: '한 달에 두 번 모여 같은 책을 읽고 이야기합니다.', place: '동네 책방 안쪽 방', body: '이번 시즌 신청은 끝났습니다.\n\n다음 시즌 소식을 기다려 주세요.' },
        ja: { title: '読書会 秋シーズン', summary: '月に二回集まり、同じ本を読んで話し合います。', place: '町の本屋の奥の部屋', body: '今シーズンの募集は終了しました。\n\n次のシーズンのお知らせをお待ちください。' },
        en: { title: 'Book Club: Autumn Season', summary: 'We meet twice a month to read and talk about the same book.', place: 'Back room of the local bookshop', body: 'Sign-ups for this season are closed.\n\nStay tuned for the next season.' },
      },
    },
    {
      id: 'sample-music-night',
      accent: 'yellow',
      image: null,
      link: null,
      startsOn: d(-30),
      endsOn: d(-30),
      deadline: deadline(-40),
      expected: 'closed',
      texts: {
        ko: { title: '작은 음악회', summary: '동네 연주자들이 꾸민 저녁 음악회였습니다.', place: '공원 야외무대', body: '함께해 주셔서 고맙습니다.' },
        ja: { title: '小さな音楽会', summary: '地域の演奏者による夜の音楽会でした。', place: '公園の野外ステージ', body: 'ご来場ありがとうございました。' },
        en: { title: 'Small Concert Night', summary: 'An evening concert by local musicians.', place: 'Park Open-air Stage', body: 'Thank you for joining us.' },
      },
    },
  ];
}

const quote = (value) => (value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);

/** 지우고 다시 넣는 SQL(문장마다 한 줄, BEGIN/COMMIT 없음 — D1 은 파일 안 트랜잭션 문을 받지 않는다). */
export function buildSeedSql(today) {
  const items = seedItems(today);
  const ids = items.map((item) => quote(item.id)).join(', ');
  const lines = [
    '-- scripts/seed-local.mjs 가 만든 로컬 전용 가짜 항목. 다시 만들 수 있으니 고치지 말 것.',
    `DELETE FROM item_texts WHERE item_id IN (${ids});`,
    `DELETE FROM items WHERE id IN (${ids});`,
  ];
  for (const item of items) {
    lines.push(
      `INSERT INTO items (id, link, accent, image, starts_on, ends_on, deadline) VALUES (${[item.id, item.link, item.accent, item.image, item.startsOn, item.endsOn, item.deadline].map(quote).join(', ')});`,
    );
    for (const [locale, text] of Object.entries(item.texts)) {
      lines.push(
        `INSERT INTO item_texts (item_id, locale, title, summary, place, body) VALUES (${[item.id, locale, text.title, text.summary, text.place, text.body].map(quote).join(', ')});`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function qaDir() {
  return process.env.SITE_QA_DIR ? resolve(process.env.SITE_QA_DIR) : resolve(root, '..', 'qa');
}

function main() {
  const today = todayKst();
  const dir = qaDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'seed-local.sql');
  writeFileSync(file, buildSeedSql(today), 'utf8');
  const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const output = execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', `--file=${file}`], {
    cwd: root,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const counts = seedItems(today).reduce((acc, item) => ({ ...acc, [item.expected]: (acc[item.expected] || 0) + 1 }), {});
  const executed = output.split('\n').find((line) => /commands? executed/i.test(line));
  if (!executed) throw new Error('wrangler d1 execute 결과에서 실행 줄을 찾지 못했습니다');
  console.log(executed.trim());
  console.log(`seed-local: 항목 6개(기준일 ${today}, 예상 상태 ${JSON.stringify(counts)}), SQL ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
