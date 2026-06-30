// ════════════════════════════════════════════════════════════
// STARDOC MANAGER PRO — Google Drive Edition
// ════════════════════════════════════════════════════════════

// ── CONFIG ──
const GOOGLE_CLIENT_ID='17061457455-lkt5q8g6jsfoq0rjn6kajpd9nu0acqnk.apps.googleusercontent.com';
const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.file';
const APP_FOLDER_NAME='StarDoc Manager Data';
const DB_FILE_NAME='stardoc_database.json';

let tokenClient=null;
let accessToken=null;
let appFolderId=null;
let dbFileId=null;
let customersCache=[];   // in-memory cache, synced to Drive
let currentUser=null;
let saveTimer=null;

// ── INIT ──
window.addEventListener('load', ()=>{
  initGoogleSignIn();
  // Try silent restore of session
  const savedToken=sessionStorage.getItem('sd_access_token');
  const savedExpiry=sessionStorage.getItem('sd_token_expiry');
  if(savedToken && savedExpiry && Date.now()<Number(savedExpiry)){
    accessToken=savedToken;
    bootAfterAuth();
  }
});

function initGoogleSignIn(){
  if(typeof google==='undefined'){ setTimeout(initGoogleSignIn,300); return; }

  tokenClient=google.accounts.oauth2.initTokenClient({
    client_id:GOOGLE_CLIENT_ID,
    scope:DRIVE_SCOPE+' https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
    callback:(resp)=>{
      if(resp.error){ alert('Google authorization failed: '+resp.error); return; }
      accessToken=resp.access_token;
      sessionStorage.setItem('sd_access_token',accessToken);
      sessionStorage.setItem('sd_token_expiry', String(Date.now()+(resp.expires_in*1000-60000)));
      bootAfterAuth();
    }
  });

  // Render a single custom button that directly triggers the OAuth popup
  // (must be a direct user-click handler, not nested in another callback,
  // otherwise browsers block the popup as Cross-Origin-Opener-Policy / popup blocker)
  const container=document.getElementById('gsiButtonContainer');
  container.innerHTML=`<button type="button" class="gsi-btn" id="gsiSignInBtn">
    <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.08-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33C2.44 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.97 10.72c-.18-.54-.28-1.12-.28-1.72s.1-1.18.28-1.72V4.95H.96A8.996 8.996 0 000 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
    Continue with Google
  </button>`;
  document.getElementById('gsiSignInBtn').addEventListener('click', ()=>{
    tokenClient.requestAccessToken({prompt:'consent'});
  });
}

function signOut(){
  if(accessToken) google.accounts.oauth2.revoke(accessToken,()=>{});
  sessionStorage.clear();
  accessToken=null; currentUser=null; customersCache=[];
  document.getElementById('appRoot').style.display='none';
  document.getElementById('loginScreen').style.display='flex';
}

async function bootAfterAuth(){
  showLoading('Connecting to Google Drive...');
  try{
    const savedUser=sessionStorage.getItem('sd_user');
    if(savedUser) currentUser=JSON.parse(savedUser);

    if(currentUser){
      document.getElementById('userName').textContent=currentUser.name.split(' ')[0];
      document.getElementById('userAvatar').src=currentUser.picture||'';
    } else {
      // Fetch profile via Drive API "about" if we don't have it cached
      const r=await fetch('https://www.googleapis.com/drive/v3/about?fields=user',{
        headers:{Authorization:'Bearer '+accessToken}
      });
      const j=await r.json();
      if(j.user){
        currentUser={name:j.user.displayName,email:j.user.emailAddress,picture:j.user.photoLink};
        document.getElementById('userName').textContent=currentUser.name.split(' ')[0];
        document.getElementById('userAvatar').src=currentUser.picture||'';
        sessionStorage.setItem('sd_user',JSON.stringify(currentUser));
      }
    }

    await ensureAppFolder();
    await ensureDbFile();
    await loadDatabase();

    document.getElementById('loginScreen').style.display='none';
    document.getElementById('appRoot').style.display='block';
    renderAll(); renderRecentHome(); renderRenewals();
  }catch(e){
    console.error(e);
    alert('Could not connect to Google Drive: '+e.message+'\n\nPlease try signing in again.');
    signOut();
  }
  hideLoading();
}

// ── DRIVE API HELPERS ──
function driveHeaders(extra){
  return Object.assign({Authorization:'Bearer '+accessToken},extra||{});
}

async function ensureAppFolder(){
  // Search for existing folder
  const q=encodeURIComponent(`name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res=await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`,{headers:driveHeaders()});
  const data=await res.json();
  if(data.files && data.files.length){
    appFolderId=data.files[0].id;
    return;
  }
  // Create it
  const createRes=await fetch('https://www.googleapis.com/drive/v3/files',{
    method:'POST',
    headers:driveHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify({name:APP_FOLDER_NAME,mimeType:'application/vnd.google-apps.folder'})
  });
  const created=await createRes.json();
  appFolderId=created.id;
}

async function ensureDbFile(){
  const q=encodeURIComponent(`name='${DB_FILE_NAME}' and '${appFolderId}' in parents and trashed=false`);
  const res=await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`,{headers:driveHeaders()});
  const data=await res.json();
  if(data.files && data.files.length){
    dbFileId=data.files[0].id;
    return;
  }
  // Create empty DB file
  dbFileId=await createJsonFile(DB_FILE_NAME, [], appFolderId);
}

async function createJsonFile(name, jsonData, parentId){
  const metadata={name, mimeType:'application/json', parents:[parentId]};
  const boundary='-------stardoc'+Date.now();
  const body=
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`+
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(jsonData)}\r\n`+
    `--${boundary}--`;
  const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{
    method:'POST',
    headers:driveHeaders({'Content-Type':`multipart/related; boundary=${boundary}`}),
    body
  });
  const created=await res.json();
  return created.id;
}

async function loadDatabase(){
  const res=await fetch(`https://www.googleapis.com/drive/v3/files/${dbFileId}?alt=media`,{headers:driveHeaders()});
  if(!res.ok){ customersCache=[]; return; }
  try{
    customersCache=await res.json();
    if(!Array.isArray(customersCache)) customersCache=[];
  }catch(e){ customersCache=[]; }
}

