#!/usr/bin/env python3
"""Saa Thum legal-page mockups (2026-09-27). Landing/folk tokens, die-cut Hindu stickers.
Emits 5 artifact pages (no doctype/html/head/body — the Artifact tool adds the skeleton)
plus a shared .src.html template for the later exact-replica build."""
import base64, io, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, 'img')
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)

def data_uri(name, width=640, q=80):
    im = Image.open(os.path.join(IMG, name)).convert('RGBA')
    if im.width > width:
        im.thumbnail((width, width * 4))
    b = io.BytesIO(); im.save(b, 'WEBP', quality=q, method=6)
    return 'data:image/webp;base64,' + base64.b64encode(b.getvalue()).decode()

I = {
    'lotus': data_uri('br-lotus.png', 128),
    'border': data_uri('br-border.png', 640, 85),
    'namaste': data_uri('hw-namaste.png', 480),
    'ontime': data_uri('hw-ontime.png', 420),
    'link': data_uri('hw-link.png', 420),
    'elephant': data_uri('elephant.png', 520),
    'ganesh': data_uri('br-ganesh.png', 420),
    'diya': data_uri('diya.png', 160),
    'contact': data_uri('st-contact.png', 640),
    'refunds': data_uri('st-refunds.png', 640),
    'privacy': data_uri('st-privacy.png', 640),
    'terms': data_uri('st-terms.png', 640),
    'cookies': data_uri('st-cookies.png', 640),
}

