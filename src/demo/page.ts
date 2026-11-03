/** Separate synthetic-only interface; never embeds the administrative dashboard. */
export const DEMO_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Postmaster demo</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;color:#182230;background:#f5f7fa;margin:0}
main{max-width:720px;margin:3rem auto;padding:0 1rem}section{background:white;border:1px solid #d9e0e8;border-radius:12px;padding:1.5rem}
label{display:block;margin-top:1rem;font-weight:600}input,textarea{box-sizing:border-box;width:100%;padding:.7rem;font:inherit;border:1px solid #98a2b3;border-radius:6px}
button{margin-top:1rem;padding:.7rem 1rem;background:#2563eb;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}
#result{white-space:pre-wrap;margin-top:1rem}a{color:#2563eb}.note{color:#475467}
</style></head><body><main><h1>Postmaster demo</h1><p class="note">Synthetic preview only. No Gmail connection, no Azure model calls, and no saved messages. Do not enter real or sensitive email.</p>
<section><form id="form"><label for="from">From</label><input id="from" value="orders@example.com" maxlength="500" required>
<label for="subject">Subject</label><input id="subject" value="Your order shipped" maxlength="1000" required>
<label for="body">Body</label><textarea id="body" rows="5" maxlength="20000" required>Your synthetic order has shipped.</textarea>
<button type="submit">Classify</button></form><p id="result" role="status"></p></section><p><a href="/oauth2/sign_out">Sign out</a></p></main>
<script>
document.getElementById('form').addEventListener('submit',async function(e){
  e.preventDefault();var out=document.getElementById('result');out.textContent='Classifying...';
  try{var r=await fetch('/api/try',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:document.getElementById('from').value,subject:document.getElementById('subject').value,body:document.getElementById('body').value})});
  var x=await r.json();out.textContent=r.ok?'Category: '+x.category+'\\nConfidence: '+Math.round(x.confidence*100)+'%\\n'+x.reason:'Unable to classify this example.';
  }catch(e){out.textContent='Unable to classify this example.'}
});
</script></body></html>`;
