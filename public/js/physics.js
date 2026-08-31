/* магнит, оптика, тепловые явления */

import { S, items } from './core.js';
import { drawArrowhead } from './shapes.js';
import { drawBoard } from './render.js';
import { net } from './net.js';
import { canEdit } from './input.js';

/* ═══ физические объекты-симуляции (раздел «Физика» в доп.меню) ═══
   Один тип items ('physics'), разные kind. Свойства — в it.props (JSON),
   геометрия — та же четвёрка x,y,w,h,rot, что у картинки, поэтому ручки
   ресайза/поворота уже работают сами (BOX_TYPES). Никакого нового
   анимационного цикла не заводим: paintPhysics вызывается из paintItem,
   а тот — из обычного flushBoard(), которое и так перерисовывается на
   каждое движение любого объекта (свой драг или чужой 'move') — значит
   стрелка компаса всегда считается по самым свежим координатам магнитов. */
const physicsAngleCache=new Map();          // id → последний посчитанный угол (только рендер, не грузится в сеть)
/** Полюса магнита в мировых координатах, одна формула на всё приложение —
    ей пользуются и расчёт поля, и трассировка силовых линий, и (раньше) её
    дублировали в двух местах с противоположным знаком, отчего стрелка
    компаса реагировала правильно только с одной стороны магнита. N — под
    красной половиной корпуса, S — под синей (см. paintPhysics: красная
    половина рисуется в локальных x от -w/2 до 0, синяя — от 0 до w/2). */
function magnetPoles(it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0;
  const half=it.w/2*0.72,dir={x:Math.cos(rot),y:Math.sin(rot)};
  return { N:{x:cx-dir.x*half,y:cy-dir.y*half}, S:{x:cx+dir.x*half,y:cy+dir.y*half}, half };
}
/* Множитель поля одного полюса — подобран так, чтобы зона заметного действия
   была в несколько длин самого магнита (как у настоящего): вплотную —
   стрелка «прилипает», в 3-6 длин — уверенно отклоняется, к 10 длинам поле
   магнита слабее фонового и стрелка возвращается к «северу». Раньше здесь
   стояла фиксированная константа без привязки к размеру магнита — с ней
   реакция была заметна только почти вплотную, отсюда жалоба на низкую
   чувствительность. */
const FIELD_K=400;
/** Поле одного полюса в точке (px,py): убывает как 1/r² — Био-Савара-Лапласа
    здесь нет (тот закон — для тока в проводнике, пригодится для будущего
    электромагнита/катушки), а у постоянного стержневого магнита с двумя
    точечными полюсами (модель Гильберта, ей же исторически описывали
    магниты до модели Ампера с токовыми контурами) поле от каждого полюса —
    как у точечного заряда: направлено от полюса наружу (sign=+1 у north,
    -1 у south), убывает как 1/r². half — полудлина магнита, отсюда «сила
    поля» масштабируется размером самого объекта, а не берётся с потолка. */
function poleField(px,py,pole,sign,strength,half){
  const dx=px-pole.x,dy=py-pole.y,d2=Math.max(dx*dx+dy*dy,1);
  const k=sign*strength*FIELD_K*half*half/d2, d=Math.sqrt(d2);
  return {x:dx/d*k,y:dy/d*k};
}
/** Суммарное магнитное поле в мировой точке (px,py) от всех магнитов на
    доске — суперпозиция вкладов: с двумя и более магнитами линии одного
    правильно огибают и притягиваются/отталкиваются от полюсов другого,
    потому что здесь честно складываются вклады всех сразу, а не одного
    ближайшего. Чистое поле, без посторонних добавок — им и трассируются
    силовые линии (учебник рисует именно его, а не «поле плюс что-то ещё»). */
