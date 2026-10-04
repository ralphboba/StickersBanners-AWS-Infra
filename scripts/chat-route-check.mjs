#!/usr/bin/env node
// Check the Google Chat spaces the paid shipping-change notice goes to.
//
//   node scripts/chat-route-check.mjs            # list which spaces are set up
//   node scripts/chat-route-check.mjs --send     # one TEST line into each space
//   node scripts/chat-route-check.mjs --send --only TX
//
// Reads /sb/<env>/gchat/webhook-url and webhook-url-{GA,NJ,TX} from SSM with
// your AWS login — the same values the Lambda uses. Never prints a URL.
// Touches nothing in Shopify or Order Desk.

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
process.env.SB_ENV = arg('env', 'dev');
const SEND = process.argv.includes('--send');
const ONLY = arg('only')?.toUpperCase();

const { getSecret } = await import('../src/shared/secrets.mjs');
const { sendChat, isChatWebhook, FACILITY_SPACES } = await import('../src/shared/gchat.mjs');

const spaces = [['MAIN', 'webhook-url'], ...FACILITY_SPACES.map((f) => [f, `webhook-url-${f}`])]
  .filter(([name]) => !ONLY || name === ONLY);

let bad = 0;
for (const [name, key] of spaces) {
  let url;
  try { url = await getSecret('gchat', key); } catch { url = undefined; }
  if (!url) { console.log(`${name.padEnd(4)}  /sb/${process.env.SB_ENV}/gchat/${key}: not set`); bad += 1; continue; }
  if (!isChatWebhook(url)) { console.log(`${name.padEnd(4)}  set, but not a Google Chat webhook URL`); bad += 1; continue; }
  if (!SEND) { console.log(`${name.padEnd(4)}  set`); continue; }
  const text = `TEST — shipping-change notices for ${name === 'MAIN' ? 'all orders' : `${name} orders`} will arrive here. Please ignore.`;
  const r = await sendChat({ webhookUrl: url, orderName: 'TEST', text });
  console.log(`${name.padEnd(4)}  ${r.sent ? `sent (HTTP ${r.status})` : `NOT sent: ${r.skipped}${r.status ? ` HTTP ${r.status}` : ''}`}`);
  if (!r.sent) bad += 1;
}
process.exit(bad ? 1 : 0);
