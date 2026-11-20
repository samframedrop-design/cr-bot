// Content Rewards auto-submitter. Runs headless in GitHub Actions using saved login (STATE_JSON).
const { chromium } = require('playwright');
const fs = require('fs');
const CAMPAIGNS = [
  { name: 'KreekCraft', url: 'https://contentrewards.com/c/campaigns/2eaa14fb-6927-4136-897e-b096e0d907d6',
    handles: ['finalboss_clips','final.boss.clips0','finalbossclips0','finalbossclips1','finalbossclips.1',
              'golden.hour.gamin','golden.hour.gamin4','golden.hour.clipa','goldenhourclips-o6e','goldenhourclips-q8t','goldenhourclips-m7s'] },
  { name: 'Brett', url: 'https://contentrewards.com/c/campaigns/954cf1f2-1a69-4f0f-b46c-18a9dfddb219',
    handles: ['hypeframetv1.0'] },
];
const DRY = process.env.DRY_RUN === '1';
const out = [];
async function dismiss(p) {
  for (const n of [/^not now$/i, /^skip for now$/i, /^decline$/i]) {
    const b = p.getByRole('button', { name: n }); if (await b.count()) await b.first().click().catch(()=>{});
  }
}
async function run(p, c) {
  await p.goto(c.url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(4000); await dismiss(p);
  if (/sign in|log in/i.test(await p.locator('body').innerText()) && !(await p.getByText('Submit clip').count()))
    throw new Error('LOGGED OUT - re-run login and update STATE_JSON secret');
  await p.getByText('Submit clip', { exact: true }).last().click(); await p.waitForTimeout(5000);
  const dlg = p.locator('[role=dialog]').filter({ hasText: /requirements/i }).last();
  const text = await dlg.innerText();
  if (/no new clips yet/i.test(text)) { out.push(`${c.name}: no new clips`); return; }
  if (DRY) { fs.writeFileSync(`dialog-${c.name}.html`, await dlg.innerHTML()); await p.screenshot({ path: `dialog-${c.name}.png` }); }
  // Each clip is a selectable item; pick only items mentioning this campaign's handles.
  const items = dlg.locator('label, [role=checkbox], [role=option], button').filter({ hasNotText: /requirements|submit clip|open (tiktok|instagram|youtube)|can't be submitted/i });
  const n = await items.count(); let picked = [];
  for (let i = 0; i < n; i++) {
    const it = items.nth(i); const t = (await it.innerText().catch(()=>'')).toLowerCase();
    const h = c.handles.find(x => new RegExp(`(^|[^a-z0-9._-])@?${x.replace(/\./g,'\\.')}($|[^a-z0-9._-])`).test(t));
    if (!h) continue;
    picked.push(t.replace(/\s+/g,' ').slice(0,80));
    if (!DRY) await it.click();
  }
  if (!picked.length) { out.push(`${c.name}: new clips listed but none from this campaign's accounts`); return; }
  if (DRY) { out.push(`${c.name}: DRY RUN would submit ${picked.length}: ${picked.join(' | ')}`); return; }
  await dlg.getByText(/I've read the requirements/i).click();
  await dlg.getByRole('button', { name: /submit/i }).last().click(); await p.waitForTimeout(5000);
  const done = p.getByRole('button', { name: /^done$/i }); if (await done.count()) await done.first().click();
  await dismiss(p);
  out.push(`${c.name}: SUBMITTED ${picked.length}: ${picked.join(' | ')}`);
}
(async () => {
  const cdp = process.env.CDP;
  const b = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch();
  const ctx = cdp ? b.contexts()[0] : await b.newContext({ storageState: JSON.parse(process.env.STATE_JSON || fs.readFileSync('state.json','utf8')) });
  const p = await ctx.newPage(); let fail = false;
  for (const c of CAMPAIGNS) { try { await run(p, c); } catch (e) { fail = true; out.push(`${c.name}: FAILED ${e.message}`); await p.screenshot({ path: `fail-${c.name}.png` }).catch(()=>{}); } }
  console.log(out.join('\n')); fs.writeFileSync('report.txt', out.join('\n'));
  await p.close(); if (!cdp) await b.close(); process.exit(fail ? 1 : 0);
})();
