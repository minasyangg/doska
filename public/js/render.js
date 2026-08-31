/* отрисовка холста, камера, курсоры участников */

import { PAPER, S, bctx, board, dpr, items, lctx, live, outlinePath, stage, toScreen, toWorld } from './core.js';
import { ARC_TYPES, BACK_TYPES, BOX_TYPES, arcPt, arcSweep, bboxOf } from './geometry.js';
import { paintItem, paintPath, paintShape } from './shapes.js';
import { paintArc, paintGraphCoordHint } from './graph.js';
import { angleAt, arcDraft, canEdit, current, dragging, eraserR, handlesFor, marquee, panning, pathDraft, selected, selection, selectionBox, shapeDraft, spaceDown } from './selection.js';
import { net } from './net.js';

/* ═══════════════════ отрисовка ═══════════════════ */
function resize(){
  dpr=Math.min(devicePixelRatio||1,2.5);
  for(const c of [board,live]){c.width=Math.round(c.clientWidth*dpr);c.height=Math.round(c.clientHeight*dpr);}
  drawBoard();drawLive();
}
const applyCam=ctx=>ctx.setTransform(dpr*S.cam.z,0,0,dpr*S.cam.z,dpr*S.cam.x,dpr*S.cam.y);
const visRect=()=>{const a=toWorld(0,0),b=toWorld(board.clientWidth,board.clientHeight);
  return{x0:a.x,y0:a.y,x1:b.x,y1:b.y};};

/* адаптивная сетка: шаг всегда остаётся в удобном диапазоне на экране */
function drawGrid(){
  if(S.grid==='none')return;
  const z=S.cam.z; let step=40;
  while(step*z<24)step*=5;
  while(step*z>130)step/=5;
  const v=visRect(), px=1/z;
  const t=Math.min(1,Math.max(0,(step*z-24)/34));       // мелкая сетка проявляется плавно
  const minor='rgba(120,132,148,'+(0.10+0.16*t).toFixed(3)+')';
  const major='rgba(96,110,128,0.30)';

  if(S.grid==='dots'){
    bctx.fillStyle='rgba(110,122,138,'+(0.30+0.35*t).toFixed(3)+')';
    const r=Math.min(1.6,Math.max(0.55,1.15*px));
    let n=0;
    for(let x=Math.floor(v.x0/step)*step;x<=v.x1;x+=step)
      for(let y=Math.floor(v.y0/step)*step;y<=v.y1;y+=step){
        bctx.beginPath();bctx.arc(x,y,r,0,6.2832);bctx.fill();
        if(++n>14000)return;
      }
    return;
  }

  const lineSet=(gap,color,width)=>{
    bctx.beginPath();
    for(let y=Math.floor(v.y0/gap)*gap;y<=v.y1;y+=gap){bctx.moveTo(v.x0,y);bctx.lineTo(v.x1,y);}
    if(S.grid!=='lines')
      for(let x=Math.floor(v.x0/gap)*gap;x<=v.x1;x+=gap){bctx.moveTo(x,v.y0);bctx.lineTo(x,v.y1);}
    bctx.strokeStyle=color; bctx.lineWidth=width*px; bctx.stroke();
  };
  lineSet(step,minor,1);
  lineSet(step*5,major,1);
}

let boardDirty=false,liveDirty=false;
const drawBoard=()=>{boardDirty=true;};
const drawLive =()=>{liveDirty=true;};

function flushBoard(){
  if(!boardDirty)return; boardDirty=false;
  bctx.setTransform(1,0,0,1,0,0);
  bctx.fillStyle=PAPER; bctx.fillRect(0,0,board.width,board.height);
  applyCam(bctx); drawGrid();
  const v=visRect();
  const hit=it=>{const b=it.bbox||(it.bbox=bboxOf(it));
    return!(b.x1<v.x0||b.x0>v.x1||b.y1<v.y0||b.y0>v.y1);};
  // Картинки идут под записями — чтобы вставленный скрин не закрыл написанное.
  // Исключение — та, которую человек сам поднял «на передний план»: прямая
  // просьба сильнее умолчания.
  const back=it=>BACK_TYPES.has(it.type)&&!it.front;
  // hidden — надпись, которую сейчас правят: её показывает поле ввода
  for(const it of items) if(!it.hidden&&back(it)&&hit(it)) paintItem(bctx,it);
  for(const it of items) if(!it.hidden&&!back(it)&&hit(it)) paintItem(bctx,it);
}

