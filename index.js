require('dotenv').config();
const express=require('express'),cors=require('cors'),axios=require('axios'),nodemailer=require('nodemailer'),Imap=require('imap'),{simpleParser}=require('mailparser'),cron=require('node-cron'),path=require('path'),fs=require('fs'),multer=require('multer'),csvParser=require('csv-parser');
const{createClient}=require('@libsql/client');

// ── Turso Database (persistent cloud SQLite — survives Railway redeploys) ─
if(!process.env.TURSO_URL||!process.env.TURSO_TOKEN){console.error('❌ TURSO_URL or TURSO_TOKEN missing from Railway variables!');process.exit(1);}
const db=createClient({url:process.env.TURSO_URL,authToken:process.env.TURSO_TOKEN});

async function initDB(){
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY AUTOINCREMENT,company TEXT,website TEXT,industry TEXT,size TEXT,location TEXT,source TEXT DEFAULT 'manual',notes TEXT,status TEXT DEFAULT 'new',created_at TEXT,updated_at TEXT);
    CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id INTEGER,name TEXT DEFAULT 'Unknown',first_name TEXT DEFAULT 'there',role TEXT,email TEXT,linkedin TEXT,status TEXT DEFAULT 'new',emails_sent INTEGER DEFAULT 0,last_sent TEXT,replied_at TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS emails(id INTEGER PRIMARY KEY AUTOINCREMENT,contact_id INTEGER,lead_id INTEGER,direction TEXT,subject TEXT,body TEXT,from_addr TEXT,to_addr TEXT,template_num INTEGER,message_id TEXT,sent_at TEXT);
    CREATE TABLE IF NOT EXISTS activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT,icon TEXT,title TEXT,detail TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT);
  `);
  console.log('✅ Turso DB connected and ready');
}

// ── KV helpers (for Serper daily tracking) ───────────────────────────────
async function kvGet(key){try{const r=await db.execute({sql:'SELECT value FROM kv WHERE key=?',args:[key]});return r.rows[0]?JSON.parse(r.rows[0].value):null;}catch(e){return null;}}
async function kvSet(key,val){await db.execute({sql:'INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)',args:[key,JSON.stringify(val)]});}

// ── DB functions (all async now) ─────────────────────────────────────────
async function getAllLeads(){
  const[leads,contacts]=await Promise.all([
    db.execute('SELECT * FROM leads ORDER BY id DESC'),
    db.execute('SELECT lead_id,status,emails_sent FROM contacts')
  ]);
  return leads.rows.map(l=>{
    const cs=contacts.rows.filter(c=>Number(c.lead_id)===Number(l.id));
    return{...l,id:Number(l.id),contact_count:cs.length,total_sent:cs.reduce((a,x)=>a+(Number(x.emails_sent)||0),0),has_reply:cs.some(x=>x.status==='replied')?1:0};
  });
}
async function getLeadById(id){const r=await db.execute({sql:'SELECT * FROM leads WHERE id=?',args:[Number(id)]});const l=r.rows[0];return l?{...l,id:Number(l.id)}:null;}
async function insertLead(d){const r=await db.execute({sql:'INSERT INTO leads(company,website,industry,size,location,source,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',args:[d.company||'',d.website||null,d.industry||null,d.size||null,d.location||null,d.source||'manual',d.notes||null,'new',new Date().toISOString(),new Date().toISOString()]});return{lastInsertRowid:Number(r.lastInsertRowid)};}
async function getContactsByLeadId(lid){const r=await db.execute({sql:'SELECT * FROM contacts WHERE lead_id=?',args:[Number(lid)]});return r.rows.map(c=>({...c,id:Number(c.id),lead_id:Number(c.lead_id),emails_sent:Number(c.emails_sent)||0}));}
async function getContactById(id){const r=await db.execute({sql:'SELECT * FROM contacts WHERE id=?',args:[Number(id)]});const c=r.rows[0];return c?{...c,id:Number(c.id),lead_id:Number(c.lead_id),emails_sent:Number(c.emails_sent)||0}:null;}
async function insertContact(d){const r=await db.execute({sql:'INSERT INTO contacts(lead_id,name,first_name,role,email,linkedin,status,emails_sent,created_at) VALUES(?,?,?,?,?,?,?,?,?)',args:[Number(d.lead_id),d.name||'Unknown',d.first_name||'there',d.role||'',d.email||null,d.linkedin||null,'new',0,new Date().toISOString()]});return{lastInsertRowid:Number(r.lastInsertRowid)};}
async function updateContactEmail(id,email){await db.execute({sql:'UPDATE contacts SET email=? WHERE id=?',args:[email,Number(id)]});}
async function markContactSent(id){await db.execute({sql:"UPDATE contacts SET emails_sent=emails_sent+1,last_sent=?,status=CASE WHEN status='new' THEN 'sent' ELSE 'followup' END WHERE id=?",args:[new Date().toISOString(),Number(id)]});}
async function markContactReplied(id){await db.execute({sql:"UPDATE contacts SET status='replied',replied_at=? WHERE id=?",args:[new Date().toISOString(),Number(id)]});}
async function getContactsDueForFollowup(){
  const days=(process.env.FOLLOWUP_DAYS||'3,7,14').split(',').map(Number),min=Math.min(...days);
  const r=await db.execute("SELECT c.*,l.company FROM contacts c JOIN leads l ON l.id=c.lead_id WHERE c.status IN('sent','followup') AND c.email IS NOT NULL AND c.last_sent IS NOT NULL");
  return r.rows.filter(c=>Number(c.emails_sent)<days.length+1&&(Date.now()-new Date(c.last_sent).getTime())/86400000>=min).map(c=>({...c,id:Number(c.id),lead_id:Number(c.lead_id),emails_sent:Number(c.emails_sent)||0}));
}
async function getContactsNotYetEmailed(){
  const max=parseInt(process.env.MAX_EMAILS_PER_DAY)||30;
  const r=await db.execute({sql:"SELECT c.*,l.company FROM contacts c JOIN leads l ON l.id=c.lead_id WHERE c.status='new' AND c.email IS NOT NULL LIMIT ?",args:[max]});
  return r.rows.map(c=>({...c,id:Number(c.id),lead_id:Number(c.lead_id),emails_sent:Number(c.emails_sent)||0}));
}
async function getEmailsByLeadId(lid){
  const r=await db.execute({sql:'SELECT e.*,c.name as contact_name,c.role as contact_role FROM emails e LEFT JOIN contacts c ON c.id=e.contact_id WHERE e.lead_id=?',args:[Number(lid)]});
  return r.rows.map(e=>({...e,id:Number(e.id)}));
}
async function insertEmail(d){await db.execute({sql:'INSERT INTO emails(contact_id,lead_id,direction,subject,body,from_addr,to_addr,template_num,message_id,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?)',args:[Number(d.contact_id),Number(d.lead_id),d.direction,d.subject||'',d.body||'',d.from_addr||'',d.to_addr||'',d.template_num||null,d.message_id||null,new Date().toISOString()]});}
async function dbLog(icon,title,detail){console.log(`[${icon}] ${title}${detail?' — '+detail:''}`);try{await db.execute({sql:'INSERT INTO activity_log(icon,title,detail,created_at) VALUES(?,?,?,?)',args:[icon,title,detail||'',new Date().toISOString()]});}catch(e){}}
async function getRecentActivity(limit=50){const r=await db.execute({sql:'SELECT * FROM activity_log ORDER BY id DESC LIMIT ?',args:[limit]});return r.rows;}
async function getStats(){
  const[l,c,ef,ct,ts,fu,tr,eo]=await Promise.all([
    db.execute('SELECT COUNT(*) as n FROM leads'),
    db.execute('SELECT COUNT(*) as n FROM contacts'),
    db.execute('SELECT COUNT(*) as n FROM contacts WHERE email IS NOT NULL'),
    db.execute('SELECT COUNT(*) as n FROM contacts WHERE emails_sent>0'),
    db.execute('SELECT COALESCE(SUM(emails_sent),0) as n FROM contacts'),
    db.execute("SELECT COUNT(*) as n FROM contacts WHERE status='followup'"),
    db.execute("SELECT COUNT(*) as n FROM contacts WHERE status='replied'"),
    db.execute("SELECT COUNT(*) as n FROM emails WHERE direction='out'"),
  ]);
  return{total_leads:Number(l.rows[0].n),total_contacts:Number(c.rows[0].n),emails_found:Number(ef.rows[0].n),contacted:Number(ct.rows[0].n),total_sent:Number(ts.rows[0].n),followups_due:Number(fu.rows[0].n),total_replies:Number(tr.rows[0].n),emails_out:Number(eo.rows[0].n)};
}
async function leadExists(company){const r=await db.execute({sql:'SELECT id FROM leads WHERE LOWER(TRIM(company))=LOWER(TRIM(?))',args:[company]});return r.rows.length>0;}

// ── Serper daily guard (stored in Turso kv table) ─────────────────────────
const SERPER_MAX_LEADS_PER_DAY=parseInt(process.env.SERPER_MAX_LEADS_DAY)||50;
const SERPER_QUERIES_PER_RUN=1;
async function serperFiredToday(){const rec=await kvGet('serperDaily');const today=new Date().toISOString().slice(0,10);return rec&&rec.date===today&&rec.fired===true;}
async function markSerperFiredToday(){const today=new Date().toISOString().slice(0,10);const rec=(await kvGet('serperDaily'))||{};await kvSet('serperDaily',{...rec,date:today,fired:true});}
async function getSerperDailyCount(){const rec=await kvGet('serperDaily');const today=new Date().toISOString().slice(0,10);return(rec&&rec.date===today)?rec.count||0:0;}
async function addSerperDailyCount(n){const today=new Date().toISOString().slice(0,10);const rec=(await kvGet('serperDaily'))||{};await kvSet('serperDaily',{...rec,date:today,count:(rec.count||0)+n});}

// ── Email templates ───────────────────────────────────────────────────────
const TPLS={
  1:{sub:'IT Outsourcing Services for {{company_name}}?',body:'Hi {{first_name}},\n\nI noticed {{company_name}} is looking for IT support — we can help.\n\nByteOn Technologies provides IT outsourcing services including:\n\u2022 Software Development (React, Node.js, Python, Java, Mobile)\n\u2022 QA & Testing | DevOps & Cloud (AWS, Azure, GCP)\n\u2022 IT Support & Managed Services | Data Engineering & AI\n\u2022 Cybersecurity | Project Management\n\nAll resources are pre-vetted, ready in 5-7 business days, 40-60% less than full-time hiring.\n\nWould you be open to a quick 15-min call this week?\n\nBest,\n{{your_name}}\n{{your_company}}\n{{your_phone}} | {{your_website}}'},
  2:{sub:'Re: IT Outsourcing for {{company_name}}',body:'Hi {{first_name}},\n\nFollowing up on my previous note.\n\nWe recently helped a US company cut IT costs by 50% by switching to our outsourcing model — same quality, fraction of the cost, zero hiring overhead.\n\nWhether you need 1 resource or a full team, ready in under a week.\n\nWorth a 15-min call?\n\n{{your_name}}\n{{your_company}}'},
  3:{sub:'One more thought — {{company_name}}',body:"Hi {{first_name}},\n\nThe biggest advantage our clients mention is flexibility — scale up when you need more capacity, scale down when you don't. No layoffs, no notice periods.\n\nHappy to send a one-pager on our services and pricing.\n\n{{your_name}}\n{{your_company}}"},
  4:{sub:'Closing the loop — {{company_name}}',body:"Hi {{first_name}},\n\nI'll leave it here — if IT outsourcing needs come up in the future, feel free to reach out.\n\nWishing {{company_name}} all the best.\n\n{{your_name}}\n{{your_company}}"}
}
function fillTpl(t,v){let s=t.sub,b=t.body;for(const[k,val]of Object.entries(v)){s=s.replaceAll(`{{${k}}}`,val||'');b=b.replaceAll(`{{${k}}}`,val||'');}return{subject:s,body:b};}

// ── Hostinger SMTP (sending) ─────────────────────────────────────────────
function makeTransport(){
  const port = parseInt(process.env.SMTP_PORT)||587;
  return require('nodemailer').createTransport({
    host: process.env.SMTP_HOST||'smtp.hostinger.com',
    port: port,
    secure: port===465,
    requireTLS: port===587,
    auth: { user:process.env.SMTP_USER, pass:process.env.SMTP_PASS },
    connectionTimeout:15000, greetingTimeout:15000, socketTimeout:15000,
    tls:{ rejectUnauthorized:false }
  });
}

async function testSmtp(){
  try{
    await makeTransport().verify();
    await dbLog('✅','Hostinger SMTP connected',process.env.SMTP_USER);
    return{ok:true, email:process.env.SMTP_USER};
  }catch(e){
    await dbLog('❌','Hostinger SMTP failed',e.message);
    return{ok:false,error:e.message};
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
  if(dryRun){await dbLog('👁','DRY RUN',`To:${contact.email}|${subject}`);return{ok:true,dryRun:true,subject,body};}
  try{
    const info = await makeTransport().sendMail({
      from:`"${process.env.SMTP_FROM_NAME}"<${process.env.SMTP_USER}>`,
      to:contact.email, subject, text:body
    });
    insertEmail({contact_id:contact.id,lead_id:lead.id||contact.lead_id,direction:'out',subject,body,from_addr:process.env.SMTP_USER,to_addr:contact.email,template_num:emailNum,message_id:info.messageId});
    markContactSent(contact.id);
    await dbLog('📤',`Email #${emailNum} sent`,`${lead.company}→${contact.name}`);
    return{ok:true,messageId:info.messageId};
  }catch(e){
    await dbLog('❌','Send failed',e.message);
    return{ok:false,error:e.message};
  }
}

