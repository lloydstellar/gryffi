/**
 * Gryffi Flow Builder - Hybrid Explorer Edition
 * Visual editor for interactive journeys with smart routing
 */

// ============================================
// SECURITY: HTML ESCAPING UTILITY
// ============================================
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// SECURITY: RICH TEXT SANITIZER
// ============================================
// Step bodies are HTML from the simple editor (or pasted from elsewhere). They
// are shown to end users and to other makers, so they always pass through
// DOMPurify with a small allowlist before they are rendered.
const RICH_TEXT_TAGS = [
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'hr', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td'
];
const RICH_TEXT_ATTRS = ['href', 'target', 'rel', 'style', 'colspan', 'rowspan'];
let richTextHooksInstalled = false;

// Plain text of an HTML fragment. DOMParser documents are inert: no scripts
// run and no images load while parsing.
function htmlToText(html) {
  if (html == null || html === '') return '';
  if (typeof DOMParser === 'undefined') return String(html).replace(/<[^>]*>?/g, '');
  return new DOMParser().parseFromString(String(html), 'text/html').body.textContent || '';
}

function sanitizeRichHtml(html) {
  if (html == null || html === '') return '';
  if (typeof window === 'undefined' || !window.DOMPurify) {
    // Never render markup without the sanitizer: fall back to plain text
    return escapeHtml(htmlToText(html));
  }
  if (!richTextHooksInstalled) {
    // Keep only font-size in inline styles (the editor's size buttons). Other
    // CSS could be used to overlay or hide parts of the page.
    window.DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
      if (data.attrName !== 'style') return;
      const match = /font-size:\s*(\d{1,2}px)/i.exec(data.attrValue || '');
      if (match) {
        data.attrValue = `font-size: ${match[1]}`;
      } else {
        data.keepAttr = false;
      }
    });
    // Links always open in a new tab without access to this window
    window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    richTextHooksInstalled = true;
  }
  return window.DOMPurify.sanitize(String(html), {
    ALLOWED_TAGS: RICH_TEXT_TAGS,
    ALLOWED_ATTR: RICH_TEXT_ATTRS
  });
}

// ============================================
// PLAYER: MAGIC-LINK SESSION GUARD
// ============================================
// Magic-link API calls need the browser session that opened the link. When
// the server reports that it is gone (code EXPEDITION_SESSION_REQUIRED), show
// one calm notice with a reload button: reloading the link restores the
// session and the saved progress.
(function installExpeditionSessionGuard() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const originalFetch = window.fetch.bind(window);
  let noticeShown = false;

  function showNotice(token) {
    if (noticeShown) return;
    noticeShown = true;
    const tp = (key, fallback) => (typeof window.tPlayer === 'function' ? window.tPlayer(key) : null) || fallback;
    const notice = document.createElement('div');
    notice.setAttribute('role', 'alert');
    notice.className = 'expedition-session-notice';
    notice.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;padding:12px 16px;background:#fff7ed;color:#7c2d12;border-bottom:1px solid #fdba74;font-size:15px;line-height:1.5;';
    const text = document.createElement('span');
    text.textContent = tp('player.session.expired', 'Your session has ended. Click Reload to continue.');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tp('player.session.reload', 'Reload');
    button.style.cssText = 'padding:8px 16px;border-radius:8px;border:none;background:var(--theme-primary, #0b4b34);color:var(--theme-button-text, #fff);font-weight:600;cursor:pointer;';
    button.addEventListener('click', () => { window.location.href = `/e/${encodeURIComponent(token)}`; });
    notice.append(text, button);
    document.body.prepend(notice);
    button.focus();
  }

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.status === 401 && !noticeShown) {
      const url = String(args[0]?.url || args[0] || '');
      const match = url.match(/\/e\/([^/?#]+)\//);
      if (match) {
        const data = await response.clone().json().catch(() => null);
        if (data?.code === 'EXPEDITION_SESSION_REQUIRED') showNotice(decodeURIComponent(match[1]));
      }
    }
    return response;
  };
})();

// ============================================
// AUTOLINK UTILITY
// ============================================
// Turn plain-text URLs and email addresses inside an HTML fragment into
// clickable <a> elements that open in a new tab. We DOM-walk the fragment
// instead of running a regex over raw HTML so we never mangle existing
// markup or accidentally rewrite links inside <a>/<code>/<pre>.
//
// Recognised forms:
//   - emails:           anyone@domain.tld         → mailto:anyone@domain.tld
//   - explicit URLs:    http(s)://...             → kept as-is
//   - www-prefixed:     www.example.com/path      → https://www.example.com/path
//   - bare domains:     example.com, example.com/path
//                                                 → https://example.com (only when TLD
//                                                   is in a curated common-TLD list,
//                                                   so plain text like "filename.zip"
//                                                   or "see chapter 1.section.two"
//                                                   does not get linkified)
const AUTOLINK_COMMON_TLDS = new Set([
  // gTLDs
  'com','net','org','info','biz','name','pro','mobi','tv','cc','co','me','app','dev','ai','tech','cloud',
  'store','shop','site','online','xyz','io','digital','studio','agency','academy','training','blog',
  'news','live','life','design','media','press','solutions','services','tools','support','help','works',
  'world','team','group','page','link','plus','expert','care','health','education','community','events',
  // ccTLDs (Gryffi-supported markets and major neighbours)
  'nl','de','fr','es','it','pt','be','eu','uk','us','ie','ch','at','dk','se','no','fi','pl','ro','tr',
  'jp','cn','in','br','au','nz','ca','mx','za','sg','hk','kr'
]);

const AUTOLINK_TOKEN_RE = new RegExp(
  // 1) email
  '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}'
  // 2) explicit URL (http/https)
  + '|https?:\\/\\/[^\\s<>"\')\\]]+'
  // 3) www-prefixed URL
  + '|\\bwww\\.[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}(?:\\/[^\\s<>"\')\\]]*)?'
  // 4) bare domain with optional path (TLD validated below)
  + '|\\b(?:[A-Za-z0-9](?:[A-Za-z0-9\\-]*[A-Za-z0-9])?\\.)+[A-Za-z]{2,12}(?:\\/[^\\s<>"\')\\]]*)?',
  'g'
);

const AUTOLINK_SKIP_TAGS = new Set([
  'A','CODE','PRE','SCRIPT','STYLE','TEXTAREA','IFRAME','BUTTON','OPTION','SELECT','INPUT','LABEL'
]);

function autolinkHtml(html) {
  if (html === null || html === undefined || html === '') return html;
  if (typeof html !== 'string') return html;
  if (typeof document === 'undefined') return html;

  const container = document.createElement('div');
  container.innerHTML = html;

  const isInsideSkipTag = (node) => {
    let n = node.parentNode;
    while (n && n !== container) {
      if (n.nodeType === 1 && AUTOLINK_SKIP_TAGS.has(n.tagName)) return true;
      n = n.parentNode;
    }
    return false;
  };

  const buildLink = (rawMatch) => {
    // Trim sentence-level trailing punctuation that wandered into the match.
    let core = rawMatch;
    let trail = '';
    const tm = core.match(/[.,!?;:)\]'"]+$/);
    if (tm) {
      trail = tm[0];
      core = core.slice(0, -trail.length);
    }
    if (!core) return { core: rawMatch, trail: '', href: null };

    // Email (must be checked before URL forms; emails contain no slashes).
    if (core.includes('@') && !/^https?:\/\//i.test(core) && !/^mailto:/i.test(core)) {
      return { core, trail, href: 'mailto:' + core };
    }

    // Explicit URLs.
    if (/^https?:\/\//i.test(core)) {
      return { core, trail, href: core };
    }
    if (/^www\./i.test(core)) {
      return { core, trail, href: 'https://' + core };
    }

    // Bare domain — only accept when the TLD is in our curated set so plain
    // text like "report.pdf", "section.two", or "config.yml" stays plain.
    const slashIdx = core.indexOf('/');
    const host = slashIdx > -1 ? core.slice(0, slashIdx) : core;
    const segments = host.split('.');
    if (segments.length < 2) return { core: rawMatch, trail: '', href: null };
    const tld = segments[segments.length - 1].toLowerCase();
    if (!AUTOLINK_COMMON_TLDS.has(tld)) return { core: rawMatch, trail: '', href: null };

    return { core, trail, href: 'https://' + core };
  };

  const processTextNode = (node) => {
    const text = node.nodeValue;
    if (!text) return;
    AUTOLINK_TOKEN_RE.lastIndex = 0;
    if (!AUTOLINK_TOKEN_RE.test(text)) return;
    AUTOLINK_TOKEN_RE.lastIndex = 0;

    const fragments = [];
    let lastIndex = 0;
    let m;
    while ((m = AUTOLINK_TOKEN_RE.exec(text)) !== null) {
      const match = m[0];
      const start = m.index;
      if (start > lastIndex) {
        fragments.push(document.createTextNode(text.slice(lastIndex, start)));
      }
      const built = buildLink(match);
      if (built.href) {
        const a = document.createElement('a');
        a.href = built.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = built.core;
        fragments.push(a);
        if (built.trail) fragments.push(document.createTextNode(built.trail));
      } else {
        fragments.push(document.createTextNode(match));
      }
      lastIndex = start + match.length;
    }
    if (lastIndex < text.length) {
      fragments.push(document.createTextNode(text.slice(lastIndex)));
    }
    if (fragments.length > 0) {
      const parent = node.parentNode;
      for (const frag of fragments) parent.insertBefore(frag, node);
      parent.removeChild(node);
    }
  };

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (isInsideSkipTag(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes = [];
  let next;
  while ((next = walker.nextNode())) textNodes.push(next);
  for (const tn of textNodes) processTextNode(tn);

  // Belt-and-braces: any pre-existing <a> in the source HTML may have been
  // authored without target="_blank". Normalise those too so all links in
  // content steps consistently open in a new tab.
  container.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    a.setAttribute('target', '_blank');
    const rel = (a.getAttribute('rel') || '').split(/\s+/).filter(Boolean);
    if (!rel.includes('noopener')) rel.push('noopener');
    if (!rel.includes('noreferrer')) rel.push('noreferrer');
    a.setAttribute('rel', rel.join(' '));
  });

  return container.innerHTML;
}

// ============================================
// ANALYTICS TRACKING HELPER
// ============================================
// Tracks user interactions in player mode for journey analytics

class JourneyAnalytics {
  constructor() {
    this.sessionId = this.generateSessionId();
    this.deviceInfo = this.getDeviceInfo();
    this.stepStartTimes = new Map(); // Track when each step was entered
    this.journeyStartTime = null;
    this.enabled = false;
    this.token = null;
    this.currentJourneyId = null;
    this.parentJourneyId = null;
  }
  
  generateSessionId() {
    return 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
  
  getDeviceInfo() {
    const ua = navigator.userAgent;
    let device_type = 'desktop';
    if (/Mobi|Android/i.test(ua)) device_type = 'mobile';
    else if (/Tablet|iPad/i.test(ua)) device_type = 'tablet';
    
    let browser = 'unknown';
    if (ua.includes('Firefox/')) browser = 'Firefox';
    else if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Safari/')) browser = 'Safari';
    
    let os = 'unknown';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
    
    return {
      device_type,
      browser,
      os,
      screen_width: window.screen.width,
      screen_height: window.screen.height
    };
  }
  
  init(token, journeyId) {
    this.enabled = true;
    this.token = token;
    this.currentJourneyId = journeyId;
    this.journeyStartTime = Date.now();
    console.log('[Analytics] Initialized for journey:', journeyId);
  }
  
  setNestedJourney(nestedJourneyId, parentJourneyId) {
    this.parentJourneyId = parentJourneyId;
    this.currentJourneyId = nestedJourneyId;
  }
  
  clearNestedJourney(parentJourneyId) {
    this.parentJourneyId = null;
    this.currentJourneyId = parentJourneyId;
  }
  
  async trackEvent(eventType, data = {}) {
    if (!this.enabled || !this.token) return;
    
    try {
      const payload = {
        event_type: eventType,
        journey_id: this.currentJourneyId,
        parent_journey_id: this.parentJourneyId,
        step_id: data.step_id || null,
        duration_ms: data.duration_ms || null,
        event_data: data.event_data || {},
        session_id: this.sessionId,
        device_info: this.deviceInfo
      };
      
      // Fire and forget - don't block user experience
      fetch(`/e/${this.token}/analytics/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      }).catch(err => console.warn('[Analytics] Failed to send event:', err));
      
      console.log('[Analytics] Event:', eventType, data.step_id ? `step: ${data.step_id.substring(0, 8)}...` : '');
    } catch (err) {
      console.warn('[Analytics] Error tracking event:', err);
    }
  }
  
  // Step timing helpers
  stepEntered(stepId, stepType) {
    this.stepStartTimes.set(stepId, Date.now());
    this.trackEvent('step_entered', { 
      step_id: stepId,
      event_data: { step_type: stepType }
    });
  }
  
  stepCompleted(stepId, stepType, additionalData = {}) {
    const startTime = this.stepStartTimes.get(stepId);
    const duration = startTime ? Date.now() - startTime : null;
    this.stepStartTimes.delete(stepId);
    
    this.trackEvent('step_completed', {
      step_id: stepId,
      duration_ms: duration,
      event_data: { step_type: stepType, ...additionalData }
    });
  }
  
  journeyStarted() {
    this.journeyStartTime = Date.now();
    this.trackEvent('journey_started', {
      event_data: { 
        referrer: document.referrer || null,
        url: window.location.href
      }
    });
  }
  
  journeyCompleted() {
    const duration = this.journeyStartTime ? Date.now() - this.journeyStartTime : null;
    this.trackEvent('journey_completed', {
      duration_ms: duration
    });
  }
  
  nestedJourneyEntered(nestedJourneyId, parentJourneyId) {
    this.trackEvent('nested_journey_entered', {
      event_data: { 
        nested_journey_id: nestedJourneyId,
        parent_journey_id: parentJourneyId
      }
    });
  }
  
  nestedJourneyCompleted(nestedJourneyId, parentJourneyId, duration) {
    this.trackEvent('nested_journey_completed', {
      duration_ms: duration,
      event_data: { 
        nested_journey_id: nestedJourneyId,
        parent_journey_id: parentJourneyId
      }
    });
  }
  
  pollAnswered(stepId, options) {
    this.trackEvent('poll_answered', {
      step_id: stepId,
      event_data: { options_selected: options }
    });
  }
  
  quizAnswered(stepId, correct, score) {
    this.trackEvent('quiz_answered', {
      step_id: stepId,
      event_data: { correct, score }
    });
  }
  
  formSubmitted(stepId, fieldCount) {
    this.trackEvent('form_submitted', {
      step_id: stepId,
      event_data: { field_count: fieldCount }
    });
  }
  
  videoWatched(stepId, watchPercentage, duration) {
    this.trackEvent('video_watched', {
      step_id: stepId,
      duration_ms: duration,
      event_data: { watch_percentage: watchPercentage }
    });
  }
  
  linkClicked(stepId, url, isExternal) {
    this.trackEvent('link_clicked', {
      step_id: stepId,
      event_data: { url, is_external: isExternal }
    });
  }
  
  resourceCollected(stepId, resourceId) {
    this.trackEvent('resource_collected', {
      step_id: stepId,
      event_data: { resource_id: resourceId }
    });
  }
  
  guideChatMessage(stepId, messageCount) {
    this.trackEvent('guide_chat_message', {
      step_id: stepId,
      event_data: { message_count: messageCount }
    });
  }
  
  // ============================================
  // QUIZ TRACKING (detailed)
  // ============================================
  
  quizAttemptStarted(stepId, totalQuestions) {
    this.currentQuizAttempt = {
      stepId,
      startTime: Date.now(),
      totalQuestions,
      answers: []
    };
    this.trackEvent('quiz_attempt_started', {
      step_id: stepId,
      event_data: { total_questions: totalQuestions }
    });
  }
  
  quizQuestionAnswered(stepId, questionIndex, isCorrect, selectedAnswer, correctAnswer, timeSpentMs) {
    if (this.currentQuizAttempt) {
      this.currentQuizAttempt.answers.push({
        question_index: questionIndex,
        correct: isCorrect,
        time_ms: timeSpentMs
      });
    }
    this.trackEvent('quiz_question_answered', {
      step_id: stepId,
      duration_ms: timeSpentMs,
      event_data: { 
        question_index: questionIndex,
        correct: isCorrect,
        selected_answer: selectedAnswer,
        correct_answer: correctAnswer
      }
    });
  }
  
  quizAttemptCompleted(stepId, score, totalQuestions, passed, attemptNumber) {
    const duration = this.currentQuizAttempt?.startTime 
      ? Date.now() - this.currentQuizAttempt.startTime 
      : null;
    
    this.trackEvent('quiz_attempt_completed', {
      step_id: stepId,
      duration_ms: duration,
      event_data: { 
        score,
        total_questions: totalQuestions,
        correct_count: score, // score IS the correct count
        passed,
        attempt_number: attemptNumber,
        percentage: Math.round((score / totalQuestions) * 100),
        question_details: this.currentQuizAttempt?.answers || []
      }
    });
    
    this.currentQuizAttempt = null;
  }
  
  // ============================================
  // POLL TRACKING (detailed)
  // ============================================
  
  pollVoted(stepId, question, selectedOptions, isMultiSelect, totalOptions) {
    this.trackEvent('poll_voted', {
      step_id: stepId,
      event_data: { 
        question,
        selected_options: selectedOptions,
        is_multi_select: isMultiSelect,
        total_options: totalOptions
      }
    });
  }
  
  // ============================================
  // FORM TRACKING (detailed)
  // ============================================
  
  formStarted(stepId, fieldCount) {
    this.currentFormStart = Date.now();
    this.trackEvent('form_started', {
      step_id: stepId,
      event_data: { field_count: fieldCount }
    });
  }
  
  formFieldCompleted(stepId, fieldType, fieldIndex) {
    this.trackEvent('form_field_completed', {
      step_id: stepId,
      event_data: { 
        field_type: fieldType,
        field_index: fieldIndex
      }
    });
  }
  
  formCompleted(stepId, fieldCount, filledCount) {
    const duration = this.currentFormStart ? Date.now() - this.currentFormStart : null;
    this.trackEvent('form_completed', {
      step_id: stepId,
      duration_ms: duration,
      event_data: { 
        field_count: fieldCount,
        filled_count: filledCount,
        completion_rate: Math.round((filledCount / fieldCount) * 100)
      }
    });
    this.currentFormStart = null;
  }
  
  // ============================================
  // VIDEO TRACKING (detailed)
  // ============================================
  
  videoStarted(stepId, videoUrl, videoDuration) {
    this.currentVideoStart = Date.now();
    this.trackEvent('video_started', {
      step_id: stepId,
      event_data: { 
        video_url: videoUrl,
        video_duration_sec: videoDuration
      }
    });
  }
  
  videoPaused(stepId, currentTime, totalDuration) {
    const watchedPercent = totalDuration > 0 ? Math.round((currentTime / totalDuration) * 100) : 0;
    this.trackEvent('video_paused', {
      step_id: stepId,
      event_data: { 
        current_time_sec: currentTime,
        total_duration_sec: totalDuration,
        watched_percentage: watchedPercent
      }
    });
  }
  
  videoCompleted(stepId, totalDuration, actualWatchTime) {
    const sessionDuration = this.currentVideoStart ? Date.now() - this.currentVideoStart : null;
    this.trackEvent('video_completed', {
      step_id: stepId,
      duration_ms: sessionDuration,
      event_data: { 
        video_duration_sec: totalDuration,
        actual_watch_time_sec: actualWatchTime,
        completed: true
      }
    });
    this.currentVideoStart = null;
  }
  
  videoSkipped(stepId, skippedAtTime, totalDuration) {
    const watchedPercent = totalDuration > 0 ? Math.round((skippedAtTime / totalDuration) * 100) : 0;
    this.trackEvent('video_skipped', {
      step_id: stepId,
      event_data: { 
        skipped_at_sec: skippedAtTime,
        total_duration_sec: totalDuration,
        watched_percentage: watchedPercent
      }
    });
  }
  
  // ============================================
  // CONTENT ENGAGEMENT
  // ============================================
  
  contentScrolled(stepId, scrollDepthPercent) {
    // Only track significant scroll milestones (25%, 50%, 75%, 100%)
    const milestone = Math.floor(scrollDepthPercent / 25) * 25;
    if (milestone > 0 && !this.scrollMilestones?.[stepId]?.includes(milestone)) {
      this.scrollMilestones = this.scrollMilestones || {};
      this.scrollMilestones[stepId] = this.scrollMilestones[stepId] || [];
      this.scrollMilestones[stepId].push(milestone);
      
      this.trackEvent('content_scroll_milestone', {
        step_id: stepId,
        event_data: { scroll_depth_percent: milestone }
      });
    }
  }
  
  externalLinkClicked(stepId, url, linkText) {
    this.trackEvent('external_link_clicked', {
      step_id: stepId,
      event_data: { 
        url,
        link_text: linkText,
        is_external: true
      }
    });
  }
  
  // ============================================
  // PATH CHOICES
  // ============================================
  
  pathChosen(stepId, pathId, pathLabel, totalPaths) {
    this.trackEvent('path_chosen', {
      step_id: stepId,
      event_data: { 
        path_id: pathId,
        path_label: pathLabel,
        total_paths: totalPaths
      }
    });
  }
  
  // ============================================
  // ENGAGEMENT METRICS
  // ============================================
  
  stepIdleDetected(stepId, idleDurationMs) {
    this.trackEvent('step_idle', {
      step_id: stepId,
      duration_ms: idleDurationMs,
      event_data: { idle_threshold_exceeded: true }
    });
  }
  
  tabFocusLost(stepId) {
    this.tabBlurTime = Date.now();
    this.trackEvent('tab_focus_lost', {
      step_id: stepId
    });
  }
  
  tabFocusRegained(stepId) {
    const awayDuration = this.tabBlurTime ? Date.now() - this.tabBlurTime : null;
    this.trackEvent('tab_focus_regained', {
      step_id: stepId,
      duration_ms: awayDuration
    });
    this.tabBlurTime = null;
  }
  
  // ============================================
  // AI GUIDE CHAT TRACKING
  // ============================================
  
  async guideChatSessionStart(guideId, guideName, journeyId) {
    if (!this.enabled || !this.token) return null;
    
    this.guideChatStartTime = Date.now();
    this.guideMessageCount = 0;
    this.guideUserMessageCount = 0;
    
    try {
      const response = await fetch(`/e/${this.token}/analytics/guide-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'session_start',
          guide_id: guideId,
          journey_id: journeyId,
          session_id: this.sessionId
        })
      });
      
      const data = await response.json();
      if (data.success && data.chat_session_id) {
        this.currentGuideChatSessionId = data.chat_session_id;
        console.log('[Analytics] Guide chat session started:', data.chat_session_id);
        return data.chat_session_id;
      }
    } catch (err) {
      console.warn('[Analytics] Failed to start guide chat session:', err);
    }
    return null;
  }
  
  async guideChatMessageSent(guideId, stepId, message, isUserMessage = true) {
    if (!this.enabled || !this.token) return;
    
    // Auto-start session if not started yet (handles race condition)
    if (!this.currentGuideChatSessionId) {
      console.log('[Analytics] No guide chat session, auto-starting one...');
      await this.guideChatSessionStart(guideId, null, null);
      if (!this.currentGuideChatSessionId) {
        console.warn('[Analytics] Failed to auto-start guide chat session');
        return;
      }
    }
    
    this.guideMessageCount++;
    if (isUserMessage) {
      this.guideUserMessageCount++;
      this.lastUserMessageTime = Date.now();
    }
    
    try {
      // Only update session counters, don't store message content
      await fetch(`/e/${this.token}/analytics/guide-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'message_sent',
          chat_session_id: this.currentGuideChatSessionId,
          guide_id: guideId,
          step_id: stepId,
          message_role: isUserMessage ? 'user' : 'guide'
        })
      });
      
      console.log('[Analytics] Guide chat message counted:', isUserMessage ? 'user' : 'guide');
    } catch (err) {
      console.warn('[Analytics] Failed to track guide chat message:', err);
    }
  }
  
  async guideChatResponseReceived(guideId, stepId, _response, _hadCitations, _citationCount) {
    if (!this.enabled || !this.token) return;
    
    // Auto-start session if not started yet (handles race condition)
    if (!this.currentGuideChatSessionId) {
      console.log('[Analytics] No guide chat session for response, auto-starting...');
      await this.guideChatSessionStart(guideId, null, null);
      if (!this.currentGuideChatSessionId) {
        return;
      }
    }
    
    this.guideMessageCount++;
    
    try {
      // Only update session counters, don't store message content
      await fetch(`/e/${this.token}/analytics/guide-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'message_sent',
          chat_session_id: this.currentGuideChatSessionId,
          guide_id: guideId,
          step_id: stepId,
          message_role: 'guide'
        })
      });
    } catch (err) {
      console.warn('[Analytics] Failed to track guide response:', err);
    }
  }
  
  async guideChatSessionEnd() {
    if (!this.enabled || !this.token || !this.currentGuideChatSessionId) return;
    
    try {
      await fetch(`/e/${this.token}/analytics/guide-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'session_end',
          chat_session_id: this.currentGuideChatSessionId
        })
      });
      
      console.log('[Analytics] Guide chat session ended. Messages:', this.guideMessageCount);
    } catch (err) {
      console.warn('[Analytics] Failed to end guide chat session:', err);
    }
    
    this.currentGuideChatSessionId = null;
    this.guideChatStartTime = null;
  }
  
  guideChatOpened(guideId, guideName, stepId) {
    this.trackEvent('guide_chat_opened', {
      step_id: stepId,
      event_data: { guide_id: guideId, guide_name: guideName }
    });
  }
  
  guideChatClosed(guideId, messageCount, duration) {
    this.trackEvent('guide_chat_closed', {
      duration_ms: duration,
      event_data: { guide_id: guideId, message_count: messageCount }
    });
  }
}

// Global analytics instance
const journeyAnalytics = new JourneyAnalytics();

// Email template defaults for automations
// Note: This function returns translated templates based on current language
function getEmailTemplates() {
  const t = (key) => {
    if (typeof window.t === 'function') {
      return window.t(key);
    }
    return key;
  };
  
  return {
    welcome: {
      name: t('builder.automations.templates.welcome'),
      subject: t('builder.automations.templateDefaults.welcome.subject'),
      body: t('builder.automations.templateDefaults.welcome.body')
    },
    info: {
      name: t('builder.automations.templates.info'),
      subject: t('builder.automations.templateDefaults.info.subject'),
      body: t('builder.automations.templateDefaults.info.body')
    },
    confirmation: {
      name: t('builder.automations.templates.confirmation'),
      subject: t('builder.automations.templateDefaults.confirmation.subject'),
      body: t('builder.automations.templateDefaults.confirmation.body')
    },
    reminder: {
      name: t('builder.automations.templates.reminder'),
      subject: t('builder.automations.templateDefaults.reminder.subject'),
      body: t('builder.automations.templateDefaults.reminder.body')
    },
    credentials: {
      name: t('builder.automations.templates.credentials'),
      subject: t('builder.automations.templateDefaults.credentials.subject'),
      body: t('builder.automations.templateDefaults.credentials.body')
    },
    completion: {
      name: t('builder.automations.templates.completion'),
      subject: t('builder.automations.templateDefaults.completion.subject'),
      body: t('builder.automations.templateDefaults.completion.body')
    },
    custom: {
      name: t('builder.automations.templates.custom'),
      subject: t('builder.automations.templateDefaults.custom.subject'),
      body: t('builder.automations.templateDefaults.custom.body')
    }
  };
}

class FlowBuilder {
  constructor() {
    this.journey = window.GRYFFI.journey;
    this.steps = window.GRYFFI.steps || [];
    this.paths = window.GRYFFI.paths || [];
    this.resources = window.GRYFFI.resources || [];
    this.guides = window.GRYFFI.guides || []; // Central guides library - preloaded in player mode

    this.readOnly = !!window.GRYFFI.readOnly;
    this.organizationId = window.GRYFFI.organization?.id || null;
    
    // PLAYER MODE: End-user journey experience (no builder UI)
    // Security: This flag only controls UI display - all write operations
    // are blocked server-side for player mode sessions
    this.playerMode = !!window.GRYFFI.playerMode;
    this.player = window.GRYFFI.player || null;

    // Apply stored reading preferences (dyslexia-friendly font) before
    // anything renders, so returning users never see the font switch
    this.applyReadingPrefs();

    // Undo/Redo history (snapshot-based) - disabled in player mode
    this.history = {
      past: [],
      future: [],
      max: 100,
      commitTimers: new Map()
    };
    this.isApplyingHistory = false;
    this.isUndoRedoInFlight = false;

    // Auto-save status tracking
    this.activeSaveCount = 0;
    this.lastSavedAt = null;
    
    this.selectedStep = null;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    
    // Canvas panning state
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    
    // Connection drawing state
    this.isDrawingConnection = false;
    this.connectionStart = null;
    this.tempConnectionLine = null;
    
    // Context menu
    this.contextMenu = null;
    
    // Panel state: 'step' | 'journey' | null
    this.panelMode = null;
    
    this.init();
  }
  
  init() {
    // PLAYER MODE: Skip all builder initialization, go straight to journey experience
    if (this.playerMode) {
      this.initPlayerMode();
      return;
    }
    
    this.canvas = document.getElementById('flowCanvas');
    this.stepsContainer = document.getElementById('stepsContainer');
    this.connectionLayer = document.getElementById('connectionLayer');
    this.propertiesPanel = document.getElementById('propertiesPanel');

    if (this.readOnly) {
      document.body?.classList.add('gryffi-readonly');
      this.applyReadOnlyToToolbar();
    }
    
    this.bindEvents();
    this.render();

    // Initialize undo history from initial server state
    this.initHistory();
    
    // Load available guides for the organization
    this.loadGuides();
    
    // Load available journeys for nesting
    this.loadAvailableNestedJourneys();
    
    // Draw connections after DOM has fully rendered
    // Use requestAnimationFrame to ensure layout is complete
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.drawConnections();
      });
    });
    
    // Close context menu on click outside
    document.addEventListener('click', () => this.closeContextMenu());
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.connection-line')) {
        this.closeContextMenu();
      }
    });
  }
  
  /**
   * PLAYER MODE INITIALIZATION
   * Starts the journey experience directly without builder UI
   * Security: All API write operations check for player mode server-side
   */
  initPlayerMode() {
    console.log('[PlayerMode] Starting journey experience...');
    
    // Initialize analytics tracking
    if (this.player?.token && this.journey?.id) {
      journeyAnalytics.init(this.player.token, this.journey.id);
    }
    
    // Load and apply organization theme
    this.loadOrganizationTheme();
    
    // Find start step
    const startStep = this.steps.find(s => s.is_start) || this.steps[0];
    if (!startStep) {
      console.error('[PlayerMode] No steps found in journey');
      document.getElementById('previewContent').innerHTML = `
        <div class="flex items-center justify-center h-full">
          <div class="text-center p-8">
            <h2 class="text-xl font-semibold text-zen-900">Journey not available</h2>
            <p class="text-zen-600 mt-2">This journey has no content yet.</p>
          </div>
        </div>
      `;
      return;
    }
    
    // Initialize preview state (reuse existing preview logic)
    this.previewState = {
      currentStep: startStep,
      visitedSteps: this.player?.progress?.visited_steps || [],
      collectedResources: this.player?.progress?.collected_resources || [],
      chatHistory: [],
      // Pacing state
      messageCount: 0,
      pacingUnlocked: false,
      pacingTimer: null,
      videoTimerStarted: false,
      // Quiz state  
      currentQuizQuestionIndex: 0,
      // Guide chat state
      guideChatHistories: {},
      guideChatOpen: false,
      currentGuide: null,
      // Navigation history for back button support
      stepHistory: [],
      // Nested journey context
      nestedContext: null,
      isInNestedJourney: false
    };
    
    // Restore progress if available
    if (this.player?.progress?.current_step_id) {
      const resumeStep = this.steps.find(s => s.id === this.player.progress.current_step_id);
      if (resumeStep) {
        this.previewState.currentStep = resumeStep;
      }
    }
    
    // Render the journey content
    this.renderPreview();
    
    // Initialize guide chat widget
    this.initGuideChat();
    
    // Update progress bar
    this.updatePlayerProgress();
    
    // Trigger automations for journey start (only if this is a fresh start, not resume)
    const isNewJourney = !this.player?.progress?.started_at;
    if (isNewJourney) {
      console.log('[PlayerMode] Triggering on_journey_start automation');
      this.triggerAutomation('on_journey_start', startStep.id);
      
      // Track journey start
      journeyAnalytics.journeyStarted();
      
      // Add start step to visited steps for new journeys
      if (!this.previewState.visitedSteps.includes(startStep.id)) {
        this.previewState.visitedSteps.push(startStep.id);
      }
    } else {
      // Track session resume
      journeyAnalytics.trackEvent('session_resumed', {
        step_id: this.previewState.currentStep?.id,
        event_data: { resumed_from: this.player?.progress?.current_step_id }
      });
    }
    
    // Always ensure current step is in visited steps
    if (!this.previewState.visitedSteps.includes(this.previewState.currentStep.id)) {
      this.previewState.visitedSteps.push(this.previewState.currentStep.id);
    }
    
    // Save progress immediately
    this.savePlayerProgress();
    
    // Trigger step enter automation for current step
    console.log('[PlayerMode] Triggering on_step_enter automation for step:', startStep.id);
    this.triggerAutomation('on_step_enter', startStep.id);
    
    // Track first step entry
    journeyAnalytics.stepEntered(startStep.id, startStep.type);
    
    // Initialize browser back button handling
    this.initBackButtonHandler();
    
    console.log('[PlayerMode] Journey started successfully');
  }
  
  /**
   * Load and apply organization theme for builder preview mode
   */
  async loadOrganizationThemeForPreview() {
    console.log('[Theme] loadOrganizationThemeForPreview called, orgId:', this.organizationId);
    
    try {
      const response = await fetch('/api/themes');
      const data = await response.json();
      
      console.log('[Theme] API response:', data);
      console.log('[Theme] activeThemeId:', data.activeThemeId);
      console.log('[Theme] themes count:', data.themes?.length);
      
      if (data.success && data.activeThemeId) {
        const activeTheme = data.themes.find(t => t.id === data.activeThemeId);
        console.log('[Theme] Found active theme:', activeTheme);
        
        if (activeTheme) {
          const tokens = typeof activeTheme.tokens === 'string' 
            ? JSON.parse(activeTheme.tokens) 
            : activeTheme.tokens;
          
          console.log('[Theme] Applying tokens:', tokens);
          // Pass logo URLs only for non-default themes
          const logoUrl = activeTheme.is_default ? null : activeTheme.logo_url;
          const logoLightUrl = activeTheme.is_default ? null : activeTheme.logo_light_url;
          this.applyThemeTokens(tokens, logoUrl, logoLightUrl);
          console.log('[Preview] Custom theme applied:', activeTheme.name);
        }
      } else {
        console.log('[Theme] No active theme found, using default');
        // Reset to default theme (no custom logo)
        this.themeLogo = null;
        this.themeLogoLight = null;
        this.updateThemeLogos();
      }
    } catch (err) {
      console.error('[Preview] Error loading theme:', err);
    }
  }
  
  /**
   * Load and apply organization theme for journey player (magic link)
   */
  async loadOrganizationTheme() {
    if (!this.playerMode || !this.organizationId) return;
    
    try {
      const response = await fetch(`/api/themes/public/${this.organizationId}`);
      const data = await response.json();
      
      if (data.success && data.theme && !data.isDefault) {
        const tokens = typeof data.theme.tokens === 'string' 
          ? JSON.parse(data.theme.tokens) 
          : data.theme.tokens;
        
        this.applyThemeTokens(tokens, data.theme.logo_url, data.theme.logo_light_url);
        console.log('[PlayerMode] Custom theme applied:', data.theme.name);
      } else {
        // Default theme - reset to default logo
        this.themeLogo = null;
        this.themeLogoLight = null;
        this.updateThemeLogos();
        console.log('[PlayerMode] Using default theme, logos reset');
      }
    } catch (_err) {
      console.log('[PlayerMode] Using default theme');
      // Reset to default logo on error
      this.themeLogo = null;
      this.themeLogoLight = null;
      this.updateThemeLogos();
    }
  }
  
  /**
   * Switch the interface language dynamically for nested journeys
   * This updates BOTH translations objects so the entire UI reflects the new language
   * @param {string} languageCode - The language code (en, nl, de, fr, es)
   * @param {Object} translations - Optional pre-loaded translations object
   */
  async switchLanguage(languageCode, translations = null) {
    console.log('[Language] Switching to:', languageCode);
    
    try {
      let newTranslations = translations;
      
      if (!newTranslations) {
        // Fetch translations from API
        const response = await fetch(`/api/translations/${languageCode}`);
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.translations) {
            newTranslations = data.translations;
          }
        }
      }
      
      if (newTranslations) {
        // Update BOTH translation objects so the entire UI reflects the new language
        // This is important for nested journeys with different language settings
        window.GRYFFI.previewTranslations = newTranslations;
        window.GRYFFI.translations = newTranslations;
        this.currentLanguage = languageCode;
        console.log('[Language] Applied translations for:', languageCode);
      } else {
        console.warn('[Language] Failed to load translations, using fallback');
      }
      
      // Update HTML lang attribute
      document.documentElement.lang = languageCode;
      
    } catch (err) {
      console.error('[Language] Error switching language:', err);
    }
  }
  
  /**
   * Apply theme tokens as CSS variables
   * @param {Object} tokens - Theme color/style tokens
   * @param {string|null} logoUrl - URL to the original logo (for light backgrounds)
   * @param {string|null} logoLightUrl - URL to the white/light logo (for dark backgrounds)
   */
  applyThemeTokens(tokens, logoUrl = null, logoLightUrl = null) {
    console.log('[Theme] applyThemeTokens called with:', tokens);
    
    // Create or update style element
    let styleEl = document.getElementById('gryffi-theme-vars');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'gryffi-theme-vars';
      document.head.appendChild(styleEl);
      console.log('[Theme] Created new style element');
    } else {
      console.log('[Theme] Updating existing style element');
    }
    
    // Map tokens to CSS variables
    const shadowMap = {
      none: 'none',
      light: '0 2px 8px rgba(0,0,0,0.08)',
      medium: '0 4px 12px rgba(0,0,0,0.1)',
      strong: '0 8px 24px rgba(0,0,0,0.15)'
    };
    
    // Use primary color as fallback for chatBubbleUser if not explicitly set
    // Also use primary if chatBubbleUser is still the default green (#0b4b34) but primary is different
    const defaultGreen = '#0b4b34';
    const primaryColor = tokens.primary || defaultGreen;
    
    // Smart fallback: if chatBubbleUser is the default green but primary is different, use primary
    const chatBubbleUserColor = (!tokens.chatBubbleUser || 
      (tokens.chatBubbleUser.toLowerCase() === defaultGreen && primaryColor.toLowerCase() !== defaultGreen))
      ? primaryColor 
      : tokens.chatBubbleUser;
    
    // Same logic for headerBackground
    const headerColor = (!tokens.headerBackground || 
      (tokens.headerBackground.toLowerCase() === defaultGreen && primaryColor.toLowerCase() !== defaultGreen))
      ? primaryColor 
      : tokens.headerBackground;
    
    const cssVars = `
      :root {
        --theme-primary: ${primaryColor};
        --theme-accent: ${tokens.accent || '#78c503'};
        --theme-background: ${tokens.background || '#ecf2eb'};
        --theme-text-primary: ${tokens.textPrimary || '#1f2937'};
        --theme-text-secondary: ${tokens.textSecondary || '#6b7280'};
        --theme-card-background: ${tokens.cardBackground || '#ffffff'};
        --theme-card-border: ${tokens.cardBorder || '#e5e7eb'};
        --theme-button-text: ${tokens.buttonText || '#ffffff'};
        --theme-header-background: ${headerColor};
        --theme-progress-bar: ${tokens.progressBar || tokens.accent || '#78c503'};
        --theme-chat-bubble-user: ${chatBubbleUserColor};
        --theme-chat-bubble-guide: ${tokens.chatBubbleGuide || '#f3f4f6'};
        --theme-border-radius: ${tokens.borderRadius || 12}px;
        --theme-shadow: ${shadowMap[tokens.shadowStrength] || shadowMap.medium};
      }
    `;
    
    styleEl.textContent = cssVars;
    console.log('[Theme] CSS variables applied:', cssVars);
    console.log('[Theme] Style element in DOM:', document.getElementById('gryffi-theme-vars'));
    
    // Store logo URLs for later use and update logo elements
    this.themeLogo = logoUrl || null;
    this.themeLogoLight = logoLightUrl || null;
    this.updateThemeLogos();
  }
  
  /**
   * Update all logo elements that should use the theme logo
   * Logos with data-theme-logo attribute will be replaced with custom logo
   * 
   * Logo selection based on background:
   * - data-theme-logo="light" → Use white/light version (for DARK backgrounds)
   * - data-theme-logo="dark" or data-theme-logo → Use original version (for LIGHT backgrounds)
   * 
   * When switching back to default theme, original logos are restored
   */
  updateThemeLogos() {
    const themeLogoElements = document.querySelectorAll('[data-theme-logo]');
    
    themeLogoElements.forEach(img => {
      // Store original src if not already stored
      if (!img.dataset.defaultSrc) {
        img.dataset.defaultSrc = img.src;
      }
      
      if (this.themeLogo) {
        // Custom theme with logo
        // Check which version to use based on data-theme-logo attribute value
        const logoVariant = img.dataset.themeLogo || 'dark';
        
        if (logoVariant === 'light') {
          // Light/white logo for dark backgrounds
          if (this.themeLogoLight) {
            img.src = this.themeLogoLight;
            img.style.filter = '';
          } else {
            // No light version available, use original with CSS filter as fallback
            img.src = this.themeLogo;
            img.style.filter = 'brightness(0) invert(1)';
          }
        } else {
          // Original/dark logo for light backgrounds (glassmorphism header)
          img.src = this.themeLogo;
          img.style.filter = '';
        }
        
        console.log('[Theme] Updated logo to custom:', img.src, `(${logoVariant} variant)`);
      } else {
        // Default theme or no logo - restore original
        img.src = img.dataset.defaultSrc;
        img.style.filter = '';
        console.log('[Theme] Restored logo to default:', img.dataset.defaultSrc);
      }
    });
  }
  
  /**
   * Initialize browser back/forward button handling for player mode
   * Prevents accidental journey exit and allows step-by-step navigation
   */
  initBackButtonHandler() {
    if (!this.playerMode) return;
    
    // Initialize step history tracking
    const initialStep = this.previewState.currentStep;
    this.previewState.stepHistory = [initialStep.id];
    this.previewState.historyIndex = 0;
    
    // Replace current state with our initial state
    history.replaceState({ 
      stepId: initialStep.id, 
      historyIndex: 0,
      isJourneyState: true 
    }, '', window.location.href);
    
    // Listen for back/forward button
    window.addEventListener('popstate', (e) => {
      this.handleHistoryNavigation(e);
    });
  }
  
  /**
   * Handle browser back/forward button in player mode
   */
  async handleHistoryNavigation(e) {
    if (!this.playerMode) return;
    
    const state = e.state;
    
    // Check if this is a journey state (has our marker)
    if (state && state.isJourneyState && state.stepId) {
      const targetStepId = state.stepId;
      const targetStep = this.steps.find(s => s.id === targetStepId);
      
      if (targetStep && targetStep.id !== this.previewState.currentStep.id) {
        // Navigate to the target step
        this.navigateToStepWithoutHistory(targetStep);
        // Update our internal index
        this.previewState.historyIndex = state.historyIndex;
        return;
      }
    }
    
    // No valid state or trying to leave journey - check if we should show confirmation
    const currentIndex = this.previewState.historyIndex || 0;
    
    if (currentIndex === 0) {
      // We're at the first step - ask user if they want to leave
      // Push state back to prevent immediate navigation
      history.pushState({ 
        stepId: this.previewState.currentStep.id, 
        historyIndex: 0,
        isJourneyState: true 
      }, '', window.location.href);
      
      // Show confirmation modal
      const shouldLeave = await window.gryffi.modal.confirm(
        `<div class="text-center">
          <svg class="w-16 h-16 mx-auto mb-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
          <p class="text-zen-700">${window.tPlayer('player.navigation.leaveJourneyMessage') || 'Are you sure you want to leave this expedition? Your progress has been saved.'}</p>
        </div>`,
        {
          title: window.tPlayer('player.navigation.leaveJourney') || 'Leave expedition?',
          confirmText: window.tPlayer('player.navigation.leaveConfirm') || 'Leave',
          cancelText: window.tPlayer('player.navigation.stayContinue') || 'Stay',
          html: true
        }
      );
      
      if (shouldLeave) {
        // Actually navigate away
        history.back();
        setTimeout(() => {
          window.location.href = 'about:blank';
        }, 100);
      }
    }
  }
  
  /**
   * Navigate to a step without pushing to browser history
   * Used for back button navigation
   */
  navigateToStepWithoutHistory(targetStep) {
    if (!targetStep) return;
    
    // Update state
    this.previewState.currentStep = targetStep;
    this.previewState.chatHistory = [];
    this.previewState.messageCount = 0;
    this.previewState.pacingUnlocked = false;
    this.previewState.quizPassed = false;
    this.previewState.videoTimerStarted = false;
    this.previewState._endStepCompleted = false;
    
    // Render the step
    this.renderPreview();
    
    // Update guide chat
    this.updateGuideChatForStep(targetStep);
    
    // Update progress bar (both player mode and builder preview)
    this.updatePlayerProgress();
  }
  
  /**
   * Update the player progress bar in player mode
   * 
   * Uses intelligent calculation:
   * 1. If on an end step (main journey) → 100%
   * 2. For nested journeys: progress is based on parent + nested combined
   * 3. Otherwise: calculates based on position in the journey path
   */
  updatePlayerProgress() {
    // Update progress bar for both player mode and builder preview mode
    const playerProgressBar = document.getElementById('playerProgressBar');
    const previewProgressBar = document.getElementById('previewProgressBar');
    
    const pos = this.computeJourneyPosition();
    if (!pos) return;
    
    // Update both progress bars if they exist
    if (playerProgressBar) {
      playerProgressBar.style.width = `${pos.percentage}%`;
    }
    if (previewProgressBar) {
      previewProgressBar.style.width = `${pos.percentage}%`;
    }
    
    // Keep the step indicator on the card in sync with the bar
    const indicator = document.querySelector('.journey-step-indicator');
    if (indicator) this.fillStepIndicator(indicator, pos);
  }
  
  /**
   * Where the user is in the journey: current step number, estimated
   * total and progress percentage. Single source of truth for the
   * progress bar AND the "Step X of Y" indicator, so they always agree.
   * 
   * - End step of the main journey → 100%
   * - Nested journeys: parent + nested combined (the nested step itself
   *   counts once in the parent), capped below 100% because parent
   *   steps remain after the nested end step
   * - Branching journeys: total is the longest remaining route
   *   (matching calculateEstimatedPathLength), flagged as approximate
   */
  computeJourneyPosition() {
    const currentStep = this.previewState.currentStep;
    if (!currentStep) return null;
    
    // Visited steps usually already include the current step; only add
    // 1 when they don't (defensive - some flows push it later).
    const countWithCurrent = (visited) =>
      visited.includes(currentStep.id) ? visited.length : visited.length + 1;
    
    const isNested = !!(this.previewState.isInNestedJourney && this.previewState.nestedContext);
    let current;
    let total;
    let percentage;
    
    if (isNested) {
      const ctx = this.previewState.nestedContext;
      // Earlier completed nested journeys keep counting; the active one
      // is excluded because its live numbers are added below.
      const done = this.getCompletedNestedProgress(ctx.parentStepId);
      const parentVisited = (ctx.parentVisitedSteps?.length || 0) + done.visited;
      const parentTotal = this.calculateEstimatedPathLengthForSteps(ctx.parentSteps, ctx.parentPaths)
        + done.total;
      const nestedVisited = countWithCurrent(this.previewState.visitedSteps);
      const nestedTotal = this.calculateEstimatedPathLength();
      
      total = Math.max(parentTotal + nestedTotal - 1, 1); // nested step counts once in the parent
      current = Math.min(parentVisited + nestedVisited, total);
      // Never show 100% inside a nested journey - parent steps remain
      const cap = currentStep.is_end ? 95 : 94;
      percentage = Math.min(Math.round((current / total) * 100), cap);
    } else {
      const done = this.getCompletedNestedProgress(null);
      total = Math.max(this.calculateEstimatedPathLength() + done.total, 1);
      if (currentStep.is_end) {
        current = total;
        percentage = 100;
      } else {
        current = Math.min(countWithCurrent(this.previewState.visitedSteps) + done.visited, total);
        percentage = Math.min(Math.round((current / total) * 100), 99);
      }
    }
    
    return {
      current: Math.max(current, 1),
      total,
      percentage,
      isApprox: isNested || this.journeyHasBranches()
    };
  }
  
  /**
   * Remember how many steps a completed nested journey contributed, so
   * the step indicator keeps counting them after returning to the
   * parent. Keyed by the parent's nested-journey step (overwritten on
   * re-entry, so nothing is counted twice). Minus 1 on both numbers
   * because the nested step itself is already part of the parent count.
   */
  recordNestedJourneyProgress(parentStepId, visitedCount, totalEstimate) {
    if (!parentStepId) return;
    if (!this.previewState.completedNestedProgress) {
      this.previewState.completedNestedProgress = {};
    }
    this.previewState.completedNestedProgress[parentStepId] = {
      visited: Math.max(visitedCount - 1, 0),
      total: Math.max(totalEstimate - 1, 0)
    };
  }
  
  /**
   * Sum of the contributions of completed nested journeys, excluding
   * the one currently being played (its live numbers are used instead).
   */
  getCompletedNestedProgress(excludeStepId) {
    const done = this.previewState.completedNestedProgress || {};
    let visited = 0;
    let total = 0;
    for (const [stepId, progress] of Object.entries(done)) {
      if (stepId === excludeStepId) continue;
      visited += progress.visited;
      total += progress.total;
    }
    return { visited, total };
  }
  
  /**
   * Whether the exact route length is knowable upfront: any step with
   * multiple outgoing paths (choices) or a nested journey makes the
   * total an estimate rather than a fact.
   */
  journeyHasBranches() {
    const hasChoice = (paths) => {
      const seen = new Set();
      for (const p of paths || []) {
        if (seen.has(p.from_step_id)) return true;
        seen.add(p.from_step_id);
      }
      return false;
    };
    if (hasChoice(this.paths)) return true;
    if (this.previewState.isInNestedJourney
        && hasChoice(this.previewState.nestedContext?.parentPaths)) {
      return true;
    }
    return (this.steps || []).some(s => s.type === 'nested_journey');
  }
  
  /**
   * The steps along the longest route from start to an end step - the
   * same route calculateEstimatedPathLength measures. Used for the
   * duration estimate on the start step.
   */
  getEstimatedPathSteps() {
    const startStep = this.steps.find(s => s.is_start);
    if (!startStep) return this.steps.slice();
    
    const visiting = new Set();
    let best = [];
    
    const traverse = (stepId, trail) => {
      if (visiting.has(stepId)) return; // cycle guard
      const step = this.steps.find(s => s.id === stepId);
      if (!step) return;
      visiting.add(stepId);
      trail.push(step);
      
      const outgoing = step.is_end ? [] : this.paths.filter(p => p.from_step_id === stepId);
      if (outgoing.length === 0) {
        if (trail.length > best.length) best = trail.slice();
      } else {
        for (const path of outgoing) traverse(path.to_step_id, trail);
      }
      
      trail.pop();
      visiting.delete(stepId);
    };
    
    traverse(startStep.id, []);
    return best.length > 0 ? best : this.steps.slice();
  }
  
  /**
   * Rough total duration in whole minutes for the expected route.
   * Deliberately coarse (reading speed ~200 wpm plus a base time per
   * step type) - it only has to answer "is this 5 minutes or half an
   * hour?" for the start step.
   */
  estimateJourneyDuration() {
    try {
      const steps = this.getEstimatedPathSteps();
      if (steps.length === 0) return 0;
      let seconds = 0;
      for (const step of steps) seconds += this.estimateStepSeconds(step);
      return Math.max(1, Math.round(seconds / 60));
    } catch {
      return 0; // no estimate is better than a broken one
    }
  }
  
  estimateStepSeconds(step) {
    let basic = step.basic_props;
    if (typeof basic === 'string') {
      try { basic = JSON.parse(basic); } catch { basic = {}; }
    }
    basic = basic || {};
    
    // Count readable words in the step's content, skipping URLs and
    // technical fields (ids, colors, file references)
    let words = ((step.title || '').match(/\S+/g) || []).length;
    const collect = (val, key) => {
      if (typeof val === 'string') {
        if (/^(https?:|data:|\/)/i.test(val)) return;
        if (/url|image|video|file|color|icon|token|_id$|^id$/i.test(key || '')) return;
        const plain = val.replace(/<[^>]*>/g, ' ');
        words += (plain.match(/\S+/g) || []).length;
      } else if (Array.isArray(val)) {
        for (const v of val) collect(v, key);
      } else if (val && typeof val === 'object') {
        for (const [k, v] of Object.entries(val)) collect(v, k);
      }
    };
    collect(basic, '');
    
    const BASE_SECONDS = {
      content: 15,
      space: 25,
      guide: 60,
      challenge: 20,
      form: 30,
      poll: 15,
      reward: 15,
      nested_journey: 180
    };
    let seconds = BASE_SECONDS[step.type] ?? 20;
    seconds += words * (60 / 200); // ~200 words per minute
    if (Array.isArray(basic.questions)) seconds += basic.questions.length * 20;
    if (Array.isArray(basic.fields)) seconds += basic.fields.length * 15;
    if (basic.video_url) seconds += 90;
    return seconds;
  }
  
  /**
   * Calculate estimated path length for a specific set of steps/paths
   * Used for parent journey estimation during nested journey navigation
   */
  calculateEstimatedPathLengthForSteps(steps, paths) {
    if (!steps || steps.length === 0) return 1;
    
    const startStep = steps.find(s => s.is_start);
    if (!startStep) return steps.length;
    
    // Find the longest path from start to any end step using DFS
    const visited = new Set();
    let maxDepth = 0;
    
    const traverse = (stepId, depth) => {
      if (visited.has(stepId)) return;
      visited.add(stepId);
      
      const step = steps.find(s => s.id === stepId);
      if (!step) {
        visited.delete(stepId);
        return;
      }
      
      maxDepth = Math.max(maxDepth, depth);
      
      if (step.is_end) {
        visited.delete(stepId);
        return;
      }
      
      const outgoingPaths = (paths || []).filter(p => p.from_step_id === stepId);
      for (const path of outgoingPaths) {
        traverse(path.to_step_id, depth + 1);
      }
      
      visited.delete(stepId);
    };
    
    traverse(startStep.id, 1);
    return Math.max(maxDepth, steps.length > 0 ? 2 : 1);
  }
  
  /**
   * Calculate the estimated path length from start to end
   * Uses the longest reachable path to give accurate progress for branching journeys
   */
  calculateEstimatedPathLength() {
    // Return cached value if available and steps haven't changed. The
    // journey id is part of the key because entering/exiting a nested
    // journey swaps this.steps for a different journey entirely.
    const cacheKey = `${this.journey?.id || ''}:${this.steps.length}`;
    if (this._cachedPathLength && this._cachedStepsHash === cacheKey) {
      return this._cachedPathLength;
    }
    
    const startStep = this.steps.find(s => s.is_start);
    if (!startStep) return this.steps.length;
    
    // Find the longest path from start to any end step using DFS
    const visited = new Set();
    let maxDepth = 0;
    
    const traverse = (stepId, depth) => {
      // Prevent infinite loops in cyclic graphs
      if (visited.has(stepId)) return;
      visited.add(stepId);
      
      const step = this.steps.find(s => s.id === stepId);
      if (!step) {
        visited.delete(stepId);
        return;
      }
      
      // If this is an end step, record the depth
      if (step.is_end) {
        maxDepth = Math.max(maxDepth, depth);
        visited.delete(stepId);
        return;
      }
      
      // Find outgoing paths from this step
      const outgoingPaths = this.paths.filter(p => p.from_step_id === stepId);
      
      // If no outgoing paths and not an end step, treat as implicit end
      if (outgoingPaths.length === 0) {
        maxDepth = Math.max(maxDepth, depth);
        visited.delete(stepId);
        return;
      }
      
      // Traverse all outgoing paths
      for (const path of outgoingPaths) {
        traverse(path.to_step_id, depth + 1);
      }
      
      visited.delete(stepId);
    };
    
    traverse(startStep.id, 1);
    
    // Cache the result
    this._cachedPathLength = maxDepth > 0 ? maxDepth : this.steps.length;
    this._cachedStepsHash = cacheKey;
    
    return this._cachedPathLength;
  }
  
  async loadGuides() {
    // In player mode, guides are preloaded server-side
    if (this.playerMode && this.guides.length > 0) {
      return;
    }
    
    try {
      const response = await fetch('/api/guides');
      const result = await response.json();
      if (result.success) {
        this.guides = result.guides || [];
        // Guides are loaded async, but step previews depend on them.
        // Re-render steps so "guide" nodes immediately show the linked guide.
        this.render();
        this.drawConnections();
      }
    } catch (err) {
      console.error('Failed to load guides:', err);
      this.guides = [];
    }
  }
  
  async loadAvailableNestedJourneys() {
    // Skip in player mode
    if (this.playerMode) {
      return;
    }
    
    try {
      const response = await fetch(`/api/journeys/${this.journey.id}/available-for-nesting`);
      const result = await response.json();
      if (result.success) {
        this.availableNestedJourneys = result.journeys || [];
        // Re-render steps to show nested journey previews
        this.render();
        this.drawConnections();
      }
    } catch (err) {
      console.error('Failed to load available nested journeys:', err);
      this.availableNestedJourneys = [];
    }
  }
  
  /**
   * Save progress to server in player mode
   * Security: Server validates the token before saving
   */
  async savePlayerProgress() {
    if (!this.playerMode || !this.player?.token) return;
    
    try {
      await fetch(`/e/${this.player.token}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_step_id: this.previewState.currentStep?.id,
          visited_steps: this.previewState.visitedSteps,
          answers: this.previewState.answers || {}
        })
      });
    } catch (err) {
      console.error('[PlayerMode] Failed to save progress:', err);
    }
  }
  
  /**
   * URL to check a quiz answer on the server, or null in the maker preview
   * (which has the answers itself)
   */
  getQuizCheckUrl() {
    if (this.playerMode && this.player?.token) {
      return `/e/${encodeURIComponent(this.player.token)}/quiz/check`;
    }
    const publicToken = window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token;
    if (publicToken) {
      return `/p/${encodeURIComponent(publicToken)}/quiz/check`;
    }
    return null;
  }

  /**
   * Save quiz attempt to database for analytics
   */
  async saveQuizAttempt(stepId, attemptNumber, totalQuestions, correctCount, passed) {
    if (!this.playerMode || !this.player?.token) return;
    
    try {
      await fetch(`/e/${this.player.token}/analytics/quiz-attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          step_id: stepId,
          journey_id: this.journey?.id,
          attempt_number: attemptNumber,
          // The server scores the attempt from the answers it checked
          attempt_key: this.previewState.quizAttemptKey,
          duration_ms: journeyAnalytics.currentQuizAttempt?.startTime 
            ? Date.now() - journeyAnalytics.currentQuizAttempt.startTime 
            : null,
          session_id: journeyAnalytics.sessionId,
          device_info: journeyAnalytics.deviceInfo
        })
      });
      console.log('[Analytics] Quiz attempt saved:', { attemptNumber, score: correctCount + '/' + totalQuestions, passed });
    } catch (err) {
      console.error('[Analytics] Failed to save quiz attempt:', err);
    }
  }
  
  /**
   * Save video watch session to database for analytics
   */
  async saveVideoSession(stepId, videoData) {
    if (!this.playerMode || !this.player?.token) return;
    
    try {
      await fetch(`/e/${this.player.token}/analytics/video-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          step_id: stepId,
          journey_id: this.journey?.id,
          video_url: videoData.url,
          video_duration_sec: videoData.duration,
          watch_time_sec: videoData.watchTime,
          max_position_sec: videoData.maxPosition,
          watch_percentage: videoData.watchPercentage,
          completed: videoData.completed,
          pause_count: videoData.pauseCount,
          seek_count: videoData.seekCount,
          session_id: journeyAnalytics.sessionId
        })
      });
      console.log('[Analytics] Video session saved:', { watchPercentage: videoData.watchPercentage, completed: videoData.completed });
    } catch (err) {
      console.error('[Analytics] Failed to save video session:', err);
    }
  }
  
  /**
   * Save form analytics to database
   */
  async saveFormAnalytics(stepId, formData) {
    if (!this.playerMode || !this.player?.token) return;
    
    try {
      await fetch(`/e/${this.player.token}/analytics/form-completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          step_id: stepId,
          journey_id: this.journey?.id,
          total_fields: formData.totalFields,
          filled_fields: formData.filledFields,
          duration_ms: formData.duration,
          field_timings: formData.fieldTimings || [],
          session_id: journeyAnalytics.sessionId
        })
      });
      console.log('[Analytics] Form analytics saved:', { fields: formData.filledFields + '/' + formData.totalFields });
    } catch (err) {
      console.error('[Analytics] Failed to save form analytics:', err);
    }
  }
  
  /**
   * Track step_completed for end steps that the user never navigates away from.
   * Non-interactive types fire immediately; interactive types fire after interaction.
   * Idempotent: uses a flag to prevent duplicate events.
   */
  trackEndStepCompletion(step) {
    if (!step?.is_end || !this.playerMode) return;
    if (this.previewState._endStepCompleted) return;
    this.previewState._endStepCompleted = true;
    journeyAnalytics.stepCompleted(step.id, step.type);
  }
  
  /**
   * Determines if an end step should auto-complete (no user interaction needed).
   */
  isEndStepAutoComplete(step) {
    const viewOnlyTypes = ['space', 'content', 'reward', 'guide', 'nested_journey'];
    if (viewOnlyTypes.includes(step.type)) return true;
    
    const bp = typeof step.basic_props === 'string'
      ? JSON.parse(step.basic_props) : (step.basic_props || {});
    const ap = typeof step.advanced_props === 'string'
      ? JSON.parse(step.advanced_props) : (step.advanced_props || {});
    
    if (step.type === 'poll' && bp.is_required === false) return true;
    if (step.type === 'form' && (ap.completion_requirement || 'after_submit') !== 'after_submit') return true;
    
    return false;
  }
  
  /**
   * Mark journey as completed in player mode
   */
  async completePlayerJourney() {
    // If we're in a nested journey, exit back to parent instead of completing
    // This works in both player mode and builder preview mode
    if (this.previewState.isInNestedJourney) {
      console.log('[Journey] Nested journey completed, returning to parent');
      await this.exitNestedJourney();
      return;
    }
    
    // For actual journey completion, only works in player mode
    if (!this.playerMode || !this.player?.token) return;
    
    try {
      // Track journey completion
      journeyAnalytics.journeyCompleted();
      
      await fetch(`/e/${this.player.token}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('[PlayerMode] Journey completed!');
    } catch (err) {
      console.error('[PlayerMode] Failed to complete journey:', err);
    }
  }
  
  /**
   * Restart the journey from the beginning
   * Only available in player mode when multiple completions are allowed
   */
  async restartJourney() {
    if (!this.playerMode || !this.player?.token) {
      console.warn('[Journey] Restart not available - not in player mode');
      return;
    }
    
    try {
      console.log('[Journey] Restarting journey...');
      
      const response = await fetch(`/e/${this.player.token}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const data = await response.json();
      
      if (!data.success) {
        this.showToast(data.error || 'Failed to restart journey', 'error');
        return;
      }
      
      // Update local completions count
      if (this.player) {
        this.player.completionsCount = (this.player.completionsCount || 0) + 1;
      }
      
      // Reset preview state
      this.previewState.visitedSteps = [];
      this.previewState.answers = {};
      this.previewState.currentStep = null;
      this.previewState.chatHistory = [];
      this.previewState.messageCount = 0;
      this.previewState.pacingUnlocked = false;
      this.previewState.quizPassed = false;
      this.previewState.videoCompleted = false;
      this.previewState._endStepCompleted = false;
      this.previewState.stepHistory = [];
      this.previewState.historyIndex = -1;
      this.previewState.isInNestedJourney = false;
      this.previewState.nestedContext = null;
      this.previewState.completedNestedProgress = {};
      
      // Find and navigate to start step
      const startStep = this.steps.find(s => s.is_start) || this.steps[0];
      if (startStep) {
        this.previewState.visitedSteps.push(startStep.id);
        this.previewState.currentStep = startStep;
        this.previewState.stepHistory = [startStep.id];
        this.previewState.historyIndex = 0;
        
        // Render the start step
        this.renderPreview();
        this.updatePlayerProgress();
        
        // Push initial state to browser history
        history.replaceState({ 
          stepId: startStep.id, 
          historyIndex: 0,
          isJourneyState: true 
        }, '', window.location.href);
        
        console.log('[Journey] Journey restarted successfully');
      }
      
    } catch (err) {
      console.error('[Journey] Failed to restart journey:', err);
      this.showToast('Failed to restart journey', 'error');
    }
  }
  
  /**
   * Enter a nested journey (works in both player mode and builder preview)
   */
  async enterNestedJourney(nestedJourneyId, currentStepId) {
    console.log('[NestedJourney] Entering nested journey:', nestedJourneyId);
    
    try {
      let data;
      
      if (this.playerMode && this.player?.token) {
        // Player mode: use the authenticated endpoint
        const response = await fetch(`/e/${this.player.token}/enter-nested`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            step_id: currentStepId,
            nested_journey_id: nestedJourneyId,
            current_step_id: this.previewState.currentStep?.id,
            visited_steps: this.previewState.visitedSteps,
            answers: this.previewState.answers || {}
          })
        });
        data = await response.json();
      } else {
        // Builder preview mode: use the API endpoint
        const response = await fetch(`/api/journeys/${this.journey.id}/nested-preview/${nestedJourneyId}`);
        data = await response.json();
      }
      
      if (!data.success) {
        console.error('[NestedJourney] Failed to enter:', data.error);
        this.showToast(data.error || 'Failed to enter nested journey', 'error');
        return false;
      }
      
      // Store parent journey context in preview state (including language and translations)
      // We store both translation objects to properly restore the interface when exiting
      this.previewState.nestedContext = {
        parentJourney: this.journey,
        parentSteps: this.steps,
        parentPaths: this.paths,
        parentResources: this.resources,
        parentGuides: this.guides,
        parentStepId: currentStepId,
        parentVisitedSteps: [...this.previewState.visitedSteps],
        parentAnswers: { ...(this.previewState.answers || {}) },
        parentLanguage: this.currentLanguage || window.GRYFFI?.journeyLanguage || 'en',
        parentTranslations: window.GRYFFI?.translations ? JSON.parse(JSON.stringify(window.GRYFFI.translations)) : null
      };
      this.previewState.isInNestedJourney = true;
      
      // Switch to nested journey data
      this.journey = data.nestedJourney;
      this.steps = data.steps;
      this.paths = data.paths;
      this.resources = data.resources || [];
      this.guides = data.guides || [];
      
      // Find and set the start step
      const startStep = this.steps.find(s => s.id === data.startStepId) || this.steps.find(s => s.is_start) || this.steps[0];
      
      // Reset preview state for nested journey
      this.previewState.currentStep = startStep;
      this.previewState.visitedSteps = [startStep.id];
      this.previewState.chatHistory = [];
      this.previewState.messageCount = 0;
      this.previewState.pacingUnlocked = false;
      this.previewState.quizPassed = false;
      this.previewState._endStepCompleted = false;
      
      // Handle language change if nested journey has different language
      if (data.language && data.translations) {
        console.log('[NestedJourney] Switching language to:', data.language);
        await this.switchLanguage(data.language, data.translations);
      }
      
      // Track nested journey entry (in player mode)
      if (this.playerMode) {
        const parentJourneyId = this.previewState.nestedContext?.parentJourney?.id;
        journeyAnalytics.nestedJourneyEntered(nestedJourneyId, parentJourneyId);
        journeyAnalytics.setNestedJourney(nestedJourneyId, parentJourneyId);
        journeyAnalytics.stepEntered(startStep.id, startStep.type);
      }
      
      // Re-render
      this.renderPreview();
      this.updateGuideChatForStep(startStep);
      this.updatePlayerProgress();
      
      // No toast message - seamless transition for end users
      console.log('[NestedJourney] Successfully entered nested journey');
      return true;
      
    } catch (err) {
      console.error('[NestedJourney] Error entering nested journey:', err);
      this.showToast('Failed to enter nested journey', 'error');
      return false;
    }
  }
  
  /**
   * Exit nested journey and return to parent (works in both player mode and builder preview)
   */
  async exitNestedJourney() {
    if (!this.previewState.isInNestedJourney) return false;
    
    console.log('[NestedJourney] Exiting nested journey, returning to parent');
    
    const nestedContext = this.previewState.nestedContext;
    if (!nestedContext) {
      console.error('[NestedJourney] No nested context found');
      return false;
    }
    
    try {
      // Capture how far the user got inside the nested journey before
      // the state is swapped back: the step indicator keeps counting
      // these steps after returning to the parent, so the numbers never
      // jump backwards (e.g. from "step 8 of 9" to "step 3 of 3").
      const nestedVisitedCount = this.previewState.visitedSteps.length;
      const nestedTotalEstimate = this.calculateEstimatedPathLength();
      
      let exitPaths = [];
      
      if (this.playerMode && this.player?.token) {
        // Player mode: use the authenticated endpoint
        const response = await fetch(`/e/${this.player.token}/exit-nested`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (!data.success) {
          console.error('[NestedJourney] Failed to exit:', data.error);
          this.showToast(data.error || 'Failed to return to parent journey', 'error');
          return false;
        }
        
        // Restore parent journey data from server response
        this.journey = data.parentJourney;
        this.steps = data.steps;
        this.paths = data.paths;
        this.resources = data.resources || [];
        this.guides = data.guides || [];
        exitPaths = data.exitPaths || [];
        
        // Find the step we were on (the nested journey step)
        const returnStep = this.steps.find(s => s.id === data.currentStepId);
        
        // Restore language and translations from server
        if (data.language && data.translations) {
          console.log('[NestedJourney] Restoring parent language from server:', data.language);
          await this.switchLanguage(data.language, data.translations);
        }
        
        // Reset nested state
        this.previewState.nestedContext = null;
        this.previewState.isInNestedJourney = false;
        
        // Restore parent journey progress
        this.previewState.currentStep = returnStep;
        this.previewState.visitedSteps = data.visitedSteps || [];
        this.previewState.answers = data.answers || {};
        
      } else {
        // Builder preview mode: restore from local context
        this.journey = nestedContext.parentJourney;
        this.steps = nestedContext.parentSteps;
        this.paths = nestedContext.parentPaths;
        this.resources = nestedContext.parentResources || [];
        this.guides = nestedContext.parentGuides || [];
        
        // Find the step we were on (the nested journey step)
        const returnStep = this.steps.find(s => s.id === nestedContext.parentStepId);
        
        // Get exit paths from the nested journey step
        exitPaths = this.paths.filter(p => p.from_step_id === nestedContext.parentStepId);
        
        // Add the nested journey step to visited
        const updatedVisitedSteps = [...(nestedContext.parentVisitedSteps || [])];
        if (!updatedVisitedSteps.includes(nestedContext.parentStepId)) {
          updatedVisitedSteps.push(nestedContext.parentStepId);
        }
        
        // Restore parent language and translations (for builder preview mode)
        const parentLanguage = nestedContext.parentLanguage;
        const parentTranslations = nestedContext.parentTranslations;
        if (parentLanguage || parentTranslations) {
          console.log('[NestedJourney] Restoring parent language (builder):', parentLanguage);
          await this.switchLanguage(parentLanguage, parentTranslations);
        }
        
        // Reset nested state
        this.previewState.nestedContext = null;
        this.previewState.isInNestedJourney = false;
        
        // Restore parent journey progress
        this.previewState.currentStep = returnStep;
        this.previewState.visitedSteps = updatedVisitedSteps;
        this.previewState.answers = nestedContext.parentAnswers || {};
      }
      
      // Common reset for both modes
      this.recordNestedJourneyProgress(nestedContext.parentStepId, nestedVisitedCount, nestedTotalEstimate);
      this.previewState.chatHistory = [];
      this.previewState.messageCount = 0;
      this.previewState.pacingUnlocked = true; // Unlock since nested journey was completed
      
      // Track nested journey completion (in player mode)
      if (this.playerMode) {
        const parentJourneyId = this.journey?.id;
        const nestedJourneyId = nestedContext.parentJourney?.id !== parentJourneyId 
          ? nestedContext.nestedJourneyId 
          : null;
        journeyAnalytics.nestedJourneyCompleted(nestedJourneyId, parentJourneyId, null);
        journeyAnalytics.clearNestedJourney(parentJourneyId);
      }
      
      // No toast message - seamless transition for end users
      console.log('[NestedJourney] Successfully returned to parent journey');
      
      // Auto-navigate to next step immediately (seamless for end users)
      if (exitPaths && exitPaths.length > 0) {
        const nextStepId = exitPaths[0].to_step_id;
        const nextStep = this.steps.find(s => s.id === nextStepId);
        if (nextStep) {
          console.log('[NestedJourney] Auto-navigating to next step:', nextStep.title);
          // Small delay just to ensure state is updated before navigation
          setTimeout(() => {
            this.navigateToStep(nextStep);
          }, 50);
          return true;
        }
      }
      
      // Only re-render if we're not auto-navigating
      this.renderPreview();
      this.updateGuideChatForStep(this.previewState.currentStep);
      this.updatePlayerProgress();
      return true;
      
    } catch (err) {
      console.error('[NestedJourney] Error exiting nested journey:', err);
      this.showToast('Failed to return to parent journey', 'error');
      return false;
    }
  }
  
  /**
   * Navigate to a specific step (helper for nested journey return)
   */
  async navigateToStep(targetStep) {
    if (!targetStep) return;
    
    // Track step completion for current step (if in player mode)
    if (this.playerMode && this.previewState.currentStep) {
      journeyAnalytics.stepCompleted(
        this.previewState.currentStep.id, 
        this.previewState.currentStep.type
      );
    }
    
    // Add current step to visited if not already
    if (!this.previewState.visitedSteps.includes(this.previewState.currentStep.id)) {
      this.previewState.visitedSteps.push(this.previewState.currentStep.id);
    }
    if (!this.previewState.visitedSteps.includes(targetStep.id)) {
      this.previewState.visitedSteps.push(targetStep.id);
    }
    
    // Update state
    this.previewState.currentStep = targetStep;
    this.previewState.chatHistory = [];
    this.previewState.messageCount = 0;
    this.previewState.pacingUnlocked = false;
    this.previewState.quizPassed = false;
    this.previewState.videoTimerStarted = false;
    this.previewState._endStepCompleted = false;
    
    // Track step entry for new step
    if (this.playerMode) {
      journeyAnalytics.stepEntered(targetStep.id, targetStep.type);
    }
    
    // NESTED JOURNEY: If this is a nested journey step, enter it directly without rendering
    // This provides seamless UX - users don't see any intermediate "loading" screen
    if (targetStep.type === 'nested_journey' && !this.previewState.isInNestedJourney) {
      const basicProps = targetStep.basic_props || {};
      const nestedJourneyId = basicProps.nested_journey_id;
      
      if (nestedJourneyId) {
        console.log('[NestedJourney] Direct entry from navigateToStep:', nestedJourneyId);
        
        // Store the paths from this step for after the nested journey completes
        const exitPaths = this.paths.filter(p => p.from_step_id === targetStep.id);
        this.previewState.pendingExitPaths = exitPaths;
        
        await this.enterNestedJourney(nestedJourneyId, targetStep.id);
        return; // Don't render the nested journey step itself
      }
    }
    
    // Render
    this.renderPreview();
    this.updateGuideChatForStep(targetStep);
    this.updatePlayerProgress();
    
    // Save progress
    if (this.playerMode) {
      this.savePlayerProgress();
    }
    
    // Trigger automations
    this.triggerAutomation('on_step_enter', targetStep.id);
    
    // Check if end step
    if (targetStep.is_end) {
      this.triggerAutomation('on_journey_complete', targetStep.id);
      if (this.playerMode) {
        this.previewState._endStepCompleted = false;
        if (this.isEndStepAutoComplete(targetStep)) {
          this.trackEndStepCompletion(targetStep);
        }
        this.completePlayerJourney();
      }
    }
  }
  
  bindEvents() {
    // Step type buttons
    document.querySelectorAll('.step-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
        return this.createStep(btn.dataset.type);
      });
    });
    
    // Zoom controls
    document.getElementById('zoomIn')?.addEventListener('click', () => this.setZoom(this.zoom + 0.1));
    document.getElementById('zoomOut')?.addEventListener('click', () => this.setZoom(this.zoom - 0.1));
    
    // Panel close
    document.getElementById('closePanel')?.addEventListener('click', () => this.closeProperties());
    
    // Journey settings button (gear icon)
    document.getElementById('journeySettingsBtn')?.addEventListener('click', () => this.showJourneySettings());
    
    // Canvas background click - show journey settings
    // Listen on the outer canvas container for better click detection
    const canvasContainer = document.getElementById('canvas');
    canvasContainer?.addEventListener('click', (e) => {
      // Only trigger if NOT clicking on a step node, connection port, or zoom controls
      if (!e.target.closest('.step-node') && 
          !e.target.closest('.connection-port') && 
          !e.target.closest('.step-email-badge') &&
          !e.target.closest('.zoom-controls') &&
          !e.target.closest('#zoomIn') &&
          !e.target.closest('#zoomOut')) {
        this.showJourneySettings();
      }
    });
    
    // Delete step
    document.getElementById('deleteStepBtn')?.addEventListener('click', () => {
      if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
      return this.deleteSelectedStep();
    });
    
    // Save button
    document.getElementById('saveBtn')?.addEventListener('click', () => {
      if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
      return this.save();
    });

    // Undo/Redo buttons
    document.getElementById('undoBtn')?.addEventListener('click', () => this.undo());
    document.getElementById('redoBtn')?.addEventListener('click', () => this.redo());

    // Keyboard shortcuts (avoid overriding native undo inside inputs)
    document.addEventListener('keydown', (e) => {
      if (this.readOnly) return;
      if (this.isUndoRedoInFlight) return;
      const target = e.target;
      const isEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (isEditable) return;

      const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      const key = (e.key || '').toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        this.redo();
      }
    });
    
    // Preview button
    document.getElementById('previewBtn')?.addEventListener('click', () => this.openPreview());
    document.getElementById('closePreview')?.addEventListener('click', () => this.closePreview());
    
    // Resources modal (button removed from toolbar, but modal functionality kept)
    // document.getElementById('resourcesBtn')?.addEventListener('click', () => this.openResourcesModal());
    document.getElementById('closeResourcesModal')?.addEventListener('click', () => this.closeResourcesModal());
    document.getElementById('addResourceBtn')?.addEventListener('click', () => this.addResource());
    
    // Click outside to deselect
    this.canvas?.addEventListener('click', (e) => {
      if (e.target === this.canvas || e.target.closest('#flowCanvas') === this.canvas) {
        if (!e.target.closest('.step-node')) {
          this.deselectAll();
        }
      }
    });
    
    // Canvas panning - drag the background to move around
    const canvasOuter = document.getElementById('canvas');
    let hasPanned = false;
    
    canvasOuter?.addEventListener('mousedown', (e) => {
      // Only pan when clicking directly on the canvas background (not on nodes, ports, or controls)
      if (e.target.closest('.step-node') || e.target.closest('.connection-port') || e.target.closest('.step-email-badge') || e.target.closest('button') || e.target.closest('#zoomIn') || e.target.closest('#zoomOut')) {
        return;
      }
      // Don't pan on right-click
      if (e.button !== 0) return;
      
      this.isPanning = true;
      hasPanned = false;
      this.panStart = { x: e.clientX - this.pan.x, y: e.clientY - this.pan.y };
      canvasOuter.style.cursor = 'grabbing';
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!this.isPanning) return;
      
      hasPanned = true;
      this.pan.x = e.clientX - this.panStart.x;
      this.pan.y = e.clientY - this.panStart.y;
      this.updateCanvasTransform();
    });
    
    document.addEventListener('mouseup', () => {
      if (this.isPanning) {
        this.isPanning = false;
        const canvasOuter = document.getElementById('canvas');
        if (canvasOuter) canvasOuter.style.cursor = '';
        
        // Prevent click event from triggering after panning
        if (hasPanned) {
          setTimeout(() => { hasPanned = false; }, 0);
        }
      }
    });
    
    // Override canvas click to not trigger after panning
    canvasOuter?.addEventListener('click', (e) => {
      if (hasPanned) {
        e.stopPropagation();
        hasPanned = false;
      }
    }, true);
    
    // ============================================
    // TOUCH SUPPORT FOR MOBILE/TABLET
    // ============================================
    
    // Touch state for pinch-to-zoom
    let initialPinchDistance = null;
    let initialZoom = this.zoom;
    let isTouchPanning = false;
    let touchPanStart = { x: 0, y: 0 };
    
    // Get distance between two touch points
    const getTouchDistance = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    
    // Touch start - detect single finger pan or two finger pinch
    canvasOuter?.addEventListener('touchstart', (e) => {
      // Don't interfere with step nodes or controls
      if (e.target.closest('.step-node') || e.target.closest('.connection-port') || 
          e.target.closest('.step-email-badge') || e.target.closest('button') || 
          e.target.closest('.zoom-controls')) {
        return;
      }
      
      if (e.touches.length === 1) {
        // Single finger - start panning
        isTouchPanning = true;
        hasPanned = false;
        const touch = e.touches[0];
        touchPanStart = { x: touch.clientX - this.pan.x, y: touch.clientY - this.pan.y };
      } else if (e.touches.length === 2) {
        // Two fingers - prepare for pinch zoom
        isTouchPanning = false;
        initialPinchDistance = getTouchDistance(e.touches);
        initialZoom = this.zoom;
        e.preventDefault(); // Prevent default zoom behavior
      }
    }, { passive: false });
    
    // Touch move - handle pan or pinch zoom
    canvasOuter?.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && isTouchPanning) {
        // Single finger panning
        hasPanned = true;
        const touch = e.touches[0];
        this.pan.x = touch.clientX - touchPanStart.x;
        this.pan.y = touch.clientY - touchPanStart.y;
        this.updateCanvasTransform();
        e.preventDefault();
      } else if (e.touches.length === 2 && initialPinchDistance !== null) {
        // Pinch to zoom
        const currentDistance = getTouchDistance(e.touches);
        const scale = currentDistance / initialPinchDistance;
        const newZoom = Math.max(0.25, Math.min(2, initialZoom * scale));
        this.setZoom(newZoom);
        e.preventDefault();
      }
    }, { passive: false });
    
    // Touch end - reset touch state
    canvasOuter?.addEventListener('touchend', (e) => {
      if (e.touches.length === 0) {
        // All fingers lifted
        isTouchPanning = false;
        initialPinchDistance = null;
        
        if (hasPanned) {
          setTimeout(() => { hasPanned = false; }, 0);
        }
      } else if (e.touches.length === 1) {
        // One finger remaining after pinch - switch to panning
        isTouchPanning = true;
        const touch = e.touches[0];
        touchPanStart = { x: touch.clientX - this.pan.x, y: touch.clientY - this.pan.y };
        initialPinchDistance = null;
      }
    });
    
    // Prevent default touch behaviors on canvas (like page scroll, browser zoom)
    canvasOuter?.addEventListener('touchmove', (e) => {
      if (e.touches.length >= 1 && (isTouchPanning || e.touches.length === 2)) {
        e.preventDefault();
      }
    }, { passive: false });
  }
  
  // ============================================
  // STEP MANAGEMENT
  // ============================================
  
  async createStep(type) {
    if (this.readOnly) return;
    const position = this.getNewStepPosition();
    
    try {
      const response = await fetch('/api/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journey_id: this.journey.id,
          type: type,
          title: this.getDefaultTitle(type),
          position_x: position.x,
          position_y: position.y,
          is_start: this.steps.length === 0,
          basic_props: this.getDefaultBasicProps(type),
          advanced_props: {}
        })
      });
      
      const data = await response.json();
      if (data.success) {
        this.steps.push(data.step);
        this.renderStep(data.step);
        this.selectStep(data.step.id);
        this.hideEmptyState();
        this.commitHistoryNow('createStep');
      }
    } catch (err) {
      console.error('Failed to create step:', err);
      this.showToast(window.t('builder.messages.stepCreateFailed'), 'error');
    }
  }
  
  async updateStep(stepId, updates) {
    if (this.readOnly) return;
    this.setSaveState('saving');
    try {
      const response = await fetch(`/api/steps/${stepId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      
      const data = await response.json();
      if (data.success) {
        const index = this.steps.findIndex(s => s.id === stepId);
        if (index !== -1) {
          this.steps[index] = data.step;
          this.renderStep(data.step);
          this.drawConnections();
          this.scheduleHistoryCommit(`step:${stepId}`);
        }
        this.setSaveState('saved');
      } else {
        this.setSaveState('error');
      }
    } catch (err) {
      console.error('Failed to update step:', err);
      this.setSaveState('error');
    }
  }
  
  async deleteSelectedStep() {
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    if (!this.selectedStep) return;
    return this.deleteStepById(this.selectedStep, { confirmPrompt: true });
  }

  async deleteStepById(stepId, { confirmPrompt = false } = {}) {
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    if (!stepId) return;
    
    // Find the step to check if it's a reward step
    const step = this.steps.find(s => s.id === stepId);
    
    // For reward steps, check impact first
    if (step?.type === 'reward') {
      try {
        const impactResponse = await fetch(`/api/steps/${stepId}/impact`);
        const impactData = await impactResponse.json();
        
        if (impactData.success && impactData.reward?.hasClaims) {
          // Show blocking modal - cannot delete reward with claims
          this.showRewardDeleteBlockedModal(impactData.reward);
          return;
        }
      } catch (err) {
        console.error('Failed to check step impact:', err);
      }
    }
    
    if (confirmPrompt && !await window.gryffi.modal.confirm(window.t('builder.messages.deleteStepConfirm'))) return;

    try {
      const response = await fetch(`/api/steps/${stepId}`, { 
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => ({}));
      
      if (data.success) {
        this.steps = this.steps.filter(s => s.id !== stepId);
        this.paths = this.paths.filter(p => p.from_step_id !== stepId && p.to_step_id !== stepId);
        document.querySelector(`[data-step-id="${stepId}"]`)?.remove();

        if (this.selectedStep === stepId) {
          this.selectedStep = null;
          this.closeProperties();
        }
        this.drawConnections();
        if (this.steps.length === 0) this.showEmptyState();
        this.commitHistoryNow('deleteStep');
      } else if (data.code === 'REWARD_HAS_CLAIMS') {
        // Show blocking modal
        this.showRewardDeleteBlockedModal(data.reward);
      }
    } catch (err) {
      console.error('Failed to delete step:', err);
    }
  }
  
  showRewardDeleteBlockedModal(reward) {
    // Remove existing modal if any
    document.getElementById('rewardDeleteBlockedModal')?.remove();
    
    const modal = document.createElement('div');
    modal.id = 'rewardDeleteBlockedModal';
    modal.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/50';
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
        <div class="flex items-start gap-4">
          <div class="flex-shrink-0 w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
            <svg class="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
            </svg>
          </div>
          <div class="flex-1">
            <h3 class="text-lg font-semibold text-zen-800">${window.t('builder.reward.cannotDelete')}</h3>
            <p class="text-sm text-zen-600 mt-1">"${escapeHtml(reward.title)}"</p>
            <p class="text-sm text-zen-600 mt-3">${window.t('builder.reward.cannotDeleteExplanation')}</p>
            <div class="mt-3 p-3 bg-gryffi-bg rounded-lg">
              <div class="flex items-center justify-between text-sm">
                <span class="text-zen-600">${window.t('builder.reward.claimedCodesCount')}</span>
                <span class="font-medium text-gryffi-primary">${reward.claimedCount}</span>
              </div>
            </div>
            <p class="text-xs text-zen-500 mt-3">${window.t('builder.reward.cannotDeleteHint')}</p>
          </div>
        </div>
        <div class="flex justify-end mt-6">
          <button id="rewardDeleteBlockedClose" class="px-4 py-2 bg-gryffi-primary text-white rounded-lg hover:bg-gryffi-primary/90 transition-colors">
            ${window.t('common.understood')}
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event handlers
    document.getElementById('rewardDeleteBlockedClose')?.addEventListener('click', () => {
      modal.remove();
    });
    
    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }
  
  // ============================================
  // PATH MANAGEMENT
  // ============================================
  
  async createPath(fromStepId, toStepId, label = null) {
    if (label === null) {
      label = window.t('builder.connections.continue');
    }
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    try {
      const response = await fetch('/api/paths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journey_id: this.journey.id,
          from_step_id: fromStepId,
          to_step_id: toStepId,
          label: label
        })
      });
      
      const data = await response.json();
      if (data.success) {
        this.paths.push(data.path);
        this.drawConnections();
        this.renderStep(this.steps.find(s => s.id === fromStepId));
        this.commitHistoryNow('createPath');
      }
    } catch (err) {
      console.error('Failed to create path:', err);
    }
  }

  async updatePath(pathId, updates) {
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    this.setSaveState('saving');
    try {
      const response = await fetch(`/api/paths/${pathId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!response.ok) {
        this.setSaveState('error');
        return;
      }
      const idx = this.paths.findIndex(p => p.id === pathId);
      if (idx !== -1) {
        this.paths[idx] = { ...this.paths[idx], ...updates };
      }
      this.drawConnections();
      this.scheduleHistoryCommit(`path:${pathId}`);
      this.setSaveState('saved');
    } catch (err) {
      console.error('Failed to update path:', err);
      this.setSaveState('error');
    }
  }
  
  async deletePath(pathId) {
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    try {
      await fetch(`/api/paths/${pathId}`, { method: 'DELETE' });
      this.paths = this.paths.filter(p => p.id !== pathId);
      this.drawConnections();
      this.commitHistoryNow('deletePath');
    } catch (err) {
      console.error('Failed to delete path:', err);
    }
  }
  
  // ============================================
  // RENDERING
  // ============================================
  
  render() {
    this.stepsContainer.innerHTML = '';
    this.steps.forEach(step => this.renderStep(step));
    
    if (this.steps.length === 0) {
      this.showEmptyState();
    } else {
      this.hideEmptyState();
    }
  }
  
  renderStep(step) {
    // Parse JSON props
    const basicProps = typeof step.basic_props === 'string' 
      ? JSON.parse(step.basic_props) 
      : (step.basic_props || {});
    // Check if journey-level automations apply to this step
    const journeyAutomations = this.journey.automations || [];
    const hasJourneyStartAutomation = step.is_start && journeyAutomations.some(a => a.trigger === 'on_journey_start');
    const hasJourneyCompleteAutomation = step.is_end && journeyAutomations.some(a => a.trigger === 'on_journey_complete');
    
    // Show badge only for journey-level automations (step-level automations removed)
    const hasAutomations = hasJourneyStartAutomation || hasJourneyCompleteAutomation;
    
    // Remove existing element if present
    document.querySelector(`[data-step-id="${step.id}"]`)?.remove();
    
    const element = document.createElement('div');
    element.className = `step-node ${step.is_start ? 'is-start' : ''} ${step.is_end ? 'is-end' : ''}`;
    element.dataset.stepId = step.id;
    element.style.left = `${step.position_x}px`;
    element.style.top = `${step.position_y}px`;
    
    // Get paths from this step
    const stepPaths = this.paths.filter(p => p.from_step_id === step.id);
    
    element.innerHTML = `
      ${hasAutomations ? `
        <div class="step-email-badge" data-step-id="${step.id}" title="${window.t('builder.props.clickToEditAutomations')}">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
          </svg>
        </div>
      ` : ''}
      <div class="step-header">
        <div class="step-icon ${escapeHtml(step.type)}">
          ${this.getStepIcon(step.type)}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm text-zen-900 truncate">${escapeHtml(step.title)}</div>
          <div class="text-xs text-zen-500">${this.getStepTypeLabel(step.type)}</div>
        </div>
        ${step.is_start ? `<span class="flow-badge start-badge" title="${window.t('builder.props.startStepTitle')}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3v18h2v-7h9l-3-4 3-4H8V3H6z"/></svg>
        </span>` : ''}
        ${step.is_end ? `<span class="flow-badge end-badge" title="${window.t('builder.props.endStepTitle')}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3v18h2v-7h9l-3-4 3-4H8V3H6z"/></svg>
        </span>` : ''}
      </div>
      <div class="step-body">
        ${this.getStepPreview(step, basicProps)}
      </div>
      ${stepPaths.length > 0 ? `
        <div class="step-footer">
          ${stepPaths.map(p => `<span class="path-badge">${escapeHtml(p.label)}</span>`).join('')}
        </div>
      ` : ''}
      <!-- Hybrid Flow: 4-directional connection ports -->
      <div class="connection-port port-top" data-port="top" data-step="${step.id}" title="${window.t('builder.props.connect')}"></div>
      <div class="connection-port port-right" data-port="right" data-step="${step.id}" title="${window.t('builder.props.connect')}"></div>
      <div class="connection-port port-bottom" data-port="bottom" data-step="${step.id}" title="${window.t('builder.props.connect')}"></div>
      <div class="connection-port port-left" data-port="left" data-step="${step.id}" title="${window.t('builder.props.connect')}"></div>
    `;
    
    // Event listeners
    element.addEventListener('mousedown', (e) => this.startDragStep(e, step));
    element.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectStep(step.id);
    });
    
    // Email badge click - go to Advanced tab and scroll to automations
    const emailBadge = element.querySelector('.step-email-badge');
    if (emailBadge) {
      emailBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectStep(step.id);
        // Wait for panel to render, then switch to Advanced tab
        setTimeout(() => {
          // Switch to Advanced tab
          document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
          document.querySelector('.panel-tab[data-tab="advanced"]')?.classList.add('active');
          document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.add('hidden'));
          document.getElementById('advancedTab')?.classList.remove('hidden');
          
          // Scroll to automations section
          document.getElementById('automationsSection')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      });
    }
    
    // Flow badges click - go to Journey Settings > Flow section
    element.querySelectorAll('.flow-badge').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showJourneySettings();
        // Wait for panel to render, then scroll to flow section
        setTimeout(() => {
          document.getElementById('flowSection')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      });
    });
    
    // Connection port events - all 4 ports can initiate connections
    element.querySelectorAll('.connection-port').forEach(port => {
      port.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.startConnectionDrag(step.id, port.dataset.port, e);
      });
    });
    
    this.stepsContainer.appendChild(element);
    
    // Update selection state
    if (this.selectedStep === step.id) {
      element.classList.add('selected');
    }
  }
  
  drawConnections() {
    const svg = this.connectionLayer;
    // Keep the defs, clear the rest
    const defs = svg.querySelector('defs');
    svg.innerHTML = '';
    if (defs) svg.appendChild(defs);
    
    this.paths.forEach(path => {
      const fromEl = document.querySelector(`[data-step-id="${path.from_step_id}"]`);
      const toEl = document.querySelector(`[data-step-id="${path.to_step_id}"]`);
      
      if (!fromEl || !toEl) return;
      
      // Get step dimensions and positions
      const fromRect = this.getStepRect(fromEl);
      const toRect = this.getStepRect(toEl);
      
      // Smart port selection based on relative positions
      const ports = this.getBestPorts(fromRect, toRect);
      
      // Get actual port coordinates
      const startPos = this.getPortPosition(fromRect, ports.from);
      const endPos = this.getPortPosition(toRect, ports.to);
      
      // Create the connection path with smart routing
      const pathData = this.calculateSmartPath(startPos, endPos, ports);
      
      // Create clickable hit area (wider, invisible)
      const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hitArea.setAttribute('d', pathData);
      hitArea.setAttribute('stroke', 'transparent');
      hitArea.setAttribute('stroke-width', '16');
      hitArea.setAttribute('fill', 'none');
      hitArea.setAttribute('class', 'connection-line');
      hitArea.setAttribute('data-path-id', path.id);
      hitArea.style.pointerEvents = 'stroke';
      hitArea.style.cursor = 'pointer';
      
      // Context menu on right-click
      hitArea.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showConnectionContextMenu(e, path);
      });
      
      svg.appendChild(hitArea);
      
      // Visual line
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', pathData);
      pathEl.setAttribute('stroke', '#0b4b34');
      pathEl.setAttribute('stroke-width', '2');
      pathEl.setAttribute('fill', 'none');
      pathEl.setAttribute('stroke-linecap', 'round');
      pathEl.setAttribute('stroke-opacity', '0.5');
      pathEl.setAttribute('class', 'connection-visual');
      pathEl.style.pointerEvents = 'none';
      
      svg.appendChild(pathEl);
      
      // End dot (Gryffi branded)
      const endDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      endDot.setAttribute('cx', endPos.x);
      endDot.setAttribute('cy', endPos.y);
      endDot.setAttribute('r', '4');
      endDot.setAttribute('fill', '#78c503');
      endDot.style.pointerEvents = 'none';
      
      svg.appendChild(endDot);
    });
  }
  
  // Get step rectangle info
  getStepRect(element) {
    return {
      x: element.offsetLeft,
      y: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
      centerX: element.offsetLeft + element.offsetWidth / 2,
      centerY: element.offsetTop + element.offsetHeight / 2
    };
  }
  
  // Smart port selection - choose best ports based on relative positions
  getBestPorts(fromRect, toRect) {
    const dx = toRect.centerX - fromRect.centerX;
    const dy = toRect.centerY - fromRect.centerY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    
    // Determine primary direction
    if (absDx > absDy * 1.2) {
      // Horizontal dominant
      if (dx > 0) {
        return { from: 'right', to: 'left' };
      } else {
        return { from: 'left', to: 'right' };
      }
    } else if (absDy > absDx * 1.2) {
      // Vertical dominant
      if (dy > 0) {
        return { from: 'bottom', to: 'top' };
      } else {
        return { from: 'top', to: 'bottom' };
      }
    } else {
      // Diagonal - choose based on primary direction
      if (dx > 0) {
        return dy > 0 
          ? { from: 'right', to: 'top' }    // Down-right
          : { from: 'right', to: 'bottom' }; // Up-right
      } else {
        return dy > 0 
          ? { from: 'left', to: 'top' }     // Down-left
          : { from: 'left', to: 'bottom' };  // Up-left
      }
    }
  }
  
  // Get actual port coordinates on the element
  getPortPosition(rect, port) {
    switch (port) {
      case 'top':
        return { x: rect.x + rect.width / 2, y: rect.y };
      case 'bottom':
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
      case 'left':
        return { x: rect.x, y: rect.y + rect.height / 2 };
      case 'right':
        return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
      default:
        return { x: rect.centerX, y: rect.centerY };
    }
  }
  
  // Calculate smart path with smooth curves
  calculateSmartPath(start, end, ports) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    
    // Calculate control point offsets based on distance
    const distance = Math.sqrt(dx * dx + dy * dy);
    const offset = Math.min(distance * 0.4, 80);
    
    // Determine control point directions based on ports
    let c1 = { x: start.x, y: start.y };
    let c2 = { x: end.x, y: end.y };
    
    switch (ports.from) {
      case 'right':  c1 = { x: start.x + offset, y: start.y }; break;
      case 'left':   c1 = { x: start.x - offset, y: start.y }; break;
      case 'top':    c1 = { x: start.x, y: start.y - offset }; break;
      case 'bottom': c1 = { x: start.x, y: start.y + offset }; break;
    }
    
    switch (ports.to) {
      case 'right':  c2 = { x: end.x + offset, y: end.y }; break;
      case 'left':   c2 = { x: end.x - offset, y: end.y }; break;
      case 'top':    c2 = { x: end.x, y: end.y - offset }; break;
      case 'bottom': c2 = { x: end.x, y: end.y + offset }; break;
    }
    
    return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
  }
  
  // Show context menu for connection line
  showConnectionContextMenu(e, path) {
    this.closeContextMenu();
    
    const fromStep = this.steps.find(s => s.id === path.from_step_id);
    const toStep = this.steps.find(s => s.id === path.to_step_id);
    
    const menu = document.createElement('div');
    menu.className = 'connection-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    
    menu.innerHTML = `
      <div class="px-3 py-2 text-xs text-zen-500 border-b border-zen-100">
        ${escapeHtml(fromStep?.title || 'Step')} → ${escapeHtml(toStep?.title || 'Step')}
      </div>
      <button class="delete-connection-btn">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
        </svg>
        ${window.t('builder.connections.deleteConnectionLabel')}
      </button>
    `;
    
    document.body.appendChild(menu);
    this.contextMenu = menu;
    
    // Position adjustment if off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${e.clientX - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${e.clientY - rect.height}px`;
    }
    
    // Delete button
    menu.querySelector('.delete-connection-btn').addEventListener('click', async () => {
      await this.deletePath(path.id);
      this.closeContextMenu();
      // Update the step that had this path
      if (fromStep) {
        this.renderStep(fromStep);
      }
    });
  }
  
  closeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }
  
  // ============================================
  // PROPERTIES PANEL
  // ============================================
  
  selectStep(stepId) {
    this.deselectAll();
    this.selectedStep = stepId;
    
    const element = document.querySelector(`[data-step-id="${stepId}"]`);
    element?.classList.add('selected');
    
    this.showProperties(stepId);
  }
  
  deselectAll() {
    document.querySelectorAll('.step-node.selected').forEach(el => el.classList.remove('selected'));
    this.selectedStep = null;
    this.closeProperties();
  }
  
  showProperties(stepId) {
    const step = this.steps.find(s => s.id === stepId);
    if (!step) return;
    
    this.panelMode = 'step';
    
    const basicProps = typeof step.basic_props === 'string' 
      ? JSON.parse(step.basic_props) 
      : (step.basic_props || {});
    const advancedProps = typeof step.advanced_props === 'string' 
      ? JSON.parse(step.advanced_props) 
      : (step.advanced_props || {});
    
    // Render the full panel content for step
    const content = document.getElementById('propertiesContent');
    content.innerHTML = this.renderStepPanelContent(step, basicProps, advancedProps);
    
    if (!this.readOnly) {
      // Bind form events
      this.bindPropertyEvents(step);
    } else {
      this.applyReadOnlyToPanel();
    }
    
    this.propertiesPanel.classList.remove('hidden');
  }
  
  showJourneySettings() {
    // Deselect any selected step
    document.querySelectorAll('.step-node.selected').forEach(el => el.classList.remove('selected'));
    this.selectedStep = null;
    this.panelMode = 'journey';
    
    const content = document.getElementById('propertiesContent');
    content.innerHTML = this.renderJourneyPanelContent();
    
    if (!this.readOnly) {
      // Bind journey settings events
      this.bindJourneySettingsEvents();
    } else {
      this.applyReadOnlyToPanel();
    }
    
    this.propertiesPanel.classList.remove('hidden');
  }

  applyReadOnlyToToolbar() {
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.add('opacity-50', 'cursor-not-allowed');
      saveBtn.title = window.t('builder.messages.readOnly');
    }

    document.querySelectorAll('.step-type-btn').forEach(btn => {
      btn.disabled = true;
      btn.classList.add('opacity-60', 'cursor-not-allowed');
      btn.title = window.t('builder.messages.readOnly');
    });

    const addResourceBtn = document.getElementById('addResourceBtn');
    if (addResourceBtn) {
      addResourceBtn.disabled = true;
      addResourceBtn.classList.add('opacity-50', 'cursor-not-allowed');
      addResourceBtn.title = window.t('builder.messages.readOnly');
    }

    ['undoBtn', 'redoBtn'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      btn.title = window.t('builder.messages.readOnly');
    });
  }

  applyReadOnlyToPanel() {
    const content = document.getElementById('propertiesContent');
    if (!content) return;

    if (!content.querySelector('[data-readonly-banner="true"]')) {
      const banner = document.createElement('div');
      banner.setAttribute('data-readonly-banner', 'true');
      banner.className = 'px-4 py-2 text-xs text-zen-700 bg-zen-50 border-b border-zen-200';
      banner.textContent = window.t('builder.messages.readOnly');
      content.prepend(banner);
    }

    content.querySelectorAll('input, textarea, select').forEach(el => {
      el.disabled = true;
    });

    content.querySelectorAll('[contenteditable="true"]').forEach(el => {
      el.setAttribute('contenteditable', 'false');
      el.classList.add('opacity-70');
    });

    content.querySelectorAll('button').forEach(btn => {
      if (btn.id === 'closePanel') return;
      if (btn.classList.contains('panel-tab')) return;
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      btn.title = window.t('builder.messages.readOnly');
    });
  }
  
  renderStepPanelContent(step, basicProps, advancedProps) {
    return `
      <!-- Accent line - Node color -->
      <div class="h-1 bg-gryffi-accent"></div>
      
      <!-- Header -->
      <div class="p-4 flex items-center justify-between border-b border-zen-100">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-gryffi-accent/20 flex items-center justify-center">
            ${this.getStepIcon(step.type)}
          </div>
          <div>
            <div class="font-medium text-zen-900">${escapeHtml(step.title)}</div>
            <div class="text-xs text-zen-500">${this.getStepTypeLabel(step.type)}</div>
          </div>
        </div>
        <button id="closePanel" class="p-1 hover:bg-zen-100 rounded text-zen-400 hover:text-zen-600">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
      
      <!-- Preview from this step -->
      <div class="px-4 py-3 border-b border-zen-100">
        <button id="previewFromHereBtn" class="w-full py-2 text-sm font-medium text-gryffi-primary bg-gryffi-primary/10 hover:bg-gryffi-primary/15 rounded-lg transition-colors flex items-center justify-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          ${window.t('builder.panel.previewFromHere')}
        </button>
      </div>
      
      <!-- Tabs: Properties | Advanced -->
      <div class="flex border-b border-zen-100">
        <button class="panel-tab active" data-tab="properties">${window.t('builder.tabs.basic')}</button>
        <button class="panel-tab" data-tab="advanced">${window.t('builder.tabs.advanced')}</button>
      </div>
      
      <!-- Tab content -->
      <div id="tabContent" class="p-4">
        <div id="propertiesTab" class="tab-pane space-y-4">
          ${this.renderBasicPropsForm(step, basicProps)}
        </div>
        <div id="advancedTab" class="tab-pane hidden space-y-4">
          ${this.renderAdvancedPropsForm(step, advancedProps, basicProps)}
        </div>
      </div>
      
      <!-- Delete Step -->
      <div class="p-4 border-t border-zen-100">
        <button id="deleteStepBtn" class="w-full py-2 text-sm text-red-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
          </svg>
          ${window.t('builder.panel.deleteStep')}
        </button>
      </div>
    `;
  }
  
  renderJourneyPanelContent() {
    const journeyAutomations = this.journey.automations || [];
    const hasAutomations = journeyAutomations.length > 0;
    
    return `
      <!-- Accent line - Journey color (primary) -->
      <div class="h-1 bg-gryffi-primary"></div>
      
      <!-- Header -->
      <div class="p-4 flex items-center justify-between border-b border-zen-100">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-gryffi-primary/10 flex items-center justify-center">
            <svg class="w-4 h-4 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
            </svg>
          </div>
          <div>
            <div class="font-medium text-zen-900">${escapeHtml(this.journey.title)}</div>
            <div class="text-xs text-zen-500">${window.t('builder.toolbar.journeySettings')}</div>
          </div>
        </div>
        <button id="closePanel" class="p-1 hover:bg-zen-100 rounded text-zen-400 hover:text-zen-600">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
      
      <!-- Tabs -->
      <div class="flex border-b border-zen-100">
        <button class="panel-tab active" data-tab="general">${window.t('builder.settings.general')}</button>
        <button class="panel-tab" data-tab="automations">
          ${window.t('builder.settings.automations')}
          ${hasAutomations ? `<span class="ml-1 w-4 h-4 bg-gryffi-primary/20 text-gryffi-primary text-xs rounded-full inline-flex items-center justify-center">${journeyAutomations.length}</span>` : ''}
        </button>
      </div>
      
      <!-- Tab content -->
      <div id="tabContent" class="p-4">
        <div id="generalTab" class="tab-pane space-y-4">
          ${this.renderJourneyGeneralForm()}
        </div>
        <div id="automationsTab" class="tab-pane hidden">
          ${this.renderJourneyAutomationsForm(journeyAutomations)}
        </div>
      </div>
    `;
  }
  
  renderJourneyGeneralForm() {
    const _startStep = this.steps.find(s => s.is_start);
    const endSteps = this.steps.filter(s => s.is_end);
    
    return `
      <div>
        <label class="form-label">${window.t('builder.settings.journeyTitle')}</label>
        <input type="text" class="form-input" id="journeyTitle" value="${escapeHtml(this.journey.title)}" />
      </div>
      <div>
        <label class="form-label">${window.t('builder.settings.description')}</label>
        <textarea class="form-textarea" id="journeyDescription" rows="3" placeholder="${window.t('builder.settings.descriptionPlaceholder')}">${escapeHtml(this.journey.description)}</textarea>
      </div>
      
      <!-- Journey Flow Section -->
      <div class="flow-section mt-4 pt-4 border-t border-zen-100" id="flowSection">
        <div class="flex items-center gap-2 mb-3">
          <svg class="w-4 h-4 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"></path>
          </svg>
          <span class="text-sm font-medium text-zen-700">${window.t('builder.settings.journeyFlow')}</span>
        </div>
        
        <div class="space-y-3">
          <div>
            <label class="form-label">${window.t('builder.settings.startStep')}</label>
            <select class="form-input" id="journeyStartStep">
              <option value="">${window.t('builder.settings.selectStartStep')}</option>
              ${this.sortStepsByTitle(this.steps).map(s => `
                <option value="${s.id}" ${s.is_start ? 'selected' : ''}>${escapeHtml(s.title)}</option>
              `).join('')}
            </select>
            <p class="text-xs text-zen-400 mt-1">${window.t('builder.settings.whereBegins')}</p>
          </div>
          
          <div>
            <label class="form-label">${endSteps.length > 1 ? window.t('builder.settings.endSteps') : window.t('builder.settings.endStep')}</label>
            <div id="endStepsContainer" class="space-y-2">
              ${this.renderEndStepsDropdowns(endSteps)}
            </div>
            <p class="text-xs text-zen-400 mt-1">${window.t('builder.settings.whereEnds')}</p>
          </div>
        </div>
      </div>
      
      <!-- Language Settings Section -->
      <div class="flow-section mt-4 pt-4 border-t border-zen-100" id="languageSection">
        <div class="flex items-center gap-2 mb-3">
          <svg class="w-4 h-4 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"></path>
          </svg>
          <span class="text-sm font-medium text-zen-700">${window.t('builder.settings.languageSettings')}</span>
        </div>
        
        <div class="space-y-4">
          <div class="p-3 bg-zen-50 rounded-lg">
            <p class="text-sm text-zen-600">
              <span class="font-medium">${window.t('builder.settings.organizationLanguage')}:</span> 
              <span class="text-gryffi-primary font-medium">${escapeHtml(this.getLanguageLabel(window.GRYFFI?.organization?.defaultLanguage || 'en'))}</span>
            </p>
          </div>
          
          <!-- Journey Player Language Override -->
          <div class="space-y-3">
            <label class="flex items-center gap-3 cursor-pointer">
              <div class="toggle-switch">
                <input type="checkbox" id="languageOverrideToggle" ${this.journey.language_override ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </div>
              <div>
                <span class="text-sm font-medium text-zen-700">${window.t('builder.settings.overrideLanguage')}</span>
                <p class="text-xs text-zen-400">${window.t('builder.settings.overrideLanguageHint')}</p>
              </div>
            </label>
            
            <div id="languageOverrideOptions" class="${this.journey.language_override ? '' : 'hidden'}">
              <label class="form-label">${window.t('builder.settings.selectLanguage')}</label>
              <select class="form-input" id="journeyLanguageCode">
                <optgroup label="${window.t('builder.settings.baseLanguages') || 'Base languages'}">
                  <option value="en" ${this.journey.language_code === 'en' ? 'selected' : ''}>English</option>
                  <option value="nl" ${this.journey.language_code === 'nl' ? 'selected' : ''}>Nederlands</option>
                  <option value="de" ${this.journey.language_code === 'de' ? 'selected' : ''}>Deutsch</option>
                  <option value="fr" ${this.journey.language_code === 'fr' ? 'selected' : ''}>Français</option>
                  <option value="es" ${this.journey.language_code === 'es' ? 'selected' : ''}>Español</option>
                </optgroup>
                <optgroup label="${window.t('builder.settings.extendedLanguages') || 'Extended languages'}">
                  <option value="it" ${this.journey.language_code === 'it' ? 'selected' : ''}>Italiano</option>
                  <option value="pt" ${this.journey.language_code === 'pt' ? 'selected' : ''}>Português</option>
                  <option value="da" ${this.journey.language_code === 'da' ? 'selected' : ''}>Dansk</option>
                  <option value="no" ${this.journey.language_code === 'no' ? 'selected' : ''}>Norsk</option>
                  <option value="fi" ${this.journey.language_code === 'fi' ? 'selected' : ''}>Suomi</option>
                  <option value="sv" ${this.journey.language_code === 'sv' ? 'selected' : ''}>Svenska</option>
                  <option value="pl" ${this.journey.language_code === 'pl' ? 'selected' : ''}>Polski</option>
                  <option value="ro" ${this.journey.language_code === 'ro' ? 'selected' : ''}>Română</option>
                  <option value="tr" ${this.journey.language_code === 'tr' ? 'selected' : ''}>Türkçe</option>
                </optgroup>
              </select>
            </div>
          </div>
          
          <!-- AI Guide Language Override -->
          <div class="space-y-3 pt-3 border-t border-zen-100">
            <label class="flex items-center gap-3 cursor-pointer">
              <div class="toggle-switch">
                <input type="checkbox" id="guideLanguageOverrideToggle" ${this.journey.guide_language_override ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </div>
              <div>
                <span class="text-sm font-medium text-zen-700">${window.t('builder.settings.overrideGuideLanguage') || 'Override AI Guide language'}</span>
                <p class="text-xs text-zen-400">${window.t('builder.settings.overrideGuideLanguageHint') || 'Set a different language for AI Guide responses'}</p>
              </div>
            </label>
            
            <div id="guideLanguageOverrideOptions" class="${this.journey.guide_language_override ? '' : 'hidden'} space-y-4">
              <div>
                <label class="form-label">${window.t('builder.settings.selectGuideLanguage') || 'AI Guide language'}</label>
                <select class="form-input" id="journeyGuideLanguageCode">
                  <optgroup label="${window.t('builder.settings.baseLanguages') || 'Base languages'}">
                    <option value="en" ${this.journey.guide_language_code === 'en' ? 'selected' : ''}>English</option>
                    <option value="nl" ${this.journey.guide_language_code === 'nl' ? 'selected' : ''}>Nederlands</option>
                    <option value="de" ${this.journey.guide_language_code === 'de' ? 'selected' : ''}>Deutsch</option>
                    <option value="fr" ${this.journey.guide_language_code === 'fr' ? 'selected' : ''}>Français</option>
                    <option value="es" ${this.journey.guide_language_code === 'es' ? 'selected' : ''}>Español</option>
                  </optgroup>
                  <optgroup label="${window.t('builder.settings.extendedLanguages') || 'Extended languages'}">
                    <option value="it" ${this.journey.guide_language_code === 'it' ? 'selected' : ''}>Italiano</option>
                    <option value="pt" ${this.journey.guide_language_code === 'pt' ? 'selected' : ''}>Português</option>
                    <option value="da" ${this.journey.guide_language_code === 'da' ? 'selected' : ''}>Dansk</option>
                    <option value="no" ${this.journey.guide_language_code === 'no' ? 'selected' : ''}>Norsk</option>
                    <option value="fi" ${this.journey.guide_language_code === 'fi' ? 'selected' : ''}>Suomi</option>
                    <option value="sv" ${this.journey.guide_language_code === 'sv' ? 'selected' : ''}>Svenska</option>
                    <option value="pl" ${this.journey.guide_language_code === 'pl' ? 'selected' : ''}>Polski</option>
                    <option value="ro" ${this.journey.guide_language_code === 'ro' ? 'selected' : ''}>Română</option>
                    <option value="tr" ${this.journey.guide_language_code === 'tr' ? 'selected' : ''}>Türkçe</option>
                  </optgroup>
                </select>
              </div>
              
              <div>
                <label class="form-label">${window.t('builder.settings.guideOpeningOverride') || 'Opening sentence override'}</label>
                <p class="text-xs text-zen-400 mb-2">${window.t('builder.settings.guideOpeningOverrideHint') || 'Optional: Set a translated opening sentence to use instead of generating one dynamically. This is faster and more reliable.'}</p>
                <textarea 
                  class="form-textarea" 
                  id="journeyGuideOpeningOverride" 
                  rows="3" 
                  placeholder="${window.t('builder.settings.guideOpeningOverridePlaceholder') || 'e.g., Ciao! Sono qui per aiutarti...'}"
                >${this.escapeHtml(this.journey.guide_opening_override || '')}</textarea>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <div class="pt-2 text-xs text-zen-400">
        <p>${window.t('builder.settings.created')}: ${this.formatDate(this.journey.created_at)}</p>
        <p>${window.t('builder.settings.lastUpdated')}: ${this.formatDate(this.journey.updated_at)}</p>
      </div>
    `;
  }
  
  /**
   * Sort steps alphabetically by title for use in dropdowns. Sorting helps
   * makers locate the right step quickly in journeys with many steps.
   *
   * Uses the maker's UI locale so accented characters and language-specific
   * collation rules behave correctly. The numeric option keeps "Step 2"
   * before "Step 10" instead of falling into pure lexical order.
   */
  sortStepsByTitle(steps) {
    const locale = window.GRYFFI?.locale || undefined;
    return [...steps].sort((a, b) => {
      const titleA = String(a?.title || '');
      const titleB = String(b?.title || '');
      return titleA.localeCompare(titleB, locale, { sensitivity: 'base', numeric: true });
    });
  }

  renderEndStepsDropdowns(selectedEndSteps) {
    if (this.steps.length === 0) {
      return `<p class="text-sm text-zen-400 italic">${window.t('builder.settings.addStepsFirst')}</p>`;
    }
    
    const selectedIds = selectedEndSteps.map(s => s.id);
    let html = '';
    
    // Render a dropdown for each selected end step
    selectedEndSteps.forEach((endStep, index) => {
      const availableSteps = this.sortStepsByTitle(
        this.steps.filter(s => s.id === endStep.id || !selectedIds.includes(s.id))
      );
      
      html += `
        <div class="end-step-row flex items-center gap-2">
          <select class="form-input flex-1 end-step-select" data-index="${index}" data-current-id="${endStep.id}">
            ${availableSteps.map(s => `
              <option value="${s.id}" ${s.id === endStep.id ? 'selected' : ''}>${escapeHtml(s.title)}</option>
            `).join('')}
          </select>
          <button type="button" class="remove-end-step p-2 text-zen-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" data-step-id="${endStep.id}" title="${window.t('common.remove')}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
      `;
    });
    
    // Show "Add end step" button if there are more steps available
    const remainingSteps = this.sortStepsByTitle(
      this.steps.filter(s => !selectedIds.includes(s.id))
    );
    if (remainingSteps.length > 0) {
      if (selectedEndSteps.length === 0) {
        // No end steps yet - show dropdown with placeholder
        html += `
          <select class="form-input add-end-step-select" id="addFirstEndStep">
            <option value="">${window.t('builder.settings.selectEndStep')}</option>
            ${remainingSteps.map(s => `
              <option value="${s.id}">${escapeHtml(s.title)}</option>
            `).join('')}
          </select>
        `;
      } else {
        // Has end steps - show compact add button
        html += `
          <button type="button" id="addEndStepBtn" class="flex items-center gap-1 text-sm text-gryffi-primary hover:text-gryffi-primary/80 transition-colors mt-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
            </svg>
            ${window.t('builder.settings.addEndStep')}
          </button>
        `;
      }
    }
    
    return html;
  }
  
  bindEndStepsEvents() {
    const container = document.getElementById('endStepsContainer');
    if (!container) return;
    
    // Handle changing an existing end step
    container.querySelectorAll('.end-step-select').forEach(select => {
      select.addEventListener('change', async (e) => {
        const oldStepId = e.target.dataset.currentId;
        const newStepId = e.target.value;
        
        if (oldStepId !== newStepId) {
          // Unmark old step as end
          const oldStep = this.steps.find(s => s.id === oldStepId);
          if (oldStep) {
            oldStep.is_end = false;
            await this.updateStep(oldStepId, { is_end: false });
            this.renderStep(oldStep);
          }
          
          // Mark new step as end
          const newStep = this.steps.find(s => s.id === newStepId);
          if (newStep) {
            newStep.is_end = true;
            await this.updateStep(newStepId, { is_end: true });
            this.renderStep(newStep);
          }
          
          // Re-render the end steps section
          this.refreshEndStepsUI();
        }
      });
    });
    
    // Handle removing an end step
    container.querySelectorAll('.remove-end-step').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const stepId = e.currentTarget.dataset.stepId;
        const step = this.steps.find(s => s.id === stepId);
        
        if (step) {
          step.is_end = false;
          await this.updateStep(stepId, { is_end: false });
          this.renderStep(step);
          this.refreshEndStepsUI();
        }
      });
    });
    
    // Handle adding first end step (from placeholder dropdown)
    const addFirstSelect = document.getElementById('addFirstEndStep');
    if (addFirstSelect) {
      addFirstSelect.addEventListener('change', async (e) => {
        const stepId = e.target.value;
        if (stepId) {
          const step = this.steps.find(s => s.id === stepId);
          if (step) {
            step.is_end = true;
            await this.updateStep(stepId, { is_end: true });
            this.renderStep(step);
            this.refreshEndStepsUI();
          }
        }
      });
    }
    
    // Handle "Add another end step" button
    const addBtn = document.getElementById('addEndStepBtn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        this.showAddEndStepDropdown();
      });
    }
  }
  
  refreshEndStepsUI() {
    const container = document.getElementById('endStepsContainer');
    if (!container) return;
    
    const endSteps = this.steps.filter(s => s.is_end);
    container.innerHTML = this.renderEndStepsDropdowns(endSteps);
    this.bindEndStepsEvents();
    
    // Update the label
    const label = container.parentElement?.querySelector('.form-label');
    if (label) {
      label.textContent = endSteps.length > 1 ? window.t('builder.settings.endSteps') : window.t('builder.settings.endStep');
    }
  }
  
  showAddEndStepDropdown() {
    const container = document.getElementById('endStepsContainer');
    const addBtn = document.getElementById('addEndStepBtn');
    if (!container || !addBtn) return;
    
    const selectedIds = this.steps.filter(s => s.is_end).map(s => s.id);
    const availableSteps = this.steps.filter(s => !selectedIds.includes(s.id));
    
    if (availableSteps.length === 0) return;
    
    // Hide the add button and show a dropdown
    addBtn.style.display = 'none';
    
    const dropdownHtml = `
      <div class="end-step-row flex items-center gap-2" id="newEndStepRow">
        <select class="form-input flex-1" id="newEndStepSelect">
          <option value="">— Select step —</option>
          ${availableSteps.map(s => `
            <option value="${s.id}">${escapeHtml(s.title)}</option>
          `).join('')}
        </select>
        <button type="button" id="cancelNewEndStep" class="p-2 text-zen-400 hover:text-zen-600 hover:bg-zen-100 rounded-lg transition-colors" title="${window.t('common.cancel')}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    `;
    
    addBtn.insertAdjacentHTML('beforebegin', dropdownHtml);
    
    const newSelect = document.getElementById('newEndStepSelect');
    const cancelBtn = document.getElementById('cancelNewEndStep');
    const newRow = document.getElementById('newEndStepRow');
    
    newSelect?.focus();
    
    newSelect?.addEventListener('change', async (e) => {
      const stepId = e.target.value;
      if (stepId) {
        const step = this.steps.find(s => s.id === stepId);
        if (step) {
          step.is_end = true;
          await this.updateStep(stepId, { is_end: true });
          this.renderStep(step);
          this.refreshEndStepsUI();
        }
      }
    });
    
    cancelBtn?.addEventListener('click', () => {
      newRow?.remove();
      addBtn.style.display = '';
    });
  }
  
  renderJourneyAutomationsForm(automations) {
    return `
      <div class="space-y-4">
        <p class="text-sm text-zen-500">
          ${window.t('builder.automations.setUpAutomaticEmails')}
        </p>
        
        <div id="journeyAutomationsList" class="space-y-3">
          ${automations.length === 0 ? `
            <div class="text-center py-6 text-zen-400">
              <svg class="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
              </svg>
              <p class="text-sm">${window.t('builder.automations.noAutomationsYet')}</p>
            </div>
          ` : automations.map((a, i) => this.renderAutomationItem(a, i, 'journey')).join('')}
        </div>
        
        <button id="addJourneyAutomation" class="w-full py-2 border-2 border-dashed border-zen-200 rounded-lg text-zen-500 hover:border-gryffi-primary hover:text-gryffi-primary transition-colors text-sm">
          ${window.t('builder.automations.addAutomationButton')}
        </button>
      </div>
    `;
  }
  
  renderAutomationItem(automation, index, context) {
    const triggerLabels = {
      on_journey_start: window.t('builder.automations.triggers.whenJourneyStarts'),
      on_journey_complete: window.t('builder.automations.triggers.whenJourneyCompletes'),
      on_inactivity: window.t('builder.automations.triggers.afterInactivity'),
      on_step_enter: window.t('builder.automations.triggers.whenUserEntersStep'),
      on_step_complete: window.t('builder.automations.triggers.whenUserCompletesStep'),
      on_path_chosen: window.t('builder.automations.triggers.whenUserChoosesPath'),
      on_step_start: window.t('builder.automations.triggers.whenStepStarts'),
      on_step_complete: window.t('builder.automations.triggers.whenStepCompletes'),
      on_space_enter: window.t('builder.automations.triggers.whenUserEntersSpace'),
      on_space_exit: window.t('builder.automations.triggers.whenUserExitsSpace'),
      on_challenge_pass: window.t('builder.automations.triggers.whenChallengePassed'),
      on_challenge_fail: window.t('builder.automations.triggers.whenChallengeFailed'),
      on_form_submit: window.t('builder.automations.triggers.whenFormSubmitted')
    };
    
    const EMAIL_TEMPLATES = getEmailTemplates();
    const templateLabel = EMAIL_TEMPLATES[automation.template]?.name || automation.template;
    
    return `
      <div class="automation-item bg-zen-50 rounded-lg p-3" data-index="${index}" data-context="${escapeHtml(context)}">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 text-sm font-medium text-zen-800">
              <svg class="w-4 h-4 text-gryffi-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
              </svg>
              <span class="truncate">${escapeHtml(triggerLabels[automation.trigger] || automation.trigger)}</span>
            </div>
            <div class="text-xs text-zen-500 mt-1 ml-6">
              ${templateLabel} → ${automation.recipient === 'current_user' ? window.t('builder.automations.currentUser') : escapeHtml(automation.recipient)}
            </div>
          </div>
          <div class="flex items-center gap-1">
            <button class="test-automation p-1 hover:bg-white rounded text-zen-400 hover:text-gryffi-accent" data-index="${index}" title="${window.t('builder.automations.sendTestEmail')}">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path>
              </svg>
            </button>
            <button class="edit-automation p-1 hover:bg-white rounded text-zen-400 hover:text-zen-600" data-index="${index}" title="${window.t('builder.automations.edit')}">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
              </svg>
            </button>
            <button class="delete-automation p-1 hover:bg-white rounded text-zen-400 hover:text-red-500" data-index="${index}" title="${window.t('builder.automations.delete')}">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }
  
  renderBasicPropsForm(step, props) {
    let html = `
      <div>
        <label class="form-label">${window.t('builder.props.title')}</label>
        <input type="text" class="form-input" id="propTitle" value="${escapeHtml(step.title)}" />
      </div>
    `;
    
    switch (step.type) {
      case 'space':
        const isPanorama = props.is_panorama === true;
        html += `
          <div>
            <label class="form-label">${window.t('builder.props.description')}</label>
            <textarea class="form-textarea" id="propDescription" placeholder="${window.t('builder.props.descriptionPlaceholder')}">${escapeHtml(props.description)}</textarea>
          </div>
          
          <!-- Image Type Toggle -->
          <div class="mt-4">
            <label class="form-label">${window.t('builder.props.imageType')}</label>
            <div class="space-y-2" id="imageTypeToggle">
              <label class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${!isPanorama ? 'border-gryffi-primary bg-gryffi-primary/5' : 'border-zen-200 hover:border-zen-300'}" id="normalImageLabel">
                <input type="radio" name="imageType" value="normal" class="form-radio" ${!isPanorama ? 'checked' : ''} id="propNormalImage">
                <div class="flex-1">
                  <span class="text-sm font-medium text-zen-700">${window.t('builder.props.normalImage')}</span>
                  <p class="text-xs text-zen-500">${window.t('builder.props.normalImageDesc')}</p>
                </div>
                <svg class="w-5 h-5 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                </svg>
              </label>
              <label class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${isPanorama ? 'border-gryffi-primary bg-gryffi-primary/5' : 'border-zen-200 hover:border-zen-300'}" id="panoramaImageLabel">
                <input type="radio" name="imageType" value="panorama" class="form-radio" ${isPanorama ? 'checked' : ''} id="propPanoramaImage">
                <div class="flex-1">
                  <span class="text-sm font-medium text-zen-700">${window.t('builder.props.panoramaImage')}</span>
                  <p class="text-xs text-zen-500">${window.t('builder.props.panoramaImageDesc')}</p>
                </div>
                <svg class="w-5 h-5 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
              </label>
            </div>
            <input type="hidden" id="propIsPanorama" value="${isPanorama}" />
          </div>
          
          <!-- Normal Image Section -->
          <div id="normalImageSection" class="${isPanorama ? 'hidden' : ''} mt-4">
            <label class="form-label">${window.t('builder.props.image')}</label>
            <div class="image-preview-container">
              ${props.image_url && !isPanorama
                ? `<img src="${escapeHtml(props.image_url)}" alt="${window.t('builder.props.spaceImage')}" id="spaceImagePreview" />
                   <div class="image-preview-actions">
                     <button type="button" class="image-preview-btn" id="changeSpaceImage">${window.t('common.change')}</button>
                     <button type="button" class="image-preview-btn delete" id="removeSpaceImage">×</button>
                   </div>`
                : `<div class="image-preview-placeholder" id="addSpaceImage">
                     <svg class="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                       <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                     </svg>
                     <span class="text-sm">${window.t('builder.props.addImage')}</span>
                   </div>`
              }
            </div>
            <input type="hidden" id="propImageUrl" value="${!isPanorama ? escapeHtml(props.image_url) : ''}" />
          </div>
          
          <!-- 360° Panorama Section -->
          <div id="panoramaImageSection" class="${!isPanorama ? 'hidden' : ''} mt-4">
            <label class="form-label">${window.t('builder.props.panoramaUpload')}</label>
            <div class="panorama-preview-container">
              ${props.image_url && isPanorama
                ? `<div class="panorama-preview-wrapper" id="panoramaPreviewWrapper">
                     <div class="panorama-mini-viewer" id="panoramaMiniViewer" data-url="${escapeHtml(props.image_url)}">
                       <div class="panorama-mini-hint">
                         <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"></path>
                         </svg>
                         <span>${window.t('builder.props.panoramaDragHint')}</span>
                       </div>
                     </div>
                     <div class="image-preview-actions">
                       <button type="button" class="image-preview-btn" id="changePanoramaImage">${window.t('common.change')}</button>
                       <button type="button" class="image-preview-btn delete" id="removePanoramaImage">×</button>
                     </div>
                   </div>`
                : `<div class="panorama-upload-placeholder" id="addPanoramaImage">
                     <svg class="w-10 h-10 mb-2 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                       <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                     </svg>
                     <span class="text-sm font-medium text-zen-600">${window.t('builder.props.panoramaUpload')}</span>
                     <span class="text-xs text-zen-400 mt-1">JPEG, PNG</span>
                   </div>`
              }
            </div>
            <input type="hidden" id="propPanoramaUrl" value="${isPanorama ? escapeHtml(props.image_url) : ''}" />
            <p class="text-xs text-zen-500 mt-2 leading-relaxed">${window.t('builder.props.panoramaHint')}</p>
          </div>
          
          <!-- Floorplan Section -->
          <div class="mt-6 pt-4 border-t border-zen-200">
            <div class="flex items-center justify-between mb-3">
              <label class="form-label mb-0">${window.t('builder.props.floorplan')}</label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" id="propFloorplanEnabled" class="form-checkbox" ${props.floorplan?.enabled ? 'checked' : ''}>
                <span class="text-sm text-zen-600">${window.t('builder.props.floorplanEnabled')}</span>
              </label>
            </div>
            
            <div id="floorplanSection" class="${props.floorplan?.enabled ? '' : 'hidden'}">
              <p class="text-xs text-zen-500 mb-3">${window.t('builder.props.floorplanEnabledDesc')}</p>
              
              <!-- Floorplan Selector -->
              <div class="floorplan-selector mb-3">
                <select class="form-input" id="propFloorplanId">
                  <option value="">${window.t('builder.props.selectFloorplan')}</option>
                </select>
                <button type="button" class="btn-secondary btn-sm mt-2" id="uploadNewFloorplanBtn">
                  <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                  </svg>
                  ${window.t('builder.props.uploadNewFloorplan')}
                </button>
              </div>
              
              <!-- Floorplan Preview & Marker Placement -->
              <div id="floorplanMarkerArea" class="hidden">
                <div class="floorplan-marker-container" id="floorplanMarkerContainer">
                  <img id="floorplanPreviewImg" src="" alt="Floorplan" />
                  <div id="floorplanMarker" class="floorplan-marker hidden">
                    <div class="floorplan-marker-dot"></div>
                    <div class="floorplan-marker-pulse"></div>
                  </div>
                </div>
                <p class="text-xs text-zen-500 mt-2 text-center" id="floorplanMarkerHint">
                  ${window.t('builder.props.clickToPlaceMarker')}
                </p>
              </div>
              
              <!-- Hidden inputs for floorplan data -->
              <input type="hidden" id="propFloorplanMarkerX" value="${escapeHtml(props.floorplan?.marker_x)}" />
              <input type="hidden" id="propFloorplanMarkerY" value="${escapeHtml(props.floorplan?.marker_y)}" />
            </div>
          </div>
        `;
        break;
        
      case 'guide':
        // Find selected guide from central library
        const selectedGuide = this.guides.find(g => g.id === props.guide_id);
        const personalityLabels = {
          friendly: window.t('guides.personalities.friendly'),
          professional: window.t('guides.personalities.professional'),
          helpful: window.t('guides.personalities.helpful'),
          cheerful: window.t('guides.personalities.cheerful'),
          wise: window.t('guides.personalities.wise')
        };
        
        html += `
          <div>
            <label class="form-label">${window.t('builder.props.selectGuide')}</label>
            <select class="form-input" id="propGuideId">
              <option value="">${window.t('builder.props.chooseGuide')}</option>
              ${this.guides.map(g => `
                <option value="${g.id}" ${props.guide_id === g.id ? 'selected' : ''}>
                  ${escapeHtml(g.name)}${g.role ? ` (${escapeHtml(g.role)})` : ''}
                </option>
              `).join('')}
            </select>
            ${this.guides.length === 0 ? `
              <p class="text-xs text-zen-500 mt-2">${window.t('builder.props.noGuidesAvailable')}</p>
            ` : `
              <p class="text-xs text-zen-400 mt-1">${window.t('builder.props.selectFromLibrary')}</p>
            `}
          </div>
          
          <!-- Guide Preview Card -->
          <div id="guidePreviewCard" class="mt-4 ${selectedGuide ? '' : 'hidden'}">
            <div class="border border-zen-200 rounded-lg overflow-hidden bg-gradient-to-br from-gryffi-primary/5 to-transparent">
              <div class="px-4 py-3 border-b border-zen-100 bg-white/50">
              <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-full bg-gradient-to-br from-gryffi-primary to-gryffi-accent flex items-center justify-center text-white font-bold overflow-hidden" id="guidePreviewAvatar">
                    ${selectedGuide?.avatar_url 
                      ? `<img src="${escapeHtml(selectedGuide.avatar_url)}" alt="${escapeHtml(selectedGuide.name)}" class="w-full h-full object-cover">`
                      : (selectedGuide ? selectedGuide.name.charAt(0).toUpperCase() : '?')
                    }
                </div>
                  <div class="flex-1 min-w-0">
                    <p class="font-medium text-zen-900 truncate" id="guidePreviewName">${escapeHtml(selectedGuide?.name || window.t('builder.props.guideName'))}</p>
                    <p class="text-xs text-zen-500 truncate" id="guidePreviewRole">${escapeHtml(selectedGuide?.role || window.t('builder.props.guideRole'))}</p>
                </div>
                  <span class="text-xs px-2 py-1 rounded-full bg-zen-100 text-zen-600" id="guidePreviewPersonality">
                    ${selectedGuide ? (personalityLabels[selectedGuide.personality] || window.t('guides.personalities.friendly')) : ''}
                  </span>
              </div>
              </div>
              <div class="px-4 py-3 text-sm">
                <div class="flex items-center justify-between text-zen-600">
                  <span id="guidePreviewKnowledge">
                    ${selectedGuide ? `📚 ${selectedGuide.knowledge_count || 0} ${window.t('guides.stats.knowledgeSources')}` : ''}
                  </span>
                  <span id="guidePreviewUsage" class="text-zen-400">
                    ${selectedGuide ? `${window.t('guides.stats.usedIn')} ${selectedGuide.journey_count || 0} ${window.t('guides.stats.journeys')}` : ''}
                  </span>
                </div>
                ${selectedGuide?.greeting ? `
                  <p class="mt-3 text-zen-500 italic text-xs border-l-2 border-gryffi-accent pl-3">
                    "${selectedGuide.greeting.substring(0, 100)}${selectedGuide.greeting.length > 100 ? '...' : ''}"
                  </p>
                ` : ''}
              </div>
            </div>
          </div>
          
          <!-- Manage Guides Link -->
          <div class="mt-4 pt-4 border-t border-zen-100">
            <button type="button" id="manageGuidesBtn" class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-zen-100 hover:bg-zen-200 text-zen-700 rounded-lg text-sm font-medium transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                </svg>
              ${window.t('builder.props.manageGuides')}
              </button>
            <p class="text-xs text-zen-400 mt-2 text-center">
              ${window.t('builder.props.manageGuidesDesc')}
            </p>
          </div>
        `;
        break;
        
      case 'content':
        // Normalize old 'markdown' to 'text'
        const mediaType = props.media_type === 'markdown' ? 'text' : (props.media_type || 'text');
        html += `
          <!-- Media Type Selector -->
          <div class="mb-4">
            <label class="form-label">${window.t('builder.props.whatToShare')}</label>
            <div class="flex gap-2 mt-2" id="mediaTypeSelector">
              <button type="button" class="media-type-btn ${mediaType === 'text' ? 'active' : ''}" data-type="text">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7"></path>
                  </svg>
                ${window.t('builder.props.text')}
                </button>
              <button type="button" class="media-type-btn ${mediaType === 'video' ? 'active' : ''}" data-type="video">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path>
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                  </svg>
                ${window.t('builder.props.video')}
              </button>
              <button type="button" class="media-type-btn ${mediaType === 'image' ? 'active' : ''}" data-type="image">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                </svg>
                ${window.t('builder.props.image')}
                </button>
            </div>
            <input type="hidden" id="propMediaType" value="${escapeHtml(mediaType)}" />
              </div>
              
          <!-- Text Content (Simple Editor) -->
          <div id="contentTextSection" class="${mediaType === 'text' ? '' : 'hidden'}">
            <label class="form-label">${window.t('builder.props.yourContent')}</label>
            <div class="simple-editor">
              <div class="simple-editor-toolbar">
                <button type="button" class="editor-btn" data-command="bold" title="${window.t('builder.props.bold')}">
                  <strong>B</strong>
                </button>
                <button type="button" class="editor-btn" data-command="italic" title="${window.t('builder.props.italic')}">
                  <em>I</em>
                </button>
                <span class="editor-divider"></span>
                <button type="button" class="editor-btn" data-command="insertUnorderedList" title="${window.t('builder.props.bulletList')}">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
                    </svg>
                </button>
                <span class="editor-divider"></span>
                <button type="button" class="editor-btn" data-command="fontSize" data-value="large" title="${window.t('builder.props.largeText')}">
                  <span style="font-size: 14px; font-weight: 600;">A</span>
                </button>
                <button type="button" class="editor-btn" data-command="fontSize" data-value="normal" title="${window.t('builder.props.normalText')}">
                  <span style="font-size: 11px;">A</span>
                </button>
                  </div>
              <div class="simple-editor-content" id="propBodyEditor" contenteditable="true" data-placeholder="${window.t('builder.props.writeContent')}">${sanitizeRichHtml(props.body)}</div>
                </div>
            <input type="hidden" id="propBody" value="${this.escapeHtml(props.body || '')}" />
              </div>
          
          <!-- Video Content -->
          <div id="contentVideoSection" class="${mediaType === 'video' ? '' : 'hidden'}">
            <div class="flex items-center gap-2 mb-2">
              <svg class="w-5 h-5 text-red-500" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
              <label class="form-label mb-0">${window.t('builder.props.youtubeVideo')}</label>
            </div>
            <input type="text" class="form-input" id="propVideoUrl" value="${escapeHtml(props.video_url)}" placeholder="https://www.youtube.com/watch?v=..." />
            <p class="text-xs text-zen-400 mt-1">${window.t('builder.props.pasteYoutubeLink')}</p>
            
            <!-- Video Preview -->
            <div id="videoPreviewContainer" class="mt-3 ${props.video_url ? '' : 'hidden'}">
              <div class="video-preview-wrapper">
                ${props.video_url ? this.renderVideoPreview(props.video_url) : ''}
              </div>
            </div>
            
            <!-- Optional Description for Video -->
            <div class="mt-4 pt-4 border-t border-zen-100">
              <label class="form-label">${window.t('builder.props.mediaDescription')}</label>
              <textarea class="form-textarea" id="propVideoDescription" rows="3" placeholder="${window.t('builder.props.mediaDescriptionPlaceholder')}">${escapeHtml(props.media_description)}</textarea>
              <p class="text-xs text-zen-400 mt-1">${window.t('builder.props.mediaDescriptionHint')}</p>
              
              <!-- Text Position -->
              <div class="mt-3">
                <label class="form-label text-xs">${window.t('builder.props.textPosition')}</label>
                <div class="flex gap-3 mt-1">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="videoTextPosition" value="above" class="text-gryffi-primary" ${(props.text_position || 'above') === 'above' ? 'checked' : ''} />
                    <span class="text-sm text-zen-600">${window.t('builder.props.aboveMedia')}</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="videoTextPosition" value="below" class="text-gryffi-primary" ${props.text_position === 'below' ? 'checked' : ''} />
                    <span class="text-sm text-zen-600">${window.t('builder.props.belowMedia')}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Image Content -->
          <div id="contentImageSection" class="${mediaType === 'image' ? '' : 'hidden'}">
            <label class="form-label">${window.t('builder.advanced.image')}</label>
            <div class="image-preview-container">
              ${props.image_url 
                ? `<img src="${escapeHtml(props.image_url)}" alt="${window.t('builder.props.contentImage')}" id="contentImagePreview" />
                   <div class="image-preview-actions">
                     <button type="button" class="image-preview-btn" id="changeContentImage">Change</button>
                     <button type="button" class="image-preview-btn delete" id="removeContentImage">×</button>
                   </div>`
                : `<div class="image-preview-placeholder" id="addContentImage">
                     <svg class="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                       <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                     </svg>
                     <span class="text-sm">${window.t('builder.props.chooseImage')}</span>
                   </div>`
              }
            </div>
            <input type="hidden" id="propContentImageUrl" value="${escapeHtml(props.image_url)}" />
            
            <!-- Optional Description for Image -->
            <div class="mt-4 pt-4 border-t border-zen-100">
              <label class="form-label">${window.t('builder.props.mediaDescription')}</label>
              <textarea class="form-textarea" id="propImageDescription" rows="3" placeholder="${window.t('builder.props.mediaDescriptionPlaceholder')}">${escapeHtml(props.media_description)}</textarea>
              <p class="text-xs text-zen-400 mt-1">${window.t('builder.props.mediaDescriptionHint')}</p>
              
              <!-- Text Position -->
              <div class="mt-3">
                <label class="form-label text-xs">${window.t('builder.props.textPosition')}</label>
                <div class="flex gap-3 mt-1">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="imageTextPosition" value="above" class="text-gryffi-primary" ${(props.text_position || 'above') === 'above' ? 'checked' : ''} />
                    <span class="text-sm text-zen-600">${window.t('builder.props.aboveMedia')}</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="imageTextPosition" value="below" class="text-gryffi-primary" ${props.text_position === 'below' ? 'checked' : ''} />
                    <span class="text-sm text-zen-600">${window.t('builder.props.belowMedia')}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        `;
        break;
        
      case 'challenge':
        // Convert old format to new format if needed
        let questions = props.questions || [];
        if (questions.length === 0 && props.question) {
          // Migrate old single-question format
          questions = [{
            id: crypto.randomUUID(),
            question: props.question,
            options: props.options || []
          }];
        }
        
        const questionCount = questions.length;
        const questionLabel = questionCount === 1 
          ? window.t('builder.quiz.questionCount', { count: questionCount })
          : window.t('builder.quiz.questionCountPlural', { count: questionCount });
        
        html += `
          <div class="quiz-builder">
            <!-- Header -->
            <div class="flex items-center justify-between mb-4">
              <div>
                <label class="form-label mb-0">${window.t('builder.quiz.questions')}</label>
                <span class="text-xs text-zen-400 ml-2">${questionLabel}</span>
              </div>
              ${questionCount > 1 ? `
                <button type="button" id="toggleAllQuestions" class="text-xs text-gryffi-primary hover:underline">
                  ${window.t('builder.quiz.collapseAll')}
                </button>
              ` : ''}
            </div>
            
            <!-- Questions List -->
            <div id="questionsContainer" class="space-y-3">
              ${questions.length === 0 ? `
                <div class="text-center py-8 text-zen-400 border-2 border-dashed border-zen-200 rounded-lg">
                  <svg class="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                  </svg>
                  <p class="text-sm">${window.t('builder.quiz.noQuestions')}</p>
                  <p class="text-xs mt-1">${window.t('builder.quiz.addFirstQuestion')}</p>
                </div>
              ` : questions.map((q, qIndex) => this.renderQuizQuestion(q, qIndex, questions.length)).join('')}
            </div>
            
            <!-- Add Question Button -->
            <button type="button" id="addQuestionBtn" class="mt-4 w-full py-3 border-2 border-dashed border-zen-200 rounded-lg text-gryffi-primary hover:border-gryffi-primary hover:bg-gryffi-primary/5 transition-colors text-sm font-medium">
              ${window.t('builder.quiz.addQuestion')}
            </button>
            
            <!-- Shuffle Questions Option -->
            ${questions.length > 1 ? `
            <div class="mt-5 pt-4 border-t border-zen-200">
              <label class="flex items-center gap-3 cursor-pointer">
                <div class="toggle-switch">
                  <input type="checkbox" id="shuffleQuestionsToggle" ${props.shuffle_questions ? 'checked' : ''}>
                  <span class="toggle-slider"></span>
                </div>
                <div>
                  <span class="text-sm font-medium text-zen-700">${window.t('builder.quiz.shuffleQuestions')}</span>
                  <p class="text-xs text-zen-400 mt-0.5">${window.t('builder.quiz.shuffleQuestionsHint')}</p>
                </div>
              </label>
            </div>
            ` : ''}
          </div>
        `;
        break;
        
      case 'form':
        const fields = props.fields || [];
        const fileFieldCount = fields.filter(f => f.type === 'file').length;
        html += `
          <div>
            <label class="form-label">${window.t('builder.props.description')}</label>
            <textarea class="form-textarea" id="propFormDescription" placeholder="${window.t('builder.form.descriptionPlaceholder')}">${escapeHtml(props.description)}</textarea>
          </div>
          
          <!-- Form Fields -->
          <div class="mt-4">
            <div class="flex items-center justify-between mb-3">
              <label class="form-label mb-0">${window.t('builder.form.formFields')}</label>
              <div class="flex items-center gap-3">
                <span id="fileUploadCounter" class="text-xs ${fileFieldCount >= 2 ? 'text-amber-500' : 'text-zen-400'}">${window.t('builder.form.fileUpload.uploadCount', { count: fileFieldCount })}</span>
                <span class="text-xs text-zen-400">${fields.length}/5 ${fields.length === 1 ? window.t('builder.form.fieldCount', { count: fields.length }) : window.t('builder.form.fieldCountPlural', { count: fields.length })}</span>
              </div>
            </div>
            <div id="formFieldsContainer" class="space-y-3">
              ${fields.map((field, i) => this.renderFormFieldEditor(field, i)).join('')}
            </div>
            ${fields.length < 5 ? `
              <button type="button" id="addFormFieldBtn" class="mt-3 w-full py-2 border-2 border-dashed border-zen-200 rounded-lg text-sm text-zen-500 hover:border-gryffi-accent hover:text-gryffi-primary transition-colors">
                + ${window.t('builder.form.addField')}
              </button>
            ` : ''}
          </div>
          
          <!-- Send To Section -->
          <div class="mt-5 pt-4 border-t border-zen-200">
            <div class="flex items-center gap-2 mb-3">
              <svg class="w-4 h-4 text-gryffi-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
              </svg>
              <label class="form-label mb-0">${window.t('builder.form.sendTo')}</label>
            </div>
            <input type="email" class="form-input" id="propRecipientEmail" value="${escapeHtml(props.recipient_email)}" placeholder="${window.t('builder.form.sendToPlaceholder')}" />
          </div>
          
          <div class="mt-3">
            <label class="form-label">${window.t('builder.form.emailSubject')}</label>
            <input type="text" class="form-input" id="propEmailSubject" value="${escapeHtml(props.email_subject || window.t('builder.form.emailSubjectPlaceholder'))}" />
          </div>
        `;
        break;
        
      case 'poll':
        const pollOptions = props.options || [];
        html += `
          <div>
            <label class="form-label">${window.t('builder.poll.question')}</label>
            <textarea class="form-textarea" id="propPollQuestion" placeholder="${window.t('builder.poll.questionPlaceholder')}">${escapeHtml(props.question)}</textarea>
          </div>
          
          <!-- Poll Options -->
          <div class="mt-4">
            <div class="flex items-center justify-between mb-3">
              <label class="form-label mb-0">${window.t('builder.poll.options')}</label>
              <span class="text-xs text-zen-400">${pollOptions.length === 1 ? window.t('builder.poll.optionCount', { count: pollOptions.length }) : window.t('builder.poll.optionCountPlural', { count: pollOptions.length })}</span>
            </div>
            <div id="pollOptionsContainer" class="space-y-2">
              ${pollOptions.map((opt, i) => this.renderPollOptionEditor(opt, i)).join('')}
            </div>
            ${pollOptions.length < 10 ? `
              <button type="button" id="addPollOptionBtn" class="mt-3 w-full py-2 border-2 border-dashed border-zen-200 rounded-lg text-sm text-zen-500 hover:border-gryffi-accent hover:text-gryffi-primary transition-colors">
                + ${window.t('builder.poll.addOption')}
              </button>
            ` : ''}
          </div>
          
          <!-- Poll Settings -->
          <div class="mt-5 pt-4 border-t border-zen-200">
            <div class="flex items-center gap-2 mb-3">
              <svg class="w-4 h-4 text-gryffi-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
              </svg>
              <span class="form-label mb-0">${window.t('builder.poll.settings')}</span>
            </div>
            
            <div class="space-y-3">
              <label class="flex items-center gap-3 p-2 rounded hover:bg-zen-50 cursor-pointer">
                <input type="checkbox" id="propIsRequired" class="form-checkbox" ${props.is_required !== false ? 'checked' : ''}>
                <span class="text-sm text-zen-700">${window.t('builder.poll.isRequired')}</span>
              </label>
              <p class="text-xs text-zen-400 ml-8 -mt-2">${window.t('builder.poll.isRequiredDesc')}</p>
              
              <label class="flex items-center gap-3 p-2 rounded hover:bg-zen-50 cursor-pointer">
                <input type="checkbox" id="propAllowMultiple" class="form-checkbox" ${props.allow_multiple ? 'checked' : ''}>
                <span class="text-sm text-zen-700">${window.t('builder.poll.allowMultiple')}</span>
              </label>
            </div>
          </div>
        `;
        break;
        
      case 'reward':
        const isRandomCodes = props.is_random_codes !== false;
        const manualCodes = props.manual_codes || '';
        const codesArray = manualCodes.split(/[,\n]/).filter(c => c.trim()).length;
        html += `
          <!-- Claim Status Banner (loaded dynamically) -->
          <div id="rewardClaimStatus" class="hidden mb-4 p-3 rounded-lg bg-gryffi-primary/10 border border-gryffi-primary/20">
            <div class="flex items-center gap-2">
              <svg class="w-5 h-5 text-gryffi-primary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              <div>
                <p class="text-sm font-medium text-gryffi-primary" id="claimStatusText"></p>
                <p class="text-xs text-zen-600 mt-0.5" id="claimStatusDesc"></p>
              </div>
            </div>
          </div>
          
          <!-- Reward Title -->
          <div>
            <label class="form-label">${window.t('builder.reward.title')}</label>
            <input type="text" class="form-input" id="propRewardTitle" value="${escapeHtml(props.title)}" placeholder="${window.t('builder.reward.titlePlaceholder')}" />
          </div>
          
          <!-- Description -->
          <div class="mt-3">
            <label class="form-label">${window.t('builder.reward.description')}</label>
            <textarea class="form-textarea" id="propRewardDescription" placeholder="${window.t('builder.reward.descriptionPlaceholder')}">${escapeHtml(props.description)}</textarea>
          </div>
          
          <!-- Redemption Location -->
          <div class="mt-3">
            <label class="form-label">${window.t('builder.reward.redemptionLocation')}</label>
            <input type="text" class="form-input" id="propRedemptionLocation" value="${escapeHtml(props.redemption_location)}" placeholder="${window.t('builder.reward.redemptionLocationPlaceholder')}" />
          </div>
          
          <!-- Terms & Conditions -->
          <div class="mt-3">
            <label class="form-label">${window.t('builder.reward.termsConditions')}</label>
            <textarea class="form-textarea" id="propTermsConditions" placeholder="${window.t('builder.reward.termsConditionsPlaceholder')}">${escapeHtml(props.terms_conditions)}</textarea>
          </div>
          
          <!-- Valid Until -->
          <div class="mt-3">
            <label class="form-label">${window.t('builder.reward.validUntil')}</label>
            <input type="date" class="form-input" id="propValidUntil" lang="${window.GRYFFI?.locale || document.documentElement.lang || 'en'}" value="${escapeHtml(props.valid_until)}" />
            <p class="text-xs text-zen-400 mt-1">${window.t('builder.reward.validUntilPlaceholder')}</p>
          </div>
          
          <!-- Code Settings -->
          <div class="mt-5 pt-4 border-t border-zen-200" id="codeSettingsSection">
            <div class="flex items-center gap-2 mb-3">
              <svg class="w-4 h-4 text-gryffi-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826-3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
              </svg>
              <span class="form-label mb-0">${window.t('builder.reward.codeSettings')}</span>
            </div>
            
            <!-- Random vs Manual Toggle -->
            <div class="space-y-2 mb-4" id="codeTypeToggle">
              <label class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${isRandomCodes ? 'border-gryffi-primary bg-gryffi-primary/5' : 'border-zen-200 hover:border-zen-300'}" id="randomCodesLabel">
                <input type="radio" name="codeType" value="random" class="form-radio" ${isRandomCodes ? 'checked' : ''} id="propRandomCodes">
                <div>
                  <span class="text-sm font-medium text-zen-700">${window.t('builder.reward.randomCodes')}</span>
                  <p class="text-xs text-zen-500">${window.t('builder.reward.randomCodesDesc')}</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${!isRandomCodes ? 'border-gryffi-primary bg-gryffi-primary/5' : 'border-zen-200 hover:border-zen-300'}" id="manualCodesLabel">
                <input type="radio" name="codeType" value="manual" class="form-radio" ${!isRandomCodes ? 'checked' : ''} id="propManualCodes">
                <div>
                  <span class="text-sm font-medium text-zen-700">${window.t('builder.reward.manualCodes')}</span>
                  <p class="text-xs text-zen-500">${window.t('builder.reward.manualCodesDesc')}</p>
                </div>
              </label>
            </div>
            
            <!-- Locked Code Type Notice -->
            <div id="codeTypeLockedNotice" class="hidden mb-4 p-3 rounded-lg bg-zen-100 border border-zen-200">
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-zen-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                </svg>
                <span class="text-sm text-zen-600" id="codeTypeLockedText"></span>
              </div>
            </div>
            
            <!-- Random Code Options -->
            <div id="randomCodeOptions" class="${isRandomCodes ? '' : 'hidden'}">
              <div class="mb-3">
                <label class="flex items-center gap-3 cursor-pointer" id="limitRecipientsLabel">
                  <input type="checkbox" id="propLimitRecipients" class="w-4 h-4 accent-gryffi-primary" ${props.max_recipients ? 'checked' : ''} />
                  <div>
                    <span class="text-sm font-medium text-zen-700">${window.t('builder.reward.limitRecipients')}</span>
                    <p class="text-xs text-zen-500">${window.t('builder.reward.limitRecipientsDesc')}</p>
                  </div>
                </label>
              </div>
              <div id="maxRecipientsContainer" class="mt-4 ${props.max_recipients ? '' : 'hidden'}">
                <div class="mb-3">
                  <label class="form-label">${window.t('builder.reward.maxRecipients')}</label>
                  <input type="number" class="form-input" id="propMaxRecipients" value="${escapeHtml(props.max_recipients)}" placeholder="${window.t('builder.reward.maxRecipientsPlaceholder')}" min="1" />
                  <p class="text-xs text-zen-400 mt-1" id="maxRecipientsDesc">${window.t('builder.reward.maxRecipientsDesc')}</p>
                </div>
              </div>
              <div class="mt-4" id="codePrefixContainer">
                <label class="form-label flex items-center gap-2">
                  ${window.t('builder.reward.codePrefix')}
                  <span id="codePrefixLock" class="hidden text-zen-400">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                    </svg>
                  </span>
                </label>
                <input type="text" class="form-input" id="propCodePrefix" value="${escapeHtml(props.code_prefix)}" placeholder="${window.t('builder.reward.codePrefixPlaceholder')}" maxlength="20" />
              </div>
            </div>
            
            <!-- Manual Code Options -->
            <div id="manualCodeOptions" class="${!isRandomCodes ? '' : 'hidden'}">
              <!-- Claimed codes list (shown when codes have been claimed) -->
              <div id="claimedCodesList" class="hidden mb-4">
                <label class="form-label flex items-center gap-2">
                  ${window.t('builder.reward.claimedCodes')}
                  <svg style="width: 14px; height: 14px; flex-shrink: 0;" class="text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                  </svg>
                </label>
                <div id="claimedCodesContainer" class="space-y-1 max-h-40 overflow-y-auto border border-zen-200 rounded-lg p-2 bg-zen-50"></div>
                <p class="text-xs text-zen-500 mt-1">${window.t('builder.reward.claimedCodesDesc')}</p>
              </div>
              
              <!-- Unclaimed codes that can be removed -->
              <div id="unclaimedCodesList" class="hidden mb-4">
                <label class="form-label">${window.t('builder.reward.unclaimedCodes')}</label>
                <div id="unclaimedCodesContainer" class="space-y-1 max-h-40 overflow-y-auto border border-zen-200 rounded-lg p-2"></div>
                <p class="text-xs text-zen-500 mt-1">${window.t('builder.reward.unclaimedCodesDesc')}</p>
              </div>
              
              <!-- Add new codes section -->
              <div class="mb-3" id="addCodesSection">
                <label class="form-label" id="enterCodesLabel">${window.t('builder.reward.enterCodes')}</label>
                <textarea class="form-textarea h-32" id="propManualCodesText" placeholder="${window.t('builder.reward.enterCodesPlaceholder')}">${escapeHtml(manualCodes)}</textarea>
                <p class="text-xs text-zen-500 mt-1" id="codesCountDisplay">${codesArray === 1 ? window.t('builder.reward.codesCount', { count: codesArray }) : window.t('builder.reward.codesCountPlural', { count: codesArray })}</p>
              </div>
              <div id="manualMaxRecipientsSection">
                <label class="form-label">${window.t('builder.reward.maxRecipients')}</label>
                <input type="number" class="form-input" id="propMaxRecipientsManual" value="${escapeHtml(props.max_recipients)}" placeholder="${window.t('builder.reward.maxRecipientsPlaceholder')}" min="1" max="${codesArray || 999}" />
                <p class="text-xs text-zen-400 mt-1" id="manualMaxRecipientsDesc">${window.t('builder.reward.maxRecipientsDesc')}</p>
                <p class="text-xs text-amber-600 mt-1 hidden" id="maxRecipientsWarning">${window.t('builder.reward.maxRecipientsExceedsCodes')}</p>
              </div>
            </div>
          </div>
        `;
        break;
        
      case 'nested_journey':
        const selectedNestedJourney = this.availableNestedJourneys?.find(j => j.id === props.nested_journey_id);
        html += `
          <div>
            <label class="form-label">${window.t('builder.props.selectNestedJourney')}</label>
            <select class="form-input" id="propNestedJourneyId">
              <option value="">${window.t('builder.props.chooseNestedJourney')}</option>
              ${(this.availableNestedJourneys || []).map(j => `
                <option value="${j.id}" ${props.nested_journey_id === j.id ? 'selected' : ''}>
                  ${escapeHtml(j.title)} (${j.step_count} ${window.t('builder.stepTypes.step').toLowerCase()}s)
                </option>
              `).join('')}
            </select>
            ${(!this.availableNestedJourneys || this.availableNestedJourneys.length === 0) ? `
              <p class="text-xs text-zen-500 mt-2">${window.t('builder.props.noPublishedJourneys')}</p>
            ` : ''}
          </div>
          
          <!-- Nested Journey Preview Card -->
          <div id="nestedJourneyPreviewCard" class="mt-4 ${selectedNestedJourney ? '' : 'hidden'}">
            <div class="border border-zen-200 rounded-lg overflow-hidden bg-gradient-to-br from-gryffi-primary/5 to-transparent">
              <div class="px-4 py-3 border-b border-zen-100 bg-white/50">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-gryffi-primary to-gryffi-accent flex items-center justify-center text-white overflow-hidden">
                    ${selectedNestedJourney?.cover_image_url 
                      ? `<img src="${escapeHtml(selectedNestedJourney.cover_image_url)}" alt="${escapeHtml(selectedNestedJourney.title)}" class="w-full h-full object-cover">`
                      : `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 10v2a2 2 0 002 2h2m6-4v-2a2 2 0 00-2-2h-2"></path></svg>`
                    }
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="font-medium text-zen-900 truncate" id="nestedJourneyPreviewTitle">${escapeHtml(selectedNestedJourney?.title)}</p>
                    <p class="text-xs text-zen-500" id="nestedJourneyPreviewSteps">
                      ${selectedNestedJourney ? window.t('builder.props.nestedJourneySteps', { count: selectedNestedJourney.step_count }) : ''}
                    </p>
                  </div>
                </div>
              </div>
              <div class="px-4 py-3 text-sm">
                ${selectedNestedJourney?.description ? `
                  <p class="text-zen-600 text-xs mb-2">${selectedNestedJourney.description.substring(0, 100)}${selectedNestedJourney.description.length > 100 ? '...' : ''}</p>
                ` : ''}
                <p class="text-xs text-zen-400">${window.t('builder.props.nestedJourneyPreview')}</p>
              </div>
            </div>
          </div>
          
          <!-- Warning -->
          <div class="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <div class="flex gap-2">
              <svg class="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
              </svg>
              <p class="text-xs text-amber-700">${window.t('builder.props.nestedJourneyWarning')}</p>
            </div>
          </div>
        `;
        break;
    }
    
    // Paths section
    const stepPaths = this.paths.filter(p => p.from_step_id === step.id);
    html += `
      <div class="pt-4 border-t border-zen-200 mt-4">
        <label class="form-label">${window.t('builder.connections.pathLabel')}</label>
        <div id="pathsContainer" class="space-y-2">
          ${stepPaths.map(p => {
            const target = this.steps.find(s => s.id === p.to_step_id);
            return `
              <div class="flex items-center gap-2">
                <input type="text" class="form-input text-sm" style="flex: 1 1 auto; min-width: 120px;" data-path="${p.id}" value="${escapeHtml(p.label)}" />
                <span class="text-xs text-zen-500" style="max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;" title="${escapeHtml(target?.title || window.t('common.unknown'))}">→ ${escapeHtml(target?.title || window.t('common.unknown'))}</span>
                <button class="text-red-500 hover:text-red-700 delete-path-btn" style="flex-shrink: 0;" data-path="${p.id}">×</button>
              </div>
            `;
          }).join('')}
        </div>
        <button id="addPathBtn" class="mt-2 text-sm text-gryffi-primary hover:underline">+ ${window.t('builder.connections.connect')}</button>
      </div>
    `;
    
    
    return html;
  }
  
  renderAdvancedPropsForm(step, props, basicProps = {}) {
    let html = '';
    const pacing = props.pacing || 'immediately';
    
    switch (step.type) {
      case 'space':
        html = `
          <!-- Pacing Section -->
          ${this.renderPacingSection('space', pacing)}
          
          <!-- Step Assistant Section -->
          ${this.renderStepAssistantSection(props.assistant_guide_id)}
        `;
        break;
        
      case 'guide':
        html = `
          <!-- Pacing Section -->
          ${this.renderPacingSection('guide', pacing)}
          
          <div class="pt-4 border-t border-zen-100 mt-4">
            <label class="form-label">${window.t('builder.advanced.stepContext')}</label>
            <textarea class="form-textarea" id="advStepContext" rows="3" placeholder="${window.t('builder.advanced.stepContextPlaceholder')}">${escapeHtml(props.step_context)}</textarea>
            <p class="text-xs text-zen-400 mt-1">${window.t('builder.advanced.stepContextDesc')}</p>
          </div>
        `;
        break;
        
      case 'content':
        // Determine media type for dynamic pacing options
        const mediaType = basicProps.media_type === 'markdown' ? 'text' : (basicProps.media_type || 'text');
        html = `
          <!-- Pacing Section - Dynamic based on media type -->
          ${this.renderPacingSection('content', pacing, mediaType)}
          
          <!-- Step Assistant Section -->
          ${this.renderStepAssistantSection(props.assistant_guide_id)}
        `;
        break;
        
      case 'challenge':
        // Get question count for passing score options
        const quizQuestions = step.basic_props?.questions || [];
        const qCount = quizQuestions.length || 1;
        const currentPassingScore = props.passing_score || 0;
        
        html = `
          <!-- Step Assistant Section -->
          ${this.renderStepAssistantSection(props.assistant_guide_id)}
          
          <!-- Quiz Settings -->
          <div class="pt-4 border-t border-zen-100 mt-4">
            <label class="form-label">${window.t('builder.quiz.settings.passingScore')}</label>
            <select class="form-select" id="advPassingScore">
              <option value="0" ${currentPassingScore === 0 ? 'selected' : ''}>${window.t('builder.quiz.settings.noRequirement')}</option>
              ${Array.from({ length: qCount }, (_, i) => i + 1).map(n => `
                <option value="${n}" ${currentPassingScore === n ? 'selected' : ''}>
                  ${n === qCount 
                    ? window.t('builder.quiz.settings.requireAll', { count: qCount })
                    : window.t('builder.quiz.settings.requireMinimum', { count: n })}
                </option>
              `).join('')}
            </select>
            <p class="text-xs text-zen-400 mt-1">${window.t('builder.quiz.settings.passingScoreDesc')}</p>
          </div>
          
          <div class="mt-4">
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" id="advShowFeedback" class="w-4 h-4 rounded border-zen-300 text-gryffi-primary focus:ring-gryffi-primary" ${props.show_feedback !== false ? 'checked' : ''} />
              <div>
                <span class="text-sm font-medium text-zen-700">${window.t('builder.quiz.settings.showFeedback')}</span>
                <p class="text-xs text-zen-400">${window.t('builder.quiz.settings.showFeedbackDesc')}</p>
              </div>
            </label>
          </div>
          
          <div class="mt-4">
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" id="advAllowRetake" class="w-4 h-4 rounded border-zen-300 text-gryffi-primary focus:ring-gryffi-primary" ${props.allow_retake !== false ? 'checked' : ''} />
              <div>
                <span class="text-sm font-medium text-zen-700">${window.t('builder.quiz.settings.allowRetake')}</span>
                <p class="text-xs text-zen-400">${window.t('builder.quiz.settings.allowRetakeDesc')}</p>
              </div>
            </label>
          </div>
          
          <div class="pt-4 border-t border-zen-100 mt-4">
            <label class="form-label">${window.t('builder.advanced.passMessage')}</label>
            <textarea class="form-textarea" id="advPassMessage">${escapeHtml(props.pass_message)}</textarea>
          </div>
          <div>
            <label class="form-label">${window.t('builder.advanced.failMessage')}</label>
            <textarea class="form-textarea" id="advFailMessage">${escapeHtml(props.fail_message)}</textarea>
          </div>
        `;
        break;
        
      case 'form':
        const formRequirement = props.completion_requirement || 'after_submit';
        html = `
          <!-- Form Completion Requirement Section -->
          ${this.renderFormCompletionSection(formRequirement)}
          
          <!-- Step Assistant Section -->
          ${this.renderStepAssistantSection(props.assistant_guide_id)}
          
          <div class="pt-4 border-t border-zen-100 mt-4">
            <label class="form-label">${window.t('builder.advanced.confirmationMessage')}</label>
            <textarea class="form-textarea" id="advConfirmationMessage">${escapeHtml(props.confirmation_message || window.t('builder.advanced.confirmationMessageDefault'))}</textarea>
            <p class="text-xs text-zen-400 mt-1">${window.t('builder.advanced.confirmationMessageDesc')}</p>
          </div>
        `;
        break;
        
      case 'poll':
        html = `
          <!-- Step Assistant Section -->
          ${this.renderStepAssistantSection(props.assistant_guide_id)}
          
          <!-- Reset Poll Section -->
          <div class="pt-4 border-t border-zen-100 mt-4">
            <label class="form-label">${window.t('builder.poll.resetSection')}</label>
            <p class="text-xs text-zen-400 mb-3">${window.t('builder.poll.resetDesc')}</p>
            <button type="button" id="resetPollBtn" class="text-sm text-red-500 hover:text-red-600 hover:underline flex items-center gap-1">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
              </svg>
              ${window.t('builder.poll.resetButton')}
            </button>
          </div>
        `;
        break;
        
      case 'nested_journey':
        html = `
          <!-- Step Assistant Section -->
          ${this.renderStepAssistantSection(props.assistant_guide_id)}
        `;
        break;
    }
    
    return html;
  }
  
  renderPacingSection(stepType, currentPacing, mediaType = null) {
    let options = [];
    
    switch (stepType) {
      case 'space':
        options = [
          { value: 'immediately', label: window.t('builder.pacing.immediately'), desc: window.t('builder.pacing.immediatelyDesc') },
          { value: 'time_10', label: window.t('builder.pacing.after10sec'), desc: window.t('builder.pacing.after10secDesc') },
          { value: 'time_30', label: window.t('builder.pacing.after30sec'), desc: window.t('builder.pacing.after30secSpace') },
          { value: 'time_60', label: window.t('builder.pacing.after1min'), desc: window.t('builder.pacing.after1minSpace') }
        ];
        break;
        
      case 'guide':
        options = [
          { value: 'immediately', label: window.t('builder.pacing.immediately'), desc: window.t('builder.pacing.immediatelySkip') },
          { value: 'messages_2', label: window.t('builder.pacing.messages2'), desc: window.t('builder.pacing.messages2Desc') },
          { value: 'messages_4', label: window.t('builder.pacing.messages4'), desc: window.t('builder.pacing.messages4Desc') },
          { value: 'messages_6', label: window.t('builder.pacing.messages6'), desc: window.t('builder.pacing.messages6Desc') }
        ];
        break;
        
      case 'content':
        if (mediaType === 'video') {
          options = [
            { value: 'immediately', label: window.t('builder.pacing.immediately'), desc: window.t('builder.pacing.immediatelyVideo') },
            { value: 'time_60', label: window.t('builder.pacing.after1min'), desc: window.t('builder.pacing.after1minVideo') },
            { value: 'time_120', label: window.t('builder.pacing.after2min'), desc: window.t('builder.pacing.after2minVideo') },
            { value: 'time_300', label: window.t('builder.pacing.after5min'), desc: window.t('builder.pacing.after5minVideo') }
          ];
        } else if (mediaType === 'image') {
          options = [
            { value: 'immediately', label: window.t('builder.pacing.immediately'), desc: window.t('builder.pacing.immediatelyDesc') },
            { value: 'time_10', label: window.t('builder.pacing.after10sec'), desc: window.t('builder.pacing.after10secImage') },
            { value: 'time_30', label: window.t('builder.pacing.after30sec'), desc: window.t('builder.pacing.after30secImage') }
          ];
        } else {
          // Text
          options = [
            { value: 'immediately', label: window.t('builder.pacing.immediately'), desc: window.t('builder.pacing.immediatelyDesc') },
            { value: 'time_30', label: window.t('builder.pacing.after30sec'), desc: window.t('builder.pacing.after30secText') },
            { value: 'time_60', label: window.t('builder.pacing.after1min'), desc: window.t('builder.pacing.after1minText') },
            { value: 'time_120', label: window.t('builder.pacing.after2min'), desc: window.t('builder.pacing.after2minText') }
          ];
        }
        break;
    }
    
    return `
      <div class="pacing-section">
        <div class="flex items-center gap-2 mb-3">
          <svg class="w-4 h-4 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <span class="text-sm font-medium text-zen-700">${window.t('builder.pacing.title')}</span>
        </div>
        <p class="text-xs text-zen-500 mb-3">${window.t('builder.pacing.subtitle')}</p>
        <div class="pacing-options">
          ${options.map(opt => `
            <label class="pacing-option ${currentPacing === opt.value ? 'selected' : ''}">
              <input type="radio" name="advPacing" value="${escapeHtml(opt.value)}" ${currentPacing === opt.value ? 'checked' : ''} />
              <div class="pacing-option-content">
                <span class="pacing-option-label">${escapeHtml(opt.label)}</span>
                <span class="pacing-option-desc">${escapeHtml(opt.desc)}</span>
              </div>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }
  
  renderFormCompletionSection(currentRequirement) {
    const options = [
      { 
        value: 'after_submit', 
        label: window.t('builder.form.completion.afterSubmit'), 
        desc: window.t('builder.form.completion.afterSubmitDesc') 
      },
      { 
        value: 'immediately', 
        label: window.t('builder.form.completion.immediately'), 
        desc: window.t('builder.form.completion.immediatelyDesc') 
      }
    ];
    
    return `
      <div class="form-completion-section">
        <div class="flex items-center gap-2 mb-3">
          <svg class="w-4 h-4 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <span class="text-sm font-medium text-zen-700">${window.t('builder.form.completion.title')}</span>
        </div>
        <p class="text-xs text-zen-500 mb-3">${window.t('builder.form.completion.subtitle')}</p>
        <div class="pacing-options">
          ${options.map(opt => `
            <label class="pacing-option ${currentRequirement === opt.value ? 'selected' : ''}">
              <input type="radio" name="advFormCompletion" value="${escapeHtml(opt.value)}" ${currentRequirement === opt.value ? 'checked' : ''} />
              <div class="pacing-option-content">
                <span class="pacing-option-label">${escapeHtml(opt.label)}</span>
                <span class="pacing-option-desc">${escapeHtml(opt.desc)}</span>
              </div>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }
  
  renderStepAssistantSection(currentGuideId = null) {
    if (!this.guides || this.guides.length === 0) {
      return `
        <div class="step-assistant-section pt-4 border-t border-zen-100 mt-4">
          <div class="flex items-center gap-2 mb-3">
            <svg class="w-4 h-4 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
            </svg>
            <span class="text-sm font-medium text-zen-700">${window.t('builder.assistant.title')}</span>
          </div>
          <p class="text-xs text-zen-500 mb-3">${window.t('builder.assistant.subtitle')}</p>
          <div class="bg-zen-50 rounded-lg p-4 text-center">
            <p class="text-sm text-zen-500 mb-2">${window.t('builder.assistant.noGuides')}</p>
            <a href="/dashboard/guides" class="text-sm text-gryffi-primary hover:underline">${window.t('builder.assistant.createFirst')}</a>
          </div>
        </div>
      `;
    }
    
    return `
      <div class="step-assistant-section pt-4 border-t border-zen-100 mt-4">
        <div class="flex items-center gap-2 mb-3">
          <svg class="w-4 h-4 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
          </svg>
          <span class="text-sm font-medium text-zen-700">${window.t('builder.assistant.title')}</span>
        </div>
        <p class="text-xs text-zen-500 mb-3">${window.t('builder.assistant.subtitle')}</p>
        
        <select id="advAssistantGuide" class="form-input mb-3">
          <option value="">${window.t('builder.assistant.noAssistant')}</option>
          ${this.guides.map(g => `
            <option value="${g.id}" ${currentGuideId === g.id ? 'selected' : ''}>
              ${escapeHtml(g.name)}${g.role ? ' — ' + escapeHtml(g.role) : ''}
            </option>
          `).join('')}
        </select>
        
        <div id="assistantGuidePreview" class="${currentGuideId ? '' : 'hidden'}">
          ${currentGuideId ? this.renderAssistantGuidePreview(currentGuideId) : ''}
        </div>
      </div>
    `;
  }
  
  renderAssistantGuidePreview(guideId) {
    const guide = this.guides.find(g => g.id === guideId);
    if (!guide) return '';
    
    return `
      <div class="bg-gryffi-primary/5 rounded-lg p-3 flex items-start gap-3">
        <div class="w-10 h-10 rounded-full bg-gryffi-primary/20 flex items-center justify-center flex-shrink-0 text-gryffi-primary font-bold">
          ${guide.avatar_url 
            ? `<img src="${escapeHtml(guide.avatar_url)}" alt="${escapeHtml(guide.name)}" class="w-10 h-10 rounded-full object-cover">`
            : guide.name.charAt(0).toUpperCase()}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-zen-900 text-sm">${escapeHtml(guide.name)}</div>
          ${guide.role ? `<div class="text-xs text-zen-500">${escapeHtml(guide.role)}</div>` : ''}
          ${guide.greeting ? `<div class="text-xs text-zen-600 mt-1 italic line-clamp-2">"${escapeHtml(guide.greeting)}"</div>` : ''}
        </div>
      </div>
      <p class="text-xs text-zen-400 mt-2 flex items-center gap-1">
        <svg class="flex-shrink-0" style="width: 14px; height: 14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        ${window.t('builder.assistant.userWillSee', { name: guide.name })}
      </p>
    `;
  }
  
  bindPropertyEvents(step) {
    // Tab switching
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        const tabName = tab.dataset.tab;
        document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.add('hidden'));
        document.getElementById(`${tabName}Tab`)?.classList.remove('hidden');
      });
    });
    
    // Close panel button (re-bind since we replaced the HTML)
    document.getElementById('closePanel')?.addEventListener('click', () => this.closeProperties());
    
    // Delete step button
    document.getElementById('deleteStepBtn')?.addEventListener('click', () => this.deleteSelectedStep());
    
    // Preview from this step (skips on_journey_start automation; banner shows
    // in the preview header to remind the maker this is a partial test run).
    document.getElementById('previewFromHereBtn')?.addEventListener('click', () => this.openPreviewFromStep(step.id));
    
    // Title change
    document.getElementById('propTitle')?.addEventListener('change', (e) => {
      this.updateStep(step.id, { title: e.target.value });
    });
    
    
    // Basic props - collect all and update
    const saveBasicProps = () => {
      const basicProps = this.collectBasicProps(step);
      this.updateStep(step.id, { basic_props: basicProps });
    };
    
    // Add change listeners to all basic prop inputs
    ['propDescription', 'propImageUrl', 'propName', 'propRole', 'propGreeting', 
     'propPersonality', 'propBody', 'propMediaType', 'propQuestion'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', saveBasicProps);
    });
    
    // Image picker for space
    const openImagePicker = () => {
      window.imagePicker?.open({
        stepType: step.type,
        stepTitle: step.title,
        onSelect: async (imageData) => {
          // Update the hidden input
          document.getElementById('propImageUrl').value = imageData.url;
          
          // Collect and save basic props
          const basicProps = this.collectBasicProps(step);
          
          // Update local step data immediately for instant UI feedback
          const stepIndex = this.steps.findIndex(s => s.id === step.id);
          if (stepIndex !== -1) {
            this.steps[stepIndex].basic_props = basicProps;
          }
          
          // Re-render the properties panel immediately with the new image
          this.showProperties(step.id);
          
          // Save to server in background
          await this.updateStep(step.id, { basic_props: basicProps });
        }
      });
    };
    
    document.getElementById('addSpaceImage')?.addEventListener('click', openImagePicker);
    document.getElementById('changeSpaceImage')?.addEventListener('click', openImagePicker);
    document.getElementById('removeSpaceImage')?.addEventListener('click', () => {
      document.getElementById('propImageUrl').value = '';
      saveBasicProps();
      this.showProperties(step.id);
    });
    
    // Image type toggle (normal vs panorama)
    const imageTypeRadios = document.querySelectorAll('input[name="imageType"]');
    imageTypeRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        const isPanorama = radio.value === 'panorama';
        document.getElementById('propIsPanorama').value = isPanorama;
        
        // Update visual state of labels
        document.getElementById('normalImageLabel')?.classList.toggle('border-gryffi-primary', !isPanorama);
        document.getElementById('normalImageLabel')?.classList.toggle('bg-gryffi-primary/5', !isPanorama);
        document.getElementById('normalImageLabel')?.classList.toggle('border-zen-200', isPanorama);
        document.getElementById('panoramaImageLabel')?.classList.toggle('border-gryffi-primary', isPanorama);
        document.getElementById('panoramaImageLabel')?.classList.toggle('bg-gryffi-primary/5', isPanorama);
        document.getElementById('panoramaImageLabel')?.classList.toggle('border-zen-200', !isPanorama);
        
        // Show/hide sections
        document.getElementById('normalImageSection')?.classList.toggle('hidden', isPanorama);
        document.getElementById('panoramaImageSection')?.classList.toggle('hidden', !isPanorama);
        
        saveBasicProps();
      });
    });
    
    // 360° Panorama upload handlers
    const openPanoramaUpload = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // Validate file type
        if (!['image/jpeg', 'image/png'].includes(file.type)) {
          window.gryffi?.modal?.alert(window.t('imagePicker.invalidType'));
          return;
        }
        
        // Check if it's a panorama by aspect ratio
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        
        img.onload = async () => {
          URL.revokeObjectURL(objectUrl);
          
          // Check aspect ratio - 360° panoramas come in various formats:
          // - Equirectangular: ~2:1 (most common for full spherical)
          // - Cylindrical/wide panoramas: can be 3:1, 4:1 or wider
          // - Minimum should be wider than a regular photo (>1.5:1)
          const aspectRatio = img.width / img.height;
          const isPanoramaValid = aspectRatio >= 1.5; // Accept any wide panorama
          
          if (!isPanoramaValid) {
            // Only reject if it's not a wide/panoramic image
            window.gryffi?.modal?.alert(window.t('builder.props.panoramaInvalid'));
            return;
          }
          
          // Upload the file
          try {
            const formData = new FormData();
            formData.append('image', file);
            
            const response = await fetch('/api/media/upload', {
              method: 'POST',
              body: formData
            });
            
            const data = await response.json();
            
            if (data.success) {
              // Update the hidden input
              document.getElementById('propPanoramaUrl').value = data.url;
              
              // Collect and save basic props
              const basicProps = this.collectBasicProps(step);
              
              // Update local step data immediately
              const stepIndex = this.steps.findIndex(s => s.id === step.id);
              if (stepIndex !== -1) {
                this.steps[stepIndex].basic_props = basicProps;
              }
              
              // Re-render the properties panel
              this.showProperties(step.id);
              
              // Save to server
              await this.updateStep(step.id, { basic_props: basicProps });
            } else {
              throw new Error(data.error || 'Upload failed');
            }
          } catch (err) {
            console.error('Panorama upload error:', err);
            window.gryffi?.modal?.alert(window.t('builder.props.uploadFailed'));
          }
        };
        
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          window.gryffi?.modal?.alert(window.t('builder.props.uploadFailed'));
        };
        
        img.src = objectUrl;
      };
      input.click();
    };
    
    document.getElementById('addPanoramaImage')?.addEventListener('click', openPanoramaUpload);
    document.getElementById('changePanoramaImage')?.addEventListener('click', openPanoramaUpload);
    document.getElementById('removePanoramaImage')?.addEventListener('click', () => {
      document.getElementById('propPanoramaUrl').value = '';
      saveBasicProps();
      this.showProperties(step.id);
    });
    
    // Initialize mini panorama viewer in editor if present
    this.initMiniPanoramaViewer();
    
    // Floorplan functionality
    const floorplanEnabledCheckbox = document.getElementById('propFloorplanEnabled');
    const floorplanSection = document.getElementById('floorplanSection');
    const floorplanSelect = document.getElementById('propFloorplanId');
    const floorplanMarkerArea = document.getElementById('floorplanMarkerArea');
    
    // Toggle floorplan section visibility
    floorplanEnabledCheckbox?.addEventListener('change', () => {
      floorplanSection?.classList.toggle('hidden', !floorplanEnabledCheckbox.checked);
      if (floorplanEnabledCheckbox.checked) {
        this.loadFloorplans();
      }
      saveBasicProps();
    });
    
    // Load floorplans if section is visible
    if (floorplanEnabledCheckbox?.checked) {
      this.loadFloorplans();
    }
    
    // Floorplan selection change
    floorplanSelect?.addEventListener('change', () => {
      const selectedId = floorplanSelect.value;
      if (selectedId) {
        const selectedOption = floorplanSelect.options[floorplanSelect.selectedIndex];
        const imageUrl = selectedOption.dataset.url;
        this.showFloorplanMarkerArea(imageUrl);
      } else {
        floorplanMarkerArea?.classList.add('hidden');
      }
      saveBasicProps();
    });
    
    // Upload new floorplan button
    document.getElementById('uploadNewFloorplanBtn')?.addEventListener('click', () => {
      this.showFloorplanUploadModal();
    });
    
    // Floorplan marker placement
    document.getElementById('floorplanMarkerContainer')?.addEventListener('click', (e) => {
      const container = e.currentTarget;
      const rect = container.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      
      // Update marker position
      const marker = document.getElementById('floorplanMarker');
      marker.style.left = `${x}%`;
      marker.style.top = `${y}%`;
      marker.classList.remove('hidden');
      
      // Update hidden inputs
      document.getElementById('propFloorplanMarkerX').value = x.toFixed(2);
      document.getElementById('propFloorplanMarkerY').value = y.toFixed(2);
      
      // Update hint text
      document.getElementById('floorplanMarkerHint').textContent = 
        `${window.t('builder.props.markerPlaced')} - ${window.t('builder.props.moveMarker')}`;
      
      saveBasicProps();
    });
    
    // Content step - Media type selector
    document.querySelectorAll('.media-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        document.getElementById('propMediaType').value = type;
        
        // Update button states
        document.querySelectorAll('.media-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Show/hide content sections
        document.getElementById('contentTextSection')?.classList.toggle('hidden', type !== 'text');
        document.getElementById('contentVideoSection')?.classList.toggle('hidden', type !== 'video');
        document.getElementById('contentImageSection')?.classList.toggle('hidden', type !== 'image');
        
        // Update pacing options in Advanced tab based on new media type
        const pacingSection = document.querySelector('.pacing-section');
        if (pacingSection && step.type === 'content') {
          // Get current pacing value to preserve it if possible
          const currentPacing = document.querySelector('[name="advPacing"]:checked')?.value || 'immediately';
          // Re-render pacing section with new media type options
          pacingSection.outerHTML = this.renderPacingSection('content', currentPacing, type);
          // Re-bind pacing event handlers
          document.querySelectorAll('[name="advPacing"]').forEach(radio => {
            radio.addEventListener('change', () => {
              document.querySelectorAll('.pacing-option').forEach(opt => opt.classList.remove('selected'));
              radio.closest('.pacing-option')?.classList.add('selected');
              saveAdvancedProps();
            });
          });
        }
        
        saveBasicProps();
      });
    });
    
    // Content step - Simple editor toolbar
    document.querySelectorAll('.editor-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const command = btn.dataset.command;
        const value = btn.dataset.value;
        
        if (command === 'fontSize') {
          // Custom font size handling
          const selection = window.getSelection();
          if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (!range.collapsed) {
              const span = document.createElement('span');
              span.style.fontSize = value === 'large' ? '18px' : '15px';
              range.surroundContents(span);
            }
          }
        } else {
          document.execCommand(command, false, value || null);
        }
        
        // Focus back on editor
        document.getElementById('propBodyEditor')?.focus();
      });
    });
    
    // Content step - Editor content change (save on blur)
    document.getElementById('propBodyEditor')?.addEventListener('blur', saveBasicProps);
    
    // Content step - Image picker
    const openContentImagePicker = () => {
      window.imagePicker?.open({
        stepType: 'content',
        stepTitle: step.title,
        onSelect: async (imageData) => {
          document.getElementById('propContentImageUrl').value = imageData.url;
          const basicProps = this.collectBasicProps(step);
          const stepIndex = this.steps.findIndex(s => s.id === step.id);
          if (stepIndex !== -1) {
            this.steps[stepIndex].basic_props = basicProps;
          }
          this.showProperties(step.id);
          await this.updateStep(step.id, { basic_props: basicProps });
        }
      });
    };
    
    document.getElementById('addContentImage')?.addEventListener('click', openContentImagePicker);
    document.getElementById('changeContentImage')?.addEventListener('click', openContentImagePicker);
    document.getElementById('removeContentImage')?.addEventListener('click', () => {
      document.getElementById('propContentImageUrl').value = '';
      saveBasicProps();
      this.showProperties(step.id);
    });
    
    // Content step - Video URL change with live preview
    const videoUrlInput = document.getElementById('propVideoUrl');
    const videoPreviewContainer = document.getElementById('videoPreviewContainer');
    
    const updateVideoPreview = () => {
      const url = videoUrlInput?.value || '';
      if (videoPreviewContainer) {
        if (url) {
          videoPreviewContainer.classList.remove('hidden');
          videoPreviewContainer.querySelector('.video-preview-wrapper').innerHTML = this.renderVideoPreview(url);
        } else {
          videoPreviewContainer.classList.add('hidden');
        }
      }
    };
    
    videoUrlInput?.addEventListener('input', updateVideoPreview);
    videoUrlInput?.addEventListener('change', () => {
      updateVideoPreview();
      saveBasicProps();
    });
    
    // Content step - Media description and text position
    document.getElementById('propVideoDescription')?.addEventListener('change', saveBasicProps);
    document.getElementById('propImageDescription')?.addEventListener('change', saveBasicProps);
    document.querySelectorAll('input[name="videoTextPosition"]').forEach(radio => {
      radio.addEventListener('change', saveBasicProps);
    });
    document.querySelectorAll('input[name="imageTextPosition"]').forEach(radio => {
      radio.addEventListener('change', saveBasicProps);
    });
    
    // Quiz builder events
    if (step.type === 'challenge') {
      this.bindQuizEvents(step);
    }
    
    // Paths
    document.querySelectorAll('[data-path]').forEach(input => {
      input.addEventListener('change', async (e) => {
        const pathId = e.target.dataset.path;
        await this.updatePath(pathId, { label: e.target.value });
        const p = this.paths.find(p => p.id === pathId);
        if (p) p.label = e.target.value;
        this.renderStep(step);
      });
    });
    
    document.querySelectorAll('.delete-path-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const pathId = e.target.dataset.path;
        await this.deletePath(pathId);
        this.showProperties(step.id);
        this.renderStep(step);
      });
    });
    
    document.getElementById('addPathBtn')?.addEventListener('click', () => {
      this.showAddPathModal(step);
    });
    
    // Advanced props - collect all and update
    const saveAdvancedProps = () => {
      const advancedProps = this.collectAdvancedProps(step);
      this.updateStep(step.id, { advanced_props: advancedProps });
    };
    
    ['advAiInstructions', 'advTopics',
     'advHint', 'advPassMessage', 'advFailMessage', 'advConfirmationMessage'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', saveAdvancedProps);
    });
    
    // Quiz settings - passing score, show feedback, allow retake
    document.getElementById('advPassingScore')?.addEventListener('change', saveAdvancedProps);
    document.getElementById('advShowFeedback')?.addEventListener('change', saveAdvancedProps);
    document.getElementById('advAllowRetake')?.addEventListener('change', saveAdvancedProps);
    
    // Step Assistant dropdown
    document.getElementById('advAssistantGuide')?.addEventListener('change', (e) => {
      const guideId = e.target.value;
      const previewEl = document.getElementById('assistantGuidePreview');
      
      if (guideId && previewEl) {
        previewEl.innerHTML = this.renderAssistantGuidePreview(guideId);
        previewEl.classList.remove('hidden');
      } else if (previewEl) {
        previewEl.innerHTML = '';
        previewEl.classList.add('hidden');
      }
      
      saveAdvancedProps();
    });
    
    // Pacing radio buttons
    document.querySelectorAll('[name="advPacing"]').forEach(radio => {
      radio.addEventListener('change', () => {
        // Update visual selection state
        document.querySelectorAll('.pacing-option').forEach(opt => opt.classList.remove('selected'));
        radio.closest('.pacing-option')?.classList.add('selected');
        saveAdvancedProps();
      });
    });
    
    // Form completion requirement radio buttons
    document.querySelectorAll('[name="advFormCompletion"]').forEach(radio => {
      radio.addEventListener('change', () => {
        // Update visual selection state within the form completion section
        const section = radio.closest('.form-completion-section');
        section?.querySelectorAll('.pacing-option').forEach(opt => opt.classList.remove('selected'));
        radio.closest('.pacing-option')?.classList.add('selected');
        saveAdvancedProps();
      });
    });
    
    // Guide step events - select guide and manage guides button
    if (step.type === 'guide') {
      this.bindGuideStepEvents(step);
    }
    
    // Form step events
    if (step.type === 'form') {
      this.bindFormFieldEvents(step, saveBasicProps);
    }
    
    // Poll step events
    if (step.type === 'poll') {
      this.bindPollEvents(step, saveBasicProps);
    }
    
    // Reward step events
    if (step.type === 'reward') {
      this.bindRewardEvents(step, saveBasicProps);
    }
    
    // Nested journey step events
    if (step.type === 'nested_journey') {
      this.bindNestedJourneyEvents(step, saveBasicProps);
    }
  }
  
  bindNestedJourneyEvents(step, saveBasicProps) {
    const journeySelect = document.getElementById('propNestedJourneyId');
    const previewCard = document.getElementById('nestedJourneyPreviewCard');
    
    journeySelect?.addEventListener('change', (e) => {
      const journeyId = e.target.value;
      const journey = this.availableNestedJourneys?.find(j => j.id === journeyId);
      
      if (journey) {
        previewCard?.classList.remove('hidden');
        
        const titleEl = document.getElementById('nestedJourneyPreviewTitle');
        const stepsEl = document.getElementById('nestedJourneyPreviewSteps');
        
        if (titleEl) titleEl.textContent = journey.title;
        if (stepsEl) stepsEl.textContent = window.t('builder.props.nestedJourneySteps', { count: journey.step_count });
      } else {
        previewCard?.classList.add('hidden');
      }
      
      saveBasicProps();
    });
  }
  
  bindRewardEvents(step, saveBasicProps) {
    // Load and apply claim status (locks fields if codes have been claimed)
    this.loadRewardClaimStatus(step, saveBasicProps);
    
    // Code type toggle (random vs manual)
    document.querySelectorAll('input[name="codeType"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const isRandom = document.getElementById('propRandomCodes')?.checked;
        
        // Update visual selection
        document.querySelectorAll('input[name="codeType"]').forEach(r => {
          const label = r.closest('label');
          if (r.checked) {
            label?.classList.add('border-gryffi-primary', 'bg-gryffi-primary/5');
            label?.classList.remove('border-zen-200');
          } else {
            label?.classList.remove('border-gryffi-primary', 'bg-gryffi-primary/5');
            label?.classList.add('border-zen-200');
          }
        });
        
        // Toggle sections
        document.getElementById('randomCodeOptions')?.classList.toggle('hidden', !isRandom);
        document.getElementById('manualCodeOptions')?.classList.toggle('hidden', isRandom);
        
        saveBasicProps();
      });
    });
    
    // Manual codes textarea - count codes and validate max recipients
    const updateCodesCount = () => {
      const textarea = document.getElementById('propManualCodesText');
      if (!textarea) return;
      
      // If codes have been claimed, update differently
      if (this.rewardClaimData?.claimedCount > 0 && !this.rewardClaimData.isRandomCodes) {
        this.updateManualCodesFromUI(saveBasicProps);
        return;
      }
      
      const codes = textarea.value.split(/[,\n]/).filter(c => c.trim()).length;
      const countDisplay = document.getElementById('codesCountDisplay');
      const maxInput = document.getElementById('propMaxRecipientsManual');
      const warning = document.getElementById('maxRecipientsWarning');
      
      if (countDisplay) {
        countDisplay.textContent = codes === 1 
          ? window.t('builder.reward.codesCount', { count: codes })
          : window.t('builder.reward.codesCountPlural', { count: codes });
      }
      
      // Update max recipients max value and validate
      if (maxInput) {
        maxInput.max = codes || 999;
        const currentValue = parseInt(maxInput.value) || 0;
        
        // Show/hide warning if value exceeds codes count
        if (warning) {
          if (currentValue > codes && codes > 0) {
            warning.classList.remove('hidden');
            maxInput.value = codes; // Auto-correct to max allowed
          } else {
            warning.classList.add('hidden');
          }
        }
      }
    };
    
    document.getElementById('propManualCodesText')?.addEventListener('input', updateCodesCount);
    
    // Also validate when max recipients input changes
    document.getElementById('propMaxRecipientsManual')?.addEventListener('input', (e) => {
      const textarea = document.getElementById('propManualCodesText');
      const warning = document.getElementById('maxRecipientsWarning');
      if (!textarea || !warning) return;
      
      const codes = textarea.value.split(/[,\n]/).filter(c => c.trim()).length;
      const currentValue = parseInt(e.target.value) || 0;
      
      if (currentValue > codes && codes > 0) {
        warning.classList.remove('hidden');
        e.target.value = codes; // Auto-correct to max allowed
      } else {
        warning.classList.add('hidden');
      }
    });
    
    // Limit recipients checkbox toggle (for random codes)
    document.getElementById('propLimitRecipients')?.addEventListener('change', (e) => {
      const container = document.getElementById('maxRecipientsContainer');
      const maxInput = document.getElementById('propMaxRecipients');
      
      if (e.target.checked) {
        container?.classList.remove('hidden');
        maxInput?.focus();
      } else {
        container?.classList.add('hidden');
        if (maxInput) maxInput.value = ''; // Clear the value when unchecked
      }
      saveBasicProps();
    });
    
    // Add change listeners to all reward inputs
    ['propRewardTitle', 'propRewardDescription', 'propRedemptionLocation', 
     'propTermsConditions', 'propValidUntil', 'propMaxRecipients', 
     'propMaxRecipientsManual', 'propCodePrefix', 'propManualCodesText'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', saveBasicProps);
    });
  }
  
  async loadRewardClaimStatus(step, saveBasicProps) {
    // Skip in player mode
    if (this.playerMode) return;
    
    try {
      const response = await fetch(`/api/rewards/step/${step.id}/status`);
      const data = await response.json();
      
      if (!data.success || !data.hasReward || data.claimedCount === 0) {
        // No claims yet - all fields remain editable
        return;
      }
      
      const claimedCount = data.claimedCount;
      const totalCodes = data.totalCodes;
      const isRandomCodes = data.isRandomCodes;
      
      // Show claim status banner
      const statusBanner = document.getElementById('rewardClaimStatus');
      const statusText = document.getElementById('claimStatusText');
      const statusDesc = document.getElementById('claimStatusDesc');
      
      if (statusBanner && statusText && statusDesc) {
        statusBanner.classList.remove('hidden');
        statusText.textContent = window.t('builder.reward.codesClaimedStatus', { claimed: claimedCount, total: totalCodes || claimedCount });
        statusDesc.textContent = window.t('builder.reward.codeSettingsLocked');
      }
      
      // Lock code type toggle
      const codeTypeToggle = document.getElementById('codeTypeToggle');
      const codeTypeLockedNotice = document.getElementById('codeTypeLockedNotice');
      const codeTypeLockedText = document.getElementById('codeTypeLockedText');
      
      if (codeTypeToggle && codeTypeLockedNotice && codeTypeLockedText) {
        codeTypeToggle.classList.add('hidden');
        codeTypeLockedNotice.classList.remove('hidden');
        codeTypeLockedText.textContent = isRandomCodes 
          ? window.t('builder.reward.usingRandomCodes')
          : window.t('builder.reward.usingManualCodes');
      }
      
      if (isRandomCodes) {
        // Random codes: lock prefix, allow increasing max only
        const codePrefixInput = document.getElementById('propCodePrefix');
        const codePrefixLock = document.getElementById('codePrefixLock');
        
        if (codePrefixInput) {
          codePrefixInput.disabled = true;
          codePrefixInput.classList.add('bg-zen-100', 'cursor-not-allowed');
        }
        if (codePrefixLock) {
          codePrefixLock.classList.remove('hidden');
        }
        
        // If limit is enabled, only allow increasing
        const limitCheckbox = document.getElementById('propLimitRecipients');
        const maxInput = document.getElementById('propMaxRecipients');
        
        if (limitCheckbox?.checked && maxInput) {
          maxInput.min = claimedCount; // Cannot set lower than claimed count
          
          // Update description
          const maxDesc = document.getElementById('maxRecipientsDesc');
          if (maxDesc) {
            maxDesc.textContent = window.t('builder.reward.maxRecipientsMinDesc', { min: claimedCount });
          }
        }
        
        // Cannot uncheck limit if it was checked and codes were claimed
        if (limitCheckbox?.checked) {
          const limitLabel = document.getElementById('limitRecipientsLabel');
          if (limitLabel) {
            limitLabel.classList.add('opacity-60', 'cursor-not-allowed');
          }
          limitCheckbox.disabled = true;
        }
        
      } else {
        // Manual codes: show claimed vs unclaimed codes separately
        const claimedCodesList = document.getElementById('claimedCodesList');
        const claimedCodesContainer = document.getElementById('claimedCodesContainer');
        const unclaimedCodesList = document.getElementById('unclaimedCodesList');
        const unclaimedCodesContainer = document.getElementById('unclaimedCodesContainer');
        const addCodesSection = document.getElementById('addCodesSection');
        const enterCodesLabel = document.getElementById('enterCodesLabel');
        const manualCodesTextarea = document.getElementById('propManualCodesText');
        
        const claimedCodes = data.codes.filter(c => c.isClaimed);
        const unclaimedCodes = data.codes.filter(c => !c.isClaimed);
        
        // Show claimed codes (locked)
        if (claimedCodesList && claimedCodesContainer && claimedCodes.length > 0) {
          claimedCodesList.classList.remove('hidden');
          claimedCodesContainer.innerHTML = claimedCodes.map(code => `
            <div class="flex items-center justify-between py-1.5 px-2 bg-gryffi-primary/5 rounded text-sm">
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
                <code class="font-mono text-gryffi-primary">${escapeHtml(code.code)}</code>
              </div>
              <span class="text-xs text-zen-500">${escapeHtml(code.claimerName || code.claimerEmail || '-')}</span>
            </div>
          `).join('');
        }
        
        // Show unclaimed codes (can be removed)
        if (unclaimedCodesList && unclaimedCodesContainer && unclaimedCodes.length > 0) {
          unclaimedCodesList.classList.remove('hidden');
          unclaimedCodesContainer.innerHTML = unclaimedCodes.map(code => `
            <div class="flex items-center justify-between py-1.5 px-2 border border-zen-200 rounded text-sm unclaimed-code-item" data-code="${escapeHtml(code.code)}">
              <code class="font-mono text-zen-700">${escapeHtml(code.code)}</code>
              <button type="button" class="text-red-500 hover:text-red-700 remove-unclaimed-code" data-code="${escapeHtml(code.code)}" title="${window.t('common.remove')}">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </button>
            </div>
          `).join('');
          
          // Add event listeners for remove buttons
          unclaimedCodesContainer.querySelectorAll('.remove-unclaimed-code').forEach(btn => {
            btn.addEventListener('click', () => {
              const item = btn.closest('.unclaimed-code-item');
              item?.remove();
              
              // Update the hidden textarea with remaining unclaimed codes
              this.updateManualCodesFromUI(saveBasicProps);
            });
          });
        }
        
        // Clear the textarea and change label to "Add new codes"
        if (manualCodesTextarea && addCodesSection) {
          manualCodesTextarea.value = ''; // Clear - existing codes are shown above
          if (enterCodesLabel) {
            enterCodesLabel.textContent = window.t('builder.reward.addNewCodes');
          }
          manualCodesTextarea.placeholder = window.t('builder.reward.addNewCodesPlaceholder');
          
          // Update codes count display
          const countDisplay = document.getElementById('codesCountDisplay');
          if (countDisplay) {
            countDisplay.textContent = window.t('builder.reward.existingCodesCount', { 
              claimed: claimedCodes.length, 
              unclaimed: unclaimedCodes.length 
            });
          }
        }
        
        // Max recipients: minimum is claimed count
        const maxInput = document.getElementById('propMaxRecipientsManual');
        if (maxInput) {
          maxInput.min = claimedCount;
          
          const maxDesc = document.getElementById('manualMaxRecipientsDesc');
          if (maxDesc) {
            maxDesc.textContent = window.t('builder.reward.maxRecipientsMinDesc', { min: claimedCount });
          }
        }
      }
      
      // Store claim data for later use
      this.rewardClaimData = data;
      
    } catch (err) {
      console.error('[Reward] Failed to load claim status:', err);
    }
  }
  
  updateManualCodesFromUI(saveBasicProps) {
    // Collect remaining unclaimed codes from UI
    const unclaimedContainer = document.getElementById('unclaimedCodesContainer');
    const remainingCodes = [];
    
    unclaimedContainer?.querySelectorAll('.unclaimed-code-item').forEach(item => {
      const code = item.dataset.code;
      if (code) remainingCodes.push(code);
    });
    
    // Add any new codes from textarea
    const textarea = document.getElementById('propManualCodesText');
    const newCodes = textarea?.value.split(/[,\n]/).filter(c => c.trim()).map(c => c.trim()) || [];
    
    // Combine: existing unclaimed + new codes
    // Note: We don't include claimed codes here as they're stored separately
    const allCodes = [...remainingCodes, ...newCodes];
    
    // Store for saveBasicProps to use
    this.manualCodesFromUI = allCodes;
    
    // Update count display
    const claimedCount = this.rewardClaimData?.claimedCount || 0;
    const countDisplay = document.getElementById('codesCountDisplay');
    if (countDisplay) {
      countDisplay.textContent = window.t('builder.reward.existingCodesCount', { 
        claimed: claimedCount, 
        unclaimed: remainingCodes.length + newCodes.length 
      });
    }
    
    // Update max recipients max value
    const maxInput = document.getElementById('propMaxRecipientsManual');
    if (maxInput) {
      const totalCodes = claimedCount + remainingCodes.length + newCodes.length;
      maxInput.max = totalCodes || 999;
    }
    
    saveBasicProps();
  }
  
  bindFormFieldEvents(step, saveBasicProps) {
    // Add field button
    document.getElementById('addFormFieldBtn')?.addEventListener('click', () => {
      const container = document.getElementById('formFieldsContainer');
      const currentFields = container?.querySelectorAll('.form-field-item') || [];
      
      if (currentFields.length >= 5) return;
      
      const newField = {
        id: crypto.randomUUID(),
        label: '',
        type: 'text',
        required: false,
        options: ''
      };
      
      const fieldHtml = this.renderFormFieldEditor(newField, currentFields.length);
      container?.insertAdjacentHTML('beforeend', fieldHtml);
      
      // Update counter and hide button if at limit
      const countEl = container?.closest('.mt-4')?.querySelector('.text-xs.text-zen-400');
      if (countEl) {
        const count = currentFields.length + 1;
        countEl.textContent = `${count}/5 ${count === 1 ? window.t('builder.form.fieldCount', { count: count }) : window.t('builder.form.fieldCountPlural', { count: count })}`;
      }
      
      if (currentFields.length + 1 >= 5) {
        document.getElementById('addFormFieldBtn')?.classList.add('hidden');
      }
      
      // Re-bind events for new field
      this.bindFormFieldEvents(step, saveBasicProps);
      saveBasicProps();
    });
    
    // Field type change - show/hide options input and file subtype
    document.querySelectorAll('.field-type-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const fieldItem = e.target.closest('.form-field-item');
        const optionsWrapper = fieldItem?.querySelector('.field-options-wrapper');
        const fileWrapper = fieldItem?.querySelector('.field-file-wrapper');
        const isSelect = e.target.value === 'select';
        const isFile = e.target.value === 'file';
        
        // Update data attribute
        if (fieldItem) {
          fieldItem.dataset.fieldType = e.target.value;
        }
        
        // Show/hide appropriate wrappers
        optionsWrapper?.classList.toggle('hidden', !isSelect);
        fileWrapper?.classList.toggle('hidden', !isFile);
        
        // If switching to select and no options exist, add one empty option
        if (isSelect) {
          const optionsList = fieldItem?.querySelector('.field-options-list');
          if (optionsList && optionsList.children.length === 0) {
            this.addDropdownOption(fieldItem, '', saveBasicProps);
          }
        }
        
        // Check file upload limit when switching to file type
        if (isFile) {
          const container = document.getElementById('formFieldsContainer');
          const fileFields = container?.querySelectorAll('.form-field-item[data-field-type="file"]') || [];
          if (fileFields.length > 2) {
            // Revert to text type and show warning
            e.target.value = 'text';
            fieldItem.dataset.fieldType = 'text';
            fileWrapper?.classList.add('hidden');
            this.showToast(window.t('builder.form.fileUpload.maxUploadsReached'), 'warning');
          }
        }
        
        // Update upload counter
        this.updateFileUploadCounter();
        
        saveBasicProps();
      });
    });
    
    // File subtype change
    document.querySelectorAll('.field-file-subtype').forEach(select => {
      select.addEventListener('change', saveBasicProps);
    });
    
    // Remove field buttons
    document.querySelectorAll('.remove-field-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fieldItem = e.target.closest('.form-field-item');
        fieldItem?.remove();
        
        // Update counter and show add button
        const container = document.getElementById('formFieldsContainer');
        const remainingFields = container?.querySelectorAll('.form-field-item') || [];
        const countEl = container?.closest('.mt-4')?.querySelector('.text-xs.text-zen-400');
        if (countEl) {
          const count = remainingFields.length;
          countEl.textContent = `${count}/5 ${count === 1 ? window.t('builder.form.fieldCount', { count: count }) : window.t('builder.form.fieldCountPlural', { count: count })}`;
        }
        
        document.getElementById('addFormFieldBtn')?.classList.remove('hidden');
        saveBasicProps();
      });
    });
    
    // All field inputs - save on change
    document.querySelectorAll('.field-label-input').forEach(input => {
      input.addEventListener('change', saveBasicProps);
    });
    
    // Dropdown option inputs - save on change
    document.querySelectorAll('.field-option-input').forEach(input => {
      input.addEventListener('change', saveBasicProps);
      input.addEventListener('input', () => {
        // Debounced save on input for better UX
        clearTimeout(this.optionInputTimer);
        this.optionInputTimer = setTimeout(saveBasicProps, 500);
      });
    });
    
    // Add option buttons
    document.querySelectorAll('.add-option-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fieldItem = e.target.closest('.form-field-item');
        this.addDropdownOption(fieldItem, '', saveBasicProps);
        saveBasicProps();
      });
    });
    
    // Remove option buttons
    document.querySelectorAll('.remove-option-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const optionRow = e.target.closest('.field-option-row');
        const fieldItem = e.target.closest('.form-field-item');
        const optionsList = fieldItem?.querySelector('.field-options-list');
        
        // Don't remove if it's the last option
        if (optionsList && optionsList.children.length > 1) {
          optionRow?.remove();
          this.renumberDropdownOptions(fieldItem);
          this.updateRemoveOptionButtons(fieldItem);
          saveBasicProps();
        }
      });
    });
    
    document.querySelectorAll('.field-required-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', saveBasicProps);
    });
    
    // Form recipient and subject
    ['propFormDescription', 'propRecipientEmail', 'propEmailSubject'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', saveBasicProps);
    });
    
    // Initial update of file upload counter
    this.updateFileUploadCounter();
  }
  
  /**
   * Update the file upload field counter display
   */
  updateFileUploadCounter() {
    const container = document.getElementById('formFieldsContainer');
    const fileFields = container?.querySelectorAll('.form-field-item[data-field-type="file"]') || [];
    const counterEl = document.getElementById('fileUploadCounter');
    
    if (counterEl) {
      const count = fileFields.length;
      counterEl.textContent = window.t('builder.form.fileUpload.uploadCount', { count: count });
      
      // Show warning color if at max
      if (count >= 2) {
        counterEl.classList.add('text-amber-500');
        counterEl.classList.remove('text-zen-400');
      } else {
        counterEl.classList.remove('text-amber-500');
        counterEl.classList.add('text-zen-400');
      }
    }
  }
  
  /**
   * Bind file upload events for form preview
   * Handles drag & drop, file selection, validation, and Base64 conversion
   */
  bindFileUploadEvents(container) {
    const fileZones = container.querySelectorAll('.file-upload-zone');
    
    fileZones.forEach(zone => {
      const fileInput = zone.querySelector('.file-input-hidden');
      const dropzone = zone.querySelector('.file-dropzone');
      const removeBtn = zone.querySelector('.file-remove-btn');
      const subtype = zone.dataset.subtype;
      const acceptTypes = zone.dataset.accept;
      
      const maxFileSize = 12 * 1024 * 1024;
      
      // Click to open file picker
      dropzone?.addEventListener('click', (e) => {
        if (e.target === removeBtn || removeBtn?.contains(e.target)) return;
        fileInput?.click();
      });
      
      // Drag and drop events
      dropzone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('border-gryffi-accent', 'bg-gryffi-accent/10');
      });
      
      dropzone?.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropzone.classList.remove('border-gryffi-accent', 'bg-gryffi-accent/10');
      });
      
      dropzone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('border-gryffi-accent', 'bg-gryffi-accent/10');
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
          this.handleFileSelection(files[0], zone, maxFileSize, acceptTypes, subtype);
        }
      });
      
      // File input change
      fileInput?.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
          this.handleFileSelection(e.target.files[0], zone, maxFileSize, acceptTypes, subtype);
        }
      });
      
      // Remove file button
      removeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.clearFileSelection(zone);
      });
    });
  }
  
  /**
   * Handle file selection and validation
   */
  handleFileSelection(file, zone, maxFileSize, acceptTypes, subtype) {
    const dropzoneContent = zone.querySelector('.file-dropzone-content');
    const filePreview = zone.querySelector('.file-preview');
    const previewName = zone.querySelector('.file-preview-name');
    const previewSize = zone.querySelector('.file-preview-size');
    const previewIcon = zone.querySelector('.file-preview-icon');
    
    // Validate file type
    const allowedTypes = acceptTypes.split(',');
    if (!allowedTypes.some(type => file.type === type || file.type.startsWith(type.replace('/*', '/')))) {
      const formatLabel = window.t(`builder.form.fileUpload.acceptedFormats.${subtype}`) || acceptTypes;
      this.showToast(window.t('builder.form.fileUpload.invalidType', { types: formatLabel }), 'error');
      return;
    }
    
    // Validate file size
    if (file.size > maxFileSize) {
      this.showToast(window.t('builder.form.fileUpload.fileTooLarge', { size: '12' }), 'error');
      return;
    }
    
    // Read file as Base64
    const reader = new FileReader();
    reader.onload = () => {
      // Store Base64 data on the zone element
      zone.dataset.fileData = reader.result;
      zone.dataset.fileName = file.name;
      zone.dataset.fileType = file.type;
      zone.dataset.fileSize = file.size;
      
      // Update preview
      if (previewName) previewName.textContent = file.name;
      if (previewSize) previewSize.textContent = this.formatFileSize(file.size);
      
      // Set preview icon based on file type
      if (previewIcon) {
        if (file.type.startsWith('image/')) {
          // Show thumbnail for images
          previewIcon.innerHTML = `<img src="${reader.result}" class="w-12 h-12 object-cover rounded-lg" alt="Preview" />`;
        } else if (file.type.startsWith('audio/')) {
          previewIcon.innerHTML = `<svg class="w-10 h-10 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path>
          </svg>`;
        } else {
          previewIcon.innerHTML = `<svg class="w-10 h-10 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
          </svg>`;
        }
      }
      
      // Show preview, hide dropzone content
      dropzoneContent?.classList.add('hidden');
      filePreview?.classList.remove('hidden');
      
      // Update dropzone styling
      const dropzone = zone.querySelector('.file-dropzone');
      dropzone?.classList.add('border-gryffi-accent', 'bg-gryffi-accent/5');
    };
    
    reader.onerror = () => {
      this.showToast('Failed to read file', 'error');
    };
    
    reader.readAsDataURL(file);
  }
  
  /**
   * Clear file selection
   */
  clearFileSelection(zone) {
    const fileInput = zone.querySelector('.file-input-hidden');
    const dropzoneContent = zone.querySelector('.file-dropzone-content');
    const filePreview = zone.querySelector('.file-preview');
    const dropzone = zone.querySelector('.file-dropzone');
    
    // Clear stored data
    delete zone.dataset.fileData;
    delete zone.dataset.fileName;
    delete zone.dataset.fileType;
    delete zone.dataset.fileSize;
    
    // Clear file input
    if (fileInput) fileInput.value = '';
    
    // Reset UI
    dropzoneContent?.classList.remove('hidden');
    filePreview?.classList.add('hidden');
    dropzone?.classList.remove('border-gryffi-accent', 'bg-gryffi-accent/5');
  }
  
  /**
   * Format file size for display
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
  
  // Bind poll events
  bindPollEvents(step, saveBasicProps) {
    // Poll question
    document.getElementById('propPollQuestion')?.addEventListener('change', saveBasicProps);
    
    // Poll settings checkboxes
    document.getElementById('propAllowMultiple')?.addEventListener('change', saveBasicProps);
    
    // Add poll option button
    document.getElementById('addPollOptionBtn')?.addEventListener('click', () => {
      this.addPollOption(step, saveBasicProps);
    });
    
    // Existing poll option events
    document.querySelectorAll('.poll-option-input').forEach(input => {
      input.addEventListener('change', saveBasicProps);
      input.addEventListener('input', () => {
        clearTimeout(this.pollOptionTimer);
        this.pollOptionTimer = setTimeout(saveBasicProps, 500);
      });
    });
    
    // Remove poll option buttons
    document.querySelectorAll('.remove-poll-option-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const optionItem = e.target.closest('.poll-option-item');
        const container = document.getElementById('pollOptionsContainer');
        if (container && container.children.length > 2) {
          optionItem?.remove();
          this.renumberPollOptions();
          saveBasicProps();
        }
      });
    });
    
    // Reset poll button
    document.getElementById('resetPollBtn')?.addEventListener('click', async () => {
      if (await window.gryffi.modal.confirm(window.t('builder.messages.resetPollConfirm'))) {
        await this.resetPollResponses(step);
      }
    });
  }
  
  // Reset poll responses via API
  async resetPollResponses(step) {
    const resetBtn = document.getElementById('resetPollBtn');
    const originalText = resetBtn?.innerHTML;
    
    if (resetBtn) {
      resetBtn.disabled = true;
      resetBtn.innerHTML = `
        <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
        </svg>
        ${window.t('common.loading')}
      `;
    }
    
    try {
      const response = await fetch(`/api/polls/${step.id}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.showToast(window.t('builder.poll.resetSuccess'), 'success');
      } else {
        this.showToast(data.error || window.t('builder.poll.resetError'), 'error');
      }
    } catch (err) {
      console.error('Reset poll error:', err);
      this.showToast(window.t('builder.poll.resetError'), 'error');
    } finally {
      if (resetBtn && originalText) {
        resetBtn.disabled = false;
        resetBtn.innerHTML = originalText;
      }
    }
  }
  
  // Helper: Add a new poll option
  addPollOption(step, saveBasicProps) {
    const container = document.getElementById('pollOptionsContainer');
    if (!container) return;
    
    const optionCount = container.children.length;
    if (optionCount >= 10) return;
    
    const newOption = {
      id: crypto.randomUUID(),
      text: ''
    };
    
    const optionHtml = this.renderPollOptionEditor(newOption, optionCount);
    container.insertAdjacentHTML('beforeend', optionHtml);
    
    // Bind events for new option
    const newItem = container.lastElementChild;
    const newInput = newItem.querySelector('.poll-option-input');
    const newRemoveBtn = newItem.querySelector('.remove-poll-option-btn');
    
    newInput?.addEventListener('change', saveBasicProps);
    newInput?.addEventListener('input', () => {
      clearTimeout(this.pollOptionTimer);
      this.pollOptionTimer = setTimeout(saveBasicProps, 500);
    });
    
    newRemoveBtn?.addEventListener('click', (_e) => {
      if (container.children.length > 2) {
        newItem?.remove();
        this.renumberPollOptions();
        saveBasicProps();
      }
    });
    
    // Hide add button if max reached
    if (container.children.length >= 10) {
      document.getElementById('addPollOptionBtn')?.classList.add('hidden');
    }
    
    // Focus new input
    newInput?.focus();
    saveBasicProps();
  }
  
  // Helper: Renumber poll options
  renumberPollOptions() {
    document.querySelectorAll('.poll-option-item').forEach((item, index) => {
      const numberSpan = item.querySelector('.text-zen-400');
      if (numberSpan) {
        numberSpan.textContent = `${index + 1}.`;
      }
      item.dataset.optionIndex = index;
    });
    
    // Show add button if below max
    const container = document.getElementById('pollOptionsContainer');
    if (container && container.children.length < 10) {
      document.getElementById('addPollOptionBtn')?.classList.remove('hidden');
    }
  }
  
  // Helper: Add a new dropdown option to a field
  addDropdownOption(fieldItem, value = '', saveBasicProps) {
    const optionsList = fieldItem?.querySelector('.field-options-list');
    if (!optionsList) return;
    
    const optionCount = optionsList.children.length;
    const newIndex = optionCount + 1;
    
    const optionHtml = `
      <div class="field-option-row flex items-center gap-2">
        <span class="text-xs text-zen-400 w-5">${newIndex}.</span>
        <input type="text" class="field-option-input form-input text-sm flex-1" value="${this.escapeHtml(value)}" placeholder="${window.t('builder.form.optionPlaceholder')}" />
        <button type="button" class="remove-option-btn text-zen-500 hover:text-red-500 hover:bg-red-50 p-1.5 rounded transition-colors" title="${window.t('builder.form.removeOption')}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    `;
    
    optionsList.insertAdjacentHTML('beforeend', optionHtml);
    
    // Bind events for new option
    const newRow = optionsList.lastElementChild;
    const newInput = newRow.querySelector('.field-option-input');
    const newRemoveBtn = newRow.querySelector('.remove-option-btn');
    
    newInput?.addEventListener('change', saveBasicProps);
    newInput?.addEventListener('input', () => {
      clearTimeout(this.optionInputTimer);
      this.optionInputTimer = setTimeout(saveBasicProps, 500);
    });
    
    newRemoveBtn?.addEventListener('click', (e) => {
      const optionRow = e.target.closest('.field-option-row');
      if (optionsList.children.length > 1) {
        optionRow?.remove();
        this.renumberDropdownOptions(fieldItem);
        this.updateRemoveOptionButtons(fieldItem);
        saveBasicProps();
      }
    });
    
    // Update all remove buttons visibility
    this.updateRemoveOptionButtons(fieldItem);
    
    // Focus the new input
    newInput?.focus();
  }
  
  // Helper: Renumber dropdown options after removal
  renumberDropdownOptions(fieldItem) {
    const optionRows = fieldItem?.querySelectorAll('.field-option-row');
    optionRows?.forEach((row, index) => {
      const numberSpan = row.querySelector('.text-xs.text-zen-400');
      if (numberSpan) {
        numberSpan.textContent = `${index + 1}.`;
      }
    });
  }
  
  // Helper: Update remove button visibility (disable if only 1 option)
  updateRemoveOptionButtons(fieldItem) {
    const optionRows = fieldItem?.querySelectorAll('.field-option-row');
    const removeButtons = fieldItem?.querySelectorAll('.remove-option-btn');
    
    removeButtons?.forEach(btn => {
      if (optionRows && optionRows.length <= 1) {
        btn.classList.add('opacity-30', 'pointer-events-none');
      } else {
        btn.classList.remove('opacity-30', 'pointer-events-none');
      }
    });
  }
  
  // ============================================
  // GUIDE STEP EVENTS
  // ============================================
  
  bindGuideStepEvents(step) {
    const guideSelect = document.getElementById('propGuideId');
    const previewCard = document.getElementById('guidePreviewCard');
    const manageBtn = document.getElementById('manageGuidesBtn');
    
    // Update preview when guide selection changes
    guideSelect?.addEventListener('change', async (e) => {
      const guideId = e.target.value;
      const guide = this.guides.find(g => g.id === guideId);
      
      if (guide) {
        // Show and update preview card
        previewCard?.classList.remove('hidden');
        
        const personalityLabels = {
          friendly: '😊 Friendly',
          professional: '👔 Professional',
          helpful: '🤝 Helpful',
          cheerful: '🌟 Cheerful',
          wise: '🦉 Wise'
        };
        
        const avatarEl = document.getElementById('guidePreviewAvatar');
        if (avatarEl) {
          if (guide.avatar_url) {
            avatarEl.innerHTML = `<img src="${escapeHtml(guide.avatar_url)}" alt="${escapeHtml(guide.name)}" class="w-full h-full object-cover">`;
          } else {
            avatarEl.innerHTML = guide.name.charAt(0).toUpperCase();
          }
        }
        document.getElementById('guidePreviewName').textContent = guide.name;
        document.getElementById('guidePreviewRole').textContent = guide.role || window.t('builder.preview.aiAssistant');
        document.getElementById('guidePreviewPersonality').textContent = personalityLabels[guide.personality] || '😊 Friendly';
        document.getElementById('guidePreviewKnowledge').textContent = `📚 ${guide.knowledge_count || 0} knowledge sources`;
        document.getElementById('guidePreviewUsage').textContent = `Used in ${guide.journey_count || 0} journeys`;
      } else {
        // Hide preview card
        previewCard?.classList.add('hidden');
      }
      
      // Save the basic props
      const basicProps = this.collectBasicProps(step);
      await this.updateStep(step.id, { basic_props: basicProps });
      
      // Update step in local array
      const localStep = this.steps.find(s => s.id === step.id);
      if (localStep) {
        localStep.basic_props = basicProps;
      }
      
      // Update step title to match guide name
      if (guide && guide.name) {
        const titleInput = document.getElementById('propTitle');
        if (titleInput && titleInput.value === 'New Guide') {
          titleInput.value = `Chat with ${guide.name}`;
          await this.updateStep(step.id, { title: titleInput.value });
          if (localStep) localStep.title = titleInput.value;
        }
      }
      
      this.render();
    });
    
    // Manage Guides button - save journey first, then navigate
    manageBtn?.addEventListener('click', async () => {
      // Save the journey before navigating
      await this.saveJourney();
      
      // Also save current step if there are unsaved changes
      const basicProps = this.collectBasicProps(step);
      const advancedProps = this.collectAdvancedProps(step);
      await this.updateStep(step.id, { 
        title: document.getElementById('propTitle')?.value || step.title,
        basic_props: basicProps, 
        advanced_props: advancedProps 
      });
      
      this.showToast(window.t('builder.messages.savedOpeningGuides'), 'success');
      
      // Navigate to guides page
      window.location.href = '/dashboard/guides';
    });
  }
  
  // ============================================
  // KNOWLEDGE BASE UI (Legacy - for step-specific knowledge)
  // ============================================
  
  bindKnowledgeEvents(step) {
    // Load existing knowledge sources
    this.loadKnowledgeSources(step.id);
    
    // Refresh button
    document.getElementById('refreshKnowledge')?.addEventListener('click', () => {
      this.loadKnowledgeSources(step.id);
    });
    
    // Upload file button
    document.getElementById('addKnowledgeFile')?.addEventListener('click', () => {
      this.showKnowledgeUploadModal(step);
    });
    
    // Add text button
    document.getElementById('addKnowledgeText')?.addEventListener('click', () => {
      this.showKnowledgeTextModal(step);
    });
  }
  
  async loadKnowledgeSources(stepId) {
    try {
      const response = await fetch(`/api/knowledge/${stepId}`);
      const data = await response.json();
      
      if (data.success) {
        this.renderKnowledgeSources(data.sources, data.stats);
      }
    } catch (err) {
      console.error('Failed to load knowledge sources:', err);
    }
  }
  
  renderKnowledgeSources(sources, stats) {
    const container = document.getElementById('knowledgeSources');
    const countBadge = document.getElementById('knowledgeCount');
    const emptyState = document.getElementById('knowledgeEmpty');
    
    if (!container) return;
    
    // Update count badge
    if (countBadge && stats) {
      const count = parseInt(stats.total_sources) || 0;
      if (count > 0) {
        countBadge.textContent = count;
        countBadge.classList.remove('hidden');
      } else {
        countBadge.classList.add('hidden');
      }
    }
    
    if (!sources || sources.length === 0) {
      if (emptyState) emptyState.classList.remove('hidden');
      container.innerHTML = '';
      return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');
    
    container.innerHTML = sources.map(source => this.renderKnowledgeSourceItem(source)).join('');
    
    // Bind delete buttons
    container.querySelectorAll('.delete-knowledge').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sourceId = btn.dataset.sourceId;
        const stepId = document.getElementById('knowledgeSection')?.dataset.stepId;
        
        if (await window.gryffi.modal.confirm(window.t('builder.messages.deleteKnowledgeConfirm'))) {
          try {
            const response = await fetch(`/api/knowledge/${stepId}/${sourceId}`, {
              method: 'DELETE'
            });
            if (response.ok) {
              this.loadKnowledgeSources(stepId);
              this.showToast(window.t('builder.messages.knowledgeSourceDeleted'), 'success');
            }
          } catch (_err) {
            this.showToast(window.t('builder.messages.deleteFailed'), 'error');
          }
        }
      });
    });
  }
  
  renderKnowledgeSourceItem(source) {
    const statusColors = {
      pending: 'bg-yellow-100 text-yellow-700',
      processing: 'bg-blue-100 text-blue-700',
      completed: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700'
    };
    
    const statusIcons = {
      pending: '⏳',
      processing: '⚙️',
      completed: '✓',
      failed: '✗'
    };
    
    const typeIcons = {
      file: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>`,
      text: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>`,
      url: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>`
    };
    
    return `
      <div class="flex items-center gap-3 p-2 bg-white border border-zen-100 rounded-lg hover:border-zen-200 transition-colors">
        <div class="text-zen-400">
          ${typeIcons[source.source_type] || typeIcons.file}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-zen-800 truncate">${escapeHtml(source.source_name)}</div>
          <div class="text-xs text-zen-400">
            ${source.chunks_count || 0} chunks
            ${source.error_message ? ` • ${escapeHtml(source.error_message)}` : ''}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 text-xs rounded ${statusColors[source.status] || statusColors.pending}">
            ${statusIcons[source.status] || '?'} ${escapeHtml(source.status)}
          </span>
          <button class="delete-knowledge p-1 text-zen-400 hover:text-red-500 transition-colors" data-source-id="${source.id}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
  }
  
  showKnowledgeUploadModal(step) {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50';
    modal.id = 'knowledgeUploadModal';
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div class="p-4 border-b border-zen-100 flex items-center justify-between">
          <h3 class="font-semibold text-zen-900">Upload Knowledge File</h3>
          <button id="closeKnowledgeUpload" class="text-zen-400 hover:text-zen-600">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <div class="p-4">
          <p class="text-sm text-zen-600 mb-4">
            Upload documents (PDF, Word, Excel, PowerPoint), text files, or images (for OCR text extraction).
          </p>
          <div class="border-2 border-dashed border-zen-200 rounded-lg p-8 text-center hover:border-gryffi-accent transition-colors cursor-pointer" id="knowledgeDropZone">
            <svg class="w-12 h-12 mx-auto text-zen-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path>
            </svg>
            <p class="text-zen-600 font-medium">Click to upload or drag and drop</p>
            <p class="text-sm text-zen-400 mt-1">PDF, DOCX, XLSX, PPTX, TXT, PNG, JPG (max 50MB)</p>
            <input type="file" id="knowledgeFileInput" class="hidden" accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.gif" />
          </div>
          <div id="knowledgeUploadProgress" class="hidden mt-4">
            <div class="flex items-center gap-3">
              <div class="animate-spin w-5 h-5 border-2 border-gryffi-accent border-t-transparent rounded-full"></div>
              <span class="text-sm text-zen-600">Uploading and processing...</span>
            </div>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    const fileInput = document.getElementById('knowledgeFileInput');
    const dropZone = document.getElementById('knowledgeDropZone');
    const progressDiv = document.getElementById('knowledgeUploadProgress');
    
    // Click to open file dialog
    dropZone.addEventListener('click', () => fileInput.click());
    
    // Drag and drop
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-gryffi-accent');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-gryffi-accent');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-gryffi-accent');
      if (e.dataTransfer.files.length > 0) {
        this.uploadKnowledgeFile(step, e.dataTransfer.files[0], progressDiv, modal);
      }
    });
    
    // File input change
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        this.uploadKnowledgeFile(step, fileInput.files[0], progressDiv, modal);
      }
    });
    
    // Close modal
    document.getElementById('closeKnowledgeUpload').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  }
  
  async uploadKnowledgeFile(step, file, progressDiv, modal) {
    progressDiv.classList.remove('hidden');
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const response = await fetch(`/api/knowledge/${step.id}/upload`, {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.showToast(window.t('builder.messages.fileUploaded'), 'success');
        modal.remove();
        this.loadKnowledgeSources(step.id);
        
        // Poll for completion
        this.pollKnowledgeStatus(step.id, data.source.id);
      } else {
        this.showToast(window.t('builder.props.uploadFailed') + ': ' + (data.error || window.t('builder.props.unknownError')), 'error');
        progressDiv.classList.add('hidden');
      }
    } catch (_err) {
      this.showToast(window.t('builder.props.uploadFailed'), 'error');
      progressDiv.classList.add('hidden');
    }
  }
  
  async pollKnowledgeStatus(stepId, sourceId, attempts = 0) {
    if (attempts > 60) return; // Give up after 5 minutes
    
    try {
      const response = await fetch(`/api/knowledge/${stepId}/status/${sourceId}`);
      const data = await response.json();
      
      if (data.status === 'completed') {
        this.showToast(window.t('builder.messages.knowledgeProcessed'), 'success');
        this.loadKnowledgeSources(stepId);
      } else if (data.status === 'failed') {
        this.showToast(window.t('builder.props.processingFailed') + ': ' + (data.errorMessage || window.t('builder.props.unknownError')), 'error');
        this.loadKnowledgeSources(stepId);
      } else {
        // Still processing, poll again in 5 seconds
        setTimeout(() => this.pollKnowledgeStatus(stepId, sourceId, attempts + 1), 5000);
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }
  
  showKnowledgeTextModal(step) {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50';
    modal.id = 'knowledgeTextModal';
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
        <div class="p-4 border-b border-zen-100 flex items-center justify-between">
          <h3 class="font-semibold text-zen-900">Add Knowledge Text</h3>
          <button id="closeKnowledgeText" class="text-zen-400 hover:text-zen-600">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <div class="p-4 space-y-4">
          <div>
            <label class="block text-sm font-medium text-zen-700 mb-1">Title</label>
            <input type="text" id="knowledgeTextName" class="w-full px-3 py-2 border border-zen-200 rounded-lg focus:ring-2 focus:ring-gryffi-accent focus:border-gryffi-accent" placeholder="${window.t('builder.props.parkingInformationExample')}" />
          </div>
          <div>
            <label class="block text-sm font-medium text-zen-700 mb-1">${window.t('builder.props.contentLabel')}</label>
            <textarea id="knowledgeTextContent" class="w-full px-3 py-2 border border-zen-200 rounded-lg focus:ring-2 focus:ring-gryffi-accent focus:border-gryffi-accent" rows="8" placeholder="${window.t('builder.props.enterInformationPlaceholder')}"></textarea>
            <p class="text-xs text-zen-400 mt-1">${window.t('builder.props.textWillBeUsed')}</p>
          </div>
        </div>
        <div class="p-4 border-t border-zen-100 flex justify-end gap-2">
          <button id="cancelKnowledgeText" class="px-4 py-2 text-zen-600 hover:bg-zen-100 rounded-lg transition-colors">Cancel</button>
          <button id="saveKnowledgeText" class="px-4 py-2 bg-gryffi-primary text-white rounded-lg hover:bg-gryffi-primary/90 transition-colors">Add Knowledge</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close handlers
    document.getElementById('closeKnowledgeText').addEventListener('click', () => modal.remove());
    document.getElementById('cancelKnowledgeText').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
    
    // Save handler
    document.getElementById('saveKnowledgeText').addEventListener('click', async () => {
      const name = document.getElementById('knowledgeTextName').value.trim();
      const text = document.getElementById('knowledgeTextContent').value.trim();
      
      if (!name || !text) {
        this.showToast(window.t('builder.messages.fillBothFields'), 'error');
        return;
      }
      
      try {
        const response = await fetch(`/api/knowledge/${step.id}/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, text })
        });
        
        const data = await response.json();
        
        if (data.success) {
          this.showToast(window.t('builder.messages.knowledgeAdded'), 'success');
          modal.remove();
          this.loadKnowledgeSources(step.id);
          
          // Poll for completion
          this.pollKnowledgeStatus(step.id, data.source.id);
        } else {
          this.showToast(window.t('builder.props.unknownError') + ': ' + (data.error || window.t('builder.props.unknownError')), 'error');
        }
      } catch (_err) {
        this.showToast(window.t('builder.messages.knowledgeAddFailed'), 'error');
      }
    });
  }
  
  collectBasicProps(step) {
    const props = {};
    
    switch (step.type) {
      case 'space':
        props.description = document.getElementById('propDescription')?.value || '';
        const isPanoramaMode = document.getElementById('propPanoramaImage')?.checked || false;
        props.is_panorama = isPanoramaMode;
        // Get the correct image URL based on the mode
        if (isPanoramaMode) {
          props.image_url = document.getElementById('propPanoramaUrl')?.value || null;
        } else {
          props.image_url = document.getElementById('propImageUrl')?.value || null;
        }
        // Floorplan data
        const floorplanEnabled = document.getElementById('propFloorplanEnabled')?.checked || false;
        const floorplanId = document.getElementById('propFloorplanId')?.value || null;
        const markerX = document.getElementById('propFloorplanMarkerX')?.value || null;
        const markerY = document.getElementById('propFloorplanMarkerY')?.value || null;
        if (floorplanEnabled && floorplanId) {
          props.floorplan = {
            enabled: true,
            floorplan_id: floorplanId,
            marker_x: markerX ? parseFloat(markerX) : null,
            marker_y: markerY ? parseFloat(markerY) : null
          };
        } else {
          props.floorplan = { enabled: false };
        }
        break;
        
      case 'guide':
        props.guide_id = document.getElementById('propGuideId')?.value || null;
        // Get guide details from the central library
        const selectedGuideForProps = this.guides.find(g => g.id === props.guide_id);
        if (selectedGuideForProps) {
          props.name = selectedGuideForProps.name;
          props.role = selectedGuideForProps.role || '';
          props.personality = selectedGuideForProps.personality || 'friendly';
          props.greeting = selectedGuideForProps.greeting || '';
        }
        break;
        
      case 'content':
        props.media_type = document.getElementById('propMediaType')?.value || 'text';
        // Get content from the contenteditable editor
        const editor = document.getElementById('propBodyEditor');
        props.body = editor ? editor.innerHTML : '';
        props.video_url = document.getElementById('propVideoUrl')?.value || '';
        props.image_url = document.getElementById('propContentImageUrl')?.value || '';
        
        // Get media description and text position based on media type
        if (props.media_type === 'video') {
          props.media_description = document.getElementById('propVideoDescription')?.value || '';
          props.text_position = document.querySelector('input[name="videoTextPosition"]:checked')?.value || 'above';
        } else if (props.media_type === 'image') {
          props.media_description = document.getElementById('propImageDescription')?.value || '';
          props.text_position = document.querySelector('input[name="imageTextPosition"]:checked')?.value || 'above';
        }
        break;
        
      case 'challenge':
        // Use new quiz format with multiple questions
        props.questions = this.collectQuizQuestions();
        props.type = 'multiple_choice';
        // Preserve shuffle_questions setting
        props.shuffle_questions = document.getElementById('shuffleQuestionsToggle')?.checked || false;
        break;
        
      case 'form':
        props.description = document.getElementById('propFormDescription')?.value || '';
        props.recipient_email = document.getElementById('propRecipientEmail')?.value || '';
        props.email_subject = document.getElementById('propEmailSubject')?.value || 'Form submission: {{journey_title}}';
        props.fields = [];
        document.querySelectorAll('.form-field-item').forEach((fieldEl) => {
          const fieldId = fieldEl.dataset.fieldId;
          const fieldType = fieldEl.querySelector('.field-type-select')?.value || 'text';
          
          // Collect options from individual inputs for dropdown fields
          let options = '';
          if (fieldType === 'select') {
            const optionInputs = fieldEl.querySelectorAll('.field-option-input');
            const optionValues = [];
            optionInputs.forEach(input => {
              const val = input.value.trim();
              if (val) optionValues.push(val);
            });
            options = optionValues.join(',');
          }
          
          // Collect file subtype for file fields
          let fileSubtype = null;
          if (fieldType === 'file') {
            fileSubtype = fieldEl.querySelector('.field-file-subtype')?.value || 'image';
          }
          
          props.fields.push({
            id: fieldId,
            label: fieldEl.querySelector('.field-label-input')?.value || '',
            type: fieldType,
            required: fieldEl.querySelector('.field-required-checkbox')?.checked || false,
            options: options,
            fileSubtype: fileSubtype
          });
        });
        break;
        
      case 'poll':
        props.question = document.getElementById('propPollQuestion')?.value || '';
        props.is_required = document.getElementById('propIsRequired')?.checked ?? true;
        props.allow_multiple = document.getElementById('propAllowMultiple')?.checked || false;
        props.show_results = true; // Always show results after voting
        props.options = [];
        document.querySelectorAll('.poll-option-item').forEach((optEl) => {
          const optionId = optEl.dataset.optionId;
          const optionText = optEl.querySelector('.poll-option-input')?.value || '';
          if (optionText.trim()) {
            props.options.push({
              id: optionId || crypto.randomUUID(),
              text: optionText.trim()
            });
          }
        });
        break;
        
      case 'reward':
        props.title = document.getElementById('propRewardTitle')?.value || '';
        props.description = document.getElementById('propRewardDescription')?.value || '';
        props.redemption_location = document.getElementById('propRedemptionLocation')?.value || '';
        props.terms_conditions = document.getElementById('propTermsConditions')?.value || '';
        props.valid_until = document.getElementById('propValidUntil')?.value || null;
        
        // If codes have been claimed, preserve the original code type
        const hasClaims = this.rewardClaimData?.claimedCount > 0;
        props.is_random_codes = hasClaims 
          ? this.rewardClaimData.isRandomCodes 
          : (document.getElementById('propRandomCodes')?.checked ?? true);
        
        if (props.is_random_codes) {
          // Only set max_recipients if the limit checkbox is checked
          const limitChecked = document.getElementById('propLimitRecipients')?.checked;
          const maxValue = document.getElementById('propMaxRecipients')?.value;
          
          if (limitChecked && maxValue) {
            let maxRecipients = parseInt(maxValue);
            // If claims exist, ensure max is not lower than claimed count
            if (hasClaims && maxRecipients < this.rewardClaimData.claimedCount) {
              maxRecipients = this.rewardClaimData.claimedCount;
            }
            props.max_recipients = maxRecipients;
          } else {
            props.max_recipients = null;
          }
          
          // If claims exist, preserve original prefix
          props.code_prefix = hasClaims 
            ? this.rewardClaimData.codePrefix 
            : (document.getElementById('propCodePrefix')?.value || '');
          props.manual_codes = '';
        } else {
          // Manual codes - combine claimed codes + remaining unclaimed + new codes
          let allCodes = [];
          
          if (hasClaims) {
            // Get claimed codes (these must be preserved)
            const claimedCodes = this.rewardClaimData.codes.filter(c => c.isClaimed).map(c => c.code);
            
            // Get remaining unclaimed codes from UI
            const unclaimedContainer = document.getElementById('unclaimedCodesContainer');
            const remainingUnclaimed = [];
            unclaimedContainer?.querySelectorAll('.unclaimed-code-item').forEach(item => {
              const code = item.dataset.code;
              if (code) remainingUnclaimed.push(code);
            });
            
            // Get new codes from textarea
            const newCodes = document.getElementById('propManualCodesText')?.value
              .split(/[,\n]/)
              .filter(c => c.trim())
              .map(c => c.trim()) || [];
            
            allCodes = [...claimedCodes, ...remainingUnclaimed, ...newCodes];
          } else {
            // No claims yet - just use textarea value
            allCodes = document.getElementById('propManualCodesText')?.value
              .split(/[,\n]/)
              .filter(c => c.trim())
              .map(c => c.trim()) || [];
          }
          
          props.manual_codes = allCodes.join('\n');
          
          // Max recipients
          const maxManualValue = document.getElementById('propMaxRecipientsManual')?.value;
          if (maxManualValue) {
            let maxRecipients = parseInt(maxManualValue);
            // Ensure max is not lower than claimed count
            if (hasClaims && maxRecipients < this.rewardClaimData.claimedCount) {
              maxRecipients = this.rewardClaimData.claimedCount;
            }
            // Ensure max is not higher than total codes
            if (maxRecipients > allCodes.length) {
              maxRecipients = allCodes.length;
            }
            props.max_recipients = maxRecipients;
          } else {
            props.max_recipients = null;
          }
          
          props.code_prefix = '';
        }
        break;
        
      case 'nested_journey':
        props.nested_journey_id = document.getElementById('propNestedJourneyId')?.value || null;
        break;
    }
    
    return props;
  }
  
  collectAdvancedProps(step) {
    const props = {};
    
    // Get pacing value (applies to space, guide, and content)
    const pacingRadio = document.querySelector('[name="advPacing"]:checked');
    if (pacingRadio) {
      props.pacing = pacingRadio.value;
    }
    
    // Get step assistant (applies to space, content, challenge, form)
    if (step.type !== 'guide') {
      const assistantGuide = document.getElementById('advAssistantGuide')?.value;
      props.assistant_guide_id = assistantGuide || null;
    }
    
    switch (step.type) {
      case 'space':
        // Space steps have no special advanced props
        break;
        
      case 'guide':
        props.step_context = document.getElementById('advStepContext')?.value || '';
        break;
        
      case 'content':
        // Content steps have no special advanced props beyond pacing and assistant
        break;
        
      case 'challenge':
        props.passing_score = parseInt(document.getElementById('advPassingScore')?.value) || 0;
        props.show_feedback = document.getElementById('advShowFeedback')?.checked !== false;
        props.allow_retake = document.getElementById('advAllowRetake')?.checked !== false;
        props.pass_message = document.getElementById('advPassMessage')?.value || null;
        props.fail_message = document.getElementById('advFailMessage')?.value || null;
        break;
        
      case 'form':
        const formCompletionRadio = document.querySelector('[name="advFormCompletion"]:checked');
        props.completion_requirement = formCompletionRadio?.value || 'after_submit';
        props.confirmation_message = document.getElementById('advConfirmationMessage')?.value || 'Thank you! Your response has been submitted.';
        break;
    }
    
    return props;
  }
  
  async testAutomation(automation, stepId = null) {
    const testEmail = await window.gryffi.modal.prompt(window.t('builder.messages.enterTestEmail'));
    if (!testEmail) return;
    
    try {
      const response = await fetch('/api/automations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          automation,
          test_email: testEmail,
          journey_id: this.journey.id,
          step_id: stepId
        })
      });
      
      const data = await response.json();
      if (data.success) {
        this.showToast(window.t('builder.messages.testEmailSent'), 'success');
      } else {
        this.showToast(window.t('builder.props.failedToSendTestEmail') + ': ' + (data.error || window.t('builder.props.unknownError')), 'error');
      }
    } catch (err) {
      console.error('Test automation error:', err);
      this.showToast(window.t('builder.props.failedToSendTestEmail'), 'error');
    }
  }
  
  /**
   * Trigger automations for a specific event
   * @param {string} trigger - The trigger type (on_journey_start, on_step_enter, etc.)
   * @param {string} stepId - The step ID (if applicable)
   * @param {string} pathId - The path ID (if applicable, for on_path triggers)
   */
  async triggerAutomation(trigger, stepId = null, pathId = null) {
    try {
      // Skip automations for public journeys (no user email to send to)
      if (window.GRYFFI?.publicMode) {
        console.log(`[Automation] Skipped for public journey: ${trigger}`);
        return;
      }
      
      // Use different endpoint for player mode vs preview mode
      const automationEndpoint = this.playerMode && this.player?.token 
        ? `/e/${this.player.token}/automations/trigger`
        : '/api/automations/trigger';
      
      const response = await fetch(automationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger,
          journey_id: this.journey.id,
          step_id: stepId,
          path_id: pathId,
          user_email: null // Server will use current session user for preview, or end_user for player mode
        })
      });
      
      const data = await response.json();
      if (data.triggered > 0) {
        console.log(`[Automation] Triggered ${data.triggered} email(s) for: ${trigger}`);
        // Only show toast in builder mode, not in player mode
        if (!this.playerMode) {
          this.showToast(window.t('builder.messages.automationTriggered'), 'success');
        }
      } else if (data.success) {
        console.log(`[Automation] No automations matched: ${trigger}`);
      }
    } catch (err) {
      console.error('[Automation] Trigger error:', err);
    }
  }
  
  bindJourneySettingsEvents() {
    // Tab switching
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        const tabName = tab.dataset.tab;
        document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.add('hidden'));
        document.getElementById(`${tabName}Tab`)?.classList.remove('hidden');
      });
    });
    
    // Close panel
    document.getElementById('closePanel')?.addEventListener('click', () => this.closeProperties());
    
    // General settings
    document.getElementById('journeyTitle')?.addEventListener('change', async (e) => {
      this.journey.title = e.target.value;
      await this.saveJourney();
      // Update header title
      document.querySelector('header h1').textContent = e.target.value;
    });
    
    document.getElementById('journeyDescription')?.addEventListener('change', async (e) => {
      this.journey.description = e.target.value;
      await this.saveJourney();
    });
    
    // Journey Flow - Start Step
    document.getElementById('journeyStartStep')?.addEventListener('change', async (e) => {
      const newStartId = e.target.value;
      
      // Clear existing start step
      this.steps.forEach(s => {
        if (s.is_start) {
          s.is_start = false;
          this.updateStep(s.id, { is_start: false });
        }
      });
      
      // Set new start step
      if (newStartId) {
        const step = this.steps.find(s => s.id === newStartId);
        if (step) {
          step.is_start = true;
          await this.updateStep(newStartId, { is_start: true });
        }
      }
      
      // Re-render all steps to update badges
      this.render();
    });
    
    // Journey Flow - End Steps (dropdown-based)
    this.bindEndStepsEvents();
    
    // Journey automations
    document.getElementById('addJourneyAutomation')?.addEventListener('click', () => {
      this.showAddAutomationModal(null, 'journey');
    });
    
    // Test automation buttons (journey level)
    document.querySelectorAll('.test-automation').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index);
        const automations = this.journey.automations || [];
        this.testAutomation(automations[index], null);
      });
    });
    
    document.querySelectorAll('.edit-automation').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index);
        const automations = this.journey.automations || [];
        this.showEditAutomationModal(null, automations[index], index, 'journey');
      });
    });
    
    document.querySelectorAll('.delete-automation').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (await window.gryffi.modal.confirm(window.t('builder.messages.deleteAutomationConfirm'))) {
          const index = parseInt(btn.dataset.index);
          const automations = [...(this.journey.automations || [])];
          automations.splice(index, 1);
          this.journey.automations = automations;
          await this.saveJourney();
          this.showJourneySettings();
        }
      });
    });
    
    // Language override toggle
    document.getElementById('languageOverrideToggle')?.addEventListener('change', async (e) => {
      this.journey.language_override = e.target.checked;
      const optionsDiv = document.getElementById('languageOverrideOptions');
      if (e.target.checked) {
        optionsDiv?.classList.remove('hidden');
        // Set default language if not set
        if (!this.journey.language_code) {
          this.journey.language_code = window.GRYFFI?.organization?.defaultLanguage || 'en';
          const select = document.getElementById('journeyLanguageCode');
          if (select) select.value = this.journey.language_code;
        }
      } else {
        optionsDiv?.classList.add('hidden');
        this.journey.language_code = null;
      }
      await this.saveJourney();
    });
    
    // Language code select
    document.getElementById('journeyLanguageCode')?.addEventListener('change', async (e) => {
      this.journey.language_code = e.target.value;
      await this.saveJourney();
    });
    
    // AI Guide language override toggle
    document.getElementById('guideLanguageOverrideToggle')?.addEventListener('change', async (e) => {
      this.journey.guide_language_override = e.target.checked;
      const optionsDiv = document.getElementById('guideLanguageOverrideOptions');
      if (e.target.checked) {
        optionsDiv?.classList.remove('hidden');
        if (!this.journey.guide_language_code) {
          this.journey.guide_language_code = window.GRYFFI?.organization?.defaultLanguage || 'en';
          const select = document.getElementById('journeyGuideLanguageCode');
          if (select) select.value = this.journey.guide_language_code;
        }
      } else {
        optionsDiv?.classList.add('hidden');
        this.journey.guide_language_code = null;
        this.journey.guide_opening_override = '';
        const openingTextarea = document.getElementById('journeyGuideOpeningOverride');
        if (openingTextarea) openingTextarea.value = '';
      }
      await this.saveJourney();
    });
    
    // AI Guide language code select
    document.getElementById('journeyGuideLanguageCode')?.addEventListener('change', async (e) => {
      this.journey.guide_language_code = e.target.value;
      await this.saveJourney();
    });
    
    // AI Guide opening override textarea
    document.getElementById('journeyGuideOpeningOverride')?.addEventListener('change', async (e) => {
      this.journey.guide_opening_override = e.target.value;
      await this.saveJourney();
    });
  }
  
  showAddAutomationModal(step, context) {
    const isJourney = context === 'journey';
    const stepPaths = step ? this.paths.filter(p => p.from_step_id === step.id) : [];
    
    const triggers = isJourney ? `
      <option value="on_journey_start">${window.t('builder.automations.triggers.whenJourneyStarts')}</option>
      <option value="on_journey_complete">${window.t('builder.automations.triggers.whenJourneyCompletes')}</option>
      <option value="on_inactivity">${window.t('builder.automations.daysOfInactivity')}</option>
    ` : `
      <option value="on_step_enter">${window.t('builder.automations.triggers.whenUserEntersStep')}</option>
      <option value="on_step_complete">${window.t('builder.automations.triggers.whenUserCompletesStep')}</option>
      ${stepPaths.length > 0 ? stepPaths.map(p => 
        `<option value="on_path:${p.id}">${window.t('builder.automations.triggers.whenUserChoosesPath')} "${escapeHtml(p.label)}"</option>`
      ).join('') : ''}
    `;
    
    const EMAIL_TEMPLATES = getEmailTemplates();
    const templateOptions = `<option value="">${window.t('builder.automations.selectTemplate')}</option>` +
      Object.entries(EMAIL_TEMPLATES).map(([key, t]) => 
        `<option value="${key}">${escapeHtml(t.name)}</option>`
      ).join('');
    
    // Get real context values
    const companyName = window.GRYFFI?.organization?.name || window.t('builder.automations.variableExamples.company_name');
    const journeyTitle = this.journey?.title || window.t('builder.automations.variableExamples.journey_title');
    const stepTitle = step?.title || window.t('builder.automations.variableExamples.step_title');
    
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center';
    modal.innerHTML = `
      <div class="bg-white rounded-xl p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto">
        <h3 class="font-semibold text-zen-900 mb-4">${window.t('builder.automations.addEmailAutomation')}</h3>
        
        <div class="space-y-4">
          <div>
            <label class="form-label">Trigger</label>
            <select class="form-select" id="automationTrigger">
              ${triggers}
            </select>
          </div>
          
          <div id="inactivityDaysWrapper" class="hidden">
            <label class="form-label">Days of inactivity</label>
            <input type="number" class="form-input" id="automationInactivityDays" value="3" min="1" max="30" />
          </div>
          
          <div>
            <label class="form-label">${window.t('builder.automations.sendTo')}</label>
            <select class="form-select" id="automationRecipient">
              <option value="current_user">${window.t('builder.automations.currentUser')}</option>
              <option value="custom">${window.t('builder.automations.customEmail')}</option>
            </select>
          </div>
          
          <div id="customEmailWrapper" class="hidden">
            <label class="form-label">${window.t('builder.automations.emailAddress')}</label>
            <input type="email" class="form-input" id="automationCustomEmail" placeholder="manager@company.com" />
          </div>
          
          <div>
            <label class="form-label">${window.t('builder.automations.emailTemplate')}</label>
            <select class="form-select" id="automationTemplate">
              ${templateOptions}
            </select>
          </div>
          
          <div>
            <label class="form-label">${window.t('builder.automations.subject')}</label>
            <div class="visual-editor visual-editor-subject" id="automationSubject" contenteditable="true" data-placeholder="${window.t('builder.props.emailSubjectPlaceholder')}"></div>
          </div>
          
          <div>
            <label class="form-label">${window.t('builder.automations.message')}</label>
            <div class="visual-editor visual-editor-body" id="automationBody" contenteditable="true" data-placeholder="${window.t('builder.props.emailMessagePlaceholder')}"></div>
            
            <!-- Variable Insert Button -->
            <div class="variable-insert-container">
              <button type="button" class="variable-insert-btn" id="variableInsertBtn">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                </svg>
                ${window.t('builder.automations.insertVariable')}
              </button>
            </div>
            
            <!-- Variable Picker Modal (hidden by default) -->
            <div class="variable-picker-modal hidden" id="variablePickerModal">
              <div class="variable-picker-content">
                <div class="variable-picker-header">
                  <h4>${window.t('builder.automations.insertVariable')}</h4>
                  <button type="button" class="variable-picker-close" id="variablePickerClose">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                  </button>
                </div>
                <div class="variable-picker-body">
                  <!-- End User Variables -->
                  <div class="variable-category">
                    <div class="variable-category-header">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>
                      </svg>
                      ${window.t('builder.automations.variableCategories.endUser')}
                    </div>
                    <button type="button" class="variable-item" data-variable="first_name">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.first_name')}</span>
                      <span class="variable-example">${window.t('builder.automations.variableExamples.first_name')}</span>
                    </button>
                    <button type="button" class="variable-item" data-variable="last_name">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.last_name')}</span>
                      <span class="variable-example">${window.t('builder.automations.variableExamples.last_name')}</span>
                    </button>
                    <button type="button" class="variable-item" data-variable="email">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.email')}</span>
                      <span class="variable-example">${window.t('builder.automations.variableExamples.email')}</span>
                    </button>
                  </div>
                  
                  <!-- Organization Variables -->
                  <div class="variable-category">
                    <div class="variable-category-header">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path>
                      </svg>
                      ${window.t('builder.automations.variableCategories.organization')}
                    </div>
                    <button type="button" class="variable-item" data-variable="company_name">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.company_name')}</span>
                      <span class="variable-example">${escapeHtml(companyName)}</span>
                    </button>
                  </div>
                  
                  <!-- Journey Variables -->
                  <div class="variable-category">
                    <div class="variable-category-header">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"></path>
                      </svg>
                      ${window.t('builder.automations.variableCategories.journey')}
                    </div>
                    <button type="button" class="variable-item" data-variable="journey_title">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.journey_title')}</span>
                      <span class="variable-example">${escapeHtml(journeyTitle)}</span>
                    </button>
                    <button type="button" class="variable-item" data-variable="step_title">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.step_title')}</span>
                      <span class="variable-example">${escapeHtml(stepTitle)}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            
          </div>
        </div>
        
        <div class="flex justify-end gap-2 mt-6">
          <button class="btn-ghost" id="cancelAutomation">${window.t('common.cancel')}</button>
          <button class="btn-primary" id="saveAutomation">${window.t('builder.automations.addAutomation')}</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Bind modal events
    const triggerSelect = modal.querySelector('#automationTrigger');
    const recipientSelect = modal.querySelector('#automationRecipient');
    const templateSelect = modal.querySelector('#automationTemplate');
    
    triggerSelect.addEventListener('change', () => {
      modal.querySelector('#inactivityDaysWrapper').classList.toggle('hidden', triggerSelect.value !== 'on_inactivity');
    });
    
    recipientSelect.addEventListener('change', () => {
      modal.querySelector('#customEmailWrapper').classList.toggle('hidden', recipientSelect.value !== 'custom');
    });
    
    // Visual Editor Setup
    const automationBody = modal.querySelector('#automationBody');
    const automationSubject = modal.querySelector('#automationSubject');
    
    // Variable display values (use real values where known, labels for user-specific data)
    const variableDisplayValues = {
      first_name: { label: window.t('builder.automations.variableLabels.first_name'), value: window.t('builder.automations.variableLabels.first_name') },
      last_name: { label: window.t('builder.automations.variableLabels.last_name'), value: window.t('builder.automations.variableLabels.last_name') },
      email: { label: window.t('builder.automations.variableLabels.email'), value: window.t('builder.automations.variableExamples.email') },
      company_name: { label: window.t('builder.automations.variableLabels.company_name'), value: companyName },
      journey_title: { label: window.t('builder.automations.variableLabels.journey_title'), value: journeyTitle },
      step_title: { label: window.t('builder.automations.variableLabels.step_title'), value: stepTitle },
      // Legacy variables
      user_name: { label: window.t('builder.automations.variableLabels.first_name'), value: window.t('builder.automations.variableLabels.first_name') + ' ' + window.t('builder.automations.variableLabels.last_name') },
      user_first_name: { label: window.t('builder.automations.variableLabels.first_name'), value: window.t('builder.automations.variableLabels.first_name') }
    };
    
    // Create a variable chip HTML element
    function createVariableChip(variableKey) {
      const info = variableDisplayValues[variableKey] || { label: variableKey, value: variableKey };
      return `<span class="variable-chip" contenteditable="false" data-variable="${escapeHtml(variableKey)}">${escapeHtml(info.value)}<button type="button" class="variable-chip-delete" tabindex="-1">×</button></span>`;
    }
    
    // Convert text with {variable} to HTML with chips
    function textToVisualHtml(text) {
      if (!text) return '';
      // Temporarily replace variable placeholders, escape everything else, then restore
      const placeholders = [];
      let result = text.replace(/\{(\w+)\}/g, (match, key) => {
        if (variableDisplayValues[key]) {
          const idx = placeholders.length;
          placeholders.push(createVariableChip(key));
          return `\x00CHIP${idx}\x00`;
        }
        return match;
      });
      result = escapeHtml(result);
      placeholders.forEach((chip, idx) => {
        result = result.replace(`\x00CHIP${idx}\x00`, chip);
      });
      result = result.replace(/\n/g, '<br>');
      return result;
    }
    
    // Convert HTML with chips back to text with {variable}
    function visualHtmlToText(container) {
      // Clone the container to avoid modifying the original
      const clone = container.cloneNode(true);
      // Replace variable chips with their {variable} syntax
      clone.querySelectorAll('.variable-chip').forEach(chip => {
        const variable = chip.dataset.variable;
        const textNode = document.createTextNode(`{${variable}}`);
        chip.replaceWith(textNode);
      });
      // Replace <br> with newlines and get text content
      clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      // Get the text content
      return clone.textContent || '';
    }
    
    // Insert variable chip at cursor position
    function insertVariableChipAtCursor(editor, variableKey) {
      editor.focus();
      const selection = window.getSelection();
      const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      
      if (range && editor.contains(range.commonAncestorContainer)) {
        // Create chip element
        const chipHtml = createVariableChip(variableKey);
        const temp = document.createElement('div');
        temp.innerHTML = chipHtml;
        const chipElement = temp.firstChild;
        
        // Insert at cursor position
        range.deleteContents();
        range.insertNode(chipElement);
        
        // Move cursor after the chip
        range.setStartAfter(chipElement);
        range.setEndAfter(chipElement);
        selection.removeAllRanges();
        selection.addRange(range);
        
        // Add a space after for easier typing
        const space = document.createTextNode('\u00A0'); // non-breaking space
        range.insertNode(space);
        range.setStartAfter(space);
        range.setEndAfter(space);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        // No selection in editor, append at end
        editor.innerHTML += createVariableChip(variableKey) + '\u00A0';
      }
      
      // Trigger input event for any listeners
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // Handle delete button clicks on variable chips
    function handleChipDelete(e) {
      if (e.target.classList.contains('variable-chip-delete')) {
        e.preventDefault();
        e.stopPropagation();
        const chip = e.target.closest('.variable-chip');
        if (chip) {
          const editor = chip.closest('.visual-editor');
          chip.remove();
          if (editor) {
            editor.focus();
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }
    }
    
    // Add delete handlers to both editors
    automationSubject.addEventListener('mousedown', handleChipDelete);
    automationBody.addEventListener('mousedown', handleChipDelete);
    
    // Prevent Enter key in subject field (single line)
    automationSubject.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
      }
    });
    
    // Handle Backspace/Delete key to remove entire chip
    [automationSubject, automationBody].forEach(editor => {
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          const selection = window.getSelection();
          if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (range.collapsed) {
              // Check if cursor is right after a chip (for Backspace)
              if (e.key === 'Backspace') {
                const prevNode = range.startContainer.previousSibling || 
                  (range.startOffset === 0 ? range.startContainer.parentNode?.previousSibling : null);
                if (prevNode && prevNode.classList?.contains('variable-chip')) {
                  e.preventDefault();
                  prevNode.remove();
                }
              }
              // Check if cursor is right before a chip (for Delete)
              if (e.key === 'Delete') {
                const nextNode = range.startContainer.nextSibling ||
                  (range.startOffset === range.startContainer.length ? range.startContainer.parentNode?.nextSibling : null);
                if (nextNode && nextNode.classList?.contains('variable-chip')) {
                  e.preventDefault();
                  nextNode.remove();
                }
              }
            }
          }
        }
      });
    });
    
    // Track which editor was last focused
    let lastFocusedEditor = automationBody;
    automationSubject.addEventListener('focus', () => { lastFocusedEditor = automationSubject; });
    automationBody.addEventListener('focus', () => { lastFocusedEditor = automationBody; });
    
    // Template change handler - populate with visual chips
    templateSelect.addEventListener('change', () => {
      const EMAIL_TEMPLATES = getEmailTemplates();
      const template = EMAIL_TEMPLATES[templateSelect.value];
      if (template) {
        automationSubject.innerHTML = textToVisualHtml(template.subject);
        automationBody.innerHTML = textToVisualHtml(template.body);
      }
    });
    
    // Variable picker modal functionality
    const variableInsertBtn = modal.querySelector('#variableInsertBtn');
    const variablePickerModal = modal.querySelector('#variablePickerModal');
    const variablePickerClose = modal.querySelector('#variablePickerClose');
    
    // Open variable picker modal
    variableInsertBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      variablePickerModal.classList.remove('hidden');
    });
    
    // Close variable picker modal
    variablePickerClose.addEventListener('click', () => {
      variablePickerModal.classList.add('hidden');
    });
    
    // Close modal when clicking outside
    variablePickerModal.addEventListener('click', (e) => {
      if (e.target === variablePickerModal) {
        variablePickerModal.classList.add('hidden');
      }
    });
    
    // Insert variable when clicking on variable item
    modal.querySelectorAll('.variable-item').forEach(item => {
      item.addEventListener('click', () => {
        const variable = item.dataset.variable;
        insertVariableChipAtCursor(lastFocusedEditor, variable);
        variablePickerModal.classList.add('hidden');
        lastFocusedEditor.focus();
      });
    });
    
    modal.querySelector('#cancelAutomation').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    
    modal.querySelector('#saveAutomation').addEventListener('click', async () => {
      const automation = {
        trigger: triggerSelect.value,
        recipient: recipientSelect.value === 'custom' 
          ? modal.querySelector('#automationCustomEmail').value 
          : 'current_user',
        template: templateSelect.value,
        subject: visualHtmlToText(automationSubject),
        body: visualHtmlToText(automationBody)
      };
      
      if (triggerSelect.value === 'on_inactivity') {
        automation.inactivity_days = parseInt(modal.querySelector('#automationInactivityDays').value) || 3;
      }
      
      if (isJourney) {
        this.journey.automations = [...(this.journey.automations || []), automation];
        await this.saveJourney();
        this.showJourneySettings();
      } else {
        const automations = [...(step.advanced_props?.automations || []), automation];
        await this.updateStep(step.id, { 
          advanced_props: { ...step.advanced_props, automations } 
        });
        this.showProperties(step.id);
        this.render(); // Update badges
      }
      
      modal.remove();
    });
  }
  
  showEditAutomationModal(step, automation, index, context) {
    // Similar to add modal but pre-filled with existing values
    const isJourney = context === 'journey';
    const stepPaths = step ? this.paths.filter(p => p.from_step_id === step.id) : [];
    
    // Get real context values
    const companyName = window.GRYFFI?.organization?.name || window.t('builder.automations.variableExamples.company_name');
    const journeyTitle = this.journey?.title || window.t('builder.automations.variableExamples.journey_title');
    const stepTitle = step?.title || window.t('builder.automations.variableExamples.step_title');
    
    const triggers = isJourney ? `
      <option value="on_journey_start" ${automation.trigger === 'on_journey_start' ? 'selected' : ''}>${window.t('builder.automations.triggers.whenJourneyStarts')}</option>
      <option value="on_journey_complete" ${automation.trigger === 'on_journey_complete' ? 'selected' : ''}>${window.t('builder.automations.triggers.whenJourneyCompletes')}</option>
      <option value="on_inactivity" ${automation.trigger === 'on_inactivity' ? 'selected' : ''}>${window.t('builder.automations.daysOfInactivity')}</option>
    ` : `
      <option value="on_step_enter" ${automation.trigger === 'on_step_enter' ? 'selected' : ''}>${window.t('builder.automations.triggers.whenUserEntersStep')}</option>
      <option value="on_step_complete" ${automation.trigger === 'on_step_complete' ? 'selected' : ''}>${window.t('builder.automations.triggers.whenUserCompletesStep')}</option>
      ${stepPaths.map(p => 
        `<option value="on_path:${p.id}" ${automation.trigger === `on_path:${p.id}` ? 'selected' : ''}>${window.t('builder.automations.triggers.whenUserChoosesPath')} "${escapeHtml(p.label)}"</option>`
      ).join('')}
    `;
    
    const EMAIL_TEMPLATES = getEmailTemplates();
    const templateOptions = Object.entries(EMAIL_TEMPLATES).map(([key, t]) => 
      `<option value="${key}" ${automation.template === key ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
    ).join('');
    
    // Variable display values for visual editor (use real values where known, labels for user-specific data)
    const variableDisplayValues = {
      first_name: { label: window.t('builder.automations.variableLabels.first_name'), value: window.t('builder.automations.variableLabels.first_name') },
      last_name: { label: window.t('builder.automations.variableLabels.last_name'), value: window.t('builder.automations.variableLabels.last_name') },
      email: { label: window.t('builder.automations.variableLabels.email'), value: window.t('builder.automations.variableExamples.email') },
      company_name: { label: window.t('builder.automations.variableLabels.company_name'), value: companyName },
      journey_title: { label: window.t('builder.automations.variableLabels.journey_title'), value: journeyTitle },
      step_title: { label: window.t('builder.automations.variableLabels.step_title'), value: stepTitle },
      user_name: { label: window.t('builder.automations.variableLabels.first_name'), value: window.t('builder.automations.variableLabels.first_name') + ' ' + window.t('builder.automations.variableLabels.last_name') },
      user_first_name: { label: window.t('builder.automations.variableLabels.first_name'), value: window.t('builder.automations.variableLabels.first_name') }
    };
    
    // Helper functions for visual editor
    function createVariableChip(variableKey) {
      const info = variableDisplayValues[variableKey] || { label: variableKey, value: variableKey };
      return `<span class="variable-chip" contenteditable="false" data-variable="${escapeHtml(variableKey)}">${escapeHtml(info.value)}<button type="button" class="variable-chip-delete" tabindex="-1">×</button></span>`;
    }
    
    function textToVisualHtml(text) {
      if (!text) return '';
      const placeholders = [];
      let result = text.replace(/\{(\w+)\}/g, (match, key) => {
        if (variableDisplayValues[key]) {
          const idx = placeholders.length;
          placeholders.push(createVariableChip(key));
          return `\x00CHIP${idx}\x00`;
        }
        return match;
      });
      result = escapeHtml(result);
      placeholders.forEach((chip, idx) => {
        result = result.replace(`\x00CHIP${idx}\x00`, chip);
      });
      result = result.replace(/\n/g, '<br>');
      return result;
    }
    
    function visualHtmlToText(container) {
      const clone = container.cloneNode(true);
      clone.querySelectorAll('.variable-chip').forEach(chip => {
        const variable = chip.dataset.variable;
        const textNode = document.createTextNode(`{${variable}}`);
        chip.replaceWith(textNode);
      });
      clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      return clone.textContent || '';
    }
    
    function insertVariableChipAtCursor(editor, variableKey) {
      editor.focus();
      const selection = window.getSelection();
      const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      
      if (range && editor.contains(range.commonAncestorContainer)) {
        const chipHtml = createVariableChip(variableKey);
        const temp = document.createElement('div');
        temp.innerHTML = chipHtml;
        const chipElement = temp.firstChild;
        
        range.deleteContents();
        range.insertNode(chipElement);
        range.setStartAfter(chipElement);
        range.setEndAfter(chipElement);
        selection.removeAllRanges();
        selection.addRange(range);
        
        const space = document.createTextNode('\u00A0');
        range.insertNode(space);
        range.setStartAfter(space);
        range.setEndAfter(space);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        editor.innerHTML += createVariableChip(variableKey) + '\u00A0';
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center';
    modal.innerHTML = `
      <div class="bg-white rounded-xl p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto">
        <h3 class="font-semibold text-zen-900 mb-4">${window.t('builder.automations.editAutomation')}</h3>
        
        <div class="space-y-4">
          <div>
            <label class="form-label">Trigger</label>
            <select class="form-select" id="automationTrigger">
              ${triggers}
            </select>
          </div>
          
          <div id="inactivityDaysWrapper" class="${automation.trigger !== 'on_inactivity' ? 'hidden' : ''}">
            <label class="form-label">${window.t('builder.automations.daysOfInactivity')}</label>
            <input type="number" class="form-input" id="automationInactivityDays" value="${escapeHtml(automation.inactivity_days || 3)}" min="1" max="30" />
          </div>
          
          <div>
            <label class="form-label">${window.t('builder.automations.sendTo')}</label>
            <select class="form-select" id="automationRecipient">
              <option value="current_user" ${automation.recipient === 'current_user' ? 'selected' : ''}>${window.t('builder.automations.currentUser')}</option>
              <option value="custom" ${automation.recipient !== 'current_user' ? 'selected' : ''}>${window.t('builder.automations.customEmail')}</option>
            </select>
          </div>
          
          <div id="customEmailWrapper" class="${automation.recipient === 'current_user' ? 'hidden' : ''}">
            <label class="form-label">${window.t('builder.automations.emailAddress')}</label>
            <input type="email" class="form-input" id="automationCustomEmail" value="${automation.recipient !== 'current_user' ? escapeHtml(automation.recipient) : ''}" placeholder="manager@company.com" />
          </div>
          
          <div>
            <label class="form-label">${window.t('builder.automations.emailTemplate')}</label>
            <select class="form-select" id="automationTemplate">
              ${templateOptions}
            </select>
          </div>
          
          <div>
            <label class="form-label">${window.t('builder.automations.subject')}</label>
            <div class="visual-editor visual-editor-subject" id="automationSubject" contenteditable="true" data-placeholder="${window.t('builder.props.emailSubjectPlaceholder')}"></div>
          </div>
          
          <div>
            <label class="form-label">${window.t('builder.automations.message')}</label>
            <div class="visual-editor visual-editor-body" id="automationBody" contenteditable="true" data-placeholder="${window.t('builder.props.emailMessagePlaceholder')}"></div>
            
            <!-- Variable Insert Button -->
            <div class="variable-insert-container">
              <button type="button" class="variable-insert-btn" id="variableInsertBtn">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                </svg>
                ${window.t('builder.automations.insertVariable')}
              </button>
            </div>
            
            <!-- Variable Picker Modal -->
            <div class="variable-picker-modal hidden" id="variablePickerModal">
              <div class="variable-picker-content">
                <div class="variable-picker-header">
                  <h4>${window.t('builder.automations.insertVariable')}</h4>
                  <button type="button" class="variable-picker-close" id="variablePickerClose">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                  </button>
                </div>
                <div class="variable-picker-body">
                  <div class="variable-category">
                    <div class="variable-category-header">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>
                      </svg>
                      ${window.t('builder.automations.variableCategories.endUser')}
                    </div>
                    <button type="button" class="variable-item" data-variable="first_name">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.first_name')}</span>
                      <span class="variable-example">${window.t('builder.automations.variableExamples.first_name')}</span>
                    </button>
                    <button type="button" class="variable-item" data-variable="last_name">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.last_name')}</span>
                      <span class="variable-example">${window.t('builder.automations.variableExamples.last_name')}</span>
                    </button>
                    <button type="button" class="variable-item" data-variable="email">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.email')}</span>
                      <span class="variable-example">${window.t('builder.automations.variableExamples.email')}</span>
                    </button>
                  </div>
                  <div class="variable-category">
                    <div class="variable-category-header">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path>
                      </svg>
                      ${window.t('builder.automations.variableCategories.organization')}
                    </div>
                    <button type="button" class="variable-item" data-variable="company_name">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.company_name')}</span>
                      <span class="variable-example">${escapeHtml(companyName)}</span>
                    </button>
                  </div>
                  <div class="variable-category">
                    <div class="variable-category-header">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"></path>
                      </svg>
                      ${window.t('builder.automations.variableCategories.journey')}
                    </div>
                    <button type="button" class="variable-item" data-variable="journey_title">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.journey_title')}</span>
                      <span class="variable-example">${escapeHtml(journeyTitle)}</span>
                    </button>
                    <button type="button" class="variable-item" data-variable="step_title">
                      <span class="variable-label">${window.t('builder.automations.variableLabels.step_title')}</span>
                      <span class="variable-example">${escapeHtml(stepTitle)}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div class="flex justify-end gap-2 mt-6">
          <button class="btn-ghost" id="cancelAutomation">${window.t('common.cancel')}</button>
          <button class="btn-primary" id="saveAutomation">${window.t('common.save')}</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Get editor elements
    const automationSubject = modal.querySelector('#automationSubject');
    const automationBody = modal.querySelector('#automationBody');
    
    // Initialize visual editors with existing content
    automationSubject.innerHTML = textToVisualHtml(automation.subject || '');
    automationBody.innerHTML = textToVisualHtml(automation.body || '');
    
    // Handle delete button clicks on variable chips
    function handleChipDelete(e) {
      if (e.target.classList.contains('variable-chip-delete')) {
        e.preventDefault();
        e.stopPropagation();
        const chip = e.target.closest('.variable-chip');
        if (chip) {
          const editor = chip.closest('.visual-editor');
          chip.remove();
          if (editor) editor.focus();
        }
      }
    }
    
    automationSubject.addEventListener('mousedown', handleChipDelete);
    automationBody.addEventListener('mousedown', handleChipDelete);
    
    // Prevent Enter in subject field
    automationSubject.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
    
    // Track focused editor
    let lastFocusedEditor = automationBody;
    automationSubject.addEventListener('focus', () => { lastFocusedEditor = automationSubject; });
    automationBody.addEventListener('focus', () => { lastFocusedEditor = automationBody; });
    
    // Bind modal events
    const triggerSelect = modal.querySelector('#automationTrigger');
    const recipientSelect = modal.querySelector('#automationRecipient');
    const templateSelect = modal.querySelector('#automationTemplate');
    const variableInsertBtn = modal.querySelector('#variableInsertBtn');
    const variablePickerModal = modal.querySelector('#variablePickerModal');
    const variablePickerClose = modal.querySelector('#variablePickerClose');
    
    triggerSelect.addEventListener('change', () => {
      modal.querySelector('#inactivityDaysWrapper').classList.toggle('hidden', triggerSelect.value !== 'on_inactivity');
    });
    
    recipientSelect.addEventListener('change', () => {
      modal.querySelector('#customEmailWrapper').classList.toggle('hidden', recipientSelect.value !== 'custom');
    });
    
    // Template change - populate visual editors
    templateSelect.addEventListener('change', () => {
      const template = EMAIL_TEMPLATES[templateSelect.value];
      if (template) {
        automationSubject.innerHTML = textToVisualHtml(template.subject);
        automationBody.innerHTML = textToVisualHtml(template.body);
      }
    });
    
    // Variable picker
    variableInsertBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      variablePickerModal.classList.remove('hidden');
    });
    
    variablePickerClose.addEventListener('click', () => {
      variablePickerModal.classList.add('hidden');
    });
    
    variablePickerModal.addEventListener('click', (e) => {
      if (e.target === variablePickerModal) variablePickerModal.classList.add('hidden');
    });
    
    modal.querySelectorAll('.variable-item').forEach(item => {
      item.addEventListener('click', () => {
        const variable = item.dataset.variable;
        insertVariableChipAtCursor(lastFocusedEditor, variable);
        variablePickerModal.classList.add('hidden');
        lastFocusedEditor.focus();
      });
    });
    
    modal.querySelector('#cancelAutomation').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    
    modal.querySelector('#saveAutomation').addEventListener('click', async () => {
      const updatedAutomation = {
        trigger: triggerSelect.value,
        recipient: recipientSelect.value === 'custom' 
          ? modal.querySelector('#automationCustomEmail').value 
          : 'current_user',
        template: templateSelect.value,
        subject: visualHtmlToText(automationSubject),
        body: visualHtmlToText(automationBody)
      };
      
      if (triggerSelect.value === 'on_inactivity') {
        updatedAutomation.inactivity_days = parseInt(modal.querySelector('#automationInactivityDays').value) || 3;
      }
      
      if (isJourney) {
        const automations = [...(this.journey.automations || [])];
        automations[index] = updatedAutomation;
        this.journey.automations = automations;
        await this.saveJourney();
        this.showJourneySettings();
      } else {
        const automations = [...(step.advanced_props?.automations || [])];
        automations[index] = updatedAutomation;
        await this.updateStep(step.id, { 
          advanced_props: { ...step.advanced_props, automations } 
        });
        this.showProperties(step.id);
        this.render();
      }
      
      modal.remove();
    });
  }
  
  async saveJourney() {
    this.setSaveState('saving');
    try {
      const response = await fetch(`/api/journeys/${this.journey.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: this.journey.title,
          description: this.journey.description,
          status: this.journey.status,
          automations: this.journey.automations,
          welcome_message: this.journey.welcome_message,
          completion_message: this.journey.completion_message,
          allow_skip: this.journey.allow_skip,
          track_progress: this.journey.track_progress,
          language_override: this.journey.language_override,
          language_code: this.journey.language_code,
          guide_language_override: this.journey.guide_language_override,
          guide_language_code: this.journey.guide_language_code,
          guide_opening_override: this.journey.guide_opening_override
        })
      });
      
      if (!response.ok) {
        throw new Error('Failed to save journey');
      }
      
      this.setSaveState('saved');
      this.scheduleHistoryCommit('journey');
    } catch (err) {
      console.error('Save journey error:', err);
      this.setSaveState('error');
      this.showToast(window.t('builder.messages.saveFailed'), 'error');
    }
  }
  
  // ============================================
  // QUIZ BUILDER METHODS
  // ============================================
  
  renderQuizQuestion(question, index, totalQuestions) {
    const options = question.options || [];
    const hasCorrect = options.some(o => o.correct);
    const isExpanded = this.expandedQuestions?.has(question.id) !== false;
    
    return `
      <div class="quiz-question-card border border-zen-200 rounded-lg overflow-hidden" data-question-id="${escapeHtml(question.id)}">
        <!-- Question Header (always visible) -->
        <div class="quiz-question-header flex items-center gap-3 p-3 bg-zen-50 cursor-pointer hover:bg-zen-100 transition-colors" data-toggle-question="${escapeHtml(question.id)}">
          <div class="flex-shrink-0 w-7 h-7 rounded-full bg-gryffi-primary text-white flex items-center justify-center text-sm font-medium">
            ${index + 1}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-zen-900 truncate">
              ${escapeHtml(question.question || window.t('builder.quiz.questionPlaceholder'))}
            </p>
            <p class="text-xs text-zen-400">
              ${options.length} ${options.length === 1 ? window.t('builder.quiz.optionCount', { count: options.length }) : window.t('builder.quiz.optionCountPlural', { count: options.length })}
              ${hasCorrect ? `<span class="text-green-600 ml-2">✓ ${window.t('builder.quiz.correctAnswer')}</span>` : `<span class="text-amber-600 ml-2">⚠ ${window.t('builder.quiz.noCorrectAnswer')}</span>`}
            </p>
          </div>
          <div class="flex items-center gap-1">
            ${index > 0 ? `
              <button type="button" class="quiz-move-up p-1.5 text-zen-400 hover:text-zen-600 hover:bg-white rounded" data-question-index="${index}" title="${window.t('builder.quiz.moveUp')}">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path></svg>
              </button>
            ` : ''}
            ${index < totalQuestions - 1 ? `
              <button type="button" class="quiz-move-down p-1.5 text-zen-400 hover:text-zen-600 hover:bg-white rounded" data-question-index="${index}" title="${window.t('builder.quiz.moveDown')}">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
              </button>
            ` : ''}
            <button type="button" class="quiz-duplicate p-1.5 text-zen-400 hover:text-zen-600 hover:bg-white rounded" data-question-index="${index}" title="${window.t('builder.quiz.duplicateQuestion')}">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
            </button>
            <button type="button" class="quiz-delete p-1.5 text-zen-400 hover:text-red-500 hover:bg-white rounded" data-question-index="${index}" title="${window.t('builder.quiz.removeQuestion')}">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
            <svg class="w-4 h-4 text-zen-400 ml-1 transition-transform ${isExpanded ? 'rotate-180' : ''}" data-chevron="${escapeHtml(question.id)}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
            </svg>
          </div>
        </div>
        
        <!-- Question Body (collapsible) -->
        <div class="quiz-question-body p-4 border-t border-zen-100 ${isExpanded ? '' : 'hidden'}" data-question-body="${escapeHtml(question.id)}">
          <!-- Question Text -->
          <div class="mb-4">
            <label class="form-label text-xs">${window.t('builder.quiz.question')}</label>
            <textarea class="form-textarea quiz-question-input" data-question-index="${index}" rows="2" placeholder="${window.t('builder.quiz.questionPlaceholder')}">${escapeHtml(question.question)}</textarea>
          </div>
          
          <!-- Answer Options -->
          <div>
            <label class="form-label text-xs">${window.t('builder.quiz.options')}</label>
            <div class="quiz-options-container space-y-2" data-question-index="${index}">
              ${options.map((opt, optIndex) => `
                <div class="flex items-center gap-2 quiz-option-row" data-option-index="${optIndex}">
                  <input type="radio" name="correct-${escapeHtml(question.id)}" value="${optIndex}" ${opt.correct ? 'checked' : ''} class="w-4 h-4 text-gryffi-primary quiz-correct-radio" data-question-index="${index}" data-option-index="${optIndex}" title="${window.t('builder.quiz.markCorrect')}" />
                  <input type="text" class="form-input flex-1 text-sm quiz-option-input" data-question-index="${index}" data-option-index="${optIndex}" value="${escapeHtml(opt.text)}" placeholder="${window.t('builder.quiz.optionPlaceholder')}" />
                  ${options.length > 2 ? `
                    <button type="button" class="quiz-remove-option p-1 text-zen-400 hover:text-red-500 rounded" data-question-index="${index}" data-option-index="${optIndex}" title="${window.t('builder.quiz.removeOption')}">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                  ` : ''}
                </div>
              `).join('')}
            </div>
            <button type="button" class="quiz-add-option mt-2 text-sm text-gryffi-primary hover:underline" data-question-index="${index}">
              ${window.t('builder.quiz.addOption')}
            </button>
          </div>
        </div>
      </div>
    `;
  }
  
  bindQuizEvents(step) {
    // Initialize expanded questions set
    if (!this.expandedQuestions) {
      this.expandedQuestions = new Set();
      // Expand first question by default
      const questions = step.basic_props?.questions || [];
      if (questions.length > 0) {
        this.expandedQuestions.add(questions[0].id);
      }
    }
    
    // Toggle question expansion
    document.querySelectorAll('[data-toggle-question]').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('button')) return; // Don't toggle when clicking buttons
        const questionId = header.dataset.toggleQuestion;
        const body = document.querySelector(`[data-question-body="${questionId}"]`);
        const chevron = document.querySelector(`[data-chevron="${questionId}"]`);
        
        if (body) {
          body.classList.toggle('hidden');
          chevron?.classList.toggle('rotate-180');
          
          if (this.expandedQuestions.has(questionId)) {
            this.expandedQuestions.delete(questionId);
          } else {
            this.expandedQuestions.add(questionId);
          }
        }
      });
    });
    
    // Toggle all questions
    document.getElementById('toggleAllQuestions')?.addEventListener('click', (e) => {
      const bodies = document.querySelectorAll('[data-question-body]');
      const allExpanded = Array.from(bodies).every(b => !b.classList.contains('hidden'));
      
      bodies.forEach(body => {
        body.classList.toggle('hidden', allExpanded);
      });
      document.querySelectorAll('[data-chevron]').forEach(chevron => {
        chevron.classList.toggle('rotate-180', !allExpanded);
      });
      
      e.target.textContent = allExpanded 
        ? window.t('builder.quiz.expandAll')
        : window.t('builder.quiz.collapseAll');
    });
    
    // Add question
    document.getElementById('addQuestionBtn')?.addEventListener('click', () => {
      this.addQuizQuestion(step);
    });
    
    // Question text changes
    document.querySelectorAll('.quiz-question-input').forEach(textarea => {
      textarea.addEventListener('change', () => this.saveQuizQuestions(step));
    });
    
    // Option text changes
    document.querySelectorAll('.quiz-option-input').forEach(input => {
      input.addEventListener('change', () => this.saveQuizQuestions(step));
    });
    
    // Correct answer changes
    document.querySelectorAll('.quiz-correct-radio').forEach(radio => {
      radio.addEventListener('change', () => this.saveQuizQuestions(step));
    });
    
    // Add option
    document.querySelectorAll('.quiz-add-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const qIndex = parseInt(e.target.dataset.questionIndex);
        this.addQuizOption(step, qIndex);
      });
    });
    
    // Remove option
    document.querySelectorAll('.quiz-remove-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const qIndex = parseInt(e.target.dataset.questionIndex);
        const oIndex = parseInt(e.target.dataset.optionIndex);
        this.removeQuizOption(step, qIndex, oIndex);
      });
    });
    
    // Delete question
    document.querySelectorAll('.quiz-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qIndex = parseInt(e.target.closest('button').dataset.questionIndex);
        this.removeQuizQuestion(step, qIndex);
      });
    });
    
    // Duplicate question
    document.querySelectorAll('.quiz-duplicate').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qIndex = parseInt(e.target.closest('button').dataset.questionIndex);
        this.duplicateQuizQuestion(step, qIndex);
      });
    });
    
    // Move up
    document.querySelectorAll('.quiz-move-up').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qIndex = parseInt(e.target.closest('button').dataset.questionIndex);
        this.moveQuizQuestion(step, qIndex, -1);
      });
    });
    
    // Move down
    document.querySelectorAll('.quiz-move-down').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qIndex = parseInt(e.target.closest('button').dataset.questionIndex);
        this.moveQuizQuestion(step, qIndex, 1);
      });
    });
    
    // Shuffle questions toggle
    document.getElementById('shuffleQuestionsToggle')?.addEventListener('change', async (e) => {
      const shuffleEnabled = e.target.checked;
      const basicProps = { ...step.basic_props, shuffle_questions: shuffleEnabled };
      step.basic_props = basicProps;
      await this.updateStep(step.id, { basic_props: basicProps });
    });
  }
  
  getQuizQuestions(step) {
    let questions = step.basic_props?.questions || [];
    // Migrate old format
    if (questions.length === 0 && step.basic_props?.question) {
      questions = [{
        id: crypto.randomUUID(),
        question: step.basic_props.question,
        options: step.basic_props.options || []
      }];
    }
    return questions;
  }
  
  collectQuizQuestions() {
    const questions = [];
    document.querySelectorAll('.quiz-question-card').forEach((card, _qIndex) => {
      const questionId = card.dataset.questionId;
      const questionText = card.querySelector('.quiz-question-input')?.value || '';
      const options = [];
      
      card.querySelectorAll('.quiz-option-row').forEach((row, oIndex) => {
        const text = row.querySelector('.quiz-option-input')?.value || '';
        const correct = row.querySelector('.quiz-correct-radio')?.checked || false;
        options.push({
          id: String.fromCharCode(97 + oIndex),
          text,
          correct
        });
      });
      
      questions.push({
        id: questionId,
        question: questionText,
        options
      });
    });
    return questions;
  }
  
  async saveQuizQuestions(step) {
    const questions = this.collectQuizQuestions();
    const basicProps = { ...step.basic_props, questions };
    // Remove old format fields
    delete basicProps.question;
    delete basicProps.options;
    
    step.basic_props = basicProps;
    await this.updateStep(step.id, { basic_props: basicProps });
    this.renderStep(step);
  }
  
  async addQuizQuestion(step) {
    const questions = this.collectQuizQuestions();
    const newQuestion = {
      id: crypto.randomUUID(),
      question: '',
      options: [
        { id: 'a', text: '', correct: false },
        { id: 'b', text: '', correct: true }
      ]
    };
    questions.push(newQuestion);
    
    // Expand the new question
    this.expandedQuestions = this.expandedQuestions || new Set();
    this.expandedQuestions.add(newQuestion.id);
    
    const basicProps = { ...step.basic_props, questions };
    delete basicProps.question;
    delete basicProps.options;
    
    step.basic_props = basicProps;
    await this.updateStep(step.id, { basic_props: basicProps });
    this.showProperties(step.id);
    this.renderStep(step);
  }
  
  async removeQuizQuestion(step, qIndex) {
    const questions = this.collectQuizQuestions();
    if (questions.length <= 1) {
      this.showToast(window.t('builder.quiz.noQuestions'), 'error');
      return;
    }
    questions.splice(qIndex, 1);
    
    const basicProps = { ...step.basic_props, questions };
    step.basic_props = basicProps;
    await this.updateStep(step.id, { basic_props: basicProps });
    this.showProperties(step.id);
    this.renderStep(step);
  }
  
  async duplicateQuizQuestion(step, qIndex) {
    const questions = this.collectQuizQuestions();
    const original = questions[qIndex];
    const duplicate = {
      id: crypto.randomUUID(),
      question: original.question,
      options: original.options.map(o => ({ ...o }))
    };
    questions.splice(qIndex + 1, 0, duplicate);
    
    // Expand the duplicated question
    this.expandedQuestions = this.expandedQuestions || new Set();
    this.expandedQuestions.add(duplicate.id);
    
    const basicProps = { ...step.basic_props, questions };
    step.basic_props = basicProps;
    await this.updateStep(step.id, { basic_props: basicProps });
    this.showProperties(step.id);
    this.renderStep(step);
  }
  
  async moveQuizQuestion(step, qIndex, direction) {
    const questions = this.collectQuizQuestions();
    const newIndex = qIndex + direction;
    if (newIndex < 0 || newIndex >= questions.length) return;
    
    const [moved] = questions.splice(qIndex, 1);
    questions.splice(newIndex, 0, moved);
    
    const basicProps = { ...step.basic_props, questions };
    step.basic_props = basicProps;
    await this.updateStep(step.id, { basic_props: basicProps });
    this.showProperties(step.id);
    this.renderStep(step);
  }
  
  async addQuizOption(step, qIndex) {
    const questions = this.collectQuizQuestions();
    const question = questions[qIndex];
    if (question.options.length >= 6) {
      this.showToast(window.t('builder.messages.maxOptionsPerQuestion'), 'error');
      return;
    }
    
    question.options.push({
      id: String.fromCharCode(97 + question.options.length),
      text: '',
      correct: false
    });
    
    const basicProps = { ...step.basic_props, questions };
    step.basic_props = basicProps;
    await this.updateStep(step.id, { basic_props: basicProps });
    this.showProperties(step.id);
  }
  
  async removeQuizOption(step, qIndex, oIndex) {
    const questions = this.collectQuizQuestions();
    const question = questions[qIndex];
    if (question.options.length <= 2) return;
    
    question.options.splice(oIndex, 1);
    
    const basicProps = { ...step.basic_props, questions };
    step.basic_props = basicProps;
    await this.updateStep(step.id, { basic_props: basicProps });
    this.showProperties(step.id);
  }
  
  // Legacy method for backward compatibility
  addChallengeOption(step) {
    // Redirect to new quiz system
    const questions = this.getQuizQuestions(step);
    if (questions.length > 0) {
      this.addQuizOption(step, 0);
    }
  }
  
  showAddPathModal(fromStep) {
    const otherSteps = this.steps.filter(s => s.id !== fromStep.id);
    
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center';
    modal.innerHTML = `
      <div class="bg-white rounded-xl p-6 max-w-sm w-full mx-4">
        <h3 class="font-semibold text-zen-900 mb-4">Add Connection</h3>
        <div class="space-y-4">
          <div>
            <label class="form-label">Label</label>
            <input type="text" class="form-input" id="newPathLabel" value="${window.t('builder.connections.continue')}" />
          </div>
          <div>
            <label class="form-label">Connect to</label>
            <select class="form-input" id="newPathTarget">
              <option value="">Select a step...</option>
              ${otherSteps.map(s => `<option value="${s.id}">${escapeHtml(s.title)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button class="btn-ghost" id="cancelPath">Cancel</button>
          <button class="btn-primary" id="confirmPath">Add</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    modal.querySelector('#cancelPath').addEventListener('click', () => modal.remove());
    modal.querySelector('#confirmPath').addEventListener('click', async () => {
      const label = document.getElementById('newPathLabel').value;
      const targetId = document.getElementById('newPathTarget').value;
      
      if (targetId) {
        await this.createPath(fromStep.id, targetId, label);
        this.showProperties(fromStep.id);
      }
      modal.remove();
    });
  }
  
  closeProperties() {
    this.propertiesPanel.classList.add('hidden');
  }
  
  // ============================================
  // DRAG & DROP
  // ============================================
  
  startDragStep(e, step) {
    if (this.readOnly) return;
    if (e.target.classList.contains('connection-port')) return;
    
    this.isDragging = true;
    this.dragStep = step;
    this.dragOffset = {
      x: e.clientX - step.position_x,
      y: e.clientY - step.position_y
    };
    
    const moveHandler = (e) => {
      if (!this.isDragging) return;
      
      const newX = Math.max(0, e.clientX - this.dragOffset.x);
      const newY = Math.max(0, e.clientY - this.dragOffset.y);
      
      const element = document.querySelector(`[data-step-id="${this.dragStep.id}"]`);
      if (element) {
        element.style.left = `${newX}px`;
        element.style.top = `${newY}px`;
      }
      
      this.dragStep.position_x = newX;
      this.dragStep.position_y = newY;
      this.drawConnections();
    };
    
    const upHandler = async () => {
      if (this.isDragging && this.dragStep) {
        await this.updateStep(this.dragStep.id, {
          position_x: this.dragStep.position_x,
          position_y: this.dragStep.position_y
        });
      }
      
      this.isDragging = false;
      this.dragStep = null;
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
    };
    
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  }
  
  startConnectionDrag(fromStepId, fromPort, _e) {
    if (this.readOnly) return;
    const otherSteps = this.steps.filter(s => s.id !== fromStepId);
    if (otherSteps.length === 0) {
      this.showToast(window.t('builder.messages.createStepFirst'), 'info');
      return;
    }
    
    const fromEl = document.querySelector(`[data-step-id="${fromStepId}"]`);
    if (!fromEl) return;
    
    // Get starting position from the port
    const fromRect = this.getStepRect(fromEl);
    const startPos = this.getPortPosition(fromRect, fromPort);
    
    // Mark the starting port as active
    const startPort = fromEl.querySelector(`[data-port="${fromPort}"]`);
    startPort?.classList.add('active');
    
    // Create temporary line
    const svg = this.connectionLayer;
    const tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempLine.setAttribute('stroke', '#78c503');
    tempLine.setAttribute('stroke-width', '2');
    tempLine.setAttribute('fill', 'none');
    tempLine.setAttribute('stroke-dasharray', '5,5');
    tempLine.setAttribute('stroke-linecap', 'round');
    tempLine.id = 'tempConnectionLine';
    svg.appendChild(tempLine);
    
    // Highlight all potential target ports
    document.querySelectorAll('.step-node').forEach(node => {
      if (node.dataset.stepId !== fromStepId) {
        node.querySelectorAll('.connection-port').forEach(port => {
          port.classList.add('potential-target');
        });
      }
    });
    
    const moveHandler = (e) => {
      const canvasRect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - canvasRect.left) / this.zoom;
      const y = (e.clientY - canvasRect.top) / this.zoom;
      
      // Calculate control points for nice curve
      const dx = x - startPos.x;
      const dy = y - startPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const offset = Math.min(distance * 0.4, 60);
      
      let c1 = { x: startPos.x, y: startPos.y };
      switch (fromPort) {
        case 'right':  c1 = { x: startPos.x + offset, y: startPos.y }; break;
        case 'left':   c1 = { x: startPos.x - offset, y: startPos.y }; break;
        case 'top':    c1 = { x: startPos.x, y: startPos.y - offset }; break;
        case 'bottom': c1 = { x: startPos.x, y: startPos.y + offset }; break;
      }
      
      tempLine.setAttribute('d', `M ${startPos.x} ${startPos.y} Q ${c1.x} ${c1.y}, ${x} ${y}`);
    };
    
    const upHandler = async (e) => {
      // Clean up
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      tempLine.remove();
      startPort?.classList.remove('active');
      
      document.querySelectorAll('.potential-target').forEach(port => {
        port.classList.remove('potential-target');
      });
      
      // Check if we dropped on a port
      const target = e.target;
      if (target.classList.contains('connection-port') && target.dataset.step !== fromStepId) {
        const toStepId = target.dataset.step;
        await this.createPath(fromStepId, toStepId, window.t('builder.connections.continue'));
      }
    };
    
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  }
  
  startConnection(fromStepId, _e) {
    // Fallback - show modal
    const otherSteps = this.steps.filter(s => s.id !== fromStepId);
    if (otherSteps.length === 0) {
      this.showToast(window.t('builder.messages.createStepFirst'), 'info');
      return;
    }
    
    this.showAddPathModal(this.steps.find(s => s.id === fromStepId));
  }
  
  // ============================================
  // PREVIEW MODE
  // ============================================
  
  async openPreview() {
    const startStep = this.steps.find(s => s.is_start) || this.steps[0];
    if (!startStep) {
      await window.gryffi.modal.alert(window.t('builder.messages.addStepsFirst'));
      return;
    }
    await this._launchPreview(startStep, { fromStart: true });
  }

  /**
   * Open preview starting from a specific step. Used by the
   * "Preview from this step" action in the properties panel.
   *
   * Behaviour differences vs. openPreview():
   *   - Initial step is the given step (not necessarily is_start).
   *   - on_journey_start automation is NOT triggered, to avoid sending
   *     automation emails (welcome notifications, etc.) during a partial
   *     test run.
   *   - A discreet info banner is shown in the preview header to remind
   *     the maker that this run does not represent the full journey.
   */
  async openPreviewFromStep(stepId) {
    const step = this.steps.find(s => s.id === stepId);
    if (!step) return;
    await this._launchPreview(step, { fromStart: false });
  }

  /**
   * Shared preview launch routine.
   * @param {Object} initialStep - The step where preview begins.
   * @param {Object} options
   * @param {boolean} options.fromStart - When true, behaves as a real journey
   *   run (triggers on_journey_start automation, hides the partial-run banner).
   *   When false, skips the journey-start automation and shows the banner.
   */
  async _launchPreview(initialStep, { fromStart }) {
    await this.loadOrganizationThemeForPreview();

    this.previewState = {
      currentStep: initialStep,
      visitedSteps: [],
      collectedResources: [],
      chatHistory: [],
      messageCount: 0,
      pacingUnlocked: false,
      pacingTimer: null,
      videoTimerStarted: false,
      currentQuizQuestionIndex: 0,
      guideChatHistories: {},
      guideChatOpen: false,
      currentGuide: null,
      // Track the entry point so the partial-run banner can be hidden once
      // the maker navigates to a subsequent step.
      previewEntryStepId: initialStep.id,
      previewStartedFromNonStart: !fromStart
    };

    document.getElementById('previewModal').classList.remove('hidden');
    this.updatePartialPreviewBanner();
    this.renderPreview();
    this.updatePlayerProgress();
    this.initGuideChat();

    if (fromStart) {
      this.triggerAutomation('on_journey_start', initialStep.id);
    }
    this.triggerAutomation('on_step_enter', initialStep.id);
  }

  /**
   * Show or hide the "preview started from step X" banner. The banner is
   * only meaningful on the entry step; once the maker navigates onward the
   * test run is identical to a normal preview from there, so we hide it.
   */
  updatePartialPreviewBanner() {
    const banner = document.getElementById('previewStartedFromBanner');
    if (!banner) return;

    const state = this.previewState || {};
    const onEntryStep = state.currentStep && state.currentStep.id === state.previewEntryStepId;
    const shouldShow = state.previewStartedFromNonStart && onEntryStep;

    if (!shouldShow) {
      banner.classList.add('hidden');
      return;
    }

    const textEl = document.getElementById('previewStartedFromBannerText');
    if (textEl) {
      const stepTitle = state.currentStep?.title || '';
      const template = window.t('builder.preview.startedFromStep') || '';
      textEl.textContent = template.replace(/\{\{step\}\}/g, stepTitle);
    }
    banner.classList.remove('hidden');
  }
  
  initGuideChat() {
    // Bind chat events once (will use previewState.currentGuide dynamically)
    this.bindGuideChatEvents();
    
    // Update for the initial step
    const startStep = this.previewState.currentStep;
    this.updateGuideChatForStep(startStep);
  }
  
  /**
   * Initialize mini panorama viewer in editor preview
   * Uses a simplified version with smooth background scrolling
   */
  initMiniPanoramaViewer() {
    const miniViewer = document.getElementById('panoramaMiniViewer');
    if (!miniViewer) return;
    
    const url = miniViewer.dataset.url;
    if (!url) return;
    
    // Load image to get dimensions
    const img = new Image();
    img.onload = () => {
      // Calculate background size to show good portion of panorama
      const viewerHeight = miniViewer.offsetHeight;
      const imgAspect = img.naturalWidth / img.naturalHeight;
      
      // Make the background tall enough to fill, and wide enough to scroll
      const bgHeight = viewerHeight;
      const bgWidth = bgHeight * imgAspect;
      
      miniViewer.style.backgroundImage = `url(${url})`;
      miniViewer.style.backgroundSize = `${bgWidth}px ${bgHeight}px`;
      miniViewer.style.backgroundRepeat = 'repeat-x';
      
      let posX = 0;
      let isDragging = false;
      let startX = 0;
      let velocityX = 0;
      let animationId = null;
      
      const updatePosition = () => {
        miniViewer.style.backgroundPosition = `${posX}px center`;
      };
      
      const animate = () => {
        if (Math.abs(velocityX) > 0.5) {
          posX += velocityX;
          velocityX *= 0.92;
          updatePosition();
          animationId = requestAnimationFrame(animate);
        } else {
          animationId = null;
        }
      };
      
      const startDrag = (e) => {
        isDragging = true;
        startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        if (animationId) {
          cancelAnimationFrame(animationId);
          animationId = null;
        }
        velocityX = 0;
        miniViewer.style.cursor = 'grabbing';
      };
      
      const doDrag = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        const diff = clientX - startX;
        velocityX = diff * 0.4;
        posX += diff * 0.8;
        startX = clientX;
        updatePosition();
      };
      
      const endDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        miniViewer.style.cursor = 'grab';
        
        // Apply momentum
        if (Math.abs(velocityX) > 0.5) {
          animate();
        }
      };
      
      miniViewer.addEventListener('mousedown', startDrag);
      miniViewer.addEventListener('touchstart', startDrag, { passive: false });
      document.addEventListener('mousemove', doDrag);
      document.addEventListener('touchmove', doDrag, { passive: false });
      document.addEventListener('mouseup', endDrag);
      document.addEventListener('touchend', endDrag);
      
      updatePosition();
      miniViewer.style.cursor = 'grab';
    };
    
    img.src = url;
  }
  
  /**
   * Load floorplans for the organization
   */
  async loadFloorplans() {
    const select = document.getElementById('propFloorplanId');
    if (!select) return;
    
    try {
      const response = await fetch('/api/floorplans');
      const data = await response.json();
      
      if (data.success) {
        // Store floorplans for later use
        this.floorplans = data.floorplans;
        
        // Get current selection from step props
        const currentStep = this.steps.find(s => s.id === this.selectedStepId);
        const currentProps = typeof currentStep?.basic_props === 'string' 
          ? JSON.parse(currentStep.basic_props) 
          : (currentStep?.basic_props || {});
        const currentFloorplanId = currentProps.floorplan?.floorplan_id;
        
        // Populate select
        select.innerHTML = `<option value="">${window.t('builder.props.selectFloorplan')}</option>`;
        
        if (data.floorplans.length === 0) {
          select.innerHTML += `<option value="" disabled>${window.t('builder.props.noFloorplans')}</option>`;
        } else {
          data.floorplans.forEach(fp => {
            const selected = fp.id === currentFloorplanId ? 'selected' : '';
            select.innerHTML += `<option value="${fp.id}" data-url="${escapeHtml(fp.image_url)}" ${selected}>${escapeHtml(fp.name)}</option>`;
          });
        }
        
        // Show marker area if a floorplan is selected
        if (currentFloorplanId) {
          const currentFloorplan = data.floorplans.find(fp => fp.id === currentFloorplanId);
          if (currentFloorplan) {
            this.showFloorplanMarkerArea(currentFloorplan.image_url, currentProps.floorplan?.marker_x, currentProps.floorplan?.marker_y);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load floorplans:', err);
    }
  }
  
  /**
   * Show the floorplan marker placement area
   */
  showFloorplanMarkerArea(imageUrl, markerX = null, markerY = null) {
    const markerArea = document.getElementById('floorplanMarkerArea');
    const previewImg = document.getElementById('floorplanPreviewImg');
    const marker = document.getElementById('floorplanMarker');
    const hint = document.getElementById('floorplanMarkerHint');
    
    if (!markerArea || !previewImg) return;
    
    previewImg.src = imageUrl;
    markerArea.classList.remove('hidden');
    
    // If marker position exists, show it
    if (markerX !== null && markerY !== null) {
      marker.style.left = `${markerX}%`;
      marker.style.top = `${markerY}%`;
      marker.classList.remove('hidden');
      hint.textContent = `${window.t('builder.props.markerPlaced')} - ${window.t('builder.props.moveMarker')}`;
    } else {
      marker.classList.add('hidden');
      hint.textContent = window.t('builder.props.clickToPlaceMarker');
    }
  }
  
  /**
   * Show the floorplan upload modal
   */
  async showFloorplanUploadModal() {
    const content = `
      <div class="space-y-4">
        <div>
          <label class="form-label">${window.t('builder.props.floorplanName')}</label>
          <input type="text" id="newFloorplanName" class="form-input" placeholder="${window.t('builder.props.floorplanNamePlaceholder')}" />
        </div>
        <div>
          <label class="form-label">${window.t('builder.props.floorplanDescription')}</label>
          <input type="text" id="newFloorplanDescription" class="form-input" placeholder="${window.t('builder.props.floorplanDescriptionPlaceholder')}" />
        </div>
        <div>
          <label class="form-label">${window.t('builder.props.uploadFloorplan')}</label>
          <div class="floorplan-upload-zone" id="floorplanUploadZone">
            <input type="file" id="floorplanFileInput" accept="image/jpeg,image/png,image/webp" class="hidden" />
            <div class="upload-placeholder">
              <svg class="w-10 h-10 text-zen-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"></path>
              </svg>
              <p class="text-sm text-zen-600">${window.t('imagePicker.dropHere')}</p>
              <p class="text-xs text-zen-400 mt-1">JPEG, PNG, WebP</p>
            </div>
            <div class="upload-preview hidden">
              <img id="floorplanUploadPreview" src="" alt="Preview" />
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Show modal and setup event listeners after DOM is ready
    setTimeout(() => {
      const uploadZone = document.getElementById('floorplanUploadZone');
      const fileInput = document.getElementById('floorplanFileInput');
      const preview = uploadZone?.querySelector('.upload-preview');
      const placeholder = uploadZone?.querySelector('.upload-placeholder');
      const previewImg = document.getElementById('floorplanUploadPreview');
      
      uploadZone?.addEventListener('click', () => fileInput?.click());
      
      uploadZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
      });
      
      uploadZone?.addEventListener('dragleave', () => {
        uploadZone.classList.remove('dragover');
      });
      
      uploadZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
          fileInput.files = e.dataTransfer.files;
          showPreview(e.dataTransfer.files[0]);
        }
      });
      
      fileInput?.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
          showPreview(fileInput.files[0]);
        }
      });
      
      function showPreview(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          previewImg.src = e.target.result;
          preview?.classList.remove('hidden');
          placeholder?.classList.add('hidden');
        };
        reader.readAsDataURL(file);
      }
    }, 100);
    
    const confirmed = await window.gryffi.modal.confirm(content, {
      title: window.t('builder.props.uploadNewFloorplan'),
      confirmText: window.t('common.upload'),
      cancelText: window.t('common.cancel'),
      size: 'medium',
      html: true,
      danger: false
    });
    
    if (confirmed) {
      await this.uploadFloorplan();
    }
  }
  
  /**
   * Handle floorplan file upload
   */
  async uploadFloorplan() {
    const nameInput = document.getElementById('newFloorplanName');
    const descInput = document.getElementById('newFloorplanDescription');
    const fileInput = document.getElementById('floorplanFileInput');
    
    const name = nameInput?.value?.trim();
    const description = descInput?.value?.trim();
    const file = fileInput?.files?.[0];
    
    if (!name) {
      window.gryffi.toast.error(window.t('builder.props.floorplanName') + ' ' + window.t('common.required'));
      return;
    }
    
    if (!file) {
      window.gryffi.toast.error(window.t('builder.props.uploadFloorplan') + ' ' + window.t('common.required'));
      return;
    }
    
    try {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('name', name);
      formData.append('description', description || '');
      
      const response = await fetch('/api/floorplans', {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (data.success) {
        window.gryffi.toast.success(window.t('common.saved'));
        
        // Reload floorplans and select the new one
        await this.loadFloorplans();
        
        const select = document.getElementById('propFloorplanId');
        if (select) {
          select.value = data.floorplan.id;
          select.dispatchEvent(new Event('change'));
        }
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      console.error('Floorplan upload error:', err);
      window.gryffi.toast.error(window.t('builder.props.uploadFailed'));
    }
  }
  
  /**
   * Show the floorplan overlay for the journey player
   */
  async showFloorplanOverlay(floorplanId, markerX, markerY) {
    // Fetch floorplan details
    let floorplan = this.floorplans?.find(fp => fp.id === floorplanId);
    
    if (!floorplan) {
      try {
        // Use public endpoint for player mode (magic-link users), regular endpoint for builder
        const endpoint = this.playerMode 
          ? `/api/floorplans/public/${floorplanId}`
          : `/api/floorplans/${floorplanId}`;
        const response = await fetch(endpoint);
        const data = await response.json();
        if (data.success) {
          floorplan = data.floorplan;
        }
      } catch (err) {
        console.error('Failed to load floorplan:', err);
        return;
      }
    }
    
    if (!floorplan) return;
    
    // Check if we're on mobile
    const isMobile = window.innerWidth < 768 || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
    
    if (isMobile) {
      this.showFloorplanBottomSheet(floorplan, markerX, markerY);
      return;
    }
    
    // Create overlay HTML for desktop
    const overlayHtml = `
      <div class="floorplan-overlay" id="floorplanOverlay">
        <div class="floorplan-overlay-content">
          <div class="floorplan-overlay-header">
            <h3 class="text-lg font-semibold text-zen-800">${escapeHtml(floorplan.name)}</h3>
            <button class="floorplan-overlay-close" id="closeFloorplanOverlay">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </button>
          </div>
          <div class="floorplan-overlay-body">
            <div class="floorplan-viewer" id="floorplanViewer">
              <div class="floorplan-viewer-inner" id="floorplanViewerInner">
                <img src="${escapeHtml(floorplan.image_url)}" alt="${escapeHtml(floorplan.name)}" id="floorplanViewerImg" />
                ${markerX && markerY ? `
                  <div class="floorplan-viewer-marker" id="floorplanViewerMarker" style="left: ${escapeHtml(markerX)}%; top: ${escapeHtml(markerY)}%;">
                    <div class="floorplan-viewer-marker-inner">
                      <div class="floorplan-viewer-marker-dot"></div>
                      <div class="floorplan-viewer-marker-pulse"></div>
                      <div class="floorplan-viewer-marker-label">${window.t('builder.props.youAreHere')}</div>
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>
            <!-- Zoom controls -->
            <div class="floorplan-zoom-controls">
              <button class="floorplan-zoom-btn" id="floorplanZoomIn" title="Zoom in">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                </svg>
              </button>
              <button class="floorplan-zoom-btn" id="floorplanZoomOut" title="Zoom out">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"></path>
                </svg>
              </button>
              <button class="floorplan-zoom-btn" id="floorplanCenterMarker" title="Center on marker">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path>
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path>
                </svg>
              </button>
            </div>
          </div>
          ${floorplan.description ? `
            <div class="floorplan-overlay-footer">
              <p class="text-sm text-zen-600">${escapeHtml(floorplan.description)}</p>
            </div>
          ` : ''}
        </div>
      </div>
    `;
    
    // Add overlay to DOM
    document.body.insertAdjacentHTML('beforeend', overlayHtml);
    
    const overlay = document.getElementById('floorplanOverlay');
    const closeBtn = document.getElementById('closeFloorplanOverlay');
    const viewer = document.getElementById('floorplanViewer');
    const viewerInner = document.getElementById('floorplanViewerInner');
    const img = document.getElementById('floorplanViewerImg');
    const marker = document.getElementById('floorplanViewerMarker');
    const zoomInBtn = document.getElementById('floorplanZoomIn');
    const zoomOutBtn = document.getElementById('floorplanZoomOut');
    const centerBtn = document.getElementById('floorplanCenterMarker');
    
    // Zoom state
    let currentZoom = 1;
    const minZoom = 0.1;
    const maxZoom = 2;
    const zoomStep = 0.15;
    
    // Close handlers
    const closeOverlay = () => {
      overlay?.classList.add('closing');
      setTimeout(() => overlay?.remove(), 200);
    };
    
    closeBtn?.addEventListener('click', closeOverlay);
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) closeOverlay();
    });
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') {
        closeOverlay();
        document.removeEventListener('keydown', escHandler);
      }
    });
    
    // Update marker scale to keep it constant size
    const updateMarkerScale = () => {
      if (marker) {
        // Counter-scale the marker so it stays the same visual size
        const inverseScale = 1 / currentZoom;
        marker.style.transform = `translate(-50%, -50%) scale(${inverseScale})`;
      }
    };
    
    // Zoom functions
    const setZoom = (zoom, _animate = false) => {
      currentZoom = Math.max(minZoom, Math.min(maxZoom, zoom));
      viewerInner.style.transform = `scale(${currentZoom})`;
      viewerInner.style.transformOrigin = '0 0';
      updateMarkerScale();
    };
    
    // Calculate max scroll boundaries
    const getScrollBounds = () => {
      const scaledWidth = img.naturalWidth * currentZoom;
      const scaledHeight = img.naturalHeight * currentZoom;
      return {
        maxX: Math.max(0, scaledWidth - viewer.clientWidth),
        maxY: Math.max(0, scaledHeight - viewer.clientHeight)
      };
    };
    
    // Clamp scroll position within bounds
    const clampScroll = () => {
      const bounds = getScrollBounds();
      viewer.scrollLeft = Math.max(0, Math.min(bounds.maxX, viewer.scrollLeft));
      viewer.scrollTop = Math.max(0, Math.min(bounds.maxY, viewer.scrollTop));
    };
    
    const centerOnMarker = (animate = true) => {
      if (!markerX || !markerY || !img.naturalWidth) return;
      
      // Calculate marker position in the scaled coordinate system
      const scaledWidth = img.naturalWidth * currentZoom;
      const scaledHeight = img.naturalHeight * currentZoom;
      const markerPosX = (parseFloat(markerX) / 100) * scaledWidth;
      const markerPosY = (parseFloat(markerY) / 100) * scaledHeight;
      
      // Calculate scroll position to center the marker
      const bounds = getScrollBounds();
      const targetScrollX = Math.max(0, Math.min(bounds.maxX, markerPosX - (viewer.clientWidth / 2)));
      const targetScrollY = Math.max(0, Math.min(bounds.maxY, markerPosY - (viewer.clientHeight / 2)));
      
      if (animate) {
        viewer.scrollTo({
          left: targetScrollX,
          top: targetScrollY,
          behavior: 'smooth'
        });
      } else {
        viewer.scrollLeft = targetScrollX;
        viewer.scrollTop = targetScrollY;
      }
    };
    
    zoomInBtn?.addEventListener('click', () => {
      setZoom(currentZoom + zoomStep);
      setTimeout(() => centerOnMarker(true), 10);
    });
    
    zoomOutBtn?.addEventListener('click', () => {
      setZoom(currentZoom - zoomStep);
      setTimeout(() => centerOnMarker(true), 10);
    });
    
    centerBtn?.addEventListener('click', () => centerOnMarker(true));
    
    // Pan functionality for large floorplans
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let scrollStartLeft = 0;
    let scrollStartTop = 0;
    
    viewer?.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      scrollStartLeft = viewer.scrollLeft;
      scrollStartTop = viewer.scrollTop;
      viewer.style.cursor = 'grabbing';
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const bounds = getScrollBounds();
      viewer.scrollLeft = Math.max(0, Math.min(bounds.maxX, scrollStartLeft - dx));
      viewer.scrollTop = Math.max(0, Math.min(bounds.maxY, scrollStartTop - dy));
    });
    
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        viewer.style.cursor = 'grab';
      }
    });
    
    // Touch support
    viewer?.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        isDragging = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        scrollStartLeft = viewer.scrollLeft;
        scrollStartTop = viewer.scrollTop;
      }
    }, { passive: true });
    
    viewer?.addEventListener('touchmove', (e) => {
      if (!isDragging || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      const bounds = getScrollBounds();
      viewer.scrollLeft = Math.max(0, Math.min(bounds.maxX, scrollStartLeft - dx));
      viewer.scrollTop = Math.max(0, Math.min(bounds.maxY, scrollStartTop - dy));
    }, { passive: true });
    
    viewer?.addEventListener('touchend', () => {
      isDragging = false;
    });
    
    // Also clamp on regular scroll events (e.g., mouse wheel)
    viewer?.addEventListener('scroll', () => {
      requestAnimationFrame(clampScroll);
    });
    
    // Initialize view when image loads - start at fit-to-view zoom and center on marker
    img?.addEventListener('load', () => {
      const viewerWidth = viewer.clientWidth;
      const viewerHeight = viewer.clientHeight;
      const imgWidth = img.naturalWidth;
      const imgHeight = img.naturalHeight;
      
      // Calculate zoom to fit entire image in viewer (with some padding)
      const fitZoomX = (viewerWidth * 0.9) / imgWidth;
      const fitZoomY = (viewerHeight * 0.9) / imgHeight;
      const fitZoom = Math.min(fitZoomX, fitZoomY);
      
      // Use fit zoom but clamp between min and max
      currentZoom = Math.max(minZoom, Math.min(maxZoom, fitZoom));
      
      // Apply initial zoom
      setZoom(currentZoom);
      viewer.style.cursor = 'grab';
      
      // Center on marker immediately (no animation for initial load)
      // Use requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(() => {
        centerOnMarker(false);
      });
    });
    
    // Animate in
    requestAnimationFrame(() => {
      overlay?.classList.add('visible');
    });
  }
  
  /**
   * Show floorplan as a bottom sheet on mobile devices
   */
  showFloorplanBottomSheet(floorplan, markerX, markerY) {
    // Create bottom sheet HTML
    const sheetHtml = `
      <div class="floorplan-sheet-backdrop" id="floorplanSheetBackdrop"></div>
      <div class="floorplan-sheet" id="floorplanSheet">
        <div class="floorplan-sheet-header" id="floorplanSheetHeader">
          <div class="floorplan-sheet-handle"></div>
          <h3 class="floorplan-sheet-title">${escapeHtml(floorplan.name)}</h3>
          <button class="floorplan-sheet-close" id="closeFloorplanSheet">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <div class="floorplan-sheet-body">
          <div class="floorplan-sheet-viewer" id="floorplanSheetViewer">
            <div class="floorplan-sheet-viewer-inner" id="floorplanSheetViewerInner">
              <img src="${escapeHtml(floorplan.image_url)}" alt="${escapeHtml(floorplan.name)}" id="floorplanSheetImg" />
              ${markerX && markerY ? `
                <div class="floorplan-viewer-marker" id="floorplanSheetMarker" style="left: ${escapeHtml(markerX)}%; top: ${escapeHtml(markerY)}%;">
                  <div class="floorplan-viewer-marker-inner">
                    <div class="floorplan-viewer-marker-dot"></div>
                    <div class="floorplan-viewer-marker-pulse"></div>
                    <div class="floorplan-viewer-marker-label">${window.t('builder.props.youAreHere')}</div>
                  </div>
                </div>
              ` : ''}
            </div>
          </div>
          <!-- Zoom controls -->
          <div class="floorplan-zoom-controls">
            <button class="floorplan-zoom-btn" id="floorplanSheetZoomIn" title="Zoom in">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
              </svg>
            </button>
            <button class="floorplan-zoom-btn" id="floorplanSheetZoomOut" title="Zoom out">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"></path>
              </svg>
            </button>
            <button class="floorplan-zoom-btn" id="floorplanSheetCenterMarker" title="Center on marker">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path>
              </svg>
            </button>
          </div>
        </div>
        ${floorplan.description ? `
          <div class="floorplan-sheet-footer">
            <p class="text-sm text-zen-600">${escapeHtml(floorplan.description)}</p>
          </div>
        ` : ''}
      </div>
    `;
    
    // Add to DOM
    document.body.insertAdjacentHTML('beforeend', sheetHtml);
    
    const backdrop = document.getElementById('floorplanSheetBackdrop');
    const sheet = document.getElementById('floorplanSheet');
    const header = document.getElementById('floorplanSheetHeader');
    const closeBtn = document.getElementById('closeFloorplanSheet');
    const viewer = document.getElementById('floorplanSheetViewer');
    const viewerInner = document.getElementById('floorplanSheetViewerInner');
    const img = document.getElementById('floorplanSheetImg');
    const marker = document.getElementById('floorplanSheetMarker');
    const zoomInBtn = document.getElementById('floorplanSheetZoomIn');
    const zoomOutBtn = document.getElementById('floorplanSheetZoomOut');
    const centerBtn = document.getElementById('floorplanSheetCenterMarker');
    
    // Zoom state
    let currentZoom = 1;
    const minZoom = 0.1;
    const maxZoom = 2;
    const zoomStep = 0.15;
    
    // Close function
    const closeSheet = () => {
      sheet.classList.add('closing');
      backdrop.classList.add('closing');
      setTimeout(() => {
        sheet?.remove();
        backdrop?.remove();
      }, 300);
    };
    
    // Close handlers
    closeBtn?.addEventListener('click', closeSheet);
    backdrop?.addEventListener('click', closeSheet);
    
    // Update marker scale
    const updateMarkerScale = () => {
      if (marker) {
        const inverseScale = 1 / currentZoom;
        marker.style.transform = `translate(-50%, -50%) scale(${inverseScale})`;
      }
    };
    
    // Scroll bounds
    const getScrollBounds = () => {
      const scaledWidth = img.naturalWidth * currentZoom;
      const scaledHeight = img.naturalHeight * currentZoom;
      return {
        maxX: Math.max(0, scaledWidth - viewer.clientWidth),
        maxY: Math.max(0, scaledHeight - viewer.clientHeight)
      };
    };
    
    // Zoom functions
    const setZoom = (zoom) => {
      currentZoom = Math.max(minZoom, Math.min(maxZoom, zoom));
      viewerInner.style.transform = `scale(${currentZoom})`;
      viewerInner.style.transformOrigin = '0 0';
      updateMarkerScale();
    };
    
    const centerOnMarker = (animate = true) => {
      if (!markerX || !markerY || !img.naturalWidth) return;
      
      const scaledWidth = img.naturalWidth * currentZoom;
      const scaledHeight = img.naturalHeight * currentZoom;
      const markerPosX = (parseFloat(markerX) / 100) * scaledWidth;
      const markerPosY = (parseFloat(markerY) / 100) * scaledHeight;
      
      const bounds = getScrollBounds();
      const targetScrollX = Math.max(0, Math.min(bounds.maxX, markerPosX - (viewer.clientWidth / 2)));
      const targetScrollY = Math.max(0, Math.min(bounds.maxY, markerPosY - (viewer.clientHeight / 2)));
      
      if (animate) {
        viewer.scrollTo({ left: targetScrollX, top: targetScrollY, behavior: 'smooth' });
      } else {
        viewer.scrollLeft = targetScrollX;
        viewer.scrollTop = targetScrollY;
      }
    };
    
    zoomInBtn?.addEventListener('click', () => {
      setZoom(currentZoom + zoomStep);
      setTimeout(() => centerOnMarker(true), 10);
    });
    
    zoomOutBtn?.addEventListener('click', () => {
      setZoom(currentZoom - zoomStep);
      setTimeout(() => centerOnMarker(true), 10);
    });
    
    centerBtn?.addEventListener('click', () => centerOnMarker(true));
    
    // Pan and pinch-to-zoom functionality
    let isPanning = false;
    let isPinching = false;
    let panStartX = 0;
    let panStartY = 0;
    let scrollStartLeft = 0;
    let scrollStartTop = 0;
    let initialPinchDistance = 0;
    let initialPinchZoom = 1;
    
    // Calculate distance between two touch points
    const getTouchDistance = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    
    viewer?.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        // Single finger - pan mode
        isPanning = true;
        isPinching = false;
        panStartX = e.touches[0].clientX;
        panStartY = e.touches[0].clientY;
        scrollStartLeft = viewer.scrollLeft;
        scrollStartTop = viewer.scrollTop;
      } else if (e.touches.length === 2) {
        // Two fingers - pinch zoom mode
        isPanning = false;
        isPinching = true;
        initialPinchDistance = getTouchDistance(e.touches);
        initialPinchZoom = currentZoom;
        e.preventDefault(); // Prevent page zoom
      }
    }, { passive: false });
    
    viewer?.addEventListener('touchmove', (e) => {
      if (isPinching && e.touches.length === 2) {
        // Pinch zoom
        e.preventDefault(); // Prevent page zoom
        const currentDistance = getTouchDistance(e.touches);
        const scale = currentDistance / initialPinchDistance;
        const newZoom = Math.max(minZoom, Math.min(maxZoom, initialPinchZoom * scale));
        setZoom(newZoom);
      } else if (isPanning && e.touches.length === 1) {
        // Pan
        const dx = e.touches[0].clientX - panStartX;
        const dy = e.touches[0].clientY - panStartY;
        const bounds = getScrollBounds();
        viewer.scrollLeft = Math.max(0, Math.min(bounds.maxX, scrollStartLeft - dx));
        viewer.scrollTop = Math.max(0, Math.min(bounds.maxY, scrollStartTop - dy));
      }
    }, { passive: false });
    
    viewer?.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) {
        isPinching = false;
      }
      if (e.touches.length === 0) {
        isPanning = false;
      }
    });
    
    // Sheet drag functionality
    let isDragging = false;
    let dragStartY = 0;
    let sheetStartHeight = 0;
    const maxHeight = window.innerHeight * 0.9;
    const minHeight = 200;
    const closeThreshold = 100;
    
    header?.addEventListener('touchstart', (e) => {
      // Don't drag if touching close button
      if (e.target === closeBtn || closeBtn?.contains(e.target)) return;
      isDragging = true;
      dragStartY = e.touches[0].clientY;
      sheetStartHeight = sheet.offsetHeight;
      sheet.style.transition = 'none';
    }, { passive: true });
    
    document.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const deltaY = dragStartY - e.touches[0].clientY;
      let newHeight = sheetStartHeight + deltaY;
      newHeight = Math.max(0, Math.min(maxHeight, newHeight));
      sheet.style.height = `${newHeight}px`;
    }, { passive: true });
    
    document.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      sheet.style.transition = '';
      
      const currentHeight = sheet.offsetHeight;
      if (currentHeight < closeThreshold) {
        closeSheet();
      } else if (currentHeight < minHeight + 50) {
        sheet.style.height = `${minHeight}px`;
      }
    });
    
    // Initialize on image load
    img?.addEventListener('load', () => {
      const viewerWidth = viewer.clientWidth;
      const viewerHeight = viewer.clientHeight;
      const imgWidth = img.naturalWidth;
      const imgHeight = img.naturalHeight;
      
      const fitZoomX = (viewerWidth * 0.9) / imgWidth;
      const fitZoomY = (viewerHeight * 0.9) / imgHeight;
      const fitZoom = Math.min(fitZoomX, fitZoomY);
      currentZoom = Math.max(minZoom, Math.min(maxZoom, fitZoom));
      
      setZoom(currentZoom);
      
      requestAnimationFrame(() => {
        centerOnMarker(false);
      });
    });
    
    // Animate in
    requestAnimationFrame(() => {
      backdrop?.classList.add('visible');
      sheet?.classList.add('visible');
    });
  }
  
  /**
   * Initialize full panorama viewer for journey player/preview
   * Uses cylindrical projection for smooth 360° viewing
   */
  initPanoramaViewer(container, imageUrl) {
    if (!container || !imageUrl) return;
    
    // Create panorama viewer HTML
    container.innerHTML = `
      <div class="panorama-viewer" id="panoramaViewerActive">
        <div class="panorama-canvas-wrapper">
          <canvas class="panorama-canvas"></canvas>
        </div>
        <div class="panorama-badge">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          360°
        </div>
        <div class="panorama-hint" id="panoramaHint">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l4-4 4 4m0 6l-4 4-4-4"></path>
          </svg>
          <span>${window.t('builder.props.panoramaDragHint')}</span>
        </div>
        <div class="panorama-controls">
          <button class="panorama-control-btn" id="panoramaZoomIn" title="Zoom in">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
            </svg>
          </button>
          <button class="panorama-control-btn" id="panoramaZoomOut" title="Zoom out">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
    
    const canvas = container.querySelector('.panorama-canvas');
    const hint = container.querySelector('#panoramaHint');
    const ctx = canvas.getContext('2d');
    
    // Load the panorama image
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    // State
    let yaw = 0;      // Horizontal rotation (0-360 degrees mapped to image width)
    let pitch = 0;    // Vertical rotation (-90 to 90 degrees)
    let fov = 75;     // Field of view
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    let velocityX = 0;
    let velocityY = 0;
    let animationId = null;
    let hasInteracted = false;
    
    // Set canvas size
    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      render();
    };
    
    // Render the panorama view
    const render = () => {
      if (!img.complete || img.naturalWidth === 0) return;
      
      const w = canvas.width;
      const h = canvas.height;
      
      // Clear canvas
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, w, h);
      
      // Calculate visible portion of the panorama
      const imgW = img.naturalWidth;
      const imgH = img.naturalHeight;
      
      // FOV determines how much of the image we see
      const visibleWidth = imgW * (fov / 360);
      
      // Yaw determines horizontal position (wrapping around)
      const normalizedYaw = ((yaw % 360) + 360) % 360;
      const srcX = (normalizedYaw / 360) * imgW;
      
      // Pitch affects vertical offset
      const pitchOffset = (pitch / 90) * (imgH / 4);
      
      // Draw the panorama with wrapping
      const drawWidth = visibleWidth;
      const srcXNorm = srcX % imgW;
      
      // Calculate destination dimensions to fill canvas
      const aspectRatio = drawWidth / imgH;
      
      let destH = h;
      let destW = h * aspectRatio;
      
      if (destW < w) {
        destW = w;
        destH = w / aspectRatio;
      }
      
      const destX = (w - destW) / 2;
      const destY = (h - destH) / 2 - pitchOffset * (destH / imgH);
      
      // Draw first part
      const firstPartWidth = Math.min(drawWidth, imgW - srcXNorm);
      const firstPartRatio = firstPartWidth / drawWidth;
      
      ctx.drawImage(
        img,
        srcXNorm, 0, firstPartWidth, imgH,
        destX, destY, destW * firstPartRatio, destH
      );
      
      // Draw wrapped part if needed
      if (srcXNorm + drawWidth > imgW) {
        const secondPartWidth = drawWidth - firstPartWidth;
        ctx.drawImage(
          img,
          0, 0, secondPartWidth, imgH,
          destX + destW * firstPartRatio, destY, destW * (1 - firstPartRatio), destH
        );
      }
    };
    
    // Animation loop for momentum
    const animate = () => {
      if (Math.abs(velocityX) > 0.01 || Math.abs(velocityY) > 0.01) {
        yaw += velocityX;
        pitch = Math.max(-45, Math.min(45, pitch + velocityY));
        
        // Friction
        velocityX *= 0.95;
        velocityY *= 0.95;
        
        render();
        animationId = requestAnimationFrame(animate);
      } else {
        animationId = null;
      }
    };
    
    // Event handlers
    const onPointerDown = (e) => {
      isDragging = true;
      const point = e.touches ? e.touches[0] : e;
      lastX = point.clientX;
      lastY = point.clientY;
      
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
      
      velocityX = 0;
      velocityY = 0;
      
      // Hide hint on first interaction
      if (!hasInteracted && hint) {
        hasInteracted = true;
        hint.style.opacity = '0';
        setTimeout(() => hint.style.display = 'none', 300);
      }
      
      container.style.cursor = 'grabbing';
    };
    
    const onPointerMove = (e) => {
      if (!isDragging) return;
      e.preventDefault();
      
      const point = e.touches ? e.touches[0] : e;
      const deltaX = point.clientX - lastX;
      const deltaY = point.clientY - lastY;
      
      // Sensitivity based on FOV - balanced for smooth but responsive movement
      const sensitivity = fov / 1600;
      
      velocityX = -deltaX * sensitivity * 1.3;
      velocityY = -deltaY * sensitivity * 1.8; // Inverted for natural scrolling
      
      yaw += velocityX * 3.5;
      pitch = Math.max(-45, Math.min(45, pitch + velocityY * 4.5));
      
      lastX = point.clientX;
      lastY = point.clientY;
      
      render();
    };
    
    const onPointerUp = () => {
      if (!isDragging) return;
      isDragging = false;
      container.style.cursor = 'grab';
      
      // Start momentum animation
      if (Math.abs(velocityX) > 0.01 || Math.abs(velocityY) > 0.01) {
        animate();
      }
    };
    
    const onWheel = (e) => {
      e.preventDefault();
      fov = Math.max(30, Math.min(120, fov + e.deltaY * 0.05));
      render();
    };
    
    // Zoom controls
    container.querySelector('#panoramaZoomIn')?.addEventListener('click', () => {
      fov = Math.max(30, fov - 10);
      render();
    });
    
    container.querySelector('#panoramaZoomOut')?.addEventListener('click', () => {
      fov = Math.min(120, fov + 10);
      render();
    });
    
    // Bind events
    container.addEventListener('mousedown', onPointerDown);
    container.addEventListener('touchstart', onPointerDown, { passive: false });
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', resize);
    
    // Load image and start
    img.onload = () => {
      resize();
      container.style.cursor = 'grab';
    };
    
    img.onerror = () => {
      console.error('Failed to load panorama image:', imageUrl);
      container.innerHTML = `
        <div class="panorama-error">
          <svg class="w-12 h-12 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
          <p>Failed to load panorama</p>
        </div>
      `;
    };
    
    img.src = imageUrl;
    
    // Cleanup function
    container._panoramaCleanup = () => {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      window.removeEventListener('touchmove', onPointerMove);
      window.removeEventListener('touchend', onPointerUp);
      window.removeEventListener('resize', resize);
      if (animationId) cancelAnimationFrame(animationId);
    };
  }
  
  updateGuideChatForStep(step) {
    const widget = document.getElementById('guideChatWidget');
    if (!widget) return;
    
    // Parse advanced props
    const advProps = typeof step.advanced_props === 'string' 
      ? JSON.parse(step.advanced_props || '{}') 
      : (step.advanced_props || {});
    
    // Get step-level assistant guide
    let guide = null;
    if (advProps.assistant_guide_id) {
      guide = this.guides.find(g => g.id === advProps.assistant_guide_id);
    }
    
    // Store current guide in preview state
    this.previewState.currentGuide = guide;
    
    if (!guide) {
      widget.classList.add('hidden');
      return;
    }
    
    // Show widget and populate guide info
    widget.classList.remove('hidden');
    
    // FAB avatar and name
    const fabAvatar = document.getElementById('guideChatFabAvatar');
    const fabName = document.getElementById('guideChatFabName');
    if (fabAvatar) {
      fabAvatar.innerHTML = guide.avatar_url 
        ? `<img src="${escapeHtml(guide.avatar_url)}" alt="${escapeHtml(guide.name)}">` 
        : guide.name.charAt(0).toUpperCase();
    }
    if (fabName) {
      const askText = window.tPlayer('player.chat.askGuide', { name: guide.name });
      fabName.textContent = askText;
    }
    
    // Set input placeholder
    const chatInput = document.getElementById('guideChatInput');
    if (chatInput) {
      chatInput.placeholder = window.tPlayer('player.chat.typeQuestion');
    }
    
    // Panel avatar and info
    const chatAvatar = document.getElementById('guideChatAvatar');
    const chatName = document.getElementById('guideChatName');
    const chatRole = document.getElementById('guideChatRole');
    if (chatAvatar) {
      chatAvatar.innerHTML = guide.avatar_url 
        ? `<img src="${escapeHtml(guide.avatar_url)}" alt="${escapeHtml(guide.name)}">` 
        : guide.name.charAt(0).toUpperCase();
    }
    if (chatName) chatName.textContent = guide.name;
    if (chatRole) chatRole.textContent = guide.role || window.t('builder.props.yourGuide');
    
    // Initialize chat history for this guide if not exists
    if (!this.previewState.guideChatHistories[guide.id]) {
      console.log('[Guide Chat] Initializing new history for guide:', guide.id, guide.name);
      this.previewState.guideChatHistories[guide.id] = [];
      
      // Check if there's a static opening override (from copy-translate or manual entry)
      const guideOpeningOverride = this.journey?.guide_opening_override || window.GRYFFI?.guideOpeningOverride;
      
      if (guideOpeningOverride) {
        // Use the static translated opening - fastest option
        console.log('[Guide Chat] Using static opening override');
        this.previewState.guideChatHistories[guide.id].push({
          role: 'guide',
          content: guideOpeningOverride
        });
      } else {
        // Generate dynamic greeting if language is overridden
        const guideLanguage = window.GRYFFI?.guideLanguage || window.GRYFFI?.journeyLanguage || 'en';
        const orgDefaultLanguage = window.GRYFFI?.organization?.defaultLanguage || 'en';
        const needsDynamicGreeting = guideLanguage !== orgDefaultLanguage;
        
        if (needsDynamicGreeting) {
          this.generateDynamicGuideGreeting(guide, guideLanguage);
        } else if (guide.greeting) {
          // Use static greeting when no language override
          this.previewState.guideChatHistories[guide.id].push({
            role: 'guide',
            content: guide.greeting
          });
        }
      }
    } else {
      console.log('[Guide Chat] Using existing history for guide:', guide.id, guide.name, 
        'with', this.previewState.guideChatHistories[guide.id].length, 'messages');
    }
    
    this.renderGuideChatMessages();
  }
  
  // Helper to get current guide's chat history
  getGuideChatHistory() {
    const guide = this.previewState.currentGuide;
    if (!guide) return [];
    return this.previewState.guideChatHistories[guide.id] || [];
  }
  
  // Helper to add message to current guide's chat history
  addToGuideChatHistory(message) {
    const guide = this.previewState.currentGuide;
    if (!guide) return;
    if (!this.previewState.guideChatHistories[guide.id]) {
      this.previewState.guideChatHistories[guide.id] = [];
    }
    this.previewState.guideChatHistories[guide.id].push(message);
  }
  
  // Generate dynamic guide greeting in specified language
  async generateDynamicGuideGreeting(guide, guideLanguage) {
    // Determine the opening endpoint based on mode
    let openingEndpoint;
    const requestBody = {
      guide_id: guide.id,
      guide_language: guideLanguage,
      journey_context: `Journey: ${this.journey?.title || ''}`
    };
    
    if (window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token) {
      openingEndpoint = `/p/${window.GRYFFI.publicPlayer.token}/guide/opening`;
    } else if (this.player?.token) {
      openingEndpoint = `/e/${this.player.token}/guide/opening`;
    } else {
      // Builder preview mode or preview mode without magic link - use API endpoint
      openingEndpoint = '/api/guide/opening';
    }
    
    try {
      console.log('[Guide Chat] Generating dynamic greeting in', guideLanguage, 'via', openingEndpoint);
      const response = await fetch(openingEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(requestBody)
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.opening) {
          this.previewState.guideChatHistories[guide.id].push({
            role: 'guide',
            content: data.opening
          });
          this.renderGuideChatMessages();
          
          // Update guide role with translated version if available
          if (data.guide?.role) {
            const chatRole = document.getElementById('guideChatRole');
            if (chatRole && chatRole.textContent !== data.guide.role) {
              chatRole.textContent = data.guide.role;
              console.log('[Guide Chat] Updated role to translated version:', data.guide.role);
            }
          }
          
          console.log('[Guide Chat] Generated dynamic greeting in', guideLanguage, 'for guide:', guide.id);
          return;
        }
      }
    } catch (err) {
      console.warn('[Guide Chat] Dynamic greeting generation failed:', err.message);
    }
    
    // Fallback to static greeting
    if (guide.greeting) {
      this.previewState.guideChatHistories[guide.id].push({
        role: 'guide',
        content: guide.greeting
      });
      this.renderGuideChatMessages();
    }
  }
  
  // Build detailed step context for AI Guide to understand current step content
  buildDetailedStepContext(step) {
    const basicProps = typeof step.basic_props === 'string' 
      ? JSON.parse(step.basic_props || '{}') 
      : (step.basic_props || {});
    const advProps = typeof step.advanced_props === 'string' 
      ? JSON.parse(step.advanced_props || '{}') 
      : (step.advanced_props || {});
    
    let context = `Current step: "${step.title}" (type: ${step.type})\n`;
    
    if (step.description) {
      context += `Step description: ${step.description}\n`;
    }
    
    // Add type-specific content details
    switch (step.type) {
      case 'challenge':
        // Include ONLY the current quiz question for the AI Guide to help
        // This prevents spoilers for upcoming questions
        // IMPORTANT: Do NOT include which answer is correct - the AI Guide should use RAG
        // to find the answer in its Knowledge Base, so citations work properly
        if (basicProps.questions && basicProps.questions.length > 0) {
          const currentQIndex = this.previewState?.currentQuizQuestionIndex || 0;
          const totalQuestions = basicProps.questions.length;
          const currentQ = basicProps.questions[currentQIndex];
          
          context += `\nThis is a Quiz step. The user is currently on question ${currentQIndex + 1} of ${totalQuestions}.\n`;
          context += `\nCURRENT QUESTION: ${currentQ.question}\n`;
          
          if (currentQ.options && currentQ.options.length > 0) {
            context += `The possible answers are:\n`;
            currentQ.options.forEach((opt, idx) => {
              const letter = String.fromCharCode(65 + idx); // A, B, C, D...
              context += `  ${letter}. ${opt.text}\n`;
            });
          }
          
          context += `\nINSTRUCTIONS FOR HELPING WITH THIS QUIZ:
- The user is asking for help with this quiz question.
- Use your Knowledge Base to find relevant information that helps answer this question.
- Guide the user toward the correct answer by explaining the relevant concepts.
- You can hint at the answer or explain why certain options are correct/incorrect based on your knowledge.
- Only help with this current question. Do NOT reveal or discuss any other questions in the quiz.
- Always cite your sources when providing information from your Knowledge Base.\n`;
          
          // Add passing score info
          if (advProps.passingScore) {
            context += `Note: The user needs at least ${advProps.passingScore} correct answer(s) to pass this quiz.\n`;
          }
        }
        break;
        
      case 'content':
        // Include content body for context
        if (basicProps.body) {
          const bodyPreview = basicProps.body.length > 500 
            ? basicProps.body.substring(0, 500) + '...' 
            : basicProps.body;
          context += `\nContent shown to user:\n${bodyPreview}\n`;
        }
        // Include video URL for AI description lookup (server-side enrichment)
        if (basicProps.video_url) {
          context += `\nThis step includes a video. video_url: "${basicProps.video_url}"\n`;
        }
        // Include image URL for AI description lookup (server-side enrichment)
        if (basicProps.image_url) {
          context += `\nThis step includes an image. image_url: "${basicProps.image_url}"\n`;
        }
        break;
        
      case 'space':
        // Include space description
        if (basicProps.description) {
          context += `\nSpace description: ${basicProps.description}\n`;
        }
        // Include panorama/image URLs for AI description lookup
        if (basicProps.panorama_url) {
          context += `\nThis space has a 360° panorama view. panorama_url: "${basicProps.panorama_url}"\n`;
        }
        if (basicProps.image_url) {
          context += `\nThis space has an image. image_url: "${basicProps.image_url}"\n`;
        }
        break;
        
      case 'form':
        // Include form fields info
        if (basicProps.fields && basicProps.fields.length > 0) {
          context += `\nThis is a Form step collecting the following information:\n`;
          basicProps.fields.forEach((field, idx) => {
            context += `  ${idx + 1}. ${field.label} (${field.type})${field.required ? ' - Required' : ''}\n`;
          });
        }
        break;
        
      case 'guide':
        // Include guide info
        if (basicProps.name) {
          context += `\nThis step features an AI Guide named "${basicProps.name}"`;
          if (basicProps.role) {
            context += ` who serves as "${basicProps.role}"`;
          }
          context += `.\n`;
        }
        break;
        
      case 'poll':
        // Include poll question and all options for the AI Guide to understand what's being asked
        context += `\nThis is a Poll step where users can share their opinion or vote.\n`;
        
        if (basicProps.question) {
          context += `\nPOLL QUESTION: ${basicProps.question}\n`;
        }
        
        if (basicProps.options && basicProps.options.length > 0) {
          context += `\nThe available answer options are:\n`;
          basicProps.options.forEach((opt, idx) => {
            const letter = String.fromCharCode(65 + idx); // A, B, C, D...
            context += `  ${letter}. ${opt.text}\n`;
          });
        }
        
        if (basicProps.allow_multiple) {
          context += `\nNote: Users can select multiple options for this poll.\n`;
        }
        
        context += `\nINSTRUCTIONS FOR HELPING WITH THIS POLL:
- The user may have questions about the poll topic or the options presented.
- Help clarify what each option means if asked.
- You can share relevant information from your Knowledge Base about the poll topic.
- Do NOT tell the user what to vote - polls are for gathering opinions, not right/wrong answers.
- Be helpful and informative without influencing their vote.\n`;
        break;
        
      case 'reward':
        // Include reward information
        context += `\nThis is a Reward step where the user receives a reward for completing the journey.\n`;
        
        if (basicProps.title) {
          context += `\nREWARD: ${basicProps.title}\n`;
        }
        
        if (basicProps.description) {
          context += `Description: ${basicProps.description}\n`;
        }
        
        if (basicProps.redemption_location) {
          context += `Where to redeem: ${basicProps.redemption_location}\n`;
        }
        
        if (basicProps.terms_conditions) {
          context += `Terms and conditions: ${basicProps.terms_conditions}\n`;
        }
        
        if (basicProps.valid_until) {
          context += `Valid until: ${basicProps.valid_until}\n`;
        }
        
        context += `\nINSTRUCTIONS FOR HELPING WITH THIS REWARD:
- The user has earned this reward by completing the journey.
- You can help explain how to redeem the reward or answer questions about it.
- Be congratulatory and helpful!\n`;
        break;
        
      case 'nested_journey':
        const nestedJourneyInfo = this.availableNestedJourneys?.find(j => j.id === basicProps.nested_journey_id);
        context += `\nThis is a Sub-Journey step that leads to another embedded journey.\n`;
        
        if (nestedJourneyInfo) {
          context += `\nSUB-JOURNEY: ${nestedJourneyInfo.title}\n`;
          if (nestedJourneyInfo.description) {
            context += `Description: ${nestedJourneyInfo.description}\n`;
          }
          context += `Contains: ${nestedJourneyInfo.step_count} steps\n`;
        }
        
        context += `\nINSTRUCTIONS FOR HELPING WITH THIS SUB-JOURNEY:
- The user is about to enter a sub-journey within the main journey.
- You can explain what this sub-journey is about and what they can expect.
- After completing the sub-journey, they will return to continue the main journey.\n`;
        break;
    }
    
    // Add any entry/exit messages
    if (advProps.entryMessage) {
      context += `\nEntry message shown: ${advProps.entryMessage}\n`;
    }
    
    // Add step-specific AI instructions if available
    if (advProps.stepContext) {
      context += `\nAdditional context: ${advProps.stepContext}\n`;
    }
    
    return context;
  }
  
  bindGuideChatEvents() {
    const toggle = document.getElementById('guideChatToggle');
    const panel = document.getElementById('guideChatPanel');
    const closeBtn = document.getElementById('closeChatPanel');
    const input = document.getElementById('guideChatInput');
    const sendBtn = document.getElementById('guideChatSend');
    
    // Track chat open time for duration calculation
    let chatOpenTime = null;
    
    // Toggle chat panel
    toggle?.addEventListener('click', async () => {
      this.previewState.guideChatOpen = !this.previewState.guideChatOpen;
      if (this.previewState.guideChatOpen) {
        panel?.classList.remove('hidden');
        // Reset height to default when opening (in case it was dragged to 0)
        const defaultHeight = window.innerHeight * 0.5; // 50vh
        panel.style.height = `${defaultHeight}px`;
        panel.style.maxHeight = `${window.innerHeight * 0.85}px`;
        // Hide FAB button when panel is open
        toggle.style.display = 'none';
        // Re-initialize drag on open (in case panel was re-rendered)
        this.initGuideChatDrag(panel);
        input?.focus();
        
        // Analytics: Track chat opened and start session
        chatOpenTime = Date.now();
        if (this.playerMode && this.previewState.currentGuide) {
          const guide = this.previewState.currentGuide;
          journeyAnalytics.guideChatOpened(guide.id, guide.name, this.previewState.currentStep?.id);
          await journeyAnalytics.guideChatSessionStart(guide.id, guide.name, this.journey?.id);
        }
      } else {
        panel?.classList.add('hidden');
        // Show FAB button when panel is closed
        toggle.style.display = '';
        
        // Analytics: Track chat closed and end session
        if (this.playerMode && this.previewState.currentGuide) {
          const duration = chatOpenTime ? Date.now() - chatOpenTime : 0;
          const messageCount = journeyAnalytics.guideMessageCount || 0;
          journeyAnalytics.guideChatClosed(this.previewState.currentGuide.id, messageCount, duration);
          await journeyAnalytics.guideChatSessionEnd();
        }
        chatOpenTime = null;
      }
    });
    
    // Close panel - handle both click and touch events
    const handleClose = async (e) => {
      e.stopPropagation(); // Prevent drag from interfering
      e.preventDefault();
      this.previewState.guideChatOpen = false;
      panel?.classList.add('hidden');
      // Reset height to default for next open
      const defaultHeight = window.innerHeight * 0.5; // 50vh
      panel.style.height = `${defaultHeight}px`;
      panel.style.maxHeight = `${window.innerHeight * 0.85}px`;
      // Show FAB button when panel is closed
      toggle.style.display = '';
      
      // Analytics: Track chat closed and end session
      if (this.playerMode && this.previewState.currentGuide) {
        const duration = chatOpenTime ? Date.now() - chatOpenTime : 0;
        const messageCount = journeyAnalytics.guideMessageCount || 0;
        journeyAnalytics.guideChatClosed(this.previewState.currentGuide.id, messageCount, duration);
        await journeyAnalytics.guideChatSessionEnd();
      }
      chatOpenTime = null;
    };
    
    closeBtn?.addEventListener('click', handleClose);
    closeBtn?.addEventListener('touchend', handleClose);
    
    // Send message on Enter (uses current guide from previewState)
    input?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && input.value.trim() && this.previewState.currentGuide) {
        this.sendGuideMessage(this.previewState.currentGuide, input.value.trim());
        input.value = '';
      }
    });
    
    // Send message on button click (uses current guide from previewState)
    sendBtn?.addEventListener('click', () => {
      if (input?.value.trim() && this.previewState.currentGuide) {
        this.sendGuideMessage(this.previewState.currentGuide, input.value.trim());
        input.value = '';
      }
    });
    
    // Initialize drag functionality for mobile guide chat panel
    this.initGuideChatDrag(panel);
  }
  
  initGuideChatDrag(panel) {
    if (!panel) return;
    
    // Check if we're on mobile (touch device)
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isMobile) return;
    
    // Prevent multiple initializations
    if (panel.dataset.dragInitialized === 'true') return;
    panel.dataset.dragInitialized = 'true';
    
    // Get references to widget and toggle button
    const _widget = document.getElementById('guideChatWidget');
    const toggle = document.getElementById('guideChatToggle');
    
    // Store drag state
    let isDragging = false;
    let startY = 0;
    let startHeight = 0;
    const minVisibleHeight = 200; // Minimum visible height before closing
    let maxHeight = window.innerHeight * 0.85; // 85vh max
    const closeThreshold = 50; // Close panel if height is below this
    
    // Make the header draggable (including the ::before drag handle)
    const header = panel.querySelector('.guide-chat-header');
    if (!header) return;
    
    // Add cursor style to indicate draggability
    header.style.cursor = 'grab';
    header.style.userSelect = 'none';
    header.style.touchAction = 'none';
    
    // Set initial height if not set
    if (!panel.style.height) {
      panel.style.height = '50vh';
    }
    
    // Function to close panel and show FAB button
    const closePanel = () => {
      this.previewState.guideChatOpen = false;
      panel.classList.add('hidden');
      // Reset height to default for next open
      const defaultHeight = window.innerHeight * 0.5; // 50vh
      panel.style.height = `${defaultHeight}px`;
      panel.style.maxHeight = `${window.innerHeight * 0.85}px`;
      if (toggle) toggle.style.display = '';
    };
    
    // Function to update messages container height
    const updateMessagesHeight = (height) => {
      const messages = panel.querySelector('.guide-chat-messages');
      if (messages && height > 0) {
        const headerHeight = header.offsetHeight;
        const inputHeight = panel.querySelector('.guide-chat-input-wrapper')?.offsetHeight || 80;
        const messagesHeight = Math.max(0, height - headerHeight - inputHeight - 20);
        messages.style.maxHeight = `${messagesHeight}px`;
      }
    };
    
    // Get close button reference to exclude it from drag
    const closeBtn = panel.querySelector('#closeChatPanel');
    
    // Touch events
    const handleStart = (e) => {
      // Don't start dragging if clicking on the close button or its children
      const target = e.target;
      if (closeBtn && (target === closeBtn || closeBtn.contains(target))) {
        return; // Let the close button handle its own click
      }
      
      isDragging = true;
      const touch = e.touches ? e.touches[0] : e;
      startY = touch.clientY;
      startHeight = panel.offsetHeight;
      panel.style.transition = 'none';
      header.style.cursor = 'grabbing';
      e.preventDefault();
    };
    
    const handleMove = (e) => {
      if (!isDragging) return;
      
      const touch = e.touches ? e.touches[0] : e;
      const deltaY = startY - touch.clientY; // Negative when dragging up
      let newHeight = startHeight + deltaY;
      
      // Allow dragging all the way down (to 0) and all the way up (to maxHeight)
      newHeight = Math.max(0, Math.min(maxHeight, newHeight));
      
      // Update panel height
      panel.style.height = `${newHeight}px`;
      panel.style.maxHeight = `${newHeight}px`;
      
      // Update messages container max-height
      updateMessagesHeight(newHeight);
      
      e.preventDefault();
    };
    
    const handleEnd = (e) => {
      if (!isDragging) return;
      
      isDragging = false;
      panel.style.transition = '';
      header.style.cursor = 'grab';
      
      const currentHeight = panel.offsetHeight;
      
      // If dragged below close threshold, close the panel
      if (currentHeight <= closeThreshold) {
        closePanel();
        return;
      }
      
      // Snap to nearest position (minVisibleHeight or maxHeight) if close
      const snapThreshold = 50; // pixels
      
      if (currentHeight < minVisibleHeight + snapThreshold) {
        // Snap to minimum visible height
        panel.style.height = `${minVisibleHeight}px`;
        panel.style.maxHeight = `${minVisibleHeight}px`;
        updateMessagesHeight(minVisibleHeight);
      } else if (currentHeight > maxHeight - snapThreshold) {
        // Snap to maximum height
        panel.style.height = `${maxHeight}px`;
        panel.style.maxHeight = `${maxHeight}px`;
        updateMessagesHeight(maxHeight);
      } else {
        // Keep current height
        updateMessagesHeight(currentHeight);
      }
      
      e.preventDefault();
    };
    
    // Add event listeners
    header.addEventListener('touchstart', handleStart, { passive: false });
    header.addEventListener('touchmove', handleMove, { passive: false });
    header.addEventListener('touchend', handleEnd, { passive: false });
    
    // Also support mouse events for testing on desktop
    header.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    
    // Update max height on window resize
    const updateMaxHeight = () => {
      maxHeight = window.innerHeight * 0.85;
      const currentHeight = panel.offsetHeight;
      if (currentHeight > maxHeight) {
        panel.style.height = `${maxHeight}px`;
        panel.style.maxHeight = `${maxHeight}px`;
        updateMessagesHeight(maxHeight);
      }
    };
    window.addEventListener('resize', updateMaxHeight);
  }
  
  async sendGuideMessage(guide, message) {
    // Add user message to this guide's history
    this.addToGuideChatHistory({
      role: 'user',
      content: message
    });
    this.renderGuideChatMessages();
    
    // Analytics: Track user message
    if (this.playerMode) {
      journeyAnalytics.guideChatMessageSent(guide.id, this.previewState.currentStep?.id, message, true);
    }
    
    // Show typing indicator
    const messagesContainer = document.getElementById('guideChatMessages');
    const typingEl = document.createElement('div');
    typingEl.className = 'guide-chat-message guide typing';
    typingEl.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
    messagesContainer?.appendChild(typingEl);
    messagesContainer?.scrollTo(0, messagesContainer.scrollHeight);
    
    // Disable input while processing
    const input = document.getElementById('guideChatInput');
    const sendBtn = document.getElementById('guideChatSend');
    if (input) input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    
    try {
      // Get current step context with full content details
      const step = this.previewState.currentStep;
      const stepContext = this.buildDetailedStepContext(step);
      
      // Build conversation history for context (from this guide's history)
      // Send as structured JSON array for reliable parsing on backend
      const guideHistory = this.getGuideChatHistory();
      const conversationMessages = guideHistory
        .slice(-10) // Last 10 messages for better context
        .map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content
        }));
      
      // Debug: log conversation history being sent
      console.log('[Guide Chat] Sending conversation with', conversationMessages.length, 'history messages for guide:', guide.id);
      console.log('[Guide Chat] History:', conversationMessages);
      
      // Call AI chat API - use different endpoint for player mode
      let chatEndpoint;
      if (window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token) {
        chatEndpoint = `/p/${window.GRYFFI.publicPlayer.token}/guide/chat`;
      } else if (this.playerMode && this.player?.token) {
        chatEndpoint = `/e/${this.player.token}/chat/guide`;
      } else {
        chatEndpoint = '/api/chat/guide';
      }
      
      const response = await fetch(chatEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guide_id: guide.id,
          journey_id: this.journey.id,
          step_context: stepContext,
          message: message,
          conversation_history: conversationMessages, // Send as JSON array instead of string
          guide_language: window.GRYFFI?.guideLanguage || window.GRYFFI?.journeyLanguage || 'en'
        })
      });
      
      const result = await response.json();
      
      // Remove typing indicator
      typingEl.remove();
      
      // Add guide response with citations
      if (result.success && result.response) {
        // Debug: log what we received
        console.log('[Guide Chat] Response received:', {
          response: result.response?.substring(0, 100),
          citationsCount: result.citations?.length || 0,
          citationSourcesCount: result.citationSources?.length || 0,
          citations: result.citations,
          citationSources: result.citationSources,
          fullResponse: result
        });
        
        // If we have citations but no sources, log a warning
        if (result.citations && result.citations.length > 0 && (!result.citationSources || result.citationSources.length === 0)) {
          console.warn('[Guide Chat] WARNING: Found citations but no citation sources!', {
            citations: result.citations,
            citationIds: result.citations.map(c => c.id)
          });
        }
        
        this.addToGuideChatHistory({
          role: 'guide',
          content: result.response,
          citations: result.citations || [],
          citationSources: result.citationSources || []
        });
        
        // Analytics: Track guide response with citations
        if (this.playerMode) {
          journeyAnalytics.guideChatResponseReceived(
            guide.id, 
            this.previewState.currentStep?.id, 
            result.response,
            result.citations && result.citations.length > 0,
            result.citations?.length || 0
          );
        }
      } else {
        let content = result.response || guide.greeting || window.tPlayer('player.chat.chatError');
        if (result.code === 'AI_UNAVAILABLE') {
          content = window.tPlayer('player.chat.guideUnavailable');
        }
        this.addToGuideChatHistory({
          role: 'guide',
          content,
          citations: [],
          citationSources: []
        });
      }
      
      this.renderGuideChatMessages();
      
    } catch (err) {
      console.error('Guide chat error:', err);
      typingEl.remove();
      this.addToGuideChatHistory({
        role: 'guide',
        content: window.tPlayer('player.chat.connectionError')
      });
      this.renderGuideChatMessages();
    } finally {
      // Re-enable input
      if (input) input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      input?.focus();
    }
  }
  
  renderGuideChatMessages() {
    const container = document.getElementById('guideChatMessages');
    if (!container) return;
    
    const history = this.getGuideChatHistory();
    container.innerHTML = history.map((msg, _idx) => {
      if (msg.role === 'user') {
        return `<div class="guide-chat-message user">${this.escapeHtml(msg.content)}</div>`;
      } else {
        // Parse citations and render with badges
        const parsedContent = this.parseCitations(msg.content, msg.citations || [], msg.citationSources || []);
        return `<div class="guide-chat-message guide">${parsedContent}</div>`;
      }
    }).join('');
    
    // Re-attach citation click handlers
    container.querySelectorAll('.citation-badge').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        const chunkId = badge.dataset.chunkId;
        // Extract surrounding text for highlighting the relevant passage in the source
        const msgEl = badge.closest('.guide-chat-message');
        const msgText = msgEl ? msgEl.textContent : '';
        const badgeIdx = msgText.indexOf('Bron');
        const contextStart = Math.max(0, badgeIdx - 100);
        const surroundingText = msgText.substring(contextStart, badgeIdx).trim();
        this.openSourceDrawer(chunkId, history, surroundingText);
      });
    });
    
    container.scrollTo(0, container.scrollHeight);
  }
  
  parseCitations(text, citations, citationSources) {
    if (!text || !citations || citations.length === 0) {
      // Still parse markdown even without citations
      return this.parseMarkdown(this.escapeHtml(text));
    }
    
    // Create a map of chunk IDs to source info (support both full UUIDs and partial matches)
    const sourceMap = {};
    citationSources.forEach(source => {
      const chunkId = source.chunkId || source.matchedCitationId;
      if (chunkId) {
        sourceMap[chunkId] = source;
        // Also map by prefix for partial matches
        const prefix = chunkId.toString().substring(0, 8).replace(/-/g, '');
        if (prefix.length === 8) {
          sourceMap[prefix] = source;
        }
      }
    });
    
    // STEP 1: Replace citations with placeholders BEFORE escaping/markdown
    // This preserves correct positions since we work on original text
    // Use <<< >>> format to avoid interference with markdown _ and * parsing
    const placeholders = [];
    const sortedCitations = [...citations].sort((a, b) => b.position - a.position);
    
    let result = text;
    sortedCitations.forEach((citation, idx) => {
      // Try to find source by exact match or partial match
      let source = sourceMap[citation.id];
      if (!source) {
        const prefix = citation.id.substring(0, 8).replace(/-/g, '');
        source = sourceMap[prefix];
      }
      
      const sourceName = source ? (source.sourceName || this.getTranslation('builder.preview.citation.source', 'Source')) : this.getTranslation('builder.preview.citation.source', 'Source');
      const fullChunkId = source ? (source.chunkId || citation.id) : citation.id;
      const citationText = this.getTranslation('builder.preview.citation.source', 'Bron');
      
      // Store badge HTML for later - use <<< >>> to avoid markdown interference
      const placeholder = `<<<CITE${idx}>>>`;
      placeholders.push({
        placeholder,
        // After escapeHtml, < becomes &lt; and > becomes &gt;
        escapedPlaceholder: `&lt;&lt;&lt;CITE${idx}&gt;&gt;&gt;`,
        badge: `<span class="citation-badge" data-chunk-id="${this.escapeHtml(fullChunkId)}" data-citation-id="${this.escapeHtml(citation.id)}" title="${this.escapeHtml(sourceName)}">
        <svg class="citation-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
        </svg>
        <span class="citation-text">${citationText}</span>
      </span>`
      });
      
      // Replace citation with placeholder in original text
      result = result.substring(0, citation.position) + placeholder + result.substring(citation.position + citation.fullMatch.length);
    });
    
    // STEP 2: Escape HTML and parse markdown
    result = this.parseMarkdown(this.escapeHtml(result));
    
    // STEP 3: Replace escaped placeholders with actual badges
    placeholders.forEach(({ escapedPlaceholder, badge }) => {
      result = result.replace(escapedPlaceholder, badge);
    });
    
    return result;
  }
  

  formatDate(dateStr) {
    const langToLocale = { en: 'en-US', nl: 'nl-NL', de: 'de-DE', fr: 'fr-FR', es: 'es-ES' };
    const lang = window.GRYFFI?.locale || document.documentElement.lang || 'en';
    const locale = langToLocale[lang] || 'en-US';
    return new Date(dateStr).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  highlightExcerpt(excerptText, citationContext) {
    if (!excerptText) return this.escapeHtml(excerptText);
    const escaped = this.escapeHtml(excerptText);
    if (!citationContext || citationContext.length < 8) return escaped;

    // Extract significant keywords (4+ chars) from the AI's answer context
    const keywords = (citationContext.match(/[a-zA-Z\u00C0-\u024F]{4,}/g) || [])
      .map(w => w.toLowerCase())
      .filter(w => !['this','that','with','from','have','your','been','also','they','their','about','which','would','there','other','than','into','more','some','what','when','will','each','make','like','does','these','here','just','only','over','such','after','very','most','much','then','them','were','said','many','well','back','been','made','could','come','every','know','take'].includes(w));

    if (keywords.length === 0) return escaped;

    // Highlight the matching keywords in the escaped text
    let highlighted = escaped;
    const uniqueKws = [...new Set(keywords)].slice(0, 10);
    for (const kw of uniqueKws) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- keyword is escaped with a regex-metachar replace on this line
      const re = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      highlighted = highlighted.replace(re, '<mark>$1</mark>');
    }

    return highlighted;
  }
  
  /**
   * Parse basic markdown formatting to HTML
   * Supports: **bold**, *italic*, `code`, and line breaks
   * Must be called AFTER escapeHtml to preserve security
   */
  parseMarkdown(text) {
    if (!text) return text;
    
    // Bold: **text** or __text__
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    
    // Italic: *text* or _text_ (but not inside words)
    text = text.replace(/(?<![a-zA-Z])\*([^*]+)\*(?![a-zA-Z])/g, '<em>$1</em>');
    text = text.replace(/(?<![a-zA-Z])_([^_]+)_(?![a-zA-Z])/g, '<em>$1</em>');
    
    // Inline code: `code`
    text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    
    // Line breaks: double newline or \n\n
    text = text.replace(/\n\n/g, '</p><p>');
    text = text.replace(/\n/g, '<br>');
    
    return text;
  }
  
  showPollResultsPreview(container, votes, totalRespondents, options, userVotes = []) {
    // Calculate percentages and update bars
    container.querySelectorAll('.journey-poll-option').forEach((option, i) => {
      const voteCount = votes[i] || 0;
      const percentage = totalRespondents > 0 ? Math.round((voteCount / totalRespondents) * 100) : 0;
      
      const bar = option.querySelector('.journey-poll-option-bar');
      const count = option.querySelector('.journey-poll-option-count');
      
      if (bar) {
        bar.style.width = `${percentage}%`;
      }
      if (count) {
        count.textContent = `${voteCount} (${percentage}%)`;
        count.classList.remove('hidden');
      }
      
      // Mark user's vote
      if (userVotes.includes(i)) {
        option.classList.add('user-vote');
      }
      
      option.classList.add('showing-results');
    });
    
    // Show total
    const resultsDiv = document.getElementById('pollResults');
    if (resultsDiv) {
      const totalDiv = resultsDiv.querySelector('.journey-poll-total');
      if (totalDiv) {
        totalDiv.textContent = window.tPlayer('player.poll.respondentsPlural', { count: totalRespondents });
      }
      resultsDiv.classList.remove('hidden');
    }
  }
  
  // Load real poll results from database and add user's preview vote
  async loadPollResults(stepId, container, options, userSelectedIndices = []) {
    try {
      const response = await fetch(`/api/polls/${stepId}/results`);
      const data = await response.json();
      
      // Convert option votes to index-based format
      const votes = {};
      let totalVotes = 0;
      
      if (data.success && data.results) {
        totalVotes = data.results.totalVotes || 0;
        const optionVotes = data.results.optionVotes || {};
        
        options.forEach((opt, i) => {
          const optionId = opt.id;
          votes[i] = optionVotes[optionId] || 0;
        });
      } else {
        // No results yet - start with zeros
        options.forEach((_, i) => {
          votes[i] = 0;
        });
      }
      
      // Add the user's preview vote to the results (preview vote is not stored in DB)
      if (userSelectedIndices.length > 0) {
        userSelectedIndices.forEach(idx => {
          votes[idx] = (votes[idx] || 0) + 1;
        });
        totalVotes += 1; // Count the preview user as one respondent
      }
      
      this.showPollResultsPreview(container, votes, totalVotes, options, userSelectedIndices);
    } catch (err) {
      console.error('Failed to load poll results:', err);
      // Show user's vote only on error
      const votes = {};
      options.forEach((_, i) => {
        votes[i] = 0;
      });
      
      // Still show the user's vote
      if (userSelectedIndices.length > 0) {
        userSelectedIndices.forEach(idx => {
          votes[idx] = 1;
        });
        this.showPollResultsPreview(container, votes, 1, options, userSelectedIndices);
      } else {
        this.showPollResultsPreview(container, votes, 0, options, userSelectedIndices);
      }
    }
  }
  
  // Show mock poll results for preview mode (no database call)
  showMockPollResults(container, options, userSelectedIndices = []) {
    const votes = {};
    options.forEach((_, i) => {
      votes[i] = 0;
    });
    
    // Only show the user's vote
    if (userSelectedIndices.length > 0) {
      userSelectedIndices.forEach(idx => {
        votes[idx] = 1;
      });
      this.showPollResultsPreview(container, votes, 1, options, userSelectedIndices);
    } else {
      this.showPollResultsPreview(container, votes, 0, options, userSelectedIndices);
    }
  }
  
  // Display poll results from public journey endpoint (option name -> count format)
  displayPollResults(container, options, results, totalVotes, userVotedIndex) {
    const votes = {};
    
    // Convert option name -> count to index -> count format
    options.forEach((opt, i) => {
      // Results can be keyed by option text
      const optionText = typeof opt === 'string' ? opt : opt.text || opt.label || opt;
      votes[i] = results[optionText] || 0;
    });
    
    // Show the results using the existing preview renderer
    this.showPollResultsPreview(container, votes, totalVotes, options, [userVotedIndex]);
  }
  
  // Claim a reward (player mode only - claims from database)
  async claimReward(stepId, _container, _basicProps) {
    try {
      // Check if public mode and needs identification
      if (window.GRYFFI?.publicMode) {
        // Check if this is preview mode (no real token)
        const isPublicPreview = window.GRYFFI?.previewMode && !window.GRYFFI?.publicPlayer?.token;
        
        // For real public journeys, check availability BEFORE identification
        if (!isPublicPreview && window.GRYFFI?.publicPlayer?.token) {
          try {
            const availRes = await fetch(`/p/${window.GRYFFI.publicPlayer.token}/rewards/availability/${stepId}`);
            const availData = await availRes.json();
            
            if (availData.success && availData.soldOut) {
              // Show sold out screen immediately without requiring identification
              console.log('[Reward] Codes sold out, showing sold out screen');
              this.showRewardSoldOutScreen();
              return;
            }
          } catch (err) {
            console.warn('[Reward] Could not check availability:', err);
            // Continue with normal flow if check fails
          }
        }
        
        // Now check if identification is needed
        if (!window.GRYFFI?.publicPlayer?.isVerified) {
          try {
            await window.GRYFFI.publicIdentify('reward', 'reward', stepId);
          } catch (err) {
            console.log('Public identify cancelled or failed:', err);
            return;
          }
        }
        
        if (isPublicPreview) {
          // Simulate successful reward claim in preview mode
          const codeElement = document.getElementById('rewardCode');
          const positionElement = document.getElementById('rewardPosition');
          const emailSentElement = document.getElementById('rewardEmailSent');
          
          if (codeElement) {
            codeElement.textContent = 'PREVIEW-CODE-1234';
          }
          if (positionElement) {
            positionElement.textContent = window.t('builder.reward.preview.youAreNumber', { position: 1 });
          }
          if (emailSentElement) {
            emailSentElement.textContent = window.t('builder.reward.preview.emailSent');
          }
          this.showToast(window.t('builder.reward.preview.claimed') || 'Reward claimed', 'success');
          return;
        }
        
        // Claim reward for public journey
        const token = window.GRYFFI.publicPlayer?.token;
        const res = await fetch(`/p/${token}/rewards/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step_id: stepId })
        });
        
        const data = await res.json();
        
        if (data.success) {
          const codeElement = document.getElementById('rewardCode');
          const positionElement = document.getElementById('rewardPosition');
          const emailSentElement = document.getElementById('rewardEmailSent');
          
          if (codeElement) {
            codeElement.textContent = data.code;
          }
          if (positionElement) {
            positionElement.textContent = window.t('builder.reward.preview.youAreNumber', { position: 1 });
          }
          if (emailSentElement) {
            emailSentElement.textContent = window.t('builder.reward.preview.emailSent');
          }
        } else if (data.code === 'NO_MORE_REWARDS' || data.error === 'No codes available') {
          // Show the "sold out" screen
          this.showRewardSoldOutScreen();
        } else {
          this.showToast(data.error || 'Failed to claim reward', 'error');
        }
        return;
      }
      
      if (!this.playerMode || !this.player?.token) {
        return;
      }
      
      const res = await fetch(`/e/${this.player.token}/rewards/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_id: stepId })
      });
      
      const data = await res.json();
      
      if (data.success) {
        // Update UI with the claimed reward code
        const codeElement = document.getElementById('rewardCode');
        const positionElement = document.getElementById('rewardPosition');
        const emailSentElement = document.getElementById('rewardEmailSent');
        
        if (codeElement) {
          codeElement.textContent = data.code;
        }
        
        if (positionElement) {
          if (data.alreadyClaimed) {
            positionElement.textContent = window.t('builder.reward.preview.alreadyClaimed');
          } else {
            positionElement.textContent = window.t('builder.reward.preview.youAreNumber', { position: data.position });
          }
        }
        
        if (emailSentElement && !data.alreadyClaimed) {
          emailSentElement.textContent = window.t('builder.reward.preview.emailSent');
        }
        
        console.log('[Reward] Successfully claimed:', data.code, 'Position:', data.position);
      } else if (data.error === 'no_more_rewards') {
        // Show the "sold out" screen
        this.showRewardSoldOutScreen();
      } else {
        console.error('[Reward] Claim failed:', data.error);
      }
    } catch (err) {
      console.error('[Reward] Claim error:', err);
    }
  }
  
  // Show the "sold out" screen when all rewards have been claimed
  showRewardSoldOutScreen() {
    const rewardContainer = document.querySelector('.journey-reward');
    if (!rewardContainer) return;
    
    // Replace the entire reward content with the sold out message
    rewardContainer.innerHTML = `
      <!-- Reward Header (keeping the badge) -->
      <div class="journey-step-badge">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"></path>
        </svg>
        <span>${window.t('builder.stepTypes.reward')}</span>
      </div>
      
      <!-- Sold Out Message -->
      <div style="text-align: center; padding: 32px 24px;">
        <!-- Sad face icon -->
        <div style="margin-bottom: 24px;">
          <svg style="width: 80px; height: 80px; margin: 0 auto; display: block; color: var(--theme-primary, #0b4b34); opacity: 0.6;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
        </div>
        
        <!-- Title -->
        <h2 style="font-size: 1.5rem; font-weight: 700; margin-bottom: 12px; color: var(--theme-primary, #0b4b34); text-align: center;">
          ${window.t('builder.reward.soldOut.title')}
        </h2>
        
        <!-- Message -->
        <p style="color: #64748b; max-width: 320px; margin: 0 auto; line-height: 1.6; text-align: center;">
          ${window.t('builder.reward.soldOut.message')}
        </p>
      </div>
    `;
    
    console.log('[Reward] Displayed sold out screen');
  }
  
  // Helper to convert hex color to RGB array
  hexToRgb(hex) {
    // Remove # if present
    hex = hex.replace(/^#/, '');
    // Parse hex to RGB
    const bigint = parseInt(hex, 16);
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
  }
  
  // Get current theme colors for PDF generation
  getThemeColorsForPdf() {
    const computedStyle = getComputedStyle(document.documentElement);
    
    // Get theme colors from CSS variables, with fallbacks to Gryffi default
    const primaryHex = computedStyle.getPropertyValue('--theme-primary').trim() || '#0b4b34';
    const backgroundHex = computedStyle.getPropertyValue('--theme-background').trim() || '#ecf2eb';
    
    return {
      primary: this.hexToRgb(primaryHex),
      background: this.hexToRgb(backgroundHex),
      textGray: [100, 116, 139] // Keep neutral gray for secondary text
    };
  }
  
  /**
   * Get image dimensions from base64 data
   * Returns a promise with { width, height, aspectRatio }
   */
  getImageDimensions(base64Data) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
          aspectRatio: img.naturalWidth / img.naturalHeight
        });
      };
      img.onerror = () => {
        // Fallback to default Gryffi logo aspect ratio
        resolve({ width: 693, height: 292, aspectRatio: 2.37 });
      };
      img.src = base64Data;
    });
  }

  // Download reward as PDF
  async downloadRewardPDF(code, basicProps) {
    // Check if jsPDF is available
    if (typeof window.jspdf === 'undefined') {
      console.error('[Reward PDF] jsPDF not loaded');
      this.showToast('PDF library not loaded', 'error');
      return;
    }
    
    // Load logo - use custom theme logo (light version for dark header) or default Gryffi logo
    let logoBase64 = null;
    let logoDimensions = { width: 693, height: 292, aspectRatio: 2.37 }; // Default Gryffi logo ratio
    
    try {
      // Use theme light logo if available, otherwise use default Gryffi white logo
      const logoUrl = this.themeLogoLight || this.themeLogo || '/images/logos/Logo---transparant-white-cropped.png';
      const response = await fetch(logoUrl);
      const blob = await response.blob();
      logoBase64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      
      // Get actual dimensions of the logo to maintain aspect ratio
      logoDimensions = await this.getImageDimensions(logoBase64);
      console.log('[Reward PDF] Logo dimensions:', logoDimensions);
    } catch (e) {
      console.warn('[Reward PDF] Could not load logo:', e);
    }
    
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 15;
    
    // Use NotoSans for Unicode support (Turkish, Arabic, Chinese, etc.)
    // Falls back to Helvetica if NotoSans not loaded
    const fontFamily = pdf.getFontList()['NotoSans'] ? 'NotoSans' : 'helvetica';
    console.log('[Reward PDF] Using font:', fontFamily);
    
    // Get theme colors (uses CSS variables if custom theme is active)
    const themeColors = this.getThemeColorsForPdf();
    const primaryColor = themeColors.primary;
    const bgLight = themeColors.background;
    const textGray = themeColors.textGray;
    
    // Header background
    pdf.setFillColor(...primaryColor);
    pdf.rect(0, 0, pageWidth, 40, 'F');
    
    // Header text (left aligned to make room for logo)
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(24);
    pdf.setFont(fontFamily, 'bold');
    pdf.text(window.t('builder.reward.preview.congratulations'), margin, 25);
    
    // Logo (right side) - calculate dimensions maintaining aspect ratio
    // Max height is 16mm, max width is 60mm (to leave room for header text)
    const maxLogoHeight = 16;
    const maxLogoWidth = 60;
    
    let logoWidth, logoHeight;
    if (logoDimensions.aspectRatio > (maxLogoWidth / maxLogoHeight)) {
      // Width-constrained: logo is wider than max ratio
      logoWidth = maxLogoWidth;
      logoHeight = logoWidth / logoDimensions.aspectRatio;
    } else {
      // Height-constrained: logo is taller than max ratio
      logoHeight = maxLogoHeight;
      logoWidth = logoHeight * logoDimensions.aspectRatio;
    }
    
    const logoX = pageWidth - margin - logoWidth;
    const logoY = (40 - logoHeight) / 2; // Center vertically in header
    
    if (logoBase64) {
      try {
        pdf.addImage(logoBase64, 'PNG', logoX, logoY, logoWidth, logoHeight);
      } catch (_e) {
        // Fallback to text if logo fails
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(14);
        pdf.setFont(fontFamily, 'bold');
        pdf.text('Gryffi', pageWidth - margin - 25, 25);
      }
    }
    
    // Reward card background
    const cardMargin = 20;
    const cardWidth = pageWidth - (cardMargin * 2);
    const cardTop = 55;
    const cardHeight = 140;
    
    pdf.setFillColor(255, 255, 255);
    pdf.setDrawColor(...primaryColor);
    pdf.setLineWidth(0.5);
    pdf.roundedRect(cardMargin, cardTop, cardWidth, cardHeight, 8, 8, 'FD');
    
    // Reward title
    let yPos = cardTop + 20;
    pdf.setTextColor(...primaryColor);
    pdf.setFontSize(20);
    pdf.setFont(fontFamily, 'bold');
    const title = basicProps.title || 'Reward';
    pdf.text(title, pageWidth / 2, yPos, { align: 'center' });
    
    // Description
    if (basicProps.description) {
      yPos += 12;
      pdf.setFontSize(12);
      pdf.setFont(fontFamily, 'normal');
      const descLines = pdf.splitTextToSize(basicProps.description, cardWidth - 20);
      pdf.text(descLines, pageWidth / 2, yPos, { align: 'center' });
      yPos += descLines.length * 6;
    }
    
    // Code box
    yPos += 10;
    const codeBoxWidth = 100;
    const codeBoxHeight = 35;
    const codeBoxX = (pageWidth - codeBoxWidth) / 2;
    
    pdf.setFillColor(...bgLight);
    pdf.roundedRect(codeBoxX, yPos, codeBoxWidth, codeBoxHeight, 4, 4, 'F');
    
    // Code label
    pdf.setTextColor(...primaryColor);
    pdf.setFontSize(10);
    pdf.setFont(fontFamily, 'normal');
    pdf.text(window.t('builder.reward.preview.yourCode'), pageWidth / 2, yPos + 12, { align: 'center' });
    
    // Code value - centered vertically in the box
    pdf.setTextColor(...primaryColor);
    pdf.setFontSize(20);
    pdf.setFont('courier', 'bold');
    pdf.text(code, pageWidth / 2, yPos + 24, { align: 'center' });
    
    yPos += codeBoxHeight + 15;
    
    // Redemption location
    if (basicProps.redemption_location) {
      pdf.setFont(fontFamily, 'bold');
      pdf.setFontSize(11);
      pdf.setTextColor(...primaryColor);
      pdf.text(window.t('builder.reward.preview.redeemAt') + ':', cardMargin + 10, yPos);
      pdf.setFont(fontFamily, 'normal');
      pdf.setTextColor(...textGray);
      pdf.text(basicProps.redemption_location, cardMargin + 10, yPos + 6);
      yPos += 16;
    }
    
    // Valid until
    if (basicProps.valid_until) {
      pdf.setFont(fontFamily, 'bold');
      pdf.setFontSize(11);
      pdf.setTextColor(...primaryColor);
      pdf.text(window.t('builder.reward.preview.validUntil') + ':', cardMargin + 10, yPos);
      pdf.setFont(fontFamily, 'normal');
      pdf.setTextColor(...textGray);
      pdf.text(this.formatDate(basicProps.valid_until), cardMargin + 60, yPos);
      yPos += 12;
    }
    
    // Terms & Conditions
    if (basicProps.terms_conditions) {
      yPos = cardTop + cardHeight + 20;
      pdf.setFillColor(245, 245, 245);
      pdf.roundedRect(cardMargin, yPos, cardWidth, 40, 4, 4, 'F');
      
      pdf.setFont(fontFamily, 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(100, 100, 100);
      pdf.text(window.t('builder.reward.preview.terms'), cardMargin + 10, yPos + 12);
      
      pdf.setFont(fontFamily, 'normal');
      pdf.setFontSize(9);
      const termsLines = pdf.splitTextToSize(basicProps.terms_conditions, cardWidth - 20);
      pdf.text(termsLines.slice(0, 3), cardMargin + 10, yPos + 22);
    }
    
    // Footer
    pdf.setFontSize(10);
    pdf.setTextColor(150, 150, 150);
    pdf.text('gryffi.com', pageWidth / 2, pageHeight - 15, { align: 'center' });
    
    // Save - sanitize filename to remove non-ASCII characters that cause issues
    const sanitizeFilename = (str) => {
      if (!str) return '';
      return str
        .normalize('NFD') // Decompose accented characters
        .replace(/[\u0300-\u036f]/g, '') // Remove diacritical marks
        .replace(/[^\x00-\x7F]/g, '') // Remove remaining non-ASCII
        .replace(/[^a-zA-Z0-9-_]/g, '-') // Replace special chars with dash
        .replace(/-+/g, '-') // Collapse multiple dashes
        .replace(/^-|-$/g, '') // Trim leading/trailing dashes
        .substring(0, 50); // Limit length
    };
    const safeTitle = sanitizeFilename(basicProps.title || 'reward');
    const safeCode = sanitizeFilename(code) || 'preview';
    const fileName = `reward-${safeTitle}-${safeCode}.pdf`;
    pdf.save(fileName);
  }
  
  // Check if player has already voted (player mode only - checks database)
  async checkPlayerPollVote(stepId, pollContainer, pollSubmitBtn, basicProps, _showResults, _isRequired) {
    try {
      const invitationId = this.player?.invitationId;
      if (!invitationId) return;
      
      const res = await fetch(`/api/polls/${stepId}/check-vote?invitationId=${invitationId}`);
      const data = await res.json();
      
      if (data.success && data.hasVoted) {
        // User has already voted - update UI
        
        // Mark as voted in preview state
        this.previewState.pollVotes[stepId] = { selectedOptions: data.userVotes };
        
        // Hide the options container (they can't vote again)
        const optionsContainer = pollContainer.querySelector('.journey-poll-options');
        if (optionsContainer && !data.showResults) {
          optionsContainer.classList.add('hidden');
        }
        
        // Hide submit button
        pollSubmitBtn.style.display = 'none';
        
        // Show "already voted" status
        const pollStatus = document.getElementById('pollStatus');
        if (pollStatus) {
          pollStatus.textContent = window.tPlayer('player.poll.alreadyVoted');
          pollStatus.classList.remove('hidden');
        }
        
        // Disable option selection
        pollContainer.querySelectorAll('.journey-poll-option').forEach(opt => {
          opt.style.pointerEvents = 'none';
        });
        
        // Show results if enabled in settings
        if (data.showResults && data.votes) {
          // Make sure options are visible for results display
          if (optionsContainer) {
            optionsContainer.classList.remove('hidden');
          }
          this.showPollResultsPreview(pollContainer, data.votes, data.totalRespondents, basicProps.options || [], data.userVotes);
        }
        
        // Unlock navigation since they've already voted
        this.trackEndStepCompletion(this.previewState.currentStep);
        this.unlockPacing();
      }
    } catch (err) {
      console.error('Check player poll vote error:', err);
    }
  }
  
  getTranslation(key, fallback) {
    // Try window.t function first
    if (typeof window.t === 'function') {
      const translated = window.t(key);
      // If translation returns something different from the key, use it
      if (translated && translated !== key && typeof translated === 'string') {
        return translated;
      }
    }
    
    // Fallback: try to get from window.GRYFFI.translations directly
    if (window.GRYFFI && window.GRYFFI.translations) {
      const keys = key.split('.');
      let value = window.GRYFFI.translations;
      for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
          value = value[k];
        } else {
          break;
        }
      }
      if (typeof value === 'string') {
        return value;
      }
    }
    
    // Return fallback
    return fallback;
  }
  
  getSourceTypeTranslation(sourceType) {
    if (!sourceType) return 'Unknown';
    
    // Map source types to translation keys
    const typeMap = {
      'file': 'builder.preview.sourceDrawer.typeFile',
      'text': 'builder.preview.sourceDrawer.typeText',
      'url': 'builder.preview.sourceDrawer.typeUrl'
    };
    
    const translationKey = typeMap[sourceType.toLowerCase()];
    if (translationKey) {
      const translated = this.getTranslation(translationKey, sourceType);
      if (translated !== translationKey) {
        return this.escapeHtml(translated);
      }
    }
    
    // Fallback: return the source type as-is
    return this.escapeHtml(sourceType);
  }
  
  async openSourceDrawer(chunkId, chatHistory, citationContext = '') {
    // Find the source info from chat history
    let sourceInfo = null;
    
    // Debug: log what we're looking for
    console.log('[Source Drawer] Looking for chunk:', chunkId);
    console.log('[Source Drawer] Chat history:', chatHistory);
    
    for (const msg of chatHistory) {
      if (msg.citationSources && Array.isArray(msg.citationSources)) {
        console.log('[Source Drawer] Checking message with', msg.citationSources.length, 'sources');
        
        // Try exact match first
        sourceInfo = msg.citationSources.find(s => {
          const sChunkId = s.chunkId || s.matchedCitationId;
          return sChunkId === chunkId || sChunkId?.toString() === chunkId.toString();
        });
        if (sourceInfo) {
          console.log('[Source Drawer] Found exact match:', sourceInfo);
          break;
        }
        
        // Try partial match (first 8 chars)
        const prefix = chunkId.toString().substring(0, 8).replace(/-/g, '');
        if (prefix.length === 8) {
          sourceInfo = msg.citationSources.find(s => {
            const sourceChunkId = (s.chunkId || s.matchedCitationId || '').toString();
            const sourcePrefix = sourceChunkId.substring(0, 8).replace(/-/g, '');
            return sourcePrefix === prefix;
          });
          if (sourceInfo) {
            console.log('[Source Drawer] Found partial match:', sourceInfo);
            break;
          }
        }
      }
    }
    
    if (!sourceInfo) {
      console.warn('[Source Drawer] Source info not found for chunk:', chunkId);
      console.warn('[Source Drawer] Available sources:', chatHistory.flatMap(msg => msg.citationSources || []).map(s => s.chunkId));
      // Show a user-friendly message instead of silently failing
      const errorMsg = this.getTranslation('builder.preview.sourceDrawer.sourceNotFound', 'Bron niet gevonden. Probeer het opnieuw.');
      await window.gryffi.modal.alert(errorMsg, { type: 'error' });
      return;
    }
    
    // Create or update drawer
    let drawer = document.getElementById('sourceDrawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'sourceDrawer';
      drawer.className = 'source-drawer';
      document.body.appendChild(drawer);
    }
    
    // Get translations using the helper method
    const pageLabel = this.getTranslation('builder.preview.sourceDrawer.page', 'Pagina');
    const typeLabel = this.getTranslation('builder.preview.sourceDrawer.type', 'Type');
    const fileLabel = this.getTranslation('builder.preview.sourceDrawer.file', 'Bestand');
    const excerptLabel = this.getTranslation('builder.preview.sourceDrawer.excerpt', 'Fragment');
    const closeLabel = this.getTranslation('builder.preview.sourceDrawer.close', 'Sluiten');
    const noExcerptText = this.getTranslation('builder.preview.sourceDrawer.noExcerpt', 'Geen fragment beschikbaar');
    
    // Render drawer content
    drawer.innerHTML = `
      <div class="source-drawer-overlay"></div>
      <div class="source-drawer-content">
        <div class="source-drawer-header">
          <h3 class="source-drawer-title">${this.escapeHtml(sourceInfo.sourceName)}</h3>
          <button class="source-drawer-close" aria-label="${closeLabel}">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <div class="source-drawer-body">
          ${sourceInfo.pageNumber ? `<div class="source-drawer-meta"><span class="source-drawer-label">${pageLabel}:</span> ${sourceInfo.pageNumber}</div>` : ''}
          <div class="source-drawer-meta"><span class="source-drawer-label">${typeLabel}:</span> ${this.getSourceTypeTranslation(sourceInfo.sourceType)}</div>
          ${sourceInfo.originalFilename ? `<div class="source-drawer-meta"><span class="source-drawer-label">${fileLabel}:</span> ${this.escapeHtml(sourceInfo.originalFilename)}</div>` : ''}
          <div class="source-drawer-text">
            <div class="source-drawer-label">${excerptLabel}:</div>
            <div class="source-drawer-excerpt">${this.highlightExcerpt(sourceInfo.originalText || noExcerptText, citationContext)}</div>
          </div>
        </div>
      </div>
    `;
    
    // Show drawer
    drawer.classList.add('active');
    
    // Close handlers
    const closeBtn = drawer.querySelector('.source-drawer-close');
    const overlay = drawer.querySelector('.source-drawer-overlay');
    
    const closeDrawer = () => {
      drawer.classList.remove('active');
    };
    
    closeBtn?.addEventListener('click', closeDrawer);
    overlay?.addEventListener('click', closeDrawer);
    
    // ESC key to close
    const escHandler = (e) => {
      if (e.key === 'Escape' && drawer.classList.contains('active')) {
        closeDrawer();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }
  
  closePreview() {
    this.stopTts();
    document.getElementById('previewModal').classList.add('hidden');
    document.getElementById('previewStartedFromBanner')?.classList.add('hidden');
  }
  
  /* ============================================
     TEXT-TO-SPEECH
     Reads the visible text of the current step aloud in the journey
     language. Natural voices come from Mistral Voxtral TTS (generated
     server-side and cached); the browser's Web Speech API covers the
     languages Voxtral doesn't support and acts as fallback whenever the
     server audio can't be fetched or played. Available in every mode
     that renders steps (player, public player, fullscreen preview,
     builder preview) so the experience is identical everywhere.
     ============================================ */
  
  webSpeechSupported() {
    return typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && typeof SpeechSynthesisUtterance !== 'undefined';
  }
  
  /**
   * Whether server-generated (Voxtral) audio is available for the
   * journey language.
   */
  serverTtsSupported() {
    // Only languages with a native Voxtral preset voice; other languages
    // would get an English pronunciation, which sounds wrong.
    // Keep in sync with VOXTRAL_TTS_LANGUAGES in app/src/services/tts.js
    const SERVER_TTS_LANGUAGES = ['en', 'fr'];
    return typeof fetch === 'function'
      && typeof Audio !== 'undefined'
      && SERVER_TTS_LANGUAGES.includes(this.getJourneyLanguage());
  }
  
  ttsSupported() {
    return this.webSpeechSupported() || this.serverTtsSupported();
  }
  
  initTts() {
    if (this._ttsInitialized || !this.ttsSupported()) return;
    this._ttsInitialized = true;
    this._ttsActive = false;
    this._ttsButton = null;
    this._ttsUtterance = null;
    this._ttsAudioEl = null;
    // Monotonic id: every start/stop invalidates in-flight async work
    this._ttsSession = 0;
    
    // Warm up the voice list - some browsers populate it asynchronously
    if (this.webSpeechSupported()) window.speechSynthesis.getVoices();
    
    // Stop speaking when the user leaves the page (magic link players
    // navigating away, closing the tab, etc.)
    window.addEventListener('pagehide', () => this.stopTts());
  }
  
  /**
   * The language steps are written in: the journey language override
   * if set, otherwise the organization default (resolved server-side
   * into window.GRYFFI.journeyLanguage).
   */
  getJourneyLanguage() {
    return (window.GRYFFI?.journeyLanguage
      || window.GRYFFI?.player?.language
      || window.GRYFFI?.locale
      || 'en').toLowerCase();
  }
  
  getTtsLang() {
    const raw = this.getJourneyLanguage();
    // Norwegian voices are published as 'nb' (Bokmål) by most engines
    return raw === 'no' ? 'nb' : raw;
  }
  
  /**
   * Pick the best available voice for the journey language.
   * Prefers local (offline) voices - they respond faster and avoid
   * the Chromium bug where remote voices stall on long utterances.
   */
  pickTtsVoice() {
    const lang = this.getTtsLang();
    const prefixes = lang === 'nb' ? ['nb', 'no'] : [lang];
    const voices = window.speechSynthesis.getVoices() || [];
    const matches = voices.filter(v => {
      const l = (v.lang || '').toLowerCase().replace('_', '-');
      return prefixes.some(p => l === p || l.startsWith(p + '-'));
    });
    if (matches.length === 0) return null;
    return matches.find(v => v.localService && v.default)
      || matches.find(v => v.localService)
      || matches.find(v => v.default)
      || matches[0];
  }
  
  /**
   * Collect the readable text of a step card in document order.
   * Interactive chrome (inputs, submit/nav buttons, chat input, pacing
   * countdowns) is skipped; answer options and path choices are read
   * because hearing the choices is exactly what helps dyslexic users.
   * @param {Element} root - The step card element
   * @param {boolean} checkVisibility - When true only currently visible
   *   text is read (click time). When false, used as a cheap probe to
   *   decide whether the step has any readable text at all (render time,
   *   when the card may still be hidden inside the preview modal).
   */
  collectTtsText(root, checkVisibility = true) {
    return this.collectTtsContent(root, checkVisibility).text;
  }
  
  /**
   * Like collectTtsText, but also returns a per-character map back to
   * the source DOM text nodes. The map powers the read-along highlight:
   * map[i] = { node, offset } for characters that exist in the DOM, or
   * null for synthesized characters (collapsed whitespace, added
   * punctuation, segment separators).
   */
  collectTtsContent(root, checkVisibility = true) {
    if (!root) return { text: '', map: [] };
    
    const SKIP_SELECTOR = [
      'script', 'style', 'svg', 'iframe', 'audio', 'video', 'canvas',
      'input', 'textarea', 'select',
      '.journey-tts-row',          // the listen button itself
      '.chat-input-wrapper',       // guide chat input
      '.typing-dots',              // guide typing animation
      '.pacing-indicator',         // "take your time..." countdowns
      '.panorama-container',       // 360° viewer
      '#quizScore',                // running score indicator
      '[data-tts-skip]',
      '[aria-hidden="true"]'
    ].join(',');
    
    // Buttons are skipped except the ones whose label IS step content:
    // path choices and quiz answer options.
    const READABLE_BUTTONS = ['preview-option', 'quiz-wizard-option'];
    
    const BLOCK_TAGS = new Set([
      'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
      'TABLE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FORM',
      'LABEL', 'BLOCKQUOTE', 'BUTTON', 'FIGCAPTION', 'PRE'
    ]);
    
    const isVisible = (el) =>
      !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    
    const segments = [];
    let segText = '';
    let segMap = [];
    
    // Append a DOM text node, collapsing whitespace runs into a single
    // space while recording where every kept character came from.
    const appendTextNode = (node) => {
      const str = node.textContent;
      for (let i = 0; i < str.length; i++) {
        if (/\s/.test(str[i])) {
          if (segText && !segText.endsWith(' ')) {
            segText += ' ';
            segMap.push(null);
          }
        } else {
          segText += str[i];
          segMap.push({ node, offset: i });
        }
      }
    };
    
    const flush = () => {
      if (segText.endsWith(' ')) {
        segText = segText.slice(0, -1);
        segMap.pop();
      }
      if (segText) segments.push({ text: segText, map: segMap });
      segText = '';
      segMap = [];
    };
    
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          appendTextNode(child);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        
        if (child.tagName === 'BR') { flush(); continue; }
        if (child.matches(SKIP_SELECTOR)) continue;
        if (child.tagName === 'BUTTON'
            && !READABLE_BUTTONS.some(cls => child.classList.contains(cls))) {
          continue;
        }
        if (checkVisibility && !isVisible(child)) continue;
        
        const isBlock = BLOCK_TAGS.has(child.tagName);
        if (isBlock) flush();
        walk(child);
        if (isBlock) flush();
      }
    };
    
    walk(root);
    flush();
    
    // Join the segments, ending each with punctuation so the voice
    // pauses naturally between title, paragraphs and options.
    let text = '';
    const map = [];
    for (const seg of segments) {
      if (text) {
        text += ' ';
        map.push(null);
      }
      text += seg.text;
      for (const entry of seg.map) map.push(entry);
      if (!/[.!?…:;,]$/.test(seg.text)) {
        text += '.';
        map.push(null);
      }
    }
    
    return { text, map };
  }
  
  /**
   * Split the collected text into sentence-based chunks, keeping each
   * chunk's character position in the source text. A chunk is both one
   * spoken unit AND one read-along highlight unit for BOTH engines
   * (Voxtral generates one audio file per chunk, Web Speech speaks one
   * utterance per chunk), so the marking always matches the audio
   * exactly - the sync is event-driven, never estimated. Short chunks
   * also work around Web Speech engines that stall on long text.
   * @returns {Array<{text: string, start: number, end: number}>}
   */
  splitTtsChunks(text, maxChunk = 180) {
    // Locate sentences with their absolute positions
    const sentences = [];
    const sentenceRe = /[^.!?…]+[.!?…]+\s*|[^.!?…]+$/g;
    let match;
    while ((match = sentenceRe.exec(text)) !== null) {
      const raw = match[0];
      if (!raw.trim()) continue;
      const lead = raw.length - raw.trimStart().length;
      const trail = raw.length - raw.trimEnd().length;
      sentences.push({
        start: match.index + lead,
        end: match.index + raw.length - trail
      });
    }
    
    const chunks = [];
    const pushChunk = (start, end) => {
      const chunkText = text.slice(start, end);
      if (chunkText.trim()) chunks.push({ text: chunkText, start, end });
    };
    
    // Break an overlong sentence on word boundaries, keeping positions
    const pushLongSentence = (sentence) => {
      const slice = text.slice(sentence.start, sentence.end);
      const wordRe = /\S+/g;
      let word;
      let pieceStart = -1;
      let pieceEnd = -1;
      while ((word = wordRe.exec(slice)) !== null) {
        const wordStart = sentence.start + word.index;
        const wordEnd = wordStart + word[0].length;
        if (pieceStart === -1) {
          pieceStart = wordStart;
          pieceEnd = wordEnd;
        } else if (wordEnd - pieceStart > maxChunk) {
          pushChunk(pieceStart, pieceEnd);
          pieceStart = wordStart;
          pieceEnd = wordEnd;
        } else {
          pieceEnd = wordEnd;
        }
      }
      if (pieceStart !== -1) pushChunk(pieceStart, pieceEnd);
    };
    
    // One sentence per chunk, so the highlight really reads along.
    // Only very short fragments (titles, labels like "Dan.") are
    // grouped with what follows, to avoid flickery marking and tiny
    // audio snippets.
    const MIN_CHUNK = 40;
    let current = null;
    const flushCurrent = () => {
      if (current) pushChunk(current.start, current.end);
      current = null;
    };
    
    for (const sentence of sentences) {
      if (sentence.end - sentence.start > maxChunk) {
        flushCurrent();
        pushLongSentence(sentence);
      } else if (!current) {
        current = { start: sentence.start, end: sentence.end };
      } else if (current.end - current.start >= MIN_CHUNK
                 || sentence.end - current.start > maxChunk) {
        flushCurrent();
        current = { start: sentence.start, end: sentence.end };
      } else {
        current.end = sentence.end;
      }
    }
    flushCurrent();
    
    return chunks;
  }
  
  /**
   * Add the reading aids (listen button + reading settings) to the
   * freshly rendered step card. Called from renderPreview() so it
   * behaves identically in the real player and in every preview.
   */
  injectTtsControl(container) {
    const card = container.querySelector('.preview-card');
    const content = card?.querySelector('.preview-content');
    if (!card || !content) return;
    
    const row = document.createElement('div');
    row.className = 'journey-tts-row';
    
    // Step orientation ("Step 3 of 8", plus "±6 min" on the start
    // step): a quiet anchor for time perception. Left of the reading
    // controls; excluded from the read-aloud text like the rest of
    // this row.
    const indicator = this.buildStepIndicator();
    if (indicator) row.appendChild(indicator);
    
    // Listen button: only when TTS works and the step has readable text
    // (e.g. skip the empty nested-journey pass-through step).
    if (this.ttsSupported()) {
      this.initTts();
      const probe = this.collectTtsText(card, false);
      if (probe.length >= 2) row.appendChild(this.buildTtsButton(card));
    }
    
    // Reading settings ("Aa"): always available so the font preference
    // can be changed on any step.
    row.appendChild(this.buildReadingControl());
    
    content.insertBefore(row, content.firstChild);
  }
  
  /* ============================================
     STEP / TIME ORIENTATION
     "Step 3 of 8" uses the same path estimate as the progress bar, so
     the two can never contradict each other. In branching journeys the
     total is the longest remaining route and gets a "±" prefix; on the
     start step of the main journey a rough duration ("±6 min") is
     added once. Inside nested journeys the parent journey's combined
     count is shown, and the quiz's own question counter lives inside
     the card, so the two never clash.
     ============================================ */
  
  buildStepIndicator() {
    const pos = this.computeJourneyPosition();
    if (!pos) return null;
    const el = document.createElement('div');
    el.className = 'journey-step-indicator';
    this.fillStepIndicator(el, pos);
    return el;
  }
  
  fillStepIndicator(el, pos) {
    // Once the end step is reached the count is exact, so drop the ±
    const showApprox = pos.isApprox && pos.percentage < 100;
    const parts = [window.tPlayer('player.orientation.step', {
      current: pos.current,
      total: (showApprox ? '±' : '') + pos.total
    })];
    
    // Estimated duration: only on the very first step of the main
    // journey, where it answers "how long will this take me?" without
    // becoming a ticking clock during the journey itself.
    const step = this.previewState.currentStep;
    if (step?.is_start && !this.previewState.isInNestedJourney) {
      const minutes = this.estimateJourneyDuration();
      if (minutes > 0) {
        parts.push(window.tPlayer('player.orientation.duration', { minutes }));
      }
    }
    
    el.textContent = parts.join(' · ');
  }
  
  buildTtsButton(card) {
    const listenText = window.tPlayer('player.tts.listen');
    const stopText = window.tPlayer('player.tts.stop');
    const listenLabel = window.tPlayer('player.tts.listenLabel');
    const stopLabel = window.tPlayer('player.tts.stopLabel');
    
    const holder = document.createElement('div');
    holder.innerHTML = `
      <button type="button" class="journey-tts-btn" aria-pressed="false"
              aria-label="${this.escapeHtml(listenLabel)}" title="${this.escapeHtml(listenLabel)}">
        <svg class="journey-tts-icon journey-tts-icon-listen" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"></path>
        </svg>
        <svg class="journey-tts-icon journey-tts-icon-stop" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z"></path>
        </svg>
        <span class="journey-tts-label">${this.escapeHtml(listenText)}</span>
      </button>
    `;
    
    const btn = holder.querySelector('.journey-tts-btn');
    btn.dataset.labelListen = listenText;
    btn.dataset.labelStop = stopText;
    btn.dataset.ariaListen = listenLabel;
    btn.dataset.ariaStop = stopLabel;
    
    btn.addEventListener('click', () => {
      if (this._ttsActive) {
        this.stopTts();
        return;
      }
      const content = this.collectTtsContent(card, true);
      if (content.text) this.startTts(content, btn);
    });
    
    return btn;
  }
  
  /* ============================================
     READING SETTINGS (dyslexia-friendly font)
     A quiet "Aa" pill next to the listen button opens a popover with
     a switch for the OpenDyslexic font. Off by default; the choice is
     stored per device so end users only have to enable it once and it
     applies to the whole journey (and any future journey they open).
     ============================================ */
  
  isDyslexicFontEnabled() {
    try {
      return localStorage.getItem('gryffiDyslexicFont') === '1';
    } catch {
      return false; // storage blocked (private mode) - treat as off
    }
  }
  
  setDyslexicFontEnabled(enabled) {
    try {
      if (enabled) {
        localStorage.setItem('gryffiDyslexicFont', '1');
      } else {
        localStorage.removeItem('gryffiDyslexicFont');
      }
    } catch {
      // Storage blocked - the setting still works for this page view
    }
    this._dyslexicFontFallback = enabled;
    this.applyReadingPrefs();
  }
  
  applyReadingPrefs() {
    const enabled = this.isDyslexicFontEnabled() || !!this._dyslexicFontFallback;
    document.body.classList.toggle('journey-dyslexic-font', enabled);
  }
  
  buildReadingControl() {
    const settingsLabel = window.tPlayer('player.reading.settings');
    const fontLabel = window.tPlayer('player.reading.dyslexicFont');
    const enabled = this.isDyslexicFontEnabled() || !!this._dyslexicFontFallback;
    
    const wrap = document.createElement('div');
    wrap.className = 'journey-reading-wrap';
    wrap.innerHTML = `
      <button type="button" class="journey-tts-btn journey-reading-btn${enabled ? ' is-on' : ''}"
              aria-haspopup="true" aria-expanded="false"
              aria-label="${this.escapeHtml(settingsLabel)}" title="${this.escapeHtml(settingsLabel)}">
        <span class="journey-reading-icon" aria-hidden="true">Aa</span>
      </button>
      <div class="journey-reading-popover hidden" role="group" aria-label="${this.escapeHtml(settingsLabel)}">
        <button type="button" class="journey-reading-option" role="switch" aria-checked="${enabled ? 'true' : 'false'}">
          <span>${this.escapeHtml(fontLabel)}</span>
          <span class="journey-switch" aria-hidden="true"></span>
        </button>
      </div>
    `;
    
    const btn = wrap.querySelector('.journey-reading-btn');
    const popover = wrap.querySelector('.journey-reading-popover');
    const option = wrap.querySelector('.journey-reading-option');
    
    const onDocClick = (e) => {
      if (!wrap.contains(e.target)) closePopover();
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        closePopover();
        btn.focus();
      }
    };
    const closePopover = () => {
      popover.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeydown);
    };
    
    btn.addEventListener('click', () => {
      if (popover.classList.contains('hidden')) {
        popover.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKeydown);
      } else {
        closePopover();
      }
    });
    
    option.addEventListener('click', () => {
      const enable = !(this.isDyslexicFontEnabled() || !!this._dyslexicFontFallback);
      this.setDyslexicFontEnabled(enable);
      option.setAttribute('aria-checked', enable ? 'true' : 'false');
      btn.classList.toggle('is-on', enable);
      // Popover stays open so the effect is immediately visible
    });
    
    return wrap;
  }
  
  /**
   * Toggle the visual state of the listen button.
   * 'loading' covers the short wait while Voxtral audio is generated;
   * in both 'loading' and 'speaking' the button acts as a stop button.
   */
  setTtsButtonState(btn, state) {
    if (!btn || !btn.isConnected) return;
    const speaking = state === 'speaking';
    const loading = state === 'loading';
    btn.classList.toggle('is-speaking', speaking);
    btn.classList.toggle('is-loading', loading);
    btn.setAttribute('aria-pressed', (speaking || loading) ? 'true' : 'false');
    btn.setAttribute('aria-busy', loading ? 'true' : 'false');
    const aria = (speaking || loading) ? btn.dataset.ariaStop : btn.dataset.ariaListen;
    btn.setAttribute('aria-label', aria);
    btn.setAttribute('title', aria);
    const label = btn.querySelector('.journey-tts-label');
    if (label) {
      label.textContent = (speaking || loading) ? btn.dataset.labelStop : btn.dataset.labelListen;
    }
  }
  
  /**
   * Which TTS endpoint to use depends on how the journey is served:
   * magic-link player, public link, or a logged-in maker preview.
   */
  getTtsEndpoint() {
    if (this.playerMode && this.player?.token) {
      return `/e/${encodeURIComponent(this.player.token)}/tts`;
    }
    if (window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token) {
      return `/p/${encodeURIComponent(window.GRYFFI.publicPlayer.token)}/tts`;
    }
    // Builder / fullscreen previews run on a logged-in maker session
    return '/api/tts';
  }
  
  /**
   * Create the shared audio element and "prime" it inside the click
   * gesture, so mobile browsers still allow play() after the async
   * fetch that generates the Voxtral audio.
   */
  unlockTtsAudio() {
    if (!this._ttsAudioEl) this._ttsAudioEl = new Audio();
    try {
      // Zero-sample silent WAV
      this._ttsAudioEl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
      const p = this._ttsAudioEl.play();
      if (p && p.catch) p.catch(() => {});
    } catch {
      // Priming is best-effort
    }
  }
  
  async startTts(content, btn) {
    this.stopTts();
    
    const session = ++this._ttsSession;
    this._ttsActive = true;
    this._ttsButton = btn;
    this._ttsMap = content.map;
    this._ttsChunks = this.splitTtsChunks(content.text);
    if (this._ttsChunks.length === 0) {
      this.stopTts();
      return;
    }
    this.setTtsButtonState(btn, 'loading');
    
    let handled = false;
    if (this.serverTtsSupported()) {
      this.unlockTtsAudio();
      handled = await this.playVoxtralTts(session);
    }
    if (this._ttsSession !== session || !this._ttsActive) return;
    if (!handled) this.startWebSpeechTts(btn, session);
  }
  
  /**
   * Fetch and play server-generated (Voxtral) audio for the step text,
   * one audio file per chunk; while one chunk plays the next is already
   * being generated server-side. The read-along highlight follows the
   * chunk that is playing. Returns false when playback couldn't start
   * at all (the caller then falls back to the Web Speech API) and true
   * when playback was handled here, even if it ended early.
   */
  async playVoxtralTts(session) {
    const endpoint = this.getTtsEndpoint();
    const language = this.getJourneyLanguage();
    const chunks = this._ttsChunks;
    
    const fetchChunkUrl = async (chunk) => {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: chunk.text, language })
      });
      if (!resp.ok) throw new Error(`TTS request failed (${resp.status})`);
      const data = await resp.json();
      if (!data?.url) throw new Error('TTS response missing audio url');
      return data.url;
    };
    
    // Generate chunks sequentially, staying one request ahead of playback
    const urlPromises = [fetchChunkUrl(chunks[0])];
    for (let i = 1; i < chunks.length; i++) {
      urlPromises.push(urlPromises[i - 1].then(() => fetchChunkUrl(chunks[i])));
    }
    urlPromises.forEach(p => p.catch(() => {})); // no unhandled rejections
    
    let startedPlaying = false;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const url = await urlPromises[i];
        if (this._ttsSession !== session) return true; // stopped meanwhile
        if (i === 0) this.setTtsButtonState(this._ttsButton, 'speaking');
        this.setTtsHighlight(chunks[i]);
        await this.playTtsAudio(url);
        startedPlaying = true;
        if (this._ttsSession !== session) return true;
      }
      this.stopTts(); // finished reading naturally
      return true;
    } catch (err) {
      if (this._ttsSession !== session) return true; // stop caused the error
      if (!startedPlaying) {
        console.warn('[TTS] Voxtral unavailable, falling back to Web Speech API:', err.message);
        this.clearTtsHighlight();
        return false;
      }
      // Mid-playback failure: stop calmly rather than switching to a
      // completely different voice halfway through the step.
      console.warn('[TTS] Voxtral playback interrupted:', err.message);
      this.stopTts();
      return true;
    }
  }
  
  playTtsAudio(url) {
    return new Promise((resolve, reject) => {
      const audio = this._ttsAudioEl || new Audio();
      this._ttsAudioEl = audio;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('audio playback error'));
      audio.src = url;
      const p = audio.play();
      if (p && p.catch) p.catch(reject);
    });
  }
  
  startWebSpeechTts(btn, session) {
    if (!this.webSpeechSupported()) {
      this.stopTts();
      return;
    }
    
    const chunks = this._ttsChunks;
    if (!chunks || chunks.length === 0) {
      this.stopTts();
      return;
    }
    
    const voice = this.pickTtsVoice();
    const lang = voice ? voice.lang : this.getTtsLang();
    
    this.setTtsButtonState(btn, 'speaking');
    
    let index = 0;
    const speakNext = () => {
      if (!this._ttsActive || this._ttsSession !== session) return;
      if (index >= chunks.length) {
        this.stopTts();
        return;
      }
      const chunk = chunks[index++];
      this.setTtsHighlight(chunk);
      const utterance = new SpeechSynthesisUtterance(chunk.text);
      if (voice) utterance.voice = voice;
      utterance.lang = lang;
      utterance.rate = 0.95; // slightly slower reads more calmly
      utterance.pitch = 1;
      utterance.onend = speakNext;
      utterance.onerror = () => {
        // 'interrupted'/'canceled' also land here after stopTts(); the
        // _ttsActive guard in speakNext makes that a no-op.
        if (this._ttsActive) this.stopTts();
      };
      // Keep a reference: some engines garbage-collect the utterance
      // mid-speech and never fire onend without it.
      this._ttsUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    };
    speakNext();
  }
  
  stopTts() {
    if (!this._ttsInitialized) return;
    this._ttsSession++;
    const btn = this._ttsButton;
    this._ttsActive = false;
    this._ttsButton = null;
    this._ttsUtterance = null;
    this._ttsChunks = null;
    this._ttsMap = null;
    this.clearTtsHighlight();
    if (this._ttsAudioEl) {
      try {
        this._ttsAudioEl.onended = null;
        this._ttsAudioEl.onerror = null;
        this._ttsAudioEl.pause();
        this._ttsAudioEl.removeAttribute('src');
      } catch {
        // Ignore - element may already be gone during page teardown
      }
    }
    try {
      if (this.webSpeechSupported()) window.speechSynthesis.cancel();
    } catch {
      // Ignore - engine may already be gone during page teardown
    }
    this.setTtsButtonState(btn, 'idle');
  }
  
  /* ============================================
     READ-ALONG HIGHLIGHT
     While reading aloud, the sentence(s) of the chunk currently being
     spoken get a soft tint via the CSS Custom Highlight API (no DOM
     mutation, so step interactivity is untouched). Because the chunk
     is the audio unit for both engines, the marking can never drift
     from the voice. Progressive enhancement: browsers without the API
     simply get audio without marking.
     ============================================ */
  
  ttsHighlightSupported() {
    return typeof window.Highlight === 'function'
      && typeof CSS !== 'undefined' && !!CSS.highlights;
  }
  
  setTtsHighlight(chunk) {
    if (!this.ttsHighlightSupported() || !this._ttsMap || !chunk) return;
    try {
      // Turn the chunk's character span into DOM ranges by grouping
      // consecutive characters that live in the same text node.
      const ranges = [];
      let runNode = null;
      let runStart = 0;
      let runEnd = 0;
      const flushRun = () => {
        if (!runNode) return;
        const range = new Range();
        range.setStart(runNode, runStart);
        range.setEnd(runNode, runEnd + 1);
        ranges.push(range);
        runNode = null;
      };
      for (let i = chunk.start; i < chunk.end; i++) {
        const entry = this._ttsMap[i];
        if (!entry || !entry.node.isConnected) continue; // synthesized char
        if (runNode === entry.node && entry.offset >= runEnd) {
          // Same node, moving forward (also spans collapsed whitespace)
          runEnd = entry.offset;
        } else {
          flushRun();
          runNode = entry.node;
          runStart = entry.offset;
          runEnd = entry.offset;
        }
      }
      flushRun();
      if (ranges.length === 0) return;
      
      CSS.highlights.set('journey-tts-reading', new Highlight(...ranges));
      
      // Gently keep the sentence being read in view on long steps
      const el = ranges[0].startContainer.parentElement;
      if (el && typeof el.scrollIntoView === 'function') {
        const reduceMotion = window.matchMedia
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      }
    } catch {
      // Highlighting is an enhancement - never let it break the audio
    }
  }
  
  clearTtsHighlight() {
    try {
      if (this.ttsHighlightSupported()) CSS.highlights.delete('journey-tts-reading');
    } catch {
      // Ignore - nothing to clear
    }
  }
  
  renderPreview() {
    // Stop reading aloud as soon as the step changes
    this.stopTts();

    // Keep the partial-preview banner in sync with the current step.
    // It only shows on the entry step of a "preview from this step" run
    // and disappears as soon as the maker navigates onward.
    this.updatePartialPreviewBanner();

    const step = this.previewState.currentStep;
    const basicProps = typeof step.basic_props === 'string' 
      ? JSON.parse(step.basic_props) 
      : (step.basic_props || {});
    const advancedProps = typeof step.advanced_props === 'string' 
      ? JSON.parse(step.advanced_props) 
      : (step.advanced_props || {});
    
    const paths = this.paths.filter(p => p.from_step_id === step.id);
    const container = document.getElementById('previewContent');
    
    let html = `<div class="preview-card">`;
    
    switch (step.type) {
      case 'space':
        const isPanoramaView = basicProps.is_panorama === true;
        const hasFloorplan = basicProps.floorplan?.enabled && basicProps.floorplan?.floorplan_id;
        html += `
          <div class="preview-space-header">
            <h2 class="text-xl font-bold">${escapeHtml(step.title)}</h2>
          </div>
          <div class="preview-content relative">
            <p class="text-zen-700">${escapeHtml(basicProps.description)}</p>
            ${basicProps.image_url ? (
              isPanoramaView 
                ? `<div class="panorama-container mt-4" id="panoramaViewerContainer" data-url="${escapeHtml(basicProps.image_url)}"></div>`
                : `<img src="${escapeHtml(basicProps.image_url)}" class="mt-4 rounded-lg w-full" />`
            ) : ''}
            ${hasFloorplan ? `
              <button class="floorplan-pill" id="floorplanFab" 
                      data-floorplan-id="${escapeHtml(basicProps.floorplan.floorplan_id)}"
                      data-marker-x="${escapeHtml(basicProps.floorplan.marker_x)}"
                      data-marker-y="${escapeHtml(basicProps.floorplan.marker_y)}">
                <svg class="floorplan-pill-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"></path>
                </svg>
                <span class="floorplan-pill-text">${window.t('builder.props.viewFloorplan')}</span>
              </button>
            ` : ''}
          </div>
        `;
        break;
        
      case 'guide':
        // Get guide from central library
        const previewGuide = this.guides.find(g => g.id === basicProps.guide_id);
        const guideName = previewGuide?.name || basicProps.name || window.t('builder.preview.guide');
        const guideRole = previewGuide?.role || basicProps.role || window.t('builder.preview.aiAssistant');
        
        if (!previewGuide && !basicProps.guide_id) {
          html += `
            <div class="preview-content text-center py-12">
              <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-zen-100 flex items-center justify-center">
                <svg class="w-8 h-8 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path>
                </svg>
              </div>
              <h3 class="font-medium text-zen-700 mb-2">${window.tPlayer('player.noGuideSelected')}</h3>
              <p class="text-sm text-zen-500">${window.tPlayer('player.pleaseSelectGuide')}</p>
            </div>
          `;
        } else {
        const guideAvatarUrl = previewGuide?.avatar_url;
        html += `
          <div class="preview-content">
            <div class="flex items-center gap-3 mb-4">
                <div class="journey-guide-avatar">
                  ${guideAvatarUrl 
                    ? `<img src="${escapeHtml(guideAvatarUrl)}" alt="${escapeHtml(guideName)}" class="journey-guide-avatar-img">`
                    : guideName[0]
                  }
                </div>
              <div>
                  <h3 class="font-semibold text-zen-900">${escapeHtml(guideName)}</h3>
                  <p class="text-sm text-zen-500">${escapeHtml(guideRole)}</p>
              </div>
            </div>
          </div>
          <div class="preview-chat">
            <div class="chat-messages" id="chatMessages">
              <div class="chat-message guide typing" id="guideOpening">
                <span class="typing-dots">
                  <span></span><span></span><span></span>
                </span>
              </div>
            </div>
            <div class="chat-input-wrapper">
                <input type="text" class="chat-input" id="chatInput" placeholder="${window.tPlayer('player.chat.typeMessage')}" disabled />
                <button class="chat-send" id="sendChatBtn" disabled>${window.tPlayer('player.chat.send')}</button>
            </div>
          </div>
        `;
        }
        break;
        
      case 'content':
        const mediaType = basicProps.media_type === 'markdown' ? 'text' : (basicProps.media_type || 'text');
        let contentHtml = '';
        let mediaHtml = '';
        const descriptionHtml = basicProps.media_description 
          ? `<div class="prose prose-zen text-zen-700">${autolinkHtml(this.escapeHtml(basicProps.media_description).replace(/\n/g, '<br>'))}</div>` 
          : '';
        const textPosition = basicProps.text_position || 'above';
        
        if (mediaType === 'text') {
          // Display HTML content directly (from the simple editor). Plain
          // URLs and email addresses are auto-linked and forced to open in
          // a new tab so the journey isn't unloaded mid-step.
          contentHtml = `<div class="prose prose-zen">${autolinkHtml(sanitizeRichHtml(basicProps.body))}</div>`;
        } else if (mediaType === 'video' && basicProps.video_url) {
          // Extract YouTube video ID and embed
          const videoId = this.extractYouTubeId(basicProps.video_url);
          
          if (videoId) {
            // Show thumbnail with play button overlay - clicking starts video AND timer
            // Use hqdefault.jpg as it's always available (maxresdefault.jpg isn't for all videos)
            mediaHtml = `
              <div class="rounded-lg overflow-hidden bg-black relative" id="videoPlayerContainer" data-video-id="${videoId}" style="aspect-ratio: 16/10;">
                <iframe 
                  src="https://www.youtube-nocookie.com/embed/${videoId}?rel=0" 
                  class="w-full h-full"
                  frameborder="0" 
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
                  referrerpolicy="strict-origin-when-cross-origin"
                  allowfullscreen>
                </iframe>
                <div id="videoPlayOverlay" class="absolute inset-0 cursor-pointer" style="display: none;"></div>
              </div>
            `;
            // Combine description and media based on position
            if (descriptionHtml) {
              contentHtml = textPosition === 'above' 
                ? `<div class="mb-4">${descriptionHtml}</div>${mediaHtml}`
                : `${mediaHtml}<div class="mt-4">${descriptionHtml}</div>`;
            } else {
              contentHtml = mediaHtml;
            }
          } else {
            contentHtml = `<p class="text-zen-500 italic">${window.t('builder.preview.invalidVideoUrl')}</p>`;
          }
        } else if (mediaType === 'image' && basicProps.image_url) {
          mediaHtml = `<img src="${escapeHtml(basicProps.image_url)}" alt="${escapeHtml(step.title)}" class="rounded-lg w-full" />`;
          // Combine description and media based on position
          if (descriptionHtml) {
            contentHtml = textPosition === 'above' 
              ? `<div class="mb-4">${descriptionHtml}</div>${mediaHtml}`
              : `${mediaHtml}<div class="mt-4">${descriptionHtml}</div>`;
          } else {
            contentHtml = mediaHtml;
          }
        } else {
          contentHtml = `<p class="text-zen-400 italic">${window.t('builder.preview.noContentYet')}</p>`;
        }
        
        html += `
          <div class="preview-content">
            <h2 class="journey-step-title">${escapeHtml(step.title)}</h2>
            ${contentHtml}
          </div>
        `;
        break;
        
      case 'challenge':
        // Get questions (support both old and new format)
        let quizQuestions = basicProps.questions || [];
        if (quizQuestions.length === 0 && basicProps.question) {
          quizQuestions = [{
            id: 'legacy',
            question: basicProps.question,
            options: basicProps.options || []
          }];
        }
        
        // Shuffle questions if enabled
        const shouldShuffle = basicProps.shuffle_questions;
        if (shouldShuffle && quizQuestions.length > 1) {
          // Use seeded shuffle based on session/participant to ensure consistency during session
          // but different order for different users
          // In player mode: use token for consistent order per user
          // In preview mode: use random seed each time to demonstrate shuffling
          const isRealPlayer = this.playerMode || window.GRYFFI?.publicMode;
          const sessionSeed = isRealPlayer 
            ? (this.player?.token || window.GRYFFI?.publicPlayer?.sessionId || Date.now())
            : Date.now(); // Random each preview
          console.log('[Quiz] Shuffling questions, seed:', sessionSeed, 'isRealPlayer:', isRealPlayer);
          quizQuestions = this.shuffleArray([...quizQuestions], sessionSeed);
        }
        
        const totalQuestions = quizQuestions.length;
        const passingScore = advancedProps.passing_score || 0;
        const showFeedback = advancedProps.show_feedback !== false;
        const allowRetake = advancedProps.allow_retake !== false;
        
        // Escape special characters for HTML attributes
        const escapeHtmlAttr = (str) => {
          if (!str) return '';
          return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        };
        
        html += `
          <div class="preview-content quiz-wizard" id="quizWizard" 
               data-questions="${escapeHtmlAttr(JSON.stringify(quizQuestions))}"
               data-passing-score="${escapeHtml(passingScore)}"
               data-show-feedback="${showFeedback}"
               data-allow-retake="${allowRetake}"
               data-pass-message="${escapeHtmlAttr(advancedProps.pass_message || '')}"
               data-fail-message="${escapeHtmlAttr(advancedProps.fail_message || '')}">
            
            <!-- Quiz Header -->
            <div class="journey-step-badge">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"></path>
              </svg>
              <span>${window.t('builder.quiz.title')}</span>
            </div>
            
            <!-- Progress Bar -->
            <div class="mb-6">
              <div class="flex justify-between items-center mb-2">
                <span class="text-sm text-zen-600" id="quizProgress">
                  ${window.tPlayer('player.quiz.questionOf', { current: 1, total: totalQuestions })}
                </span>
                <span class="text-xs text-zen-400" id="quizScore"></span>
              </div>
              <div class="h-2 bg-zen-100 rounded-full overflow-hidden">
                <div class="h-full transition-all duration-300" id="quizProgressBar" style="background: var(--theme-progress-bar, var(--theme-accent, #78c503)); width: ${100 / totalQuestions}%"></div>
              </div>
            </div>
            
            <!-- Question Container -->
            <div id="quizQuestionContainer">
              ${this.renderQuizWizardQuestion(quizQuestions[0], 0, totalQuestions)}
            </div>
            
            <!-- Results Container (hidden initially) -->
            <div id="quizResultsContainer" class="hidden">
              <!-- Will be populated dynamically -->
            </div>
          </div>
        `;
        break;
        
      case 'form':
        const formFields = basicProps.fields || [];
        html += `
          <div class="preview-content">
            <!-- Already Submitted Banner (hidden by default, shown via JS) -->
            <div class="form-already-submitted-banner hidden mb-6 p-4 rounded-lg border" id="formAlreadySubmittedBanner" 
                 style="background: color-mix(in srgb, var(--theme-primary, #0b4b34) 8%, white); border-color: color-mix(in srgb, var(--theme-primary, #0b4b34) 20%, transparent);">
              <div class="flex items-start gap-3">
                <div class="flex-shrink-0 mt-0.5">
                  <svg class="w-5 h-5" style="color: var(--theme-primary, #0b4b34);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                  </svg>
                </div>
                <div class="flex-1">
                  <h4 class="text-sm font-medium" style="color: var(--theme-primary, #0b4b34);">${window.t('builder.form.alreadySubmitted.title')}</h4>
                  <p class="text-sm mt-1 text-zen-600" id="formSubmittedMessage">${window.t('builder.form.alreadySubmitted.message', { date: '' })}</p>
                </div>
              </div>
            </div>
            
            <div class="journey-step-badge">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path>
              </svg>
              <span>${window.t('builder.preview.form')}</span>
            </div>
            <h2 class="journey-step-title">${escapeHtml(step.title)}</h2>
            ${basicProps.description ? `<p class="text-zen-600 mb-6">${escapeHtml(basicProps.description)}</p>` : ''}
            
            <form class="preview-form space-y-4" id="previewForm">
              ${formFields.map((field, i) => this.renderFormFieldPreview(field, i)).join('')}
              
              <div class="form-buttons-container mt-8 pt-4 flex flex-wrap items-center gap-3">
                <button type="submit" class="journey-poll-submit-btn" id="submitFormBtn">
                  ${window.t('builder.preview.submit')}
                </button>
                
                <!-- Skip Form Button (hidden by default, shown only when user has already submitted this form before) -->
                <button type="button" class="journey-form-skip-btn" id="skipFormBtn"
                        style="display: none;">
                  ${window.t('builder.form.alreadySubmitted.skipButton')}
                </button>
              </div>
            </form>
            
            <div class="form-success-message hidden text-center py-8" id="formSuccessMessage">
              <div class="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style="background: color-mix(in srgb, var(--theme-accent, #78c503) 20%, transparent);">
                <svg class="w-8 h-8" style="color: var(--theme-accent, #78c503);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
              </div>
              <p class="text-lg font-medium text-zen-900">${escapeHtml(advancedProps.confirmation_message || window.t('builder.preview.defaultConfirmation'))}</p>
            </div>
          </div>
        `;
        break;
        
      case 'poll':
        const pollOptions = basicProps.options || [];
        const allowMultiple = basicProps.allow_multiple || false;
        const showResults = true; // Results always shown after voting
        const isRequired = basicProps.is_required !== false;
        
        html += `
          <div class="preview-content">
            <div class="journey-poll" data-step-id="${step.id}" data-allow-multiple="${allowMultiple}" data-show-results="${showResults}" data-required="${isRequired}">
              <p class="journey-poll-question">${escapeHtml(basicProps.question)}</p>
              <div class="journey-poll-options">
                ${pollOptions.map((opt, i) => {
                  const letter = String.fromCharCode(65 + i);
                  return `
                  <div class="journey-poll-option" data-option-index="${i}" role="button" tabindex="0">
                    <input type="hidden" name="poll_option" value="${i}" class="journey-poll-input">
                    <span class="option-letter">${letter}</span>
                    <span class="option-text">${this.escapeHtml(opt.text || '')}</span>
                    <span class="journey-poll-option-bar" style="width: 0%"></span>
                    <span class="journey-poll-option-count hidden">0</span>
                    <span class="option-indicator">
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
                      </svg>
                    </span>
                  </div>
                `}).join('')}
              </div>
              <div class="journey-poll-footer">
                <button type="button" class="journey-poll-submit-btn" id="pollSubmitBtn">${window.tPlayer('player.poll.submitVote')}</button>
                <div class="journey-poll-status hidden" id="pollStatus"></div>
              </div>
              <div class="journey-poll-results hidden" id="pollResults">
                <div class="journey-poll-total"></div>
              </div>
            </div>
          </div>
        `;
        break;
        
      case 'reward':
        const rewardTitle = basicProps.title || window.t('builder.reward.preview.yourCode');
        const rewardDesc = basicProps.description || '';
        const redemptionLoc = basicProps.redemption_location || '';
        const termsConditions = basicProps.terms_conditions || '';
        const validUntil = basicProps.valid_until;
        // Determine preview mode: builder preview OR public journey preview (not real public journey)
        const isPublicJourney = window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token;
        const isPublicPreviewOnly = window.GRYFFI?.publicMode && window.GRYFFI?.previewMode && !window.GRYFFI?.publicPlayer?.token;
        const isPreviewMode = (!this.playerMode && !isPublicJourney) || isPublicPreviewOnly; // True if in builder preview mode
        
        html += `
          <div class="preview-content">
            <div class="journey-reward" data-step-id="${step.id}">
              <!-- Reward Header -->
              <div class="journey-step-badge">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"></path>
                </svg>
                <span>${window.t('builder.stepTypes.reward')}</span>
              </div>
              
              <!-- Congratulations Message -->
              <div class="text-center mb-6">
                <h2 class="text-2xl font-bold text-zen-900 mb-2">${window.t('builder.reward.preview.congratulations')}</h2>
                <p class="text-zen-600" id="rewardPosition">${isPreviewMode ? window.t('builder.reward.preview.previewMode') : ''}</p>
              </div>
              
              <!-- Reward Card -->
              <div class="bg-white rounded-xl p-6 mb-6" style="border: 2px solid color-mix(in srgb, var(--theme-primary, #0b4b34) 20%, transparent);">
                <h3 class="text-lg font-bold mb-2" style="color: var(--theme-primary, #0b4b34);">${this.escapeHtml(rewardTitle)}</h3>
                ${rewardDesc ? `<p class="text-zen-600 mb-4">${this.escapeHtml(rewardDesc)}</p>` : ''}
                
                <!-- Code Display -->
                <div class="rounded-lg p-4 mb-4 text-center" style="background: var(--theme-background, #ecf2eb); border: 1px solid color-mix(in srgb, var(--theme-primary, #0b4b34) 20%, transparent);">
                  <p class="text-xs mb-1" style="color: var(--theme-primary, #0b4b34);">${window.t('builder.reward.preview.yourCode')}</p>
                  <p class="text-3xl font-mono font-bold tracking-wider" style="color: var(--theme-primary, #0b4b34);" id="rewardCode">
                    ${isPreviewMode ? 'PREVIEW-CODE' : '...'}
                  </p>
                </div>
                
                <!-- Redemption Info -->
                ${redemptionLoc ? `
                  <div class="flex items-start gap-2 mb-3">
                    <svg class="w-5 h-5 flex-shrink-0 mt-0.5" style="color: var(--theme-primary, #0b4b34);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path>
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path>
                    </svg>
                    <div>
                      <p class="text-xs font-medium" style="color: var(--theme-primary, #0b4b34);">${window.t('builder.reward.preview.redeemAt')}</p>
                      <p class="text-zen-700">${this.escapeHtml(redemptionLoc)}</p>
                    </div>
                  </div>
                ` : ''}
                
                ${validUntil ? `
                  <div class="flex items-start gap-2 mb-3">
                    <svg class="w-5 h-5 flex-shrink-0 mt-0.5" style="color: var(--theme-primary, #0b4b34);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                    </svg>
                    <div>
                      <p class="text-xs font-medium" style="color: var(--theme-primary, #0b4b34);">${window.t('builder.reward.preview.validUntil')}</p>
                      <p class="text-zen-700">${this.formatDate(validUntil)}</p>
                    </div>
                  </div>
                ` : ''}
                
                ${termsConditions ? `
                  <div class="mt-4 pt-4 border-t border-zen-200">
                    <p class="text-xs font-medium mb-1" style="color: var(--theme-primary, #0b4b34);">${window.t('builder.reward.preview.terms')}</p>
                    <p class="text-sm text-zen-600">${this.escapeHtml(termsConditions)}</p>
                  </div>
                ` : ''}
              </div>
              
              <!-- Actions -->
              <div class="flex gap-3">
                <button type="button" class="journey-nav-btn journey-nav-btn-primary flex-1 flex items-center justify-center gap-2" id="downloadRewardPdfBtn">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                  </svg>
                  ${window.t('builder.reward.preview.downloadCoupon')}
                </button>
              </div>
              
              <p class="text-center text-xs text-zen-500 mt-4" id="rewardEmailSent">${window.t('builder.reward.preview.emailSent')}</p>
            </div>
          </div>
        `;
        break;
        
      case 'nested_journey':
        // Nested journey steps should not render any content in preview mode
        // The navigation logic in navigateToStep() handles entering the nested journey directly
        // This empty content ensures a seamless transition without any flash
        html += `<div class="preview-content"></div>`;
        break;
    }
    
    // Navigation options with pacing
    // NESTED JOURNEY: Don't render any navigation for nested_journey steps
    // The navigation logic handles entering the nested journey directly before rendering
    if (step.type === 'nested_journey') {
      // No navigation rendered - user is immediately taken into the nested journey
    } else if (paths.length > 0 && step.type !== 'guide') {
      const pacing = advancedProps.pacing || 'immediately';
      const pacingInfo = this.getPacingInfo(pacing, step.type, basicProps.media_type);
      
      // For challenge steps, always hide nav buttons until quiz is completed
      const isChallenge = step.type === 'challenge';
      
      // For form steps, check completion_requirement
      const isForm = step.type === 'form';
      const formRequirement = advancedProps.completion_requirement || 'after_submit';
      const formRequiresSubmit = isForm && formRequirement === 'after_submit';
      
      // For poll steps, check if required
      const isPoll = step.type === 'poll';
      const pollIsRequired = isPoll && (basicProps.is_required !== false);
      // Check if already voted in preview
      const pollAlreadyVoted = isPoll && this.previewState.pollVotes && this.previewState.pollVotes[step.id];
      
      // Determine if nav should be shown immediately
      let shouldShowNav = pacing === 'immediately';
      if (isChallenge) shouldShowNav = false;
      if (formRequiresSubmit) shouldShowNav = false;
      if (pollIsRequired && !pollAlreadyVoted) shouldShowNav = false;
      
      // Determine the pacing message
      let pacingMessage = pacingInfo.message;
      if (isChallenge) {
        pacingMessage = window.tPlayer('player.quiz.completeQuizToContinue');
      } else if (formRequiresSubmit) {
        pacingMessage = window.tPlayer('player.form.submitToContinue');
      } else if (pollIsRequired && !pollAlreadyVoted) {
        pacingMessage = window.tPlayer('player.poll.completePollToContinue');
      }
      
      html += `
        <div class="preview-options" id="previewNavigation">
          <!-- Pacing indicator (hidden when unlocked) -->
          <div class="pacing-indicator ${shouldShowNav ? 'hidden' : ''}" id="pacingIndicator">
            <svg class="w-4 h-4 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            <span class="text-sm text-zen-500" id="pacingMessage">${escapeHtml(pacingMessage)}</span>
          </div>
          
          <!-- Navigation buttons (hidden until pacing unlocked) -->
          <div class="preview-nav-buttons ${shouldShowNav ? '' : 'hidden'}" id="navButtons">
          ${paths.map(p => `
            <button class="preview-option" data-path="${p.id}" data-target="${p.to_step_id}">
              <svg class="w-5 h-5" style="color: var(--theme-primary, #0b4b34);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"></path>
              </svg>
              <span class="flex-1">${escapeHtml(p.label)}</span>
            </button>
          `).join('')}
          </div>
        </div>
      `;
    }
    
    // End step celebration (only show if NOT in a nested journey)
    // In nested journey, we auto-return to parent instead of showing "complete"
    if (step.is_end && !this.previewState.isInNestedJourney) {
      // Check if user can restart the journey (unlimited or has completions remaining)
      const canRestart = this.playerMode && this.player && (
        this.player.maxCompletions === null || // null = unlimited
        (this.player.completionsCount + 1) < this.player.maxCompletions
      );
      
      html += `
        <div class="p-6 text-center border-t border-zen-200">
          ${canRestart ? `
            <div class="mb-4">
              <div class="w-16 h-16 mx-auto mb-3 rounded-full flex items-center justify-center" style="background: var(--theme-primary, #0b4b34)15;">
                <svg class="w-8 h-8" style="color: var(--theme-primary, #0b4b34);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
              </div>
              <p class="text-lg font-semibold" style="color: var(--theme-primary, #0b4b34);">${window.t('invitations.magicLink.completedCanRestart.title')}</p>
              <p class="text-zen-500 mt-1">${window.t('invitations.magicLink.completedCanRestart.message')}</p>
            </div>
            <button type="button" id="restartJourneyBtn" class="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-white transition-all hover:opacity-90" style="background: var(--theme-primary, #0b4b34);">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
              </svg>
              ${window.t('invitations.magicLink.completedCanRestart.restartButton')}
            </button>
          ` : `
            <p class="font-semibold" style="color: var(--theme-primary, #0b4b34);">${window.tPlayer('player.navigation.journeyComplete')}</p>
          `}
        </div>
      `;
    } else if (step.is_end && this.previewState.isInNestedJourney) {
      // In nested journey end step - show "Continue" button to return to parent
      html += `
        <div class="preview-options" id="previewNavigation">
          <div class="preview-nav-buttons" id="navButtons">
            <button class="preview-option nested-journey-continue" id="nestedJourneyContinue">
              <svg class="w-5 h-5" style="color: var(--theme-primary, #0b4b34);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"></path>
              </svg>
              <span class="flex-1">${window.t('common.continue') || 'Continue'}</span>
            </button>
          </div>
        </div>
      `;
    }
    
    html += `</div>`;
    container.innerHTML = html;
    
    // Add the text-to-speech "listen" control (identical in player and previews)
    this.injectTtsControl(container);
    
    // Scroll to top of the step content (works for both mobile and desktop)
    // Reset scroll on the preview-content element (mobile scrollable area)
    const previewContent = container.querySelector('.preview-content');
    if (previewContent) {
      previewContent.scrollTop = 0;
    }
    // Reset scroll on the container itself (desktop modal)
    container.scrollTop = 0;
    // Reset scroll on the preview-card (for full card scroll)
    const previewCard = container.querySelector('.preview-card');
    if (previewCard) {
      previewCard.scrollTop = 0;
    }
    // For player mode, also scroll the main content area
    const playerContent = document.querySelector('.player-content');
    if (playerContent) {
      playerContent.scrollTop = 0;
      window.scrollTo(0, 0);
    }
    
    // Initialize panorama viewer if present
    const panoramaContainer = container.querySelector('#panoramaViewerContainer');
    if (panoramaContainer) {
      const panoramaUrl = panoramaContainer.dataset.url;
      this.initPanoramaViewer(panoramaContainer, panoramaUrl);
    }
    
    // Initialize floorplan FAB if present
    const floorplanFab = container.querySelector('#floorplanFab');
    if (floorplanFab) {
      const handleFloorplanClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const floorplanId = floorplanFab.dataset.floorplanId;
        const markerX = floorplanFab.dataset.markerX;
        const markerY = floorplanFab.dataset.markerY;
        this.showFloorplanOverlay(floorplanId, markerX, markerY);
      };
      
      // Support both click and touch for mobile compatibility
      floorplanFab.addEventListener('click', handleFloorplanClick);
      floorplanFab.addEventListener('touchend', (e) => {
        e.preventDefault();
        handleFloorplanClick(e);
      }, { passive: false });
    }
    
    // Bind preview events
    container.querySelectorAll('.preview-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetId = btn.dataset.target;
        const pathId = btn.dataset.path;
        const targetStep = this.steps.find(s => s.id === targetId);
        if (targetStep) {
          // Clear any existing pacing timer
          if (this.previewState.pacingTimer) {
            clearInterval(this.previewState.pacingTimer);
          }
          
          // NESTED JOURNEY: If current step is a nested_journey type, enter the nested journey
          // This works in both player mode AND builder preview mode
          console.log('[Navigation] Current step type:', step.type, 'Step ID:', step.id);
          console.log('[Navigation] BasicProps:', basicProps);
          
          if (step.type === 'nested_journey') {
            const nestedJourneyId = basicProps.nested_journey_id;
            console.log('[NestedJourney] Step is nested_journey, nestedJourneyId:', nestedJourneyId);
            
            if (nestedJourneyId) {
              // Store the target step info for after the nested journey completes
              this.previewState.pendingTargetStep = targetStep;
              this.previewState.pendingPathId = pathId;
              
              console.log('[NestedJourney] Calling enterNestedJourney...');
              const entered = await this.enterNestedJourney(nestedJourneyId, step.id);
              console.log('[NestedJourney] enterNestedJourney result:', entered);
              
              if (entered) {
                return; // Successfully entered nested journey, don't navigate yet
              }
              // If failed to enter, fall through to normal navigation
            } else {
              console.log('[NestedJourney] No nestedJourneyId set in basicProps');
            }
          }
          
          // Analytics: Track step completion with duration
          if (this.playerMode) {
            journeyAnalytics.stepCompleted(step.id, step.type);
          }
          
          // Trigger automations for completing current step
          this.triggerAutomation('on_step_complete', step.id);
          if (pathId) {
            this.triggerAutomation(`on_path:${pathId}`, step.id, pathId);
          }
          
          // Add current step to visited (avoid duplicates)
          if (!this.previewState.visitedSteps.includes(step.id)) {
            this.previewState.visitedSteps.push(step.id);
          }
          // Also add target step as visited
          if (!this.previewState.visitedSteps.includes(targetStep.id)) {
            this.previewState.visitedSteps.push(targetStep.id);
          }
          this.previewState.currentStep = targetStep;
          this.previewState.chatHistory = [];
          this.previewState.messageCount = 0;
          this.previewState.pacingUnlocked = false;
          this.previewState.quizPassed = false;
          this.previewState.videoTimerStarted = false;
          this.previewState._endStepCompleted = false;
          
          // NESTED JOURNEY: If the TARGET step is a nested journey, enter it directly
          // This provides seamless UX - users don't see any intermediate screen
          if (targetStep.type === 'nested_journey' && !this.previewState.isInNestedJourney) {
            const targetBasicProps = targetStep.basic_props || {};
            const nestedJourneyId = targetBasicProps.nested_journey_id;
            
            if (nestedJourneyId) {
              console.log('[NestedJourney] Target step is nested_journey, entering directly:', nestedJourneyId);
              
              // Store the paths from the nested journey step for after completion
              const exitPaths = this.paths.filter(p => p.from_step_id === targetStep.id);
              this.previewState.pendingExitPaths = exitPaths;
              
              await this.enterNestedJourney(nestedJourneyId, targetStep.id);
              return; // Don't render the nested journey step, we're already in the sub-journey
            }
          }
          
          // Analytics: Track step entry for new step
          if (this.playerMode) {
            journeyAnalytics.stepEntered(targetStep.id, targetStep.type);
          }
          
          this.renderPreview();
          
          // Update guide chat for the new step
          this.updateGuideChatForStep(targetStep);
          
          // Trigger automations for entering new step
          this.triggerAutomation('on_step_enter', targetStep.id);
          
          // Update progress bar (both player mode and builder preview)
          this.updatePlayerProgress();
          
          // PLAYER MODE: Save progress and update browser history
          if (this.playerMode) {
            this.savePlayerProgress();
            
            // Add to step history and push browser history state
            if (this.previewState.stepHistory) {
              // If we navigated back and then forward via UI, truncate future history
              const currentIndex = this.previewState.historyIndex || 0;
              if (currentIndex < this.previewState.stepHistory.length - 1) {
                // We're not at the end, truncate future steps
                this.previewState.stepHistory = this.previewState.stepHistory.slice(0, currentIndex + 1);
              }
              
              // Add new step to history
              this.previewState.stepHistory.push(targetStep.id);
              this.previewState.historyIndex = this.previewState.stepHistory.length - 1;
              
              // Push to browser history
              history.pushState({ 
                stepId: targetStep.id, 
                historyIndex: this.previewState.historyIndex,
                isJourneyState: true 
              }, '', window.location.href);
            }
          }
          
          // Check if this is an end step
          if (targetStep.is_end) {
            this.triggerAutomation('on_journey_complete', targetStep.id);
            // PLAYER MODE: Mark journey as completed
            if (this.playerMode) {
              this.previewState._endStepCompleted = false;
              if (this.isEndStepAutoComplete(targetStep)) {
                this.trackEndStepCompletion(targetStep);
              }
              this.completePlayerJourney();
            }
          }
        }
      });
    });
    
    // NESTED JOURNEY: Auto-start nested journey when we land on a nested_journey step
    // This is a fallback for when the start step is a nested_journey or direct navigation
    // Normal navigation already handles this in navigateToStep() before rendering
    if (step.type === 'nested_journey') {
      const basicProps = step.basic_props || {};
      const nestedJourneyId = basicProps.nested_journey_id;
      
      if (nestedJourneyId && !this.previewState.isInNestedJourney) {
        // Enter immediately without delay - the empty content prevents flash
        console.log('[NestedJourney] Auto-starting nested journey (fallback):', nestedJourneyId);
        
        // Store the paths from this step for after the nested journey completes
        const exitPaths = this.paths.filter(p => p.from_step_id === step.id);
        this.previewState.pendingExitPaths = exitPaths;
        
        // Use immediate invocation to prevent any visible delay
        (async () => {
          await this.enterNestedJourney(nestedJourneyId, step.id);
        })();
      }
    }
    
    // NESTED JOURNEY: Bind click handler for "Continue" button at end of nested journey
    const nestedJourneyContinueBtn = container.querySelector('.nested-journey-continue');
    if (nestedJourneyContinueBtn) {
      nestedJourneyContinueBtn.addEventListener('click', async () => {
        console.log('[NestedJourney] Continue button clicked - returning to parent journey');
        await this.exitNestedJourney();
      });
    }
    
    // RESTART JOURNEY: Bind click handler for restart button on end step
    const restartJourneyBtn = container.querySelector('#restartJourneyBtn');
    if (restartJourneyBtn) {
      restartJourneyBtn.addEventListener('click', async () => {
        console.log('[Journey] Restart button clicked');
        await this.restartJourney();
      });
    }
    
    // Initialize pacing for this step
    this.initializePacing(step, advancedProps, basicProps);
    
    // Quiz wizard initialization
    if (step.type === 'challenge') {
      this.initQuizWizard(container);
    }
    
    // Form step: check if already submitted (for player mode)
    if (step.type === 'form' && (this.playerMode || window.GRYFFI?.publicMode)) {
      this.checkFormSubmissionStatus(step, container, advancedProps);
    }
    
    // Form submission
    const previewForm = container.querySelector('#previewForm');
    if (previewForm) {
      // Analytics: Track form start time
      if (this.playerMode) {
        this.previewState.formStartTime = Date.now();
        journeyAnalytics.formStarted(step.id, basicProps.fields?.length || 0);
      }
      
      previewForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const formData = new FormData(previewForm);
        const fields = basicProps.fields || [];
        const responses = {};
        const attachments = [];
        
        // Collect form responses and file attachments
        fields.forEach((field, i) => {
          if (field.type === 'file') {
            // Get file data from the upload zone
            const fileZone = container.querySelector(`.file-upload-zone[data-field-index="${i}"]`);
            if (fileZone && fileZone.dataset.fileData) {
              // Store the plain filename as the response value; the file itself
              // is uploaded separately and shared via a secure download link.
              responses[field.label] = fileZone.dataset.fileName;
              attachments.push({
                filename: fileZone.dataset.fileName,
                content: fileZone.dataset.fileData, // Base64 data URL
                contentType: fileZone.dataset.fileType,
                fieldLabel: field.label
              });
            } else {
              responses[field.label] = '';
            }
          } else {
            const value = formData.get(`field_${i}`);
            responses[field.label] = value || '';
          }
        });
        
        const totalAttachmentSize = attachments.reduce((sum, att) => {
          const base64Data = att.content.split(',')[1] || att.content;
          return sum + (base64Data.length * 0.75);
        }, 0);
        
        if (totalAttachmentSize > 24 * 1024 * 1024) {
          this.showToast(window.t('builder.form.fileUpload.totalTooLarge'), 'error');
          return;
        }
        
        // Send form data via email
        try {
          const submitBtn = previewForm.querySelector('#submitFormBtn');
          submitBtn.disabled = true;
          submitBtn.textContent = window.t('builder.preview.submitting');
          
          // Check if public mode and needs identification
          if (window.GRYFFI?.publicMode && !window.GRYFFI?.publicPlayer?.isVerified) {
            try {
              await window.GRYFFI.publicIdentify('form', 'form', step.id);
            } catch (err) {
              console.log('Public identify cancelled or failed:', err);
              submitBtn.disabled = false;
              submitBtn.textContent = window.t('builder.preview.submit');
              return;
            }
          }
          
          // Check if this is preview mode for a public journey (no real token)
          const isPublicPreview = window.GRYFFI?.publicMode && window.GRYFFI?.previewMode && !window.GRYFFI?.publicPlayer?.token;
          
          if (isPublicPreview) {
            // Simulate successful form submission in preview mode
            previewForm.classList.add('hidden');
            container.querySelector('#formSuccessMessage')?.classList.remove('hidden');
            this.trackEndStepCompletion(this.previewState.currentStep);
            this.unlockPacing();
            this.showToast(window.t('builder.preview.formSubmitted') || 'Form submitted successfully', 'success');
          } else {
            // Determine the correct endpoint
            let submitUrl;
            if (window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token) {
              submitUrl = `/p/${window.GRYFFI.publicPlayer.token}/forms/submit`;
            } else if (this.playerMode && window.GRYFFI?.player?.token) {
              submitUrl = `/e/${window.GRYFFI.player.token}/forms/submit`;
            } else {
              submitUrl = '/api/forms/submit';
            }
            
            const emailResponse = await fetch(submitUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                journey_id: this.journey.id,
                step_id: step.id,
                step_title: step.title,
                recipient_email: basicProps.recipient_email,
                email_subject: (basicProps.email_subject || 'Form submission: {{journey_title}}')
                  .replace('{{journey_title}}', this.journey.title)
                  .replace('{{step_title}}', step.title),
                attachments: attachments.length > 0 ? attachments : undefined,
                responses
              })
            });
            
            if (emailResponse.ok) {
              // Show success message
              previewForm.classList.add('hidden');
              container.querySelector('#formSuccessMessage')?.classList.remove('hidden');
              
              // Analytics: Track form submission
              if (this.playerMode) {
                const filledCount = Object.values(responses).filter(v => v && v.trim() !== '').length;
                const totalCount = basicProps.fields?.length || Object.keys(responses).length;
                const formStartTime = this.previewState.formStartTime || Date.now();
                
                journeyAnalytics.formCompleted(step.id, totalCount, filledCount);
                this.saveFormAnalytics(step.id, {
                  totalFields: totalCount,
                  filledFields: filledCount,
                  duration: Date.now() - formStartTime
                });
              }
              
              // Unlock navigation after form is submitted
              this.trackEndStepCompletion(this.previewState.currentStep);
              this.unlockPacing();
            } else {
              const errorData = await emailResponse.json().catch(() => ({}));
              if (errorData.code === 'VERIFICATION_REQUIRED') {
                // Need to verify first
                submitBtn.disabled = false;
                submitBtn.textContent = window.t('builder.preview.submit');
                this.showToast(errorData.error || 'Email verification required', 'error');
                return;
              }
              if (errorData.code === 'NSFW_CONTENT' || errorData.code === 'IMAGE_CHECK_UNAVAILABLE') {
                // Image refused by the content check: say what happened and what to do
                submitBtn.disabled = false;
                submitBtn.textContent = window.t('builder.preview.submit');
                const key = errorData.code === 'NSFW_CONTENT' ? 'player.form.imageRejected' : 'player.form.imageCheckUnavailable';
                this.showToast(window.tPlayer ? window.tPlayer(key) : (errorData.error || key), 'error');
                return;
              }
              throw new Error('Failed to submit form');
            }
          }
        } catch (error) {
          console.error('Form submission error:', error);
          this.showToast(window.t('builder.preview.formSubmitFailed'), 'error');
          const submitBtn = previewForm.querySelector('#submitFormBtn');
          submitBtn.disabled = false;
          submitBtn.textContent = window.t('builder.preview.submit');
        }
      });
    }
    
    // File upload handling for form steps
    this.bindFileUploadEvents(container);
    
    // Poll submission
    const pollContainer = container.querySelector('.journey-poll');
    const pollSubmitBtn = container.querySelector('#pollSubmitBtn');
    
    if (pollContainer && pollSubmitBtn) {
      const allowMultiple = pollContainer.dataset.allowMultiple === 'true';
      const showResults = pollContainer.dataset.showResults === 'true';
      const isRequired = pollContainer.dataset.required === 'true';
      const stepId = step.id;
      
      // Initialize poll state tracking
      if (!this.previewState.pollVotes) {
        this.previewState.pollVotes = {};
      }
      
      // Check if already voted - different logic for player mode vs preview mode
      const hasAlreadyVoted = this.previewState.pollVotes[stepId];
      
      // In player mode, check database for existing vote
      if (this.playerMode && this.player?.invitationId && !hasAlreadyVoted) {
        this.checkPlayerPollVote(stepId, pollContainer, pollSubmitBtn, basicProps, showResults, isRequired);
      } else if (hasAlreadyVoted) {
        // Preview mode - check local state
        // Already voted - show results and hide submit button
        pollSubmitBtn.style.display = 'none';
        const pollStatus = document.getElementById('pollStatus');
        if (pollStatus) {
          pollStatus.textContent = window.tPlayer('player.poll.alreadyVoted');
          pollStatus.classList.remove('hidden');
        }
        // Disable option selection
        pollContainer.querySelectorAll('.journey-poll-option').forEach(opt => {
          opt.style.pointerEvents = 'none';
        });
        // Load and show real results
        this.loadPollResults(stepId, pollContainer, basicProps.options || [], hasAlreadyVoted.selectedOptions);
      }
      
      // Option selection visual feedback
      pollContainer.querySelectorAll('.journey-poll-option').forEach(option => {
        option.addEventListener('click', () => {
          if (hasAlreadyVoted) return; // Already voted, don't allow changes
          
          const isSelected = option.classList.contains('selected');
          
          if (!allowMultiple) {
            // Single selection: deselect all others first
            pollContainer.querySelectorAll('.journey-poll-option').forEach(opt => {
              opt.classList.remove('selected');
            });
          }
          
          // Toggle this option
          if (isSelected && allowMultiple) {
            option.classList.remove('selected');
          } else {
            option.classList.add('selected');
          }
        });
      });
      
      // Submit vote
      pollSubmitBtn.addEventListener('click', async () => {
        // Get selected options via the .selected class on option elements
        const selectedOptionElements = pollContainer.querySelectorAll('.journey-poll-option.selected');
        const selectedOptions = Array.from(selectedOptionElements).map(el => parseInt(el.dataset.optionIndex));
        
        if (selectedOptions.length === 0) {
          return;
        }
        
        // Check if public mode and needs identification
        if (window.GRYFFI?.publicMode && !window.GRYFFI?.publicPlayer?.isVerified) {
          try {
            const identifyResult = await window.GRYFFI.publicIdentify('poll', 'poll', stepId);
            
            // Check if user already voted (from identification response)
            if (identifyResult && identifyResult.alreadyVoted) {
              // Show the results directly
              pollSubmitBtn.style.display = 'none';
              const pollStatus = document.getElementById('pollStatus');
              if (pollStatus) {
                pollStatus.classList.add('hidden');
              }
              pollContainer.querySelectorAll('.journey-poll-option').forEach(opt => {
                opt.style.pointerEvents = 'none';
              });
              
              // Display the results from the identification response
              const votedIndex = basicProps.options?.indexOf(identifyResult.userVote) ?? 0;
              this.previewState.pollVotes[stepId] = { selectedOptions: [votedIndex] };
              this.displayPollResults(pollContainer, basicProps.options || [], identifyResult.results, identifyResult.totalVotes, votedIndex);
              this.showToast(identifyResult.message || window.tPlayer('player.poll.alreadyVoted'), 'info');
              this.trackEndStepCompletion(this.previewState.currentStep);
              this.unlockPacing();
              return;
            }
          } catch (err) {
            console.log('Public identify cancelled or failed:', err);
            return;
          }
          
          // Check if this is preview mode (no real token)
          const isPublicPreview = window.GRYFFI?.previewMode && !window.GRYFFI?.publicPlayer?.token;
          
          if (isPublicPreview) {
            // Simulate successful poll submission in preview mode
            this.previewState.pollVotes[stepId] = { selectedOptions };
            pollSubmitBtn.style.display = 'none';
            const pollStatus = document.getElementById('pollStatus');
            if (pollStatus) {
              pollStatus.classList.add('hidden');
            }
            pollContainer.querySelectorAll('.journey-poll-option').forEach(opt => {
              opt.style.pointerEvents = 'none';
            });
            if (showResults) {
              // Show mock results for preview
              this.showMockPollResults(pollContainer, basicProps.options || [], selectedOptions);
            }
            this.trackEndStepCompletion(this.previewState.currentStep);
            this.unlockPacing();
            this.showToast(window.tPlayer('player.poll.voteRecorded') || 'Vote recorded', 'success');
          } else {
            // Submit vote for public journey
            try {
              pollSubmitBtn.disabled = true;
              pollSubmitBtn.textContent = '...';
              
              const token = window.GRYFFI.publicPlayer?.token;
              const res = await fetch(`/p/${token}/poll/${stepId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  option: basicProps.options?.[selectedOptions[0]] || selectedOptions[0]
                })
              });
              
              const data = await res.json();
              
              if (data.success) {
                // Determine which option was voted for
                const votedOption = data.userVote || basicProps.options?.[selectedOptions[0]] || selectedOptions[0];
                const votedIndex = basicProps.options?.indexOf(votedOption) ?? selectedOptions[0];
                
                this.previewState.pollVotes[stepId] = { selectedOptions: [votedIndex] };
                pollSubmitBtn.style.display = 'none';
                const pollStatus = document.getElementById('pollStatus');
                if (pollStatus) {
                  pollStatus.classList.add('hidden');
                }
                pollContainer.querySelectorAll('.journey-poll-option').forEach(opt => {
                  opt.style.pointerEvents = 'none';
                });
                
                // Show results if we have them (from backend) or load them
                if (data.results && data.totalVotes !== undefined) {
                  // Use results directly from the response
                  this.displayPollResults(pollContainer, basicProps.options || [], data.results, data.totalVotes, votedIndex);
                } else if (showResults) {
                  this.loadPollResults(stepId, pollContainer, basicProps.options || [], [votedIndex]);
                }
                
                // Show appropriate toast message
                if (data.alreadyVoted) {
                  this.showToast(data.message || window.tPlayer('player.poll.alreadyVoted'), 'info');
                } else {
                  this.showToast(data.message || window.tPlayer('player.poll.voteRecorded'), 'success');
                }
                
                this.trackEndStepCompletion(this.previewState.currentStep);
                this.unlockPacing();
              } else {
                this.showToast(data.error || 'Failed to submit vote', 'error');
                pollSubmitBtn.disabled = false;
                pollSubmitBtn.textContent = window.tPlayer('player.poll.submitVote');
              }
            } catch (error) {
              console.error('Poll submission error:', error);
              this.showToast('Failed to submit vote', 'error');
              pollSubmitBtn.disabled = false;
              pollSubmitBtn.textContent = window.tPlayer('player.poll.submitVote');
            }
          }
          return;
        }
        
        // In player mode, submit vote to database
        if (this.playerMode && this.player?.invitationId) {
          try {
            pollSubmitBtn.disabled = true;
            pollSubmitBtn.textContent = '...';
            
            const res = await fetch(`/api/polls/${stepId}/vote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                selectedOptions,
                invitationId: this.player.invitationId
              })
            });
            
            const data = await res.json();
            
            if (data.success) {
              // Mark as voted in preview state
              this.previewState.pollVotes[stepId] = { selectedOptions };
              
              // Analytics: Track poll vote
              const selectedOptionLabels = selectedOptions.map(i => basicProps.options?.[i] || i);
              journeyAnalytics.pollVoted(
                stepId, 
                basicProps.question || '', 
                selectedOptionLabels, 
                allowMultiple, 
                basicProps.options?.length || 0
              );
              
              // Hide submit button
              pollSubmitBtn.style.display = 'none';
              
              // Hide poll status message (don't show "already voted" immediately after voting)
              const pollStatus = document.getElementById('pollStatus');
              if (pollStatus) {
                pollStatus.classList.add('hidden');
              }
              
              // Disable option selection
              pollContainer.querySelectorAll('.journey-poll-option').forEach(opt => {
                opt.style.pointerEvents = 'none';
              });
              
              // Show results from API response if enabled
              if (showResults && data.votes) {
                this.showPollResultsPreview(pollContainer, data.votes, data.totalRespondents, basicProps.options || [], selectedOptions);
              }
              
              // Unlock navigation
              this.trackEndStepCompletion(this.previewState.currentStep);
              this.unlockPacing();
            } else if (data.alreadyVoted) {
              // Already voted - show message
              pollSubmitBtn.style.display = 'none';
              const pollStatus = document.getElementById('pollStatus');
              if (pollStatus) {
                pollStatus.textContent = window.tPlayer('player.poll.alreadyVoted');
                pollStatus.classList.remove('hidden');
              }
              this.trackEndStepCompletion(this.previewState.currentStep);
              this.unlockPacing();
            } else {
              console.error('Poll vote error:', data.error);
              pollSubmitBtn.disabled = false;
              pollSubmitBtn.textContent = window.tPlayer('player.poll.submitVote');
            }
          } catch (err) {
            console.error('Poll vote error:', err);
            pollSubmitBtn.disabled = false;
            pollSubmitBtn.textContent = window.tPlayer('player.poll.submitVote');
          }
        } else {
          // Preview mode (not player) - store locally only
          this.previewState.pollVotes[stepId] = { selectedOptions };
          
          // Hide submit button completely
          pollSubmitBtn.style.display = 'none';
          
          // Hide poll status message (don't show "already voted" immediately after voting)
          const pollStatus = document.getElementById('pollStatus');
          if (pollStatus) {
            pollStatus.classList.add('hidden');
          }
          
          // Disable option selection
          pollContainer.querySelectorAll('.journey-poll-option').forEach(opt => {
            opt.style.pointerEvents = 'none';
          });
          
          // Show simulated results from database if enabled
          if (showResults) {
            await this.loadPollResults(stepId, pollContainer, basicProps.options || [], selectedOptions);
          }
          
          // Unlock navigation
          this.trackEndStepCompletion(this.previewState.currentStep);
          this.unlockPacing();
        }
      });
      
      // If poll is required and not yet voted, keep navigation locked
      // Navigation is unlocked by unlockPacing() after voting
    }
    
    // Reward claiming
    const rewardContainer = container.querySelector('.journey-reward');
    const downloadRewardPdfBtn = container.querySelector('#downloadRewardPdfBtn');
    
    // Auto-claim reward when step is reached (player mode or public journey)
    const isPrivatePlayer = this.playerMode && this.player?.token;
    const isPublicPlayer = window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token;
    
    if (rewardContainer && (isPrivatePlayer || isPublicPlayer)) {
      // For public journeys, we need to identify first, then claim
      this.claimReward(step.id, rewardContainer, basicProps);
    }
    
    // Download reward PDF button
    if (downloadRewardPdfBtn) {
      downloadRewardPdfBtn.addEventListener('click', async () => {
        const code = document.getElementById('rewardCode')?.textContent || 'CODE';
        await this.downloadRewardPDF(code, basicProps);
      });
    }
    
    // Guide chat
    const chatInput = container.querySelector('#chatInput');
    const sendBtn = container.querySelector('#sendChatBtn');
    
    if (chatInput && sendBtn) {
      // Get the central guide for this step
      const centralGuide = this.guides.find(g => g.id === basicProps.guide_id);
      
      // Use unified guide chat history (shared with Step Assistant)
      // This ensures the guide remembers conversations from earlier in the journey
      const getGuideHistory = () => {
        if (!centralGuide) return [];
        return this.previewState.guideChatHistories[centralGuide.id] || [];
      };
      
      const addToGuideHistory = (message) => {
        if (!centralGuide) return;
        if (!this.previewState.guideChatHistories[centralGuide.id]) {
          this.previewState.guideChatHistories[centralGuide.id] = [];
        }
        this.previewState.guideChatHistories[centralGuide.id].push(message);
      };
      
      // Render existing chat history in the UI
      const renderExistingHistory = () => {
        const messagesContainer = container.querySelector('#chatMessages');
        const openingElement = container.querySelector('#guideOpening');
        const history = getGuideHistory();
        
        if (history.length > 0) {
          // Hide the opening element since we have history
          if (openingElement) openingElement.style.display = 'none';
          
          // Render all messages from history
          messagesContainer.innerHTML = history.map(msg => {
            if (msg.role === 'user') {
              return `<div class="chat-message user">${this.escapeHtml(msg.content)}</div>`;
            } else {
              const parsedContent = this.parseCitations(msg.content, msg.citations || [], msg.citationSources || []);
              return `<div class="chat-message guide">${parsedContent}</div>`;
            }
          }).join('');
          
          // Attach citation click handlers with full history
          messagesContainer.querySelectorAll('.citation-badge').forEach(badge => {
            badge.addEventListener('click', (e) => {
              e.preventDefault();
              const chunkId = badge.dataset.chunkId;
              const msgEl = badge.closest('.guide-chat-message');
              const msgText = msgEl ? msgEl.textContent : '';
              const bIdx = msgText.indexOf('Bron');
              const ctxStart = Math.max(0, bIdx - 100);
              const ctx = bIdx >= 0 ? msgText.substring(ctxStart, bIdx).trim() : '';
              this.openSourceDrawer(chunkId, history, ctx);
            });
          });
          
          console.log('[Guide Step] Rendered existing history with', history.length, 'messages for guide:', centralGuide.id);
          return true;
        }
        return false;
      };
      
      // Generate AI opening greeting (only if no history exists)
      const generateOpening = async () => {
        const openingElement = container.querySelector('#guideOpening');
          
        // If no guide selected, show a fallback message
        if (!centralGuide) {
          openingElement.classList.remove('typing');
          openingElement.innerHTML = window.tPlayer ? window.tPlayer('player.chat.selectGuideForStep') : window.t('builder.preview.selectGuideForStep');
          return;
        }
        
        // Check if we already have history for this guide
        if (renderExistingHistory()) {
          // Enable chat input - we have existing conversation
          chatInput.disabled = false;
          sendBtn.disabled = false;
          chatInput.focus();
          return;
        }
        
        try {
          const guideLanguage = window.GRYFFI?.guideLanguage || window.GRYFFI?.journeyLanguage || 'en';
          const orgDefaultLanguage = window.GRYFFI?.organization?.defaultLanguage || 'en';
          const fallback = centralGuide.greeting || (window.tPlayer ? window.tPlayer('player.chat.defaultGreeting') : window.t('builder.preview.defaultGreeting'));
          
          // Check if there's a static opening override (from copy-translate or manual entry)
          const guideOpeningOverride = this.journey?.guide_opening_override || window.GRYFFI?.guideOpeningOverride;
          
          if (guideOpeningOverride) {
            // Use the static translated opening - fastest option
            console.log('[Guide Step] Using static opening override');
            openingElement.classList.remove('typing');
            openingElement.textContent = guideOpeningOverride;
            addToGuideHistory({
              role: 'assistant',
              content: guideOpeningOverride
            });
            console.log('[Guide Step] Initialized new history with static opening override for guide:', centralGuide.id);
            chatInput.disabled = false;
            sendBtn.disabled = false;
            chatInput.focus();
            return;
          }
          
          // Generate dynamic opening if language is overridden (different from org default)
          const needsDynamicOpening = guideLanguage !== orgDefaultLanguage;
          
          if (needsDynamicOpening) {
            // Determine the opening endpoint based on mode
            let openingEndpoint;
            const requestBody = {
              guide_id: centralGuide.id,
              guide_language: guideLanguage,
              journey_context: `Journey: ${this.journey?.title || ''}`
            };
            
            if (window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token) {
              openingEndpoint = `/p/${window.GRYFFI.publicPlayer.token}/guide/opening`;
            } else if (this.player?.token) {
              openingEndpoint = `/e/${this.player.token}/guide/opening`;
            } else {
              // Builder preview or fullscreen preview without magic link - use API endpoint
              openingEndpoint = '/api/guide/opening';
            }
            
            if (openingEndpoint) {
              try {
                console.log('[Guide Step] Generating dynamic opening in', guideLanguage, 'via', openingEndpoint);
                const response = await fetch(openingEndpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'same-origin',
                  body: JSON.stringify(requestBody)
                });
                
                if (response.ok) {
                  const data = await response.json();
                  if (data.success && data.opening) {
                    openingElement.classList.remove('typing');
                    // AI output: escape, then apply the same light markdown as other guide messages
                    openingElement.innerHTML = this.parseMarkdown(this.escapeHtml(data.opening));
                    addToGuideHistory({
                      role: 'assistant',
                      content: data.opening
                    });
                    
                    // Update guide role with translated version if available
                    if (data.guide?.role) {
                      const roleElement = container.querySelector('.text-zen-500');
                      if (roleElement && roleElement.textContent !== data.guide.role) {
                        roleElement.textContent = data.guide.role;
                        console.log('[Guide Step] Updated role to translated version:', data.guide.role);
                      }
                    }
                    
                    console.log('[Guide Step] Generated dynamic opening in', guideLanguage, 'for guide:', centralGuide.id);
                    chatInput.disabled = false;
                    sendBtn.disabled = false;
                    chatInput.focus();
                    return;
                  }
                }
              } catch (fetchErr) {
                console.warn('[Guide Step] Dynamic opening generation failed, using fallback:', fetchErr.message);
              }
            }
          }
          
          // Use the guide's stored greeting as fallback
          openingElement.classList.remove('typing');
          openingElement.innerHTML = this.parseMarkdown(this.escapeHtml(fallback));
          addToGuideHistory({
            role: 'assistant',
            content: fallback
          });
          console.log('[Guide Step] Initialized new history with greeting for guide:', centralGuide.id);
          
          // Enable chat input
          chatInput.disabled = false;
          sendBtn.disabled = false;
          chatInput.focus();
          
        } catch (err) {
          console.error('Failed to generate opening:', err);
          const fallback = centralGuide?.greeting || (window.tPlayer ? window.tPlayer('player.chat.defaultGreeting') : window.t('builder.preview.defaultGreeting'));
          openingElement.classList.remove('typing');
          openingElement.innerHTML = this.parseMarkdown(this.escapeHtml(fallback));
          addToGuideHistory({
            role: 'assistant',
            content: fallback
          });
          chatInput.disabled = false;
          sendBtn.disabled = false;
        }
      };
      
      // Start generating opening immediately
      generateOpening();
      
      const sendMessage = async () => {
        const message = chatInput.value.trim();
        if (!message || !centralGuide) return;
        
        // Analytics: Track user message sent
        if (this.playerMode) {
          journeyAnalytics.guideChatMessageSent(centralGuide.id, step.id, message, true);
        }
        
        // Add user message to unified history first
        addToGuideHistory({ role: 'user', content: message });
        
        // Add user message to UI
        const messagesContainer = container.querySelector('#chatMessages');
        messagesContainer.innerHTML += `<div class="chat-message user">${this.escapeHtml(message)}</div>`;
        chatInput.value = '';
        
        // Show typing indicator
        messagesContainer.innerHTML += `<div class="chat-message guide typing"><span class="typing-dots"><span></span><span></span><span></span></span></div>`;
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
        // Call AI using the central guide chat endpoint
        try {
          // Build conversation history as JSON array (unified with Step Assistant)
          const guideHistory = getGuideHistory();
          const conversationMessages = guideHistory
            .slice(-10) // Last 10 messages for better context
            .map(m => ({
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.content
            }));
          
          console.log('[Guide Step] Sending conversation with', conversationMessages.length, 'history messages for guide:', centralGuide.id);
          
          // Use different endpoint for player mode
          let chatEndpoint;
          if (window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token) {
            chatEndpoint = `/p/${window.GRYFFI.publicPlayer.token}/guide/chat`;
          } else if (this.playerMode && this.player?.token) {
            chatEndpoint = `/e/${this.player.token}/chat/guide`;
          } else {
            chatEndpoint = '/api/chat/guide';
          }
          
          // Build detailed step context using the same method as Step Assistant
          const detailedStepContext = this.buildDetailedStepContext(step);
          
          const response = await fetch(chatEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              guide_id: centralGuide.id,
              journey_id: this.journey.id,
              step_context: detailedStepContext,
              message: message,
              conversation_history: conversationMessages, // Send as JSON array
              guide_language: window.GRYFFI?.guideLanguage || window.GRYFFI?.journeyLanguage || 'en'
            })
          });
          
          const data = await response.json();
          
          // Remove typing indicator
          container.querySelector('.typing')?.remove();
          
          // The guide cannot answer (no AI questions left this month): say so calmly
          // and let the end user continue instead of waiting for messages
          if (data.code === 'AI_UNAVAILABLE') {
            messagesContainer.innerHTML += `<div class="chat-message guide">${this.escapeHtml(window.tPlayer('player.chat.guideUnavailable'))}</div>`;
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            this.unlockPacing();
            return;
          }
          
          // Add response with citations
          const responseText = data.response || window.tPlayer('player.chat.chatError');
          const parsedResponse = this.parseCitations(responseText, data.citations || [], data.citationSources || []);
          messagesContainer.innerHTML += `<div class="chat-message guide">${parsedResponse}</div>`;
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
          
          // Save AI response to unified history first
          addToGuideHistory({ 
            role: 'assistant', 
            content: responseText,
            citations: data.citations || [],
            citationSources: data.citationSources || []
          });
          
          // Analytics: Track guide response received
          if (this.playerMode) {
            journeyAnalytics.guideChatResponseReceived(
              centralGuide.id, 
              step.id, 
              responseText,
              data.citations && data.citations.length > 0,
              data.citations?.length || 0
            );
          }
          
          // Re-attach citation click handlers with full history
          const fullHistory = getGuideHistory();
          messagesContainer.querySelectorAll('.citation-badge').forEach(badge => {
            badge.addEventListener('click', (e) => {
              e.preventDefault();
              const chunkId = badge.dataset.chunkId;
              const msgEl = badge.closest('.guide-chat-message');
              const msgText = msgEl ? msgEl.textContent : '';
              const bIdx = msgText.indexOf('Bron');
              const ctxStart = Math.max(0, bIdx - 100);
              const ctx = bIdx >= 0 ? msgText.substring(ctxStart, bIdx).trim() : '';
              this.openSourceDrawer(chunkId, fullHistory, ctx);
            });
          });
          
          // Update message pacing if applicable
          const guidePacing = advancedProps.pacing || 'immediately';
          if (guidePacing.startsWith('messages_')) {
            const requiredMessages = parseInt(guidePacing.split('_')[1]);
            this.updateMessagePacing(requiredMessages);
          }
          
        } catch (_err) {
          container.querySelector('.typing')?.remove();
          messagesContainer.innerHTML += `<div class="chat-message guide">${window.tPlayer('player.chat.connectionError')}</div>`;
          // A failed message would never count towards "chat N messages": do not keep the end user waiting
          this.unlockPacing();
        }
      };
      
      sendBtn.addEventListener('click', sendMessage);
      chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !chatInput.disabled) sendMessage();
      });
      
      // Show continue options after greeting for guide
      if (paths.length > 0) {
        const guidePacing = advancedProps.pacing || 'immediately';
        const pacingInfo = this.getPacingInfo(guidePacing, 'guide', null);
        
        const optionsHtml = `
          <div class="preview-options mt-4" id="previewNavigation">
            <!-- Pacing indicator for guide -->
            <div class="pacing-indicator ${guidePacing === 'immediately' ? 'hidden' : ''}" id="pacingIndicator">
              <svg class="w-4 h-4 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
              </svg>
              <span class="text-sm text-zen-500" id="pacingMessage">${escapeHtml(pacingInfo.message)}</span>
            </div>
            
            <div class="preview-nav-buttons ${guidePacing === 'immediately' ? '' : 'hidden'}" id="navButtons">
              <p class="text-sm text-zen-500 mb-2">${window.tPlayer('player.navigation.whenReady')}</p>
            ${paths.map(p => `
              <button class="preview-option" data-path="${p.id}" data-target="${p.to_step_id}">
                <svg class="w-5 h-5 text-gryffi-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"></path>
                </svg>
                <span class="flex-1">${escapeHtml(p.label)}</span>
              </button>
            `).join('')}
            </div>
          </div>
        `;
        container.querySelector('.preview-chat').insertAdjacentHTML('afterend', optionsHtml);
        
        container.querySelectorAll('.preview-option').forEach(btn => {
          btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const pathId = btn.dataset.path;
            const targetStep = this.steps.find(s => s.id === targetId);
            if (targetStep) {
              // Clear pacing timer if any
              if (this.previewState.pacingTimer) {
                clearInterval(this.previewState.pacingTimer);
              }
              
              // Analytics: Track step completion with duration
              if (this.playerMode) {
                journeyAnalytics.stepCompleted(step.id, step.type);
              }
              
              // Trigger automations for completing current step
              this.triggerAutomation('on_step_complete', step.id);
              if (pathId) {
                this.triggerAutomation(`on_path:${pathId}`, step.id, pathId);
              }
              
              // Add current step to visited (avoid duplicates)
              if (!this.previewState.visitedSteps.includes(step.id)) {
                this.previewState.visitedSteps.push(step.id);
              }
              // Also add target step as visited
              if (!this.previewState.visitedSteps.includes(targetStep.id)) {
                this.previewState.visitedSteps.push(targetStep.id);
              }
              this.previewState.currentStep = targetStep;
              this.previewState.chatHistory = [];
              this.previewState.messageCount = 0;
              this.previewState.pacingUnlocked = false;
              this.previewState.quizPassed = false;
              this.previewState.videoCompleted = false;
              this.previewState._endStepCompleted = false;
              
              // Analytics: Track step entry for new step
              if (this.playerMode) {
                journeyAnalytics.stepEntered(targetStep.id, targetStep.type);
              }
              
              this.renderPreview();
              
              // Update guide chat for the new step
              this.updateGuideChatForStep(targetStep);
              
              // Trigger automations for entering new step
              this.triggerAutomation('on_step_enter', targetStep.id);
              
              // Update progress bar (both player mode and builder preview)
              this.updatePlayerProgress();
              
              // PLAYER MODE: Save progress
              if (this.playerMode) {
                this.savePlayerProgress();
              }
              
              // Check if this is an end step
              if (targetStep.is_end) {
                this.triggerAutomation('on_journey_complete', targetStep.id);
                // PLAYER MODE: Mark journey as completed
                if (this.playerMode) {
                  this.previewState._endStepCompleted = false;
                  if (this.isEndStepAutoComplete(targetStep)) {
                    this.trackEndStepCompletion(targetStep);
                  }
                  this.completePlayerJourney();
                }
              }
            }
          });
        });
      }
    }
  }
  
  renderMarkdown(text) {
    // Simple markdown rendering
    return text
      .replace(/^### (.*$)/gm, '<h3 class="text-lg font-semibold mt-4 mb-2">$1</h3>')
      .replace(/^## (.*$)/gm, '<h2 class="text-xl font-bold mt-4 mb-2">$1</h2>')
      .replace(/^# (.*$)/gm, '<h1 class="text-2xl font-bold mt-4 mb-2">$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^- (.*$)/gm, '<li class="ml-4">$1</li>')
      .replace(/\n\n/g, '</p><p class="mt-2">')
      .replace(/\n/g, '<br>');
  }
  
  // ============================================
  // RESOURCES
  // ============================================
  
  openResourcesModal() {
    this.renderResourcesList();
    document.getElementById('resourcesModal').classList.remove('hidden');
  }
  
  closeResourcesModal() {
    document.getElementById('resourcesModal').classList.add('hidden');
  }
  
  renderResourcesList() {
    const container = document.getElementById('resourcesList');
    
    if (this.resources.length === 0) {
      container.innerHTML = `<p class="text-zen-500 text-center py-4">No resources yet</p>`;
      return;
    }
    
    container.innerHTML = this.resources.map(r => `
      <div class="flex items-center gap-3 p-3 bg-zen-50 rounded-lg">
        <div class="w-10 h-10 rounded-lg bg-white flex items-center justify-center">
          ${this.getResourceIcon(r.icon)}
        </div>
        <div class="flex-1">
          <div class="font-medium text-zen-900">${escapeHtml(r.name)}</div>
          <div class="text-xs text-zen-500">${escapeHtml(r.type)}</div>
        </div>
        ${this.readOnly ? '' : `
          <button class="text-red-500 hover:text-red-700 p-1" onclick="builder.deleteResource('${r.id}')">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        `}
      </div>
    `).join('');
  }
  
  async addResource() {
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    const name = await window.gryffi.modal.prompt(window.t('builder.messages.enterResourceName') || 'Resource name:');
    if (!name) return;
    
    try {
      const response = await fetch('/api/resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journey_id: this.journey.id,
          name: name,
          type: 'document',
          icon: 'file'
        })
      });
      
      const data = await response.json();
      if (data.success) {
        this.resources.push(data.resource);
        this.renderResourcesList();
        this.commitHistoryNow('addResource');
      }
    } catch (err) {
      console.error('Failed to add resource:', err);
    }
  }
  
  async deleteResource(id) {
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    if (!await window.gryffi.modal.confirm(window.t('builder.messages.deleteResourceConfirm'))) return;
    return this.deleteResourceById(id, { confirmPrompt: false });
  }

  async deleteResourceById(id, { confirmPrompt = false } = {}) {
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    if (confirmPrompt && !await window.gryffi.modal.confirm(window.t('builder.messages.deleteResourceConfirm'))) return;
    try {
      await fetch(`/api/resources/${id}`, { method: 'DELETE' });
      this.resources = this.resources.filter(r => r.id !== id);
      this.renderResourcesList();
      this.commitHistoryNow('deleteResource');
    } catch (err) {
      console.error('Failed to delete resource:', err);
    }
  }

  // ============================================
  // UNDO / REDO (Snapshot history)
  // ============================================

  initHistory() {
    if (this.readOnly) {
      this.updateUndoRedoUI();
      return;
    }
    const snap = this.captureSnapshot();
    this.history.past = [snap];
    this.history.future = [];
    this.updateUndoRedoUI();
    this.updateUndoRedoTitles();
  }

  safeT(key, fallback) {
    const v = window.t(key);
    if (typeof v === 'string' && v !== key) return v;
    return fallback;
  }

  updateUndoRedoTitles() {
    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
    const undoShortcut = isMac ? '⌘Z' : 'Ctrl+Z';
    const redoShortcut = isMac ? '⇧⌘Z' : 'Ctrl+Y';
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    if (undoBtn) undoBtn.title = `${this.safeT('builder.toolbar.undo', 'Undo')} (${undoShortcut})`;
    if (redoBtn) redoBtn.title = `${this.safeT('builder.toolbar.redo', 'Redo')} (${redoShortcut})`;
  }

  updateUndoRedoUI() {
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    const canUndo = this.history.past.length > 1 && !this.isUndoRedoInFlight && !this.readOnly;
    const canRedo = this.history.future.length > 0 && !this.isUndoRedoInFlight && !this.readOnly;
    if (undoBtn) {
      undoBtn.disabled = !canUndo;
      undoBtn.classList.toggle('opacity-40', !canUndo);
      undoBtn.classList.toggle('cursor-not-allowed', !canUndo);
    }
    if (redoBtn) {
      redoBtn.disabled = !canRedo;
      redoBtn.classList.toggle('opacity-40', !canRedo);
      redoBtn.classList.toggle('cursor-not-allowed', !canRedo);
    }
  }

  scheduleHistoryCommit(key) {
    if (this.readOnly || this.isApplyingHistory) return;
    // Any new change invalidates redo stack
    this.history.future = [];
    this.updateUndoRedoUI();

    const existing = this.history.commitTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.history.commitTimers.delete(key);
      this.commitHistoryNow(key);
    }, 650);
    this.history.commitTimers.set(key, timer);
  }

  commitHistoryNow(_reason = 'change') {
    if (this.readOnly || this.isApplyingHistory) return;
    // Any new change invalidates redo stack
    this.history.future = [];

    const snap = this.captureSnapshot();
    const last = this.history.past[this.history.past.length - 1];
    if (last && this.snapshotsEqual(last, snap)) {
      this.updateUndoRedoUI();
      return;
    }
    this.history.past.push(snap);
    if (this.history.past.length > this.history.max) {
      this.history.past.shift();
    }
    this.updateUndoRedoUI();
  }

  snapshotsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  normalizeJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return fallback; }
    }
    return fallback;
  }

  captureSnapshot() {
    const journey = {
      id: this.journey.id,
      title: this.journey.title,
      description: this.journey.description,
      status: this.journey.status,
      automations: this.journey.automations || [],
      welcome_message: this.journey.welcome_message || '',
      completion_message: this.journey.completion_message || '',
      allow_skip: !!this.journey.allow_skip,
      track_progress: this.journey.track_progress !== false
    };

    const steps = (this.steps || []).map(s => ({
      id: s.id,
      journey_id: s.journey_id || this.journey.id,
      type: s.type,
      title: s.title,
      position_x: s.position_x,
      position_y: s.position_y,
      is_start: !!s.is_start,
      is_end: !!s.is_end,
      basic_props: this.normalizeJson(s.basic_props, {}),
      advanced_props: this.normalizeJson(s.advanced_props, {})
    })).sort((a, b) => (a.id || '').localeCompare(b.id || ''));

    const paths = (this.paths || []).map(p => ({
      id: p.id,
      journey_id: p.journey_id || this.journey.id,
      from_step_id: p.from_step_id,
      to_step_id: p.to_step_id,
      label: p.label,
      description: p.description,
      icon: p.icon,
      requires_resource_id: p.requires_resource_id,
      condition: this.normalizeJson(p.condition, {}),
      sort_order: p.sort_order || 0
    })).sort((a, b) => (a.id || '').localeCompare(b.id || ''));

    const resources = (this.resources || []).map(r => ({
      id: r.id,
      journey_id: r.journey_id || this.journey.id,
      name: r.name,
      description: r.description,
      icon: r.icon,
      type: r.type,
      content: this.normalizeJson(r.content, {})
    })).sort((a, b) => (a.id || '').localeCompare(b.id || ''));

    return { journey, steps, paths, resources };
  }

  async undo() {
    if (this.readOnly) return;
    if (this.isUndoRedoInFlight) return;
    if (this.history.past.length <= 1) return;

    // Flush pending commits before undo so we don't "lose" latest edits
    for (const timer of this.history.commitTimers.values()) clearTimeout(timer);
    this.history.commitTimers.clear();

    this.isUndoRedoInFlight = true;
    this.updateUndoRedoUI();

    const current = this.history.past.pop();
    this.history.future.push(current);
    const target = this.history.past[this.history.past.length - 1];
    await this.applySnapshot(target);

    this.isUndoRedoInFlight = false;
    this.updateUndoRedoUI();
  }

  async redo() {
    if (this.readOnly) return;
    if (this.isUndoRedoInFlight) return;
    if (this.history.future.length === 0) return;

    for (const timer of this.history.commitTimers.values()) clearTimeout(timer);
    this.history.commitTimers.clear();

    this.isUndoRedoInFlight = true;
    this.updateUndoRedoUI();

    const target = this.history.future.pop();
    this.history.past.push(target);
    await this.applySnapshot(target);

    this.isUndoRedoInFlight = false;
    this.updateUndoRedoUI();
  }

  async applySnapshot(target) {
    this.isApplyingHistory = true;
    try {
      await this.reconcileToSnapshot(target);

      // Apply locally (source of truth for UI)
      this.journey = { ...this.journey, ...target.journey };
      this.steps = target.steps.map(s => ({ ...s, basic_props: s.basic_props, advanced_props: s.advanced_props }));
      this.paths = target.paths.map(p => ({ ...p, condition: p.condition }));
      this.resources = target.resources.map(r => ({ ...r, content: r.content }));

      this.selectedStep = null;
      this.closeProperties();
      this.render();
      this.drawConnections();
    } catch (err) {
      console.error('Undo/redo apply failed:', err);
      this.showToast(window.t('builder.messages.undoRedoFailed'), 'error');
    } finally {
      this.isApplyingHistory = false;
    }
  }

  async reconcileToSnapshot(target) {
    const currentSteps = new Map((this.steps || []).map(s => [s.id, s]));
    const targetSteps = new Map((target.steps || []).map(s => [s.id, s]));
    const currentPaths = new Map((this.paths || []).map(p => [p.id, p]));
    const targetPaths = new Map((target.paths || []).map(p => [p.id, p]));
    const currentResources = new Map((this.resources || []).map(r => [r.id, r]));
    const targetResources = new Map((target.resources || []).map(r => [r.id, r]));

    // 1) Create missing resources (needed for paths/steps referencing them)
    for (const [id, r] of targetResources.entries()) {
      if (!currentResources.has(id)) {
        const res = await fetch('/api/resources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: r.id,
            journey_id: this.journey.id,
            name: r.name,
            description: r.description,
            icon: r.icon,
            type: r.type,
            content: r.content
          })
        });
        if (!res.ok) throw new Error('Failed to restore resource');
      }
    }

    // 2) Create missing steps
    for (const [id, s] of targetSteps.entries()) {
      if (!currentSteps.has(id)) {
        const res = await fetch('/api/steps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: s.id,
            journey_id: this.journey.id,
            type: s.type,
            title: s.title,
            position_x: s.position_x,
            position_y: s.position_y,
            is_start: s.is_start,
            is_end: s.is_end,
            basic_props: s.basic_props,
            advanced_props: s.advanced_props
          })
        });
        if (!res.ok) throw new Error('Failed to restore step');
      }
    }

    // 3) Update steps that changed
    for (const [id, s] of targetSteps.entries()) {
      if (!currentSteps.has(id)) continue;
      const cur = currentSteps.get(id);
      const curNorm = {
        id: cur.id,
        type: cur.type,
        title: cur.title,
        position_x: cur.position_x,
        position_y: cur.position_y,
        is_start: !!cur.is_start,
        is_end: !!cur.is_end,
        basic_props: this.normalizeJson(cur.basic_props, {}),
        advanced_props: this.normalizeJson(cur.advanced_props, {})
      };
      const tgtNorm = {
        id: s.id,
        type: s.type,
        title: s.title,
        position_x: s.position_x,
        position_y: s.position_y,
        is_start: !!s.is_start,
        is_end: !!s.is_end,
        basic_props: s.basic_props,
        advanced_props: s.advanced_props
      };
      if (JSON.stringify(curNorm) !== JSON.stringify(tgtNorm)) {
        const res = await fetch(`/api/steps/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: s.type,
            title: s.title,
            position_x: s.position_x,
            position_y: s.position_y,
            is_start: s.is_start,
            is_end: s.is_end,
            basic_props: s.basic_props,
            advanced_props: s.advanced_props
          })
        });
        if (!res.ok) throw new Error('Failed to update step');
      }
    }

    // 4) Create missing paths
    for (const [id, p] of targetPaths.entries()) {
      if (!currentPaths.has(id)) {
        const res = await fetch('/api/paths', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: p.id,
            journey_id: this.journey.id,
            from_step_id: p.from_step_id,
            to_step_id: p.to_step_id,
            label: p.label,
            description: p.description,
            icon: p.icon,
            requires_resource_id: p.requires_resource_id,
            condition: p.condition,
            sort_order: p.sort_order || 0
          })
        });
        if (!res.ok) throw new Error('Failed to restore path');
      }
    }

    // 5) Update paths that changed
    for (const [id, p] of targetPaths.entries()) {
      if (!currentPaths.has(id)) continue;
      const cur = currentPaths.get(id);
      const curNorm = {
        id: cur.id,
        from_step_id: cur.from_step_id,
        to_step_id: cur.to_step_id,
        label: cur.label,
        description: cur.description,
        icon: cur.icon,
        requires_resource_id: cur.requires_resource_id,
        condition: this.normalizeJson(cur.condition, {}),
        sort_order: cur.sort_order || 0
      };
      const tgtNorm = {
        id: p.id,
        from_step_id: p.from_step_id,
        to_step_id: p.to_step_id,
        label: p.label,
        description: p.description,
        icon: p.icon,
        requires_resource_id: p.requires_resource_id,
        condition: p.condition,
        sort_order: p.sort_order || 0
      };
      if (JSON.stringify(curNorm) !== JSON.stringify(tgtNorm)) {
        const res = await fetch(`/api/paths/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: p.label,
            description: p.description,
            icon: p.icon,
            requires_resource_id: p.requires_resource_id,
            condition: p.condition,
            sort_order: p.sort_order || 0
          })
        });
        if (!res.ok) throw new Error('Failed to update path');
      }
    }

    // 6) Delete extra paths (before deleting steps)
    for (const [id] of currentPaths.entries()) {
      if (!targetPaths.has(id)) {
        const res = await fetch(`/api/paths/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete path');
      }
    }

    // 7) Delete extra steps
    for (const [id] of currentSteps.entries()) {
      if (!targetSteps.has(id)) {
        const res = await fetch(`/api/steps/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete step');
      }
    }

    // 8) Delete extra resources
    for (const [id] of currentResources.entries()) {
      if (!targetResources.has(id)) {
        const res = await fetch(`/api/resources/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete resource');
      }
    }

    // 9) Journey settings
    const curJourney = this.captureSnapshot().journey;
    if (JSON.stringify(curJourney) !== JSON.stringify(target.journey)) {
      const res = await fetch(`/api/journeys/${this.journey.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: target.journey.title,
          description: target.journey.description,
          status: target.journey.status,
          automations: target.journey.automations,
          welcome_message: target.journey.welcome_message,
          completion_message: target.journey.completion_message,
          allow_skip: target.journey.allow_skip,
          track_progress: target.journey.track_progress
        })
      });
      if (!res.ok) throw new Error('Failed to update journey');
    }
  }
  
  // ============================================
  // HELPERS
  // ============================================
  
  setZoom(level) {
    this.zoom = Math.max(0.25, Math.min(2, level));
    this.updateCanvasTransform();
    document.getElementById('zoomLevel').textContent = `${Math.round(this.zoom * 100)}%`;
  }
  
  updateCanvasTransform() {
    this.canvas.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
  }
  
  getNewStepPosition() {
    const offset = this.steps.length * 50;
    return {
      x: 200 + offset,
      y: 150 + (offset % 200)
    };
  }
  
  getDefaultTitle(type) {
    const titles = { 
      space: window.t('builder.defaults.newSpace'), 
      guide: window.t('builder.defaults.newGuide'), 
      content: window.t('builder.defaults.newContent'), 
      challenge: window.t('builder.defaults.newChallenge'), 
      form: window.t('builder.defaults.newForm'),
      reward: window.t('builder.defaults.newReward')
    };
    return titles[type] || window.t('builder.defaults.newStep');
  }
  
  getDefaultBasicProps(type) {
    const t = (key) => {
      if (typeof window.t === 'function') {
        const translated = window.t(key);
        return translated !== key ? translated : key;
      }
      if (window.GRYFFI?.translations) {
        const keys = key.split('.');
        let value = window.GRYFFI.translations;
        for (const k of keys) {
          value = value?.[k];
          if (value === undefined) break;
        }
        return value || key;
      }
      return key;
    };

    const defaults = {
      space: { 
        description: '', 
        image_url: null 
      },
      guide: { 
        guide_id: null, 
        name: t('builder.defaults.guideName'), 
        role: t('builder.defaults.guideRole'), 
        greeting: t('builder.defaults.guideGreeting'), 
        personality: 'friendly' 
      },
      content: { 
        body: '', 
        media_type: 'text', 
        video_url: '', 
        image_url: '' 
      },
      challenge: { 
        type: 'multiple_choice',
        questions: [{
          id: crypto.randomUUID(),
          question: '', 
          options: [
            { id: 'a', text: t('builder.defaults.challengeOptionA'), correct: false }, 
            { id: 'b', text: t('builder.defaults.challengeOptionB'), correct: true }
          ]
        }]
      },
      form: { 
        description: '', // Empty so HTML placeholder is visible
        recipient_email: '', 
        email_subject: t('builder.defaults.formEmailSubject'),
        fields: [{ 
          id: crypto.randomUUID(), 
          label: '', // Empty so HTML placeholder is visible
          type: 'text', 
          required: true, 
          options: '' 
        }]
      },
      reward: {
        title: '',
        description: '',
        redemption_location: '',
        terms_conditions: '',
        valid_until: null,
        is_random_codes: true,
        max_recipients: null,
        code_prefix: '',
        manual_codes: ''
      },
      nested_journey: {
        nested_journey_id: null
      }
    };
    return defaults[type] || {};
  }
  
  getStepIcon(type) {
    const icons = {
      space: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>',
      guide: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>',
      content: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>',
      challenge: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"></path></svg>',
      form: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>',
      poll: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>',
      reward: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"></path></svg>',
      nested_journey: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 10v2a2 2 0 002 2h2m6-4v-2a2 2 0 00-2-2h-2"></path></svg>'
    };
    return icons[type] || icons.content;
  }
  
  getStepTypeLabel(type) {
    const labels = { 
      space: window.t('builder.stepTypes.space'), 
      guide: window.t('builder.stepTypes.aiGuide'), 
      content: window.t('builder.stepTypes.content'), 
      challenge: window.t('builder.stepTypes.challenge'), 
      form: window.t('builder.stepTypes.form'),
      poll: window.t('builder.stepTypes.poll'),
      reward: window.t('builder.stepTypes.reward'),
      nested_journey: window.t('builder.stepTypes.nestedJourney')
    };
    return labels[type] || window.t('builder.stepTypes.step');
  }
  
  escapeHtml(text) {
    // Delegate to the global helper: it also escapes quotes, so the result is
    // safe inside attribute values too.
    return escapeHtml(text);
  }
  
  renderPollOptionEditor(option, index) {
    return `
      <div class="poll-option-item flex items-center gap-2 p-2 bg-zen-50 rounded-lg" data-option-id="${option.id}" data-option-index="${index}">
        <span class="text-xs text-zen-400 w-5">${index + 1}.</span>
        <input type="text" class="poll-option-input form-input text-sm flex-1" value="${this.escapeHtml(option.text || '')}" placeholder="${window.t('builder.poll.optionPlaceholder')}" />
        <button type="button" class="remove-poll-option-btn text-zen-400 hover:text-red-500 p-1" title="${window.t('builder.poll.removeOption')}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    `;
  }
  
  renderFormFieldEditor(field, index) {
    const isSelect = field.type === 'select';
    const isFile = field.type === 'file';
    // Parse options: support both comma-separated string and array format
    let optionsArray = [];
    if (field.options) {
      if (Array.isArray(field.options)) {
        optionsArray = field.options;
      } else {
        optionsArray = field.options.split(',').map(o => o.trim()).filter(o => o);
      }
    }
    // Always have at least one empty option input for dropdown
    if (isSelect && optionsArray.length === 0) {
      optionsArray = [''];
    }
    
    // Default file subtype
    const fileSubtype = field.fileSubtype || 'image';
    
    return `
      <div class="form-field-item bg-zen-50 rounded-lg p-3" data-field-id="${escapeHtml(field.id)}" data-field-index="${index}" data-field-type="${escapeHtml(field.type || 'text')}">
        <div class="flex items-start gap-2">
          <div class="flex-1 space-y-2">
            <input type="text" class="field-label-input form-input text-sm" value="${escapeHtml(field.label)}" placeholder="${window.t('builder.form.fieldLabelPlaceholder')}" />
            <div class="flex gap-2">
              <select class="field-type-select form-input text-sm flex-1">
                <option value="text" ${field.type === 'text' ? 'selected' : ''}>${window.t('builder.form.fieldTypes.shortText')}</option>
                <option value="textarea" ${field.type === 'textarea' ? 'selected' : ''}>${window.t('builder.form.fieldTypes.longText')}</option>
                <option value="select" ${field.type === 'select' ? 'selected' : ''}>${window.t('builder.form.fieldTypes.select')}</option>
                <option value="yesno" ${field.type === 'yesno' ? 'selected' : ''}>${window.t('builder.form.fieldTypes.yesno')}</option>
                <option value="file" ${field.type === 'file' ? 'selected' : ''}>${window.t('builder.form.fieldTypes.file')}</option>
              </select>
              <label class="flex items-center gap-1 text-xs text-zen-500 whitespace-nowrap">
                <input type="checkbox" class="field-required-checkbox w-3.5 h-3.5" ${field.required ? 'checked' : ''} />
                ${window.t('builder.form.required')}
              </label>
            </div>
            <!-- File subtype selector (only visible for file type) -->
            <div class="field-file-wrapper ${isFile ? '' : 'hidden'}">
              <div class="text-xs text-zen-500 mb-2">${window.t('builder.form.fileUpload.subtype')}</div>
              <select class="field-file-subtype form-input text-sm">
                <option value="image" ${fileSubtype === 'image' ? 'selected' : ''}>${window.t('builder.form.fileUpload.subtypes.image')} (${window.t('builder.form.fileUpload.acceptedFormats.image')})</option>
                <option value="document" ${fileSubtype === 'document' ? 'selected' : ''}>${window.t('builder.form.fileUpload.subtypes.document')} (${window.t('builder.form.fileUpload.acceptedFormats.document')})</option>
                <option value="audio" ${fileSubtype === 'audio' ? 'selected' : ''}>${window.t('builder.form.fileUpload.subtypes.audio')} (${window.t('builder.form.fileUpload.acceptedFormats.audio')})</option>
              </select>
              <p class="text-xs text-zen-400 mt-1">${window.t('builder.form.fileUpload.maxSize', { size: '12' })}</p>
            </div>
            <div class="field-options-wrapper ${isSelect ? '' : 'hidden'}">
              <div class="text-xs text-zen-500 mb-2">${window.t('builder.form.dropdownOptions')}</div>
              <div class="field-options-list space-y-2">
                ${optionsArray.map((opt, optIndex) => `
                  <div class="field-option-row flex items-center gap-2">
                    <span class="text-xs text-zen-400 w-5">${optIndex + 1}.</span>
                    <input type="text" class="field-option-input form-input text-sm flex-1" value="${this.escapeHtml(opt)}" placeholder="${window.t('builder.form.optionPlaceholder')}" />
                    <button type="button" class="remove-option-btn text-zen-500 hover:text-red-500 hover:bg-red-50 p-1.5 rounded transition-colors ${optionsArray.length <= 1 ? 'opacity-30 pointer-events-none' : ''}" title="${window.t('builder.form.removeOption')}">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                      </svg>
                    </button>
                  </div>
                `).join('')}
              </div>
              <button type="button" class="add-option-btn mt-2 text-xs text-gryffi-primary hover:text-gryffi-primary/80 flex items-center gap-1">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                </svg>
                ${window.t('builder.form.addOption')}
              </button>
            </div>
          </div>
          <button type="button" class="remove-field-btn text-zen-400 hover:text-red-500 p-1 -mt-1" title="${window.t('builder.form.removeField')}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
  }
  
  renderFormFieldPreview(field, index) {
    const required = field.required ? 'required' : '';
    const requiredMark = field.required ? '<span class="text-red-500 ml-1">*</span>' : '';
    
    let inputHtml = '';
    
    switch (field.type) {
      case 'text':
        inputHtml = `<input type="text" name="field_${index}" class="form-input w-full" ${required} />`;
        break;
      case 'textarea':
        inputHtml = `<textarea name="field_${index}" class="form-textarea w-full" rows="3" ${required}></textarea>`;
        break;
      case 'select':
        const optionsList = (field.options || '').split(',').map(o => o.trim()).filter(o => o);
        inputHtml = `
          <select name="field_${index}" class="form-input w-full" ${required}>
            <option value="">${window.t('builder.preview.selectOption')}</option>
            ${optionsList.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('')}
          </select>
        `;
        break;
      case 'yesno':
        inputHtml = `
          <div class="flex gap-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="field_${index}" value="yes" class="w-4 h-4" style="accent-color: var(--theme-primary, #0b4b34);" ${required} />
              <span>${window.t('builder.preview.yes')}</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="field_${index}" value="no" class="w-4 h-4" style="accent-color: var(--theme-primary, #0b4b34);" />
              <span>${window.t('builder.preview.no')}</span>
            </label>
          </div>
        `;
        break;
      case 'file':
        const fileSubtype = field.fileSubtype || 'image';
        const acceptMap = {
          image: 'image/jpeg,image/png,image/gif,image/webp',
          document: 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain',
          audio: 'audio/mpeg'
        };
        const acceptTypes = acceptMap[fileSubtype] || acceptMap.image;
        const formatLabel = window.t(`builder.form.fileUpload.acceptedFormats.${fileSubtype}`) || '';
        const subtypeLabel = window.t(`builder.form.fileUpload.subtypes.${fileSubtype}`) || fileSubtype;
        
        // Icon based on file type
        let fileIcon = '';
        if (fileSubtype === 'image') {
          fileIcon = `<svg class="w-10 h-10 mx-auto mb-3 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
          </svg>`;
        } else if (fileSubtype === 'document') {
          fileIcon = `<svg class="w-10 h-10 mx-auto mb-3 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
          </svg>`;
        } else {
          fileIcon = `<svg class="w-10 h-10 mx-auto mb-3 text-zen-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path>
          </svg>`;
        }
        
        inputHtml = `
          <div class="file-upload-zone" data-field-index="${index}" data-subtype="${escapeHtml(fileSubtype)}" data-accept="${acceptTypes}">
            <input type="file" name="field_${index}" class="file-input-hidden" accept="${acceptTypes}" ${required} style="display: none;" />
            <div class="file-dropzone border-2 border-dashed border-zen-300 rounded-xl p-6 text-center cursor-pointer transition-all hover:border-gryffi-accent hover:bg-gryffi-accent/5" style="min-height: 120px;">
              <div class="file-dropzone-content">
                ${fileIcon}
                <p class="text-sm text-zen-600 mb-1">${window.t('builder.form.fileUpload.dropzone')}</p>
                <p class="text-xs text-zen-400">${escapeHtml(subtypeLabel)} · ${escapeHtml(formatLabel)}</p>
                <p class="text-xs text-zen-400 mt-1">${window.t('builder.form.fileUpload.maxSize', { size: '12' })}</p>
              </div>
              <div class="file-preview hidden">
                <div class="file-preview-content flex items-center gap-3 py-2 px-2">
                  <div class="file-preview-icon flex-shrink-0"></div>
                  <div class="file-preview-info text-left flex-1 min-w-0 overflow-hidden">
                    <p class="file-preview-name text-sm font-medium text-zen-700 truncate"></p>
                    <p class="file-preview-size text-xs text-zen-400"></p>
                  </div>
                  <button type="button" class="file-remove-btn flex-shrink-0 text-zen-400 hover:text-red-500 p-1" title="${window.t('builder.form.fileUpload.removeFile')}">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;
        break;
    }
    
    return `
      <div class="form-field-preview">
        <label class="block text-sm font-medium text-zen-700 mb-1.5">${escapeHtml(field.label || window.t('builder.preview.field'))}${requiredMark}</label>
        ${inputHtml}
      </div>
    `;
  }
  
  // ============================================
  // QUIZ WIZARD PREVIEW METHODS
  // ============================================
  
  renderQuizWizardQuestion(question, index, total) {
    const options = question.options || [];
    
    return `
      <div class="quiz-question-slide" data-question-index="${index}" style="display: flex; flex-direction: column; min-height: 0;">
        <div style="flex: 1; min-height: 0;">
          <h3 class="text-lg font-semibold text-zen-900 mb-6">${escapeHtml(question.question || window.t('builder.quiz.questionPlaceholder'))}</h3>
          
          <div class="space-y-4 mb-8" id="quizOptionsContainer">
            ${options.map((opt, i) => `
              <button type="button" class="quiz-wizard-option" 
                      data-option-index="${i}"${opt.correct !== undefined ? ` data-correct="${opt.correct === true}"` : ''}>
                <span class="option-letter">${String.fromCharCode(65 + i)}</span>
                <span class="option-text">${escapeHtml(opt.text || window.t('builder.quiz.optionPlaceholder'))}</span>
                <span class="option-indicator">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
                  </svg>
                </span>
              </button>
            `).join('')}
          </div>
          
          <!-- Feedback Area (hidden initially) -->
          <div id="quizFeedback" class="mt-4 mb-6 hidden"></div>
        </div>
        
        <!-- Navigation Buttons - Always visible at bottom -->
        <div class="flex items-center gap-4 mt-6 ${index === 0 ? 'justify-end' : 'justify-between'}" style="flex-shrink: 0; padding-top: 16px;">
          ${index === 0 ? '' : `
            <button
              type="button"
              id="quizPrevBtn"
              class="journey-nav-btn inline-flex items-center"
              style="border: 2px solid var(--theme-primary, #0b4b34); color: var(--theme-primary, #0b4b34); background: white;"
            >
              <svg class="w-5 h-5 flex-shrink-0" style="margin-right: 10px;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
              </svg>
              ${window.tPlayer('player.quiz.previous')}
            </button>
          `}
          <button
            type="button"
            id="quizNextBtn"
            class="journey-nav-btn journey-nav-btn-primary inline-flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            style="min-width: 160px;"
            disabled
          >
            <span style="margin-right: 12px;">${index === total - 1 ? window.tPlayer('player.quiz.finish') : window.tPlayer('player.quiz.next')}</span>
            <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
  }
  
  renderQuizResults(correctCount, totalCount, passingScore, passMessage, failMessage, allowRetake) {
    // Four result framings, chosen by whether the maker set a passing score
    // and what the participant achieved:
    //
    //   - 'passed'    : threshold set and met         -> green, congratulate, show maker's pass_message
    //   - 'failed'    : threshold set and not met     -> red, explain what's required, show fail_message + retake
    //   - 'perfect'   : no threshold + every question right
    //                                                 -> green, "All correct!" / "Correct answer!"
    //   - 'completed' : no threshold + at least one wrong
    //                                                 -> neutral primary tint, "Quiz completed"
    //                                                   (no "passed/congratulations" framing because the
    //                                                   maker never declared this a pass/fail check;
    //                                                   feliciting someone for 0 right answers is awkward)
    const hasThreshold = passingScore > 0;
    const isPerfect = totalCount > 0 && correctCount === totalCount;
    const passed = !hasThreshold || correctCount >= passingScore;
    const percentage = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

    let resultStyle;
    if (hasThreshold) resultStyle = passed ? 'passed' : 'failed';
    else resultStyle = isPerfect ? 'perfect' : 'completed';

    const successColor = 'var(--theme-accent, #78c503)';
    const failColor = '#ef4444';
    const neutralColor = 'var(--theme-primary, #0b4b34)';

    const strokeColor = (resultStyle === 'passed' || resultStyle === 'perfect')
      ? successColor
      : (resultStyle === 'failed' ? failColor : neutralColor);

    let resultLabel;
    if (resultStyle === 'passed') {
      resultLabel = window.tPlayer('player.quiz.passed');
    } else if (resultStyle === 'failed') {
      resultLabel = window.tPlayer('player.quiz.failed', { required: passingScore });
    } else if (resultStyle === 'perfect') {
      // "All correct" doesn't fit a 1-question quiz; pick the singular form.
      resultLabel = totalCount === 1
        ? window.tPlayer('player.quiz.singleCorrect')
        : window.tPlayer('player.quiz.allCorrect');
    } else {
      resultLabel = window.tPlayer('player.quiz.completed');
    }

    const isPositive = resultStyle === 'passed' || resultStyle === 'perfect';
    const isNegative = resultStyle === 'failed';
    const labelColor = isPositive ? successColor : (isNegative ? failColor : neutralColor);

    // Maker-supplied messages: only surface pass_message when we frame the
    // result as a success. The 'completed' state explicitly suppresses
    // pass_message because makers usually phrase it as "Congratulations!"
    // which doesn't match a 0/1 correct outcome.
    let makerMessage = '';
    if (isPositive && passMessage) {
      makerMessage = `<p class="text-zen-600 mt-2">${escapeHtml(passMessage)}</p>`;
    } else if (isNegative && failMessage) {
      makerMessage = `<p class="text-zen-600">${escapeHtml(failMessage)}</p>`;
    }

    // Show the "journey continues" hint everywhere except on a failure,
    // where we want the participant to focus on retrying instead.
    const continueHint = !isNegative
      ? `<p class="text-zen-500 text-sm">${window.tPlayer('player.quiz.nextStepHint')}</p>`
      : '';

    // Positive/neutral states get the check-in-circle icon (color makes the
    // distinction between celebration and neutral acknowledgement); the
    // failed state gets the X-in-circle icon.
    const positiveIconPath = 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z';
    const negativeIconPath = 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z';
    const iconPath = isNegative ? negativeIconPath : positiveIconPath;

    return `
      <div class="text-center py-6">
        <!-- Score Circle -->
        <div class="relative w-32 h-32 mx-auto mb-6">
          <svg class="w-full h-full transform -rotate-90">
            <circle cx="64" cy="64" r="56" fill="none" stroke="#e5e7eb" stroke-width="8"/>
            <circle cx="64" cy="64" r="56" fill="none" stroke="${escapeHtml(strokeColor)}" stroke-width="8" 
                    stroke-dasharray="${2 * Math.PI * 56}" 
                    stroke-dashoffset="${2 * Math.PI * 56 * (1 - percentage / 100)}"
                    class="transition-all duration-1000"/>
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <span class="text-3xl font-bold" style="color: ${escapeHtml(strokeColor)};">${percentage}%</span>
            <span class="text-xs text-zen-400">${window.tPlayer('player.quiz.score')}</span>
          </div>
        </div>
        
        <!-- Result Message -->
        <div class="mb-6">
          <div class="flex items-center justify-center gap-2 mb-2" style="color: ${escapeHtml(labelColor)};">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${iconPath}"></path>
            </svg>
            <span class="font-semibold">${resultLabel}</span>
          </div>
          ${continueHint}
          ${makerMessage}
        </div>
        
        <!-- Score Details -->
        <p class="text-zen-500 mb-6">
          ${window.tPlayer('player.quiz.questionsCorrect', { correct: correctCount, total: totalCount })}
        </p>
        
        <!-- Actions -->
        ${!passed && allowRetake ? `
          <div class="flex justify-center gap-4 mt-8">
            <button type="button" id="quizRetakeBtn" class="journey-nav-btn journey-nav-btn-primary">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
              </svg>
              ${window.tPlayer('player.quiz.retake')}
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  initQuizWizard(container) {
    const wizard = container.querySelector('#quizWizard');
    if (!wizard) return;
    
    // Helper to decode HTML entities
    const decodeHtmlEntities = (str) => {
      if (!str) return str;
      const textarea = document.createElement('textarea');
      textarea.innerHTML = str;
      return textarea.value;
    };
    
    // Parse quiz data (decode HTML entities first)
    const questions = JSON.parse(decodeHtmlEntities(wizard.dataset.questions) || '[]');
    const passingScore = parseInt(wizard.dataset.passingScore) || 0;
    const showFeedback = wizard.dataset.showFeedback === 'true';
    const allowRetake = wizard.dataset.allowRetake === 'true';
    const passMessage = decodeHtmlEntities(wizard.dataset.passMessage) || '';
    const failMessage = decodeHtmlEntities(wizard.dataset.failMessage) || '';
    
    // Quiz state
    let currentQuestion = 0;
    let answers = [];
    // eslint-disable-next-line no-unused-vars -- Used in updateUI and showQuestion functions
    let answered = false;
    
    // Track quiz attempt number; the key identifies this attempt on the server
    this.previewState.quizAttemptNumber = (this.previewState.quizAttemptNumber || 0) + 1;
    this.previewState.quizAttemptKey = crypto.randomUUID();
    const attemptNumber = this.previewState.quizAttemptNumber;
    
    // Analytics: Track quiz start
    if (this.playerMode) {
      journeyAnalytics.quizAttemptStarted(this.previewState.currentStep?.id, questions.length);
    }
    
    const updateUI = () => {
      // Update progress
      const progress = container.querySelector('#quizProgress');
      const progressBar = container.querySelector('#quizProgressBar');
      const scoreSpan = container.querySelector('#quizScore');
      
      if (progress) {
        progress.textContent = window.tPlayer('player.quiz.questionOf', { 
          current: currentQuestion + 1, 
          total: questions.length 
        });
      }
      if (progressBar) {
        progressBar.style.width = `${((currentQuestion + 1) / questions.length) * 100}%`;
      }
      if (scoreSpan && answers.length > 0) {
        const correct = answers.filter(a => a.correct).length;
        scoreSpan.textContent = `${correct}/${answers.length}`;
      }
    };
    
    const showQuestion = (index) => {
      currentQuestion = index;
      answered = false;
      
      // Stop reading the previous question aloud
      this.stopTts();
      
      // Store current quiz question index in previewState so AI Guide knows which question is visible
      this.previewState.currentQuizQuestionIndex = index;
      
      const questionContainer = container.querySelector('#quizQuestionContainer');
      questionContainer.innerHTML = this.renderQuizWizardQuestion(questions[index], index, questions.length);
      
      updateUI();
      this.bindQuizWizardEvents(container, questions, index, showFeedback, answers, () => {
        answered = true;
      }, showQuestion, showResults);
    };
    
    const showResults = () => {
      // Stop reading the last question aloud
      this.stopTts();
      
      const correctCount = answers.filter(a => a.correct).length;
      const passed = passingScore === 0 || correctCount >= passingScore;
      const questionContainer = container.querySelector('#quizQuestionContainer');
      const resultsContainer = container.querySelector('#quizResultsContainer');
      
      questionContainer.classList.add('hidden');
      resultsContainer.classList.remove('hidden');
      resultsContainer.innerHTML = this.renderQuizResults(
        correctCount, 
        questions.length, 
        passingScore, 
        passMessage, 
        failMessage, 
        allowRetake
      );
      
      // Analytics: Track quiz completion with detailed results
      if (this.playerMode) {
        const stepId = this.previewState.currentStep?.id;
        const score = correctCount;
        
        journeyAnalytics.quizAttemptCompleted(stepId, score, questions.length, passed, attemptNumber);
        
        // Also save to the dedicated quiz_attempts table
        this.saveQuizAttempt(stepId, attemptNumber, questions.length, correctCount, passed);
      }
      
      // Only set quizPassed if the passing score is met
      if (passed) {
        this.previewState.quizPassed = true;
        this.trackEndStepCompletion(this.previewState.currentStep);
        this.updatePreviewPacing();
      } else {
        // Reset quizPassed if not passed
        this.previewState.quizPassed = false;
        this.previewState.pacingUnlocked = false;
        const navButtons = document.getElementById('navButtons');
        const pacingIndicator = document.getElementById('pacingIndicator');
        if (navButtons) navButtons.classList.add('hidden');
        if (pacingIndicator) pacingIndicator.classList.remove('hidden');
      }
      
      // Bind result actions
      container.querySelector('#quizRetakeBtn')?.addEventListener('click', () => {
        answers = [];
        this.previewState.quizPassed = false;
        this.previewState.pacingUnlocked = false;
        resultsContainer.classList.add('hidden');
        questionContainer.classList.remove('hidden');
        
        // Increment attempt number for retake (new attempt key for the server)
        this.previewState.quizAttemptNumber = (this.previewState.quizAttemptNumber || 0) + 1;
        this.previewState.quizAttemptKey = crypto.randomUUID();
        
        // Analytics: Track new quiz attempt start
        if (this.playerMode) {
          journeyAnalytics.quizAttemptStarted(this.previewState.currentStep?.id, questions.length);
        }
        
        showQuestion(0);
        
        // Hide nav buttons again
        const navButtons = document.getElementById('navButtons');
        const pacingIndicator = document.getElementById('pacingIndicator');
        if (navButtons) navButtons.classList.add('hidden');
        if (pacingIndicator) pacingIndicator.classList.remove('hidden');
      });
    };
    
    // Initial bind
    this.bindQuizWizardEvents(container, questions, 0, showFeedback, answers, () => {
      answered = true;
    }, showQuestion, showResults);
  }
  
  bindQuizWizardEvents(container, questions, currentIndex, showFeedback, answers, onAnswer, showQuestion, showResults) {
    const optionBtns = container.querySelectorAll('.quiz-wizard-option');
    const nextBtn = container.querySelector('#quizNextBtn');
    const prevBtn = container.querySelector('#quizPrevBtn');
    const feedbackArea = container.querySelector('#quizFeedback');
    
    // eslint-disable-next-line no-unused-vars -- Used in click handler below
    let selectedOption = null;
    let hasAnswered = answers[currentIndex] !== undefined;
    
    // If already answered, show the state
    if (hasAnswered) {
      const previousAnswer = answers[currentIndex];
      optionBtns.forEach((btn, i) => {
        if (i === previousAnswer.selected) {
          btn.classList.add('border-gryffi-primary', 'bg-gryffi-primary/10');
          if (showFeedback) {
            if (previousAnswer.correct) {
              btn.classList.add('border-green-500', 'bg-green-50');
            } else {
              btn.classList.add('border-red-500', 'bg-red-50');
            }
          }
        }
        btn.style.pointerEvents = 'none';
      });
      nextBtn.disabled = false;
    }
    
    optionBtns.forEach((btn, i) => {
      btn.addEventListener('click', async () => {
        if (hasAnswered) return;
        hasAnswered = true;
        
        // Clear previous selection
        optionBtns.forEach(b => {
          b.classList.remove('border-gryffi-primary', 'bg-gryffi-primary/10', 'border-green-500', 'bg-green-50', 'border-red-500', 'bg-red-50');
        });
        
        // Select this option
        btn.classList.add('border-gryffi-primary', 'bg-gryffi-primary/10');
        selectedOption = i;
        
        // Players do not have the answers: the server checks them. The maker
        // preview still has them in the page and checks locally.
        let isCorrect = btn.dataset.correct === 'true';
        const checkUrl = this.getQuizCheckUrl();
        if (checkUrl) {
          optionBtns.forEach(b => { b.style.pointerEvents = 'none'; });
          try {
            const response = await fetch(checkUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({
                step_id: this.previewState.currentStep?.id,
                question_id: questions[currentIndex]?.id,
                option_index: i,
                attempt_key: this.previewState.quizAttemptKey
              })
            });
            const result = await response.json();
            isCorrect = result.success === true && result.correct === true;
          } catch (err) {
            console.error('[Quiz] Answer check failed:', err);
            isCorrect = false;
          }
        }
        
        // Record answer
        answers[currentIndex] = { selected: i, correct: isCorrect };
        onAnswer();
        
        // Show feedback if enabled
        if (showFeedback) {
          // Update the selected button's indicator icon
          const indicator = btn.querySelector('.option-indicator');
          
          if (isCorrect) {
            btn.classList.remove('border-gryffi-primary', 'bg-gryffi-primary/10');
            btn.classList.add('correct');
            // Replace arrow with checkmark
            if (indicator) {
              indicator.innerHTML = `
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>
                </svg>
              `;
            }
            feedbackArea.innerHTML = `
              <div class="flex items-center gap-2 text-green-600 p-3 bg-green-50 rounded-lg">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
                <span class="font-medium">${window.tPlayer('player.quiz.correct')}</span>
              </div>
            `;
          } else {
            btn.classList.remove('border-gryffi-primary', 'bg-gryffi-primary/10');
            btn.classList.add('incorrect');
            // Replace arrow with X
            if (indicator) {
              indicator.innerHTML = `
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              `;
            }
            feedbackArea.innerHTML = `
              <div class="flex items-center gap-2 text-red-600 p-3 bg-red-50 rounded-lg">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
                <span class="font-medium">${window.tPlayer('player.quiz.incorrect')}</span>
              </div>
            `;
          }
          feedbackArea.classList.remove('hidden');
        }
        
        // Disable further selection - add disabled class to other options
        optionBtns.forEach(b => {
          if (b !== btn) {
            b.classList.add('disabled');
          }
        });
        
        // Enable next button
        nextBtn.disabled = false;
      });
    });
    
    // Next button
    nextBtn?.addEventListener('click', () => {
      if (currentIndex < questions.length - 1) {
        showQuestion(currentIndex + 1);
      } else {
        showResults();
      }
    });
    
    // Previous button
    prevBtn?.addEventListener('click', () => {
      if (currentIndex > 0) {
        showQuestion(currentIndex - 1);
      }
    });
  }
  
  extractYouTubeId(url) {
    if (!url) return null;
    // Handle various YouTube URL formats
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/,
      /youtube\.com\/watch\?.*v=([^&\s]+)/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      // A YouTube ID is exactly 11 URL-safe characters. Anything else is
      // rejected so the value can never break out of the embed URL/attribute.
      if (match && /^[A-Za-z0-9_-]{11}$/.test(match[1])) return match[1];
    }
    return null;
  }
  
  renderVideoPreview(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      return `<p class="text-sm text-zen-400 italic py-4 text-center">Enter a valid YouTube URL to see preview</p>`;
    }
    return `
      <div class="aspect-video rounded-lg overflow-hidden bg-black">
        <iframe 
          src="https://www.youtube-nocookie.com/embed/${videoId}" 
          class="w-full h-full"
          frameborder="0" 
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
          referrerpolicy="strict-origin-when-cross-origin"
          allowfullscreen>
        </iframe>
      </div>
    `;
  }
  
  getPacingInfo(pacing, stepType, mediaType) {
    const info = { message: '', seconds: 0, messages: 0, isVideo: false };
    
    if (pacing === 'immediately') {
      return info;
    }
    
    if (pacing.startsWith('time_')) {
      const seconds = parseInt(pacing.split('_')[1]);
      info.seconds = seconds;
      
      // Different messages based on content type
      if (mediaType === 'video') {
        info.isVideo = true;
        info.message = window.t('builder.preview.pressPlayToStart');
      } else if (seconds >= 60) {
        const mins = Math.floor(seconds / 60);
        // Handle pluralization based on language
        let message = window.tPlayer('player.pacing.takeYourTimeMinutes');
        message = message.replace(/\{\{minutes\}\}/g, mins);
        const locale = window.GRYFFI?.locale || 'en';
        let pluralText = '';
        if (locale === 'nl') {
          pluralText = mins === 1 ? 'minuut' : 'minuten';
        } else if (locale === 'de') {
          pluralText = mins === 1 ? 'Minute' : 'Minuten';
        } else if (locale === 'fr') {
          // French: "minute" (singular) or "minutes" (plural), and "restante" (singular) or "restantes" (plural)
          pluralText = mins === 1 ? 'minute' : 'minutes';
          message = message.replace(/restante\{\{plural\}\}/g, mins === 1 ? 'restante' : 'restantes');
        } else if (locale === 'es') {
          // Spanish: "minuto" (singular) or "minutos" (plural), and "restante" (singular) or "restantes" (plural)
          pluralText = mins === 1 ? 'minuto' : 'minutos';
          message = message.replace(/restante\{\{plural\}\}/g, mins === 1 ? 'restante' : 'restantes');
        } else {
          // English: use 's' for plural
          pluralText = mins > 1 ? 's' : '';
        }
        message = message.replace(/\{\{plural\}\}/g, pluralText);
        info.message = message;
      } else {
        info.message = window.tPlayer('player.pacing.takeYourTimeSeconds', { seconds });
      }
    } else if (pacing.startsWith('messages_')) {
      const count = parseInt(pacing.split('_')[1]);
      info.messages = count;
      info.message = window.t('builder.preview.chatWithGuide', { count: 0, total: count });
    }
    
    return info;
  }
  
  /**
   * Check if a form has already been submitted by this user
   * Shows a banner and skip button if already submitted
   */
  async checkFormSubmissionStatus(step, container, advancedProps) {
    try {
      // Determine the correct endpoint based on mode
      let statusUrl;
      if (window.GRYFFI?.publicMode && window.GRYFFI?.publicPlayer?.token) {
        statusUrl = `/p/${window.GRYFFI.publicPlayer.token}/forms/submission-status/${step.id}`;
      } else if (this.playerMode && window.GRYFFI?.player?.token) {
        statusUrl = `/e/${window.GRYFFI.player.token}/forms/submission-status/${step.id}`;
      } else {
        // Builder preview mode - no status check needed
        return;
      }
      
      const response = await fetch(statusUrl);
      if (!response.ok) return;
      
      const data = await response.json();
      
      if (data.success && data.hasSubmitted) {
        // Format the date with proper locale
        const submittedDate = new Date(data.submittedAt);
        const langToLocale = {
          'en': 'en-US',
          'nl': 'nl-NL',
          'de': 'de-DE',
          'fr': 'fr-FR',
          'es': 'es-ES'
        };
        const currentLang = window.GRYFFI?.locale || document.documentElement.lang || 'en';
        const locale = langToLocale[currentLang] || 'en-US';
        const formattedDate = submittedDate.toLocaleDateString(locale, {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        
        // Show the "already submitted" banner
        const banner = container.querySelector('#formAlreadySubmittedBanner');
        const messageEl = container.querySelector('#formSubmittedMessage');
        const skipBtn = container.querySelector('#skipFormBtn');
        
        if (banner) {
          banner.classList.remove('hidden');
        }
        
        if (messageEl) {
          messageEl.textContent = window.t('builder.form.alreadySubmitted.message', { date: formattedDate });
        }
        
        if (skipBtn) {
          // Show the skip button (it's hidden by default with inline style)
          skipBtn.style.display = 'flex';
          
          // Add click handler for skip button
          skipBtn.addEventListener('click', () => {
            // Unlock pacing so user can proceed
            this.unlockPacing();
            
            // Hide the form and show a "skipped" message
            const previewForm = container.querySelector('#previewForm');
            const successMessage = container.querySelector('#formSuccessMessage');
            
            if (previewForm) {
              previewForm.classList.add('hidden');
            }
            
            if (successMessage) {
              // Update message to indicate skipping
              const messageP = successMessage.querySelector('p');
              if (messageP) {
                messageP.textContent = advancedProps.confirmation_message || window.t('builder.preview.defaultConfirmation');
              }
              successMessage.classList.remove('hidden');
            }
            
            // Auto-navigate to next step if available
            const nextBtns = container.querySelectorAll('.preview-nav-next');
            if (nextBtns.length === 1) {
              // Small delay to show the success state
              setTimeout(() => {
                nextBtns[0].click();
              }, 500);
            }
          });
        }
        
        // If the form completion is NOT required (completion_requirement !== 'after_submit'),
        // or if it was already submitted, the pacing should be unlocked
        const formRequirement = advancedProps.completion_requirement || 'after_submit';
        if (formRequirement !== 'after_submit') {
          this.unlockPacing();
        }
      }
    } catch (error) {
      console.error('Error checking form submission status:', error);
      // Silently fail - user can still submit the form
    }
  }
  
  initializePacing(step, advancedProps, basicProps) {
    // For challenge steps, never unlock pacing immediately - wait for quiz completion
    if (step.type === 'challenge') {
      this.previewState.pacingUnlocked = false;
      this.previewState.quizPassed = false;
      return;
    }
    
    const pacing = advancedProps.pacing || 'immediately';
    const pacingMessage = document.getElementById('pacingMessage');
    const mediaType = basicProps?.media_type === 'markdown' ? 'text' : (basicProps?.media_type || 'text');
    const isVideo = step.type === 'content' && mediaType === 'video';
    
    // Always initialize video play overlay, regardless of pacing settings
    if (isVideo) {
      this.initializeVideoPlayer();
    }
    
    if (pacing === 'immediately') {
      this.previewState.pacingUnlocked = true;
      return;
    }
    
    if (pacing.startsWith('time_')) {
      let secondsLeft = parseInt(pacing.split('_')[1]);
      
      const startTimer = () => {
        const updateTimer = () => {
          if (secondsLeft <= 0) {
            clearInterval(this.previewState.pacingTimer);
            this.unlockPacing();
            if (pacingMessage) {
              pacingMessage.textContent = window.tPlayer('player.pacing.readyToContinue');
            }
          } else {
            if (pacingMessage) {
              if (isVideo) {
                pacingMessage.textContent = window.tPlayer('player.pacing.keepWatching', { seconds: secondsLeft });
              } else {
                pacingMessage.textContent = window.tPlayer('player.pacing.takeYourTimeSeconds', { seconds: secondsLeft });
              }
            }
            secondsLeft--;
          }
        };
        
        updateTimer();
        this.previewState.pacingTimer = setInterval(updateTimer, 1000);
      };
      
      if (isVideo) {
        // For video: wait for user to click play overlay before timer begins
        this.previewState.videoTimerStarted = false;
        
        // Set up timer to start when video is played
        // The actual video player initialization is handled by initializeVideoPlayer()
        // We just need to hook up the timer start
        const originalStartVideo = this.previewState.startVideoCallback;
        this.previewState.startVideoCallback = () => {
          if (originalStartVideo) originalStartVideo();
          startTimer();
        };
      } else {
        // For non-video content: start timer immediately
        startTimer();
      }
    }
    // Message-based pacing is handled in the chat send handler
  }
  
  initializeVideoPlayer() {
    // Initialize video player - video is now shown directly via iframe
    const videoContainer = document.getElementById('videoPlayerContainer');
    
    if (videoContainer) {
      // Video is loaded directly, start pacing timer immediately if configured
      // (user can start watching right away without clicking an overlay)
      if (this.previewState.startVideoCallback) {
        this.previewState.startVideoCallback();
      }
    }
  }
  
  unlockPacing() {
    this.previewState.pacingUnlocked = true;
    const pacingIndicator = document.getElementById('pacingIndicator');
    const navButtons = document.getElementById('navButtons');
    
    if (pacingIndicator) {
      pacingIndicator.classList.add('hidden');
    }
    if (navButtons) {
      navButtons.classList.remove('hidden');
    }
  }
  
  updatePreviewPacing() {
    // For challenge steps, unlock pacing when quiz is passed
    if (this.previewState.quizPassed) {
      this.previewState.pacingUnlocked = true;
      const pacingIndicator = document.getElementById('pacingIndicator');
      const navButtons = document.getElementById('navButtons');
      
      if (pacingIndicator) {
        pacingIndicator.classList.add('hidden');
      }
      if (navButtons) {
        navButtons.classList.remove('hidden');
      }
    }
  }
  
  updateMessagePacing(requiredMessages) {
    this.previewState.messageCount++;
    const count = this.previewState.messageCount;
    const pacingMessage = document.getElementById('pacingMessage');
    
    if (pacingMessage) {
      if (count >= requiredMessages) {
        this.unlockPacing();
      } else {
        pacingMessage.textContent = window.t('builder.preview.chatWithGuide', { count, total: requiredMessages });
      }
    }
  }
  
  getStepPreview(step, props) {
    switch (step.type) {
      case 'space': return `<p class="truncate">${escapeHtml(props.description || window.t('builder.props.noDescription'))}</p>`;
      case 'guide': 
        const guideForPreview = this.guides.find(g => g.id === props.guide_id);
        if (guideForPreview) {
          return `<p class="truncate">${escapeHtml(guideForPreview.name)}${guideForPreview.role ? ` - ${escapeHtml(guideForPreview.role)}` : ''}</p>`;
        }
        return `<p class="truncate text-zen-400 italic">${window.t('builder.preview.noGuideSelected')}</p>`;
      case 'content': 
        const mediaType = props.media_type === 'markdown' ? 'text' : (props.media_type || 'text');
        if (mediaType === 'video') return `<p class="truncate text-zen-500">📹 ${window.t('builder.props.video')}</p>`;
        if (mediaType === 'image') return `<p class="truncate text-zen-500">🖼️ ${window.t('builder.props.image')}</p>`;
        // Strip HTML tags for text preview
        const textContent = htmlToText(props.body);
        return `<p class="truncate">${escapeHtml(textContent.substring(0, 40)) || window.t('builder.props.noContent')}${textContent.length > 40 ? '...' : ''}</p>`;
      case 'challenge': 
        const quizQs = props.questions || [];
        if (quizQs.length > 0) {
          const qLabel = quizQs.length === 1 
            ? window.t('builder.quiz.questionCount', { count: quizQs.length })
            : window.t('builder.quiz.questionCountPlural', { count: quizQs.length });
          return `<p class="truncate text-zen-500">🧠 ${qLabel}</p>`;
        }
        return `<p class="truncate">${escapeHtml(props.question || window.t('builder.props.questionFallback'))}</p>`;
      case 'form':
        const fieldCount = (props.fields || []).length;
        const fieldText = fieldCount === 1 ? window.t('builder.form.fieldCount', { count: fieldCount }) : window.t('builder.form.fieldCountPlural', { count: fieldCount });
        return `<p class="truncate text-zen-500">📋 ${escapeHtml(fieldText)}</p>`;
      case 'poll':
        const optionCount = (props.options || []).length;
        const optionText = optionCount === 1 ? window.t('builder.poll.optionCount', { count: optionCount }) : window.t('builder.poll.optionCountPlural', { count: optionCount });
        return `<p class="truncate text-zen-500">📊 ${escapeHtml(optionText)}</p>`;
      case 'reward':
        return `<p class="truncate text-zen-500">🎁 ${escapeHtml(props.title || window.t('builder.stepTypes.reward'))}</p>`;
      case 'nested_journey':
        const nestedJourney = this.availableNestedJourneys?.find(j => j.id === props.nested_journey_id);
        if (nestedJourney) {
          return `<p class="truncate text-zen-500">↳ ${escapeHtml(nestedJourney.title)}</p>`;
        }
        return `<p class="truncate text-zen-400 italic">${window.t('builder.props.chooseNestedJourney')}</p>`;
      default: return '';
    }
  }
  
  getResourceIcon(icon) {
    const icons = {
      badge: '<svg class="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"></path></svg>',
      book: '<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>',
      laptop: '<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>',
      file: '<svg class="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>'
    };
    return icons[icon] || icons.file;
  }
  
  /**
   * Get display label for a language code
   */
  getLanguageLabel(code) {
    const labels = {
      en: 'English',
      nl: 'Nederlands',
      de: 'Deutsch',
      fr: 'Français',
      es: 'Español'
    };
    return labels[code] || code || 'English';
  }
  
  /**
   * Shuffle an array using Fisher-Yates algorithm with optional seed
   * Using a seed ensures the same user gets the same order during their session
   */
  shuffleArray(array, seed = null) {
    const result = [...array];
    
    // Simple seeded random number generator
    const seededRandom = (s) => {
      const x = Math.sin(s) * 10000;
      return x - Math.floor(x);
    };
    
    // Use seed to generate consistent shuffle for same session
    let seedValue = seed ? this.hashString(String(seed)) : Math.random() * 10000;
    
    // Fisher-Yates shuffle
    for (let i = result.length - 1; i > 0; i--) {
      seedValue = seedValue * 9301 + 49297;
      const j = Math.floor(seededRandom(seedValue) * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    
    return result;
  }
  
  /**
   * Simple string hash function for seeding
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
  
  showEmptyState() {
    document.getElementById('emptyState')?.classList.remove('hidden');
  }
  
  hideEmptyState() {
    document.getElementById('emptyState')?.classList.add('hidden');
  }
  
  showToast(message, type = 'info') {
    // Use the standard Gryffi toast notification
    if (window.gryffi && window.gryffi.toast) {
      if (type === 'success') {
        window.gryffi.toast.success(message);
      } else if (type === 'error') {
        window.gryffi.toast.error(message);
      } else {
        window.gryffi.toast.info(message);
      }
    } else {
      console.log(`[${type}] ${message}`);
    }
  }
  
  setSaveState(state) {
    const el = document.getElementById('saveStatus');
    if (!el) return;

    if (state === 'saving') {
      this.activeSaveCount++;
      el.textContent = window.t('builder.status.saving');
      el.classList.remove('hidden', 'text-red-500');
      el.classList.add('text-zen-400');
    } else if (state === 'saved') {
      this.activeSaveCount = Math.max(0, this.activeSaveCount - 1);
      if (this.activeSaveCount === 0) {
        this.lastSavedAt = new Date();
        const time = new Intl.DateTimeFormat(navigator.language, {
          hour: '2-digit', minute: '2-digit'
        }).format(this.lastSavedAt);
        el.textContent = window.t('builder.status.lastSaved', { time });
        el.classList.remove('hidden', 'text-red-500');
        el.classList.add('text-zen-400');
      }
    } else if (state === 'error') {
      this.activeSaveCount = Math.max(0, this.activeSaveCount - 1);
      el.textContent = window.t('builder.status.saveFailed');
      el.classList.remove('hidden', 'text-zen-400');
      el.classList.add('text-red-500');
      if (this.lastSavedAt) {
        setTimeout(() => {
          if (this.activeSaveCount === 0 && this.lastSavedAt) {
            const time = new Intl.DateTimeFormat(navigator.language, {
              hour: '2-digit', minute: '2-digit'
            }).format(this.lastSavedAt);
            el.textContent = window.t('builder.status.lastSaved', { time });
            el.classList.remove('text-red-500');
            el.classList.add('text-zen-400');
          }
        }, 3000);
      }
    }
  }

  async save() {
    if (this.readOnly) return this.showToast(window.t('builder.messages.readOnly'), 'info');
    await this.saveJourney();

    const btn = document.getElementById('saveBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = `✓ ${window.t('builder.messages.savedShort')}`;
    btn.disabled = true;

    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

// Initialize
const _builder = new FlowBuilder();
