/* модели: маятники, волна, цилиндр с поршнем */

import { S, board, items, toWorld } from './core.js';
import { bboxOf } from './geometry.js';
import { drawArrowhead } from './shapes.js';
import { hint } from './shell.js';
import { canEdit, selected } from './selection.js';
import { drawBoard } from './render.js';
import { net } from './net.js';
import { bodyField, bodyHeating, bodyInit, bodyReset, bodyTempMax, materialOptions, mixBusy, mixField, mixInit, mixToggle,
         paintBody, paintCalorimeter, paintHeater } from './thermal.js';

/* ═══ модели разделов «Механика» и «Тепловые явления» ═══
   Тот же тип items 'physics', что у магнита и линз, но здесь у объекта есть
   настоящее движение, а смотрят на него сразу несколько человек. Учитель
   говорит «смотрите, груз в крайней точке» — и у ученика он должен быть там
   же. Слать положение по сети тридцать раз в секунду незачем: у колебаний
   всё будущее задано одним числом.

   Поэтому в props лежит не положение, а фаза ph в момент at (часы сервера) и
   признак run: текущая фаза считается у каждого сама — ph+ω(сейчас−at). По
   сети идут только правки, а вошедший посреди урока сразу видит то же, что
   все. Часы именно серверные: на школьных устройствах свои уходят на секунды,
   поправку даёт 'init' (см. S.clock). Правка параметра сначала фиксирует
   текущую фазу и уже потом меняет ω — иначе груз скакал бы при каждом
   движении ползунка: при новом ω та же разность времён даёт другую фазу.

   Настройки — как у графика: до постановки настраивать нечего, ползунки
   появляются, когда модель выделена, и правят сам объект. Выделить её может
   только тот, кому можно править, остальные просто смотрят.

   Числа в fields — зеркало MODEL_RANGES в server.js. */
const G=9.8, GAS_R=8.31;
const PISTON_S=0.01;                 // площадь поршня, м² (100 см²)
const CYL_H=1, CYL_MIN=0.05;         // верхний и нижний упоры поршня, м
const PISTON_EASE=0.35;              // за сколько секунд поршень проходит большую часть пути
const LEN_MAX=2.5, AMP_MAX=30;       // по ним маятник вписан в рамку
const SPRING_AMP_MAX=10;
const WAVE_SPAN=6;                   // сколько метров среды видно в рамке

