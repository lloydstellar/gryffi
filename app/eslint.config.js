/**
 * ESLint Configuration - Gryffi
 * Security-focused linting for Node.js/Express application
 */
import security from 'eslint-plugin-security';

// Globals for server code (Node 20)
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  setImmediate: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  performance: 'readonly',
  crypto: 'readonly'
};

// Globals for browser scripts in public/js
const browserGlobals = {
  console: 'readonly',
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  FileReader: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  crypto: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  open: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  performance: 'readonly',
  getComputedStyle: 'readonly',
  Image: 'readonly',
  Audio: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  MouseEvent: 'readonly',
  KeyboardEvent: 'readonly',
  MutationObserver: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  HTMLElement: 'readonly',
  HTMLAnchorElement: 'readonly',
  Element: 'readonly',
  Node: 'readonly',
  NodeList: 'readonly',
  NodeFilter: 'readonly',
  Range: 'readonly',
  Highlight: 'readonly',
  CSS: 'readonly',
  DOMParser: 'readonly',
  XMLSerializer: 'readonly',
  XMLHttpRequest: 'readonly',
  AbortController: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  AudioContext: 'readonly',
  SpeechSynthesisUtterance: 'readonly',
  speechSynthesis: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  // Libraries loaded with a <script> tag
  Sortable: 'readonly',
  marked: 'readonly',
  DOMPurify: 'readonly',
  LeaderLine: 'readonly',
  Chart: 'readonly',
  jspdf: 'readonly',
  html2canvas: 'readonly',
  Cropper: 'readonly'
};

const sharedRules = {
      // ============================================
      // SECURITY RULES (eslint-plugin-security)
      // ============================================
      
      // Detect potential SQL injection via string concatenation
      // Note: Many false positives with array indexing - keep as 'off' or review manually
      'security/detect-object-injection': 'off',
      
      // Detect non-literal require() calls - CRITICAL
      'security/detect-non-literal-require': 'error',
      
      // Detect non-literal fs filename (path traversal)
      // Note: Our fs operations use validated paths from environment/config
      'security/detect-non-literal-fs-filename': 'off',
      
      // Detect eval() usage - CRITICAL
      'security/detect-eval-with-expression': 'error',
      
      // Detect child_process with non-literal arguments - CRITICAL
      'security/detect-child-process': 'error',
      
      // Detect unsafe RegExp (ReDoS vulnerability)
      // Note: Some false positives, but important to check new regex patterns
      'security/detect-unsafe-regex': 'warn',
      
      // Detect Buffer with noAssert flag - CRITICAL
      'security/detect-buffer-noassert': 'error',
      
      // Detect possible timing attacks
      // Note: Many false positives with non-secret comparisons
      'security/detect-possible-timing-attacks': 'off',
      
      // Detect pseudoRandomBytes usage (use randomBytes instead) - CRITICAL
      'security/detect-pseudoRandomBytes': 'error',
      
      // Detect non-literal RegExp (potential ReDoS with user input)
      'security/detect-non-literal-regexp': 'warn',
      
      // Detect bidi characters (can hide malicious code) - CRITICAL
      'security/detect-bidi-characters': 'error',
      
      // ============================================
      // GENERAL BEST PRACTICES
      // ============================================
      
      // Disallow use of undeclared variables (catches missing imports)
      'no-undef': 'error',

      // Disallow eval()
      'no-eval': 'error',
      
      // Disallow implied eval() through setTimeout/setInterval strings
      'no-implied-eval': 'error',
      
      // Disallow new Function()
      'no-new-func': 'error',
      
      // Disallow with statements
      'no-with': 'error',
      
      // Require const/let instead of var
      'no-var': 'warn',
      
      // Prefer const when variable is not reassigned
      'prefer-const': 'warn',
      
      // Disallow unused variables (but allow unused function arguments and catch errors)
      'no-unused-vars': ['warn', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      
      // Disallow console in production (warn only)
      'no-console': 'off', // Keep off for server-side logging
      
      // Require strict equality
      'eqeqeq': ['warn', 'smart'],
};

export default [
  {
    // Third-party and generated code is never linted
    ignores: ['node_modules/**', 'public/js/vendor/**']
  },
  {
    files: ['src/**/*.js'],
    plugins: { security },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: nodeGlobals },
    rules: sharedRules
  },
  {
    files: ['public/js/**/*.js'],
    plugins: { security },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: browserGlobals },
    rules: sharedRules
  }
];
