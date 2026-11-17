/* Sayfa v0.1.6 — single pinned PDF.js engine and safe PDF reopening. */
/* Sayfa v0.1 — MIT. A browser-first, privacy-preserving personal PDF library. */
const $ = (id) => document.getElementById(id);
// Keep main PDF.js API and its worker at exactly the same pinned release.
const PDF_ENGINE_VERSION = '3.11.174';
const PDF_ENGINE_MAIN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDF_ENGINE_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PALETTE = ['#343434','#E5B437','#E97777','#63AC91','#6098D9','#9D78D1','#E58A46','#FFFFFF'];
const DEFAULT_SETTINGS = { tool:'hand', color:'#343434', width:4, animation:true, dark:false };
let settings = { ...DEFAULT_SETTINGS };
try { settings = {...settings,...JSON.parse(localStorage.getItem('sayfa-settings') || '{}')}; } catch (_) {}
const state = { db:null, pdfjs:null, book:null, pdfDoc:null, page:1, marks:{strokes:[],notes:[]}, undo:[], redo:[], drawing:false, pendingStroke:null, editingNote:null, notePosition:null, renderTask:null, renderSerial:0, pageUrl:null, covers:[], busy:false, nextToast:null, resizeTimer:null };
function saveSettings(){localStorage.setItem('sayfa-settings',JSON.stringify(settings));}
function toast(text, ms=2800){const el=$('toast');el.textContent=text;el.classList.add('shown');clearTimeout(state.nextToast);state.nextToast=setTimeout(()=>el.classList.remove('shown'),ms);}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function formatSize(n){if(!Number.isFinite(n))return '—';return n>=1048576?(n/1048576).toFixed(1)+' MB':(n/1024).toFixed(0)+' KB';}
function request(r){return new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('sayfa-kutuphane',1);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('books'))db.createObjectStore('books',{keyPath:'id'});if(!db.objectStoreNames.contains('marks')){const s=db.createObjectStore('marks',{keyPath:'key'});s.createIndex('bookId','bookId');}if(!db.objectStoreNames.contains('pages')){const s=db.createObjectStore('pages',{keyPath:'key'});s.createIndex('bookId','bookId');}};r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);});}
function dbRead(store,key){return request(state.db.transaction(store,'readonly').objectStore(store).get(key));}
function dbAll(store){return request(state.db.transaction(store,'readonly').objectStore(store).getAll());}
function dbPut(store,value){return new Promise((resolve,reject)=>{const tx=state.db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function dbDelete(store,key){return new Promise((resolve,reject)=>{const tx=state.db.transaction(store,'readwrite');tx.objectStore(store).delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function dbDeleteIndexed(store,index,value){return new Promise((resolve,reject)=>{const tx=state.db.transaction(store,'readwrite');const idx=tx.objectStore(store).index(index);const r=idx.openCursor(IDBKeyRange.only(value));r.onsuccess=()=>{const cursor=r.result;if(cursor){cursor.delete();cursor.continue();}};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}

let pdfEngineLoading=null;
async function pdfjs(){
  // No mixing of ESM 4.x with classic worker 3.x: all PDFs use one pinned release.
  if(state.pdfjs?.version===PDF_ENGINE_VERSION)return state.pdfjs;
  if(!pdfEngineLoading){
    pdfEngineLoading=new Promise((resolve,reject)=>{
      const initialize=(lib)=>{
        if(!lib||lib.version!==PDF_ENGINE_VERSION){
          reject(new Error('PDF okuma motorunun sürümü uyuşmuyor. Lütfen güncel Sayfa sürümünü yeniden açın.'));
          return;
        }
        lib.GlobalWorkerOptions.workerSrc=PDF_ENGINE_WORKER;
        state.pdfjs=lib;
        resolve(lib);
      };
      if(window.pdfjsLib?.version===PDF_ENGINE_VERSION){
        initialize(window.pdfjsLib);
        return;
      }
      // Loading one browser script (and one same-version worker) avoids cached mixed API/worker.
      const script=document.createElement('script');
      script.src=PDF_ENGINE_MAIN;
      script.async=true;
      script.onload=()=>initialize(window.pdfjsLib);
      script.onerror=()=>reject(new Error('PDF motoru indirilemedi. İlk kullanımda internet bağlantısı gereklidir.'));
      document.head.appendChild(script);
    }).catch(error=>{pdfEngineLoading=null;throw error;});
  }
  return pdfEngineLoading;
}
async function getPDF(source){
  let bytes;
  if(source instanceof Blob)bytes=new Uint8Array(await source.arrayBuffer());
  else if(source instanceof ArrayBuffer)bytes=new Uint8Array(source.slice(0));
  else if(ArrayBuffer.isView(source))bytes=new Uint8Array(source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength));
  else throw new Error('Kayıtlı PDF verisinin türü tanınmadı.');
  if(bytes.byteLength<10)throw new Error('Bu kitabın cihazda saklanan dosyası boş veya eksik.');
  const header=new TextDecoder('latin1').decode(bytes.subarray(0,Math.min(12,bytes.length)));
  if(!header.startsWith('%PDF-'))throw new Error('Kayıtlı dosyanın PDF başlangıcı eksik. Lütfen orijinal PDF kopyasını yeniden yükleyin.');
  const lib=await pdfjs();
  try{
    // Always give PDF.js a disposable copy. The original IndexedDB Blob/ArrayBuffer
    // must never be transferred or detached while a book is being viewed.
    return await lib.getDocument({
      data:bytes.slice(),
      stopAtErrors:false
    }).promise;
  }catch(error){
    const message=String(error?.message||error);
    console.warn('PDF açılamadı; motor:',lib.version,'boyut:',bytes.length,'hata:',error);
    if(/Invalid Root reference|Invalid XRef|Invalid PDF structure|Missing PDF|Invalid document/i.test(message)){
      throw new Error('PDF dosyasının iç dizin yapısı bozuk veya eksik. Sağlam bir PDF kopyası kullanın. ('+message+')');
    }
    throw new Error('PDF okunamadı ('+PDF_ENGINE_VERSION+'): '+message);
  }
}
function canvasBlob(canvas,mime,quality){return new Promise(resolve=>{
  try{if(typeof canvas.toBlob==='function')canvas.toBlob(resolve,mime,quality);else resolve(null);}
  catch(e){console.warn('Canvas blob oluşturulamadı:',e);resolve(null);}
});}
async function imageBlob(canvas,quality){
  const webp=await canvasBlob(canvas,'image/webp',quality);
  if(webp?.type==='image/webp')return webp;
  const jpeg=await canvasBlob(canvas,'image/jpeg',quality);
  if(jpeg)return jpeg;
  // iOS fallback when canvas.toBlob is unavailable/returns null.
  const url=canvas.toDataURL('image/jpeg',quality);
  const payload=url.split(',')[1];
  if(!payload)throw new Error('Kapak görseli üretilemedi.');
  const binary=atob(payload),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes],{type:'image/jpeg'});
}
async function renderPageToCanvas(pdfDoc,num,canvas,width=1300){const p=await pdfDoc.getPage(num);const base=p.getViewport({scale:1});const viewport=p.getViewport({scale:Math.min(width/base.width,2.8)});canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);const context=canvas.getContext('2d',{alpha:false});context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);await p.render({canvasContext:context,viewport,background:'#ffffff'}).promise;return canvas;}
async function coverFor(doc){
  const canvas=document.createElement('canvas');
  await renderPageToCanvas(doc,1,440);
  const thumb=document.createElement('canvas');
  thumb.width=224;thumb.height=Math.max(120,Math.round(224*canvas.height/canvas.width));
  const ctx=thumb.getContext('2d',{alpha:false});
  ctx.fillStyle='#fff';ctx.fillRect(0,0,thumb.width,thumb.height);
  ctx.drawImage(canvas,0,0,thumb.width,thumb.height);
  return imageBlob(thumb,.78);
}
const coverRepairAttempted=new Set();
async function repairCover(book,card){
  if(book.cover||coverRepairAttempted.has(book.id))return;
  coverRepairAttempted.add(book.id);
  let doc=null;
  try{
    let cover=null;
    if(book.type==='pdf'){
      doc=await getPDF(book.blob);
      cover=await coverFor(doc);
    }else{
      const firstPage=await dbRead('pages',book.id+':1');
      cover=firstPage?.blob||null;
    }
    if(!cover)return;
    const latest=await dbRead('books',book.id);
    if(!latest||latest.cover)return;
    latest.cover=cover;
    await dbPut('books',latest);
    if(state.book?.id===book.id)state.book.cover=cover;
    const container=card.querySelector('.book-cover');
    if(container?.isConnected){
      container.querySelector('.cover-placeholder')?.remove();
      const img=document.createElement('img');
      const url=URL.createObjectURL(cover);
      state.covers.push(url);
      img.src=url;img.alt='Kitabın ilk sayfası';
      container.prepend(img);
    }
  }catch(e){console.warn('Kapak daha sonra yeniden oluşturulabilir:',e);}
  finally{if(doc)await doc.destroy().catch(()=>{});}
}
async function ensureVisibleCover(serial){
  if(!state.book||state.book.cover||state.page!==1||serial!==state.renderSerial)return;
  const bookId=state.book.id;
  const source=state.book.type==='pdf'?$('pdfCanvas'):$('imagePage');
  const w=source.naturalWidth||source.width,h=source.naturalHeight||source.height;
  if(!w||!h)return;
  try{
    const thumb=document.createElement('canvas');
    thumb.width=224;thumb.height=Math.max(120,Math.round(224*h/w));
    const ctx=thumb.getContext('2d',{alpha:false});
    ctx.fillStyle='#fff';ctx.fillRect(0,0,thumb.width,thumb.height);
    ctx.drawImage(source,0,0,thumb.width,thumb.height);
    const cover=await imageBlob(thumb,.78);
    const latest=await dbRead('books',bookId);
    if(!latest||latest.cover)return;
    latest.cover=cover;
    await dbPut('books',latest);
    if(state.book?.id===bookId)state.book.cover=cover;
  }catch(e){console.warn('Görünen sayfadan kapak kaydedilemedi:',e);}
}
function percent(a,b){return b?Math.round(a*100/b):0;}
function uniqueId(){return typeof crypto.randomUUID==='function'?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(16).slice(2);}
function checkPdfIntegrity(arrayBuffer){
  const bytes=new Uint8Array(arrayBuffer);
  if(bytes.length<16)throw new Error('Bu dosya geçerli bir PDF değil.');
  const head=new TextDecoder('latin1').decode(bytes.subarray(0,Math.min(1400,bytes.length)));
  if(!head.startsWith('%PDF-'))throw new Error('Dosyanın başlangıcında PDF başlığı bulunamadı.');
  const tail=new TextDecoder('latin1').decode(bytes.subarray(Math.max(0,bytes.length-4096)));
  const declared=head.match(/\/Linearized\s+\d[\s\S]{0,200}?\/L\s+(\d+)/);
  const expected=declared?Number(declared[1]):0;
  if(expected>bytes.length+4096&&!tail.includes('%%EOF')){
    throw new Error('Bu PDF eksik indirilmiş veya hasarlı. Dosyanın son bölümü bulunmuyor. Lütfen sağlam bir PDF kopyası seçin.');
  }
}
function setBusy(v){state.busy=v;$('importBtn').disabled=v;$('emptyImportBtn').disabled=v;}
async function importFile(file){if(!file||!file.name.toLowerCase().endsWith('.pdf')){toast('Lütfen bir PDF dosyası seçin.');return;}
  $('importFilename').textContent=`${file.name} — ${formatSize(file.size)}`;
  $('importDialog').querySelector('input[value="original"]').checked=true;
  const dialog=$('importDialog');dialog.showModal();
  const result=await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true}));
  if(result!=='ok')return;
  const mode=dialog.querySelector('input[name="importMode"]:checked').value;
  setBusy(true);let doc=null;let id=uniqueId();let compressed=false;let stage='PDF hazırlığı';
  try{
    toast('PDF açılıyor…',20000);
    const pdfBytes=await file.arrayBuffer();
    checkPdfIntegrity(pdfBytes);
    const safeBlob=new Blob([pdfBytes],{type:'application/pdf'});
    stage='PDF sayfaları okunuyor';
    doc=await getPDF(safeBlob);
    if(!doc.numPages)throw new Error('PDF sayfaları bulunamadı.');
    // Linearized PDFs may report a page count even when their page tree is
    // incomplete; verify that both ends of the document actually open.
    stage='PDF sayfaları doğrulanıyor';
    try{
      await doc.getPage(1);
      if(doc.numPages>1)await doc.getPage(doc.numPages);
    }catch(checkError){
      throw new Error('PDF eksik veya bozuk. İlk/son sayfalar açılamıyor. '+(checkError?.message||checkError));
    }
    stage='Kapak önizlemesi hazırlanıyor';
    let cover=null;
    try{cover=await coverFor(doc);}catch(coverError){console.warn('Kapak önizlemesi atlandı:',coverError);}
    const book={id,title:file.name.replace(/\.pdf$/i,''),fileName:file.name,createdAt:Date.now(),updatedAt:Date.now(),type:'pdf',pageCount:doc.numPages,currentPage:1,bookmarks:[],cover,rawSize:file.size,storedSize:file.size,blob:pdfBytes.slice(0)};
    if(mode!=='original'){
      stage='Sayfalar sıkıştırılıyor';
      const width=mode==='strong'?1000:1450;
      const quality=mode==='strong'?.65:.80;
      let bytes=0;
      try{
        for(let i=1;i<=doc.numPages;i++){
          const canvas=document.createElement('canvas');await renderPageToCanvas(doc,i,canvas,width);
          const image=await imageBlob(canvas,quality);if(!image)throw new Error('Sayfa sıkıştırılamadı.');
          bytes+=image.size;
          await dbPut('pages',{key:`${id}:${i}`,bookId:id,page:i,blob:image,width:canvas.width,height:canvas.height});
          if(i===1||i%3===0||i===doc.numPages){toast(`Sıkıştırılıyor: ${i}/${doc.numPages} sayfa`,20000);await sleep(0);}
        }
        if(bytes < file.size*.97){book.type='images';book.blob=null;book.storedSize=bytes;compressed=true;}
        else await dbDeleteIndexed('pages','bookId',id);
      }catch(e){await dbDeleteIndexed('pages','bookId',id);throw e;}
    }
    stage='Cihazın kitaplığına kaydediliyor';
    try{await dbPut('books',book);}catch(saveError){
      // iOS Safari bazen Blob klonlamayı reddeder; kayıpsız ArrayBuffer yedeği.
      if(book.type!=='pdf')throw saveError;
      console.warn('Blob kaydı başarısız; ArrayBuffer deneniyor:',saveError);
      book.blob=pdfBytes;
      await dbPut('books',book);
    }
    stage='Kitaplık güncelleniyor';
    toast(compressed?`Kitap eklendi: %${percent(file.size-book.storedSize,file.size)} daha küçük.`:mode==='original'?'Kitap kitaplığına eklendi.':'Sıkıştırma küçültmediği için özgün PDF korundu.',5000);
    await showLibrary();
  }catch(e){await dbDeleteIndexed('pages','bookId',id).catch(()=>{});console.error('Kitap ekleme hatası ['+stage+']:',e);toast('Kitap eklenemedi ('+stage+'): '+(e.message||e),14000);}
  finally{if(doc)await doc.destroy().catch(()=>{});setBusy(false);}
}
async function showLibrary(){if(state.book){await closeReader();}const all=await dbAll('books');all.sort((a,b)=>b.updatedAt-a.updatedAt);$('bookCount').textContent=all.length?`${all.length} kitap`:'Henüz kitabın yok';const search=$('searchInput').value.trim().toLocaleLowerCase('tr');const visible=all.filter(b=>b.title.toLocaleLowerCase('tr').includes(search));state.covers.forEach(URL.revokeObjectURL);state.covers=[];const grid=$('bookGrid');grid.replaceChildren();$('libraryEmpty').classList.toggle('hidden',all.length!==0);for(const book of visible){const card=document.createElement('article');card.className='book-card';card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',book.title+' kitabını aç');const cover=document.createElement('div');cover.className='book-cover';if(book.cover){const url=URL.createObjectURL(book.cover);state.covers.push(url);const img=document.createElement('img');img.src=url;img.alt='Kitap kapağı';cover.append(img);}else cover.innerHTML=`<div class="cover-placeholder"><span>📖</span><b>${escapeHtml(book.title)}</b></div>`;const menu=document.createElement('button');menu.className='book-menu';menu.textContent='⋯';menu.title='Kitap seçenekleri';menu.addEventListener('click',e=>{e.stopPropagation();bookOptions(book);});cover.append(menu);const title=document.createElement('h3');title.textContent=book.title;const meta=document.createElement('div');meta.className='book-meta';meta.innerHTML=`<span>${book.currentPage} / ${book.pageCount} sayfa</span><span>${formatSize(book.storedSize)}</span>`;const track=document.createElement('div');track.className='progress-track';const fill=document.createElement('div');fill.className='progress-fill';fill.style.width=percent(book.currentPage,book.pageCount)+'%';track.append(fill);card.append(cover,title,meta,track);card.addEventListener('click',()=>openReader(book.id).catch(e=>toast('Kitap açılamadı: '+e.message,6000)));card.addEventListener('keydown',e=>{if(e.key==='Enter')card.click();});grid.append(card);if(!book.cover)repairCover(book,card).catch(e=>console.warn('Kapak:',e));}
  $('libraryScreen').classList.remove('hidden');$('readerScreen').classList.add('hidden');$('backBtn').classList.add('hidden');
  document.body.classList.remove('reading-mode');
  $('penPanel').classList.add('hidden');
  $('readerToolbar').classList.add('hidden');
  $('pageFooter').classList.remove('page-footer-open');
  $('readerPenBtn').setAttribute('aria-expanded','false');
}
let activeBookMenuId=null;
function bookOptions(book){
  activeBookMenuId=book.id;
  $('bookActionTitle').textContent=book.title;
  $('bookActionsDialog').showModal();
}
async function openRenameDialog(){
  const book=activeBookMenuId?await dbRead('books',activeBookMenuId):null;
  $('bookActionsDialog').close();
  if(!book)return;
  $('renameBookInput').value=book.title;
  $('renameBookDialog').showModal();
  $('renameBookInput').focus();
  $('renameBookInput').select();
}
async function renameBookFromMenu(){
  const id=activeBookMenuId;
  const name=$('renameBookInput').value.trim();
  if(!id||!name){toast('Kitap adı boş olamaz.',4500);return;}
  const book=await dbRead('books',id);
  if(!book)return;
  book.title=name;book.updatedAt=Date.now();
  await dbPut('books',book);
  $('renameBookDialog').close();
  await showLibrary();
  toast('Kitap adı değiştirildi.');
}
async function openDeleteBookDialog(){
  const book=activeBookMenuId?await dbRead('books',activeBookMenuId):null;
  $('bookActionsDialog').close();
  if(!book)return;
  $('deleteBookTitle').textContent=book.title;
  $('deleteBookDialog').showModal();
}
async function deleteBookFromMenu(){
  const id=activeBookMenuId;
  if(!id)return;
  $('deleteBookConfirm').disabled=true;
  try{
    await dbDeleteIndexed('marks','bookId',id);
    await dbDeleteIndexed('pages','bookId',id);
    await dbDelete('books',id);
    activeBookMenuId=null;
    $('deleteBookDialog').close();
    await showLibrary();
    toast('Kitap silindi.');
  }finally{$('deleteBookConfirm').disabled=false;}
}
function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function openReader(id){const book=await dbRead('books',id);if(!book)throw new Error('Kitap bulunamadı.');if(state.book)await closeReader();state.book=book;state.page=book.currentPage||1;try{if(book.type==='pdf')state.pdfDoc=await getPDF(book.blob);}catch(e){state.book=null;throw e;}
  $('libraryScreen').classList.add('hidden');$('readerScreen').classList.remove('hidden');
  document.body.classList.add('reading-mode');
  $('backBtn').classList.add('hidden');
  $('readerToolbar').classList.add('hidden');
  $('penPanel').classList.add('hidden');
  $('pageFooter').classList.remove('page-footer-open');
  $('readerPenBtn').setAttribute('aria-expanded','false');
  $('readerBookTitle').textContent=book.title;
  $('pageSlider').max=String(book.pageCount);
  $('pageAnimationBtn').classList.toggle('active',settings.animation);
  $('saveStatus').textContent='Kitap açık';
  selectTool('hand');
  await goToPage(state.page,false);
}
async function closeReader(){if(!state.book)return;state.renderSerial++;if(state.renderTask){state.renderTask.cancel();await state.renderTask.promise.catch(()=>{});state.renderTask=null;}if(state.pdfDoc){await state.pdfDoc.destroy().catch(()=>{});state.pdfDoc=null;}if(state.pageUrl){URL.revokeObjectURL(state.pageUrl);state.pageUrl=null;}state.book=null;state.marks={strokes:[],notes:[]};$('pageSheet').classList.remove('turn-next','turn-prev');}
function updatePager(){if(!state.book)return;$('readerPageBadge').textContent=state.page+' / '+state.book.pageCount;$('pageCount').textContent=`${state.page} / ${state.book.pageCount}`;$('pageSlider').value=String(state.page);for(const id of ['prevPageBtn','previousPageFloat'])$(id).disabled=state.page<=1;for(const id of ['nextPageBtn','nextPageFloat'])$(id).disabled=state.page>=state.book.pageCount;const saved=state.book.bookmarks||[];$('bookmarkBtn').classList.toggle('active',saved.includes(state.page));$('bookmarkBtn').firstChild.textContent=saved.includes(state.page)?'★ ':'☆ ';}
async function loadMarks(bookId,page,serial){
  const record=await dbRead('marks',`${bookId}:${page}`);
  if(!state.book||state.book.id!==bookId||state.page!==page||serial!==state.renderSerial)return false;
  state.marks=record?{strokes:record.strokes||[],notes:record.notes||[]}:{strokes:[],notes:[]};
  state.undo=[];state.redo=[];renderAnnotations();renderNotePins();return true;
}
async function saveMarks(){
  if(!state.book)return;
  const bookId=state.book.id,page=state.page;
  const marks=JSON.parse(JSON.stringify(state.marks));
  $('saveStatus').textContent='Kaydediliyor…';
  await dbPut('marks',{key:`${bookId}:${page}`,bookId,page,strokes:marks.strokes,notes:marks.notes});
  if(state.book&&state.book.id===bookId&&state.page===page)$('saveStatus').textContent='Notlar kaydedildi';
}
function snapshot(){state.undo.push(JSON.stringify(state.marks));if(state.undo.length>50)state.undo.shift();state.redo=[];}
async function undo(){if(!state.undo.length||state.drawing)return;state.redo.push(JSON.stringify(state.marks));state.marks=JSON.parse(state.undo.pop());renderAnnotations();renderNotePins();await saveMarks();}
async function redo(){if(!state.redo.length||state.drawing)return;state.undo.push(JSON.stringify(state.marks));state.marks=JSON.parse(state.redo.pop());renderAnnotations();renderNotePins();await saveMarks();}
function makePageFlipSnapshot(){
  const sheet=$('pageSheet');
  sheet.querySelectorAll('.page-turn-overlay').forEach(el=>el.remove());
  const source=$('pdfCanvas').classList.contains('hidden')?$('imagePage'):$('pdfCanvas');
  const w=source.naturalWidth||source.width,h=source.naturalHeight||source.height;
  if(!w||!h)return null;
  try{
    const overlay=document.createElement('canvas');
    overlay.className='page-turn-overlay';
    overlay.width=Math.min(w,860);
    overlay.height=Math.round(overlay.width*h/w);
    const ctx=overlay.getContext('2d');
    ctx.drawImage(source,0,0,overlay.width,overlay.height);
    const annotations=$('annotationCanvas');
    if(annotations.width)ctx.drawImage(annotations,0,0,overlay.width,overlay.height);
    sheet.append(overlay);
    return overlay;
  }catch(e){console.warn('Sayfa animasyonu önizlemesi:',e);return null;}
}
function finishPageFlip(overlay,dir){
  if(!overlay?.isConnected)return;
  const w=overlay.width,h=overlay.height;
  const snapshot=document.createElement('canvas');
  snapshot.width=w;snapshot.height=h;
  snapshot.getContext('2d',{alpha:false}).drawImage(overlay,0,0);
  const ctx=overlay.getContext('2d',{alpha:true});
  const forward=dir==='next';
  const reduce=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const duration=reduce?180:840;
  const start=performance.now();
  const edgeAt=(t,y)=>{
    const v=y/h;
    const bend=(Math.sin(Math.PI*v)*.085+(v-.5)*.065)*Math.sin(Math.PI*t)*w;
    return Math.max(0,Math.min(w,(forward?(1-t):t)*w+bend));
  };
  function drawFrame(t){
    const ease=t*t*(3-2*t);
    const curl=Math.sin(Math.PI*ease);
    ctx.clearRect(0,0,w,h);
    if(ease>=1)return;
    const segments=Math.max(20,Math.ceil(h/22)),step=h/segments;
    ctx.save();
    ctx.beginPath();
    if(forward){
      ctx.moveTo(0,0);ctx.lineTo(edgeAt(ease,0),0);
      for(let i=1;i<=segments;i++)ctx.lineTo(edgeAt(ease,step*i),Math.min(h,step*i));
      ctx.lineTo(0,h);
    }else{
      ctx.moveTo(w,0);ctx.lineTo(edgeAt(ease,0),0);
      for(let i=1;i<=segments;i++)ctx.lineTo(edgeAt(ease,step*i),Math.min(h,step*i));
      ctx.lineTo(w,h);
    }
    ctx.closePath();ctx.clip();
    ctx.drawImage(snapshot,0,0,w,h);
    ctx.restore();
    if(curl<.003)return;
    const side=forward?1:-1;
    // An irregular, rounded crease suggests a paper cylinder, not a rotating flat rectangle.
    const foldedW=(.10+.075*curl)*w*curl;
    ctx.save();ctx.beginPath();
    for(let i=0;i<=segments;i++){
      const y=Math.min(h,i*step),x=edgeAt(ease,y);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    for(let i=segments;i>=0;i--){
      const y=Math.min(h,i*step),x=edgeAt(ease,y);
      const taper=.4+.6*Math.sin(Math.PI*(y/h));
      ctx.lineTo(x+side*foldedW*taper,y);
    }
    ctx.closePath();
    const gradient=ctx.createLinearGradient(
      forward?w*(1-ease):w*ease,0,
      (forward?w*(1-ease):w*ease)+side*foldedW,0
    );
    gradient.addColorStop(0,'rgba(55,48,38,.43)');
    gradient.addColorStop(.24,'rgba(190,180,164,.84)');
    gradient.addColorStop(.57,'rgba(255,254,250,.98)');
    gradient.addColorStop(1,'rgba(218,212,204,.94)');
    ctx.fillStyle=gradient;ctx.fill();
    ctx.strokeStyle='rgba(74,66,54,.34)';
    ctx.lineWidth=Math.max(.8,w/650);
    ctx.stroke();
    ctx.restore();
    // Soft shadow cast onto the newly revealed page.
    const shadowWidth=w*.075*curl;
    for(let i=0;i<segments;i++){
      const y=i*step,edge=edgeAt(ease,y+step/2);
      const shadow=ctx.createLinearGradient(edge-side*shadowWidth,y,edge+side*shadowWidth,y);
      shadow.addColorStop(0,'rgba(0,0,0,0)');
      shadow.addColorStop(.5,'rgba(39,34,27,.19)');
      shadow.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=shadow;
      const x=Math.min(edge-shadowWidth,edge+shadowWidth);
      ctx.fillRect(Math.max(0,x),y,Math.min(2*shadowWidth,w),step+1);
    }
  }
  drawFrame(0);
  function tick(now){
    if(!overlay.isConnected)return;
    const elapsed=Math.min(1,(now-start)/duration);
    drawFrame(elapsed);
    if(elapsed<1)requestAnimationFrame(tick);
    else overlay.remove();
  }
  requestAnimationFrame(tick);
}
async function goToPage(number,animate=true){
  if(!state.book)return;
  number=Math.max(1,Math.min(state.book.pageCount,Number(number)||1));
  const previous=state.page;
  if(number===previous&&animate)return;
  const overlay=(animate&&settings.animation&&previous!==number)?makePageFlipSnapshot():null;
  state.page=number;
  state.book.currentPage=number;
  state.book.updatedAt=Date.now();
  const serial=++state.renderSerial,bookId=state.book.id;
  updatePager();
  $('pageFooter').classList.remove('page-footer-open');
  try{
    await dbPut('books',state.book);
    if(serial!==state.renderSerial){overlay?.remove();return;}
    $('saveStatus').textContent='Kaldığın yer kaydedildi';
    if(!await loadMarks(bookId,number,serial)){overlay?.remove();return;}
    await paintPage(serial);
    if(serial!==state.renderSerial){overlay?.remove();return;}
    if(overlay)requestAnimationFrame(()=>finishPageFlip(overlay,number>previous?'next':'prev'));
  }catch(e){overlay?.remove();throw e;}
}
async function paintPage(serial){if(!state.book||serial!==state.renderSerial)return;let ownTask=null;const sheet=$('pageSheet');const canvas=$('pdfCanvas');const image=$('imagePage');const spinner=$('pageSpinner');spinner.textContent='Sayfa hazırlanıyor…';spinner.classList.remove('hidden');sheet.classList.remove('turn-next','turn-prev');try{
    if(state.renderTask){const oldTask=state.renderTask;state.renderTask=null;oldTask.cancel();await oldTask.promise.catch(()=>{});}
    if(serial!==state.renderSerial)return;
    if(state.pageUrl){URL.revokeObjectURL(state.pageUrl);state.pageUrl=null;}
    if(state.book.type==='pdf'){
      canvas.classList.remove('hidden');image.classList.add('hidden');image.removeAttribute('src');
      const p=await state.pdfDoc.getPage(state.page);if(serial!==state.renderSerial)return;
      const base=p.getViewport({scale:1});
       const area=$('viewerArea'),cs=getComputedStyle(area);
       const usableWidth=Math.max(180,area.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-2);
       const usableHeight=Math.max(200,area.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom)-2);
       const scale=Math.min(Math.min(usableWidth,780)/base.width,usableHeight/base.height,3.5);
       const viewport=p.getViewport({scale});const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(viewport.width*dpr);canvas.height=Math.round(viewport.height*dpr);canvas.style.width=Math.round(viewport.width)+'px';canvas.style.height=Math.round(viewport.height)+'px';sheet.style.width=Math.round(viewport.width)+'px';sheet.style.height=Math.round(viewport.height)+'px';sheet.style.minHeight='0';sheet.style.aspectRatio='auto';const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      ownTask=p.render({canvasContext:ctx,viewport,transform:[dpr,0,0,dpr,0,0],background:'#ffffff'});state.renderTask=ownTask;await ownTask.promise;
    } else {
      canvas.classList.add('hidden');image.classList.remove('hidden');const record=await dbRead('pages',`${state.book.id}:${state.page}`);if(!record)throw new Error('Sıkıştırılmış sayfa bulunamadı.');const url=URL.createObjectURL(record.blob);state.pageUrl=url;const area=$('viewerArea'),cs=getComputedStyle(area);
       const usableWidth=Math.max(180,area.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-2);
       const usableHeight=Math.max(200,area.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom)-2);
       const scale=Math.min(Math.min(usableWidth,780)/record.width,usableHeight/record.height,1);
       sheet.style.width=Math.round(record.width*scale)+'px';
       sheet.style.height=Math.round(record.height*scale)+'px';
       sheet.style.aspectRatio=`${record.width} / ${record.height}`;
       sheet.style.minHeight='0';image.src=url;await new Promise((resolve,reject)=>{if(image.complete&&image.naturalWidth)return resolve();image.onload=resolve;image.onerror=()=>reject(new Error('Görsel açılamadı.'));});
    }
    if(serial!==state.renderSerial)return;spinner.classList.add('hidden');setupDrawingCanvas();renderAnnotations();renderNotePins();if(state.page===1&&!state.book.cover)ensureVisibleCover(serial).catch(e=>console.warn('Kapak:',e));$('viewerArea').scrollTo({top:0,behavior:'auto'});
  }catch(e){if(serial!==state.renderSerial)return;console.error(e);spinner.textContent='Sayfa açılamadı: '+(e.message||'bilinmeyen hata');toast('Sayfa açılamadı: '+e.message,6000);}finally{if(state.renderTask===ownTask)state.renderTask=null;}
}
function setupDrawingCanvas(){const sheet=$('pageSheet');const canvas=$('annotationCanvas');const w=sheet.clientWidth,h=sheet.clientHeight;if(w<2||h<2)return;const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';canvas.getContext('2d').setTransform(dpr,0,0,dpr,0,0);}
function pointFrom(e){const rect=$('annotationCanvas').getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))};}
function drawStroke(ctx,stroke,rect){const points=stroke.points||[];if(!points.length)return;const scale=rect.width/550;let width=Math.max(.8,(stroke.width||4)*scale);ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle=stroke.color||'#343434';ctx.fillStyle=stroke.color||'#343434';ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';if(stroke.tool==='highlighter'){width*=3.2;ctx.globalAlpha=.34;ctx.globalCompositeOperation='multiply';}else if(stroke.tool==='pencil'){ctx.globalAlpha=.65;width*=.72;}else if(stroke.tool==='marker'){width*=1.25;}else if(stroke.tool==='underline'||stroke.tool==='strike'){width*=.88;}
  ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(points[0].x*rect.width,points[0].y*rect.height);if(points.length===1){ctx.lineTo(points[0].x*rect.width+.01,points[0].y*rect.height+.01);}else for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x*rect.width,points[i].y*rect.height);ctx.stroke();ctx.restore();}
