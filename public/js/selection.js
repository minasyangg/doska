/* что сейчас выделено, что тянут и что рисуют */

import { S, byId, items, stage, toScreen } from './core.js';
import { ARC_TYPES, BOX_TYPES, SELECTABLE, arcPt, arcSweep, bboxOf, rotAround } from './geometry.js';
import { graphAxisLabelPos, graphPointY } from './graph.js';
import { hitTest } from './text.js';
import { drawLive } from './render.js';
import { updatePhysicsPanel } from './input.js';

let current=null,drawId=null,lastPt=null,lastT=0,pressure=0.45,lastPen=0;
const pointers=new Map();
let pinch=null,panning=null,spaceDown=false,erasing=null,erasedBatch=[];
/* selection — что выделено (0, 1 или много объектов), selected — тот самый
   единственный, если он один. Ручки поворота и растяжения показываются только
   для одиночного выделения: у группы осмысленны перенос, удаление, копия и
   смена стиля, а не ресайз общей рамки. */
let selection=[];
let selected=null,dragging=null,seqNo=0,shapeDraft=null,pathDraft=null,marquee=null;
/* Начатая дуга: центр ставится нажатием, радиус и начальный угол берутся с
   первым же движением, дальше палец обводит — как настоящим циркулем. */
let arcDraft=null;