const MODELS={
  /* Формула T=2π√(l/g) и гармоническое движение верны для малых углов,
     поэтому амплитуда ограничена 30°: там настоящий период длиннее всего на
     1,7%, а показанное T совпадает с тем, что видно на доске. */
  pendulum:{paint:paintPendulum,init:clockInit,omega:p=>Math.sqrt(p.g/p.len),fields:[
    {key:'len',label:'Длина нити',unit:'м',min:0.2,max:LEN_MAX,step:0.05,def:1,d:2},
    {key:'g',label:'Ускорение свободного падения',unit:'м/с²',min:1.6,max:25,step:0.1,def:G,d:1},
    {key:'amp',label:'Амплитуда',unit:'°',min:1,max:AMP_MAX,step:1,def:15,d:0},
    {key:'mass',label:'Масса груза',unit:'кг',min:0.1,max:2,step:0.1,def:0.5,d:1},
  ]},
  spring:{paint:paintSpring,init:clockInit,omega:p=>Math.sqrt(p.k/p.mass),fields:[
    {key:'k',label:'Жёсткость',unit:'Н/м',min:5,max:200,step:1,def:20,d:0},
    {key:'mass',label:'Масса груза',unit:'кг',min:0.05,max:2,step:0.05,def:0.5,d:2},
    {key:'amp',label:'Амплитуда',unit:'см',min:1,max:SPRING_AMP_MAX,step:0.5,def:5,d:1},
  ]},
  wave:{paint:paintWave,init:clockInit,omega:p=>2*Math.PI/p.period,fields:[
    {key:'lambda',label:'Длина волны',unit:'м',min:0.5,max:3,step:0.1,def:2,d:1},
    {key:'period',label:'Период',unit:'с',min:0.5,max:5,step:0.1,def:2,d:1},
    {key:'amp',label:'Амплитуда',unit:'м',min:0.1,max:1,step:0.05,def:0.5,d:2},
  ]},
  cylinder:{paint:paintCylinder,init:cylinderInit,fields:[
    {key:'T',label:'Температура',unit:'К',min:100,max:1000,step:5,def:300,d:0},
    {key:'n',label:'Количество газа',unit:'моль',min:0.05,max:1,step:0.01,def:0.2,d:2},
    {key:'mass',label:'Масса поршня',unit:'кг',min:0,max:50,step:1,def:0,d:0,zero:'0 кг (невесомый)'},
    {key:'fric',label:'Сила трения',unit:'Н',min:0,max:500,step:10,def:0,d:0,zero:'0 Н (без трения)'},
    {key:'p0',label:'Давление снаружи',unit:'кПа',min:0,max:200,step:5,def:100,d:0},
    {key:'h',label:'Высота поршня',unit:'м',min:CYL_MIN,max:CYL_H,step:0.01,def:0.5,d:2,when:p=>p.fixed},
  ]},
  heater:{paint:paintHeater,init:p=>{p.on=false;},toggle:p=>{p.on=!p.on;},
    runLabel:p=>p.on?'⏹ Выключить':'🔥 Включить',fields:[
    {key:'power',label:'Мощность',unit:'Вт',min:50,max:5000,step:50,def:500,d:0},
  ]},
  body:{paint:paintBody,init:bodyInit,busy:bodyHeating,reset:bodyReset,onField:bodyField,fields:[
    {key:'material',label:'Вещество',options:materialOptions,def:'water'},
    {key:'mass',label:'Масса',unit:'г',k:1000,min:10,max:1000,step:10,def:0.1,d:0},
    {key:'t0',label:'Начальная температура',unit:'°C',min:-30,max:bodyTempMax,step:1,def:-10,d:0},
  ]},
  calorimeter:{paint:paintCalorimeter,init:mixInit,busy:mixBusy,toggle:mixToggle,onField:mixField,
    runLabel:p=>p.run?'⟲ Разделить заново':'▶ Смешать',fields:[
    {key:'mat1',label:'Вещество 1',options:materialOptions,def:'water'},
    {key:'m1',label:'Масса 1',unit:'г',min:10,max:1000,step:10,def:200,d:0},
    {key:'t1',label:'Температура 1',unit:'°C',min:-30,max:500,step:1,def:20,d:0},
    {key:'mat2',label:'Вещество 2',options:materialOptions,def:'copper'},
    {key:'m2',label:'Масса 2',unit:'г',min:10,max:1000,step:10,def:100,d:0},
    {key:'t2',label:'Температура 2',unit:'°C',min:-30,max:500,step:1,def:100,d:0},
  ]},
};

function modelDefaults(kind){
  const m=MODELS[kind],p={};
  for(const f of m.fields)p[f.key]=f.def;
  m.init(p);
  return p;
}
function clockInit(p){ p.run=false;p.ph=0;p.at=0; }
function cylinderInit(p){ p.fixed=false;p.h=pistonRest(p); }
const serverNow=()=>Date.now()+S.clock;
function modelPhase(it){
  const p=it.props;
  return p.run?p.ph+MODELS[it.kind].omega(p)*(serverNow()-p.at)/1000:p.ph;
}
/* Где поршень остановится. Газ давит на него с силой pS=νRT/h, вниз давят
   атмосфера и вес. Трение держит поршень, пока разность этих сил не больше
   Fтр, — то есть для него годится не одна высота, а целый отрезок [lo,hi].
   Внутри отрезка поршень стоит, снаружи доходит до ближайшего края: нагрели
   чуть-чуть — не сдвинулся, нагрели сильнее — пошёл. Без трения отрезок
   сжимается в точку, это обычный изобарный процесс.

   Считается один раз при правке, и в props уходит уже итог. Положение зависит
   от прошлого: если бы каждый участник считал его по своему плавному ходу,
   поршень у всех остановился бы в разных местах. */
