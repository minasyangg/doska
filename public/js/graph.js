/* график функций: разбор формул и отрисовка */

import { S, toScreen, toWorld } from './core.js';
import { arcSweep } from './geometry.js';
import { drawAxisArrow } from './shapes.js';
import { compassAngle, paintBody, paintCalorimeter, paintFieldLines, paintHeater, paintLens, paintMirror, paintSource } from './physics.js';
import { dragging, itemAt } from './selection.js';
import { hoverPt } from './render.js';

/* ── график функций (раздел «Математика» в доп.меню) ─────────────
   Свой парсер и вычислитель вместо стороннего math.js/eval: доска —
   один файл без зависимостей и без сборки, а главное — выражение это
   данные, долетающие до ЧУЖОГО браузера через синхронизацию (as-is
   строка от другого участника). eval/new Function от неё means
   исполнение чужого кода у себя в вкладке — недопустимо. Здесь строится
   свой AST, и обходит его тоже свой код: выполнить что-то, кроме
   арифметики и разрешённых функций, через это невозможно, что бы ни было
   в исходной строке.

   Рендер — тот же приём, что у силовых линий и лучей: сэмплируем функцию
   по x и рисуем полилинию, только на этот раз холст — это ПОДокно со
   своими координатами (view.cx/cy/scale), не мировыми координатами
   доски. Прецедента вложенной камеры в приложении раньше не было (весь
   рендер идёт в одной applyCam()-трансформации) — это первый объект,
   которому она нужна: масштаб доски масштабирует график целиком (как
   картинку), a view.scale — зум ВНУТРИ графика, независимый от него. */
const GRAPH_COLORS=['#2F6FE0','#D8433A','#2E9B62','#B36D1F','#8A4FC9'];
const GRAPH_FUNCS={
  sin:Math.sin,cos:Math.cos,tan:Math.tan,
  asin:Math.asin,acos:Math.acos,atan:Math.atan,
  sqrt:Math.sqrt,abs:Math.abs,exp:Math.exp,
  ln:Math.log,log:Math.log10,
};
const GRAPH_TRIG=new Set(['sin','cos','tan']), GRAPH_INV_TRIG=new Set(['asin','acos','atan']);
const GRAPH_CONSTS={pi:Math.PI,e:Math.E};
function graphTokenize(src){
  const toks=[];let i=0;
  while(i<src.length){
    const c=src[i];
    if(/\s/.test(c)){i++;continue;}
    if(/[0-9.]/.test(c)){
      let j=i+1;while(j<src.length&&/[0-9.]/.test(src[j]))j++;
      toks.push({t:'num',v:parseFloat(src.slice(i,j))});i=j;continue;
    }
    if(/[a-zA-Zа-яёА-ЯЁ]/.test(c)){
      let j=i+1;while(j<src.length&&/[a-zA-Zа-яёА-ЯЁ0-9]/.test(src[j]))j++;
      toks.push({t:'id',v:src.slice(i,j).toLowerCase()});i=j;continue;
    }
    if('+-*/^(),'.includes(c)){toks.push({t:c});i++;continue;}
    throw new Error('непонятный символ «'+c+'»');
  }
  return toks;
}
/** Рекурсивный спуск с неявным умножением: "2x", "2(x+1)", "2sin(x)" —
    в цикле parseTerm любой следующий множитель без явного *narrow
    считается умножением, если с него вообще может начаться выражение.
    Свободный идентификатор (не x/y/t, не константа, не имя функции перед
    «(») не считается ошибкой на этапе разбора — это может быть параметр
    со слайдера, определённый только в контексте конкретного графика.
    Разбор от этого не зависит, поэтому кэш graphAstCache остаётся ключом
    просто по тексту; какое имя действительно определено, решает
    graphEval через словарь vars — не найдётся, вернётся NaN, кривая в
    этой точке просто прервётся, как при делении на ноль. */
function graphParseExpr(src){
  const toks=graphTokenize(src);
  let pos=0;
  const peek=()=>toks[pos];
  const startsFactor=t=>!!t&&(t.t==='num'||t.t==='id'||t.t==='(');
  function parseExpr(){
    let node=parseTerm();
    while(peek()&&(peek().t==='+'||peek().t==='-')){
      const op=toks[pos++].t;
      node={t:op,a:node,b:parseTerm()};
    }
    return node;
  }
  function parseTerm(){
    let node=parseUnary();
    while(peek()&&(peek().t==='*'||peek().t==='/'||startsFactor(peek()))){
      let op='*';
      if(peek().t==='*'||peek().t==='/')op=toks[pos++].t;
      node={t:op,a:node,b:parseUnary()};
    }
    return node;
  }
  function parseUnary(){
    if(peek()&&peek().t==='-'){pos++;return {t:'neg',a:parseUnary()};}
    if(peek()&&peek().t==='+'){pos++;return parseUnary();}
    return parsePower();
  }
  function parsePower(){
    const base=parseFactor();
    if(peek()&&peek().t==='^'){pos++;return {t:'^',a:base,b:parseUnary()};}
    return base;
  }
  function parseFactor(){
    const tk=peek();
    if(!tk)throw new Error('неожиданный конец выражения');
    if(tk.t==='num'){pos++;return {t:'num',v:tk.v};}
    if(tk.t==='('){
      pos++;const e=parseExpr();
      if(!peek()||peek().t!==')')throw new Error('не хватает «)»');
      pos++;return e;
    }
    if(tk.t==='id'){
      pos++;
      if(peek()&&peek().t==='('){
        pos++;
        const args=[parseExpr()];
        while(peek()&&peek().t===','){pos++;args.push(parseExpr());}
        if(!peek()||peek().t!==')')throw new Error('не хватает «)»');
        pos++;
        if(!(tk.v in GRAPH_FUNCS))throw new Error('неизвестная функция «'+tk.v+'»');
        return {t:'call',name:tk.v,args};
      }
      if(tk.v in GRAPH_CONSTS)return {t:'num',v:GRAPH_CONSTS[tk.v]};
      return {t:'var',name:tk.v};
    }
    throw new Error('неожиданный символ');
  }
  const ast=parseExpr();
  if(pos<toks.length)throw new Error('лишние символы в конце');
  return ast;
}
/** «y = …» — обычная запись функции; префикс не часть математики, поэтому
    срезается перед разбором, а не остаётся особым случаем в парсере. */
