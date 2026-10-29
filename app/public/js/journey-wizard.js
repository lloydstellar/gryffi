/**
 * Journey Wizard - client-side controller
 *
 * Handles state, navigation, validation, document upload and SSE-based
 * generation of a new journey based on wizard answers.
 *
 * Exposes window.GryffiWizard with open()/close() methods. Reads its i18n
 * dictionary and config from window.GryffiWizardI18n and window.GryffiWizardConfig
 * which are rendered server-side.
 */
(function () {
  'use strict';

  const I18N = window.GryffiWizardI18n || {};
  const CFG = window.GryffiWizardConfig || {};

  const STORAGE_KEY = 'gryffi_wizard_state_v1';
  const STORAGE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
  const TOPIC_MIN_LENGTH = 30;

  // Slider stops, in left-to-right order. The midpoint ('medium') is the
  // default. Token names match the backend's LENGTH_RANGES keys so the wizard
  // payload travels through verbatim.
  const LENGTH_STOPS = ['very-short', 'short', 'medium', 'long', 'very-long'];
  const LENGTH_DEFAULT_IDX = 2;
  // Backwards compat for older saved sessions that pre-date the slider.
  const LEGACY_LENGTH_MAP = { short: 'short', medium: 'medium', long: 'long' };

  // Branching complexity stops, used by the inline sub-config under the
  // "Keuzemoment" component checkbox. Order matters: index 0 is the most
  // restrained shape (1 quick split, paths merge again), index 4 is the most
  // open shape (multiple splits, paths can have separate endings). Token names
  // match the backend's BRANCHING_PROFILES keys.
  const BRANCHING_STOPS = ['subtle', 'variation', 'routes', 'adventure', 'open'];
  const BRANCHING_DEFAULT_IDX = 2;

  // ---------------------------------------------------------------------------
  // Page sequence
  // ---------------------------------------------------------------------------
  // "topic" is skipped if source === 'upload'
  // "reward" always asked, but maps to a single optional closing step.
  // Title + description are NOT asked — Mistral proposes them so the maker can
  // focus on the substance and rename it later in the builder.
  // Page order after the Option-C redesign: purpose & audience are merged
  // into a single screen, guide/branching/reward are merged into a single
  // "components" multi-select page (with inline sub-config for guide/reward).
  const ALL_PAGES = [
    'source',
    'topic',
    'purpose',
    'length',
    'components',
    'language',
    'summary'
  ];

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let state = defaultState();
  let currentPage = 'source';
  let uploadAbortController = null;
  let sseAbortController = null;

  function defaultState() {
    return {
      source: null,          // 'upload' | 'describe'
      uploadId: null,        // server-side session id returned by upload endpoint
      uploadFileName: null,
      uploadPages: null,
      uploadWarnings: [],
      topic: '',
      purpose: null,
      audience: '',
      // Components-page selections. Each maps to a single backend field. Guide,
      // reward, and branching keep their existing string/enum shape so the
      // backend prompt logic stays unchanged. Quiz/poll/form/space are simple
      // booleans grouped under `components`.
      components: { quiz: false, poll: false, form: false, space: false, video: false, image: false },
      guide: 'none',         // 'existing' | 'newWithKb' | 'newNoKb' | 'none'
      guideExistingId: null,
      guideName: '',
      length: 'medium',
      branching: 'no',
      // Branching complexity is ignored when branching === 'no'. Stored
      // separately so toggling the checkbox off and back on preserves the
      // maker's choice of complexity stop.
      branchingComplexity: 'routes',
      reward: 'none',        // 'voucher' | 'certificate' | 'thankyou' | 'later' | 'none'
      rewardDetails: '',
      language: CFG.interfaceLanguage || 'en',
      title: '',
      description: '',
      savedAt: Date.now()
    };
  }

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------
  const modal = document.getElementById('journeyWizardModal');
  if (!modal) return;

  const $ = (sel, ctx = modal) => ctx.querySelector(sel);
  const $$ = (sel, ctx = modal) => Array.from(ctx.querySelectorAll(sel));

  const pagesBySlug = {};
  $$('[data-jw-page]').forEach(el => { pagesBySlug[el.dataset.jwPage] = el; });

  const el = {
    stepCounter: $('#jwStepCounter'),
    progressFill: $('#jwProgressFill'),
    backBtn: $('#jwBackBtn'),
    nextBtn: $('#jwNextBtn'),
    footer: $('#jwFooter'),
    // source
    fileInput: $('#jwFileInput'),
    uploadArea: $('#jwUploadArea'),
    uploadIdle: $('#jwUploadIdle'),
    uploadBusy: $('#jwUploadBusy'),
    uploadDone: $('#jwUploadDone'),
    uploadFileName: $('#jwUploadFileName'),
    uploadPageHint: $('#jwUploadPageHint'),
    uploadError: $('#jwUploadError'),
    chooseFileBtn: $('#jwChooseFile'),
    changeFileBtn: $('#jwChangeFile'),
    // topic
    topicText: $('#jwTopicText'),
    topicError: $('#jwTopicError'),
    // audience
    audienceText: $('#jwAudienceText'),
    // guide
    guideExistingField: $('#jwGuideExistingField'),
    guideExistingSelect: $('#jwGuideExistingSelect'),
    guideNameField: $('#jwGuideNameField'),
    guideName: $('#jwGuideName'),
    // reward
    rewardDetailsField: $('#jwRewardDetailsField'),
    rewardDetails: $('#jwRewardDetails'),
    // length (slider)
    lengthSlider: $('#jwLengthSlider'),
    lengthFill: $('#jwLengthFill'),
    // branching complexity (slider, inside components page sub-config)
    branchingSlider: $('#jwBranchingSlider'),
    branchingFill: $('#jwBranchingFill'),
    branchingDescription: $('#jwBranchingDescription'),
    // language
    languageSelect: $('#jwLanguage'),
    // summary
    summaryList: $('#jwSummaryList'),
    // progress
    progressStatus: $('#jwProgressStatus'),
    progressBarFill: $('#jwProgressBarFill'),
    // success
    openBuilder: $('#jwOpenBuilder'),
    // error
    errorMessage: $('#jwErrorMessage'),
    errorRetry: $('#jwErrorRetry'),
    errorFallback: $('#jwErrorFallback'),
    // resume
    resumeContinue: $('#jwResumeContinue'),
    resumeFresh: $('#jwResumeFresh')
  };

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------
  function visiblePages() {
    return ALL_PAGES.filter(p => {
      if (p === 'topic' && state.source !== 'describe') return false;
      return true;
    });
  }

  function pageIndex(slug) {
    return visiblePages().indexOf(slug);
  }

  function showPage(slug) {
    currentPage = slug;
    Object.values(pagesBySlug).forEach(p => { p.hidden = true; });
    if (pagesBySlug[slug]) pagesBySlug[slug].hidden = false;
    updateFooterFor(slug);
    updateProgress();
    persistState();
    if (slug === 'summary') renderSummary();
    updateNextState();
    // Reset body scroll on page change. The browser sometimes preserves the
    // previous page's scrollTop (or auto-scrolls focused but visually-hidden
    // form controls into view), which on the components page can leave the
    // scroll position parked far below the actual content — looking like a
    // big white area below the footer to the maker.
    const body = $('#jwBody');
    if (body) body.scrollTop = 0;
  }

  // ---------------------------------------------------------------------------
  // Diagnostic mode (opt-in via ?wizard-debug=1) — paints a live overlay with
  // scroll metrics on the modal so we can see exactly what's going on without
  // having to keep a DevTools panel open. Activate it by appending the query
  // parameter to the page URL, then open the wizard. Disable: remove the param.
  // ---------------------------------------------------------------------------
  const WIZARD_DEBUG = (() => {
    try {
      return new URLSearchParams(window.location.search).get('wizard-debug') === '1';
    } catch (_) { return false; }
  })();
  let debugOverlay = null;
  function debugLog(...args) {
    if (!WIZARD_DEBUG) return;
    console.log('[wizard-debug]', ...args);
  }
  function ensureDebugOverlay() {
    if (!WIZARD_DEBUG || debugOverlay) return;
    debugOverlay = document.createElement('div');
    debugOverlay.id = 'jwDebugOverlay';
    debugOverlay.style.cssText = [
      'position:fixed','left:8px','bottom:8px','z-index:99999',
      'background:rgba(0,0,0,0.85)','color:#9fefa1','font:12px/1.45 ui-monospace,monospace',
      'padding:10px 12px','border-radius:8px','max-width:380px','white-space:pre-wrap',
      'pointer-events:none','box-shadow:0 6px 16px rgba(0,0,0,0.4)'
    ].join(';');
    document.body.appendChild(debugOverlay);
  }
  function refreshDebugOverlay(reason) {
    if (!WIZARD_DEBUG || !debugOverlay) return;
    const body = $('#jwBody');
    const content = modal.querySelector('.jw-modal-content');
    const active = document.activeElement;
    const lines = [
      `page: ${currentPage}    reason: ${reason || '-'}`,
      body ? `body  scrollTop=${body.scrollTop}  scrollHeight=${body.scrollHeight}  clientHeight=${body.clientHeight}` : 'body: (not found)',
      content ? `content  height=${content.offsetHeight}  rect.top=${Math.round(content.getBoundingClientRect().top)}` : '',
      `viewport ${window.innerWidth}x${window.innerHeight}`,
      active ? `focus: <${active.tagName.toLowerCase()}${active.id ? '#' + active.id : ''}${active.name ? ' name=' + active.name : ''}${active.value !== undefined ? ' value=' + active.value : ''}>` : 'focus: -'
    ];
    debugOverlay.textContent = lines.filter(Boolean).join('\n');
  }
  if (WIZARD_DEBUG) {
    ensureDebugOverlay();
    // Capture every scroll on the body and log a stack trace so we can see
    // WHO scrolled it (a click, a focus, scrollIntoView, etc.).
    const tickRefresh = (reason) => requestAnimationFrame(() => refreshDebugOverlay(reason));
    document.addEventListener('focusin', (e) => {
      if (modal.contains(e.target)) {
        debugLog('focusin', e.target.tagName, e.target.name || '', e.target.id || '');
        tickRefresh('focusin ' + (e.target.id || e.target.name || e.target.tagName));
      }
    }, true);
    document.addEventListener('click', (e) => {
      if (modal.contains(e.target)) tickRefresh('click ' + (e.target.tagName.toLowerCase()));
    }, true);
    setInterval(() => refreshDebugOverlay('tick'), 500);
    // Also instrument the body's scroll directly.
    const body = $('#jwBody');
    if (body) {
      body.addEventListener('scroll', () => {
        debugLog('scroll', { scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight });
        tickRefresh('scroll');
      }, { passive: true });
    }
  }

  function updateFooterFor(slug) {
    const hideFooter = ['progress', 'success', 'error', 'resume'].includes(slug);
    el.footer.hidden = hideFooter;
    if (hideFooter) return;

    const idx = pageIndex(slug);
    el.backBtn.disabled = idx <= 0;
    el.backBtn.style.visibility = idx > 0 ? 'visible' : 'hidden';
    el.nextBtn.textContent = (slug === 'summary') ? I18N.generateButton : I18N.nextButton;
  }

  function updateProgress() {
    const pages = visiblePages();
    const idx = pageIndex(currentPage);
    if (idx < 0) {
      el.progressFill.style.width = '0%';
      el.stepCounter.textContent = '';
      return;
    }
    const pct = Math.round(((idx + 1) / pages.length) * 100);
    el.progressFill.style.width = pct + '%';
    const counterTpl = I18N.stepCounter || 'Step {{current}} of {{total}}';
    el.stepCounter.textContent = counterTpl
      .replace('{{current}}', idx + 1)
      .replace('{{total}}', pages.length);
  }

  function goNext() {
    if (!validateCurrent()) return;
    if (currentPage === 'summary') {
      startGeneration();
      return;
    }
    const pages = visiblePages();
    const idx = pages.indexOf(currentPage);
    if (idx < pages.length - 1) showPage(pages[idx + 1]);
  }

  function goBack() {
    const pages = visiblePages();
    const idx = pages.indexOf(currentPage);
    if (idx > 0) showPage(pages[idx - 1]);
  }

  // ---------------------------------------------------------------------------
  // Validation + next-button enable
  // ---------------------------------------------------------------------------
  function validateCurrent() {
    switch (currentPage) {
      case 'source':
        if (!state.source) return false;
        if (state.source === 'upload' && !state.uploadId) return false;
        return true;
      case 'topic': {
        const text = (el.topicText.value || '').trim();
        if (text.length < TOPIC_MIN_LENGTH) {
          showError(el.topicError, I18N.errors.topicMinLength);
          return false;
        }
        state.topic = text;
        hideError(el.topicError);
        return true;
      }
      case 'purpose':
        // Audience is now collected on this same page (inline field) — pull
        // its value into state on validation so it travels with the wizard.
        if (el.audienceText) state.audience = (el.audienceText.value || '').trim();
        return !!state.purpose;
      case 'length':
        return !!state.length;
      case 'components': {
        // Guide checkbox: if ticked, the relevant sub-fields must be valid.
        if (state.guide && state.guide !== 'none') {
          if (state.guide === 'existing' && !state.guideExistingId) return false;
          if (state.guide === 'newWithKb' || state.guide === 'newNoKb') {
            const name = (el.guideName && el.guideName.value || '').trim();
            if (!name) return false;
            state.guideName = name;
          }
        }
        // Reward checkbox: a reward type must be picked when the box is ticked.
        if (state.reward && state.reward !== 'none') {
          state.rewardDetails = (el.rewardDetails && el.rewardDetails.value || '').trim();
        }
        return true;
      }
      case 'language':
        state.language = el.languageSelect.value;
        return !!state.language;
      case 'summary':
        return true;
      default:
        return true;
    }
  }

  function updateNextState() {
    if (!el.nextBtn || el.footer.hidden) return;
    let ok = false;
    switch (currentPage) {
      case 'source':
        ok = state.source === 'describe' ||
             (state.source === 'upload' && !!state.uploadId);
        break;
      case 'topic':
        ok = (el.topicText.value || '').trim().length >= TOPIC_MIN_LENGTH;
        break;
      case 'purpose': ok = !!state.purpose; break;
      case 'length': ok = !!state.length; break;
      case 'components':
        // The components page is always passable; even an empty selection is
        // valid (= journey of pure content steps). The only reason to block
        // Next is when Guide or Reward is ticked but their sub-config is
        // incomplete (need a guide name / pick an existing one).
        if (state.guide === 'existing') ok = !!(el.guideExistingSelect && el.guideExistingSelect.value);
        else if (state.guide === 'newWithKb' || state.guide === 'newNoKb') ok = !!(el.guideName && (el.guideName.value || '').trim());
        else ok = true;
        break;
      case 'language': ok = !!el.languageSelect.value; break;
      case 'summary': ok = true; break;
      default: ok = true;
    }
    el.nextBtn.disabled = !ok;
  }

  function showError(errEl, msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function hideError(errEl) {
    if (!errEl) return;
    errEl.hidden = true;
    errEl.textContent = '';
  }

  // ---------------------------------------------------------------------------
  // Card radio sync
  // ---------------------------------------------------------------------------
  function syncCards(name) {
    $$(`input[name="${name}"]`).forEach(input => {
      const card = input.closest('.jw-card');
      if (!card) return;
      if (input.checked) card.classList.add('is-selected');
      else card.classList.remove('is-selected');
    });
  }

  /**
   * Visual sync for the length slider: positions the input value, paints the
   * fill bar, marks the active stop dot, and emphasises the matching tick
   * label. Called whenever state.length changes (slider input, state restore,
   * summary edit-link).
   */
  function syncLengthSlider() {
    if (!el.lengthSlider) return;
    let idx = LENGTH_STOPS.indexOf(state.length);
    if (idx < 0) idx = LENGTH_DEFAULT_IDX;
    el.lengthSlider.value = String(idx);
    el.lengthSlider.setAttribute('aria-valuenow', String(idx));
    const pct = (idx / (LENGTH_STOPS.length - 1)) * 100;
    if (el.lengthFill) el.lengthFill.style.width = pct + '%';
    $$('[data-jw-length-stop]').forEach(node => {
      const i = LENGTH_STOPS.indexOf(node.dataset.jwLengthStop);
      node.classList.toggle('is-active', i <= idx);
    });
    $$('[data-jw-length-tick]').forEach(node => {
      node.classList.toggle('is-active', node.dataset.jwLengthTick === LENGTH_STOPS[idx]);
    });
  }

  // Mirror sync for the branching complexity slider. Same shape as
  // syncLengthSlider so the visual behaviour matches one-for-one. Also paints
  // the per-stop description hint underneath, since the names alone ("subtle",
  // "open") would be too abstract on their own.
  function syncBranchingSlider() {
    if (!el.branchingSlider) return;
    let idx = BRANCHING_STOPS.indexOf(state.branchingComplexity);
    if (idx < 0) idx = BRANCHING_DEFAULT_IDX;
    el.branchingSlider.value = String(idx);
    el.branchingSlider.setAttribute('aria-valuenow', String(idx));
    const pct = (idx / (BRANCHING_STOPS.length - 1)) * 100;
    if (el.branchingFill) el.branchingFill.style.width = pct + '%';
    $$('[data-jw-branching-stop]').forEach(node => {
      const i = BRANCHING_STOPS.indexOf(node.dataset.jwBranchingStop);
      node.classList.toggle('is-active', i <= idx);
    });
    $$('[data-jw-branching-tick]').forEach(node => {
      node.classList.toggle('is-active', node.dataset.jwBranchingTick === BRANCHING_STOPS[idx]);
    });
    if (el.branchingDescription && I18N.branchingDescriptions) {
      el.branchingDescription.textContent =
        I18N.branchingDescriptions[BRANCHING_STOPS[idx]] || '';
    }
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function wireEvents() {
    // Close
    $$('[data-jw-close]', modal).forEach(btn => btn.addEventListener('click', tryClose));
    $('[data-jw-close-overlay]', modal).addEventListener('click', tryClose);
    document.addEventListener('keydown', (e) => {
      if (modal.style.display === 'flex' && e.key === 'Escape') tryClose();
    });

    // Back / Next
    el.backBtn.addEventListener('click', goBack);
    el.nextBtn.addEventListener('click', goNext);

    // Source cards
    $$('input[name="jwSource"]').forEach(inp => {
      inp.addEventListener('change', () => {
        state.source = inp.value;
        syncCards('jwSource');
        el.uploadArea.hidden = state.source !== 'upload';
        updateGuideAvailability();
        updateNextState();
        persistState();
      });
    });

    // Upload
    el.chooseFileBtn.addEventListener('click', () => el.fileInput.click());
    el.changeFileBtn.addEventListener('click', () => {
      resetUploadUI();
      el.fileInput.value = '';
      el.fileInput.click();
    });
    el.fileInput.addEventListener('change', handleFileSelected);

    // Purpose cards. Picking a purpose also seeds smart defaults for the
    // components page — e.g. compliance journeys get Quiz pre-ticked, tour
    // and guest journeys get Location pre-ticked. The maker can always
    // override these on the next page.
    $$('input[name="jwPurpose"]').forEach(inp => {
      inp.addEventListener('change', () => {
        state.purpose = inp.value;
        syncCards('jwPurpose');
        applyPurposeDefaults();
        syncComponentsUI();
        updateNextState();
        persistState();
      });
    });

    // Audience (now lives on the purpose page)
    if (el.audienceText) {
      el.audienceText.addEventListener('input', () => {
        state.audience = el.audienceText.value;
        persistState();
      });
    }

    // Length slider — five named stops, no exact step counts surfaced to the
    // maker. The AI decides the actual number of steps based on this hint
    // plus how rich the source material is.
    if (el.lengthSlider) {
      el.lengthSlider.addEventListener('input', () => {
        const idx = parseInt(el.lengthSlider.value, 10);
        const value = LENGTH_STOPS[idx] || 'medium';
        state.length = value;
        syncLengthSlider();
        updateNextState();
        persistState();
      });
      syncLengthSlider();
    }

    // Branching complexity slider (lives inside the components-page sub-config)
    if (el.branchingSlider) {
      el.branchingSlider.addEventListener('input', () => {
        const idx = parseInt(el.branchingSlider.value, 10);
        const value = BRANCHING_STOPS[idx] || 'routes';
        state.branchingComplexity = value;
        syncBranchingSlider();
        updateNextState();
        persistState();
      });
      // The slider lives inside a <label>; clicks/drags would bubble up to the
      // checkbox and toggle "Keuzemoment" off again. Stop that bubbling here
      // so the maker can interact with the slider freely.
      ['click','mousedown','touchstart','keydown'].forEach(evt => {
        el.branchingSlider.addEventListener(evt, (e) => e.stopPropagation());
      });
      syncBranchingSlider();
    }

    // ---- Components page: 7 checkboxes + inline sub-config for guide/reward
    $$('input[name="jwComponent"]').forEach(inp => {
      inp.addEventListener('change', (e) => {
        // Sub-config rows live INSIDE the <label>, so a click on a radio pill
        // bubbles up and would also toggle the checkbox. Stop that.
        e.stopPropagation();
        applyComponentToggle(inp.value, inp.checked);
        syncComponentsUI();
        updateNextState();
        persistState();
      });
    });

    // Block clicks inside sub-config from toggling the parent checkbox.
    $$('[data-jw-subconfig]').forEach(sub => {
      sub.addEventListener('click', (e) => e.stopPropagation());
    });

    // Guide sub-config: mode pills + existing-select + name input
    $$('input[name="jwGuideMode"]').forEach(inp => {
      inp.addEventListener('change', () => {
        state.guide = inp.value;
        syncRadioPills('jwGuideMode');
        updateGuideSubfields();
        updateNextState();
        persistState();
      });
    });
    if (el.guideExistingSelect) {
      el.guideExistingSelect.addEventListener('change', () => {
        state.guideExistingId = el.guideExistingSelect.value || null;
        updateNextState();
        persistState();
      });
    }
    if (el.guideName) {
      el.guideName.addEventListener('input', () => {
        state.guideName = el.guideName.value;
        updateNextState();
        persistState();
      });
    }

    // Reward sub-config: type pills + free-text details
    $$('input[name="jwRewardType"]').forEach(inp => {
      inp.addEventListener('change', () => {
        state.reward = inp.value;
        syncRadioPills('jwRewardType');
        if (el.rewardDetailsField) {
          el.rewardDetailsField.hidden = !(state.reward === 'voucher' || state.reward === 'certificate' || state.reward === 'thankyou');
        }
        updateNextState();
        persistState();
      });
    });
    if (el.rewardDetails) {
      el.rewardDetails.addEventListener('input', () => {
        state.rewardDetails = el.rewardDetails.value;
        persistState();
      });
    }

    // Topic live validation
    el.topicText.addEventListener('input', () => {
      state.topic = el.topicText.value;
      updateNextState();
      if ((el.topicText.value || '').trim().length >= TOPIC_MIN_LENGTH) hideError(el.topicError);
      persistState();
    });

    // Language
    el.languageSelect.addEventListener('change', () => {
      state.language = el.languageSelect.value;
      persistState();
    });

    // Resume
    if (el.resumeContinue) el.resumeContinue.addEventListener('click', () => {
      hydrateUIFromState();
      const first = visiblePages()[0];
      showPage(first);
    });
    if (el.resumeFresh) el.resumeFresh.addEventListener('click', () => {
      state = defaultState();
      persistState();
      hydrateUIFromState();
      showPage('source');
    });

    // Error actions
    if (el.errorRetry) el.errorRetry.addEventListener('click', () => showPage('summary'));
    if (el.errorFallback) el.errorFallback.addEventListener('click', createFallbackBlank);
  }

  // ---------------------------------------------------------------------------
  // Guide subfields (shown inside the components page when Guide is ticked)
  // ---------------------------------------------------------------------------
  function updateGuideSubfields() {
    if (el.guideExistingField) el.guideExistingField.hidden = state.guide !== 'existing';
    if (el.guideNameField) {
      const showNameField = (state.guide === 'newWithKb' || state.guide === 'newNoKb');
      el.guideNameField.hidden = !showNameField;
    }
  }

  // ---------------------------------------------------------------------------
  // Components page helpers
  // ---------------------------------------------------------------------------
  // Read all checkbox state at once and project it onto the wizard's state
  // object. We keep guide/reward/branching as their existing string enums
  // (so the backend prompt code stays untouched) and the four "lightweight"
  // step types (quiz/poll/form/space) as plain booleans under `components`.
  function applyComponentToggle(key, checked) {
    if (key === 'guide') {
      if (checked) {
        // Default new guides to "newNoKb" since the radio pill is checked
        // server-side; the maker can switch to "existing" or "newWithKb".
        const selected = $('input[name="jwGuideMode"]:checked');
        state.guide = selected ? selected.value : 'newNoKb';
      } else {
        state.guide = 'none';
        state.guideExistingId = null;
      }
    } else if (key === 'reward') {
      if (checked) {
        const selected = $('input[name="jwRewardType"]:checked');
        state.reward = selected ? selected.value : 'voucher';
      } else {
        state.reward = 'none';
        state.rewardDetails = '';
      }
    } else if (key === 'branching') {
      state.branching = checked ? 'yes' : 'no';
    } else if (key === 'quiz' || key === 'poll' || key === 'form' || key === 'space' ||
               key === 'video' || key === 'image') {
      state.components[key] = !!checked;
    }
  }

  // Reflect the wizard's component state on the DOM: mark the right checkboxes
  // ticked, expand/collapse sub-config blocks, and apply the "selected" visual
  // styling. Used after state restore, after smart defaults, and after Back.
  function syncComponentsUI() {
    if (!pagesBySlug.components) return;
    const flagsByKey = {
      video:     !!state.components.video,
      image:     !!state.components.image,
      quiz:      !!state.components.quiz,
      poll:      !!state.components.poll,
      form:      !!state.components.form,
      space:     !!state.components.space,
      guide:     state.guide && state.guide !== 'none',
      reward:    state.reward && state.reward !== 'none',
      branching: state.branching === 'yes'
    };

    Object.keys(flagsByKey).forEach(key => {
      const inp = $(`input[name="jwComponent"][value="${key}"]`);
      if (!inp) return;
      inp.checked = flagsByKey[key];
      const label = inp.closest('.jw-check');
      if (label) label.classList.toggle('is-selected', flagsByKey[key]);
      const sub = label ? label.querySelector('[data-jw-subconfig]') : null;
      if (sub) sub.hidden = !flagsByKey[key];
    });

    // Sub-config: ensure radios + select reflect state too.
    if (state.guide && state.guide !== 'none') {
      const modeInp = $(`input[name="jwGuideMode"][value="${state.guide}"]`);
      if (modeInp) modeInp.checked = true;
      syncRadioPills('jwGuideMode');
      updateGuideSubfields();
    }
    if (state.reward && state.reward !== 'none') {
      const rewInp = $(`input[name="jwRewardType"][value="${state.reward}"]`);
      if (rewInp) rewInp.checked = true;
      syncRadioPills('jwRewardType');
      if (el.rewardDetailsField) {
        el.rewardDetailsField.hidden = !(state.reward === 'voucher' || state.reward === 'certificate' || state.reward === 'thankyou');
      }
    }

    // Repaint the branching complexity slider whenever the components page is
    // synced, so re-opening the wizard or toggling Keuzemoment back on shows
    // the previously-chosen stop instead of a stale 50% fill.
    if (state.branching === 'yes') {
      syncBranchingSlider();
    }
  }

  // Apply visual "is-selected" class to the active pill in a radio group.
  function syncRadioPills(name) {
    $$(`input[name="${name}"]`).forEach(input => {
      const pill = input.closest('.jw-radio-pill');
      if (!pill) return;
      pill.classList.toggle('is-selected', !!input.checked);
    });
  }

  // Smart defaults on purpose change. Only applied when the corresponding
  // component flag is still at its initial value (false / 'none' / 'no'),
  // so we never silently overwrite a maker's deliberate choice when they
  // come back from the components page to switch their purpose.
  function applyPurposeDefaults() {
    const p = state.purpose;
    if (!p) return;
    if (p === 'compliance' && state.components.quiz === false) {
      state.components.quiz = true;
    }
    if ((p === 'tour' || p === 'guest') && state.components.space === false) {
      state.components.space = true;
    }
  }

  // "New guide + use my document as knowledge base" only makes sense when the
  // maker actually uploaded a document in step 1. The guide sub-config now
  // lives inside the components-page checkbox row, so we operate on the
  // newWithKb radio pill there. When they picked "describe it yourself", we
  // disable the pill and surface a hint; if they already selected newWithKb
  // and then switched source, fall back to newNoKb.
  function updateGuideAvailability() {
    const radio = document.querySelector('input[name="jwGuideMode"][value="newWithKb"]');
    if (!radio) return;
    const pill = radio.closest('.jw-radio-pill');
    const tag = document.querySelector('[data-jw-needs-upload-tag]');
    const hasUpload = state.source === 'upload' && !!state.uploadId;
    const lockedByLimit = !!CFG.guidesAtLimit;

    if (!hasUpload && !lockedByLimit) {
      if (pill) pill.classList.add('jw-radio-pill-disabled');
      radio.disabled = true;
      if (tag) tag.hidden = false;
      if (pill) pill.setAttribute('title', I18N.guideKbDisabledHint || '');
      if (state.guide === 'newWithKb') {
        state.guide = 'newNoKb';
        const fallback = document.querySelector('input[name="jwGuideMode"][value="newNoKb"]');
        if (fallback) { fallback.checked = true; syncRadioPills('jwGuideMode'); }
        updateGuideSubfields();
      }
    } else if (!lockedByLimit) {
      if (pill) pill.classList.remove('jw-radio-pill-disabled');
      radio.disabled = false;
      if (tag) tag.hidden = true;
      if (pill) pill.removeAttribute('title');
    }
  }

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------
  async function handleFileSelected() {
    const file = el.fileInput.files && el.fileInput.files[0];
    if (!file) return;
    hideError(el.uploadError);

    if (file.size > MAX_UPLOAD_BYTES) {
      showError(el.uploadError, I18N.errors.uploadTooLarge);
      return;
    }

    el.uploadIdle.hidden = true;
    el.uploadBusy.hidden = false;
    el.uploadDone.hidden = true;

    const formData = new FormData();
    formData.append('file', file);

    uploadAbortController = new AbortController();
    try {
      const res = await fetch('/api/wizard/upload', {
        method: 'POST',
        body: formData,
        signal: uploadAbortController.signal
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const code = data && data.code;
        const msg = (code && I18N.errors[code]) || data.error || I18N.errors.uploadGeneric;
        throw new Error(msg);
      }
      // Defensive: make sure the source state matches the fact that we just
      // completed an upload, even if the radio-change event somehow never fired.
      state.source = 'upload';
      state.uploadId = data.uploadId;
      state.uploadFileName = data.fileName || file.name;
      state.uploadPages = data.pages || null;
      state.uploadWarnings = data.warnings || [];

      el.uploadBusy.hidden = true;
      el.uploadDone.hidden = false;
      el.uploadFileName.textContent = state.uploadFileName +
        (state.uploadPages ? ` · ${state.uploadPages} p.` : '');
      el.uploadPageHint.hidden = !(state.uploadWarnings && state.uploadWarnings.includes('truncated_pages'));

      // Also re-sync the source radio so the card shows as selected.
      const sourceRadio = document.querySelector('input[name="jwSource"][value="upload"]');
      if (sourceRadio && !sourceRadio.checked) {
        sourceRadio.checked = true;
        syncCards('jwSource');
      }

      console.debug('[Wizard] upload done', { uploadId: state.uploadId, source: state.source, currentPage });
      updateGuideAvailability();
      updateNextState();
      persistState();
      console.debug('[Wizard] nextBtn.disabled after upload:', el.nextBtn.disabled);
    } catch (err) {
      console.error('[Wizard] upload failed', err);
      resetUploadUI();
      showError(el.uploadError, err.message || I18N.errors.uploadGeneric);
    }
  }

  function resetUploadUI() {
    el.uploadIdle.hidden = false;
    el.uploadBusy.hidden = true;
    el.uploadDone.hidden = true;
    state.uploadId = null;
    state.uploadFileName = null;
    state.uploadPages = null;
    state.uploadWarnings = [];
    updateNextState();
    persistState();
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  function renderSummary() {
    const items = [];
    const S = I18N.summaryLabels || {};

    // Source
    items.push({
      key: 'source',
      label: S.source,
      value: state.source === 'upload'
        ? (S.sourceDocument || '').replace('{{name}}', state.uploadFileName || '')
        : (S.sourceDescribe || '').toString(),
      goto: 'source'
    });
    if (state.source === 'describe') {
      items.push({ key: 'topic', label: S.source, value: truncate(state.topic, 80), goto: 'topic' });
    }
    if (state.purpose) {
      items.push({ key: 'purpose', label: S.purpose, value: I18N.purposeLabels[state.purpose], goto: 'purpose' });
    }
    if (state.audience) {
      items.push({ key: 'audience', label: S.audience, value: truncate(state.audience, 80), goto: 'purpose' });
    }

    items.push({ key: 'length', label: S.length, value: I18N.lengthLabels[state.length], goto: 'length' });

    // Summarise the components page as a single comma-separated row, in the
    // same visual order as the checkbox list. If nothing is selected we still
    // show a "(none)" placeholder so the maker can spot empty journeys before
    // generating.
    const C = I18N.componentLabels || {};
    const componentParts = [];
    if (state.components.video)           componentParts.push(C.video);
    if (state.components.image)           componentParts.push(C.image);
    if (state.components.quiz)            componentParts.push(C.quiz);
    if (state.components.poll)            componentParts.push(C.poll);
    if (state.components.form)            componentParts.push(C.form);
    if (state.guide && state.guide !== 'none') {
      let label = C.guide;
      if (state.guide === 'existing' && state.guideExistingId && el.guideExistingSelect) {
        const opt = el.guideExistingSelect.options[el.guideExistingSelect.selectedIndex];
        const name = opt ? opt.textContent : '';
        if (name) label = `${C.guide} · ${name}`;
      } else if ((state.guide === 'newWithKb' || state.guide === 'newNoKb') && state.guideName) {
        label = `${C.guide} · ${state.guideName}`;
      }
      componentParts.push(label);
    }
    if (state.components.space)           componentParts.push(C.space);
    if (state.reward && state.reward !== 'none') {
      const rewardLabel = (I18N.rewardLabels && I18N.rewardLabels[state.reward]) || C.reward;
      componentParts.push(`${C.reward} · ${rewardLabel}`);
    }
    if (state.branching === 'yes') {
      const tickKey = state.branchingComplexity || BRANCHING_STOPS[BRANCHING_DEFAULT_IDX];
      const tickLabel = (I18N.branchingTicks && I18N.branchingTicks[tickKey]) || '';
      componentParts.push(tickLabel ? `${C.branching} · ${tickLabel}` : C.branching);
    }
    items.push({
      key: 'components',
      label: S.components,
      value: componentParts.length ? componentParts.join(', ') : (S.componentsNone || '—'),
      goto: 'components'
    });

    items.push({ key: 'language', label: S.language, value: state.language.toUpperCase(), goto: 'language' });
    // Name is chosen by Gryffi — show it as a non-editable row so the maker
    // understands the journey will get a suggested title they can rename later.
    items.push({ key: 'title', label: S.title, value: S.titleAuto || '—' });

    el.summaryList.innerHTML = '';
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'jw-summary-item';
      const dt = document.createElement('dt');
      dt.textContent = item.label || '';
      const dd = document.createElement('dd');
      dd.textContent = item.value || '';
      if (item.goto) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'jw-summary-edit';
        editBtn.textContent = S.editLink || 'Change';
        editBtn.addEventListener('click', () => showPage(item.goto));
        dd.appendChild(editBtn);
      }
      row.appendChild(dt);
      row.appendChild(dd);
      el.summaryList.appendChild(row);
    });
  }

  function truncate(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }

  // ---------------------------------------------------------------------------
  // Generation (SSE)
  // ---------------------------------------------------------------------------
  async function startGeneration() {
    showPage('progress');
    setProgress(0, 'thinking');

    const payload = {
      source: state.source,
      uploadId: state.uploadId,
      topic: state.topic,
      purpose: state.purpose,
      audience: state.audience,
      // Component checkboxes from the redesigned wizard. Guide / branching /
      // reward keep their existing string-enum shape (the backend already
      // understands them); the four lightweight types travel as booleans.
      components: {
        quiz:  !!state.components.quiz,
        poll:  !!state.components.poll,
        form:  !!state.components.form,
        space: !!state.components.space,
        video: !!state.components.video,
        image: !!state.components.image
      },
      guide: state.guide,
      guideExistingId: state.guideExistingId,
      guideName: state.guideName,
      length: state.length,
      branching: state.branching,
      // Only meaningful when branching === 'yes'; the backend ignores it
      // otherwise but having it in the payload makes wizard logs reproducible.
      branchingComplexity: state.branchingComplexity,
      reward: state.reward,
      rewardDetails: state.rewardDetails,
      language: state.language,
      title: state.title,
      description: state.description
    };

    sseAbortController = new AbortController();
    try {
      const res = await fetch('/api/wizard/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: sseAbortController.signal
      });

      if (!res.ok && !res.headers.get('content-type')?.includes('text/event-stream')) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || I18N.errors.generic);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }

          if (typeof data.progress === 'number') {
            // Pass the status *key* (e.g. 'thinking') to setProgress so it can
            // rotate through the per-phase variants. Falls back to data.message
            // if the server sent a custom message instead of a known status.
            setProgress(data.progress, data.status || data.message || '');
          }
          if (data.done && data.journeyId) {
            clearPersistedState();
            el.openBuilder.href = `/dashboard/builder/${data.journeyId}`;
            showSuccess();
            try { reader.cancel(); } catch (_) {}
            return;
          }
          if (data.error) {
            try { reader.cancel(); } catch (_) {}
            // Map known server error codes to localised friendly messages.
            // Falls back to the raw server message when no code is set so we
            // don't accidentally swallow useful context.
            const codeMessages = {
              mistral_timeout:     I18N.errors.timeout,
              mistral_rate_limit:  I18N.errors.rateLimit,
              mistral_unavailable: I18N.errors.serviceUnavailable
            };
            const friendly = data.code && codeMessages[data.code];
            showFailure(friendly || data.error);
            return;
          }
        }
      }
    } catch (err) {
      console.error('[Wizard] generation failed', err);
      showFailure(err.message || I18N.errors.generic);
    }
  }

  // Visible "creep" between server-side milestones. The Mistral call between
  // 15% and 45% takes 10-30s; without creep the bar appears frozen. We slowly
  // approach the next milestone asymptotically so the user keeps seeing motion,
  // and snap to the real value as soon as the next SSE event arrives.
  const PROGRESS_NEXT_MILESTONE = {
    0: 15, 5: 15, 15: 45, 45: 55, 55: 65, 65: 75, 75: 95
  };

  // Each server-sent status maps to a list of i18n keys. We rotate through
  // them every few seconds so the user keeps seeing the wizard "do something",
  // especially during the long Mistral call (status: thinking).
  const PROGRESS_STATUS_PHASES = {
    reading:   ['reading', 'reading2'],
    thinking:  ['thinking', 'thinking2', 'thinking3', 'thinking4', 'thinking5'],
    creating:  ['creating', 'creating2'],
    guide:     ['guide', 'guide2'],
    knowledge: ['knowledge', 'knowledge2', 'knowledge3'],
    steps:     ['steps', 'steps2', 'paths'],
    finishing: ['finishing']
  };
  const PROGRESS_STATUS_ROTATE_MS = 3500;

  let progressCreepTimer = null;
  let progressStatusTimer = null;
  let currentProgressPct = 0;

  function stopProgressCreep() {
    if (progressCreepTimer) {
      clearInterval(progressCreepTimer);
      progressCreepTimer = null;
    }
  }

  function startProgressCreep(milestone) {
    stopProgressCreep();
    if (typeof milestone !== 'number' || milestone <= currentProgressPct) return;
    const target = milestone - 1; // never reach the next real milestone
    progressCreepTimer = setInterval(() => {
      const remaining = target - currentProgressPct;
      if (remaining <= 0.1) { stopProgressCreep(); return; }
      currentProgressPct += remaining * 0.04;
      el.progressBarFill.style.width = currentProgressPct.toFixed(2) + '%';
    }, 250);
  }

  function stopStatusRotation() {
    if (progressStatusTimer) {
      clearInterval(progressStatusTimer);
      progressStatusTimer = null;
    }
  }

  function startStatusRotation(status) {
    stopStatusRotation();
    const keys = PROGRESS_STATUS_PHASES[status];
    if (!keys || keys.length === 0) return;
    // Show the first variant immediately, then rotate.
    const firstMsg = I18N.progressStatus[keys[0]];
    if (firstMsg) el.progressStatus.textContent = firstMsg;
    if (keys.length === 1) return;
    let idx = 1;
    progressStatusTimer = setInterval(() => {
      const msg = I18N.progressStatus[keys[idx]];
      if (msg) el.progressStatus.textContent = msg;
      // Stop on the last variant — keep that line until the next phase arrives.
      if (idx >= keys.length - 1) {
        stopStatusRotation();
        return;
      }
      idx += 1;
    }, PROGRESS_STATUS_ROTATE_MS);
  }

  function setProgress(pct, status) {
    stopProgressCreep();
    const clamped = Math.max(0, Math.min(100, pct));
    if (clamped === 0) {
      currentProgressPct = 0;
    } else {
      // Don't visually rewind: creep may already have pushed past a low value.
      currentProgressPct = Math.max(currentProgressPct, clamped);
    }
    el.progressBarFill.style.width = currentProgressPct.toFixed(2) + '%';
    if (status && PROGRESS_STATUS_PHASES[status]) {
      startStatusRotation(status);
    } else if (status && I18N.progressStatus[status]) {
      stopStatusRotation();
      el.progressStatus.textContent = I18N.progressStatus[status];
    }
    startProgressCreep(PROGRESS_NEXT_MILESTONE[clamped]);
  }

  function showSuccess() {
    stopProgressCreep();
    stopStatusRotation();
    currentProgressPct = 100;
    Object.values(pagesBySlug).forEach(p => { p.hidden = true; });
    pagesBySlug.success.hidden = false;
    el.footer.hidden = true;
    el.progressFill.style.width = '100%';
    if (el.progressBarFill) el.progressBarFill.style.width = '100%';
  }

  function showFailure(msg) {
    stopProgressCreep();
    stopStatusRotation();
    Object.values(pagesBySlug).forEach(p => { p.hidden = true; });
    pagesBySlug.error.hidden = false;
    el.errorMessage.textContent = msg || I18N.errors.generic;
    el.footer.hidden = true;
  }

  async function createFallbackBlank() {
    // Send a minimal create-journey request and go to the builder.
    try {
      const res = await fetch('/dashboard/journeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ title: state.title || 'Untitled', description: state.description || '' })
      });
      if (res.redirected) {
        window.location.href = res.url;
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data && data.journeyId) {
        window.location.href = `/dashboard/builder/${data.journeyId}`;
      } else {
        window.location.href = '/dashboard/journeys/new';
      }
    } catch {
      window.location.href = '/dashboard/journeys/new';
    }
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------
  function persistState() {
    state.savedAt = Date.now();
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }
  function loadPersistedState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.savedAt || (Date.now() - s.savedAt) > STORAGE_TTL_MS) return null;
      return s;
    } catch (_) { return null; }
  }
  function clearPersistedState() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function hydrateUIFromState() {
    // Source
    if (state.source) {
      const inp = document.querySelector(`input[name="jwSource"][value="${state.source}"]`);
      if (inp) { inp.checked = true; syncCards('jwSource'); }
      el.uploadArea.hidden = state.source !== 'upload';
      if (state.source === 'upload' && state.uploadId) {
        el.uploadIdle.hidden = true;
        el.uploadBusy.hidden = true;
        el.uploadDone.hidden = false;
        el.uploadFileName.textContent = state.uploadFileName +
          (state.uploadPages ? ` · ${state.uploadPages} p.` : '');
        el.uploadPageHint.hidden = !(state.uploadWarnings && state.uploadWarnings.includes('truncated_pages'));
      }
    }
    // Free-text fields
    if (el.topicText) el.topicText.value = state.topic || '';
    if (el.audienceText) el.audienceText.value = state.audience || '';
    if (el.rewardDetails) el.rewardDetails.value = state.rewardDetails || '';
    if (el.guideName) el.guideName.value = state.guideName || '';
    if (el.languageSelect) el.languageSelect.value = state.language || (CFG.interfaceLanguage || 'en');

    // Migrate legacy persisted state from older wizard versions: the components
    // bag may not exist, and `guide`/`branching`/`reward` may already carry
    // values that we want to project onto the new components page.
    if (!state.components || typeof state.components !== 'object') {
      state.components = { quiz: false, poll: false, form: false, space: false, video: false, image: false };
    } else {
      state.components.quiz  = !!state.components.quiz;
      state.components.poll  = !!state.components.poll;
      state.components.form  = !!state.components.form;
      state.components.space = !!state.components.space;
      state.components.video = !!state.components.video;
      state.components.image = !!state.components.image;
    }

    // Purpose radio
    if (state.purpose) {
      const inp = document.querySelector(`input[name="jwPurpose"][value="${state.purpose}"]`);
      if (inp) { inp.checked = true; syncCards('jwPurpose'); }
    }

    // Length slider — coerce legacy values from older sessions and paint UI.
    if (!LENGTH_STOPS.includes(state.length)) {
      state.length = LEGACY_LENGTH_MAP[state.length] || 'medium';
    }
    syncLengthSlider();

    // Branching complexity — older saved sessions don't carry this field. Fall
    // back to the default mid-stop so the slider always paints something
    // sensible. Coerce any unknown value the same way.
    if (!BRANCHING_STOPS.includes(state.branchingComplexity)) {
      state.branchingComplexity = BRANCHING_STOPS[BRANCHING_DEFAULT_IDX];
    }
    syncBranchingSlider();

    // Components page (checkboxes + sub-config) reflects current state.
    if (state.guideExistingId && el.guideExistingSelect) el.guideExistingSelect.value = state.guideExistingId;
    syncComponentsUI();
    updateGuideAvailability();
  }

  // ---------------------------------------------------------------------------
  // Open/close
  // ---------------------------------------------------------------------------
  function tryClose() {
    // If we're in the middle of generation, warn the user
    if (currentPage === 'progress') {
      if (!confirm(I18N.closeConfirm)) return;
      if (sseAbortController) sseAbortController.abort();
    } else if (currentPage === 'success') {
      // no confirm, but reset
    } else if (hasUnsavedAnswers()) {
      if (!confirm(I18N.closeConfirm)) return;
    }
    closeModal();
  }

  function hasUnsavedAnswers() {
    const d = defaultState();
    return JSON.stringify({ ...state, savedAt: 0 }) !== JSON.stringify({ ...d, savedAt: 0 });
  }

  function openModal() {
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    const saved = loadPersistedState();
    if (saved && anyMeaningfulAnswer(saved)) {
      state = saved;
      hydrateUIFromState();
      showPage('resume');
    } else {
      state = defaultState();
      hydrateUIFromState();
      showPage('source');
    }
  }

  function anyMeaningfulAnswer(s) {
    return !!(s.source || s.topic || s.purpose || s.audience ||
              (s.guide && s.guide !== 'none'));
  }

  function closeModal() {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (uploadAbortController) { try { uploadAbortController.abort(); } catch (_) {} }
    if (sseAbortController) { try { sseAbortController.abort(); } catch (_) {} }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  wireEvents();
  window.GryffiWizard = { open: openModal, close: closeModal };
})();
