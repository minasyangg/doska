/* тепловые модели: нагреватель, тело, калориметр */

import { S, items } from './core.js';
import { canEdit, mineOnly } from './selection.js';
import { net } from './net.js';
import { caption, captionH, fontSize, num, serverNow } from './models.js';

/* ═══ модели раздела «Тепловые явления» ═══
   Устроены как остальные модели (см. models.js): значения подписаны на самой
   модели, настройки правят уже стоящий на доске объект, а у всех участников
   видно одно и то же.

   Нагрев синхронен без потока сообщений: у тела в props лежит теплота q в
   момент at (часы сервера) и мощность watts, текущая теплота считается у
   каждого сама — q+watts·(сейчас−at). По сети идёт только смена мощности.
   Кривая на теле строится по теплоте Q, а не по времени: она целиком следует
   из вещества, массы и начальной температуры, поэтому у вошедшего посреди
   урока точно такая же, а истории копить не нужно.

   Вещество описано этапами (нагрев, плавление, нагрев, кипение, нагрев), и по
   ним считается запас теплоты на килограмм. Через него идёт и нагрев тела, и
   теплообмен в калориметре: поэтому лёд в воде тает как положено, а не просто
   усредняет температуры. */
const MATERIALS={
  water:{title:'Вода / лёд',cSolid:2100,cLiquid:4200,cGas:2000,melt:0,boil:100,fusion:330000,vapor:2260000,
         t0:-10,tMax:150,color:'#CDE7F5'},
  copper:{title:'Медь',cSolid:380,melt:1085,fusion:205000,t0:20,tMax:1400,color:'#C77B4A'},
  aluminum:{title:'Алюминий',cSolid:920,melt:660,fusion:390000,t0:20,tMax:900,color:'#BFC5CC'},
  lead:{title:'Свинец',cSolid:140,melt:327,fusion:25000,t0:20,tMax:600,color:'#7E8691'},
  steel:{title:'Сталь',cSolid:460,melt:1450,fusion:270000,t0:20,tMax:1700,color:'#9AA2AB'},
};
const LOW=-50;                       // от этой температуры считается запас теплоты
const NEAR=30;                       // тело греется, если стоит к нагревателю ближе этого
const MIX_TAU=2.5;                   // за столько секунд смесь проходит большую часть пути к равновесию
const PHASE_NAME={solid:'твёрдое',melting:'плавление',liquid:'жидкое',boiling:'кипение',gas:'пар'};

function materialOptions(){ return Object.entries(MATERIALS).map(([v,m])=>[v,m.title]); }
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function stagesOf(mat){
  if(mat.stages)return mat.stages;
  const cL=mat.cLiquid||mat.cSolid;
  const list=[{phase:'solid',t0:LOW,t1:mat.melt,c:mat.cSolid},{phase:'melting',t:mat.melt,q:mat.fusion}];
  if(mat.boil==null)list.push({phase:'liquid',t0:mat.melt,t1:Infinity,c:cL});
  else list.push({phase:'liquid',t0:mat.melt,t1:mat.boil,c:cL},{phase:'boiling',t:mat.boil,q:mat.vapor},
                 {phase:'gas',t0:mat.boil,t1:Infinity,c:mat.cGas||cL});
  return mat.stages=list;
}
/** Запас теплоты, Дж/кг. Ровно при температуре плавления вещество ещё твёрдое. */
function enthalpy(mat,t){
  let h=0;
  for(const s of stagesOf(mat)){
    if(s.q!=null){ if(t<=s.t)return h; h+=s.q; continue; }
    h+=s.c*(Math.min(t,s.t1)-s.t0);
    if(t<=s.t1)return h;
  }
  return h;
}
/** Обратно: температура, этап и какая доля этапа пройдена. */
function stateAt(mat,h){
  let left=h;
  for(const s of stagesOf(mat)){
    if(s.q!=null){
      if(left<s.q)return {temp:s.t,phase:s.phase,frac:left/s.q};
      left-=s.q;
      continue;
    }
    const need=s.c*(s.t1-s.t0);
    if(left<need)return {temp:s.t0+left/s.c,phase:s.phase,frac:0};
    left-=need;
  }
}