function pistonRest(p){
  if(p.fixed)return p.h;
  const gas=p.n*GAS_R*p.T, load=pistonLoad(p);
  const lo=gas/(load+p.fric), hi=load>p.fric?gas/(load-p.fric):Infinity;
  return Math.min(CYL_H,Math.max(CYL_MIN,Math.min(hi,Math.max(lo,p.h))));
}
const pistonLoad=p=>p.p0*1000*PISTON_S+p.mass*G;
function pistonState(p,shown){
  if(Math.abs(shown-p.h)>0.002)return 'движется';
  if(p.fixed)return 'закреплён';
  const diff=p.n*GAS_R*p.T/p.h-pistonLoad(p);
  if(p.h>=CYL_H&&diff>p.fric)return 'на верхнем упоре';
  if(p.h<=CYL_MIN&&-diff>p.fric)return 'на нижнем упоре';
  return Math.abs(diff)>0.5?'держит трение':'в равновесии';
}

/* Одна точка, через которую идёт любая правка модели. */
function modelEdit(it,change){
  if(!canEdit()||it.locked){
    hint(it.locked?'Объект заблокирован: снимите замок':'Преподаватель закрыл доску для правок');
    syncModelPanel(it);
    return;
  }
  // новый объект, а не правка на месте: вставленная копия делит props с
  // оригиналом (см. pasteClipboard), и сдвинулись бы обе модели сразу
  const p={...it.props};
  if(MODELS[it.kind].omega){p.ph=modelPhase(it)%(2*Math.PI);p.at=serverNow();}
  change(p);
  if(it.kind==='cylinder')p.h=pistonRest(p);
  it.props=p;
  net.send({t:'move',id:it.id,props:{...p}});
  syncModelPanel(it);
  drawBoard();
}

/* Движение есть только у запущенной модели и у едущего поршня. Перерисовка
   здесь — вся доска, как при панорамировании, поэтому только пока такая
   модель на экране: забытый за краем маятник не должен сажать планшет.
   Плавный ход поршня живёт в it._h, у каждого свой: это лишь показ, а
   настоящая высота уже лежит в props. */
let tickAt=performance.now();
function modelTick(){
  const now=performance.now(),dt=Math.min(0.1,(now-tickAt)/1000);
  tickAt=now;
  if(!S.boardId)return;
  const a=toWorld(0,0),b=toWorld(board.clientWidth,board.clientHeight);
  let moving=false;
  for(const it of items){
    if(it.type!=='physics'||!MODELS[it.kind])continue;
    const busy=MODELS[it.kind].busy;
    let active=busy?busy(it):it.props.run;
    if(it.kind==='cylinder'&&it._h!=null&&it._h!==it.props.h){
      const d=it.props.h-it._h;
      it._h=Math.abs(d)<0.001?it.props.h:it._h+d*(1-Math.exp(-dt/PISTON_EASE));
      active=true;
    }
    if(!active)continue;
    const q=it.bbox||(it.bbox=bboxOf(it));
    if(q.x1>=a.x&&q.x0<=b.x&&q.y1>=a.y&&q.y0<=b.y)moving=true;
  }
  if(moving)drawBoard();
}

/* ── отрисовка ──────────────────────────────────────────────────
   Значения подписаны прямо на модели, а не только на панели: панель видит
   один человек, а смотрят на доску все. */
