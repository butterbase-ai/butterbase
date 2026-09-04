// Inline SVG "butter pat" mark — a soft yellow square with a melt highlight
// and a B serif glyph. Used in both the closed launcher and the panel header.
// Inline (no <img>) so the widget bundle stays self-contained and never makes
// a second network request for the logo. ~600 bytes gzipped.

export function BrandMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id="bs-butter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FBE08E" />
          <stop offset="55%" stopColor="#F5C24C" />
          <stop offset="100%" stopColor="#E0A82E" />
        </linearGradient>
      </defs>
      <rect x="2" y="3" width="28" height="26" rx="7" fill="url(#bs-butter)" />
      <path
        d="M5 9 Q 9 6 16 7 T 27 9"
        stroke="#FFF6D6"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
        opacity="0.75"
      />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="ui-serif, Georgia, 'Times New Roman', serif"
        fontWeight="700"
        fontSize="16"
        fill="#3a2a0a"
      >
        B
      </text>
    </svg>
  );
}