/* ── нагрев тела ── */
function bodyInfo(it){
  const p=it.props,mat=MATERIALS[p.material];
  const h0=enthalpy(mat,p.t0),qMax=Math.max(0,p.mass*(enthalpy(mat,mat.tMax)-h0));
  const q=Math.min(qMax,p.q+p.watts*Math.max(0,serverNow()-p.at)/1000);
  return {mat,h0,q,qMax,...stateAt(mat,h0+q/p.mass)};
}
const bodyHeating=it=>{ const s=bodyInfo(it); return it.props.watts>0&&s.q<s.qMax; };
const bodyTempMax=p=>MATERIALS[p.material].tMax-1;
function bodyInit(p){ p.q=0;p.at=0;p.watts=0; }
/* Другое вещество или масса — это уже другой опыт, поэтому теплота с нуля. */
function bodyField(p,key){
  if(key==='material')p.t0=MATERIALS[p.material].t0;
  bodyReset(p);
}
function bodyReset(p){ p.q=0;p.at=serverNow(); }

function touching(a,b){
  return a.x-NEAR<b.x+b.w&&b.x-NEAR<a.x+a.w&&a.y-NEAR<b.y+b.h&&b.y-NEAR<a.y+a.h;
}
function powerOn(body){
  let watts=0;
  for(const it of items)
    if(it.type==='physics'&&it.kind==='heater'&&it.props.on&&touching(body,it))watts+=it.props.power;
  return watts;
}
/* Мощность меняется от чужих действий: нагреватель подвинули, включили, стёрли.
   Поэтому сверяем её по таймеру, а пишет только тот, кому это тело можно
   править, и только в момент смены: забытая вкладка в сеть ничего не шлёт. */
function thermalTick(){
  if(!S.boardId||!canEdit())return;
  for(const it of items){
    if(it.type!=='physics'||it.kind!=='body'||it.locked||!mineOnly(it))continue;
    const watts=powerOn(it);
    if(watts===it.props.watts)continue;
    it.props={...it.props,q:bodyInfo(it).q,at:serverNow(),watts};
    net.send({t:'move',id:it.id,props:{...it.props}});
  }
}

/* ── смешивание в калориметре ──
   Горячее отдаёт теплоту x холодному, пока температуры не сравняются. Запас
   теплоты растёт вместе с температурой, поэтому равновесие ищем делением
   отрезка; на плавлении температура стоит, и подходит наименьшее x, — лёд
   дотаивает ровно настолько, насколько хватило теплоты. */
function mixState(it){
  const p=it.props;
  const side=(mat,g,t)=>{ const m=g/1000,M=MATERIALS[mat]; return {mat:M,m,t,H:m*enthalpy(M,t)}; };
  const a=side(p.mat1,p.m1,p.t1),b=side(p.mat2,p.m2,p.t2);
  const hot=a.t>=b.t?a:b,cold=hot===a?b:a;
  const tOf=(s,H)=>stateAt(s.mat,H/s.m).temp;
  let lo=0,hi=Math.max(0,hot.H-hot.m*enthalpy(hot.mat,cold.t));
  for(let i=0;i<60;i++){
    const x=(lo+hi)/2;
    if(tOf(hot,hot.H-x)>tOf(cold,cold.H+x))lo=x;else hi=x;
  }
  const passed=p.run?Math.max(0,serverNow()-p.at)/1000:0;
  const k=p.run?1-Math.exp(-passed/MIX_TAU):0, done=passed>6*MIX_TAU;
  // lo, а не hi: на шаг раньше вода ещё жидкая, а не начала замерзать
  const x=lo*(done?1:k);
  const now=(s,sign)=>stateAt(s.mat,(s.H+sign*x)/s.m);
  return {a:{...a,...now(a,a===hot?-1:1)},b:{...b,...now(b,b===hot?-1:1)},x,k:done?1:k,done};
}
const mixBusy=it=>it.props.run&&!mixState(it).done;
function mixInit(p){ p.run=false;p.at=0; }
function mixField(p){ p.run=false; }
function mixToggle(p){ p.run=!p.run;p.at=serverNow(); }