const num=(v,d)=>v.toFixed(d).replace('.',',');
const fontSize=it=>Math.max(7,Math.min(14,Math.min(it.w,it.h)*0.05));
const captionH=(it,n,fs=fontSize(it))=>fs*1.35*n+12;
function caption(ctx,it,lines,fs=fontSize(it)){
  ctx.fillStyle='#1A1C20';ctx.textAlign='left';ctx.textBaseline='alphabetic';
  ctx.font=fs+'px ui-sans-serif,system-ui,sans-serif';
  lines.forEach((t,i)=>ctx.fillText(t,-it.w/2+10,it.h/2-8-(lines.length-1-i)*fs*1.35));
}
function dashed(ctx,draw){
  ctx.save();
  ctx.strokeStyle='rgba(26,28,32,.32)';ctx.lineWidth=1;ctx.setLineDash([4,4]);
  ctx.beginPath();draw();ctx.stroke();
  ctx.restore();
}
function ceiling(ctx,y,half){
  ctx.strokeStyle='#8C9199';ctx.lineWidth=2;
  ctx.beginPath();ctx.moveTo(-half,y);ctx.lineTo(half,y);
  ctx.lineWidth=1.2;
  for(let x=-half+4;x<=half;x+=9){ctx.moveTo(x,y);ctx.lineTo(x-5,y-6);}
  ctx.stroke();
}
function paintModel(ctx,it){
  ctx.save();
  ctx.translate(it.x+it.w/2,it.y+it.h/2);ctx.rotate(it.rot||0);
  ctx.fillStyle='rgba(255,255,255,.55)';ctx.strokeStyle='rgba(26,28,32,.16)';ctx.lineWidth=1;
  ctx.beginPath();ctx.roundRect(-it.w/2,-it.h/2,it.w,it.h,8);ctx.fill();ctx.stroke();
  MODELS[it.kind].paint(ctx,it);
  ctx.restore();
}
function paintPendulum(ctx,it){
  const p=it.props,w=it.w,h=it.h;
  const T=2*Math.PI/MODELS.pendulum.omega(p);
  const lines=['l = '+num(p.len,2)+' м,  g = '+num(p.g,1)+' м/с²,  m = '+num(p.mass,1)+' кг',
               'T = 2π√(l/g) = '+num(T,2)+' с,  ν = '+num(1/T,2)+' Гц'];
  const top=-h/2+14,r=Math.min(w,h)*0.035*Math.cbrt(p.mass/0.5);
  const room=h-14-captionH(it,lines.length)-r-6;
  // рамку можно сжать меньше подписей; отрицательный радиус ctx.arc не примет,
  // а исключение здесь остановило бы отрисовку всей доски
  const sc=Math.max(0,Math.min(room/LEN_MAX,(w/2-r-6)/(LEN_MAX*Math.sin(AMP_MAX*Math.PI/180))));
  const L=p.len*sc,amp=p.amp*Math.PI/180,a=amp*Math.cos(modelPhase(it));
  const bx=Math.sin(a)*L,by=top+Math.cos(a)*L;
  ceiling(ctx,top,Math.min(w*0.22,40));
  dashed(ctx,()=>{ctx.moveTo(0,top);ctx.lineTo(0,top+L+r);});
  dashed(ctx,()=>{ctx.arc(0,top,L,Math.PI/2-amp,Math.PI/2+amp);});
  ctx.strokeStyle='#4A4E55';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.moveTo(0,top);ctx.lineTo(bx,by);ctx.stroke();
  ctx.fillStyle='#2F6FE0';ctx.strokeStyle='rgba(0,0,0,.35)';ctx.lineWidth=1.2;
  ctx.beginPath();ctx.arc(bx,by,r,0,6.2832);ctx.fill();ctx.stroke();
  caption(ctx,it,lines);
}
function paintSpring(ctx,it){
  const p=it.props,w=it.w,h=it.h;
  const T=2*Math.PI/MODELS.spring.omega(p);
  const lines=['k = '+num(p.k,0)+' Н/м,  m = '+num(p.mass,2)+' кг,  A = '+num(p.amp,1)+' см',
               'T = 2π√(m/k) = '+num(T,2)+' с,  ν = '+num(1/T,2)+' Гц'];
  const top=-h/2+14,room=Math.max(0,h-14-captionH(it,lines.length)-8);
  const eq=top+room*0.56,sc=room*0.3/SPRING_AMP_MAX;
  const size=room*0.12*Math.cbrt(p.mass/0.5);
  const y=eq+p.amp*Math.cos(modelPhase(it))*sc,end=y-size/2;
  const half=Math.min(w*0.09,16),coils=12;
  ceiling(ctx,top,Math.min(w*0.22,40));
  for(const dy of [-p.amp*sc,p.amp*sc])
    dashed(ctx,()=>{ctx.moveTo(-w*0.2,eq+dy);ctx.lineTo(w*0.2,eq+dy);});
  ctx.strokeStyle='#4A4E55';ctx.lineWidth=1.6;ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(0,top);ctx.lineTo(0,top+6);
  for(let i=0;i<coils;i++)ctx.lineTo(i%2?-half:half,top+6+(end-top-12)*(i+0.5)/coils);
  ctx.lineTo(0,end-6);ctx.lineTo(0,end);ctx.stroke();
  ctx.fillStyle='#2F6FE0';ctx.strokeStyle='rgba(0,0,0,.35)';ctx.lineWidth=1.2;
  ctx.beginPath();ctx.roundRect(-size/2,y-size/2,size,size,3);ctx.fill();ctx.stroke();
  dashed(ctx,()=>{ctx.moveTo(-w*0.36,eq);ctx.lineTo(w*0.36,eq);});
  ctx.fillStyle='#4A4E55';ctx.textAlign='left';ctx.textBaseline='bottom';
  ctx.font=fontSize(it)*0.85+'px ui-sans-serif,system-ui,sans-serif';
  ctx.fillText('x = 0',w*0.26,eq-2);
  caption(ctx,it,lines);
}
/* Волна y=A·cos(ωt−kx) бежит вправо. Частицы среды нарисованы отдельно от
   кривой, а одна — красным: видно, что вдоль волны едет только форма, сама
   частица ходит вверх-вниз на месте. Масштаб по осям один — иначе амплитуда
   на глаз не сравнивалась бы с длиной волны. */
