import type { CSSProperties } from 'react';

export type IconName = 'play' | 'users' | 'clock' | 'target' | 'settings' | 'close' | 'arrow' | 'copy' | 'check' | 'shield' | 'heal' | 'ar' | 'shotgun' | 'trophy' | 'volume' | 'phone' | 'desktop' | 'reload' | 'jump' | 'aim' | 'leave' | 'link' | 'pause'
  | 'smg' | 'sniper' | 'pistol' | 'knife' | 'grenade' | 'mortar' | 'drone' | 'radar' | 'crouch' | 'swap' | 'head' | 'sprint' | 'list' | 'class' | 'fullscreen';
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
    smg: <path d="M2 9h2V8h12v1h5v2h-5v1h-2.6l.6 6h-2.6l-.6-6H9.6l-1.2 4H5.9l1.2-4H4v-1H2zm9-2.5h3V8h-3z" fill="currentColor" stroke="none"/>,
    sniper: <path d="M1 12.2h3.4l1-1.2h11V10h1.2v1H23v1.4h-6.4v.8H10l-2 3.9H5.6l1.6-3.9H4.6l-1.2 1.2H1zM8.6 7.4h6.6v1.9H8.6zm1.4 1.9h1.2v1.6H10zm2.6 0h1.2v1.6h-1.2z" fill="currentColor" stroke="none"/>,
    pistol: <path d="M3 7h17.5v3.4H11l-1 1.4.4 1.6H8.3L7.6 17H4.3l1.4-6.6H3zm9 4.2h2.4l-.6 2.2h-2.2z" fill="currentColor" stroke="none"/>,
    knife: <path d="M2.5 18.6 15.3 6.4c1.7-.7 3.1.3 3.6 1.4L6.6 19.7l-3.9.7zm15.4-8.3 1.8-1.8 2.6 2.6-1.8 1.8z" fill="currentColor" stroke="none"/>,
    grenade: <><circle cx="11" cy="14.5" r="6"/><path d="M9 8.6V5.5h4v3.1M13 6.5h3.2l2.3 3"/></>,
    mortar: <><path d="M6.5 18 16 4.5m-2.2-1.2 4.4 3M10.3 12.6l5.2 6.4M3 21h18"/></>,
    drone: <><circle cx="5" cy="6" r="2.6"/><circle cx="19" cy="6" r="2.6"/><circle cx="5" cy="18" r="2.6"/><circle cx="19" cy="18" r="2.6"/><path d="m7 8 2.7 2.7m4.6 0L17 8M7 16l2.7-2.7m4.6 0L17 16"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1"/></>,
    radar: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.6"/><path d="m12 12 6.2-6.2"/><circle cx="15.8" cy="15" r="1.3" fill="currentColor" stroke="none"/></>,
    crouch: <path d="m5 8 7 6 7-6M5 19h14"/>,
    swap: <path d="M4 8h14m0 0-3.2-3.2M18 8l-3.2 3.2M20 16H6m0 0 3.2-3.2M6 16l3.2 3.2"/>,
    head: <><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/></>,
    sprint: <path d="m6 12.5 6-6 6 6M6 19l6-6 6 6"/>,
    list: <path d="M4 6h16M4 12h16M4 18h16"/>,
    class: <><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M7 9h10M7 13h6M7 16.5h8"/></>,
    trophy: <><path d="M7 3h10v6a5 5 0 0 1-10 0zM12 14v5m-5 2h10M7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4"/></>,
    volume: <><path d="M3 9h4l5-5v16l-5-5H3zM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>,
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