/* ── отрисовка ── */
const hex=s=>[1,3,5].map(i=>parseInt(s.slice(i,i+2),16));
function mix(a,b,k){
  const A=hex(a),B=hex(b);
  return 'rgb('+A.map((v,i)=>Math.round(v+(B[i]-v)*k)).join(',')+')';
}
const solidColor=(mat,t)=>mat.boil!=null?mat.color:mix(mat.color,'#E8562A',0.85*clamp((t-300)/(mat.melt-300),0,1));
const liquidColor=(mat,t)=>mat.boil!=null?mix('#5FAFE6','#E8836F',clamp(t/100,0,1)):'#F39A45';
const scatter=i=>{ const s=Math.sin(i*12.9898)*43758.5453; return s-Math.floor(s); };

/** Какую долю высоты занимает жидкость. */
function poolLevel(s){
  if(s.phase==='melting')return 0.1+0.38*s.frac;
  if(s.phase==='liquid')return 0.48;
  if(s.phase==='boiling')return 0.48*(1-s.frac*0.85);
  return 0;
}
/** Вещество в его состоянии: лёд тает в собственной воде, вода кипит и уходит
    паром. pool — чужая жидкость вокруг: в калориметре она растекается на обе
    половины, как только поднимется перегородка. */
function substance(ctx,x,y,w,h,mat,s,pool){
  if(w<=0||h<=0)return;
  const bottom=y+h,cx=x+w/2,now=Date.now();
  const level=pool?pool.level:poolLevel(s),top=bottom-h*level;
  if(level>0){
    ctx.fillStyle=pool?pool.color:liquidColor(mat,s.temp);
    ctx.fillRect(x,top,w,h*level);
  }
  const block=k=>{
    const bw=w*0.62*k,bh=h*0.5*k;
    ctx.fillStyle=solidColor(mat,s.temp);ctx.strokeStyle='rgba(0,0,0,.22)';ctx.lineWidth=1;
    ctx.beginPath();ctx.roundRect(cx-bw/2,bottom-bh,bw,bh,3);ctx.fill();ctx.stroke();
  };
  const steam=n=>{
    ctx.fillStyle='rgba(150,160,172,.6)';
    for(let i=0;i<n;i++){
      ctx.beginPath();
      ctx.arc(x+w*(0.08+0.84*scatter(i+1))+Math.sin(now/700+i)*3,y+h*scatter(i+60),2.6,0,6.2832);
      ctx.fill();
    }
  };
  if(s.phase==='solid')block(1);
  else if(s.phase==='melting')block(1-s.frac*0.8);
  else if(s.phase==='boiling'){
    ctx.fillStyle='rgba(255,255,255,.75)';
    for(let i=0;i<8;i++){
      ctx.beginPath();
      ctx.arc(x+w*(0.1+0.8*scatter(i+1)),bottom-((now/900+scatter(i+20))%1)*(bottom-top),1.5+2*scatter(i+40),0,6.2832);
      ctx.fill();
    }
    steam(Math.round(6+14*s.frac));
  }
  else if(s.phase==='gas')steam(32);
}
function thermometer(ctx,x,y,h,temp,lo,hi,marks,fs){
  if(h<44)return;
  const stem=h-16,yOf=t=>y+stem*(1-(clamp(t,lo,hi)-lo)/(hi-lo||1));
  ctx.fillStyle='#fff';ctx.strokeStyle='#8C9199';ctx.lineWidth=1.2;
  ctx.beginPath();ctx.roundRect(x-4,y-3,8,stem+8,4);ctx.fill();ctx.stroke();
  ctx.fillStyle='#D8433A';
  ctx.fillRect(x-2,yOf(temp),4,y+stem-yOf(temp)+4);
  ctx.beginPath();ctx.arc(x,y+stem+7,7,0,6.2832);ctx.fill();
  ctx.fillStyle='#4A4E55';ctx.textAlign='left';ctx.textBaseline='middle';
  ctx.font=fs*0.8+'px ui-sans-serif,system-ui,sans-serif';
  ctx.strokeStyle='#8C9199';ctx.lineWidth=1;
  for(const t of marks){
    const my=yOf(t);
    ctx.beginPath();ctx.moveTo(x+4,my);ctx.lineTo(x+8,my);ctx.stroke();
    ctx.fillText(num(t,0),x+10,my);
  }
}
/** Точки ломаной t(Q): каждый этап вещества — отрезок, плавление и кипение — ступени. */
function curvePoints(s,mass){
  const pts=[{q:0,t:stateAt(s.mat,s.h0).temp}];
  let b=0;
  for(const st of stagesOf(s.mat)){
    if(st.t1===Infinity)break;
    b+=st.q!=null?st.q:st.c*(st.t1-st.t0);
    const q=(b-s.h0)*mass;
    if(q>0&&q<s.qMax)pts.push({q,t:st.q!=null?st.t:st.t1});
  }
  pts.push({q:s.qMax,t:s.mat.tMax});
  return pts;
}
function heatingCurve(ctx,x,y,w,h,s,mass,fs){
  const gx=x+fs*2.6,gy=y+2,gw=w-fs*2.6-6,gh=h-fs*1.3-2;
  if(gw<40||gh<20||s.qMax<=0)return;
  const pts=curvePoints(s,mass),t0=pts[0].t,t1=s.mat.tMax;
  const px=q=>gx+q/s.qMax*gw,py=t=>gy+gh-(t-t0)/(t1-t0||1)*gh;
  ctx.strokeStyle='rgba(26,28,32,.35)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(gx,gy);ctx.lineTo(gx,gy+gh);ctx.lineTo(gx+gw,gy+gh);ctx.stroke();
  const line=(list)=>{
    ctx.beginPath();
    list.forEach((p,i)=>i?ctx.lineTo(px(p.q),py(p.t)):ctx.moveTo(px(p.q),py(p.t)));
    ctx.stroke();
  };
  ctx.save();ctx.setLineDash([3,3]);ctx.strokeStyle='rgba(26,28,32,.32)';line(pts);ctx.restore();
  const done=pts.filter(p=>p.q<s.q);
  done.push({q:s.q,t:s.temp});
  ctx.strokeStyle='#D8433A';ctx.lineWidth=2;ctx.lineJoin='round';line(done);
  ctx.fillStyle='#D8433A';
  ctx.beginPath();ctx.arc(px(s.q),py(s.temp),3.5,0,6.2832);ctx.fill();
  ctx.fillStyle='#4A4E55';ctx.font=fs*0.8+'px ui-sans-serif,system-ui,sans-serif';
  ctx.textAlign='right';ctx.textBaseline='middle';
  ctx.fillText(num(t1,0),gx-3,gy+3);ctx.fillText(num(t0,0),gx-3,gy+gh-3);
  ctx.textBaseline='top';
  ctx.fillText('Q, кДж: '+num(s.qMax/1000,0),gx+gw,gy+gh+2);
  ctx.textAlign='left';
  ctx.fillText('t, °C',gx+4,gy);
}
function stageFormula(s){
  const m=s.mat;
  if(s.phase==='melting')return 'Q = λ·m,  λ = '+num(m.fusion/1000,0)+' кДж/кг';
  if(s.phase==='boiling')return 'Q = L·m,  L = '+num(m.vapor/1000,0)+' кДж/кг';
  const c=s.phase==='solid'?m.cSolid:s.phase==='gas'?m.cGas:(m.cLiquid||m.cSolid);
  return 'Q = c·m·Δt,  c = '+c+' Дж/(кг·°C)';
}
function phaseText(s){
  const part=s.phase==='melting'||s.phase==='boiling'?', '+Math.round(s.frac*100)+'%':'';
  return PHASE_NAME[s.phase]+part;
}
function paintBody(ctx,it){
  const p=it.props,w=it.w,h=it.h,fs=fontSize(it),s=bodyInfo(it);
  const x0=-w/2+10,top=-h/2+9,W=w-20,titleH=fs*1.6;
  const lines=['t = '+num(s.temp,0)+' °C,  '+phaseText(s),
    'Q = '+num(s.q/1000,1)+' кДж'+(p.watts>0?(s.q<s.qMax?',  нагрев '+num(p.watts,0)+' Вт':',  предел модели'):''),
    stageFormula(s)];
  const textH=captionH(it,lines.length),graphH=Math.max(0,h*0.26);
  const vesselH=Math.max(0,h-9-titleH-graphH-textH-6),vy=top+titleH,vw=W*0.68;
  ctx.fillStyle='#1A1C20';ctx.textAlign='left';ctx.textBaseline='top';
  ctx.font='600 '+fs+'px ui-sans-serif,system-ui,sans-serif';
  ctx.fillText(s.mat.title+',  '+num(p.mass*1000,0)+' г',x0,top);
  substance(ctx,x0+2,vy,vw-4,vesselH-1,s.mat,s);
  ctx.strokeStyle='#8C9199';ctx.lineWidth=2;ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(x0,vy);ctx.lineTo(x0,vy+vesselH);ctx.lineTo(x0+vw,vy+vesselH);ctx.lineTo(x0+vw,vy);ctx.stroke();
  const marks=[s.mat.melt,s.mat.boil,s.mat.tMax].filter(t=>t!=null);
  thermometer(ctx,x0+vw+14,vy+2,vesselH-2,s.temp,Math.min(p.t0,s.mat.t0),s.mat.tMax,marks,fs);
  heatingCurve(ctx,x0,vy+vesselH+4,W,graphH,s,p.mass,fs);
  caption(ctx,it,lines);
}
function flame(ctx,y,fh,fw,color){
  ctx.fillStyle=color;
  ctx.beginPath();ctx.moveTo(-fw/2,y);
  ctx.quadraticCurveTo(-fw*0.7,y-fh*0.5,0,y-fh);
  ctx.quadraticCurveTo(fw*0.7,y-fh*0.5,fw/2,y);
  ctx.closePath();ctx.fill();
}
function paintHeater(ctx,it){
  const p=it.props,w=it.w,h=it.h;
  const warm=p.on&&items.some(o=>o.type==='physics'&&o.kind==='body'&&touching(o,it));
  const lines=['P = '+num(p.power,0)+' Вт',!p.on?'выключен':warm?'включён, греет тело':'включён, поставьте тело вплотную'];
  // рамка невысокая, и шрифт по её высоте вышел бы мельче, чем на соседних моделях
  const fs=Math.min(13,w*0.055);
  const bottom=h/2-captionH(it,lines.length,fs)-2,room=Math.max(0,bottom-(-h/2+8));
  const bw=Math.min(w*0.4,90),bh=room*0.28,neck=bottom-bh-6;
  ctx.fillStyle='#4A4E55';
  ctx.beginPath();ctx.moveTo(-bw/2,bottom);ctx.lineTo(bw/2,bottom);ctx.lineTo(bw*0.28,bottom-bh);ctx.lineTo(-bw*0.28,bottom-bh);ctx.closePath();ctx.fill();
  ctx.fillStyle='#8C9199';ctx.fillRect(-bw*0.1,neck,bw*0.2,6);
  if(p.on){
    const fh=Math.max(0,(room-bh-6)*(0.35+0.65*Math.sqrt(p.power/5000))*(1+0.05*Math.sin(Date.now()/90)));
    flame(ctx,neck,fh,bw*0.7,'#F4A23A');
    flame(ctx,neck,fh*0.6,bw*0.38,'#FBD96A');
  }
  caption(ctx,it,lines,fs);
}
function paintCalorimeter(ctx,it){
  const p=it.props,w=it.w,h=it.h,fs=fontSize(it),s=mixState(it);
  const x0=-w/2+12,top=-h/2+9,titleH=fs*1.7,vw=w*0.5,vy=top+titleH,vh=Math.max(0,h-20-titleH);
  ctx.fillStyle='#1A1C20';ctx.textAlign='left';ctx.textBaseline='top';
  ctx.font='600 '+fs+'px ui-sans-serif,system-ui,sans-serif';
  ctx.fillText('Калориметр',x0,top);
  // внешняя стенка — та самая теплоизоляция, поэтому двойная
  ctx.strokeStyle='#8C9199';ctx.lineWidth=2;
  ctx.beginPath();ctx.roundRect(x0,vy,vw,vh,6);ctx.stroke();
  const ix=x0+7,iy=vy+7,iw=Math.max(0,vw-14),ih=Math.max(0,vh-14),half=iw/2;
  ctx.fillStyle='#fff';ctx.fillRect(ix,iy,iw,ih);
  // пока перегородка поднимается, уровни сходятся: жидкость растекается
  const la=poolLevel(s.a),lb=poolLevel(s.b),mid=(la+lb)/2;
  const color=lb>la?liquidColor(s.b.mat,s.b.temp):liquidColor(s.a.mat,s.a.temp);
  const poolOf=(side,l)=>({level:l+(mid-l)*s.k,color:l>0?liquidColor(side.mat,side.temp):color});
  substance(ctx,ix,iy,half,ih,s.a.mat,s.a,poolOf(s.a,la));
  substance(ctx,ix+half,iy,half,ih,s.b.mat,s.b,poolOf(s.b,lb));
  ctx.strokeStyle='#4A4E55';ctx.lineWidth=1.5;ctx.strokeRect(ix,iy,iw,ih);
  // перегородка поднимается при смешивании
  if(s.k<1){
    ctx.strokeStyle='rgba(74,78,85,'+(1-s.k).toFixed(3)+')';ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(ix+half,iy);ctx.lineTo(ix+half,iy+ih);ctx.stroke();
  }
  ctx.fillStyle='#1A1C20';ctx.textAlign='center';ctx.textBaseline='top';
  ctx.font='600 '+fs*0.95+'px ui-sans-serif,system-ui,sans-serif';
  ctx.fillText(num(s.a.temp,1)+' °C',ix+half/2,iy+4);
  ctx.fillText(num(s.b.temp,1)+' °C',ix+half*1.5,iy+4);
  const eq=s.done?'тепловое равновесие':p.run?'идёт теплообмен':'перегородка закрыта';
  const col=['1: '+s.a.mat.title,'m = '+num(p.m1,0)+' г,  t = '+num(p.t1,0)+' °C',phaseText(s.a),'',
    '2: '+s.b.mat.title,'m = '+num(p.m2,0)+' г,  t = '+num(p.t2,0)+' °C',phaseText(s.b),'',
    'Отдано Q = '+num(s.x/1000,1)+' кДж','Получено Q = '+num(s.x/1000,1)+' кДж',eq];
  ctx.fillStyle='#1A1C20';ctx.textAlign='left';ctx.textBaseline='top';
  ctx.font=fs*0.92+'px ui-sans-serif,system-ui,sans-serif';
  const lh=Math.min(fs*1.3,(h-20)/col.length);
  col.forEach((t,i)=>ctx.fillText(t,x0+vw+10,vy+i*lh));
}

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
setInterval(thermalTick,400);

}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  bodyField, bodyHeating, bodyInit, bodyReset, bodyTempMax, materialOptions, mixBusy, mixField, mixInit, mixToggle,
  paintBody, paintCalorimeter, paintHeater,
};
