import { useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { copyText, type PlayerSession, type Settings } from '../lib/storage';

export function SettingsDialog({ settings, onChange, player, onPlayer, onClose, inGame = false }: {
  settings: Settings; onChange: (value: Settings) => void; player: PlayerSession | null;
  onPlayer: (value: PlayerSession) => void; onClose: () => void; inGame?: boolean;
}) {
  const [restore, setRestore] = useState(false);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="Your settings" onClose={onClose}>
    <div className="settings-fields">
      <label className="range-label"><span>Look sensitivity <strong>{settings.sensitivity.toFixed(1)}×</strong></span><input type="range" min="0.2" max="2.5" step="0.1" value={settings.sensitivity} onChange={e => onChange({ ...settings, sensitivity: Number(e.target.value) })}/></label>
      <label className="range-label"><span>Game volume <strong>{Math.round(settings.volume * 100)}%</strong></span><input type="range" min="0" max="1" step="0.05" value={settings.volume} onChange={e => onChange({ ...settings, volume: Number(e.target.value) })}/></label>
      <label className="field-label">Graphics<select value={settings.quality} onChange={e => onChange({ ...settings, quality: e.target.value as Settings['quality'] })}><option value="auto">Automatic · recommended</option><option value="high">High · sharper shadows</option><option value="low">Low · smoother on phones</option></select></label>
      <label className="checkbox-row"><input type="checkbox" checked={settings.invertY} onChange={e => onChange({ ...settings, invertY: e.target.checked })}/> Invert vertical look</label>
    </div>
    {!inGame && <section className="settings-player"><h3>Keep your player</h3><p>Your player is saved in this browser. Use a private player key to bring the same profile and scores to your other device. Keep it to yourself.</p>
      <div className="button-row">{player && <button className="button secondary small" onClick={async () => setMessage(await copyText(player.token) ? 'Player key copied. Keep it private.' : 'Copy needs a secure connection. Open the game over HTTPS or on localhost.')}><Icon name="copy" size={18}/> Copy player key</button>}<button className="text-button" onClick={() => setRestore(!restore)}>Use existing player</button></div>
      {restore && <form className="inline-form" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setMessage('');
        try { const { profile } = await api<{ profile: PlayerSession['profile'] }>('/profile', key.trim()); onPlayer({ token: key.trim(), profile }); setMessage('Player restored on this device.'); setKey(''); setRestore(false); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
      }}><label className="field-label">Private player key<input type="password" autoComplete="off" required value={key} onChange={e => setKey(e.target.value)} placeholder="Paste the key from your other device"/></label><button className="button secondary small" disabled={busy}>{busy ? 'Restoring…' : 'Restore player'}</button></form>}
      {message && <p className="inline-message" role="status">{message}</p>}
    </section>}
    <button className="button primary full-width" onClick={onClose}>Back to {inGame ? 'game' : 'arena'}</button>
  </Modal>;
}