function magnetFieldAt(px,py){
  let fx=0,fy=0;
  for(const it of items){
    if(it.type!=='physics'||it.kind!=='magnet')continue;
    const {N,S,half}=magnetPoles(it);
    const strength=(it.props&&it.props.strength)||1;
    const fN=poleField(px,py,N,1,strength,half), fS=poleField(px,py,S,-1,strength,half);
    fx+=fN.x+fS.x; fy+=fN.y+fS.y;
  }
  return {x:fx,y:fy};
}
/** То же самое плюс слабое фоновое поле «на север» (вверх) — то, что
    реально чувствует стрелка компаса: вдали от всех магнитов она не висит
    на нуле, а тяготеет к северу, как настоящая (это уже про Землю, а не
    про магнит, поэтому в трассировку линий магнита ниже не подмешивается —
    иначе замкнутые линии из учебника тянуло бы вбок и они переставали
    сходиться в S). */
function fieldAt(px,py){
  const f=magnetFieldAt(px,py);
  return {x:f.x,y:f.y-6};
}
/** Угол стрелки компаса — не хранимое поле объекта, а результат расчёта по
    текущим координатам всех магнитов. Кэш — только чтобы не дёргать стрелку
    в шум там, где поле почти нулевое (не персистится, не едет по сети). */
function compassAngle(it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2;
  const f=fieldAt(cx,cy);
  const mag=Math.hypot(f.x,f.y);
  if(mag<0.5)return physicsAngleCache.get(it.id)||0;
  const ang=Math.atan2(f.y,f.x);
  physicsAngleCache.set(it.id,ang);
  return ang;
}

/* ── силовые линии магнита ──────────────────────────────────
   Классическая трассировка: из точек по кругу вокруг N-полюса шагаем вдоль
   направления локального поля (суммарного — от всех магнитов сразу), пока
   не подойдём вплотную к чьему-нибудь S-полюсу (линия «дошла» — обычная
   картина для одного магнита, его же линия замыкается на его же S — ровно
   вложенные петли, как на классической картинке из учебника: узкие рядом с
   корпусом, широкие — если стартовая точка смотрела прямо вдоль оси от N
   наружу, такой линии нужно обойти по большой дуге, прежде чем вернуться
   к S с другой стороны, отсюда запас в MAX_STEPS). Шаг идёт по чистому
   magnetFieldAt() — без фонового «на север», который нужен только компасу
   (см. fieldAt) и здесь только увёл бы линии в сторону, не давая им
   замкнуться. Из-за общей суммы полей трассировка сама переигрывается,
   когда магнитов двое и больше: линии одного гнутся к полюсам соседнего.
   Кэш по подписи всех магнитов сразу — чтобы не тратить это на каждый
   кадр, если на доске просто рисуют ручкой в стороне. */
const FIELD_LINES=12, FIELD_STEP=5, FIELD_MAX_STEPS=400, FIELD_SINK=7;
function nearestSouthDist(p){
  let best=Infinity;
  for(const it of items){
    if(it.type!=='physics'||it.kind!=='magnet')continue;
    const S=magnetPoles(it).S;
    const d=Math.hypot(p.x-S.x,p.y-S.y);
    if(d<best)best=d;
  }
  return best;
}
function traceFieldLines(it){
  const {N}=magnetPoles(it), R0=Math.max(6,it.h*0.32);
  const maxR=Math.max(600,it.w*8);            // «ушла в бесконечность» — обрезаем, а не считаем вечно
  const lines=[];
  for(let i=0;i<FIELD_LINES;i++){
    const a=(i/FIELD_LINES)*6.2832;
    let p={x:N.x+Math.cos(a)*R0,y:N.y+Math.sin(a)*R0};
    const pts=[p];
    for(let step=0;step<FIELD_MAX_STEPS;step++){
      const f=magnetFieldAt(p.x,p.y);
      const mag=Math.hypot(f.x,f.y)||1e-6;
      p={x:p.x+f.x/mag*FIELD_STEP,y:p.y+f.y/mag*FIELD_STEP};
      pts.push(p);
      if(nearestSouthDist(p)<FIELD_SINK)break;
      if(Math.hypot(p.x-N.x,p.y-N.y)>maxR)break;
    }
    lines.push(pts);
  }
  return lines;
}
let physicsFieldCache={sig:'',lines:new Map()};
function magnetsSignature(){
  let s='';
  for(const it of items) if(it.type==='physics'&&it.kind==='magnet')
    s+=it.id+':'+it.x.toFixed(1)+','+it.y.toFixed(1)+','+(it.rot||0).toFixed(3)+
       ','+((it.props&&it.props.strength)||1)+';';
  return s;
}
function fieldLinesFor(it){
  const sig=magnetsSignature();
  if(physicsFieldCache.sig!==sig)physicsFieldCache={sig,lines:new Map()};
  if(!physicsFieldCache.lines.has(it.id))physicsFieldCache.lines.set(it.id,traceFieldLines(it));
  return physicsFieldCache.lines.get(it.id);
}
function paintFieldLines(ctx,it){
  const lines=fieldLinesFor(it);
  ctx.save();
  ctx.strokeStyle='rgba(90,120,190,.55)';ctx.lineWidth=1.2;
  ctx.lineCap='round';ctx.lineJoin='round';
  for(const pts of lines){
    if(pts.length<2)continue;
    ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
    for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);
    ctx.stroke();
    const mid=Math.floor(pts.length/2);
    if(mid>0)drawArrowhead(ctx,pts[mid-1],pts[mid],2,2.4,'rgba(90,120,190,.85)');
  }
  ctx.restore();
}

