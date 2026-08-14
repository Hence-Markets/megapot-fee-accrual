'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPublicClient, createWalletClient, custom, http, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { CHAIN_ID, RPC, USDC, JACKPOT, SEALED_CALLER, jackpotAbi, usdcAbi, sealedCallerAbi } from '../lib/config';

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const fmtUsd = (v, dec = 6) => '$' + Number(formatUnits(v ?? 0n, dec)).toLocaleString(undefined, { maximumFractionDigits: 0 });

function useCountdown(toMs) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  if (!toMs) return '—';
  const s = Math.max(0, Math.floor((toMs - now) / 1000));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
}

export default function Page() {
  const [account, setAccount] = useState(null);
  const [state, setState] = useState(null);      // Megapot DrawingState
  const [drawingId, setDrawingId] = useState(null);
  const [round, setRound] = useState(null);      // SealedCaller round
  const [players, setPlayers] = useState([]);
  const [myHandle, setMyHandle] = useState(null);
  const [fee, setFee] = useState(null);
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const deployed = !!SEALED_CALLER;

  // Megapot drawing state is the single source of truth for pool + cutoff + ball range
  const refresh = async () => {
    try {
      const id = await pub.readContract({ address: JACKPOT, abi: jackpotAbi, functionName: 'currentDrawingId' });
      const s = await pub.readContract({ address: JACKPOT, abi: jackpotAbi, functionName: 'getDrawingState', args: [id] });
      setDrawingId(id); setState(s);
      if (deployed) {
        const [r, ps, f] = await Promise.all([
          pub.readContract({ address: SEALED_CALLER, abi: sealedCallerAbi, functionName: 'rounds', args: [id] }),
          pub.readContract({ address: SEALED_CALLER, abi: sealedCallerAbi, functionName: 'playersOf', args: [id] }),
          pub.readContract({ address: SEALED_CALLER, abi: sealedCallerAbi, functionName: 'entryFee' }),
        ]);
        setRound(r); setPlayers(ps); setFee(f);
        if (account) {
          const h = await pub.readContract({ address: SEALED_CALLER, abi: sealedCallerAbi, functionName: 'guessHandleOf', args: [id, account] });
          setMyHandle(h !== '0x' + '0'.repeat(64) ? h : null);
        }
      }
    } catch (e) { setErr(String(e.shortMessage || e.message || e)); }
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 15000); return () => clearInterval(id); }, [account]);

  const connect = async () => {
    setErr('');
    try {
      const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + CHAIN_ID.toString(16) }] }); } catch {}
      setAccount(a);
    } catch (e) { setErr(String(e.message || e)); }
  };

  const commit = async () => {
    if (pick == null || !account) return;
    setBusy('encrypting'); setErr('');
    try {
      // Inco Lightning: encrypt the pick client-side; only the ciphertext goes on-chain
      const { Lightning } = await import('@inco/lightning-js/lite');
      const zap = await Lightning.baseSepoliaTestnet({ hostChainRpcUrls: [RPC] });
      const ciphertext = await zap.encrypt(BigInt(pick), { accountAddress: account, dappAddress: SEALED_CALLER });

      const wallet = createWalletClient({ chain: baseSepolia, transport: custom(window.ethereum) });
      setBusy('approving USDC');
      const allowance = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'allowance', args: [account, SEALED_CALLER] });
      if (allowance < fee) {
        const h1 = await wallet.writeContract({ account, address: USDC, abi: usdcAbi, functionName: 'approve', args: [SEALED_CALLER, fee] });
        await pub.waitForTransactionReceipt({ hash: h1 });
      }
      setBusy('committing sealed guess');
      const h2 = await wallet.writeContract({ account, address: SEALED_CALLER, abi: sealedCallerAbi, functionName: 'commitGuess', args: [ciphertext] });
      await pub.waitForTransactionReceipt({ hash: h2 });
      setBusy(''); setPick(null); refresh();
    } catch (e) { setBusy(''); setErr(String(e.shortMessage || e.message || e)); }
  };

  const cutoffMs = state ? Number(state.drawingTime) * 1000 : 0;
  const countdown = useCountdown(cutoffMs);
  const open = state && Date.now() < cutoffMs && !state.jackpotLock;
  const bonusMax = state ? Number(state.bonusballMax) : 0;
  const balls = useMemo(() => Array.from({ length: bonusMax }, (_, i) => i + 1), [bonusMax]);
  const sidePot = round ? round[0] : 0n;

  return (
    <div className="wrap">
      <div className="hero">
        <h1>SEALED CALLER</h1>
        <div className="pool">{state ? fmtUsd(state.prizePool) : '…'}</div>
        <div className="sub">Megapot pool · draw in {countdown} · drawing #{drawingId?.toString() ?? '…'}</div>
      </div>

      <div className="card">
        <h2>Call tonight&apos;s bonusball — sealed</h2>
        {!deployed ? (
          <div className="note">Contract not deployed yet — set NEXT_PUBLIC_SEALED_CALLER.</div>
        ) : myHandle ? (
          <>
            <div className="sealed">🔒 Your call is sealed on-chain until the draw.</div>
            <div className="row"><span className="k">Handle</span><span>{myHandle.slice(0, 10)}…{myHandle.slice(-6)}</span></div>
          </>
        ) : (
          <>
            <div className="balls">
              {balls.map((b) => (
                <button key={b} className={'ball' + (pick === b ? ' on' : '')} onClick={() => setPick(b)}>{b}</button>
              ))}
            </div>
            {!account ? (
              <button className="cta" onClick={connect}>Connect wallet</button>
            ) : (
              <button className="cta" disabled={pick == null || !open || !!busy} onClick={commit}>
                {busy ? busy + '…' : open ? `Seal my call — ${fee ? fmtUsd(fee) : '…'} (real Megapot ticket incl.)` : 'Drawing closed'}
              </button>
            )}
            <div className="note">
              Your entry mints a real Megapot quick-pick to YOUR wallet, and your bonusball call stays
              encrypted (Inco) until the draw — nobody can copy it. Exact hits split the side pot; no
              hits and it rolls into tomorrow.
            </div>
          </>
        )}
        {err ? <div className="err">{err}</div> : null}
      </div>

      <div className="card">
        <h2>Tonight&apos;s round</h2>
        <div className="row"><span className="k">Side pot</span><span>{fmtUsd(sidePot)}</span></div>
        <div className="row"><span className="k">Sealed calls</span><span>{players.length}</span></div>
        <div className="row"><span className="k">Bonusball range</span><span>1–{bonusMax || '…'}</span></div>
        <div className="row"><span className="k">Megapot tickets sold</span><span>{state ? state.globalTicketsBought.toString() : '…'}</span></div>
      </div>

      <div className="footer">Powered by Megapot · sealed with Inco Lightning · built on Base by Hence</div>
    </div>
  );
}