CSS = """
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;500;600;700&family=Nunito:wght@400;600;700;800;900&display=swap">
<style>
/* Saa Thum — legal & contact pages redesign mockup (2026-09-27). Landing tokens, sticker style.
   Single light theme by design (the site is cream-only). Type floor: 17px desktop, 16px phone. */
:root {
  --cream: #fff8e8; --paper: #fffaf0; --teal: #07545b; --ink: #17343c; --red: #c82c25;
  --sage: #dfe7d0; --gold: #d1ae70; --gold-hair: #d1ae7066; --terra: #A54C2E; --marigold: #F6B93B;
  --quiet: #937751; --body: #35494c; --plum-a: #3d2138; --plum-b: #2b2344;
  --gutter: clamp(20px, 2.4vw, 44px); --box: 1280px;
  --border-url: url("{{IMG_border}}");
  color-scheme: light;
}
html, body { margin: 0; background: var(--cream); }
body { color: var(--ink); font: 19px/1.55 'Nunito', system-ui, sans-serif; overflow-x: clip; -webkit-font-smoothing: antialiased; }
*, *::before, *::after { box-sizing: border-box; }
a { color: inherit; text-underline-offset: 4px; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--red); outline-offset: 3px; }
h1, h2, h3 { font-family: 'Comfortaa', system-ui, sans-serif; font-weight: 700; letter-spacing: -.045em; line-height: 1.16; margin: 0; color: var(--teal); text-wrap: balance; }
h1 { font-size: clamp(38px, 4vw, 62px); }
h2 { font-size: clamp(25px, 2vw, 34px); }
h3 { font-size: clamp(21px, 1.5vw, 25px); }
p { margin: 0; }
em { color: var(--red); font-style: normal; }
img { max-width: 100%; }
code { font: 700 .92em 'Nunito', monospace; background: #fff; border: 1px solid var(--gold-hair); border-radius: 6px; padding: 1px 7px; color: var(--teal); }
.wrap { max-width: var(--box); margin: auto; padding-inline: var(--gutter); }
@media (min-width: 1800px) { :root { --box: 1480px; } }
.ribbon { height: 25px; background-color: var(--gold); background-image: var(--border-url); background-repeat: repeat-x; background-position: center; background-size: auto 76px; border-block: 1px solid var(--gold); }
.eyebrow { font-size: 15px; font-weight: 900; letter-spacing: .16em; line-height: 1.4; color: var(--teal); text-transform: uppercase; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 12px; background: var(--red); color: #fff; text-decoration: none; padding: 16px 26px; border: 1px solid #a9211a; border-radius: 10px; font: 800 19px/1.25 'Nunito', sans-serif; cursor: pointer; }
.btn:hover { background: #ac241e; }
.btn--ghost { background: transparent; color: var(--teal); border: 2px solid var(--teal); }
.btn--ghost:hover { background: var(--teal); color: #fff; }
.btn--paper { background: var(--paper); color: var(--teal); border: 2px solid var(--paper); }
.btn--paper:hover { background: #fff; }

/* header (live landing chrome) */
.hdr { background: var(--cream); }
.hdr-bar { max-width: 1840px; margin: auto; padding: 12px var(--gutter); display: flex; align-items: center; gap: 20px; }
.logo { display: flex; align-items: center; gap: 10px; text-decoration: none; flex: 0 0 auto; }
.logo img { width: 46px; height: 46px; display: block; }
.logo b { font-family: 'Comfortaa', sans-serif; font-size: 32px; font-weight: 700; color: var(--teal); letter-spacing: -.02em; }
.nav { flex: 1; display: flex; justify-content: center; gap: 22px; font-size: 17px; font-weight: 700; }
.nav a { text-decoration: none; padding: 8px 4px; }
.nav a[aria-current] { color: var(--red); text-decoration: underline; text-decoration-thickness: 3px; }
.hdr-cta { display: flex; align-items: center; gap: 14px; font-size: 17px; font-weight: 700; }
.hdr-cta a { text-decoration: none; }
.hdr-cta .solid { background: var(--red); color: #fff; border-radius: 4px; padding: 12px 16px; }
.burger { display: none; width: 44px; height: 44px; border: 0; background: transparent; border-radius: 8px; color: var(--teal); }
.burger svg { width: 28px; height: 28px; }

/* hero — cream, the page's die-cut sticker on the right with one small stamp */
.hero { padding-block: 26px 34px; }
.hero-inner { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 40px; align-items: center; }
.hero h1 { margin-top: 12px; }
.hero .lead { margin-top: 18px; font-size: clamp(20px, 1.4vw, 23px); line-height: 1.45; max-width: 32em; color: #2b4046; }
.hero-meta { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; margin-top: 24px; }
.pill { display: inline-flex; align-items: center; gap: 8px; background: var(--marigold); color: var(--ink); border-radius: 999px; padding: 8px 16px; font-size: 16px; font-weight: 900; letter-spacing: .04em; text-transform: uppercase; }
.pill .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--red); }
.hero-meta .link { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; font-size: 18px; color: var(--teal); }
.hero-art { position: relative; display: grid; place-items: center; padding: 10px 20px; }
.hero-art::before { content: ""; position: absolute; inset: 8% 6%; border-radius: 50%; background: radial-gradient(closest-side, #f6b93b55, #f6b93b00 75%); }
.hero-art .sticker { position: relative; width: min(100%, 440px); height: auto; filter: drop-shadow(0 12px 16px #17343c33); }
.hero-art .stamp { position: absolute; width: 140px; height: auto; filter: drop-shadow(0 6px 8px #17343c33); right: 4px; bottom: 6px; transform: rotate(8deg); }

/* body — sticky "On this page" rail + white article card */
.body { padding-block: 40px 44px; }
.body-inner { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 34px; align-items: start; }
.rail { position: sticky; top: 18px; display: grid; gap: 16px; }
.toc { background: var(--sage); border: 4px solid #fff; border-radius: 16px; box-shadow: 0 6px 18px #17343c14; padding: 20px 20px 22px; }
.toc b { display: block; font-size: 15px; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; color: var(--teal); margin-bottom: 10px; }
.toc ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; counter-reset: t; }
.toc li { counter-increment: t; }
.toc a { display: grid; grid-template-columns: 30px 1fr; gap: 6px; align-items: baseline; text-decoration: none; font-size: 17px; font-weight: 700; color: var(--ink); padding: 6px 8px; border-radius: 8px; }
.toc a::before { content: counter(t, decimal-leading-zero); font-size: 14px; font-weight: 900; color: var(--red); letter-spacing: .04em; }
.toc a:hover, .toc a[aria-current] { background: #fff; color: var(--teal); }
.rail-card { background: #fff; border: 4px solid #fff; border-radius: 16px; box-shadow: 0 6px 18px #17343c14; padding: 18px 20px 20px; display: grid; grid-template-columns: 1fr 76px; gap: 14px; align-items: start; }
.rail-card img { width: 76px; height: auto; filter: drop-shadow(0 4px 5px #17343c26); }
.rail-card b { display: block; font-size: 18px; color: var(--teal); }
.rail-card span { font-size: 16.5px; color: var(--body); line-height: 1.45; display: block; margin-top: 4px; }
.rail-card a { color: var(--teal); font-weight: 800; }
.article { background: #fff; border: 5px solid #fff; border-radius: 22px; box-shadow: 0 10px 26px #17343c1a; padding: clamp(22px, 3vw, 44px) clamp(20px, 3.4vw, 52px) clamp(28px, 3vw, 46px); }
.prose > * + * { margin-top: 18px; }
.prose p, .prose li { font-size: 19px; line-height: 1.6; color: var(--body); max-width: 68ch; }
.prose strong { color: var(--ink); }
.prose a { color: var(--teal); font-weight: 800; }
.prose h2 { padding-top: 26px; margin-top: 30px; border-top: 1px solid var(--gold-hair); scroll-margin-top: 20px; display: flex; gap: 12px; align-items: baseline; }
.prose h2:first-child { padding-top: 0; margin-top: 0; border-top: 0; }
.prose h2 .n { color: var(--red); font-size: .72em; font-weight: 700; flex: 0 0 auto; }
.prose ul, .prose ol { padding-left: 1.3em; display: grid; gap: 10px; }
.prose ul li::marker { color: var(--red); }
.prose ol li::marker { color: var(--red); font-weight: 900; }
.prose .note { background: #fff5d6; border: 3px solid #fff; border-radius: 16px; box-shadow: 0 6px 18px #17343c14, inset 0 0 0 1px var(--marigold); padding: 20px 22px; display: grid; grid-template-columns: 1fr 120px; gap: 18px; align-items: center; }
.prose .note p { max-width: none; }
.prose .note p + p { margin-top: 12px; }
.prose .note img { width: 120px; height: auto; filter: drop-shadow(0 5px 6px #17343c26); }
.prose .note.note--plain { grid-template-columns: 1fr; }
.prose .note .tag { display: inline-block; font-size: 14px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; color: #fff; background: var(--terra); padding: 5px 11px; border-radius: 999px; margin-bottom: 10px; }
.tablewrap { overflow-x: auto; border-radius: 14px; border: 1px solid var(--gold-hair); }
.prose table { width: 100%; border-collapse: collapse; font-size: 18px; min-width: 520px; }
.prose th { text-align: left; background: var(--teal); color: #fff; font-weight: 900; letter-spacing: .06em; text-transform: uppercase; font-size: 15px; padding: 14px 18px; }
.prose td { padding: 14px 18px; border-top: 1px solid var(--gold-hair); vertical-align: top; color: var(--body); line-height: 1.5; }
.prose td strong { color: var(--teal); font-size: 18px; }
.prose tr:nth-child(even) td { background: var(--paper); }

/* closing band — terracotta, namaste sticker */
.ask { position: relative; padding-block: 44px 50px; z-index: 0; color: var(--paper); }
.ask::before { content: ""; position: absolute; inset: 0 50% 0; width: 100vw; transform: translateX(-50%); background: var(--terra); z-index: -1; }
.ask-inner { display: grid; grid-template-columns: 170px 1fr auto; gap: 30px; align-items: center; }
.ask img { width: 170px; height: auto; filter: drop-shadow(0 8px 10px #3a140a55); }
.ask h2 { color: var(--paper); }
.ask h2 span { color: var(--marigold); }
.ask p { margin-top: 10px; font-size: 19px; color: #f6e7d3; max-width: 52ch; }
.ask-actions { display: flex; flex-wrap: wrap; gap: 14px; }

/* contact page */
.contact { padding-block: 40px 48px; }
.contact-inner { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, .75fr); gap: 34px; align-items: start; }
.cform { background: #fff; border: 5px solid #fff; border-radius: 22px; box-shadow: 0 10px 26px #17343c1a; padding: clamp(22px, 3vw, 40px); display: flex; flex-direction: column; gap: 20px; }
.cform .intro { font-size: 19px; color: var(--body); }
.cform .intro a { color: var(--teal); font-weight: 800; }
.cform .row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.cform label { display: flex; flex-direction: column; gap: 8px; font-weight: 800; color: var(--teal); font-size: 17px; }
.cform input, .cform textarea, .cform select { width: 100%; font: 600 18px/1.4 'Nunito', sans-serif; color: var(--ink); background: var(--paper); border: 2px solid var(--gold); border-radius: 12px; padding: 14px 16px; outline: none; }
.cform input:focus, .cform textarea:focus, .cform select:focus { border-color: var(--teal); background: #fff; box-shadow: 0 0 0 4px #07545b1f; outline: none; }
.cform textarea { resize: vertical; }
.cform .honeypot { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
.cform .btn { align-self: flex-start; }
.cstatus { font-weight: 800; margin: 0; min-height: 1.2em; }
.delivery-note { font-size: 16px; color: var(--quiet); }
.side { display: grid; gap: 18px; }
.side-card { --tc: var(--teal); background: #fff; border: 5px solid #fff; border-radius: 16px; box-shadow: 0 8px 22px #17343c14; padding: 20px 22px 22px; display: grid; grid-template-columns: 1fr 120px; gap: 16px; align-items: center; border-bottom: 8px solid var(--tc); }
.side-card img { width: 120px; height: auto; filter: drop-shadow(0 5px 6px #17343c26); }
.side-card .tag { justify-self: start; font-size: 14px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; color: #fff; background: var(--tc); padding: 5px 11px; border-radius: 999px; margin-bottom: 8px; }
.side-card h3 { color: var(--tc); }
.side-card p { margin-top: 6px; font-size: 17.5px; line-height: 1.5; color: var(--body); }
.side-card p strong { color: var(--ink); font-size: 19px; }
.side-card a { color: var(--tc); font-weight: 800; }
.side-card--red { --tc: var(--red); } .side-card--terra { --tc: var(--terra); } .side-card--plum { --tc: var(--plum-a); }

/* footer (live landing chrome) */
.ftr { background: var(--cream); color: var(--ink); border-top: 2px solid var(--gold-hair); margin-top: 10px; }
.ftr-main { max-width: 1840px; margin: auto; padding: 34px var(--gutter) 18px; text-align: center; }
.ftr-logo { display: flex; justify-content: center; align-items: center; gap: 10px; margin: 0 0 14px; }
.ftr-logo img { width: 64px; height: 64px; }
.ftr-logo b { color: var(--teal); font: 700 42px/1.2 'Comfortaa', sans-serif; letter-spacing: -.02em; }
.ftr-tag { font-size: 17px; line-height: 1.5; max-width: 30ch; margin: auto; }
.ftr-cols { display: flex; justify-content: center; flex-wrap: wrap; gap: 28px 44px; max-width: 1320px; margin: 30px auto 8px; }
.ftr-col { flex: 1 1 320px; display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; column-gap: 18px; }
.ftr-col b { flex: 0 0 100%; color: var(--teal); font: 800 18px/1.4 'Nunito', sans-serif; margin-bottom: 9px; }
.ftr-col a { font-size: 17px; font-weight: 600; line-height: 1.35; padding: 3px 0; }
.ftr-bottom { display: flex; justify-content: center; flex-wrap: wrap; gap: 10px 22px; padding: 20px var(--gutter) 27px; font-size: 16px; text-align: center; }
.ftr::after { content: ""; display: block; width: 100%; height: 25px; background-color: var(--gold); background-image: var(--border-url); background-repeat: repeat-x; background-position: center; background-size: auto 76px; }

@media (max-width: 1100px) {
  .nav { display: none; } .burger { display: grid; place-items: center; margin-left: auto; } .hdr-cta a:not(.solid) { display: none; }
  .hero-inner { grid-template-columns: 1fr; gap: 20px; }
  .hero-art { max-width: 420px; margin: 10px auto 0; width: 100%; order: -1; }
  .hero-art .sticker { width: min(100%, 320px); }
  .hero-art .stamp { width: 110px; }
  .body-inner { grid-template-columns: 1fr; }
  .rail { position: static; grid-template-columns: 1fr 1fr; }
  .contact-inner { grid-template-columns: 1fr; }
  .ask-inner { grid-template-columns: 130px 1fr; }
  .ask-actions { grid-column: 1 / -1; }
}
@media (max-width: 640px) {
  :root { --gutter: 16px; }
  body { font-size: 18px; }
  .prose p, .prose li, .cform .intro { font-size: 18px; }
  .ribbon, .ftr::after { height: 18px; background-size: auto 60px; }
  .logo b { font-size: 28px; } .logo img { width: 40px; height: 40px; } .hdr-bar { padding: 10px 16px; gap: 12px; }
  .rail { grid-template-columns: 1fr; }
  .article { border-radius: 16px; }
  .prose .note { grid-template-columns: 1fr; } .prose .note img { width: 100px; justify-self: center; order: -1; }
  .cform .row { grid-template-columns: 1fr; }
  .cform .btn { align-self: stretch; }
  .side-card { grid-template-columns: 1fr 96px; } .side-card img { width: 96px; }
  .ask-inner { grid-template-columns: 1fr; text-align: center; } .ask img { margin: auto; width: 130px; } .ask-actions { justify-content: center; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
"""