function graphParse(src){ return graphParseExpr(src.replace(/^\s*y\s*=/i,'')); }
/** vars — таблица имён, доступных ПРЯМО СЕЙЧАС (x и/или y и/или t — что
    актуально для текущего режима — плюс значения всех слайдеров графика).
    deg — считать ли аргументы/результаты три­гонометрии в градусах. */
function graphEval(node,vars,deg){
  switch(node.t){
    case 'num':return node.v;
    case 'var':return (vars&&node.name in vars)?vars[node.name]:NaN;
    case '+':return graphEval(node.a,vars,deg)+graphEval(node.b,vars,deg);
    case '-':return graphEval(node.a,vars,deg)-graphEval(node.b,vars,deg);
    case '*':return graphEval(node.a,vars,deg)*graphEval(node.b,vars,deg);
    case '/':return graphEval(node.a,vars,deg)/graphEval(node.b,vars,deg);
    case '^':return Math.pow(graphEval(node.a,vars,deg),graphEval(node.b,vars,deg));
    case 'neg':return -graphEval(node.a,vars,deg);
    case 'call':{
      const args=node.args.map(a=>graphEval(a,vars,deg));
      if(deg&&GRAPH_TRIG.has(node.name))return GRAPH_FUNCS[node.name](args[0]*Math.PI/180);
      const r=GRAPH_FUNCS[node.name](...args);
      return (deg&&GRAPH_INV_TRIG.has(node.name))?r*180/Math.PI:r;
    }
    default:return NaN;
  }
}
/** '=' вне скобок — граница между левой и правой частью неявного уравнения
    («x^2+y^2=25»); «y = …» ловится раньше как обычная функция и сюда не
    попадает (см. graphClassify). */
function findTopLevelEquals(s){
  let depth=0;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(c==='(')depth++; else if(c===')')depth--;
    else if(c==='='&&depth===0)return i;
  }
  return -1;
}
function splitTopLevelComma(s){
  let depth=0,start=0;const parts=[];
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(c==='(')depth++; else if(c===')')depth--;
    else if(c===','&&depth===0){parts.push(s.slice(start,i));start=i+1;}
  }
  parts.push(s.slice(start));
  return parts;
}
/** Три формы записи в одном и том же поле — как в Desmos, без переключателя:
    "(cos(t), sin(t))"  → параметрическая кривая
    "x^2 + y^2 = 25"     → неявное уравнение (обе переменные сразу)
    всё остальное        → обычная функция y = f(x) (префикс "y=" необязателен) */
function graphClassify(text){
  const t=text.trim();
  if(t[0]==='('&&t[t.length-1]===')'&&splitTopLevelComma(t.slice(1,-1)).length===2)return 'parametric';
  const eq=findTopLevelEquals(t);
  if(eq>=0&&t.slice(0,eq).trim().toLowerCase()!=='y')return 'implicit';
  return 'function';
}
const graphAstCache=new Map();  // текст формулы → разобранное представление, чтобы не парсить на каждый сэмпл
function graphCompile(text){
  if(graphAstCache.has(text))return graphAstCache.get(text);
  let result;
  try{
    const mode=graphClassify(text);
    if(mode==='parametric'){
      const parts=splitTopLevelComma(text.trim().slice(1,-1));
      if(parts.length!==2)throw new Error('нужно два выражения через запятую: (x(t), y(t))');
      result={mode,xAst:graphParseExpr(parts[0]),yAst:graphParseExpr(parts[1]),error:null};
    }else if(mode==='implicit'){
      const eq=findTopLevelEquals(text);
      result={mode,lhsAst:graphParseExpr(text.slice(0,eq)),rhsAst:graphParseExpr(text.slice(eq+1)),error:null};
    }else{
      result={mode,ast:graphParse(text),error:null};
    }
  }catch(err){ result={mode:null,error:err.message}; }
  if(graphAstCache.size>300)graphAstCache.clear();   // защита от утечки, пока кто-то активно печатает
  graphAstCache.set(text,result);
  return result;
}
/** Все имена-переменные, встреченные в дереве — нужно только для подсветки
    опечаток в панели (граф.движку это не требуется: не найдётся в vars —
    просто NaN). */