async function sendNotif({contactName,companyName,replyBody}){
  if(!process.env.NOTIFY_EMAIL) return;
  try{
    await makeTransport().sendMail({
      from:`"LeadForge"<${process.env.SMTP_USER}>`,
      to:process.env.NOTIFY_EMAIL,
      subject:`Reply from ${companyName} — ${contactName}`,
      text:`New reply!\n\nCompany: ${companyName}\nContact: ${contactName}\n\n${replyBody||''}`
    });
  }catch(e){}
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
async function findCompanyWebsite(companyName){
  const key = process.env.SERPER_API_KEY;
  if(!key) return null;
  try{
    const r = await axios.post('https://google.serper.dev/search',
      { q:`${companyName} official website`, num:1, gl:'us' },
      { headers:{ 'X-API-KEY':key, 'Content-Type':'application/json' }, timeout:10000 }
    );
    const link = r.data?.organic?.[0]?.link||'';
    if(!link) return null;
    const domain = link.replace(/^https?:\/\//,'').replace(/\/.*/,'').replace(/^www\./,'');
    // Skip generic sites
    if(['linkedin','indeed','glassdoor','crunchbase','bloomberg','forbes','wikipedia'].some(s=>domain.includes(s))) return null;
    return domain;
  }catch(e){ return null; }
}

async function enrichContactsWithHunter(){
  const key = process.env.HUNTER_API_KEY;
  if(!key){ await dbLog('⚠️','Hunter skipped','HUNTER_API_KEY not set'); return 0; }

  const contacts = (await db.execute("SELECT c.*,l.website,l.company as lead_company FROM contacts c JOIN leads l ON l.id=c.lead_id WHERE c.email IS NULL")).rows.map(c=>({...c,id:Number(c.id),lead_id:Number(c.lead_id),emails_sent:Number(c.emails_sent)||0}));
  let found = 0;
  let searched = 0;
  const HUNTER_DAILY_LIMIT = 20; // stay well within free 25/month

  for(const c of contacts){
    if(searched >= HUNTER_DAILY_LIMIT) break;
    const lead = await getLeadById(c.lead_id);
    if(!lead) continue;

    // Get domain — from website field, guess from name, or look up via Serper
    let domain = '';
    if(lead.website){
      domain = lead.website.replace(/^https?:\/\//,'').replace(/\/.*/,'').replace(/^www\./,'');
    } else {
      // Guess first: "Stripe Inc" → "stripe.com"
      const guessed = lead.company.toLowerCase()
        .replace(/[^a-z0-9 ]/g,'').replace(/\s+(inc|llc|corp|ltd|co|technologies|tech|solutions|services|group)$/,'')
        .trim().replace(/\s+/g,'')+'.com';
      // Use Serper to verify/find real domain (costs 1 credit per lookup — limit to first 5)
      if(searched < 5 && process.env.SERPER_API_KEY){
        const found = await findCompanyWebsite(lead.company);
        domain = found || guessed;
        if(found) await db.execute({sql:'UPDATE leads SET website=? WHERE id=?',args:['https://'+found,lead.id]});
      } else {
        domain = guessed;
      }
    }
    if(!domain) continue;

    searched++;
    const nameParts = (c.name||'').split(' ');
    const firstName = c.first_name||nameParts[0]||'';
    const lastName  = nameParts[1]||'';

    // Try 1: find specific person's email
    let email = await findEmailHunter(firstName, lastName, domain);

    // Try 2: if person not found, grab any email from the domain
    if(!email && lead.website){
      const domainEmails = await findEmailsByDomain(domain);
      if(domainEmails.length>0){
        email = domainEmails[0].value; // use first email found on domain
        await dbLog('🔍','Hunter domain fallback',`${lead.company} → ${email}`);
      }
    }

    if(email){
      updateContactEmail(c.id, email);
      found++;
      await dbLog('🎯','Hunter email found',`${c.name} at ${lead.company} → ${email}`);
    } else {
      await dbLog('🔍','Hunter no result',`${lead.company} (${domain})`);
    }
    await new Promise(r=>setTimeout(r,1200));
  }

  await dbLog('🔍','Hunter enrichment done',`${found} emails found from ${searched} searches`);
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
    const existsR = await db.execute({sql:'SELECT * FROM leads WHERE LOWER(TRIM(company))=LOWER(TRIM(?))',args:[coKey]});
    const exists = existsR.rows[0]||null;
    if(exists){
      for(const p of people.slice(0,maxContacts)){
        const dupR = await db.execute({sql:'SELECT id FROM contacts WHERE lead_id=? AND name=?',args:[exists.id,p.name]});
          const dup = dupR.rows[0]||null;
        if(!dup){ await insertContact({lead_id:exists.id,name:p.name,first_name:p.firstName||p.name.split(' ')[0]||'there',role:p.role,email:p.email||null,linkedin:p.linkedin||null}); contactsAdded++; }
      }
      continue;
    }
    const r = await insertLead({company,website,industry,size:null,location,source,notes:`Imported from ${source==='waalaxy'?'Waalaxy':'Apollo.io'} CSV`});
    leadsAdded++;
    for(const p of people.slice(0,maxContacts)){
      await insertContact({lead_id:r.lastInsertRowid,name:p.name,first_name:p.firstName||p.name.split(' ')[0]||'there',role:p.role,email:p.email||null,linkedin:p.linkedin||null});
      contactsAdded++;
    }
  }

  await dbLog('📋',`CSV import complete (${rows[0]&&'First name' in rows[0]?'Waalaxy':'Apollo'} format)`,`${leadsAdded} companies, ${contactsAdded} contacts, ${skipped} skipped`);
  return{leadsAdded,contactsAdded,skipped,total:rows.length};
}

// ── Reply watcher ─────────────────────────────────────────────────────────
async function checkForReplies(){return new Promise(resolve=>{const imap=new Imap({user:process.env.SMTP_USER,password:process.env.SMTP_PASS,host:process.env.IMAP_HOST||'imap.hostinger.com',port:993,tls:true,tlsOptions:{rejectUnauthorized:false},connTimeout:15000,authTimeout:15000});let found=0;imap.once('ready',()=>{imap.openBox('INBOX',false,(err)=>{if(err){imap.end();return resolve(0);}const since=new Date();since.setDate(since.getDate()-30);imap.search(['UNSEEN',['SINCE',since.toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric'})]],async(err,uids)=>{if(err||!uids?.length){imap.end();return resolve(0);}const fetch=imap.fetch(uids,{bodies:'',markSeen:false});const promises=[];fetch.on('message',msg=>{const p=new Promise(res=>{let buf='';msg.on('body',s=>s.on('data',d=>buf+=d.toString()));msg.once('end',async()=>{try{const parsed=await simpleParser(buf);const fe=parsed.from?.value?.[0]?.address?.toLowerCase();if(!fe)return res();const contactRes=await db.execute({sql:'SELECT * FROM contacts WHERE LOWER(email)=?',args:[fe]});
              const contact=contactRes.rows[0]||null;if(contact&&contact.status!=='replied'){found++;markContactReplied(contact.id);const lead=await getLeadById(contact.lead_id);insertEmail({contact_id:contact.id,lead_id:contact.lead_id,direction:'in',subject:parsed.subject||'',body:parsed.text||'',from_addr:fe,to_addr:process.env.SMTP_USER,template_num:null,message_id:parsed.messageId||null});await dbLog('💬','REPLY!',`${lead?.company}—${contact.name}`);await sendNotif({contactName:contact.name,companyName:lead?.company||'',replyBody:(parsed.text||'').substring(0,500)});}}catch(e){}res();});});promises.push(p);});fetch.once('end',async()=>{await Promise.all(promises);imap.end();resolve(found);});});});});imap.once('error',()=>resolve(0));imap.once('end',()=>{});imap.connect();});}

