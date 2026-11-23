// Cloud bot: every 30s, read posts that went live in the last 30 min from Vista Social,
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
// Only save the login when Vista accepted it on the last check. Saving a dead login would overwrite a fresh one
// uploaded by relogin (this is what kept the bot broken after Vista ended its session on Nov 21).
let vistaOK = false, crOK = true;
// Vista API key (encrypted in vista.enc with the same STATE_KEY). With it the bot reads posts through Vista's MCP
// server, which never logs out - the website login is only a fallback.
const VKEY = (() => { try { if (process.env.VISTA_API_KEY) return process.env.VISTA_API_KEY.trim();
  if (KEY && fs.existsSync('vista.enc')) { const [iv, tag, data] = fs.readFileSync('vista.enc', 'utf8').trim().split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(data), d.final()]).toString().trim(); } } catch (e) { console.log('vista.enc unreadable', e.message); } return null; })();
const MCP_URL = 'https://mcp.vistasocial.com/mcp'; let mcpSid = null, mcpId = 1;
async function mcpRpc(body) {
  const r = await fetch(MCP_URL, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': VKEY, ...(mcpSid ? { 'mcp-session-id': mcpSid } : {}) } });
  const sid = r.headers.get('mcp-session-id'); if (sid) mcpSid = sid;
  const t = await r.text(); if (!r.ok) throw new Error(`Vista MCP ${r.status}: ${t.slice(0, 120)}`);
  if (body.id === undefined) return null;
  const j = JSON.parse(t.includes('data:') ? t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop() : t);
  if (j.error) throw new Error('Vista MCP error: ' + JSON.stringify(j.error).slice(0, 150)); return j.result; }
async function mcpTool(name, args, retry = true) {
  try { if (!mcpSid) { await mcpRpc({ jsonrpc: '2.0', id: mcpId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cr-bot', version: '2' } } });
      await mcpRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }); }
    const res = await mcpRpc({ jsonrpc: '2.0', id: mcpId++, method: 'tools/call', params: { name, arguments: args } });
    const txt = (res.content || []).map(c => c.text || '').join(''); if (res.isError) throw new Error(`Vista ${name}: ${txt.slice(0, 150)}`);
    return JSON.parse(txt); }
  catch (e) { if (retry) { mcpSid = null; return mcpTool(name, args, false); } throw e; } }
let mcpProfiles = null, mcpProfilesAt = 0;
async function vistaLinksMCP() {
  const now = Date.now();
  if (!mcpProfiles || now - mcpProfilesAt > 30 * 60e3) { const pr = await mcpTool('findProfiles', { fields: ['id'], limit: 200 });
    mcpProfiles = (Array.isArray(pr) ? pr : pr.profiles || pr.rows || []).map(x => x.id ?? x[0]).filter(Boolean); mcpProfilesAt = now; }
  if (!mcpProfiles.length) throw new Error('Vista MCP returned no profiles');
  const day = d => new Date(d).toISOString().slice(0, 10);
  const r = await mcpTool('listPosts', { profile_ids: mcpProfiles, status: ['PUBLISHED'], dateFrom: day(now - 864e5), dateTo: day(now + 864e5), timezone: 'Etc/UTC', sort: 'newest_first', limit: 150 });
  const rows = (r.rows || []).map(x => Object.fromEntries(r.columns.map((c, i) => [c, x[i]])));
  return rows.filter(e => e.published_link).map(e => { const link = e.published_link; const tt = link.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
      if (/tiktok\.com/.test(link) && !tt) return null;
      const live = tt ? Number(BigInt(tt[1]) >> 32n) * 1000 : Date.parse(e.publish_at + 'Z');
      return { profile: +e.profile_id, link, live, tags: e.tags || [] }; }).filter(Boolean)
    .filter(e => now - e.live < WINDOW_MIN * 60e3 && now - e.live > -60e3); }
function sh(cmd) { return require('child_process').execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
const LOG = 'submitted.log'; const myLog = []; // log lines written by this run, re-applied if we have to reset to the remote
let lastStateText = fs.existsSync('state.enc') ? fs.readFileSync('state.enc', 'utf8') : '';
// Make the local copy match GitHub again (never gets stuck mid-rebase), keeping this run's submitted.log lines.
function resetToRemote() {
  try { sh('git rebase --abort'); } catch {}
  try { sh('git fetch -q origin main && git reset -q --hard origin/main'); } catch { return; }
  const cur = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const miss = myLog.filter(l => !cur.includes(l.split(' ').pop()));
  if (miss.length) fs.appendFileSync(LOG, (cur && !cur.endsWith('\n') ? '\n' : '') + miss.join('\n') + '\n');
}
function gitSync(msg, files) { if (!process.env.GITHUB_ACTIONS) return;
  try { sh(`git add -f ${files} && (git diff --cached --quiet || git commit -qm ${msg}) && git push -q`); return; } catch {}
  resetToRemote(); // someone else pushed (another run, or a new login upload): keep theirs, re-add only our log lines
  try { sh(`git add -f ${LOG} && (git diff --cached --quiet || git commit -qm log) && git push -q`); } catch {} }
async function saveState(ctx) { if (!KEY || !process.env.GITHUB_ACTIONS || !crOK || !(vistaOK || VKEY)) return;
  try { const st = await ctx.storageState(); st.cookies = st.cookies.filter(c => /contentrewards\.com|vistasocial\.com/.test(c.domain));
    st.origins = st.origins.filter(o => /contentrewards\.com|vistasocial\.com/.test(o.origin)); lastStateText = encState(st); fs.writeFileSync('state.enc', lastStateText);
    gitSync('state', 'state.enc'); } catch {} }
// While logged out: pick up a fresh state.enc uploaded by "Fix Vista Login" without restarting the run.
async function reloadState(ctx) { if (!KEY || !process.env.GITHUB_ACTIONS) return false;
  resetToRemote(); try { sh(`git add -f ${LOG} && (git diff --cached --quiet || git commit -qm log) && git push -q`); } catch {}
  const now = fs.existsSync('state.enc') ? fs.readFileSync('state.enc', 'utf8') : '';
  if (!now || now === lastStateText) return false; lastStateText = now;
  try { const st = loadState(); await ctx.clearCookies(); await ctx.addCookies(st.cookies); console.log(new Date().toISOString(), 'loaded new login from state.enc'); return true; }
  catch (e) { console.log('reload failed', e.message); return false; } }
const CAMPAIGNS = [
  { name: 'KreekCraft', url: 'https://contentrewards.com/c/campaigns/2eaa14fb-6927-4136-897e-b096e0d907d6',
    profiles: [847128,847051,847137,847115,847138,847050,847139,847116,847119,847117,847120,847118,847121] },
  { name: 'Diego', url: 'https://contentrewards.com/c/campaigns/5d37d3dd-adf3-401f-9c62-24bb54d5087a', profiles: [850559,850560,850561] },
  { name: 'Parker', url: 'https://contentrewards.com/c/campaigns/e41de449-3eca-4343-a11c-b194e7a3379a', profiles: [847045,850798] }, // Clip Nuke
  { name: 'Brett', url: 'https://contentrewards.com/c/campaigns/954cf1f2-1a69-4f0f-b46c-18a9dfddb219', profiles: [850136] },
];
const ENTITY_IDS = '3f972620-e50a-11f1-a33e-81c466c1e067,cf51f540-e1d3-11f1-905a-196ceb9e190b,a4893300-e1d3-11f1-b7d5-835374bce5b6,dddc08d0-e1d3-11f1-a025-4d6af26820fd,5027a300-e1d3-11f1-988c-89194c44b0b5';
// Content Rewards only accepts a clip for 30 minutes after it was posted, so only look at posts younger than that.
// (Anything missed while logged out can't be submitted later - that's why login alerts matter.)
const WINDOW_MIN = +process.env.WINDOW_MIN || 30, DRY = process.env.DRY_RUN === '1';
const TOO_OLD = /submitted for 30 minutes|can't be submitted|too old|expired|older than/i;
const tries = {}; const MAX_TRIES = 3; // per run, so one bad link can't be retried every 30s
// Email the owner (GitHub notifies on new issues) when a login dies; close the issue when it works again.
const ALERT = 'cr-bot ALERT: login expired';
const alerted = {};
function alertOn(what, msg) { if (alerted[what] || !process.env.GITHUB_ACTIONS || !process.env.GH_TOKEN) return; alerted[what] = true;
  try { if (sh(`gh issue list --state open --search "in:title ${ALERT}" --json number --jq length`) !== '0') return;
    const owner = (process.env.GITHUB_REPOSITORY || '').split('/')[0];
    fs.writeFileSync('alert.md', `@${owner} the bot can't submit posts right now.\n\n**${msg}**\n\nFix: on your Mac, double-click **Fix Vista Login** on your Desktop and log in if asked. The bot picks up the new login by itself within about 5 minutes. Content Rewards only accepts clips for 30 minutes after posting, so posts that go live while the bot is logged out cannot be submitted later - fix it fast. This issue closes itself when it's working again.`);
    sh(`gh issue create --title "${ALERT} (${what})" --body-file alert.md`); } catch (e) { console.log('alert failed', e.message); } }
// First success of a run also closes alerts left open by earlier runs (alerted[what] starts undefined).
function alertOff(what) { if (alerted[what] === false) return; alerted[what] = false;
  if (!process.env.GITHUB_ACTIONS || !process.env.GH_TOKEN) return;
  try { for (const n of sh(`gh issue list --state open --search "in:title ${ALERT} (${what})" --json number --jq ".[].number"`).split('\n').filter(Boolean))
    sh(`gh issue close ${n} --comment "Working again - login is back and posts are being submitted."`); } catch {} }
const done = new Set(fs.existsSync(LOG) ? fs.readFileSync(LOG,'utf8').split('\n').map(l=>l.split(' ').pop()) : []);
const out = []; let nextDue = Infinity; const _push = out.push.bind(out); out.push = (...a) => { a.forEach(x=>console.log(new Date().toISOString(), x)); return _push(...a); }; const pt = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

let TAGS = []; // [{id,name}]
async function vistaLinks(ctx) {
  const now = Date.now();
  // Ask for exactly the profiles that exist right now. Vista returns NO posts at all if the list holds a profile
  // that was removed (847128 did this), and an empty list also returns nothing - so never use a hard-coded list.
  let entityIds = ENTITY_IDS, profileIds = '';
  const er = await ctx.request.get('https://vistasocial.com/api/entities?page=calendar');
  if (!er.ok() || !(er.headers()['content-type'] || '').includes('json')) throw new Error(`Vista login expired (status ${er.status()}) - needs new sign-in`);
  const e = await er.json().catch(() => ({}));
  if (e.entities?.length) { entityIds = e.entities.map(x => x.id).join(','); profileIds = [...new Set(e.entities.flatMap(x => (x.profiles || []).map(p => p.id)))].join(','); }
  if (!profileIds) throw new Error('Vista login expired (no profiles visible) - needs new sign-in');
  try { const t = await (await ctx.request.get('https://vistasocial.com/api/tag?surface=PUBLICATION')).json(); if (Array.isArray(t)) TAGS = t.map(x => ({ id: x._id, name: x.name })); } catch {}
  const body = { timezone: 'America/Los_Angeles', centralDate: '', dateFrom: pt(now - WINDOW_MIN * 60e3 - 864e5), dateTo: pt(now + 864e5), entityIds, profileIds };
  const r = await ctx.request.post('https://vistasocial.com/api/publishing/calendar/get-calendar', { data: body });
  if (!r.ok() || !(r.headers()['content-type'] || '').includes('json')) throw new Error(`Vista login expired (status ${r.status()}) - needs new sign-in`);
  const ev = ((await r.json()).events || []).filter(e => e.profile_gid);
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
  await p.goto('https://contentrewards.com/c/campaigns'); await p.waitForTimeout(4000); await closePopups(p);
  const body = await p.locator('main').innerText(); const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const cand = [...new Set(lines.filter(l => l.length > 6 && norm(l).includes(norm(tag)) && !/submit clip/i.test(l)))];
  if (cand.length !== 1) { campCache[tag] = null; out.push(`TAG "${tag}": ${cand.length ? 'matches several campaigns: ' + cand.join(' / ') : 'matches no joined campaign'} - not submitted`); return null; }
  await p.getByText(cand[0], { exact: true }).first().click(); await p.waitForTimeout(4000);
  const m = p.url().match(/campaigns\/([0-9a-f-]{36})/); campCache[tag] = m ? { name: cand[0], url: `https://contentrewards.com/c/campaigns/${m[1]}` } : null;
  return campCache[tag];
}
async function pickCampaign(p, post) {
  for (const t of post.tags) { try { const c = await campaignForTag(p, t); if (c) return c; } catch (e) { out.push(`tag lookup error "${t}": ${e.message.split('\n')[0]}`); await p.screenshot({ path: `tagfail-${Date.now()}.png` }).catch(()=>{}); } }
  return CAMPAIGNS.find(c => c.profiles.includes(post.profile)) || null; // untagged: old fixed list
}
const POPUP_BTN = /^(not now|skip( for now)?|maybe later|no,? thanks|dismiss|close|decline|reject( all)?|got it|ok(ay)?|continue|later|cancel)$/i;
// Close anything that is not the submit box: cookie banners, Discord prompts, announcements, tours.
async function closePopups(p, keep) {
  for (let round = 0; round < 3; round++) {
    let closed = false;
    for (const d of await p.locator('[role=dialog], [role=alertdialog], [aria-modal=true], [class*=modal i], [class*=popup i], [class*=toast i], [class*=banner i]').all()) {
      if (!(await d.isVisible().catch(() => false))) continue;
      const t = (await d.innerText().catch(() => '')).toLowerCase();
      if (keep && keep.test(t)) continue;
      for (const btn of await d.locator('button, [role=button], a').all()) {
        const label = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('aria-label').catch(() => '')) || '').trim();
        if (POPUP_BTN.test(label) || /^(close|dismiss)/i.test(await btn.getAttribute('aria-label').catch(() => '') || '')) { await btn.click({ timeout: 3000 }).catch(() => {}); closed = true; break; }
      }
    }
    if (!closed) break; await p.waitForTimeout(700);
  }
}
const SUBMIT_BOX = /paste a link|requirements|submit/i;
async function clickSmart(p, loc) { // normal click, then press-and-hold if the button needs holding
  const box = await loc.boundingBox(); const label = (await loc.innerText().catch(() => '')).toLowerCase();
  if (/hold/.test(label) && box) { await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.waitForTimeout(4000); await p.mouse.up(); return; }
  await loc.click({ timeout: 8000 }).catch(async () => { await loc.click({ force: true, timeout: 5000 }); });
}
async function findOne(scope, list) { for (const l of list) { const x = scope.locator(l).filter({ visible: true }); if (await x.count()) return x.last(); } return null; }
async function submit(p, c, link) {
  await p.goto(c.url); await p.waitForTimeout(3500); await closePopups(p);
  if (/sign in|log in|continue with google/i.test(await p.locator('body').innerText()) && !(await p.getByText(/submit/i).count())) throw new Error('Content Rewards logged out - needs new sign-in');
  const opener = await findOne(p, ['button:has-text("Submit clip")', 'a:has-text("Submit clip")', 'text=/^submit (a )?(clip|video|post|content)$/i', 'button:has-text("Submit")']);
  if (!opener) throw new Error('no Submit button on campaign page');
  await clickSmart(p, opener); await p.waitForTimeout(3000); await closePopups(p, SUBMIT_BOX);
  const dlg = (await findOne(p, ['[role=dialog]:has-text("link")', '[role=dialog]:has-text("requirements")', '[aria-modal=true]'])) || p.locator('body');
  const inp = await findOne(dlg, ['input[placeholder*="link" i]', 'input[placeholder*="url" i]', 'input[type=url]', 'textarea', 'input[type=text]']);
  if (!inp) throw new Error('no link box in submit dialog');
  await inp.fill(link); await inp.press('Enter').catch(() => {}); await p.waitForTimeout(3500); await closePopups(p, SUBMIT_BOX);
  // tick every unticked agreement box
  for (const cb of await dlg.locator('input[type=checkbox], [role=checkbox]').all()) {
    const on = (await cb.getAttribute('aria-checked').catch(() => null)) === 'true' || (await cb.isChecked().catch(() => false));
    if (!on) await cb.click({ force: true, timeout: 4000 }).catch(() => {});
  }
  const agree = dlg.getByText(/I've read|requirements|I agree|accept/i).last();
  if (!(await dlg.locator('[aria-checked=true], input[type=checkbox]:checked').count()) && await agree.count()) await agree.click().catch(() => {});
  await p.waitForTimeout(800);
  const btn = await findOne(dlg, ['button:has-text("Submit clip")', 'button:has-text("Hold")', 'button:has-text("Submit")', 'button[type=submit]']);
  if (!btn) throw new Error('no final Submit button');
  if (!(await btn.isEnabled())) throw new Error('Submit disabled: ' + (await dlg.innerText()).slice(0, 200).replace(/\n/g, ' '));
  if (process.env.SUBMIT_TEST) return 'test-ok';
  await clickSmart(p, btn); await p.waitForTimeout(5000);
  const after = (await p.locator('body').innerText()).toLowerCase();
  const done = p.getByRole('button', { name: /^(done|close|ok|got it)$/i }); if (await done.count()) await done.first().click().catch(() => {});
  await closePopups(p);
  if (/already (been )?submitted|duplicate/.test(after)) return 'already';
  if (/too old|expired|older than|30 minutes/.test(after) && !/you have 30 minutes/.test(after)) throw new Error('rejected as too old');
  if (/error|failed|try again|something went wrong/.test(after) && await inp.isVisible().catch(() => false)) throw new Error('Content Rewards showed an error after submit');
  return 'ok';
}
(async () => {
  const cdp = process.env.CDP;
  const b = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch();
  if (process.argv[2] === 'encrypt') { fs.writeFileSync('state.enc', encState(JSON.parse(fs.readFileSync(process.argv[3],'utf8')))); console.log('encrypted'); process.exit(0); }
  const ctx = cdp ? b.contexts()[0] : await b.newContext({ storageState: loadState() });
  const p = await ctx.newPage(); p.setDefaultTimeout(15000); let fail = false;
  for (const sig of ['SIGTERM','SIGINT']) process.on(sig, async () => { await saveState(ctx); process.exit(1); });
  const end = Date.now() + (+process.env.LOOP_MIN || 0) * 60e3;
  console.log(new Date().toISOString(), 'Vista source:', VKEY ? 'MCP with API key (no logout)' : 'website login only');
  let tick = 0, vistaFails = 0;
  do {
    let posts = null;
    let mcpErr = null;
    if (VKEY) try { posts = await vistaLinksMCP(); vistaFails = 0; alertOff('Vista'); } catch (e) { mcpErr = e; if (!(tick % 20)) console.log('MCP failed, trying website login:', e.message); }
    if (!posts) try { posts = await vistaLinks(ctx); vistaOK = true; vistaFails = 0; alertOff('Vista'); }
    catch (e) { vistaOK = false; vistaFails++; fail = true; if (mcpErr) e.message = `${mcpErr.message} | ${e.message}`;
      if (vistaFails === 1 || !(vistaFails % 120)) out.push(`FAILED (${vistaFails}x in a row): ` + e.message.split('\n')[0]);
      if (vistaFails >= 4) alertOn('Vista', 'Vista Social logged the bot out (Vista ends website logins after about 12 hours).'); // 4 in a row = not a one-off server hiccup
      if (!(vistaFails % 10) && await reloadState(ctx)) out.push('Picked up a new login from state.enc - retrying'); }
    if (posts) try {
      if (!(++tick % 10)) { await saveState(ctx); console.log(new Date().toISOString(), 'alive, live posts:', posts.length, 'logged:', done.size); }
      for (const post of posts) {
        if (done.has(post.link)) continue; const c = await pickCampaign(p, post); if (!c) { out.push(`no campaign for ${post.link} (tags: ${post.tags.join(',')||'none'})`); done.add(post.link); continue; }
        if (DRY) { out.push(`DRY would submit to ${c.name}: ${post.link}`); done.add(post.link); continue; }
        try { const res = await submit(p, c, post.link); done.add(post.link); crOK = true; alertOff('Content Rewards'); if (res === 'already') out.push('(Content Rewards says already submitted)');
          const line = `${new Date().toISOString()} ${c.name} ${post.link}`; myLog.push(line); fs.appendFileSync(LOG, line + '\n'); gitSync('log', LOG); out.push(`SUBMITTED to ${c.name}: ${post.link}`); }
        catch (e) { fail = true; const msg = e.message.split('\n')[0]; out.push(`FAILED ${c.name} ${post.link}: ${msg}`); await p.screenshot({ path: `fail-${Date.now()}.png` }).catch(()=>{});
          if (/logged out/.test(msg)) { crOK = false; alertOn('Content Rewards', 'Content Rewards logged the bot out.'); break; }
          tries[post.link] = (tries[post.link] || 0) + 1;
          if (tries[post.link] >= MAX_TRIES || (TOO_OLD.test(msg) && Date.now() - post.live > 25 * 60e3)) done.add(post.link); } // a fresh post may just not be visible to CR yet, so keep trying those
      }
    } catch (e) { fail = true; out.push('FAILED: ' + e.message.split('\n')[0]); }
    if (Date.now() < end) { await p.waitForTimeout(30000); if (out.length > 200) out.splice(0, 100); }
  } while (Date.now() < end);
  if (!out.length) out.push('nothing new');
  if (!cdp) await saveState(ctx);
  console.log(out.join('\n')); fs.writeFileSync('report.txt', out.join('\n'));
  await p.close(); if (!cdp) await b.close(); process.exit(fail ? 1 : 0);
})();
