/**
 * Installation settings page (Community Edition)
 *
 * Loads the installation settings, renders a control per setting, saves the
 * changed values per section and runs the same live tests as the setup wizard.
 * Secrets are never shown: an empty secret field keeps the stored value.
 * All text is written with textContent.
 */
(function () {
  'use strict';

  const { texts, setupTexts, adminEmail, language, docsUrl } = window.GRYFFI_INSTALLATION;
  const root = document.getElementById('installation');
  let settings = {};

  // ---------------------------------------------------------------- helpers

  function lookup(source, path) {
    return path.split('.').reduce((node, key) => (node && node[key] !== undefined ? node[key] : undefined), source);
  }

  function fill(template, vars = {}) {
    return String(template).replace(/\{\{(\w+)\}\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : ''));
  }

  function text(path, vars) {
    const template = lookup(texts, path);
    return typeof template === 'string' ? fill(template, vars) : path;
  }

  // Setting keys contain dots, so their texts cannot be found with lookup()
  function settingText(group, key, part) {
    const node = texts[group] && texts[group][key];
    return node && typeof node[part] === 'string' ? node[part] : null;
  }

  function errorText(code, details = {}) {
    const template = lookup(setupTexts, `errors.${code}`) || lookup(setupTexts, 'errors.CHECK_CRASHED');
    return fill(template, details);
  }

  function showResult(container, ok, message, { code, extra = [] } = {}) {
    container.replaceChildren();
    container.className = `setup-result ${ok ? 'setup-result--ok' : 'setup-result--error'}`;
    const line = document.createElement('p');
    line.textContent = message;
    container.append(line);
    if (!ok && code) {
      const link = document.createElement('a');
      link.href = `${docsUrl}#${code.toLowerCase().replace(/_/g, '-')}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = lookup(setupTexts, 'moreHelp');
      container.append(link);
    }
    extra.forEach((node) => container.append(node));
  }

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return response.json();
  }

  const control = (key) => root.querySelector(`[data-setting="${key}"]`);
  const fieldValue = (key) => {
    const element = control(key);
    if (!element) return undefined;
    return element.type === 'checkbox' ? element.checked : element.value.trim();
  };

  // ---------------------------------------------------------------- render

  function renderControl(setting) {
    const holder = root.querySelector(`[data-control][data-key="${setting.key}"]`);
    if (!holder) return;
    const id = holder.dataset.id;
    let element;

    if (setting.type === 'boolean') {
      element = document.createElement('input');
      element.type = 'checkbox';
      element.className = 'installation-checkbox';
      element.checked = setting.value === true;
    } else if (setting.type === 'enum') {
      element = document.createElement('select');
      element.className = 'setup-input';
      setting.options.forEach((option) => {
        const item = document.createElement('option');
        item.value = option;
        item.textContent = settingText('options', setting.key, option) || option;
        element.append(item);
      });
      element.value = setting.value ?? setting.options[0];
    } else {
      element = document.createElement('input');
      element.className = 'setup-input';
      element.type = setting.secret ? 'password' : setting.type === 'number' ? 'number' : 'text';
      element.autocomplete = 'off';
      element.spellcheck = false;
      if (setting.secret) {
        element.placeholder = setting.value ? text('secretStored', { value: setting.value }) : text('secretEmpty');
      } else {
        element.value = setting.value ?? '';
      }
    }
    element.id = id;
    element.dataset.setting = setting.key;
    holder.replaceWith(element);

    if (setting.type === 'boolean') {
      // Put the checkbox before its label text, like the wizard toggles
      const label = root.querySelector(`label[for="${id}"]`);
      label.classList.add('setup-toggle');
      label.prepend(element);
    }

    const source = root.querySelector(`[data-field="${setting.key}"] [data-source]`);
    if (setting.source === 'environment' || setting.source === 'default') {
      source.textContent = text(`source.${setting.source}`);
      source.hidden = false;
    }
  }

  // ---------------------------------------------------------------- version

  function renderVersion(version) {
    const box = document.getElementById('versionStatus');
    box.replaceChildren();
    const line = (message) => {
      const p = document.createElement('p');
      p.textContent = message;
      box.append(p);
      return p;
    };

    if (version.development) {
      line(text('version.development'));
      return;
    }
    line(text('version.current', { version: version.current }));
    if (!version.enabled) {
      line(text('version.off'));
    } else if (version.available) {
      line(text('version.available', { version: version.latest })).className = 'setup-label';
      line(text('version.howTo'));
      const command = document.createElement('code');
      command.textContent = 'gryffi update';
      box.append(command);
      if (version.url) {
        const notes = document.createElement('a');
        notes.href = version.url;
        notes.target = '_blank';
        notes.rel = 'noopener';
        notes.textContent = text('version.notes');
        line('').append(notes);
      }
    } else if (version.latest) {
      line(text('version.upToDate'));
    } else {
      line(text('version.notChecked'));
    }
  }

  async function load() {
    const data = await request('GET', '/api/installation/settings');
    if (!data.success) return;
    settings = Object.fromEntries(data.settings.map((s) => [s.key, s]));
    data.settings.forEach(renderControl);
    root.querySelector('[data-uri="google"]').textContent = data.redirectUris.google;
    root.querySelector('[data-uri="microsoft"]').textContent = data.redirectUris.microsoft;
    renderReembed(data.reembed);
    renderVersion(data.version);
    loadAudit();
  }

  // ------------------------------------------------------------------- save

  function changedValues(form) {
    const values = {};
    form.querySelectorAll('[data-setting]').forEach((element) => {
      const key = element.dataset.setting;
      const setting = settings[key];
      const current = element.type === 'checkbox' ? element.checked : element.value.trim();
      if (setting.secret) {
        if (current !== '') values[key] = current;
        return;
      }
      const before = setting.value === null || setting.value === undefined ? '' : setting.value;
      if (String(current) !== String(before)) values[key] = current === '' ? null : current;
    });
    return values;
  }

  root.querySelectorAll('form[data-section]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = form.querySelector('[data-section-result]');
      const values = changedValues(form);
      if (Object.keys(values).length === 0) {
        showResult(result, true, text('nothingChanged'));
        return;
      }
      const data = await request('PUT', '/api/installation/settings', { values });
      if (!data.success) {
        const label = data.field ? settingText('fields', data.field, 'label') : null;
        const message = data.code === 'SECRET_REQUIRED' && label
          ? text('secretRequired', { field: label })
          : label ? text('saveFailedField', { field: label }) : errorText(data.code || 'SETTING_INVALID');
        // The help pages cover check codes; this one explains itself
        showResult(result, false, message, { code: data.code === 'SECRET_REQUIRED' ? null : data.code });
        return;
      }
      showResult(result, true, text('saved'));
      if (data.reembed) renderReembed(data.reembed);
      await load();
    });
  });

  // ------------------------------------------------------------------ tests

  const TESTS = {
    ai: () => ({ baseUrl: fieldValue('ai.baseUrl'), apiKey: fieldValue('ai.apiKey'), chatModel: fieldValue('ai.chatModel') }),
    embeddings: () => ({
      baseUrl: fieldValue('ai.baseUrl'),
      apiKey: fieldValue('ai.apiKey'),
      model: fieldValue('ai.embeddingModel'),
      embeddingBaseUrl: fieldValue('ai.embeddingBaseUrl'),
      embeddingApiKey: fieldValue('ai.embeddingApiKey')
    }),
    vision: () => ({ baseUrl: fieldValue('ai.baseUrl'), apiKey: fieldValue('ai.apiKey'), model: fieldValue('ai.visionModel') }),
    speech: () => ({ baseUrl: fieldValue('ai.baseUrl'), apiKey: fieldValue('ai.apiKey'), model: fieldValue('ai.ttsModel'), voice: fieldValue('ai.ttsVoice') }),
    email: () => ({
      host: fieldValue('email.smtpHost'),
      port: Number(fieldValue('email.smtpPort')) || 587,
      security: fieldValue('email.smtpSecurity'),
      user: fieldValue('email.smtpUser'),
      password: fieldValue('email.smtpPassword'),
      from: fieldValue('email.from'),
      to: adminEmail
    }),
    parser: () => ({}),
    nsfw: () => ({})
  };

  function okMessage(part, details) {
    switch (part) {
      case 'ai': return lookup(setupTexts, 'steps.ai.connectionOk').replace('{{count}}', (details.models || []).length);
      case 'embeddings': return fill(lookup(setupTexts, 'steps.ai.embeddingsOk'), details);
      case 'vision': return lookup(setupTexts, 'steps.ai.visionOk');
      case 'speech': return lookup(setupTexts, 'steps.ai.speechOk');
      case 'email': return fill(lookup(setupTexts, 'steps.email.sent'), { to: details.sentTo });
      default: return lookup(setupTexts, 'steps.features.running');
    }
  }

  root.querySelectorAll('[data-test]').forEach((button) => {
    button.addEventListener('click', async () => {
      const part = button.dataset.test;
      const result = button.closest('form').querySelector('[data-section-result]');
      const label = button.textContent;
      button.disabled = true;
      button.textContent = lookup(setupTexts, 'testing');
      try {
        const data = await request('POST', `/api/installation/test/${part}`, TESTS[part]());
        const extra = data.ok && part === 'speech' && data.details.audio
          ? [Object.assign(document.createElement('audio'), { controls: true, src: data.details.audio })]
          : [];
        showResult(result, data.ok, data.ok ? okMessage(part, data.details) : errorText(data.code, data.details), { code: data.code, extra });
      } catch {
        showResult(result, false, errorText('CHECK_CRASHED'), { code: 'CHECK_CRASHED' });
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
  });

  // ------------------------------------------------------------- re-embedding

  let reembedTimer = null;

  function renderReembed(state) {
    const box = document.getElementById('reembedStatus');
    const button = document.getElementById('reembedButton');
    box.replaceChildren();
    button.disabled = !!state.running;
    if (!state.startedAt) return;

    const line = document.createElement('p');
    if (state.running) {
      line.textContent = text('reembed.running', { done: state.done, total: state.total });
      const bar = document.createElement('div');
      bar.className = 'installation-progress';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(state.total));
      bar.setAttribute('aria-valuenow', String(state.done));
      const fillBar = document.createElement('span');
      fillBar.style.width = `${state.total ? Math.round((state.done / state.total) * 100) : 100}%`;
      bar.append(fillBar);
      box.append(line, bar);
      clearTimeout(reembedTimer);
      reembedTimer = setTimeout(async () => {
        const data = await request('GET', '/api/installation/reembed');
        if (data.success) renderReembed(data.reembed);
      }, 2000);
    } else {
      line.textContent = text(state.failed ? 'reembed.doneWithErrors' : 'reembed.done', { total: state.total, failed: state.failed });
      box.append(line);
    }
  }

  document.getElementById('reembedButton').addEventListener('click', async () => {
    const data = await request('POST', '/api/installation/reembed');
    if (data.success) renderReembed(data.reembed);
  });

  // ------------------------------------------------------------------ audit

  function shownValue(raw) {
    if (raw === null || raw === undefined) return text('audit.empty');
    try {
      const value = JSON.parse(raw);
      if (value === true) return text('audit.on');
      if (value === false) return text('audit.off');
      return String(value);
    } catch {
      return String(raw);
    }
  }

  async function loadAudit() {
    const data = await request('GET', '/api/installation/audit');
    const body = document.getElementById('auditRows');
    body.replaceChildren();
    if (!data.success || data.entries.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.textContent = text('audit.none');
      row.append(cell);
      body.append(row);
      return;
    }
    const formatter = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
    data.entries.forEach((entry) => {
      const row = document.createElement('tr');
      const cells = [
        formatter.format(new Date(entry.changed_at)),
        entry.changed_by || text('audit.system'),
        settingText('fields', entry.key, 'label') || entry.key,
        `${shownValue(entry.old_value)} → ${shownValue(entry.new_value)}`
      ];
      cells.forEach((value) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      });
      body.append(row);
    });
  }

  load();
})();