// ── Job Board Scrapers (RSS + Public APIs — no bot blocking) ─────────────

function extractDomain(url=''){
  try{ return new URL(url.startsWith('http')?url:'https://'+url).hostname.replace('www.',''); }
  catch(e){ return ''; }
}


// ── 1. Indeed RSS (most reliable — official feed) ────────────────────────
async function scrapeIndeed(){
  const results = [];
  const keywords = [
    // Direct outsourcing intent — highest priority
    'IT+outsourcing+services','IT+staff+augmentation','managed+IT+services',
    'contract+IT+services','IT+vendor+remote','outsource+IT+team',
    // Development — remote contract
    'React+developer+remote+contract','Node.js+developer+remote+contract',
    'Python+developer+remote+contract','Full+stack+developer+remote',
    'Software+engineer+remote+contract','Java+developer+remote+contract',
    'Mobile+developer+remote+contract','PHP+developer+remote',
    // DevOps & Cloud
    'DevOps+engineer+remote+contract','AWS+engineer+remote',
    'Cloud+engineer+remote+contract','Azure+engineer+remote',
    // QA
    'QA+engineer+remote+contract','software+tester+remote',
    // Data & AI
    'data+engineer+remote+contract','AI+developer+remote',
    // IT Support
    'IT+support+remote+contract','helpdesk+remote+outsource',
    // Cybersecurity
    'cybersecurity+engineer+remote+contract',
    // PM
    'IT+project+manager+remote+contract','scrum+master+remote+contract',
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
        const text    = (title+' '+desc).toLowerCase();
        // Remote only — skip on-site/hybrid
        if(!/\bremote\b/.test(text)) continue;
        if(/\bon.?site\b|\bin.?office\b|\bin.?person\b/.test(text)) continue;
        // Extract company from title: "Job Title - Company Name"
        const dashIdx = title.lastIndexOf(' - ');
        const company = dashIdx>0 ? title.substring(dashIdx+3).trim() : '';
        if(company && company.length>1 && company.length<60 && !company.toLowerCase().includes('indeed')){
          results.push({company, source:'indeed', link, location:'Remote / USA', notes:`Indeed: hiring ${kw.replace('+',' ')} · Remote`});
        }
      }
    }catch(e){}
    await new Promise(r=>setTimeout(r,1500));
  }
  await dbLog('💼','Indeed RSS',`${results.length} job posts found`);
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
    await dbLog('🔶','HackerNews Hiring',`${results.length} companies found`);
  }catch(e){ await dbLog('⚠️','HN error',e.message); }
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
    await dbLog('🚀','YC Jobs',`${results.length} companies found`);
  }catch(e){ await dbLog('⚠️','YC error',e.message); }
  return results;
}

