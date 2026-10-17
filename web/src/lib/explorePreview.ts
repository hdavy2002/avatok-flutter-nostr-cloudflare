// @ts-nocheck
// [HF-EXPLORE-V2-1] Client behaviour for /explore-preview: search + autocomplete, live filters, Grid/Reels/List views,
// simulated official embeds and the 3-step Book Call drawer. All creators are SAMPLE data; wiring to D1 comes later.
export function initExplorePreview(){
const ROOT=document.getElementById('xp');if(!ROOT)return;
const IMG=JSON.parse(document.getElementById('xp-img')?.textContent||'{}');
const BRAND=ROOT.dataset.brand||'';

const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- icons ---------- */
const PL={
 ig:'<svg viewBox="0 0 24 24" fill="none" stroke="#be246e" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.6" r="1.2" fill="#be246e" stroke="none"/></svg>',
 yt:'<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="4" fill="#d6332f"/><path d="M10 9l5 3-5 3z" fill="#fff"/></svg>',
 fb:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#2f5fd0"/><path d="M13.2 20v-6.2h2.1l.3-2.5h-2.4V9.8c0-.7.2-1.2 1.2-1.2h1.3V6.4a17 17 0 0 0-1.9-.1c-1.9 0-3.2 1.1-3.2 3.3v1.7H8.5v2.5h2.1V20z" fill="#fff"/></svg>'
};
const PLN={ig:'Instagram',yt:'YouTube',fb:'Facebook'};
const I={
 play:'<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
 eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
 phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
 x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
 down:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><path d="m6 9 6 6 6-6"/></svg>',
 bolt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
 cal:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
 vb:'<svg class="vbadge" viewBox="0 0 24 24"><path d="M12 1.5l2.6 2 3.2-.3.9 3.1 2.8 1.6-1 3.1 1 3.1-2.8 1.6-.9 3.1-3.2-.3-2.6 2-2.6-2-3.2.3-.9-3.1-2.8-1.6 1-3.1-1-3.1 2.8-1.6.9-3.1 3.2.3z" fill="#be246e" stroke="#30245f" stroke-width="1.4"/><path d="m8 12.2 2.6 2.6L16 9.4" fill="none" stroke="#fff2cf" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
 rosette:'<svg class="rosette" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20" fill="#ff793c" stroke="#30245f" stroke-width="2"/><circle cx="22" cy="22" r="12" fill="#fbd447" stroke="#30245f" stroke-width="2"/><circle cx="22" cy="22" r="5" fill="#be246e"/></svg>'
};
const CAT={
 Lifestyle:{c:'#ffdf89',p:'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z'},
 Comedy:{c:'#ffa179',p:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 14s1.5 2.5 4 2.5 4-2.5 4-2.5M9 9.5h.01M15 9.5h.01'},
 Fashion:{c:'#efabd0',p:'M8 3 3 6l2 4 3-1v12h8V9l3 1 2-4-5-3a4 4 0 0 1-8 0z'},
 Beauty:{c:'#bfc2ee',p:'M9 21h6V11H9zM10 11V6l4-3v8'},
 Food:{c:'#fbd447',p:'M3 11h18a9 9 0 0 1-18 0zM8 7c0-2 2-2 2-4M13 7c0-2 2-2 2-4'},
 Travel:{c:'#bfc2ee',p:'M2 13 22 5l-8 18-2-8z'},
 Music:{c:'#efabd0',p:'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'},
 Fitness:{c:'#ffa179',p:'M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12'},
 Gaming:{c:'#ffdf89',p:'M6 8h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5 2l-2-2H9l-2 2a3 3 0 0 1-5-2v-1a4 4 0 0 1 4-4zM8 10.5v3M6.5 12h3M16 11h.01M18 13h.01'},
 Education:{c:'#bfc2ee',p:'M2 5h7a3 3 0 0 1 3 3v12a2.5 2.5 0 0 0-2.5-2.5H2zM22 5h-7a3 3 0 0 0-3 3v12a2.5 2.5 0 0 1 2.5-2.5H22z'},
 Spirituality:{c:'#fbd447',p:'M3 14h18c-1 4-5 6-9 6s-8-2-9-6zM12 3c2.2 3 2.2 5.5 0 8-2.2-2.5-2.2-5 0-8z'}
};
const catImg=(k,cls='')=>`<img class="${cls}" src="${IMG['cat-'+k.toLowerCase()]}" alt="" width="112" height="112" loading="lazy">`;


/* ---------- sample data (dummy until wired to D1) ---------- */
const C=[
 {id:'meera',name:'Meera Joshi',h:'meera.unfiltered',pl:['ig','yt'],cat:['Lifestyle','Travel'],lang:['Hindi','English'],rate:20,st:'online',v:'1.2M',f:'840K',ver:true,g:'Female',img:'sample-01',tags:['featured','popular'],today:true},
 {id:'kabir',name:'Kabir Malhotra',h:'kabirkehtahai',pl:['yt','ig'],cat:['Comedy'],lang:['Hindi','English'],rate:15,st:'busy',v:'842K',f:'1.1M',ver:true,g:'Male',img:'sample-02',tags:['featured','popular'],today:true},
 {id:'sonalim',name:'Sonali Mehta',h:'sonali.style',pl:['ig','fb'],cat:['Fashion'],lang:['Hindi','Marathi'],rate:16,st:'online',v:'356K',f:'3.4M',ver:true,g:'Female',img:'sample-03',tags:['featured'],today:true},
 {id:'rohan',name:'Rohan Bhatt',h:'rohan.on.road',pl:['yt'],cat:['Travel'],lang:['Hindi','English'],rate:18,st:'online',v:'670K',f:'390K',ver:false,g:'Male',img:'sample-04',tags:['featured'],today:true},
 {id:'ananya',name:'Ananya Iyer',h:'ananya.sings',pl:['ig'],cat:['Music'],lang:['Tamil','English'],rate:25,st:'online',v:'956K',f:'620K',ver:true,g:'Female',img:'art-05',tags:['featured'],today:true},
 {id:'kamla',name:'Kamla Bisht',h:'pahadi.rasoi',pl:['yt','fb'],cat:['Food'],lang:['Hindi','Garhwali'],rate:12,st:'online',v:'2.1M',f:'1.6M',ver:true,g:'Female',img:'sample-05',tags:['popular'],today:true,kw:'pahadi uttarakhand recipes'},
 {id:'meenakshi',name:'Meenakshi Raghavan',h:'carnatic.with.meenakshi',pl:['yt'],cat:['Music','Education'],lang:['Tamil','Telugu','English'],rate:22,st:'busy',v:'980K',f:'540K',ver:true,g:'Female',img:'sample-06',tags:['popular'],today:true},
 {id:'gurdev',name:'Gurdev Singh',h:'gallan.gurdev.diyan',pl:['fb','yt'],cat:['Spirituality'],lang:['Punjabi','Hindi'],rate:5,st:'offline',v:'1.4M',f:'2.3M',ver:true,g:'Male',img:'sample-10',tags:['popular'],today:false},
 {id:'anjali',name:'Anjali Desai',h:'anjali.parents',pl:['ig'],cat:['Education','Lifestyle'],lang:['Gujarati','Hindi','English'],rate:16,st:'online',v:'1.3M',f:'910K',ver:false,g:'Female',img:'art-03',tags:['popular'],today:true},
 {id:'faizan',name:'Faizan Ali',h:'lucknowi.zaika',pl:['ig','yt'],cat:['Food','Travel'],lang:['Urdu','Hindi'],rate:14,st:'online',v:'730K',f:'480K',ver:false,g:'Male',img:'sample-12',tags:['popular','new'],today:true},
 {id:'arjun',name:'Arjun Das',h:'arjun.lifts',pl:['ig'],cat:['Fitness'],lang:['Kannada','English'],rate:12,st:'online',v:'188K',f:'260K',ver:false,g:'Male',img:'sample-07',tags:['new'],today:true},
 {id:'priyanka',name:'Priyanka Reddy',h:'gamingwithpri',pl:['yt'],cat:['Gaming'],lang:['Telugu','English'],rate:10,st:'busy',v:'402K',f:'330K',ver:false,g:'Female',img:'sample-08',tags:['new'],today:true},
 {id:'riya',name:'Riya Sen',h:'riya.glowup',pl:['ig','fb'],cat:['Beauty'],lang:['Bengali','Hindi'],rate:18,st:'offline',v:'97K',f:'150K',ver:false,g:'Female',img:'sample-11',tags:['new'],today:false},
 {id:'vikram',name:'Vikram Nair',h:'vikram.explains',pl:['yt'],cat:['Education'],lang:['Malayalam','English'],rate:20,st:'online',v:'—',f:'480K',ver:false,g:'Male',img:'sample-09',tags:['new'],today:true,video:'unavailable'}
];
const D=[
 {id:'d1',name:'Sonali Sharma',h:'sonali.sharma',pl:['ig'],cat:['Gaming','Lifestyle'],lang:['Hindi'],f:'12.5M',img:'art-06',asks:342},
 {id:'d2',name:'Rahul Kulkarni',h:'rahulcooks',pl:['yt'],cat:['Food'],lang:['Marathi','Hindi'],f:'3.4M',img:'art-02',asks:128},
 {id:'d3',name:'Fatima Shaikh',h:'fatima.poetry',pl:['ig'],cat:['Education'],lang:['Urdu','Hindi'],f:'1.9M',img:'art-01',asks:96},
 {id:'d4',name:'Tenzin Norbu',h:'tenzin.trails',pl:['yt'],cat:['Travel'],lang:['English','Hindi'],f:'860K',img:'art-04',asks:51}
];
const TILES=['tileyellow','tilepink','tilelavender','tilepeach'];
const thumb=(c,cls='')=>`<img class="${cls}" src="${IMG[c.img]}" alt="" loading="lazy" decoding="async">`;
const smallImg=c=>`<img src="${IMG[c.img+'-sm']}" alt="" loading="lazy">`;

/* ---------- card ---------- */
function card(c,i){
 const extra=c.pl.length>1?`<span class="more" title="Also on ${c.pl.slice(1).map(p=>PLN[p]).join(', ')}">+${c.pl.length-1}</span>`:'';
 const stTxt={online:'Online now',busy:'Busy',offline:'Offline'}[c.st];
 return `<article class="card" style="--tile:url(${IMG[TILES[i%4]]})" data-id="${c.id}">
  <img class="rosette" src="${IMG.rosette}" alt="" aria-hidden="true">
  <div class="vid">${thumb(c,'poster')}<div class="shade"></div>
   <div class="plat"><span title="${PLN[c.pl[0]]}">${PL[c.pl[0]]}</span>${extra}</div>
   <button class="playb" type="button" data-play="${c.id}" aria-label="Play ${esc(c.name)}'s latest ${PLN[c.pl[0]]} video">${I.play}</button>
   <div class="meta"><span class="views-ct" title="Views on latest video">${I.eye}${c.v}</span><span class="status ${c.st}"><i></i><span>${stTxt}</span></span></div>
  </div>
  <div class="info">
   <div class="nm"><h3>${esc(c.name)}</h3>${c.ver?`<img class="vbadge" src="${IMG.verified}" alt="Verified" title="Verified: account ownership confirmed by connecting ${PLN[c.pl[0]]}">`:''}</div>
   <div class="handle">@${esc(c.h)} &middot; ${c.f} followers</div>
   <div class="chips">${c.cat.map(x=>`<span>${x}</span>`).join('')}${c.lang.slice(0,2).map(x=>`<span class="lang">${x}</span>`).join('')}</div>
   <div class="buy"><div class="rate">₹${c.rate}<small>/min</small></div><button class="book" type="button" data-book="${c.id}">${I.phone}Book call</button></div>
  </div>
 </article>`;
}
function dcard(d,i){
 return `<article class="card disc" style="--tile:url(${IMG.tilelavender})" data-id="${d.id}">
  <div class="vid">${thumb(d,'poster')}<div class="shade"></div>
   <div class="plat"><span title="${PLN[d.pl[0]]}">${PL[d.pl[0]]}</span></div>
   <button class="playb" type="button" data-play="${d.id}" aria-label="Play ${esc(d.name)}'s latest video">${I.play}</button>
   <div class="meta" style="justify-content:flex-end"><span class="tag no" style="background:var(--paper)">Not bookable yet</span></div>
  </div>
  <div class="info">
   <div class="nm"><h3>${esc(d.name)}</h3></div>
   <div class="handle">@${esc(d.h)} &middot; ${d.f} on ${PLN[d.pl[0]]}</div>
   <div class="chips">${d.cat.map(x=>`<span>${x}</span>`).join('')}${d.lang.slice(0,2).map(x=>`<span class="lang">${x}</span>`).join('')}</div>
   <button class="invite" type="button" data-invite="${d.id}" aria-pressed="false">Ask them to join</button>
   <div class="asked" data-asked="${d.id}">${d.asks} fans asked so far</div>
  </div>
 </article>`;
}
function row(c){
 const stTxt={online:'Online now',busy:'Busy',offline:'Offline'}[c.st];
 return `<article class="row" data-id="${c.id}">
  <div class="th">${smallImg(c)}</div>
  <div style="min-width:0"><div class="nm"><h3>${esc(c.name)}</h3>${c.ver?`<img class="vbadge" src="${IMG.verified}" alt="Verified">`:''}</div>
   <div class="handle" style="margin-top:2px">@${esc(c.h)} &middot; ${c.pl.map(p=>PLN[p]).join(' + ')}</div></div>
  <div class="chips row-chips">${c.cat.map(x=>`<span>${x}</span>`).join('')}${c.lang.map(x=>`<span class="lang">${x}</span>`).join('')}</div>
  <span class="status ${c.st} row-status"><i></i>${stTxt}</span>
  <div style="display:flex;align-items:center;gap:14px"><div class="rate">₹${c.rate}<small>/min</small></div><button class="book" type="button" data-book="${c.id}">${I.phone}<span>Book</span></button></div>
 </article>`;
}

/* ---------- state ---------- */
const S={q:'',platform:new Set(),category:new Set(),language:new Set(),gender:new Set(),avail:'any',pmin:'',pmax:'',sort:'rec',view:'grid'};
const LANGS=['Hindi','English','Tamil','Telugu','Punjabi','Bengali','Marathi','Gujarati','Malayalam','Garhwali'];
const F=[
 {k:'platform',label:'Platform',type:'multi',opts:[['ig','Instagram'],['yt','YouTube'],['fb','Facebook']]},
 {k:'category',label:'Category',type:'multi',opts:Object.keys(CAT).map(x=>[x,x])},
 {k:'language',label:'Language',type:'multi',opts:LANGS.map(x=>[x,x])},
 {k:'gender',label:'Gender',type:'multi',opts:[['Female','Female'],['Male','Male']],note:'Only shown when the creator chose to add it to their profile.'},
 {k:'avail',label:'Availability',type:'radio',opts:[['any','Any time'],['online','Online now'],['today','Available today'],['schedule','Schedule a call']]},
 {k:'price',label:'Price / min',type:'price'},
 {k:'sort',label:'Sort',type:'radio',opts:[['rec','Recommended'],['pop','Popular'],['recent','Recently active'],['plo','Price: low to high'],['phi','Price: high to low']]}
];
const views=v=>parseFloat(v)*(/M/.test(v)?1e6:/K/.test(v)?1e3:1)||0;
function matchQ(c,q){
 if(!q)return true; q=q.toLowerCase().replace(/^@/,'');
 return [c.name,c.h,...c.cat,...c.lang,c.kw||''].join(' ').toLowerCase().includes(q);
}
function filtered(){
 let r=C.filter(c=>matchQ(c,S.q)
  &&(!S.platform.size||c.pl.some(p=>S.platform.has(p)))
  &&(!S.category.size||c.cat.some(x=>S.category.has(x)))
  &&(!S.language.size||c.lang.some(x=>S.language.has(x)))
  &&(!S.gender.size||S.gender.has(c.g))
  &&(S.avail==='any'||(S.avail==='online'&&c.st==='online')||(S.avail==='today'&&c.today)||S.avail==='schedule')
  &&(S.pmin===''||c.rate>=+S.pmin)&&(S.pmax===''||c.rate<=+S.pmax));
 const st={online:0,busy:1,offline:2};
 if(S.sort==='pop')r.sort((a,b)=>views(b.v)-views(a.v));
 else if(S.sort==='recent')r.sort((a,b)=>st[a.st]-st[b.st]);
 else if(S.sort==='plo')r.sort((a,b)=>a.rate-b.rate);
 else if(S.sort==='phi')r.sort((a,b)=>b.rate-a.rate);
 else r.sort((a,b)=>(b.ver-a.ver)||(st[a.st]-st[b.st]));
 return r;
}
const active=()=>!!(S.q||S.platform.size||S.category.size||S.language.size||S.gender.size||S.avail!=='any'||S.pmin!==''||S.pmax!==''||S.sort!=='rec');

/* ---------- render ---------- */
function renderList(list,el,kind){
 if(S.view==='list'&&kind!=='disc'){el.className='list';el.innerHTML=list.map(row).join('');return}
 if(S.view==='reels'){el.className='reels';el.innerHTML=list.map(kind==='disc'?dcard:card).join('');$$('.card .info .buy .book',el).forEach(b=>b.classList.add('wide'));return}
 el.className=kind==='grid'?'grid':'rail';
 el.innerHTML=list.map(kind==='disc'?dcard:card).join('');
}
function renderShelves(){
 const sh={featured:C.filter(c=>c.tags.includes('featured')),popular:C.filter(c=>c.tags.includes('popular')).sort((a,b)=>views(b.v)-views(a.v)),
  available:C.filter(c=>c.st==='online'),new:C.filter(c=>c.tags.includes('new'))};
 $$('[data-shelf]').forEach(el=>{const k=el.dataset.shelf;const inner=document.createElement('div');inner.id='rail-'+k;el.innerHTML='';el.appendChild(inner);
  if(k==='discovered')renderList(D,inner,'disc');else renderList(sh[k],inner,'rail')});
}
function renderResults(){
 const on=active();$('#results').hidden=!on;$('#shelves').hidden=on;
 if(!on)return;
 const r=filtered();
 $('#resTitle').innerHTML=S.q?`${r.length} ${r.length===1?'creator':'creators'} for <span class="hl">&ldquo;${esc(S.q)}&rdquo;</span>`:`${r.length} ${r.length===1?'creator':'creators'} <span class="hl">match.</span>`;
 const pills=[];
 if(S.q)pills.push(['q','','Search: '+S.q]);
 ['platform','category','language','gender'].forEach(k=>S[k].forEach(v=>pills.push([k,v,k==='platform'?PLN[v]:v])));
 if(S.avail!=='any')pills.push(['avail','',F[4].opts.find(o=>o[0]===S.avail)[1]]);
 if(S.pmin!==''||S.pmax!=='')pills.push(['price','',`₹${S.pmin||0}–${S.pmax||'∞'}/min`]);
 if(S.sort!=='rec')pills.push(['sort','','Sort: '+F[6].opts.find(o=>o[0]===S.sort)[1]]);
 $('#pills').innerHTML=pills.map(([k,v,t])=>`<button class="pill" type="button" data-rm="${k}" data-v="${esc(v)}" aria-label="Remove ${esc(t)}">${esc(t)}${I.x}</button>`).join('')+`<button class="clear" type="button" id="clearAll">Clear all</button>`;
 const body=$('#resBody');
 // brief skeleton so the "no page reload" update is visible
 body.className='grid';body.innerHTML='<div class="skel"></div>'.repeat(Math.min(Math.max(r.length,1),5));
 clearTimeout(renderResults.t);
 renderResults.t=setTimeout(()=>{
  if(!r.length){
   const ds=D.filter(d=>matchQ(d,S.q));
   body.className='';
   body.innerHTML=`<div class="empty"><img src="${IMG.empty}" alt="" width="640" height="512"><h3>No bookable creators match yet.</h3><p>Try fewer filters, or a different name or topic.</p>${ds.length?`<p style="margin-top:18px"><b>Found on socials, not on ${BRAND} yet:</b></p><div class="grid" style="text-align:left">${ds.map(dcard).join('')}</div>`:''}</div>`;
  } else {
   renderList(r,body,'grid');
   const ds=S.q?D.filter(d=>matchQ(d,S.q)):[];
   if(ds.length){body.insertAdjacentHTML('afterend','');const w=document.createElement('div');w.innerHTML=`<div class="eyebrow" style="margin-top:56px">Also found on socials &middot; not bookable yet</div><div class="grid">${ds.map(dcard).join('')}</div>`;body.appendChild(w);w.style.gridColumn='1/-1'}
  }
 },260);
}
function renderFilters(){
 $('#frow').innerHTML=F.map(f=>{
  let n=0;if(f.type==='multi')n=S[f.k].size;else if(f.k==='avail')n=S.avail!=='any'?1:0;else if(f.k==='price')n=(S.pmin!==''||S.pmax!=='')?1:0;else if(f.k==='sort')n=0;
  const lab=f.k==='sort'?'Sort: '+F[6].opts.find(o=>o[0]===S.sort)[1]:f.label;
  return `<div class="fdrop"><button class="fbtn${n?' on':''}" type="button" data-f="${f.k}" aria-expanded="false" aria-haspopup="true">${lab}${n?`<span class="n">${n}</span>`:''}${I.down}</button></div>`}).join('');
}
function renderCats(){
 const all=`<button class="cat" type="button" data-cat="" aria-pressed="${!S.category.size}">${catImg('all')}<span>All</span></button>`;
 $('#cats').innerHTML=all+Object.keys(CAT).map(k=>`<button class="cat" type="button" data-cat="${k}" aria-pressed="${S.category.has(k)}">${catImg(k)}<span>${k}</span></button>`).join('');
 $('#tiles').innerHTML=Object.keys(CAT).map(k=>{const n=C.filter(c=>c.cat.includes(k)).length;return `<button class="tile" type="button" data-cat="${k}">${catImg(k)}<span><b>${k}</b><span>${n*37+12} creators</span></span></button>`}).join('');
}
function renderAll(){renderFilters();renderCats();renderShelves();renderResults()}

/* ---------- filter popovers ---------- */
let pop=null;
function closePop(){if(pop){pop.el.remove();pop.btn.setAttribute('aria-expanded','false');pop=null}}
function openPop(btn){
 const k=btn.dataset.f,f=F.find(x=>x.k===k);closePop();
 const el=document.createElement('div');el.className='xp-pop';el.setAttribute('role','dialog');el.setAttribute('aria-label',f.label);
 if(f.type==='multi'){
  el.innerHTML=f.opts.map(([v,t])=>{const n=C.filter(c=>(k==='platform'?c.pl:k==='category'?c.cat:k==='language'?c.lang:[c.g]).includes(v)).length;
   return `<label class="opt"><input type="checkbox" value="${v}" ${S[k].has(v)?'checked':''}>${k==='platform'?`<span style="width:22px;height:22px;display:inline-grid">${PL[v]}</span>`:''}${t}<span class="cnt">${n}</span></label>`}).join('')+(f.note?`<div class="note">${f.note}</div>`:'');
  el.addEventListener('change',e=>{const v=e.target.value;e.target.checked?S[k].add(v):S[k].delete(v);update(true)});
 } else if(f.type==='radio'){
  const cur=k==='avail'?S.avail:S.sort;
  el.innerHTML=f.opts.map(([v,t])=>`<label class="opt"><input type="radio" name="r-${k}" value="${v}" ${cur===v?'checked':''}>${t}</label>`).join('');
  el.addEventListener('change',e=>{S[k==='avail'?'avail':'sort']=e.target.value;update(true)});
 } else {
  el.innerHTML=`<div class="price-in"><label for="pmin">Min ₹/min<input id="pmin" type="number" min="0" inputmode="numeric" value="${S.pmin}" placeholder="10"></label><label for="pmax">Max ₹/min<input id="pmax" type="number" min="0" inputmode="numeric" value="${S.pmax}" placeholder="30"></label></div>
  <div class="presets"><button class="chip" type="button" data-pr=",15">Under ₹15</button><button class="chip" type="button" data-pr="15,25">₹15–25</button><button class="chip" type="button" data-pr="25,">₹25+</button></div>`;
  el.addEventListener('input',e=>{if(e.target.id==='pmin')S.pmin=e.target.value;if(e.target.id==='pmax')S.pmax=e.target.value;update(true)});
  el.addEventListener('click',e=>{const b=e.target.closest('[data-pr]');if(!b)return;[S.pmin,S.pmax]=b.dataset.pr.split(',');$('#pmin',el).value=S.pmin;$('#pmax',el).value=S.pmax;update(true)});
 }
 document.body.appendChild(el);
 const r=btn.getBoundingClientRect();
 el.style.top=(r.bottom+10)+'px';el.style.left=Math.max(16,Math.min(r.left,innerWidth-el.offsetWidth-16))+'px';
 btn.setAttribute('aria-expanded','true');pop={el,btn,k};
 const first=$('input',el);first&&first.focus();
}
function update(keepPop){
 const k=pop&&pop.k;renderFilters();renderCats();renderResults();
 if(keepPop&&k){const b=$(`[data-f="${k}"]`);if(b&&pop){pop.btn=b;b.setAttribute('aria-expanded','true')}}
 if(!keepPop)closePop();
}

/* ---------- search + autocomplete ---------- */
const q=$('#q'),sg=$('#suggest');let sel=-1,items=[];
function avatar(c){return `<span class="av">${smallImg(c)}</span>`}
const TRENDING=[['Sonali','Sonali'],['Pahadi','Pahadi food'],['Tamil','Tamil creators'],['Comedy','Comedy']];
function suggest(){
 const v=q.value.trim();
 if(!v){items=TRENDING.map(t=>({t:'q',v:t[0]}));sg.innerHTML='<h4>Trending searches</h4>'+TRENDING.map(([t,l],i)=>`<button class="sg" type="button" role="option" data-i="${i}"><span class="av" style="display:grid;place-items:center;background:#fbd447;font-weight:900">#</span><span class="who"><b>${esc(l)}</b><span>Popular this week</span></span></button>`).join('');sg.hidden=false;q.setAttribute('aria-expanded','true');sel=-1;return}
 const reg=C.filter(c=>matchQ(c,v)).slice(0,5),dis=D.filter(d=>matchQ(d,v)).slice(0,3);
 const topics=[...Object.keys(CAT),...LANGS].filter(t=>t.toLowerCase().startsWith(v.toLowerCase())).slice(0,3);
 items=[];let h='';
 if(reg.length){h+='<h4>On ${BRAND} &middot; bookable</h4>';reg.forEach(c=>{items.push({t:'c',c});h+=`<button class="sg" type="button" role="option" data-i="${items.length-1}">${avatar(c)}<span class="who"><b>${esc(c.name)}</b> ${c.ver?`<img src="${IMG.verified}" alt="Verified" style="width:20px;height:20px;vertical-align:-4px">`:''}<span>@${esc(c.h)} &middot; ${c.f} followers &middot; ₹${c.rate}/min</span></span><span class="tag ok">${c.st==='online'?'Online':'Bookable'}</span></button>`})}
 if(dis.length){h+='<h4>Found on socials &middot; not on ${BRAND} yet</h4>';dis.forEach(d=>{items.push({t:'d',d});h+=`<button class="sg" type="button" role="option" data-i="${items.length-1}">${avatar(d)}<span class="who"><b>${esc(d.name)}</b><span>@${esc(d.h)} &middot; ${d.f} on ${PLN[d.pl[0]]}</span></span><span class="tag no">Not bookable</span></button>`})}
 if(topics.length){h+='<h4>Topics &amp; languages</h4>';topics.forEach(t=>{items.push({t:'topic',v:t});h+=`<button class="sg" type="button" role="option" data-i="${items.length-1}"><span class="av" style="display:grid;place-items:center;background:#bfc2ee">${CAT[t]?catImg(t):'<b style="font-family:var(--head)">अ</b>'}</span><span class="who"><b>${t}</b><span>${CAT[t]?'Category':'Language'}</span></span></button>`})}
 items.push({t:'all'});h+=`<button class="sg" type="button" role="option" data-i="${items.length-1}"><span class="av" style="display:grid;place-items:center;background:var(--yellow)"><svg viewBox="0 0 24 24" fill="none" stroke="#30245f" stroke-width="2.6" style="width:22px;height:22px"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></svg></span><span class="who"><b>Search &ldquo;${esc(v)}&rdquo; in all creators</b></span></button>`;
 sg.innerHTML=h;sg.hidden=false;q.setAttribute('aria-expanded','true');sel=-1;
}
function pick(i){
 const it=items[i];if(!it)return;sg.hidden=true;
 if(it.t==='c'){openBooking(it.c.id);return}
 if(it.t==='q'){S.q=it.v;q.value=it.v}
 else if(it.t==='d'){S.q=it.d.name;q.value=it.d.name}
 else if(it.t==='topic'){q.value='';S.q='';(CAT[it.v]?S.category:S.language).add(it.v)}
 else S.q=q.value.trim();
 update();scrollToResults();
}
q.addEventListener('input',suggest);q.addEventListener('focus',suggest);
q.addEventListener('keydown',e=>{
 const opts=$$('.sg',sg);if(sg.hidden||!opts.length)return;
 if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();sel=(sel+(e.key==='ArrowDown'?1:-1)+opts.length)%opts.length;opts.forEach((o,i)=>o.setAttribute('aria-selected',i===sel));opts[sel].scrollIntoView({block:'nearest'})}
 else if(e.key==='Enter'&&sel>=0){e.preventDefault();pick(sel)}
 else if(e.key==='Escape'){sg.hidden=true}
});
sg.addEventListener('click',e=>{const b=e.target.closest('.sg');b&&pick(+b.dataset.i)});
$('#searchForm').addEventListener('submit',e=>{e.preventDefault();S.q=q.value.trim();sg.hidden=true;update();scrollToResults()});
function scrollToResults(){requestAnimationFrame(()=>{const y=$('#fbar').getBoundingClientRect().top+scrollY-hdrH()+2;scrollTo({top:y,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})})}
const hdrH=()=>{const h=$('.cv-header');return h?h.getBoundingClientRect().height:0};

/* ---------- clicks ---------- */
document.addEventListener('click',e=>{
 const t=e.target;
 if(pop&&!pop.el.contains(t)&&!t.closest('[data-f]'))closePop();
 if(!t.closest('#searchBox'))sg.hidden=true;
 let b;
 if(b=t.closest('[data-f]')){pop&&pop.btn.dataset.f===b.dataset.f?closePop():openPop(b);return}
 if(b=t.closest('[data-view]')){S.view=b.dataset.view;$$('[data-view]').forEach(x=>x.setAttribute('aria-pressed',x===b));renderShelves();renderResults();return}
 if(b=t.closest('.cat,.tile')){const k=b.dataset.cat;if(!k){S.category.clear()}else{S.category.has(k)&&b.classList.contains('cat')?S.category.delete(k):S.category.add(k)}update();if(b.classList.contains('tile'))scrollToResults();return}
 if(b=t.closest('[data-q]')){q.value=b.dataset.q;S.q=b.dataset.q;update();scrollToResults();return}
 if(b=t.closest('[data-quick]')){e.preventDefault();S.avail='online';update();scrollToResults();return}
 if(b=t.closest('[data-rm]')){const k=b.dataset.rm,v=b.dataset.v;if(k==='q'){S.q='';q.value=''}else if(k==='avail')S.avail='any';else if(k==='sort')S.sort='rec';else if(k==='price'){S.pmin='';S.pmax=''}else S[k].delete(v);update();return}
 if(t.closest('#clearAll')){Object.assign(S,{q:'',avail:'any',pmin:'',pmax:'',sort:'rec'});['platform','category','language','gender'].forEach(k=>S[k].clear());q.value='';update();return}
 if(b=t.closest('[data-rail]')){const r=$('#rail-'+b.dataset.rail);r&&r.scrollBy({left:+b.dataset.dir*r.clientWidth*.8,behavior:'smooth'});return}
 if(b=t.closest('[data-play]')){play(b);return}
 if(b=t.closest('[data-stop]')){b.closest('.state').remove();return}
 if(b=t.closest('[data-book]')){openBooking(b.dataset.book);return}
 if(b=t.closest('[data-invite]')){const on=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',on);b.textContent=on?'Request sent':'Ask them to join';const d=D.find(x=>x.id===b.dataset.invite);$$(`[data-asked="${d.id}"]`).forEach(a=>a.textContent=`${d.asks+(on?1:0)} fans asked so far${on?' · we\'ll tell you when they join':''}`);return}
 if(b=t.closest('#mMenu')){const nav=$('#nav'),o=nav.dataset.open!=='true';nav.dataset.open=o;b.setAttribute('aria-expanded',o);return}
 if(t.closest('#mSearch')){scrollTo({top:0,behavior:'smooth'});setTimeout(()=>q.focus(),300);return}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePop();closeBooking()}});
addEventListener('resize',closePop);addEventListener('scroll',()=>{if(pop){const r=pop.btn.getBoundingClientRect();pop.el.style.top=(r.bottom+10)+'px'}},{passive:true});

/* ---------- simulated official embed ---------- */
function play(btn){
 const vid=btn.closest('.vid'),id=btn.dataset.play,c=C.find(x=>x.id===id)||D.find(x=>x.id===id);
 const p=PLN[c.pl[0]];
 const st=document.createElement('div');st.className='state';st.innerHTML='<div class="spin" role="status" aria-label="Loading player"></div><span>Loading '+p+' player&hellip;</span>';
 vid.appendChild(st);
 setTimeout(()=>{
  if(c.video==='unavailable'){st.innerHTML=`<button class="x" type="button" data-stop aria-label="Close">${I.x}</button><img src="${IMG.unavailable}" alt=""><b>Video unavailable</b><span>This ${p} video was removed or made private. You can still book a call.</span>`;return}
  st.innerHTML=`<button class="x" type="button" data-stop aria-label="Close player">${I.x}</button><span style="width:56px;height:56px;display:grid;place-items:center;background:var(--paper);border-radius:14px">${PL[c.pl[0]].replace('<svg','<svg style="width:34px;height:34px"')}</span><b>Official ${p} player</b><span>@${esc(c.h)}&rsquo;s latest video plays here with ${p}&rsquo;s own controls and branding.</span>`;
 },900);
}

/* ---------- booking drawer ---------- */
const B={};let lastFocus=null;
const DAYS=(()=>{const d=new Date(),o=[];for(let i=0;i<5;i++){const x=new Date(d);x.setDate(d.getDate()+i);o.push([i,i===0?'Today':i===1?'Tomorrow':x.toLocaleDateString('en-IN',{weekday:'short'}),x.toLocaleDateString('en-IN',{day:'numeric',month:'short'})])}return o})();
const TIMES=['10:30 AM','12:00 PM','4:30 PM','7:00 PM','8:30 PM','9:30 PM'];
function openBooking(id){
 const c=C.find(x=>x.id===id);if(!c)return;closePop();lastFocus=document.activeElement;
 Object.assign(B,{c,step:1,mode:c.st==='online'?'now':'schedule',day:0,time:null,dur:10,pay:'wallet',done:false});
 drawBooking();
}
function closeBooking(){const r=$('#drawerRoot');if(r.hidden)return;r.hidden=true;r.innerHTML='';document.body.style.overflow='';lastFocus&&lastFocus.focus&&lastFocus.focus()}
function money(n){return '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2})}
function drawBooking(){
 const c=B.c,r=$('#drawerRoot');r.hidden=false;document.body.style.overflow='hidden';
 const sub=c.rate*B.dur,gst=Math.round(sub*.18*100)/100,tot=sub+gst;
 const stTxt={online:'Online now · usually picks up in 2 min',busy:'On another call · free in about 20 min',offline:'Offline · book a time below'}[c.st];
 const steps=['Call type','Duration','Pay'].map((s,i)=>`<span class="${B.step===i+1?'on':B.step>i+1||B.done?'done':''}"><i>${i+1}</i><b>${s}</b></span>`).join('');
 let body='',foot='';
 if(B.done){
  body=`<div class="done-art"><img src="${IMG.success}" alt="" width="640" height="640"><img class="stk" src="${IMG.stkDone}" alt="Ho gaya!"><h4>Booking confirmed!</h4><p>${B.mode==='now'?`We&rsquo;re ringing ${esc(c.name.split(' ')[0])} now. Your phone will ring from a private ${BRAND} number in a minute.`:`Your ${B.dur}-minute call with ${esc(c.name.split(' ')[0])} is set for ${DAYS[B.day][1]}, ${B.time}. We&rsquo;ll remind you 15 minutes before.`}</p><p style="color:var(--muted);font-size:var(--fs-small)">Demo only. No payment was taken.</p></div>`;
  foot=`<button class="book" type="button" id="bkDone">Back to exploring</button>`;
 } else if(B.step===1){
  body=`<div class="avail"><span class="status ${c.st}"><i></i>${{online:'Online',busy:'Busy',offline:'Offline'}[c.st]}</span><span style="font-size:var(--fs-small);color:var(--muted)">${stTxt}</span></div>
  <h4>How do you want to talk?</h4>
  <div class="choice">
   <button class="opt-card" type="button" data-mode="now" aria-pressed="${B.mode==='now'}" ${c.st!=='online'?'disabled':''}>${I.bolt}<b>Call now</b><span>${c.st==='online'?'Connect in a couple of minutes':'Available when they&rsquo;re online'}</span></button>
   <button class="opt-card" type="button" data-mode="schedule" aria-pressed="${B.mode==='schedule'}">${I.cal}<b>Schedule</b><span>Pick a day and time</span></button>
  </div>
  ${B.mode==='schedule'?`<div class="lbl2">Day</div><div class="days">${DAYS.map(([i,d,dt])=>`<button class="seg" type="button" data-day="${i}" aria-pressed="${B.day===i}">${d}<small>${dt}</small></button>`).join('')}</div>
  <div class="lbl2">Free slots (IST)</div><div class="times">${TIMES.map((t,i)=>`<button class="seg" type="button" data-time="${t}" aria-pressed="${B.time===t}" ${(i+B.day)%4===1?'disabled style="opacity:.4;text-decoration:line-through"':''}>${t}</button>`).join('')}</div>`:''}`;
  foot=`<button class="book" type="button" id="bkNext" ${B.mode==='schedule'&&!B.time?'disabled style="opacity:.5;cursor:not-allowed"':''}>Next: duration</button>`;
 } else if(B.step===2){
  body=`<h4>How long?</h4><div class="durs">${[5,10,15,30].map(m=>`<button class="seg" type="button" data-dur="${m}" aria-pressed="${B.dur===m}">${m} min<small>${money(c.rate*m)}</small></button>`).join('')}</div>
  <div class="bill"><div><span>${money(c.rate)}/min &times; ${B.dur} min</span><span>${money(sub)}</span></div><div><span>GST (18%)</span><span>${money(gst)}</span></div><div class="tot"><span>Total</span><span>${money(tot)}</span></div></div>
  <div class="terms"><b>Before you pay:</b> ${B.mode==='now'?'If the creator doesn&rsquo;t pick up within 3 minutes, the full amount goes back to your wallet.':'Cancel free up to 2 hours before the call. Later cancellations are not refunded.'} Unused minutes are not carried over. <i>(Placeholder terms, to be wired to the Refunds policy.)</i></div>`;
  foot=`<button class="back" type="button" id="bkBack">Back</button><button class="book" type="button" id="bkNext">Next: pay ${money(tot)}</button>`;
 } else {
  body=`<h4>Confirm &amp; pay</h4>
  <div class="bill"><div><span>${B.mode==='now'?'Call now':`${DAYS[B.day][1]}, ${DAYS[B.day][2]} &middot; ${B.time}`}</span><span>${B.dur} min</span></div><div><span>Call charges</span><span>${money(sub)}</span></div><div><span>GST (18%)</span><span>${money(gst)}</span></div><div class="tot"><span>Total</span><span>${money(tot)}</span></div></div>
  <div class="pay"><div class="lbl2">Pay with</div>
   <label><input type="radio" name="pay" value="wallet" ${B.pay==='wallet'?'checked':''}>${BRAND} wallet<span class="cnt">Balance ₹480</span></label>
   <label><input type="radio" name="pay" value="upi" ${B.pay==='upi'?'checked':''}>UPI (any app)<span class="cnt">via Cashfree</span></label>
  </div>
  <div class="terms">Both phone numbers stay private. No one listens in. Press # any time to end the call and block.</div>`;
  foot=`<button class="back" type="button" id="bkBack">Back</button><button class="skin-btn" type="button" id="bkPay">${I.phone}Pay ${money(tot)} &amp; book</button>`;
 }
 r.innerHTML=`<div class="xp-scrim" id="bkScrim"></div><aside class="xp-drawer" role="dialog" aria-modal="true" aria-labelledby="bkT">
  <div class="dh"><span class="av">${smallImg(c)}</span><div style="min-width:0"><h3 id="bkT">Call ${esc(c.name)}</h3><div class="handle" style="margin:2px 0 0">@${esc(c.h)} &middot; ${money(c.rate)}/min</div></div><button class="x" type="button" id="bkX" aria-label="Close booking">${I.x}</button></div>
  ${B.done?'':`<div class="steps">${steps}</div>`}
  <div class="db">${body}</div><div class="df">${foot}</div></aside>`;
 const dr=$('.xp-drawer',r);
 dr.addEventListener('click',e=>{const t=e.target;let b;
  if(b=t.closest('[data-mode]')){B.mode=b.dataset.mode;drawBooking()}
  else if(b=t.closest('[data-day]')){B.day=+b.dataset.day;B.time=null;drawBooking()}
  else if(b=t.closest('[data-time]')){B.time=b.dataset.time;drawBooking()}
  else if(b=t.closest('[data-dur]')){B.dur=+b.dataset.dur;drawBooking()}
  else if(t.closest('#bkNext')){if(B.mode==='schedule'&&!B.time&&B.step===1)return;B.step++;drawBooking()}
  else if(t.closest('#bkBack')){B.step--;drawBooking()}
  else if(t.closest('#bkPay')){B.done=true;drawBooking()}
  else if(t.closest('#bkX,#bkDone'))closeBooking();
 });
 dr.addEventListener('change',e=>{if(e.target.name==='pay')B.pay=e.target.value});
 $('#bkScrim').addEventListener('click',closeBooking);
 ($('.db button:not([disabled])',dr)||$('#bkX'))?.focus({preventScroll:true});
}

/* sticky offset follows the real header height */
const setH=()=>ROOT.style.setProperty('--hdr',hdrH()+'px');
const hdr=$('.cv-header');if(hdr)new ResizeObserver(setH).observe(hdr);setH();

/* live-ish online counter */
setInterval(()=>{const el=$('#onlineCt');if(el)el.textContent=300+Math.floor(Math.random()*30)},4000);

renderAll();

}
