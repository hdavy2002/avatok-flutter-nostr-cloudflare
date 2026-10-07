import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = resolve('public/hosts/crisis-script.pdf');
const source = resolve('/tmp/hello-fraands-crisis-script-source.html');
await mkdir(resolve('public/hosts'), { recursive: true });
const html = `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><style>
    @page{size:A4;margin:13mm}
    *{box-sizing:border-box}
    html,body{background:#fff}body{font-family:"Devanagari Sangam MN",Arial,sans-serif;color:#382338;font-size:11pt;line-height:1.55;margin:0}
    h1,h2{font-family:Arial,sans-serif;color:#46113e}
    h1{font-size:23pt;line-height:1.1;margin:0 0 5mm}
    h2{font-size:12pt;margin:6mm 0 2mm}
    p{margin:0 0 2.5mm}
    .brand{font-family:Arial,sans-serif;font-weight:700;letter-spacing:.07em;color:#7b388c;text-transform:uppercase;font-size:8.5pt;margin-bottom:2mm}
    .lead{font-size:11pt;color:#694266;margin-bottom:5mm}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:5mm;align-items:stretch}
    .card{background:#fffaf6;border:1px solid #e7d4e3;border-radius:4mm;padding:5mm}
    .card h2{margin:0 0 3mm}
    .card[lang=hi]{font-family:"Devanagari Sangam MN",sans-serif;font-size:11.5pt;line-height:1.6}
    .card[lang=hi] h2{font-family:"Devanagari Sangam MN",sans-serif}
    .number{color:#692d65;font-weight:700;text-decoration:underline}
    .next{margin-top:5mm;padding:3mm 4mm;background:#f1eaf1;border-radius:3mm}
    .small{font-size:9pt}
    .foot{border-top:1px solid #ddd;margin-top:5mm;padding-top:2mm;color:#6c6269;font-size:8pt}
  </style></head><body>
  <p class="brand">Hello Fraands · Host safety card</p>
  <h1>When a caller mentions self-harm</h1>
  <p class="lead">Stay calm. Do not argue or counsel. Say the words below, ask them to call now, then end and report the call.</p>
  <div class="grid">
    <section class="card"><h2>Say this in English</h2>
      <p>“I care about your safety, and I am glad you told me. I am not trained to help in a crisis. Please call Tele-MANAS on <a class="number" href="tel:14416">14416</a> now. If you might hurt yourself now or are in immediate danger, call <a class="number" href="tel:112">112</a> now. Can you make that call now? If you can, ask someone you trust to stay with you. I am going to end this call so you can reach that help, and report this to our safety team.”</p>
    </section>
    <section class="card" lang="hi"><h2>हिंदी में यह कहें</h2>
      <p>“मुझे आपकी सुरक्षा की परवाह है। आपने मुझे बताया, यह अच्छा किया। मैं संकट में मदद करने के लिए प्रशिक्षित नहीं हूँ। कृपया अभी टेली-मानस को <a class="number" href="tel:14416">14416</a> पर कॉल करें। अगर आपको लगता है कि आप अभी खुद को नुकसान पहुँचा सकते हैं या तुरंत खतरे में हैं, तो अभी <a class="number" href="tel:112">112</a> पर कॉल करें। क्या आप अभी यह कॉल कर सकते हैं? हो सके तो किसी भरोसेमंद व्यक्ति को अपने पास रहने के लिए कहें। मैं अब यह कॉल खत्म करूँगा या करूँगी ताकि आप मदद ले सकें, और हमारी सुरक्षा टीम को इसकी रिपोर्ट दूँगा या दूँगी।”</p>
    </section>
  </div>
  <section class="next"><h2>Do not say</h2><p class="small">“You are overreacting.” “Just be positive.” “Promise me you will never do it.” “I can fix this.” “This will stay secret.”</p><p class="small">Do not ask for method details, offer a diagnosis, or charge for more conversation. Do not promise that emergency services have been contacted. Use end-and-report after giving the script.</p></section>
  <p class="foot">Hello Fraands is not a crisis service. This host script is under legal review. More help: <a class="number" href="tel:9152987821">iCall 9152987821</a> · <a class="number" href="tel:18602662345">Vandrevala 1860-2662-345</a>.</p>
  </body></html>`;
await writeFile(source, html);
const binary = resolve(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell');
const run = spawnSync(binary, ['--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf=' + output, pathToFileURL(source).href], { encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr || 'PDF rendering failed');
console.log(output);
