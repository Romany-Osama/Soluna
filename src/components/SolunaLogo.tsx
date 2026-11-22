interface SolunaLogoProps {
  size?: number;
  className?: string;
}

export function SolunaLogo({ size = 28, className = "" }: SolunaLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="soluna-sol" cx="40%" cy="40%" r="65%">
          <stop offset="0%" stopColor="#FFF24D" />
          <stop offset="40%" stopColor="#FF9100" />
          <stop offset="100%" stopColor="#FF1744" />
        </radialGradient>
        <linearGradient id="soluna-luna" x1="100%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#00FFAA" />
          <stop offset="50%" stopColor="#00D2FF" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
        <linearGradient id="soluna-stem" x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#00D2FF" />
          <stop offset="50%" stopColor="#6366F1" />
          <stop offset="100%" stopColor="#FF4071" />
        </linearGradient>
        <linearGradient id="soluna-flag" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FF9500" />
          <stop offset="50%" stopColor="#FF1E56" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
        <filter id="soluna-glow" x="-15%" y="-15%" width="130%" height="130%">
          <feDropShadow dx="0" dy="8" stdDeviation="12" floodColor="#000000" floodOpacity="0.4" />
        </filter>
      </defs>
      <g filter="url(#soluna-glow)">
        <path
          d="M 440 560 C 310 535, 190 610, 160 730 C 130 850, 210 960, 330 980 C 440 1000, 530 920, 550 820 C 560 775, 520 740, 475 745 C 430 750, 390 775, 340 765 C 280 750, 250 690, 270 640 C 290 590, 350 565, 410 580 C 450 590, 480 560, 440 560 Z"
          fill="url(#soluna-luna)"
        />
        <circle cx="360" cy="740" r="105" fill="url(#soluna-sol)" />
        <circle cx="360" cy="740" r="105" fill="none" stroke="#FFFFFF" strokeWidth="4" strokeOpacity="0.75" />
      </g>
      <g filter="url(#soluna-glow)">
        <rect x="444" y="220" width="76" height="540" rx="38" fill="url(#soluna-stem)" />
      </g>
      <g filter="url(#soluna-glow)">
        <path
          d="M 482 220 C 650 200, 810 260, 890 380 C 915 418, 885 455, 840 445 C 765 425, 670 385, 520 410 L 520 220 Z"
          fill="url(#soluna-flag)"
        />
      </g>
    </svg>
  );
}
