import { accrue, buy, status, winSweep } from './engine.js';

const cmd = process.argv[2];
if (cmd === 'accrue') await accrue();
else if (cmd === 'buy') await buy();
else if (cmd === 'cycle') { await accrue(); await buy(); await winSweep(); }
else if (cmd === 'status') status();
else console.log('usage: node src/run.js accrue|buy|cycle|status');
