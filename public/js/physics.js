/* магнит, оптика */

import { items } from './core.js';
import { drawArrowhead } from './shapes.js';

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

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  compassAngle, paintFieldLines, paintLens, paintMirror, paintSource,
};
