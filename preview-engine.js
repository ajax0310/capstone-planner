/*
 * A안 프론트엔드 체험용 미리보기 엔진입니다.
 * 실제 서버의 시간표 생성 알고리즘/API 구현이나 검증을 대체하지 않습니다.
 * 브라우저: await window.PreviewEngine.generate(input)
 * Node: const { generate } = require('./preview-engine.js')
 */
(function (root) {
  'use strict';

  const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
  const WEEKDAYS = DAYS.slice(0, 5);
  const EPSILON = 1e-7;

  function identifier(value) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function validMeeting(meeting) {
    return meeting && DAYS.includes(meeting.day)
      && Number.isInteger(meeting.start) && Number.isInteger(meeting.end)
      && meeting.start >= 0 && meeting.end <= 1440
      && meeting.start < meeting.end;
  }

  // 반개방 구간: 10:00~11:00 다음 11:00~12:00 수업은 충돌하지 않습니다.
  function overlap(left, right) {
    return left.day === right.day && left.start < right.end && right.start < left.end;
  }

  function clashes(meetings, occupied) {
    return meetings.some(meeting => occupied.some(other => overlap(meeting, other)));
  }

  function gapMinutes(meetings) {
    let gap = 0;
    for (const day of DAYS) {
      const slots = meetings.filter(meeting => meeting.day === day)
        .sort((left, right) => left.start - right.start);
      for (let index = 1; index < slots.length; index += 1) {
        gap += slots[index].start - slots[index - 1].end;
      }
    }
    return gap;
  }

  function compareCandidates(left, right) {
    // 동점은 발견 순서를 유지합니다. ID 정렬로 앞 분반만 결과를 독점하지 않습니다.
    return right.count - left.count || left.gapMinutes - right.gapMinutes;
  }

  function integerLimit(value, fallback, upperBound) {
    return finiteNumber(value) && value >= 1
      ? Math.min(Math.floor(value), upperBound) : fallback;
  }

  async function generate(input) {
    const config = input && typeof input === 'object' ? input : {};
    const warningSet = new Set();
    const warn = message => warningSet.add(message);
    let checked = 0;
    let truncated = false;
    const candidates = [];
    const finish = () => ({ candidates, truncated, checked, warnings: [...warningSet] });
    const maxResults = integerLimit(config.maxResults, 8, 64);
    const maxChecks = integerLimit(config.maxChecks, 30000, 200000);
    const conditions = config.conditions && typeof config.conditions === 'object'
      ? config.conditions : {};
    // 목표 학점은 범위 {min, max} 입니다. 정수 하나면 min=max, 한쪽만 있으면 그쪽만 검사합니다.
    const rawCredits = conditions.credits == null ? null : conditions.credits;
    const creditRange = rawCredits === null ? null
      : typeof rawCredits === 'object'
        ? { min: rawCredits.min == null ? null : rawCredits.min, max: rawCredits.max == null ? null : rawCredits.max }
        : { min: rawCredits, max: rawCredits };
    const targetMin = creditRange && creditRange.min !== null ? creditRange.min : null;
    const targetMax = creditRange && creditRange.max !== null ? creditRange.max : null;
    const targetCount = conditions.count == null ? null : conditions.count;

    if ((targetMin !== null && (!finiteNumber(targetMin) || targetMin < 0))
      || (targetMax !== null && (!finiteNumber(targetMax) || targetMax < 0))
      || (targetMin !== null && targetMax !== null && targetMin > targetMax)) {
      warn('목표 학점은 0 이상의 유효한 숫자여야 하고, 범위면 최소가 최대보다 클 수 없습니다.');
      return finish();
    }
    if (targetCount !== null && (!Number.isInteger(targetCount) || targetCount < 0)) {
      warn('목표 과목 수는 0 이상의 정수여야 합니다.');
      return finish();
    }
    const freeDaysInput = conditions.freeDays == null ? [] : conditions.freeDays;
    const blockedInput = conditions.blockedTimes == null ? [] : conditions.blockedTimes;
    if (!Array.isArray(freeDaysInput) || freeDaysInput.some(day => !DAYS.includes(day))) {
      warn('공강 요일 조건을 확인해 주세요. 지원하는 요일은 월~일입니다.');
      return finish();
    }
    if (!Array.isArray(blockedInput) || blockedInput.some(meeting => !validMeeting(meeting))) {
      warn('불가 시간 조건을 확인해 주세요. 시작·종료 시각은 0~1440분 범위여야 합니다.');
      return finish();
    }
    const freeDays = new Set(freeDaysInput);
    const blockedTimes = blockedInput.map(({ day, start, end }) => ({ day, start, end }));

    if (!Array.isArray(config.courses) || !Array.isArray(config.selection)) {
      warn('강의 목록과 과목 선택 정보를 확인해 주세요.');
      return finish();
    }
    const courseMap = new Map();
    const duplicateCourseIds = new Set();
    for (const course of config.courses) {
      const id = identifier(course && course.id);
      if (id === null) continue;
      if (courseMap.has(id)) duplicateCourseIds.add(id);
      else courseMap.set(id, course);
    }

    const entries = [];
    const selectedIds = new Set();
    let invalidSelection = false;
    for (const choice of config.selection) {
      const courseId = identifier(choice && choice.courseId);
      if (courseId === null || !['candidate', 'required', 'excluded'].includes(choice.status)) {
        warn('형식이 올바르지 않은 과목 선택이 있어 생성할 수 없습니다.');
        invalidSelection = true;
        continue;
      }
      if (selectedIds.has(courseId)) {
        warn('같은 과목이 중복 선택되어 있습니다. 선택 목록을 확인해 주세요.');
        invalidSelection = true;
        continue;
      }
      selectedIds.add(courseId);
      if (choice.status === 'excluded') continue;
      const course = courseMap.get(courseId);
      if (!course || duplicateCourseIds.has(courseId)) {
        warn(`확인할 수 없는 과목 ID(${courseId})는 사용할 수 없습니다.`);
        invalidSelection = true;
        continue;
      }
      const label = course.name || course.code || courseId;
      const required = choice.status === 'required';
      if (!Array.isArray(course.sections)) {
        warn(`${label}: 분반 정보를 확인할 수 없어 제외했습니다.`);
        if (required) invalidSelection = true;
        continue;
      }
      const sectionMap = new Map();
      const duplicateSectionIds = new Set();
      for (const section of course.sections) {
        const id = identifier(section && section.id);
        if (id === null) continue;
        if (sectionMap.has(id)) duplicateSectionIds.add(id);
        else sectionMap.set(id, section);
      }
      let allowedIds;
      if (choice.allowedSectionIds == null) allowedIds = [...sectionMap.keys()];
      else if (Array.isArray(choice.allowedSectionIds)) {
        allowedIds = [];
        let rejected = 0;
        for (const suppliedId of choice.allowedSectionIds) {
          const sectionId = identifier(suppliedId);
          if (sectionId === null || !sectionMap.has(sectionId) || duplicateSectionIds.has(sectionId)) {
            rejected += 1;
          } else if (!allowedIds.includes(sectionId)) allowedIds.push(sectionId);
        }
        if (rejected) warn(`${label}: 이 과목에 속하지 않거나 확인할 수 없는 분반 ID ${rejected}개를 거부했습니다.`);
      } else {
        warn(`${label}: 허용 분반 설정이 올바르지 않습니다.`);
        invalidSelection = true;
        continue;
      }

      const options = [];
      let unknownTimes = 0;
      let unknownCredits = 0;
      let ambiguousIds = 0;
      for (const sectionId of allowedIds) {
        if (duplicateSectionIds.has(sectionId)) {
          ambiguousIds += 1;
          continue;
        }
        const section = sectionMap.get(sectionId);
        const credits = section.credits == null ? course.credits : section.credits;
        if (!finiteNumber(credits) || credits < 0) {
          unknownCredits += 1;
          continue;
        }
        if (section.timeStatus !== 'KNOWN' || !Array.isArray(section.meetings)
          || section.meetings.length === 0 || section.meetings.some(meeting => !validMeeting(meeting))) {
          unknownTimes += 1;
          continue;
        }
        const meetings = section.meetings.map(({ day, start, end }) => ({ day, start, end }));
        if (meetings.some((meeting, index) => clashes([meeting], meetings.slice(index + 1)))) {
          unknownTimes += 1;
          continue;
        }
        if (meetings.some(meeting => freeDays.has(meeting.day)) || clashes(meetings, blockedTimes)) continue;
        options.push({ courseId, sectionId, credits, meetings });
      }
      if (unknownTimes) warn(`${label}: 시간이 미확인·누락되었거나 유효하지 않은 분반 ${unknownTimes}개를 제외했습니다.`);
      if (unknownCredits) warn(`${label}: 학점 확인이 필요한 분반 ${unknownCredits}개를 제외했습니다.`);
      if (ambiguousIds) warn(`${label}: 중복되어 확인할 수 없는 분반 ID ${ambiguousIds}개를 거부했습니다.`);
      if (options.length === 0) {
        warn(`${label}: 허용 분반과 현재 조건을 만족하는 분반이 없습니다.${required ? ' 필수 과목을 포함할 수 없습니다.' : ''}`);
        if (required) invalidSelection = true;
        continue;
      }
      entries.push({
        courseId, required, options,
        minCredits: Math.min(...options.map(option => option.credits)),
        maxCredits: Math.max(...options.map(option => option.credits))
      });
    }
    if (invalidSelection || entries.length === 0) return finish();

    // 제약이 강한 필수 과목부터 탐색해 불가능한 가지를 일찍 중단합니다.
    entries.sort((left, right) => Number(right.required) - Number(left.required)
      || left.options.length - right.options.length || left.courseId.localeCompare(right.courseId));
    const remainingCredits = new Array(entries.length + 1).fill(0);
    const requiredCredits = new Array(entries.length + 1).fill(0);
    const requiredCounts = new Array(entries.length + 1).fill(0);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      remainingCredits[index] = remainingCredits[index + 1] + entries[index].maxCredits;
      requiredCredits[index] = requiredCredits[index + 1] + (entries[index].required ? entries[index].minCredits : 0);
      requiredCounts[index] = requiredCounts[index + 1] + Number(entries[index].required);
    }

    const seenResults = new Set();
    function keepCandidate(state) {
      if (state.count === 0) return;
      if (targetCount !== null && state.count !== targetCount) return;
      if (targetMin !== null && state.credits < targetMin - EPSILON) return;
      if (targetMax !== null && state.credits > targetMax + EPSILON) return;
      const sections = state.sections.map(({ courseId, sectionId }) => ({ courseId, sectionId }))
        .sort((left, right) => left.courseId.localeCompare(right.courseId));
      // JSON 직렬화를 사용해 ID 안의 구분 문자로 후보가 충돌하지 않도록 합니다.
      const id = `preview-${JSON.stringify(sections.map(item => [item.courseId, item.sectionId]))}`;
      if (seenResults.has(id)) return;
      seenResults.add(id);
      candidates.push({
        id, sections,
        credits: Math.round(state.credits * 10000000) / 10000000,
        count: state.count,
        gapMinutes: gapMinutes(state.meetings),
        freeDays: WEEKDAYS.filter(day => !state.meetings.some(meeting => meeting.day === day))
      });
      candidates.sort(compareCandidates);
      if (candidates.length > maxResults) candidates.pop();
    }

    function children(state) {
      const index = state.index;
      if (targetCount !== null && (state.count + requiredCounts[index] > targetCount
        || state.count + entries.length - index < targetCount)) return [];
      if (targetMax !== null && state.credits + requiredCredits[index] > targetMax + EPSILON) return [];
      if (targetMin !== null && state.credits + remainingCredits[index] < targetMin - EPSILON) return [];
      if (candidates.length === maxResults
        && state.count + entries.length - index < candidates[candidates.length - 1].count) return [];
      if (index === entries.length) {
        keepCandidate(state);
        return [];
      }
      const entry = entries[index];
      const result = [];
      for (const option of entry.options) {
        if (clashes(option.meetings, state.meetings)) continue;
        if (targetCount !== null && state.count + 1 > targetCount) continue;
        if (targetMax !== null && state.credits + option.credits > targetMax + EPSILON) continue;
        result.push({
          index: index + 1,
          sections: state.sections.concat(option),
          meetings: state.meetings.concat(option.meetings),
          credits: state.credits + option.credits,
          count: state.count + 1
        });
      }
      if (!entry.required) {
        result.push({ ...state, index: index + 1 });
      }
      return result;
    }

    const initial = { index: 0, sections: [], meetings: [], credits: 0, count: 0 };
    let pools = [[initial]];
    let poolIndex = 0;
    let divided = false;
    while (pools.length && checked < maxChecks) {
      if (poolIndex >= pools.length) poolIndex = 0;
      const stack = pools[poolIndex];
      if (stack.length === 0) {
        pools.splice(poolIndex, 1);
        continue;
      }
      const state = stack.pop();
      checked += 1;
      const next = children(state);
      // 첫 분기들을 번갈아 탐색해 예산 안에서도 한 분반에만 후보가 몰리지 않게 합니다.
      if (!divided && next.length > 1) {
        pools = next.map(item => [item]);
        poolIndex = 0;
        divided = true;
      } else {
        for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]);
        poolIndex += 1;
      }
      // 탐색 예산을 적용하면서 브라우저가 입력·화면 갱신을 처리할 틈을 줍니다.
      if (checked % 2048 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    truncated = pools.some(stack => stack.length > 0);
    if (truncated) warn(`미리보기 탐색 한도(${maxChecks.toLocaleString('ko-KR')}회)에 도달했습니다. 더 적은 과목이나 분반으로 다시 시도할 수 있습니다.`);
    return finish();
  }

  const api = { generate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PreviewEngine = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