function paintWave(ctx,it){
  const p=it.props,w=it.w,h=it.h,fs=fontSize(it);
  const lines=['λ = '+num(p.lambda,1)+' м,  T = '+num(p.period,1)+' с,  ν = '+num(1/p.period,2)+' Гц,  A = '+num(p.amp,2)+' м',
               'v = λ/T = '+num(p.lambda/p.period,2)+' м/с'];
  const x0=-w/2+14,W=w-28,sc=W/WAVE_SPAN;
  const areaTop=-h/2+8+fs*2.4,areaBot=h/2-captionH(it,lines.length)-18;
  const y0=(areaTop+areaBot)/2,A=Math.max(0,Math.min(p.amp*sc,(areaBot-areaTop)/2));
  const ph=modelPhase(it),k=2*Math.PI/p.lambda;
  const yAt=x=>y0-A*Math.cos(ph-k*x);
  dashed(ctx,()=>{ctx.moveTo(x0,y0);ctx.lineTo(x0+W,y0);});
  ctx.strokeStyle='#2F6FE0';ctx.lineWidth=2;ctx.lineJoin='round';
  ctx.beginPath();
  for(let px=0;px<=W;px+=2){
    const y=yAt(px/sc);
    px?ctx.lineTo(x0+px,y):ctx.moveTo(x0,y);
  }
  ctx.stroke();
  const beads=24,marked=6;
  for(let i=0;i<=beads;i++){
    const x=i/beads*WAVE_SPAN;
    ctx.fillStyle=i===marked?'#D8433A':'#8C9199';
    ctx.beginPath();ctx.arc(x0+x*sc,yAt(x),i===marked?4.5:2.2,0,6.2832);ctx.fill();
  }
  // λ — от гребня до гребня; метка едет вместе с волной
  const c=(ph/k)%p.lambda,xa=x0+c*sc,xb=xa+p.lambda*sc,yb=y0-A-7;
  dashed(ctx,()=>{ctx.moveTo(xa,yb);ctx.lineTo(xa,y0-A);ctx.moveTo(xb,yb);ctx.lineTo(xb,y0-A);});
  ctx.strokeStyle='#1A1C20';ctx.lineWidth=1.2;
  ctx.beginPath();ctx.moveTo(xa,yb);ctx.lineTo(xb,yb);ctx.stroke();
  drawArrowhead(ctx,{x:xb,y:yb},{x:xa,y:yb},2,2,'#1A1C20');
  drawArrowhead(ctx,{x:xa,y:yb},{x:xb,y:yb},2,2,'#1A1C20');
  ctx.fillStyle='#1A1C20';ctx.textAlign='center';ctx.textBaseline='bottom';
  ctx.font='600 '+fs+'px ui-sans-serif,system-ui,sans-serif';
  ctx.fillText('λ',(xa+xb)/2,yb-2);
  // v — куда бежит волна
  const yv=areaBot+12,xv=x0+W;
  ctx.strokeStyle='#D8433A';ctx.lineWidth=1.8;
  ctx.beginPath();ctx.moveTo(xv-46,yv);ctx.lineTo(xv-4,yv);ctx.stroke();
  drawArrowhead(ctx,{x:xv-46,y:yv},{x:xv,y:yv},2,2,'#D8433A');
  ctx.fillStyle='#D8433A';ctx.textAlign='right';ctx.textBaseline='middle';
  ctx.fillText('v',xv-52,yv);
  caption(ctx,it,lines);
}
/* Точки газа только показывают, сколько его и как он сжат: разбросаны одинаково
   у всех, потому что считаются по номеру, а не случайно. */
