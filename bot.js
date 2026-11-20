// Cloud bot: every run, read posts that went live in the last 30 min from Vista Social,
// then paste each link into the matching Content Rewards campaign. Never resubmits a link (submitted.log).
const { chromium } = require('playwright'); const fs = require('fs');
const CAMPAIGNS = [
  { name: 'KreekCraft', url: 'https://contentrewards.com/c/campaigns/2eaa14fb-6927-4136-897e-b096e0d907d6',
    profiles: [847128,847051,847137,847115,847138,847050,847139,847116,847119,847117,847120,847118,847121] },
  { name: 'Diego', url: 'https://contentrewards.com/c/campaigns/5d37d3dd-adf3-401f-9c62-24bb54d5087a', profiles: [850559,850560,850561] },
  { name: 'Brett', url: 'https://contentrewards.com/c/campaigns/954cf1f2-1a69-4f0f-b46c-18a9dfddb219', profiles: [850136] },
];
const ENTITY_IDS = '3f972620-e50a-11f1-a33e-81c466c1e067,cf51f540-e1d3-11f1-905a-196ceb9e190b,a4893300-e1d3-11f1-b7d5-835374bce5b6,dddc08d0-e1d3-11f1-a025-4d6af26820fd,5027a300-e1d3-11f1-988c-89194c44b0b5';
const WINDOW_MIN = 28, DRY = process.env.DRY_RUN === '1';
const LOG = 'submitted.log'; const done = new Set(fs.existsSync(LOG) ? fs.readFileSync(LOG,'utf8').split('\n').map(l=>l.split(' ').pop()) : []);
const out = []; let nextDue = Infinity; const _push = out.push.bind(out); out.push = (...a) => { a.forEach(x=>console.log(new Date().toISOString(), x)); return _push(...a); }; const pt = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

async function vistaLinks(ctx) {
  const now = Date.now();
  const r = await ctx.request.post('https://vistasocial.com/api/publishing/calendar/get-calendar', { data: {
    timezone: 'America/Los_Angeles', centralDate: '', dateFrom: pt(now - 864e5), dateTo: pt(now + 864e5),
    profileIds: CAMPAIGNS.flatMap(c=>c.profiles).join(','), entityIds: ENTITY_IDS } });
  if (!r.ok()) throw new Error(`Vista ${r.status()} - Vista login expired? re-run setup`);
  const ev = (await r.json()).events || [];
  const ids = new Set(CAMPAIGNS.flatMap(c=>c.profiles).map(String));
  nextDue = Math.min(Infinity, ...ev.filter(e => ids.has(String(e.profile_gid)) && /SCHEDULED|PROCESSING|APPROVED|REVIEW/.test(e.status))
    .map(e => +e.publish_at_time).filter(t => t > now - 30*60e3));
  return ev.filter(e => e.status === 'PUBLISHED' && e.result?.published_link)
    .map(e => { const link = e.result.published_link; const tt = link.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
      if (/tiktok\.com/.test(link) && !tt) return null; // profile-only link: video not ready yet
      const live = tt ? Number(BigInt(tt[1]) >> 32n) * 1000 : (Date.parse(e.result.published_at || '') || +e.publish_at_time);
      return { profile: +e.profile_gid, link, live }; }).filter(Boolean)
    .filter(e => now - e.live < WINDOW_MIN * 60e3 && now - e.live > -60e3);
}
function saveLog() { if (!process.env.GITHUB_ACTIONS) return; try { require('child_process').execSync('git add -f submitted.log && git commit -qm log && (git push -q || (git pull -q --rebase && git push -q))', { stdio: 'ignore' }); } catch {} }
async function closePopups(p) { for (const n of [/^not now$/i,/^skip for now$/i,/^decline$/i]) { const x=p.getByRole('button',{name:n}); if (await x.count()) await x.first().click().catch(()=>{}); } }
async function submit(p, c, link) {
  await p.goto(c.url); await p.waitForTimeout(3500); await closePopups(p);
  const btn = p.getByText('Submit clip', { exact: true }).last();
  if (!(await btn.count())) throw new Error('Content Rewards logged out - re-run setup');
  await btn.click(); await p.waitForTimeout(3000);
  const inp = p.getByPlaceholder(/paste a link/i); await inp.fill(link); await inp.press('Enter').catch(()=>{}); await p.waitForTimeout(3500);
  await p.getByText(/I've read the requirements/i).last().click(); await p.waitForTimeout(800);
  const sb = p.getByRole('button', { name: /^submit/i }).last();
  if (!(await sb.isEnabled())) throw new Error('Submit disabled: ' + (await p.locator('[role=dialog]').last().innerText()).slice(0,200).replace(/\n/g,' '));
  await sb.click(); await p.waitForTimeout(4000);
  const d = p.getByRole('button', { name: /^done$/i }); if (await d.count()) await d.first().click();
  await closePopups(p);
}
(async () => {
  const cdp = process.env.CDP;
  const b = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch();
  const ctx = cdp ? b.contexts()[0] : await b.newContext({ storageState: JSON.parse(process.env.STATE_JSON || fs.readFileSync('state.json','utf8')) });
  const p = await ctx.newPage(); p.setDefaultTimeout(15000); let fail = false;
  const end = Date.now() + (+process.env.LOOP_MIN || 0) * 60e3;
  let tick = 0;
  do {
    try {
      const posts = await vistaLinks(ctx); if (!(++tick % 10)) console.log(new Date().toISOString(), 'alive, live posts:', posts.length, 'logged:', done.size);
      for (const post of posts) {
        const c = CAMPAIGNS.find(c => c.profiles.includes(post.profile)); if (!c || done.has(post.link)) continue;
        if (DRY) { out.push(`DRY would submit to ${c.name}: ${post.link}`); done.add(post.link); continue; }
        try { await submit(p, c, post.link); done.add(post.link); fs.appendFileSync(LOG, `${new Date().toISOString()} ${c.name} ${post.link}\n`); saveLog(); out.push(`SUBMITTED to ${c.name}: ${post.link}`); }
        catch (e) { fail = true; out.push(`FAILED ${c.name} ${post.link}: ${e.message.split('\n')[0]}`); await p.screenshot({ path: `fail-${Date.now()}.png` }).catch(()=>{}); }
      }
    } catch (e) { fail = true; out.push('FAILED: ' + e.message.split('\n')[0]); }
    if (Date.now() < end) { await p.waitForTimeout(30000); if (out.length > 200) out.splice(0, 100); }
  } while (Date.now() < end);
  if (!out.length) out.push('nothing new');
  console.log(out.join('\n')); fs.writeFileSync('report.txt', out.join('\n'));
  await p.close(); if (!cdp) await b.close(); process.exit(fail ? 1 : 0);
})();
