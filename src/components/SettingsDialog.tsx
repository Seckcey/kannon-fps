import { useId, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { requestGyroscope } from '../game/Gyroscope';
import { SETTING_RANGES, copyText, isTouchDevice, type PlayerSession, type Settings } from '../lib/storage';

function Choice<T extends string>({ label, value, options, onChange, hint }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void; hint?: string }) {
  const name = useId();
  return <fieldset className="choice-group"><legend>{label}</legend>
    <div className="segmented">{options.map(([option, text]) => <label key={option} className={value === option ? 'selected' : ''}>
      <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)}/><span>{text}</span>
    </label>)}</div>
    {hint && <small>{hint}</small>}
  </fieldset>;
}

export function SettingsDialog({ settings, onChange, player, onPlayer, onClose, inGame = false, onTestSound, touch = isTouchDevice() }: {
  settings: Settings; onChange: (value: Settings) => void; player: PlayerSession | null;
  onPlayer: (value: PlayerSession) => void; onClose: () => void; inGame?: boolean; onTestSound?: () => void; touch?: boolean;
}) {
  const [restore, setRestore] = useState(false);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [gyroMessage, setGyroMessage] = useState('');
  const [gyroBusy, setGyroBusy] = useState(false);
  const currentSettings = useRef(settings); currentSettings.current = settings;
  const change = (patch: Partial<Settings>) => onChange({ ...currentSettings.current, ...patch });
  const sprintHint = settings.sprintMode === 'auto'
    ? touch ? 'Push the stick all the way forward to sprint. Push it again quickly to dash.' : 'Holding W always sprints. Tap W twice and hold to dash.'
    : settings.sprintMode === 'toggle' ? `${touch ? 'Tap Sprint' : 'Tap Shift'} to start sprinting and again to stop. Tap twice quickly to dash.`
    : touch ? 'Hold Sprint to sprint. Tap it twice and hold to dash.' : 'Hold Shift to sprint. Tap it twice and hold to dash.';
  return <Modal title="Your settings" onClose={onClose}>
    <div className="settings-fields">
      <h3 className="settings-heading">Aiming</h3>
      <label className="range-label"><span>Look sensitivity <strong>{settings.sensitivity.toFixed(1)}×</strong></span><input type="range" min={SETTING_RANGES.sensitivity[0]} max={SETTING_RANGES.sensitivity[1]} step="0.1" value={settings.sensitivity} onChange={e => change({ sensitivity: Number(e.target.value) })}/></label>
      <label className="range-label"><span>Aim sensitivity <strong>{settings.adsSensitivity.toFixed(2)}×</strong></span><input type="range" min={SETTING_RANGES.adsSensitivity[0]} max={SETTING_RANGES.adsSensitivity[1]} step="0.05" value={settings.adsSensitivity} onChange={e => change({ adsSensitivity: Number(e.target.value) })}/><small>Look speed while aiming down sights, compared with normal look speed.</small></label>
      <label className="range-label"><span>Field of view <strong>{settings.fov}°</strong></span><input type="range" min={SETTING_RANGES.fov[0]} max={SETTING_RANGES.fov[1]} step="1" value={settings.fov} onChange={e => change({ fov: Number(e.target.value) })}/><small>Wider shows more around you. Narrower makes faraway rivals look bigger.</small></label>
      <label className="checkbox-row"><input type="checkbox" checked={settings.invertY} onChange={e => change({ invertY: e.target.checked })}/> Invert vertical look</label>

      <h3 className="settings-heading">Controls</h3>
      <Choice label="Aim down sights" value={settings.aimMode} options={[['hold', 'Hold'], ['toggle', 'Toggle']]} onChange={aimMode => change({ aimMode })}
        hint={settings.aimMode === 'hold' ? `Aim while you hold ${touch ? 'Aim' : 'right click'}.` : `${touch ? 'Tap Aim' : 'Right click'} once to aim and again to stop.`}/>
      <Choice label="Crouch" value={settings.crouchMode} options={[['hold', 'Hold'], ['toggle', 'Toggle']]} onChange={crouchMode => change({ crouchMode })}
        hint="Crouch while sprinting to slide."/>
      <Choice label="Sprint" value={settings.sprintMode} options={[['hold', 'Hold'], ['toggle', 'Toggle'], ['auto', 'Automatic']]} onChange={sprintMode => change({ sprintMode })} hint={sprintHint}/>
      {touch && <label className="field-label">Mobile firing<select value={settings.firingMode} onChange={e => change({ firingMode: e.target.value as Settings['firingMode'] })}><option value="simple">Simple · aim to auto-fire</option><option value="advanced">Advanced · manual fire</option></select><small>Simple fires while your crosshair rests on a visible rival. In Advanced, hold and drag Fire to aim and shoot. Both Fire buttons always work.</small></label>}
      {touch && <div className="gyro-setting"><button className="button secondary small" disabled={gyroBusy} onClick={async () => {
        if (settings.gyroscope) { change({ gyroscope: false }); setGyroMessage('Gyroscope off.'); return; }
        setGyroBusy(true);
        const allowed = await requestGyroscope();
        if (allowed) { change({ gyroscope: true }); setGyroMessage('Gyroscope on. Tilt gently while playing; touch aiming still works.'); }
        else setGyroMessage('Motion access is unavailable or was declined. You can keep aiming by touch.');
        setGyroBusy(false);
      }}>{gyroBusy ? 'Requesting motion access…' : settings.gyroscope ? 'Turn gyroscope off' : 'Enable gyroscope aiming'}</button>{gyroMessage && <p className="inline-message" role="status">{gyroMessage}</p>}</div>}
      {touch && settings.gyroscope && <label className="range-label"><span>Gyroscope sensitivity <strong>{settings.gyroSensitivity.toFixed(1)}×</strong></span><input type="range" min={SETTING_RANGES.gyroSensitivity[0]} max={SETTING_RANGES.gyroSensitivity[1]} step="0.1" value={settings.gyroSensitivity} onChange={e => change({ gyroSensitivity: Number(e.target.value) })}/></label>}

      <h3 className="settings-heading">Picture and sound</h3>
      <label className="field-label">Graphics<select value={settings.quality} onChange={e => change({ quality: e.target.value as Settings['quality'] })}><option value="auto">Automatic · recommended</option><option value="high">High · richer lighting and detail</option><option value="low">Low · smoother on phones</option></select></label>
      <label className="checkbox-row"><input type="checkbox" checked={settings.reduceMotion} onChange={e => change({ reduceMotion: e.target.checked })}/><span>Reduce camera motion<small>Less head bob, tilt and shake.</small></span></label>
      <label className="range-label"><span>Game volume <strong>{Math.round(settings.volume * 100)}%</strong></span><input type="range" min="0" max="1" step="0.05" value={settings.volume} onChange={e => change({ volume: Number(e.target.value) })}/></label>
      {onTestSound && <button type="button" className="button secondary small" onClick={onTestSound} disabled={settings.volume === 0}>Test sound effects</button>}
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
