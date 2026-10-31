// Single-page admin UI. No external requests, no dependencies. All untrusted text (email
// subjects, model reasons) is inserted with textContent/value, never as HTML.
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Postmaster</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1a1d21;--muted:#667085;--line:#e4e7ec;--accent:#2563eb;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--text:#e8eaed;--muted:#98a2b3;--line:#2a2f38;--accent:#60a5fa;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
header h1{font-size:16px;margin:0}
.grow{flex:1}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
.badge.dry{color:var(--warn)}.badge.live{color:var(--ok)}.badge.src{color:var(--muted);font-weight:500}
nav{display:flex;gap:4px;padding:10px 20px 0}
nav button{background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px;color:var(--muted);cursor:pointer;font:inherit}
nav button.on{color:var(--text);border-color:var(--accent);font-weight:600}
main{padding:16px 20px 60px;max-width:1100px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
button.btn{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:7px 14px;font:inherit;cursor:pointer}
button.btn:disabled{opacity:.4;cursor:default}
button.ghost{background:none;border:1px solid var(--line);color:var(--text);border-radius:7px;padding:5px 10px;font:inherit;cursor:pointer}
button.danger{color:var(--bad)}
input,textarea,select{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:6px 8px;width:100%}
textarea{resize:vertical;min-height:60px}
label{display:block;font-size:12px;color:var(--muted);margin:8px 0 3px}
.row{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.checks{display:flex;gap:14px;flex-wrap:wrap;margin-top:4px}
.checks label{display:flex;gap:5px;align-items:center;color:var(--text);margin:0;font-size:13px}
.checks input{width:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
td.trunc{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{display:inline-block;padding:2px 8px;border-radius:99px;background:var(--bg);border:1px solid var(--line);font-size:12px;margin:0 6px 6px 0}
.muted{color:var(--muted)}
.rules td{padding:4px}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 16px;border-radius:8px;max-width:80vw;white-space:pre-wrap;display:none;z-index:9}
#toast.bad{background:var(--bad);color:#fff}
.hint{font-size:12px;color:var(--muted);margin:4px 0 0}
</style>
</head>
<body>
<header>
  <h1>Postmaster</h1><span id="mode" class="badge"></span><span class="grow"></span>
  <span id="run" class="badge src">...</span>
  <button id="runbtn" class="btn" disabled>Start</button>
  <span id="dirty" class="muted" hidden>Unsaved changes</span>
  <button id="save" class="btn" disabled>Save</button>
</header>
<nav id="tabs"></nav>
<main id="main"></main>
<div id="toast"></div>
<script>
var ACTIONS=['label','star','mark_read','archive'];
var TABS=[['activity','Activity'],['categories','Categories'],['rules','Rules'],['settings','Settings'],['try','Try it']];
var cfg=null,dirty=false,tab='activity',timer=null,toastTimer=null,runState=null;
var activitySource=null,activityItems=[],lastActivitySig='',processedIds=readProcessedIds();

function h(tag,props){
  var e=document.createElement(tag),val,hasVal=false,chk,hasChk=false;
  var kids=Array.prototype.slice.call(arguments,2).flat(Infinity);
  for(var k in (props||{})){var v=props[k];
    if(k==='class')e.className=v;
    else if(k==='value'){val=v;hasVal=true}
    else if(k==='checked'){chk=v;hasChk=true}
    else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),v);
    else if(v!==false&&v!=null)e.setAttribute(k,v===true?'':v);}
  kids.forEach(function(c){if(c==null||c===false)return;e.append(c&&c.nodeType?c:document.createTextNode(String(c)))});
  if(hasVal)e.value=val;if(hasChk)e.checked=chk;return e;
}
function $(s){return document.querySelector(s)}
function fill(el){var k=Array.prototype.slice.call(arguments,1).flat(Infinity).filter(function(x){return x!=null&&x!==false});el.replaceChildren.apply(el,k)}
async function api(path,opts){
  var r=await fetch(path,opts);var j=await r.json().catch(function(){return{}});
  if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;
}
function toast(msg,bad){
  var t=$('#toast');t.textContent=msg;t.className=bad?'bad':'';t.style.display='block';
  clearTimeout(toastTimer);toastTimer=setTimeout(function(){t.style.display='none'},bad?12000:4000);
}
function touch(){dirty=true;$('#save').disabled=false;$('#dirty').hidden=false}
function header(){
  var m=$('#mode');var dry=cfg&&cfg.settings.dry_run;
  m.textContent=dry?'DRY RUN - nothing changes in Gmail':'LIVE';m.className='badge '+(dry?'dry':'live');
}
function catLabel(id){var c=cfg.categories.find(function(x){return x.id===id});return c?c.label:id}
function catSelect(value,onchange){
  return h('select',{value:value,onchange:onchange},cfg.categories.map(function(c){return h('option',{value:c.id},c.label+' ('+c.id+')')}));
}
function field(label,input,hint){return h('div',null,h('label',null,label),input,hint?h('div',{class:'hint'},hint):null)}

/* ---------- Activity bookkeeping ---------- */
var ACTIVITY_KEY='postmaster.activity.processed';
function readProcessedIds(){
  try{var raw=localStorage.getItem(ACTIVITY_KEY);var a=raw?JSON.parse(raw):[];return Array.isArray(a)?a:[]}catch(e){return[]}
}
function saveProcessedIds(){
  // Keep the list bounded so localStorage cannot grow forever.
  if(processedIds.length>2000)processedIds=processedIds.slice(-2000);
  try{localStorage.setItem(ACTIVITY_KEY,JSON.stringify(processedIds))}catch(e){}
}
function markProcessed(x){
  if(x&&x.message_id&&processedIds.indexOf(x.message_id)<0){processedIds.push(x.message_id);saveProcessedIds()}
}

/* ---------- Start / Stop ---------- */
function drawRun(){
  var b=$('#run'),btn=$('#runbtn');
  if(!runState){b.textContent='status unavailable';b.className='badge src';btn.disabled=true;return}
  var st=runState.status||{};
  if(!runState.online){b.textContent='Poller offline';b.className='badge dry';btn.textContent='Start';btn.disabled=true;btn.title='Run: docker compose up -d postmaster';return}
  btn.disabled=false;btn.title='';
  if(!runState.running){b.textContent='Stopped';b.className='badge src';btn.textContent='Start';return}
  var p=st.progress;
  b.textContent=st.state==='scanning'?('Running: '+(p?p.done+' / '+p.total+' emails':'checking mail...')):(st.lastCycle&&st.lastCycle.seen===0?'No new mail found - waiting for next check':'Scan finished - waiting for next check');
  b.className='badge live';btn.textContent='Stop';
}
async function refreshStatus(){
  try{runState=await api('/api/status')}catch(e){runState=null}
  drawRun();
}
async function toggleRun(){
  var starting=!(runState&&runState.running);
  if(starting&&cfg&&!cfg.settings.dry_run&&!confirm('Dry run is OFF. Postmaster will start labeling and archiving your real mail. Start?'))return;
  if(starting&&dirty&&!confirm('You have unsaved changes that Postmaster will not use. Start anyway?'))return;
  try{
    runState=await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:starting?'start':'stop'})});
    drawRun();toast(starting?'Started. Scanning the inbox lookback, then checking for new mail every few minutes.':'Stopping after in-flight emails finish.');
  }catch(e){toast(e.message,true)}
}