HEADER = """
<header class="hdr">
  <div class="hdr-bar">
    <a class="logo" href="#" aria-label="Saa Thum home"><img src="{{IMG_lotus}}" alt="" width="46" height="46"><b>Saa Thum</b></a>
    <nav class="nav" aria-label="Main"><a href="#">Home</a><a href="#">Explore</a><a href="#">How it works</a><a href="#">Help centre</a></nav>
    <div class="hdr-cta"><a href="#">Sign in</a><a class="solid" href="#">Book a puja</a></div>
    <button class="burger" type="button" aria-label="Open menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
  </div>
</header>
"""

FOOTER = """
<footer class="ftr">
  <div class="ftr-main">
    <div class="ftr-logo"><img src="{{IMG_lotus}}" alt="" width="64" height="64"><b>Saa Thum</b></div>
    <p class="ftr-tag">Faith, brought home to you.</p>
    <div class="ftr-cols">
      <div class="ftr-col"><b>Rituals</b><a href="#">All pujas</a><a href="#">All havans</a><a href="#">By intention</a><a href="#">Festival pujas</a></div>
      <div class="ftr-col"><b>Company</b><a href="#">How it works</a><a href="#">Help centre</a><a href="#">Contact</a></div>
      <div class="ftr-col"><b>Trust</b><a href="#">Refund policy</a><a href="#">Privacy</a><a href="#">Terms</a><a href="#">Cookies</a></div>
    </div>
  </div>
  <div class="ftr-bottom"><span>Made in India with Love ❤️ and cutting chai.</span><span>© 2026 SAA THUM · Performed with devotion in India.</span></div>
</footer>
"""