/* ── оптика: источник луча, линзы, зеркало ──────────────────────
   Тот же приём, что у поля магнита: элементы — просто данные (позиция,
   поворот, у линзы — фокусное расстояние), сами лучи нигде не хранятся и
   не едут по сети — трассируются заново из текущих координат при каждой
   перерисовке, поэтому у всех участников совпадают автоматически.

   Линза и зеркало — тонкая пластина (отрезок высотой h, перпендикулярный
   собственной оси it.rot), как в оптической скамье: луч подходит вдоль
   примерно горизонтали, пластина стоит поперёк. */
function elementSegment(it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0;
  const perp={x:-Math.sin(rot),y:Math.cos(rot)},half=it.h/2;
  return {A:{x:cx-perp.x*half,y:cy-perp.y*half},B:{x:cx+perp.x*half,y:cy+perp.y*half}};
}
/** Пересечение луча (O,D — единичное направление) с отрезком A-B.
    Стандартная параметризация: t — вдоль луча (нужен t>0, впереди), u —
    вдоль отрезка (0..1, иначе мимо пластины). */
function raySegmentHit(O,D,A,B){
  const sx=B.x-A.x,sy=B.y-A.y;
  const denom=D.x*sy-D.y*sx;
  if(Math.abs(denom)<1e-9)return null;           // луч и пластина параллельны
  const qx=A.x-O.x,qy=A.y-O.y;
  const t=(qx*sy-qy*sx)/denom, u=(qx*D.y-qy*D.x)/denom;
  if(t>1e-3&&u>=0&&u<=1)return{t,x:O.x+D.x*t,y:O.y+D.y*t};
  return null;
}
function reflectDir(D,n){
  const dot=D.x*n.x+D.y*n.y;
  return {x:D.x-2*dot*n.x,y:D.y-2*dot*n.y};
}
/** Тонкая линза, формула из матричной (ABCD) оптики: луч на высоте h от
    оптической оси под углом θ к ней выходит под углом θ'=θ-h/f — тот самый
    закон, которым в учебниках строят ход лучей через собирающую/
    рассеивающую линзу (f>0 — собирающая, f<0 — рассеивающая, знак задаётся
    при постановке инструментом, не подписью пользователя). Формула точна
    для параксиальных (малых) углов; как и во всех интерактивных
    тренажёрах оптики, здесь её применяют и к обычным углам ради наглядной
    картинки, а не строгого хода луча через реальную кривизну стекла.

    θ считается не от мировой оси it.rot, а от направления, вдоль которого
    ЭТОТ луч фактически движется (u или -u — с какой стороны падает свет):
    линза физически симметрична и должна одинаково собирать/рассеивать
    свет что слева, что справа. Раньше θ всегда мерился от +u — для луча,
    идущего справа налево (тот же h, но угол около ±π вместо около нуля),
    коррекция «θ-h/f» через простое сложение мировых углов заворачивала в
    обратную сторону, и рассеивающая линза при взгляде с той стороны вела
    себя как собирающая (и наоборот). */