/* ---------- Activity ---------- */
function activityRows(decisions){
  return h('div',{class:'card',style:'overflow-x:auto'},h('table',null,
    h('thead',null,h('tr',null,['Time','From','Subject','Category','Conf.','How','Result'].map(function(t){return h('th',null,t)}))),
    h('tbody',null,decisions.map(function(x){return h('tr',null,
      h('td',{class:'muted'},new Date(x.created_at).toLocaleString()),
      h('td',{class:'trunc',title:x.sender||''},x.sender||''),
      h('td',{class:'trunc',title:x.subject||''},x.subject||'(no subject)'),
      h('td',null,catLabel(x.category)),
      h('td',null,Math.round(x.confidence*100)+'%'),
      h('td',{title:x.reason},x.source),
      h('td',{class:x.applied?'':'muted'},x.applied?'applied':'dry run'))}))));
}

function renderActivity(d){
  if(tab!=='activity')return;
  // Only show decisions we have not already seen. The ids live in localStorage, so a page
  // reload (or a second browser tab) does not reprocess the same list again.
  var fresh=[];
  (d.decisions||[]).forEach(function(x){
    if(x&&x.message_id&&processedIds.indexOf(x.message_id)<0){fresh.push(x);markProcessed(x)}
  });
  if(fresh.length){
    activityItems=fresh.concat(activityItems);
    if(activityItems.length>100)activityItems=activityItems.slice(0,100);
  }
  var counts={};activityItems.forEach(function(x){counts[x.category]=(counts[x.category]||0)+1});
  var st=(d.run&&d.run.status)||(runState&&runState.status)||{};
  var sig=JSON.stringify({error:st.lastError||'',cycle:st.lastCycle||null,calls:d.llmCallsToday,cap:d.dailyCap,mode:d.mode,ids:activityItems.map(function(x){return x.message_id})});
  if(sig===lastActivitySig)return;
  lastActivitySig=sig;
  fill($('#main'),
    st.lastError?h('div',{class:'card',style:'color:var(--bad);white-space:pre-wrap'},'Last error: '+st.lastError):null,
    h('div',{class:'card'},
      st.lastCycle?h('span',{class:'chip'},'Last check: '+st.lastCycle.seen+' seen, '+st.lastCycle.processed+' handled, '+st.lastCycle.failed+' failed'+(st.lastCycle.dryRun?' (dry run)':'')):null,
      h('span',{class:'chip'},'Model calls today: '+d.llmCallsToday+' / '+d.dailyCap),
      h('span',{class:'chip'},'Classifier for Try it: '+d.mode),
      Object.keys(counts).map(function(k){return h('span',{class:'chip'},catLabel(k)+': '+counts[k])}),
      h('div',{class:'hint'},'Showing '+activityItems.length+' new decisions. Live updates. ',h('button',{class:'ghost',style:'margin-left:8px',onclick:function(){
        processedIds=[];saveProcessedIds();activityItems=[];lastActivitySig='';activity().catch(function(e){toast(e.message,true)});
      }},'Show all'))),
    activityItems.length?activityRows(activityItems)
      :h('div',{class:'card muted'},'No new decisions. Press Start at the top to begin, or use the Try it tab.'));
}

