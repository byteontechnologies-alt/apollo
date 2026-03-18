require('dotenv').config();
const express=require('express'),cors=require('cors'),axios=require('axios'),nodemailer=require('nodemailer'),Imap=require('imap'),{simpleParser}=require('mailparser'),cron=require('node-cron'),path=require('path'),fs=require('fs'),low=require('lowdb'),FileSync=require('lowdb/adapters/FileSync'),multer=require('multer'),csvParser=require('csv-parser');

// ── Database ──────────────────────────────────────────────────────────────
const DATA_DIR=path.join(__dirname,'data');
if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true});
const db=low(new FileSync(path.join(DATA_DIR,'leadforge.json')));
db.defaults({leads:[],contacts:[],emails:[],activity_log:[],_nextId:{leads:1,contacts:1,emails:1,activity_log:1}}).write();
function nextId(t){const id=db.get(`_nextId.${t}`).value();db.set(`_nextId.${t}`,id+1).write();return id;}
function getAllLeads(){return db.get('leads').value().map(l=>{const c=db.get('contacts').filter({lead_id:l.id}).value();return{...l,contact_count:c.length,total_sent:c.reduce((a,x)=>a+(x.emails_sent||0),0),has_reply:c.some(x=>x.status==='replied')?1:0};}).reverse();}
function getLeadById(id){return db.get('leads').find({id:Number(id)}).value();}
function insertLead(d){const id=nextId('leads');db.get('leads').push({id,company:d.company||'',website:d.website||null,industry:d.industry||null,size:d.size||null,location:d.location||null,source:d.source||'manual',notes:d.notes||null,status:'new',created_at:new Date().toISOString(),updated_at:new Date().toISOString()}).write();return{lastInsertRowid:id};}
function getContactsByLeadId(lid){return db.get('contacts').filter({lead_id:Number(lid)}).value();}
function getContactById(id){return db.get('contacts').find({id:Number(id)}).value();}
function insertContact(d){const id=nextId('contacts');db.get('contacts').push({id,lead_id:Number(d.lead_id),name:d.name||'Unknown',first_name:d.first_name||'there',role:d.role||'',email:d.email||null,linkedin:d.linkedin||null,status:'new',emails_sent:0,last_sent:null,replied_at:null,created_at:new Date().toISOString()}).write();return{lastInsertRowid:id};}
function updateContactEmail(id,email){db.get('contacts').find({id:Number(id)}).assign({email}).write();}
function markContactSent(id){const c=db.get('contacts').find({id:Number(id)}).value();if(!c)return;db.get('contacts').find({id:Number(id)}).assign({emails_sent:(c.emails_sent||0)+1,last_sent:new Date().toISOString(),status:c.status==='new'?'sent':'followup'}).write();}
function markContactReplied(id){db.get('contacts').find({id:Number(id)}).assign({status:'replied',replied_at:new Date().toISOString()}).write();}
function getContactsDueForFollowup(){const days=(process.env.FOLLOWUP_DAYS||'3,7,14').split(',').map(Number),min=Math.min(...days);return db.get('contacts').filter(c=>['sent','followup'].includes(c.status)&&c.email&&c.last_sent&&c.emails_sent<days.length+1&&(Date.now()-new Date(c.last_sent).getTime())/86400000>=min).value().map(c=>{const l=getLeadById(c.lead_id);return{...c,company:l?l.company:''};});}
function getContactsNotYetEmailed(){return db.get('contacts').filter(c=>c.status==='new'&&c.email).value().slice(0,parseInt(process.env.MAX_EMAILS_PER_DAY)||30).map(c=>{const l=getLeadById(c.lead_id);return{...c,company:l?l.company:''};});}
function getEmailsByLeadId(lid){return db.get('emails').filter({lead_id:Number(lid)}).value().map(e=>{const c=getContactById(e.contact_id);return{...e,contact_name:c?c.name:'',contact_role:c?c.role:''};});}
function insertEmail(d){const id=nextId('emails');db.get('emails').push({id,contact_id:Number(d.contact_id),lead_id:Number(d.lead_id),direction:d.direction,subject:d.subject||'',body:d.body||'',from_addr:d.from_addr||'',to_addr:d.to_addr||'',template_num:d.template_num||null,message_id:d.message_id||null,sent_at:new Date().toISOString()}).write();return{lastInsertRowid:id};}
function dbLog(icon,title,detail){console.log(`[${icon}] ${title}${detail?' — '+detail:''}`);const id=nextId('activity_log');db.get('activity_log').push({id,icon,title,detail:detail||'',created_at:new Date().toISOString()}).write();}
function getRecentActivity(limit=50){return db.get('activity_log').value().slice(-limit).reverse();}
function getStats(){const l=db.get('leads').value(),c=db.get('contacts').value(),e=db.get('emails').value();return{total_leads:l.length,total_contacts:c.length,emails_found:c.filter(x=>x.email).length,contacted:c.filter(x=>x.emails_sent>0).length,total_sent:c.reduce((a,x)=>a+(x.emails_sent||0),0),followups_due:c.filter(x=>x.status==='followup').length,total_replies:c.filter(x=>x.status==='replied').length,emails_out:e.filter(x=>x.direction==='out').length};}