const remoteLive=new Map(), cursors=new Map(), peers=new Map();
// область экрана каждого участника (id -> {cam,w,h,seen}) — для стрелок
// «участник смотрит в другой стороне», когда его поле зрения не совпадает
// с нашим (см. flushLive)
const peerViews=new Map();
let hoverPt=null;                                   // для кольца ластика

function flushLive(){
  if(!liveDirty)return; liveDirty=false;
  lctx.setTransform(1,0,0,1,0,0);
  lctx.clearRect(0,0,live.width,live.height);
  applyCam(lctx);
  const drawTmp=s=>{
    if(!s.pts.length)return;
    lctx.save(); if(s.type==='marker'||s.kind==='marker')lctx.globalAlpha=0.42;
    lctx.fillStyle=s.color; outlinePath(lctx,s); lctx.fill(); lctx.restore();
  };
  if(current)drawTmp(current);
  for(const s of remoteLive.values())drawTmp(s);
  if(arcDraft&&arcDraft.a0!==null){
    // Ножка циркуля и сама дуга, пока её обводят.
    paintArc(lctx,{cx:arcDraft.cx,cy:arcDraft.cy,r:arcDraft.r,
                   a0:arcDraft.a0,a1:arcDraft.a1,
                   color:S.color,size:S.size,dash:S.dash});
    lctx.save();
    lctx.strokeStyle='rgba(47,128,237,.5)';lctx.lineWidth=1/S.cam.z;
    lctx.setLineDash([4/S.cam.z,4/S.cam.z]);
    lctx.beginPath();lctx.moveTo(arcDraft.cx,arcDraft.cy);
    const tip=arcPt(arcDraft,arcDraft.a1);
    lctx.lineTo(tip.x,tip.y);lctx.stroke();
    lctx.setLineDash([]);
    lctx.fillStyle='#2F80ED';
    lctx.beginPath();lctx.arc(arcDraft.cx,arcDraft.cy,3/S.cam.z,0,6.2832);lctx.fill();
    lctx.restore();

    /* Градусная мера, пока ведут. Показываем сколько развернули от начала —
       именно это и держат в голове, когда чертят угол. С отрывом пера подпись
       исчезает вместе с самим наброском: на готовой дуге она была бы мусором. */
    const deg=Math.abs(arcDraft.a1-arcDraft.a0)*180/Math.PI;
    const mid=arcPt(arcDraft,(arcDraft.a0+arcDraft.a1)/2);
    const sp=toScreen(mid.x,mid.y);
    lctx.setTransform(dpr,0,0,dpr,0,0);
    const txt=(deg>=360?deg.toFixed(0):deg.toFixed(1))+'°';
    lctx.font='12px ui-sans-serif,system-ui,sans-serif';
    const tw=lctx.measureText(txt).width+12;
    // подпись чуть наружу от дуги, чтобы не перекрывать саму линию
    const away=Math.hypot(sp.x-toScreen(arcDraft.cx,arcDraft.cy).x,
                          sp.y-toScreen(arcDraft.cx,arcDraft.cy).y)||1;
    const c0=toScreen(arcDraft.cx,arcDraft.cy);
    const bx=sp.x+(sp.x-c0.x)/away*18-tw/2, by=sp.y+(sp.y-c0.y)/away*18-10;
    lctx.fillStyle='rgba(247,245,240,.96)';lctx.strokeStyle='rgba(26,28,32,.25)';
    lctx.lineWidth=1;
    lctx.beginPath();lctx.roundRect(bx,by,tw,20,5);lctx.fill();lctx.stroke();
    lctx.fillStyle='#1A1C20';lctx.textAlign='center';lctx.textBaseline='middle';
    lctx.fillText(txt,bx+tw/2,by+10);
    lctx.textAlign='start';lctx.textBaseline='alphabetic';
    applyCam(lctx);
  }
  if(shapeDraft){
    const d=shapeDraft;
    const x0=Math.min(d.a.x,d.b.x), y0=Math.min(d.a.y,d.b.y);
    const w0=Math.abs(d.b.x-d.a.x), h0=Math.abs(d.b.y-d.a.y);
    paintShape(lctx,{kind:d.kind,x:x0,y:y0,w:w0,h:h0,rot:0,
                     color:S.color,size:S.size,dash:S.dash,fill:S.fill});
  }
  if(pathDraft){
    const d=pathDraft;
    let pts=d.pts;
    if(d.mode==='vertex'&&d.live)pts=pts.concat([d.live]);
    if(pts.length>=2){
      paintPath(lctx,{kind:d.kind,pts,closed:false,
        color:S.color,size:S.size,dash:S.dash,fill:d.kind==='polygon'?S.fill:null,
        a1:S.a1||0,a2:S.a2||0});
    }
    if(d.mode==='vertex'){
      const rDot=4/S.cam.z;
      lctx.fillStyle='#2F80ED';
      for(const p of d.pts){lctx.beginPath();lctx.arc(p.x,p.y,rDot,0,6.2832);lctx.fill();}
    }
    /* Транспортир: градус видно уже во время черчения второго луча — так
       можно вести мышь, глядя на число, а не подгонять угол на глаз и
       проверять уже после отпускания. Тот же приём, что и у циркуля выше. */
    if(S.physicsPreset==='protractor'&&d.mode==='vertex'&&d.live&&d.pts.length>=2){
      const c=pts.length,v=pts[c-2];
      const deg=angleAt(pts[c-3],v,pts[c-1]);
      const sp=toScreen(v.x,v.y);
      lctx.setTransform(dpr,0,0,dpr,0,0);
      const txt=Math.round(deg)+'°';
      lctx.font='12px ui-sans-serif,system-ui,sans-serif';
      const tw=lctx.measureText(txt).width+12;
      const bx=sp.x-tw/2, by=sp.y-32;
      lctx.fillStyle='rgba(247,245,240,.96)';lctx.strokeStyle='rgba(26,28,32,.25)';
      lctx.lineWidth=1;
      lctx.beginPath();lctx.roundRect(bx,by,tw,20,5);lctx.fill();lctx.stroke();
      lctx.fillStyle='#1A1C20';lctx.textAlign='center';lctx.textBaseline='middle';
      lctx.fillText(txt,bx+tw/2,by+10);
      lctx.textAlign='start';lctx.textBaseline='alphabetic';
      applyCam(lctx);
    }
  }

  lctx.setTransform(dpr,0,0,dpr,0,0);

  // рамка выделенного объекта — с учётом поворота у box-семейства
  if(selected){
    const col=selected.locked?'#B3322B':'#2F80ED';
    lctx.strokeStyle=col;lctx.lineWidth=1.5;lctx.setLineDash([5,4]);
    if(BOX_TYPES.has(selected.type)){
      const cx=selected.x+selected.w/2,cy=selected.y+selected.h/2;
      const p=toScreen(cx,cy),rot=selected.rot||0;
      lctx.save();lctx.translate(p.x,p.y);lctx.rotate(rot);
      lctx.strokeRect(-selected.w*S.cam.z/2,-selected.h*S.cam.z/2,selected.w*S.cam.z,selected.h*S.cam.z);
      lctx.restore();
    }else{
      const b=bboxOf(selected),p0=toScreen(b.x0,b.y0);
      lctx.strokeRect(p0.x,p0.y,(b.x1-b.x0)*S.cam.z,(b.y1-b.y0)*S.cam.z);
    }
    lctx.setLineDash([]);
    const handles=handlesFor(selected);
    if(handles.length){
      const centerW=BOX_TYPES.has(selected.type)
        ?{x:selected.x+selected.w/2,y:selected.y+selected.h/2}
        :(()=>{const b=bboxOf(selected);return{x:(b.x0+b.x1)/2,y:(b.y0+b.y1)/2};})();
      const centerS=toScreen(centerW.x,centerW.y);
      for(const h of handles){
        if(h.kind==='rotate'){
          lctx.strokeStyle=col;lctx.lineWidth=1;lctx.setLineDash([3,3]);
          lctx.beginPath();lctx.moveTo(centerS.x,centerS.y);lctx.lineTo(h.sx,h.sy);lctx.stroke();
          lctx.setLineDash([]);
          lctx.fillStyle='#fff';lctx.strokeStyle=col;lctx.lineWidth=1.5;
          lctx.beginPath();lctx.arc(h.sx,h.sy,6,0,6.2832);lctx.fill();lctx.stroke();
        }else{
          lctx.fillStyle='#fff';lctx.strokeStyle=col;lctx.lineWidth=1.5;
          lctx.beginPath();lctx.rect(h.sx-5,h.sy-5,10,10);lctx.fill();lctx.stroke();
        }
      }
    }
  }
  /* Отсчёт угла при повороте: вертикальная нормаль, текущее направление и
     подпись между ними. Без числа поворот на глаз не поставишь. */
  if(dragging&&(dragging.mode==='rotate'||dragging.mode==='angle')&&
     typeof dragging.angle==='number'){
    const c=toScreen(dragging.cx,dragging.cy);
    const R=Math.min(120,Math.max(54,dragging.armPx||90));
    const a=dragging.angle*Math.PI/180;
    lctx.strokeStyle='rgba(26,28,32,.55)';lctx.lineWidth=1;
    lctx.beginPath();lctx.moveTo(c.x,c.y);lctx.lineTo(c.x,c.y-R);lctx.stroke();      // нормаль
    lctx.beginPath();lctx.moveTo(c.x,c.y);
    lctx.lineTo(c.x+Math.sin(a)*R,c.y-Math.cos(a)*R);lctx.stroke();                  // текущее
    const txt=dragging.angle.toFixed(1)+'°';
    lctx.font='12px ui-sans-serif,system-ui,sans-serif';
    const tw=lctx.measureText(txt).width+12;
    const bx=c.x-tw/2, by=c.y+6;
    lctx.fillStyle='rgba(247,245,240,.96)';lctx.strokeStyle='rgba(26,28,32,.25)';
    lctx.lineWidth=1;
    lctx.beginPath();lctx.roundRect(bx,by,tw,20,5);lctx.fill();lctx.stroke();
    lctx.fillStyle='#1A1C20';lctx.textAlign='center';lctx.textBaseline='middle';
    lctx.fillText(txt,c.x,by+10);
    lctx.textAlign='start';lctx.textBaseline='alphabetic';
  }

  /* Группа: одна общая рамка, а сами объекты подсвечены.

     Раньше у каждого объекта была своя рамка, и выделенный десяток штрихов
     превращался в решётку из прямоугольников — за ней не видно самих записей.
     Теперь объекты обводятся по собственному контуру мягким ореолом: сразу
     понятно, что именно взято, и написанное остаётся читаемым.

     Ручек у группы нет намеренно: поворот и растяжение группы — отдельная
     история, а перенос, копия, замок и удаление работают и без них. */
  if(selection.length>1){
    lctx.save();
    lctx.setTransform(dpr,0,0,dpr,0,0);
    applyCam(lctx);
    lctx.strokeStyle='rgba(47,128,237,.38)';
    lctx.lineJoin='round';lctx.lineCap='round';
    for(const it of selection){
      const halo=(it.size||2)+10/S.cam.z;      // ореол шире самой линии
      lctx.lineWidth=halo;
      if(BOX_TYPES.has(it.type)){
        const rot=it.rot||0, cx=it.x+it.w/2, cy=it.y+it.h/2;
        lctx.save();
        if(rot){lctx.translate(cx,cy);lctx.rotate(rot);lctx.translate(-cx,-cy);}
        lctx.lineWidth=6/S.cam.z;
        lctx.strokeRect(it.x,it.y,it.w,it.h||0);
        lctx.restore();
      }else if(ARC_TYPES.has(it.type)){
        lctx.beginPath();
        lctx.arc(it.cx,it.cy,it.r,it.a0,it.a0+arcSweep(it));
        lctx.stroke();
      }else if(Array.isArray(it.pts)&&it.pts.length){
        lctx.beginPath();
        lctx.moveTo(it.pts[0].x,it.pts[0].y);
        for(let i=1;i<it.pts.length;i++)lctx.lineTo(it.pts[i].x,it.pts[i].y);
        if(it.closed)lctx.closePath();
        lctx.stroke();
      }
    }
    lctx.restore();
    lctx.setTransform(dpr,0,0,dpr,0,0);

    const g=selectionBox(),gp=toScreen(g.x0,g.y0);
    lctx.strokeStyle='#2F80ED';lctx.lineWidth=1.5;lctx.setLineDash([6,4]);
    lctx.strokeRect(gp.x-4,gp.y-4,(g.x1-g.x0)*S.cam.z+8,(g.y1-g.y0)*S.cam.z+8);
    lctx.setLineDash([]);
  }
  // рамка протяжки
  if(marquee){
    const a=toScreen(marquee.a.x,marquee.a.y), b=toScreen(marquee.b.x,marquee.b.y);
    const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
    lctx.fillStyle='rgba(47,128,237,.10)';lctx.fillRect(x,y,w,h);
    lctx.strokeStyle='#2F80ED';lctx.lineWidth=1;lctx.setLineDash([4,3]);
    lctx.strokeRect(x+.5,y+.5,w,h);lctx.setLineDash([]);
  }
  // кольцо ластика
  if(S.tool==='eraser'&&hoverPt){
    lctx.beginPath();lctx.arc(hoverPt.x,hoverPt.y,eraserR()*S.cam.z,0,6.2832);
    lctx.strokeStyle='rgba(30,32,36,.55)';lctx.lineWidth=1.2;lctx.stroke();
    lctx.fillStyle='rgba(255,255,255,.35)';lctx.fill();
  }
  paintGraphCoordHint(lctx);
  // курсоры участников
  const now=performance.now();
  for(const [id,c] of cursors){
    if(now-c.t>5000){cursors.delete(id);continue;}
    const p=peers.get(id); if(!p)continue;
    const s=toScreen(c.x,c.y);
    lctx.globalAlpha=Math.max(0,1-(now-c.t)/5000)*0.95;
    lctx.beginPath();lctx.arc(s.x,s.y,4.5,0,6.2832);
    lctx.fillStyle=p.color;lctx.fill();
    lctx.strokeStyle='rgba(255,255,255,.85)';lctx.lineWidth=1.5;lctx.stroke();
    lctx.font='600 11px Inter,system-ui,sans-serif';
    const w=lctx.measureText(p.name).width+10;
    lctx.fillStyle=p.color; roundRect(lctx,s.x+9,s.y+6,w,17,8); lctx.fill();
    lctx.fillStyle='#fff'; lctx.fillText(p.name,s.x+14,s.y+18);
    lctx.globalAlpha=1;
  }
  // Указатели «участник смотрит в другой стороне» — как в iDroo: если чья-то
  // видимая область не пересекается с моей, у края экрана в её сторону
  // рисуется стрелка его цвета с именем. Иначе непонятно, куда вообще
  // смотрит человек — особенно ученику, где сейчас объясняет учитель.
  for(const[id,v] of peerViews){
    if(now-v.seen>8000){peerViews.delete(id);continue;}
    const p=peers.get(id); if(!p||!v.cam||!v.w||!v.h)continue;
    // их видимая область в мировых координатах — по их же присланным cam/w/h
    const tL=(0-v.cam.x)/v.cam.z, tR=(v.w-v.cam.x)/v.cam.z;
    const tT=(0-v.cam.y)/v.cam.z, tB=(v.h-v.cam.y)/v.cam.z;
    const myTl=toWorld(0,0), myBr=toWorld(board.clientWidth,board.clientHeight);
    const overlap=tL<myBr.x&&tR>myTl.x&&tT<myBr.y&&tB>myTl.y;
    if(overlap)continue;
    const sp=toScreen((tL+tR)/2,(tT+tB)/2);
    const pad=28;
    const cx=Math.max(pad,Math.min(board.clientWidth-pad,sp.x));
    const cy=Math.max(pad,Math.min(board.clientHeight-pad,sp.y));
    const ang=Math.atan2(sp.y-cy,sp.x-cx);
    lctx.save();
    lctx.translate(cx,cy);lctx.rotate(ang);
    lctx.fillStyle=p.color;
    lctx.beginPath();lctx.moveTo(12,0);lctx.lineTo(-7,-7);lctx.lineTo(-7,7);lctx.closePath();lctx.fill();
    lctx.strokeStyle='rgba(255,255,255,.85)';lctx.lineWidth=1.3;lctx.stroke();
    lctx.restore();
    lctx.font='600 11px Inter,system-ui,sans-serif';
    const tw=lctx.measureText(p.name).width+10;
    const lx=Math.max(4,Math.min(board.clientWidth-tw-4,cx+12));
    const ly=Math.max(20,Math.min(board.clientHeight-4,cy-6));
    lctx.fillStyle=p.color; roundRect(lctx,lx,ly,tw,17,8); lctx.fill();
    lctx.fillStyle='#fff'; lctx.fillText(p.name,lx+5,ly+12);
  }
  if(cursors.size||peerViews.size)liveDirty=true;
}
function roundRect(c,x,y,w,h,r){
  c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);
  c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();
}
function zoomAt(sx,sy,f){
  const z0=S.cam.z, z1=Math.min(20,Math.max(0.06,z0*f));
  if(Math.abs(z1-z0)<1e-9)return;
  S.cam.x=sx-(sx-S.cam.x)*(z1/z0);
  S.cam.y=sy-(sy-S.cam.y)*(z1/z0);
  S.cam.z=z1; camChanged();
}
function camChanged(){
  document.getElementById('zoom').textContent=Math.round(S.cam.z*100)+'%';
  drawBoard();drawLive();net.sendView();net.sendPresence();
}

