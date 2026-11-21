// Cloud bot: every run, read posts that went live in the last 30 min from Vista Social,
// then paste each link into the matching Content Rewards campaign. Never resubmits a link (submitted.log).
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
// Login state: encrypted file in repo (state.enc), key in STATE_KEY secret. The cloud renews and re-saves it.
const KEY = process.env.STATE_KEY ? Buffer.from(process.env.STATE_KEY, 'hex') : null;
function loadState() {
  if (KEY && fs.existsSync('state.enc')) { const [iv, tag, data] = fs.readFileSync('state.enc', 'utf8').trim().split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString()); }
  return JSON.parse(process.env.STATE_JSON || fs.readFileSync('state.json', 'utf8'));
}
function encState(obj) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]); return [iv, c.getAuthTag(), data].map(x => x.toString('base64')).join('.'); }
async function saveState(ctx) { if (!KEY || !process.env.GITHUB_ACTIONS) return;
  try { const st = await ctx.storageState(); st.cookies = st.cookies.filter(c => /contentrewards\.com|vistasocial\.com/.test(c.domain));
    st.origins = st.origins.filter(o => /contentrewards\.com|vistasocial\.com/.test(o.origin)); fs.writeFileSync('state.enc', encState(st));
    require('child_process').execSync('git add state.enc && git commit -qm state && (git push -q || (git pull -q --rebase && git push -q))', { stdio: 'ignore' }); } catch {} }
const CAMPAIGNS = [
  { name: 'KreekCraft', url: 'https://contentrewards.com/c/campaigns/2eaa14fb-6927-4136-897e-b096e0d907d6',
    profiles: [847128,847051,847137,847115,847138,847050,847139,847116,847119,847117,847120,847118,847121] },
  { name: 'Diego', url: 'https://contentrewards.com/c/campaigns/5d37d3dd-adf3-401f-9c62-24bb54d5087a', profiles: [850559,850560,850561] },
  { name: 'Parker', url: 'https://contentrewards.com/c/campaigns/e41de449-3eca-4343-a11c-b194e7a3379a', profiles: [847045,850798] }, // Clip Nuke
  { name: 'Brett', url: 'https://contentrewards.com/c/campaigns/954cf1f2-1a69-4f0f-b46c-18a9dfddb219', profiles: [850136] },
];
const ENTITY_IDS = '3f972620-e50a-11f1-a33e-81c466c1e067,cf51f540-e1d3-11f1-905a-196ceb9e190b,a4893300-e1d3-11f1-b7d5-835374bce5b6,dddc08d0-e1d3-11f1-a025-4d6af26820fd,5027a300-e1d3-11f1-988c-89194c44b0b5';
const WINDOW_MIN = 28, DRY = process.env.DRY_RUN === '1';
const LOG = 'submitted.log'; const done = new Set(fs.existsSync(LOG) ? fs.readFileSync(LOG,'utf8').split('\n').map(l=>l.split(' ').pop()) : []);
const out = []; let nextDue = Infinity; const _push = out.push.bind(out); out.push = (...a) => { a.forEach(x=>console.log(new Date().toISOString(), x)); return _push(...a); }; const pt = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