const scatter=i=>{const s=Math.sin(i*12.9898)*43758.5453;return s-Math.floor(s);};
function paintCylinder(ctx,it){
  const p=it.props,w=it.w,h=it.h,fs=fontSize(it);
  if(it._h==null)it._h=p.h;
  const shown=it._h;
  const press=p.n*GAS_R*p.T/(PISTON_S*shown)/1000,V=PISTON_S*shown*1000;
  const left=-w/2+14,cw=w*0.46,right=left+cw;
  const th=Math.max(8,h*0.03),head=Math.max(26,h*0.14)+th;
  const bottom=h/2-12,top=-h/2+head,sc=(bottom-top)/CYL_H;
  const py=bottom-shown*sc;
  // от холодного синего к горячему красному
  const t=(p.T-100)/900;
  ctx.fillStyle='rgba('+Math.round(120+110*t)+','+Math.round(175-60*t)+','+Math.round(230-120*t)+',.38)';
  ctx.fillRect(left,py,cw,bottom-py);
  ctx.fillStyle='rgba(47,70,110,.7)';
  const dots=Math.round(8+p.n*80);
  for(let i=0;i<dots;i++){
    ctx.beginPath();
    ctx.arc(left+4+scatter(i+1)*(cw-8),bottom-3-scatter(i+501)*(bottom-py-6),1.7,0,6.2832);
    ctx.fill();
  }
  // стенки и упоры
  ctx.strokeStyle='#4A4E55';ctx.lineWidth=3;ctx.lineJoin='miter';
  ctx.beginPath();ctx.moveTo(left,top-th-2);ctx.lineTo(left,bottom);
  ctx.lineTo(right,bottom);ctx.lineTo(right,top-th-2);ctx.stroke();
  ctx.fillStyle='#4A4E55';
  ctx.fillRect(left,top-th-5,7,3);ctx.fillRect(right-7,top-th-5,7,3);
  // поршень; трение — штрихи у стенок, закреплён — красные штифты
  ctx.fillStyle='#8C9199';ctx.strokeStyle='rgba(0,0,0,.35)';ctx.lineWidth=1;
  ctx.fillRect(left+2,py-th,cw-4,th);ctx.strokeRect(left+2,py-th,cw-4,th);
  if(p.fric>0){
    ctx.strokeStyle='#C97A2E';ctx.lineWidth=1.4;
    ctx.beginPath();
    for(let i=0;i<3;i++){
      const y=py-th*(i+0.5)/3;
      ctx.moveTo(left+2,y);ctx.lineTo(left+8,y-2);
      ctx.moveTo(right-2,y);ctx.lineTo(right-8,y-2);
    }
    ctx.stroke();
  }
  if(p.fixed){
    ctx.fillStyle='#D8433A';
    ctx.fillRect(left-5,py-th/2-2.5,12,5);ctx.fillRect(right-7,py-th/2-2.5,12,5);
  }
  if(p.mass>0){
    const lw=cw*(0.25+0.45*p.mass/50),lh=8+p.mass*0.35,cx=left+cw/2;
    ctx.fillStyle='#4A4E55';ctx.fillRect(cx-lw/2,py-th-lh,lw,lh);
    ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.font=Math.min(fs,lh)*0.9+'px ui-sans-serif,system-ui,sans-serif';
    ctx.fillText('m',cx,py-th-lh/2);
  }
  const col=['p = '+num(press,1)+' кПа','V = '+num(V,1)+' л',
    'T = '+num(p.T,0)+' К ('+num(p.T-273,0)+' °C)','ν = '+num(p.n,2)+' моль','',
    'p₀ = '+num(p.p0,0)+' кПа','m = '+num(p.mass,0)+' кг','Fтр = '+num(p.fric,0)+' Н','',
    'Поршень:',pistonState(p,shown)];
  ctx.fillStyle='#1A1C20';ctx.textAlign='left';ctx.textBaseline='alphabetic';
  ctx.font=fs+'px ui-sans-serif,system-ui,sans-serif';
  const lh=Math.min(fs*1.4,(h-24)/col.length);
  col.forEach((s,i)=>ctx.fillText(s,right+10,-h/2+12+fs+i*lh));
}

