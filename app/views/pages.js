// Server-rendered pages. Brand: deep brown, cream, teal (taken from the Bali logo).
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { naira } = require('../lib/core');

const FONT = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';
const HEAD = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#1a0d07"><title>${esc(title)}</title>${FONT}`;

const GUEST_CSS = `<style>
:root{--bg:#1a0d07;--bg2:#2a140a;--card:rgba(255,255,255,.05);--line:rgba(232,201,155,.16);--text:#f6ead9;--muted:#b9a68f;--cream:#e8c99b;--teal:#3aa3bd;--ok:#62c597;--bad:#f0776a;--r:16px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;min-height:100%;background:radial-gradient(1200px 600px at 50% -10%,#3b1c0e 0,var(--bg) 60%);color:var(--text);font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:520px;margin:0 auto;padding:0 18px calc(40px + env(safe-area-inset-bottom))}
.banner{height:150px;margin:0 -18px 22px;background:#3a1a0d url(/assets/welcome.png) center/cover no-repeat;border-bottom:1px solid var(--line);position:relative}
.banner::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(26,13,7,0) 40%,var(--bg) 100%)}
h1{font-size:26px;line-height:1.15;margin:0 0 6px;font-weight:700;letter-spacing:-.4px}
.sub{color:var(--muted);font-size:14.5px;line-height:1.5;margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px}
label{display:block;font-size:12.5px;font-weight:600;color:var(--cream);letter-spacing:.3px;text-transform:uppercase;margin:0 0 7px}
.field{margin-bottom:16px}
input,select{width:100%;background:rgba(0,0,0,.28);border:1px solid var(--line);border-radius:12px;color:var(--text);font:inherit;font-size:16px;padding:14px 14px;outline:none;transition:border-color .15s,box-shadow .15s;appearance:none;-webkit-appearance:none;color-scheme:dark}
input:focus,select:focus{border-color:var(--cream);box-shadow:0 0 0 3px rgba(232,201,155,.15)}
.err{color:var(--bad);font-size:13px;margin-top:6px;min-height:0}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stepper{display:flex;align-items:center;background:rgba(0,0,0,.28);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.stepper button{width:52px;height:50px;background:none;border:none;color:var(--cream);font-size:24px;cursor:pointer}
.stepper button:active{background:rgba(232,201,155,.12)}
.stepper input{border:none;background:none;text-align:center;font-weight:700;font-size:18px;box-shadow:none;padding:0}
.price{display:flex;gap:12px;align-items:flex-start;background:rgba(58,163,189,.1);border:1px solid rgba(58,163,189,.3);border-radius:12px;padding:13px 14px;margin:4px 0 18px;font-size:13.5px;line-height:1.5;color:#cfe9f0}
.price b{color:#fff}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border:none;border-radius:14px;padding:16px;font:inherit;font-weight:700;font-size:16px;cursor:pointer;color:#2a140a;background:linear-gradient(180deg,#f0d6ab,#e0b97c);box-shadow:0 6px 24px rgba(224,185,124,.25);text-decoration:none;transition:transform .1s}
.btn:active{transform:scale(.98)}.btn[disabled]{opacity:.6}
.btn.ghost{background:transparent;color:var(--cream);border:1px solid var(--line);box-shadow:none}
.btn.small{padding:11px 14px;font-size:14px;width:auto}
.btn.danger{background:rgba(240,119,106,.12);color:var(--bad);border:1px solid rgba(240,119,106,.4);box-shadow:none}
.tick{width:72px;height:72px;border-radius:50%;background:rgba(98,197,151,.14);border:2px solid var(--ok);display:flex;align-items:center;justify-content:center;margin:6px auto 18px;font-size:34px;color:var(--ok)}
.tick.wait{background:rgba(232,201,155,.1);border-color:var(--cream);color:var(--cream)}
.center{text-align:center}
.kv{display:grid;grid-template-columns:auto 1fr;gap:10px 16px;margin:6px 0 4px;font-size:15px}.kv dt{color:var(--muted)}.kv dd{margin:0;font-weight:600;text-align:right}
.foot{text-align:center;color:var(--muted);font-size:12px;margin-top:26px;opacity:.7}
.res{padding:16px}.res+.res{margin-top:12px}.pill{display:inline-block;font-size:11.5px;font-weight:700;padding:4px 9px;border-radius:99px;background:rgba(98,197,151,.14);color:var(--ok)}.pill.w{background:rgba(232,201,155,.12);color:var(--cream)}
.note{font-size:13px;color:var(--muted);margin:8px 0 12px;line-height:1.5}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:flex-end;justify-content:center;z-index:50}.modal.open{display:flex}
.sheet{background:#2a140a;border:1px solid var(--line);border-radius:20px 20px 0 0;padding:22px 18px calc(22px + env(safe-area-inset-bottom));width:100%;max-width:520px}
</style>`;

