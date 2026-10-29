/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/views/**/*.ejs",
    "./public/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        // Gryffi Brand Colors - Technical Zen
        gryffi: {
          bg: '#ecf2eb',        // Achtergrondkleur - soft sage
          primary: '#0b4b34',   // Basiskleur - deep forest
          accent: '#78c503',    // Accentkleur - vibrant lime
          'primary-light': '#0d5c40',
          'primary-dark': '#093d2a',
          'accent-light': '#8fd41a',
          'accent-dark': '#5fa002',
        },
        // Neutral palette for UI
        zen: {
          50: '#f8faf8',
          100: '#f0f4ef',
          200: '#e2e8e1',
          300: '#c8d4c6',
          400: '#9fb49c',
          500: '#789476',
          600: '#5c7459',
          700: '#485c46',
          800: '#3c4a3a',
          900: '#333f32',
          950: '#1a211a',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['Outfit', 'Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        'xl': '1rem',
        '2xl': '1.5rem',
        '3xl': '2rem',
      },
      boxShadow: {
        'glass': '0 4px 30px rgba(0, 0, 0, 0.05)',
        'glass-lg': '0 8px 40px rgba(0, 0, 0, 0.08)',
        'zen': '0 2px 20px rgba(11, 75, 52, 0.08)',
        'zen-lg': '0 4px 40px rgba(11, 75, 52, 0.12)',
      },
      backdropBlur: {
        'glass': '10px',
      }
    },
  },
  plugins: [],
}

