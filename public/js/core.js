/* состояние доски, обращения к серверу, движок линии */

const store={
  get(k){try{return localStorage.getItem(k);}catch{return null;}},
  set(k,v){try{localStorage.setItem(k,v);}catch{}},
};
/* Токенов в браузере больше нет: аутентификация — httpOnly-кука, выданная
   сервером доски. Из JS её не достать и не потерять, поэтому запросам нужно
   ровно одно — ходить на свой origin. */
async function api(path,{method='GET',body}={}){
  const r=await fetch('/api'+path,{method,credentials:'same-origin',
    headers:body!==undefined?{'content-type':'application/json'}:undefined,
    body:body!==undefined?JSON.stringify(body):undefined});
  if(r.status===204)return null;
  const data=await r.json().catch(()=>({error:'сервер ответил не по-человечески'}));
  if(!r.ok){const e=new Error(data.error||('ошибка '+r.status));e.status=r.status;throw e;}
  return data;
}
/* Стабильный идентификатор гостя — на нём держится «стереть своё» у того,
   у кого нет аккаунта. Живёт в localStorage, потому что должен переживать
   закрытие вкладки: иначе после перезахода гость теряет свои же штрихи. */
/* Свой постоянный номер гостя: по нему сервер узнаёт того же человека, если он
   перезашёл. Раньше здесь звалась rnd() — она живёт на сервере, и в браузере
   этой строки просто не существовало. Вылезало только у гостя: у вошедших
   номер берётся из учётной записи, и до сюда дело не доходило. */
function guestId(){
  let g=store.get('doska.guest');
  if(!g||!/^[A-Za-z0-9_-]{8,32}$/.test(g)){
    const a=new Uint8Array(12);crypto.getRandomValues(a);
    g=btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    store.set('doska.guest',g);
  }
  return g;
}

/* ═══════════════════ движок линии ═══════════════════ */
const PAPER='#F7F5F0';
const PENS=['#1A1C20','#24468C','#B3322B','#2E6B47','#6B3FA0'];
const MARKERS=['#F2D33C','#7ED9C4','#F79BB0','#9DC5F5','#C9E36B'];
const FILLS=[null,'#F2D33C','#7ED9C4','#F79BB0','#9DC5F5','#C9E36B'];
const STREAMLINE=0.42;
const STYLED=new Set(['pen','marker','shape','path','text','arc']);

const stage=document.getElementById('stage');
const board=document.getElementById('board'), live=document.getElementById('live');
const bctx=board.getContext('2d'), lctx=live.getContext('2d');
let dpr=Math.min(devicePixelRatio||1,2.5);

const GRID_MODES=['grid','dots','lines','none'];
const GRID_NAMES={grid:'клетка',dots:'точки',lines:'линейка',none:'чистый лист'};

const S={tool:'pen',size:4,color:PENS[0],penColor:PENS[0],markerColor:MARKERS[0],
  cam:{x:0,y:0,z:1},grid:store.get('doska.grid')||'grid',
  // панель инструментов: закреплена или прячется у края
  dockPinned:store.get('doska.dockPinned')!=='0',
  // насколько скорость руки меняет толщину линии: 1 — как было всегда, 0 — ровная
  sens:(()=>{const v=parseFloat(store.get('doska.sens'));return Number.isFinite(v)?Math.min(1,Math.max(0,v)):1;})(),
  // насколько точно линия идёт за указателем: 1 — след в след, ниже — мягче
  follow:(()=>{const v=parseFloat(store.get('doska.follow'));
    return Number.isFinite(v)?Math.min(1,Math.max(0.12,v)):1-STREAMLINE;})(),
  // cap — что мне можно на этой доске: owner | edit | view | none
  locked:false,cap:'none',anyEdit:false,me:null,you:null,following:false,
  boardId:null,name:store.get('doska.name')||'',
  shapeKind:'rect',fill:null,dash:0,pathKind:'line',a1:0,a2:0,
  // выбран ли физический пресет (транспортир/линейка/вектор) для инструмента «линия»
  physicsPreset:null,
  // какой объект-симуляцию ставит инструмент «physics» (магнит/компас/…)
  physicsKind:null,
  // черновик физ.свойств объекта — настраивается в physicsPanel ДО того, как
  // объект появится на доске (клик по холсту ставит его уже с этими
  // значениями); хранится по kind, чтобы настройки одного вида не сбивали
  // другой
  physicsProps:{
    magnet:{strength:1,showField:true},
    'light-source':{rayCount:5,spreadDeg:16},
    lens:{focal:140},
    heater:{power:500},
    body:{material:'water',mass:0.1},
  },
  // знак фокусного расстояния линзы — задаётся выбором инструмента
  // (Собирающая/Рассеивающая), а не самой панелью: там правится только
  // модуль, чтобы переключатель не путался с ползунком
  physicsSign:1,
  // настройки инструмента открываются по требованию и закрыты при загрузке
  panelOpen:false};