ASK = """
  <section class="ask" aria-labelledby="ask-title">
    <div class="wrap ask-inner">
      <img src="{{IMG_namaste}}" alt="" aria-hidden="true">
      <div>
        <h2 id="ask-title">Still have a question? <span>We are a namaste away.</span></h2>
        <p>Write to support (@) saathum.com, or read the plain-English version of every policy in the Help centre.</p>
      </div>
      <div class="ask-actions"><a class="btn btn--paper" href="#">Contact us</a><a class="btn btn--paper" href="#">Help centre</a></div>
    </div>
  </section>
"""

def hero(eyebrow, title, lead, sticker, stamp, meta_html, alt):
    return f"""
  <section class="hero wrap" aria-labelledby="page-title">
    <div class="hero-inner">
      <div>
        <p class="eyebrow">{eyebrow}</p>
        <h1 id="page-title">{title}</h1>
        <p class="lead">{lead}</p>
        <div class="hero-meta">{meta_html}</div>
      </div>
      <div class="hero-art">
        <img class="sticker" src="{{{{IMG_{sticker}}}}}" alt="{alt}">
        <img class="stamp" src="{{{{IMG_{stamp}}}}}" alt="" aria-hidden="true">
      </div>
    </div>
  </section>
  <div class="ribbon" aria-hidden="true"></div>
"""

def updated(d): return f'<span class="pill"><span class="dot"></span>Last updated {d}</span>'

def legal_page(slug, title_tag, eyebrow, h1, lead, sticker, stamp, meta, alt, toc, rail_card, prose):
    toc_html = ''.join(f'<li><a href="#{i}">{t}</a></li>' for i, t in toc)
    return (f"<title>{title_tag}</title>" + CSS + HEADER + "<main>" +
        hero(eyebrow, h1, lead, sticker, stamp, meta, alt) + f"""
  <section class="body wrap">
    <div class="body-inner">
      <aside class="rail">
        <nav class="toc" aria-label="On this page"><b>On this page</b><ol>{toc_html}</ol></nav>
        {rail_card}
      </aside>
      <article class="article"><div class="prose">
{prose}
      </div></article>
    </div>
  </section>
""" + ASK + "</main>" + FOOTER)

def h2(i, n, t): return f'<h2 id="{i}"><span class="n">{n}</span>{t}</h2>'

