/**
 * Gryffi - Main Application JavaScript
 */

function _escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Add subtle animations on page load
document.addEventListener('DOMContentLoaded', () => {
  // Fade in main content
  document.body.classList.add('animate-fade-in');
  
  // Add click handlers for cards
  document.querySelectorAll('.journey-card').forEach(card => {
    card.addEventListener('mouseenter', () => {
      card.style.transform = 'translateY(-4px)';
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
});

// API helper
const api = {
  async fetch(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include',
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'An error occurred');
    }
    
    return data;
  },
  
  get(url) {
    return this.fetch(url);
  },
  
  post(url, body) {
    return this.fetch(url, { method: 'POST', body: JSON.stringify(body) });
  },
  
  put(url, body) {
    return this.fetch(url, { method: 'PUT', body: JSON.stringify(body) });
  },
  
  delete(url) {
    return this.fetch(url, { method: 'DELETE' });
  }
};

// Toast notifications - Gryffi brand style
const toast = {
  show(message, type = 'info') {
    // Remove any existing toasts
    const existingToast = document.querySelector('.gryffi-global-toast');
    if (existingToast) existingToast.remove();

    // Create toast element
    const toastEl = document.createElement('div');
    toastEl.className = 'gryffi-global-toast';
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
    }, 2500);
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
            style="width: 100%; padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; margin-top: 16px; outline: none; transition: border-color 0.2s;"
            onfocus="this.style.borderColor='#0b4b34'" onblur="this.style.borderColor='#e5e7eb'">`
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
      
      // Focus input if prompt
      if (options.showInput) {
        setTimeout(() => document.getElementById('gryffiModalInput')?.focus(), 100);
      }
      
      // Close function
      const close = (result) => {
        modalEl.style.background = 'rgba(0,0,0,0)';
        const content = document.getElementById('gryffiModalContent');
        content.style.transform = 'scale(0.95)';
        content.style.opacity = '0';
        setTimeout(() => modalEl.remove(), 200);
        resolve(result);
      };
      
      // Event handlers
      document.getElementById('gryffiModalCancel')?.addEventListener('click', () => close(options.showInput ? null : false));
      document.getElementById('gryffiModalOk')?.addEventListener('click', () => {
        if (options.showInput) {
          close(document.getElementById('gryffiModalInput').value);
        } else {
          close(options.mode === 'alert' ? true : true);
        }
      });
      
      // Close on backdrop click (except for prompts with required input)
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
          close(options.showInput ? null : (options.mode === 'alert' ? true : false));
        }
      });
      
      // Close on Escape
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', escHandler);
          close(options.showInput ? null : (options.mode === 'alert' ? true : false));
        }
      };
      document.addEventListener('keydown', escHandler);
      
      // Enter to confirm
      const enterHandler = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          document.removeEventListener('keydown', enterHandler);
          if (options.showInput) {
            close(document.getElementById('gryffiModalInput').value);
          } else {
            close(true);
          }
        }
      };
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
      cancelText: options.cancelText || (window.t ? window.t('common.cancel') : 'Cancel')
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
      inputType: options.inputType || 'text',
      placeholder: options.placeholder || '',
      defaultValue: options.defaultValue || '',
      okText: options.okText || (window.t ? window.t('common.confirm') : 'OK'),
      cancelText: options.cancelText || (window.t ? window.t('common.cancel') : 'Cancel')
    });
  }
};

// Export for use in other scripts
window.gryffi = { api, toast, modal };