function refractThroughLens(it,point,D){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0;
  const u={x:Math.cos(rot),y:Math.sin(rot)};        // оптическая ось
  const n={x:-u.y,y:u.x};                            // поперёк линзы — по ней меряется h
  const h=(point.x-cx)*n.x+(point.y-cy)*n.y;
  const sgn=(D.x*u.x+D.y*u.y)>=0?1:-1;               // с какой стороны идёт луч
  const fwd={x:sgn*u.x,y:sgn*u.y};                   // «вперёд» именно для этого луча
  const along=D.x*fwd.x+D.y*fwd.y, across=D.x*n.x+D.y*n.y;
  const theta=Math.atan2(across,along);
  const focal=(it.props&&it.props.focal)||140;
  const theta2=theta-h/focal;
  const c=Math.cos(theta2),s=Math.sin(theta2);
  return {x:c*fwd.x+s*n.x,y:c*fwd.y+s*n.y};
}
const RAY_ESCAPE=1400, RAY_MAX_BOUNCES=6;
function opticalElements(){
  const out=[];
  for(const it of items)if(it.type==='physics'&&(it.kind==='lens'||it.kind==='mirror'))out.push(it);
  return out;
}
/** Трассировка одного луча: на каждом шаге ищем ближайшую линзу/зеркало по
    ходу луча, применяем нужный закон (отражение или тонкая линза) и идём
    дальше от точки встречи. Если ничего не задело — луч уходит в
    пространство на разумное расстояние (RAY_ESCAPE), совсем как силовые
    линии магнита выше. Ограничение по числу столкновений — чтобы зеркала,
    поставленные друг напротив друга, не заставили считать бесконечно. */
function traceRay(O,D){
  const pts=[O];
  const els=opticalElements();
  for(let b=0;b<RAY_MAX_BOUNCES;b++){
    let hit=null,hitIt=null;
    for(const it of els){
      const seg=elementSegment(it);
      const r=raySegmentHit(O,D,seg.A,seg.B);
      if(r&&(!hit||r.t<hit.t)){hit=r;hitIt=it;}
    }
    if(!hit){pts.push({x:O.x+D.x*RAY_ESCAPE,y:O.y+D.y*RAY_ESCAPE});break;}
    pts.push({x:hit.x,y:hit.y});
    if(hitIt.kind==='mirror'){
      const rot=hitIt.rot||0;
      D=reflectDir(D,{x:Math.cos(rot),y:Math.sin(rot)});
    }else{
      D=refractThroughLens(hitIt,{x:hit.x,y:hit.y},D);
    }
    // маленький сдвиг вперёд, чтобы на следующем шаге луч не «зацепился»
    // за ту же самую пластину в точке выхода
    O={x:hit.x+D.x*0.5,y:hit.y+D.y*0.5};
  }
  return pts;
}
function sourceRays(it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0;
  const n=Math.max(1,Math.min(41,Math.round((it.props&&it.props.rayCount)||5)));
  const spread=((it.props&&it.props.spreadDeg)!=null?it.props.spreadDeg:16)*Math.PI/180;
  const dirs=[];
  if(n===1)dirs.push(rot);
  else for(let i=0;i<n;i++)dirs.push(rot-spread/2+spread*i/(n-1));
  return dirs.map(a=>traceRay({x:cx,y:cy},{x:Math.cos(a),y:Math.sin(a)}));
}
let opticsCache={sig:'',rays:new Map()};
function opticsSignature(){
  let s='';
  for(const it of items) if(it.type==='physics'&&(it.kind==='light-source'||it.kind==='lens'||it.kind==='mirror'))
    s+=it.id+':'+it.x.toFixed(1)+','+it.y.toFixed(1)+','+(it.rot||0).toFixed(3)+
       ','+it.h.toFixed(1)+','+JSON.stringify(it.props||{})+';';
  return s;
}
function raysFor(it){
  const sig=opticsSignature();
  if(opticsCache.sig!==sig)opticsCache={sig,rays:new Map()};
  if(!opticsCache.rays.has(it.id))opticsCache.rays.set(it.id,sourceRays(it));
  return opticsCache.rays.get(it.id);
}
function paintRays(ctx,it){
  ctx.save();
  ctx.strokeStyle='rgba(224,64,40,.75)';ctx.lineWidth=1.4;ctx.lineCap='round';ctx.lineJoin='round';
  for(const pts of raysFor(it)){
    if(pts.length<2)continue;
    ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
    for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
}
/** Значок линзы — тот же символ, что и в учебнике: пластина с «крылышками»
    наружу у собирающей (шире в середине хода лучей) и внутрь у
    рассеивающей. Переиспользует drawArrowhead — не заводим для значка
    отдельную геометрию. */
function paintLens(ctx,it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0,h=it.h;
  const converging=((it.props&&it.props.focal)||140)>=0;
  const cap=Math.max(8,h*0.16),col='#4C7FD6';
  ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);
  ctx.strokeStyle=col;ctx.lineWidth=2.2;
  ctx.beginPath();ctx.moveTo(0,-h/2);ctx.lineTo(0,h/2);ctx.stroke();
  if(converging){
    drawArrowhead(ctx,{x:0,y:-h/2+cap},{x:0,y:-h/2},1,cap*0.55,col);
    drawArrowhead(ctx,{x:0,y:h/2-cap},{x:0,y:h/2},1,cap*0.55,col);
  }else{
    drawArrowhead(ctx,{x:0,y:-h/2},{x:0,y:-h/2+cap},1,cap*0.55,col);
    drawArrowhead(ctx,{x:0,y:h/2},{x:0,y:h/2-cap},1,cap*0.55,col);
  }
  ctx.restore();
}
/** Зеркало отражает с обеих сторон — упрощение ради этого первого прохода:
    настоящее одностороннее зеркало потребовало бы отдельно решать, что
    происходит с лучом, зашедшим со спины (пропускать насквозь), это
    осмысленно отложить до отдельного шага. */