function notFound() {
  return `${HEAD('Link not found')}${GUEST_CSS}</head><body><div class="wrap"><div class="banner"></div><h1>This link is not valid</h1><p class="sub">Please message Bali on WhatsApp again and tap the button in the reply.</p></div></body></html>`;
}

function form({ S, T, token, phone, askUrl, waNumber }) {
  const wa = `https://wa.me/${String(waNumber || '').replace(/D/g, '')}`;
  const today = T.todayStr();
  const max = T.addDaysISO(today, S.max_days_ahead);
  const total = S.reservation_fee_kobo + S.service_fee_kobo;
  const maxG = S.max_guests_per_booking > 0 ? S.max_guests_per_booking : 2000;
  const cfg = { token, today, max, closed: S.closed_weekdays || [], maxGuests: maxG, pay: S.payments_enabled, total: naira(total) };
  return `${HEAD('Reserve a table')}${GUEST_CSS}</head><body><div class="wrap"><div class="banner"><a href="${esc(wa)}" aria-label="Back to WhatsApp" style="position:absolute;top:14px;left:16px;z-index:2;width:38px;height:38px;border-radius:50%;background:rgba(26,13,7,.65);border:1px solid var(--line);color:var(--cream);font-size:26px;line-height:34px;text-align:center;text-decoration:none">‹</a></div>
<h1>Reserve a table</h1><p class="sub">Tell us when you are coming and we will hold your table.</p>
<form id="f" class="card" novalidate>
 <div class="field"><label for="name">Full name</label><input id="name" name="name" autocomplete="name" placeholder="e.g. Ada Okafor" maxlength="60"><div class="err" data-e="name"></div></div>
 <div class="field"><label for="phone">Phone number</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(phone ? '+' + phone : '')}" placeholder="+234 800 000 0000"><div class="err" data-e="phone"></div></div>
 <div class="row2">
  <div class="field"><label for="date">Date</label><input id="date" name="date" type="date" min="${today}" max="${max}"><div class="err" data-e="date"></div></div>
  <div class="field"><label for="time">Arrival time</label><input id="time" name="time" type="time" value="19:00"><div class="err" data-e="time"></div></div>
 </div>
 <div class="field"><label>Number of guests</label><div class="stepper"><button type="button" id="minus" aria-label="Fewer guests">−</button><input id="guests" name="guests" type="number" inputmode="numeric" min="1" max="${maxG}" value="2"><button type="button" id="plus" aria-label="More guests">+</button></div><div class="err" data-e="guests"></div></div>
 ${S.payments_enabled ? `<div class="price"><div>💳</div><div>Pay <b>${esc(naira(total))}</b> to confirm: <b>${esc(naira(S.reservation_fee_kobo))}</b> is credited to your food and drinks order on the day, plus a ${esc(naira(S.service_fee_kobo))} service fee.</div></div>` : ''}
 <div class="err" data-e="_" style="margin-bottom:10px"></div>
 <button class="btn" id="go" type="submit">${S.payments_enabled ? 'Continue to payment' : 'Confirm reservation'}</button>
</form>
<p class="foot">Have a question first? <a href="${esc(askUrl)}" style="color:var(--cream)">Chat with us</a></p>
<p class="foot">Powered by ERA Systems</p></div>
<script>
const C=${JSON.stringify(cfg)};
const $=(s)=>document.querySelector(s);
const g=$('#guests');
$('#minus').onclick=()=>{g.value=Math.max(1,(+g.value||1)-1)};
$('#plus').onclick=()=>{g.value=Math.min(C.maxGuests,(+g.value||1)+1)};
$('#date').addEventListener('change',e=>{const d=new Date(e.target.value+'T00:00:00Z').getUTCDay();if(C.closed.includes(d)){setErr('date','We are closed on that day. Please pick another.');e.target.value='';}else setErr('date','');});
function setErr(k,m){const el=document.querySelector('[data-e="'+k+'"]');if(el)el.textContent=m||''}
$('#f').addEventListener('submit',async(ev)=>{
 ev.preventDefault();document.querySelectorAll('.err').forEach(e=>e.textContent='');
 const b=$('#go');const label=b.textContent;b.disabled=true;b.textContent='Please wait…';
 try{
  const r=await fetch('/api/reserve/'+C.token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#name').value,phone:$('#phone').value,date:$('#date').value,time:$('#time').value,guests:+g.value})});
  const j=await r.json();
  if(j.ok){ if(j.payUrl){location.href=j.payUrl;return;} location.href='/reserve/'+C.token+'/done?ref='+j.ref;return; }
  Object.entries(j.errors||{}).forEach(([k,m])=>setErr(k,m));
  const first=document.querySelector('.err:not(:empty)');if(first)first.scrollIntoView({behavior:'smooth',block:'center'});
 }catch(e){setErr('_','Network problem. Please try again.');}
 b.disabled=false;b.textContent=label;
});
</script></body></html>`;
}