async function activity(){
  var d=await api('/api/decisions?limit=200');
  renderActivity(d);
}

function stopActivityStream(){
  if(activitySource){activitySource.close();activitySource=null}
}

function startActivityStream(){
  stopActivityStream();
  if(!('EventSource' in window)){
    // Very old browsers: fall back to a one-second poll, still deduplicated above.
    activity().catch(function(e){toast(e.message,true)});
    timer=setInterval(function(){activity().catch(function(){})},1000);
    return;
  }
  activitySource=new EventSource('/api/activity/stream');
  activitySource.onmessage=function(e){
    try{
      var d=JSON.parse(e.data);
      if(d.error)return; // keep the last good view; the config tab explains how to fix it
      renderActivity(d);
    }catch(err){}
  };
  activitySource.onerror=function(){
    // EventSource reconnects on its own while the server is reachable. Only fall back if it
    // has closed for good.
    if(activitySource&&activitySource.readyState===EventSource.CLOSED){
      stopActivityStream();
      timer=setInterval(function(){activity().catch(function(){})},2000);
    }
  };
}

/* ---------- Categories ---------- */
function categories(){
  var root=$('#main');
  fill(root,
    cfg.categories.map(function(c){
      return h('div',{class:'card'},
        h('div',{class:'row'},
          field('Id',h('input',{value:c.id,onchange:function(e){renameCategory(c,e.target.value.trim())}}),'lowercase letters, digits, underscores'),
          field('Gmail label',h('input',{value:c.label,oninput:function(e){c.label=e.target.value;touch()}}),'becomes '+cfg.settings.label_prefix+c.label)),
        field('Description (the model reads this)',h('textarea',{value:c.description,oninput:function(e){c.description=e.target.value;touch()}})),
        field('Examples (one per line)',h('textarea',{value:(c.examples||[]).join('\n'),oninput:function(e){c.examples=e.target.value.split('\n').filter(function(l){return l.trim()});touch()}})),
        h('label',null,'What happens to matching mail'),
        h('div',{class:'checks'},ACTIONS.map(function(a){return h('label',null,h('input',{type:'checkbox',checked:c.actions.indexOf(a)>=0,onchange:function(e){
          c.actions=ACTIONS.filter(function(x){return x===a?e.target.checked:c.actions.indexOf(x)>=0});touch()}}),a)})),
        h('div',{class:'checks'},h('label',null,h('input',{type:'checkbox',checked:!!c.only_if_unread,onchange:function(e){c.only_if_unread=e.target.checked;touch()}}),'Only use this category if the email is still unread')),
        h('div',{style:'margin-top:10px;text-align:right'},
          h('button',{class:'ghost danger',onclick:function(){removeCategory(c)}},'Delete')));
    }),
    h('button',{class:'ghost',onclick:function(){
      var n=1;while(cfg.categories.some(function(c){return c.id==='new_category_'+n}))n++;
      cfg.categories.push({id:'new_category_'+n,label:'New category',description:'',examples:[],actions:['label']});touch();categories();
    }},'+ Add category'));
}
function renameCategory(c,next){
  if(!next||next===c.id)return;var old=c.id;c.id=next;
  cfg.rules.forEach(function(r){if(r.category===old)r.category=next});
  if(cfg.settings.fallback_category===old)cfg.settings.fallback_category=next;touch();
}
function removeCategory(c){
  if(cfg.settings.fallback_category===c.id)return toast('That is the fallback category. Pick another fallback in Settings first.',true);
  if(cfg.rules.some(function(r){return r.category===c.id}))return toast('Rules still point at this category. Delete or change them first.',true);
  if(!confirm('Delete category '+c.label+'?'))return;
  cfg.categories=cfg.categories.filter(function(x){return x!==c});touch();categories();
}