function paintMirror(ctx,it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0,h=it.h;
  ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);
  ctx.strokeStyle='#8C9199';ctx.lineWidth=3;ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(0,-h/2);ctx.lineTo(0,h/2);ctx.stroke();
  ctx.restore();
}
function paintSource(ctx,it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0,r=Math.min(it.w,it.h)/2;
  paintRays(ctx,it);
  ctx.save();ctx.translate(cx,cy);
  ctx.fillStyle='#F4C94B';ctx.strokeStyle='rgba(0,0,0,.25)';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.arc(0,0,r*0.5,0,6.2832);ctx.fill();ctx.stroke();
  ctx.strokeStyle='#C99A2E';ctx.lineWidth=2;
  for(let i=0;i<8;i++){
    const a=i/8*6.2832;
    ctx.beginPath();ctx.moveTo(Math.cos(a)*r*0.68,Math.sin(a)*r*0.68);
    ctx.lineTo(Math.cos(a)*r*0.95,Math.sin(a)*r*0.95);ctx.stroke();
  }
  // короткая стрелка — куда «прицелен» пучок, повторяет it.rot
  ctx.rotate(rot);
  ctx.strokeStyle='#8C6A1A';ctx.lineWidth=2;
  ctx.beginPath();ctx.moveTo(r*0.5,0);ctx.lineTo(r*1.25,0);ctx.stroke();
  drawArrowhead(ctx,{x:r*0.9,y:0},{x:r*1.25,y:0},2,4,'#8C6A1A');
  ctx.restore();
}

/* ── тепловые явления: нагреватель, тело, калориметр ─────────────
   Тот же принцип, что у остальной физики: объекты — данные, поведение
   считает общий код. Разница только в одном — здесь впервые появляется
   настоящее время: температура тела растёт, пока рядом греет нагреватель,
   даже если никто на доске ничего не трогает. Хранить саму температуру
   как отдельное синхронизируемое поле не стали — она всегда пересчитана
   из energyJoules (Дж, суммарно переданное количество теплоты) по
   формулам количества теплоты; это единственное число, которое реально
   меняется во времени и периодически уходит по сети остальным
   участникам (см. thermalTick ниже), а не сама температура — так суммарно
   переданная теплота остаётся верной, даже если мощность нагревателя
   меняли посреди нагрева. */