function done({ S, T, r, state, token, describe }) {
  const link = S.order_link ? `${S.order_link}${S.order_link.includes('?') ? '&' : '?'}ref=${r.ref}` : '';
  const p = T.utcToLocalParts(r.starts_at);
  const kv = `<dl class="kv"><dt>Reference</dt><dd>${esc(r.ref)}</dd><dt>Name</dt><dd>${esc(r.guest_name)}</dd><dt>Date</dt><dd>${esc(T.fmtDateFull(p.date))}</dd><dt>Arrival</dt><dd>${esc(T.fmtTime(p.time))}</dd><dt>Guests</dt><dd>${r.guests}</dd></dl>`;
  let inner;
  if (state === 'confirmed') {
    inner = `<div class="tick">✓</div><h1 class="center">Your table is confirmed</h1><p class="sub center">We have sent the details to your WhatsApp.${r.paid_amount_kobo ? ` Your ${esc(naira(S.reservation_fee_kobo))} is credited to your order on the day.` : ''}</p><div class="card">${kv}</div>
    ${link ? `<p class="note center" style="margin-top:18px">You can place your food and drinks order for that day now.</p><a class="btn" href="${esc(link)}">Place your order</a>` : ''}
    <a class="btn ghost" style="margin-top:12px" href="/my/${esc(token)}">Change or cancel</a>`;
  } else if (state === 'pending' || state === 'pending_payment') {
    inner = `<div class="tick wait">…</div><h1 class="center">Waiting for your payment</h1><p class="sub center">If you have just paid, this page updates by itself. Your table is held for a few minutes.</p><div class="card">${kv}</div><a class="btn ghost" style="margin-top:16px" href="">Check again</a>
    <script>setTimeout(()=>location.reload(),4000)</script>`;
  } else {
    inner = `<div class="tick wait">!</div><h1 class="center">This reservation is ${esc(state.replace('_', ' '))}</h1><p class="sub center">If you paid and see this, message us on WhatsApp and we will sort it out.</p><a class="btn" href="/reserve/${esc(token)}">Make a new reservation</a>`;
  }
  return `${HEAD('Reservation')}${GUEST_CSS}</head><body><div class="wrap"><div class="banner"></div>${inner}<p class="foot">Powered by ERA Systems</p></div></body></html>`;
}

