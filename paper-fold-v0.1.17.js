/* Sayfa v0.1.17 — single-sheet, corner-to-corner paper folding.
 * A physical paper fold is a reflection across the perpendicular bisector of
 * the segment from the original page corner to the point being dragged.
 * This replaces the older artificial stripe/ribbon rendering entirely.
 * Pure geometry is separately exported for regression checks.
 */
const EPS=1e-8;
const clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
const dot=(a,b)=>a.x*b.x+a.y*b.y;
const rect=(w,h)=>[{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}];

function clipToHalfPlane(points,mid,unit,sign){
  const distance=p=>sign*((p.x-mid.x)*unit.x+(p.y-mid.y)*unit.y);
  const out=[];
  if(!points?.length)return out;
  let prev=points[points.length-1],previousDistance=distance(prev);
  for(const current of points){
    const currentDistance=distance(current);
    const prevInside=previousDistance>=-EPS;
    const currentInside=currentDistance>=-EPS;
    if(currentInside!==prevInside){
      const t=previousDistance/(previousDistance-currentDistance);
      out.push({x:prev.x+(current.x-prev.x)*t,y:prev.y+(current.y-prev.y)*t});
    }
    if(currentInside)out.push({x:current.x,y:current.y});
    prev=current;previousDistance=currentDistance;
  }
  return out;
}
function foldPoint(p,mid,n){
  const d=(p.x-mid.x)*n.x+(p.y-mid.y)*n.y;
  return {x:p.x-2*d*n.x,y:p.y-2*d*n.y};
}

export function paperFoldGeometry(w,h,progress,contactY=.58,direction='next'){
  if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)
    throw new Error('Geçersiz sayfa boyutları.');
  const t=clamp(Number(progress)||0,0,1);
  const next=direction==='next';
  const y=clamp(Number.isFinite(contactY)?contactY:.58,0,1);
  if(t<=.00001)return {progress:0,flat:rect(w,h),flap:[],mid:null,unit:null,reflection:null};
  if(t>=.99999)return {progress:1,flat:[],flap:[],mid:null,unit:null,reflection:null};

  // Choose the nearest corner, just as a person naturally grabs the sheet.
  const upper=y<.45;
  const corner={x:next?w:0,y:upper?0:h};

  // The corner travels twice the horizontal drag distance: its fold line is
  // halfway between its original and displaced positions. At 50% drag, the
  // crease passes through the central part of the page.
  const lift=h*.48*Math.sin(Math.PI*t)*(.78+.22*Math.abs(2*y-1));
  const dragged={
    x:corner.x+(next?-1:1)*2*w*t,
    y:corner.y+(upper?1:-1)*lift
  };
  const displacement={x:corner.x-dragged.x,y:corner.y-dragged.y};
  const length=Math.hypot(displacement.x,displacement.y);
  if(length<EPS)return {progress:t,flat:rect(w,h),flap:[],mid:null,unit:null,reflection:null};
  const n={x:displacement.x/length,y:displacement.y/length};
  const mid={x:(corner.x+dragged.x)/2,y:(corner.y+dragged.y)/2};
  const points=rect(w,h);
  // The stationary portion is on the spine side of the crease.
  const flat=clipToHalfPlane(points,mid,n,-1);
  // Only the *physical part of the original page* beyond the crease folds.
  const sourceFold=clipToHalfPlane(points,mid,n,1);
  const flap=sourceFold.map(p=>foldPoint(p,mid,n));
  // Reflection is an isometry. No artificial strip, width adjustment or
  // stretching of the page's printed content can create a 'rolled' look.
  const a=1-2*n.x*n.x,b=-2*n.x*n.y,c=b,d=1-2*n.y*n.y;
  const measure=2*(mid.x*n.x+mid.y*n.y);
  const reflection={a,b,c,d,e:measure*n.x,f:measure*n.y};
  return {progress:t,flat,flap,mid,unit:n,reflection,corner,dragged};
}