const MATERIALS={
  water:{title:'Вода / лёд',cSolid:2100,cLiquid:4200,cGas:2000,
    melt:0,boil:100,fusion:330000,vapor:2260000,t0:-10},
  copper:{title:'Медь',cSolid:380,melt:1085,fusion:205000,t0:20},
  aluminum:{title:'Алюминий',cSolid:920,melt:660,fusion:390000,t0:20},
  lead:{title:'Свинец',cSolid:140,melt:327,fusion:25000,t0:20},
  steel:{title:'Сталь',cSolid:460,melt:1450,fusion:270000,t0:20},
};
/** Температура и фаза тела по суммарно переданному количеству теплоты —
    ровно та стадийная модель, по которой в учебнике строят график
    нагревания: греем твёрдое до t плавления, тратим теплоту плавления
    (температура стоит на месте — «плато»), греем жидкость до кипения,
    тратим теплоту парообразования (снова плато), греем пар. У металлов
    (нет boil/vapor/cLiquid в таблице) кипение не моделируем — после
    плавления жидкость греется дальше без потолка, приближённо тем же c,
    что и твёрдое тело: раздельных данных по жидкой фазе металлов в
    школьном курсе обычно и не дают. */
function tempFromEnergy(mat,mass,Q){
  const cS=mat.cSolid,cL=mat.cLiquid||mat.cSolid,cG=mat.cGas||cL;
  let q=Math.max(0,Q);
  const q1=cS*mass*(mat.melt-mat.t0);
  if(q<q1)return {temp:mat.t0+q/(cS*mass),phase:'solid'};
  q-=q1;
  const qFusion=(mat.fusion||0)*mass;
  if(q<qFusion)return {temp:mat.melt,phase:'melting'};
  q-=qFusion;
  if(mat.boil==null)return {temp:mat.melt+q/(cL*mass),phase:'liquid'};
  const q3=cL*mass*(mat.boil-mat.melt);
  if(q<q3)return {temp:mat.melt+q/(cL*mass),phase:'liquid'};
  q-=q3;
  const qVapor=(mat.vapor||0)*mass;
  if(q<qVapor)return {temp:mat.boil,phase:'boiling'};
  q-=qVapor;
  return {temp:mat.boil+q/(cG*mass),phase:'gas'};
}
const PHASE_NAME={solid:'твёрдое',melting:'плавление',liquid:'жидкое',boiling:'кипение',gas:'пар'};
const PHASE_COLOR={solid:'#8FC7EA',melting:'#B9DDE6',liquid:'#3E9BD6',boiling:'#CFE9EF',gas:'#E7EEF2'};
function bodyState(it){
  const mat=MATERIALS[(it.props&&it.props.material)||'water'];
  const mass=Math.max(0.001,(it.props&&it.props.mass)||0.1);
  const Q=(it.props&&it.props.energyJoules)||0;
  return {...tempFromEnergy(mat,mass,Q),mat,mass};
}
/** Нагреватели, действующие на тело — по перекрытию областей (с запасом
    в четверть их размера, чтобы не требовалось попиксельно точного
    совмещения): суммируем мощность всех задевающих, как и положено при
    нескольких источниках тепла сразу. */
function heatersOn(body){
  const bx=body.x+body.w/2,by=body.y+body.h/2,br=Math.max(body.w,body.h)/2;
  let power=0,any=false;
  for(const it of items){
    if(it.type!=='physics'||it.kind!=='heater')continue;
    const hx=it.x+it.w/2,hy=it.y+it.h/2,hr=Math.max(it.w,it.h)/2;
    if(Math.hypot(hx-bx,hy-by)<(br+hr)*0.85){power+=(it.props&&it.props.power)||500;any=true;}
  }
  return {power,any};
}
const thermalHistory=new Map();             // id → [{t,temp}] — только для графика, локально у зрителя
let thermalLastTick=performance.now();
/** Единственное место, где на доске течёт настоящее время: раз в ~400мс
    проверяем, кого сейчас греют, добавляем прошедшую энергию и секунды.
    Тикает у всех — и у зрителя тоже, иначе он не увидит, как меняется
    температура, — но пишет обратно на сервер только тот, кому разрешено
    редактировать: иначе каждый зритель слал бы свою правку одновременно. */
