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

// ── Job Board Scrapers ────────────────────────────────────────────────────

// Helper: extract domain from URL
function extractDomain(url=''){
  try{ return new URL(url.startsWith('http')?url:'https://'+url).hostname.replace('www.',''); }
  catch(e){ return url.replace(/^https?:\/\//,'').split('/')[0].replace('www.',''); }
}

// Helper: extract company website from job posting text
function guessWebsite(company){
  if(!company) return null;
  return company.toLowerCase().replace(/[^a-z0-9]/g,'')+'com';
}

// Helper: deduplicate leads by company name
function leadExists(company){
  return !!db.get('leads').find(l=>l.company.toLowerCase().trim()===company.toLowerCase().trim()).value();
}

// ── 1. Indeed RSS Feed ───────────────────────────────────────────────────
async function scrapeIndeed(keywords=['React developer','Node.js developer','Python developer','DevOps engineer','Full stack developer']){
  const results = [];
  for(const kw of keywords){
    try{
      const encoded = encodeURIComponent(kw);
      const url = `https://www.indeed.com/rss?q=${encoded}&l=United+States&sort=date`;
      const r = await axios.get(url, {
        headers:{'User-Agent':'Mozilla/5.0 (compatible; RSS reader)'},
        timeout:15000
      });
      // Parse RSS XML manually
      const items = r.data.match(/<item>([\s\S]*?)<\/item>/g)||[];
      for(const item of items.slice(0,10)){
        const title   = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||[])[1]||'';
        const company = (item.match(/<source[^>]*>(.*?)<\/source>/)||[])[1]||
                        (item.match(/<![CDATA[^>]*company[^>]*>(.*?)<\/]/)||[])[1]||'';
        const link    = (item.match(/<link>(.*?)<\/link>/)||[])[1]||'';
        const desc    = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)||[])[1]||'';
        // Extract company from description
        const coMatch = desc.match(/company[:\s]+([A-Za-z0-9\s&]+?)[\.<]/i)||
                        desc.match(/<b>([A-Za-z0-9\s&]+?)<\/b>/)||[];
        const coName  = company||coMatch[1]||'';
        if(coName && coName.length>2) results.push({company:coName.trim(), source:'indeed', keyword:kw, link, notes:`Indeed job ad: ${title}`});
      }
    }catch(e){ dbLog('⚠️','Indeed scrape error',e.message); }
    await new Promise(r=>setTimeout(r,2000));
  }
  return results;
}

