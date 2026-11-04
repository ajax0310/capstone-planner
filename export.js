/* 시간표 후보를 PNG 이미지로 그리거나 인쇄(PDF 저장)용 시트를 만듭니다. 외부 라이브러리 없이 동작합니다. */
(function (root) {
  'use strict';

  const FONT = '"Noto Sans KR", Pretendard, "Malgun Gothic", sans-serif';
  const time = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth) {
    const value = String(text ?? '');
    if (ctx.measureText(value).width <= maxWidth) return value;
    let trimmed = value;
    while (trimmed.length > 1 && ctx.measureText(trimmed + '…').width > maxWidth) trimmed = trimmed.slice(0, -1);
    return trimmed + '…';
  }

  // model: { title, subtitle, footnote, days, rangeStart, rangeEnd, meetings[], blocks[], courses[] }
  function toCanvas(model, { scale = 2 } = {}) {
    const days = model.days;
    const hours = Math.max(1, (model.rangeEnd - model.rangeStart) / 60);
    const padX = 48, padTop = 40, headerH = 84, dayHeadH = 44, hourH = 64, timeW = 72, listRowH = 30;
    const width = 1400;
    const gridW = width - padX * 2 - timeW;
    const colW = gridW / days.length;
    const listH = model.courses.length ? 56 + model.courses.length * listRowH : 0;
    const height = padTop + headerH + dayHeadH + hours * hourH + 36 + listH + 40;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#121417';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(model.title, padX, padTop + 30);
    ctx.fillStyle = '#6b7280';
    ctx.font = `400 15px ${FONT}`;
    ctx.fillText(model.subtitle, padX, padTop + 58);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9aa3af';
    ctx.font = `400 13px ${FONT}`;
    ctx.fillText(model.footnote, width - padX, padTop + 30);
    ctx.textAlign = 'left';

    const gridTop = padTop + headerH + dayHeadH;
    const gridLeft = padX + timeW;
    days.forEach((day, index) => {
      const x = gridLeft + index * colW;
      ctx.fillStyle = '#f3f6fa';
      ctx.fillRect(x, gridTop - dayHeadH, colW, dayHeadH);
      ctx.strokeStyle = '#e6e9ee';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, gridTop - dayHeadH + 0.5, colW, dayHeadH);
      ctx.fillStyle = '#0a5bab';
      ctx.font = `700 15px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(day, x + colW / 2, gridTop - dayHeadH / 2 + 5);
    });
    ctx.textAlign = 'left';
    for (let hour = 0; hour <= hours; hour += 1) {
      const y = gridTop + hour * hourH;
      ctx.strokeStyle = hour === 0 || hour === hours ? '#d5dbe3' : '#e6e9ee';
      ctx.setLineDash(hour > 0 && hour < hours ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(gridLeft, y + 0.5);
      ctx.lineTo(gridLeft + gridW, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hour < hours) {
        ctx.fillStyle = '#8a94a3';
        ctx.font = `400 12px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillText(time(model.rangeStart + hour * 60), gridLeft - 10, y + 14);
        ctx.textAlign = 'left';
      }
    }
    for (let index = 0; index <= days.length; index += 1) {
      const x = gridLeft + index * colW;
      ctx.strokeStyle = '#e6e9ee';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, gridTop);
      ctx.lineTo(x + 0.5, gridTop + hours * hourH);
      ctx.stroke();
    }
    const yOf = minute => gridTop + (minute - model.rangeStart) / 60 * hourH;

    model.blocks.forEach(block => {
      const index = days.indexOf(block.day);
      if (index < 0) return;
      const x = gridLeft + index * colW + 3;
      const y = yOf(block.start);
      const h = yOf(block.end) - y;
      const w = colW - 6;
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, x, y + 1, w, h - 2, 6);
      ctx.clip();
      ctx.fillStyle = '#f4f6f9';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#dfe3ea';
      ctx.lineWidth = 1;
      for (let offset = -h; offset < w + h; offset += 8) {
        ctx.beginPath();
        ctx.moveTo(x + offset, y);
        ctx.lineTo(x + offset + h, y + h);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = '#9aa3af';
      ctx.font = `400 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(block.label || '수업 제외', x + w / 2, y + h / 2 + 4);
      ctx.textAlign = 'left';
    });

    model.meetings.forEach(meeting => {
      const index = days.indexOf(meeting.day);
      if (index < 0) return;
      const x = gridLeft + index * colW + 4;
      const y = yOf(meeting.start) + 2;
      const w = colW - 8;
      const h = Math.max(22, yOf(meeting.end) - yOf(meeting.start) - 4);
      ctx.fillStyle = meeting.color || '#dcebfa';
      ctx.beginPath();
      roundRect(ctx, x, y, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const ink = meeting.ink || '#1d3557';
      ctx.fillStyle = ink;
      ctx.font = `700 13px ${FONT}`;
      ctx.fillText(fitText(ctx, meeting.name, w - 14), x + 7, y + 18);
      ctx.globalAlpha = 0.85;
      ctx.font = `400 11.5px ${FONT}`;
      ctx.fillText(`${time(meeting.start)}–${time(meeting.end)}`, x + 7, y + 34);
      if (h >= 56) {
        const line = [meeting.section ? `${meeting.section}분반` : null, meeting.room].filter(Boolean).join(' · ');
        if (line) ctx.fillText(fitText(ctx, line, w - 14), x + 7, y + 50);
      }
      ctx.restore();
    });

    if (model.courses.length) {
      let y = gridTop + hours * hourH + 44;
      ctx.fillStyle = '#121417';
      ctx.font = `700 15px ${FONT}`;
      ctx.fillText('포함된 과목', padX, y);
      y += 12;
      model.courses.forEach(course => {
        y += listRowH;
        ctx.fillStyle = course.color || '#dcebfa';
        ctx.beginPath();
        roundRect(ctx, padX, y - 14, 12, 12, 3);
        ctx.fill();
        ctx.fillStyle = '#121417';
        ctx.font = `600 13.5px ${FONT}`;
        ctx.fillText(fitText(ctx, course.name, 320), padX + 22, y - 3);
        ctx.fillStyle = '#6b7280';
        ctx.font = `400 13px ${FONT}`;
        ctx.fillText(fitText(ctx, course.detail, width - padX * 2 - 380), padX + 360, y - 3);
      });
    }
    return canvas;
  }

  function toPNG(model, options) {
    return new Promise((resolve, reject) => {
      try {
        const canvas = toCanvas(model, options);
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('PNG 변환에 실패했습니다.'))), 'image/png');
      } catch (error) {
        reject(error);
      }
    });
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 인쇄 시트: 현재 달력 DOM을 복제해 제목·과목 목록과 함께 인쇄합니다. 브라우저의 "PDF로 저장"을 그대로 사용합니다.
  function printSheet(model, calendarElement) {
    const previous = document.getElementById('print-sheet');
    if (previous) previous.remove();
    const sheet = document.createElement('section');
    sheet.id = 'print-sheet';
    sheet.setAttribute('aria-hidden', 'true');
    const head = document.createElement('div');
    head.className = 'print-head';
    const title = document.createElement('h1');
    title.textContent = model.title;
    const subtitle = document.createElement('p');
    subtitle.textContent = model.subtitle;
    const note = document.createElement('small');
    note.textContent = model.footnote;
    head.append(title, subtitle, note);
    const grid = calendarElement.cloneNode(true);
    grid.removeAttribute('id');
    grid.classList.add('print-calendar');
    grid.querySelectorAll('button').forEach(button => {
      const block = document.createElement('div');
      block.className = button.className;
      block.setAttribute('style', button.getAttribute('style') || '');
      block.innerHTML = button.innerHTML;
      button.replaceWith(block);
    });
    const list = document.createElement('ul');
    list.className = 'print-list';
    model.courses.forEach(course => {
      const item = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'print-dot';
      dot.style.background = course.color || '#dcebfa';
      const name = document.createElement('strong');
      name.textContent = course.name;
      const detail = document.createElement('span');
      detail.textContent = course.detail;
      item.append(dot, name, detail);
      list.append(item);
    });
    sheet.append(head, grid, list);
    document.body.append(sheet);
    document.body.classList.add('printing');
    const cleanup = () => {
      document.body.classList.remove('printing');
      sheet.remove();
      root.removeEventListener('afterprint', cleanup);
    };
    root.addEventListener('afterprint', cleanup);
    setTimeout(() => {
      try { root.print(); } finally { setTimeout(cleanup, 0); }
    }, 60);
    return sheet;
  }

  root.TimetableExport = { toCanvas, toPNG, download, print: printSheet };
  if (typeof module === 'object' && module.exports) module.exports = root.TimetableExport;
})(typeof window !== 'undefined' ? window : globalThis);