// ── 4. RemoteOK (JSON API with fallback to RSS) ───────────────────────────
async function scrapeRemoteOK(){
  const results = [];
  const keywords = [
    'react','node','python','javascript','typescript',
    'devops','backend','fullstack','frontend','mobile',
    'qa','cloud','aws','azure','gcp','data','ai','machine-learning',
    'java','php','ruby','golang','rust','kotlin','swift',
    'cybersecurity','project-manager','scrum',
    'it-support','managed-services','staff-augmentation',
  ];

  // Try JSON API first
  try{
    const r = await axios.get('https://remoteok.com/api',{
      headers:{
        'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':'application/json, text/plain, */*',
        'Accept-Language':'en-US,en;q=0.9',
        'Referer':'https://remoteok.com/',
      },
      timeout:20000
    });
    const jobs = Array.isArray(r.data)?r.data.filter(j=>j.company):[];
    for(const job of jobs.slice(0,100)){
      const text = `${job.position||''} ${(job.tags||[]).join(' ')}`.toLowerCase();
      const relevant = keywords.some(k=>text.includes(k));
      if(relevant && job.company){
        results.push({
          company: job.company,
          website: job.company_website||null,
          source: 'remoteok',
          location: 'Remote / USA',
          job_title: job.position||'Developer',
          job_url: `https://remoteok.com/l/${job.slug||''}`,
          job_desc: job.description?job.description.replace(/<[^>]+>/g,'').substring(0,300):'',
          salary: job.salary||'',
          notes:`RemoteOK: hiring ${job.position||'developer'}${job.salary?' · '+job.salary:''}`
        });
      }
    }
    await dbLog('🌍','RemoteOK JSON',`${results.length} companies found`);
    return results;
  }catch(e){
    await dbLog('⚠️','RemoteOK JSON failed',`${e.response?.status||e.message} — trying RSS fallback`);
  }

  // Fallback: RemoteOK RSS feed (no auth, rarely blocked)
  try{
    const rssFeeds = [
      'https://remoteok.com/remote-dev-jobs.rss',
      'https://remoteok.com/remote-javascript-jobs.rss',
      'https://remoteok.com/remote-python-jobs.rss',
      'https://remoteok.com/remote-devops-jobs.rss',
    ];
    for(const feedUrl of rssFeeds){
      try{
        const r = await axios.get(feedUrl,{
          headers:{'User-Agent':'Mozilla/5.0 (compatible; RSS/2.0)','Accept':'application/rss+xml,text/xml'},
          timeout:15000
        });
        const items = r.data.split('<item>').slice(1);
        for(const item of items.slice(0,15)){
          const title   = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s)||item.match(/<title>(.*?)<\/title>/s)||[])[1]||'';
          const link    = (item.match(/<link>(.*?)<\/link>/s)||[])[1]||'';
          const creator = (item.match(/<dc:creator><!\[CDATA\[(.*?)\]\]><\/dc:creator>/s)||[])[1]||'';
          const company = creator || (title.match(/ at (.+)$/)?.[1]||'').trim();
          if(company && company.length>1 && company.length<60){
            results.push({company, source:'remoteok', location:'Remote / USA', job_url:link, notes:`RemoteOK RSS: ${title.substring(0,80)}`});
          }
        }
        await new Promise(r=>setTimeout(r,800));
      }catch(e){}
    }
    await dbLog('🌍','RemoteOK RSS fallback',`${results.length} companies found`);
  }catch(e){ await dbLog('⚠️','RemoteOK RSS also failed',e.message); }

  return results;
}