function graphCollectVars(node,into){
  if(!node)return;
  if(node.t==='var'){into.add(node.name);return;}
  if(node.a)graphCollectVars(node.a,into);
  if(node.b)graphCollectVars(node.b,into);
  if(node.args)node.args.forEach(a=>graphCollectVars(a,into));
}
/** Формула валидна, если она вообще разобралась И каждое использованное
    имя — это x/y/t (смотря какой режим) или объявленный на этом графике
    параметр-слайдер. Второе не умеет проверить сам парсер (см. комментарий
    у graphParseExpr) — там нет графика, к которому можно быть привязанным. */
function graphExprOk(text,it){
  if(!text||!text.trim())return true;      // пустая строка — не ошибка, просто ничего не рисуем
  const c=graphCompile(text);
  if(!c.mode)return false;
  // какое имя вообще осмысленно, зависит от режима: параметрической кривой
  // при вычислении никто не подставит x, обычной функции — t, и т.д.
  const known=new Set(c.mode==='parametric'?['t']:c.mode==='implicit'?['x','y']:['x']);
  (it.props.params||[]).forEach(p=>known.add(p.name));
  const used=new Set();
  [c.ast,c.xAst,c.yAst,c.lhsAst,c.rhsAst].forEach(a=>graphCollectVars(a,used));
  for(const name of used)if(!known.has(name))return false;
  return true;
}
/** «Круглый» шаг сетки под текущий масштаб — 1/2/5×10ⁿ, обычный приём для
    осей графиков: интервалы сами не скачут дробными числами при зуме. */
function graphNiceStep(rough){
  const pow10=Math.pow(10,Math.floor(Math.log10(rough)));
  const f=rough/pow10;
  const nice=f<1.5?1:f<3?2:f<7?5:10;
  return nice*pow10;
}
const GRAPH_HEADER_H=18;         // полоска сверху — за неё двигают саму рамку, не панорамируют вид
/** Приблизить/отдалить вид графика к мировой точке (курсор), не сдвигая
    математическую точку под ним — тот же приём, что у zoomAt() для всей
    доски, только внутри собственных координат объекта. */
function zoomGraphAt(it,worldPt,factor){
  const view=it.props.view;
  const bx=it.x+it.w/2,by=it.y+it.h/2;
  const mx=view.cx+(worldPt.x-bx)/view.scale, my=view.cy-(worldPt.y-by)/view.scale;
  const newScale=Math.max(4,Math.min(4000,view.scale*factor));
  view.cx=mx-(worldPt.x-bx)/newScale;
  view.cy=my+(worldPt.y-by)/newScale;
  view.scale=newScale;
  it.bbox=null;
}
/* props кладётся в net.send/pushUndo как есть, а points/expressions —
   вложенные массивы: обычный {...it.props} их не копирует, только делит
   ссылку. Для undo это опасно — "снимок до" незаметно менялся бы вместе с
   "после". props насквозь JSON-совместим (это его смысл — едет по сети),
   поэтому клонировать проще всего через JSON. */
const cloneProps=p=>JSON.parse(JSON.stringify(p));
/** Место подписи осей X/Y — у конца соответствующей оси (там же, где её
    стрелка), а не в стороне от неё: раньше уводил их в фиксированный
    уголок рамки, чтобы не наезжали на линию, но так они переставали быть
    подписями именно ЭТОЙ оси — оторвались от неё. От наезда защищает не
    расстояние, а собственный непрозрачный флажок (drawGraphLegendChip),
    поэтому можно держать подпись рядом с осью и одновременно не давать ей
    сливаться с линией/сеткой. Если ось сейчас вне видимой области
    (график далеко панорамирован) — подпись не убегает вникуда, а держится
    у ближайшего края рамки, как и раньше. */
function graphAxisLabelPos(it){
  const view=it.props.view||{cx:0,cy:0,scale:40};
  const ccx=it.x+it.w/2,ccy=it.y+it.h/2;
  const ax=ccx+(0-view.cx)*view.scale, ay=ccy-(0-view.cy)*view.scale;
  const top=it.y+GRAPH_HEADER_H+10,bottom=it.y+it.h-10,left=it.x+10,right=it.x+it.w-10;
  const xAxisY=Math.min(Math.max(ay,top),bottom);
  const yAxisX=Math.min(Math.max(ax,left),right);
  // тот же перевод «сколько на экране» → «сколько в мировых единицах»,
  // что и в paintGraph (см. uiScale там) — без него подпись росла бы
  // вместе с зумом доски, как и жаловались на цифры на сетке
  const size=(it.props.labelSize||13)/(S.cam.z||1);
  return {
    x:{wx:right,wy:xAxisY-size*0.9-4,size,anchor:'right'},   // у правого конца оси X, чуть выше линии
    y:{wx:yAxisX+size*0.5+6,wy:top,size,anchor:'left'},      // у верхнего конца оси Y, чуть правее линии
  };
}
/** Подпись с непрозрачным флажком-подложкой позади — гарантированно
    читаема, чем бы график ни закрасил у неё за спиной (сетка, кривая,
    сама ось). anchor определяет, в какую сторону от wx растёт текст. */
