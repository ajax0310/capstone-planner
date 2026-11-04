/* 강의 목록 불러오기. 서버(/semesters → /sections)를 먼저 시도하고, 실패하면 동봉된 저장본으로 전환합니다.
   fetchJSON 과 targets 는 시간표 생성(timetable-api.js)도 함께 씁니다. */
(function (root) {
  'use strict';

  const DAYS = new Set(['월', '화', '수', '목', '금', '토', '일']);
  const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'ko', { numeric: true });
  const nullableString = value => value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
  function nullableNumber(value) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function minute(value) {
    const number = nullableNumber(value);
    return number !== null && Number.isInteger(number) && number >= 0 && number <= 1440 ? number : null;
  }
  function unique(values) {
    return [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))].sort(compare);
  }
  function abortError() {
    const error = new Error('강의 목록 불러오기를 취소했습니다.');
    error.name = 'AbortError';
    return error;
  }
  // 수업 학년은 API가 명시한 값만 사용합니다. 학수번호나 학과로 추정하지 않습니다.
  function gradeOf(offering) {
    const explicit = offering.course_year ?? offering['수업학년'] ?? offering.course_year_raw;
    const text = nullableString(explicit);
    if (text === null) return null;
    const match = /^(\d{1,2})/.exec(text);
    return match ? match[1] : text;
  }

  // 과목은 분반의 묶음입니다. 과목을 담아도 분반을 전부 고른 것은 아닙니다.
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) {
      throw new Error('강의 목록 응답에 sections 배열이 없습니다.');
    }
    const byCourse = new Map();
    let meetingCount = 0;
    for (const record of raw.sections) {
      const offering = record && record['개설강의'];
      const courseId = nullableString(record && record.course_id) || nullableString(offering && offering.course_id);
      const sectionId = nullableString(record && record.section_id) || nullableString(offering && offering.section_id);
      if (!offering || !courseId || !sectionId) throw new Error('강의 응답에 과목 또는 분반 식별자가 없습니다.');
      const sourceMeetings = Array.isArray(record['수업시간목록']) ? record['수업시간목록'] : [];
      const warnings = Array.isArray(record.warnings) ? record.warnings.map(nullableString).filter(Boolean) : [];
      let unresolved = record.time_status === 'UNRESOLVED' || sourceMeetings.length === 0;
      const meetings = sourceMeetings.map(meeting => {
        const day = nullableString(meeting['요일']);
        const start = minute(meeting['시작분']);
        const end = minute(meeting['종료분']);
        if (!DAYS.has(day) || start === null || end === null || end <= start || meeting['시간값오류'] || meeting['시간순서오류'] || meeting['요일확인필요']) unresolved = true;
        return { day, start, end, room: nullableString(meeting['강의실코드']) };
      });
      if (unresolved && !warnings.some(warning => /시간|요일/.test(warning))) warnings.push('수업 시간·요일 확인 필요');
      meetingCount += meetings.length;
      const section = {
        id: sectionId,
        number: nullableString(offering['분반']) || '',
        professor: nullableString(offering['담당교수']),
        credits: nullableNumber(offering['학점수']),
        year: nullableNumber(offering['학년도']),
        semester: nullableNumber(offering['학기']),
        grade: gradeOf(offering),
        category: nullableString(offering.course_category),
        categoryRaw: nullableString(offering.course_category_raw),
        mode: nullableString(offering.instruction_mode),
        modeRaw: nullableString(offering.instruction_mode_raw),
        department: nullableString(offering['개설학과']),
        meetings,
        timeStatus: unresolved ? 'UNRESOLVED' : 'KNOWN',
        warnings
      };
      let course = byCourse.get(courseId);
      if (!course) {
        course = {
          id: courseId,
          code: nullableString(offering['학수번호']) || '',
          name: nullableString(offering['교과목명']) || '',
          credits: null,
          categories: [], categoryLabels: [], modes: [], departments: [], years: [], grades: [], sections: []
        };
        byCourse.set(courseId, course);
      }
      course.sections.push(section);
    }
    const courses = [...byCourse.values()];
    for (const course of courses) {
      course.sections.sort((a, b) => compare(a.number, b.number) || compare(a.id, b.id));
      const credits = new Set(course.sections.map(section => section.credits));
      course.credits = credits.size === 1 ? course.sections[0].credits : null;
      course.categories = unique(course.sections.map(section => section.category));
      course.categoryLabels = unique(course.sections.map(section => section.categoryRaw));
      course.modes = unique(course.sections.map(section => section.mode));
      course.departments = unique(course.sections.map(section => section.department));
      course.years = unique(course.sections.map(section => section.year));
      course.grades = unique(course.sections.map(section => section.grade));
    }
    courses.sort((a, b) => compare(a.name, b.name) || compare(a.code, b.code) || compare(a.id, b.id));
    return {
      courses,
      dataset: {
        id: nullableString(raw.dataset_id),
        year: nullableNumber(raw['학년도']),
        semester: nullableNumber(raw['학기']),
        sectionCount: raw.sections.length,
        meetingCount
      }
    };
  }

  function snapshot(notice) {
    if (!root.PKNU_CATALOG) throw new Error('동봉된 강의 데이터가 없습니다. data/catalog-snapshot.js 파일을 확인해 주세요.');
    const meta = root.PKNU_CATALOG_META && typeof root.PKNU_CATALOG_META === 'object' ? root.PKNU_CATALOG_META : {};
    const data = normalize(root.PKNU_CATALOG);
    const semesters = Number.isInteger(data.dataset.year) && Number.isInteger(data.dataset.semester)
      ? [{ year: data.dataset.year, semester: data.dataset.semester, offeringCount: data.dataset.sectionCount }] : [];
    const result = { ...data, semesters, source: 'snapshot', fetchedAt: nullableString(meta.fetchedAt) };
    if (notice) result.notice = notice;
    return result;
  }

  // /semesters 응답을 최근 학기부터 정렬한 목록으로 바꿉니다.
  function parseSemesters(raw) {
    const list = raw && Array.isArray(raw.semesters) ? raw.semesters : [];
    return list
      .map(item => ({ year: nullableNumber(item && item.year), semester: nullableNumber(item && item.semester), offeringCount: nullableNumber(item && item.offering_count) }))
      .filter(item => Number.isInteger(item.year) && Number.isInteger(item.semester))
      .sort((a, b) => b.year - a.year || b.semester - a.semester);
  }
  // 요청한 학기가 목록에 있으면 그것을, 없으면 가장 최근 학기를 고릅니다. 목록이 비면 서버 기본값에 맡깁니다.
  function chooseSemester(list, requested) {
    if (!Array.isArray(list) || !list.length) return null;
    if (requested && list.some(item => item.year === requested.year && item.semester === requested.semester)) return { year: requested.year, semester: requested.semester };
    return { year: list[0].year, semester: list[0].semester };
  }

  function config() {
    return root.PKNU_CONFIG && typeof root.PKNU_CONFIG === 'object' ? root.PKNU_CONFIG : {};
  }
  function isLocalHost() {
    const host = root.location && root.location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
  }
  // 로컬 실행에서는 server.py 중계(/api)를 먼저, 그다음 백엔드 주소를 직접 시도합니다.
  function targets() {
    const cfg = config();
    const list = [];
    if (isLocalHost() && cfg.devProxyBase) list.push({ base: String(cfg.devProxyBase).replace(/\/$/, ''), kind: 'proxy' });
    if (cfg.apiBase) list.push({ base: String(cfg.apiBase).replace(/\/$/, ''), kind: 'direct' });
    if (!list.length) list.push({ base: '/api', kind: 'proxy' });
    return list;
  }
  function reasonOf(error) {
    if (!error) return '연결 실패';
    if (error.name === 'TimeoutError') return '응답 시간 초과';
    if (error.name === 'HttpError') return error.message;
    if (error instanceof TypeError) return '연결 실패(CORS 또는 네트워크)';
    return error.message || '연결 실패';
  }

  // 서버 호출 한 번. 응답이 늦어지면 "깨우는 중" 상태를 알리고, HTTP 오류면 서버가 보낸 detail 을 메시지에 붙입니다.
  async function fetchJSON(target, path, { method = 'GET', body, signal, onStatus = () => {}, timeoutMs = 90000, wakeAfterMs = 6000 } = {}) {
    const controller = new AbortController();
    const started = Date.now();
    let timer;
    let wakeTimer;
    let externalAbort;
    try {
      return await Promise.race([
        (async () => {
          const headers = { Accept: 'application/json' };
          if (body !== undefined) headers['Content-Type'] = 'application/json';
          const response = await root.fetch(target.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
          if (!response.ok) {
            const error = new Error('HTTP ' + response.status);
            error.name = 'HttpError';
            error.status = response.status;
            try {
              const detail = (await response.json()).detail;
              if (typeof detail === 'string' && detail.trim()) error.detail = detail.trim();
              else if (Array.isArray(detail) && detail.length) error.detail = detail.map(item => item && item.msg).filter(Boolean).join(', ');
              if (error.detail) error.message += ' · ' + error.detail;
            } catch (_) { /* 본문이 JSON이 아니면 상태 코드만 씁니다. */ }
            throw error;
          }
          return response.json();
        })(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            const error = new Error('서버 응답 시간이 초과되었습니다.');
            error.name = 'TimeoutError';
            reject(error);
          }, timeoutMs);
          wakeTimer = setTimeout(() => onStatus({ phase: 'waking', target, elapsed: Date.now() - started }), wakeAfterMs);
          if (signal) {
            externalAbort = () => { controller.abort(); reject(abortError()); };
            signal.addEventListener('abort', externalAbort, { once: true });
          }
        })
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(wakeTimer);
      if (signal && externalAbort) signal.removeEventListener('abort', externalAbort);
    }
  }

  // 빈 응답이라도 성공이면 그대로 사용합니다. 저장본 전환은 연결 실패 때만 일어납니다.
  // semester: {year, semester} 를 주면 /semesters 목록에 있을 때 그 학기를 요청합니다.
  async function load({ source = 'auto', semester = null, signal, onStatus = () => {} } = {}) {
    if (!['auto', 'live', 'snapshot'].includes(source)) throw new Error('지원하지 않는 강의 데이터 소스입니다.');
    if (signal && signal.aborted) throw abortError();
    const protocol = root.location && root.location.protocol;
    if (source === 'snapshot' || (source === 'auto' && protocol !== 'http:' && protocol !== 'https:')) {
      return snapshot(source === 'snapshot' ? '' : '동봉된 2026년 2학기 강의 데이터로 실행 중입니다.');
    }
    const cfg = config();
    const timeoutMs = Number(cfg.requestTimeoutMs) > 0 ? Number(cfg.requestTimeoutMs) : 90000;
    const wakeAfterMs = Number(cfg.wakeNoticeAfterMs) > 0 ? Number(cfg.wakeNoticeAfterMs) : 6000;
    const failures = [];
    for (const target of targets()) {
      if (signal && signal.aborted) throw abortError();
      onStatus({ phase: 'connecting', target });
      try {
        const options = { signal, onStatus, timeoutMs, wakeAfterMs };
        let semesters = [];
        try {
          semesters = parseSemesters(await fetchJSON(target, '/semesters', options));
        } catch (error) {
          // /semesters 가 없는 예전 백엔드면 기본 학기로 계속합니다. 연결 자체가 안 되면 다음 대상으로 넘어갑니다.
          if (error.name !== 'HttpError') throw error;
        }
        const choice = chooseSemester(semesters, semester);
        const query = choice ? `?year=${choice.year}&semester=${choice.semester}` : '';
        const data = normalize(await fetchJSON(target, '/sections' + query, options));
        return { ...data, semesters, source: 'live', via: target.kind, base: target.base, fetchedAt: new Date().toISOString() };
      } catch (error) {
        if (error.name === 'AbortError' || (signal && signal.aborted)) throw abortError();
        failures.push(`${target.kind === 'proxy' ? '로컬 중계' : '백엔드'}: ${reasonOf(error)}`);
      }
    }
    if (source === 'live') throw new Error(failures.join(' / ') || '강의 API에 연결하지 못했습니다.');
    return snapshot('강의 API에 연결하지 못해 동봉된 데이터로 전환했습니다. (' + failures.join(' / ') + ')');
  }

  root.CatalogAPI = { load, normalize, targets, fetchJSON, reasonOf, parseSemesters, chooseSemester };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CatalogAPI;
})(typeof window !== 'undefined' ? window : globalThis);