// ── 5. Greenhouse Job Board API (public — no auth needed) ────────────────
async function scrapeGreenhouse(){
  const results = [];
  // These are real companies on Greenhouse — publicly accessible
  const companies = [
    'airbnb','stripe','twilio','shopify','hubspot','zendesk','intercom',
    'squarespace','asana','figma','notion','linear','vercel','netlify',
    'planetscale','supabase','clerk','resend','postmark','segment',
    'datadog','newrelic','pagerduty','atlassian','servicenow','okta',
    'cloudflare','fastly','hashicorp','mongodb','elastic','snowflake',
  ];
  const keywords = [
    'react','node','python','engineer','developer','devops','backend','frontend',
    'qa','cloud','data','mobile','java','security','support','manager','scrum',
  ];
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
  await dbLog('🌱','Greenhouse',`${results.length} companies actively hiring`);
  return results;
}

// ── Serper daily credit guard ─────────────────────────────────────────────
// Tracks how many Serper queries were fired today. Max 2 per run × 2 runs/day
// = 4 queries/day × 10 results = ~40 leads/day. Hard cap at 50 leads/day.

// ── 6. Serper.dev Search API — Remote-only, 50 leads/day cap ─────────────
async function scrapeGoogleCustom(){
  const key = process.env.SERPER_API_KEY;
  if(!key) return [];

  // ── Once-per-day guard — 1 query/day = 2,500 days of free credits ────
  if(await serperFiredToday()){
    await dbLog('⏸️','Serper skipped','Already used today\'s 1 query — resets at midnight');
    return [];
  }

  // ── Daily lead cap check ──────────────────────────────────────────────
  const todayCount = await getSerperDailyCount();
  if(todayCount >= SERPER_MAX_LEADS_PER_DAY){
    await dbLog('⏸️','Serper skipped',`Daily cap of ${SERPER_MAX_LEADS_PER_DAY} leads already reached`);
    return [];
  }
  const remainingSlots = SERPER_MAX_LEADS_PER_DAY - todayCount;

  const results = [];

  // ── Remote-only queries (all include "remote" keyword) ────────────────
  // These are designed to return ONLY remote roles — no on-site, no hybrid
  const allQueries = [
    // Target ATS/job board pages directly — these are ACTUAL job postings, not articles
    'site:lever.co "remote" "software engineer" OR "developer" OR "devops"',
    'site:greenhouse.io "remote" "software engineer" OR "developer" OR "devops"',
    'site:boards.greenhouse.io "remote" engineer developer',
    'site:jobs.ashbyhq.com "remote" engineer developer',
    'site:workable.com "remote" "software engineer" OR "developer"',
    'site:apply.workable.com "remote" developer engineer',
    'site:jobs.lever.co "remote" developer engineer QA devops',
    'site:wellfound.com/jobs "remote" "software engineer" OR "developer"',
    'site:weworkremotely.com/jobs "developer" OR "engineer" OR "devops"',
    'site:remotive.com/jobs "developer" OR "engineer" OR "devops"',
    'site:ycombinator.com/jobs "remote" engineer developer',
  ];

  // Rotate through queries — 2 per run to preserve credits
  // With 2 runs/day this = 4 credits/day → ~40 leads max (well under 50 cap)
  const day  = new Date().getDate();
  const hour = new Date().getHours();
  const idx  = ((day * SERPER_QUERIES_PER_RUN) + Math.floor(hour/12)) % allQueries.length;
  const todayQueries = [];
  for(let i=0; i<SERPER_QUERIES_PER_RUN; i++){
    todayQueries.push(allQueries[(idx+i) % allQueries.length]);
  }

  await dbLog('🔎','Serper Search',`${todayQueries.length} queries | ${todayCount}/${SERPER_MAX_LEADS_PER_DAY} leads used today`);

  for(const q of todayQueries){
    if(results.length >= remainingSlots) break; // stop if daily cap would be hit

    try{
      const r = await axios.post('https://google.serper.dev/search',
        { q, num:10, gl:'us', hl:'en' },
        { headers:{ 'X-API-KEY': key, 'Content-Type':'application/json' }, timeout:15000 }
      );
      const items = (r.data?.organic||[]).map(i=>({
        title:   i.title||'',
        link:    i.link||'',
        snippet: i.snippet||''
      }));

      for(const item of items){
        if(results.length >= remainingSlots) break;

        const title = item.title||'';
        const link  = item.link||'';
        const desc  = item.snippet||'';
        const text  = (title+' '+desc).toLowerCase();

        // Skip hard on-site signals only
        const isOnsite = /\bon.?site\b|\bin.?office\b|\bin.?person\b|\bhybrid\b/.test(text);
        if(isOnsite) continue;

        // ── Skip blog posts, articles, listicles — not job postings ──
        const isBlog = /top \d+|best \d+|how to hire|guide to|tips for|what is|vs\.|comparison|review|\d+ picks|why outsource|benefits of outsourc|article|blog\.|\bposts\b/i.test(title);
        if(isBlog) continue;
        // Also skip vendor/agency sites promoting themselves
        const isVendor = /outsourc.*compan|software.*vendor|development.*agenc|our services|hire us|contact us/i.test(title+' '+desc);
        if(isVendor) continue;

        // Extract company name — job board aware
        let company = '';
        // Job board URL patterns: lever.co/company-name, greenhouse.io/company, workable.com/company
        const jobBoardMatch = link.match(/(?:lever\.co|greenhouse\.io|workable\.com|ashbyhq\.com|boards\.greenhouse\.io)\/([a-z0-9\-]+)/i);
        if(jobBoardMatch) company = jobBoardMatch[1].replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        // LinkedIn jobs: linkedin.com/jobs/view/title-at-Company-123
        const linkedinMatch = link.match(/linkedin\.com\/jobs\/view\/(.+?)-\d+/);
        if(!company && linkedinMatch) {
          const atIdx = linkedinMatch[1].lastIndexOf('-at-');
          if(atIdx>0) company = linkedinMatch[1].substring(atIdx+4).replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        }
        // Title patterns: "Role at Company" or "Company - Role"
        if(!company){
          const m1 = title.match(/ at ([A-Z][A-Za-z0-9 &,.]+?)(?:\s*[-|]|$)/);
          const m2 = title.match(/^([A-Z][A-Za-z0-9 &]+?) [-–|] /);
          const m3 = desc.match(/([A-Z][A-Za-z0-9 &]+?) is (?:looking|hiring|seeking|need)/);
          const m4 = desc.match(/([A-Z][A-Za-z0-9 &]+?) (?:company|startup|inc|llc|corp)/i);
          company = (m1&&m1[1])||(m2&&m2[1])||(m3&&m3[1])||(m4&&m4[1])||'';
        }
        // Domain fallback — skip known job board domains
        if(!company){
          const domainMatch = link.match(/https?:\/\/(?:www\.)?([^\/]+)/);
          const domain = domainMatch?.[1]||'';
          const jobBoards = ['linkedin','indeed','glassdoor','greenhouse','lever','workable','ashbyhq','wellfound','angel','remotive','weworkremotely','nodesk','ycombinator','ziprecruiter','monster'];
          const domainName = domain.split('.')[0];
          if(!jobBoards.includes(domainName) && domainName.length>2){
            company = domainName.charAt(0).toUpperCase()+domainName.slice(1);
          }
        }
        company = company.trim().replace(/\.$/, '').substring(0,60);

        if(company && company.length>2){
          const salaryMatch = (title+' '+desc).match(/\$[\d,]+(?:\s*-\s*\$[\d,]+)?(?:\/hr|\/hour|k| per hour)?/i);
          const salary = salaryMatch ? salaryMatch[0] : '';

          const serviceTypes = [];
          if(text.match(/develop|engineer|programmer|coder/)) serviceTypes.push('Development');
          if(text.match(/qa|tester|quality/)) serviceTypes.push('QA');
          if(text.match(/devops|cloud|aws|azure|gcp/)) serviceTypes.push('DevOps/Cloud');
          if(text.match(/support|helpdesk|it support/)) serviceTypes.push('IT Support');
          if(text.match(/data|analytics|ml|ai|machine learning/)) serviceTypes.push('Data/AI');
          if(text.match(/security|cyber|pentest/)) serviceTypes.push('Cybersecurity');
          if(text.match(/project manager|scrum|agile/)) serviceTypes.push('PM/Scrum');
          if(text.match(/mobile|ios|android|flutter/)) serviceTypes.push('Mobile');
          if(text.match(/outsourc|augment|vendor|partner|third.party/)) serviceTypes.push('Outsourcing');
          const serviceLabel = serviceTypes.length>0 ? serviceTypes.join(', ') : 'IT Services';

          results.push({
            company, source:'serper',
            job_url: link,
            website: link,
            job_title: `${serviceLabel} — ${title.substring(0,60)}`,
            job_desc: desc.substring(0,250),
            salary, location:'Remote / USA',
            notes:`Serper: ${title.substring(0,80)}${salary?' · '+salary:''}· Remote`,
          });
        }
      }
      await dbLog('🔎','Serper query done',`"${q.substring(0,50)}" → ${results.length} remote leads so far`);
    }catch(e){
      if(e.response&&(e.response.status===429||e.response.status===403)){
        await dbLog('⚠️','Serper quota reached','Credit limit hit — check serper.dev dashboard');
        break;
      }
      await dbLog('⚠️','Serper error',e.message);
    }
    await new Promise(r=>setTimeout(r,1200));
  }

  // Track how many leads we found today + mark as fired
  if(results.length>0) await addSerperDailyCount(results.length);
  await markSerperFiredToday();

  await dbLog('🔎','Serper done',`${results.length} remote IT leads found | ${await getSerperDailyCount()}/${SERPER_MAX_LEADS_PER_DAY} today`);
  return results;
}
// ── Master scraper ────────────────────────────────────────────────────────
async function scrapeAllJobBoards(){
  await dbLog('🌐','Job scrape started','Indeed RSS + HackerNews + YC + RemoteOK + Greenhouse + Serper (remote only)');

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

  // Deduplicate — check existing leads in DB
  const seen = new Set();
  const existingCheck = await Promise.all(all.map(r=>leadExists(r.company)));
  const unique = all.filter((r,i)=>{
    const key = r.company.toLowerCase().trim();
    if(!key||key.length<2||seen.has(key)||existingCheck[i]) return false;
    seen.add(key);
    return true;
  });

  await dbLog('📊','Scrape complete',`${all.length} total → ${unique.length} new unique companies`);

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

    const r = await insertLead({
      company:co.company, website:co.website||null,
      industry:'Technology', size:null,
      location:co.location||'USA', source:co.source,
      notes:jobDetails,
    });
    await insertContact({
      lead_id:r.lastInsertRowid, name:'Unknown',
      first_name:'there', role:'CTO / HR Manager',
      email:null, linkedin:null,
    });
    added++;
  }

  await dbLog('✅','Import done',`${added} new companies added`);
  return {total:all.length, unique:unique.length, added};
}

