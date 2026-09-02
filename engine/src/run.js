import { accrue, buy, status, winSweep, load, save } from './engine.js';
import { resetWallets } from './reset.js';

const cmd = process.argv[2];
if (cmd === 'accrue') await accrue();
else if (cmd === 'buy') await buy();
else if (cmd === 'cycle') { await accrue(); await buy(); await winSweep(); }
else if (cmd === 'winsweep') await winSweep();
else if (cmd === 'reset') {
  // node src/run.js reset 0xabc,0xdef  - team-test reset (see reset.js)
  const list = String(process.argv[3] || '').split(/[,\s]+/).filter(Boolean);
  if (!list.length) { console.log('usage: reset <wallet,wallet,...>'); process.exit(1); }
  const s = load(); const r = resetWallets(s, list); save(s);
  console.log(JSON.stringify(r));
}
else if (cmd === 'status') status();
else console.log('usage: node src/run.js accrue|buy|winsweep|cycle|status|reset <wallets>');