function drawGraphLegendChip(ctx,wx,wy,text,size,anchor){
  ctx.font='700 '+size+'px ui-sans-serif,system-ui,sans-serif';
  const tw=ctx.measureText(text).width, padX=size*0.46,padY=size*0.23;
  const bx=anchor==='right'?wx-tw-padX*2:wx;
  // только заливка, без обводки — рамка вокруг подписи выглядела отдельным
  // элементом интерфейса поверх графика; полупрозрачной заливки одной уже
  // достаточно, чтобы текст не сливался с сеткой/кривой позади
  ctx.fillStyle='rgba(252,251,248,.9)';
  ctx.beginPath();ctx.roundRect(bx,wy-size/2-padY,tw+padX*2,size+padY*2,5);ctx.fill();
  ctx.fillStyle='#2A2D33';ctx.textAlign='left';ctx.textBaseline='middle';
  ctx.fillText(text,bx+padX,wy+1);
}
/** Следующая свободная буква A-Z — обычная геометрическая нумерация точек;
    после алфавита (только если поставить их совсем много) — просто номер. */
function nextPointLabel(points){
  const used=new Set(points.map(p=>p.label).filter(Boolean));
  for(let i=0;i<26;i++){const c=String.fromCharCode(65+i);if(!used.has(c))return c;}
  return 'P'+(points.length+1);
}
/** Неявное уравнение (lhs = rhs, обе части — функции от x И y сразу) —
    marching squares по решётке шириной в cell экранных пикселей: значения
    F=lhs-rhs в узлах решётки посчитаны один раз (узлы общие для соседних
    клеток), а не по клеткам — тех же чисел вчетверо меньше. Для клетки,
    где F меняет знак, линейной интерполяцией по рёбрам находим точки
    F=0 и соединяем их — 2 точки пересечения на клетку рисуются одним
    отрезком, 4 (седловая клетка) — двумя отрезками крест-накрест: это
    огрубление классических 16 случаев маршрута, которое не разбирает
    отдельно, какая из двух диагоналей физически правильнее, но лишней
    нагрузки не создаёт и на практике не искажает узнаваемую форму кривой
    (окружности/эллипсы/гиперболы не создают седловых клеток вовсе).
    Сетка фиксированного размера — счёта тем меньше, чем крупнее cell,
    и он не зависит от того, сколько точек/итераций «попросил» пользователь
    (в отличие от обычных функций и параметрик, здесь и просить нечего). */
function paintImplicitCurve(ctx,baseVars,lhsAst,rhsAst,color,deg,toMx,toMy,bx,by,bw,bh){
  const cell=8;
  const nx=Math.max(1,Math.ceil(bw/cell)), ny=Math.max(1,Math.ceil(bh/cell));
  const grid=new Float64Array((nx+1)*(ny+1));
  const vars={...baseVars};
  for(let j=0;j<=ny;j++){
    vars.y=toMy(by+j*cell);
    for(let i=0;i<=nx;i++){
      vars.x=toMx(bx+i*cell);
      let f;try{f=graphEval(lhsAst,vars,deg)-graphEval(rhsAst,vars,deg);}catch{f=NaN;}
      grid[j*(nx+1)+i]=f;
    }
  }
  const val=(i,j)=>grid[j*(nx+1)+i];
  const interp=(v0,v1)=>v0/(v0-v1);
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const f00=val(i,j),f10=val(i+1,j),f01=val(i,j+1),f11=val(i+1,j+1);
    if(![f00,f10,f01,f11].every(Number.isFinite))continue;
    const x0=bx+i*cell,x1=bx+(i+1)*cell,y0=by+j*cell,y1=by+(j+1)*cell;
    const pts=[];
    if((f00<0)!==(f10<0)){const t=interp(f00,f10);pts.push([x0+t*(x1-x0),y0]);}
    if((f10<0)!==(f11<0)){const t=interp(f10,f11);pts.push([x1,y0+t*(y1-y0)]);}
    if((f01<0)!==(f11<0)){const t=interp(f01,f11);pts.push([x0+t*(x1-x0),y1]);}
    if((f00<0)!==(f01<0)){const t=interp(f00,f01);pts.push([x0,y0+t*(y1-y0)]);}
    if(pts.length===2){ctx.moveTo(pts[0][0],pts[0][1]);ctx.lineTo(pts[1][0],pts[1][1]);}
    else if(pts.length===4){
      ctx.moveTo(pts[0][0],pts[0][1]);ctx.lineTo(pts[1][0],pts[1][1]);
      ctx.moveTo(pts[2][0],pts[2][1]);ctx.lineTo(pts[3][0],pts[3][1]);
    }
  }
  ctx.stroke();
}
/** y точки — либо хранимое значение, либо (если точка «приклеена» к кривой
    через onExpr) заново посчитанное из актуальной формулы; общая для
    отрисовки, подсказки координат при наведении/перетаскивании — так они
    не могут разойтись между собой. */
function graphPointY(it,p,baseVars,deg){
  if(!p.onExpr)return p.y;
  const host=(it.props.expressions||[]).find(e=>e.id===p.onExpr);
  const c=host&&graphCompile(host.text);
  if(!c||c.mode!=='function')return NaN;
  try{return graphEval(c.ast,{...baseVars,x:p.x},deg);}catch{return NaN;}
}
/** Число для подписи деления. Точность считается от шага сетки (step), а
    не зафиксирована в 2 знаках: на глубоком зуме шаг может стать 0.01 или
    мельче (сетка ниже теперь адаптивна и к зуму доски, не только к
    масштабу графика) — с фиксированными двумя знаками соседние деления
    округлялись бы в одно и то же число и подпись переставала быть
    отличимой. Один запасной знак сверх «необходимого по шагу» — чтобы не
    зависеть от пограничного округления самого шага. */