// ── Agent ─────────────────────────────────────────────────────────────────
let agentRunning=false;
async function runAgentCycle({dryRun=false}={}){if(agentRunning)return;agentRunning=true;await dbLog('⚡','Agent started',dryRun?'DRY RUN':'LIVE');try{const r=await checkForReplies();if(r>0)await dbLog('🎉',`${r} replies`,'');// Scrape job boards for new leads
try{await scrapeAllJobBoards();}catch(e){await dbLog('⚠️','Scraper error',e.message);}try{const hunterFound=await enrichContactsWithHunter();if(hunterFound>0)await dbLog('🔍','Hunter enrichment',`${hunterFound} emails found`);}catch(e){}
const nc=await getContactsNotYetEmailed();let sent=0;const max=parseInt(process.env.MAX_EMAILS_PER_DAY)||30;for(const c of nc){if(sent>=max)break;const l=await getLeadById(c.lead_id);if(!l)continue;const res=await sendEmail({contact:c,lead:l,emailNum:1,dryRun});if(res.ok)sent++;if(!dryRun)await delay(parseInt(process.env.EMAIL_DELAY_SECONDS)||90);}const fc=await getContactsDueForFollowup();for(const c of fc){if(sent>=max)break;const l=await getLeadById(c.lead_id);if(!l)continue;const res=await sendEmail({contact:c,lead:l,emailNum:Math.min(c.emails_sent+1,4),dryRun});if(res.ok)sent++;if(!dryRun)await delay(parseInt(process.env.EMAIL_DELAY_SECONDS)||90);}await dbLog('✅','Cycle done',`${sent} emails`);}catch(e){await dbLog('❌','Agent error',e.message);}finally{agentRunning=false;}}
function startScheduler(){
  cron.schedule('0 15 * * 2-4',()=>runAgentCycle());
  cron.schedule('0 19 * * 2-4',()=>runAgentCycle());
  cron.schedule('0 14 * * 1',()=>runAgentCycle());
  cron.schedule('0 6 * * 1-5',()=>scrapeAllJobBoards().catch(console.error));
  cron.schedule('*/15 * * * *',()=>checkForReplies());
  dbLog('📅','Scheduler active','Tue-Thu 10am+2pm EST | Mon 9am | Scrape 6am | Replies 15min');
}

