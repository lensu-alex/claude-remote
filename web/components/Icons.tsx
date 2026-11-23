import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

// One drawing style for every glyph: 24-unit grid, round caps and joins, one stroke weight.
function Icon({ size = 22, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.5 5l-7 7 7 7" />
  </Icon>
);

export const ChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 5l7 7-7 7" />
  </Icon>
);

export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 9l7 7 7-7" />
  </Icon>
);

export const Plus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ArrowUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);

export const ArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
);

export const More = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="12" r="1.3" fill="currentColor" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    <circle cx="19" cy="12" r="1.3" fill="currentColor" />
  </Icon>
);

// Eight teeth around a hub, drawn from angles so the outline stays even.
const GEAR = (() => {
  const point = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`;
  };
  const parts: string[] = [];
  for (let k = 0; k < 8; k += 1) {
    const a = k * 45;
    parts.push(point(a - 14, 7.3), point(a - 8.5, 9.6), point(a + 8.5, 9.6), point(a + 14, 7.3));
  }
  return `M${parts.join("L")}Z`;
})();

export const Gear = (p: IconProps) => (
  <Icon {...p}>
    <path d={GEAR} />
    <circle cx="12" cy="12" r="2.9" />
  </Icon>
);

export const ListIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10" />
    <circle cx="5" cy="6.5" r="1.1" fill="currentColor" />
    <circle cx="5" cy="12" r="1.1" fill="currentColor" />
    <circle cx="5" cy="17.5" r="1.1" fill="currentColor" />
  </Icon>
);

export const Laptop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="5" width="15" height="10.5" rx="1.8" />
    <path d="M2.5 19h19" />
  </Icon>
);

export const Folder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.5a2 2 0 012-2h3.6l2 2.2h7.4a2 2 0 012 2v7.8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
  </Icon>
);

export const Alert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.2l8.6 14.8H3.4z" />
    <path d="M12 10v4.2M12 16.9v.1" />
  </Icon>
);

export const Photo = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.6" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4.5 17l4.8-4.6 3.6 3.2 2.6-2.2 4 3.6" />
  </Icon>
);

export const Bell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.2 16.5V11a5.8 5.8 0 0111.6 0v5.5l1.7 2H4.5z" />
    <path d="M10 20.5a2.2 2.2 0 004 0" />
  </Icon>
);

export const Person = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.2" r="3.6" />
    <path d="M4.8 19.6a7.4 7.4 0 0114.4 0" />
  </Icon>
);

export const Close = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Icon>
);

export const Copy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" />
    <path d="M15.5 5.5h-8a2 2 0 00-2 2v8" />
  </Icon>
);

export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const Pencil = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 19.5l.9-4.1L15.8 5a2.2 2.2 0 013.2 3.2L8.6 18.6z" />
    <path d="M14 6.8l3.2 3.2" />
  </Icon>
);

export const Trash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2h9.4L17.5 7" />
    <path d="M10.2 10.5v5.5M13.8 10.5v5.5" />
  </Icon>
);

export const Clock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const CheckCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.2 12.4l2.6 2.6 5-5.4" />
  </Icon>
);

/** Filled circle with an exclamation mark cut out in the cell colour. */
export const ExclamationFill = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none" />
    <path d="M12 7.2v5.6M12 16.4v.1" stroke="var(--cell)" strokeWidth={2.2} />
  </Icon>
);

export const Stop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.4" fill="currentColor" stroke="none" />
  </Icon>
);

export const Bolt = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 3L5.5 13.5h5.2L10 21l8-11h-5.4z" fill="currentColor" stroke="none" />
  </Icon>
);

/** The app mark: a terminal prompt on a dark tile. Matches scripts/make-icons.mjs. */
export const Sliders = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);

export const Doc = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Icon>
);

export const Download = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14" />
  </Icon>
);

export function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="23" fill="#2a1a0f" />
      <path d="M30 33l19 17-19 17" fill="none" stroke="#f6ead9" strokeWidth="9.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M57 67h15" fill="none" stroke="#d2a171" strokeWidth="9.2" strokeLinecap="round" />
    </svg>
  );
}