function thermalTick(){
  const now=performance.now();
  const dt=Math.min(2,(now-thermalLastTick)/1000);
  thermalLastTick=now;
  if(!S.boardId||dt<=0)return;
  let any=false;
  for(const it of items){
    if(it.type!=='physics'||it.kind!=='body')continue;
    const {power,any:touching}=heatersOn(it);
    const started=it.props&&it.props.started;
    if(!touching&&!started)continue;
    any=true;
    const p=it.props||(it.props={material:'water',mass:0.1,energyJoules:0,elapsedSeconds:0});
    p.started=true;
    p.elapsedSeconds=(p.elapsedSeconds||0)+dt;
    if(touching)p.energyJoules=(p.energyJoules||0)+power*dt;
    it.bbox=null;
    const st=bodyState(it);
    let hist=thermalHistory.get(it.id);
    if(!hist)thermalHistory.set(it.id,hist=[]);
    hist.push({t:p.elapsedSeconds,temp:st.temp});
    if(hist.length>800)hist.splice(0,hist.length-800);
    it._thermalDirty=(it._thermalDirty||0)+dt;
    if(canEdit()&&it._thermalDirty>1.2){
      it._thermalDirty=0;
      net.send({t:'move',id:it.id,props:{...p}});
    }
  }
  if(any)drawBoard();
}
function paintHeater(ctx,it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0,w=it.w,h=it.h;
  ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);
  ctx.fillStyle='#3A3D42';ctx.fillRect(-w/2,h*0.15,w,h*0.35);
  ctx.fillStyle='#D8433A';
  for(let i=0;i<3;i++){
    const fx=-w*0.3+i*w*0.3;
    ctx.beginPath();
    ctx.moveTo(fx,h*0.15);
    ctx.quadraticCurveTo(fx-w*0.12,-h*0.1,fx,-h*0.35);
    ctx.quadraticCurveTo(fx+w*0.12,-h*0.05,fx,h*0.15);
    ctx.fill();
  }
  ctx.fillStyle='#F4A23A';
  for(let i=0;i<3;i++){
    const fx=-w*0.3+i*w*0.3;
    ctx.beginPath();ctx.moveTo(fx,h*0.1);
    ctx.quadraticCurveTo(fx-w*0.05,-h*0.02,fx,-h*0.18);
    ctx.quadraticCurveTo(fx+w*0.05,-h*0.02,fx,h*0.1);ctx.fill();
  }
  ctx.restore();
}
function paintBody(ctx,it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0,w=it.w,h=it.h;
  const st=bodyState(it);
  ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);
  ctx.fillStyle=PHASE_COLOR[st.phase];ctx.strokeStyle='rgba(0,0,0,.3)';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.roundRect(-w/2,-h/2,w,h,6);ctx.fill();ctx.stroke();
  ctx.fillStyle='#1A1C20';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.font='600 '+Math.round(h*0.24)+'px ui-sans-serif,system-ui,sans-serif';
  ctx.fillText(Math.round(st.temp)+'°C',0,-h*0.08);
  ctx.font=Math.round(h*0.14)+'px ui-sans-serif,system-ui,sans-serif';
  ctx.fillStyle='#4A4E55';
  ctx.fillText(st.mat.title+' · '+PHASE_NAME[st.phase],0,h*0.26);
  ctx.restore();
  if(it.props&&it.props.started)paintHeatingGraph(ctx,it,st);
}
/** Мини-график t(τ) рядом с телом — та самая картинка из учебника
    (наклон — нагрев, плато — фазовый переход). История точек — только у
    этого зрителя в памяти вкладки: не синхронизируем сам график, только
    итоговую энергию, из которой в любой момент можно посчитать текущую
    температуру заново — новый участник увидит верную температуру сразу,
    а сам график начнёт рисовать с момента, как открыл доску. */
