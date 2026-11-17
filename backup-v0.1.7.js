/* Sayfa v0.1.7: dependency-free, uncompressed ZIP backup with CRC32 and SHA-256. MIT. */
const encoder=new TextEncoder(),decoder=new TextDecoder();
const MAX_ZIP_BYTES=512*1024*1024;
const crcTable=new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);crcTable[n]=c>>>0;}
function crc32(bytes){let c=0xFFFFFFFF;for(const v of bytes)c=crcTable[(c^v)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
export async function sourceBytes(source){
  if(source instanceof Blob)return new Uint8Array(await source.arrayBuffer());
  if(source instanceof ArrayBuffer)return new Uint8Array(source.slice(0));
  if(ArrayBuffer.isView(source))return new Uint8Array(source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength));
  if(typeof source==='string')return encoder.encode(source);
  throw new Error('Desteklenmeyen arşiv verisi.');
}
export async function sha256Hex(source){
  if(!crypto?.subtle)throw new Error('Bu cihaz SHA-256 doğrulamasını desteklemiyor.');
  const bytes=await sourceBytes(source);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(hash,x=>x.toString(16).padStart(2,'0')).join('');
}
function write16(v,o,x){v.setUint16(o,x,true);}
function write32(v,o,x){v.setUint32(o,x,true);}
function safeName(name){
  if(!name||name.length>400||name.startsWith('/')||name.includes('..')||name.includes('\\')||name.includes('\0'))throw new Error('Geçersiz arşiv dosya adı.');
  return name;
}
export async function createZip(entries){
  if(!entries.length||entries.length>65000)throw new Error('Arşivde desteklenmeyen sayıda dosya var.');
  let local=[],central=[],offset=0,centralSize=0;
  const seen=new Set();
  for(const entry of entries){
    const name=safeName(entry.name);
    if(seen.has(name))throw new Error('Arşivde tekrar eden dosya adı: '+name);
    seen.add(name);
    const filename=encoder.encode(name);
    const data=await sourceBytes(entry.data);
    if(data.length>MAX_ZIP_BYTES||offset+data.length>MAX_ZIP_BYTES)throw new Error('Yedek bu cihaz için çok büyük; kitapları tek tek dışa aktarın.');
    const checksum=crc32(data);
    const h=new Uint8Array(30+filename.length),dv=new DataView(h.buffer);
    write32(dv,0,0x04034b50);write16(dv,4,20);write16(dv,6,0x0800);write16(dv,8,0);
    write32(dv,14,checksum);write32(dv,18,data.length);write32(dv,22,data.length);
    write16(dv,26,filename.length);h.set(filename,30);
    local.push(h,data);
    const c=new Uint8Array(46+filename.length),cv=new DataView(c.buffer);
    write32(cv,0,0x02014b50);write16(cv,4,20);write16(cv,6,20);write16(cv,8,0x0800);
    write16(cv,10,0);write32(cv,16,checksum);write32(cv,20,data.length);write32(cv,24,data.length);
    write16(cv,28,filename.length);write32(cv,42,offset);c.set(filename,46);
    central.push(c);centralSize+=c.length;
    offset+=h.length+data.length;
    if(offset>MAX_ZIP_BYTES)throw new Error('Yedek bu cihaz için çok büyük.');
  }
  const end=new Uint8Array(22),e=new DataView(end.buffer);
  write32(e,0,0x06054b50);write16(e,8,entries.length);write16(e,10,entries.length);
  write32(e,12,centralSize);write32(e,16,offset);
  return new Blob([...local,...central,end],{type:'application/zip'});
}
export async function readZip(file){
  const bytes=await sourceBytes(file);
  if(bytes.length>MAX_ZIP_BYTES||bytes.length<22)throw new Error('Yedek dosyasının boyutu geçersiz.');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let eocd=-1;for(let x=bytes.length-22;x>=Math.max(0,bytes.length-65557);x--){
    if(v.getUint32(x,true)===0x06054b50&&x+22+v.getUint16(x+20,true)===bytes.length){eocd=x;break;}
  }
  if(eocd<0)throw new Error('ZIP yedeğinin son kayıt bilgisi yok; dosya eksik olabilir.');
  const count=v.getUint16(eocd+10,true),offset=v.getUint32(eocd+16,true);
  const centralSize=v.getUint32(eocd+12,true);
  if(offset+centralSize!==eocd||count<1||count>5000)throw new Error('ZIP dosya dizini hasarlı.');
  const out=new Map();
  let p=offset;
  for(let i=0;i<count;i++){
    if(p+46>eocd||v.getUint32(p,true)!==0x02014b50)throw new Error('ZIP merkez dizini bozuk.');
    const method=v.getUint16(p+10,true),crc=v.getUint32(p+16,true),size=v.getUint32(p+20,true);
    const packed=v.getUint32(p+24,true),nameLen=v.getUint16(p+28,true);
    const extra=v.getUint16(p+30,true),comment=v.getUint16(p+32,true);
    const localOff=v.getUint32(p+42,true);
    if(method!==0||packed!==size)throw new Error('Bu ZIP sıkıştırma türü desteklenmiyor.');
    if(size>MAX_ZIP_BYTES||p+46+nameLen+extra+comment>eocd)throw new Error('ZIP kayıt sınırı geçersiz.');
    const name=safeName(decoder.decode(bytes.subarray(p+46,p+46+nameLen)));
    if(out.has(name))throw new Error('ZIP içinde yinelenen dosya.');
    if(localOff+30>offset||v.getUint32(localOff,true)!==0x04034b50)throw new Error('ZIP dosya başlangıcı bozuk.');
    const localNameLen=v.getUint16(localOff+26,true),localExtra=v.getUint16(localOff+28,true);
    const dataStart=localOff+30+localNameLen+localExtra;
    if(dataStart+size>offset)throw new Error('ZIP dosya içeriği eksik.');
    const data=bytes.slice(dataStart,dataStart+size);
    if(crc32(data)!==crc)throw new Error('Yedek dosyasında hata bulundu: '+name);
    out.set(name,data);
    p+=46+nameLen+extra+comment;
  }
  if(p!==eocd)throw new Error('ZIP merkez dizini uzunluğu uyuşmuyor.');
  return out;
}