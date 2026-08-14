'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPublicClient, http, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { RPC, JACKPOT, jackpotAbi } from '../lib/config';
import campaign from '../../campaign.json';

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const HL_INFO = 'https://api.hyperliquid.xyz/info';

const fmtUsd = (v, dec = 6) => '$' + Number(formatUnits(v ?? 0n, dec)).toLocaleString(undefined, { maximumFractionDigits: 0 });

function useCountdown(toMs) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  if (!toMs) return '—';
  const s = Math.max(0, Math.floor((toMs - now) / 1000));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
}

// same qualifying logic as the engine (engine/src/engine.js), campaign-sheet-driven
const el = campaign.eligibility;
const qualifies = (coin, timeMs) => {
  if (timeMs < campaign.campaign.startMs || (campaign.campaign.endMs && timeMs > campaign.campaign.endMs)) return false;
  const raw = String(coin);
  const isXyz = raw.startsWith('xyz:');
  if (!el.products.includes(isXyz ? 'xyz-equities' : 'perps')) return false;
  const sym = (isXyz ? raw.split(':')[1] : raw).toUpperCase();
  if ((el.excludeZeroFeePairs || []).map((s) => s.toUpperCase()).includes(sym)) return false;
  return !el.symbols.length || el.symbols.map((s) => s.toUpperCase()).includes(sym);
};

export default function Page() {
  const [state, setState] = useState(null);
  const [drawingId, setDrawingId] = useState(null);
  const [priceUsd, setPriceUsd] = useState(0.01);
  const [addr, setAddr] = useState('');
  const addrRef = useRef(null);
  const [me, setMe] = useState(null); // { volume, credit, entries }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const id = await pub.readContract({ address: JACKPOT, abi: jackpotAbi, functionName: 'currentDrawingId' });
        const s = await pub.readContract({ address: JACKPOT, abi: jackpotAbi, functionName: 'getDrawingState', args: [id] });
        setDrawingId(id); setState(s); setPriceUsd(Number(formatUnits(s.ticketPrice, 6)) || 0.01);
      } catch (e) { setErr(String(e.shortMessage || e.message)); }
    };
    load(); const id = setInterval(load, 15000); return () => clearInterval(id);
  }, []);

  const check = async () => {
    // read the live DOM value — survives paste, autofill and automation that
    // bypasses React's synthetic onChange
    const w = (addrRef.current?.value ?? addr).trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(w)) { setErr('Enter a valid 0x wallet address'); return; }
    setBusy(true); setErr(''); setMe(null);
    try {
      // venue-authoritative fills, same source the engine credits from
      let fills = [], start = campaign.campaign.startMs;
      for (let page = 0; page < 5; page++) {
        const r = await fetch(HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFillsByTime', user: w, startTime: start + 1, endTime: Date.now() }) });
        const batch = await r.json();
        if (!Array.isArray(batch) || !batch.length) break;
        fills.push(...batch);
        if (batch.length < 2000) break;
        start = batch[batch.length - 1].time;
      }
      let volume = 0;
      for (const f of fills) if (qualifies(f.coin, f.time)) volume += Number(f.px) * Number(f.sz);
      const credit = volume * (campaign.economics.feeBps / 10_000) * campaign.economics.rolloverShare;
      const entries = Math.min(Math.floor(credit / priceUsd), campaign.caps.ticketsPerWalletPerWeek);
      setMe({ volume, credit, entries });
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const cutoffMs = state ? Number(state.drawingTime) * 1000 : 0;
  const countdown = useCountdown(cutoffMs);
  const perEntry = 2000; // display rung: $2k volume ≈ 1 entry at 4.5bps vs live testnet price varies
  const ladder = useMemo(() => campaign.multipliers.levels, []);

  return (
    <div className="wrap">
      <div className="hero">
        <div className="crumb">HENCE · REWARD HUB</div>
        <h1>Megapot Rewards</h1>
        <div className="pool">{state ? fmtUsd(state.prizePool) : '…'}</div>
        <div className="sub">today&apos;s pool · draw in {countdown} · drawing #{drawingId?.toString() ?? '…'} · {campaign.campaign.network}</div>
      </div>

      <div className="card">
        <h2>Get something back on every trade</h2>
        <p className="lead">
          Your trading fees roll into reward credit. Credit becomes entries in the daily Megapot pool,
          minted to <b>your own wallet</b> — non-custodial, always yours.
        </p>
        <div className="checkrow">
          <input ref={addrRef} className="addr" placeholder="0x… your trading wallet" defaultValue={addr}
            spellCheck={false}
            onKeyDown={(e) => e.key === 'Enter' && check()} />
          <button className="cta" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check my rewards'}</button>
        </div>
        {me ? (
          <div className="me">
            <div className="row"><span className="k">Qualifying volume (campaign)</span><span>${me.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
            <div className="row"><span className="k">Reward credit accrued</span><span className="gold">${me.credit.toFixed(4)}</span></div>
            <div className="row"><span className="k">Entries unlocked this week</span><span className="gold">{me.entries} 🎟</span></div>
            <div className="note">Entries mint at the daily cutoff. Caps: {campaign.caps.ticketsPerWalletPerDay}/day · {campaign.caps.ticketsPerWalletPerWeek}/week.</div>
          </div>
        ) : null}
        {err ? <div className="err">{err}</div> : null}
      </div>

      <div className="card">
        <h2>Multiplier ladder — behavior earns it</h2>
        {ladder.map((l) => (
          <div className="row" key={l.x}><span className="k">{l.x.toFixed(1)}x</span><span className="lv">{l.requires}</span></div>
        ))}
        <div className="note">Roughly ${perEntry.toLocaleString()} of qualifying volume per entry at 1.0x — higher multipliers earn entries faster.</div>
      </div>

      <div className="card">
        <h2>This campaign</h2>
        <div className="row"><span className="k">Season</span><span>{campaign.campaign.name}</span></div>
        <div className="row"><span className="k">Window</span><span>{new Date(campaign.campaign.startMs).toISOString().slice(0, 10)} → {new Date(campaign.campaign.endMs).toISOString().slice(0, 10)}</span></div>
        <div className="row"><span className="k">Products</span><span>{el.products.join(' · ')}</span></div>
        <div className="row"><span className="k">Qualifying tickers</span><span>{el.symbols.join(' ')}</span></div>
        <div className="note">Parameters live in <code>campaign.json</code> — retuned per season without code changes.</div>
      </div>

      <div className="footer">Powered by Megapot · non-custodial · built on Base by Hence</div>
    </div>
  );
}