function renderAnnotations(){const canvas=$('annotationCanvas');if(!canvas.width)return;const ctx=canvas.getContext('2d');const dpr=Math.min(window.devicePixelRatio||1,2);ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.restore();const rect={width:canvas.clientWidth,height:canvas.clientHeight};for(const s of state.marks.strokes)drawStroke(ctx,s,rect);if(state.pendingStroke)drawStroke(ctx,state.pendingStroke,rect);}
function renderNotePins(){const container=$('notePins');container.replaceChildren();for(const n of state.marks.notes){const pin=document.createElement('button');pin.className='note-pin';pin.textContent='✎';pin.title=n.text;pin.style.left=(n.x*100)+'%';pin.style.top=(n.y*100)+'%';pin.addEventListener('click',e=>{e.stopPropagation();editNote(n);});container.append(pin);}}
function distToSegment(p,a,b){const dx=b.x-a.x,dy=b.y-a.y;const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot((p.x-a.x-t*dx)*1.0,(p.y-a.y-t*dy)*1.0);}
function eraseAt(point){const canvas=$('annotationCanvas');const radius=Math.max(.015,settings.width*.002);const before=state.marks.strokes.length;state.marks.strokes=state.marks.strokes.filter(s=>{for(let i=0;i<s.points.length;i++){const a=s.points[i],b=s.points[i+1]||a;const p={x:point.x,y:point.y};const corrected={x: p.x*(canvas.clientWidth/canvas.clientHeight),y:p.y};const aa={x:a.x*(canvas.clientWidth/canvas.clientHeight),y:a.y};const bb={x:b.x*(canvas.clientWidth/canvas.clientHeight),y:b.y};if(distToSegment(corrected,aa,bb)<radius)return false;}return true;});if(before!==state.marks.strokes.length)renderAnnotations();}
function onPointerDown(e){if(!state.book||state.busy||settings.tool==='hand')return;if(e.button!==undefined&&e.button!==0)return;const p=pointFrom(e);if(settings.tool==='note'){state.notePosition=p;state.editingNote=null;$('noteText').value='';$('deleteNoteBtn').classList.add('hidden');$('noteDialog').showModal();return;}
  e.preventDefault();state.drawing=true;try{e.target.setPointerCapture(e.pointerId);}catch(_){}snapshot();if(settings.tool==='eraser'){eraseAt(p);}else{state.pendingStroke={id:uniqueId(),tool:settings.tool,color:settings.color,width:settings.width,points:[p]};renderAnnotations();}}
