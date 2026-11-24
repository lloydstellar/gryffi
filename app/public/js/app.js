/**
 * Gryffi - Main Application JavaScript
 */

function _escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
  // Lift journey cards on hover
  document.querySelectorAll('.journey-card').forEach(card => {
    card.addEventListener('mouseenter', () => {
      card.style.transform = 'translateY(-4px)';
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
});

// Toast notifications - Gryffi brand style
const toast = {
  show(message, type = 'info') {
    // Remove any existing toasts
    const existingToast = document.querySelector('.gryffi-global-toast');
    if (existingToast) existingToast.remove();

    // Create toast element
    const toastEl = document.createElement('div');
    toastEl.className = 'gryffi-global-toast';
    // Screen readers get the message from a live region that is already on
    // the page (errors interrupt, the rest waits); the toast itself is visual
    toastEl.setAttribute('aria-hidden', 'true');
    a11y.announce(message, type === 'error');
    if (type === 'error') toastEl.classList.add('error');
    if (type === 'warning') toastEl.classList.add('warning');
    
    // Create icon based on type
    let iconSvg;
    if (type === 'success') {
      iconSvg = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
    } else if (type === 'error') {
      iconSvg = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
    } else if (type === 'warning') {
      iconSvg = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
    } else {
      iconSvg = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
    }
    
    // Determine colors based on type
    let bgColor, iconBg, iconColor, shadowColor;
    if (type === 'error') {
      bgColor = '#991b1b';
      iconBg = 'rgba(255,255,255,0.2)';
      iconColor = '#fca5a5';
      shadowColor = 'rgba(153, 27, 27, 0.3)';
    } else if (type === 'warning') {
      bgColor = '#b45309';
      iconBg = 'rgba(255,255,255,0.2)';
      iconColor = '#fde68a';
      shadowColor = 'rgba(180, 83, 9, 0.3)';
    } else {
      bgColor = '#0b4b34';
      iconBg = 'rgba(120,197,3,0.25)';
      iconColor = '#78c503';
      shadowColor = 'rgba(11, 75, 52, 0.3)';
    }
    
    toastEl.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <span class="toast-icon" style="display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: ${iconBg}; border-radius: 50%; color: ${iconColor}; flex-shrink: 0;">${iconSvg}</span>
        <span style="color: rgba(255,255,255,0.95);">${_escHtml(message)}</span>
      </div>
    `;
    
    // Apply styles
    Object.assign(toastEl.style, {
      position: 'fixed',
      top: '24px',
      left: '50%',
      transform: 'translateX(-50%) translateY(-20px)',
      background: bgColor,
      color: '#fff',
      padding: '14px 24px',
      borderRadius: '12px',
      fontSize: '14px',
      fontWeight: '500',
      fontFamily: "'Outfit', sans-serif",
      opacity: '0',
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      zIndex: '9999',
      pointerEvents: 'none',
      boxShadow: `0 8px 32px ${shadowColor}, 0 2px 8px rgba(0, 0, 0, 0.1)`
    });
    
    document.body.appendChild(toastEl);
    
    // Trigger animation
    requestAnimationFrame(() => {
      toastEl.style.opacity = '1';
      toastEl.style.transform = 'translateX(-50%) translateY(0)';
    });
    
    // Auto-remove after delay
    setTimeout(() => {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translateX(-50%) translateY(-20px)';
      setTimeout(() => toastEl.remove(), 300);
    }, (type === 'error' || type === 'warning') ? 7000 : 3500); // errors need time to read
  },
  
  success(message) { this.show(message, 'success'); },
  error(message) { this.show(message, 'error'); },
  warning(message) { this.show(message, 'warning'); },
  info(message) { this.show(message, 'info'); }
};

// Modal dialogs - Beautiful replacements for browser alerts/confirms/prompts
const modal = {
  // Internal: Create and show modal
  _show(options) {
    return new Promise((resolve) => {
      // Remove existing modal if any
      document.getElementById('gryffiModal')?.remove();
      
      // Icon based on type
      const iconSvg = options.type === 'warning' 
        ? `<svg style="width: 24px; height: 24px; color: #f59e0b;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>`
        : options.type === 'error'
        ? `<svg style="width: 24px; height: 24px; color: #ef4444;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>`
        : options.type === 'success'
        ? `<svg style="width: 24px; height: 24px; color: #0b4b34;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>`
        : `<svg style="width: 24px; height: 24px; color: #0b4b34;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>`;
      
      const iconBg = options.type === 'warning' ? '#fef3c7' 
        : options.type === 'error' ? '#fee2e2' 
        : '#ecf2eb';
      
      // Input field for prompt
      const inputHtml = options.showInput 
        ? `<input type="${_escHtml(options.inputType || 'text')}" id="gryffiModalInput" 
            placeholder="${_escHtml(options.placeholder || '')}" 
            value="${_escHtml(options.defaultValue || '')}"
            style="width: 100%; padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; margin-top: 16px; outline: none; transition: border-color 0.2s;">`
        : '';
      
      // Buttons based on mode
      let buttonsHtml = '';
      if (options.mode === 'alert') {
        buttonsHtml = `
          <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
            <button id="gryffiModalOk" style="padding: 10px 20px; background: #0b4b34; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;">
              ${_escHtml(options.okText || 'OK')}
            </button>
          </div>`;
      } else {
        const confirmBtnStyle = options.danger 
          ? 'background: #dc2626; color: white;' 
          : 'background: #0b4b34; color: white;';
        buttonsHtml = `
          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
            <button id="gryffiModalCancel" style="padding: 10px 20px; color: #64748b; background: transparent; border: 1px solid #e5e7eb; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;">
              ${_escHtml(options.cancelText || 'Cancel')}
            </button>
            <button id="gryffiModalOk" style="padding: 10px 20px; ${confirmBtnStyle} border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;">
              ${_escHtml(options.okText || 'OK')}
            </button>
          </div>`;
      }
      
      // Create modal
      const maxWidth = options.size === 'large' ? '600px' : options.size === 'medium' ? '500px' : '400px';
      const messageHtml = options.html
        ? `<div style="font-size: 14px; color: #4b5563; margin: 0; line-height: 1.5;">${options.message}</div>`
        : `<p style="font-size: 14px; color: #4b5563; margin: 0; line-height: 1.5;">${_escHtml(options.message)}</p>`;
      
      const modalEl = document.createElement('div');
      modalEl.id = 'gryffiModal';
      modalEl.style.cssText = 'position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0); transition: background 0.2s;';
      modalEl.innerHTML = `
        <div id="gryffiModalContent" style="background: white; border-radius: 16px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); max-width: ${maxWidth}; width: calc(100% - 32px); margin: 16px; padding: 24px; transform: scale(0.95); opacity: 0; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);">
          <div style="display: flex; align-items: flex-start; gap: 16px;">
            <div style="flex-shrink: 0; width: 48px; height: 48px; border-radius: 50%; background: ${iconBg}; display: flex; align-items: center; justify-content: center;">
              ${iconSvg}
            </div>
            <div style="flex: 1; min-width: 0;">
              ${options.title ? `<h3 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 8px 0;">${_escHtml(options.title)}</h3>` : ''}
              ${messageHtml}
              ${inputHtml}
              <p id="gryffiModalError" role="alert" style="display: none; font-size: 14px; color: #b91c1c; margin: 12px 0 0 0; line-height: 1.5;"></p>
            </div>
          </div>
          ${buttonsHtml}
        </div>
      `;
      
      document.body.appendChild(modalEl);
      
      // Animate in
      requestAnimationFrame(() => {
        modalEl.style.background = 'rgba(0,0,0,0.5)';
        const content = document.getElementById('gryffiModalContent');
        content.style.transform = 'scale(1)';
        content.style.opacity = '1';
      });
      
      // Focus input if prompt (focus color via listeners: the CSP blocks inline handlers)
      if (options.showInput) {
        const promptInput = document.getElementById('gryffiModalInput');
        promptInput?.addEventListener('focus', () => { promptInput.style.borderColor = '#0b4b34'; });
        promptInput?.addEventListener('blur', () => { promptInput.style.borderColor = '#e5e7eb'; });
        setTimeout(() => promptInput?.focus(), 100);
      }
      
      // Close function (once; also drops the keyboard handlers)
      let closed = false;
      const close = (result) => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', escHandler);
        document.removeEventListener('keydown', enterHandler);
        modalEl.style.background = 'rgba(0,0,0,0)';
        const content = document.getElementById('gryffiModalContent');
        content.style.transform = 'scale(0.95)';
        content.style.opacity = '0';
        setTimeout(() => modalEl.remove(), 200);
        resolve(result);
      };
      
      // OK / Enter: an optional validate() returns a message to show in the
      // dialog instead of closing it, so nothing the user entered is lost
      const confirmModal = () => {
        if (typeof options.validate === 'function') {
          const problem = options.validate();
          if (problem) {
            const errorEl = document.getElementById('gryffiModalError');
            errorEl.textContent = problem;
            errorEl.style.display = 'block';
            return;
          }
        }
        close(options.showInput ? document.getElementById('gryffiModalInput').value : true);
      };

      // Event handlers
      document.getElementById('gryffiModalCancel')?.addEventListener('click', () => close(options.showInput ? null : false));
      document.getElementById('gryffiModalOk')?.addEventListener('click', confirmModal);
      
      // Close on backdrop click (except for prompts with required input)
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
          close(options.showInput ? null : (options.mode === 'alert' ? true : false));
        }
      });
      
      // Close on Escape
      function escHandler(e) {
        if (e.key === 'Escape') {
          close(options.showInput ? null : (options.mode === 'alert' ? true : false));
        }
      }
      document.addEventListener('keydown', escHandler);
      
      // Enter to confirm (not on a button: Enter on Cancel means Cancel)
      function enterHandler(e) {
        if (e.key === 'Enter' && !e.shiftKey && e.target?.tagName !== 'BUTTON') {
          e.preventDefault();
          confirmModal();
        }
      }
      document.addEventListener('keydown', enterHandler);
    });
  },
  
  // Alert - info message with OK button
  alert(message, options = {}) {
    return this._show({
      mode: 'alert',
      message,
      title: options.title,
      type: options.type || 'info',
      okText: options.okText || (window.t ? window.t('common.ok') : 'OK')
    });
  },
  
  // Confirm - yes/no question
  confirm(message, options = {}) {
    return this._show({
      mode: 'confirm',
      message,
      title: options.title,
      type: options.type || 'warning',
      danger: options.danger !== false,
      html: options.html || false,
      size: options.size,
      okText: options.confirmText || options.okText || (window.t ? window.t('common.confirm') : 'OK'),
      cancelText: options.cancelText || (window.t ? window.t('common.cancel') : 'Cancel'),
      validate: options.validate
    });
  },
  
  // Prompt - input field
  prompt(message, options = {}) {
    return this._show({
      mode: 'prompt',
      message,
      title: options.title,
      type: options.type || 'info',
      html: options.html || false,
      danger: options.danger || false,
      showInput: true,
      validate: options.validate,
      inputType: options.inputType || 'text',
      placeholder: options.placeholder || '',
      defaultValue: options.defaultValue || '',
      okText: options.okText || (window.t ? window.t('common.confirm') : 'OK'),
      cancelText: options.cancelText || (window.t ? window.t('common.cancel') : 'Cancel')
    });
  }
};

/**
 * Check a journey before publishing: fetches GET /api/journeys/:id/publish-check
 * and, when something needs attention, shows the issues in a dialog.
 * @param {string} journeyId
 * @param {{onGoToStep?: function(string): void}} [options] - called with a step id
 *   when the maker picks "Go to this step"; without it the button is hidden
 * @returns {Promise<'clear'|'publish'|'cancel'>} 'clear': nothing found (or the
 *   check could not run; the server still blocks a journey without start or end),
 *   'publish': the maker chose to publish anyway, 'cancel': do not publish
 */
async function publishCheck(journeyId, options = {}) {
  let data;
  try {
    const response = await fetch(`/api/journeys/${encodeURIComponent(journeyId)}/publish-check`);
    data = await response.json();
    if (!response.ok || !data.success) return 'clear';
  } catch (err) {
    console.error('[PublishCheck] Check failed:', err);
    return 'clear';
  }
  const issues = Array.isArray(data.issues) ? data.issues : [];
  if (issues.length === 0) return 'clear';

  const labels = data.labels || {};
  const blocking = issues.some(i => i.blocking);
  const canGoTo = typeof options.onGoToStep === 'function';
  const previousFocus = document.activeElement;

  return new Promise((resolve) => {
    document.getElementById('gryffiPublishCheck')?.remove();

    const warningIcon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>';
    const blockIcon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>';

    const itemsHtml = issues.map((issue, index) => `
      <li style="display: flex; gap: 10px; align-items: flex-start; padding: 12px 0; ${index > 0 ? 'border-top: 1px solid #f1f5f9;' : ''}">
        <svg aria-hidden="true" style="flex-shrink: 0; width: 20px; height: 20px; margin-top: 1px; color: ${issue.blocking ? '#dc2626' : '#d97706'};" fill="none" stroke="currentColor" viewBox="0 0 24 24">${issue.blocking ? blockIcon : warningIcon}</svg>
        <div style="flex: 1; min-width: 0;">
          <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #374151; overflow-wrap: anywhere;">${_escHtml(issue.message)}</p>
          ${canGoTo && issue.stepId ? `<button type="button" class="publish-check-goto" data-step-id="${_escHtml(issue.stepId)}" style="margin-top: 4px; padding: 2px 0; background: none; border: none; color: #0b4b34; font-size: 14px; font-weight: 500; text-decoration: underline; cursor: pointer;">${_escHtml(labels.goToStep || 'Go to this step')}</button>` : ''}
        </div>
      </li>`).join('');

    const buttonBase = 'padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500;';
    const buttonsHtml = blocking
      ? `<button type="button" id="publishCheckClose" style="${buttonBase} background: #0b4b34; color: white; border: none;">${_escHtml(labels.close || 'Close')}</button>`
      : `<button type="button" id="publishCheckCancel" style="${buttonBase} color: #475569; background: white; border: 1px solid #e5e7eb;">${_escHtml(labels.cancel || 'Cancel')}</button>
         <button type="button" id="publishCheckPublish" style="${buttonBase} background: #0b4b34; color: white; border: none;">${_escHtml(labels.publishAnyway || 'Publish anyway')}</button>`;

    const overlay = document.createElement('div');
    overlay.id = 'gryffiPublishCheck';
    overlay.style.cssText = 'position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.5);';
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="publishCheckTitle" aria-describedby="publishCheckIntro"
           style="background: white; border-radius: 16px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); max-width: 560px; width: calc(100% - 32px); max-height: calc(100vh - 32px); display: flex; flex-direction: column; padding: 24px;">
        <h2 id="publishCheckTitle" style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 8px 0;">${_escHtml(labels.title || '')}</h2>
        <p id="publishCheckIntro" style="font-size: 14px; color: #4b5563; margin: 0; line-height: 1.5;">${_escHtml(blocking ? labels.introBlocking : labels.intro)}</p>
        <ul style="list-style: none; margin: 12px 0 0 0; padding: 0; overflow-y: auto;">${itemsHtml}</ul>
        <div style="display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 12px; margin-top: 20px;">${buttonsHtml}</div>
      </div>`;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('[role="dialog"]');
    const focusables = () => Array.from(dialog.querySelectorAll('button'));

    const close = (result, keepFocus = false) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (!keepFocus && previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(result);
    };

    // Escape closes; Tab stays inside the dialog
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close('cancel');
      } else if (e.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey, true);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close('cancel');
    });
    overlay.querySelector('#publishCheckClose')?.addEventListener('click', () => close('cancel'));
    overlay.querySelector('#publishCheckCancel')?.addEventListener('click', () => close('cancel'));
    overlay.querySelector('#publishCheckPublish')?.addEventListener('click', () => close('publish'));
    overlay.querySelectorAll('.publish-check-goto').forEach(btn => {
      btn.addEventListener('click', () => {
        close('cancel', true);
        options.onGoToStep(btn.dataset.stepId);
      });
    });

    (overlay.querySelector('#publishCheckClose') || overlay.querySelector('#publishCheckCancel'))?.focus();
  });
}