const newId=()=>(S.me?S.me.id:'x')+'-'+(++seqNo)+'-'+Date.now().toString(36).slice(-4);
const localXY=e=>{const r=stage.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
// Зеркало серверной проверки: владельца замок доски не касается, наблюдателю
// нельзя ничего. Сервер всё равно решает сам — здесь только чтобы не давать
// человеку рисовать то, что через секунду отвалится.
const canEdit=()=>S.cap==='owner'||(S.cap==='edit'&&!S.locked);
const eraserR=()=>(11+S.size*0.9)/S.cam.z;
// by хранит идентификатор человека, а не сокета, — поэтому своё остаётся своим
// и после переподключения
const mineOnly=it=>S.cap==='owner'||S.anyEdit||!it.by||(S.me&&it.by===S.me.uid);

function selectMany(list){
  // объект мог быть стёрт другим участником, пока лежал в выделении
  selection=list.filter(it=>it&&byId.has(it.id));
  selected=selection.length===1?selection[0]:null;
  refreshSelBar();
  updatePhysicsPanel();          // список формул графика открыт, пока график выделен
  drawLive();
}
function select(it){ selectMany(it?[it]:[]); }
/** Общая рамка выделения — по ней рисуется группа и ставится панель действий. */
function selectionBox(){
  const b={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
  for(const it of selection){
    const q=bboxOf(it);
    b.x0=Math.min(b.x0,q.x0);b.y0=Math.min(b.y0,q.y0);
    b.x1=Math.max(b.x1,q.x1);b.y1=Math.max(b.y1,q.y1);
  }
  return b;
}
function refreshSelBar(){
  const bar=document.getElementById('selbar');
  // Пока объект тащат, тянут за ручку или поворачивают, панель убирается: она
  // висит над рамкой и в жесте только мешает — закрывает то, что двигают, и
  // подсовывает корзину под руку.
  const busy=!!dragging||!!marquee;
  bar.classList.toggle('show',selection.length>0&&!busy);
  if(!selection.length||busy)return;
  const b=selectionBox();
  const p=toScreen(b.x0,b.y0);
  bar.style.left=Math.max(8,Math.min(innerWidth-260,p.x))+'px';
  bar.style.top=Math.max(8,p.y-46)+'px';
  updateSelBar();
}
/* Замок открыт или закрыт — по нему и видно состояние, подпись не нужна. */
const LOCK_OPEN='<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.7-1.5"/>';
const LOCK_SHUT='<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>';

function updateSelBar(){
  const lockBtn=document.getElementById('selLock');
  if(!lockBtn||!selection.length)return;
  const allLocked=selection.every(it=>it.locked);
  const icon=lockBtn.querySelector('svg');
  if(icon)icon.innerHTML=allLocked?LOCK_SHUT:LOCK_OPEN;
  lockBtn.title=allLocked?'Разблокировать положение':'Заблокировать положение';
  lockBtn.classList.toggle('on',allLocked);
  const cnt=document.getElementById('selCount');
  cnt.textContent=selection.length>1?selection.length+' объекта':'';
  cnt.classList.toggle('hidden',selection.length<2);
}
/* Область выделения ловит объект, если его рамка пересекается с рамкой
   протяжки, — так же, как в привычных редакторах: попадать точно вокруг
   каждого штриха никто не станет. */
const boxesOverlap=(a,b)=>a.x0<=b.x1&&a.x1>=b.x0&&a.y0<=b.y1&&a.y1>=b.y0;
function itemsIn(rect){
  const out=[];
  for(const it of items){
    if(!SELECTABLE.has(it.type))continue;
    if(!mineOnly(it))continue;
    if(boxesOverlap(bboxOf(it),rect))out.push(it);
  }
  return out;
}
const inSelection=it=>selection.some(s=>s.id===it.id);
function itemAt(w){
  const r=6/S.cam.z; // небольшой экранно-постоянный допуск клика — точки штриха дискретны и могут быть реже, чем палец/клик
  for(let i=items.length-1;i>=0;i--){
    const it=items[i];
    if(!SELECTABLE.has(it.type))continue;
    if(hitTest(it,w,r))return it;
  }
  return null;
}
/* хэндлы выделения в экранных координатах — 4 угла (resize) + 1 rotate-хэндл.
   Для box-семейства углы учитывают it.rot; для точечного (штрихи) —
   углы берутся по bbox, поворот у них не хранится отдельным полем
   (масштаб/поворот сразу применяются к pts), так что здесь всегда 0.
   Заблокированный объект — пустой список: ни двигать, ни крутить, ни ресайзить. */
function handlesFor(it){
  if(!it||it.locked||!SELECTABLE.has(it.type))return[];
  /* У дуги ручек размера нет вовсе: тянуть её за угол значило бы растянуть, а
     растянутая дуга перестаёт быть дугой окружности. Даём ровно то, что
     циркулю и положено, — концы дуги, то есть углы. */
  if(ARC_TYPES.has(it.type)){
    const p0=arcPt(it,it.a0), p1=arcPt(it,it.a0+arcSweep(it));
    const s0=toScreen(p0.x,p0.y), s1=toScreen(p1.x,p1.y);
    return [{name:'a0',kind:'angle',end:0,sx:s0.x,sy:s0.y},
            {name:'a1',kind:'angle',end:1,sx:s1.x,sy:s1.y}];
  }
  let corners,rot=0;
  if(BOX_TYPES.has(it.type)){
    rot=it.rot||0;
    const cx=it.x+it.w/2,cy=it.y+it.h/2,hw=it.w/2,hh=it.h/2;
    const toW=(lx,ly)=>rotAround(cx+lx,cy+ly,cx,cy,rot);
    corners={nw:toW(-hw,-hh),ne:toW(hw,-hh),sw:toW(-hw,hh),se:toW(hw,hh)};
  }else{
    const b=bboxOf(it);
    corners={nw:{x:b.x0,y:b.y0},ne:{x:b.x1,y:b.y0},sw:{x:b.x0,y:b.y1},se:{x:b.x1,y:b.y1}};
  }
  const s={};for(const k in corners)s[k]=toScreen(corners[k].x,corners[k].y);
  const handles=[
    {name:'nw',kind:'corner',sx:s.nw.x,sy:s.nw.y},{name:'ne',kind:'corner',sx:s.ne.x,sy:s.ne.y},
    {name:'sw',kind:'corner',sx:s.sw.x,sy:s.sw.y},{name:'se',kind:'corner',sx:s.se.x,sy:s.se.y}
  ];
  /* Середины сторон тянут объект по одной оси: угол меняет обе сразу и держит
     пропорции, а вытянуть только вширь ими нельзя. На мелком выделении их не
     показываем — они слиплись бы с углами. */
  const mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const wide=Math.hypot(s.ne.x-s.nw.x,s.ne.y-s.nw.y)>44;
  const tall=Math.hypot(s.sw.x-s.nw.x,s.sw.y-s.nw.y)>44;
  const edges={n:[mid(s.nw,s.ne),wide],s:[mid(s.sw,s.se),wide],
               w:[mid(s.nw,s.sw),tall],e:[mid(s.ne,s.se),tall]};
  for(const name in edges){
    const [p,show]=edges[name];
    if(show)handles.push({name,kind:'edge',sx:p.x,sy:p.y});
  }
  const midW={x:(corners.nw.x+corners.ne.x)/2,y:(corners.nw.y+corners.ne.y)/2};
  const midS=toScreen(midW.x,midW.y);
  const ux=Math.sin(rot),uy=-Math.cos(rot);
  // у графика поворот бессмысленен (координатная плоскость всегда прямая) —
  // ручки вращения у него нет, только обычный ресайз рамки по углам/сторонам
  if(!(it.type==='physics'&&it.kind==='graph'))
    handles.push({name:'rot',kind:'rotate',sx:midS.x+ux*24,sy:midS.y+uy*24});
  // отдельные вершины линии/полигона — редактируются независимо от rotate/resize
  if(it.type==='path'){
    it.pts.forEach((p,i)=>{
      const s=toScreen(p.x,p.y);
      handles.push({name:'v'+i,kind:'vertex',index:i,sx:s.x,sy:s.y});
    });
  }
  // у графика — свои ручки поверх обычных (ресайз/перенос за шапку не
  // трогаем): точки, которые можно перетаскивать, и подписи осей, по
  // которым можно кликнуть, чтобы переименовать
  if(it.type==='physics'&&it.kind==='graph'){
    const view=it.props.view||{cx:0,cy:0,scale:40};
    const gcx=it.x+it.w/2,gcy=it.y+it.h/2;
    const gdeg=it.props.angleMode==='deg', gvars={};
    (it.props.params||[]).forEach(pr=>{gvars[pr.name]=pr.value;});
    (it.props.points||[]).forEach((p,i)=>{
      // для точки на кривой — тот же пересчитанный y, что и на отрисовке:
      // иначе ручка (и хват мышью) отставала бы от видимой точки, стоило
      // подвинуть точку по x или поправить саму формулу
      const py=graphPointY(it,p,gvars,gdeg);
      if(!Number.isFinite(py))return;
      const wx=gcx+(p.x-view.cx)*view.scale, wy=gcy-(py-view.cy)*view.scale;
      const s=toScreen(wx,wy);
      handles.push({name:'gp'+i,kind:'graphPoint',index:i,sx:s.x,sy:s.y});
    });
    const lbl=graphAxisLabelPos(it);
    const sxl=toScreen(lbl.x.wx,lbl.x.wy), syl=toScreen(lbl.y.wx,lbl.y.wy);
    handles.push({name:'xLabel',kind:'axisLabel',axis:'x',sx:sxl.x,sy:sxl.y});
    handles.push({name:'yLabel',kind:'axisLabel',axis:'y',sx:syl.x,sy:syl.y});
  }
  return handles;
}
function handleAt(sp){
  if(!selected)return null;
  for(const h of handlesFor(selected)){
    // подпись оси — не точка, а флажок с текстом переменной длины (имя
    // можно переименовать хоть в «Скорость»); девяти экранных пикселей
    // хватает на угол ручки, но не на весь флажок — тут допуск щедрее
    const tol=h.kind==='axisLabel'?24:9;
    if(Math.abs(sp.x-h.sx)<tol&&Math.abs(sp.y-h.sy)<tol)return h;
  }
  return null;
}
/** Перенос выделенного — одного объекта или всей группы одним жестом. */
function angleAt(a,b,c){
  const a1=Math.atan2(a.y-b.y,a.x-b.x),a2=Math.atan2(c.y-b.y,c.x-b.x);
  let deg=Math.abs(a1-a2)*180/Math.PI;if(deg>180)deg=360-deg;
  return deg;
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
  angleAt, arcDraft, canEdit, current, dragging, drawId, erasedBatch, eraserR, erasing,
  handleAt, handlesFor, inSelection, itemAt, itemsIn, lastPen, lastPt, lastT, localXY, marquee,
  mineOnly, newId, panning, pathDraft, pinch, pointers, pressure, refreshSelBar, select,
  selectMany, selected, selection, selectionBox, shapeDraft, spaceDown, updateSelBar,
};