// ── 2. Google Search Scraper ─────────────────────────────────────────────
async function scrapeGoogle(queries=[
  'site:lever.co "React developer" "United States"',
  'site:greenhouse.io "Node.js" "United States"',
  'site:workable.com "Python developer" "USA"',
  'site:jobs.ashbyhq.com "Full stack developer"',
  '"we are hiring" "React developer" site:linkedin.com/jobs',
  'startup "hiring React developer" USA 2025',
  '"looking for" "Node.js developer" company USA',
]){
  const results = [];
  for(const q of queries){
    try{
      const encoded = encodeURIComponent(q);
      const url = `https://www.google.com/search?q=${encoded}&num=10&hl=en`;
      const r = await axios.get(url, {
        headers:{
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept':'text/html',
          'Accept-Language':'en-US,en;q=0.9',
        },
        timeout:15000
      });
      // Extract result titles and URLs
      const titleMatches = r.data.match(/<h3[^>]*>(.*?)<\/h3>/g)||[];
      const urlMatches   = r.data.match(/https?:\/\/(?:lever\.co|greenhouse\.io|workable\.com|ashbyhq\.com|jobs\.lever\.co)[^"&\s]*/g)||[];
      
      for(const urlMatch of urlMatches.slice(0,8)){
        // Extract company from ATS URLs
        // lever.co/companyname/... greenhouse.io/companyname/...
        const parts = urlMatch.replace(/https?:\/\//,'').split('/');
        const domain = parts[0];
        const company = parts[1]||'';
        if(company && company.length>2 && !company.includes('?')){
          const coName = company.replace(/-/g,' ').replace(/\w/g,c=>c.toUpperCase());
          results.push({
            company: coName,
            website: `${company}.com`,
            source: 'google',
            keyword: q,
            link: urlMatch,
            notes: `Google search: found on ${domain}`
          });
        }
      }

      // Also extract plain company names from titles
      for(const t of titleMatches.slice(0,5)){
        const text = t.replace(/<[^>]+>/g,'');
        const atMatch = text.match(/at ([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|·]|\s*$)/);
        if(atMatch && atMatch[1].length>2 && atMatch[1].length<50){
          results.push({company:atMatch[1].trim(), source:'google', keyword:q, notes:`Google: ${text.substring(0,80)}`});
        }
      }
    }catch(e){ dbLog('⚠️','Google scrape error',e.message); }
    await new Promise(r=>setTimeout(r,3000)); // be polite to Google
  }
  return results;
}

// ── 3. YCombinator Jobs ──────────────────────────────────────────────────
async function scrapeYC(){
  const results = [];
  try{
    const r = await axios.get('https://news.ycombinator.com/jobs', {
      headers:{'User-Agent':'Mozilla/5.0'},
      timeout:15000
    });
    const items = r.data.match(/class="storylink"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)||[];
    for(const item of items.slice(0,20)){
      const urlM = item.match(/href="([^"]+)"/);
      const nameM = item.match(/>([^<]+)<\/a>/);
      if(nameM){
        // Extract company name — usually "Company (YC S24) is hiring..."
        const text = nameM[1];
        const coMatch = text.match(/^([^(]+)/);
        const coName = coMatch?coMatch[1].trim():'';
        if(coName && coName.length>2){
          results.push({company:coName, source:'ycombinator', link:urlM?urlM[1]:'', notes:`YC Jobs: ${text.substring(0,100)}`});
        }
      }
    }
    dbLog('🚀','YC Jobs scraped',`${results.length} companies found`);
  }catch(e){ dbLog('⚠️','YC scrape error',e.message); }
  return results;
}

// ── 4. Wellfound (AngelList) ─────────────────────────────────────────────
async function scrapeWellfound(){
  const results = [];
  try{
    // Wellfound has a public JSON API for job listings
    const roles = ['engineer','developer','engineering'];
    for(const role of roles){
      const r = await axios.get(`https://wellfound.com/role/l/${role}`, {
        headers:{
          'User-Agent':'Mozilla/5.0',
          'Accept':'text/html',
        },
        timeout:15000
      });
      // Extract company names from the page
      const coMatches = r.data.match(/"name":"([^"]{3,50})","type":"Organization"/g)||[];
      for(const m of coMatches.slice(0,15)){
        const name = (m.match(/"name":"([^"]+)"/)||[])[1]||'';
        if(name) results.push({company:name, source:'wellfound', notes:`Wellfound: hiring ${role}`});
      }
      await new Promise(r=>setTimeout(r,2000));
    }
    dbLog('🦗','Wellfound scraped',`${results.length} companies found`);
  }catch(e){ dbLog('⚠️','Wellfound scrape error',e.message); }
  return results;
}

// ── 5. LinkedIn Jobs via Google ──────────────────────────────────────────
async function scrapeLinkedInJobs(){
  const results = [];
  const searches = [
    'site:linkedin.com/jobs "React developer" "United States" "11-50 employees"',
    'site:linkedin.com/jobs "Node.js developer" USA startup',
    'site:linkedin.com/jobs "Python developer" "Series A" OR "Series B"',
    'site:linkedin.com/jobs "Full stack" "remote" "United States"',
  ];
  try{
    for(const q of searches){
      const encoded = encodeURIComponent(q);
      const r = await axios.get(`https://www.google.com/search?q=${encoded}&num=10`, {
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
        timeout:15000
      });
      // Extract company names from LinkedIn job URLs and titles
      const titles = r.data.match(/<h3[^>]*>(.*?)<\/h3>/g)||[];
      for(const t of titles){
        const text = t.replace(/<[^>]+>/g,'');
        // LinkedIn titles format: "Job Title at Company | LinkedIn"
        const atMatch = text.match(/ at ([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*\||\s*-)/);
        if(atMatch && atMatch[1].length>2 && atMatch[1].length<60){
          results.push({company:atMatch[1].trim(), source:'linkedin_jobs', notes:`LinkedIn Jobs: ${text.substring(0,80)}`});
        }
      }
      await new Promise(r=>setTimeout(r,3000));
    }
    dbLog('🔵','LinkedIn Jobs scraped via Google',`${results.length} companies found`);
  }catch(e){ dbLog('⚠️','LinkedIn Jobs scrape error',e.message); }
  return results;
}

// ── Master scraper — runs all sources and imports results ────────────────
async function scrapeAllJobBoards(){
  dbLog('🌐','Job board scrape started','Indeed + Google + YC + Wellfound + LinkedIn Jobs');
  
  const [indeed, google, yc, wellfound, linkedin] = await Promise.allSettled([
    scrapeIndeed(),
    scrapeGoogle(),
    scrapeYC(),
    scrapeWellfound(),
    scrapeLinkedInJobs(),
  ]);

  // Combine all results
  const all = [
    ...(indeed.value||[]),
    ...(google.value||[]),
    ...(yc.value||[]),
    ...(wellfound.value||[]),
    ...(linkedin.value||[]),
  ];

  // Deduplicate by company name
  const seen = new Set();
  const unique = all.filter(r=>{
    const key = r.company.toLowerCase().trim();
    if(seen.has(key)||leadExists(r.company)) return false;
    seen.add(key);
    return true;
  });

  dbLog('📊','Scrape results',`${all.length} total → ${unique.length} new unique companies`);

  // Import into database
  let added = 0;
  for(const co of unique){
    if(!co.company || co.company.length < 2) continue;
    const r = insertLead({
      company: co.company,
      website: co.website||null,
      industry: 'Technology',
      size: null,
      location: co.location||'USA',
      source: co.source,
      notes: co.notes||`Found via ${co.source} — actively hiring developers`,
    });
    // Add a placeholder contact to find later
    insertContact({
      lead_id: r.lastInsertRowid,
      name: 'Unknown',
      first_name: 'there',
      role: 'CTO / HR Manager',
      email: null,
      linkedin: null,
    });
    added++;
  }

  dbLog('✅','Job board import done',`${added} new companies added to pipeline`);
  return { total: all.length, unique: unique.length, added };
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
