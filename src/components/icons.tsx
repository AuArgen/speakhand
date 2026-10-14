// Сызыктуу иконкалар (24×24, stroke).
import type { SVGProps } from "react";

const base = (d: React.ReactNode) => (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
    {d}
  </svg>
);

export const IconMic = base(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
export const IconStop = base(<rect x="6" y="6" width="12" height="12" rx="2.5" />);
export const IconPlay = base(<path d="M7 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 7 5.5Z" />);
export const IconReplay = base(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>);
export const IconHand = base(<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v7.5c0 4-2.7 7.5-7 7.5-3 0-4.6-1.6-6-4l-2-3.5a1.5 1.5 0 0 1 2.5-1.6L8 13" />);
export const IconCamera = base(<><path d="M15 10l5-3v10l-5-3" /><rect x="3" y="6" width="12" height="12" rx="2.5" /></>);
export const IconRecord = base(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" fill="currentColor" /></>);
export const IconBook = base(<><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /></>);
export const IconSpeaker = base(<><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></>);
export const IconSparkle = base(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />);
export const IconSun = base(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>);
export const IconMoon = base(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />);
export const IconTrash = base(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />);
export const IconDownload = base(<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />);
export const IconUpload = base(<path d="M12 21V9m0 0-4 4m4-4 4 4M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" />);
export const IconInfo = base(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
export const IconX = base(<path d="M6 6l12 12M18 6 6 18" />);
export const IconPlus = base(<path d="M12 5v14M5 12h14" />);
export const IconSearch = base(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconArrow = base(<path d="M5 12h14m-5-5 5 5-5 5" />);

/** Логотип: түндүк (боз үйдүн чамгарагы) + сүйлөө толкуну. */
export function Logo(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden {...p}>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb38a" />
          <stop offset="1" stopColor="#ff7a45" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#lg)" />
      <circle cx="20" cy="20" r="10.5" fill="none" stroke="#2a1206" strokeWidth="2.2" />
      <path d="M13 14.5c4.5 3.5 9.5 3.5 14 0M13 25.5c4.5-3.5 9.5-3.5 14 0M14.5 13c3.5 4.5 3.5 9.5 0 14M25.5 13c-3.5 4.5-3.5 9.5 0 14" fill="none" stroke="#2a1206" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