/* ---------- Rules ---------- */
function rules(){
  var root=$('#main');
  function move(i,d){var j=i+d;if(j<0||j>=cfg.rules.length)return;var t=cfg.rules[i];cfg.rules[i]=cfg.rules[j];cfg.rules[j]=t;touch();rules()}
  function mi(r,key,ph){return h('input',{value:r.match[key]||'',placeholder:ph,oninput:function(e){r.match[key]=e.target.value;touch()}})}
  fill(root,
    h('div',{class:'card'},
      h('div',{class:'hint'},'Checked top to bottom, first match wins, no model call and the email is never sent to the model. Fill in one or more fields; all filled fields must match.'),
      h('table',{class:'rules'},
        h('thead',null,h('tr',null,['From address','From domain','Subject contains','Category',''].map(function(t){return h('th',null,t)}))),
        h('tbody',null,cfg.rules.map(function(r,i){return h('tr',null,
          h('td',null,mi(r,'from','boss@company.com')),
          h('td',null,mi(r,'from_domain','github.com')),
          h('td',null,mi(r,'subject_contains','invoice')),
          h('td',null,catSelect(r.category,function(e){r.category=e.target.value;touch()})),
          h('td',{style:'white-space:nowrap'},
            h('button',{class:'ghost',onclick:function(){move(i,-1)}},'up'),' ',
            h('button',{class:'ghost',onclick:function(){move(i,1)}},'down'),' ',
            h('button',{class:'ghost danger',onclick:function(){cfg.rules.splice(i,1);touch();rules()}},'x')))}))),
      cfg.rules.length?null:h('div',{class:'muted',style:'padding:8px'},'No rules yet.')),
    h('button',{class:'ghost',onclick:function(){cfg.rules.push({match:{from_domain:''},category:cfg.categories[0].id});touch();rules()}},'+ Add rule'));
}

