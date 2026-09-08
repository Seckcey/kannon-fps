import type { CSSProperties } from 'react';

export type IconName = 'play' | 'users' | 'clock' | 'target' | 'settings' | 'close' | 'arrow' | 'copy' | 'check' | 'shield' | 'heal' | 'ar' | 'shotgun' | 'trophy' | 'volume' | 'phone' | 'desktop' | 'reload' | 'jump' | 'aim' | 'leave' | 'link' | 'pause';
export function Icon({ name, size = 24, className = '', style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  const paths: Record<IconName, React.ReactNode> = {
    play: <path d="m8 4 13 8L8 20z" fill="currentColor" stroke="none" />,
    users: <><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M17 14h5m-2.5-2.5v5"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/></>,
    settings: <><path d="m10 2-.8 3-2.1 1.2-3-.8-2 3.4 2.1 2.3v2.6l-2.1 2.2 2 3.5 3-.8 2.1 1.2.8 3h4l.8-3 2.1-1.2 3 .8 2-3.5-2.1-2.2v-2.6l2.1-2.3-2-3.4-3 .8L14.8 5 14 2z"/><circle cx="12" cy="12" r="3"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>, arrow: <path d="m9 5 7 7-7 7"/>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
    check: <path d="m5 12 4 4 10-10"/>,
    shield: <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z" fill="currentColor" stroke="none"/>,
    heal: <path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z" fill="currentColor" stroke="none"/>,
    ar: <path d="M1 11h4l2-3h8V6h2v2h3v2h3v3h-9l-2 3H9l1-3H7l-2 5H1l2-5H1zm8-4h3v1H9" fill="currentColor" stroke="none"/>,
    shotgun: <path d="M1 15 6 9h16v3H10l-3 3H5l-2 4H1zm10-7h11v1H11" fill="currentColor" stroke="none"/>,
    trophy: <><path d="M7 3h10v6a5 5 0 0 1-10 0zM12 14v5m-5 2h10M7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4"/></>,
    volume: <><path d="M3 9h4l5-5v16l-5-5H3zM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    phone: <><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/></>,
    desktop: <><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-5 0h10"/></>,
    reload: <><path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 14-2m0 10A8 8 0 0 1 5 2" transform="translate(0 1)"/></>,
    jump: <><path d="m5 12 7-7 7 7M12 5v16M4 2h16"/></>,
    aim: <><path d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"/><circle cx="12" cy="12" r="3"/></>,
    leave: <><path d="M9 3H3v18h6m-1-9h14m-5-5 5 5-5 5"/></>,
    link: <><path d="m9 15 6-6M8 17l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2-1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0)"/></>,
    pause: <><path d="M7 4v16m10-16v16" strokeWidth="5"/></>,
  };
  return <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