# ---------------------------------------------------------------- REFUNDS
refunds_toc = [('price','What you see is what you pay'),('cancel','Cancelling your booking'),('request','How to request a refund'),('refund-paid','How your refund is paid'),('we-cancel',"If we cancel or can't perform your ritual"),('missed','If you miss the live stream'),('disputes','Wrong or duplicate payments'),('rights','Your rights')]
refunds_prose = f"""
  <p>This policy explains how cancellations and refunds work for pujas and havans you book on Saa Thum. It sits alongside our <a href="#">Terms of Service</a>.</p>
  {h2('price','1.','What you see is what you pay')}
  <p>The price shown on a ritual is the full price you pay. There are no tokens, wallets, credits or extra charges added at checkout.</p>
  {h2('cancel','2.','Cancelling your booking')}
  <div class="note"><div><span class="tag">The 24-hour rule</span><p><strong>Cancel at least 24 hours before the scheduled start</strong> of your puja or havan and you get a full refund of the amount you paid.</p></div><img src="{{{{IMG_ontime}}}}" alt="" aria-hidden="true"></div>
  <p>Cancellations made less than 24 hours before the scheduled start are not refunded, because our priests have already prepared your ritual and your sankalp.</p>
  {h2('request','3.','How to request a refund')}
  <p>Refunds are not automatic — you need to send us a request. Email support (@) saathum.com or use our <a href="#">contact form</a> and include:</p>
  <ol>
    <li>Your full name, and the email or phone number you booked with.</li>
    <li>The ritual you booked and its scheduled date and time.</li>
    <li><strong>Your 12-digit UPI transaction number</strong> (also called the UTR or UPI reference number) for the payment.</li>
  </ol>
  <p>The UPI transaction number is how we locate your payment, so we can't process a refund without it. You'll find it in your UPI app (Google Pay, PhonePe, Paytm, BHIM or your bank's app) by opening the payment in your transaction history, and in your bank's payment SMS.</p>
  {h2('refund-paid','4.','How your refund is paid')}
  <p>Once we've located your payment and confirmed your cancellation was made at least 24 hours before the scheduled start, we refund the full amount to the UPI account you paid from. We'll let you know by email when the refund has been sent.</p>
  {h2('we-cancel','5.',"If we cancel or can't perform your ritual")}
  <p>If we cancel your puja or havan, or can't perform it, you get a full refund. Send us a request the same way, with your 12-digit UPI transaction number, and we'll refund you.</p>
  {h2('missed','6.','If you miss the live stream')}
  <p>Your sankalp is still performed at the altar, so a booking you miss watching is not refunded. The replay is available for 7 days.</p>
  {h2('disputes','7.','Wrong or duplicate payments')}
  <p>If you think you were charged by mistake or paid twice, email support (@) saathum.com with the 12-digit UPI transaction number for each payment. Please contact us before raising a dispute with your bank — it's faster, and we'll sort it out directly.</p>
  {h2('rights','8.','Your rights')}
  <p>Nothing in this policy limits any rights you have under applicable consumer protection law.</p>
"""
refunds_rail = '<div class="rail-card"><div><b>Keep your UTR handy</b><span>The 12-digit UPI transaction number is how we find your payment. <a href="#">Read the help centre</a></span></div><img src="{{IMG_link}}" alt="" aria-hidden="true"></div>'
PAGES = {}
PAGES['refunds'] = legal_page('refunds', 'Saa Thum Refunds', 'Legal', 'Refunds &amp; <em>Cancellations</em>',
    'What you see is what you pay. Cancel at least 24 hours before your ritual and we refund you in full.',
    'refunds', 'ontime', updated('September 25, 2026') + '<a class="link" href="#">Read the plain-English version in the Help centre <span aria-hidden="true">→</span></a>',
    'A brass bowl of coins with a scroll and a lotus — refunds.', refunds_toc, refunds_rail, refunds_prose)

# ---------------------------------------------------------------- COOKIES
cookies_toc = [('what','What are cookies?'),('how','How we use cookies'),('manage','Managing cookies'),('third','Third-party cookies'),('changes','Changes'),('contact','Contact')]
cookies_prose = f"""
  <p>This Cookie Policy explains how <strong>Saa Thum</strong> uses cookies and similar technologies on the Saa Thum Services. It supplements our <a href="#">Privacy Policy</a>.</p>
  {h2('what','1.','What are cookies?')}
  <p>Cookies are small text files stored on your device when you visit a website. We also use related technologies such as local storage, pixels, and SDKs. We refer to all of these as "cookies".</p>
  {h2('how','2.','How we use cookies')}
  <div class="tablewrap"><table>
    <thead><tr><th>Type</th><th>Purpose</th></tr></thead>
    <tbody>
      <tr><td><strong>Essential</strong></td><td>Required for the Services to work — sign-in, sessions, security, and load balancing. These can't be switched off.</td></tr>
      <tr><td><strong>Preferences</strong></td><td>Remember your settings, such as language or display choices.</td></tr>
      <tr><td><strong>Analytics</strong></td><td>Help us understand how the Services are used so we can improve them. We use privacy-respecting analytics.</td></tr>
      <tr><td><strong>Functional</strong></td><td>Enable enhanced features and integrations, such as payments and embedded media.</td></tr>
    </tbody>
  </table></div>
  {h2('manage','3.','Managing cookies')}
  <p>You can control cookies through your browser settings — most browsers let you block or delete cookies. Note that blocking some cookies may affect how the Services function. Where required, we will ask for your consent before setting non-essential cookies.</p>
  {h2('third','4.','Third-party cookies')}
  <p>Some cookies are set by third parties that provide services to us, such as analytics and payment providers. Their use of cookies is governed by their own policies.</p>
  {h2('changes','5.','Changes')}
  <p>We may update this Cookie Policy from time to time. The "Last updated" date above shows when it was last revised.</p>
  {h2('contact','6.','Contact')}
  <p>Questions about cookies? Email support (@) saathum.com or visit our <a href="#">contact page</a>.</p>
"""
cookies_rail = '<div class="rail-card"><div><b>Only the essentials</b><span>Sign-in and security cookies can\'t be switched off; everything else is your choice.</span></div><img src="{{IMG_diya}}" alt="" aria-hidden="true"></div>'
PAGES['cookies'] = legal_page('cookies', 'Saa Thum Cookies', 'Legal', 'Cookie <em>Policy</em>',
    'How Saa Thum uses cookies and similar technologies, and how to control them.',
    'cookies', 'elephant', updated('August 28, 2026'),
    'A brass mithai box with sweets, a lotus and a cup — the cookies page.', cookies_toc, cookies_rail, cookies_prose)

