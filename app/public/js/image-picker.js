/**
 * Gryffi Image Picker - Hybrid Edition
 * Zen-styled image selection with Pexels integration and uploads
 */

class ImagePicker {
  constructor() {
    this.modal = null;
    this.currentTab = 'suggested';
    this.onSelect = null;
    this.stepType = 'space';
    this.stepTitle = '';
    this.searchQuery = '';
    this.searchResults = [];
    this.library = [];
    this.suggestions = [];
    this.isLoading = false;
    
    // Don't create modal in player mode - it's not needed
    if (window.GRYFFI?.playerMode) {
      console.log('[ImagePicker] Player mode detected, skipping modal creation');
      return;
    }
    
    this.createModal();
    
    // Apply translations after DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.updateTranslations());
    } else {
      // Small delay to ensure translations are loaded
      setTimeout(() => this.updateTranslations(), 100);
    }
  }
  
  // Translation helper - uses window.t if available, otherwise returns default
  t(key, fallback, params = {}) {
    // First try window.t function
    if (typeof window.t === 'function') {
      const translated = window.t(key, params);
      // If translation returns the key itself, use fallback
      if (translated !== key) {
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
        // Handle interpolation
        for (const [param, replacement] of Object.entries(params)) {
          // eslint-disable-next-line security/detect-non-literal-regexp -- param names are developer-defined translation placeholders, not user input
          value = value.replace(new RegExp(`{{${param}}}`, 'g'), replacement);
        }
        return value;
      }
    }
    
    // Handle simple interpolation for fallback
    let result = fallback;
    for (const [param, value] of Object.entries(params)) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- param names are developer-defined translation placeholders, not user input
      result = result.replace(new RegExp(`{{${param}}}`, 'g'), value);
    }
    return result;
  }
  
  createModal() {
    // Create modal HTML
    const modalHtml = `
      <div id="imagePickerModal" class="image-picker-overlay hidden">
        <div class="image-picker-modal">
          <!-- Header -->
          <div class="image-picker-header">
            <h2 class="text-lg font-semibold text-zen-900" id="imagePickerTitle">Choose Image</h2>
            <button class="image-picker-close" id="closeImagePicker">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </button>
          </div>
          
          <!-- Tabs -->
          <div class="image-picker-tabs">
            <button class="image-picker-tab active" data-tab="suggested">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"></path>
              </svg>
              <span data-i18n="suggested">Suggested</span>
            </button>
            <button class="image-picker-tab" data-tab="search">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
              </svg>
              <span data-i18n="search">Search</span>
            </button>
            <button class="image-picker-tab" data-tab="library">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
              </svg>
              <span data-i18n="library">Library</span>
            </button>
            <button class="image-picker-tab" data-tab="upload">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path>
              </svg>
              <span data-i18n="upload">Upload</span>
            </button>
          </div>
          
          <!-- Content -->
          <div class="image-picker-content">
            <!-- Suggested Tab -->
            <div class="image-picker-panel" data-panel="suggested">
              <div id="suggestedGrid" class="image-picker-grid">
                <!-- Loaded via JS -->
              </div>
            </div>
            
            <!-- Search Tab -->
            <div class="image-picker-panel hidden" data-panel="search">
              <div class="image-picker-search">
                <input type="text" id="imageSearchInput" class="input" data-i18n-placeholder="searchPlaceholder" placeholder="Search for images..." />
                <button id="imageSearchBtn" class="btn-primary">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
                  </svg>
                </button>
              </div>
              <div id="searchGrid" class="image-picker-grid">
                <div class="image-picker-empty">
                  <p class="text-zen-500" data-i18n="searchHint">Search for images on Pexels</p>
                </div>
              </div>
            </div>
            
            <!-- Library Tab -->
            <div class="image-picker-panel hidden" data-panel="library">
              <div id="libraryGrid" class="image-picker-grid">
                <!-- Loaded via JS -->
              </div>
            </div>
            
            <!-- Upload Tab -->
            <div class="image-picker-panel hidden" data-panel="upload">
              <div class="image-picker-upload-zone" id="uploadZone">
                <input type="file" id="imageUploadInput" accept="image/jpeg,image/png,image/gif,image/webp" class="hidden" />
                <div class="upload-placeholder">
                  <svg class="w-12 h-12 text-zen-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                  </svg>
                  <p class="text-zen-600 font-medium mb-1" data-i18n="dropHere">Drop image here or click to upload</p>
                  <p class="text-zen-400 text-sm" data-i18n="fileTypes">JPEG, PNG, GIF, WebP up to 10MB</p>
                </div>
                <div class="upload-progress hidden">
                  <div class="upload-progress-bar"></div>
                  <p class="text-zen-600 text-sm mt-2" data-i18n="uploading">Uploading...</p>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Footer -->
          <div class="image-picker-footer">
            <div class="flex items-center gap-2 text-xs text-zen-400">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path>
              </svg>
              <span data-i18n="pexelsCredit">Photos provided by <a href="https://www.pexels.com" target="_blank" class="underline hover:text-zen-600">Pexels</a></span>
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Add to DOM
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    this.modal = document.getElementById('imagePickerModal');
    
    this.bindEvents();
  }
  
  // Update all translatable elements in the modal
  updateTranslations() {
    if (!this.modal) return;
    
    // Title
    const title = this.modal.querySelector('#imagePickerTitle');
    if (title) title.textContent = this.t('imagePicker.title', 'Choose Image');
    
    // Tab labels
    const translations = {
      'suggested': this.t('imagePicker.suggested', 'Suggested'),
      'search': this.t('imagePicker.search', 'Search'),
      'library': this.t('imagePicker.library', 'Library'),
      'upload': this.t('imagePicker.upload', 'Upload'),
      'searchPlaceholder': this.t('imagePicker.searchPlaceholder', 'Search for images...'),
      'searchHint': this.t('imagePicker.searchHint', 'Search for images on Pexels'),
      'dropHere': this.t('imagePicker.dropHere', 'Drop image here or click to upload'),
      'fileTypes': this.t('imagePicker.fileTypes', 'JPEG, PNG, GIF, WebP up to 10MB'),
      'uploading': this.t('imagePicker.uploading', 'Uploading...'),
      'pexelsCredit': this.t('imagePicker.pexelsCredit', 'Photos provided by <a href="https://www.pexels.com" target="_blank" class="underline hover:text-zen-600">Pexels</a>')
    };
    
    // Update elements with data-i18n attributes
    this.modal.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (translations[key]) {
        el.innerHTML = translations[key];
      }
    });
    
    // Update placeholder
    const searchInput = this.modal.querySelector('[data-i18n-placeholder]');
    if (searchInput) {
      searchInput.placeholder = translations['searchPlaceholder'];
    }
  }
  
  bindEvents() {
    // Close button - use event delegation on modal
    const closeBtn = this.modal?.querySelector('#closeImagePicker');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      });
    }
    
    // Click outside to close — require both mousedown AND mouseup on overlay
    // to prevent accidental closes when the user's cursor drifts slightly
    // outside a form field while clicking
    let overlayMouseDown = false;
    this.modal?.addEventListener('mousedown', (e) => {
      overlayMouseDown = e.target === this.modal;
    });
    this.modal?.addEventListener('mouseup', (e) => {
      if (overlayMouseDown && e.target === this.modal) {
        this.close();
      }
      overlayMouseDown = false;
    });
    
    // ESC key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.modal?.classList.contains('hidden')) {
        this.close();
      }
    });
    
    // Tab switching
    this.modal?.querySelectorAll('.image-picker-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });
    
    // Search
    document.getElementById('imageSearchBtn')?.addEventListener('click', () => this.search());
    document.getElementById('imageSearchInput')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.search();
    });
    
    // Upload zone - only within the modal to avoid conflicts with other upload zones
    const uploadZone = this.modal?.querySelector('#uploadZone');
    const uploadInput = this.modal?.querySelector('#imageUploadInput');
    
    uploadZone?.addEventListener('click', () => uploadInput?.click());
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
      const files = e.dataTransfer.files;
      if (files.length > 0) this.uploadFile(files[0]);
    });
    uploadInput?.addEventListener('change', (e) => {
      if (e.target.files.length > 0) this.uploadFile(e.target.files[0]);
    });
  }
  
  open(options = {}) {
    const { onSelect, stepType = 'space', stepTitle = '' } = options;
    
    this.onSelect = onSelect;
    this.stepType = stepType;
    this.stepTitle = stepTitle;
    
    // Update translations before showing
    this.updateTranslations();
    
    this.modal?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    
    // Load suggestions
    this.switchTab('suggested');
    this.loadSuggestions();
  }
  
  close() {
    this.modal?.classList.add('hidden');
    document.body.style.overflow = '';
    this.onSelect = null;
  }
  
  switchTab(tab) {
    this.currentTab = tab;
    
    // Update tab styles
    this.modal?.querySelectorAll('.image-picker-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    
    // Show/hide panels
    this.modal?.querySelectorAll('.image-picker-panel').forEach(p => {
      p.classList.toggle('hidden', p.dataset.panel !== tab);
    });
    
    // Load content for tab
    switch (tab) {
      case 'suggested':
        if (this.suggestions.length === 0) this.loadSuggestions();
        break;
      case 'library':
        this.loadLibrary();
        break;
    }
  }
  
  async loadSuggestions() {
    const grid = document.getElementById('suggestedGrid');
    if (!grid) return;
    
    grid.innerHTML = this.renderLoading();
    
    try {
      const response = await fetch(`/api/media/suggestions?type=${this.stepType}&title=${encodeURIComponent(this.stepTitle)}`);
      const data = await response.json();
      
      if (data.success && data.photos.length > 0) {
        this.suggestions = data.photos;
        grid.innerHTML = this.renderPhotoGrid(data.photos, 'pexels');
        this.bindPhotoClicks(grid);
      } else {
        grid.innerHTML = this.renderEmpty(this.t('imagePicker.noSuggestions', 'No suggestions available. Try searching.'));
      }
    } catch (err) {
      console.error('Load suggestions error:', err);
      grid.innerHTML = this.renderEmpty(this.t('imagePicker.loadFailed', 'Failed to load suggestions'));
    }
  }
  
  async search() {
    const input = document.getElementById('imageSearchInput');
    const query = input?.value?.trim();
    
    if (!query || query.length < 2) return;
    
    const grid = document.getElementById('searchGrid');
    if (!grid) return;
    
    grid.innerHTML = this.renderLoading();
    
    try {
      const response = await fetch(`/api/media/search?q=${encodeURIComponent(query)}&per_page=15`);
      const data = await response.json();
      
      if (data.success && data.photos.length > 0) {
        this.searchResults = data.photos;
        grid.innerHTML = this.renderPhotoGrid(data.photos, 'pexels');
        this.bindPhotoClicks(grid);
      } else {
        grid.innerHTML = this.renderEmpty(this.t('imagePicker.noResults', 'No images found for "{{query}}"', { query }));
      }
    } catch (err) {
      console.error('Search error:', err);
      grid.innerHTML = this.renderEmpty(this.t('imagePicker.searchFailed', 'Search failed'));
    }
  }
  
  async loadLibrary() {
    const grid = document.getElementById('libraryGrid');
    if (!grid) return;
    
    grid.innerHTML = this.renderLoading();
    
    try {
      const response = await fetch('/api/media/library?per_page=20');
      const data = await response.json();
      
      if (data.success && data.media.length > 0) {
        this.library = data.media;
        grid.innerHTML = this.renderLibraryGrid(data.media);
        this.bindPhotoClicks(grid);
      } else {
        grid.innerHTML = this.renderEmpty(this.t('imagePicker.emptyLibrary', 'No images in your library yet. Search Pexels or upload your own.'));
      }
    } catch (err) {
      console.error('Library error:', err);
      grid.innerHTML = this.renderEmpty(this.t('imagePicker.libraryFailed', 'Failed to load library'));
    }
  }
  
  async uploadFile(file) {
    if (!file) return;
    
    // Only use uploadZone within the modal to avoid conflicts with other upload zones
    const uploadZone = this.modal?.querySelector('#uploadZone');
    if (!uploadZone) {
      console.warn('[ImagePicker] Upload zone not found in modal');
      return;
    }
    
    const placeholder = uploadZone?.querySelector('.upload-placeholder');
    const progress = uploadZone?.querySelector('.upload-progress');
    
    // Validate - only for image picker (not knowledge uploads)
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      await window.gryffi.modal.alert(this.t('imagePicker.invalidType', 'Invalid file type. Please upload JPEG, PNG, GIF, or WebP.'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      await window.gryffi.modal.alert(this.t('imagePicker.fileTooLarge', 'File too large. Maximum size is 10MB.'));
      return;
    }
    
    // Show progress
    placeholder?.classList.add('hidden');
    progress?.classList.remove('hidden');
    
    try {
      const formData = new FormData();
      formData.append('image', file);
      
      const response = await fetch('/api/media/upload', {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (data.success) {
        // Select the uploaded image
        this.selectImage({
          url: data.url,
          source: 'upload',
          photographer: null
        });
      } else {
        throw new Error(data.error || 'Upload failed');
      }
    } catch (err) {
      console.error('Upload error:', err);
      await window.gryffi.modal.alert(this.t('imagePicker.uploadFailed', 'Upload failed. Please try again.'), { type: 'error' });
    } finally {
      placeholder?.classList.remove('hidden');
      progress?.classList.add('hidden');
    }
  }
  
  async selectPexelsPhoto(photo) {
    // Show loading state
    const card = document.querySelector(`[data-photo-id="${photo.id}"]`);
    card?.classList.add('loading');
    
    try {
      const response = await fetch('/api/media/download-pexels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo, size: 'large' })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.selectImage({
          url: data.url,
          source: 'pexels',
          photographer: data.photographer,
          photographer_url: data.photographer_url
        });
      } else {
        throw new Error(data.error || 'Download failed');
      }
    } catch (err) {
      console.error('Select pexels error:', err);
      await window.gryffi.modal.alert(this.t('imagePicker.downloadFailed', 'Failed to download image. Please try again.'), { type: 'error' });
      card?.classList.remove('loading');
    }
  }
  
  selectImage(imageData) {
    if (this.onSelect) {
      this.onSelect(imageData);
    }
    this.close();
  }
  
  bindPhotoClicks(container) {
    container.querySelectorAll('.image-picker-card').forEach(card => {
      card.addEventListener('click', () => {
        const photoId = card.dataset.photoId;
        const source = card.dataset.source;
        
        if (source === 'pexels') {
          const photo = [...this.suggestions, ...this.searchResults].find(p => p.id.toString() === photoId);
          if (photo) this.selectPexelsPhoto(photo);
        } else if (source === 'library') {
          const media = this.library.find(m => m.id === photoId);
          if (media) {
            this.selectImage({
              url: media.url,
              source: media.source,
              photographer: media.photographer
            });
          }
        }
      });
    });
  }
  
  renderPhotoGrid(photos, source) {
    if (!photos || photos.length === 0) {
      return this.renderEmpty(this.t('imagePicker.noImages', 'No images found'));
    }
    
    return photos.map(photo => `
      <div class="image-picker-card" data-photo-id="${photo.id}" data-source="${source}">
        <img src="${photo.src?.medium || photo.src?.small}" alt="${photo.alt || ''}" loading="lazy" />
        <div class="image-picker-card-overlay">
          <span class="text-white text-xs truncate">${photo.photographer || ''}</span>
        </div>
        <div class="image-picker-card-loading">
          <div class="spinner"></div>
        </div>
      </div>
    `).join('');
  }
  
  renderLibraryGrid(media) {
    if (!media || media.length === 0) {
      return this.renderEmpty(this.t('imagePicker.noLibraryImages', 'No images in library'));
    }
    
    const uploadedLabel = this.t('imagePicker.uploaded', 'Uploaded');
    
    return media.map(item => `
      <div class="image-picker-card" data-photo-id="${item.id}" data-source="library">
        <img src="${item.url}" alt="${item.original_name || ''}" loading="lazy" />
        <div class="image-picker-card-overlay">
          <span class="text-white text-xs truncate">${item.source === 'pexels' ? item.photographer : uploadedLabel}</span>
        </div>
      </div>
    `).join('');
  }
  
  renderLoading() {
    return `
      <div class="image-picker-loading">
        <div class="spinner"></div>
        <p class="text-zen-500 mt-2">${this.t('imagePicker.loading', 'Loading...')}</p>
      </div>
    `;
  }
  
  renderEmpty(message) {
    return `
      <div class="image-picker-empty">
        <svg class="w-12 h-12 text-zen-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
        </svg>
        <p class="text-zen-500">${message}</p>
      </div>
    `;
  }
}

// Create global instance
window.imagePicker = new ImagePicker();
