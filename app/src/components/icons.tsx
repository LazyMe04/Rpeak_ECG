/**
 * Inline icon set.
 *
 * The reference app pulls these from lucide-react; the app has no icon
 * dependency, so the handful of glyphs it actually uses are drawn here with the
 * same 24px grid and 2px round strokes. That keeps the visual language
 * identical without adding a package.
 */
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 20, ...rest }: Props) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...rest,
  };
}

export function ActivityIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

export function PlayIcon(p: Props) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}

export function PauseIcon(p: Props) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

export function SkipBackIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M19 20 9 12l10-8z" fill="currentColor" stroke="none" />
      <path d="M5 19V5" />
    </svg>
  );
}

export function SkipForwardIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M5 4l10 8-10 8z" fill="currentColor" stroke="none" />
      <path d="M19 5v14" />
    </svg>
  );
}

export function ChevronLeftIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function ChevronRightIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function ListIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TrendingUpIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M22 7l-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </svg>
  );
}

export function ZapIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
    </svg>
  );
}

export function SunIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MoonIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function XIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function HeartIcon(p: Props) {
  return (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <path d="M12 21s-7.5-4.7-9.6-9A5.5 5.5 0 0 1 12 6.5 5.5 5.5 0 0 1 21.6 12C19.5 16.3 12 21 12 21z" />
    </svg>
  );
}

export function InfoIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.6v.4" />
    </svg>
  );
}

export function CircleDotIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DownloadIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M12 3v11" />
      <path d="m7.5 10 4.5 4.5L16.5 10" />
      <path d="M4 19.5h16" />
    </svg>
  );
}

export function WavesIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M2 12h3l2-5 3 10 2.5-6 2 3H22" />
      <path d="M6 20v-3M11 20v-3M16 20v-3" />
    </svg>
  );
}

/** Neural-net / chip glyph: the beat classifier. */
export function BrainIcon(p: Props) {
  return (
    <svg {...base(p)}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
