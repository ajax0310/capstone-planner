/* 수강 플래너 연결 설정. 서버 주소가 바뀌면 이 파일만 고치면 됩니다. */
window.PKNU_CONFIG = {
  // 백엔드 API(서비스 B). 브라우저가 직접 호출하므로 백엔드에 CORS 허용이 필요합니다.
  apiBase: 'https://pkun-timetable-api.onrender.com',

  // start.cmd(server.py)로 로컬 실행하면 같은 주소의 /api 가 백엔드로 중계합니다.
  // CORS가 열리기 전에도 로컬에서 실제 데이터를 테스트할 수 있습니다. 쓰지 않으려면 빈 문자열.
  devProxyBase: '/api',

  // AI 챗봇(서비스 A). 빈 값이면 화면을 제공하는 같은 주소의 chatPath 를 호출합니다.
  chatBase: 'https://pknu-chat.onrender.com',
  chatPath: '/api/chat',

  // Render 무료 플랜은 잠든 서버가 깨어나는 데 1분 안팎이 걸립니다.
  requestTimeoutMs: 90000,
  wakeNoticeAfterMs: 6000,

  // 시간표 후보 생성 방식. 'server'는 백엔드 POST /timetables/generate, 'browser'는 화면 미리보기 계산.
  // 서버 호출이 실패하면 자동으로 화면 계산으로 대신하고, 파일(file://)로 열면 항상 화면 계산입니다.
  generateMode: 'server',
  // 서버에 요청할 최대 후보 수 (API 상한 30). 분반 고정·목표 학점은 화면에서 거르므로 넉넉히 받습니다.
  generateMaxResults: 30
};