/* ---------- Settings ---------- */
function settings(){
  var s=cfg.settings;
  function num(key,label,hint,step){return field(label,h('input',{type:'number',step:step||'1',value:s[key],oninput:function(e){s[key]=Number(e.target.value);touch()}}),hint)}
  fill($('#main'),h('div',{class:'card'},
    h('div',{class:'checks'},h('label',null,h('input',{type:'checkbox',checked:s.dry_run,onchange:function(e){s.dry_run=e.target.checked;touch()}}),'Dry run: log decisions but change nothing in Gmail')),
    h('div',{class:'row'},
      field('Label prefix',h('input',{value:s.label_prefix,oninput:function(e){s.label_prefix=e.target.value;touch()}}),'nests labels in the Gmail sidebar'),
      field('Fallback category',catSelect(s.fallback_category,function(e){s.fallback_category=e.target.value;touch()}),'where unsure mail goes'),
      num('confidence_threshold','Confidence threshold','0 to 1. Higher sends more mail to review.','0.05'),
      num('daily_llm_call_cap','Daily model call cap','hard stop on spend'),
      num('poll_interval_seconds','Poll interval (seconds)',''),
      num('max_body_chars','Body characters sent to model',''),
      num('backlog_days','Inbox lookback (days)','Scanned on Start and on the next check after changing this value. Already-processed emails are skipped.'))));
}

/* ---------- Try it ---------- */
function tryIt(){
  var from=h('input',{value:'orders@shop.example'}),subj=h('input',{value:'Your order has shipped'}),
      body=h('textarea',{style:'min-height:120px',value:'Hi! Your order #1234 is on its way and should arrive Friday.'}),out=h('div');
  async function run(){
    fill(out,h('div',{class:'muted'},'Working...'));
    try{
      var r=await api('/api/try',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:from.value,subject:subj.value,body:body.value})});
      fill(out,h('div',{class:'card'},
        h('div',null,h('b',null,r.label),'  ',h('span',{class:'chip'},Math.round(r.confidence*100)+'% confident'),h('span',{class:'chip'},r.source)),
        h('div',{class:'muted',style:'margin:6px 0'},r.reason),
        h('div',null,'Would apply: ',r.actions.map(function(a){return h('span',{class:'chip'},a)})),
        h('div',{class:'hint'},'Classifier: '+r.mode+(r.mode==='mock'?' (keyword guesser. Add Azure settings to .env to test the real model.)':'')+'. Nothing was changed in Gmail and nothing was saved.')));
    }catch(e){fill(out,h('div',{class:'card',style:'color:var(--bad)'},e.message))}
  }
  fill($('#main'),h('div',{class:'card'},
    h('div',{class:'hint'},'Paste an email to see how it would be sorted with your current saved config. Save changes first.'),
    h('div',{class:'row'},field('From',from),field('Subject',subj)),field('Body',body),
    h('div',{style:'margin-top:10px'},h('button',{class:'btn',onclick:run},'Classify'))),out);
}

/* ---------- shell ---------- */
function render(){
  clearInterval(timer);timer=null;stopActivityStream();lastActivitySig='';header();
  fill($('#tabs'),TABS.map(function(t){return h('button',{class:tab===t[0]?'on':'',onclick:function(){tab=t[0];render()}},t[1])}));
  if(tab==='activity'){startActivityStream()}
  else if(tab==='categories')categories();else if(tab==='rules')rules();else if(tab==='settings')settings();else tryIt();
}
function prune(){
  cfg.rules.forEach(function(r){Object.keys(r.match).forEach(function(k){if(!String(r.match[k]||'').trim())delete r.match[k]})});
  cfg.rules=cfg.rules.filter(function(r){return Object.keys(r.match).length});
}
async function save(){
  prune();
  try{
    cfg=await api('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
    dirty=false;$('#save').disabled=true;$('#dirty').hidden=true;
    toast('Saved. Postmaster picks it up on its next poll cycle.');render();
  }catch(e){toast('Not saved:\n'+e.message,true)}
}
window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue=''}});
$('#save').addEventListener('click',save);
$('#runbtn').addEventListener('click',toggleRun);
refreshStatus();setInterval(refreshStatus,3000);
api('/api/config').then(function(c){cfg=c;render()}).catch(function(e){$('#main').textContent=e.message});
</script>
</body>
</html>`;