let items=[];                       // всё содержимое доски (линии и картинки)
const byId=new Map();
let undoStack=[], redoStack=[];
/* Потолок истории отмен.

   Записи копились без всякой границы. Для стирания запись держит ЦЕЛЫЕ
   объекты со всеми точками — то есть стёртое с доски продолжало занимать
   память до перезагрузки страницы, и за длинный урок с парой массовых стираний
   это набегало вполне заметно на планшете ученика.

   Двести шагов заведомо больше того, на сколько возвращаются руками; глубже
   всё равно проще стереть и написать заново. Стек отмен ограничивает и стек
   возврата: тот пополняется только из него. */
const UNDO_MAX=200;
function recordUndo(op){
  undoStack.push(op);
  if(undoStack.length>UNDO_MAX)undoStack.shift();
}

const toWorld=(sx,sy)=>({x:(sx-S.cam.x)/S.cam.z, y:(sy-S.cam.y)/S.cam.z});
const toScreen=(wx,wy)=>({x:wx*S.cam.z+S.cam.x, y:wy*S.cam.z+S.cam.y});

const mkStroke=(type,color,size,id,by)=>({id,by,type,color,size,pts:[],bbox:null,g:null,locked:false});

/* Линия тянется за указателем не мгновенно: каждая новая точка ставится не
   там, где мышь, а на доле пути к ней. Это гасит дрожание руки — мышью иначе
   получается «пила». Доля и есть чувствительность: на единице линия идёт точно
   за указателем и повторяет каждое подрагивание, ниже — мягче и спокойнее.

   STREAMLINE осталась значением по умолчанию для тех, кто ничего не трогал. */
function pushPoint(s,wx,wy,p){
  const pts=s.pts;
  if(!pts.length){pts.push({x:wx,y:wy,p});return true;}
  const last=pts[pts.length-1], t=S.follow;
  const nx=last.x+(wx-last.x)*t, ny=last.y+(wy-last.y)*t;
  if(Math.hypot(nx-last.x,ny-last.y)<0.35/S.cam.z){last.p=last.p*0.7+p*0.3;return false;}
  pts.push({x:nx,y:ny,p});return true;
}
/* Нажим у мыши и пальца взять неоткуда, поэтому он выводится из скорости:
   ведёшь быстро — линия тоньше. Насколько сильно — настраивается.

   При S.sens=1 получается ровно то, что было раньше (порог 0.28, шкала 2.4).
   Ниже — отклик слабее, на нуле линия совсем ровная: кому-то так спокойнее,
   особенно когда пишут мышью, а не пером. */
const simPressure=(prev,speed)=>{
  const s=S.sens;
  if(s<=0)return 1;
  const target=Math.max(1-0.72*s,Math.min(1,1-speed*s/2.4));
  return prev+(target-prev)*0.22;
};