# ---------------------------------------------------------------- TERMS
terms_toc = [('status','Who we are, and where we are in our journey'),('eligibility','Eligibility & accounts'),('content','Your content'),('use','Acceptable use'),('payments','Payments, payouts & fees'),('ai','Artificial intelligence — important disclaimer'),('third','Third-party services'),('ip','Intellectual property'),('termination','Termination'),('disclaimers','Disclaimers'),('liability','Limitation of liability'),('indemnification','Indemnification'),('law','Governing law'),('changes','Changes'),('contact','Contact')]
terms_prose = f"""
  <p>These Terms of Service ("Terms") govern your access to and use of the Saa Thum websites, apps, and services (the "Services"), provided by the Saa Thum founding team ("Saa Thum", "we", "us", or "our"). By using the Services, you agree to these Terms. If you do not agree, do not use the Services.</p>
  {h2('status','1.','Who we are, and where we are in our journey')}
  <p>Because we are early, please read section 10 (Disclaimers) and section 11 (Limitation of liability) carefully. Saa Thum is offered on a trial basis to invited users and you should not rely on it for anything critical.</p>
  {h2('eligibility','2.','Eligibility &amp; accounts')}
  <p>You must be able to form a binding contract and meet any minimum age requirements in your jurisdiction. You are responsible for your account, for keeping your credentials secure, and for all activity under your account.</p>
  {h2('content','3.','Your content')}
  <p>You retain ownership of the content you create or upload. You grant us a limited, worldwide, non-exclusive license to host, store, reproduce, and display your content solely to operate and improve the Services. You are responsible for your content and confirm you have the rights to share it.</p>
  {h2('use','4.','Acceptable use')}
  <p>You agree not to misuse the Services — including no illegal activity, harassment, infringement, spam, malware, or attempts to disrupt or reverse-engineer the Services.</p>
  {h2('payments','5.','Payments, payouts &amp; fees')}
  <p>Some features let you earn or spend money. Payments and payouts are handled by third-party processors subject to their terms. Applicable fees, revenue shares, and taxes are your responsibility where required by law. We may change pricing with notice.</p>
  <p><strong>Payments and payouts may be limited by product availability.</strong> Payment and payout flows on Saa Thum are in test and available only to invited users. Amounts, fees and token values shown during this period are indicative. If a payment is taken from you in error during testing, tell us at support (@) saathum.com and we will return it. See our <a href="#">Refunds &amp; Cancellations</a> policy.</p>
  {h2('ai','6.','Artificial intelligence — important disclaimer')}
  <div class="note"><div><span class="tag">Please read</span><p>Saa Thum is an AI-centric product, and some features and content are generated or assisted by artificial intelligence. <strong>AI can make mistakes.</strong> AI-generated outputs may be inaccurate, incomplete, outdated, or otherwise unreliable, and <strong>Saa Thum is not responsible or liable</strong> for decisions you make based on them. Always use your own judgment and verify important information independently.</p>
  <p>We have made our best efforts to use imagery generated by AI responsibly. If you come across any image or content on Saa Thum that you find objectionable, please tell us at support (@) saathum.com and we will review and remove it. Any such inclusion was not intentional.</p></div><img src="{{{{IMG_ganesh}}}}" alt="" aria-hidden="true"></div>
  {h2('third','7.','Third-party services')}
  <p>The Services may link to or integrate third-party products. We are not responsible for third-party services, and your use of them is governed by their own terms.</p>
  {h2('ip','8.','Intellectual property')}
  <p>The Services, including software, design, and trademarks, are owned by Saa Thum or its licensors and protected by law. These Terms do not grant you rights to our branding except as needed to use the Services.</p>
  {h2('termination','9.','Termination')}
  <p>You may stop using the Services at any time. We may suspend or terminate access if you violate these Terms or to protect the Services and our community. Some provisions survive termination.</p>
  {h2('disclaimers','10.','Disclaimers')}
  <p>The Services are provided "as is" and "as available" without warranties of any kind, to the fullest extent permitted by law. We do not warrant that the Services will be uninterrupted, error-free, or secure. Saa Thum is an evolving product and is being tested: features may break, change or be withdrawn, and test data may be reset.</p>
  {h2('liability','11.','Limitation of liability')}
  <p>To the maximum extent permitted by law, Saa Thum, its founders and its team will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for lost profits or data, arising from your use of the Services.</p>
  {h2('indemnification','12.','Indemnification')}
  <p>You agree to indemnify and hold Saa Thum and its founders harmless from claims arising out of your content, your use of the Services, or your violation of these Terms or applicable law.</p>
  {h2('law','13.','Governing law')}
  <p>These Terms are governed by the laws of India, without regard to conflict-of-laws rules, except where local mandatory consumer-protection laws apply to you. Our contracting entity is Saa Thum.</p>
  {h2('changes','14.','Changes')}
  <p>We may update these Terms from time to time. We will post the updated version here and revise the "Last updated" date. Continued use after changes means you accept the updated Terms.</p>
  {h2('contact','15.','Contact')}
  <p>Questions about these Terms? Email support (@) saathum.com or visit our <a href="#">contact page</a>.</p>
"""
terms_rail = '<div class="rail-card"><div><b>Governed by the laws of India</b><span>Read sections 10 and 11 with care — Saa Thum is still an early, invite-only product.</span></div><img src="{{IMG_elephant}}" alt="" aria-hidden="true"></div>'
PAGES['terms'] = legal_page('terms', 'Saa Thum Terms', 'Legal', 'Terms of <em>Service</em>',
    'The agreement between you and Saa Thum for using Saa Thum.',
    'terms', 'lotus', updated('September 15, 2026'),
    'A red bound book beside a kalash with mango leaves and a diya — terms of service.', terms_toc, terms_rail, terms_prose)

