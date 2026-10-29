/**
 * Setup wizard (Community Edition)
 *
 * Walks the administrator through seven steps: server checks, organization,
 * admin account, AI provider, email, optional features and the installation
 * itself. Every part that talks to another service has a Test button; a step
 * with a required service only continues after its test passed.
 *
 * All text comes from window.GRYFFI_SETUP.texts (the setup.* translations)
 * and is written with textContent, never as HTML.
 */
(function () {
  'use strict';

  const { texts, docsUrl } = window.GRYFFI_SETUP;
  const STEPS = ['server', 'organization', 'admin', 'ai', 'email', 'features', 'install'];

  const AI_PRESETS = {
    mistral: { baseUrl: 'https://api.mistral.ai/v1', chatModel: 'mistral-small-latest', embeddingModel: 'mistral-embed', visionModel: 'mistral-large-latest', ttsModel: 'voxtral-mini-tts-2603', apiKey: '' },
    openai: { baseUrl: 'https://api.openai.com/v1', chatModel: '', embeddingModel: 'text-embedding-3-small', visionModel: '', ttsModel: '', apiKey: '' },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', chatModel: '', embeddingModel: '', visionModel: '', ttsModel: '', apiKey: '' },
    ollama: { baseUrl: 'http://host.docker.internal:11434/v1', chatModel: '', embeddingModel: 'nomic-embed-text', visionModel: '', ttsModel: '', apiKey: 'ollama' },
    other: { baseUrl: '', chatModel: '', embeddingModel: '', visionModel: '', ttsModel: '', apiKey: '' }
  };

  // Tests that must pass before the step can be left, and what invalidates them
  const passed = { ai: false, embeddings: false, email: false };
  const containers = { parser: false, nsfw: false };
  let current = 0;
  let serverReady = false;

  const $ = (id) => document.getElementById(id);
  const value = (id) => $(id).value.trim();

  // ---------------------------------------------------------------- helpers

  function lookup(path) {
    return path.split('.').reduce((node, key) => (node && node[key] !== undefined ? node[key] : undefined), texts);
  }

  function text(path, vars = {}) {
    const template = lookup(path);
    if (typeof template !== 'string') return path;
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : ''));
  }

  function errorText(code, details = {}) {
    return lookup(`errors.${code}`) ? text(`errors.${code}`, details) : text('errors.CHECK_CRASHED');
  }

  /** Show a test or check result: a line of text, a help link for errors, optional extra nodes. */
  function showResult(container, result, okText, extra = []) {
    container.replaceChildren();
    container.className = `setup-result ${result.ok ? 'setup-result--ok' : 'setup-result--error'}`;
    const line = document.createElement('p');
    line.textContent = result.ok ? okText : errorText(result.code, result.details);
    container.append(line);
    if (!result.ok && result.code) {
      const link = document.createElement('a');
      link.href = `${docsUrl}#${result.code.toLowerCase().replace(/_/g, '-')}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = text('moreHelp');
      container.append(link);
    }
    extra.forEach((node) => container.append(node));
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (response.status === 401) {
      window.location.href = '/setup';
      return { ok: false, code: 'SETUP_CODE_REQUIRED' };
    }
    return response.json();
  }

  function stepError(message) {
    const element = $('stepError');
    element.textContent = message || '';
    element.hidden = !message;
  }

  // ------------------------------------------------------------- navigation

  function showStep(index) {
    current = index;
    document.querySelectorAll('[data-step]').forEach((section) => {
      section.hidden = section.dataset.step !== STEPS[index];
    });
    document.querySelectorAll('[data-step-dot]').forEach((dot) => {
      const i = Number(dot.dataset.stepDot);
      dot.className = i < index ? 'is-done' : i === index ? 'is-current' : '';
    });
    $('stepIndicator').textContent = text('stepOf', { current: index + 1, total: STEPS.length });
    $('backButton').hidden = index === 0;
    $('nextButton').hidden = STEPS[index] === 'install';
    stepError('');
    if (STEPS[index] === 'install') renderSummary();
    const heading = document.querySelector(`[data-step="${STEPS[index]}"] h1`);
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }

  function validateStep() {
    switch (STEPS[current]) {
      case 'server':
        return serverReady ? null : text('steps.server.blocked');
      case 'organization':
        return value('organizationName').length >= 2 ? null : text('errors.ORG_NAME_REQUIRED');
      case 'admin': {
        if (!value('firstName') || !value('lastName')) return text('errors.NAME_REQUIRED');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value('email'))) return text('errors.EMAIL_INVALID');
        if ($('password').value.length < 12) return text('errors.PASSWORD_TOO_SHORT');
        if ($('password').value !== $('passwordConfirm').value) return text('errors.PASSWORD_MISMATCH');
        return null;
      }
      case 'ai':
        if ($('aiDisabled').checked) return null;
        if (!passed.ai) return text('steps.ai.testFirst');
        if (!passed.embeddings) return text('steps.ai.testEmbeddingsFirst');
        return null;
      case 'email':
        if ($('emailSkip').checked) return null;
        return passed.email ? null : text('steps.email.testFirst');
      default:
        return null;
    }
  }

  $('nextButton').addEventListener('click', () => {
    const problem = validateStep();
    if (problem) {
      stepError(problem);
      return;
    }
    showStep(Math.min(current + 1, STEPS.length - 1));
  });
  $('backButton').addEventListener('click', () => showStep(Math.max(current - 1, 0)));
  $('setupForm').addEventListener('submit', (event) => event.preventDefault());

  // ---------------------------------------------------------------- 1. server

  async function runServerChecks() {
    const list = $('serverChecks');
    list.replaceChildren();
    const pending = document.createElement('li');
    pending.className = 'setup-check setup-check--pending';
    pending.textContent = text('steps.server.checking');
    list.append(pending);

    let checks = [];
    try {
      const response = await fetch('/setup/api/checks');
      checks = (await response.json()).checks || [];
    } catch {
      checks = [{ name: 'server', required: true, ok: false, code: 'CHECK_CRASHED', details: {} }];
    }

    list.replaceChildren();
    serverReady = checks.every((check) => check.ok || !check.required);
    checks.forEach((check) => {
      if (check.name === 'parser' || check.name === 'nsfw') containers[check.name] = check.ok;
      const item = document.createElement('li');
      const state = check.ok ? 'ok' : check.required ? 'error' : 'warning';
      item.className = `setup-check setup-check--${state}`;
      const name = document.createElement('strong');
      name.textContent = text(`steps.server.names.${check.name}`);
      item.append(name);
      if (!check.ok) {
        const status = document.createElement('span');
        status.textContent = errorText(check.code, check.details);
        item.append(status);
      }
      list.append(item);
    });

    $('featureNsfw').checked = containers.nsfw;
    $('featureParser').checked = containers.parser;
  }
  $('rerunChecks').addEventListener('click', runServerChecks);

  // ----------------------------------------------------------------- 3. admin

  $('showPassword').addEventListener('change', (event) => {
    const type = event.target.checked ? 'text' : 'password';
    $('password').type = type;
    $('passwordConfirm').type = type;
  });

  // -------------------------------------------------------------------- 4. AI

  function applyPreset(name) {
    const preset = AI_PRESETS[name];
    $('aiBaseUrl').value = preset.baseUrl;
    $('aiApiKey').value = preset.apiKey;
    $('aiChatModel').value = preset.chatModel;
    $('aiEmbeddingModel').value = preset.embeddingModel;
    $('aiVisionModel').value = preset.visionModel;
    $('aiTtsModel').value = preset.ttsModel;
    $('aiTtsVoice').value = '';
    $('aiProviderHint').textContent = text(`steps.ai.providerHints.${name}`);
    $('aiSeparateEmbeddings').checked = name === 'openrouter';
    $('aiEmbeddingProvider').hidden = name !== 'openrouter';
    passed.ai = false;
    passed.embeddings = false;
  }
  $('aiProvider').addEventListener('change', (event) => applyPreset(event.target.value));

  $('aiDisabled').addEventListener('change', (event) => {
    $('aiFields').hidden = event.target.checked;
  });
  $('aiSeparateEmbeddings').addEventListener('change', (event) => {
    $('aiEmbeddingProvider').hidden = !event.target.checked;
    passed.embeddings = false;
  });
  ['aiBaseUrl', 'aiApiKey', 'aiChatModel'].forEach((id) => $(id).addEventListener('input', () => { passed.ai = false; passed.embeddings = false; }));
  ['aiEmbeddingModel', 'aiEmbeddingBaseUrl', 'aiEmbeddingApiKey'].forEach((id) => $(id).addEventListener('input', () => { passed.embeddings = false; }));

  const aiBase = () => ({ baseUrl: value('aiBaseUrl'), apiKey: value('aiApiKey') });
  const embeddingBody = () => ({
    ...aiBase(),
    model: value('aiEmbeddingModel'),
    ...($('aiSeparateEmbeddings').checked && { embeddingBaseUrl: value('aiEmbeddingBaseUrl'), embeddingApiKey: value('aiEmbeddingApiKey') })
  });

  const TESTS = {
    ai: {
      body: () => ({ ...aiBase(), chatModel: value('aiChatModel') }),
      ok: (result) => {
        const models = result.details.models || [];
        const list = $('aiModelList');
        list.replaceChildren(...models.map((id) => Object.assign(document.createElement('option'), { value: id })));
        passed.ai = !!value('aiChatModel');
        return passed.ai ? text('steps.ai.connectionOk', { count: models.length }) : text('steps.ai.pickModel', { count: models.length });
      }
    },
    embeddings: {
      body: embeddingBody,
      ok: (result) => {
        passed.embeddings = true;
        return text('steps.ai.embeddingsOk', { dimensions: result.details.dimensions });
      }
    },
    vision: {
      body: () => ({ ...aiBase(), model: value('aiVisionModel') }),
      ok: () => text('steps.ai.visionOk')
    },
    speech: {
      body: () => ({ ...aiBase(), model: value('aiTtsModel'), voice: value('aiTtsVoice') }),
      ok: () => text('steps.ai.speechOk'),
      extra: (result) => {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = result.details.audio;
        return [audio];
      }
    },
    email: {
      body: () => ({
        host: value('smtpHost'),
        port: Number(value('smtpPort')) || 587,
        security: $('smtpSecurity').value,
        user: value('smtpUser'),
        password: $('smtpPassword').value,
        from: value('emailFrom'),
        to: value('email')
      }),
      ok: (result) => {
        passed.email = true;
        return text('steps.email.sent', { to: result.details.sentTo });
      }
    }
  };

  document.querySelectorAll('[data-test]').forEach((button) => {
    button.addEventListener('click', async () => {
      const part = button.dataset.test;
      const container = document.querySelector(`[data-result="${part}"]`);
      const label = button.textContent;
      button.disabled = true;
      button.textContent = text('testing');
      try {
        const result = await postJson(`/setup/api/test/${part}`, TESTS[part].body());
        const okText = result.ok ? TESTS[part].ok(result) : '';
        if (!result.ok && part in passed) passed[part] = false;
        showResult(container, result, okText, result.ok && TESTS[part].extra ? TESTS[part].extra(result) : []);
      } catch {
        showResult(container, { ok: false, code: 'CHECK_CRASHED', details: {} }, '');
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
  });

  // ----------------------------------------------------------------- 5. email

  $('emailSkip').addEventListener('change', (event) => {
    $('emailFields').hidden = event.target.checked;
    $('emailSkipWarning').hidden = !event.target.checked;
  });
  ['smtpHost', 'smtpPort', 'smtpSecurity', 'smtpUser', 'smtpPassword', 'emailFrom'].forEach((id) => {
    $(id).addEventListener('input', () => { passed.email = false; });
  });
  $('smtpSecurity').addEventListener('change', (event) => {
    if (event.target.value === 'tls' && value('smtpPort') === '587') $('smtpPort').value = '465';
    if (event.target.value === 'starttls' && value('smtpPort') === '465') $('smtpPort').value = '587';
  });

  // -------------------------------------------------------------- 6. features

  async function toggleContainer(checkbox, part) {
    const container = document.querySelector(`[data-result="${part}"]`);
    if (!checkbox.checked) {
      container.replaceChildren();
      container.className = 'setup-result';
      return;
    }
    const result = await postJson(`/setup/api/test/${part}`, {});
    showResult(container, result, text('steps.features.running'));
    if (!result.ok) checkbox.checked = false;
  }
  $('featureNsfw').addEventListener('change', (event) => toggleContainer(event.target, 'nsfw'));
  $('featureParser').addEventListener('change', (event) => toggleContainer(event.target, 'parser'));

  // --------------------------------------------------------------- 7. install

  function collectSettings() {
    const settings = {
      'nsfw.enabled': $('featureNsfw').checked,
      'documents.parserEnabled': $('featureParser').checked,
      'branding.poweredBy': $('featurePoweredBy').checked,
      'pexels.apiKey': value('pexelsApiKey') || null
    };
    if ($('aiDisabled').checked) {
      settings['ai.enabled'] = false;
    } else {
      const chatModel = value('aiChatModel');
      Object.assign(settings, {
        'ai.enabled': true,
        'ai.baseUrl': value('aiBaseUrl'),
        'ai.apiKey': value('aiApiKey'),
        'ai.chatModel': chatModel,
        'ai.fallbackModel': chatModel,
        'ai.classifierModel': chatModel,
        'ai.embeddingModel': value('aiEmbeddingModel'),
        'ai.embeddingBaseUrl': $('aiSeparateEmbeddings').checked ? value('aiEmbeddingBaseUrl') || null : null,
        'ai.embeddingApiKey': $('aiSeparateEmbeddings').checked ? value('aiEmbeddingApiKey') || null : null,
        'ai.visionModel': value('aiVisionModel') || null,
        'ai.imageAnalysis': !!value('aiVisionModel'),
        'ai.ttsModel': value('aiTtsModel') || null,
        'ai.ttsVoice': value('aiTtsVoice') || null,
        'ai.speech': !!value('aiTtsModel')
      });
    }
    if ($('emailSkip').checked) {
      settings['email.provider'] = 'smtp';
      settings['email.smtpHost'] = null;
    } else {
      Object.assign(settings, {
        'email.provider': 'smtp',
        'email.smtpHost': value('smtpHost'),
        'email.smtpPort': Number(value('smtpPort')) || 587,
        'email.smtpSecurity': $('smtpSecurity').value,
        'email.smtpUser': value('smtpUser') || null,
        'email.smtpPassword': $('smtpPassword').value || null,
        'email.from': value('emailFrom')
      });
    }
    return settings;
  }

  function renderSummary() {
    const on = text('steps.install.on');
    const off = text('steps.install.off');
    const rows = [
      ['organization', `${value('organizationName')} (${$('language').selectedOptions[0].textContent})`],
      ['admin', `${value('firstName')} ${value('lastName')}, ${value('email')}`],
      ['ai', $('aiDisabled').checked ? off : `${$('aiProvider').selectedOptions[0].textContent}, ${value('aiChatModel')}`],
      ['email', $('emailSkip').checked ? off : `${value('smtpHost')}:${value('smtpPort')}`],
      ['nsfw', $('featureNsfw').checked ? on : off],
      ['parser', $('featureParser').checked ? on : off],
      ['poweredBy', $('featurePoweredBy').checked ? on : off]
    ];
    const list = $('installSummary');
    list.replaceChildren();
    rows.forEach(([key, shown]) => {
      const term = document.createElement('dt');
      term.textContent = text(`steps.install.summary.${key}`);
      const detail = document.createElement('dd');
      detail.textContent = shown;
      list.append(term, detail);
    });
  }

  const FIELD_STEP = {
    organizationName: 'organization', language: 'organization',
    firstName: 'admin', lastName: 'admin', email: 'admin', password: 'admin'
  };

  $('installButton').addEventListener('click', async () => {
    const button = $('installButton');
    const progress = $('installProgress');
    const result = $('installResult');
    button.disabled = true;
    $('backButton').disabled = true;
    progress.hidden = false;
    progress.replaceChildren();
    result.replaceChildren();
    result.className = 'setup-result';

    const account = {
      organizationName: value('organizationName'),
      language: $('language').value,
      firstName: value('firstName'),
      lastName: value('lastName'),
      email: value('email'),
      password: $('password').value
    };

    const finish = (message, ok) => {
      result.className = `setup-result ${ok ? 'setup-result--ok' : 'setup-result--error'}`;
      const line = document.createElement('p');
      line.textContent = message;
      result.replaceChildren(line);
    };

    try {
      const response = await fetch('/setup/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, settings: collectSettings() })
      });
      // Progress comes as one JSON line per step; anything else is a refusal
      // in one plain JSON answer (an expired setup session, for example)
      if (response.status === 401) {
        window.location.href = '/setup';
        return;
      }
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        finish(`${errorText(data.code || 'INSTALL_FAILED')} ${text('steps.install.failed')}`, false);
        button.disabled = false;
        $('backButton').disabled = false;
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (message.step) {
            const item = document.createElement('li');
            item.className = 'setup-check setup-check--ok';
            item.textContent = text(`steps.install.progress.${message.step}`);
            progress.append(item);
          } else if (message.done) {
            button.hidden = true;
            document.querySelector('.setup-nav').hidden = true;
            finish(text('steps.install.done'), true);
            const link = document.createElement('a');
            link.href = message.redirect;
            link.className = 'setup-button setup-button--primary';
            link.textContent = text('steps.install.goToLogin');
            result.append(link);
            link.focus();
            return;
          } else if (message.error) {
            finish(`${errorText(message.error, { field: message.field })} ${text('steps.install.failed')}`, false);
            const step = FIELD_STEP[message.field];
            if (step) showStep(STEPS.indexOf(step));
          }
        }
      }
    } catch {
      finish(`${text('errors.INSTALL_FAILED')} ${text('steps.install.failed')}`, false);
    }
    button.disabled = false;
    $('backButton').disabled = false;
  });

  // ------------------------------------------------------------------ start

  applyPreset('mistral');
  showStep(0);
  runServerChecks();
})();