/**
 * Accessible dialogs and action menus for every page that loads app.js.
 *
 * Dialogs: an element with data-dialog, or with an id that ends in "Modal",
 * is treated as a dialog while it is visible. Screen readers get
 * role="dialog", aria-modal and a name from its first heading. Focus moves
 * into it (to its first field, or to the dialog itself), Tab stays inside,
 * Escape presses its close or cancel button when the dialog's own code did
 * not close it, and focus goes back to what opened it. Dialogs that do all of
 * this themselves carry data-dialog-manual and are left alone.
 *
 * Menus: a .kebab-menu-btn next to a .kebab-menu-dropdown gets a name with the
 * item it belongs to, aria-expanded, arrow keys, Home/End and Escape. Opened
 * with the keyboard, focus goes to the first item.
 *
 * Tabs: buttons with the class analytics-tab, settings-tab or panel-tab work
 * as tabs: role="tab", aria-selected follows the "active" class, and the
 * arrow keys, Home and End move to another tab and open it.
 *
 * Messages: toasts are read out through two live regions that exist from page
 * load, because screen readers often skip a live region that appears together
 * with its text.
 */
const a11y = (() => {
  const DIALOG_SELECTOR = '[data-dialog], [id$="Modal"]';
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const CLOSE_SELECTOR = '[data-dialog-close], [id$="Close"], [id$="CloseBtn"], [id$="Cancel"], [id$="CancelBtn"], [id^="close"], [id^="cancel"], button[class*="close"]';
  const open = [];
  let scheduled = false;
  let keyboardUsed = false;

  const isVisible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const focusablesIn = (el) => Array.from(el.querySelectorAll(FOCUSABLE)).filter(isVisible);

  function prepareDialog(el) {
    const panel = el.matches('[role="dialog"]') ? el : (el.querySelector('[role="dialog"]') || el);
    if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    if (!panel.hasAttribute('aria-labelledby') && !panel.hasAttribute('aria-label')) {
      const heading = Array.from(panel.querySelectorAll('h1, h2, h3, h4')).find(isVisible);
      if (heading) {
        if (!heading.id) heading.id = 'dialog-title-' + Math.random().toString(36).slice(2, 10);
        panel.setAttribute('aria-labelledby', heading.id);
      }
    }
    return panel;
  }

  function onOpen(el) {
    const focused = document.activeElement;
    const opener = focused && focused !== document.body && !el.contains(focused) ? focused : null;
    const panel = prepareDialog(el);
    const wasHidden = el.getAttribute('aria-hidden') === 'true';
    if (wasHidden) el.setAttribute('aria-hidden', 'false');
    open.push({ el, panel, opener, wasHidden });
    // The dialog's own code may place focus first (a prompt field, a button)
    setTimeout(() => {
      if (!isVisible(el) || el.contains(document.activeElement)) return;
      const field = focusablesIn(el).find(n => n.matches('[autofocus], input:not([type="checkbox"]):not([type="radio"]), select, textarea'));
      if (field) {
        field.focus();
      } else {
        if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        panel.style.outline = 'none';
        panel.focus({ preventScroll: true });
      }
    }, 120);
  }

  function onClose({ el, opener, wasHidden }) {
    if (wasHidden && el.isConnected) el.setAttribute('aria-hidden', 'true');
    const focused = document.activeElement;
    const focusLost = !focused || focused === document.body || el.contains(focused) || !isVisible(focused);
    if (!focusLost) return;
    let target = opener;
    // A menu item that opened the dialog is hidden again: use its menu button
    if (target && !isVisible(target)) target = target.closest('.kebab-menu-container')?.querySelector('.kebab-menu-btn') || null;
    if (target && isVisible(target)) target.focus({ preventScroll: true });
  }

  function setupMenus() {
    document.querySelectorAll('.kebab-menu-btn:not([data-menu-ready])').forEach(btn => {
      const menu = btn.parentElement?.querySelector('.kebab-menu-dropdown');
      if (!menu) return;
      btn.dataset.menuReady = '1';
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      const name = menu.dataset.journeyTitle || menu.dataset.guideName || '';
      if (name && !btn.hasAttribute('aria-label')) btn.setAttribute('aria-label', `${btn.title || ''}: ${name}`);
      menu.setAttribute('role', 'menu');
      menu.querySelectorAll('.kebab-menu-item').forEach(item => {
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '-1');
      });
      menu.querySelectorAll('.kebab-menu-divider').forEach(d => d.setAttribute('role', 'separator'));
      new MutationObserver(() => {
        const isOpen = menu.classList.contains('show');
        if (btn.getAttribute('aria-expanded') === String(isOpen)) return;
        btn.setAttribute('aria-expanded', String(isOpen));
        if (isOpen && keyboardUsed) focusWhenShown(menuItems(menu)[0], btn);
      }).observe(menu, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // A menu that fades in is visibility: hidden for a moment: focus does not
  // stick yet, or drops back to the page. Keep trying for a short while, as
  // long as focus is still on the page or on the menu button.
  function focusWhenShown(el, button, tries = 15) {
    if (!el || !el.closest('.kebab-menu-dropdown')?.classList.contains('show')) return;
    const focused = document.activeElement;
    if (focused === document.body || focused === button) el.focus();
    if (tries > 0) setTimeout(() => focusWhenShown(el, button, tries - 1), 30);
  }

  // Not isVisible, for the same reason
  const TAB_SELECTOR = '.analytics-tab, .settings-tab, .panel-tab';

  function syncTabs() {
    document.querySelectorAll(TAB_SELECTOR).forEach(tab => {
      if (tab.parentElement && tab.parentElement.getAttribute('role') !== 'tablist') tab.parentElement.setAttribute('role', 'tablist');
      if (tab.getAttribute('role') !== 'tab') tab.setAttribute('role', 'tab');
      const selected = tab.classList.contains('active');
      if (tab.getAttribute('aria-selected') !== String(selected)) tab.setAttribute('aria-selected', String(selected));
      const index = selected ? '0' : '-1';
      if (tab.getAttribute('tabindex') !== index) tab.setAttribute('tabindex', index);
    });
  }

  const menuItems = (menu) => Array.from(menu.querySelectorAll('.kebab-menu-item')).filter(item => item.getClientRects().length > 0 && !item.disabled);

  function check() {
    scheduled = false;
    setupMenus();
    syncTabs();
    const shown = Array.from(document.querySelectorAll(DIALOG_SELECTOR))
      .filter(el => !el.hasAttribute('data-dialog-manual') && isVisible(el));
    for (let i = open.length - 1; i >= 0; i--) {
      if (!shown.includes(open[i].el)) onClose(open.splice(i, 1)[0]);
    }
    shown.forEach(el => { if (!open.some(o => o.el === el)) onOpen(el); });
  }

  function schedule(records) {
    if (scheduled) return;
    // Moving steps on the builder canvas changes styles all the time; that never opens a dialog
    if (records && records.every(r => r.target.closest?.('#canvas'))) return;
    scheduled = true;
    requestAnimationFrame(check);
  }

  function liveRegion(id, assertive) {
    let region = document.getElementById(id);
    if (region) return region;
    region = document.createElement('div');
    region.id = id;
    region.setAttribute('role', assertive ? 'alert' : 'status');
    region.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
    region.style.cssText = 'position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;';
    document.body.appendChild(region);
    return region;
  }

  /**
   * Read a message out to screen reader users.
   * @param {string} message
   * @param {boolean} [assertive] - true for errors: interrupts what is being read
   */
  function announce(message, assertive = false) {
    if (!document.body) return;
    const region = liveRegion(assertive ? 'gryffiLiveAlert' : 'gryffiLiveStatus', assertive);
    region.textContent = '';
    setTimeout(() => { region.textContent = message; }, 60);
  }

  function init() {
    liveRegion('gryffiLiveStatus', false);
    liveRegion('gryffiLiveAlert', true);
    check();
    new MutationObserver(schedule).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    });
  }

  document.addEventListener('pointerdown', () => { keyboardUsed = false; }, true);
  document.addEventListener('keydown', (e) => {
    keyboardUsed = true;

    // Action menus
    const btnTarget = e.target.closest?.('.kebab-menu-btn');
    const menu = e.target.closest?.('.kebab-menu-dropdown.show') ||
      (btnTarget?.getAttribute('aria-expanded') === 'true' ? btnTarget.parentElement.querySelector('.kebab-menu-dropdown') : null);
    if (menu) {
      const items = menuItems(menu);
      const index = items.indexOf(document.activeElement);
      const btn = menu.parentElement.querySelector('.kebab-menu-btn');
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(index + 1) % items.length]?.focus(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); return; }
      if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); return; }
      if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); btn?.click(); btn?.focus(); return; }
      if (e.key === 'Tab') { btn?.click(); return; }
    }

    // Tabs
    const tab = e.target.closest?.(TAB_SELECTOR);
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      const tabs = Array.from(tab.parentElement.querySelectorAll(':scope > ' + TAB_SELECTOR.split(', ').join(', :scope > '))).filter(isVisible);
      const index = tabs.indexOf(tab);
      const next = e.key === 'Home' ? tabs[0]
        : e.key === 'End' ? tabs[tabs.length - 1]
          : tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      if (next && next !== tab) {
        e.preventDefault();
        next.click();
        next.focus();
      }
      return;
    }

    // Dialogs
    const top = open[open.length - 1];
    if (!top) return;
    if (e.key === 'Tab') {
      const list = focusablesIn(top.el);
      if (list.length === 0) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const focused = document.activeElement;
      if (!top.el.contains(focused)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (focused === first || focused === top.panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && focused === last) { e.preventDefault(); first.focus(); }
    } else if (e.key === 'Escape') {
      // The dialog's own Escape handling goes first (and may animate out)
      setTimeout(() => {
        if (open[open.length - 1] !== top || !isVisible(top.el)) return;
        const closeBtn = Array.from(top.el.querySelectorAll(CLOSE_SELECTOR)).find(isVisible);
        closeBtn?.click();
      }, 350);
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { announce };
})();