function onPointerMove(e){if(!state.drawing)return;e.preventDefault();const p=pointFrom(e);if(settings.tool==='eraser'){eraseAt(p);return;}if(!state.pendingStroke)return;if(settings.tool==='underline'||settings.tool==='strike'){state.pendingStroke.points=[state.pendingStroke.points[0],{x:p.x,y:state.pendingStroke.points[0].y}];}else{const last=state.pendingStroke.points.at(-1);if(Math.hypot(last.x-p.x,last.y-p.y)>.001)state.pendingStroke.points.push(p);}renderAnnotations();}
async function onPointerUp(e){if(!state.drawing)return;e.preventDefault();state.drawing=false;try{e.target.releasePointerCapture(e.pointerId);}catch(_){}if(state.pendingStroke){state.marks.strokes.push(state.pendingStroke);state.pendingStroke=null;}renderAnnotations();try{await saveMarks();}catch(err){toast('Çizim kaydedilemedi: '+err.message,5500);}}
function editNote(note){state.editingNote=note;state.notePosition={x:note.x,y:note.y};$('noteText').value=note.text;$('deleteNoteBtn').classList.remove('hidden');$('noteDialog').showModal();}
async function saveNote(){const text=$('noteText').value.trim();if(!text){toast('Boş not kaydedilmedi.');return;}snapshot();if(state.editingNote){state.editingNote.text=text;}else{state.marks.notes.push({id:uniqueId(),text,...state.notePosition,createdAt:Date.now()});}$('noteDialog').close();renderNotePins();await saveMarks();}
async function deleteNote(){if(!state.editingNote)return;snapshot();state.marks.notes=state.marks.notes.filter(n=>n.id!==state.editingNote.id);$('noteDialog').close();renderNotePins();await saveMarks();}
function selectTool(tool){settings.tool=tool;document.body.classList.toggle('pen-active',tool!=='hand');saveSettings();document.querySelectorAll('.pen-tool').forEach(b=>b.classList.toggle('selected',b.dataset.tool===tool));$('pageSheet').classList.toggle('drawing',tool!=='hand');$('annotationCanvas').style.pointerEvents=tool==='hand'?'none':'auto';$('annotationCanvas').style.touchAction=tool==='hand'?'auto':'none';updatePreview();}
function updatePreview(){document.querySelectorAll('.swatch').forEach(s=>s.classList.toggle('selected',s.dataset.color===settings.color));$('widthSlider').value=String(settings.width);$('widthOutput').textContent=settings.width+' / 12';const path=$('previewPath');path.setAttribute('stroke',settings.tool==='eraser'?'#777777':settings.color);path.setAttribute('stroke-width',String(settings.width*(settings.tool==='highlighter'?1.6:1)));path.setAttribute('opacity',String(settings.tool==='highlighter'?.40:settings.tool==='pencil'?.65:1));}
function setupSwipeGestures(){
  const area=$('viewerArea');let start=null;
  area.addEventListener('touchstart',e=>{
    if(settings.tool!=='hand'||!state.book||state.busy||e.touches.length!==1||e.target.closest('button')||document.querySelector('dialog[open]')){start=null;return;}
    const t=e.touches[0];start={x:t.clientX,y:t.clientY,at:Date.now(),page:state.page};
  },{passive:true});
  area.addEventListener('touchend',e=>{
    if(!start)return;
    const pos=start;start=null;
    if(settings.tool!=='hand'||!state.book||e.changedTouches.length!==1||pos.page!==state.page)return;
    const t=e.changedTouches[0],dx=t.clientX-pos.x,dy=t.clientY-pos.y;
    const threshold=Math.max(48,Math.min(area.clientWidth*.15,85));
    if(Math.abs(dx)>=threshold&&Math.abs(dx)>Math.abs(dy)*1.3&&Date.now()-pos.at<1700){
      goToPage(state.page+(dx<0?1:-1)).catch(err=>toast(err.message,5000));
    }
  },{passive:true});
  area.addEventListener('touchcancel',()=>{start=null;},{passive:true});
}
function togglePenPanel(){
  const panel=$('penPanel'),open=panel.classList.contains('hidden');
  panel.classList.toggle('hidden',!open);
  $('readerPenBtn').setAttribute('aria-expanded',String(open));
  $('readerPenBtn').classList.toggle('active',open);
  $('readerToolbar').classList.add('hidden');
}
function setupControls(){
  $('renameBookOption').addEventListener('click',()=>openRenameDialog().catch(e=>toast(e.message)));
  $('deleteBookOption').addEventListener('click',()=>openDeleteBookDialog().catch(e=>toast(e.message)));
  $('renameBookConfirm').addEventListener('click',()=>renameBookFromMenu().catch(e=>toast(e.message,6000)));
  $('deleteBookConfirm').addEventListener('click',()=>deleteBookFromMenu().catch(e=>toast(e.message,6000)));
  const colors=$('colorPalette');PALETTE.forEach(c=>{const b=document.createElement('button');b.className='swatch';b.style.backgroundColor=c;b.dataset.color=c;b.title='Kalem rengi '+c;b.setAttribute('aria-label',b.title);b.addEventListener('click',()=>{settings.color=c;saveSettings();updatePreview();});colors.append(b);});updatePreview();document.querySelectorAll('.pen-tool').forEach(b=>b.addEventListener('click',()=>selectTool(b.dataset.tool)));$('widthSlider').addEventListener('input',e=>{settings.width=Number(e.target.value);saveSettings();updatePreview();});$('undoBtn').addEventListener('click',()=>undo().catch(e=>toast(e.message)));$('redoBtn').addEventListener('click',()=>redo().catch(e=>toast(e.message)));setupSwipeGestures();const canvas=$('annotationCanvas');canvas.addEventListener('pointerdown',onPointerDown);canvas.addEventListener('pointermove',onPointerMove);canvas.addEventListener('pointerup',onPointerUp);canvas.addEventListener('pointercancel',onPointerUp);
  $('importBtn').addEventListener('click',()=>$('fileInput').click());$('emptyImportBtn').addEventListener('click',()=>$('fileInput').click());$('fileInput').addEventListener('change',async e=>{const files=Array.from(e.target.files||[]);e.target.value='';for(const f of files)await importFile(f);});$('backBtn').addEventListener('click',()=>showLibrary().catch(e=>toast(e.message)));
   $('readerBackBtn').addEventListener('click',()=>showLibrary().catch(e=>toast(e.message)));
   $('readerPenBtn').addEventListener('click',togglePenPanel);
   $('closePenBtn').addEventListener('click',togglePenPanel);
   $('readerMoreBtn').addEventListener('click',()=>{
     $('penPanel').classList.add('hidden');
     $('readerPenBtn').setAttribute('aria-expanded','false');
     $('readerToolbar').classList.toggle('hidden');
   });
   $('readerPageBadge').addEventListener('click',()=>$('pageFooter').classList.toggle('page-footer-open'));$('searchInput').addEventListener('input',()=>showLibrary().catch(e=>toast(e.message)));$('themeBtn').addEventListener('click',()=>{settings.dark=!settings.dark;saveSettings();applyTheme();});$('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());$('penToolbarBtn').addEventListener('click',togglePenPanel);$('pageAnimationBtn').addEventListener('click',()=>{settings.animation=!settings.animation;saveSettings();$('pageAnimationBtn').classList.toggle('active',settings.animation);toast(settings.animation?'Sayfa animasyonu açıldı.':'Sayfa animasyonu kapatıldı.');});$('bookmarkBtn').addEventListener('click',async()=>{if(!state.book)return;const saved=state.book.bookmarks||[];state.book.bookmarks=saved.includes(state.page)?saved.filter(p=>p!==state.page):[...saved,state.page].sort((a,b)=>a-b);await dbPut('books',state.book);updatePager();toast(saved.includes(state.page)?'Yer imi kaldırıldı.':'Yer imi kaydedildi.');});$('notesListBtn').addEventListener('click',()=>{const notes=state.marks.notes;const msg=notes.length?notes.map((n,i)=>`${i+1}. ${n.text}`).join('\n\n'):'Bu sayfada metin notu bulunmuyor. “Not” aracını seçip sayfaya dokunabilirsiniz.';alert(msg);});$('saveNoteBtn').addEventListener('click',()=>saveNote().catch(e=>toast(e.message)));$('deleteNoteBtn').addEventListener('click',()=>deleteNote().catch(e=>toast(e.message)));for(const id of ['prevPageBtn','previousPageFloat'])$(id).addEventListener('click',()=>goToPage(state.page-1).catch(e=>toast(e.message)));for(const id of ['nextPageBtn','nextPageFloat'])$(id).addEventListener('click',()=>goToPage(state.page+1).catch(e=>toast(e.message)));$('pageSlider').addEventListener('change',e=>goToPage(Number(e.target.value)).catch(err=>toast(err.message)));window.addEventListener('keydown',e=>{if(!state.book||document.querySelector('dialog[open]'))return;if(e.target.matches('input,textarea'))return;if(e.ctrlKey&&e.key.toLowerCase()==='z'){e.preventDefault();(e.shiftKey?redo():undo()).catch(err=>toast(err.message));}else if(e.key==='ArrowRight')goToPage(state.page+1).catch(err=>toast(err.message));else if(e.key==='ArrowLeft')goToPage(state.page-1).catch(err=>toast(err.message));});window.addEventListener('resize',()=>{if(!state.book)return;clearTimeout(state.resizeTimer);state.resizeTimer=setTimeout(()=>paintPage(++state.renderSerial),240);});}
function applyTheme(){document.body.classList.toggle('dark',settings.dark);$('themeBtn').textContent=settings.dark?'☀':'☾';}
const APP_VERSION='0.1.6';
let updateCheckPending=false;
let availableVersion=null;
async function checkForUpdates(manual=false){
  if(updateCheckPending)return;
  if(!navigator.onLine){
    if(manual)toast('Güncelleme kontrolü için internet bağlantısı gerekli.',5000);
    return;
  }
  if(state.busy||state.drawing){
    if(manual)toast('Önce devam eden işlemi bitirin.',4000);
    return;
  }
  updateCheckPending=true;
  const button=$('updateBtn');
  if(button)button.disabled=true;
  try{
    // Unique URL also bypasses cache-first service workers from older installations.
    const url=new URL('./version.json',location.href);
    url.searchParams.set('check',String(Date.now()));
    const response=await fetch(url.href,{cache:'no-store'});
    if(!response.ok)throw new Error('Sürüm bilgisi alınamadı.');
    const remote=await response.json();
    const version=String(remote.version||'').trim();
    if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Sürüm bilgisi geçersiz.');
    let registration=null;
    if('serviceWorker' in navigator){
      registration=await navigator.serviceWorker.getRegistration().catch(()=>null);
      if(registration)await registration.update().catch(e=>console.warn('SW update:',e));
    }
    if(version===APP_VERSION){
      availableVersion=null;
      if(button){button.classList.remove('update-ready');button.title='Güncellemeyi kontrol et';}
      if(manual)toast('Sayfa v'+APP_VERSION+' güncel.',3500);
      return;
    }
    availableVersion=version;
    if(button){
      button.classList.add('update-ready');
      button.title='Yeni sürüm v'+version+' — yüklemek için dokunun';
    }
    if(state.book){
      if(manual){
        if(!confirm('Sayfa v'+version+' hazır. Yeni sürümü yüklemek için açık kitap kapanacak. Devam edilsin mi?'))return;
      }else{
        toast('Yeni sürüm v'+version+' hazır. Yüklemek için üstteki ↻ simgesine dokunun.',7000);
        return;
      }
    }
    const attemptKey='sayfa-update-attempt:'+version;
    const lastAttempt=Number(sessionStorage.getItem(attemptKey)||'0');
    if(!manual&&Date.now()-lastAttempt<60000){
      toast('Yeni sürüm hazır. Üstteki ↻ simgesinden güncelleyebilirsiniz.',6000);
      return;
    }
    sessionStorage.setItem(attemptKey,String(Date.now()));
    toast('Sayfa v'+version+' yükleniyor…',3000);
    const destination=new URL('./',location.href);
    destination.searchParams.set('v',version);
    destination.searchParams.set('refresh',String(Date.now()));
    location.replace(destination.href);
  }catch(e){
    console.warn('Sürüm kontrolü:',e);
    if(manual)toast('Güncelleme kontrol edilemedi: '+(e.message||e),7000);
  }finally{
    updateCheckPending=false;
    if(button)button.disabled=false;
  }
}
async function init(){
  applyTheme();
  setupControls();
  $('updateBtn')?.addEventListener('click',()=>checkForUpdates(true));
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden)checkForUpdates(false);
  });
  window.addEventListener('online',()=>checkForUpdates(false));
  try{
    state.db=await openDB();
    await showLibrary();
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
    if('serviceWorker' in navigator&&location.protocol!=='file:'){
      navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'})
        .then(reg=>reg.update().catch(e=>console.warn('SW update:',e)))
        .catch(e=>console.warn('SW registration:',e));
    }
    // Do not interrupt reading/drawing; otherwise refresh on new release.
    checkForUpdates(false);
  }catch(e){
    console.error(e);
    toast('Uygulama veritabanı başlatılamadı: '+e.message,10000);
  }
}
init();