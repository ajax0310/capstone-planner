/* 시간표 후보 생성: 백엔드 POST /timetables/select 호출과 화면 선택·조건의 변환.
   서버(2026-11-10 배포)는 필수·후보 구분, 허용 분반, 목표 학점 범위(min_credits·max_credits), 과목 수(target_count, 생략 가능),
   공강 요일, 차단 시간을 받아 담은 과목 중에서 골라 조합을 만듭니다. 한 번에 30과목까지 보낼 수 있습니다.
   실측(2026-11-10): 목표가 없으면 들어갈 수 있는 만큼 많이 넣은 조합을 돌려주고, 시간 미확인 분반은 제외하며,
   필수 과목이 조건에 못 들어가면 후보없는과목에 학수번호가 옵니다. 제한으로탐색중단은 max_results 를 채웠을 때도 true 입니다.
   422(중복 과목, 필수 수 > 목표 수, 최소 > 최대, 정확한 학점과 범위 동시 지정)는 detail 에 한국어 메시지가 옵니다.
   서버가 받는 조건이라도 응답을 한 번 더 확인해, 맞지 않는 후보가 섞이면 걸러내고 그 사실을 안내문으로 남깁니다. */
(function (root) {
  'use strict';

  const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
  const WEEKDAYS = DAYS.slice(0, 5);
  const LIMITS = { courses: 30, results: 30 };
  const PATH = '/timetables/select';
  // 목표 학점은 {min, max} 범위(정수 하나면 min=max).
  function creditRange(value) {
    const bound = raw => raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') {
      const min = bound(value.min);
      const max = bound(value.max);
      return min === null && max === null ? null : { min, max };
    }
    const single = bound(value);
    return single === null ? null : { min: single, max: single };
  }
  const creditLabel = range => range.min !== null && range.max !== null
    ? (range.min === range.max ? `${range.min}학점` : `${range.min}~${range.max}학점`)
    : range.min !== null ? `${range.min}학점 이상` : `${range.max}학점 이하`;

  const text = value => value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
  const number = value => { const parsed = Number(value); return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : null; };
  const label = course => course.name || course.code || course.id;
  function config() {
    return root.PKNU_CONFIG && typeof root.PKNU_CONFIG === 'object' ? root.PKNU_CONFIG : {};
  }
  // file:// 로 연 단일 HTML에는 생성 서버가 없습니다.
  function available() {
    const protocol = root.location && root.location.protocol;
    return protocol === 'http:' || protocol === 'https:';
  }
  function validMeeting(meeting) {
    return Boolean(meeting) && DAYS.includes(meeting.day) && Number.isInteger(meeting.start) && Number.isInteger(meeting.end)
      && meeting.start >= 0 && meeting.end <= 1440 && meeting.start < meeting.end;
  }
  // 서버가 조합에 쓸 수 있는 분반: 시간이 확인되고 학점이 있는 분반
  function usable(section) {
    return Boolean(section) && section.timeStatus === 'KNOWN' && Array.isArray(section.meetings) && section.meetings.length > 0
      && section.meetings.every(validMeeting) && Number.isFinite(section.credits);
  }

  // 화면의 선택·조건을 서버 요청으로 바꿉니다. 보낼 수 없는 것은 notes 에 남깁니다.
  function buildRequest({ courses, selection, conditions, dataset, maxResults }) {
    const courseMap = new Map(courses.map(course => [course.id, course]));
    const notes = [];
    const sent = [];
    const pins = [];
    const codes = new Set();
    const entries = [];
    let unsatisfiable = false;
    let optional = 0;
    for (const selected of Array.isArray(selection) ? selection : []) {
      if (!selected || selected.status === 'excluded') continue;
      const course = courseMap.get(selected.courseId);
      const required = selected.status === 'required';
      if (!course) {
        notes.push(`확인할 수 없는 과목(${selected.courseId})은 서버에 보내지 않았어요.`);
        if (required) unsatisfiable = true;
        continue;
      }
      const name = label(course);
      const code = text(course.code);
      if (!code) {
        notes.push(`${name}: 학수번호가 없어 서버에 보낼 수 없어요.`);
        if (required) unsatisfiable = true;
        continue;
      }
      if (codes.has(code)) {
        notes.push(`${name}: 같은 학수번호의 과목이 이미 있어 한 번만 보냈어요.`);
        continue;
      }
      const pinned = Array.isArray(selected.allowedSectionIds);
      const allowed = pinned ? course.sections.filter(section => selected.allowedSectionIds.includes(section.id)) : course.sections;
      if (!allowed.some(usable)) {
        notes.push(`${name}: 시간 미확인 분반뿐이라 서버에 보내지 않았어요.${required ? ' 필수 과목이라 후보를 만들 수 없어요.' : ''}`);
        if (required) unsatisfiable = true;
        continue;
      }
      codes.add(code);
      if (!required) optional += 1;
      const entry = { course_code: code, status: required ? 'required' : 'candidate' };
      if (pinned) {
        // 허용 분반은 분반 번호("101")로 보냅니다. 번호를 모르는 분반이 있으면 전체 허용으로 보내고 화면에서 거릅니다.
        const numbers = [...new Set(allowed.filter(usable).map(section => text(section.number)).filter(Boolean))];
        const complete = numbers.length > 0 && allowed.filter(usable).every(section => text(section.number));
        if (complete) entry.allowed_sections = numbers;
        pins.push({ courseId: course.id, name, allowedIds: new Set(allowed.map(section => section.id)), sent: complete });
      }
      entries.push(entry);
      sent.push({ courseId: course.id, code, name, required });
    }
    const request = {};
    if (dataset && Number.isInteger(dataset.year) && Number.isInteger(dataset.semester)) {
      request.year = dataset.year;
      request.semester = dataset.semester;
    }
    request.courses = entries;
    const target = creditRange(conditions && conditions.credits);
    if (target) {
      if (target.min !== null) request.min_credits = target.min;
      if (target.max !== null) request.max_credits = target.max;
    }
    const countValue = conditions ? number(conditions.count) : null;
    const count = Number.isInteger(countValue) && countValue > 0 ? countValue : null;
    if (count !== null) request.target_count = count;
    request.blocked_times = (conditions && Array.isArray(conditions.blockedTimes) ? conditions.blockedTimes : []).filter(validMeeting).map(({ day, start, end }) => ({ day, start, end }));
    request.free_days = (conditions && Array.isArray(conditions.freeDays) ? conditions.freeDays : []).filter(day => DAYS.includes(day));
    request.max_results = Math.min(LIMITS.results, Math.max(1, Math.floor(number(maxResults) || LIMITS.results)));
    if (optional && !target && count === null) notes.push(`목표 학점·과목 수가 없어서 서버가 후보 과목을 들어갈 수 있는 만큼 넣었어요. 조건 편집에서 목표를 정하면 그에 맞춰 골라요.`);
    else if (optional) notes.push(`서버가 필수 ${sent.length - optional}과목을 넣고 후보 ${optional}과목 중에서 목표에 맞게 골랐어요.`);
    return { request, sent, pins, notes, unsatisfiable, target, count, limitExceeded: entries.length > LIMITS.courses };
  }

  // 서버 응답(조합)을 화면 후보 형식으로 바꾸고, 조건에 맞지 않는 후보가 섞여 있으면 걸러냅니다.
  function adapt({ response, plan, courses, conditions, via, base }) {
    if (!response || typeof response !== 'object' || !Array.isArray(response['조합'])) throw new Error('시간표 생성 응답에 조합 배열이 없습니다.');
    const byCode = new Map();
    courses.forEach(course => { if (course.code && !byCode.has(course.code)) byCode.set(course.code, course); });
    const resultMap = new Map(courses.map(course => [course.id, course]));
    const nameOf = code => { const course = byCode.get(String(code)); return course ? label(course) : String(code); };

    function resolve(item) {
      const code = text(item['학수번호']);
      const numberText = text(item['분반']) || '';
      let course = (text(item.course_id) && resultMap.get(text(item.course_id))) || (code && byCode.get(code)) || null;
      const courseId = course ? course.id : text(item.course_id) || `code:${code || '?'}`;
      const sectionId = text(item.section_id) || `${courseId}:${numberText}`;
      let section = course ? course.sections.find(entry => entry.id === sectionId) : null;
      if (!section && course && numberText) section = course.sections.find(entry => entry.number === numberText);
      if (!section) {
        // 화면 목록에 없는 분반이면 서버가 준 정보만으로 그립니다. 교수·강의실은 알 수 없습니다.
        section = {
          id: sectionId, number: numberText, professor: null, credits: number(item['학점수']), year: null, semester: null,
          grade: text(item.course_year) || text(item.course_year_raw), category: text(item.course_category), categoryRaw: text(item.course_category_raw),
          mode: null, modeRaw: null, department: null,
          meetings: (Array.isArray(item['수업']) ? item['수업'] : []).map(meeting => ({ day: text(meeting['요일']), start: number(meeting['시작분']), end: number(meeting['종료분']), room: null })).filter(validMeeting),
          timeStatus: 'KNOWN', warnings: ['화면 목록에 없는 분반이라 서버 정보로 표시해요.']
        };
        course = course
          ? { ...course, sections: [...course.sections, section] }
          : { id: courseId, code: code || '', name: text(item['교과목명']) || code || '과목', credits: section.credits, categories: [], categoryLabels: [], modes: [], departments: [], years: [], grades: [], sections: [section] };
        resultMap.set(course.id, course);
      }
      return { course, section };
    }

    let candidates = response['조합'].map((combo, index) => {
      const sections = [];
      const meetings = [];
      let credits = 0;
      for (const item of Array.isArray(combo['강의목록']) ? combo['강의목록'] : []) {
        const { course, section } = resolve(item);
        sections.push({ courseId: course.id, sectionId: section.id });
        meetings.push(...section.meetings);
        credits += Number.isFinite(section.credits) ? section.credits : 0;
      }
      const total = number(combo['총학점']);
      return {
        id: `server-${index + 1}`,
        sections,
        credits: total === null ? credits : total,
        count: sections.length,
        gapMinutes: number(combo['수업사이대기분']) || 0,
        freeDays: WEEKDAYS.filter(day => !meetings.some(meeting => meeting.day === day))
      };
    });
    const serverCount = candidates.length;
    const warnings = [];
    (Array.isArray(response['후보없는과목']) ? response['후보없는과목'] : []).forEach(code => warnings.push(`${nameOf(code)}: 조건에 맞는 분반이 없어 서버가 넣지 못했어요. 필수 과목이면 후보가 만들어지지 않아요.`));
    (Array.isArray(response['시간미확인제외']) ? response['시간미확인제외'] : []).forEach(entry => {
      const match = /^(.+?)-([^:\s]+):\s*(.+)$/.exec(String(entry));
      warnings.push(match ? `${nameOf(match[1])} ${match[2]}분반: ${match[3]} (서버에서 제외)` : `서버에서 제외: ${entry}`);
    });
    warnings.push(...plan.notes);
    for (const pin of plan.pins) {
      const before = candidates.length;
      candidates = candidates.filter(candidate => candidate.sections.every(entry => entry.courseId !== pin.courseId || pin.allowedIds.has(entry.sectionId)));
      const removed = before - candidates.length;
      if (!pin.sent) warnings.push(`${pin.name}: 분반 번호를 알 수 없어 허용 분반을 서버에 보내지 못하고 화면에서 걸렀어요. (서버 후보 ${before}개 중 ${removed}개 제외)`);
      else if (removed) warnings.push(`${pin.name}: 허용하지 않은 분반이 든 서버 후보 ${removed}개를 뺐어요.`);
    }
    const target = creditRange(conditions && conditions.credits);
    if (target) {
      const before = candidates.length;
      candidates = candidates.filter(candidate => (target.min === null || candidate.credits >= target.min) && (target.max === null || candidate.credits <= target.max));
      if (before !== candidates.length) warnings.push(`목표 ${creditLabel(target)}에 맞지 않는 서버 후보 ${before - candidates.length}개를 뺐어요.`);
    }
    const targetCount = conditions ? number(conditions.count) : null;
    if (Number.isInteger(targetCount) && targetCount > 0) {
      const before = candidates.length;
      candidates = candidates.filter(candidate => candidate.count === targetCount);
      if (before !== candidates.length) warnings.push(`과목 수 ${targetCount}개에 맞지 않는 서버 후보 ${before - candidates.length}개를 뺐어요.`);
    }
    const stopped = response['제한으로탐색중단'] === true;
    if (!serverCount && stopped) warnings.push('탐색 한도 안에서 조합을 찾지 못했어요. 과목이나 허용 분반을 줄이거나 조건을 느슨하게 해보세요.');
    return {
      engine: 'server',
      candidates,
      warnings,
      // 서버는 max_results 를 채워도 중단 표시를 보내므로, 요청한 수보다 적게 찾았을 때만 탐색 한도 안내를 띄웁니다.
      truncated: stopped && serverCount < plan.request.max_results,
      courseMap: resultMap,
      meta: { serverCount, kept: candidates.length, via, base, request: plan.request, checked: number(response['검사횟수']), sortNote: text(response['정렬기준']) }
    };
  }

  // 요청을 만들고 서버를 호출한 뒤 화면 형식으로 돌려줍니다. 서버에 닿지 못하면 예외를 던집니다.
  async function run({ courses, selection, conditions, dataset, signal, onStatus = () => {} }) {
    const cfg = config();
    const plan = buildRequest({ courses, selection, conditions, dataset, maxResults: cfg.generateMaxResults });
    const emptyResult = (warnings, extra) => ({
      engine: 'server', candidates: [], warnings, truncated: false,
      courseMap: new Map(courses.map(course => [course.id, course])),
      meta: { serverCount: 0, kept: 0, via: null, base: null, request: plan.request, ...extra }
    });
    if (plan.limitExceeded) {
      const error = new Error(`서버 생성은 한 번에 최대 ${LIMITS.courses}과목까지 보낼 수 있습니다.`);
      error.name = 'LimitError';
      throw error;
    }
    if (plan.unsatisfiable || !plan.request.courses.length) return emptyResult(plan.notes, { skipped: true });
    const timeoutMs = Number(cfg.requestTimeoutMs) > 0 ? Number(cfg.requestTimeoutMs) : 90000;
    const wakeAfterMs = Number(cfg.wakeNoticeAfterMs) > 0 ? Number(cfg.wakeNoticeAfterMs) : 6000;
    const failures = [];
    for (const target of root.CatalogAPI.targets()) {
      if (signal && signal.aborted) {
        const error = new Error('시간표 생성을 취소했습니다.');
        error.name = 'AbortError';
        throw error;
      }
      onStatus({ phase: 'connecting', target });
      try {
        const response = await root.CatalogAPI.fetchJSON(target, PATH, { method: 'POST', body: plan.request, signal, onStatus, timeoutMs, wakeAfterMs });
        return adapt({ response, plan, courses, conditions, via: target.kind, base: target.base });
      } catch (error) {
        if (error.name === 'AbortError' || (signal && signal.aborted)) throw error;
        // 422는 요청 자체가 거절된 것이라 다른 주소로 보내도 같습니다. 서버가 보낸 이유를 그대로 보여줍니다.
        if (error.name === 'HttpError' && error.status === 422) {
          const reason = (error.detail || '').replace(/^Value error,\s*/i, '').trim() || '요청 형식이 맞지 않아요.';
          return emptyResult([`서버가 요청을 받지 않았어요: ${reason}`, ...plan.notes], { via: target.kind, base: target.base, rejected: true });
        }
        failures.push(`${target.kind === 'proxy' ? '로컬 중계' : '백엔드'}: ${root.CatalogAPI.reasonOf(error)}`);
      }
    }
    const error = new Error(failures.join(' / ') || '시간표 생성 서버에 연결하지 못했습니다.');
    error.name = 'ServerError';
    throw error;
  }

  root.TimetableAPI = { LIMITS, PATH, available, buildRequest, adapt, run };
  if (typeof module === 'object' && module.exports) module.exports = root.TimetableAPI;
})(typeof window !== 'undefined' ? window : globalThis);