// ── Express ───────────────────────────────────────────────────────────────
const app=express();
app.use(cors());
app.use(express.json());

app.get('/healthz',(req,res)=>res.status(200).send('OK'));
app.get('/api/stats',async(req,res)=>res.json(await getStats()));
app.get('/api/leads',async(req,res)=>res.json(await getAllLeads()));
app.get('/api/leads/:id',async(req,res)=>{const l=await getLeadById(req.params.id);if(!l)return res.status(404).json({error:'Not found'});const[contacts,thread]=await Promise.all([getContactsByLeadId(l.id),getEmailsByLeadId(l.id)]);res.json({...l,contacts,thread});});
app.post('/api/leads',async(req,res)=>{const{company,website,industry,size,location,source,notes,contacts}=req.body;if(!company)return res.status(400).json({error:'company required'});const r=await insertLead({company,website,industry,size,location,source:source||'manual',notes});const lid=r.lastInsertRowid;if(contacts?.length)for(const c of contacts)if(c.name||c.email)await insertContact({lead_id:lid,name:c.name||'Unknown',first_name:c.name?.split(' ')[0]||'there',role:c.role||'',email:c.email||null,linkedin:c.linkedin||null});await dbLog('➕','Lead added',company);res.json({ok:true,id:lid});});
app.delete('/api/leads/:id',async(req,res)=>{await db.execute({sql:'DELETE FROM leads WHERE id=?',args:[Number(req.params.id)]});await db.execute({sql:'DELETE FROM contacts WHERE lead_id=?',args:[Number(req.params.id)]});res.json({ok:true});});
app.patch('/api/contacts/:id/email',async(req,res)=>{await updateContactEmail(req.params.id,req.body.email);res.json({ok:true});});
app.patch('/api/contacts/:id/replied',async(req,res)=>{await markContactReplied(req.params.id);res.json({ok:true});});
app.post('/api/contacts/:id/send',async(req,res)=>{const c=await getContactById(req.params.id);if(!c)return res.status(404).json({error:'Not found'});if(!c.email)return res.status(400).json({error:'No email'});const l=await getLeadById(c.lead_id);res.json(await sendEmail({contact:c,lead:l,emailNum:c.emails_sent+1}));});
app.get('/api/activity',async(req,res)=>res.json(await getRecentActivity(parseInt(req.query.limit)||50)));
// ── Gemini AI Personalised Email ─────────────────────────────────────────
app.post('/api/ai/generate-email',async(req,res)=>{
  const key = process.env.GEMINI_API_KEY;
  if(!key) return res.json({ok:false,error:'GEMINI_API_KEY not set in Railway'});

  const {lead_id,contact_id,email_num=1} = req.body;
  const lead = await getLeadById(lead_id);
  if(!lead) return res.status(404).json({error:'Lead not found'});
  const contacts = getContactsByLeadId(lead_id);
  const contact = contact_id ? contacts.find(c=>c.id===Number(contact_id)) : contacts[0];

  const notes = lead.notes||'';
  const jobTitle = notes.match(/Job Title: (.+)/)?.[1]||'';
  const salary   = notes.match(/Salary: (.+)/)?.[1]||'';
  const jobDesc  = notes.includes('Description: ') ? notes.split('Description: ')[1].split('\nSalary:')[0].split('\nPosted:')[0].trim() : '';
  const jobUrl   = notes.match(/Job Post: (.+)/)?.[1]||'';

  const prompt = `You are a BD expert writing a cold email for ByteOn Technologies, an IT outsourcing company based in India serving US/UK clients.

TARGET:
Company: ${lead.company}
Contact: ${contact?.name||'there'} (${contact?.role||'Decision Maker'})
${jobTitle?'Job they posted: '+jobTitle:''}
${salary?'Budget: '+salary:''}
${jobDesc?'Details: '+jobDesc.substring(0,250):''}
${jobUrl?'Job post URL: '+jobUrl:''}

ABOUT US: ByteOn Technologies — IT outsourcing: Dev, QA, DevOps, Cloud, IT Support, Data, Cybersecurity, PM. Resources ready in 5-7 days. 40-60% cheaper than hiring locally.

Write email #${email_num}:
${email_num===1?'First touch — reference their SPECIFIC job post or need. Be direct, concise, max 120 words.':''}
${email_num===2?'Follow-up day 3 — add a specific stat or case study. New angle. Max 80 words.':''}
${email_num===3?'Follow-up day 7 — address a different pain point (speed, quality, flexibility). Max 60 words.':''}
${email_num===4?'Break-up email day 14 — short, creates mild urgency, leaves door open. Max 50 words.':''}

Rules:
- Sound like a real human, not a sales robot
- NO "I hope this finds you well" or similar openers
- Reference ${lead.company} specifically
- One clear CTA: 15-min call
- Sign as: Anas | ByteOn Technologies | byteonai.com

Respond ONLY with valid JSON, no markdown, no extra text: {"subject":"...","body":"..."}`;

  try{
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {contents:[{parts:[{text:prompt}]}]},
      {headers:{'Content-Type':'application/json'},timeout:25000}
    );
    const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text||'{}';
    const clean = raw.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(clean);
    if(!parsed.subject||!parsed.body) throw new Error('Gemini returned incomplete JSON');
    await dbLog('🤖','Gemini email generated',`${lead.company} — email #${email_num}`);
    res.json({ok:true, subject:parsed.subject, body:parsed.body});
  }catch(e){
    await dbLog('❌','Gemini failed',e.response?.data?.error?.message||e.message);
    res.json({ok:false, error:e.response?.data?.error?.message||e.message});
  }
});

