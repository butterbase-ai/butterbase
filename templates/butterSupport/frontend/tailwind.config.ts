import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './widget.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // shadcn token wiring — all HSL CSS variables
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Extended editorial palette
        butter: {
          DEFAULT: 'hsl(var(--butter))',
          soft: 'hsl(var(--butter-soft))',
        },
        coral: 'hsl(var(--coral))',
        sage: 'hsl(var(--sage))',
        ink: 'hsl(var(--ink))',
        paper: 'hsl(var(--paper))',
        rule: 'hsl(var(--rule))',
        // Legacy aliases for files not yet converted
        caramel: { DEFAULT: 'hsl(var(--butter))', soft: 'hsl(var(--butter-soft))', deep: 'hsl(var(--butter))' },
        positive: { DEFAULT: 'hsl(var(--sage))', foreground: 'hsl(var(--paper))' },
        'paper-soft': 'hsl(var(--card))',
        'paper-warm': 'hsl(var(--muted))',
        'paper-deep': 'hsl(var(--secondary))',
        'rule-soft': 'hsl(var(--border) / 0.6)',
        'ink-soft': 'hsl(var(--foreground) / 0.85)',
        'ink-muted': 'hsl(var(--muted-foreground))',
        'ink-faint': 'hsl(var(--muted-foreground) / 0.7)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        editorial: ['var(--font-editorial)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 8px)',
      },
      keyframes: {
        rise: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%,100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'toast-in': {
          from: { opacity: '0', transform: 'translateX(16px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateX(0) scale(1)' },
        },
        'toast-out': {
          from: { opacity: '1', transform: 'translateX(0) scale(1)' },
          to: { opacity: '0', transform: 'translateX(16px) scale(0.98)' },
        },
      },
      animation: {
        rise: 'rise 480ms cubic-bezier(0.2, 0.7, 0.2, 1) both',
        'pulse-soft': 'pulse-soft 2.2s ease-in-out infinite',
        'toast-in': 'toast-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'toast-out': 'toast-out 180ms cubic-bezier(0.4, 0, 1, 1) both',
      },
    },
  },
  plugins: [],
};

export default config;