function pathPolygon(ctx,poly){
  ctx.beginPath();
  if(!poly?.length)return;
  ctx.moveTo(poly[0].x,poly[0].y);
  for(let i=1;i<poly.length;i++)ctx.lineTo(poly[i].x,poly[i].y);
  ctx.closePath();
}

export function createPaperFoldRenderer(overlay,direction='next'){
  if(!overlay?.isConnected)return null;
  const w=overlay.width,h=overlay.height;
  const ctx=overlay.getContext('2d',{alpha:true});
  if(!ctx||!w||!h)return null;
  const oldPage=document.createElement('canvas');
  oldPage.width=w;oldPage.height=h;
  oldPage.getContext('2d',{alpha:true}).drawImage(overlay,0,0);
  return (progress,contactY=.58)=>{
    const geo=paperFoldGeometry(w,h,progress,contactY,direction);
    ctx.clearRect(0,0,w,h);
    if(geo.progress===0){ctx.drawImage(oldPage,0,0,w,h);return;}
    if(geo.progress===1)return;

    // Stationary part of the OLD upper page. Transparency elsewhere reveals
    // the already rendered NEXT page underneath.
    if(geo.flat.length>=3){
      ctx.save();pathPolygon(ctx,geo.flat);ctx.clip();
      ctx.drawImage(oldPage,0,0,w,h);
      ctx.restore();
    }
    if(geo.flap.length<3)return;
    const {mid,unit:n,reflection:R}=geo;

    // A restrained shadow falls onto the newly revealed page beside the fold.
    // Its width is fixed in pixels; it is not a fake cylindrical paper strip.
    const shadowPx=Math.max(5,Math.min(18,w*.025));
    ctx.save();
    const exposed=clipToHalfPlane(rect(w,h),mid,n,1);
    if(exposed.length>=3){
      pathPolygon(ctx,exposed);ctx.clip();
      const gradient=ctx.createLinearGradient(mid.x,mid.y,mid.x+n.x*shadowPx,mid.y+n.y*shadowPx);
      gradient.addColorStop(0,'rgba(35,30,23,.16)');
      gradient.addColorStop(.42,'rgba(35,30,23,.055)');
      gradient.addColorStop(1,'rgba(35,30,23,0)');
      ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
    }
    ctx.restore();

    // The genuinely folded part is one reflected polygon, not a band.
    ctx.save();
    pathPolygon(ctx,geo.flap);ctx.clip();
    ctx.fillStyle='#faf8f2';ctx.fillRect(0,0,w,h);
    // Text is a faint, mirror-reflected copy from the SAME old page.
    ctx.save();
    ctx.globalAlpha=.085;
    ctx.transform(R.a,R.b,R.c,R.d,R.e,R.f);
    ctx.drawImage(oldPage,0,0,w,h);
    ctx.restore();

    // Subtle paper sheen runs perpendicular to the diagonal crease.
    // The triangular flap remains flat, without metallic or rolled shading.
    const flapDepth=Math.max(5,...geo.flap.map(p=>-((p.x-mid.x)*n.x+(p.y-mid.y)*n.y)));
    const g=ctx.createLinearGradient(mid.x,mid.y,mid.x-n.x*flapDepth,mid.y-n.y*flapDepth);
    g.addColorStop(0,'rgba(96,82,60,.16)');
    g.addColorStop(.18,'rgba(240,234,220,.12)');
    g.addColorStop(.65,'rgba(255,255,251,.02)');
    g.addColorStop(1,'rgba(176,160,135,.09)');
    ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
    ctx.restore();

    // A single crisp fold line. No broad grey roll across the page.
    ctx.save();ctx.beginPath();
    const dx=-n.y,dy=n.x;
    ctx.moveTo(mid.x-dx*Math.hypot(w,h),mid.y-dy*Math.hypot(w,h));
    ctx.lineTo(mid.x+dx*Math.hypot(w,h),mid.y+dy*Math.hypot(w,h));
    ctx.strokeStyle='rgba(80,70,58,.22)';
    ctx.lineWidth=Math.max(.55,w/1000);
    ctx.stroke();ctx.restore();
  };
}
