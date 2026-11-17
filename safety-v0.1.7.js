/* Sayfa v0.1.7 — verified local library backups. No server, no subscriptions. */
import {sourceBytes,sha256Hex,createZip,readZip} from './backup-v0.1.7.js';
const encoder=new TextEncoder();
const decoder=new TextDecoder();
function filename(s){return String(s||'Kitap').replace(/[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ._ -]/g,'_').slice(0,110);}
export async function bookDigest(source){return sha256Hex(source);}
export function setupSafeLibrary(api){
  const {dbAll,dbRead,dbPut,dbDelete,dbDeleteIndexed,toast,download,getPDF,showLibrary,uniqueId,state,getActiveBookId}=api;
  const $=id=>document.getElementById(id);
  const status=(s,ms=11000)=>{
    const panel=$('librarySafetyDialog'),message=$('archiveActionStatus');
    if(panel?.open&&message)message.textContent=s;
    toast(s,ms);
  };
  const busy=v=>{
    for(const id of ['backupLibraryBtn','restoreLibraryBtn','verifyLibraryBtn','importBtn','emptyImportBtn'])if($(id))$(id).disabled=v;
  };
  const validatePDF=async(bytes,title)=>{
    const pdf=await getPDF(bytes);
    try{
      if(!pdf.numPages)throw new Error('PDF sayfaları bulunamadı.');
      await pdf.getPage(1);
      if(pdf.numPages>1)await pdf.getPage(pdf.numPages);
      return pdf.numPages;
    }catch(e){throw new Error(title+': PDF sayfaları açılamıyor. '+e.message);}
    finally{await pdf.destroy().catch(()=>{});}
  };
  const parseBackup=async(file)=>{
    status('Yedek arşivi kontrol ediliyor…',18000);
    const entries=await readZip(file);
    const raw=entries.get('manifest.json');
    if(!raw)throw new Error('Bu ZIP bir Sayfa kitaplık yedeği değil.');
    let manifest;
    try{manifest=JSON.parse(decoder.decode(raw));}catch(e){throw new Error('Yedek bilgisi okunamadı.');}
    if(manifest?.format!=='sayfa-library' || manifest.version!==1 || !Array.isArray(manifest.books) || !manifest.books.length)throw new Error('Sayfa yedeğinin biçimi geçersiz.');
    const seen=new Set();
    for(const b of manifest.books){
      if(!b.id||seen.has(b.id)||!b.title||!Number.isInteger(b.pageCount)||b.pageCount<1)throw new Error('Yedek kitap bilgileri hatalı.');
      seen.add(b.id);
      if(!Array.isArray(b.marks))throw new Error('Yedek not bilgileri hatalı.');
      if(b.type==='pdf'){
        const data=entries.get(b.path);
        if(!data||await sha256Hex(data)!==b.sha256)throw new Error(b.title+' kitabının PDF yedeği hasarlı.');
        if(await validatePDF(data,b.title)!==b.pageCount)throw new Error(b.title+' sayfa sayısı değişmiş.');
      }else if(b.type==='images'){
        if(!Array.isArray(b.pages)||b.pages.length!==b.pageCount)throw new Error(b.title+' sayfaları eksik.');
        for(const p of b.pages){
          const data=entries.get(p.path);
          if(!data||await sha256Hex(data)!==p.sha256)throw new Error(b.title+' sayfa yedeği hasarlı.');
        }
        if(b.originalPath){
          const original=entries.get(b.originalPath);
          if(!original||await sha256Hex(original)!==b.originalSha256)throw new Error(b.title+' orijinal PDF yedeği hasarlı.');
          if(await validatePDF(original,b.title)!==b.pageCount)throw new Error(b.title+' orijinal PDF sayfaları doğrulanamadı.');
        }
      }else throw new Error('Yedekte desteklenmeyen kitap biçimi.');
    }
    return {manifest,entries};
  };
  async function exportLibrary(){
    if(state.busy)return;
    state.busy=true;busy(true);
    try{
      const books=await dbAll('books');
      if(!books.length)throw new Error('Kitaplıkta kitap yok.');
      const estimate=books.reduce((n,b)=>n+(b.storedSize||0),0);
      if(estimate>180*1024*1024)throw new Error('Bütün kitaplık iPhone için çok büyük. Her kitabı ayrı PDF olarak dışa aktarın.');
      const marks=await dbAll('marks'),pages=await dbAll('pages'),entries=[],list=[];
      for(const [index,book] of books.entries()){
        status('Yedek hazırlanıyor: '+(index+1)+'/'+books.length,16000);
        const meta={
          id:book.id,title:book.title,fileName:book.fileName,createdAt:book.createdAt,
          updatedAt:book.updatedAt,currentPage:book.currentPage||1,bookmarks:book.bookmarks||[],
          pageCount:book.pageCount,rawSize:book.rawSize||0,storedSize:book.storedSize||0,type:book.type,
          marks:marks.filter(m=>m.bookId===book.id).map(m=>({page:m.page,strokes:m.strokes||[],notes:m.notes||[]}))
        };
        if(book.type==='pdf'){
          const data=await sourceBytes(book.blob);
          const hash=await sha256Hex(data);
          if(book.sha256&&hash!==book.sha256)throw new Error(book.title+' dosyasının kayıtlı verisi değişmiş.');
          if(await validatePDF(data,book.title)!==book.pageCount)throw new Error(book.title+' sayfa sayısı uyuşmuyor.');
          meta.path='books/'+book.id+'.pdf';meta.sha256=hash;
          entries.push({name:meta.path,data});
        }else if(book.type==='images'){
          const p=pages.filter(x=>x.bookId===book.id);
          if(p.length!==book.pageCount)throw new Error(book.title+' görsel sayfaları eksik.');
          meta.pages=[];
          if(book.originalBlob){
            const original=await sourceBytes(book.originalBlob);
            const hash=await sha256Hex(original);
            if(book.sha256&&book.sha256!==hash)throw new Error(book.title+' orijinal PDF bütünlüğü bozuk.');
            if(await validatePDF(original,book.title)!==book.pageCount)throw new Error(book.title+' orijinal PDF geçersiz.');
            meta.originalPath='books/'+book.id+'-original.pdf';
            meta.originalSha256=hash;
            entries.push({name:meta.originalPath,data:original});
          }else{
            throw new Error(book.title+' için orijinal PDF saklanmamış. Önce orijinal dosyayı tekrar ekleyin.');
          }
          for(const page of p.sort((a,b)=>a.page-b.page)){
            const data=await sourceBytes(page.blob);
            const path='pages/'+book.id+'/'+page.page+'.bin';
            meta.pages.push({page:page.page,path,sha256:await sha256Hex(data),mime:page.blob?.type||'image/jpeg',width:page.width,height:page.height});
            entries.push({name:path,data});
          }
        }else throw new Error('Kitap biçimi yedeklenemiyor.');
        list.push(meta);
      }
      const manifest={format:'sayfa-library',version:1,createdAt:new Date().toISOString(),books:list};
      entries.push({name:'manifest.json',data:encoder.encode(JSON.stringify(manifest))});
      const zip=await createZip(entries);
      // The archive is read back and each PDF's cryptographic hash is rechecked.
      const checked=await readZip(zip);
      for(const b of list){
        if(b.type==='pdf'&&await sha256Hex(checked.get(b.path))!==b.sha256)throw new Error('Arşiv PDF doğrulaması başarısız.');
        for(const p of b.pages||[])if(await sha256Hex(checked.get(p.path))!==p.sha256)throw new Error('Arşiv sayfa doğrulaması başarısız.');
        if(b.originalPath&&await sha256Hex(checked.get(b.originalPath))!==b.originalSha256)throw new Error('Orijinal PDF arşiv doğrulaması başarısız.');
      }
      const link=$('backupDownloadLink');
      if(link){
        if(link.dataset.oldUrl)URL.revokeObjectURL(link.dataset.oldUrl);
        const href=URL.createObjectURL(zip);
        link.dataset.oldUrl=href;
        link.href=href;
        link.download='Sayfa-Yedek-'+new Date().toISOString().slice(0,10)+'.zip';
        link.classList.remove('hidden');
        status(list.length+' kitaplık ZIP doğrulandı. Şimdi “Yedeği Dosyalar’a indir” düğmesine dokunun ve dosyayı farklı bir yerde de saklayın.',18000);
      }else{
        download(zip,'Sayfa-Yedek-'+new Date().toISOString().slice(0,10)+'.zip');
        status('ZIP hazır. İndirilenler klasöründe bulunduğunu kontrol edin.',12000);
      }
    }catch(e){console.error('Sayfa backup:',e);status('Yedek alınamadı: '+e.message,16000);}
    finally{state.busy=false;busy(false);}
  }
  async function checkBackup(file){
    if(!file)return;
    if(state.busy)return;state.busy=true;busy(true);
    try{
      const {manifest}=await parseBackup(file);
      status(manifest.books.length+' kitaplık yedek doğrulandı. ZIP dosyasını iCloud Drive veya bilgisayarda da saklayın.',16000);
    }catch(e){console.error(e);status('Yedek doğrulanamadı: '+e.message,16000);}
    finally{state.busy=false;busy(false);}
  }
  async function restoreLibrary(file){
    if(!file||state.busy)return;
    state.busy=true;busy(true);
    try{
      const {manifest,entries}=await parseBackup(file);
      if(!confirm(manifest.books.length+' kitaplık yedek doğrulandı. Kitaplar mevcut verilerin üzerine yazılmadan eklensin mi?'))return;
      let restored=0;
      for(const b of manifest.books){
        const old=await dbRead('books',b.id);
        const id=old?uniqueId():b.id;
        const fresh={
          id,title:old?b.title+' (yedekten)':b.title,fileName:b.fileName||b.title+'.pdf',
          createdAt:b.createdAt||Date.now(),updatedAt:Date.now(),
          type:b.type,pageCount:b.pageCount,currentPage:Math.min(b.pageCount,Math.max(1,b.currentPage||1)),
          bookmarks:Array.isArray(b.bookmarks)?b.bookmarks:[],cover:null,rawSize:b.rawSize||0,storedSize:b.storedSize||0
        };
        try{
          if(b.type==='pdf'){
            const data=entries.get(b.path);
            fresh.blob=data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
            fresh.sha256=b.sha256;fresh.verifiedAt=Date.now();fresh.storedSize=data.length;
          }else{
            fresh.blob=null;
            if(b.originalPath){
              const original=entries.get(b.originalPath);
              fresh.originalBlob=original.buffer.slice(original.byteOffset,original.byteOffset+original.byteLength);
              fresh.sha256=b.originalSha256;fresh.verifiedAt=Date.now();
            }
            for(const p of b.pages){
              const data=entries.get(p.path);
              await dbPut('pages',{key:id+':'+p.page,bookId:id,page:p.page,blob:new Blob([data],{type:p.mime||'image/jpeg'}),width:p.width,height:p.height});
            }
          }
          for(const m of b.marks){
            if(!Number.isInteger(m.page)||m.page<1||m.page>b.pageCount)throw new Error('Yedekte geçersiz not sayfası.');
            await dbPut('marks',{key:id+':'+m.page,bookId:id,page:m.page,strokes:m.strokes||[],notes:m.notes||[]});
          }
          await dbPut('books',fresh);
          if(b.type==='pdf'){
            const check=await dbRead('books',id);
            if(!check||await sha256Hex(check.blob)!==b.sha256)throw new Error('Geri yüklenen PDF doğru kaydedilemedi.');
          }
          restored++;status(restored+' / '+manifest.books.length+' kitap geri yüklendi…',10000);
        }catch(e){
          await dbDeleteIndexed('marks','bookId',id).catch(()=>{});
          await dbDeleteIndexed('pages','bookId',id).catch(()=>{});
          await dbDelete('books',id).catch(()=>{});
          throw e;
        }
      }
      await showLibrary();
      status(restored+' kitap yedekten geri yüklendi. ZIP yedeğinizi saklayın.',15000);
    }catch(e){console.error('Sayfa restore:',e);status('Geri yükleme tamamlanamadı: '+e.message,16000);}
    finally{state.busy=false;busy(false);}
  }
  async function exportBook(){
    const id=getActiveBookId();if(!id)return;
    const book=await dbRead('books',id);
    $('bookActionsDialog')?.close();
    if(!book)return;
    if(book.type!=='pdf'&&!book.originalBlob){status('Bu eski görsel kitap kaydında orijinal PDF bulunmuyor. Eski PDF kopyasını saklayın.',9500);return;}
    try{
      const data=await sourceBytes(book.type==='pdf'?book.blob:book.originalBlob);
      const hash=await sha256Hex(data);
      if(book.sha256&&book.sha256!==hash)throw new Error('PDF bütünlüğü doğrulanamadı.');
      if(await validatePDF(data,book.title)!==book.pageCount)throw new Error('Sayfa sayısı farklı.');
      download(new Blob([data],{type:'application/pdf'}),filename(book.title)+'.pdf');
      status('Orijinal PDF dışa aktarıldı. Dosyalar/İndirilenler içinde göründüğünü kontrol edin.',11000);
    }catch(e){status('PDF dışa aktarılamadı: '+e.message,13000);}
  }
  $('backupLibraryBtn')?.addEventListener('click',exportLibrary);
  $('restoreLibraryBtn')?.addEventListener('click',()=>$('restoreBackupInput').click());
  $('verifyLibraryBtn')?.addEventListener('click',()=>$('verifyBackupInput').click());
  $('exportBookOption')?.addEventListener('click',exportBook);
  $('restoreBackupInput')?.addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';restoreLibrary(file);});
  $('verifyBackupInput')?.addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';checkBackup(file);});
}
