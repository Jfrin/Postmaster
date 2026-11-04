/** Separate synthetic-only interface; never embeds the administrative dashboard. */
export const DEMO_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Postmaster demo</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1a1d21;--muted:#667085;--line:#e4e7ec;--accent:#2563eb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--card);border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0}.grow{flex:1}.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;border:1px solid currentColor;color:#b45309}
.status{color:var(--muted);font-weight:500}a{color:var(--accent)}nav{display:flex;gap:4px;padding:10px 20px 0;overflow-x:auto}
nav button{background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px;color:var(--muted);cursor:pointer;font:inherit;white-space:nowrap}
nav button[aria-pressed="true"]{color:var(--text);border-color:var(--accent);font-weight:600}
main{padding:16px 20px 60px;max-width:1100px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.notice{color:#475467}.notice strong{color:var(--text)}.hint{font-size:12px;color:var(--muted);margin:4px 0 0}
.btn{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:7px 14px;font:inherit;cursor:pointer}.btn:disabled{opacity:.4;cursor:not-allowed}
.chip{display:inline-block;padding:2px 8px;border-radius:99px;background:var(--bg);border:1px solid var(--line);font-size:12px;margin:0 6px 6px 0}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:680px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}tbody tr:last-child td{border-bottom:0}
label{display:block;font-size:12px;color:var(--muted);margin:12px 0 4px}input,textarea{font:inherit;color:var(--text);background:var(--bg);border:1px solid #cbd2dc;border-radius:7px;padding:8px;width:100%}textarea{resize:vertical;min-height:110px}form .btn{margin-top:14px}
h2{font-size:16px;margin:0 0 8px}#result{white-space:pre-wrap;margin:14px 0 0}#result:empty{display:none}[hidden]{display:none!important}
@media(max-width:600px){header{flex-wrap:wrap;gap:8px}header .grow{flex-basis:30%}main{padding:14px}nav{padding-left:14px}header{padding:12px 14px}}
</style></head><body>
<header><h1>Postmaster</h1><span class="badge">DEMO</span><span class="grow"></span><span class="badge status">Synthetic preview</span><button class="btn" disabled title="Not available in the demo">Start</button><button class="btn" disabled title="Not available in the demo">Save</button><a href="/oauth2/sign_out">Sign out</a></header>
<nav aria-label="Demo sections">
<button type="button" aria-pressed="true" aria-controls="activity">Activity</button><button type="button" aria-pressed="false" aria-controls="categories">Categories</button><button type="button" aria-pressed="false" aria-controls="rules">Rules</button><button type="button" aria-pressed="false" aria-controls="settings">Settings</button><button type="button" aria-pressed="false" aria-controls="try">Try it</button>
</nav>
<main>
<div class="card notice"><strong>Demo only.</strong> No Gmail connection, no Azure model calls, and no saved messages. Activity and settings below are examples; Start and Save are unavailable. Do not enter real or sensitive email.</div>
<section id="activity" aria-label="Activity">
<div class="card"><span class="chip">Model calls: 0</span><span class="chip">Classifier: mock</span><span class="chip">Receipts: 2</span><span class="chip">Newsletters: 2</span><span class="chip">Security: 1</span><span class="chip">Promotions: 1</span><p class="hint">Showing 6 example decisions. No inbox is connected.</p></div>
<div class="card table-wrap"><table><thead><tr><th>Time</th><th>From</th><th>Subject</th><th>Category</th><th>Conf.</th><th>How</th><th>Result</th></tr></thead><tbody>
<tr><td>Example</td><td>orders@example.com</td><td>Your order shipped</td><td>Receipts</td><td>95%</td><td>mock</td><td>preview</td></tr>
<tr><td>Example</td><td>digest@example.com</td><td>Your weekly reading list</td><td>Newsletters</td><td>90%</td><td>mock</td><td>preview</td></tr>
<tr><td>Example</td><td>security@example.com</td><td>New sign-in alert</td><td>Security</td><td>98%</td><td>mock</td><td>preview</td></tr>
<tr><td>Example</td><td>shop@example.com</td><td>Spring offers are here</td><td>Promotions</td><td>92%</td><td>mock</td><td>preview</td></tr>
<tr><td>Example</td><td>updates@example.com</td><td>This month's highlights</td><td>Newsletters</td><td>91%</td><td>mock</td><td>preview</td></tr>
<tr><td>Example</td><td>billing@example.com</td><td>Payment confirmation</td><td>Receipts</td><td>96%</td><td>mock</td><td>preview</td></tr>
</tbody></table></div></section>
<section id="categories" aria-label="Categories" hidden><div class="card"><h2>Example categories</h2><p class="hint">A preview of how messages can be organized. These examples are read-only.</p><div class="table-wrap"><table><thead><tr><th>Category</th><th>Description</th><th>Example actions</th></tr></thead><tbody>
<tr><td>Receipts</td><td>Purchase confirmations and shipping updates</td><td>Label, mark read, archive</td></tr><tr><td>Newsletters</td><td>Subscribed digests and updates</td><td>Label, archive</td></tr><tr><td>Security</td><td>Login alerts and verification codes</td><td>Label</td></tr><tr><td>Promotions</td><td>Sales and marketing</td><td>Label, mark read, archive</td></tr><tr><td>Needs Review</td><td>Messages that do not clearly fit</td><td>Label</td></tr>
</tbody></table></div></div></section>
<section id="rules" aria-label="Rules" hidden><div class="card"><h2>Example rule</h2><p class="hint">Rules can classify matching messages before the classifier. This preview is read-only.</p><div class="table-wrap"><table><thead><tr><th>Match</th><th>Category</th></tr></thead><tbody><tr><td>Sender domain: github.com</td><td>Dev</td></tr></tbody></table></div></div></section>
<section id="settings" aria-label="Settings" hidden><div class="card"><h2>Example settings</h2><p class="hint">Settings shown here illustrate the product and cannot be changed in the demo.</p><p><span class="chip">Dry run: on</span><span class="chip">Label prefix: AI/</span><span class="chip">Confidence threshold: 70%</span><span class="chip">Fallback: Needs Review</span></p></div></section>
<section id="try" aria-label="Try it" hidden><div class="card"><h2>Try a synthetic message</h2><p class="hint">Try the mock classifier with made-up content. Results are not saved.</p>
<form id="form"><label for="from">From</label><input id="from" value="orders@example.com" maxlength="500" required><label for="subject">Subject</label><input id="subject" value="Your order shipped" maxlength="1000" required><label for="body">Body</label><textarea id="body" rows="5" maxlength="20000" required>Your synthetic order has shipped.</textarea><button class="btn" type="submit">Classify</button></form><p id="result" role="status"></p></div></section>
</main><script>
document.querySelectorAll('nav button').forEach(function(button){button.addEventListener('click',function(){
  document.querySelectorAll('nav button').forEach(function(tab){var selected=tab===button;tab.setAttribute('aria-pressed',String(selected));document.getElementById(tab.getAttribute('aria-controls')).hidden=!selected});
})});
document.getElementById('form').addEventListener('submit',async function(e){
  e.preventDefault();var out=document.getElementById('result');out.textContent='Classifying...';
  try{var r=await fetch('/api/try',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:document.getElementById('from').value,subject:document.getElementById('subject').value,body:document.getElementById('body').value})});
  var x=await r.json();out.textContent=r.ok?'Category: '+x.category+'\\nConfidence: '+Math.round(x.confidence*100)+'%\\n'+x.reason:'Unable to classify this example.';
  }catch(e){out.textContent='Unable to classify this example.'}
});
</script></body></html>`;