function graphFmtNum(v,step){
  const decimals=step>0?Math.max(0,Math.min(8,Math.ceil(-Math.log10(step))+1)):2;
  const r=+v.toFixed(decimals);
  if(Number.isInteger(r))return String(r);
  return String(r.toFixed(decimals)).replace(/0+$/,'').replace(/\.$/,'');
}
/** Координаты под курсором внутри графика — при наведении, либо пока
    тащат точку (тогда — её точное положение, а не позиция курсора: хват
    не всегда впритык). Рисуется на «живом» слое (см. flushLive) заново
    каждый кадр — не хранится нигде, не мешает основному рендеру графика
    на статичном. Вызывается уже из экранно-пиксельного контекста (после
    setTransform(dpr,...) в flushLive), поэтому мировые координаты сюда
    переводятся вручную через toScreen(). */
function paintGraphCoordHint(ctx){
  let it,mx,my,highlight=false;
  if(dragging&&dragging.mode==='graphPointDrag'){
    it=dragging.it;
    const p=it.props.points&&it.props.points[dragging.index];
    if(!p)return;
    const deg=it.props.angleMode==='deg', baseVars={};
    (it.props.params||[]).forEach(pr=>{baseVars[pr.name]=pr.value;});
    mx=p.x;my=graphPointY(it,p,baseVars,deg);highlight=true;
    if(!Number.isFinite(my))return;
  }else if(!dragging&&hoverPt&&S.tool==='select'){
    const w=toWorld(hoverPt.x,hoverPt.y);
    const g=itemAt(w);
    if(!g||g.type!=='physics'||g.kind!=='graph')return;
    if(w.y-g.y<=GRAPH_HEADER_H)return;
    it=g;
    const deg=g.props.angleMode==='deg', baseVars={};
    (g.props.params||[]).forEach(pr=>{baseVars[pr.name]=pr.value;});
    const view=g.props.view,gcx=g.x+g.w/2,gcy=g.y+g.h/2;
    mx=view.cx+(w.x-gcx)/view.scale;my=view.cy-(w.y-gcy)/view.scale;
    // приклеиваемся к близкой точке — удобнее целиться числом, чем на глаз
    for(const p of (g.props.points||[])){
      const py=graphPointY(g,p,baseVars,deg);
      if(!Number.isFinite(py))continue;
      const sx=gcx+(p.x-view.cx)*view.scale,sy=gcy-(py-view.cy)*view.scale;
      if(Math.hypot(w.x-sx,w.y-sy)*S.cam.z<9){mx=p.x;my=py;highlight=true;break;}
    }
  }else return;
  const view=it.props.view,gcx=it.x+it.w/2,gcy=it.y+it.h/2;
  const wx=gcx+(mx-view.cx)*view.scale,wy=gcy-(my-view.cy)*view.scale;
  const sp=toScreen(wx,wy);
  ctx.fillStyle=highlight?'#2F6FE0':'#1A1C20';
  ctx.beginPath();ctx.arc(sp.x,sp.y,highlight?5:3,0,6.2832);ctx.fill();
  // та же точность, что и у чисел на сетке при таком же зуме — иначе
  // подсказка могла бы показать меньше знаков, чем нужно, чтобы отличить
  // соседние деления
  const coordStep=graphNiceStep(80/(view.scale*(S.cam.z||1)));
  const txt='('+graphFmtNum(mx,coordStep)+', '+graphFmtNum(my,coordStep)+')';
  ctx.font='11px ui-monospace,SFMono-Regular,Menlo,monospace';
  const tw=ctx.measureText(txt).width+10;
  const bx=Math.min(sp.x+10,innerWidth-tw-8),by=Math.max(8,sp.y-26);
  ctx.fillStyle='rgba(26,28,32,.92)';
  ctx.beginPath();ctx.roundRect(bx,by,tw,18,5);ctx.fill();
  ctx.fillStyle='#fff';ctx.textAlign='left';ctx.textBaseline='middle';
  ctx.fillText(txt,bx+5,by+9);
  ctx.textAlign='start';ctx.textBaseline='alphabetic';
}
function paintGraph(ctx,it){
  const view=it.props.view||{cx:0,cy:0,scale:40};
  const bx=it.x,by=it.y,bw=it.w,bh=it.h;
  const ccx=bx+bw/2,ccy=by+bh/2;
  const toSx=mx=>ccx+(mx-view.cx)*view.scale, toSy=my=>ccy-(my-view.cy)*view.scale;
  const toMx=sx=>view.cx+(sx-ccx)/view.scale, toMy=sy=>view.cy-(sy-ccy)/view.scale;
  const deg=it.props.angleMode==='deg';
  const baseVars={};(it.props.params||[]).forEach(p=>{baseVars[p.name]=p.value;});
  // «Размер подписей» в панели — желаемый размер НА ЭКРАНЕ, а рисуем мы в
  // уже повёрнутых/промасштабированных мировых координатах доски (общий
  // applyCam применяется до вызова paintItem) — без компенсации на зум
  // доски (S.cam.z) шрифт/линии этого графика распухали бы при
  // приближении доски и мельчали при отдалении вместе с самим объектом,
  // хотя подписи — это не «содержимое» вроде кривой, а служебный текст,
  // который должен читаться одинаково на любом зуме. uiScale переводит
  // «сколько нужно на экране» в «сколько написать в мировых единицах»,
  // чтобы после applyCam на экране получилось ровно столько же.
  // зажато с обеих сторон — на экстремальном зуме доски (сильно
  // отдалённой или наоборот) иначе поплыли бы отступы под подписи,
  // посчитанные от tickSize/labelSize
  const uiScale=Math.min(4,Math.max(0.15,1/(S.cam.z||1)));
  const labelSize=(it.props.labelSize||13)*uiScale, tickSize=Math.max(8,(it.props.labelSize||13)-3)*uiScale;
  const ax=toSx(0), ay=toSy(0);
  // где рисовать подписи делений — на самой оси, если она видна, иначе
  // прижимаем к краю рамки (график далеко панорамирован, ось за кадром).
  // Отступы от края — не про саму линию, а про то, чтобы под подпись-число
  // рядом с ней оставалось место: раньше 8px не хватало даже на одну
  // строку цифр, и у прижатой к краю оси числа обрезались рамкой клипа.
  const xAxisY=Math.min(Math.max(ay,by+GRAPH_HEADER_H+14),by+bh-(tickSize+12));
  const yAxisX=Math.min(Math.max(ax,bx+34),bx+bw-14);
  ctx.save();
  ctx.beginPath();ctx.rect(bx,by,bw,bh);ctx.clip();
  ctx.fillStyle='#FCFBF8';ctx.fillRect(bx,by,bw,bh);
  // цель — «прибл. 80 экранных px между линиями», а не мировых: чистый
  // view.scale не видит зум самой доски (S.cam.z), поэтому раньше клетка
  // переставала мельчать при увеличении доски колесом — оставалась той же
  // в мировых единицах, а на экране только росла вместе с доской
  const pxPerUnit=view.scale*(S.cam.z||1);
  // Цель по X крупнее, чем по Y: горизонтальная подпись — это строка
  // цифр шириной в несколько символов, ей нужно больше зазора между
  // соседними делениями, чем вертикальной (та всего на строку выше/ниже
  // своей линии). Одинаковая цель в 80px раньше давала на X ровно те же
  // деления, что и на Y, и при мелком шаге (глубокий зум) подписи по X
  // упирались друг в друга гораздо раньше, чем по Y.
  const stepX=graphNiceStep(130/pxPerUnit), stepY=graphNiceStep(80/pxPerUnit);
  ctx.strokeStyle='rgba(0,0,0,.08)';ctx.lineWidth=uiScale;
  ctx.font=tickSize+'px ui-sans-serif,system-ui,sans-serif';ctx.fillStyle='rgba(0,0,0,.45)';
  ctx.textAlign='center';ctx.textBaseline='top';
  let lastLabelRight=-Infinity;
  for(let mx=Math.ceil(toMx(bx)/stepX)*stepX;mx<=toMx(bx+bw);mx+=stepX){
    const sx=toSx(mx);ctx.beginPath();ctx.moveTo(sx,by);ctx.lineTo(sx,by+bh);ctx.stroke();
    if(Math.abs(mx)<=stepX*0.01)continue;   // «0» подписывает вертикальная сетка
    const txt=graphFmtNum(mx,stepX), half=ctx.measureText(txt).width/2;
    // Подстраховка сверх подобранной цели по шагу: если всё же соседняя
    // подпись перекрылась бы (например узкий бокс графика поджал вид),
    // просто пропускаем её вместо нечитаемой каши цифр друг на друге.
    if(sx-half<lastLabelRight)continue;
    ctx.fillText(txt,sx,xAxisY+3);
    lastLabelRight=sx+half+2*uiScale;
  }
  ctx.textAlign='right';ctx.textBaseline='middle';
  for(let my=Math.ceil(toMy(by+bh)/stepY)*stepY;my<=toMy(by);my+=stepY){
    const sy=toSy(my);ctx.beginPath();ctx.moveTo(bx,sy);ctx.lineTo(bx+bw,sy);ctx.stroke();
    if(Math.abs(my)>stepY*0.01)ctx.fillText(graphFmtNum(my,stepY),yAxisX-4,sy);
  }
  // Оси рисуются всегда, а не только когда истинный ноль виден: иначе,
  // стоило отойти панорамой от (0,0), они пропадали бы совсем — не за что
  // зацепиться взглядом, чтобы понять, куда вообще смотришь. Прижаты к
  // краю (yAxisX/xAxisY — те же клампы, что и у подписей делений); когда
  // истинная ось вне рамки, это уже не «ровно ноль тут», а лишь ориентир
  // с краю — поэтому в этом случае рисуется пунктиром, а не сплошной.
  const yAxisPinned=ax<bx+34||ax>bx+bw-14, xAxisPinned=ay<by+GRAPH_HEADER_H+14||ay>by+bh-(tickSize+12);
  // сами стрелки — компактнее и темнее (были крупнее и той же бледности,
  // что и линия оси, из-за чего выглядели грубовато); упираются в истинную
  // границу рамки, а не в нижний край шапки — вертикальная ось теперь
  // доходит до верха ровно так же, как горизонтальная доходит до правого края
  const AXIS_ARROW='rgba(0,0,0,.7)', arrowSize=2.6*uiScale;
  ctx.strokeStyle='rgba(0,0,0,.4)';ctx.fillStyle='rgba(0,0,0,.4)';ctx.lineWidth=1.4*uiScale;
  ctx.setLineDash(yAxisPinned?[5*uiScale,4*uiScale]:[]);
  ctx.beginPath();ctx.moveTo(yAxisX,by);ctx.lineTo(yAxisX,by+bh);ctx.stroke();
  if(!yAxisPinned)drawAxisArrow(ctx,yAxisX,by,0,-1,arrowSize,AXIS_ARROW);
  ctx.setLineDash(xAxisPinned?[5*uiScale,4*uiScale]:[]);
  ctx.beginPath();ctx.moveTo(bx,xAxisY);ctx.lineTo(bx+bw,xAxisY);ctx.stroke();
  if(!xAxisPinned)drawAxisArrow(ctx,bx+bw,xAxisY,1,0,arrowSize,AXIS_ARROW);
  ctx.setLineDash([]);
  ctx.textAlign='right';ctx.textBaseline='middle';
  ctx.fillText('0',yAxisX-4,xAxisY+3);   // подпись начала координат — единственная общая для обеих осей
  for(const ex of (it.props.expressions||[])){
    if(ex.visible===false||!ex.text||!ex.text.trim())continue;
    const c=graphCompile(ex.text);
    if(!c.mode)continue;
    const color=ex.color||GRAPH_COLORS[0];
    ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineCap='round';ctx.lineJoin='round';
    if(c.mode==='function'){
      const vars={...baseVars};
      const samples=[];
      ctx.beginPath();
      let started=false,prevSy=0;
      for(let sx=bx;sx<=bx+bw;sx+=1.5){
        vars.x=toMx(sx);
        let my;try{my=graphEval(c.ast,vars,deg);}catch{my=NaN;}
        const sy=toSy(my);
        const ok=Number.isFinite(sy)&&sy>by-bh*3&&sy<by+bh*4;
        if(ok&&started&&Math.abs(sy-prevSy)<bh*1.5)ctx.lineTo(sx,sy);
        else if(ok){ctx.moveTo(sx,sy);started=true;}
        else started=false;
        if(ok)prevSy=sy;
        samples.push(ok?{sx,sy}:null);
      }
      ctx.stroke();
      if(ex.fill){
        // заливка — отдельным проходом по тем же отсчётам, разрыв там же,
        // где рвётся сама линия (домен/асимптота): каждый непрерывный
        // кусок замыкается через ось X и красится отдельно
        ctx.save();ctx.globalAlpha=0.16;ctx.fillStyle=color;
        let i=0;
        while(i<samples.length){
          while(i<samples.length&&!samples[i])i++;
          const start=i;
          while(i<samples.length&&samples[i])i++;
          const seg=samples.slice(start,i);
          if(seg.length>1){
            ctx.beginPath();ctx.moveTo(seg[0].sx,toSy(0));
            for(const p of seg)ctx.lineTo(p.sx,p.sy);
            ctx.lineTo(seg[seg.length-1].sx,toSy(0));
            ctx.closePath();ctx.fill();
          }
        }
        ctx.restore();
      }
    }else if(c.mode==='parametric'){
      // фиксированный t∈[0,2π] — покрывает один период (окружности,
      // эллипсы, циклоиды и т.п.); настраиваемый диапазон осознанно не
      // делаем — то же поле ввода, что и у обычной функции, без второго
      // ряда настроек под него
      const vars={...baseVars};
      const N=400;
      ctx.beginPath();let started=false,prevSx=0,prevSy=0;
      for(let i=0;i<=N;i++){
        vars.t=(i/N)*6.28318530718;
        let mx,my;
        try{mx=graphEval(c.xAst,vars,deg);my=graphEval(c.yAst,vars,deg);}catch{mx=NaN;my=NaN;}
        const sx=toSx(mx),sy=toSy(my);
        const ok=Number.isFinite(sx)&&Number.isFinite(sy);
        if(ok&&started&&Math.hypot(sx-prevSx,sy-prevSy)<Math.max(bw,bh)*1.5)ctx.lineTo(sx,sy);
        else if(ok){ctx.moveTo(sx,sy);started=true;}
        else started=false;
        if(ok){prevSx=sx;prevSy=sy;}
      }
      ctx.stroke();
    }else if(c.mode==='implicit'){
      paintImplicitCurve(ctx,baseVars,c.lhsAst,c.rhsAst,color,deg,toMx,toMy,bx,by,bw,bh);
    }
  }
  // точки, поставленные вручную — координаты хранятся в математическом
  // пространстве графика, поэтому сами едут вместе с видом при панораме/зуме.
  // Точка, привязанная к кривой (onExpr), своего y не хранит — он всегда
  // пересчитан из актуальной формулы, поэтому переживает и правку формулы,
  // и включение/выключение параметра, от которого формула зависит
  for(const p of (it.props.points||[])){
    const py=graphPointY(it,p,baseVars,deg);
    if(!Number.isFinite(py))continue;
    let color='#1A1C20';
    if(p.onExpr){
      const host=(it.props.expressions||[]).find(e=>e.id===p.onExpr);
      if(host)color=host.color||color;
    }
    const sx=toSx(p.x),sy=toSy(py);
    ctx.fillStyle=color;ctx.strokeStyle='#fff';ctx.lineWidth=1.5*uiScale;
    ctx.beginPath();ctx.arc(sx,sy,4*uiScale,0,6.2832);ctx.fill();ctx.stroke();
    if(p.label){
      ctx.font='700 '+(12*uiScale)+'px ui-sans-serif,system-ui,sans-serif';ctx.fillStyle='#1A1C20';
      ctx.textAlign='left';ctx.textBaseline='bottom';
      ctx.fillText(p.label,sx+6*uiScale,sy-4*uiScale);
    }
  }
  ctx.restore();
  // подписи осей — снаружи клипа не нужны (они внутри рамки), но рисуем уже
  // после кривых и точек, чтобы флажок лежал по-настоящему сверху
  const lbl=graphAxisLabelPos(it);
  drawGraphLegendChip(ctx,lbl.x.wx,lbl.x.wy,it.props.xLabel||'x',lbl.x.size,lbl.x.anchor);
  drawGraphLegendChip(ctx,lbl.y.wx,lbl.y.wy,it.props.yLabel||'y',lbl.y.size,lbl.y.anchor);
  // полоска-«шапка» сверху (GRAPH_HEADER_H) больше не закрашивается видимой
  // серой лентой — это чисто логическая зона для переноса рамки графика
  // (см. пункт про то, что двигает рамку, а что панорамирует вид), рисовать
  // её отдельным элементом не обязательно
  ctx.strokeStyle='rgba(0,0,0,.25)';ctx.lineWidth=1.5*uiScale;ctx.strokeRect(bx,by,bw,bh);
}