function manage({ S, T, token, list, formUrl }) {
  const items = list.map((r) => {
    const paid = r.paid_amount_kobo;
    const refundNote = !paid ? '' : (r.hoursAway >= S.refund_hours
      ? `Cancelling now refunds ${naira(S.reservation_fee_kobo)}. The ${naira(S.service_fee_kobo)} service fee is not refundable.`
      : `This is less than ${S.refund_hours} hours away, so the payment will not be refunded.`);
    return `<div class="card res"><div style="display:flex;justify-content:space-between;align-items:center"><b>${esc(r.ref)}</b><span class="pill ${r.status === 'confirmed' ? '' : 'w'}">${r.status === 'confirmed' ? 'Confirmed' : 'Awaiting payment'}</span></div>
      <p style="margin:10px 0 2px;font-size:16px;font-weight:600">${esc(r.text)}</p><p class="note">${esc(r.guest_name)}${refundNote ? '<br>' + esc(refundNote) : ''}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${r.status === 'confirmed' ? `<button class="btn small" data-change="${esc(r.ref)}" data-date="${esc(r.ldate)}" data-time="${esc(r.ltime)}" data-guests="${r.guests}">Change</button>` : ''}<button class="btn danger small" data-ref="${esc(r.ref)}" data-note="${esc(refundNote)}">Cancel reservation</button></div></div>`;
  }).join('');
  return `${HEAD('My reservation')}${GUEST_CSS}</head><body><div class="wrap"><div class="banner"></div><h1>My reservation</h1><p class="sub">Your upcoming tables at ${esc(S.venue_name)}.</p>
  ${items || `<div class="card center"><p class="note">You have no upcoming reservations.</p></div>`}
  <a class="btn" style="margin-top:18px" href="${esc(formUrl)}">Book a table</a><p class="foot">Powered by ERA Systems</p></div>
  <div class="modal" id="cm"><div class="sheet"><h1 style="font-size:20px">Change your reservation</h1><p class="note" id="cmref"></p>
   <div class="field"><label for="cd">Date</label><input id="cd" type="date" min="${esc(T.todayStr())}" max="${esc(T.addDaysISO(T.todayStr(), S.max_days_ahead))}"></div>
   <div class="field"><label for="ct">Arrival time</label><input id="ct" type="time"></div>
   <div class="field"><label for="cg">Number of guests</label><input id="cg" type="number" inputmode="numeric" min="1"></div>
   <p class="note">Your payment stays with the new booking. Changes close ${S.change_cutoff_hours > 0 ? S.change_cutoff_hours + ' hours' : 'at arrival'} before you arrive.</p>
   <div class="err" id="cerr" style="margin-bottom:10px"></div>
   <button class="btn" id="csave">Save changes</button><button class="btn ghost" id="cno" style="margin-top:10px">Close</button></div></div>
  <div class="modal" id="m"><div class="sheet"><h1 style="font-size:20px">Cancel this reservation?</h1><p class="note" id="mn"></p><button class="btn danger" id="yes">Yes, cancel it</button><button class="btn ghost" id="no" style="margin-top:10px">Keep it</button></div></div>
  <script>let cur=null;const m=document.getElementById('m');
  document.querySelectorAll('[data-ref]').forEach(b=>b.onclick=()=>{cur=b.dataset.ref;document.getElementById('mn').textContent=b.dataset.note||'';m.classList.add('open')});
  document.getElementById('no').onclick=()=>m.classList.remove('open');
  document.getElementById('yes').onclick=async()=>{const y=document.getElementById('yes');y.disabled=true;y.textContent='Cancelling…';await fetch('/api/my/${esc(token)}/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:cur})});location.reload()};
  let chg=null;const cm=document.getElementById('cm');
  document.querySelectorAll('[data-change]').forEach(b=>b.onclick=()=>{chg=b.dataset.change;document.getElementById('cmref').textContent='Reservation '+chg;document.getElementById('cd').value=b.dataset.date;document.getElementById('ct').value=b.dataset.time;document.getElementById('cg').value=b.dataset.guests;document.getElementById('cerr').textContent='';cm.classList.add('open')});
  document.getElementById('cno').onclick=()=>cm.classList.remove('open');
  document.getElementById('csave').onclick=async()=>{const s=document.getElementById('csave');const er=document.getElementById('cerr');er.textContent='';s.disabled=true;s.textContent='Saving…';
   try{const r=await fetch('/api/my/${esc(token)}/change',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:chg,date:document.getElementById('cd').value,time:document.getElementById('ct').value,guests:+document.getElementById('cg').value})});const j=await r.json();
    if(j.ok){location.reload();return}er.textContent=Object.values(j.errors||{})[0]||'Something went wrong.'}catch(e){er.textContent='Network problem. Please try again.'}
   s.disabled=false;s.textContent='Save changes'};</script></body></html>`;
}