/* ═══════════════════ курсоры ═══════════════════ */
const cur=(inner,hx,hy)=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'+inner+'</svg>';
  return 'url("data:image/svg+xml;utf8,'+encodeURIComponent(svg)+'") '+hx+' '+hy+', crosshair';
};
const CURSOR={
  pen:cur('<path d="M2.6 21.4l1-3.9L15.8 5.3a2.05 2.05 0 0 1 2.9 2.9L6.5 20.4l-3.9 1z" fill="#FFFDF8" stroke="#16181C" stroke-width="1.25" stroke-linejoin="round"/>'+
          '<path d="M14.5 6.6l2.9 2.9" stroke="#16181C" stroke-width="1.15"/>'+
          '<path d="M2.6 21.4l1.9-.5-1.4-1.4z" fill="#16181C"/>',2,22),
  marker:cur('<path d="M3 21l1.2-4.6 9.4-9.4 4.4 4.4-9.4 9.4L3 21z" fill="#FFFDF8" stroke="#16181C" stroke-width="1.25" stroke-linejoin="round"/>'+
          '<path d="M14.2 5.4l2.6-2.6 4.4 4.4-2.6 2.6z" fill="#F2D33C" stroke="#16181C" stroke-width="1.25"/>',3,21),
  select:'default', hand:'grab', eraser:'none', text:'text', arc:'crosshair'
};
/* Стрелка на ручке показывает, куда потянется край. Направление считается с
   учётом поворота объекта: у наклонённого прямоугольника «верхняя» ручка тянет
   не вверх, и курсор должен говорить правду. Восемь готовых курсоров браузера
   идут через 45°, поэтому угол округляем до ближайшего. */