let TAGS = []; // [{id,name}]
async function vistaLinks(ctx) {
  const now = Date.now();
  let entityIds = ENTITY_IDS;
  try { const e = await (await ctx.request.get('https://vistasocial.com/api/entities?page=calendar')).json(); if (e.entities?.length) entityIds = e.entities.map(x => x.id).join(','); } catch {}
  try { const t = await (await ctx.request.get('https://vistasocial.com/api/tag?surface=PUBLICATION')).json(); if (Array.isArray(t)) TAGS = t.map(x => ({ id: x._id, name: x.name })); } catch {}
  const body = { timezone: 'America/Los_Angeles', centralDate: '', dateFrom: pt(now - 864e5), dateTo: pt(now + 864e5), entityIds };
  let r = await ctx.request.post('https://vistasocial.com/api/publishing/calendar/get-calendar', { data: { ...body, profileIds: '' } });
  let ct = r.headers()['content-type'] || '';
  let ev = (r.ok() && ct.includes('json')) ? ((await r.json()).events || []).filter(e => e.profile_gid) : [];
  if (!ev.length) { r = await ctx.request.post('https://vistasocial.com/api/publishing/calendar/get-calendar', { data: { ...body, profileIds: CAMPAIGNS.flatMap(c=>c.profiles).join(',') } });
    ct = r.headers()['content-type'] || ''; if (!r.ok() || !ct.includes('json')) throw new Error(`Vista login expired (status ${r.status()}) - needs new sign-in`);
    ev = (await r.json()).events || []; }
  return ev.filter(e => e.status === 'PUBLISHED' && e.result?.published_link)
    .map(e => { const link = e.result.published_link; const tt = link.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
      if (/tiktok\.com/.test(link) && !tt) return null;
      const live = tt ? Number(BigInt(tt[1]) >> 32n) * 1000 : (Date.parse(e.result.published_at || '') || +e.publish_at_time);
      const js = JSON.stringify(e); const tags = TAGS.filter(t => js.includes(`"${t.id}"`) || js.includes(`"${t.name}"`)).map(t => t.name);
      return { profile: +e.profile_gid, link, live, tags }; }).filter(Boolean)
    .filter(e => now - e.live < WINDOW_MIN * 60e3 && now - e.live > -60e3);
}
// Campaign lookup by tag: tag = campaign link/ID, or a word from the campaign title (must match exactly one joined campaign).
const campCache = {};
const norm = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
async function campaignForTag(p, tag) {
  const id = tag.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (id) return { name: tag, url: `https://contentrewards.com/c/campaigns/${id[0]}` };
  if (campCache[tag] !== undefined) return campCache[tag];
  await p.goto('https://contentrewards.com/c/campaigns'); await p.waitForTimeout(4000);
  const body = await p.locator('main').innerText(); const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const cand = [...new Set(lines.filter(l => l.length > 6 && norm(l).includes(norm(tag)) && !/submit clip/i.test(l)))];
  if (cand.length !== 1) { campCache[tag] = null; out.push(`TAG "${tag}": ${cand.length ? 'matches several campaigns: ' + cand.join(' / ') : 'matches no joined campaign'} - not submitted`); return null; }
  await p.getByText(cand[0], { exact: true }).first().click(); await p.waitForTimeout(4000);
  const m = p.url().match(/campaigns\/([0-9a-f-]{36})/); campCache[tag] = m ? { name: cand[0], url: `https://contentrewards.com/c/campaigns/${m[1]}` } : null;
  return campCache[tag];
}
async function pickCampaign(p, post) {
  for (const t of post.tags) { const c = await campaignForTag(p, t); if (c) return c; }
  return CAMPAIGNS.find(c => c.profiles.includes(post.profile)) || null; // untagged: old fixed list
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
  if (process.argv[2] === 'encrypt') { fs.writeFileSync('state.enc', encState(JSON.parse(fs.readFileSync(process.argv[3],'utf8')))); console.log('encrypted'); process.exit(0); }
  const ctx = cdp ? b.contexts()[0] : await b.newContext({ storageState: loadState() });
  const p = await ctx.newPage(); p.setDefaultTimeout(15000); let fail = false;
  for (const sig of ['SIGTERM','SIGINT']) process.on(sig, async () => { await saveState(ctx); process.exit(1); });
  const end = Date.now() + (+process.env.LOOP_MIN || 0) * 60e3;
  let tick = 0;
  do {
    try {
      const posts = await vistaLinks(ctx); if (!(++tick % 10)) { await saveState(ctx); } if (!(tick % 10)) console.log(new Date().toISOString(), 'alive, live posts:', posts.length, 'logged:', done.size);
      for (const post of posts) {
        if (done.has(post.link)) continue; const c = await pickCampaign(p, post); if (!c) { out.push(`no campaign for ${post.link} (tags: ${post.tags.join(',')||'none'})`); done.add(post.link); continue; }
        if (DRY) { out.push(`DRY would submit to ${c.name}: ${post.link}`); done.add(post.link); continue; }
        try { await submit(p, c, post.link); done.add(post.link); fs.appendFileSync(LOG, `${new Date().toISOString()} ${c.name} ${post.link}\n`); saveLog(); out.push(`SUBMITTED to ${c.name}: ${post.link}`); }
        catch (e) { fail = true; out.push(`FAILED ${c.name} ${post.link}: ${e.message.split('\n')[0]}`); await p.screenshot({ path: `fail-${Date.now()}.png` }).catch(()=>{}); }
      }
    } catch (e) { fail = true; out.push('FAILED: ' + e.message.split('\n')[0]); }
    if (Date.now() < end) { await p.waitForTimeout(30000); if (out.length > 200) out.splice(0, 100); }
  } while (Date.now() < end);
  if (!out.length) out.push('nothing new');
  if (!cdp) await saveState(ctx);
  console.log(out.join('\n')); fs.writeFileSync('report.txt', out.join('\n'));
  await p.close(); if (!cdp) await b.close(); process.exit(fail ? 1 : 0);
})();
