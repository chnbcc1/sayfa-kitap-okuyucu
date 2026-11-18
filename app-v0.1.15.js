/* Sayfa v0.1.15 — touch-linked live page curls, cancellation, pre-rendered underside. */
import {setupSafeLibrary,bookDigest} from './safety-v0.1.7.js';
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
// Patch only changed fields, atomically. A page-turn must never erase a new cover.
function dbPatchBook(bookId,fields){
  return new Promise((resolve,reject)=>{
    const tx=state.db.transaction('books','readwrite');
    const store=tx.objectStore('books');
    let updated=null;
    const request=store.get(bookId);
    request.onsuccess=()=>{
      if(!request.result){tx.abort();return;}
      updated={...request.result,...fields};
      store.put(updated);
    };
    tx.oncomplete=()=>resolve(updated);
    tx.onerror=()=>reject(tx.error||new Error('Kitap kaydı güncellenemedi.'));
    tx.onabort=()=>reject(new Error('Kitap kaydı bulunamadı.'));
  });
}
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
async function coverDataURL(blob){
  if(typeof blob==='string'&&blob.startsWith('data:image/'))return blob;
  if(!(blob instanceof Blob))throw new Error('Kapak verisi geçersiz.');
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>typeof reader.result==='string'&&reader.result.startsWith('data:image/')?resolve(reader.result):reject(new Error('Kapak okunamadı.'));
    reader.onerror=()=>reject(reader.error||new Error('Kapak dosyası okunamadı.'));
    reader.readAsDataURL(blob);
  });
}
async function coverFor(doc){
  // Produce a thumbnail from page one before presenting the book in the library.
  // Keep the render small to avoid Safari's canvas memory limits.
  const page=await doc.getPage(1);
  const base=page.getViewport({scale:1});
  if(base.width<=0||base.height<=0)throw new Error('PDF ilk sayfasının boyutu geçersiz.');
  const scale=Math.min(1,440/base.width);
  const viewport=page.getViewport({scale:Math.max(.1,scale)});
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(viewport.width));
  canvas.height=Math.max(1,Math.round(viewport.height));
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw new Error('Kapak çizim alanı oluşturulamadı.');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:ctx,viewport,background:'#ffffff'}).promise;
  const thumb=document.createElement('canvas');
  thumb.width=224;thumb.height=Math.max(120,Math.round(224*canvas.height/canvas.width));
  const thumbCtx=thumb.getContext('2d',{alpha:false});
  if(!thumbCtx)throw new Error('Kapak küçük resim alanı oluşturulamadı.');
  thumbCtx.fillStyle='#fff';thumbCtx.fillRect(0,0,thumb.width,thumb.height);
  thumbCtx.drawImage(canvas,0,0,thumb.width,thumb.height);
  const image=await canvasBlob(thumb,'image/jpeg',.84);
  if(!image||image.size<100)throw new Error('Kapak görseli boş oluşturuldu.');
  return image;
}
const coverRepairInflight=new Map();
const coverRetryTimes=new Map();
function showCoverInCard(card,src,onFailure){
  const area=card?.querySelector('.book-cover');
  if(!area||!card.isConnected||!src)return;
  const img=new Image();
  img.alt='Kitap kapağı';
  img.onload=()=>{
    if(!card.isConnected)return;
    area.querySelectorAll('img,.cover-placeholder').forEach(el=>el.remove());
    area.insertBefore(img,area.firstChild);
  };
  img.onerror=()=>{
    // Do not leave a broken image or an expired object URL in the library.
    if(!card.isConnected)return;
    area.querySelector('img')?.remove();
    onFailure?.();
  };
  img.src=src;
}
async function ensureCardCover(book,card){
  if(!card?.isConnected)return;
  if(book.coverDataUrl){
    showCoverInCard(card,book.coverDataUrl,()=>repairCover(book,card,{force:true}));
    return;
  }
  if(book.cover instanceof Blob&&book.cover.size>100){
    try{
      const src=await coverDataURL(book.cover);
      // Some older Safari builds saved a Blob that later cannot be decoded.
      const img=new Image();
      await new Promise((resolve,reject)=>{
        img.onload=resolve;
        img.onerror=()=>reject(new Error('Eski kapak çözülmedi.'));
        img.src=src;
      });
      await dbPatchBook(book.id,{coverDataUrl:src});
      if(card.isConnected)showCoverInCard(card,src,()=>repairCover(book,card,{force:true}));
      return;
    }catch(e){console.warn('Eski kapak yeniden oluşturulacak:',e);}
  }
  if(card.isConnected)await repairCover(book,card,{force:true});
}
async function repairCover(book,card=null,{force=false}={}){
  if(book.coverDataUrl&&!force){
    if(card)showCoverInCard(card,book.coverDataUrl,()=>repairCover(book,card,{force:true}));
    return true;
  }
  if(coverRepairInflight.has(book.id))return coverRepairInflight.get(book.id);
  const last=coverRetryTimes.get(book.id)||0;
  if(!force&&Date.now()-last<12000)return false;
  coverRetryTimes.set(book.id,Date.now());
  const work=(async()=>{
    let doc=null;
    try{
      let cover=null;
      if(book.type==='pdf'){
        doc=await getPDF(book.blob);
        cover=await coverFor(doc);
      }else{
        const firstPage=await dbRead('pages',book.id+':1');
        if(firstPage?.blob){
          // Older iPhones might not expose createImageBitmap: use an Image fallback.
          let bitmap=null,temporaryUrl=null;
          try{
            if(typeof createImageBitmap==='function')bitmap=await createImageBitmap(firstPage.blob);
          }catch(e){console.warn('Alternatif kapak çözme kullanılacak:',e);}
          if(!bitmap){
            temporaryUrl=URL.createObjectURL(firstPage.blob);
            bitmap=new Image();
            await new Promise((resolve,reject)=>{
              bitmap.onload=resolve;
              bitmap.onerror=()=>reject(new Error('Görsel sayfa okunamadı.'));
              bitmap.src=temporaryUrl;
            });
          }
          const canvas=document.createElement('canvas');
          canvas.width=224;
          canvas.height=Math.max(120,Math.round(224*bitmap.height/bitmap.width));
          canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
          bitmap.close?.();
          if(temporaryUrl)URL.revokeObjectURL(temporaryUrl);
          cover=await canvasBlob(canvas,'image/jpeg',.84);
        }
      }
      if(!cover)return false;
      const dataUrl=await coverDataURL(cover);
      const saved=await dbPatchBook(book.id,{cover,coverDataUrl:dataUrl});
      if(state.book?.id===book.id){
        state.book.cover=cover;
        state.book.coverDataUrl=dataUrl;
      }
      if(card)showCoverInCard(card,dataUrl,()=>console.warn('Oluşturulan kapak açılamadı:',book.title));
      coverRetryTimes.delete(book.id);
      return !!saved;
    }catch(e){
      console.warn('Kapak yeniden denenecek:',book.title,e);
      return false;
    }finally{if(doc)await doc.destroy().catch(()=>{});}
  })();
  coverRepairInflight.set(book.id,work);
  try{return await work;}finally{coverRepairInflight.delete(book.id);}
}
async function ensureVisibleCover(serial){
  if(!state.book||state.book.coverDataUrl||state.page!==1||serial!==state.renderSerial)return;
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
    const cover=await canvasBlob(thumb,'image/jpeg',.84);
    if(!cover)throw new Error('Kapak çizilemedi.');
    const coverDataUrl=await coverDataURL(cover);
    if(serial!==state.renderSerial||state.book?.id!==bookId)return;
    await dbPatchBook(bookId,{cover,coverDataUrl});
    if(state.book?.id===bookId){
      state.book.cover=cover;
      state.book.coverDataUrl=coverDataUrl;
    }
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
    stage='PDF bütünlüğü hesaplanıyor';
    const pdfHash=await bookDigest(pdfBytes);
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
    let cover=null,coverDataUrl=null;
    try{
      cover=await coverFor(doc);
      coverDataUrl=await coverDataURL(cover);
    }catch(coverError){console.warn('Kapak önizlemesi atlandı:',coverError);}
    const book={id,title:file.name.replace(/\.pdf$/i,''),fileName:file.name,createdAt:Date.now(),updatedAt:Date.now(),type:'pdf',pageCount:doc.numPages,currentPage:1,bookmarks:[],cover,coverDataUrl,sha256:pdfHash,verifiedAt:Date.now(),rawSize:file.size,storedSize:file.size,blob:pdfBytes.slice(0)};
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
        if(bytes < file.size*.97){
          book.type='images';
          // Keep the original PDF even when the optimized reading images are smaller.
          book.originalBlob=pdfBytes.slice(0);
          book.blob=null;
          book.storedSize=bytes+pdfBytes.byteLength;
          compressed=true;
        }
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
    stage='Cihazdaki kayıt doğrulanıyor';
    const confirmed=await dbRead('books',id);
    if(!confirmed)throw new Error('PDF cihaz veritabanında bulunamadı.');
    const verifiedBytes=confirmed.type==='pdf'?confirmed.blob:confirmed.originalBlob;
    if(!verifiedBytes||await bookDigest(verifiedBytes)!==pdfHash)throw new Error('Kaydedilen orijinal PDF bütünlük doğrulamasını geçemedi.');
    if(confirmed.type==='images'){
      const first=await dbRead('pages',id+':1');
      const last=await dbRead('pages',id+':'+confirmed.pageCount);
      if(!first?.blob||!last?.blob)throw new Error('Görüntü sayfaları eksik kaydedildi.');
    }
    // A cover is prepared before the library list is displayed, not on first opening.
    // If the initial thumbnail render failed, reopen the saved PDF and retry.
    let coverReady=!!confirmed.coverDataUrl;
    if(!coverReady){
      stage='Kitap kapağı hazırlanıyor';
      if(doc){await doc.destroy().catch(()=>{});doc=null;}
      coverReady=await repairCover(confirmed,null,{force:true});
    }
    stage='Kitaplık güncelleniyor';
    toast(!coverReady?'Kitap güvenle kaydedildi. Kapak henüz oluşturulamadı; kitaplıkta otomatik yeniden denenecek.':compressed?'Kitap ve orijinal PDF korundu (görsel önizleme eklendi).':mode==='original'?'Kitap kitaplığına eklendi. Yedek almayı unutmayın.':'Sıkıştırma uygun değil; orijinal PDF korundu.',7000);
    await showLibrary();
    if(!coverReady){
      // Retry automatically even if the user never opens the book.
      setTimeout(async()=>{
        try{
          const saved=await dbRead('books',id);
          if(saved&&!saved.cover){
            const card=Array.from($('bookGrid').querySelectorAll('.book-card')).find(el=>el.dataset.bookId===id);
            await repairCover(saved,card,{force:true});
          }
        }catch(e){console.warn('Gecikmeli kapak onarma:',e);}
      },5500);
    }
  }catch(e){await dbDeleteIndexed('pages','bookId',id).catch(()=>{});console.error('Kitap ekleme hatası ['+stage+']:',e);toast('Kitap eklenemedi ('+stage+'): '+(e.message||e),14000);}
  finally{if(doc)await doc.destroy().catch(()=>{});setBusy(false);}
}
async function showLibrary(){if(state.book){await closeReader();}const all=await dbAll('books');all.sort((a,b)=>b.updatedAt-a.updatedAt);$('bookCount').textContent=all.length?`${all.length} kitap`:'Henüz kitabın yok';const search=$('searchInput').value.trim().toLocaleLowerCase('tr');const visible=all.filter(b=>b.title.toLocaleLowerCase('tr').includes(search));state.covers.forEach(URL.revokeObjectURL);state.covers=[];const grid=$('bookGrid');grid.replaceChildren();$('libraryEmpty').classList.toggle('hidden',all.length!==0);for(const book of visible){const card=document.createElement('article');card.className='book-card';card.dataset.bookId=book.id;card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',book.title+' kitabını aç');const cover=document.createElement('div');cover.className='book-cover';cover.innerHTML=`<div class="cover-placeholder"><span>📖</span><b>${escapeHtml(book.title)}</b></div>`;const menu=document.createElement('button');menu.className='book-menu';menu.textContent='⋯';menu.title='Kitap seçenekleri';menu.addEventListener('click',e=>{e.stopPropagation();bookOptions(book);});cover.append(menu);const title=document.createElement('h3');title.textContent=book.title;const meta=document.createElement('div');meta.className='book-meta';meta.innerHTML=`<span>${book.currentPage} / ${book.pageCount} sayfa</span><span>${formatSize(book.storedSize)}</span>`;const track=document.createElement('div');track.className='progress-track';const fill=document.createElement('div');fill.className='progress-fill';fill.style.width=percent(book.currentPage,book.pageCount)+'%';track.append(fill);card.append(cover,title,meta,track);card.addEventListener('click',()=>openReader(book.id).catch(e=>toast('Kitap açılamadı: '+e.message,6000)));card.addEventListener('keydown',e=>{if(e.key==='Enter')card.click();});grid.append(card);ensureCardCover(book,card).catch(e=>console.warn('Kapak:',e));}
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
  await dbPatchBook(id,{title:name,updatedAt:book.updatedAt});
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
async function openReader(id){
  const book=await dbRead('books',id);
  if(!book)throw new Error('Kitap bulunamadı.');
  if(state.book)await closeReader();
  state.book=book;state.page=book.currentPage||1;
  try{
    if(book.type==='pdf'){
      if(book.sha256&&await bookDigest(book.blob)!==book.sha256)throw new Error('Kayıtlı PDF dosyası bütünlük doğrulamasını geçemedi. Lütfen yedeğinizi saklayın.');
      state.pdfDoc=await getPDF(book.blob);
      if(!book.sha256){
        book.sha256=await bookDigest(book.blob);
        book.verifiedAt=Date.now();
        await dbPatchBook(id,{sha256:book.sha256,verifiedAt:book.verifiedAt});
      }
    }else if(book.originalBlob&&book.sha256&&await bookDigest(book.originalBlob)!==book.sha256){
      throw new Error('Sıkıştırılmış kitabın orijinal PDF bütünlüğü doğrulanamadı.');
    }
  }catch(e){state.book=null;throw e;}
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
async function closeReader(){stopCurlGesture();clearPagePreviewCache();if(!state.book)return;state.renderSerial++;if(state.renderTask){state.renderTask.cancel();await state.renderTask.promise.catch(()=>{});state.renderTask=null;}if(state.pdfDoc){await state.pdfDoc.destroy().catch(()=>{});state.pdfDoc=null;}if(state.pageUrl){URL.revokeObjectURL(state.pageUrl);state.pageUrl=null;}state.book=null;state.marks={strokes:[],notes:[]};$('pageSheet').classList.remove('turn-next','turn-prev');}
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
  for(const key of pagePreviewCache.keys())if(key.startsWith(bookId+':'+page+':'))pagePreviewCache.delete(key);
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
function createCurlPainter(overlay,dir){
  if(!overlay?.isConnected)return null;
  const original=document.createElement('canvas');
  original.width=overlay.width;original.height=overlay.height;
  original.getContext('2d',{alpha:false}).drawImage(overlay,0,0);
  const w=overlay.width,h=overlay.height;
  const ctx=overlay.getContext('2d',{alpha:true});
  const next=dir==='next';
  const bands=Math.max(32,Math.min(64,Math.ceil(h/19)));
  const rowH=h/bands;
  const clamp=x=>Math.max(0,Math.min(w,x));
  // Finger motion must be linear; release animation is eased separately.

  // The snapshot is the EXISTING TOP page. The newly rendered page stays
  // stationary below it and is revealed wherever this canvas becomes clear.
  // +1 (next): right edge travels right-to-left; backside folds to the left.
  // -1 (previous): left edge travels left-to-right; backside folds to the right.
  function paperAt(t,y){
    const v=y/h,arc=Math.sin(Math.PI*t);
    const cornerLead=(v-.5)*w*.048*arc;
    const topBow=Math.sin(v*Math.PI)*w*.018*arc;
    const crease=clamp((next?(1-t):t)*w+cornerLead+topBow*(next?-1:1));
    const folded=w*.195*Math.pow(Math.max(0,arc),.9)*(.65+.35*Math.sin(Math.PI*v));
    return {crease,folded,
      front:clamp(crease+(next?-folded:folded))};
  }
  function traceFront(t){
    ctx.beginPath();
    if(next){
      ctx.moveTo(0,0);ctx.lineTo(paperAt(t,0).front,0);
      for(let i=1;i<=bands;i++){
        const y=Math.min(h,i*rowH);ctx.lineTo(paperAt(t,y).front,y);
      }
      ctx.lineTo(0,h);
    }else{
      ctx.moveTo(w,0);ctx.lineTo(paperAt(t,0).front,0);
      for(let i=1;i<=bands;i++){
        const y=Math.min(h,i*rowH);ctx.lineTo(paperAt(t,y).front,y);
      }
      ctx.lineTo(w,h);
    }
    ctx.closePath();
  }
  function traceFold(t){
    ctx.beginPath();
    for(let i=0;i<=bands;i++){
      const y=Math.min(h,i*rowH),p=paperAt(t,y);
      if(i===0)ctx.moveTo(p.front,y);else ctx.lineTo(p.front,y);
    }
    for(let i=bands;i>=0;i--){
      const y=Math.min(h,i*rowH),p=paperAt(t,y);
      ctx.lineTo(p.crease,y);
    }
    ctx.closePath();
  }
  function drawFrame(progress){
    const t=Math.max(0,Math.min(1,progress)),curvature=Math.sin(Math.PI*t);
    ctx.clearRect(0,0,w,h);
    if(t>=.99999)return;

    // 1. The original readable page stays in front until its edge has turned.
    ctx.save();
    traceFront(t);ctx.clip();
    ctx.drawImage(original,0,0,w,h);
    ctx.restore();
    if(curvature<.006)return;

    // 2. Only the now-exposed new page (already rendered underneath) receives
    // a slight shadow cast by the original page's curved leading edge.
    ctx.save();
    for(let i=0;i<bands;i++){
      const y=i*rowH,mid=Math.min(h,y+rowH/2),p=paperAt(t,mid);
      const width=w*.075*curvature;
      let x0,x1;
      if(next){x0=p.crease;x1=clamp(p.crease+width);}
      else{x0=clamp(p.crease-width);x1=p.crease;}
      if(x1-x0<1)continue;
      const g=ctx.createLinearGradient(x0,0,x1,0);
      if(next){
        g.addColorStop(0,'rgba(38,32,24,.22)');
        g.addColorStop(.35,'rgba(38,32,24,.09)');
        g.addColorStop(1,'rgba(38,32,24,0)');
      }else{
        g.addColorStop(0,'rgba(38,32,24,0)');
        g.addColorStop(.65,'rgba(38,32,24,.09)');
        g.addColorStop(1,'rgba(38,32,24,.22)');
      }
      ctx.fillStyle=g;ctx.fillRect(x0,y,x1-x0,rowH+1);
    }
    ctx.restore();

    // 3. The BACK of that same top page folds *into the top page*.
    // It must not extend onto the newly revealed page: that is what used to
    // make the new page appear to be opening above the current one.
    ctx.save();
    traceFold(t);ctx.clip();
    ctx.fillStyle='#fffdf8';ctx.fillRect(0,0,w,h);
    for(let i=0;i<bands;i++){
      const y=i*rowH,mid=Math.min(h,y+rowH/2),p=paperAt(t,mid);
      const width=Math.abs(p.crease-p.front);
      if(width<1)continue;
      // The reverse of the existing sheet is translucent paper. The mirrored
      // text comes only from that same existing page, not the destination.
      ctx.save();
      ctx.globalAlpha=.15;
      const sample=Math.max(1,Math.min(width*1.45,w));
      const bandHeight=Math.max(1,Math.min(rowH+1,h-y));
      if(next){
        const sourceX=Math.max(0,Math.min(w-sample,p.front-sample*.12));
        ctx.translate(p.crease,0);ctx.scale(-1,1);
        ctx.drawImage(original,sourceX,y,sample,bandHeight,0,y,width,bandHeight);
      }else{
        const sourceX=Math.max(0,Math.min(w-sample,p.front-sample));
        ctx.translate(p.crease,0);ctx.scale(-1,1);
        // After mirroring, negative local x places the fold to the RIGHT,
        // above the original top page, not over the revealed page.
        ctx.drawImage(original,sourceX,y,sample,bandHeight,-width,y,width,bandHeight);
      }
      ctx.restore();
      const a=Math.min(p.crease,p.front),b=Math.max(p.crease,p.front);
      const gradient=ctx.createLinearGradient(a,0,b,0);
      if(next){
        gradient.addColorStop(0,'rgba(245,240,231,.47)');
        gradient.addColorStop(.27,'rgba(255,255,250,.65)');
        gradient.addColorStop(.68,'rgba(225,216,198,.31)');
        gradient.addColorStop(1,'rgba(80,72,58,.30)');
      }else{
        gradient.addColorStop(0,'rgba(80,72,58,.30)');
        gradient.addColorStop(.32,'rgba(225,216,198,.31)');
        gradient.addColorStop(.73,'rgba(255,255,250,.65)');
        gradient.addColorStop(1,'rgba(245,240,231,.47)');
      }
      ctx.fillStyle=gradient;ctx.fillRect(a,y,b-a,rowH+1);
    }
    ctx.restore();

    // A fine, curved paper edge without a broad artificial grey hinge.
    ctx.save();
    ctx.beginPath();
    for(let i=0;i<=bands;i++){
      const y=Math.min(h,i*rowH),x=paperAt(t,y).crease;
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.lineWidth=Math.max(.5,w/1500);
    ctx.strokeStyle='rgba(108,100,86,.3)';
    ctx.stroke();ctx.restore();
  }

  return drawFrame;
}
function runCurlAnimation(gesture,to,duration){
  return new Promise(resolve=>{
    if(!gesture?.active||!gesture.painter)return resolve(false);
    const from=gesture.progress||0;
    const start=performance.now();
    const ease=x=>x*x*(3-2*x);
    function tick(now){
      if(!gesture.active||!gesture.overlay?.isConnected)return resolve(false);
      const t=Math.min(1,(now-start)/Math.max(1,duration));
      const progress=from+(to-from)*ease(t);
      gesture.progress=progress;
      gesture.painter(progress);
      if(t<1)requestAnimationFrame(tick);
      else resolve(true);
    }
    requestAnimationFrame(tick);
  });
}
function finishPageFlip(overlay,dir){
  if(!overlay?.isConnected)return;
  const painter=createCurlPainter(overlay,dir);
  if(!painter){overlay.remove();return;}
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const gesture={active:true,overlay,painter,progress:0};
  runCurlAnimation(gesture,1,reduced?130:750).finally(()=>{gesture.active=false;overlay.remove();});
}
// A tiny, in-memory cache of neighboring pages allows the next page to be visible
// DURING the finger gesture. It never modifies the stored PDF, notes or reading position.
const pagePreviewCache=new Map();
function clearPagePreviewCache(){pagePreviewCache.clear();}
function stopCurlGesture(){
  const gesture=state.curlGesture;
  if(!gesture)return;
  gesture.active=false;
  gesture.overlay?.remove();
  gesture.preview?.remove();
  state.curlGesture=null;
}
async function renderPagePreview(bookId,page,width,height){
  if(!state.book||state.book.id!==bookId)throw new Error('Kitap değişti.');
  const result=document.createElement('canvas');
  result.width=width;result.height=height;
  const ctx=result.getContext('2d',{alpha:false});
  if(!ctx)throw new Error('Önizleme çizim alanı oluşturulamadı.');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);
  let left=0,top=0,drawWidth=width,drawHeight=height;
  if(state.book.type==='pdf'){
    const doc=state.pdfDoc;
    if(!doc)throw new Error('PDF okuma motoru hazır değil.');
    const pdfPage=await doc.getPage(page);
    const base=pdfPage.getViewport({scale:1});
    const scale=Math.min(width/base.width,height/base.height);
    const viewport=pdfPage.getViewport({scale});
    drawWidth=viewport.width;drawHeight=viewport.height;
    left=(width-drawWidth)/2;top=(height-drawHeight)/2;
    await pdfPage.render({canvasContext:ctx,viewport,
      transform:[1,0,0,1,left,top],background:'#ffffff'}).promise;
  }else{
    const record=await dbRead('pages',bookId+':'+page);
    if(!record?.blob)throw new Error('Önizleme için sayfa bulunamadı.');
    let bitmap=null,url=null;
    try{
      if(typeof createImageBitmap==='function'){
        try{bitmap=await createImageBitmap(record.blob);}catch(e){console.warn('Önizleme resim çözme alternatifi:',e);}
      }
      if(!bitmap){
        bitmap=new Image();
        url=URL.createObjectURL(record.blob);
        await new Promise((resolve,reject)=>{
          bitmap.onload=resolve;
          bitmap.onerror=()=>reject(new Error('Önizleme görseli açılamadı.'));
          bitmap.src=url;
        });
      }
      const scale=Math.min(width/bitmap.width,height/bitmap.height);
      drawWidth=bitmap.width*scale;drawHeight=bitmap.height*scale;
      left=(width-drawWidth)/2;top=(height-drawHeight)/2;
      ctx.drawImage(bitmap,left,top,drawWidth,drawHeight);
    }finally{bitmap?.close?.();if(url)URL.revokeObjectURL(url);}
  }
  const marks=await dbRead('marks',bookId+':'+page);
  if(marks){
    ctx.save();ctx.translate(left,top);
    for(const stroke of marks.strokes||[])drawStroke(ctx,stroke,{width:drawWidth,height:drawHeight});
    for(const note of marks.notes||[]){
      const x=(note.x||0)*drawWidth,y=(note.y||0)*drawHeight;
      ctx.fillStyle='#f8d66c';ctx.strokeStyle='#ffffff';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(x,y,Math.max(6,drawWidth*.014),0,Math.PI*2);ctx.fill();ctx.stroke();
    }
    ctx.restore();
  }
  return result;
}
function getPagePreview(bookId,page,width,height){
  const key=bookId+':'+page+':'+width+'x'+height;
  if(pagePreviewCache.has(key))return pagePreviewCache.get(key);
  const work=renderPagePreview(bookId,page,width,height).catch(error=>{
    pagePreviewCache.delete(key);
    throw error;
  });
  pagePreviewCache.set(key,work);
  while(pagePreviewCache.size>3)pagePreviewCache.delete(pagePreviewCache.keys().next().value);
  return work;
}
function scheduleAdjacentPreviews(serial){
  if(!settings.animation||settings.tool!=='hand'||!state.book)return;
  const bookId=state.book.id,page=state.page,total=state.book.pageCount;
  const source=$('pdfCanvas').classList.contains('hidden')?$('imagePage'):$('pdfCanvas');
  const w=source.naturalWidth||source.width,h=source.naturalHeight||source.height;
  if(!w||!h)return;
  const width=Math.min(w,860),height=Math.max(1,Math.round(width*h/w));
  // Use a short idle delay so the book itself always renders first.
  setTimeout(async()=>{
    if(!state.book||state.book.id!==bookId||state.page!==page||serial!==state.renderSerial)return;
    for(const target of [page+1,page-1]){
      if(target<1||target>total||!state.book||state.book.id!==bookId||serial!==state.renderSerial)break;
      try{await getPagePreview(bookId,target,width,height);}
      catch(e){console.warn('Komşu sayfa önizlemesi:',e);}
    }
  },180);
}
async function goToPage(number,animate=true,options={}){
  if(!state.book)return;
  if(state.curlGesture&&!options.fromCurl)stopCurlGesture();
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
    await dbPatchBook(bookId,{currentPage:number,updatedAt:state.book.updatedAt});
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
    if(serial!==state.renderSerial)return;spinner.classList.add('hidden');setupDrawingCanvas();renderAnnotations();renderNotePins();if(state.page===1&&!state.book.coverDataUrl)ensureVisibleCover(serial).catch(e=>console.warn('Kapak:',e));$('viewerArea').scrollTo({top:0,behavior:'auto'});scheduleAdjacentPreviews(serial);
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
function selectTool(tool){if(tool!=='hand')stopCurlGesture();settings.tool=tool;document.body.classList.toggle('pen-active',tool!=='hand');saveSettings();document.querySelectorAll('.pen-tool').forEach(b=>b.classList.toggle('selected',b.dataset.tool===tool));$('pageSheet').classList.toggle('drawing',tool!=='hand');$('annotationCanvas').style.pointerEvents=tool==='hand'?'none':'auto';$('annotationCanvas').style.touchAction=tool==='hand'?'auto':'none';updatePreview();}
function updatePreview(){document.querySelectorAll('.swatch').forEach(s=>s.classList.toggle('selected',s.dataset.color===settings.color));$('widthSlider').value=String(settings.width);$('widthOutput').textContent=settings.width+' / 12';const path=$('previewPath');path.setAttribute('stroke',settings.tool==='eraser'?'#777777':settings.color);path.setAttribute('stroke-width',String(settings.width*(settings.tool==='highlighter'?1.6:1)));path.setAttribute('opacity',String(settings.tool==='highlighter'?.40:settings.tool==='pencil'?.65:1));}
async function prepareCurlPreview(gesture){
  try{
    const cached=await getPagePreview(
      gesture.bookId,gesture.target,gesture.overlay.width,gesture.overlay.height
    );
    if(!gesture.active||state.curlGesture!==gesture||!gesture.overlay.isConnected)return false;
    const sheet=$('pageSheet');
    cached.classList.add('page-turn-preview');
    sheet.insertBefore(cached,gesture.overlay);
    gesture.preview=cached;
    gesture.ready=true;
    gesture.painter(gesture.progress);
    return true;
  }catch(error){
    console.warn('Canlı sayfa önizlemesi hazırlanamıyor:',error);
    gesture.error=error;
    return false;
  }
}
async function settleCurlGesture(gesture,shouldComplete){
  if(!gesture?.active||gesture.settling)return;
  gesture.settling=true;
  if(gesture.previewPromise)await gesture.previewPromise;
  if(!gesture.active||state.curlGesture!==gesture)return;
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if(!gesture.ready){
    // A corrupt or slow preview must never commit without the real reader being
    // able to open the target. Use the existing safe navigation as a fallback.
    stopCurlGesture();
    if(shouldComplete){
      try{await goToPage(gesture.target,false);}
      catch(error){toast('Sayfa açılamadı: '+error.message,5500);}
    }else if(gesture.error){
      toast('Sayfa önizlemesi hazırlanamadı; tekrar deneyin.',4500);
    }
    return;
  }
  const end=shouldComplete?1:0;
  const remaining=Math.abs(end-gesture.progress);
  const duration=reduced?100:Math.max(150,Math.round(380*remaining));
  const finished=await runCurlAnimation(gesture,end,duration);
  if(!finished||!gesture.active||state.curlGesture!==gesture)return;
  if(!shouldComplete){stopCurlGesture();return;}
  try{
    // The destination image stays under the completely turned page while
    // PDF.js renders the full-resolution page and the reader saves progress.
    await goToPage(gesture.target,false,{fromCurl:true});
    if(!gesture.active)return;
    if(state.page!==gesture.target)toast('Sayfa değiştirilemedi; tekrar deneyin.',4500);
  }catch(error){toast('Sayfa açılamadı: '+error.message,6500);}
  finally{if(state.curlGesture===gesture)stopCurlGesture();}
}
function setupSwipeGestures(){
  const area=$('viewerArea');
  let start=null;
  const finger=(touches,id)=>{
    for(const t of Array.from(touches||[]))if(t.identifier===id)return t;
    return null;
  };
  area.addEventListener('touchstart',e=>{
    if(e.touches.length!==1){
      start=null;stopCurlGesture();return;
    }
    if(settings.tool!=='hand'||!state.book||state.busy||state.curlGesture||
       e.target.closest('button,input,textarea,[contenteditable]')||
       document.querySelector('dialog[open]')){
      start=null;return;
    }
    const touch=e.touches[0];
    start={
      id:touch.identifier,x:touch.clientX,y:touch.clientY,at:performance.now(),
      page:state.page,bookId:state.book.id,turned:false
    };
  },{passive:true});

  area.addEventListener('touchmove',e=>{
    if(!start||!state.book||settings.tool!=='hand')return;
    const t=finger(e.touches,start.id);
    if(!t||e.touches.length!==1){start=null;stopCurlGesture();return;}
    if(state.book.id!==start.bookId||state.page!==start.page){
      start=null;stopCurlGesture();return;
    }
    const dx=t.clientX-start.x,dy=t.clientY-start.y;
    if(!start.turned){
      if(Math.abs(dy)>13&&Math.abs(dy)>Math.abs(dx)*1.25){
        start=null;return; // Vertical scrolling is not page turning.
      }
      if(Math.abs(dx)<12||Math.abs(dx)<Math.abs(dy)*1.2)return;
      if(!settings.animation){
        start.turned=true; // Existing immediate swipe behavior.
      }else{
        const direction=dx<0?'next':'prev';
        const target=state.page+(direction==='next'?1:-1);
        if(target<1||target>state.book.pageCount){start=null;return;}
        const overlay=makePageFlipSnapshot();
        if(!overlay){start=null;return;}
        const painter=createCurlPainter(overlay,direction);
        if(!painter){overlay.remove();start=null;return;}
        const gesture={
          active:true,ready:false,settling:false,overlay,painter,direction,target,
          bookId:start.bookId,page:start.page,progress:0,
          startX:start.x,startAt:start.at,lastX:t.clientX,
          preview:null,previewPromise:null,framePending:false,error:null
        };
        state.curlGesture=gesture;
        start.turned=true;
        gesture.previewPromise=prepareCurlPreview(gesture);
      }
    }
    if(!settings.animation)return;
    const gesture=state.curlGesture;
    if(!gesture?.active||gesture.settling)return;
    // Don't scroll the viewport once a horizontal page-turn is recognized.
    if(e.cancelable)e.preventDefault();
    const delta=gesture.direction==='next'?(gesture.startX-t.clientX):(t.clientX-gesture.startX);
    const width=Math.max(1,$('pageSheet').getBoundingClientRect().width);
    gesture.progress=Math.min(1,Math.max(0,delta/width));
    gesture.lastX=t.clientX;
    if(gesture.ready&&!gesture.framePending){
      gesture.framePending=true;
      requestAnimationFrame(()=>{
        gesture.framePending=false;
        if(gesture.active&&!gesture.settling&&gesture.ready)gesture.painter(gesture.progress);
      });
    }
  },{passive:false});

  area.addEventListener('touchend',e=>{
    if(!start)return;
    const pos=start;
    const t=finger(e.changedTouches,pos.id);
    if(!t)return;
    start=null;
    if(!state.book||state.page!==pos.page||state.book.id!==pos.bookId)return;
    const dx=t.clientX-pos.x,dy=t.clientY-pos.y;
    if(!settings.animation){
      const threshold=Math.max(48,Math.min(area.clientWidth*.15,85));
      if(Math.abs(dx)>=threshold&&Math.abs(dx)>Math.abs(dy)*1.3){
        goToPage(state.page+(dx<0?1:-1),false).catch(error=>toast(error.message,5000));
      }
      return;
    }
    const gesture=state.curlGesture;
    if(!gesture?.active){
      // Preserve very fast swipes on browsers that coalesce touchmove events.
      const threshold=Math.max(50,Math.min(area.clientWidth*.16,88));
      if(Math.abs(dx)>threshold&&Math.abs(dx)>Math.abs(dy)*1.4){
        goToPage(state.page+(dx<0?1:-1),true).catch(error=>toast(error.message,5000));
      }
      return;
    }
    if(gesture.page!==pos.page||gesture.bookId!==pos.bookId)return;
    // A half-turned page stays under the finger until release. On release it
    // completes past the midpoint, or springs gently back if dragged less.
    const elapsed=Math.max(1,performance.now()-pos.at);
    const distance=Math.abs(dx);
    const quickFlick=distance>Math.max(48,area.clientWidth*.14)&&distance/elapsed>.55;
    const shouldComplete=gesture.progress>=.45||quickFlick;
    settleCurlGesture(gesture,shouldComplete).catch(error=>{
      stopCurlGesture();toast('Sayfa geçişi tamamlanamadı: '+error.message,6000);
    });
  },{passive:true});

  area.addEventListener('touchcancel',()=>{
    start=null;
    const gesture=state.curlGesture;
    if(gesture?.active){
      settleCurlGesture(gesture,false).catch(()=>stopCurlGesture());
    }
  },{passive:true});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){start=null;stopCurlGesture();}
  });
}
function togglePenPanel(){
  const panel=$('penPanel'),open=panel.classList.contains('hidden');
  panel.classList.toggle('hidden',!open);
  $('readerPenBtn').setAttribute('aria-expanded',String(open));
  $('readerPenBtn').classList.toggle('active',open);
  $('readerToolbar').classList.add('hidden');
}
function setupControls(){
  setupSafeLibrary({dbAll,dbRead,dbPut,dbDelete,dbDeleteIndexed,toast,download,getPDF,showLibrary,uniqueId,state,getActiveBookId:()=>activeBookMenuId});
  $('librarySafetyBtn').addEventListener('click',()=>{
    $('archiveActionStatus').textContent='';
    if(!$('librarySafetyDialog').open)$('librarySafetyDialog').showModal();
  });
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
   $('readerPageBadge').addEventListener('click',()=>$('pageFooter').classList.toggle('page-footer-open'));$('searchInput').addEventListener('input',()=>showLibrary().catch(e=>toast(e.message)));$('themeBtn').addEventListener('click',()=>{settings.dark=!settings.dark;saveSettings();applyTheme();});$('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());$('penToolbarBtn').addEventListener('click',togglePenPanel);$('pageAnimationBtn').addEventListener('click',()=>{stopCurlGesture();settings.animation=!settings.animation;if(!settings.animation)clearPagePreviewCache();saveSettings();$('pageAnimationBtn').classList.toggle('active',settings.animation);toast(settings.animation?'Sayfa animasyonu açıldı.':'Sayfa animasyonu kapatıldı.');});$('bookmarkBtn').addEventListener('click',async()=>{if(!state.book)return;const saved=state.book.bookmarks||[];state.book.bookmarks=saved.includes(state.page)?saved.filter(p=>p!==state.page):[...saved,state.page].sort((a,b)=>a-b);await dbPatchBook(state.book.id,{bookmarks:state.book.bookmarks});updatePager();toast(saved.includes(state.page)?'Yer imi kaldırıldı.':'Yer imi kaydedildi.');});$('notesListBtn').addEventListener('click',()=>{const notes=state.marks.notes;const msg=notes.length?notes.map((n,i)=>`${i+1}. ${n.text}`).join('\n\n'):'Bu sayfada metin notu bulunmuyor. “Not” aracını seçip sayfaya dokunabilirsiniz.';alert(msg);});$('saveNoteBtn').addEventListener('click',()=>saveNote().catch(e=>toast(e.message)));$('deleteNoteBtn').addEventListener('click',()=>deleteNote().catch(e=>toast(e.message)));for(const id of ['prevPageBtn','previousPageFloat'])$(id).addEventListener('click',()=>goToPage(state.page-1).catch(e=>toast(e.message)));for(const id of ['nextPageBtn','nextPageFloat'])$(id).addEventListener('click',()=>goToPage(state.page+1).catch(e=>toast(e.message)));$('pageSlider').addEventListener('change',e=>goToPage(Number(e.target.value)).catch(err=>toast(err.message)));window.addEventListener('keydown',e=>{if(!state.book||document.querySelector('dialog[open]'))return;if(e.target.matches('input,textarea'))return;if(e.ctrlKey&&e.key.toLowerCase()==='z'){e.preventDefault();(e.shiftKey?redo():undo()).catch(err=>toast(err.message));}else if(e.key==='ArrowRight')goToPage(state.page+1).catch(err=>toast(err.message));else if(e.key==='ArrowLeft')goToPage(state.page-1).catch(err=>toast(err.message));});window.addEventListener('resize',()=>{if(!state.book)return;stopCurlGesture();clearPagePreviewCache();clearTimeout(state.resizeTimer);state.resizeTimer=setTimeout(()=>paintPage(++state.renderSerial),240);});}
function applyTheme(){document.body.classList.toggle('dark',settings.dark);$('themeBtn').textContent=settings.dark?'☀':'☾';}
const APP_VERSION='0.1.15';
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