function ask({ S, token, formUrl, chips, waNumber }) {
  const wa = `https://wa.me/${String(waNumber || '').replace(/D/g, '')}`;
  return `${HEAD('Bali enquiries')}<style>
:root{--bg:#efeae2;--header:#075e54;--in:#fff;--out:#d9fdd3;--text:#111b21;--text2:#667781;--accent:#00a884}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{margin:0;height:100%;font-family:Inter,system-ui,sans-serif;color:var(--text);background:var(--bg);overflow:hidden}
#app{display:flex;flex-direction:column;height:100%}
header{flex:none;background:var(--header);color:#fff;padding:10px 14px;display:flex;align-items:center;gap:10px;padding-top:calc(10px + env(safe-area-inset-top))}
.av{width:38px;height:38px;border-radius:50%;background:#3a1a0d url(/assets/welcome.png) center/cover}
header .back{flex:none;color:#fff;font-size:30px;line-height:1;padding:0 6px 4px 0;text-decoration:none;font-weight:300}
header .n{font-weight:600;font-size:16px}header .s{font-size:12px;opacity:.75}header .by{font-size:10px;opacity:.55;letter-spacing:.3px}
#scroll{flex:1;overflow-y:auto;padding:14px 10px;background-image:radial-gradient(rgba(0,0,0,.055) 1px,transparent 1px);background-size:22px 22px}
.row{display:flex;margin:3px 0}.row.in{justify-content:flex-start}.row.out{justify-content:flex-end}
.b{position:relative;max-width:84%;padding:7px 10px 6px;border-radius:9px;font-size:14.5px;line-height:1.4;box-shadow:0 1px 1px rgba(0,0,0,.18);white-space:pre-wrap;word-wrap:break-word}
.row.in .b{background:var(--in);border-top-left-radius:0}.row.out .b{background:var(--out);border-top-right-radius:0}
.pop{animation:pop .26s cubic-bezier(.34,1.56,.64,1)}@keyframes pop{0%{transform:scale(.8);opacity:0}100%{transform:scale(1);opacity:1}}
.act{display:block;margin:8px -4px 2px;padding:10px;text-align:center;background:var(--accent);color:#04120d;font-weight:700;border-radius:8px;text-decoration:none;font-size:14.5px}
.chips{display:flex;flex-wrap:wrap;gap:8px;padding:6px 4px 4px}.chip{background:#fff;color:var(--accent);border:1px solid rgba(0,168,132,.4);border-radius:99px;padding:8px 13px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer}
.typing{color:var(--text2);font-size:13px;padding:4px 10px}
form{flex:none;display:flex;gap:8px;padding:8px 8px calc(8px + env(safe-area-inset-bottom));background:#f0f2f5}
input{flex:1;border:none;border-radius:22px;padding:12px 16px;font:inherit;font-size:16px;outline:none;background:#fff}
button.send{width:46px;height:46px;border-radius:50%;border:none;background:var(--accent);color:#fff;font-size:20px;cursor:pointer}
.top{display:flex;gap:8px;padding:8px 10px;background:#fff;border-bottom:1px solid rgba(0,0,0,.08)}.top a{flex:1;text-align:center;padding:9px;border-radius:9px;background:#f0f2f5;color:var(--accent);font-weight:700;font-size:13.5px;text-decoration:none}
</style></head><body><div id="app">
<header><a class="back" href="${esc(wa)}" aria-label="Back to WhatsApp">‹</a><div class="av"></div><div><div class="n">${esc(S.venue_name)}</div><div class="s">Enquiries</div></div></header>
<div class="top"><a href="${esc(formUrl)}">Reserve a table</a></div>
<div id="scroll"><div id="list"></div><div class="chips" id="chips"></div></div>
<form id="f" autocomplete="off"><input id="t" placeholder="Type your question" maxlength="500"><button class="send" aria-label="Send">➤</button></form></div>
<script>
const TOKEN=${JSON.stringify(token)},INTRO=${JSON.stringify(S.enquiry_intro)},CHIPS=${JSON.stringify(chips)};
const list=document.getElementById('list'),sc=document.getElementById('scroll'),chipsEl=document.getElementById('chips');
function add(dir,text,action,animate){const r=document.createElement('div');r.className='row '+dir+(animate?' pop':'');const b=document.createElement('div');b.className='b';b.textContent=text;
 if(action){const a=document.createElement('a');a.className='act';a.href=action.url;a.textContent=action.label;b.appendChild(a)}r.appendChild(b);list.appendChild(r);sc.scrollTop=sc.scrollHeight}
function showChips(){chipsEl.innerHTML='';CHIPS.forEach(q=>{const c=document.createElement('button');c.type='button';c.className='chip';c.textContent=q;c.onclick=()=>send(q);chipsEl.appendChild(c)})}
async function send(text){text=(text||'').trim();if(!text)return;chipsEl.innerHTML='';add('out',text,null,true);document.getElementById('t').value='';
 const ty=document.createElement('div');ty.className='typing';ty.textContent='typing…';list.appendChild(ty);sc.scrollTop=sc.scrollHeight;
 try{const r=await fetch('/api/ask/'+TOKEN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});const j=await r.json();ty.remove();add('in',j.reply||'Sorry, something went wrong.',j.action,true)}catch(e){ty.remove();add('in','Network problem. Please try again.')}
 showChips()}
document.getElementById('f').onsubmit=e=>{e.preventDefault();send(document.getElementById('t').value)};
(async()=>{try{const r=await fetch('/api/ask/'+TOKEN+'/history');const j=await r.json();
 if(!j.messages.length){add('in',INTRO)}else j.messages.forEach(m=>add(m.direction==='in'?'out':'in',m.body,m.interactive&&m.interactive.url?{label:m.interactive.label,url:m.interactive.url}:null))}catch(e){add('in',INTRO)}showChips()})();
</script></body></html>`;
}

function login(msg) {
  return `${HEAD('Bali dashboard')}${GUEST_CSS}</head><body><div class="wrap" style="padding-top:12vh"><div class="center"><div style="width:84px;height:84px;margin:0 auto 18px;border-radius:22px;background:#3a1a0d url(/assets/welcome.png) center/cover;border:1px solid var(--line)"></div><h1>Bali dashboard</h1><p class="sub">Sign in to manage reservations.</p></div>
<form class="card" method="post" action="/dashboard/login"><div class="field"><label>Username</label><input name="username" autocomplete="username" autofocus></div><div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password"></div>${msg ? `<div class="err" style="margin-bottom:10px">${esc(msg)}</div>` : ''}<button class="btn">Sign in</button></form><p class="foot">Powered by ERA Systems</p></div></body></html>`;
}

function dashboard() {
  const v = Date.now().toString(36);
  return `${HEAD('Bali · Dashboard')}<link rel="stylesheet" href="/assets/dashboard.css?v=${v}"></head><body>
<div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="/assets/dashboard.js?v=${v}"></script></body></html>`;
}

module.exports = { notFound, form, done, manage, ask, login, dashboard, esc };