# ---------------------------------------------------------------- PRIVACY
privacy_toc = [('collect','Information we collect'),('use','How we use information'),('google','Google APIs and Google user data'),('ai','AI features and your data'),('share','How we share information'),('retention','Data retention'),('rights','Your rights and choices'),('security','Security'),('transfers','International transfers'),('children','Children'),('changes','Changes to this policy'),('contact','Contact us')]
privacy_prose = f"""
  <p>This Privacy Policy explains how the Saa Thum founding team ("Saa Thum", "we", "us", or "our") handles personal information in connection with the Saa Thum websites, apps, and services (collectively, the "Services").</p>
  <div class="note note--plain"><div><span class="tag">Testing stage</span><p>Because we are at the testing stage, please note that Saa Thum is a pre-release product, that access is invite-only, and that <strong>test data may be reset</strong> as we build. Do not put information into Saa Thum that you could not afford to lose or would not want handled by an early-stage service. We still protect what you give us as described below, and you can ask us to delete it at any time.</p></div></div>
  <p>By using the Services you agree to the practices described here. If you do not agree, please do not use the Services.</p>
  {h2('collect','1.','Information we collect')}
  <p>We collect information in three ways:</p>
  <ul>
    <li><strong>Information you give us</strong> — such as your name, email address, handle, profile details, payment and payout details, identity-verification data (for KYC where required), and any content you create, upload, or send.</li>
    <li><strong>Biometric identifiers</strong> — before you post publicly we ask you to complete a liveness check, which produces a scan of facial geometry. We collect this only with your prior written consent, we never sell or profit from it, and we destroy it on a published timetable.</li>
    <li><strong>Information we collect automatically</strong> — such as device and browser type, IP address, approximate location, pages viewed, and interactions with the Services, collected through cookies and similar technologies (see our <a href="#">Cookie Policy</a>).</li>
    <li><strong>Information from third parties</strong> — such as authentication providers, payment processors, and analytics partners that help us run the Services.</li>
  </ul>
  {h2('use','2.','How we use information')}
  <ul>
    <li>To provide, maintain, and improve the Services.</li>
    <li>To process payments, payouts, bookings, and transactions.</li>
    <li>To verify identity, keep the community safe, and prevent fraud and abuse.</li>
    <li>To personalize features, including AI-powered features.</li>
    <li>To communicate with you about your account, updates, and support requests.</li>
    <li>To comply with legal obligations and enforce our <a href="#">Terms of Service</a>.</li>
  </ul>
  {h2('google','3.','Google APIs and Google user data')}
  <p>If you choose to connect a Google Account, Saa Thum uses Google OAuth and requests only Google Drive's limited <code>drive.file</code> access. This lets Saa Thum create files in your Google Drive when you ask it to (for example, saving a booking receipt) and open only the files that Saa Thum created or that you explicitly select. Saa Thum cannot see, read or change any other file in your Google Drive. Saa Thum does not request access to your Google Calendar, Gmail, Contacts or any other Google service.</p>
  <p>Google user data is used only to provide the feature you requested, is transmitted over encrypted connections, and is never sold, used for advertising, used to determine creditworthiness, or transferred to anyone else except as necessary to provide that feature or where required by law. Saa Thum's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
  <p><strong>Google user data and AI.</strong> Saa Thum does not send any data received from Google APIs to any AI or machine-learning model — neither a self-hosted model nor a third-party AI service — and does not use Google user data to train, fine-tune or improve any AI model, whether generalized, foundational or Saa Thum's own.</p>
  <p>You can disconnect Google at any time from Saa Thum's settings or from your Google Account's third-party connections (myaccount.google.com/connections). When disconnected, Saa Thum stops making Google API requests for that connection. You can ask us to delete stored Google-related data and tokens by contacting support (@) saathum.com; tokens are encrypted at rest and are deleted when the connection is removed, subject to legally required retention.</p>
  {h2('ai','4.','AI features and your data')}
  <p>Saa Thum is an AI-centric platform. Some features use machine-learning models to generate, summarize, translate, or recommend content. AI outputs can be inaccurate or incomplete — please review the section on AI in our <a href="#">Terms of Service</a>. Private and end-to-end encrypted content is processed on-device wherever feasible and is not used to train shared models without your consent. Some communication features are server-readable so Saa Thum can provide the service you request; content is handled according to the controls and disclosures shown inside the relevant feature. Where a feature is explicitly described as end-to-end encrypted, processing remains limited to the participating devices except where you choose to share that content with Saa Thum.</p>
  <p><strong>Which AI services we use.</strong> Saa Thum does not run its own self-hosted AI model. AI features use third-party AI services acting as our service providers: Cloudflare Workers AI, OpenAI and Google Gemini (and, for some features, OpenRouter and Groq). We send these providers only the content needed for the AI feature you use. As explained in section 3, data received from Google APIs is never sent to any of these AI services.</p>
  {h2('share','5.','How we share information')}
  <p>We do <strong>not</strong> sell your personal information. We share it only:</p>
  <ul>
    <li>With service providers (e.g. hosting, payments, email, analytics) under contract.</li>
    <li>With other users when you choose to make content or a profile public.</li>
    <li>To comply with law, legal process, or to protect rights, safety, and property.</li>
    <li>In connection with a merger, acquisition, or sale of assets, with notice where required.</li>
  </ul>
  {h2('retention','6.','Data retention')}
  <p>We keep personal information for as long as your account is active or as needed to provide the Services, comply with legal obligations, resolve disputes, and enforce our agreements. You can request deletion of your account and data at any time.</p>
  {h2('rights','7.','Your rights and choices')}
  <p>Depending on where you live, you may have the right to access, correct, export, or delete your personal information, and to object to or restrict certain processing. To exercise these rights, contact us at support (@) saathum.com. You can also manage cookies through your browser and our cookie controls.</p>
  {h2('security','8.','Security')}
  <p>We use technical and organizational measures designed to protect personal information, including encryption in transit and at rest. No method of transmission or storage is perfectly secure, so we cannot guarantee absolute security.</p>
  <p>Saa Thum user data is hosted using secure infrastructure selected by Saa Thum. We describe the locations and providers used for your data in the applicable service notices.</p>
  {h2('transfers','9.','International transfers')}
  <p>We operate globally. Your information may be processed in countries other than your own, including countries where our infrastructure and service providers operate, where data-protection laws may differ. We take steps to ensure appropriate safeguards are in place.</p>
  {h2('children','10.','Children')}
  <p>The Services are not directed to children under 13 (or the minimum age required in your jurisdiction). We do not knowingly collect personal information from children. If you believe a child has provided us information, contact support (@) saathum.com.</p>
  {h2('changes','11.','Changes to this policy')}
  <p>We may update this Privacy Policy from time to time. We will post the updated version here and revise the "Last updated" date above. Material changes may be communicated through the Services.</p>
  {h2('contact','12.','Contact us')}
  <p>Questions about privacy? Email support (@) saathum.com or use our <a href="#">contact page</a>.</p>
"""
privacy_rail = '<div class="rail-card"><div><b>We never sell your data</b><span>Ask us to delete your account and data at any time at support (@) saathum.com.</span></div><img src="{{IMG_diya}}" alt="" aria-hidden="true"></div>'
PAGES['privacy'] = legal_page('privacy', 'Saa Thum Privacy', 'Legal', 'Privacy <em>Policy</em>',
    'How the Saa Thum team collects, uses, and protects your information while we test an early product with a small group of invited users.',
    'privacy', 'lotus', updated('September 25, 2026'),
    'A teal lotus-shaped shield with a golden padlock and a diya — privacy.', privacy_toc, privacy_rail, privacy_prose)

