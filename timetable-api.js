/* 시간표 후보 생성: 백엔드 POST /timetables/generate 호출과 화면 선택·조건의 변환.
   서버 API가 아직 받지 않는 조건(필수·후보 구분, 분반 고정, 목표 학점·과목 수)은 여기서 보완하고 그 사실을 안내문으로 남깁니다.
   실측한 서버 동작(2026-11-04): 보낸 과목을 모두 포함하는 조합만 찾고, 시간 미확인 분반은 제외하며, professor_filters 는 교수 이름 정확 일치입니다. */
(function (root) {
  'use strict';

  const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
  const WEEKDAYS = DAYS.slice(0, 5);
  const LIMITS = { courses: 10, results: 30 };

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

  // 화면의 선택·조건을 서버 요청으로 바꿉니다. 보낼 수 없는 조건은 notes 에 남깁니다.
  function buildRequest({ courses, selection, conditions, dataset, maxResults }) {
    const courseMap = new Map(courses.map(course => [course.id, course]));
    const notes = [];
    const sent = [];
    const pins = [];
    const codes = new Set();
    const professorFilters = {};
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
        notes.push(`${name}: 시간 미확인 분반뿐이라 서버 생성에서 뺐어요.${required ? ' 필수 과목이라 후보를 만들 수 없어요.' : ''}`);
        if (required) unsatisfiable = true;
        continue;
      }
      codes.add(code);
      if (!required) optional += 1;
      sent.push({ courseId: course.id, code, name, required });
      if (pinned) {
        // 고정한 분반이 한 교수의 분반 전부와 같으면 서버의 담당교수 조건으로 그대로 보낼 수 있습니다.
        const professors = [...new Set(allowed.map(section => text(section.professor)))];
        const professor = professors.length === 1 ? professors[0] : null;
        const sameProfessor = professor ? course.sections.filter(section => text(section.professor) === professor).map(section => section.id) : [];
        const allowedIds = new Set(allowed.map(section => section.id));
        const bridged = Boolean(professor) && sameProfessor.length === allowedIds.size && sameProfessor.every(id => allowedIds.has(id));
        if (bridged) professorFilters[code] = professor;
        pins.push({ courseId: course.id, name, allowedIds, bridged, professor });
      }
    }
    if (optional) notes.push(`서버는 아직 필수·후보 구분을 받지 않아 보낸 과목 ${sent.length}개를 모두 포함하는 조합만 찾아요. ‘후보’로 둔 ${optional}과목도 반드시 들어가요.`);
    const request = {};
    if (dataset && Number.isInteger(dataset.year) && Number.isInteger(dataset.semester)) {
      request.year = dataset.year;
      request.semester = dataset.semester;
    }
    request.course_codes = sent.map(item => item.code);
    request.blocked_times = (conditions && Array.isArray(conditions.blockedTimes) ? conditions.blockedTimes : []).filter(validMeeting).map(({ day, start, end }) => ({ day, start, end }));
    request.free_days = (conditions && Array.isArray(conditions.freeDays) ? conditions.freeDays : []).filter(day => DAYS.includes(day));
    request.professor_filters = professorFilters;
    request.max_results = Math.min(LIMITS.results, Math.max(1, Math.floor(number(maxResults) || LIMITS.results)));
    return { request, sent, pins, notes, unsatisfiable, limitExceeded: sent.length > LIMITS.courses };
  }

  // 서버 응답(조합)을 화면 후보 형식으로 바꾸고, 서버가 받지 못한 조건을 화면에서 거릅니다.
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
    (Array.isArray(response['후보없는과목']) ? response['후보없는과목'] : []).forEach(code => warnings.push(`${nameOf(code)}: 서버가 조건에 맞는 분반을 찾지 못했어요.`));
    (Array.isArray(response['시간미확인제외']) ? response['시간미확인제외'] : []).forEach(entry => {
      const match = /^(.+?)-([^:\s]+):\s*(.+)$/.exec(String(entry));
      warnings.push(match ? `${nameOf(match[1])} ${match[2]}분반: ${match[3]} (서버에서 제외)` : `서버에서 제외: ${entry}`);
    });
    warnings.push(...plan.notes);
    for (const pin of plan.pins) {
      const before = candidates.length;
      candidates = candidates.filter(candidate => candidate.sections.every(entry => entry.courseId !== pin.courseId || pin.allowedIds.has(entry.sectionId)));
      const removed = before - candidates.length;
      if (pin.bridged) warnings.push(`${pin.name}: 분반 고정을 담당교수(${pin.professor}) 조건으로 서버에 보냈어요.`);
      else warnings.push(`${pin.name}: 분반 고정은 서버가 아직 받지 않아 화면에서 걸렀어요. (서버 후보 ${before}개 중 ${removed}개 제외)`);
    }
    const targetCredits = conditions && number(conditions.credits);
    if (targetCredits !== null && targetCredits !== undefined) {
      const before = candidates.length;
      candidates = candidates.filter(candidate => candidate.credits === targetCredits);
      warnings.push(`목표 ${targetCredits}학점: 서버가 아직 받지 않아 화면에서 걸렀어요. (서버 후보 ${before}개 중 ${before - candidates.length}개 제외)`);
    }
    const targetCount = conditions && number(conditions.count);
    if (targetCount !== null && targetCount !== undefined) {
      const before = candidates.length;
      candidates = candidates.filter(candidate => candidate.count === targetCount);
      warnings.push(`과목 수 ${targetCount}개: 서버가 아직 받지 않아 화면에서 걸렀어요. 서버는 보낸 과목 ${plan.sent.length}개를 모두 포함해요. (${before - candidates.length}개 제외)`);
    }
    return {
      engine: 'server',
      candidates,
      warnings,
      truncated: response['제한으로탐색중단'] === true,
      courseMap: resultMap,
      meta: { serverCount, kept: candidates.length, via, base, request: plan.request, checked: number(response['검사횟수']), sortNote: text(response['정렬기준']) }
    };
  }

  // 요청을 만들고 서버를 호출한 뒤 화면 형식으로 돌려줍니다. 서버에 닿지 못하면 예외를 던집니다.
  async function run({ courses, selection, conditions, dataset, signal, onStatus = () => {} }) {
    const cfg = config();
    const plan = buildRequest({ courses, selection, conditions, dataset, maxResults: cfg.generateMaxResults });
    if (plan.limitExceeded) {
      const error = new Error(`서버 생성은 한 번에 최대 ${LIMITS.courses}과목까지 보낼 수 있습니다.`);
      error.name = 'LimitError';
      throw error;
    }
    if (plan.unsatisfiable || !plan.request.course_codes.length) {
      return {
        engine: 'server', candidates: [], warnings: plan.notes, truncated: false,
        courseMap: new Map(courses.map(course => [course.id, course])),
        meta: { serverCount: 0, kept: 0, via: null, base: null, request: plan.request, skipped: true }
      };
    }
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
        const response = await root.CatalogAPI.fetchJSON(target, '/timetables/generate', { method: 'POST', body: plan.request, signal, onStatus, timeoutMs, wakeAfterMs });
        return adapt({ response, plan, courses, conditions, via: target.kind, base: target.base });
      } catch (error) {
        if (error.name === 'AbortError' || (signal && signal.aborted)) throw error;
        // 422는 요청 자체가 거절된 것이라 다른 주소로 보내도 같습니다.
        if (error.name === 'HttpError' && error.status === 422) throw error;
        failures.push(`${target.kind === 'proxy' ? '로컬 중계' : '백엔드'}: ${root.CatalogAPI.reasonOf(error)}`);
      }
    }
    const error = new Error(failures.join(' / ') || '시간표 생성 서버에 연결하지 못했습니다.');
    error.name = 'ServerError';
    throw error;
  }

  root.TimetableAPI = { LIMITS, available, buildRequest, adapt, run };
  if (typeof module === 'object' && module.exports) module.exports = root.TimetableAPI;
})(typeof window !== 'undefined' ? window : globalThis);
