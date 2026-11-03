import { Modal } from './Modal';

/** iPhones give a website no way to hide the browser bars, so a tap on Play full screen explains how. */
export function FullscreenHelp({ onClose }: { onClose: () => void }) {
  return <Modal title="Play full screen." onClose={onClose}>
    <p className="modal-intro">iPhones do not let a website hide the browser bars by itself. It takes a couple of taps from you.</p>
    <ol className="fullscreen-steps">
      <li><strong>Quickest, in Safari</strong><span>Tap the menu button in the address bar (it shows lines or <b>aA</b>), then <b>Hide Toolbars</b>. Tap the very top of the screen to bring them back.</span></li>
      <li><strong>From now on</strong><span>Tap <b>Share</b>, then <b>Add to Home Screen</b>, then open Kannon Arena from its new icon. This leaves your match. The icon starts as a new player, so to keep yours, first copy your player key from Settings on the main menu. Links from friends still open in Safari.</span></li>
    </ol>
    <button className="button primary full-width" onClick={onClose}>Back to game</button>
  </Modal>;
}