// ── Email templates ───────────────────────────────────────────────────────
const TPLS={1:{sub:'IT Staff Augmentation for {{company_name}}?',body:'Hi {{first_name}},\n\nI noticed {{company_name}} is actively building its tech team.\n\nWe help US companies staff up with pre-vetted IT professionals (React, Node.js, Python, DevOps, QA) ready in 5-7 business days — 40-60% less than full-time hiring.\n\nOpen to a quick 15-min call this week?\n\nBest,\n{{your_name}}\n{{your_company}}\n{{your_phone}} · {{your_website}}'},2:{sub:'Re: IT Staff Augmentation for {{company_name}}?',body:'Hi {{first_name}},\n\nFollowing up — we recently helped a SaaS company stand up a 3-person React + Node team in under a week.\n\nWorth a 15-min call?\n\n{{your_name}}\n{{your_company}}'},3:{sub:'One more thought — {{company_name}}',body:'Hi {{first_name}},\n\nOur clients say the biggest win is scaling back down just as fast — no layoffs, no notice periods.\n\nHappy to send a one-pager.\n\n{{your_name}}\n{{your_company}}'},4:{sub:'Closing the loop — {{company_name}}',body:'Hi {{first_name}},\n\nI\'ll leave it here — if IT staffing needs come up, feel free to reach out anytime.\n\nWishing {{company_name}} all the best.\n\n{{your_name}}\n{{your_company}}'}};
function fillTpl(t,v){let s=t.sub,b=t.body;for(const[k,val]of Object.entries(v)){s=s.replaceAll(`{{${k}}}`,val||'');b=b.replaceAll(`{{${k}}}`,val||'');}return{subject:s,body:b};}

// ── SMTP ──────────────────────────────────────────────────────────────────
// ── Gmail API (OAuth2 — no SMTP port blocking) ───────────────────────────
const {google} = require('googleapis');

function getOAuth2Client(){
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI||'https://apollo-production-7a77.up.railway.app/auth/callback'
  );
  if(process.env.GMAIL_REFRESH_TOKEN){
    client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  }
  return client;
}

function makeRawEmail({to, toName, subject, body, fromName, fromEmail}){
  const msg = [
    `From: "${fromName}" <${fromEmail}>`,
    `To: ${toName?`"${toName}" <${to}>`:to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body
  ].join('\r\n');
  return Buffer.from(msg).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function gmailSend({to, toName, subject, body}){
  const auth = getOAuth2Client();
  const gmail = google.gmail({version:'v1', auth});
  const raw = makeRawEmail({
    to, toName, subject, body,
    fromName: process.env.SMTP_FROM_NAME||'LeadForge',
    fromEmail: process.env.GMAIL_SEND_AS||process.env.SMTP_USER
  });
  const r = await gmail.users.messages.send({ userId:'me', requestBody:{ raw } });
  return r.data;
}

async function testSmtp(){
  if(!process.env.GMAIL_REFRESH_TOKEN){
    return {ok:false, error:'Not authorised yet — visit /auth/start to connect your Gmail account'};
  }
  try {
    const auth = getOAuth2Client();
    const gmail = google.gmail({version:'v1', auth});
    const profile = await gmail.users.getProfile({userId:'me'});
    dbLog('✅','Gmail API connected', profile.data.emailAddress);
    return {ok:true, email: profile.data.emailAddress};
  } catch(e) {
    dbLog('❌','Gmail API failed', e.message);
    return {ok:false, error: e.message};
  }
}

async function sendEmail({contact,lead,emailNum=1,dryRun=false}){
  const t=TPLS[emailNum]||TPLS[1];
  const{subject,body}=fillTpl(t,{
    first_name:contact.first_name||contact.name?.split(' ')[0]||'there',
    company_name:lead.company, role:contact.role,
    your_name:process.env.SMTP_FROM_NAME||'Your Name',
    your_company:process.env.YOUR_COMPANY||'',
    your_phone:process.env.YOUR_PHONE||'',
    your_website:process.env.YOUR_WEBSITE||''
  });
  if(dryRun){dbLog('👁','DRY RUN',`To:${contact.email}|${subject}`);return{ok:true,dryRun:true,subject,body};}
  try {
    await gmailSend({to:contact.email, toName:contact.name, subject, body});
    insertEmail({contact_id:contact.id,lead_id:lead.id||contact.lead_id,direction:'out',subject,body,from_addr:process.env.SMTP_USER,to_addr:contact.email,template_num:emailNum,message_id:null});
    markContactSent(contact.id);
    dbLog('📤',`Email #${emailNum} sent`,`${lead.company}→${contact.name}`);
    return{ok:true};
  } catch(e){
    dbLog('❌','Send failed',e.message);
    return{ok:false,error:e.message};
  }
}

async function sendNotif({contactName,companyName,replyBody}){
  if(!process.env.NOTIFY_EMAIL) return;
  try {
    await gmailSend({
      to: process.env.NOTIFY_EMAIL,
      subject: `Reply from ${companyName} — ${contactName}`,
      body: `New reply!\n\nCompany: ${companyName}\nContact: ${contactName}\n\n${replyBody||''}`
    });
  } catch(e){}
}
function delay(s){return new Promise(r=>setTimeout(r,Math.max(5000,(s+(Math.random()-.5)*60)*1000)));}

