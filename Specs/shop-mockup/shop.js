(function(){
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const inr=n=>'₹'+Number(n).toLocaleString('en-IN');
const COLOURS={Saffron:'#e07a1f',Black:'#222',Cream:'#f1e8d6',Maroon:'#7a1f24',Teal:'#127a72',Mustard:'#d9a62b',White:'#fafafa',Navy:'#1f2a4a'};
const P=[
 {id:0,name:'Om Saffron Tee',coll:'Minimal',price:699,mrp:0,col:['Saffron','Maroon','Cream'],sizes:['S','M','L','XL','XXL'],fit:'Regular',print:'Chest print',for:'Adults',tag:'',sold:120,newr:4},
 {id:1,name:'Har Har Mahadev Trishul Tee',coll:'Mahadev',price:799,mrp:999,col:['Black','Navy'],sizes:['S','M','L','XL','XXL','3XL'],fit:'Regular',print:'Big front print',for:'Adults',tag:'sale',sold:310,newr:3},
 {id:2,name:'Lotus & Diya Tee',coll:'Lotus & Diya',price:649,mrp:0,col:['Cream','White'],sizes:['S','M','L','XL'],fit:'Regular',print:'Big front print',for:'Adults',tag:'new',sold:80,newr:7},
 {id:3,name:'Murli Mandala Oversized Tee',coll:'Krishna',price:899,mrp:0,col:['Maroon','Black'],sizes:['M','L','XL','XXL'],fit:'Oversized',print:'Back print',for:'Adults',tag:'best',sold:420,newr:2},
 {id:4,name:'Temple Bell Embroidered Tee',coll:'Minimal',price:749,mrp:0,col:['Teal','Navy','Cream'],sizes:['S','M','L','XL','XXL'],fit:'Regular',print:'Embroidery',for:'Adults',tag:'new',sold:60,newr:6},
 {id:5,name:'Himalayan Mandir Tee',coll:'Himalaya',price:699,mrp:799,col:['Mustard','Cream'],sizes:['S','M','L','XL'],fit:'Regular',print:'Big front print',for:'Adults',tag:'sale',sold:190,newr:5},
 {id:6,name:'Baby Gaj Kids Tee',coll:'Kids',price:449,mrp:0,col:['White','Saffron'],sizes:['2-3Y','4-5Y','6-7Y','8-9Y'],fit:'Regular',print:'Big front print',for:'Kids',tag:'new',sold:95,newr:8},
];
const COLLS=[['Mahadev','Shiva, trishul, damru'],['Krishna','Murli, peacock, Vrindavan'],['Lotus & Diya','Light and new beginnings'],['Himalaya','Mountain temples we visit'],['Minimal','Small symbols, everyday wear'],['Kids','For little devotees']];
const ph=(p,label='T-shirt photo')=>`<div class="sh-ph" style="--ph:${shade(COLOURS[p.col[0]])}"><span>${label}</span></div>`;
function shade(h){const n=parseInt(h.slice(1),16);let r=n>>16,g=n>>8&255,b=n&255;r=Math.round(r*.45+239*.55);g=Math.round(g*.45+220*.55);b=Math.round(b*.45+191*.55);return`rgb(${r},${g},${b})`}

/* ---------- state ---------- */
let cart=[{id:1,col:'Black',size:'L',qty:1},{id:3,col:'Maroon',size:'XL',qty:1}];
const wish=new Set();
const GST_PCT=18;
const sub=()=>cart.reduce((s,i)=>s+P[i.id].price*i.qty,0);
const ship=()=>0;
const gstOf=n=>Math.round(n*GST_PCT/100);

/* ---------- card ---------- */
function card(p){
  const off=p.mrp?Math.round((1-p.price/p.mrp)*100):0;
  const badge=p.tag==='sale'?'<span class="sh-badge">Sale</span>':p.tag==='new'?'<span class="sh-badge sh-badge--new">New</span>':p.tag==='best'?'<span class="sh-badge sh-badge--best">Bestseller</span>':'';
  return `<article class="sh-card" data-open="${p.id}">
   <div class="sh-card-art">${ph(p)}${badge}
    <button class="sh-heart${wish.has(p.id)?' is-on':''}" data-wish="${p.id}" aria-label="Save"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7.5-4.6-9.5-9.2C1 8.3 3.3 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5 18.7 5 21 8.3 19.5 11.8 17.5 16.4 12 21 12 21z"/></svg></button>
    <button class="sh-btn sh-btn--red sh-quick" data-quick="${p.id}">Quick add · ${p.sizes[1]||p.sizes[0]}</button>
   </div>
   <h3>${p.name}</h3>
   <div class="sh-price">${inr(p.price)}${p.mrp?` <s>${inr(p.mrp)}</s> <span class="sh-off">−${off}%</span>`:''}</div>
   <div class="sh-sw">${p.col.map(c=>`<i style="background:${COLOURS[c]}" title="${c}"></i>`).join('')}</div>
  </article>`;
}

/* ---------- router ---------- */
function go(r){location.hash=r}
function route(){
  let h=(location.hash||'#home').slice(1); let [v,arg]=h.split('/');
  if(!$(`[data-view="${v}"]`))v='home';
  $$('.sh-view').forEach(x=>x.classList.toggle('is-on',x.dataset.view===v));
  $$('.sh-switch button').forEach(b=>b.classList.toggle('is-on',b.dataset.go.split('/')[0]===v));
  $$('.mk-nav a').forEach(a=>a.classList.toggle('is-active',a.dataset.nav==='shop'&&['home','all','p','checkout'].includes(v)));
  if(v==='p')renderPdp(+arg||0);
  if(v==='checkout')renderCheckout();
  if(v==='orders')renderOrders();
  if(v==='billing')renderBilling();
  window.scrollTo(0,0);
}
window.addEventListener('hashchange',route);

document.addEventListener('click',e=>{
  const g=e.target.closest('[data-go]');
  if(g){e.preventDefault(); if(g.dataset.coll){F.coll=new Set([g.dataset.coll]);syncFilters()} if(g.dataset.tag==='new'){$('#fSort').value='new';applyFilters()} go(g.dataset.go);return}
  const w=e.target.closest('[data-wish]'); if(w){e.stopPropagation();const id=+w.dataset.wish;wish.has(id)?wish.delete(id):wish.add(id);w.classList.toggle('is-on');toast(wish.has(id)?'Saved to your wishlist':'Removed from wishlist');return}
  const q=e.target.closest('[data-quick]'); if(q){e.stopPropagation();const p=P[+q.dataset.quick];addToCart(p.id,p.col[0],p.sizes[1]||p.sizes[0],1);return}
  const o=e.target.closest('[data-open]'); if(o){go('p/'+o.dataset.open);return}
});

/* ---------- home ---------- */
$('#shCats').innerHTML=COLLS.map(([n,d],i)=>`<button class="sh-cat" data-go="all" data-coll="${n}"><div class="sh-ph" style="--ph:${shade(Object.values(COLOURS)[i])}"><span>Collection art</span></div><b>${n}</b><small>${P.filter(p=>p.coll===n).length} designs · ${d}</small></button>`).join('');
$('#shNew').innerHTML=P.filter(p=>p.tag==='new'||p.id===5).slice(0,4).map(card).join('');
$('#shBest').innerHTML=[...P].sort((a,b)=>b.sold-a.sold).slice(0,4).map(card).join('');
$$('.sh-dot').forEach(d=>d.addEventListener('click',e=>{
  const p=P[+d.dataset.pop],pop=$('#shPop');
  pop.innerHTML=`${ph(p)}<div><b>${p.name}</b><small>${inr(p.price)} · tap to view →</small></div>`;
  pop.style.left=`calc(${d.style.left} - 270px)`;pop.style.top=`calc(${d.style.top} - 30px)`;
  pop.classList.add('is-on');pop.onclick=()=>go('p/'+p.id);e.stopPropagation();
}));
document.addEventListener('click',e=>{if(!e.target.closest('.sh-dot,.sh-pop'))$('#shPop').classList.remove('is-on')});

/* ---------- filters (layout 1) ---------- */
const F={min:399,max:999,coll:new Set(),col:new Set(),size:new Set(),fit:new Set(),print:new Set(),for:new Set()};
const uniq=k=>[...new Set(P.flatMap(p=>[].concat(p[k])))];
function opt(group,v,count,sw){return`<label class="sh-opt"><input type="checkbox" data-fg="${group}" value="${v}">${sw?`<i style="background:${sw}"></i>`:''}${v}<em>${count}</em></label>`}
$('#fColl').innerHTML=COLLS.map(([n])=>opt('coll',n,P.filter(p=>p.coll===n).length)).join('');
$('#fColour').innerHTML=uniq('col').map(c=>opt('col',c,P.filter(p=>p.col.includes(c)).length,COLOURS[c])).join('');
$('#fSize').innerHTML=['S','M','L','XL','XXL','3XL','2-3Y','4-5Y','6-7Y','8-9Y'].map(s=>`<label><input type="checkbox" data-fg="size" value="${s}"><span>${s}</span></label>`).join('');
$('#fFit').innerHTML=uniq('fit').map(v=>opt('fit',v,P.filter(p=>p.fit===v).length)).join('');
$('#fPrint').innerHTML=uniq('print').map(v=>opt('print',v,P.filter(p=>p.print===v).length)).join('');
$('#fFor').innerHTML=uniq('for').map(v=>opt('for',v,P.filter(p=>p.for===v).length)).join('');
document.addEventListener('change',e=>{const t=e.target;if(t.dataset.fg){t.checked?F[t.dataset.fg].add(t.value):F[t.dataset.fg].delete(t.value);applyFilters()}});
function priceSync(src){
  let a=+$('#fMin').value,b=+$('#fMax').value;
  if(src==='n'){a=+$('#fMinN').value||399;b=+$('#fMaxN').value||999}
  if(a>b)[a,b]=[b,a]; F.min=a;F.max=b;
  $('#fMin').value=a;$('#fMax').value=b;$('#fMinN').value=a;$('#fMaxN').value=b;$('#fPriceLbl').textContent=`${inr(a)} – ${inr(b)}`;applyFilters();
}
['#fMin','#fMax'].forEach(s=>$(s).addEventListener('input',()=>priceSync('r')));
['#fMinN','#fMaxN'].forEach(s=>$(s).addEventListener('change',()=>priceSync('n')));
$('#fSort').addEventListener('change',applyFilters);
$('#fClear').addEventListener('click',()=>{['coll','col','size','fit','print','for'].forEach(k=>F[k].clear());$('#fMinN').value=399;$('#fMaxN').value=999;syncFilters();priceSync('n')});
$('#fOpen').addEventListener('click',()=>{$('#shFilters').classList.add('is-on');$$('.sh-filter-close').forEach(b=>b.style.display='')});
$$('.sh-filter-close').forEach(b=>b.addEventListener('click',()=>{$('#shFilters').classList.remove('is-on');$$('.sh-filter-close').forEach(x=>x.style.display='none')}));
function syncFilters(){$$('[data-fg]').forEach(i=>i.checked=F[i.dataset.fg].has(i.value));applyFilters()}
function applyFilters(){
  let r=P.filter(p=>p.price>=F.min&&p.price<=F.max&&(!F.coll.size||F.coll.has(p.coll))&&(!F.col.size||p.col.some(c=>F.col.has(c)))&&(!F.size.size||p.sizes.some(s=>F.size.has(s)))&&(!F.fit.size||F.fit.has(p.fit))&&(!F.print.size||F.print.has(p.print))&&(!F.for.size||F.for.has(p.for)));
  const s=$('#fSort').value;
  if(s==='lo')r.sort((a,b)=>a.price-b.price); if(s==='hi')r.sort((a,b)=>b.price-a.price);
  if(s==='best')r.sort((a,b)=>b.sold-a.sold); if(s==='new')r.sort((a,b)=>b.newr-a.newr);
  $('#fCount').textContent=`${r.length} product${r.length===1?'':'s'}`;
  $('#shAll').innerHTML=r.length?r.map(card).join(''):`<div class="sh-empty"><b>No T-shirts match these filters</b><p style="font:600 15px Nunito;color:#6b4a2b">Try a wider price range or fewer filters.</p><button class="sh-btn sh-btn--ghost" onclick="document.getElementById('fClear').click()">Clear filters</button></div>`;
  const chips=[];['coll','col','size','fit','print','for'].forEach(k=>F[k].forEach(v=>chips.push(`<button class="sh-chip" data-unchip="${k}|${v}">${v} ×</button>`)));
  if(F.min>399||F.max<999)chips.push(`<span class="sh-chip">${inr(F.min)}–${inr(F.max)}</span>`);
  $('#fChips').innerHTML=chips.join('');
}
document.addEventListener('click',e=>{const c=e.target.closest('[data-unchip]');if(c){const[k,v]=c.dataset.unchip.split('|');F[k].delete(v);syncFilters()}});
applyFilters();

/* ---------- product page ---------- */
let sel={};
function renderPdp(id){
  const p=P[id]; sel={id,col:p.col[0],size:null,qty:1};
  const off=p.mrp?Math.round((1-p.price/p.mrp)*100):0;
  $('#pCrumb').innerHTML=`<a data-go="home">Shop</a> / <a data-go="all" data-coll="${p.coll}">${p.coll}</a> / ${p.name}`;
  $('#pdp').innerHTML=`
  <div class="sh-gal"><div class="sh-thumbs">${['Front','Back','Print close-up','On model'].map((t,i)=>`<button class="${i?'':'is-on'}" data-thumb="${t}">${ph(p,t)}</button>`).join('')}</div>
   <div class="sh-main-img" id="pMain">${ph(p,'Front photo')}</div></div>
  <div class="sh-pdp-info">
   <p class="sh-eyebrow">${p.coll} collection${p.tag==='best'?' · Bestseller':''}</p>
   <h1>${p.name}</h1>
   <div class="sh-price">${inr(p.price)}${p.mrp?` <s>${inr(p.mrp)}</s> <span class="sh-off">−${off}%</span>`:''}</div>
   <p class="sh-tax">+ ${GST_PCT}% GST at checkout · Free shipping, pan India</p>
   <div class="sh-lbl">Colour <span id="pCol">${p.col[0]}</span></div>
   <div class="sh-colours">${p.col.map((c,i)=>`<button class="${i?'':'is-on'}" style="background:${COLOURS[c]}" data-col="${c}" aria-label="${c}"></button>`).join('')}</div>
   <div class="sh-lbl">Size <button class="sh-link" id="pGuide">Size guide</button></div>
   <div class="sh-sizes" id="pSizes">${p.sizes.map(s=>`<label><input type="radio" name="psz" value="${s}"><span>${s}</span></label>`).join('')}</div>
   <div class="sh-err" id="pErr"></div>
   <div class="sh-buy"><div class="sh-qty"><button data-q="-1">−</button><span id="pQty">1</span><button data-q="1">+</button></div>
    <button class="sh-btn sh-btn--ghost" id="pAdd">Add to cart</button><button class="sh-btn sh-btn--red" id="pBuy">Buy now</button></div>
   <div class="sh-perks"><div><i>🖨️</i>Printed to order for you</div><div><i>🚚</i>Free shipping, pan India</div><div><i>📲</i>Pay by any UPI app</div></div>
   <div class="sh-pin"><b style="font:900 15px Nunito;width:100%">Check delivery</b><input id="pPin" placeholder="Enter 6-digit pincode" inputmode="numeric" maxlength="6"><button class="sh-btn sh-btn--teal" id="pPinBtn" style="min-height:46px">Check</button><p id="pPinOut" hidden></p></div>
   <div class="sh-acc">
    <details open><summary>About this design</summary><p>Original Saa Thum artwork. ${p.print} on ${p.fit.toLowerCase()} fit ${p.for==='Kids'?'kids ':''}T-shirt. Designed to be worn with respect — to the temple, to work, everyday.</p></details>
    <details><summary>Fabric &amp; care</summary><ul><li>100% combed cotton, 180 GSM, bio-washed</li><li>Wash inside out in cold water</li><li>Do not iron directly on the print</li></ul></details>
    <details><summary>Shipping &amp; returns</summary><ul><li>Printed to order, delivered in 5–8 days — free shipping anywhere in India</li><li>We ship within India only</li><li>No returns or exchanges for size or change of mind — please check the size guide</li><li>Wrong or damaged item? Tell us within 48 hours with a photo and we replace it or refund you</li></ul></details>
   </div>
  </div>`;
}
document.addEventListener('click',e=>{
  if(!$('[data-view="p"]').classList.contains('is-on'))return;
  const c=e.target.closest('[data-col]'); if(c){sel.col=c.dataset.col;$$('[data-col]').forEach(b=>b.classList.toggle('is-on',b===c));$('#pCol').textContent=sel.col;$('#pMain .sh-ph').style.setProperty('--ph',shade(COLOURS[sel.col]))}
  const t=e.target.closest('[data-thumb]'); if(t){$$('[data-thumb]').forEach(b=>b.classList.toggle('is-on',b===t));$('#pMain span').textContent=t.dataset.thumb+' photo'}
  const q=e.target.closest('[data-q]'); if(q){sel.qty=Math.max(1,Math.min(10,sel.qty+ +q.dataset.q));$('#pQty').textContent=sel.qty}
  if(e.target.id==='pAdd'||e.target.id==='pBuy'){
    const s=$('input[name=psz]:checked'); if(!s){$('#pErr').textContent='Please pick a size first.';return}
    $('#pErr').textContent=''; addToCart(sel.id,sel.col,s.value,sel.qty,e.target.id==='pBuy');
  }
  if(e.target.id==='pPinBtn'){const v=$('#pPin').value,o=$('#pPinOut');o.hidden=false;if(!/^\d{6}$/.test(v)){o.style.color='#b3261e';o.textContent='Enter a valid 6-digit pincode.'}else{o.style.color='';o.textContent=`✓ Delivers to ${v} in 5–8 days · free shipping`}}
  if(e.target.id==='pGuide'){modal(`<h2>Size guide</h2><p>Chest and length in inches, measured flat. Oversized fits are 2" wider.</p><table class="sh-sizeguide"><tr><th>Size</th><th>Chest</th><th>Length</th></tr>${[['S',38,27],['M',40,28],['L',42,29],['XL',44,30],['XXL',46,31],['3XL',48,32]].map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table><div style="margin-top:16px"><button class="sh-btn sh-btn--teal sh-btn--wide" data-close>Got it</button></div>`)}
});

/* ---------- cart ---------- */
function addToCart(id,col,size,qty,buyNow){
  const ex=cart.find(i=>i.id===id&&i.col===col&&i.size===size);
  ex?ex.qty+=qty:cart.push({id,col,size,qty});
  renderCart(); if(buyNow){go('checkout');return} openCart(); toast(`Added: ${P[id].name} (${size})`);
}
function renderCart(){
  const n=cart.reduce((s,i)=>s+i.qty,0); $$('.avh-cart b').forEach(b=>b.textContent=n||'');
  const s=sub();
  $('#shFree').innerHTML='🚚 <b>Free shipping</b> on every order, pan India';
  $('#shFree').style.display=cart.length?'':'none';
  $('#shItems').innerHTML=cart.length?cart.map((i,k)=>{const p=P[i.id];return`<div class="sh-item">${ph({col:[i.col]})}<div><b>${p.name}</b><small>${i.col} · Size ${i.size}</small><div class="sh-qty"><button data-cq="${k}|-1">−</button><span>${i.qty}</span><button data-cq="${k}|1">+</button></div></div><div class="sh-item-r"><strong>${inr(p.price*i.qty)}</strong><button data-rm="${k}">Remove</button></div></div>`}).join(''):`<div class="sh-cart-empty"><b>Your cart is empty</b><p>Find a T-shirt that carries your faith.</p><button class="sh-btn sh-btn--red" data-go="all" onclick="document.getElementById('shCartClose').click()">Browse T-shirts</button></div>`;
  $('#shCartFoot').innerHTML=cart.length?`<div class="sh-row"><span>Subtotal</span><span>${inr(s)}</span></div><div class="sh-row"><span>Shipping</span><span>Free</span></div><div class="sh-row"><span>GST (${GST_PCT}%)</span><span>${inr(gstOf(s))}</span></div><div class="sh-row sh-row--tot"><span>Total</span><span>${inr(s+gstOf(s))}</span></div><button class="sh-btn sh-btn--red sh-btn--wide" id="cGo">Checkout · Pay by UPI →</button><button class="sh-btn sh-btn--ghost sh-btn--wide" style="margin-top:8px" id="cKeep">Keep shopping</button>`:'';
}
function openCart(){$('#shCart').classList.add('is-on');$('#shScrim').classList.add('is-on')}
function closeCart(){$('#shCart').classList.remove('is-on');$('#shScrim').classList.remove('is-on')}
document.addEventListener('click',e=>{
  if(e.target.closest('.avh-cart')){renderCart();openCart()}
  if(e.target.id==='shScrim'||e.target.id==='shCartClose'||e.target.id==='cKeep')closeCart();
  if(e.target.id==='cGo'){closeCart();go('checkout')}
  const q=e.target.closest('[data-cq]'); if(q){const[k,d]=q.dataset.cq.split('|');cart[k].qty+=+d;if(cart[k].qty<1)cart.splice(k,1);renderCart();if(location.hash==='#checkout')renderSum()}
  const r=e.target.closest('[data-rm]'); if(r){cart.splice(+r.dataset.rm,1);renderCart()}
});
let tt;function toast(m){const t=$('#shToast');t.textContent=m;t.classList.add('is-on');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('is-on'),2200)}

/* ---------- checkout ---------- */
let step=1,coupon=0,lastOrder=null;
function renderSum(){
  const s=sub(),total=s-coupon+gstOf(s-coupon);
  $('#coSum').innerHTML=`<h2>Order summary</h2>${cart.map(i=>`<div class="sh-sum-item">${ph({col:[i.col]})}<div><b>${P[i.id].name}</b><small>${i.col} · ${i.size} · Qty ${i.qty}</small></div><strong>${inr(P[i.id].price*i.qty)}</strong></div>`).join('')}
   ${step<4?`<div class="sh-coupon"><input placeholder="Coupon code" id="coCode"><button class="sh-btn sh-btn--ghost" id="coApply" style="min-height:46px">Apply</button></div>`:''}
   <div class="sh-row"><span>Subtotal</span><span>${inr(s)}</span></div>
   ${coupon?`<div class="sh-row" style="color:#1e8a4c"><span>Coupon NAVRATRI10</span><span>−${inr(coupon)}</span></div>`:''}
   <div class="sh-row"><span>Shipping</span><span>Free</span></div>
   <div class="sh-row"><span>GST (${GST_PCT}%)</span><span>${inr(gstOf(s-coupon))}</span></div>
   <div class="sh-row sh-row--tot"><span>Total</span><span>${inr(total)}</span></div>
   <p style="font:700 13px Nunito;color:#7a6a55;margin:0">Free shipping, pan India. No returns — wrong item? We replace it or refund you.</p>`;
}
function stepsBar(){return`<div class="sh-steps">${['1 · You','2 · Delivery address','3 · Review','4 · Pay with UPI'].map((t,i)=>`<span class="${i+1===step?'is-on':i+1<step?'is-done':''}">${i+1<step?'✓ ':''}${t}</span>`).join('')}</div>`}
function renderCheckout(){
  if(!cart.length&&step<5){$('#coMain').innerHTML=`<div class="sh-panel sh-done"><h2>Your cart is empty</h2><p>Add a T-shirt to check out.</p><button class="sh-btn sh-btn--red" data-go="all">Browse T-shirts</button></div>`;$('#coSum').innerHTML='';return}
  const m=$('#coMain'); renderSum();
  if(step===1)m.innerHTML=stepsBar()+`<div class="sh-panel"><h2>You</h2><p>Signed in. Order updates come on WhatsApp and email.</p>
    <div class="sh-wa"><i>✓</i>WhatsApp +91 98•••• 4521 verified</div>
    <div class="sh-form"><label>Full name<input value="Anita Sharma"></label><label>Email<input value="anita@example.com"></label></div>
    <p style="font:700 14px Nunito;color:#6b4a2b;margin:14px 0 0">Not signed in? Same as event bookings: WhatsApp first, then email, then Google.</p>
    <div style="margin-top:18px"><button class="sh-btn sh-btn--red" data-step="2">Continue to address →</button></div></div>`;
  if(step===2)m.innerHTML=stepsBar()+`<div class="sh-panel"><h2>Delivery address</h2><p>Saved addresses from your profile appear first.</p>
    <label class="sh-opt" style="background:#fff;border:2px solid #b3261e;border-radius:14px;padding:14px;margin-bottom:14px"><input type="radio" name="ad" checked> <span><b style="color:#5a1f14">Home</b> — 12 Rajpur Road, Dehradun, Uttarakhand 248001</span></label>
    <details><summary class="sh-link" style="display:inline">+ Use a new address</summary><div class="sh-form" style="margin-top:14px">
    <label class="full">Address line<input placeholder="House, street, area"></label><label>Pincode<input placeholder="248001"></label><label>City<input></label><label>State<select><option>Uttarakhand</option><option>Delhi</option><option>Maharashtra</option></select></label><label>Phone for courier<input placeholder="+91"></label></div></details>
    <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap"><button class="sh-btn sh-btn--ghost" data-step="1">← Back</button><button class="sh-btn sh-btn--red" data-step="3">Continue to review →</button></div></div>`;
  if(step===3)m.innerHTML=stepsBar()+`<div class="sh-panel"><h2>Review your order</h2><p>Check sizes now — every tee is printed to order, so sizes can’t be changed later.</p>
    ${cart.map(i=>`<div class="sh-sum-item">${ph({col:[i.col]})}<div><b>${P[i.id].name}</b><small>${i.col} · Size ${i.size}</small></div><div class="sh-qty" style="height:40px"><button data-cq="${cart.indexOf(i)}|-1">−</button><span>${i.qty}</span><button data-cq="${cart.indexOf(i)}|1">+</button></div></div>`).join('')}
    <p style="font:700 15px Nunito;color:#3c4a4c;margin:16px 0 0">Ships to: 12 Rajpur Road, Dehradun 248001 · Printed to order, arrives in 5–8 days</p>
    <label class="sh-opt" style="margin-top:14px"><input type="checkbox" class="coAgree"> I agree to the <a class="sh-link" style="font-size:15px">Terms &amp; Conditions</a></label><label class="sh-opt" style="margin-top:8px"><input type="checkbox" class="coAgree"> I agree to the <a class="sh-link" style="font-size:15px">Refund policy</a> — no returns; refund only if we send the wrong item</label><p class="sh-err" id="coAgreeErr"></p>
    <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap"><button class="sh-btn sh-btn--ghost" data-step="2">← Back</button><button class="sh-btn sh-btn--red" id="coToPay">Go to payment →</button></div></div>`;
  if(step===4){const b=sub()-coupon,total=b+gstOf(b), pay=total-3;
    m.innerHTML=stepsBar()+`<div class="sh-panel"><p class="sh-eyebrow">Last step · Pay</p><h2>Pay with UPI</h2><p>Same as event bookings — scan the QR or pay to the UPI ID. No card, no app redirect.</p>
    <div class="sh-pay"><div class="sh-qr">${qr()}<small>Scan with any UPI app</small><button class="sh-link" style="font-size:14px">Save QR</button></div>
    <div><div class="sh-amt"><small>Please pay this exact amount</small><b>${inr(pay)}</b><em>UPI rounding discount −₹3 (helps us match your payment)</em></div>
     <div class="sh-upi"><span>UPI ID <b>saathum@hdfcbank</b></span><button class="sh-link" style="font-size:14px">Copy</button></div>
     <ol class="sh-how"><li>Open GPay, PhonePe, Paytm or BHIM</li><li>Scan the QR or pay to the UPI ID</li><li>Pay exactly <b>${inr(pay)}</b>, then tap the button below</li></ol>
     <button class="sh-btn sh-btn--red sh-btn--wide" id="coPaid">I’ve paid →</button>
     <p style="font:700 13px Nunito;color:#7a6a55;margin:10px 0 0">This QR is held for 30 minutes.</p></div></div></div>`;}
  if(step===45)m.innerHTML=stepsBar()+`<div class="sh-panel"><p class="sh-eyebrow">Payment · Step 2 of 2</p><h2>Waiting for bank to confirm</h2><p>Your bank usually confirms within a minute. This page updates by itself.</p>
    <div class="sh-wait"><div class="ok"><i>✓</i>You paid in your UPI app</div><div class="spin" id="w2"><i>…</i>Bank is confirming your payment</div><div id="w3"><i></i>Order confirmed and receipt sent</div></div>
    <p style="font:800 14px Nunito;color:#5a1f14;margin:14px 0 6px">Have your 12-digit UPI reference? Enter it to speed things up</p>
    <div class="sh-utr"><input placeholder="12-digit UTR" maxlength="12" inputmode="numeric"><button class="sh-btn sh-btn--teal" style="min-height:46px">Submit</button></div></div>`;
  if(step===5){m.innerHTML=`<div class="sh-panel sh-done"><div class="big">✓</div><p class="sh-eyebrow">Order SHP-24817 confirmed</p><h2>Thank you, Anita!</h2><p>Payment of ${inr(lastOrder.total)} received. Your T-shirts go to print now. We send the tracking link on WhatsApp and email the moment they ship (usually 3–5 days).</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><button class="sh-btn sh-btn--red" data-go="orders">Track in My orders →</button><button class="sh-btn sh-btn--ghost">Download receipt (PDF)</button><button class="sh-btn sh-btn--ghost" data-go="home">Keep shopping</button></div></div>`;$('#coSum').innerHTML=`<h2>Paid</h2>${lastOrder.html}<div class="sh-row sh-row--tot"><span>Total paid</span><span>${inr(lastOrder.total)}</span></div><p style="font:700 14px Nunito;color:#1e8a4c;margin:0">✓ Shows in Dashboard → Billing</p>`}
}
document.addEventListener('click',e=>{
  const s=e.target.closest('[data-step]'); if(s){step=+s.dataset.step;renderCheckout();window.scrollTo(0,0)}
  if(e.target.id==='coToPay'){const ok=$$('.coAgree').every(c=>c.checked);if(!ok){$('#coAgreeErr').textContent='Please agree to the Terms & Conditions and the Refund policy to continue.';return}step=4;renderCheckout();window.scrollTo(0,0)}
  if(e.target.id==='coApply'){const v=($('#coCode').value||'').trim().toUpperCase();if(v==='NAVRATRI10'){coupon=Math.round(sub()*.1);toast('Coupon applied: 10% off')}else toast('Try NAVRATRI10 in this mockup');renderSum()}
  if(e.target.id==='coPaid'){step=45;renderCheckout();
    setTimeout(()=>{const w=$('#w2');if(w){w.className='ok';w.querySelector('i').textContent='✓'}},1600);
    setTimeout(()=>{const w=$('#w3');if(w){w.className='ok';w.querySelector('i').textContent='✓'}},2600);
    setTimeout(()=>{lastOrder={total:sub()-coupon+gstOf(sub()-coupon)-3,html:cart.map(i=>`<div class="sh-sum-item">${ph({col:[i.col]})}<div><b>${P[i.id].name}</b><small>${i.col} · ${i.size} · Qty ${i.qty}</small></div><strong>${inr(P[i.id].price*i.qty)}</strong></div>`).join(''),items:cart.slice()};
      ORDERS.unshift({id:'SHP-24817',date:'1 Oct 2026',items:lastOrder.items,total:lastOrder.total,st:'paid',utr:'627415093388',cust:'Anita Sharma',city:'Dehradun'});
      cart=[];coupon=0;renderCart();step=5;renderCheckout();renderAdminOrders()},3400);}
});
function qr(){let s='<svg viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/>';let seed=7;const rnd=()=>(seed=(seed*9301+49297)%233280)/233280;
  const finder=(x,y)=>`<rect x="${x}" y="${y}" width="7" height="7" fill="#17343c"/><rect x="${x+1}" y="${y+1}" width="5" height="5" fill="#fff"/><rect x="${x+2}" y="${y+2}" width="3" height="3" fill="#17343c"/>`;
  for(let y=1;y<28;y++)for(let x=1;x<28;x++){if((x<9&&y<9)||(x>19&&y<9)||(x<9&&y>19))continue;if(rnd()>.52)s+=`<rect x="${x}" y="${y}" width="1" height="1" fill="#17343c"/>`}
  return s+finder(1,1)+finder(21,1)+finder(1,21)+'</svg>'}

/* ---------- customer dashboard ---------- */
const ORDERS=[
 {id:'SHP-24790',date:'26 Sep 2026',items:[{id:3,col:'Maroon',size:'L',qty:1}],total:899,st:'shipped',utr:'626918204471',cust:'Anita Sharma',city:'Dehradun',awb:'DL 77812 4410',courier:'Printrove · Delhivery'},
 {id:'SHP-24655',date:'12 Sep 2026',items:[{id:0,col:'Saffron',size:'M',qty:2},{id:6,col:'White',size:'4-5Y',qty:1}],total:1847,st:'delivered',utr:'625511873320',cust:'Anita Sharma',city:'Dehradun',awb:'BD 77011 2893',courier:'Printrove · Bluedart'},
];
const custSide=`<h3>My account</h3><a>Book events</a><a>My events</a><a>Past events</a><a data-go="orders">My orders <span class="new">New</span></a><a>Wishlist</a><a data-go="billing">Billing</a><a>Profile</a><a>Logout</a>`;
$$('[data-side="cust"]').forEach(n=>n.innerHTML=custSide);
const STEPS=['Ordered','Paid','Printing','Shipped','Delivered'],RANK={pending:0,paid:1,packed:2,shipped:3,delivered:4};
const stLabel={pending:'Awaiting payment',paid:'Paid · going to print',packed:'Printing at Printrove',shipped:'Shipped',delivered:'Delivered',cancelled:'Cancelled'};
function renderOrders(){
  $$('[data-side="cust"] a').forEach(a=>a.classList.toggle('is-on',a.dataset.go==='orders'));
  $('#custOrders').innerHTML=ORDERS.filter(o=>o.cust==='Anita Sharma').map(o=>`<div class="sh-order"><div class="sh-oh"><div><b>${o.id}</b><small>Placed ${o.date} · ${inr(o.total)} paid by UPI</small></div><span class="sh-st st-${o.st}">${stLabel[o.st]}</span></div>
   <div class="sh-oitems">${o.items.map(i=>`<div class="sh-oitem">${ph({col:[i.col]})}<div><b>${P[i.id].name}</b><small>${i.col} · ${i.size} · Qty ${i.qty}</small></div></div>`).join('')}</div>
   <div class="sh-track">${STEPS.map((s,k)=>`<div class="${k<=RANK[o.st]?'ok':''}">${s}${k===3&&o.awb?`<small>${o.awb}</small>`:''}</div>`).join('')}</div>
   <div class="sh-oact">${o.st==='shipped'?`<button class="sh-btn sh-btn--teal">Track parcel (${o.courier}) →</button>`:''}<button class="sh-btn sh-btn--ghost">Receipt PDF</button>${o.st==='delivered'?'<button class="sh-btn sh-btn--ghost">Wrong item? Report it</button>':''}<button class="sh-btn sh-btn--ghost">Need help?</button></div></div>`).join('');
}
function renderBilling(){
  $$('[data-side="cust"] a').forEach(a=>a.classList.toggle('is-on',a.dataset.go==='billing'));
  const shop=ORDERS.filter(o=>o.cust==='Anita Sharma').map(o=>`<tr><td>${o.date}</td><td><b>${o.id}</b> · ${o.items.length} item${o.items.length>1?'s':''}</td><td><span class="sh-bill-src src-shop">Shop</span></td><td>${o.utr}</td><td><b>${inr(o.total)}</b></td><td><span class="sh-st st-delivered">Paid</span></td><td><button class="sh-link" style="font-size:14px">Receipt</button></td></tr>`).join('');
  $('#custBill').innerHTML=shop+`<tr><td>20 Sep 2026</td><td><b>Rudrabhishek Havan</b> · Kedarnath</td><td><span class="sh-bill-src src-event">Event</span></td><td>626300117245</td><td><b>₹311</b></td><td><span class="sh-st st-delivered">Paid</span></td><td><button class="sh-link" style="font-size:14px">Receipt</button></td></tr><tr><td>02 Sep 2026</td><td><b>Ganapati Havan</b> · Haridwar</td><td><span class="sh-bill-src src-event">Event</span></td><td>624519900812</td><td><b>₹111</b></td><td><span class="sh-st st-cancelled">Refunded</span></td><td><button class="sh-link" style="font-size:14px">Receipt</button></td></tr>`;
}

/* ---------- admin ---------- */
ORDERS.push(
 {id:'SHP-24815',date:'1 Oct 2026',items:[{id:1,col:'Black',size:'XL',qty:1}],total:799,st:'paid',utr:'627411200958',cust:'Rohit Negi',city:'Haridwar'},
 {id:'SHP-24812',date:'30 Sep 2026',items:[{id:5,col:'Mustard',size:'M',qty:1},{id:2,col:'Cream',size:'S',qty:1}],total:1348,st:'packed',utr:'627388164020',cust:'Priya Iyer',city:'Chennai'},
 {id:'SHP-24810',date:'30 Sep 2026',items:[{id:4,col:'Teal',size:'L',qty:1}],total:828,st:'pending',utr:'—',cust:'Sameer Joshi',city:'Pune'},
 {id:'SHP-24801',date:'28 Sep 2026',items:[{id:3,col:'Black',size:'XXL',qty:1}],total:978,st:'cancelled',utr:'626977305112',cust:'Kavita Rawat',city:'Delhi'});
let aFilter='all';
function renderAdminOrders(){
  const rows=ORDERS.filter(o=>aFilter==='all'||o.st===aFilter);
  $('#aOrders').innerHTML=rows.map(o=>{const k=ORDERS.indexOf(o);
   const act=o.st==='pending'?`<button class="sh-btn sh-btn--ghost sh-mini" data-amatch="${k}">Match payment</button>`:o.st==='paid'?`<button class="sh-btn sh-btn--teal sh-mini" data-apack="${k}">Sent to Printrove</button>`:o.st==='packed'?`<button class="sh-btn sh-btn--red sh-mini" data-aship="${k}">Mark shipped</button>`:o.st==='shipped'?`<button class="sh-btn sh-btn--ghost sh-mini" data-adeliv="${k}">Mark delivered</button>`:o.st==='cancelled'?`<span style="font:700 14px Nunito">Refund UTR sent</span>`:'—';
   return`<tr><td><b>${o.id}</b><br><small>${o.date}</small></td><td>${o.cust}<br><small>${o.city}</small></td><td>${o.items.map(i=>`${P[i.id].name} · ${i.size} ×${i.qty}`).join('<br>')}</td><td><b>${inr(o.total)}</b></td><td>${o.utr==='—'?'<span style="color:#7a5a00">Not matched</span>':'UPI '+o.utr.slice(-4)}</td><td><span class="sh-st st-${o.st}">${stLabel[o.st]}</span>${o.awb&&o.st!=='delivered'?`<br><small>${o.awb}</small>`:''}</td><td>${act}</td></tr>`}).join('')||'<tr><td colspan="7" style="text-align:center;padding:30px">No orders in this state.</td></tr>';
  $('#aToShip').textContent=ORDERS.filter(o=>o.st==='paid'||o.st==='packed').length;
  $('#aNewCount').textContent=ORDERS.filter(o=>o.st==='paid').length+' to print';$('#aToPrint').textContent=ORDERS.filter(o=>o.st==='paid').length;
}
$('#aOrderTabs').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;aFilter=b.dataset.f;$$('#aOrderTabs button').forEach(x=>x.classList.toggle('is-on',x===b));renderAdminOrders()});
const SLOTS={'Hero hotspots (photo dots)':[5,3,4],'New arrivals rail':[2,4,6,5],'Featured banner':[2],'Bestsellers rail':[3,1,0,5],'Sale badge':[1,5],'Product page · You may also like':[0,3,4,1]};
function renderProducts(){
  $('#aProducts').innerHTML=P.filter(p=>!p.gone).map(p=>{const on=Object.entries(SLOTS).filter(([,v])=>v.includes(p.id)).map(([k])=>k.split(' (')[0].split(' ·')[0]);
   return`<tr><td>${ph(p)}<b>${p.name}</b></td><td>${p.coll}</td><td><b>${inr(p.price)}</b>${p.mrp?`<br><small><s>${inr(p.mrp)}</s></small>`:''}</td><td><small>${p.sizes.join(' · ')}</small></td><td style="max-width:220px"><small>${on.join(', ')||'—'}</small></td><td><span class="sh-st st-delivered">Live</span></td>
   <td style="white-space:nowrap"><button class="sh-btn sh-btn--ghost sh-mini" data-aedit="${p.id}">Edit</button> <button class="sh-btn sh-btn--teal sh-mini" data-apromo="${p.id}">Promote</button> <button class="sh-btn sh-btn--ghost sh-mini" style="color:#b3261e;border-color:#b3261e" data-adel="${p.id}">Delete</button></td></tr>`}).join('');
}
function renderSlots(){$('#aSlots').innerHTML=Object.entries(SLOTS).map(([k,v])=>`<div class="sh-slot"><h3>${k}</h3><p>${v.length} product${v.length>1?'s':''} · drag to reorder</p><div class="sh-slot-items">${v.filter(i=>!P[i].gone).map(i=>`<span>${ph(P[i])}${P[i].name}</span>`).join('')}<span style="border-style:dashed;padding:4px 10px;cursor:pointer">+ Add</span></div></div>`).join('')}
let CATS=COLLS.map(c=>c[0]);
function renderCats(){$('#aCats').innerHTML=CATS.map((c,i)=>`<div class="sh-sum-item" style="grid-template-columns:28px 1fr auto"><span style="font:900 18px Nunito;color:#a08974;cursor:grab">⋮⋮</span><div><b>${c}</b><small>${P.filter(p=>p.coll===c&&!p.gone).length} products · shown on shop home</small></div><div style="white-space:nowrap"><button class="sh-btn sh-btn--ghost sh-mini">Edit</button> <button class="sh-btn sh-btn--ghost sh-mini" style="color:#b3261e;border-color:#b3261e" data-acatdel="${i}">Delete</button></div></div>`).join('')}
$('#aCatAdd').addEventListener('click',()=>{const v=$('#aCatName').value.trim();if(!v)return;CATS.push(v);$('#aCatName').value='';renderCats();toast('Collection added')});
$$('[data-atab]').forEach(a=>a.addEventListener('click',()=>{$$('[data-atab]').forEach(x=>x.classList.toggle('is-on',x===a));$$('.sh-apanel').forEach(p=>p.classList.toggle('is-on',p.dataset.apanel===a.dataset.atab))}));

