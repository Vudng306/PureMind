const PATHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="M15 18l-6-6 6-6" />,
  next: <path d="M9 18l6-6-6-6" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  toc: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  focus: <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />,
  highlighter: (
    <>
      <path d="M9 11l-6 6v3h9l3-3" />
      <path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </>
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      {/* Eight even teeth around (12, 12): a tooth 16° wide at r 9.5, the gaps 21° wide at r 7. */}
      <path d="M10.54 5.15L10.68 2.59A9.5 9.5 0 0 1 13.32 2.59L13.46 5.15A7 7 0 0 1 15.81 6.13L17.72 4.41A9.5 9.5 0 0 1 19.59 6.28L17.87 8.19A7 7 0 0 1 18.85 10.54L21.41 10.68A9.5 9.5 0 0 1 21.41 13.32L18.85 13.46A7 7 0 0 1 17.87 15.81L19.59 17.72A9.5 9.5 0 0 1 17.72 19.59L15.81 17.87A7 7 0 0 1 13.46 18.85L13.32 21.41A9.5 9.5 0 0 1 10.68 21.41L10.54 18.85A7 7 0 0 1 8.19 17.87L6.28 19.59A9.5 9.5 0 0 1 4.41 17.72L6.13 15.81A7 7 0 0 1 5.15 13.46L2.59 13.32A9.5 9.5 0 0 1 2.59 10.68L5.15 10.54A7 7 0 0 1 6.13 8.19L4.41 6.28A9.5 9.5 0 0 1 6.28 4.41L8.19 6.13A7 7 0 0 1 10.54 5.15Z" />
    </>
  ),
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" />,
  sort: <path d="M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3" />,
  note: (
    <>
      <path d="M5 4h14v12l-4 4H5z" />
      <path d="M15 20v-4h4M9 9h6M9 13h4" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  minus: <path d="M5 12h14" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />,
  chart: <path d="M4 4v16h16M8 15l4-5 3 3 5-6" />,
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>
  ),
  translate: <path d="M4 5h9M8.5 3v2M11 5c-.8 3.8-3.4 6.8-7 8.5M6 8.5c1.2 2 3 3.6 5 4.5M13 21l4-9 4 9M14.4 18h5.2" />,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