async function saveDatabase(){
  setSyncStatus('syncing');
  const boundary='-------stardocupd'+Date.now();
  const metadata={name:DB_FILE_NAME};
  const body=
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`+
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(customersCache)}\r\n`+
    `--${boundary}--`;
  try{
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${dbFileId}?uploadType=multipart`,{
      method:'PATCH',
      headers:driveHeaders({'Content-Type':`multipart/related; boundary=${boundary}`}),
      body
    });
    setSyncStatus('synced');
  }catch(e){
    setSyncStatus('error');
    console.error('Save failed',e);
  }
}

function queueSave(){
  setSyncStatus('syncing');
  clearTimeout(saveTimer);
  saveTimer=setTimeout(saveDatabase, 800);
}

function setSyncStatus(state){
  const pill=document.getElementById('syncPill');
  const text=document.getElementById('syncText');
  if(!pill) return;
  pill.classList.remove('syncing','synced');
  if(state==='syncing'){ pill.classList.add('syncing'); text.textContent='Saving...'; }
  else if(state==='synced'){ pill.classList.add('synced'); text.textContent='Synced'; }
  else { text.textContent='Sync error'; }
}

// ── UPLOAD A DOCUMENT FILE TO DRIVE (returns Drive file ID + webViewLink) ──
async function uploadDocToDrive(base64data, filename, customerFolderId){
  const arr=base64data.split(',');
  const mimeMatch=arr[0].match(/:(.*?);/);
  const mime=mimeMatch?mimeMatch[1]:'application/octet-stream';
  const bstr=atob(arr[1]);
  const u8=new Uint8Array(bstr.length);
  for(let i=0;i<bstr.length;i++) u8[i]=bstr.charCodeAt(i);
  const blob=new Blob([u8],{type:mime});

  const metadata={name:filename, parents:[customerFolderId]};
  const form=new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)],{type:'application/json'}));
  form.append('file', blob);

  const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink',{
    method:'POST',
    headers:driveHeaders(),
    body:form
  });
  const created=await res.json();
  return created; // {id, webViewLink, webContentLink}
}

async function ensureCustomerFolder(customerName, existingFolderId){
  if(existingFolderId) return existingFolderId;
  const safeName=customerName.replace(/[^\w\s\-]/g,'').trim()||'Customer';
  const res=await fetch('https://www.googleapis.com/drive/v3/files',{
    method:'POST',
    headers:driveHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify({name:safeName, mimeType:'application/vnd.google-apps.folder', parents:[appFolderId]})
  });
  const created=await res.json();
  return created.id;
}

function showLoading(msg){
  document.getElementById('loadingText').textContent=msg||'Loading...';
  document.getElementById('loadingOverlay').style.display='flex';
}
function hideLoading(){
  document.getElementById('loadingOverlay').style.display='none';
}

// ════════════════════════════════════════════════════════════
// PDF READING + PARSING (proven logic, reused as-is)
// ════════════════════════════════════════════════════════════

async function readPDF(event){
  const file=event.target.files[0]; if(!file) return;
  showStatus('⏳ Reading PDF... please wait','info');
  document.getElementById('formCard').style.display='none';
  window._pendingPdfFile=file;

  try{
    const buf=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:buf}).promise;
    let pages=[];
    for(let i=1;i<=pdf.numPages;i++){
      const page=await pdf.getPage(i);
      const content=await page.getTextContent({includeMarkedContent:false});
      const lineMap={};
      content.items.forEach(it=>{
        if(!it.str.trim()) return;
        const y=Math.round(it.transform[5]);
        if(!lineMap[y]) lineMap[y]=[];
        lineMap[y].push(it.str);
      });
      const sortedY=Object.keys(lineMap).map(Number).sort((a,b)=>b-a);
      pages.push(sortedY.map(y=>lineMap[y].join(' ')).join('\n'));
    }
    const text=pages.join('\n');

    if(text.trim().length<50){
      showStatus('⚠️ PDF has no readable text (scanned image). Please fill manually below.','warn');
      document.getElementById('formCard').style.display='block';
      renderDocGrid();
      return;
    }

    const missing=fillForm(text);

    // Auto-store the uploaded PDF as Policy Bond document
    const pdfReader=new FileReader();
    pdfReader.onload=e=>{
      formDocs['policy']=e.target.result;
      renderDocGrid();
    };
    pdfReader.readAsDataURL(file);

    document.getElementById('formCard').style.display='block';
    if(missing.length){
      showStatus('✅ PDF read! These fields need manual entry: <strong>'+missing.join(', ')+'</strong> — fill them and tap Save.','warn');
    } else {
      showStatus('✅ PDF read successfully! All fields filled — check details and tap Save.','ok');
    }
    document.getElementById('formCard').scrollIntoView({behavior:'smooth'});

  }catch(e){
    showStatus('❌ Could not read PDF: '+e.message+'. Please fill manually below.','err');
    document.getElementById('formCard').style.display='block';
    renderDocGrid();
  }
  event.target.value='';
}

function fillForm(text){
  const t=text.replace(/\r/g,' ').replace(/\s+/g,' ');
  const missing=[];

  function get(patterns){
    for(const p of patterns){
      const m=t.match(p);
      if(m&&m[1]&&m[1].trim()) return m[1].trim();
    }
    return '';
  }

  function toISO(s){
    if(!s) return '';
    const months={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
    let m=s.match(/(\d{1,2})[\-\/]([A-Za-z]{3})[\-\/](\d{4})/);
    if(m) return `${m[3]}-${months[m[2]]||'01'}-${m[1].padStart(2,'0')}`;
    m=s.match(/(\d{1,2})[\-\/](\d{2})[\-\/](\d{4})/);
    if(m) return `${m[3]}-${m[2]}-${m[1].padStart(2,'0')}`;
    return '';
  }
  window._toISO=toISO; // expose for member parser below

  // ── NAME ──
  let name=get([
    /Customer\s*Name\s*[:\-]?\s*([A-Z][A-Z\s\.]+?)(?=\s+(?:Cust|SAC|Phone|E-mail|\d))/i,
    /Proposer\s*Name\s*[:\-]?\s*([A-Z][A-Z\s\.]+?)(?=\s+(?:Issuing|Phone|E-mail|\d))/i,
    /certify\s+that\s+([A-Z][A-Z\s\.]+?)\s+has\s+paid/i,
    /To,?\s+([A-Z][A-Z\s\.,]+?)(?:,|\n)/
  ]);
  if(name) name=name.replace(/^(IMPORTANT|Dear|To|Re|From|Subject)\s+/i,'').trim();
  set('fName', name||'');
  if(!name) missing.push('Name');

  // ── MOBILE ──
  const mobile=get([
    /Mobile\s*[:\-]\s*(\d{10})\b/,
    /Phone\s*No\s*[:\-]\s*(\d{10})\b/,
    /\b([6-9]\d{9})\b/
  ]);
  set('fMobile', mobile||'');
  if(!mobile) missing.push('Mobile');

  // ── EMAIL ──
  const email=get([
    /E-mail\s*Id\s*[:\-]\s*([a-zA-Z0-9._%+\-]+@(?!star[t]?health)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
    /([a-zA-Z0-9._%+\-]+@(?!star[t]?health)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/
  ]);
  set('fEmail', email||'');

  // ── POLICY NUMBER ──
  const policy=get([
    /Health\s*Insurance\s*Policy\s*[-–\:]\s*(\d{10,20})/i,
    /Policy\s*No\.?\s*:\s*(\d{10,20})(?!\s*Previous)/i,
    /Invoice\s*Date.*?Policy\s*No\.?\s*(\d{10,20})/i
  ]);
  set('fPolicy', policy||'');
  if(!policy) missing.push('Policy No');

  // ── PRODUCT ──
  const productRaw=get([
    /(Star\s+Health\s+(?:Assure|Comprehensive|Super\s+Star|Senior\s+Citizens|Medi\s*Classic|Family\s+Health\s+Optima)\s*(?:Insurance|Policy)?)/i,
    /(Assure\s+Insurance)/i,
    /(Super\s+Star)/i,
    /(Family\s+Health\s+Optima|FHO)/i
  ]);
  if(productRaw){
    const sel=document.getElementById('fProduct');
    if(/assure/i.test(productRaw)) sel.value='Star Health Assure Insurance';
    else if(/super\s*star/i.test(productRaw)) sel.value='Star Super Star Insurance';
    else if(/FHO|family\s*health\s*optima/i.test(productRaw)) sel.value='Star Family Health Optima';
    else if(/comprehensive/i.test(productRaw)) sel.value='Star Comprehensive Insurance';
    else if(/senior/i.test(productRaw)) sel.value='Star Senior Citizens Red Carpet';
    else if(/medi\s*classic/i.test(productRaw)) sel.value='Star Medi Classic Insurance';
  }

  // ── PREMIUM ──
  const premRaw=get([
    /Total\s*Premium\s*[:\-]\s*Rs\.?\s*([\d,]+)/i,
    /paid\s*Rs\s*([\d,]+)/i,
    /Premium\s*[:\-]?\s*Rs\.?\s*([\d,]+)/i,
    /Total\s*Invoice\s*Value\s*(?:in\s*Figures)?\s*[:\-]\s*Rs\.?\s*([\d,]+)/i
  ]);
  set('fPremium', premRaw.replace(/,/g,'')||'');

  // ── SUM INSURED ──
  const sum=get([
    /Basic\s*Floater\s*Sum\s*Insured\s*[:\-]\s*Rs\.?\s*([\d,]+)/i,
    /Sum\s*Insured\s*[:\-]\s*Rs\.?\s*([\d,]+)/i,
    /Sum\s*Insured\s*Rs\.?\s*([\d,]+)/i,
    /\bInsured\s+(\d{1,2},\d{2},\d{3})\b/,
    /Self\s+([\d,]+)\s+[\d,]+\s+\d{2}-[A-Za-z]/i
  ]);
  set('fSum', sum||'');

  // ── START DATE ──
  const startRaw=get([
    /PERIOD\s*OF\s*INSURANCE\s*[:\-]\s*From\s*[:\-]\s*(\d{2}[\-\/][A-Za-z]{3}[\-\/]\d{4})/i,
    /Period\s*of\s*Insurance\s*[:\-]\s*From\s*[:\-]\s*(\d{2}[\-\/][A-Za-z]{3}[\-\/]\d{4})/i,
    /From\s*[:\-]\s*(\d{2}[\-\/][A-Za-z]{3}[\-\/]\d{4})/i
  ]);
  set('fStart', toISO(startRaw)||'');

  // ── RENEWAL DATE ──
  const renewalRaw=get([
    /Midnight\s*Of\s*(\d{2}[\-\/][A-Za-z]{3}[\-\/]\d{4})/i,
    /To\s*[:\-]\s*Midnight\s*[Oo]f\s*(\d{2}[\-\/][A-Za-z]{3}[\-\/]\d{4})/i,
    /midnight\s*of\s*(\d{2}[\-\/][A-Za-z]{3}[\-\/]\d{4})/i
  ]);
  set('fRenewal', toISO(renewalRaw)||'');
  if(!renewalRaw) missing.push('Renewal Date');

  // ── MEMBERS + PER-MEMBER PED ──
  document.getElementById('memberBody').innerHTML='';
  const rawText=text.replace(/\r/g,'');

  if(/RENEWAL\s*NOTICE/i.test(t) && !/Policy\s*Schedule/i.test(t)){
    showStatus('⚠️ This appears to be a Renewal Notice, not a Policy Bond/Schedule. Please upload the actual Policy PDF for full member details.','warn');
    return missing;
  }

  const DATE_RXG2  = /\b(\d{2}[\-][A-Za-z]{3}[\-]\d{4})\b/g;
  const GENDER_RX2 = /\b(Male|Female)\b/i;
  const RELAT_RX2  = /\b(Self|Spouse|Son|Daughter|Father|Mother|Other)\b/i;
  const SERIAL_RX2 = /^(\d{1,2})\s+\S/;
  const PED_LBL_RX = /Pre\s*Existing\s*Disease\s*[:\-]?/gi;
  const JUNK_RX    = /^[\d,\-]+$/;
  const NAME_FR_RX = /^[A-Z][A-Z\.\s]{0,35}$/;
  const STOP2_RX   = /^Nominee\s*Details/i;

  let insuredSection2=rawText;
  const sec2=rawText.match(/Details\s+of\s+Insured\s+(?:Persons?)?\s*:?([\s\S]*?)(?=Nominee\s+Details)/i);
  if(sec2) insuredSection2=sec2[1];

  const aLines=insuredSection2.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  const serialIdxs=aLines.reduce((a,l,i)=>{ if(SERIAL_RX2.test(l)) a.push(i); return a; },[]);

  const parsedMembers=[];
  serialIdxs.forEach(function(idx,mi){
    const dataLine=aLines[idx];
    const nameParts=[];
    let j=idx-1;
    while(j>=0){
      const l=aLines[j];
      if(JUNK_RX.test(l)){ j--; continue; }
      if(NAME_FR_RX.test(l)){ nameParts.unshift(l); j--; }
      else break;
    }
    const dataRest=dataLine.replace(/^\d+\s+/,'');
    const gm2=GENDER_RX2.exec(dataRest);
    if(gm2){
      let before=dataRest.slice(0,gm2.index);
      before=before.replace(DATE_RXG2,'').replace(/\b[\d,]+\b/g,'').trim();
      if(before) nameParts.push(before);
    }
    const name=nameParts.join(' ').trim();

    const dates=[...dataLine.matchAll(DATE_RXG2)].map(m=>m[1]);
    const dob=dates[0]||'';
    const inception=dates[dates.length-1]||dob;
    const gm=GENDER_RX2.exec(dataLine);
    const rm=RELAT_RX2.exec(dataLine);
    const gender=gm?gm[1]:'';
    const relation=rm?rm[1]:'';

    const nextIdx=mi+1<serialIdxs.length ? serialIdxs[mi+1]-1 : aLines.length;
    const pedLines=[];
    for(let k=idx+1;k<nextIdx;k++){
      const l=aLines[k];
      if(STOP2_RX.test(l)) break;
      if(JUNK_RX.test(l)) continue;
      const cleaned=l.replace(PED_LBL_RX,'').trim();
      if(cleaned) pedLines.push(cleaned);
    }

    const pedJoined=pedLines.join(' ').trim();
    const ped=(!pedJoined||/no\s*ped\s*declared/i.test(pedJoined))
      ?'No PED Declared'
      :pedLines.filter(l=>!/^no\s*ped\s*declared$/i.test(l)).join('\n').trim();

    if(dob&&gender){
      parsedMembers.push({name,dob,gender,relation,inception,ped});
    }
  });

  parsedMembers.forEach(pm=>{
    const pedArg=/no\s*ped/i.test(pm.ped)?'No PED Declared':pm.ped;
    addMember(pm.name, toISO(pm.dob), pm.relation, pm.gender, toISO(pm.inception), pedArg);
  });
  return missing;
}

function set(id,val){const el=document.getElementById(id);if(el)el.value=val||'';}

// ════════════════════════════════════════════════════════════
// MEMBERS TABLE
// ════════════════════════════════════════════════════════════

function addMember(name='',dob='',rel='Self',gender='Male',inception='',ped='No PED Declared'){
  const tbody=document.getElementById('memberBody');
  const tr=document.createElement('tr');
  const hasPed = ped && !/no\s*ped/i.test(ped);
  tr.innerHTML=`
    <td><input class="m-name" value="${escH(name)}" placeholder="Name"></td>
    <td><input class="m-dob" type="date" value="${dob}"></td>
    <td><select class="m-rel">
      ${['Self','Spouse','Son','Daughter','Father','Mother','Other'].map(r=>`<option ${r===rel?'selected':''}>${r}</option>`).join('')}
    </select></td>
    <td><select class="m-gender">
      <option ${gender==='Male'?'selected':''}>Male</option>
      <option ${gender==='Female'?'selected':''}>Female</option>
    </select></td>
    <td><input class="m-incept" type="date" value="${inception}"></td>
    <td><select class="m-ped ped-sel" onchange="toggleMemberPED(this)">
      <option value="no" ${!hasPed?'selected':''}>No PED</option>
      <option value="yes" ${hasPed?'selected':''}>Has PED</option>
    </select></td>
    <td class="ped-txt-cell"><textarea class="m-pedtext" style="width:100%;min-height:32px;font-size:10px;border:1px solid #e3eaf5;border-radius:5px;padding:3px;" ${!hasPed?'disabled':''}>${escH(hasPed?ped:'')}</textarea></td>
    <td><button type="button" onclick="this.closest('tr').remove()" style="background:#fef2f2;color:#b91c1c;border:none;border-radius:5px;padding:4px 8px;cursor:pointer;font-size:11px;">✕</button></td>
  `;
  tbody.appendChild(tr);
}

function toggleMemberPED(sel){
  const txt=sel.closest('tr').querySelector('.m-pedtext');
  txt.disabled = sel.value==='no';
  if(sel.value==='no') txt.value='';
}

function getMembers(){
  const rows=document.querySelectorAll('#memberBody tr');
  const members=[];
  rows.forEach(r=>{
    const name=r.querySelector('.m-name').value.trim();
    if(!name) return;
    const pedStatus=r.querySelector('.m-ped').value;
    members.push({
      name,
      dob:r.querySelector('.m-dob').value,
      relation:r.querySelector('.m-rel').value,
      gender:r.querySelector('.m-gender').value,
      inception:r.querySelector('.m-incept').value,
      pedStatus,
      pedText: pedStatus==='yes' ? r.querySelector('.m-pedtext').value.trim() : ''
    });
  });
  return members;
}

// ════════════════════════════════════════════════════════════
// DOCUMENT UPLOAD HANDLING (form-level, before save)
// ════════════════════════════════════════════════════════════

let formDocs={};
let formPhoto='';

const DOC_TYPES=[
  {key:'photo',icon:'🤳',label:'Customer Photo'},
  {key:'aadhaar',icon:'🪪',label:'Aadhaar Card'},
  {key:'pan',icon:'💳',label:'PAN Card'},
  {key:'cheque',icon:'🏦',label:'Cancelled Cheque'},
  {key:'policy',icon:'📄',label:'Policy Bond / PDF'},
];

function renderDocGrid(){
  const grid=document.getElementById('docGrid');
  grid.innerHTML=DOC_TYPES.map(dt=>{
    const d=formDocs[dt.key];
    const isImg=d&&d.startsWith('data:image');
    return `<div class="doc-item" style="border-color:${d?'#27ae60':'#cbd5e1'};">
      ${d?`<button class="doc-remove" onclick="removeDoc('${dt.key}')">✕</button>`:''}
      ${d&&isImg?`<img class="doc-thumb" src="${d}">`:''}
      ${d&&!isImg?`<div style="font-size:24px;">📄</div>`:''}
      <div class="doc-icon">${d?'':dt.icon}</div>
      <div class="doc-label" style="color:${d?'#27ae60':'#64748b'};">${d?'✅ ':''}${dt.label}</div>
      <input type="file" id="docFile-${dt.key}" accept="${dt.key==='policy'?'application/pdf,image/*':'image/*'}" onchange="handleDoc(event,'${dt.key}')">
      ${!d?`<button type="button" onclick="triggerDoc('${dt.key}')" style="position:absolute;inset:0;background:transparent;border:none;cursor:pointer;"></button>`:''}
    </div>`;
  }).join('');
}

function triggerDoc(key){document.getElementById('docFile-'+key).click();}

function handleDoc(event,key){
  const file=event.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{ formDocs[key]=e.target.result; renderDocGrid(); };
  reader.readAsDataURL(file);
  event.target.value='';
}

function removeDoc(key){ delete formDocs[key]; renderDocGrid(); }

function previewPhoto(event){
  const file=event.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    formPhoto=e.target.result;
    document.getElementById('photoPreview').innerHTML=`<img src="${formPhoto}" style="width:100%;height:100%;object-fit:cover;">`;
  };
  reader.readAsDataURL(file);
}

// ════════════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════════════

function showStatus(msg,type){
  const el=document.getElementById('status');
  el.innerHTML=msg; el.className=type; el.style.display='block';
}
function hideStatus(){ document.getElementById('status').style.display='none'; }

let pageHistory=['home'];
function showPage(id,el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  if(el) el.classList.add('active');
  pageHistory.push(id);
  if(id==='renewal') renderRenewals();
  if(id==='customers') renderAll();
  if(id==='home'){ renderRecentHome(); }
}

function goBack(){
  pageHistory.pop();
  const prevPage=pageHistory[pageHistory.length-1]||'home';
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+prevPage).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const tabBtns=document.querySelectorAll('.tab');
  tabBtns.forEach(b=>{ if(b.textContent.toLowerCase().includes(prevPage==='customers'?'customers':prevPage)) b.classList.add('active'); });
  if(prevPage==='home') renderRecentHome();
  if(prevPage==='renewal') renderRenewals();
  if(prevPage==='customers') renderAll();
}

function escH(s){ return (s||'').toString().replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDate(d){
  if(!d) return '—';
  const dt=new Date(d);
  if(isNaN(dt)) return d;
  return dt.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function copyText(val,label){
  navigator.clipboard.writeText(val).then(()=>showStatus('✅ '+label+' copied!','ok')).catch(()=>{});
}

// ════════════════════════════════════════════════════════════
// SAVE CUSTOMER (uploads docs to Drive, saves metadata to DB file)
// ════════════════════════════════════════════════════════════

async function saveCustomer(){
  const name=document.getElementById('fName').value.trim();
  if(!name){ alert('Please enter customer name!'); return; }
  const policy=document.getElementById('fPolicy').value.trim();
  const mobile=document.getElementById('fMobile').value.trim();

  // ── DUPLICATE CHECK ──
  const dup=customersCache.find(c=>{
    if(policy && c.policy && c.policy===policy) return true;
    if(mobile && c.mobile && c.mobile===mobile &&
       name && c.name && c.name.toLowerCase()===name.toLowerCase()) return true;
    return false;
  });
  if(dup){
    const go=confirm('⚠️ Duplicate detected!\n\n"'+dup.name+'" already exists with '+(dup.policy===policy?'the same Policy No.':'the same name + mobile')+'\n\nSave anyway?');
    if(!go){ resetForm(); document.getElementById('formCard').style.display='none'; return; }
  }

  const saveBtn=document.getElementById('saveBtn');
  saveBtn.disabled=true; saveBtn.textContent='⏳ Saving to Google Drive...';

  try{
    const customerId='cust_'+Date.now();
    const driveFolderId=await ensureCustomerFolder(name, null);

    // Upload all documents to Drive
    const docLinks={};
    for(const dt of DOC_TYPES){
      if(formDocs[dt.key]){
        const ext=formDocs[dt.key].startsWith('data:image/png')?'png':
                  formDocs[dt.key].startsWith('data:image')?'jpg':'pdf';
        const fname=(dt.label+'_'+name).replace(/\s+/g,'_')+'.'+ext;
        const uploaded=await uploadDocToDrive(formDocs[dt.key], fname, driveFolderId);
        docLinks[dt.key]={fileId:uploaded.id, link:uploaded.webViewLink};
      }
    }
    let photoLink='';
    if(formPhoto){
      const uploaded=await uploadDocToDrive(formPhoto,'Photo_'+name.replace(/\s+/g,'_')+'.jpg',driveFolderId);
      photoLink=uploaded.webViewLink;
    }

    const c={
      id:customerId,
      name, mobile,
      email:document.getElementById('fEmail').value.trim(),
      policy,
      product:document.getElementById('fProduct').value,
      premium:document.getElementById('fPremium').value.trim(),
      sumInsured:document.getElementById('fSum').value.trim(),
      startDate:document.getElementById('fStart').value,
      renewalDate:document.getElementById('fRenewal').value,
      members:getMembers(),
      photoLink,
      docs:docLinks,
      driveFolderId,
      savedAt:new Date().toISOString()
    };

    customersCache.push(c);
    await saveDatabase();

    resetForm();
    showStatus('✅ Customer saved to Google Drive: <strong>'+escH(name)+'</strong>','ok');
    document.getElementById('formCard').style.display='none';
    renderRecentHome();
  }catch(e){
    console.error(e);
    showStatus('❌ Save failed: '+e.message,'err');
  }
  saveBtn.disabled=false; saveBtn.textContent='💾 Save Customer';
}

function resetForm(){
  ['fName','fMobile','fEmail','fPolicy','fPremium','fSum','fStart','fRenewal'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('memberBody').innerHTML='';
  formDocs={}; formPhoto='';
  document.getElementById('photoPreview').innerHTML='🧑';
  renderDocGrid();
}

// ════════════════════════════════════════════════════════════
// RENDER: HOME RECENT LIST
// ════════════════════════════════════════════════════════════

function renderRecentHome(){
  // Home page doesn't show a list by default in this layout, but we keep stats updated
  const totalEl=document.getElementById('totalCount');
  if(totalEl) totalEl.textContent=customersCache.length;
}

// ════════════════════════════════════════════════════════════
// RENDER: CUSTOMERS LIST + SEARCH
// ════════════════════════════════════════════════════════════

function renewalBadge(dateStr){
  if(!dateStr) return '';
  const today=new Date(); today.setHours(0,0,0,0);
  const rd=new Date(dateStr); rd.setHours(0,0,0,0);
  const diffDays=Math.round((rd-today)/86400000);
  if(diffDays<0) return `<span class="badge due">Expired</span>`;
  if(diffDays===0) return `<span class="badge due">Due Today</span>`;
  if(diffDays<=15) return `<span class="badge soon">${diffDays}d left</span>`;
  return `<span class="badge ok">Active</span>`;
}

function custRow(c){
  const initials=(c.name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  return `<div class="cust-item" onclick="viewCust('${c.id}')">
    <div class="av">${initials}</div>
    <div class="ci">
      <div class="name">${escH(c.name)}</div>
      <div class="sub">${escH(c.mobile||'—')} · ${escH(c.policy||'—')}</div>
      <div class="sub2">Renewal: ${fmtDate(c.renewalDate)}</div>
    </div>
    ${renewalBadge(c.renewalDate)}
  </div>`;
}

function renderAll(){
  const q=(document.getElementById('searchInput')?.value||'').toLowerCase();
  let all=[...customersCache].sort((a,b)=>new Date(b.savedAt)-new Date(a.savedAt));
  if(q) all=all.filter(c=>
    c.name.toLowerCase().includes(q)||
    (c.mobile||'').includes(q)||
    (c.policy||'').includes(q)||
    (c.members||[]).some(m=>(m.name||'').toLowerCase().includes(q))
  );
  const listEl=document.getElementById('allList');
  const countEl=document.getElementById('totalCount');
  if(countEl) countEl.textContent=customersCache.length;
  if(!all.length){ listEl.innerHTML='<div class="empty">No customers found.</div>'; return; }
  listEl.innerHTML=all.map(custRow).join('');
}

// WebView-safe search binding
window.addEventListener('load',()=>{
  const si=document.getElementById('searchInput');
  if(si){
    ['input','keyup','change','propertychange'].forEach(ev=>{
      si.addEventListener(ev,function(){ renderAll(); });
    });
  }
});

// ════════════════════════════════════════════════════════════
// RENDER: RENEWALS DASHBOARD
// ════════════════════════════════════════════════════════════

function renderRenewals(){
  const today=new Date(); today.setHours(0,0,0,0);
  const todayList=[], soon15=[], thisMonth=[];

  customersCache.forEach(c=>{
    if(!c.renewalDate) return;
    const rd=new Date(c.renewalDate); rd.setHours(0,0,0,0);
    const diffDays=Math.round((rd-today)/86400000);
    if(diffDays===0) todayList.push(c);
    else if(diffDays>0 && diffDays<=15) soon15.push(c);
    else if(rd.getMonth()===today.getMonth() && rd.getFullYear()===today.getFullYear() && diffDays>15) thisMonth.push(c);
  });

  document.getElementById('todayCount').textContent=todayList.length;
  document.getElementById('soon15Count').textContent=soon15.length;
  document.getElementById('monthCount').textContent=thisMonth.length;

  document.getElementById('todayList').innerHTML=todayList.length?todayList.map(custRow).join(''):'<div class="empty">No renewals today 🎉</div>';
  document.getElementById('soon15List').innerHTML=soon15.length?soon15.map(custRow).join(''):'<div class="empty">No upcoming renewals in 15 days.</div>';
  document.getElementById('monthList').innerHTML=thisMonth.length?thisMonth.map(custRow).join(''):'<div class="empty">No more renewals this month.</div>';
}

// ════════════════════════════════════════════════════════════
// CUSTOMER DETAIL VIEW
// ════════════════════════════════════════════════════════════

function viewCust(id){
  const c=customersCache.find(x=>x.id===id); if(!c) return;
  const initials=(c.name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();

  const membHtml=(c.members&&c.members.length)
    ? c.members.map(m=>{
        const hasPed=m.pedStatus==='yes'&&m.pedText;
        return `<div class="memb-row">
          <div>
            <div class="memb-name">${escH(m.name)} <span class="memb-meta">(${escH(m.relation)}, ${escH(m.gender)})</span></div>
            <div class="memb-meta">DOB: ${fmtDate(m.dob)} · Inception: ${fmtDate(m.inception)}</div>
          </div>
          <span class="ped-chip ${hasPed?'has':'no'}" title="${hasPed?escH(m.pedText):''}">${hasPed?'🔴 Has PED':'✅ No PED'}</span>
        </div>`;
      }).join('')
    : '<div class="empty">No members recorded</div>';

  const docTypes=DOC_TYPES;
  const docsHtml=`<div class="doc-grid">${docTypes.map(dt=>{
    const d=c.docs&&c.docs[dt.key];
    return `<div class="doc-item${d?' has-doc':''}"
      style="cursor:${d?'pointer':'default'};opacity:${d?'1':'0.45'};border:2px solid ${d?'#27ae60':'#ccc'};"
      onclick="${d?`window.open('${d.link}','_blank')`:''}"
      title="${d?'Tap to view '+dt.label+' in Google Drive':'Not uploaded'}">
      <div style="font-size:28px;text-align:center;${!d?'filter:grayscale(1);':''}">${dt.icon}</div>
      <div class="doc-label" style="font-size:11px;text-align:center;margin-top:4px;color:${d?'#27ae60':'#999'};">
        ${d?'✅ '+dt.label:'❌ '+dt.label}
      </div>
    </div>`;
  }).join('')}</div>`;

  document.getElementById('detailContent').innerHTML=`
    <div class="det-hdr">
      <div class="det-av">${c.photoLink?`<img src="${c.photoLink}">`:initials}</div>
      <div class="det-hinfo">
        <h2>${escH(c.name)}</h2>
        <p>${escH(c.mobile||'—')} ${c.email?' · '+escH(c.email):''}</p>
        <span class="det-badge">${escH(c.product||'Star Health')}</span>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h3>Policy Details</h3>
        <div class="ir"><span class="lb">Policy No.</span><span class="vl">${escH(c.policy||'—')}</span></div>
        <div class="ir"><span class="lb">Premium</span><span class="vl">₹${c.premium?Number(c.premium).toLocaleString('en-IN'):'—'}</span></div>
        <div class="ir"><span class="lb">Sum Insured</span><span class="vl">₹${escH(c.sumInsured||'—')}</span></div>
      </div>
      <div class="info-box">
        <h3>Validity</h3>
        <div class="ir"><span class="lb">Start Date</span><span class="vl">${fmtDate(c.startDate)}</span></div>
        <div class="ir"><span class="lb">Renewal Date</span><span class="vl">${fmtDate(c.renewalDate)}</span></div>
        <div class="ir"><span class="lb">Status</span><span class="vl">${renewalBadge(c.renewalDate)}</span></div>
      </div>
    </div>

    <div class="members-section">
      <h3>👨‍👩‍👧 Insured Members (${(c.members||[]).length})</h3>
      ${membHtml}
    </div>

    <div class="docs-section">
      <h3>📎 Documents</h3>
      ${docsHtml}
    </div>

    <div class="act-bar">
      <button class="ab blue" onclick="window.location.href='tel:${escH(c.mobile)}'">📞 Call</button>
      <button class="ab wapp" onclick="window.open('https://wa.me/91${(c.mobile||'').replace(/\D/g,'')}')">💬 WhatsApp</button>
      <button class="ab purple" onclick="shareDocs('${c.id}')">📤 Share</button>
      <button class="ab red" onclick="deleteCust('${c.id}')">🗑 Delete</button>
    </div>`;

  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-detail').classList.add('active');
  pageHistory.push('detail');
}

// ════════════════════════════════════════════════════════════
// SHARE — sends Drive links via WhatsApp/native share
// ════════════════════════════════════════════════════════════

async function shareDocs(id){
  const c=customersCache.find(x=>x.id===id); if(!c) return;
  const docs=c.docs||{};
  const available=DOC_TYPES.filter(dt=>docs[dt.key]);

  let shareText='📋 '+c.name+' — Star Health\nPolicy: '+(c.policy||'—')+
    '\nPremium: ₹'+(c.premium?Number(c.premium).toLocaleString('en-IN'):'—')+
    '\nValid: '+fmtDate(c.startDate)+' → '+fmtDate(c.renewalDate)+'\n';

  if(c.driveFolderId){
    shareText+='\n📁 All documents:\nhttps://drive.google.com/drive/folders/'+c.driveFolderId+'\n';
  }
  if(available.length){
    shareText+='\nIndividual files:\n'+available.map(dt=>`• ${dt.label}: ${docs[dt.key].link}`).join('\n');
  }

  if(navigator.share){
    try{ await navigator.share({title:c.name+' — Documents',text:shareText}); return; }
    catch(e){ if(e.name==='AbortError') return; }
  }
  // Fallback: copy + open WhatsApp
  copyText(shareText,'Share text');
  window.open('https://wa.me/?text='+encodeURIComponent(shareText));
}

// ════════════════════════════════════════════════════════════
// DELETE CUSTOMER
// ════════════════════════════════════════════════════════════

async function deleteCust(id){
  const c=customersCache.find(x=>x.id===id); if(!c) return;
  const sure=confirm('Delete "'+c.name+'"?\n\nThis removes them from the database. Files in Google Drive will NOT be deleted automatically — you can remove the folder manually if needed.');
  if(!sure) return;
  customersCache=customersCache.filter(x=>x.id!==id);
  await saveDatabase();
  goBack();
  renderAll(); renderRecentHome();
}

// ════════════════════════════════════════════════════════════
// EXCEL EXPORT (CSV with exact headers requested)
// ════════════════════════════════════════════════════════════

function downloadExcelReport(){
  if(!customersCache.length){ alert('No customers saved yet.'); return; }

  const headers=[
    'Policy No','Proposer Name','S. No','Name of the Insured','Date of Birth',
    'Relationship with Proposer','Sum Insured','Inception Date','PED','Due for Renewal','Mobile Number'
  ];
  const rows=[headers];

  customersCache.forEach(c=>{
    const members=(c.members&&c.members.length)?c.members:[{name:'',dob:'',relation:'',inception:'',pedStatus:'no',pedText:''}];
    members.forEach((m,idx)=>{
      rows.push([
        c.policy?'="'+c.policy+'"':'',
        c.name||'',
        idx+1,
        m.name||'',
        m.dob?fmtDate(m.dob):'',
        m.relation||'',
        c.sumInsured||'',
        m.inception?fmtDate(m.inception):'',
        (m.pedStatus==='yes'&&m.pedText)?m.pedText:'No PED',
        c.renewalDate?fmtDate(c.renewalDate):'',
        c.mobile||''
      ]);
    });
  });

  const csv='\uFEFF'+rows.map(r=>r.map(v=>{
    const s=String(v||'').replace(/"/g,'""');
    return /[,\n"]/.test(s)?'"'+s+'"':s;
  }).join(',')).join('\n');

  const today=new Date().toISOString().split('T')[0];
  const filename='StarHealth_Report_'+today+'.csv';
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});

  if(/Android/i.test(navigator.userAgent)){
    // Save report copy into Drive root app folder too
    (async()=>{
      try{
        const reader=new FileReader();
        reader.onload=async(e)=>{
          await uploadDocToDrive(e.target.result, filename, appFolderId);
          showStatus('✅ Report saved to your Google Drive (StarDoc Manager Data folder)!','ok');
        };
        reader.readAsDataURL(blob);
      }catch(e){ alert('Could not save report: '+e.message); }
    })();
  } else {
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

// ════════════════════════════════════════════════════════════
// EXCEL IMPORT (CSV) — bulk add customers
// ════════════════════════════════════════════════════════════

async function importExcel(event){
  const file=event.target.files[0]; if(!file) return;
  showLoading('Importing customers from Excel...');
  try{
    const text=await file.text();
    const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(l=>l.trim());
    if(lines.length<2){ alert('No data rows found in file.'); hideLoading(); return; }

    const headers=parseCsvLine(lines[0]).map(h=>h.trim());
    const idx=name=>headers.findIndex(h=>h.toLowerCase().includes(name.toLowerCase()));

    const iPolicy=idx('Policy No'), iName=idx('Proposer Name'), iMemberName=idx('Name of the Insured'),
          iDob=idx('Date of Birth'), iRelation=idx('Relationship'), iSum=idx('Sum Insured'),
          iIncept=idx('Inception'), iPed=idx('PED'), iRenewal=idx('Due for Renewal'), iMobile=idx('Mobile');

    const grouped={};
    for(let i=1;i<lines.length;i++){
      const cols=parseCsvLine(lines[i]);
      const policy=(cols[iPolicy]||'').replace(/^="?|"?$/g,'').trim();
      const key=policy||cols[iName];
      if(!key) continue;
      if(!grouped[key]) grouped[key]={
        policy, name:cols[iName]||'', mobile:cols[iMobile]||'',
        sumInsured:cols[iSum]||'', renewalDate:parseDateFlexible(cols[iRenewal]),
        members:[]
      };
      const pedVal=(cols[iPed]||'').trim();
      grouped[key].members.push({
        name:cols[iMemberName]||'', dob:parseDateFlexible(cols[iDob]),
        relation:cols[iRelation]||'Self', gender:'',
        inception:parseDateFlexible(cols[iIncept]),
        pedStatus: (pedVal && !/no\s*ped/i.test(pedVal))?'yes':'no',
        pedText: (pedVal && !/no\s*ped/i.test(pedVal))?pedVal:''
      });
    }

    let added=0;
    Object.values(grouped).forEach(g=>{
      const exists=customersCache.find(c=>c.policy && c.policy===g.policy);
      if(exists) return;
      customersCache.push({
        id:'cust_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),
        name:g.name, mobile:g.mobile, email:'', policy:g.policy,
        product:'Star Health Assure Insurance', premium:'', sumInsured:g.sumInsured,
        startDate:'', renewalDate:g.renewalDate, members:g.members,
        photoLink:'', docs:{}, driveFolderId:null, savedAt:new Date().toISOString()
      });
      added++;
    });

    await saveDatabase();
    renderAll(); renderRenewals(); renderRecentHome();
    showStatus('✅ Imported '+added+' new customer(s) from Excel.','ok');
  }catch(e){
    alert('Import failed: '+e.message);
  }
  hideLoading();
  event.target.value='';
}

function parseCsvLine(line){
  const result=[]; let cur=''; let inQuotes=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(inQuotes && line[i+1]==='"'){ cur+='"'; i++; }
      else inQuotes=!inQuotes;
    } else if(ch===',' && !inQuotes){
      result.push(cur); cur='';
    } else cur+=ch;
  }
  result.push(cur);
  return result;
}

function parseDateFlexible(s){
  if(!s) return '';
  s=s.trim();
  // Try DD MMM YYYY (e.g. "23 Jul 2025")
  let m=s.match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/);
  const months={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  if(m) return `${m[3]}-${months[m[2].slice(0,3)]||'01'}-${m[1].padStart(2,'0')}`;
  // Try DD-MM-YYYY or DD/MM/YYYY
  m=s.match(/(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{4})/);
  if(m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // Try YYYY-MM-DD already
  m=s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(m) return s;
  return '';
}
