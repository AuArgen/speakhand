// Бөлмө үчүн кошумча сызыктуу иконкалар (24×24, stroke) — негизгилер ../icons.tsx ичинде.
import type { ReactNode, SVGProps } from "react";

const base = (d: ReactNode) => (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
    {d}
  </svg>
);

export const IconCopy = base(<><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>);
export const IconShare = base(<><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6" /></>);
export const IconQr = base(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 14h3v3h-3zM20 14v1M14 20h1M17 20h4v-3" /></>);
export const IconSettings = base(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>);
export const IconSend = base(<path d="M4 12 20 4l-4 16-4-7-8-1Z" />);
export const IconChat = base(<path d="M5 18.5 3.5 21V6a2.5 2.5 0 0 1 2.5-2.5h12A2.5 2.5 0 0 1 20.5 6v10a2.5 2.5 0 0 1-2.5 2.5H5Z" />);
export const IconCheck = base(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconChecks = base(<path d="m2.5 12.5 4.5 4.5L15 8.5M9.5 16.5l1 1L20 8" />);
export const IconClock = base(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconBack = base(<path d="M15 5l-7 7 7 7" />);
export const IconKeyboard = base(<><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>);
export const IconGrid = base(<><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></>);
export const IconChevron = base(<path d="m9 6 6 6-6 6" />);
export const IconWifiOff = base(<><path d="M2 8.5a16 16 0 0 1 6.2-3.3M12 19h.01M5 12.5a10 10 0 0 1 3.5-2.4M8.5 16a5 5 0 0 1 4.3-1.5M22 8.5a16 16 0 0 0-6.6-3.4M19 12.5a10 10 0 0 0-3-2.2" /><path d="M3 3l18 18" /></>);
export const IconSkip = base(<path d="M6 5v14l9-7-9-7ZM18 5v14" />);
export const IconUndo = base(<path d="M8 7H4V3M4.5 7A8 8 0 1 1 4 13" />);
export const IconBolt = base(<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />);
export const IconLink = base(<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />);
export const IconUsers = base(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.5a6.5 6.5 0 0 1 3 5.5" /></>);
export const IconLogout = base(<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l-4 4 4 4M6 12h10" />);
export const IconSwap = base(<path d="M4 7h13m0 0-3-3m3 3-3 3M20 17H7m0 0 3-3m-3 3 3 3" />);
export const IconEye = base(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>);
export const IconVolumeOff = base(<><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="m22 9-6 6M16 9l6 6" /></>);
export const IconVibrate = base(<><rect x="7" y="3" width="10" height="18" rx="2.5" /><path d="M3 8v8M21 8v8" /></>);
export const IconPhone = base(<><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M11 18h2" /></>);
export const IconHome = base(<path d="M3.5 11 12 4l8.5 7V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1v-9Z" />);
export const IconTools = base(<path d="m14.5 6.5 3 3M3.5 20.5l8-8M15 4a4 4 0 0 0 4.9 4.9l-7 7a2 2 0 0 1-2.8-2.8l7-7L15 4Z" />);
export const IconEllipsis = base(<path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={3} />);

/** «Мен сүйлөйм» — адам жана үн толкуну */
export function ArtSpeaker(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 120 96" fill="none" aria-hidden {...p}>
      <circle cx="46" cy="30" r="14" fill="var(--art-skin)" />
      <path d="M18 92c2-20 13-30 28-30s26 10 28 30Z" fill="var(--art-cloth)" />
      <path d="M40 23c3-6 10-8 15-5" stroke="var(--art-hair)" strokeWidth="5" strokeLinecap="round" />
      <path d="M78 36c6 4 6 14 0 18M86 28c11 8 11 26 0 34M94 20c16 12 16 38 0 50" stroke="var(--accent)" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}

/** «Мен жаңсайм» — адам жана эки кол */
export function ArtSigner(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 120 96" fill="none" aria-hidden {...p}>
      <circle cx="60" cy="26" r="13" fill="var(--art-skin)" />
      <path d="M34 92c2-18 12-28 26-28s24 10 26 28Z" fill="var(--art-cloth)" />
      <path d="M53 19c4-6 11-6 15-1" stroke="var(--art-hair)" strokeWidth="5" strokeLinecap="round" />
      <g stroke="var(--teal)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 60V40M30 60V34M38 60V38M46 60V44M46 60c0 10-6 16-14 16-6 0-10-3-12-7l-4-7" />
        <path d="M98 56V36M90 56V30M82 56V34M74 56V40M74 56c0 10 6 16 14 16 6 0 10-3 12-7l4-7" />
      </g>
    </svg>
  );
}