# ---------------------------------------------------------------- CONTACT
contact_body = """
  <section class="contact wrap">
    <div class="contact-inner">
      <form id="contact-form" class="cform" novalidate>
        <p class="intro">You can always email us directly at support (@) saathum.com, or use the form below. For anything about your data, see our <a href="#">Privacy Policy</a>.</p>
        <label class="honeypot" aria-hidden="true"><span>Company website</span><input type="text" name="company" tabindex="-1" autocomplete="off"></label>
        <div class="row">
          <label><span>Your name</span><input id="c-name" type="text" name="name" autocomplete="name" required maxlength="120"></label>
          <label><span>Email</span><input id="c-email" type="email" name="email" autocomplete="email" required maxlength="200"></label>
        </div>
        <label><span>What can we help with?</span>
          <select id="c-category" name="category">
            <option value="Support">Product support</option><option value="Feedback">Feedback or an idea</option><option value="Safety">Safety or abuse report</option><option value="Privacy">Privacy request</option><option value="Press">Press or media</option><option value="Partnership">Partnership</option><option value="Other">Something else</option>
          </select>
        </label>
        <label><span>Subject</span><input id="c-subject" type="text" name="subject" maxlength="160" placeholder="What’s this about?"></label>
        <label><span>Message</span><textarea id="c-message" name="message" rows="6" required maxlength="5000" placeholder="How can we help?"></textarea></label>
        <button type="submit" class="btn">Send message <span aria-hidden="true">→</span></button>
        <p class="cstatus" id="contact-status" role="status" aria-live="polite"></p>
        <p class="delivery-note">Every form submission is delivered through Brevo to <strong>support@saathum.com</strong>.</p>
      </form>
      <aside class="side">
        <div class="side-card side-card--red"><div><span class="tag">Email</span><h3>Write to us directly</h3><p><strong>support (@) saathum.com</strong></p><p>Your message goes straight to the Saa Thum support team.</p></div><img src="{{IMG_link}}" alt="" aria-hidden="true"></div>
        <div class="side-card side-card--terra"><div><span class="tag">Help centre</span><h3>Answers in plain English</h3><p>Booking, joining live, prasad, refunds and your account — <a href="#">browse the Help centre</a>.</p></div><img src="{{IMG_ontime}}" alt="" aria-hidden="true"></div>
        <div class="side-card side-card--plum"><div><span class="tag">Your data</span><h3>Privacy requests</h3><p>Pick “Privacy request” in the form, or read our <a href="#">Privacy Policy</a>.</p></div><img src="{{IMG_privacy}}" alt="" aria-hidden="true"></div>
      </aside>
    </div>
  </section>
  <script>
  (function(){var f=document.getElementById('contact-form'),s=document.getElementById('contact-status');if(!f||!s)return;
  f.addEventListener('submit',function(e){e.preventDefault();var d=new FormData(f);
  if(!d.get('name')||!d.get('email')||!d.get('message')){s.className='cstatus';s.style.color='#c82c25';s.textContent='Please fill in your name, email, and message.';return;}
  s.style.color='#07545b';s.textContent='Mockup only — on the live site this sends your message to the Saa Thum support team.';});})();
  </script>
"""
PAGES['contact'] = ("<title>Saa Thum Contact</title>" + CSS + HEADER + "<main>" +
    hero('Talk to a human', 'Contact <em>us</em>',
         'Questions, feedback, press, partnerships, or a problem to report? Your message goes straight to the Saa Thum support team.',
         'contact', 'elephant', '<span class="pill"><span class="dot"></span>support (@) saathum.com</span>',
         'Folded hands in namaste over a lit diya with marigolds — contact us.') +
    contact_body + "</main>" + FOOTER)

# ---------------------------------------------------------------- write
for slug, html in PAGES.items():
    src = html
    with open(os.path.join(OUT, f'saathum-{slug}-mock.src.html'), 'w') as f: f.write(src)
    for k, v in I.items(): html = html.replace('{{IMG_%s}}' % k, v)
    assert '{{IMG_' not in html, slug
    p = os.path.join(OUT, f'saathum-{slug}-mock.html')
    with open(p, 'w') as f: f.write(html)
    print(slug, round(os.path.getsize(p)/1024), 'KB')