function paintHeatingGraph(ctx,it,st){
  const hist=thermalHistory.get(it.id);
  if(!hist||hist.length<2)return;
  const gw=Math.max(140,it.w*1.6),gh=70;
  const gx=it.x+it.w/2-gw/2,gy=it.y+it.h+14;
  ctx.save();
  ctx.fillStyle='rgba(247,245,240,.95)';ctx.strokeStyle='rgba(26,28,32,.2)';ctx.lineWidth=1;
  ctx.beginPath();ctx.roundRect(gx,gy,gw,gh,6);ctx.fill();ctx.stroke();
  let tMin=hist[0].t,tMax=hist[hist.length-1].t,vMin=hist[0].temp,vMax=hist[0].temp;
  for(const p of hist){if(p.temp<vMin)vMin=p.temp;if(p.temp>vMax)vMax=p.temp;}
  if(vMax-vMin<1){vMax+=1;vMin-=1;}
  if(tMax-tMin<1)tMax=tMin+1;
  const pad=8,px=t=>gx+pad+(t-tMin)/(tMax-tMin)*(gw-pad*2),
        py=v=>gy+gh-pad-(v-vMin)/(vMax-vMin)*(gh-pad*2);
  ctx.strokeStyle='#D8433A';ctx.lineWidth=1.6;ctx.beginPath();
  hist.forEach((p,i)=>{const x=px(p.t),y=py(p.temp);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.stroke();
  ctx.fillStyle='#8C9199';ctx.font='9px ui-monospace,monospace';ctx.textAlign='left';ctx.textBaseline='alphabetic';
  ctx.fillText('τ, с',gx+gw-22,gy+gh-2);
  ctx.restore();
}
function paintCalorimeter(ctx,it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,w=it.w,h=it.h;
  const inside=items.filter(o=>o.type==='physics'&&o.kind==='body'&&
    o.x+o.w/2>it.x&&o.x+o.w/2<it.x+it.w&&o.y+o.h/2>it.y&&o.y+o.h/2<it.y+it.h);
  ctx.save();
  ctx.fillStyle='rgba(180,190,200,.25)';ctx.strokeStyle='#8C9199';ctx.lineWidth=2;
  ctx.beginPath();ctx.roundRect(it.x,it.y,w,h,10);ctx.fill();ctx.stroke();
  ctx.fillStyle='#4A4E55';ctx.font='600 12px ui-sans-serif,system-ui,sans-serif';
  ctx.textAlign='center';ctx.textBaseline='top';
  ctx.fillText('Калориметр',cx,it.y+6);
  if(inside.length<2){
    ctx.font='11px ui-sans-serif,system-ui,sans-serif';ctx.fillStyle='#8C9199';
    ctx.fillText('перетащите сюда два тела',cx,cy-6);
  }else{
    // равновесная температура смеси — по сохранению энергии, теплоёмкость
    // берём под текущую фазу каждого тела (жидкость/пар/твёрдое), а не
    // всегда одну и ту же: тело, ещё не растаявшее, греет иначе, чем вода
    let num=0,den=0;
    for(const b of inside){
      const st=bodyState(b);
      const c=st.phase==='gas'?(st.mat.cGas||st.mat.cSolid)
        :(st.phase==='liquid'||st.phase==='boiling')?(st.mat.cLiquid||st.mat.cSolid)
        :st.mat.cSolid;
      num+=st.mass*c*st.temp; den+=st.mass*c;
    }
    const tEq=den>0?num/den:0;
    ctx.font='600 20px ui-sans-serif,system-ui,sans-serif';ctx.fillStyle='#1A1C20';
    ctx.fillText(tEq.toFixed(1)+'°C',cx,cy-14);
    ctx.font='11px ui-sans-serif,system-ui,sans-serif';ctx.fillStyle='#8C9199';
    ctx.fillText('температура смеси ('+inside.length+' тел.)',cx,cy+12);
  }
  ctx.restore();
}


/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули здесь ссылаются друг на друга
   кольцами (сеть ↔ интерфейс ↔ ввод), а при кольцах порядок выполнения
   задаёт граф импортов, а не список в точке входа: тело toolbar.js
   успевало выполниться раньше shapes.js и обращалось к его const до
   инициализации. Объявления от порядка не страдают — функции подняты, а
   их тела выполняются уже потом, — страдали только эти строки. Теперь их
   зовёт main.js, в исходном порядке и уже после того, как все модули
   вычислены. */
export function __init() {
setInterval(thermalTick,400);

}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  compassAngle, paintBody, paintCalorimeter, paintFieldLines, paintHeater, paintLens,
  paintMirror, paintSource,
};