/**
 * "Send it to yourself": publish the journey (after the usual publish check
 * when it is still a draft) and email the maker an invitation, through
 * POST /api/journeys/:id/send-to-self. Callers show the result.
 * @param {string} journeyId
 * @param {{ isDraft?: boolean }} [options]
 * @returns {Promise<Object>} the server answer plus `ok`, or { cancelled: true }
 */
async function sendToSelf(journeyId, options = {}) {
  if (options.isDraft !== false) {
    const check = await publishCheck(journeyId);
    if (check === 'cancel') return { cancelled: true };
  }
  try {
    const response = await fetch(`/api/journeys/${encodeURIComponent(journeyId)}/send-to-self`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    const data = await response.json().catch(() => ({}));
    return { ...data, ok: response.ok && data.success === true };
  } catch (err) {
    console.error('[SendToSelf] Request failed:', err);
    return { ok: false };
  }
}

/**
 * The sentence to show after sendToSelf. `texts` holds the sendToSelf.*
 * translations of the page (sent, alreadyInvited, emailFailed, errors.failed).
 * Show it as text (textContent), never as HTML.
 * @returns {{ kind: 'success'|'info'|'error', text: string }}
 */
function sendToSelfMessage(result, texts) {
  const fill = (str) => String(str || '').replace('{{email}}', result.email || '');
  if (result.ok && result.emailError) return { kind: 'error', text: texts.emailFailed };
  if (result.ok && result.alreadyInvited) return { kind: 'info', text: fill(texts.alreadyInvited) };
  if (result.ok) return { kind: 'success', text: fill(texts.sent) };
  return { kind: 'error', text: result.error || texts.failed };
}

/**
 * Plan limits that the page blocks in the browser (a disabled create button,
 * an upgrade link) never reach the server on their own. Elements with
 * data-limit-hit="journeys|guides|makers|endUsers" report a click to
 * POST /api/limit-hits (data-limit-source: 'button' by default, or
 * 'upgrade_link'). A blocked button also fires a 'gryffi:limit-hit' event,
 * so the page can explain the limit.
 */
function recordLimitHit(limitType, source = 'button') {
  try {
    fetch('/api/limit-hits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limitType, source }),
      keepalive: true
    }).catch(() => {});
  } catch (_err) { /* measuring must never break the page */ }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-limit-hit]');
  if (!el) return;
  const limitType = el.dataset.limitHit;
  const source = el.dataset.limitSource || 'button';
  recordLimitHit(limitType, source);
  if (source === 'button') {
    e.preventDefault();
    document.dispatchEvent(new CustomEvent('gryffi:limit-hit', { detail: { limitType } }));
  }
});

// Export for use in other scripts
window.gryffi = { toast, modal, publishCheck, sendToSelf, sendToSelfMessage, announce: a11y.announce, recordLimitHit };

