/** Request and administration interface. Must only be served behind real session authentication. */
export const BETA_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Postmaster beta</title><style>
body{font:16px/1.5 system-ui,sans-serif;color:#182230;background:#f5f7fa;margin:0}
main{max-width:1000px;margin:2rem auto;padding:0 1rem}section{background:white;border:1px solid #d9e0e8;border-radius:12px;padding:1rem;margin:1rem 0}
button,input{font:inherit;padding:.5rem;margin:.25rem}button{cursor:pointer}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;text-align:left;padding:.5rem}small{color:#475467}
</style></head><body><main><h1>Postmaster beta</h1><p id="identity"></p><section><h2>Testing access</h2>
<p id="access"></p><button id="request">Request access</button><p><small>Connect Gmail before approval. No mailbox processing occurs until approval and Start.</small></p>
<div id="gmail" hidden><p id="gmail-status"></p><p><small>Connecting grants Gmail modification access. When processing is enabled, message metadata and a limited body may be sent to Azure OpenAI. Only connect an inbox after reviewing the privacy and consent information.</small></p><button id="connect">Connect Gmail</button><button id="disconnect">Disconnect Gmail</button><button id="forget">Remove local connection</button></div></section>
<section id="config" hidden><h2>Categories, rules, and settings</h2><p><small>Edit your own JSON configuration. New accounts start in dry run; live actions can change your Gmail.</small></p><textarea id="config-text" rows="18" style="width:100%;box-sizing:border-box"></textarea><button id="save-config">Save configuration</button></section>
<section id="processing" hidden><h2>Processing</h2><p id="processing-status"></p><button id="processing-button"></button></section>
<section id="activity" hidden><h2>Recent activity</h2><div id="activity-list"></div></section>
<section id="admin" hidden><h2>Admin dashboard</h2><p id="metrics"></p><div id="requests"></div></section>
<p id="message" role="status"></p><button id="logout">Sign out</button></main><script>
let session;
const basePath=__BETA_BASE_PATH__;
const byId=id=>document.getElementById(id);
function element(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e}
async function api(path,method='GET',body,extra={}){
  const options={method,headers:{}};
  if(method!=='GET'){options.headers={'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,...extra};options.body=JSON.stringify(body)}
  const response=await fetch(basePath+path,options);const value=await response.json();if(!response.ok)throw new Error(value.error||'Request failed');return value;
}
async function refresh(){
  session=await api('/api/session');byId('identity').textContent='Signed in as '+session.email;
  const request=session.request;byId('access').textContent=!request?'No request submitted.':request.active?'Approved until '+new Date(request.expiresAt).toLocaleString():request.status==='approved'?'Approval expired.':request.status==='pending'?'Your request is pending.':'Your request was denied.';
  byId('request').disabled=!!request&&(request.active||request.status==='pending');
  byId('gmail').hidden=!session.gmailAvailable;
  byId('connect').hidden=!!request&&!request.active&&request.status!=='pending';
  byId('disconnect').hidden=!session.gmailConnected;
  byId('forget').hidden=!session.gmailConnected;
  byId('gmail-status').textContent=session.gmailConnected?'Gmail connection stored.':'Gmail is not connected.';
  byId('config').hidden=!(session.configAvailable&&request&&request.active);
  if(!byId('config').hidden)byId('config-text').value=JSON.stringify(await api('/api/config'),null,2);
  byId('processing').hidden=!(session.processingOnline&&session.configAvailable&&session.gmailReady&&request&&request.active);
  byId('processing-status').textContent=session.processingRequested?'Processing requested.':'Processing stopped.';
  byId('processing-button').textContent=session.processingRequested?'Stop':'Start';
  byId('activity').hidden=!(session.activityAvailable&&request&&request.active);
  if(!byId('activity').hidden){const rows=await api('/api/activity');const table=element('table'),head=element('tr');['Date','Sender','Subject','Category','Mode'].forEach(x=>head.append(element('th',x)));table.append(head);for(const x of rows){const tr=element('tr');[x.created_at,x.sender||'',x.subject||'',x.category,x.applied?'Live':'Dry run'].forEach(v=>tr.append(element('td',v)));table.append(tr)}byId('activity-list').replaceChildren(table)}
  byId('admin').hidden=!session.isAdmin;
  if(!session.isAdmin)return;
  const [metrics,entries]=await Promise.all([api('/api/admin/metrics'),api('/api/admin/requests')]);
  byId('metrics').textContent='Pending: '+metrics.pending+' · Active: '+metrics.active+' · Expired: '+metrics.expired+' · Denied: '+metrics.denied+' · Reads today (UTC): '+metrics.readsToday+' · Processed (including dry runs): '+metrics.processedToday+' · Failures: '+metrics.failedToday;
  const table=element('table');const head=element('tr');['Account','Status','Expires','Reads today','Processed / failed','Daily limit','Approve until','Actions'].forEach(x=>head.append(element('th',x)));table.append(head);
  for(const item of entries){
    const tr=element('tr');tr.append(element('td',item.email),element('td',item.status==='approved'&&!item.active?'expired':item.status),element('td',item.expiresAt?new Date(item.expiresAt).toLocaleString():'—'),element('td',String(item.attempts)),element('td',item.cycleUsage.processed+' / '+item.cycleUsage.failed));
    const cap=element('input');cap.type='number';cap.min='0';cap.max='100000';cap.value=String(item.dailyLimit);cap.setAttribute('aria-label','Daily read limit');
    const expiry=element('input');expiry.type='datetime-local';expiry.setAttribute('aria-label','Approval expiry');
    const capCell=element('td');capCell.append(cap);const expiryCell=element('td');expiryCell.append(expiry);tr.append(capCell,expiryCell);
    const actions=element('td'),approve=element('button','Approve / update'),deny=element('button','Deny');
    approve.onclick=async()=>{const time=expiry.value?new Date(expiry.value).getTime():NaN;if(!Number.isFinite(time)){byId('message').textContent='Choose an expiry date.';return}try{await api('/api/admin/approve','POST',{subject:item.subject,expiresAt:time,dailyLimit:Number(cap.value)});await refresh()}catch(e){byId('message').textContent=e.message}};
    deny.onclick=async()=>{try{await api('/api/admin/deny','POST',{subject:item.subject});await refresh()}catch(e){byId('message').textContent=e.message}};
    actions.append(approve,deny);tr.append(actions);table.append(tr);
  }
  byId('requests').replaceChildren(table);
}
byId('request').onclick=async()=>{try{await api('/api/access/request','POST',{});await refresh()}catch(e){byId('message').textContent=e.message}};
byId('connect').onclick=async()=>{try{const result=await api('/api/gmail/connect','POST',{});location.assign(result.location)}catch(e){byId('message').textContent=e.message}};
byId('disconnect').onclick=async()=>{try{await api('/api/gmail/disconnect','POST',{});await refresh()}catch(e){byId('message').textContent='Unable to revoke the connection. Try again or revoke Postmaster in your Google account.'}};
byId('forget').onclick=async()=>{if(!confirm('Remove the stored connection? This does not revoke access at Google or delete backup copies.'))return;try{await api('/api/gmail/forget','POST',{});await refresh()}catch(e){byId('message').textContent='Unable to remove the connection.'}};
byId('save-config').onclick=async()=>{try{const value=JSON.parse(byId('config-text').value);let extra={};if(value.settings&&!value.settings.dry_run){if(!confirm('Live mode can modify your Gmail. Save?'))return;extra={'X-Confirm-Live':'yes'}}await api('/api/config','PUT',value,extra);byId('message').textContent='Configuration saved; changes take effect next cycle.';await refresh()}catch(e){byId('message').textContent='Invalid configuration or unable to save.'}};
byId('processing-button').onclick=async()=>{try{if(session.processingRequested)await api('/api/processing/stop','POST',{});else{const config=await api('/api/config');let confirmLive=false;if(!config.settings.dry_run){if(!confirm('Live mode can modify your Gmail. Start?'))return;confirmLive=true}await api('/api/processing/start','POST',{confirmLive})}await refresh()}catch(e){byId('message').textContent='Unable to change processing state.'}};
byId('logout').onclick=async()=>{try{await api('/api/logout','POST',{});location.reload()}catch(e){byId('message').textContent=e.message}};
refresh().catch(()=>{byId('message').textContent='Unable to load your session.'});
</script></body></html>`;