const RESIZE_CURSORS=['ns-resize','nesw-resize','ew-resize','nwse-resize'];
/* Курсора «поворот» в браузере нет, поэтому рисуем свой: круговая стрелка,
   белая обводка под тёмной линией — чтобы читалась и на бумаге, и на тёмной
   картинке. Число в конце — точка, которой курсор указывает. */
const ROTATE_CURSOR="url(\"data:image/svg+xml;utf8,"+encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">'+
  '<g fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">'+
  '<path d="M20 13a7 7 0 1 1-2.3-5.2"/><path d="M20 4.5V9h-4.5"/></g>'+
  '<g fill="none" stroke="#1A1C20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+
  '<path d="M20 13a7 7 0 1 1-2.3-5.2"/><path d="M20 4.5V9h-4.5"/></g></svg>')+"\") 13 13, grab";

function handleCursor(h){
  if(!h)return null;
  if(h.kind==='rotate')return ROTATE_CURSOR;
  if(h.kind==='vertex')return 'move';
  const base={n:0,ne:45,e:90,se:135,s:180,sw:225,w:270,nw:315}[h.name];
  if(base===undefined)return 'move';
  const rot=(selected&&BOX_TYPES.has(selected.type)?(selected.rot||0):0)*180/Math.PI;
  const a=((base+rot)%180+180)%180;                 // стрелка симметрична
  return RESIZE_CURSORS[Math.round(a/45)%4];
}

function applyCursor(){
  stage.style.cursor = panning ? 'grabbing'
    : (spaceDown ? 'grab'
    : (!canEdit() ? 'not-allowed'
    : (hoverHandleCursor || (CURSOR[S.tool]||'crosshair'))));
}
let hoverHandleCursor=null;

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
(function loop(){flushBoard();flushLive();requestAnimationFrame(loop);})();

/* ═══════════════════ камера ═══════════════════ */
}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  applyCursor, camChanged, cursors, drawBoard, drawLive, handleCursor, hoverHandleCursor,
  hoverPt, peerViews, peers, remoteLive, resize, zoomAt,
};