app.post('/api/agent/run',async(req,res)=>{const d=req.body?.dry_run===true;runAgentCycle({dryRun:d}).catch(console.error);res.json({ok:true,message:d?'Dry run started':'Agent started'});});
app.post('/api/agent/check-replies',async(req,res)=>res.json({ok:true,replies_found:await checkForReplies()}));
app.get('/api/test/hostinger',async(req,res)=>res.json(await testSmtp()));
app.get('/api/test/gmail',async(req,res)=>res.json(await testSmtp())); // kept for backwards compat

// Hunter.io test — shows exact credits remaining
app.get('/api/test/hunter',async(req,res)=>{
  const key=process.env.HUNTER_API_KEY;
  if(!key) return res.json({ok:false,error:'HUNTER_API_KEY not set in Railway'});
  try{
    const r=await axios.get('https://api.hunter.io/v2/account',{params:{api_key:key},timeout:10000});
    const data = r.data?.data;
    const searches = data?.requests?.searches;
    res.json({
      ok:true,
      plan: data?.plan_name||'unknown',
      searches_used: searches?.used||0,
      searches_available: searches?.available||0,
      resets: 'Monthly',
      warning: (searches?.available||0)<5 ? '⚠️ Almost out of Hunter credits! Will stop finding emails.' : null
    });
  }catch(e){res.json({ok:false,error:e.response?.data?.errors?.[0]?.details||e.message});}
});

// Gemini test — verifies API key and generates a sample email
app.get('/api/test/gemini',async(req,res)=>{
  const key=process.env.GEMINI_API_KEY;
  if(!key) return res.json({ok:false,error:'GEMINI_API_KEY not set in Railway'});
  try{
    const r=await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {contents:[{parts:[{text:'Write a 2-sentence cold email subject line for an IT outsourcing company called ByteOn Technologies reaching out to Stripe who is hiring a remote React developer. Respond ONLY with JSON: {"subject":"...","body":"..."}'}]}]},
      {headers:{'Content-Type':'application/json'},timeout:20000}
    );
    const raw=r.data?.candidates?.[0]?.content?.parts?.[0]?.text||'{}';
    const parsed=JSON.parse(raw.replace(/```json|```/g,'').trim());
    res.json({ok:true, message:'Gemini working!', model:'gemini-1.5-flash', sample_subject:parsed.subject, sample_body:parsed.body});
  }catch(e){
    res.json({ok:false, error:e.response?.data?.error?.message||e.message});
  }
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

// GET test for Serper Search — open in browser to test
app.get('/api/test/google',async(req,res)=>{
  const key = process.env.SERPER_API_KEY;
  if(!key) return res.json({ok:false,error:'SERPER_API_KEY not set in Railway'});
  try{
    const r = await axios.post('https://google.serper.dev/search',
      { q:'remote React developer contract hiring USA', num:5, gl:'us' },
      { headers:{ 'X-API-KEY': key, 'Content-Type':'application/json' }, timeout:15000 }
    );
    const items = r.data?.organic||[];
    res.json({
      ok:true,
      message:`Serper working! Found ${items.length} results. NOTE: this used 1 credit.`,
      credits_remaining: r.data?.credits||'check serper.dev dashboard',
      sample: items.slice(0,3).map(i=>({title:i.title,link:i.link,snippet:i.snippet?.substring(0,100)}))
    });
  }catch(e){
    res.json({ok:false,error:e.response?.data?.message||e.message, details:e.response?.data});
  }
});
app.post('/api/scrape/indeed',async(req,res)=>{try{const r=await scrapeIndeed();res.json({ok:true,found:r.length});}catch(e){res.json({ok:false,error:e.message});}});
app.post('/api/scrape/google',async(req,res)=>{try{const r=await scrapeGoogleCustom();res.json({ok:true,found:r.length});}catch(e){res.json({ok:false,error:e.message});}});
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
    await dbLog('🔗','Waalaxy webhook received', JSON.stringify(data).substring(0,100));

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
      const leadR = await db.execute({sql:'SELECT * FROM leads WHERE LOWER(TRIM(company))=LOWER(TRIM(?))',args:[coName]});
      let lead = leadR.rows[0]||null; if(lead) lead={...lead,id:Number(lead.id)};

      if(!lead){
        const r = await insertLead({
          company:coName, website, industry:null,
          size:null, location, source:'waalaxy',
          notes:`LinkedIn connection accepted via Waalaxy`
        });
        lead = {id: r.lastInsertRowid, company: coName};
        added++;
      }

      // Add contact if not already there
      const existsC = await db.execute({sql:'SELECT id FROM contacts WHERE lead_id=? AND name=?',args:[lead.id,name]});
      const exists = existsC.rows[0]||null;
      if(!exists){
        await insertContact({
          lead_id:lead.id, name, first_name:firstName||name.split(' ')[0]||'there',
          role, email:email||null, linkedin
        });
      }

      // If email provided by Waalaxy — start sequence immediately
      if(email){
        await dbLog('📤','Waalaxy lead ready to email',`${name} at ${coName} — ${email}`);
      } else {
        await dbLog('🔍','Waalaxy lead needs email',`${name} at ${coName} — will search via Hunter`);
        // Try Hunter.io to find email
        if(process.env.HUNTER_API_KEY && website){
          const domain = website.replace(/^https?:\/\//,'').replace(/\/.*/,'');
          const hunterEmail = await findEmailHunter(firstName, lastName, domain);
          if(hunterEmail){
            const contactR = await db.execute({sql:'SELECT * FROM contacts WHERE lead_id=? AND name=?',args:[lead.id,name]});
          const contact = contactR.rows[0]||null;
            if(contact) updateContactEmail(contact.id, hunterEmail);
            await dbLog('🎯','Email found via Hunter',`${name} → ${hunterEmail}`);
          }
        }
      }
    }

    await dbLog('✅','Waalaxy webhook processed',`${added} new companies added`);
    res.json({ok:true, added, message:'Prospects received and queued for outreach'});

  }catch(e){
    await dbLog('❌','Waalaxy webhook error',e.message);
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


const PORT=process.env.PORT||3000;
initDB().then(()=>{
  app.listen(PORT,'0.0.0.0',()=>{
    console.log(`\n🚀 LeadForge running on port ${PORT}`);
    console.log(`📋 CSV upload: POST /api/import/csv`);
    console.log(`🎯 Hunter enrich: POST /api/hunter/enrich`);
    console.log(`✅ Tests: /api/test/hostinger /api/test/hunter /api/test/gemini /api/test/google\n`);
    startScheduler();
    dbLog('🟢','Server started',`Port ${PORT}`);
  });
}).catch(e=>{
  console.error('❌ Failed to connect to Turso DB:',e.message);
  process.exit(1);
});