// ── Hunter.io email finder ─────────────────────────────────────────────────
async function findEmailHunter(firstName, lastName, domain){
  const key = process.env.HUNTER_API_KEY;
  if(!key) return null;
  try {
    const r = await axios.get('https://api.hunter.io/v2/email-finder', {
      params: { first_name:firstName, last_name:lastName, domain, api_key:key },
      timeout: 10000
    });
    return r.data?.data?.email || null;
  } catch(e) { return null; }
}
async function findEmailsByDomain(domain){
  const key = process.env.HUNTER_API_KEY;
  if(!key) return [];
  try {
    const r = await axios.get('https://api.hunter.io/v2/domain-search', {
      params: { domain, api_key:key, limit:5 },
      timeout: 10000
    });
    return r.data?.data?.emails || [];
  } catch(e) { return []; }
}
async function enrichContactsWithHunter(){
  const contacts = db.get('contacts').filter(c=>!c.email).value();
  let found = 0;
  for(const c of contacts){
    const lead = getLeadById(c.lead_id);
    if(!lead?.website) continue;
    const domain = lead.website.replace(/^https?:\/\//,'').replace(/\/.*/,'');
    const nameParts = c.name.split(' ');
    const email = await findEmailHunter(nameParts[0], nameParts[1]||'', domain);
    if(email){ updateContactEmail(c.id, email); found++; dbLog('🔍','Email found via Hunter',`${c.name} → ${email}`); }
    await new Promise(r=>setTimeout(r,1000));
  }
  return found;
}

// ── CSV Import (from Apollo export) ───────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits:{ fileSize: 10*1024*1024 } });

function parseApolloCSV(buffer){
  return new Promise((resolve, reject) => {
    const results = [];
    const stream = require('stream');
    const readable = new stream.Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(csvParser())
      .on('data', row => results.push(row))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

function detectAndNormalizeRow(row){
  // ── Waalaxy export format ──
  // Waalaxy columns: First name, Last name, Occupation, Company, LinkedIn profile URL
  if('First name' in row || 'Firstname' in row || 'firstName' in row){
    const firstName = row['First name']||row['Firstname']||row['firstName']||'';
    const lastName  = row['Last name']||row['Lastname']||row['lastName']||'';
    return {
      name:     `${firstName} ${lastName}`.trim()||'Unknown',
      firstName: firstName,
      company:  row['Company']||row['company']||row['Organization']||'',
      role:     row['Occupation']||row['occupation']||row['Job title']||row['Position']||'',
      email:    row['Email']||row['email']||'',
      linkedin: row['LinkedIn profile URL']||row['LinkedIn']||row['linkedin']||row['Profile URL']||'',
      website:  row['Website']||row['Company website']||'',
      location: row['Location']||row['City']||'',
      industry: row['Industry']||'',
      source:   'waalaxy',
    };
  }
  // ── Apollo export format ──
  const firstName = row['First Name']||row['first_name']||'';
  const lastName  = row['Last Name']||row['last_name']||'';
  const fullName  = row['Name']||row['name']||row['Full Name']||`${firstName} ${lastName}`.trim()||'Unknown';
  return {
    name:     fullName,
    firstName: fullName.split(' ')[0]||'there',
    company:  row['Company']||row['company']||row['Organization Name']||'',
    role:     row['Title']||row['title']||row['Job Title']||'',
    email:    row['Email']||row['email']||row['Work Email']||'',
    linkedin: row['LinkedIn Url']||row['linkedin_url']||row['LinkedIn']||'',
    website:  row['Website']||row['Company Website']||'',
    location: row['City']||row['city']||row['Location']||'',
    industry: row['Industry']||row['industry']||'',
    source:   'apollo',
  };
}

async function importFromCSV(buffer){
  const rows = await parseApolloCSV(buffer);
  if(!rows.length) return {leadsAdded:0,contactsAdded:0,skipped:0,total:0};

  let leadsAdded=0, contactsAdded=0, skipped=0;
  const byCompany = {};

  for(const row of rows){
    const p = detectAndNormalizeRow(row);
    if(!p.company){ skipped++; continue; }
    const coKey = p.company.toLowerCase().trim();
    if(!byCompany[coKey]) byCompany[coKey]={ company:p.company, website:p.website, industry:p.industry, location:p.location, source:p.source, people:[] };
    byCompany[coKey].people.push(p);
  }

  const maxContacts = parseInt(process.env.CONTACTS_PER_COMPANY)||2;

  for(const [coKey, {company,website,industry,location,source,people}] of Object.entries(byCompany)){
    // Skip duplicate companies — just add new contacts
    const exists = db.get('leads').find(l=>l.company.toLowerCase().trim()===coKey).value();
    if(exists){
      for(const p of people.slice(0,maxContacts)){
        const dup = db.get('contacts').find(c=>c.lead_id===exists.id&&c.name===p.name).value();
        if(!dup){ insertContact({lead_id:exists.id,name:p.name,first_name:p.firstName||p.name.split(' ')[0]||'there',role:p.role,email:p.email||null,linkedin:p.linkedin||null}); contactsAdded++; }
      }
      continue;
    }
    const r = insertLead({company,website,industry,size:null,location,source,notes:`Imported from ${source==='waalaxy'?'Waalaxy':'Apollo.io'} CSV`});
    leadsAdded++;
    for(const p of people.slice(0,maxContacts)){
      insertContact({lead_id:r.lastInsertRowid,name:p.name,first_name:p.firstName||p.name.split(' ')[0]||'there',role:p.role,email:p.email||null,linkedin:p.linkedin||null});
      contactsAdded++;
    }
  }

  dbLog('📋',`CSV import complete (${rows[0]&&'First name' in rows[0]?'Waalaxy':'Apollo'} format)`,`${leadsAdded} companies, ${contactsAdded} contacts, ${skipped} skipped`);
  return{leadsAdded,contactsAdded,skipped,total:rows.length};
}

// ── Reply watcher ─────────────────────────────────────────────────────────
async function checkForReplies(){return new Promise(resolve=>{const imap=new Imap({user:process.env.SMTP_USER,password:process.env.SMTP_PASS,host:process.env.IMAP_HOST||'imap.hostinger.com',port:993,tls:true,tlsOptions:{rejectUnauthorized:false},connTimeout:15000,authTimeout:15000});let found=0;imap.once('ready',()=>{imap.openBox('INBOX',false,(err)=>{if(err){imap.end();return resolve(0);}const since=new Date();since.setDate(since.getDate()-30);imap.search(['UNSEEN',['SINCE',since.toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric'})]],async(err,uids)=>{if(err||!uids?.length){imap.end();return resolve(0);}const fetch=imap.fetch(uids,{bodies:'',markSeen:false});const promises=[];fetch.on('message',msg=>{const p=new Promise(res=>{let buf='';msg.on('body',s=>s.on('data',d=>buf+=d.toString()));msg.once('end',async()=>{try{const parsed=await simpleParser(buf);const fe=parsed.from?.value?.[0]?.address?.toLowerCase();if(!fe)return res();const contact=db.get('contacts').filter(c=>c.email&&c.email.toLowerCase()===fe).value()[0];if(contact&&contact.status!=='replied'){found++;markContactReplied(contact.id);const lead=getLeadById(contact.lead_id);insertEmail({contact_id:contact.id,lead_id:contact.lead_id,direction:'in',subject:parsed.subject||'',body:parsed.text||'',from_addr:fe,to_addr:process.env.SMTP_USER,template_num:null,message_id:parsed.messageId||null});dbLog('💬','REPLY!',`${lead?.company}—${contact.name}`);await sendNotif({contactName:contact.name,companyName:lead?.company||'',replyBody:(parsed.text||'').substring(0,500)});}}catch(e){}res();});});promises.push(p);});fetch.once('end',async()=>{await Promise.all(promises);imap.end();resolve(found);});});});});imap.once('error',()=>resolve(0));imap.once('end',()=>{});imap.connect();});}

// ── Job Board Scrapers (RSS + Public APIs — no bot blocking) ─────────────

function extractDomain(url=''){
  try{ return new URL(url.startsWith('http')?url:'https://'+url).hostname.replace('www.',''); }
  catch(e){ return ''; }
}

function leadExists(company){
  return !!db.get('leads').find(l=>l.company.toLowerCase().trim()===company.toLowerCase().trim()).value();
}

// ── 1. Indeed RSS (most reliable — official feed) ────────────────────────
async function scrapeIndeed(){
  const results = [];
  const keywords = [
    'React+developer','Node.js+developer','Python+developer',
    'Full+stack+developer','DevOps+engineer','Software+engineer',
    'Mobile+developer','Backend+developer'
  ];
  for(const kw of keywords){
    try{
      const url = `https://www.indeed.com/rss?q=${kw}&l=United+States&sort=date&fromage=7`;
      const r = await axios.get(url,{
        headers:{'User-Agent':'Mozilla/5.0 (compatible; RSS/2.0)','Accept':'application/rss+xml,text/xml'},
        timeout:20000
      });
      const xml = r.data;
      // Parse items from RSS
      const items = xml.split('<item>').slice(1);
      for(const item of items.slice(0,8)){
        const title   = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s)||item.match(/<title>(.*?)<\/title>/s)||[])[1]||'';
        const desc    = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s)||[])[1]||'';
        const link    = (item.match(/<link>(.*?)<\/link>/s)||[])[1]||'';
        // Extract company from title: "Job Title - Company Name"
        const dashIdx = title.lastIndexOf(' - ');
        const company = dashIdx>0 ? title.substring(dashIdx+3).trim() : '';
        if(company && company.length>1 && company.length<60 && !company.toLowerCase().includes('indeed')){
          results.push({company, source:'indeed', link, notes:`Indeed: hiring ${kw.replace('+',' ')}`});
        }
      }
    }catch(e){}
    await new Promise(r=>setTimeout(r,1500));
  }
  dbLog('💼','Indeed RSS',`${results.length} job posts found`);
  return results;
}

// ── 2. HackerNews "Who is Hiring" (monthly thread) ───────────────────────
async function scrapeHNHiring(){
  const results = [];
  try{
    // Search HN for the latest "Who is Hiring" thread
    const search = await axios.get('https://hn.algolia.com/api/v1/search?query=Ask+HN+Who+is+hiring&tags=story&restrictSearchableAttributes=title',{timeout:10000});
    const hits = search.data?.hits||[];
    const thread = hits.find(h=>h.title?.includes('Who is Hiring'));
    if(!thread) return results;

    // Get the thread comments
    const comments = await axios.get(`https://hn.algolia.com/api/v1/items/${thread.objectID}`,{timeout:15000});
    const children = comments.data?.children||[];

    for(const comment of children.slice(0,50)){
      const text = comment?.text||'';
      if(!text) continue;
      // Extract company name — HN hiring posts start with "Company | Location | ..."
      const pipeMatch = text.match(/^<p>([^|<]{2,50})\s*\|/);
      const company = pipeMatch?pipeMatch[1].trim():'';
      if(company && company.length>1){
        // Check if it mentions outsourcing-relevant roles
        const relevant = /react|node|python|javascript|typescript|devops|backend|frontend|fullstack|full.stack|engineer|developer/i.test(text);
        if(relevant){
          results.push({company, source:'hackernews', notes:'HN Who is Hiring — tech roles'});
        }
      }
    }
    dbLog('🔶','HackerNews Hiring',`${results.length} companies found`);
  }catch(e){ dbLog('⚠️','HN error',e.message); }
  return results;
}

// ── 3. YCombinator Jobs (official page) ──────────────────────────────────
async function scrapeYC(){
  const results = [];
  try{
    // Use HN Algolia API to find YC job posts
    const r = await axios.get('https://hn.algolia.com/api/v1/search?query=hiring&tags=job&hitsPerPage=50',{timeout:15000});
    const hits = r.data?.hits||[];
    for(const hit of hits){
      const company = hit.author||'';
      const text = hit.title||hit.story_text||'';
      if(company && text){
        const relevant = /react|node|python|developer|engineer|devops|frontend|backend/i.test(text);
        if(relevant) results.push({company, source:'ycombinator', notes:`YC Jobs: ${text.substring(0,80)}`});
      }
    }
    dbLog('🚀','YC Jobs',`${results.length} companies found`);
  }catch(e){ dbLog('⚠️','YC error',e.message); }
  return results;
}

// ── 4. RemoteOK API (free public API — no blocking) ──────────────────────
async function scrapeRemoteOK(){
  const results = [];
  try{
    const r = await axios.get('https://remoteok.com/api',{
      headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'},
      timeout:20000
    });
    const jobs = Array.isArray(r.data)?r.data.filter(j=>j.company):[];
    const keywords = ['react','node','python','javascript','typescript','devops','backend','fullstack'];
    for(const job of jobs.slice(0,100)){
      const text = `${job.position||''} ${job.tags?.join(' ')||''}`.toLowerCase();
      const relevant = keywords.some(k=>text.includes(k));
      if(relevant && job.company){
        results.push({
          company: job.company,
          website: job.url||null,
          source: 'remoteok',
          location: 'Remote / USA',
          job_title: job.position||'Developer',
          job_url: `https://remoteok.com/l/${job.slug||''}`,
          job_desc: job.description?job.description.replace(/<[^>]+>/g,'').substring(0,300):'',
          salary: job.salary||'',
          date_posted: job.date||'',
          notes:`RemoteOK: hiring ${job.position||'developer'}${job.salary?' · '+job.salary:''}`
        });
      }
    }
    dbLog('🌍','RemoteOK',`${results.length} companies found`);
  }catch(e){ dbLog('⚠️','RemoteOK error',e.message); }
  return results;
}

// ── 5. Greenhouse Job Board API (public — no auth needed) ────────────────
async function scrapeGreenhouse(){
  const results = [];
  // These are real companies on Greenhouse — publicly accessible
  const companies = [
    'airbnb','stripe','twilio','shopify','hubspot','zendesk','intercom',
    'squarespace','asana','figma','notion','linear','vercel','netlify',
    'planetscale','supabase','clerk','resend','postmark','segment'
  ];
  const keywords = ['react','node','python','engineer','developer','devops','backend','frontend'];
  for(const co of companies.slice(0,10)){
    try{
      const r = await axios.get(`https://boards-api.greenhouse.io/v1/boards/${co}/jobs`,{timeout:8000});
      const jobs = r.data?.jobs||[];
      const relevant = jobs.filter(j=>keywords.some(k=>(j.title||'').toLowerCase().includes(k)));
      if(relevant.length>0){
        const jobTitles = relevant.slice(0,3).map(j=>j.title).join(', ');
        results.push({
          company: co.charAt(0).toUpperCase()+co.slice(1),
          website: `${co}.com`,
          source: 'greenhouse',
          job_title: relevant[0]?.title||'Developer',
          job_url: relevant[0]?.absolute_url||`https://boards.greenhouse.io/${co}`,
          job_desc: `Open roles: ${jobTitles}`,
          notes:`Greenhouse: ${relevant.length} open dev role${relevant.length!==1?'s':''} — ${jobTitles}`
        });
      }
    }catch(e){}
    await new Promise(r=>setTimeout(r,500));
  }
  dbLog('🌱','Greenhouse',`${results.length} companies actively hiring`);
  return results;
}

// ── 6. Google Custom Search API ──────────────────────────────────────────
async function scrapeGoogleCustom(){
  const key = process.env.GOOGLE_SEARCH_KEY;
  const cx  = process.env.GOOGLE_SEARCH_CX;
  if(!key||!cx){ dbLog('⚠️','Google Search','Keys not set'); return []; }

  const results = [];
  const queries = [
    // Job boards — companies actively hiring developers
    '"React developer" hiring "United States" site:lever.co OR site:greenhouse.io',
    '"Node.js developer" hiring remote USA site:lever.co OR site:greenhouse.io',
    '"Python developer" hiring USA site:ashbyhq.com OR site:lever.co',
    '"DevOps engineer" hiring remote USA site:lever.co OR site:workable.com',
    '"Full stack developer" hiring USA site:greenhouse.io OR site:workable.com',
    '"Mobile developer" hiring USA remote site:lever.co OR site:greenhouse.io',
    // LinkedIn posts — people posting hiring needs with salary
    'site:linkedin.com "looking for developer" "per hour" 2025',
    'site:linkedin.com "need a developer" remote 2025',
    'site:linkedin.com "we are hiring" "React" OR "Node.js" OR "Python" 2025',
    'site:linkedin.com "outsource" developer "per hour" 2025',
    // Salary-based searches — the "$35/hr" type posts you mentioned
    '"need developer" "$35" OR "$40" OR "$45" OR "$50" "per hour" remote',
    '"hire developer" "$" "per hour" USA 2025',
    '"IT outsourcing" "looking for" developer USA 2025',
    '"staff augmentation" developer USA remote 2025',
  ];

  for(const q of queries){
    try{
      const r = await axios.get('https://www.googleapis.com/customsearch/v1',{
        params:{ key, cx, q, num:10 },
        timeout:15000
      });
      const items = r.data?.items||[];
      dbLog('🔎','Google',`"${q.substring(0,40)}..." — ${items.length} results`);

      for(const item of items){
        const title   = item.title||'';
        const snippet = item.snippet||'';
        const link    = item.link||'';
        const text    = title+' '+snippet;

        let company='', jobTitle='';
        const atMatch   = title.match(/^(.+?)\s+at\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-|]|$)/);
        const pipeMatch = title.match(/^([A-Z][A-Za-z0-9\s&,\.]+?)\s*[|]\s*(.+)/);
        const dashMatch = title.match(/^(.+?)\s*[-]\s*([A-Z][A-Za-z0-9\s&,\.]{2,40})(?:\s*[-|]|$)/);

        if(atMatch){ jobTitle=atMatch[1].trim(); company=atMatch[2].trim(); }
        else if(pipeMatch){ company=pipeMatch[1].trim(); jobTitle=pipeMatch[2].trim(); }
        else if(dashMatch){ jobTitle=dashMatch[1].trim(); company=dashMatch[2].trim(); }

        if(!company || company.length<2 || company.length>60) continue;
        const skip=['Google','Indeed','LinkedIn','Glassdoor','ZipRecruiter','Facebook','Twitter'];
        if(skip.some(s=>company.includes(s))) continue;

        const salaryM = text.match(/\$(\d+)(?:-(\d+))?\s*(?:\/hr|\/hour|per hour)/i);
        const salary  = salaryM ? `$${salaryM[1]}${salaryM[2]?'-$'+salaryM[2]:''}/hr` : '';
        const expM    = text.match(/(\d+)\+?\s*years?\s*(?:of\s*)?(?:exp|experience)/i);
        const exp     = expM ? `${expM[1]}+ years exp` : '';
        const isLI    = link.includes('linkedin.com');
        const isFB    = link.includes('facebook.com');
        const src     = isLI?'linkedin_posts':isFB?'facebook':'google';

        results.push({
          company, source:src,
          job_title: jobTitle||title.substring(0,60),
          job_url: link,
          job_desc: snippet.substring(0,300),
          salary,
          notes:[
            `Found via Google Search (${src})`,
            jobTitle?`Job: ${jobTitle}`:'',
            salary?`Salary: ${salary}`:'',
            exp?`Experience: ${exp}`:'',
          ].filter(Boolean).join('\n'),
        });
      }
    }catch(e){
      if(e.response?.status===429){ await new Promise(r=>setTimeout(r,10000)); }
      else dbLog('⚠️','Google error',e.message);
    }
    await new Promise(r=>setTimeout(r,1100));
  }

  dbLog('🔎','Google Search done',`${results.length} companies found`);
  return results;
}
// ── Master scraper ────────────────────────────────────────────────────────
async function scrapeAllJobBoards(){
  dbLog('🌐','Job scrape started','Indeed RSS + HackerNews + YC + RemoteOK + Greenhouse');

  const [indeed, hn, yc, remote, greenhouse, google] = await Promise.allSettled([
    scrapeIndeed(),
    scrapeHNHiring(),
    scrapeYC(),
    scrapeRemoteOK(),
    scrapeGreenhouse(),
    scrapeGoogleCustom(),
  ]);

  const all = [
    ...(indeed.value||[]),
    ...(hn.value||[]),
    ...(yc.value||[]),
    ...(remote.value||[]),
    ...(greenhouse.value||[]),
    ...(google.value||[]),
  ];

  // Deduplicate
  const seen = new Set();
  const unique = all.filter(r=>{
    const key = r.company.toLowerCase().trim();
    if(!key||key.length<2||seen.has(key)||leadExists(r.company)) return false;
    seen.add(key);
    return true;
  });

  dbLog('📊','Scrape complete',`${all.length} total → ${unique.length} new unique companies`);

  let added = 0;
  for(const co of unique){
    // Build structured notes with job post details
    const jobDetails = [
      co.notes||'',
      co.job_title ? `Job Title: ${co.job_title}` : '',
      co.job_url   ? `Job Post: ${co.job_url}` : '',
      co.job_desc  ? `Description: ${co.job_desc.substring(0,300)}` : '',
      co.salary    ? `Salary: ${co.salary}` : '',
      co.date_posted ? `Posted: ${co.date_posted}` : '',
    ].filter(Boolean).join('\n');

    const r = insertLead({
      company:co.company, website:co.website||null,
      industry:'Technology', size:null,
      location:co.location||'USA', source:co.source,
      notes:jobDetails,
    });
    insertContact({
      lead_id:r.lastInsertRowid, name:'Unknown',
      first_name:'there', role:'CTO / HR Manager',
      email:null, linkedin:null,
    });
    added++;
  }

  dbLog('✅','Import done',`${added} new companies added`);
  return {total:all.length, unique:unique.length, added};
}

// ── Agent ─────────────────────────────────────────────────────────────────
let agentRunning=false;
async function runAgentCycle({dryRun=false}={}){if(agentRunning)return;agentRunning=true;dbLog('⚡','Agent started',dryRun?'DRY RUN':'LIVE');try{const r=await checkForReplies();if(r>0)dbLog('🎉',`${r} replies`,'');// Scrape job boards for new leads
try{await scrapeAllJobBoards();}catch(e){dbLog('⚠️','Scraper error',e.message);}// Try Hunter.io email enrichment
try{await scrapeAllJobBoards();}catch(e){dbLog('⚠️','Scraper error',e.message);}try{const hunterFound=await enrichContactsWithHunter();if(hunterFound>0)dbLog('🔍','Hunter enrichment',`${hunterFound} emails found`);}catch(e){}
const nc=getContactsNotYetEmailed();let sent=0;const max=parseInt(process.env.MAX_EMAILS_PER_DAY)||30;for(const c of nc){if(sent>=max)break;const l=getLeadById(c.lead_id);if(!l)continue;const res=await sendEmail({contact:c,lead:l,emailNum:1,dryRun});if(res.ok)sent++;if(!dryRun)await delay(parseInt(process.env.EMAIL_DELAY_SECONDS)||90);}const fc=getContactsDueForFollowup();for(const c of fc){if(sent>=max)break;const l=getLeadById(c.lead_id);if(!l)continue;const res=await sendEmail({contact:c,lead:l,emailNum:Math.min(c.emails_sent+1,4),dryRun});if(res.ok)sent++;if(!dryRun)await delay(parseInt(process.env.EMAIL_DELAY_SECONDS)||90);}dbLog('✅','Cycle done',`${sent} emails`);}catch(e){dbLog('❌','Agent error',e.message);}finally{agentRunning=false;}}
function startScheduler(){
  // Full agent run: 9am weekdays (scrape + email)
  cron.schedule('0 9 * * 1-5',()=>runAgentCycle());
  // Afternoon follow-ups: 2pm weekdays
  cron.schedule('0 14 * * 1-5',()=>runAgentCycle());
  // Extra scrape: 6pm weekdays to catch new job posts
  cron.schedule('0 18 * * 1-5',()=>scrapeAllJobBoards().catch(console.error));
  // Reply check: every 15 minutes
  cron.schedule('*/15 * * * *',()=>checkForReplies());
  dbLog('📅','Scheduler active','Scrape+email: 9am & 6pm | Follow-ups: 2pm | Replies: every 15min');
}

// ── Express ───────────────────────────────────────────────────────────────
const app=express();
app.use(cors());
app.use(express.json());

app.get('/healthz',(req,res)=>res.status(200).send('OK'));
app.get('/api/stats',(req,res)=>res.json(getStats()));
app.get('/api/leads',(req,res)=>res.json(getAllLeads()));
app.get('/api/leads/:id',(req,res)=>{const l=getLeadById(req.params.id);if(!l)return res.status(404).json({error:'Not found'});res.json({...l,contacts:getContactsByLeadId(l.id),thread:getEmailsByLeadId(l.id)});});
app.post('/api/leads',(req,res)=>{const{company,website,industry,size,location,source,notes,contacts}=req.body;if(!company)return res.status(400).json({error:'company required'});const r=insertLead({company,website,industry,size,location,source:source||'manual',notes});const lid=r.lastInsertRowid;if(contacts?.length)for(const c of contacts)if(c.name||c.email)insertContact({lead_id:lid,name:c.name||'Unknown',first_name:c.name?.split(' ')[0]||'there',role:c.role||'',email:c.email||null,linkedin:c.linkedin||null});dbLog('➕','Lead added',company);res.json({ok:true,id:lid});});
app.delete('/api/leads/:id',(req,res)=>{db.get('leads').remove({id:Number(req.params.id)}).write();res.json({ok:true});});
app.patch('/api/contacts/:id/email',(req,res)=>{updateContactEmail(req.params.id,req.body.email);res.json({ok:true});});
app.patch('/api/contacts/:id/replied',(req,res)=>{markContactReplied(req.params.id);res.json({ok:true});});
app.post('/api/contacts/:id/send',async(req,res)=>{const c=getContactById(req.params.id);if(!c)return res.status(404).json({error:'Not found'});if(!c.email)return res.status(400).json({error:'No email'});const l=getLeadById(c.lead_id);res.json(await sendEmail({contact:c,lead:l,emailNum:c.emails_sent+1}));});
app.get('/api/activity',(req,res)=>res.json(getRecentActivity(parseInt(req.query.limit)||50)));
app.post('/api/agent/run',async(req,res)=>{const d=req.body?.dry_run===true;runAgentCycle({dryRun:d}).catch(console.error);res.json({ok:true,message:d?'Dry run started':'Agent started'});});
app.post('/api/agent/check-replies',async(req,res)=>res.json({ok:true,replies_found:await checkForReplies()}));
app.get('/api/test/gmail',async(req,res)=>res.json(await testSmtp()));

// Hunter.io test
app.get('/api/test/hunter',async(req,res)=>{
  const key=process.env.HUNTER_API_KEY;
  if(!key) return res.json({ok:false,error:'HUNTER_API_KEY not set'});
  try{
    const r=await axios.get('https://api.hunter.io/v2/account',{params:{api_key:key},timeout:10000});
    res.json({ok:true,plan:r.data?.data?.plan_name,searches_left:r.data?.data?.requests?.searches?.available});
  }catch(e){res.json({ok:false,error:e.response?.data?.errors?.[0]?.details||e.message});}
});

// CSV upload endpoint
app.post('/api/import/csv', upload.single('file'), async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file uploaded'});
  try{
    const result = await importFromCSV(req.file.buffer);
    res.json({ok:true,...result});
  }catch(e){
    res.json({ok:false,error:e.message});
  }
});

// Hunter enrichment endpoint
app.post('/api/scrape',async(req,res)=>{try{res.json({ok:true,...await scrapeAllJobBoards()});}catch(e){res.json({ok:false,error:e.message});}});
app.post('/api/scrape/indeed',async(req,res)=>{try{const r=await scrapeIndeed();res.json({ok:true,found:r.length});}catch(e){res.json({ok:false,error:e.message});}});
app.post('/api/scrape/google',async(req,res)=>{try{const r=await scrapeGoogle();res.json({ok:true,found:r.length});}catch(e){res.json({ok:false,error:e.message});}});
app.post('/api/scrape/yc',async(req,res)=>{try{const r=await scrapeYC();res.json({ok:true,found:r.length});}catch(e){res.json({ok:false,error:e.message});}});
app.post('/api/hunter/enrich',async(req,res)=>{
  try{const found=await enrichContactsWithHunter();res.json({ok:true,emails_found:found});}
  catch(e){res.json({ok:false,error:e.message});}
});

// ── Waalaxy Webhook ──────────────────────────────────────────────────────
// When someone accepts your LinkedIn connection, Waalaxy fires this webhook
// The agent instantly adds them as a lead and starts the email sequence
app.post('/webhook/waalaxy', async(req,res)=>{
  try{
    const data = req.body;
    dbLog('🔗','Waalaxy webhook received', JSON.stringify(data).substring(0,100));

    // Waalaxy sends prospect data in various formats — handle all of them
    const prospects = data.prospects || data.leads || (Array.isArray(data)?data:[data]);

    let added = 0;
    for(const p of prospects){
      // Extract fields from Waalaxy prospect object
      const firstName  = p.firstName||p.first_name||p.firstname||'';
      const lastName   = p.lastName||p.last_name||p.lastname||'';
      const name       = p.name||`${firstName} ${lastName}`.trim()||'Unknown';
      const company    = p.company||p.companyName||p.organization||'';
      const role       = p.occupation||p.title||p.position||p.jobTitle||'';
      const email      = p.email||p.emailAddress||'';
      const linkedin   = p.linkedinUrl||p.linkedin||p.profileUrl||'';
      const website    = p.companyWebsite||p.website||'';
      const location   = p.location||p.city||'';

      if(!company && !name){ continue; }

      // Find or create the lead (company)
      const coName = company || `${name}'s Company`;
      let lead = db.get('leads').find(l=>l.company.toLowerCase().trim()===coName.toLowerCase().trim()).value();

      if(!lead){
        const r = insertLead({
          company:coName, website, industry:null,
          size:null, location, source:'waalaxy',
          notes:`LinkedIn connection accepted via Waalaxy`
        });
        lead = {id: r.lastInsertRowid, company: coName};
        added++;
      }

      // Add contact if not already there
      const exists = db.get('contacts').find(c=>c.lead_id===lead.id&&c.name===name).value();
      if(!exists){
        insertContact({
          lead_id:lead.id, name, first_name:firstName||name.split(' ')[0]||'there',
          role, email:email||null, linkedin
        });
      }

      // If email provided by Waalaxy — start sequence immediately
      if(email){
        dbLog('📤','Waalaxy lead ready to email',`${name} at ${coName} — ${email}`);
      } else {
        dbLog('🔍','Waalaxy lead needs email',`${name} at ${coName} — will search via Hunter`);
        // Try Hunter.io to find email
        if(process.env.HUNTER_API_KEY && website){
          const domain = website.replace(/^https?:\/\//,'').replace(/\/.*/,'');
          const hunterEmail = await findEmailHunter(firstName, lastName, domain);
          if(hunterEmail){
            const contact = db.get('contacts').find(c=>c.lead_id===lead.id&&c.name===name).value();
            if(contact) updateContactEmail(contact.id, hunterEmail);
            dbLog('🎯','Email found via Hunter',`${name} → ${hunterEmail}`);
          }
        }
      }
    }

    dbLog('✅','Waalaxy webhook processed',`${added} new companies added`);
    res.json({ok:true, added, message:'Prospects received and queued for outreach'});

  }catch(e){
    dbLog('❌','Waalaxy webhook error',e.message);
    res.json({ok:false, error:e.message});
  }
});

// Waalaxy webhook test
app.get('/webhook/waalaxy/test',(req,res)=>{
  res.json({
    ok:true,
    message:'Waalaxy webhook is ready!',
    webhook_url:`${req.protocol}://${req.get('host')}/webhook/waalaxy`,
    instructions:'Copy the webhook_url above and paste it into Waalaxy → Settings → Webhooks'
  });
});

// ── Gmail OAuth routes ───────────────────────────────────────────────────
app.get('/auth/start',(req,res)=>{
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({
    access_type:'offline',
    prompt:'consent',
    scope:['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/userinfo.email']
  });
  res.redirect(url);
});

app.get('/auth/callback',async(req,res)=>{
  const {code} = req.query;
  if(!code) return res.send('Error: no code received');
  try {
    const client = getOAuth2Client();
    const {tokens} = await client.getToken(code);
    const refreshToken = tokens.refresh_token;
    if(!refreshToken) return res.send(`
      <h2>⚠ No refresh token received</h2>
      <p>This happens if you already authorised this app before.</p>
      <p><a href="https://myaccount.google.com/permissions">Click here to revoke access</a>, then <a href="/auth/start">try again</a>.</p>
    `);
    res.send(`
      <html><body style="font-family:monospace;padding:40px;background:#0a0c10;color:#e2e8f0;">
      <h2 style="color:#00d4aa;">✅ Gmail Connected!</h2>
      <p>Copy this refresh token and add it to Railway Variables as <strong>GMAIL_REFRESH_TOKEN</strong></p>
      <textarea style="width:100%;height:80px;background:#111827;color:#00d4aa;border:1px solid #1e2d42;padding:10px;font-family:monospace;font-size:12px;">${refreshToken}</textarea>
      <br><br>
      <p>In Railway → Variables → add:</p>
      <code style="background:#111827;padding:10px;display:block;margin:10px 0;">GMAIL_REFRESH_TOKEN = ${refreshToken}</code>
      <p style="color:#94a3b8;">After adding the variable, Railway will restart and your agent will be able to send emails.</p>
      </body></html>
    `);
  } catch(e){
    res.send(`Error: ${e.message}`);
  }
});

const PORT=process.env.PORT||3000;
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n🚀 LeadForge running on port ${PORT}`);
  console.log(`📋 CSV upload: POST /api/import/csv`);
  console.log(`🎯 Hunter enrich: POST /api/hunter/enrich`);
  console.log(`✅ Test: /healthz /api/stats /api/test/gmail /api/test/hunter\n`);
  startScheduler();
  dbLog('🟢','Server started',`Port ${PORT}`);
});