function paintPhysics(ctx,it){
  const cx=it.x+it.w/2,cy=it.y+it.h/2,rot=it.rot||0;
  if(it.kind==='light-source'){paintSource(ctx,it);return;}
  if(it.kind==='lens'){paintLens(ctx,it);return;}
  if(it.kind==='mirror'){paintMirror(ctx,it);return;}
  if(it.kind==='heater'){paintHeater(ctx,it);return;}
  if(it.kind==='body'){paintBody(ctx,it);return;}
  if(it.kind==='graph'){paintGraph(ctx,it);return;}
  if(it.kind==='calorimeter'){paintCalorimeter(ctx,it);return;}
  if(it.kind==='magnet'){
    if(!it.props||it.props.showField!==false)paintFieldLines(ctx,it);
    ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);
    const w=it.w,h=it.h;
    ctx.fillStyle='#D8433A';ctx.fillRect(-w/2,-h/2,w/2,h);
    ctx.fillStyle='#2F6FE0';ctx.fillRect(0,-h/2,w/2,h);
    ctx.strokeStyle='rgba(0,0,0,.25)';ctx.lineWidth=1.5;ctx.strokeRect(-w/2,-h/2,w,h);
    ctx.fillStyle='#fff';ctx.font=Math.round(h*0.55)+'px ui-sans-serif,system-ui,sans-serif';
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText('N',-w/4,1);ctx.fillText('S',w/4,1);
    ctx.restore();
    return;
  }
  if(it.kind==='compass'){
    const r=Math.min(it.w,it.h)/2;
    ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);
    ctx.fillStyle='#F4F1E8';ctx.strokeStyle='rgba(0,0,0,.3)';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.arc(0,0,r,0,6.2832);ctx.fill();ctx.stroke();
    ctx.restore();
    // стрелка — по направлению поля, независимо от того, как повёрнут корпус
    const ang=compassAngle(it);
    ctx.save();ctx.translate(cx,cy);ctx.rotate(ang);
    ctx.fillStyle='#D8433A';
    ctx.beginPath();ctx.moveTo(r*0.85,0);ctx.lineTo(0,-r*0.16);ctx.lineTo(0,r*0.16);ctx.closePath();ctx.fill();
    ctx.fillStyle='#B7BCC2';
    ctx.beginPath();ctx.moveTo(-r*0.85,0);ctx.lineTo(0,-r*0.16);ctx.lineTo(0,r*0.16);ctx.closePath();ctx.fill();
    ctx.fillStyle='#1A1C20';ctx.beginPath();ctx.arc(0,0,r*0.1,0,6.2832);ctx.fill();
    ctx.restore();
    return;
  }
}

/** Дуга циркуля: центр, радиус, два угла. Заливки у неё нет — циркуль ничего
    не закрашивает. */
function paintArc(ctx,it){
  if(!(it.r>0))return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(it.cx,it.cy,it.r,it.a0,it.a0+arcSweep(it));
  ctx.lineWidth=it.size;ctx.strokeStyle=it.color;ctx.lineCap='round';
  if(it.dash===1)ctx.setLineDash([it.size*3,it.size*2]);
  else if(it.dash===2)ctx.setLineDash([it.size*0.1,it.size*2]);
  ctx.stroke();
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
  GRAPH_COLORS, GRAPH_HEADER_H, cloneProps, graphAxisLabelPos, graphCompile, graphEval,
  graphExprOk, graphPointY, nextPointLabel, paintArc, paintGraphCoordHint, paintPhysics,
  zoomGraphAt,
};
