/* Searchable checkbox filters. Search text is local UI state, never a filter value. */
(function (root) {
  'use strict';

  const instances = new Set();
  let sequence = 0;

  class SearchMultiSelect {
    constructor(hostElement, config = {}) {
      if (!hostElement || !hostElement.ownerDocument) {
        throw new TypeError('SearchMultiSelect requires a host element.');
      }
      this.host = hostElement;
      this.document = hostElement.ownerDocument;
      this.window = this.document.defaultView || root;
      this.config = config;
      this.label = String(config.label || '필터');
      this.placeholder = String(config.placeholder || `${this.label} 전체`);
      this.notice = String(config.notice || '');
      this.onChange = typeof config.onChange === 'function' ? config.onChange : () => {};
      this.options = [];
      this.optionMap = new Map();
      this.selected = new Set();
      this.optionElements = new Map();
      this.query = '';
      this.isOpen = false;
      this.isComposing = false;
      this.destroyed = false;
      this.suppressFocusOpen = false;
      this.listeners = [];
      this.blurTimer = null;
      this.originalClass = hostElement.classList.contains('multi-filter');
      this.originalFilterId = hostElement.getAttribute('data-filter-id');
      const key = String(config.id || 'filter').replace(/[^a-zA-Z0-9_-]/g, '-');
      this.domId = `multi-filter-${key}-${++sequence}`;

      this.host.classList.add('multi-filter');
      this.host.dataset.filterId = String(config.id || this.domId);
      this.input = this.document.createElement('input');
      this.input.className = 'multi-filter-input';
      this.input.id = `${this.domId}-input`;
      this.input.type = 'text';
      this.input.autocomplete = 'off';
      this.input.spellcheck = false;
      this.input.setAttribute('role', 'combobox');
      this.input.setAttribute('aria-label', `${this.label} 검색 및 여러 항목 선택`);
      this.input.setAttribute('aria-autocomplete', 'list');
      this.input.setAttribute('aria-haspopup', 'dialog');
      this.input.setAttribute('aria-expanded', 'false');
      this.input.setAttribute('aria-controls', `${this.domId}-menu`);

      // 선택 요약은 input의 placeholder에 표시합니다. 검색 입력 DOM은 교체하지 않습니다.
      this.summary = this.document.createElement('span');
      this.summary.className = 'multi-filter-summary';
      this.summary.id = `${this.domId}-summary`;
      this.summary.hidden = true;
      this.input.setAttribute('aria-describedby', this.summary.id);

      this.clearButton = this.document.createElement('button');
      this.clearButton.type = 'button';
      this.clearButton.className = 'multi-filter-clear';
      this.clearButton.textContent = '×';
      this.clearButton.setAttribute('aria-label', `${this.label} 선택 모두 해제`);
      this.clearButton.title = '선택 모두 해제';
      this.toggleButton = this.document.createElement('button');
      this.toggleButton.type = 'button';
      this.toggleButton.className = 'multi-filter-toggle';
      this.toggleButton.textContent = '⌄';
      this.toggleButton.setAttribute('aria-label', `${this.label} 항목 열기`);
      this.toggleButton.setAttribute('aria-controls', `${this.domId}-menu`);
      this.toggleButton.setAttribute('aria-expanded', 'false');
      this.toggleButton.setAttribute('aria-haspopup', 'dialog');
      this.host.replaceChildren(this.input, this.summary, this.clearButton, this.toggleButton);

      this.menu = this.document.createElement('div');
      this.menu.className = 'filter-menu';
      this.menu.id = `${this.domId}-menu`;
      this.menu.dataset.filterId = this.host.dataset.filterId;
      this.menu.hidden = true;
      this.menu.setAttribute('role', 'dialog');
      this.menu.setAttribute('aria-label', `${this.label} 여러 항목 선택`);
      this.menu.style.position = 'fixed';
      this.menu.style.zIndex = '120';
      this.optionsElement = this.document.createElement('div');
      this.optionsElement.className = 'filter-menu-options';
      this.optionsElement.setAttribute('role', 'group');
      this.optionsElement.setAttribute('aria-label', `${this.label} 항목`);
      this.emptyElement = this.document.createElement('div');
      this.emptyElement.className = 'filter-menu-empty';
      this.emptyElement.setAttribute('role', 'status');
      this.footer = this.document.createElement('div');
      this.footer.className = 'filter-menu-footer';
      this.footerSelection = this.document.createElement('div');
      this.footerSelection.setAttribute('aria-live', 'polite');
      this.footerNotice = this.document.createElement('div');
      this.footerNotice.className = 'filter-menu-notice';
      this.footer.append(this.footerSelection, this.footerNotice);
      this.menu.append(this.optionsElement, this.emptyElement, this.footer);
      this.document.body.append(this.menu);

      this._bindEvents();
      instances.add(this);
      this.setOptions(Array.isArray(config.options) ? config.options : []);
      this.setSelected(config.selected || [], { silent: true });
      this.setNotice(this.notice);
    }

    _listen(element, type, handler, options) {
      element.addEventListener(type, handler, options);
      this.listeners.push(() => element.removeEventListener(type, handler, options));
    }

    _bindEvents() {
      this._listen(this.input, 'focus', () => {
        if (!this.suppressFocusOpen) this._open();
      });
      this._listen(this.input, 'click', () => this._open());
      this._listen(this.input, 'compositionstart', () => {
        this.isComposing = true;
        this._open();
      });
      this._listen(this.input, 'compositionend', () => {
        this.isComposing = false;
        this._search();
      });
      this._listen(this.input, 'input', event => {
        if (!this.isComposing && !event.isComposing) this._search();
      });
      this._listen(this.input, 'keydown', event => {
        if (this.isComposing || event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          this.close();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          this._open();
          const enabled = this._enabledCheckboxes();
          const checkbox = event.key === 'ArrowDown' ? enabled[0] : enabled[enabled.length - 1];
          checkbox?.focus({ preventScroll: true });
          checkbox?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter') {
          // 검색 문자를 선택 값으로 보내거나 부모 폼을 제출하지 않습니다.
          event.preventDefault();
          this._open();
        }
      });
      const preventButtonBlur = event => event.preventDefault();
      this._listen(this.clearButton, 'mousedown', preventButtonBlur);
      this._listen(this.toggleButton, 'mousedown', preventButtonBlur);
      this._listen(this.clearButton, 'click', () => {
        const wasOpen = this.isOpen;
        this.query = '';
        this.input.value = '';
        this.setSelected([], { silent: false });
        if (this.destroyed) return;
        this._renderOptions();
        this._focusInput(wasOpen);
      });
      this._listen(this.toggleButton, 'click', () => {
        const opening = !this.isOpen;
        if (opening) this._open();
        else this.close();
        this._focusInput(opening);
      });
      this._listen(this.menu, 'mousedown', event => {
        // 체크박스 클릭으로 검색 입력의 포커스·IME 위치가 불필요하게 이동하지 않게 합니다.
        if (event.button === 0 && event.target.closest('.filter-option')
          && this.document.activeElement === this.input) event.preventDefault();
      });
      this._listen(this.menu, 'change', event => {
        const checkbox = event.target;
        if (!checkbox.matches('input[data-filter-option]') || checkbox.disabled) return;
        const values = new Set(this.selected);
        if (checkbox.checked) values.add(checkbox.value);
        else values.delete(checkbox.value);
        try {
          this.setSelected([...values], { silent: false });
        } finally {
          if (!this.destroyed) this._focusInput(true);
        }
      });
      this._listen(this.menu, 'keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          this.close();
          this._focusInput(false);
        }
      });
      const closeOnBlur = () => {
        this.window.clearTimeout(this.blurTimer);
        this.blurTimer = this.window.setTimeout(() => {
          if (this.destroyed || !this.isOpen) return;
          const focused = this.document.activeElement;
          if (!this.host.contains(focused) && !this.menu.contains(focused)) this.close();
        }, 0);
      };
      this._listen(this.host, 'focusout', closeOnBlur);
      this._listen(this.menu, 'focusout', closeOnBlur);
      this._listen(this.document, 'pointerdown', event => {
        if (this.isOpen && !this.host.contains(event.target) && !this.menu.contains(event.target)) this.close();
      }, true);
      this._listen(this.window, 'resize', () => this._position());
      this._listen(this.document, 'scroll', () => this._position(), true);
    }

    _focusInput(keepOpen) {
      this.suppressFocusOpen = !keepOpen;
      try { this.input.focus({ preventScroll: true }); }
      finally { this.suppressFocusOpen = false; }
    }

    _enabledCheckboxes() {
      return [...this.optionsElement.querySelectorAll('input[type="checkbox"]:not(:disabled)')];
    }

    _search() {
      if (this.destroyed) return;
      this.query = this.input.value;
      this._open();
      this._renderOptions();
    }

    _open() {
      if (this.destroyed || this.isOpen) return;
      for (const instance of instances) if (instance !== this) instance.close();
      this.isOpen = true;
      this.host.classList.add('is-open');
      this.menu.hidden = false;
      this.input.setAttribute('aria-expanded', 'true');
      this.toggleButton.setAttribute('aria-expanded', 'true');
      this.toggleButton.setAttribute('aria-label', `${this.label} 항목 닫기`);
      this._position();
    }

    _position() {
      if (this.destroyed || !this.isOpen) return;
      const rect = this.host.getBoundingClientRect();
      const viewportWidth = this.window.innerWidth || this.document.documentElement.clientWidth;
      const viewportHeight = this.window.innerHeight || this.document.documentElement.clientHeight;
      const availableWidth = Math.max(0, viewportWidth - 16);
      const width = Math.min(Math.max(260, rect.width), availableWidth);
      const styles = this.window.getComputedStyle(this.host);
      this.menu.style.fontFamily = styles.fontFamily;
      this.menu.style.fontSize = styles.fontSize;
      this.menu.style.lineHeight = styles.lineHeight;
      this.menu.style.width = `${width}px`;
      this.menu.style.maxWidth = `${availableWidth}px`;
      this.menu.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`;
      const menuHeight = this.menu.getBoundingClientRect().height;
      const below = viewportHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const top = menuHeight > below && above > below
        ? rect.top - menuHeight - 6 : rect.bottom + 6;
      this.menu.style.top = `${Math.max(8, Math.min(top, viewportHeight - menuHeight - 8))}px`;
    }

    _renderOptions() {
      const query = this.query.trim().toLocaleLowerCase('ko-KR');
      const filtered = this.options.filter(option => !query
        || option.label.toLocaleLowerCase('ko-KR').includes(query)
        || option.value.toLocaleLowerCase('ko-KR').includes(query));
      const fragment = this.document.createDocumentFragment();
      this.optionElements.clear();
      for (const option of filtered) {
        const label = this.document.createElement('label');
        label.className = 'filter-option';
        label.classList.toggle('is-selected', this.selected.has(option.value));
        label.classList.toggle('is-disabled', option.disabled);
        const checkbox = this.document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = option.value;
        checkbox.dataset.filterOption = '';
        checkbox.checked = this.selected.has(option.value);
        checkbox.disabled = option.disabled;
        const text = this.document.createElement('span');
        text.className = 'filter-option-label';
        text.textContent = option.label;
        label.append(checkbox, text);
        if (option.count !== null) {
          const count = this.document.createElement('span');
          count.className = 'filter-option-count';
          count.textContent = option.count.toLocaleString('ko-KR');
          label.append(count);
        }
        this.optionElements.set(option.value, { label, checkbox });
        fragment.append(label);
      }
      this.optionsElement.replaceChildren(fragment);
      this.emptyElement.hidden = filtered.length > 0;
      this.emptyElement.textContent = query ? '검색 결과가 없어요.' : '선택할 항목이 없어요.';
      this._position();
    }

    _updateSelectionUI() {
      const labels = this.getSelected().map(value => this.optionMap.get(value)?.label).filter(Boolean);
      const summary = labels.length > 1 ? `${labels[0]} 외 ${labels.length - 1}개` : labels[0] || this.placeholder;
      this.input.placeholder = summary;
      this.input.title = labels.length ? labels.join(', ') : this.placeholder;
      this.summary.textContent = labels.length ? `${this.label}: ${labels.join(', ')}` : `${this.label}: 전체`;
      this.host.classList.toggle('has-selection', labels.length > 0);
      this.clearButton.hidden = labels.length === 0;
      for (const [value, elements] of this.optionElements) {
        const selected = this.selected.has(value);
        elements.checkbox.checked = selected;
        elements.label.classList.toggle('is-selected', selected);
      }
      this.footerSelection.textContent = labels.length
        ? `${labels.length}개 선택 · 체크한 항목이 바로 반영돼요.`
        : '선택하지 않으면 전체 항목을 표시해요.';
    }

    setOptions(options) {
      if (this.destroyed) return;
      const next = [];
      const seen = new Set();
      for (const option of Array.isArray(options) ? options : []) {
        if (!option || typeof option.value !== 'string' || seen.has(option.value)) continue;
        seen.add(option.value);
        next.push({
          value: option.value,
          label: String(option.label ?? option.value),
          count: typeof option.count === 'number' && Number.isFinite(option.count) && option.count >= 0 ? option.count : null,
          disabled: Boolean(option.disabled)
        });
      }
      this.options = next;
      this.optionMap = new Map(next.map(option => [option.value, option]));
      const previous = this.getSelected();
      this.selected = new Set(previous.filter(value => this.optionMap.has(value) && !this.optionMap.get(value).disabled));
      this._renderOptions();
      this._updateSelectionUI();
      if (previous.length !== this.selected.size) this.onChange(this.getSelected());
    }

    setSelected(values, { silent = true } = {}) {
      if (this.destroyed) return;
      const next = new Set((Array.isArray(values) ? values : [])
        .filter(value => this.optionMap.has(value) && !this.optionMap.get(value).disabled));
      const changed = next.size !== this.selected.size || [...next].some(value => !this.selected.has(value));
      if (changed) this.selected = next;
      this._updateSelectionUI();
      if (changed && !silent) this.onChange(this.getSelected());
    }

    getSelected() {
      return [...this.selected];
    }

    setNotice(text) {
      if (this.destroyed) return;
      this.notice = String(text || '');
      this.footerNotice.textContent = this.notice;
      this.footerNotice.hidden = !this.notice;
      this._position();
    }

    close() {
      if (this.destroyed) return;
      this.isOpen = false;
      this.query = '';
      this.input.value = '';
      this.host.classList.remove('is-open');
      this.menu.hidden = true;
      this.input.setAttribute('aria-expanded', 'false');
      this.toggleButton.setAttribute('aria-expanded', 'false');
      this.toggleButton.setAttribute('aria-label', `${this.label} 항목 열기`);
      this._updateSelectionUI();
      // 닫힌 뒤 다시 열면 이전 검색어로 숨겨진 항목 없이 모든 옵션을 표시합니다.
      this._renderOptions();
    }

    destroy() {
      if (this.destroyed) return;
      this.close();
      this.destroyed = true;
      this.window.clearTimeout(this.blurTimer);
      for (const removeListener of this.listeners) removeListener();
      this.listeners = [];
      this.menu.remove();
      this.host.replaceChildren();
      this.host.classList.remove('has-selection', 'is-open');
      if (!this.originalClass) this.host.classList.remove('multi-filter');
      if (this.originalFilterId === null) this.host.removeAttribute('data-filter-id');
      else this.host.setAttribute('data-filter-id', this.originalFilterId);
      instances.delete(this);
    }
  }

  root.SearchMultiSelect = SearchMultiSelect;
  if (typeof module === 'object' && module.exports) module.exports = SearchMultiSelect;
})(typeof window !== 'undefined' ? window : globalThis);