function radii(s){
  const pts=s.pts,n=pts.length,half=s.size/2,thin=s.type==='marker'?0:0.62;
  const cum=new Float64Array(n);
  for(let i=1;i<n;i++)cum[i]=cum[i-1]+Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y);
  const total=cum[n-1]||0, r=new Float64Array(n);
  const taper=s.type==='marker'?0:Math.min(s.size*1.6,total*0.28);
  const ease=t=>Math.sin(Math.min(1,Math.max(0,t))*Math.PI/2);
  for(let i=0;i<n;i++){
    let v=half*(1-thin+thin*pts[i].p);
    if(taper>0.001){const a=ease(cum[i]/taper),b=ease((total-cum[i])/taper);v*=(0.3+0.7*a)*(0.3+0.7*b);}
    r[i]=v;
  }
  for(let k=0;k<2;k++){const c=r.slice();for(let i=1;i<n-1;i++)r[i]=(c[i-1]+2*c[i]+c[i+1])/4;}
  return r;
}
function trace(ctx,p,move){
  if(!p.length)return;
  move?ctx.moveTo(p[0].x,p[0].y):ctx.lineTo(p[0].x,p[0].y);
  for(let i=1;i<p.length-1;i++)ctx.quadraticCurveTo(p[i].x,p[i].y,(p[i].x+p[i+1].x)/2,(p[i].y+p[i+1].y)/2);
  if(p.length>1)ctx.lineTo(p[p.length-1].x,p[p.length-1].y);
}
function outlinePath(ctx,s){
  const pts=s.pts,n=pts.length; if(!n)return;
  const r=radii(s);
  if(n===1||(n===2&&Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y)<0.1)){
    ctx.beginPath();ctx.arc(pts[0].x,pts[0].y,Math.max(r[0],s.size*0.28),0,6.2832);return;
  }
  const L=[],R=[];
  for(let i=0;i<n;i++){
    const a=pts[Math.max(0,i-1)],b=pts[Math.min(n-1,i+1)];
    let tx=b.x-a.x,ty=b.y-a.y; const len=Math.hypot(tx,ty)||1; tx/=len;ty/=len;
    const nx=-ty,ny=tx;
    L.push({x:pts[i].x+nx*r[i],y:pts[i].y+ny*r[i]});
    R.push({x:pts[i].x-nx*r[i],y:pts[i].y-ny*r[i]});
  }
  const dir=(i0,i1)=>{const dx=pts[i1].x-pts[i0].x,dy=pts[i1].y-pts[i0].y,l=Math.hypot(dx,dy)||1;return{x:dx/l,y:dy/l};};
  const tE=dir(n-2,n-1),tS=dir(0,1);
  const nE={x:-tE.y,y:tE.x},nS={x:-tS.y,y:tS.x};
  ctx.beginPath();
  trace(ctx,L,true);
  ctx.arc(pts[n-1].x,pts[n-1].y,r[n-1],Math.atan2(nE.y,nE.x),Math.atan2(-nE.y,-nE.x),true);
  trace(ctx,R.slice().reverse(),false);
  ctx.arc(pts[0].x,pts[0].y,r[0],Math.atan2(-nS.y,-nS.x),Math.atan2(nS.y,nS.x),true);
  ctx.closePath();
}
function paintStroke(ctx,s){
  ctx.save();
  if(s.type==='marker'){ctx.globalAlpha=0.42;ctx.globalCompositeOperation='multiply';}
  ctx.fillStyle=s.color; outlinePath(ctx,s); ctx.fill(); ctx.restore();
}

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
'use strict';

/* ═══════════════════ хранилище и API ═══════════════════ */
}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  FILLS, GRID_MODES, GRID_NAMES, PAPER, PENS, S, STYLED, api, bctx, board, byId, dpr, guestId,
  items, lctx, live, mkStroke, outlinePath, paintStroke, pushPoint, recordUndo, redoStack,
  simPressure, stage, store, toScreen, toWorld, trace, undoStack,
};
