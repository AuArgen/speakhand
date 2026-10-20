// «Үйрөнүү» бөлүмүнүн иконкалары (icons.tsx стилинде: 24×24, сызык).
import type { ReactNode, SVGProps } from "react";

const base = (d: ReactNode) => (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
    {d}
  </svg>
);

export const IconGrad = base(<><path d="M2.5 9 12 4.5 21.5 9 12 13.5 2.5 9Z" /><path d="M6.5 11v4.5c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3V11M21.5 9v5.5" /></>);
export const IconFlame = base(<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.3 2.3-5.4 3.6-7.6.4 1.6 1.3 2.7 2.4 3.2C11.7 7.6 12.6 5 15 3c-.3 2.6 1 4.4 2.3 6 1 1.3 1.7 2.9 1.7 4.8C19 18.4 16 21 12 21Z" />);
export const IconTarget = base(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>);
export const IconQuestion = base(<><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8M12 17h.01" /></>);
export const IconLeft = base(<path d="M15 5l-7 7 7 7" />);
export const IconRight = base(<path d="m9 5 7 7-7 7" />);
export const IconLoop = base(<><path d="M17 2.5 20.5 6 17 9.5" /><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13M7 21.5 3.5 18 7 14.5" /><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13" /></>);
export const IconTurtle = base(<><path d="M4 15.5c0-4 3.4-7 7.5-7s7.5 3 7.5 7H4Z" /><path d="M19 13.5h1.5a1.5 1.5 0 0 0 0-3H19M6.5 15.5 5.5 18M16.5 15.5l1 2.5M8 11.5l2 4M15 11.5l-2 4" /></>);
export const IconSave = base(<><path d="M5 3.5h11l3.5 3.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z" /><path d="M7.5 3.5v5h8v-5M7.5 20.5v-6h9v6" /></>);
export const IconTrophy = base(<><path d="M7.5 4h9v5a4.5 4.5 0 0 1-9 0V4Z" /><path d="M7.5 6H4.5a3 3 0 0 0 3 4M16.5 6h3a3 3 0 0 1-3 4M12 13.5V17M8.5 20.5h7M9.5 17h5v3.5h-5z" /></>);