function modal(html){$('#shModalBox').innerHTML=html;$('#shModal').classList.add('is-on')}
function closeModal(){$('#shModal').classList.remove('is-on')}
let mIdx=null;
document.addEventListener('click',e=>{
  if(e.target.id==='shModal'||e.target.closest('[data-close]'))closeModal();
  const t=e.target.closest('[data-apack],[data-adeliv],[data-amatch]');
  if(t){const k=+(t.dataset.apack??t.dataset.adeliv??t.dataset.amatch);const o=ORDERS[k];
    if(t.dataset.amatch!==undefined){mIdx=k;modal(`<h2>Match payment · ${o.id}</h2><p>No bank SMS matched ${inr(o.total)} yet. Enter the customer's 12-digit UTR after checking your bank app.</p><div class="sh-form"><label class="full">UTR<input placeholder="12-digit UPI reference"></label></div><div style="display:flex;gap:10px;margin-top:16px"><button class="sh-btn sh-btn--ghost" data-close>Cancel</button><button class="sh-btn sh-btn--teal" id="mMatch" style="flex:1">Confirm payment</button></div><p style="margin-top:12px;font-size:14px">Rejecting sends the soft WhatsApp + email message with the support contact.</p>`);return}
    o.st=t.dataset.apack!==undefined?'packed':'delivered';renderAdminOrders();toast(`${o.id} → ${stLabel[o.st]} · customer notified on WhatsApp + email`)}
  const s=e.target.closest('[data-aship]'); if(s){mIdx=+s.dataset.aship;const o=ORDERS[mIdx];modal(`<h2>Mark ${o.id} as shipped</h2><p>${o.cust}, ${o.city} · ${o.items.length} item(s). Copy the courier and tracking number from Printrove.</p><div class="sh-form">
    <label>Courier (from Printrove)<select id="mCour"><option>Printrove · Delhivery</option><option>Printrove · Bluedart</option><option>Printrove · Xpressbees</option><option>Printrove · India Post</option></select></label><label>AWB / tracking number<input id="mAwb" value="DL 77920 1183"></label><label class="full">Tracking link<input value="https://www.delhivery.com/track/package/…"></label><label class="full">Expected delivery<input value="5 Oct 2026"></label></div>
    <label class="sh-opt" style="margin-top:14px"><input type="checkbox" checked> Send tracking on WhatsApp + email</label>
    <div style="display:flex;gap:10px;margin-top:16px"><button class="sh-btn sh-btn--ghost" data-close>Cancel</button><button class="sh-btn sh-btn--red" id="mShip" style="flex:1">Mark shipped</button></div>`)}
  if(e.target.id==='mShip'){const o=ORDERS[mIdx];o.st='shipped';o.awb=$('#mAwb').value;o.courier=$('#mCour').value;closeModal();renderAdminOrders();toast(`${o.id} shipped · tracking sent to ${o.cust}`)}
  if(e.target.id==='mMatch'){ORDERS[mIdx].st='paid';ORDERS[mIdx].utr='627455510239';closeModal();renderAdminOrders();toast('Payment confirmed · order moved to “to pack”')}
  const d=e.target.closest('[data-adel]'); if(d){mIdx=+d.dataset.adel;modal(`<h2>Delete “${P[mIdx].name}”?</h2><p>It disappears from the shop, every card and search. Past orders and receipts keep their copy of the product. You can restore it from Archived for 30 days.</p><div style="display:flex;gap:10px"><button class="sh-btn sh-btn--ghost" data-close>Cancel</button><button class="sh-btn sh-btn--red" id="mDel" style="flex:1">Delete product</button></div>`)}
  if(e.target.id==='mDel'){P[mIdx].gone=true;closeModal();renderProducts();renderSlots();renderCats();toast('Product deleted (archived for 30 days)')}
  const pr=e.target.closest('[data-apromo]'); if(pr){mIdx=+pr.dataset.apromo;modal(`<h2>Promote “${P[mIdx].name}”</h2><p>Tick every card on the shop where this product should appear.</p><div class="sh-promo-opts">${Object.keys(SLOTS).map(k=>`<label class="sh-opt"><input type="checkbox" data-slot="${k}"${SLOTS[k].includes(mIdx)?' checked':''}>${k}</label>`).join('')}</div><div class="sh-form"><label>Badge<select><option>None</option><option>New</option><option>Bestseller</option><option>Sale</option></select></label><label>Show until<input value="Always"></label></div><div style="display:flex;gap:10px;margin-top:16px"><button class="sh-btn sh-btn--ghost" data-close>Cancel</button><button class="sh-btn sh-btn--teal" id="mPromo" style="flex:1">Save</button></div>`)}
  if(e.target.id==='mPromo'){$$('[data-slot]').forEach(c=>{const a=SLOTS[c.dataset.slot],i=a.indexOf(mIdx);if(c.checked&&i<0)a.push(mIdx);if(!c.checked&&i>=0)a.splice(i,1)});closeModal();renderProducts();renderSlots();toast('Promotion saved')}
  const ed=e.target.closest('[data-aedit]'); if(ed||e.target.id==='aAddProd'){const p=ed?P[+ed.dataset.aedit]:null;modal(`<h2>${p?'Edit product':'Add product'}</h2><p>Photos, price and stock per size. SEO title and share card are written automatically.</p><div class="sh-form">
    <label class="full">Product name<input value="${p?p.name:''}" placeholder="e.g. Ram Darbar Tee"></label><label>Collection<select>${CATS.map(c=>`<option${p&&p.coll===c?' selected':''}>${c}</option>`).join('')}</select></label><label>Fit<select><option>Regular</option><option${p&&p.fit==='Oversized'?' selected':''}>Oversized</option></select></label>
    <label>Price (₹)<input value="${p?p.price:''}"></label><label>MRP for strike-through (₹)<input value="${p&&p.mrp?p.mrp:''}" placeholder="optional"></label>
    <label class="full">Colours<input value="${p?p.col.join(', '):''}" placeholder="Black, Maroon"></label>
    <label class="full">Sizes offered<input value="${p?p.sizes.join(', '):'S, M, L, XL, XXL'}"></label><label class="full">Printrove product / design ID<input placeholder="from your Printrove dashboard"></label>
    <label class="full">Photos (front, back, close-up, on model)<div class="sh-ph" style="min-height:90px;border-radius:12px"><span>Drop photos here</span></div></label>
    <label class="full">Description<input value="${p?'Original Saa Thum artwork…':''}"></label>
    <label>Status<select><option>Live</option><option>Draft</option><option>Hidden</option></select></label><label>Price shown<input value="+18% GST at checkout" disabled></label></div>
    <div style="display:flex;gap:10px;margin-top:16px"><button class="sh-btn sh-btn--ghost" data-close>Cancel</button><button class="sh-btn sh-btn--red" data-close style="flex:1">${p?'Save changes':'Publish product'}</button></div>`)}
  const cd=e.target.closest('[data-acatdel]'); if(cd){const i=+cd.dataset.acatdel;const n=P.filter(p=>p.coll===CATS[i]&&!p.gone).length;if(n){toast(`Move its ${n} product(s) first — a collection with products can't be deleted`)}else{CATS.splice(i,1);renderCats()}}
});

/* ---------- init ---------- */
$('#shAlso')&&($('#shAlso').innerHTML=P.slice(0,4).map(card).join(''));
renderCart();renderAdminOrders();renderProducts();renderSlots();renderCats();route();
})();