/* ── панель ─────────────────────────────────────────────────────
   Строки собираются один раз на выделение, а чужие правки только подставляют
   значения: пересборка выдернула бы ползунок из-под руки. */
let panelRows=[];
const activeModel=()=>selected&&selected.type==='physics'&&MODELS[selected.kind]?selected:null;
const fieldText=(f,v)=>f.options?'':f.zero&&!v?f.zero:num(v*(f.k||1),f.d)+' '+f.unit;
const bound=(v,p)=>typeof v==='function'?v(p):v;
function renderModelPanel(it){
  const box=document.getElementById('physicsModelFields');
  box.innerHTML='';
  panelRows=MODELS[it.kind].fields.map(f=>{
    const row=document.createElement('div');
    const head=document.createElement('div');
    head.className='label';head.style.cssText='margin:9px 0 5px';
    const val=document.createElement('span');
    val.style.color='var(--text)';
    head.append(f.label+' ',val);
    const m=MODELS[it.kind];
    const set=v=>modelEdit(it,p=>{p[f.key]=v;if(m.onField)m.onField(p,f.key);});
    let input;
    if(f.options){
      input=document.createElement('select');
      input.style.cssText='width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--edge);border-radius:6px;padding:6px';
      for(const [value,title] of f.options()){
        const o=document.createElement('option');
        o.value=value;o.textContent=title;
        input.appendChild(o);
      }
      input.onchange=()=>set(input.value);
    }else{
      input=document.createElement('input');
      input.type='range';input.step=f.step;
      input.oninput=()=>set(+input.value/(f.k||1));
    }
    row.append(head,input);
    box.appendChild(row);
    return {f,row,val,input};
  });
  const m=MODELS[it.kind],run=!!(m.omega||m.toggle),reset=!!(m.omega||m.reset);
  document.getElementById('physModelRun').classList.toggle('hidden',!run);
  document.getElementById('physModelReset').classList.toggle('hidden',!reset);
  document.getElementById('physModelClock').classList.toggle('hidden',!run&&!reset);
  document.getElementById('physModelFixedRow').classList.toggle('hidden',it.kind!=='cylinder');
  syncModelPanel(it);
}
function syncModelPanel(it){
  if(selected!==it||!MODELS[it.kind])return;
  const p=it.props;
  for(const {f,row,val,input} of panelRows){
    row.classList.toggle('hidden',!!f.when&&!f.when(p));
    // сначала границы: за старой границей браузер обрезал бы новое значение
    if(!f.options){input.min=bound(f.min,p);input.max=bound(f.max,p);}
    input.value=f.options?p[f.key]:p[f.key]*(f.k||1);
    val.textContent=fieldText(f,p[f.key]);
  }
  const label=MODELS[it.kind].runLabel;
  document.getElementById('physModelRun').textContent=label?label(p):p.run?'⏸ Пауза':'▶ Пуск';
  document.getElementById('physModelFixed').checked=!!p.fixed;
}

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
setInterval(modelTick,33);
document.getElementById('physModelRun').onclick=()=>{
  const it=activeModel();
  if(it)modelEdit(it,MODELS[it.kind].toggle||(p=>{p.run=!p.run;}));
};
document.getElementById('physModelReset').onclick=()=>{
  const it=activeModel();
  if(it)modelEdit(it,MODELS[it.kind].reset||(p=>{p.run=false;p.ph=0;}));
};
document.getElementById('physModelFixed').onchange=e=>{
  const it=activeModel();
  if(it)modelEdit(it,p=>{p.fixed=e.target.checked;});
};

}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  MODELS, caption, captionH, fontSize, modelDefaults, num, paintModel, renderModelPanel, serverNow, syncModelPanel,
};
