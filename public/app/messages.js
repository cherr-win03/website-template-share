// 화면 문구 사전. 키: [ko, ja, en]. 자리표시자는 {이름}.
// 서버 오류 코드(docs/CONTRACT.md)는 'error.<CODE>' 로 전부 들어 있다. 코드를 더하면 세 언어를 같이 적는다(시험이 확인한다).

export const MESSAGES = {
  // ---- 공통 ----
  'skip': ['본문으로 건너뛰기', '本文へスキップ', 'Skip to content'],
  'lang.label': ['언어', '言語', 'Language'],
  'nav.label': ['주요 메뉴', 'メインメニュー', 'Main menu'],
  'auth.signIn': ['로그인', 'ログイン', 'Sign in'],
  'auth.signOut': ['로그아웃', 'ログアウト', 'Sign out'],
  'state.loading': ['불러오는 중입니다…', '読み込み中です…', 'Loading…'],
  'state.retry': ['다시 시도', '再試行', 'Try again'],
  'noscript': [
    '이 사이트를 보려면 JavaScript 를 켜 주세요.',
    'このサイトを表示するには JavaScript を有効にしてください。',
    'Please turn on JavaScript to use this site.',
  ],
  'page.items': ['항목', '項目', 'Items'],
  'page.login': ['로그인', 'ログイン', 'Sign in'],
  'page.members': ['회원 전용', '会員専用', 'Members only'],
  'page.notFound': ['페이지를 찾을 수 없습니다', 'ページが見つかりません', 'Page not found'],

  // ---- 목록 ----
  'list.title': ['항목', '項目一覧', 'Items'],
  'list.lead': [
    '진행 중인 항목과 지난 항목을 한곳에서 볼 수 있습니다.',
    '開催中の項目と過去の項目をまとめて確認できます。',
    'Browse current and past items in one place.',
  ],
  'list.countOpen': ['진행 중', '進行中', 'Open'],
  'list.countClosed': ['마감', '終了', 'Closed'],
  'list.shown': ['{n}개 항목', '{n}件の項目', '{n} items'],
  'list.shownOne': ['1개 항목', '1件の項目', '1 item'],
  'list.empty': ['표시할 항목이 없습니다.', '表示する項目がありません。', 'There are no items to show.'],
  'list.emptyFiltered': ['조건에 맞는 항목이 없습니다.', '条件に合う項目がありません。', 'No items match this filter.'],
  'filter.label': ['상태로 걸러 보기', '状態で絞り込み', 'Filter by status'],
  'filter.all': ['전체', 'すべて', 'All'],
  'filter.open': ['진행 중', '進行中', 'Open'],
  'filter.closed': ['마감', '終了', 'Closed'],

  // ---- 카드·상태·날짜 ----
  'status.open': ['진행 중', '進行中', 'Open'],
  'status.closing': ['마감 임박', 'まもなく締切', 'Closing soon'],
  'status.closed': ['마감', '終了', 'Closed'],
  'card.more': ['자세히 보기', '詳しく見る', 'View details'],
  'fact.dates': ['일정', '日程', 'Dates'],
  'fact.place': ['장소', '場所', 'Place'],
  'fact.deadline': ['마감', '締切', 'Deadline'],
  'dday.today': ['오늘 마감', '本日締切', 'Closes today'],
  'dday.left': ['마감까지 {n}일 남음', '締切まであと{n}日', '{n} days until the deadline'],
  'dday.leftOne': ['마감까지 1일 남음', '締切まであと1日', '1 day until the deadline'],

  // ---- 상세 ----
  'detail.back': ['목록으로', '一覧へ', 'Back to list'],
  'detail.about': ['소개', '紹介', 'About'],
  'detail.actionTitle': ['관련 링크', '関連リンク', 'Related link'],
  'detail.openLink': ['관련 링크 열기', '関連リンクを開く', 'Open the link'],
  'detail.newTab': ['(새 탭에서 열림)', '(新しいタブで開きます)', '(opens in a new tab)'],
  'detail.closedNote': ['마감된 항목입니다.', '終了した項目です。', 'This item is closed.'],

  // ---- 로그인 ----
  'login.title': ['로그인', 'ログイン', 'Sign in'],
  'login.lead': [
    '이메일로 받은 코드로 로그인합니다.',
    'メールで届いたコードでログインします。',
    'Sign in with the code we email you.',
  ],
  'login.disabled': ['로그인 기능이 꺼져 있습니다.', 'ログイン機能は現在オフです。', 'Sign-in is turned off.'],
  'login.disabledHelp': [
    '이 사이트는 지금 로그인을 받지 않습니다.',
    'このサイトでは現在ログインを受け付けていません。',
    'This site is not accepting sign-ins right now.',
  ],
  'login.home': ['처음으로', 'トップへ', 'Go to the start'],
  'login.already': ['이미 로그인했습니다.', 'すでにログインしています。', 'You are already signed in.'],
  'login.continue': ['계속하기', '続ける', 'Continue'],
  'login.email': ['이메일', 'メールアドレス', 'Email'],
  'login.emailHint': ['코드를 받을 주소를 입력하세요.', 'コードを受け取るアドレスを入力してください。', 'Enter the address that should receive the code.'],
  'login.emailInvalid': ['올바른 이메일 주소를 입력해 주세요.', '正しいメールアドレスを入力してください。', 'Enter a valid email address.'],
  'login.sendCode': ['코드 보내기', 'コードを送る', 'Send code'],
  'login.sending': ['보내는 중…', '送信中…', 'Sending…'],
  'login.sent': [
    '코드를 보냈습니다. 메일함을 확인해 주세요.',
    'コードを送信しました。メールをご確認ください。',
    'We sent a code. Please check your inbox.',
  ],
  'login.code': ['확인 코드', '確認コード', 'Code'],
  'login.codeHint': ['{email} 로 보낸 코드를 입력하세요.', '{email} に送ったコードを入力してください。', 'Enter the code we sent to {email}.'],
  'login.codeRequired': ['코드를 입력해 주세요.', 'コードを入力してください。', 'Enter the code.'],
  'login.verify': ['로그인', 'ログイン', 'Sign in'],
  'login.verifying': ['확인하는 중…', '確認中…', 'Checking…'],
  'login.changeEmail': ['다른 이메일 쓰기', '別のメールアドレスを使う', 'Use a different email'],
  'login.or': ['또는', 'または', 'or'],
  'login.social': ['{name} 계정으로 계속하기', '{name} で続ける', 'Continue with {name}'],
  'login.socialGroup': ['다른 방법으로 로그인', '他の方法でログイン', 'Other ways to sign in'],

  // ---- 회원 견본 ----
  'members.title': ['회원 전용', '会員専用', 'Members only'],
  'members.lead': [
    '로그인한 사람만 볼 수 있는 견본 화면입니다.',
    'ログインした人だけが見られるサンプル画面です。',
    'A sample page that only signed-in people can see.',
  ],
  'members.hello': ['{email} 로 로그인했습니다.', '{email} でログインしています。', 'Signed in as {email}.'],
  'members.needSignIn': ['로그인이 필요합니다.', 'ログインが必要です。', 'You need to sign in.'],

  // ---- 없는 경로 ----
  'notfound.title': ['페이지를 찾을 수 없습니다', 'ページが見つかりません', 'Page not found'],
  'notfound.body': [
    '주소가 바뀌었거나 없는 페이지입니다.',
    'アドレスが変わったか、存在しないページです。',
    'The address may have changed, or the page does not exist.',
  ],
  'notfound.home': ['처음으로', 'トップへ', 'Go to the start'],

  // ---- 오류 코드(docs/CONTRACT.md) ----
  'error.INVALID_ORIGIN': ['요청을 보낸 곳이 올바르지 않습니다. 사이트를 새로 고친 뒤 다시 시도해 주세요.', 'リクエスト元が正しくありません。ページを更新してもう一度お試しください。', 'The request came from an unexpected place. Reload the page and try again.'],
  'error.INVALID_REQUEST': ['요청이 올바르지 않습니다. 사이트를 새로 고친 뒤 다시 시도해 주세요.', 'リクエストが正しくありません。ページを更新してもう一度お試しください。', 'The request was not valid. Reload the page and try again.'],
  'error.INVALID_CSRF': ['로그인 상태가 바뀌었습니다. 사이트를 새로 고친 뒤 다시 시도해 주세요.', 'ログイン状態が変わりました。ページを更新してもう一度お試しください。', 'Your sign-in state changed. Reload the page and try again.'],
  'error.PAYLOAD_TOO_LARGE': ['보내는 내용이 너무 깁니다.', '送信する内容が長すぎます。', 'What you sent is too long.'],
  'error.INVALID_JSON': ['보내는 내용을 읽을 수 없습니다.', '送信内容を読み取れません。', 'We could not read what you sent.'],
  'error.SERVICE_UNAVAILABLE': ['지금은 서비스를 쓸 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 'ただいまサービスを利用できません。しばらくしてからもう一度お試しください。', 'The service is unavailable right now. Please try again in a moment.'],
  'error.NOT_FOUND': ['찾을 수 없습니다.', '見つかりません。', 'Not found.'],
  'error.METHOD_NOT_ALLOWED': ['이 요청은 받을 수 없습니다. 사이트를 새로 고친 뒤 다시 시도해 주세요.', 'このリクエストは受け付けられません。ページを更新してもう一度お試しください。', 'This request is not allowed. Reload the page and try again.'],
  'error.AUTH_MISCONFIGURED': ['로그인 설정에 문제가 있습니다. 사이트 운영자에게 알려 주세요.', 'ログインの設定に問題があります。サイト運営者にお知らせください。', 'Sign-in is misconfigured. Please tell the site owner.'],
  'error.AUTH_DISABLED': ['로그인 기능이 꺼져 있습니다.', 'ログイン機能は現在オフです。', 'Sign-in is turned off.'],
  'error.AUTH_UNAVAILABLE': ['로그인 서비스에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 'ログインサービスに接続できませんでした。しばらくしてからもう一度お試しください。', 'We could not reach the sign-in service. Please try again in a moment.'],
  'error.INVALID_EMAIL': ['올바른 이메일 주소를 입력해 주세요.', '正しいメールアドレスを入力してください。', 'Enter a valid email address.'],
  'error.INVALID_CODE': ['코드가 맞지 않거나 만료되었습니다. 다시 확인해 주세요.', 'コードが違うか期限切れです。もう一度ご確認ください。', 'The code is wrong or has expired. Please check it again.'],
  'error.RATE_LIMITED': ['요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.', 'リクエストが多すぎます。しばらくしてからもう一度お試しください。', 'Too many requests. Please try again in a moment.'],
  'error.PROVIDER_NOT_ALLOWED': ['이 방법으로는 로그인할 수 없습니다.', 'この方法ではログインできません。', 'You cannot sign in this way.'],
  'error.SOCIAL_FAILED': ['외부 계정으로 로그인하지 못했습니다. 다시 시도해 주세요.', '外部アカウントでログインできませんでした。もう一度お試しください。', 'Signing in with that account failed. Please try again.'],
  'error.SIGN_IN_REQUIRED': ['로그인이 필요합니다.', 'ログインが必要です。', 'You need to sign in.'],
  'error.NETWORK_ERROR': ['네트워크에 연결하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.', 'ネットワークに接続できませんでした。接続を確認してもう一度お試しください。', 'We could not connect. Check your connection and try again.'],
  'error.UNKNOWN': ['알 수 없는 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.', '不明なエラーが発生しました。しばらくしてからもう一度お試しください。', 'Something went wrong. Please try again in a moment.'],
  'error.retryAfter': ['{n}초 뒤에 다시 시도할 수 있습니다.', '{n}秒後にもう一度お試しください。', 'You can try again in {n} seconds.'],
};

// 화면이 아는 오류 코드 목록(시험이 사전과 CONTRACT 를 대조한다)
export const ERROR_CODES = Object.keys(MESSAGES)
  .filter((key) => key.startsWith('error.') && key !== 'error.retryAfter')
  .map((key) => key.slice('error.'.length));
