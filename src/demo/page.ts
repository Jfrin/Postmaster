import { BETA_PAGE } from '../beta/page.js';
import type { Config } from '../config.js';

/** Use the actual beta dashboard with a strictly synthetic, browser-only backend. */
export function demoPage(config: Config): string {
  // Escape script delimiters even if the demo configuration is ever changed.
  const sampleConfig = JSON.stringify(config).replaceAll('<', '\\u003c');
  const adapter = String.raw`
// No beta endpoint is called: all dashboard data and edits stay in this page.
var demoConfig=__DEMO_CONFIG__;
var demoSession={email:'preview@example.com',request:{active:true,status:'approved',expiresAt:Date.UTC(2030,0,1)},gmailReady:true,gmailConnected:true,gmailAvailable:true,configAvailable:true,processingOnline:true,processingRequested:false,usage:{attempts:6,limit:100,processed:6,failed:0}};
var demoDecisions=[
 {created_at:'2026-11-05T09:00:00Z',sender:'orders@example.com',subject:'Your order shipped',category:'receipts',confidence:.95,source:'mock',applied:false},
 {created_at:'2026-11-05T08:55:00Z',sender:'digest@example.com',subject:'Your weekly reading list',category:'newsletters',confidence:.90,source:'mock',applied:false},
 {created_at:'2026-11-05T08:50:00Z',sender:'security@example.com',subject:'New sign-in alert',category:'security',confidence:.98,source:'mock',applied:false},
 {created_at:'2026-11-05T08:45:00Z',sender:'shop@example.com',subject:'Spring offers are here',category:'promotions',confidence:.92,source:'mock',applied:false},
 {created_at:'2026-11-05T08:40:00Z',sender:'updates@example.com',subject:'This month\x27s highlights',category:'newsletters',confidence:.91,source:'mock',applied:false},
 {created_at:'2026-11-05T08:35:00Z',sender:'billing@example.com',subject:'Payment confirmation',category:'receipts',confidence:.96,source:'mock',applied:false}
];
var demoEvents=[{occurred_at:'2026-11-05T09:00:00Z',event:'cycle_completed',seen:6,processed:6,failed:0},{occurred_at:'2026-11-05T08:35:00Z',event:'cycle_started'}];
api=async function(path,method,body){
 if(path==='/api/session'&&(!method||method==='GET'))return JSON.parse(JSON.stringify(demoSession));
 if(path==='/api/config'&&(!method||method==='GET'))return JSON.parse(JSON.stringify(demoConfig));
 if(path==='/api/config'&&method==='PUT'){demoConfig=JSON.parse(JSON.stringify(body));return JSON.parse(JSON.stringify(demoConfig))}
 if(path==='/api/activity'&&(!method||method==='GET')){recentDecisions=demoDecisions;return demoDecisions}
 if(path==='/api/processing/events'&&(!method||method==='GET'))return demoEvents;
 throw new Error('Unavailable in the synthetic demo');
};
var demoHeader=header;header=function(){demoHeader();$('#runbtn').disabled=true;$('#runbtn').title='Not available in the demo';$('#mode').textContent=savedDryRun?'DEMO DRY RUN':'DEMO LIVE PREVIEW';$('#run').textContent='Example · Stopped'};
access=function(){fill($('#main'),h('div',{class:'card'},h('h2',null,'Account'),h('p',null,'Example account: preview@example.com'),h('p',null,'Example approval until '+new Date(demoSession.request.expiresAt).toLocaleString()),h('p',null,'Daily Gmail read-attempt limit: 100 · Used today: 6 · Remaining: 94'),h('p',{class:'hint'},'Example values only. No account is signed in and no Gmail connection exists.'),h('button',{class:'btn',disabled:true},'Request access')),h('div',{class:'card'},h('h2',null,'Gmail connection'),h('p',null,'No Gmail connection in the demo.'),h('button',{class:'btn',disabled:true},'Connect Gmail')))};
var demoAccount=access;access=function(){demoAccount();$('#main').append(h('div',{class:'card'},h('h2',null,'Your data'),h('p',null,'Example only: the beta offers separate deletion controls and automatic cleanup of temporary email display data.'),['Delete email content data','Delete decision cache data','Delete other account data','Delete all data','Delete account'].map(function(label){return h('div',null,h('h2',null,label),h('button',{class:'ghost danger',disabled:true},label))}))) };
var demoTabs=tabs;tabs=function(){demoTabs();$('#tabs').append(h('button',{class:tab==='try'?'on':'',onclick:function(){tab='try';render()}},'Try it'))};
var demoRender=render;render=function(){if(tab!=='try'){demoRender();return}tabs();header();overview();fill($('#main'),h('div',{class:'card'},h('h2',null,'Try a synthetic message'),h('p',{class:'hint'},'Mock classifier only. Do not enter real or sensitive email; results are not saved.'),h('form',{onsubmit:async function(e){e.preventDefault();var out=$('#demo-result');out.textContent='Classifying...';try{var r=await fetch('/api/try',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:$('#demo-from').value,subject:$('#demo-subject').value,body:$('#demo-body').value})});var x=await r.json();out.textContent=r.ok?'Category: '+x.category+' · Confidence: '+Math.round(x.confidence*100)+'% · '+x.reason:'Unable to classify this example.'}catch(e){out.textContent='Unable to classify this example.'}}},field('From',h('input',{id:'demo-from',value:'orders@example.com',maxlength:'500',required:true})),field('Subject',h('input',{id:'demo-subject',value:'Your order shipped',maxlength:'1000',required:true})),field('Body',h('textarea',{id:'demo-body',value:'Your synthetic order has shipped.',maxlength:'20000',required:true})),h('p',null,h('button',{class:'btn',type:'submit'},'Classify'))),h('p',{id:'demo-result',role:'status'})))};
$('#logout').disabled=true;$('#logout').title='Not available in the demo';
`;
  const marker = "window.addEventListener('beforeunload'";
  if (!BETA_PAGE.includes(marker)) throw new Error('Beta dashboard initialization changed');
  return BETA_PAGE.replace('__BETA_BASE_PATH__', '"/demo"')
    .replace('<title>Postmaster beta</title>', '<title>Postmaster demo</title>')
    .replace('>BETA</span>', '>DEMO</span>')
    .replace('Connection stored and ready locally', 'Example connection (not actually connected)')
    .replace(
      'After changing settings, press Save. Changes apply on the next scan; no restart is required. To start a new scan sooner, Stop then Start (in-flight requests may finish).',
      'Explore the dashboard with example data. Save keeps edits in this page only; no scans run.',
    )
    .replace('Saved. Changes take effect next cycle.', 'Saved in this demo page only.')
    .replace(
      '<section id="setup"',
      '<div class="setup" role="note"><strong>Synthetic demo only.</strong> No Gmail connection or Azure model calls. All activity, account details and usage are examples. Changes stay in this page and disappear on reload; Start and account actions are unavailable. Do not enter real or sensitive email.</div><section id="setup"',
    )
    .replace(marker, () => adapter.replace('__DEMO_CONFIG__', () => sampleConfig) + marker);
}
