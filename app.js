/* 국립부경대학교 수강 플래너 (A안 화면 · 부경대 앱 톤)
   강의 목록·AI 대화·시간표 후보 생성은 실제 서버를 호출합니다.
   서버에 닿지 않거나 파일로 열면 후보 생성만 화면 미리보기 계산(preview-engine.js)으로 대신합니다. */
(() => {
  'use strict';

  // ---------- 공통 도우미 ----------
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
  const STATUS = { required: '필수', candidate: '후보', excluded: '제외' };
  const STORAGE_KEY = 'pknu-planner-b-v1';
  const LEGACY_STORAGE_KEYS = ['pknu-workspace-a-v1'];
  const PAGE_SIZE_PRESETS = [10, 20, 30, 50, 'all'];
  const DEFAULT_PAGE_SIZE = 20;
  const MAX_PAGE_SIZE = 500;
  const UNKNOWN = '미확인';
  const FILTER_FIELDS = ['category', 'mode', 'department', 'credits', 'grade'];
  const FILTER_LABELS = { category: '교과 구분', mode: '수업 방식', department: '개설학과', credits: '학점', grade: '수업 학년' };
  const CATEGORY_ORDER = ['전공공통', '전공필수', '전공선택', '필수교양', '균형교양', '교직필수', '자유선택'];
  const COLORS = [
    { bg: '#dcebfa', ink: '#1d4f8f' }, { bg: '#d9f2ec', ink: '#166a5a' }, { bg: '#ebe7fb', ink: '#4f45a8' },
    { bg: '#fdebdc', ink: '#9a5520' }, { bg: '#e0f1f6', ink: '#1f6b86' }, { bg: '#fbe4ec', ink: '#9b3a62' }
  ];
  const emptyFilters = () => ({ q: '', category: [], mode: [], department: [], credits: [], grade: [] });
  const emptyConditions = () => ({ credits: null, count: null, freeDays: [], blockedTimes: [] });
  const iconPaths = {
    search: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="m16 16 4.2 4.2"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.3 8a7.3 7.3 0 0 1 12-3L20 8M4 16l2.7 3a7.3 7.3 0 0 0 12-3"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    left: '<path d="m14.5 5-7 7 7 7"/>',
    right: '<path d="m9.5 5 7 7-7 7"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
    cart: '<path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.5"/><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="17" cy="20" r="1.4" fill="currentColor" stroke="none"/>',
    sparkle: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H4zM13 7a3 3 0 0 1 3-3h5v14h-5a3 3 0 0 0-3 3"/>',
    chat: '<path d="M20 11.5a8 8 0 0 1-8 8H4l1.6-4A8 8 0 1 1 20 11.5Z"/><path d="M8 10h8M8 14h5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18M8 15h3M14 15h2M8 18h3"/>'
  };
  const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
  const time = value => Number.isFinite(value) ? `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : UNKNOWN;
  const minute = value => { const match = /^(\d{2}):(\d{2})$/.exec(value); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
  const validMeeting = meeting => DAYS.includes(meeting.day) && Number.isInteger(meeting.start) && Number.isInteger(meeting.end) && meeting.start >= 0 && meeting.end <= 1440 && meeting.end > meeting.start;
  const uniqueText = values => [...new Set(values.filter(value => value !== null && value !== undefined && String(value).trim() !== '').map(String))];
  const gradeKey = value => value === null || value === undefined || String(value).trim() === '' ? UNKNOWN : String(value).trim().replace(/학년$/, '').trim();
  const now = () => new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date());

  // ---------- 상태 ----------
  const state = {
    courses: [], courseMap: new Map(), dataset: null, source: null,
    selection: new Map(), checked: new Set(),
    filters: emptyFilters(), page: 1, pageSize: DEFAULT_PAGE_SIZE, showAdded: false,
    view: 'catalog', loading: true, loadStatus: null, error: null,
    conditions: emptyConditions(), resultConditions: emptyConditions(), revision: 0, resultRevision: -1,
    candidates: [], activeCandidate: 0, generated: false, generating: false, generationWarnings: [], truncated: false, resultCourseMap: new Map(),
    resultEngine: null, resultMeta: null, generatingEngine: null, generateStatus: null, semesters: [], semesterChoice: null,
    chatCollapsed: window.innerWidth < 1366, selectionCollapsed: false, messages: [], lastAIChange: null, chatPending: false, chatSource: null, chatFailure: null
  };
  const filterControls = {};
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved) for (const key of LEGACY_STORAGE_KEYS) { const legacy = JSON.parse(localStorage.getItem(key) || 'null'); if (legacy) { saved = legacy; break; } }
  } catch (_) { saved = null; }
  if (saved && saved.ui && typeof saved.ui === 'object') {
    state.showAdded = saved.ui.showAdded === true;
    state.pageSize = normalizePageSize(saved.ui.pageSize);
    state.semesterChoice = normalizeSemester(saved.ui.semester);
  }
  let toastTimer;
  let popoverState = null;
  let conditionsDraft = null;
  let loadController = null;

  function normalizePageSize(value) {
    if (value === 'all') return 'all';
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= MAX_PAGE_SIZE ? number : DEFAULT_PAGE_SIZE;
  }
  function normalizeSemester(value) {
    if (!value || typeof value !== 'object') return null;
    const year = Number(value.year);
    const semester = Number(value.semester);
    return Number.isInteger(year) && year >= 2000 && year <= 2100 && Number.isInteger(semester) && semester >= 1 && semester <= 4 ? { year, semester } : null;
  }
  // 후보 생성 방식: 기본은 백엔드 서버. 파일로 열었거나 설정이 browser면 화면 미리보기 계산.
  function engineFor() {
    const cfg = window.PKNU_CONFIG || {};
    return cfg.generateMode !== 'browser' && window.TimetableAPI.available() ? 'server' : 'browser';
  }
  const ENGINE_LABELS = { server: '서버 계산', browser: '화면 미리보기 계산', 'browser-fallback': '화면 계산 · 서버 연결 실패' };
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ datasetId: state.dataset?.id, selection: selectedStatus(), conditions: state.conditions, ui: { showAdded: state.showAdded, pageSize: state.pageSize, semester: state.semesterChoice } }));
    } catch (_) {}
  }
  function sanitizeConditions(value) {
    const result = emptyConditions();
    if (!value || typeof value !== 'object') return result;
    if (Number.isInteger(value.credits) && value.credits > 0 && value.credits <= 40) result.credits = value.credits;
    if (Number.isInteger(value.count) && value.count > 0 && value.count <= 15) result.count = value.count;
    if (Array.isArray(value.freeDays)) result.freeDays = [...new Set(value.freeDays.filter(day => DAYS.includes(day)))];
    if (Array.isArray(value.blockedTimes)) {
      result.blockedTimes = value.blockedTimes
        .filter(block => block && typeof block === 'object' && validMeeting(block))
        .map((block, index) => ({ id: String(block.id || `block-${index}-${Date.now()}`), day: block.day, start: block.start, end: block.end }));
    }
    return result;
  }
  const isStale = () => state.generated && state.resultRevision !== state.revision;
  function invalidate({ fromAI = false } = {}) {
    state.revision += 1;
    if (!fromAI) state.lastAIChange = null;
    save();
    renderSelection();
    renderResults();
    renderChat();
  }

  // ---------- 과목·분반 도우미 ----------
  const selectedStatus = () => [...state.selection.values()];
  const getCourse = id => state.courseMap.get(id);
  const allowedSections = (course, selected) => !selected || selected.allowedSectionIds === null ? course.sections : course.sections.filter(section => selected.allowedSectionIds.includes(section.id));
  const rangeCredits = sections => { const values = sections.map(section => section.credits).filter(Number.isFinite); return values.length ? [Math.min(...values), Math.max(...values)] : null; };
  function creditText(course, selected) {
    const range = rangeCredits(allowedSections(course, selected));
    return range ? (range[0] === range[1] ? String(range[0]) : `${range[0]}–${range[1]}`) : UNKNOWN;
  }
  const creditLabel = (course, selected) => { const text = creditText(course, selected); return text === UNKNOWN ? '학점 미확인' : `${text}학점`; };
  function sectionSummary(course, selected) {
    if (!selected || selected.allowedSectionIds === null) return '분반: 전체 허용';
    const numbers = allowedSections(course, selected).map(section => section.number);
    if (!numbers.length) return '분반 다시 선택';
    if (numbers.length === 1) return `${numbers[0]}분반 고정`;
    if (numbers.length <= 3) return `${numbers.join('·')}분반 중 1개`;
    return `${numbers.length}개 분반 중 1개`;
  }
  const meetingText = section => section.meetings.length ? section.meetings.map(m => `${m.day || '요일 미확인'} ${time(m.start)}–${time(m.end)}`).join(' · ') : '수업시간 미확인';
  function colorFor(id) { let hash = 0; for (const letter of id) hash = (hash * 31 + letter.charCodeAt(0)) | 0; return COLORS[Math.abs(hash) % COLORS.length]; }
  function filterValue(section, key) {
    if (key === 'category') return section.categoryRaw || UNKNOWN;
    if (key === 'mode') return section.modeRaw || UNKNOWN;
    if (key === 'department') return section.department || UNKNOWN;
    if (key === 'credits') return Number.isFinite(section.credits) ? String(section.credits) : UNKNOWN;
    if (key === 'grade') return gradeKey(section.grade);
    return UNKNOWN;
  }
  // 학년 "0"은 학년 구분이 없는 전학년 수업입니다.
  const gradeLabelOf = value => value === UNKNOWN ? UNKNOWN : value === '0' ? '전학년' : `${value}학년`;
  const gradeRank = value => value === UNKNOWN ? 99 : value === '0' ? 50 : Number(value) || 60;
  const optionLabel = (key, value) => value === UNKNOWN ? UNKNOWN : key === 'credits' ? `${value}학점` : key === 'grade' ? gradeLabelOf(value) : value;
  const hasFilters = () => Boolean(state.filters.q.trim() || FILTER_FIELDS.some(key => state.filters[key].length));
  const tagClass = category => category === '전공필수' ? 'tag-req' : /^전공/.test(category) ? 'tag-major' : 'tag-gen';

  // ---------- 필터 ----------
  function closeFilters() { Object.values(filterControls).forEach(control => control.close()); }
  function initFilters() {
    FILTER_FIELDS.forEach(key => {
      filterControls[key] = new window.SearchMultiSelect($(`${key}-filter`), {
        id: `${key}-filter-input`, label: FILTER_LABELS[key], placeholder: `${FILTER_LABELS[key]} 전체`, options: [], selected: [],
        onChange(values) { state.filters[key] = values; state.page = 1; closePopover(false); renderCatalog(); }
      });
    });
  }
  function populateFilters() {
    const sections = state.courses.flatMap(course => course.sections);
    FILTER_FIELDS.forEach(key => {
      const values = uniqueText(sections.map(section => filterValue(section, key)));
      values.sort((a, b) => {
        if (a === UNKNOWN) return 1;
        if (b === UNKNOWN) return -1;
        if (key === 'grade') return gradeRank(a) - gradeRank(b);
        if (key === 'credits') return a.localeCompare(b, 'ko', { numeric: true });
        if (key === 'category') {
          const ai = CATEGORY_ORDER.indexOf(a), bi = CATEGORY_ORDER.indexOf(b);
          if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        }
        return a.localeCompare(b, 'ko');
      });
      let options = values.map(value => ({ value, label: optionLabel(key, value) }));
      const noGrades = key === 'grade' && !values.some(value => value !== UNKNOWN);
      if (noGrades) options = [...['1', '2', '3', '4'].map(value => ({ value, label: `${value}학년`, disabled: true })), ...options];
      filterControls[key].setOptions(options);
      filterControls[key].setNotice(noGrades ? '현재 자료에 수업 학년이 없어 미확인으로 표시합니다.' : key === 'grade' ? '학년이 없는 분반은 미확인으로 표시합니다.' : '');
      filterControls[key].setSelected(state.filters[key], { silent: true });
      state.filters[key] = filterControls[key].getSelected();
    });
  }
  function resetFilters() {
    closeFilters();
    state.filters = emptyFilters();
    state.page = 1;
    $('course-search').value = '';
    Object.values(filterControls).forEach(control => control.setSelected([], { silent: true }));
    renderCatalog();
  }

  // ---------- 전체 과목 ----------
  function matchesFilters(course) {
    const q = state.filters.q.trim().toLocaleLowerCase();
    const courseMatches = !q || `${course.name} ${course.code}`.toLocaleLowerCase().includes(q);
    return course.sections.some(section => (courseMatches || (section.professor || '').toLocaleLowerCase().includes(q))
      && FILTER_FIELDS.every(key => !state.filters[key].length || state.filters[key].includes(filterValue(section, key))));
  }
  const filteredCourses = () => state.courses.filter(course => (state.showAdded || !state.selection.has(course.id)) && matchesFilters(course));
  const hiddenAddedCount = () => state.showAdded ? 0 : state.courses.filter(course => state.selection.has(course.id) && matchesFilters(course)).length;
  const pageCount = total => state.pageSize === 'all' ? 1 : Math.max(1, Math.ceil(total / state.pageSize));
  function pageCourses() {
    const list = filteredCourses();
    if (state.pageSize === 'all') return list;
    return list.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  }
  function setPageSize(value) {
    state.pageSize = normalizePageSize(value);
    state.page = 1;
    save();
    renderCatalog();
    $('catalog-table-wrap').scrollTop = 0;
  }
  function renderPageSize() {
    $('page-size-options').innerHTML = PAGE_SIZE_PRESETS.map(size => {
      const active = String(state.pageSize) === String(size);
      return `<button type="button" data-page-size="${size}" class="${active ? 'active' : ''}" aria-pressed="${active}">${size === 'all' ? '전체' : size}</button>`;
    }).join('');
    const input = $('page-size-input');
    const custom = state.pageSize !== 'all' && !PAGE_SIZE_PRESETS.includes(state.pageSize);
    if (document.activeElement !== input) input.value = custom ? String(state.pageSize) : '';
  }
  function renderCatalogState() {
    const box = $('catalog-state');
    const filtered = filteredCourses();
    if (state.loading) {
      const waking = state.loadStatus && state.loadStatus.phase === 'waking';
      box.hidden = false;
      box.innerHTML = `<span class="spinner"></span><strong>${waking ? '서버를 깨우는 중이에요.' : '강의 목록을 불러오고 있어요.'}</strong><p>${waking ? '잠든 서버가 깨어나는 데 1분 정도 걸릴 수 있어요.<br>기다리기 어려우면 저장된 목록으로 먼저 볼 수 있어요.' : '서버에서 이번 학기 강의 목록을 받고 있어요.'}</p>${waking ? '<div class="state-actions"><button class="button secondary small" data-action="use-snapshot">저장된 목록으로 먼저 보기</button></div>' : ''}`;
      $('catalog-table-wrap').hidden = true;
      return;
    }
    if (state.error) {
      box.hidden = false;
      box.innerHTML = `${icon('book', 26)}<strong>강의 목록을 불러오지 못했어요.</strong><p>${esc(state.error)}</p><div class="state-actions"><button class="button primary small" data-action="retry-load">다시 시도</button><button class="button secondary small" data-action="use-snapshot">저장된 목록 보기</button></div>`;
      $('catalog-table-wrap').hidden = true;
      return;
    }
    if (!filtered.length) {
      const hidden = hiddenAddedCount();
      box.hidden = false;
      box.innerHTML = `${icon('search', 26)}<strong>${hidden && !hasFilters() ? '남은 과목이 없어요.' : '찾는 과목이 없어요.'}</strong><p>${hidden ? `담은 과목 ${hidden}개는 목록에서 숨겼어요.` : '검색어나 필터를 바꿔보세요.'}</p><div class="state-actions">${hasFilters() ? '<button class="button secondary small" data-action="reset-filters">필터 초기화</button>' : ''}${hidden ? '<button class="button secondary small" data-action="show-added">담은 과목도 보기</button>' : ''}</div>`;
      $('catalog-table-wrap').hidden = true;
      return;
    }
    box.hidden = true;
    $('catalog-table-wrap').hidden = false;
  }
  function renderBatch() {
    const page = pageCourses().filter(course => !state.selection.has(course.id));
    $('check-page').checked = page.length > 0 && page.every(course => state.checked.has(course.id));
    $('check-page').indeterminate = page.some(course => state.checked.has(course.id)) && !$('check-page').checked;
    $('check-page').disabled = !page.length;
    const count = state.checked.size;
    $('batch-add').disabled = count === 0 || state.loading;
    $('batch-add').textContent = count ? `선택 ${count}개 담기` : '선택한 과목 담기';
  }
  function courseRow(course) {
    const added = state.selection.has(course.id);
    const categories = uniqueText(course.sections.map(section => section.categoryRaw || UNKNOWN));
    const modes = uniqueText(course.sections.map(section => section.modeRaw || UNKNOWN));
    const grades = uniqueText(course.sections.map(section => gradeKey(section.grade))).sort((a, b) => gradeRank(a) - gradeRank(b));
    const gradeHtml = grades.map(value => value === UNKNOWN ? '<span class="grade-unknown" title="학년 정보가 없는 분반이 있어요.">미확인</span>' : esc(gradeLabelOf(value))).join(' · ');
    const professors = uniqueText(course.sections.map(section => section.professor));
    const unknownProfessor = course.sections.some(section => !section.professor);
    const professorHtml = professors.length
      ? `<span class="professor-list">${professors.slice(0, 2).map(professor => `<span>${esc(professor)}</span>`).join('')}${professors.length > 2 ? `<button class="professor-more" data-detail-course="${esc(course.id)}" aria-label="${esc(course.name)} 담당교수 전체 보기">외 ${professors.length - 2}명 보기</button>` : ''}${unknownProfessor ? '<span class="professor-unknown">미확인 포함</span>' : ''}</span>`
      : '<span class="professor-unknown">미확인</span>';
    const departments = course.departments.length ? course.departments.slice(0, 2).join(' · ') + (course.departments.length > 2 ? ` 외 ${course.departments.length - 2}개 학과` : '') : '개설학과 미확인';
    const unknownTime = course.sections.every(section => section.timeStatus !== 'KNOWN');
    return `<tr class="course-row ${added ? 'is-added' : ''}" data-course-row="${esc(course.id)}">
      <td class="check-column"><input type="checkbox" data-check-course="${esc(course.id)}" aria-label="${esc(course.name)} 선택" ${added ? 'disabled' : ''} ${state.checked.has(course.id) ? 'checked' : ''}></td>
      <td class="course-cell"><button class="course-name" data-detail-course="${esc(course.id)}">${esc(course.name)}</button><span class="course-sub" title="${esc(course.departments.join(' · '))}">${esc(course.code)} · ${esc(departments)} · 분반 ${course.sections.length}개</span>${unknownTime ? '<span class="time-unresolved">수업시간 미확인</span>' : ''}</td>
      <td class="nw">${categories.map(category => `<span class="tag ${tagClass(category)}">${esc(category)}</span>`).join('')}</td>
      <td class="nw credit-cell"><span class="credit-text">${esc(creditText(course))}</span><span class="mode-text">${esc(modes.join('·'))}</span></td>
      <td class="nw">${gradeHtml}</td>
      <td class="professor-cell">${professorHtml}</td>
      <td class="nw col-sections"><button class="section-count" data-sections-course="${esc(course.id)}" aria-label="${esc(course.name)} 분반 설정">${course.sections.length}개 <span aria-hidden="true">▾</span></button></td>
      <td class="add-column">${added ? `<span class="added-mark">${icon('check', 15)} 담음</span>` : `<button class="add-course" data-add-course="${esc(course.id)}" aria-label="${esc(course.name)} 담기">담기</button>`}</td>
    </tr>`;
  }
  function renderCatalog() {
    const filtered = filteredCourses();
    const pages = pageCount(filtered.length);
    state.page = Math.min(Math.max(1, state.page), pages);
    const page = pageCourses();
    const hidden = hiddenAddedCount();
    $('total-course-count').textContent = state.loading ? '—' : `${filtered.length.toLocaleString()}개`;
    const from = filtered.length ? (state.pageSize === 'all' ? 1 : (state.page - 1) * state.pageSize + 1) : 0;
    const to = state.pageSize === 'all' ? filtered.length : Math.min(filtered.length, state.page * state.pageSize);
    const hiddenNote = hidden ? ` · 담은 과목 ${hidden}개는 숨김` : '';
    $('catalog-description').textContent = state.loading ? '서버에서 강의 목록을 받고 있어요.'
      : hasFilters() ? `조건에 맞는 과목 ${filtered.length.toLocaleString()}개 중 ${from}–${to}${hiddenNote}`
        : `${state.courses.length.toLocaleString()}과목 · ${(state.dataset?.sectionCount || 0).toLocaleString()}분반 중 ${from}–${to}${hiddenNote}`;
    renderCatalogState();
    $('course-rows').innerHTML = page.map(courseRow).join('');
    $('page-indicator').textContent = `${state.page} / ${pages}`;
    $('previous-page').disabled = state.page <= 1;
    $('next-page').disabled = state.page >= pages;
    $('reset-filters').hidden = !hasFilters();
    $('active-filters').hidden = !FILTER_FIELDS.some(key => state.filters[key].length);
    $('active-filters').textContent = FILTER_FIELDS.filter(key => state.filters[key].length).map(key => {
      const values = state.filters[key];
      return `${FILTER_LABELS[key]}: ${values.slice(0, 2).map(value => optionLabel(key, value)).join('·')}${values.length > 2 ? ` 외 ${values.length - 2}개` : ''}`;
    }).join(' / ');
    renderPageSize();
    renderBatch();
  }
  function addCourse(id, { quiet = false } = {}) {
    if (state.selection.has(id) || !getCourse(id)) return;
    state.selection.set(id, { courseId: id, status: 'candidate', allowedSectionIds: null });
    state.checked.delete(id);
    closePopover(false);
    invalidate();
    renderCatalog();
    if (!quiet) toast(`${getCourse(id).name}을(를) 담았어요.`);
  }
  function removeCourse(id) {
    const course = getCourse(id);
    closePopover(false);
    state.selection.delete(id);
    invalidate();
    renderCatalog();
    toast(`${course?.name || '과목'}을(를) 목록에서 뺐어요. 전체 과목에 다시 보여요.`);
  }

  // ---------- 선택한 과목 ----------
  function selectionCredits() {
    let sum = 0;
    let unknown = false;
    selectedStatus().filter(selected => selected.status !== 'excluded').forEach(selected => {
      const course = getCourse(selected.courseId);
      const range = course ? rangeCredits(allowedSections(course, selected)) : null;
      if (range) sum += range[0]; else unknown = true;
    });
    return { sum, unknown };
  }
  function renderSelection() {
    const selections = selectedStatus();
    const counts = { candidate: 0, required: 0, excluded: 0 };
    selections.forEach(selected => { counts[selected.status] += 1; });
    $('selected-count').textContent = selections.length;
    $('selection-rail-count').textContent = selections.length;
    $('selection-summary').textContent = selections.length ? `필수 ${counts.required} · 후보 ${counts.candidate} · 제외 ${counts.excluded}` : '관심 있는 과목을 담아보세요.';
    const credits = selectionCredits();
    $('selection-brief').innerHTML = selections.length ? `담은 과목 <b>${selections.length}과목 · ${credits.sum}학점${credits.unknown ? '+' : ''}</b>` : '담은 과목 없음';
    const list = $('selected-list');
    const previousScroll = list.scrollTop;
    list.innerHTML = selections.length ? selections.map(selected => {
      const course = getCourse(selected.courseId);
      const professors = uniqueText(allowedSections(course, selected).map(section => section.professor));
      const professorText = professors.length ? (professors.length > 2 ? `${professors[0]} 외 ${professors.length - 1}명` : professors.join('·')) : '교수 미확인';
      const fixed = selected.allowedSectionIds !== null;
      return `<article class="selected-course ${selected.status === 'excluded' ? 'is-excluded' : ''}">
        <div class="selected-top"><button class="selected-name" data-detail-course="${esc(course.id)}">${esc(course.name)}</button><button class="remove-course" data-remove-course="${esc(course.id)}" aria-label="${esc(course.name)} 제거">${icon('close', 16)}</button></div>
        <div class="selected-meta">${esc(course.code)} · ${esc(creditLabel(course, selected))} · ${esc(professorText)}</div>
        <div class="selected-actions">
          <div class="seg" role="group" aria-label="${esc(course.name)} 포함 상태">${Object.entries(STATUS).map(([value, label]) => `<button type="button" class="${selected.status === value ? 'on' : ''}" data-status-course="${esc(course.id)}" data-status="${value}" aria-pressed="${selected.status === value}">${label}</button>`).join('')}</div>
          <button class="sec-chip ${fixed ? 'fixed' : ''}" data-sections-course="${esc(course.id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(course.name)} ${esc(sectionSummary(course, selected))}, 분반 설정">${esc(sectionSummary(course, selected))} <span aria-hidden="true">▾</span></button>
        </div>
      </article>`;
    }).join('') : `<div class="empty-selection"><div class="empty-symbol">${icon('book', 26)}</div><strong>어떤 수업이 듣고 싶나요?</strong><p>왼쪽 목록에서 과목을 담으면<br>이곳에서 분반과 조건을 정할 수 있어요.</p><button class="text-button" data-action="load-example">예시 과목으로 체험하기 →</button></div>`;
    list.scrollTop = previousScroll;
    const active = selections.filter(selected => selected.status !== 'excluded').length;
    const stale = isStale();
    $('generate').disabled = state.loading || state.generating || !active;
    $('generate').innerHTML = state.generating ? '<span class="spinner"></span> 후보 만드는 중…' : state.generated ? '후보 다시 만들기' : '시간표 후보 만들기';
    $('generate-note').textContent = engineFor() === 'server'
      ? `백엔드 서버가 후보를 계산해요. 한 번에 ${window.TimetableAPI.LIMITS.courses}과목까지 보낼 수 있어요.`
      : window.TimetableAPI.available() ? '설정에 따라 화면 미리보기 계산으로 만들어요.' : '서버 없이 열어서 화면 미리보기 계산으로 만들어요.';
    $('selection-stale').hidden = !stale;
    $('stale-dot').hidden = !stale;
    renderConditionSummary();
  }
  function conditionLabels(conditions) {
    const labels = [];
    if (conditions.credits !== null) labels.push(`${conditions.credits}학점`);
    if (conditions.count !== null) labels.push(`${conditions.count}과목`);
    if (conditions.freeDays.length) labels.push(`${conditions.freeDays.join('·')}요일 공강`);
    conditions.blockedTimes.forEach(block => labels.push(`${block.day} ${time(block.start)}–${time(block.end)} 제외`));
    return labels;
  }
  function renderConditionSummary() {
    const labels = conditionLabels(state.conditions);
    $('condition-summary').innerHTML = labels.length ? labels.map(label => `<span class="condition-chip">${esc(label)}</span>`).join('') : '<p class="condition-summary-line">학점·과목 수 제한 없이 가능한 시간표를 살펴봐요.</p>';
  }

  // ---------- 분반 선택창 ----------
  function closePopover(restoreFocus = true) {
    if (!popoverState) return;
    const anchor = popoverState.anchor;
    anchor?.setAttribute('aria-expanded', 'false');
    $('section-popover').hidden = true;
    $('section-popover').innerHTML = '';
    popoverState = null;
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }
  function openPopover(id, anchor) {
    if (popoverState?.id === id && popoverState.anchor === anchor) { closePopover(); return; }
    closePopover(false);
    closeFilters();
    const course = getCourse(id);
    if (!course) return;
    const selected = state.selection.get(id);
    const draft = allowedSections(course, selected).map(section => section.id);
    popoverState = { id, anchor, draft };
    anchor.setAttribute('aria-expanded', 'true');
    $('section-popover').innerHTML = `<div class="popover-heading"><div><span class="eyebrow">분반 설정</span><h3 id="section-popover-title">${esc(course.name)}</h3></div><button class="all-sections-button" data-popover-action="all">전체 허용</button></div>
      <p class="popover-hint">체크한 분반 중 하나만 시간표에 들어가요.</p>
      <div class="popover-options">${course.sections.map(section => `<label class="section-option ${draft.includes(section.id) ? 'is-selected' : ''}"><input type="checkbox" value="${esc(section.id)}" ${draft.includes(section.id) ? 'checked' : ''}><span class="section-option-body"><span class="section-option-top"><strong>${esc(section.number)}분반</strong><span class="section-option-professor">${esc(section.professor || '교수 미확인')}</span><span class="section-credit">${Number.isFinite(section.credits) ? `${section.credits}학점` : '학점 미확인'}</span></span><span class="section-option-times">${esc(meetingText(section))}</span><span class="section-option-note">${esc([section.categoryRaw || '구분 미확인', section.modeRaw || '방식 미확인', gradeKey(section.grade) === UNKNOWN ? '학년 미확인' : gradeLabelOf(gradeKey(section.grade)), section.timeStatus !== 'KNOWN' ? '시간 확인 필요' : null].filter(Boolean).join(' · '))}</span></span></label>`).join('')}</div>
      <div class="popover-validation" id="popover-validation" aria-live="polite"></div>
      <div class="popover-actions"><button class="button secondary small" data-popover-action="cancel">취소</button><button class="button primary small" data-popover-action="apply">${selected ? '적용' : '이 설정으로 담기'}</button></div>`;
    $('section-popover').hidden = false;
    updatePopoverValidation();
    positionPopover();
    $('section-popover').querySelector('input')?.focus({ preventScroll: true });
  }
  function positionPopover() {
    if (!popoverState) return;
    const popover = $('section-popover');
    const rect = popoverState.anchor.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 32);
    popover.style.width = `${width}px`;
    const left = Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16));
    const height = popover.getBoundingClientRect().height;
    const top = Math.max(16, Math.min(rect.bottom + 9, window.innerHeight - height - 16));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }
  function updatePopoverValidation() {
    if (!popoverState) return;
    const checked = [...$('section-popover').querySelectorAll('input:checked')].map(input => input.value);
    popoverState.draft = checked;
    $('section-popover').querySelectorAll('.section-option').forEach(label => label.classList.toggle('is-selected', label.querySelector('input').checked));
    const message = $('popover-validation');
    message.textContent = checked.length ? `${checked.length}개 분반 허용` : '분반을 하나 이상 선택해주세요.';
    message.classList.toggle('invalid', !checked.length);
    message.setAttribute('role', checked.length ? 'status' : 'alert');
    $('section-popover').querySelector('[data-popover-action="apply"]').disabled = !checked.length;
  }
  function applyPopover() {
    if (!popoverState?.draft.length) return;
    const { id, draft } = popoverState;
    const course = getCourse(id);
    const previous = state.selection.get(id);
    const selected = { courseId: id, status: previous?.status || 'candidate', allowedSectionIds: draft.length === course.sections.length ? null : [...draft] };
    closePopover(false);
    state.selection.set(id, selected);
    state.checked.delete(id);
    invalidate();
    renderCatalog();
    toast(`${course.name} · ${sectionSummary(course, selected)}`);
  }

  // ---------- 조건 편집 ----------
  function openConditions() {
    closePopover(false);
    closeFilters();
    conditionsDraft = clone(state.conditions);
    $('condition-credits').value = conditionsDraft.credits ?? '';
    $('condition-count').value = conditionsDraft.count ?? '';
    $('blocked-error').hidden = true;
    renderConditionEditor();
    $('conditions-dialog').showModal();
  }
  function renderConditionEditor() {
    $('free-day-choices').innerHTML = DAYS.map(day => `<label class="day-choice"><input type="checkbox" value="${day}" ${conditionsDraft.freeDays.includes(day) ? 'checked' : ''}><span>${day}</span></label>`).join('');
    const blocks = [...conditionsDraft.blockedTimes].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start);
    $('blocked-table').hidden = !blocks.length;
    $('blocked-empty').hidden = Boolean(blocks.length);
    $('blocked-list').innerHTML = blocks.map(block => `<tr><td>${esc(block.day)}요일</td><td>${time(block.start)}</td><td>${time(block.end)}</td><td><button type="button" class="icon-button" data-remove-block="${esc(block.id)}" aria-label="${esc(block.day)}요일 ${time(block.start)}–${time(block.end)} 제외 시간 삭제">${icon('close', 16)}</button></td></tr>`).join('');
  }
  function addBlockedTime() {
    const block = { id: `block-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, day: $('blocked-day').value, start: minute($('blocked-start').value), end: minute($('blocked-end').value) };
    if (!validMeeting(block)) { $('blocked-error').textContent = '종료 시각은 시작 시각보다 늦어야 해요.'; $('blocked-error').hidden = false; return; }
    if (conditionsDraft.blockedTimes.some(item => item.day === block.day && item.start === block.start && item.end === block.end)) { $('blocked-error').textContent = '이미 등록한 시간이에요.'; $('blocked-error').hidden = false; return; }
    $('blocked-error').hidden = true;
    conditionsDraft.blockedTimes.push(block);
    renderConditionEditor();
  }
  function applyConditions(event) {
    event.preventDefault();
    const credits = $('condition-credits').value;
    const count = $('condition-count').value;
    conditionsDraft.credits = credits === '' ? null : Number(credits);
    conditionsDraft.count = count === '' ? null : Number(count);
    conditionsDraft.freeDays = [...$('free-day-choices').querySelectorAll('input:checked')].map(input => input.value);
    const next = sanitizeConditions(conditionsDraft);
    const changed = JSON.stringify(next) !== JSON.stringify(state.conditions);
    state.conditions = next;
    $('conditions-dialog').close();
    if (changed) { invalidate(); toast(state.generated ? '조건을 저장했어요. 후보 다시 만들기를 누르면 반영돼요.' : '조건을 저장했어요.'); }
  }

  // ---------- 시간표 후보 ----------
  function candidateSections(candidate) {
    return candidate.sections.map(item => {
      const course = state.resultCourseMap.get(item.courseId);
      const section = course?.sections.find(entry => entry.id === item.sectionId);
      return course && section ? { course, section } : null;
    }).filter(Boolean);
  }
  function calendarLayout(candidate, conditions) {
    const details = candidateSections(candidate);
    const meetings = details.flatMap(({ course, section }) => section.meetings.filter(validMeeting).map(meeting => ({ ...meeting, course, section })));
    const weekend = meetings.some(meeting => meeting.day === '토' || meeting.day === '일') || conditions.freeDays.some(day => day === '토' || day === '일') || conditions.blockedTimes.some(block => block.day === '토' || block.day === '일');
    const days = weekend ? DAYS : DAYS.slice(0, 5);
    const rangeStart = Math.min(9 * 60, ...meetings.map(m => Math.floor(m.start / 60) * 60), ...conditions.blockedTimes.map(m => Math.floor(m.start / 60) * 60));
    const rangeEnd = Math.max(18 * 60, ...meetings.map(m => Math.ceil(m.end / 60) * 60), ...conditions.blockedTimes.map(m => Math.ceil(m.end / 60) * 60));
    return { details, meetings, weekend, days, rangeStart, rangeEnd };
  }
  const resultSummaryText = candidate => `${candidate.credits}학점 · ${candidate.count}과목${candidate.freeDays?.length ? ` · ${candidate.freeDays.join('·')}요일 공강` : ''} · 수업 사이 대기 ${candidate.gapMinutes}분`;
  function timetableModel() {
    if (!state.candidates.length || state.generating) return null;
    const candidate = state.candidates[state.activeCandidate];
    const conditions = state.resultConditions;
    const layout = calendarLayout(candidate, conditions);
    const semester = state.dataset ? `${state.dataset.year || '—'}년 ${state.dataset.semester || '—'}학기` : '';
    const blocks = layout.days.flatMap(day => conditions.freeDays.includes(day) ? [{ day, start: layout.rangeStart, end: layout.rangeEnd, label: '공강' }] : conditions.blockedTimes.filter(block => block.day === day));
    return {
      title: `${semester} 시간표 후보 ${state.activeCandidate + 1}`.trim(),
      subtitle: resultSummaryText(candidate),
      footnote: `국립부경대학교 수강 플래너 · ${new Date().toLocaleDateString('ko-KR')} 기준`,
      days: layout.days, rangeStart: layout.rangeStart, rangeEnd: layout.rangeEnd,
      meetings: layout.meetings.map(meeting => ({ day: meeting.day, start: meeting.start, end: meeting.end, name: meeting.course.name, section: meeting.section.number, room: meeting.room, color: colorFor(meeting.course.id).bg, ink: colorFor(meeting.course.id).ink })),
      blocks,
      courses: layout.details.map(({ course, section }) => ({ name: course.name, color: colorFor(course.id).bg, detail: [`${section.number}분반`, section.professor || '교수 미확인', Number.isFinite(section.credits) ? `${section.credits}학점` : null, meetingText(section)].filter(Boolean).join(' · ') }))
    };
  }
  function renderEngineTag() {
    const tag = $('engine-tag');
    const engine = state.generating ? state.generatingEngine : state.generated ? state.resultEngine : engineFor();
    tag.textContent = ENGINE_LABELS[engine] || ENGINE_LABELS.browser;
    tag.classList.toggle('is-server', engine === 'server');
    tag.classList.toggle('is-warning', engine === 'browser-fallback');
  }
  function renderReasons() {
    const items = [...state.generationWarnings];
    if (state.truncated) items.push(`${state.resultEngine === 'server' ? '서버가 ' : ''}탐색 범위 안에서 찾은 후보예요. 과목이나 허용 분반을 줄이면 더 정확해져요.`);
    const box = $('reasons');
    if (!state.generated || state.generating || !items.length) { box.hidden = true; box.open = false; return; }
    box.hidden = false;
    $('reasons-title').textContent = state.resultEngine === 'server' ? '서버 생성 안내와 제외된 분반' : '제외된 분반과 이유';
    $('reasons-count').textContent = `${items.length}건`;
    $('reasons-list').innerHTML = items.map(item => {
      // "과목명: 이유" 꼴만 굵은 머리말로 나눕니다. 문장 뒤에 괄호로 붙은 세부 이유의 콜론은 건드리지 않습니다.
      const match = /^([^:.]{1,40}):\s*(.+)$/.exec(item);
      return match ? `<li><b>${esc(match[1])}</b> · ${esc(match[2])}</li>` : `<li>${esc(item)}</li>`;
    }).join('');
  }
  function renderResults() {
    $('candidate-count').textContent = state.candidates.length;
    const stale = isStale();
    $('stale-notice').hidden = !stale;
    $('stale-dot').hidden = !stale;
    $('regenerate-inline').disabled = state.generating;
    $('candidate-tabs').innerHTML = state.candidates.map((candidate, index) => `<button class="candidate-button ${index === state.activeCandidate ? 'active' : ''}" data-candidate="${index}" aria-pressed="${index === state.activeCandidate}">후보 ${index + 1}<span>${candidate.credits}학점 · ${candidate.count}과목</span></button>`).join('');
    $('candidate-tabs').hidden = !state.candidates.length;
    const canExport = state.candidates.length > 0 && !state.generating;
    $('export-png').disabled = !canExport;
    $('export-pdf').disabled = !canExport;
    renderReasons();
    renderEngineTag();
    const empty = $('calendar-empty');
    if (state.generating) {
      const server = state.generatingEngine === 'server';
      const waking = server && state.generateStatus && state.generateStatus.phase === 'waking';
      empty.hidden = false;
      empty.innerHTML = `<span class="spinner large"></span><h3>${waking ? '잠든 서버를 깨우는 중이에요.' : server ? '서버가 가능한 시간표를 찾고 있어요.' : '가능한 시간표를 살펴보고 있어요.'}</h3><p>${waking ? '잠든 서버가 깨어나는 데 1분 정도 걸릴 수 있어요.<br>깨어나면 바로 후보를 받아와요.' : server ? '담은 과목과 시간 조건을 백엔드 서버에 보냈어요.' : '선택한 분반과 시간 조건을 확인하는 중이에요.'}</p>`;
      $('calendar-scroll').hidden = true;
      $('calendar-footer').hidden = true;
      $('result-summary').textContent = '선택한 과목과 조건으로 후보를 만들고 있어요.';
      return;
    }
    if (!state.candidates.length) {
      empty.hidden = false;
      $('calendar-scroll').hidden = true;
      $('calendar-footer').hidden = true;
      const serverEmpty = state.generated && state.resultEngine === 'server';
      const removed = serverEmpty && state.resultMeta ? state.resultMeta.serverCount - state.resultMeta.kept : 0;
      const hint = !state.generated ? '관심 있는 과목을 담고<br>‘시간표 후보 만들기’를 눌러보세요.'
        : removed ? `서버가 찾은 후보 ${removed}개는 분반 고정이나 목표 조건에 맞지 않아 뺐어요.<br>아래 안내를 확인하고 조건을 조정해보세요.`
          : '필수 과목의 시간이나 허용 분반을 확인하고,<br>학점·공강 조건을 조금 조정해보세요.';
      empty.innerHTML = `<div class="empty-symbol">${icon('calendar', 26)}</div><h3>${state.generated ? '조건에 맞는 후보가 없어요.' : '아직 그려진 시간표가 없어요.'}</h3><p>${hint}</p><div class="empty-actions"><button class="button secondary" data-action="${state.generated ? 'edit-conditions' : 'browse'}">${state.generated ? '조건 살펴보기' : '과목 살펴보기'}</button>${serverEmpty ? '<button class="button secondary" data-action="generate-browser">화면 계산으로 만들어 보기</button>' : ''}</div>`;
      $('result-summary').textContent = state.generated ? '선택한 과목과 조건을 조금 바꿔보세요.' : '선택한 과목으로 이번 학기의 모양을 확인해보세요.';
      return;
    }
    empty.hidden = true;
    $('calendar-scroll').hidden = false;
    $('calendar-footer').hidden = false;
    state.activeCandidate = Math.min(state.activeCandidate, state.candidates.length - 1);
    const candidate = state.candidates[state.activeCandidate];
    const conditions = state.resultConditions;
    const { meetings, weekend, days, rangeStart, rangeEnd } = calendarLayout(candidate, conditions);
    $('result-summary').textContent = resultSummaryText(candidate);
    const hourHeight = 60;
    const height = (rangeEnd - rangeStart) / 60 * hourHeight;
    const labels = [];
    for (let value = rangeStart; value < rangeEnd; value += 60) labels.push(`<span class="calendar-hour-label" style="top:${(value - rangeStart) / 60 * hourHeight}px">${time(value)}</span>`);
    const calendar = $('calendar');
    calendar.style.setProperty('--days', days.length);
    calendar.style.setProperty('--hour-height', `${hourHeight}px`);
    calendar.innerHTML = `<div class="calendar-header"><div class="calendar-time-head"></div>${days.map(day => `<div class="calendar-day-label">${day}</div>`).join('')}</div><div class="calendar-body" style="height:${height}px"><div class="calendar-time-column">${labels.join('')}</div>${days.map(day => {
      const dayMeetings = meetings.filter(meeting => meeting.day === day);
      const blocked = conditions.freeDays.includes(day) ? [{ start: rangeStart, end: rangeEnd, label: '공강' }] : conditions.blockedTimes.filter(block => block.day === day);
      return `<div class="calendar-day">${Array.from({ length: (rangeEnd - rangeStart) / 60 }, (_, index) => `<div class="calendar-hour-line" style="top:${index * hourHeight}px"></div>`).join('')}${blocked.map(block => `<div class="calendar-block" style="top:${(block.start - rangeStart) / 60 * hourHeight}px;height:${(block.end - block.start) / 60 * hourHeight}px"><span>${esc(block.label || '수업 제외')}</span></div>`).join('')}${!dayMeetings.length && !blocked.length ? '<span class="empty-day-label">공강</span>' : ''}${dayMeetings.map(meeting => {
        const color = colorFor(meeting.course.id);
        return `<button class="calendar-event" data-detail-course="${esc(meeting.course.id)}" data-detail-section="${esc(meeting.section.id)}" data-detail-source="result" style="top:${(meeting.start - rangeStart) / 60 * hourHeight + 2}px;height:${Math.max(24, (meeting.end - meeting.start) / 60 * hourHeight - 4)}px;--event-bg:${color.bg};--event-ink:${color.ink}" title="${esc(`${meeting.course.name} ${meeting.section.number}분반 · ${meeting.section.professor || '교수 미확인'} · ${meeting.day} ${time(meeting.start)}–${time(meeting.end)}`)}"><span class="event-name">${esc(meeting.course.name)}</span><span class="event-time">${time(meeting.start)}–${time(meeting.end)}</span>${meeting.end - meeting.start >= 90 ? `<span class="event-room">${esc(meeting.section.number)}분반${meeting.room ? ` · ${esc(meeting.room)}` : ''}</span>` : ''}</button>`;
      }).join('')}</div>`;
    }).join('')}</div>`;
    $('calendar-range').textContent = `${weekend ? '월–일' : '월–금'} · ${time(rangeStart)}–${time(rangeEnd)}`;
  }
  async function generateInBrowser({ courses, selection, conditions }) {
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = await window.PreviewEngine.generate({ courses, selection, conditions, maxResults: 8, maxChecks: 30000 });
    return { engine: 'browser', candidates: result.candidates, warnings: result.warnings, truncated: result.truncated, courseMap: new Map(courses.map(course => [course.id, course])), meta: null };
  }
  // 서버 생성이 기본입니다. 서버에 닿지 못하면 같은 입력으로 화면 미리보기 계산을 대신 씁니다.
  async function generate({ engine = engineFor() } = {}) {
    const active = selectedStatus().filter(selected => selected.status !== 'excluded');
    if (state.generating || !active.length) return;
    const limit = engine === 'server' ? window.TimetableAPI.LIMITS.courses : 15;
    if (active.length > limit) {
      toast(engine === 'server' ? `서버 생성은 한 번에 최대 ${limit}과목까지 보낼 수 있어요. 과목을 빼거나 ‘제외’로 바꿔주세요.` : `미리보기에서는 최대 ${limit}과목까지 조합할 수 있어요.`);
      return;
    }
    closePopover(false);
    state.generating = true;
    state.generatingEngine = engine;
    state.generateStatus = null;
    state.generationWarnings = [];
    setView('timetable');
    renderSelection();
    renderResults();
    const revision = state.revision;
    const selection = clone(selectedStatus());
    const conditions = clone(state.conditions);
    const courses = state.courses;
    const input = { courses, selection, conditions, dataset: state.dataset };
    try {
      let result;
      if (engine === 'server') {
        try {
          result = await window.TimetableAPI.run({ ...input, onStatus: status => { state.generateStatus = status; renderResults(); } });
        } catch (error) {
          console.warn('서버 생성 실패, 화면 미리보기 계산으로 대신합니다.', error);
          result = await generateInBrowser(input);
          result.engine = 'browser-fallback';
          result.warnings = [`서버 생성에 실패해 화면 미리보기 계산으로 대신 만들었어요. (${window.CatalogAPI.reasonOf(error)})`, ...result.warnings];
        }
      } else {
        result = await generateInBrowser(input);
      }
      state.candidates = result.candidates;
      state.activeCandidate = 0;
      state.generated = true;
      state.resultRevision = revision;
      state.resultConditions = conditions;
      state.resultEngine = result.engine;
      state.resultMeta = result.meta || null;
      state.generationWarnings = result.warnings;
      state.truncated = result.truncated;
      state.resultCourseMap = result.courseMap;
    } catch (error) {
      state.candidates = [];
      state.generated = true;
      state.resultRevision = revision;
      state.resultEngine = engine;
      state.resultMeta = null;
      state.generationWarnings = ['후보를 만들지 못했어요. 잠시 후 다시 시도해주세요.'];
      console.error(error);
    } finally {
      state.generating = false;
      state.generateStatus = null;
      renderSelection();
      renderResults();
    }
  }
  async function exportPNG() {
    const model = timetableModel();
    if (!model) return;
    try {
      const blob = await window.TimetableExport.toPNG(model, { scale: 2 });
      window.TimetableExport.download(blob, `부경대_시간표_후보${state.activeCandidate + 1}.png`);
      toast('시간표 이미지를 저장했어요.');
    } catch (error) {
      console.error(error);
      toast('이미지를 만들지 못했어요. 잠시 후 다시 시도해주세요.');
    }
  }
  function exportPDF() {
    const model = timetableModel();
    if (!model) return;
    closePopover(false);
    window.TimetableExport.print(model, $('calendar'));
  }

  // ---------- 화면 전환·패널 ----------
  function setView(view) {
    closePopover(false);
    closeFilters();
    state.view = view;
    $('catalog-view').hidden = view !== 'catalog';
    $('timetable-view').hidden = view !== 'timetable';
    $('catalog-tab').classList.toggle('active', view === 'catalog');
    $('timetable-tab').classList.toggle('active', view === 'timetable');
    $('catalog-tab').setAttribute('aria-pressed', String(view === 'catalog'));
    $('timetable-tab').setAttribute('aria-pressed', String(view === 'timetable'));
    if (view === 'timetable') renderResults();
  }
  function renderPanels() {
    $('workspace').classList.toggle('chat-collapsed', state.chatCollapsed);
    $('workspace').classList.toggle('selection-collapsed', state.selectionCollapsed);
    $('chat-content').hidden = state.chatCollapsed;
    $('expand-chat').hidden = !state.chatCollapsed;
    $('selection-content').hidden = state.selectionCollapsed;
    $('expand-selection').hidden = !state.selectionCollapsed;
    closePopover(false);
    closeFilters();
  }

  // ---------- 과목 상세 ----------
  function showDetail(id, sectionId, fromResult = false) {
    closePopover(false);
    const course = fromResult ? state.resultCourseMap.get(id) : getCourse(id);
    if (!course) return;
    const sections = sectionId ? course.sections.filter(section => section.id === sectionId) : course.sections;
    $('detail-content').innerHTML = `<div class="modal-heading"><div><span class="eyebrow">${esc(course.code)} · ${esc(creditLabel(course))}</span><h2 id="detail-title">${esc(course.name)}</h2></div><button class="icon-button" data-close-dialog="detail-dialog" aria-label="과목 정보 닫기">${icon('close', 20)}</button></div>
      <div class="modal-body"><p class="notice-text">${course.sections.length}개 분반 중 하나를 수강해요. 담은 뒤 분반을 설정할 수 있어요.</p>${sections.map(section => `<section class="detail-section"><div class="detail-heading"><h3>${esc(section.number)}분반 <span>${esc(section.professor || '교수 미확인')}</span></h3><span>${Number.isFinite(section.credits) ? section.credits + '학점' : '학점 미확인'}</span></div><dl class="detail-grid"><dt>교과 구분</dt><dd>${esc(section.categoryRaw || UNKNOWN)}</dd><dt>수업 방식</dt><dd>${esc(section.modeRaw || UNKNOWN)}</dd><dt>수업 학년</dt><dd>${esc(gradeLabelOf(gradeKey(section.grade)))}</dd><dt>개설학과</dt><dd>${esc(section.department || UNKNOWN)}</dd><dt>수업시간</dt><dd class="detail-meetings">${section.meetings.length ? section.meetings.map(meeting => `<span>${esc(meeting.day || '요일 미확인')} ${time(meeting.start)}–${time(meeting.end)}<small>${esc(meeting.room || '강의실 미확인')}</small></span>`).join('') : UNKNOWN}</dd></dl>${section.warnings.length ? `<p class="notice-text">${esc(section.warnings.join(' · '))}</p>` : ''}</section>`).join('')}</div>
      <div class="modal-footer"><span></span><button class="button ${state.selection.has(id) ? 'secondary' : 'primary'}" data-detail-add="${esc(id)}">${state.selection.has(id) ? '닫기' : '과목 담기'}</button></div>`;
    $('detail-dialog').showModal();
  }
  function seedExample() {
    if (!state.courses.length) return;
    const preferred = ['자료구조', '컴퓨터네트워크', '소프트웨어공학', '데이터베이스', '인공지능', '대학영어', '경영정보론', '글쓰기'];
    const pool = [...new Set(preferred.map(name => state.courses.find(course => course.name.includes(name) && course.sections.some(section => section.timeStatus === 'KNOWN'))).filter(Boolean))];
    state.courses.filter(course => course.sections.some(section => section.timeStatus === 'KNOWN')).slice(0, 20).forEach(course => { if (!pool.includes(course)) pool.push(course); });
    const occupied = [];
    const picks = [];
    for (const course of pool) {
      const section = course.sections.find(entry => entry.timeStatus === 'KNOWN' && entry.meetings.length && entry.meetings.every(validMeeting) && entry.meetings.every(meeting => occupied.every(old => old.day !== meeting.day || old.end <= meeting.start || old.start >= meeting.end)));
      if (section) { picks.push(course); occupied.push(...section.meetings); }
      if (picks.length === 6) break;
    }
    closePopover(false);
    const wasEmpty = state.selection.size === 0;
    let added = 0;
    picks.forEach(course => {
      if (!state.selection.has(course.id)) { state.selection.set(course.id, { courseId: course.id, status: wasEmpty && added === 0 ? 'required' : 'candidate', allowedSectionIds: null }); added += 1; }
    });
    state.checked.clear();
    invalidate();
    renderCatalog();
    toast(added ? `실제 강의 목록에서 예시 ${added}과목을 담았어요. 기존 선택과 조건은 유지돼요.` : '예시 과목이 이미 담겨 있어요.');
  }

  // ---------- AI 도우미 ----------
  function localChatRules(text, current) {
    const conditions = clone(current);
    let summary = null;
    let reply;
    if (/초기화|조건.*없애|조건.*지워/.test(text)) {
      Object.assign(conditions, emptyConditions());
      summary = '시간표 조건 초기화';
      reply = '시간표 조건을 초기화했어요.';
    } else {
      const creditMatch = text.match(/(\d{1,2})\s*학점/);
      const day = DAYS.find(value => text.includes(value + '요일'));
      if (creditMatch && Number(creditMatch[1]) > 0 && Number(creditMatch[1]) <= 40) {
        conditions.credits = Number(creditMatch[1]);
        summary = `목표 ${conditions.credits}학점`;
        reply = `목표 학점을 ${conditions.credits}학점으로 바꿨어요.`;
      } else if (day && /오전/.test(text)) {
        if (!conditions.blockedTimes.some(item => item.day === day && item.start === 540 && item.end === 720)) conditions.blockedTimes.push({ id: `ai-${Date.now()}`, day, start: 540, end: 720 });
        summary = `${day}요일 09:00–12:00 제외`;
        reply = `${day}요일 오전 09:00–12:00을 제외 시간에 넣었어요.`;
      } else if (day && /공강|비워|쉬고/.test(text)) {
        if (!conditions.freeDays.includes(day)) conditions.freeDays.push(day);
        summary = `${day}요일 공강`;
        reply = `${day}요일을 공강으로 설정했어요.`;
      } else {
        reply = '“목요일 오전은 비워줘”, “금요일은 공강으로”, “18학점으로 맞춰줘”처럼 말해 보세요.';
      }
    }
    return { reply, summary, updatedConditions: conditions, source: 'local' };
  }
  function describeConditionChange(before, after) {
    const parts = [];
    if (before.credits !== after.credits) parts.push(after.credits === null ? '목표 학점 해제' : `목표 ${after.credits}학점`);
    if (before.count !== after.count) parts.push(after.count === null ? '과목 수 제한 해제' : `${after.count}과목`);
    const addedDays = after.freeDays.filter(day => !before.freeDays.includes(day));
    const removedDays = before.freeDays.filter(day => !after.freeDays.includes(day));
    if (addedDays.length) parts.push(`${addedDays.join('·')}요일 공강`);
    if (removedDays.length) parts.push(`${removedDays.join('·')}요일 공강 해제`);
    const key = block => `${block.day}-${block.start}-${block.end}`;
    const beforeKeys = new Set(before.blockedTimes.map(key));
    const afterKeys = new Set(after.blockedTimes.map(key));
    after.blockedTimes.filter(block => !beforeKeys.has(key(block))).forEach(block => parts.push(`${block.day} ${time(block.start)}–${time(block.end)} 제외`));
    before.blockedTimes.filter(block => !afterKeys.has(key(block))).forEach(block => parts.push(`${block.day} ${time(block.start)}–${time(block.end)} 제외 해제`));
    return parts.join(' · ') || '조건 변경';
  }
  const sourceLabel = source => source === 'local' ? '예시 규칙' : source === 'fallback' ? '서버 기본 규칙' : source && source !== 'server' ? `AI · ${source}` : 'AI 서버';
  function renderChatStatus() {
    const status = $('chat-status');
    let text;
    let warning = false;
    if (!window.ChatAPI.available()) text = '서버로 실행하면 AI 챗봇에 연결돼요. 지금은 예시 규칙으로 답해요.';
    else if (state.chatFailure === 'error') { text = 'AI 서버에 연결하지 못해 예시 규칙으로 답했어요.'; warning = true; }
    else if (state.chatSource === 'fallback') { text = 'AI 서버가 LLM 없이 기본 규칙으로 답하고 있어요.'; warning = true; }
    else if (state.chatSource) text = `AI 서버 연결됨 · ${state.chatSource}`;
    else text = '공강, 피하고 싶은 시간, 목표 학점을 말로 요청할 수 있어요.';
    status.textContent = text;
    status.classList.toggle('is-warning', warning);
  }
  function renderChat() {
    const welcome = `<div class="assistant-welcome"><div class="assistant-mark">${icon('sparkle', 20)}</div><strong>어떤 한 학기를 원하세요?</strong><p>공강이나 피하고 싶은 시간을 말해 보세요.<br>바뀐 조건은 가운데 ‘선택한 과목’에서 바로 확인할 수 있어요.</p></div>`;
    const bubbles = state.messages.map(message => `<div class="bubble ${message.role}"><p class="bubble-copy">${esc(message.text).replace(/\n/g, '<br>')}</p><span class="chat-time">${esc(message.time)}${message.role === 'assistant' && message.source ? `<span class="chat-source">· ${esc(sourceLabel(message.source))}</span>` : ''}</span></div>`).join('');
    const pending = state.chatPending ? '<div class="bubble assistant pending"><p class="bubble-copy">생각하는 중…</p></div>' : '';
    const change = state.lastAIChange ? `<div class="ai-change"><span class="ai-change-title">변경한 조건</span><span class="ai-change-summary">${esc(state.lastAIChange.summary)}</span><button class="undo-change" data-action="undo-ai">되돌리기</button></div>` : '';
    $('chat-messages').innerHTML = (state.messages.length ? '' : welcome) + bubbles + pending + change;
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
    $('chat-send').disabled = state.chatPending;
    renderChatStatus();
  }
  async function sendChat(text) {
    text = String(text || '').trim();
    if (!text || state.chatPending) return;
    $('chat-input').value = '';
    state.messages.push({ role: 'user', text, time: now() });
    state.chatPending = true;
    renderChat();
    const before = clone(state.conditions);
    const history = state.messages.slice(-11, -1).map(message => ({ role: message.role, text: message.text }));
    let result;
    let failure = null;
    try {
      result = await window.ChatAPI.send({ message: text, conditions: before, history });
    } catch (error) {
      failure = error;
      result = localChatRules(text, before);
    }
    const next = sanitizeConditions(result.updatedConditions || before);
    const changed = JSON.stringify(next) !== JSON.stringify(before);
    let reply = result.reply;
    if (changed) {
      state.conditions = next;
      invalidate({ fromAI: true });
      state.lastAIChange = { before, summary: result.summary || describeConditionChange(before, next), revision: state.revision };
      if (!/다시 만들기/.test(reply)) reply += ' 후보 다시 만들기를 누르면 반영돼요.';
    }
    state.chatSource = result.source;
    state.chatFailure = failure ? (failure.name === 'UnavailableError' ? 'unavailable' : 'error') : null;
    state.messages.push({ role: 'assistant', text: reply, time: now(), source: result.source });
    state.chatPending = false;
    renderChat();
  }

  // ---------- 강의 목록 불러오기 ----------
  function formatStamp(iso, live) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return live ? '서버 목록' : '저장된 목록';
    if (live) return `서버 ${new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(date)} 기준`;
    return `저장본 ${new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(date)} 기준`;
  }
  function applyCatalog(result) {
    const hadDataset = Boolean(state.dataset);
    const previous = hadDataset ? selectedStatus() : saved?.selection;
    state.courses = result.courses;
    state.courseMap = new Map(state.courses.map(course => [course.id, course]));
    state.dataset = result.dataset;
    state.source = result.source;
    state.selection.clear();
    let removed = 0;
    if (Array.isArray(previous)) previous.forEach(selected => {
      const course = getCourse(selected.courseId);
      if (!course) { removed += 1; return; }
      const allowed = selected.allowedSectionIds === null ? null : Array.isArray(selected.allowedSectionIds) ? selected.allowedSectionIds.filter(id => course.sections.some(section => section.id === id)) : null;
      state.selection.set(course.id, { courseId: course.id, status: STATUS[selected.status] ? selected.status : 'candidate', allowedSectionIds: allowed && allowed.length ? allowed : null });
    });
    if (saved && !state.generated && state.revision === 0) state.conditions = sanitizeConditions(saved.conditions);
    saved = null;
    state.checked.clear();
    if (hadDataset) state.revision += 1;
    populateFilters();
    const year = result.dataset.year || '—';
    const term = result.dataset.semester || '—';
    const live = result.source === 'live';
    state.semesters = Array.isArray(result.semesters) ? result.semesters : [];
    if (Number.isInteger(result.dataset.year) && Number.isInteger(result.dataset.semester)) state.semesterChoice = { year: result.dataset.year, semester: result.dataset.semester };
    $('semester-heading').textContent = `${year}학년도 ${term}학기`;
    renderSemesterSelect();
    $('dataset-label').textContent = live ? `서버 강의 목록${result.via === 'proxy' ? ' (로컬 중계)' : ''}` : '저장된 강의 목록';
    $('dataset-label').classList.toggle('is-live', live);
    $('source-footer').innerHTML = `<b>${esc(year)}년 ${esc(term)}학기</b> 개설강좌 ${result.dataset.sectionCount.toLocaleString()}분반 · ${state.courses.length.toLocaleString()}과목 · ${esc(formatStamp(result.fetchedAt, live))}`;
    $('source-notice').hidden = !result.notice;
    $('source-notice').textContent = result.notice || '';
    if (removed) toast(`현재 자료에 없는 ${removed}개 과목을 선택 목록에서 뺐어요.`);
    save();
  }
  // 서버가 학기를 2개 이상 제공할 때만 선택 목록을 보여줍니다. 하나뿐이면 학기 표시만 둡니다.
  function renderSemesterSelect() {
    const select = $('semester-select');
    const list = state.semesters;
    const current = state.dataset ? `${state.dataset.year}-${state.dataset.semester}` : '';
    if (state.source !== 'live' || list.length < 2) { select.hidden = true; $('semester-heading').hidden = false; return; }
    select.innerHTML = list.map(item => `<option value="${item.year}-${item.semester}" ${`${item.year}-${item.semester}` === current ? 'selected' : ''}>${item.year}학년도 ${item.semester}학기</option>`).join('');
    select.hidden = false;
    $('semester-heading').hidden = true;
  }
  async function loadCatalog(options = {}) {
    loadController?.abort();
    loadController = new AbortController();
    const controller = loadController;
    state.loading = true;
    state.error = null;
    state.loadStatus = null;
    renderCatalog();
    renderSelection();
    $('reload-catalog').disabled = true;
    $('semester-select').disabled = true;
    $('dataset-label').textContent = '강의 목록 불러오는 중';
    $('dataset-label').classList.remove('is-live');
    try {
      const result = await window.CatalogAPI.load({
        source: options.source || 'auto',
        semester: options.semester || state.semesterChoice,
        signal: controller.signal,
        onStatus: status => { if (controller !== loadController) return; state.loadStatus = status; renderCatalogState(); }
      });
      if (controller !== loadController) return;
      applyCatalog(result);
    } catch (error) {
      if (error.name === 'AbortError') return;
      state.error = error.message || '잠시 후 다시 시도해주세요.';
      $('dataset-label').textContent = '강의 목록 연결 실패';
    } finally {
      if (controller === loadController) {
        state.loading = false;
        state.loadStatus = null;
        $('reload-catalog').disabled = false;
        $('semester-select').disabled = false;
        renderCatalog();
        renderSelection();
        renderResults();
      }
    }
  }

  // ---------- 초기화와 이벤트 ----------
  $('search-icon').innerHTML = icon('search');
  $('reload-catalog').innerHTML = icon('refresh', 20);
  $('previous-page').innerHTML = icon('left', 16);
  $('next-page').innerHTML = icon('right', 16);
  $('collapse-selection').innerHTML = icon('right');
  $('collapse-chat').innerHTML = icon('right');
  $('selection-rail-icon').innerHTML = icon('cart');
  $('chat-rail-icon').innerHTML = icon('sparkle');
  $('catalog-tile').innerHTML = icon('list', 22);
  $('timetable-tile').innerHTML = icon('calendar', 22);
  $('selection-tile').innerHTML = icon('cart', 22);
  $('chat-tile').innerHTML = icon('sparkle', 22);
  $('show-added').checked = state.showAdded;

  $('catalog-tab').addEventListener('click', () => setView('catalog'));
  $('timetable-tab').addEventListener('click', () => setView('timetable'));
  $('back-to-courses').addEventListener('click', () => setView('catalog'));
  $('reload-catalog').addEventListener('click', () => loadCatalog());
  $('load-example').addEventListener('click', seedExample);
  $('generate').addEventListener('click', () => generate());
  $('regenerate-inline').addEventListener('click', () => generate());
  $('semester-select').addEventListener('change', event => {
    const [year, semester] = event.target.value.split('-').map(Number);
    state.semesterChoice = normalizeSemester({ year, semester });
    save();
    loadCatalog({ semester: state.semesterChoice });
  });
  $('export-png').addEventListener('click', exportPNG);
  $('export-pdf').addEventListener('click', exportPDF);
  $('edit-conditions').addEventListener('click', openConditions);
  $('collapse-selection').addEventListener('click', () => { state.selectionCollapsed = true; renderPanels(); });
  $('expand-selection').addEventListener('click', () => { state.selectionCollapsed = false; renderPanels(); });
  $('collapse-chat').addEventListener('click', () => { state.chatCollapsed = true; renderPanels(); });
  $('expand-chat').addEventListener('click', () => { state.chatCollapsed = false; renderPanels(); });
  $('show-added').addEventListener('change', event => { state.showAdded = event.target.checked; state.page = 1; save(); renderCatalog(); });
  $('course-search').addEventListener('input', event => { state.filters.q = event.target.value; state.page = 1; renderCatalog(); });
  $('reset-filters').addEventListener('click', resetFilters);
  $('previous-page').addEventListener('click', () => { state.page -= 1; renderCatalog(); $('catalog-table-wrap').scrollTop = 0; });
  $('next-page').addEventListener('click', () => { state.page += 1; renderCatalog(); $('catalog-table-wrap').scrollTop = 0; });
  $('page-size-options').addEventListener('click', event => { const button = event.target.closest('[data-page-size]'); if (button) setPageSize(button.dataset.pageSize); });
  $('page-size-input').addEventListener('change', event => {
    const raw = event.target.value.trim();
    if (raw === '') { renderPageSize(); return; }
    const clamped = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(raw)) || 1));
    if (String(clamped) !== raw) toast(`페이지당 과목 수는 1~${MAX_PAGE_SIZE} 사이로 맞췄어요.`);
    setPageSize(clamped);
  });
  $('page-size-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.target.blur(); } });
  $('check-page').addEventListener('change', event => {
    pageCourses().filter(course => !state.selection.has(course.id)).forEach(course => (event.target.checked ? state.checked.add(course.id) : state.checked.delete(course.id)));
    renderCatalog();
  });
  $('batch-add').addEventListener('click', () => {
    const ids = [...state.checked];
    ids.forEach(id => { if (getCourse(id) && !state.selection.has(id)) state.selection.set(id, { courseId: id, status: 'candidate', allowedSectionIds: null }); });
    state.checked.clear();
    invalidate();
    renderCatalog();
    toast(`${ids.length}개 과목을 담았어요.`);
  });
  $('section-popover').addEventListener('change', updatePopoverValidation);
  $('section-popover').addEventListener('click', event => {
    const action = event.target.closest('[data-popover-action]')?.dataset.popoverAction;
    if (action === 'cancel') closePopover();
    else if (action === 'apply') applyPopover();
    else if (action === 'all') { $('section-popover').querySelectorAll('input').forEach(input => { input.checked = true; }); updatePopoverValidation(); }
  });
  $('section-popover').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closePopover(); } });
  $('conditions-form').addEventListener('submit', applyConditions);
  $('free-day-choices').addEventListener('change', () => { conditionsDraft.freeDays = [...$('free-day-choices').querySelectorAll('input:checked')].map(input => input.value); });
  $('add-blocked').addEventListener('click', addBlockedTime);
  $('reset-conditions').addEventListener('click', () => { conditionsDraft = emptyConditions(); $('condition-credits').value = ''; $('condition-count').value = ''; $('blocked-error').hidden = true; renderConditionEditor(); });
  $('chat-form').addEventListener('submit', event => { event.preventDefault(); sendChat($('chat-input').value); });
  $('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat($('chat-input').value); } });
  document.addEventListener('change', event => {
    const check = event.target.closest('[data-check-course]');
    if (check) { if (check.checked) state.checked.add(check.dataset.checkCourse); else state.checked.delete(check.dataset.checkCourse); renderBatch(); }
  });
  document.addEventListener('click', event => {
    const add = event.target.closest('[data-add-course]');
    if (add) addCourse(add.dataset.addCourse);
    const remove = event.target.closest('[data-remove-course]');
    if (remove) removeCourse(remove.dataset.removeCourse);
    const status = event.target.closest('[data-status-course][data-status]');
    if (status) {
      const selected = state.selection.get(status.dataset.statusCourse);
      if (selected && selected.status !== status.dataset.status) { selected.status = status.dataset.status; closePopover(false); invalidate(); }
    }
    const sections = event.target.closest('[data-sections-course]');
    if (sections) { openPopover(sections.dataset.sectionsCourse, sections); return; }
    const detail = event.target.closest('[data-detail-course]');
    if (detail) showDetail(detail.dataset.detailCourse, detail.dataset.detailSection, detail.dataset.detailSource === 'result');
    const close = event.target.closest('[data-close-dialog]');
    if (close) $(close.dataset.closeDialog).close();
    const detailAdd = event.target.closest('[data-detail-add]');
    if (detailAdd) { if (!state.selection.has(detailAdd.dataset.detailAdd)) addCourse(detailAdd.dataset.detailAdd); $('detail-dialog').close(); }
    const candidate = event.target.closest('[data-candidate]');
    if (candidate) { state.activeCandidate = Number(candidate.dataset.candidate); renderResults(); }
    const removeBlock = event.target.closest('[data-remove-block]');
    if (removeBlock) { conditionsDraft.blockedTimes = conditionsDraft.blockedTimes.filter(block => block.id !== removeBlock.dataset.removeBlock); renderConditionEditor(); }
    const prompt = event.target.closest('[data-prompt]');
    if (prompt) sendChat(prompt.dataset.prompt);
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'load-example') seedExample();
    else if (action === 'browse') setView('catalog');
    else if (action === 'edit-conditions') openConditions();
    else if (action === 'reset-filters') resetFilters();
    else if (action === 'retry-load') loadCatalog();
    else if (action === 'use-snapshot') loadCatalog({ source: 'snapshot' });
    else if (action === 'generate-browser') generate({ engine: 'browser' });
    else if (action === 'show-added') { state.showAdded = true; $('show-added').checked = true; save(); renderCatalog(); }
    else if (action === 'undo-ai' && state.lastAIChange) { state.conditions = clone(state.lastAIChange.before); state.lastAIChange = null; invalidate(); toast('AI가 바꾼 조건을 되돌렸어요.'); }
    if (popoverState && !event.target.closest('#section-popover')) closePopover(false);
  });
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && popoverState) closePopover(); });
  window.addEventListener('resize', () => positionPopover());
  document.addEventListener('scroll', event => { if (popoverState && !$('section-popover').contains(event.target)) positionPopover(); }, true);

  initFilters();
  renderPanels();
  renderChat();
  renderSelection();
  renderResults();
  loadCatalog();
})();
