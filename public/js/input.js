/* указатель, выделение, ввод надписи, вставка картинок */

import { S, board, items, mkStroke, pushPoint, recordUndo, redoStack, simPressure, stage, toScreen, toWorld } from './core.js';
import { ARC_TYPES, BOX_TYPES, arcSweep, bboxOf, normAngle, rotAround } from './geometry.js';
import { GRAPH_COLORS, GRAPH_HEADER_H, cloneProps, graphCompile, graphEval, nextPointLabel, zoomGraphAt } from './graph.js';
import { hitTest } from './text.js';
import { hint } from './shell.js';
import { angleAt, arcDraft, canEdit, current, dragging, drawId, erasedBatch, eraserR, erasing, handleAt, inSelection, itemAt, itemsIn, lastPen, lastPt, lastT, localXY, marquee, mineOnly, newId, panning, pathDraft, pinch, pointers, pressure, refreshSelBar, select, selectMany, selected, selection, shapeDraft, spaceDown } from './selection.js';
import { applyCursor, camChanged, drawBoard, drawLive, handleCursor, hoverHandleCursor, hoverPt, zoomAt } from './render.js';
import { addItem, deflate, net, removeItem } from './net.js';
import { renderGraphExpressions, renderGraphParams } from './graph-ui.js';
import { pushUndo } from './undo.js';
import { prev, setTool } from './toolbar.js';
import { openMenu, withGroup } from './menu.js';

/* ═══════════════════ ввод ═══════════════════ */
function startMove(w){
  const list=selection.filter(it=>!it.locked);
  if(!list.length)return;
  dragging={mode:'move',list:list.map(it=>({it,start:snapshotItem(it)})),w0:w};
}
/* Неподвижная точка при растяжении: для угла — противоположный угол, для
   середины стороны — середина противоположной стороны. */
const OPPOSITE_CORNER={nw:'se',ne:'sw',sw:'ne',se:'nw',n:'s',s:'n',w:'e',e:'w'};
/* снимок объекта на начало драга — pts копируются глубоко (это отдельные
   {x,y,p}-объекты), иначе before/after в истории ссылались бы на один
   и тот же массив и undo не смог бы восстановить исходную форму */
function snapshotItem(it){
  return {...it, pts: Array.isArray(it.pts)? it.pts.map(p=>({...p})) : it.pts};
}

let tStream=0;
const GEOM_KEYS={
  image:['x','y','w','h','rot','locked'],
  physics:['x','y','w','h','rot','locked'],
  shape:['x','y','w','h','rot','color','size','dash','fill','locked'],
  path:['pts','color','size','dash','fill','a1','a2','locked'],
  // высоты у надписи нет: она считается из числа строк
  text:['x','y','w','rot','text','color','size','bold','italic','locked'],
  // у дуги нет ширины и высоты: только центр, радиус и углы
  arc:['cx','cy','r','a0','a1','color','size','dash','locked'],
  pen:['pts','locked'],marker:['pts','locked']
};
function geomKeys(it){return GEOM_KEYS[it.type]||[];}
/* снимок геометрии для undo/redo — pts всегда глубокая копия {x,y,p}-объектов
   (внутреннее представление), а не проводной формат [x,y,p]-кортежей */
function snapGeom(src,it){
  const o={};
  for(const k of geomKeys(it)) o[k]=(k==='pts'&&Array.isArray(src.pts))?src.pts.map(p=>({...p})):src[k];
  return o;
}
function geomChanged(a,b){
  for(const k in a){
    if(Array.isArray(a[k])){
      if(!Array.isArray(b[k])||a[k].length!==b[k].length)return true;
      for(let i=0;i<a[k].length;i++)if(a[k][i].x!==b[k][i].x||a[k][i].y!==b[k][i].y)return true;
    }else if(a[k]!==b[k])return true;
  }
  return false;
}
/* геометрия для undo хранит pts как {x,y,p}-объекты; сеть/сервер ждут
   те же кортежи [x,y,p], что и deflate() — эта функция переводит одно в другое */
function wireGeom(g){
  if(!('pts' in g))return g;
  // штрихи несут давление (p), у линий/полигонов его нет — кортеж короче
  return {...g, pts:g.pts.map(p=>'p' in p ? [+p.x.toFixed(2),+p.y.toFixed(2),+p.p.toFixed(3)] : [+p.x.toFixed(2),+p.y.toFixed(2)])};
}

function endPointer(e){
  pointers.delete(e.pointerId);
  if(pointers.size<2)pinch=null;
  if(panning){
    const m=panning.menu;
    panning=null;applyCursor();
    if(m){
      const pt=localXY(e);
      const still=Math.hypot(pt.x-m.sx,pt.y-m.sy)<5;
      if(still){
        const w=toWorld(pt.x,pt.y);
        // щёлкнули по объекту вне выделения — сперва выделяем его, как это
        // делают все редакторы, иначе меню относилось бы непонятно к чему
        // Рисовали фигуру — правая кнопка означает «хватит рисовать, дай
        // поработать с нарисованным»: переключаем на выделение, иначе
        // следующий же щелчок начал бы новую фигуру.
        if(S.tool==='shape'||S.tool==='path'){abortDraft();setTool('select');}
        const under=itemAt(w);
        if(under&&mineOnly(under)&&!inSelection(under))selectMany(withGroup([under]));
        else if(!under)select(null);
        openMenu({x:e.clientX,y:e.clientY},w);
        return;
      }
    }
  }
  if(dragging&&dragging.mode==='graphPan'){
    // панорама вида — не «содержимое», а состояние камеры графика (как и
    // S.cam самой доски), поэтому в историю отмен не идёт; отправляем один
    // раз по отпусканию, а не на каждый pointermove — так же, как обычный
    // перенос объекта шлёт итоговую позицию только в конце жеста
    net.send({t:'move',id:dragging.it.id,props:{...dragging.it.props}});
    dragging=null;
    refreshSelBar();
  }else if(dragging&&dragging.mode==='graphPointDrag'){
    // точку, вынесенную за пределы графика, не оставляем висеть снаружи —
    // это и есть способ её удалить, без отдельной кнопки/меню под неё
    const g=dragging.it, wEnd=toWorld(localXY(e).x,localXY(e).y);
    const outside=wEnd.x<g.x||wEnd.x>g.x+g.w||wEnd.y<g.y+GRAPH_HEADER_H||wEnd.y>g.y+g.h;
    if(outside&&g.props.points)g.props.points.splice(dragging.index,1);
    g.bbox=null;
    const after=cloneProps(g.props);
    if(JSON.stringify(dragging.before)!==JSON.stringify(after)){
      pushUndo([{type:'move',id:g.id,before:{props:dragging.before},after:{props:after}}]);
      net.send({t:'move',id:g.id,props:after});
    }
    if(outside)hint('Точка удалена');
    dragging=null;
    refreshSelBar();drawBoard();
  }else if(dragging){
    // перенос группы — одна запись в истории на весь жест, иначе Ctrl+Z
    // возвращал бы объекты по одному
    const parts=dragging.list||[{it:dragging.it,start:dragging.start}];
    const ops=[];
    for(const m of parts){
      const before=snapGeom(m.start,m.it), after=snapGeom(m.it,m.it);
      if(geomChanged(before,after))ops.push({type:'move',id:m.it.id,before,after});
    }
    if(ops.length){
      for(const o of ops)net.send({t:'move',id:o.id,...wireGeom(o.after)});
      pushUndo(ops);
    }
    dragging=null;
    refreshSelBar();                     // жест кончился — панель возвращается
  }
  if(marquee){
    const m=marquee;marquee=null;
    const rect={x0:Math.min(m.a.x,m.b.x),y0:Math.min(m.a.y,m.b.y),
                x1:Math.max(m.a.x,m.b.x),y1:Math.max(m.a.y,m.b.y)};
    // короткий тычок — это снятие выделения, а не выбор всего под точкой
    if(Math.max(rect.x1-rect.x0,rect.y1-rect.y0)*S.cam.z>=4){
      const found=itemsIn(rect);
      const add=e.shiftKey||e.ctrlKey||e.metaKey;
      selectMany(add?selection.concat(found.filter(it=>!inSelection(it))):found);
      if(selection.length>1)hint('Выделено объектов: '+selection.length+' · тащите за любой из них');
    }
    refreshSelBar();
    drawLive();
  }
  if(arcDraft){
    const d=arcDraft;arcDraft=null;
    // совсем маленькую дугу не заводим: это был случайный тычок
    if(d.a0!==null&&d.r*S.cam.z>=6&&Math.abs(d.a1-d.a0)*d.r*S.cam.z>=4){
      const it={id:newId(),by:S.me&&S.me.uid,type:'arc',
                cx:d.cx,cy:d.cy,r:d.r,a0:d.a0,a1:d.a1,
                color:S.color,size:S.size,dash:S.dash,
                g:null,locked:false,bbox:null};
      addItem(it);
      pushUndo([{type:'add',item:it}]);
      net.send({t:'add',item:deflate(it)});
    }
    drawLive();
  }
  if(shapeDraft){
    const d=shapeDraft;shapeDraft=null;
    const x0=Math.min(d.a.x,d.b.x), y0=Math.min(d.a.y,d.b.y);
    const w0=Math.abs(d.b.x-d.a.x), h0=Math.abs(d.b.y-d.a.y);
    if(Math.max(w0,h0)*S.cam.z>=3){
      const it={id:newId(),by:S.me&&S.me.uid,type:'shape',kind:d.kind,
                x:x0,y:y0,w:Math.max(0.5,w0),h:Math.max(0.5,h0),rot:0,
                color:S.color,size:S.size,dash:S.dash,fill:S.fill,locked:false};
      addItem(it);
      recordUndo({type:'add',item:it});redoStack.length=0;
      net.send({t:'add',item:deflate(it)});
    }
    drawLive();
  }
  if(pathDraft&&pathDraft.mode==='drag'){
    const d=pathDraft;pathDraft=null;
    if(Math.hypot(d.pts[1].x-d.pts[0].x,d.pts[1].y-d.pts[0].y)*S.cam.z>=3)commitPath(d.kind,d.pts);
    drawLive();
  }
  if(erasing){erasing=null;commitErase();}
  if(current&&e.pointerId===drawId)commit();
}
function simplifyStroke(pts,eps,pEps){
  const n=pts.length; if(n<3)return pts;
  const keep=new Uint8Array(n); keep[0]=keep[n-1]=1;
  const stack=[[0,n-1]];
  while(stack.length){
    const [a,b]=stack.pop(); if(b-a<2)continue;
    const ax=pts[a].x,ay=pts[a].y,dx=pts[b].x-ax,dy=pts[b].y-ay;
    const len=Math.hypot(dx,dy)||1;
    let far=-1,best=eps;
    for(let i=a+1;i<b;i++){
      const d=Math.abs((pts[i].x-ax)*dy-(pts[i].y-ay)*dx)/len;
      if(d>best){best=d;far=i;}
    }
    if(far>0){keep[far]=1;stack.push([a,far],[far,b]);}
  }
  // нажим задаёт толщину: где он заметно гулял, точку возвращаем
  const gaps=[];
  for(let i=1,prev=0;i<n;i++){ if(!keep[i])continue; if(i-prev>1)gaps.push([prev,i]); prev=i; }
  while(gaps.length){
    const [a,b]=gaps.pop();
    const p0=pts[a].p==null?0.5:pts[a].p, p1=pts[b].p==null?0.5:pts[b].p;
    let far=-1,best=pEps;
    for(let j=a+1;j<b;j++){
      const pj=pts[j].p==null?0.5:pts[j].p;
      const d=Math.abs(pj-(p0+(p1-p0)*((j-a)/(b-a))));
      if(d>best){best=d;far=j;}
    }
    if(far>0){keep[far]=1;
      if(far-a>1)gaps.push([a,far]);
      if(b-far>1)gaps.push([far,b]);}
  }
  const out=[];
  for(let i=0;i<n;i++)if(keep[i])out.push(pts[i]);
  return out;
}

function commit(){
  const s=current;current=null;drawId=null;drawLive();
  if(!s||!s.pts.length)return;
  net.stream(s);                       // досылаем хвост живого штриха соседям
  s.pts=simplifyStroke(s.pts,0.35/S.cam.z,0.06);
  s.bbox=null;
  addItem(s);
  recordUndo({type:'add',item:s});redoStack.length=0;
  net.send({t:'add',item:deflate(s)});net.sid=null;net.sent=0;
}
function abortStroke(){if(current){current=null;drawId=null;net.sid=null;drawLive();}}
function abortDraft(){
  if(shapeDraft){shapeDraft=null;drawLive();}
  if(pathDraft){pathDraft=null;drawLive();}
  if(marquee){marquee=null;drawLive();}
}
/* коммит новой линии/полилинии/кривой/полигона — общий выход и для
   drag-режима (line/arrow), и для расстановки вершин кликами */
/* ═══════════════════ ввод надписи ═══════════════════
   Печатаем в настоящем textarea поверх холста: своя каретка, выделение,
   раскладки и подсказки клавиатуры на планшете достаются даром, а рисовать их
   в canvas пришлось бы руками. */
const textEdit=document.getElementById('textEdit');
let editing=null;                    // {item, isNew, w}

function openTextEditor(at,item){
  if(!canEdit())return hint('Преподаватель закрыл доску для правок');
  closeTextEditor(true);
  const size=item?item.size:Math.max(12,S.size*4);
  const w=item?item.w:280;
  editing={item:item||null,isNew:!item,x:item?item.x:at.x,y:item?item.y:at.y,size,w};
  const p=toScreen(editing.x,editing.y);
  textEdit.value=item?item.text:'';
  textEdit.style.left=p.x+'px';
  textEdit.style.top=p.y+'px';
  textEdit.style.width=(w*S.cam.z)+'px';
  textEdit.style.fontSize=(size*S.cam.z)+'px';
  textEdit.style.color=item?item.color:S.color;
  textEdit.style.fontWeight=item&&item.bold?'600':'400';
  textEdit.style.fontStyle=item&&item.italic?'italic':'normal';
  textEdit.classList.remove('hidden');
  if(item){item.hidden=true;drawBoard();}      // редактируемое не двоится
  autoGrowText();
  setTimeout(()=>{textEdit.focus();textEdit.select();},0);
}
function autoGrowText(){
  textEdit.style.height='auto';
  textEdit.style.height=Math.max(textEdit.scrollHeight,parseFloat(textEdit.style.fontSize)*1.28)+'px';
}
function closeTextEditor(save){
  if(!editing)return;
  const ed=editing;editing=null;
  const body=textEdit.value;
  textEdit.classList.add('hidden');textEdit.value='';
  if(ed.item)delete ed.item.hidden;

  if(!save||!body.trim()){
    // пустую надпись не заводим, а у существующей отмена возвращает прежний вид
    drawBoard();return;
  }
  if(ed.item){
    if(ed.item.text===body){drawBoard();return;}
    const before=snapGeom(ed.item,ed.item);
    ed.item.text=body;ed.item.bbox=null;
    pushUndo([{type:'move',id:ed.item.id,before,after:snapGeom(ed.item,ed.item)}]);
    net.send({t:'move',id:ed.item.id,text:body});
    drawBoard();return;
  }
  const it={id:newId(),by:S.me&&S.me.uid,type:'text',text:body,
            x:ed.x,y:ed.y,w:ed.w,rot:0,color:S.color,size:ed.size,
            bold:false,italic:false,g:null,locked:false,bbox:null};
  addItem(it);
  pushUndo([{type:'add',item:it}]);
  net.send({t:'add',item:deflate(it)});
  setTool('select');select(it);
}

function commitPath(kind,pts){
  const it={id:newId(),by:S.me&&S.me.uid,type:'path',kind,
            pts:pts.map(p=>({x:p.x,y:p.y})),closed:kind==='polygon',
            color:S.color,size:S.size,dash:S.dash,
            fill:kind==='polygon'?S.fill:null,
            a1:S.a1||0,a2:S.a2||0,locked:false,bbox:null};
  addItem(it);
  net.send({t:'add',item:deflate(it)});
  const ops=[{type:'add',item:it}];
  const label=applyPhysicsLabel(kind,pts);         // транспортир/линейка — подпись рядом
  if(label)ops.push(label);
  pushUndo(ops);
}
function commitPathDraft(){
  if(!pathDraft)return;
  const d=pathDraft;pathDraft=null;
  let minPts=d.kind==='polygon'?3:2;
  if(S.physicsPreset==='protractor')minPts=3;     // транспортиру нужна вершина и два луча
  if(d.pts.length>=minPts)commitPath(d.kind,d.pts);
  drawLive();
}
/* Физические пресеты (транспортир/линейка/вектор) — не отдельный тип объекта
   на сервере, а обычная «линия»/«ломаная», у транспортира и линейки —
   с текстовой подписью рядом: персист/отмена/синхронизация у обоих типов уже
   есть, заводить третий не пришлось. У вектора подписи нет — это просто
   стрелка с аккуратным остриём (style 4 в drawArrowhead), значение при
   желании учитель подписывает сам обычным инструментом «Текст». */
function applyPhysicsLabel(kind,pts){
  const preset=S.physicsPreset;
  if(!preset)return null;
  if(preset==='protractor'&&kind==='polyline'&&pts.length>=3){
    const b=pts[pts.length-1],v=pts[pts.length-2],a=pts[pts.length-3];
    return addTextLabel(v,Math.round(angleAt(a,v,b))+'°');
  }
  if(preset==='ruler'&&kind==='line'&&pts.length===2){
    const len=Math.round(Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));
    const mid={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};
    return addTextLabel(mid,'≈ '+len+' px');
  }
  return null;
}
/** Угол ABC в вершине b (градусы, 0..180). Общая для подписи после отрисовки
    и для живой подсказки во время неё (см. drawLive/pathDraft ниже). */
function addTextLabel(at,text){
  const it={id:newId(),by:S.me&&S.me.uid,type:'text',text,
            x:at.x,y:at.y,w:140,rot:0,color:S.color,size:Math.max(14,S.size*3),
            bold:false,italic:false,g:null,locked:false,bbox:null};
  addItem(it);
  net.send({t:'add',item:deflate(it)});
  return {type:'add',item:it};
}

function eraseAt(pt){
  const w=toWorld(pt.x,pt.y),r=eraserR();
  for(let i=items.length-1;i>=0;i--){
    const it=items[i];
    if(!mineOnly(it))continue;
    if(hitTest(it,w,r)){
      if(selected&&selected.id===it.id)select(null);
      erasedBatch.push(it);removeItem(it.id);drawBoard();
    }
  }
}
function commitErase(){
  if(!erasedBatch.length)return;
  net.send({t:'erase',ids:erasedBatch.map(i=>i.id)});
  recordUndo({type:'erase',items:erasedBatch.slice()});redoStack.length=0;
  erasedBatch=[];
}

/* колесо: масштаб. Shift+колесо и пробел — панорама */
// Панорамирование ЛКМ считает камеру абсолютно от точки старта жеста
// (panning.cx/cy + сдвиг от panning.sx/sy) — если колесо/Shift-прокрутка
// поменяет S.cam посреди этого жеста, а точку старта не обновить, то на
// следующем pointermove панорама перепишет камеру по старой опорной точке
// и всё, что сделал зум, схлопнется одним резким скачком. Пересинхронизируем
// опору на текущее положение сразу после любого стороннего сдвига камеры.
const resyncPanning=p=>{
  if(!panning)return;
  panning.cx=S.cam.x;panning.cy=S.cam.y;panning.sx=p.x;panning.sy=p.y;
};
let graphZoomSyncTimer=null;
const UPLOADABLE=new Set(['image/png','image/jpeg','image/webp','image/gif']);
/* Скриншот из буфера обмена приходит в PNG — формат без потерь, и для снимка
   экрана это впустую: на настоящих файлах WebP при q0.85 даёт вдвое-впятеро
   меньше при расхождении меньше полутора уровней яркости из 255, чего не
   видно. Перекодируем в браузере: сервер остаётся без графических библиотек,
   а по сети уходит уже сжатое.

   Снимок с экрана 4K шириной 3840 точек на доске показывается примерно в
   1300 — хранить его целиком незачем. Ужимаем длинную сторону до 2560, чтобы
   оставался запас на приближение вдвое.

   Если перекодирование не выиграло (а на мелких картинках PNG иногда лучше),
   отправляем исходник: лучше сохранить как есть, чем ухудшить без выгоды. */
const IMG_MAX_SIDE=2560, IMG_QUALITY=0.85;

async function prepareImage(blob){
  let bmp;
  try{ bmp=await createImageBitmap(blob); }
  catch{ return blob; }                       // не распознали — пусть решает сервер
  const k=Math.min(1,IMG_MAX_SIDE/Math.max(bmp.width,bmp.height));
  const w=Math.max(1,Math.round(bmp.width*k)), h=Math.max(1,Math.round(bmp.height*k));

  const c=document.createElement('canvas');c.width=w;c.height=h;
  const cx=c.getContext('2d');
  cx.imageSmoothingEnabled=true;cx.imageSmoothingQuality='high';
  cx.drawImage(bmp,0,0,w,h);

  let out=await new Promise(r=>c.toBlob(r,'image/webp',IMG_QUALITY));
  // Safari до 14 не умеет кодировать WebP и отдаёт PNG — там хотя бы уменьшим
  if(!out||!/webp/.test(out.type))
    out=await new Promise(r=>c.toBlob(r,'image/png'));
  if(!out) return UPLOADABLE.has(blob.type)?blob:null;

  if(k===1&&out.size>=blob.size&&UPLOADABLE.has(blob.type))return blob;
  return out;
}

async function placeImage(blob,screenPt){
  if(!canEdit())return hint('Преподаватель закрыл доску для правок');
  if(!S.boardId)return;
  try{
    hint('Загружаю картинку…');
    const file=await prepareImage(blob);
    if(!file)throw new Error('не удалось прочитать картинку');
    const bmp=await createImageBitmap(file);
    const r=await fetch('/api/upload?board='+encodeURIComponent(S.boardId),
      {method:'POST',credentials:'same-origin',headers:{'content-type':file.type},body:file});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||'ошибка загрузки');

    // вписываем в 70 % видимой области, сохраняя пропорции
    const vw=board.clientWidth/S.cam.z, vh=board.clientHeight/S.cam.z;
    const k=Math.min(1,vw*0.7/bmp.width,vh*0.7/bmp.height);
    const w=bmp.width*k, h=bmp.height*k;
    const c=screenPt?toWorld(screenPt.x,screenPt.y):toWorld(board.clientWidth/2,board.clientHeight/2);
    const it={id:newId(),by:S.me&&S.me.uid,type:'image',url:data.url,
              x:c.x-w/2,y:c.y-h/2,w,h,rot:0,locked:false};
    addItem(it);
    recordUndo({type:'add',item:it});redoStack.length=0;
    net.send({t:'add',item:deflate(it)});
    setTool('select');select(it);
    hint('Картинка вставлена: тяните за углы, чтобы изменить размер');
  }catch(err){hint('Не получилось: '+err.message);}
}

/* Объект-симуляция ставится кликом, как штамп — без загрузки файла, размер
   фиксирован под конкретный вид. Дальше это обычный box-объект: тянется,
   вращается, ресайзится теми же ручками, что и картинка. Свойства (сила
   поля и т.п.) настраиваются ДО постановки — см. physicsPanel ниже — и
   берутся из черновика S.physicsProps, а не задаются задним числом. */
const PHYSICS_SIZE={magnet:{w:96,h:34},compass:{w:64,h:64},
  'light-source':{w:40,h:40},lens:{w:14,h:110},mirror:{w:14,h:130},
  heater:{w:56,h:44},body:{w:90,h:70},calorimeter:{w:180,h:140},graph:{w:280,h:220}};
const PHYSICS_TITLE={magnet:'Магнит',compass:'Компас','light-source':'Источник луча',lens:'Линза',mirror:'Зеркало',
  heater:'Нагреватель',body:'Тело',calorimeter:'Калориметр',graph:'График'};
function placePhysics(kind,w){
  if(!canEdit())return hint('Преподаватель закрыл доску для правок');
  const size=PHYSICS_SIZE[kind]||{w:60,h:60};
  const props=kind==='magnet'?{...S.physicsProps.magnet}
    :kind==='light-source'?{...S.physicsProps['light-source']}
    :kind==='lens'?{focal:(S.physicsSign||1)*Math.abs(S.physicsProps.lens.focal)}
    :kind==='heater'?{...S.physicsProps.heater}
    :kind==='body'?{material:S.physicsProps.body.material,mass:S.physicsProps.body.mass,
                    energyJoules:0,elapsedSeconds:0,started:false}
    :kind==='graph'?{view:{cx:0,cy:0,scale:40},
                      expressions:[{id:newId(),text:'',color:GRAPH_COLORS[0],visible:true,fill:false}],
                      points:[],xLabel:'x',yLabel:'y',angleMode:'rad',params:[],labelSize:13}
    :{};
  const it={id:newId(),by:S.me&&S.me.uid,type:'physics',kind,
            x:w.x-size.w/2,y:w.y-size.h/2,w:size.w,h:size.h,rot:0,locked:false,props};
  addItem(it);
  recordUndo({type:'add',item:it});redoStack.length=0;
  net.send({t:'add',item:deflate(it)});
  setTool('select');select(it);
  hint((PHYSICS_TITLE[kind]||'Объект')+' поставлен: тяните и вращайте как обычно');
}

/* Панель свойств физ.объекта. Для всех видов, кроме графика, открывается
   ДО того, как объект появился на доске: выбор в доп.меню переводит в
   инструмент «physics» и показывает эту панель — клик по холсту ставит
   объект уже с выбранными значениями (значения живут в S.physicsProps —
   черновик на весь сеанс, как цвет пера).

   У графика настраивать до постановки нечего (пустая плоскость), зато
   после — список формул нужен постоянно, не один раз. Поэтому для kind
   'graph' эта же панель включается ПОСЛЕ: как только график выделен на
   доске (обычным инструментом «выделить»), а не только в момент, когда
   его ставят инструментом «physics» — см. editingGraph ниже. Выбор
   другого объекта или снятие выделения закрывает её сами собой через
   тот же путь, что обновляет панель выделения (selectMany→refreshSelBar). */
function updatePhysicsPanel(){
  const panel=document.getElementById('physicsPanel');
  const editingGraph=S.tool==='select'&&selected&&selected.type==='physics'&&selected.kind==='graph';
  const placing=S.tool==='physics'&&!!S.physicsKind;
  const on=(placing||editingGraph)&&!!S.boardId;
  panel.classList.toggle('hidden',!on);
  if(!on)return;
  const kind=editingGraph?'graph':S.physicsKind;
  const title=kind==='lens'?(PHYSICS_TITLE.lens+' ('+((S.physicsSign||1)>0?'собирающая':'рассеивающая')+')')
                            :(PHYSICS_TITLE[kind]||'Объект');
  document.getElementById('physicsPanelTitle').textContent=title;
  document.getElementById('physicsMagnetRow').classList.toggle('hidden',kind!=='magnet');
  document.getElementById('physicsSourceRow').classList.toggle('hidden',kind!=='light-source');
  document.getElementById('physicsLensRow').classList.toggle('hidden',kind!=='lens');
  document.getElementById('physicsHeaterRow').classList.toggle('hidden',kind!=='heater');
  document.getElementById('physicsBodyRow').classList.toggle('hidden',kind!=='body');
  document.getElementById('physicsGraphRow').classList.toggle('hidden',kind!=='graph');
  document.getElementById('physicsPlaceHint').classList.toggle('hidden',kind==='graph');
  if(kind==='graph'){
    renderGraphExpressions();
    document.getElementById('physicsGraphPostOnly').classList.toggle('hidden',!editingGraph);
    if(editingGraph){
      renderGraphParams();
      document.getElementById('physGraphDeg').textContent=selected.props.angleMode==='deg'?'град':'рад';
      const ls=selected.props.labelSize||13;
      document.getElementById('physLabelSize').value=ls;
      document.getElementById('physLabelSizeVal').textContent=ls;
    }
    return;
  }
  if(kind==='magnet'){
    const p=S.physicsProps.magnet;
    document.getElementById('physShowField').checked=p.showField;
    document.getElementById('physStrength').value=p.strength;
    document.getElementById('physStrengthVal').textContent=p.strength.toFixed(1);
  }else if(kind==='light-source'){
    const p=S.physicsProps['light-source'];
    document.getElementById('physRayCount').value=p.rayCount;
    document.getElementById('physRayCountVal').textContent=p.rayCount;
    document.getElementById('physSpread').value=p.spreadDeg;
    document.getElementById('physSpreadVal').textContent=p.spreadDeg.toFixed(1);
  }else if(kind==='lens'){
    document.getElementById('physFocal').value=S.physicsProps.lens.focal;
    document.getElementById('physFocalVal').textContent=Math.round(S.physicsProps.lens.focal);
  }else if(kind==='heater'){
    document.getElementById('physPower').value=S.physicsProps.heater.power;
    document.getElementById('physPowerVal').textContent=Math.round(S.physicsProps.heater.power);
  }else if(kind==='body'){
    const p=S.physicsProps.body;
    document.getElementById('physMaterial').value=p.material;
    document.getElementById('physMass').value=p.mass*1000;
    document.getElementById('physMassVal').textContent=Math.round(p.mass*1000);
  }
}

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
stage.addEventListener('pointerdown',e=>{
  // Захват иногда невозможен (указатель уже отпущен, у устройства отобрали
  // событие) и бросает NotFoundError. Без try весь обработчик обрывался бы
  // на первой строке, и жест пропадал целиком.
  try{stage.setPointerCapture(e.pointerId);}catch{}
  // Указатель иногда «теряется»: capture выше не удался (см. коммент к try),
  // либо кнопку отпустили за пределами окна/вкладки — тогда ни pointerup, ни
  // pointercancel не приходят, и старая запись в pointers навсегда виснет.
  // Настоящий пинч — это две точки, шевелящиеся ОДНОВРЕМЕННО; у зависшей
  // координата не обновлялась уже давно. Чистим такие перед тем, как решать,
  // пинч это или нет — иначе следующий обычный клик мышью попадёт в
  // pointers.size===2 вместе с координатой из давно завершённого жеста, и
  // зум/панорама прыгнут туда, а не к месту клика (см. zoomAt/pinch ниже).
  const now=performance.now();
  for(const[id,p]of pointers)if(id!==e.pointerId&&now-p.t>250)pointers.delete(id);
  pointers.set(e.pointerId,{...localXY(e),t:now});
  if(e.pointerType==='pen')lastPen=now;
  if(e.pointerType==='touch'&&now-lastPen<900)return;

  if(pointers.size===2){
    abortStroke();abortDraft();
    const[a,b]=[...pointers.values()];
    pinch={d:Math.hypot(a.x-b.x,a.y-b.y),c:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};return;
  }
  if(pointers.size>2)return;

  const pt=localXY(e), w=toWorld(pt.x,pt.y);
  if(S.tool==='hand'||spaceDown||e.button===1||e.button===2){
    // Правая кнопка делает два дела: тянет холст и открывает меню. Различаем по
    // тому, сдвинулась ли рука: потянули — панорама, щёлкнули на месте — меню.
    panning={sx:pt.x,sy:pt.y,cx:S.cam.x,cy:S.cam.y,
             menu:e.button===2?{sx:pt.x,sy:pt.y,t:performance.now()}:null};
    applyCursor();return;
  }
  if(e.button!==0&&e.pointerType==='mouse')return;

  // Начали действие любым инструментом, кроме «выделить», — прежнее
  // выделение снимаем сразу. Раньше оно переживало переключение на перо и
  // оставалось видимым (рамка, ручки) поверх уже начатого рисования.
  if(S.tool!=='select'&&selected)select(null);

  /* циркуль: нажали — поставили ножку, ведём — разводим и обводим */
  if(S.tool==='arc'){
    if(!canEdit())return hint('Преподаватель закрыл доску для правок');
    arcDraft={cx:w.x,cy:w.y,r:0,a0:null,a1:0};
    return;
  }

  /* надпись: щелчок ставит её туда, куда указали */
  if(S.tool==='text'){
    const under=itemAt(w);
    if(under&&under.type==='text'&&mineOnly(under))openTextEditor(null,under);
    else openTextEditor(w,null);
    return;
  }

  /* выделение объектов */
  if(S.tool==='select'){
    const h=handleAt(pt);
    if(h&&selected&&!selected.locked){
      if(h.kind==='rotate'){
        const b=bboxOf(selected);
        const cx=BOX_TYPES.has(selected.type)?selected.x+selected.w/2:(b.x0+b.x1)/2;
        const cy=BOX_TYPES.has(selected.type)?selected.y+selected.h/2:(b.y0+b.y1)/2;
        dragging={mode:'rotate',it:selected,start:snapshotItem(selected),cx,cy,
                  a0:Math.atan2(w.y-cy,w.x-cx)};
      }else if(h.kind==='angle'){
        dragging={mode:'angle',it:selected,end:h.end,start:snapshotItem(selected)};
      }else if(h.kind==='vertex'){
        dragging={mode:'vertex',it:selected,index:h.index,start:snapshotItem(selected)};
      }else if(h.kind==='graphPoint'){
        dragging={mode:'graphPointDrag',it:selected,index:h.index,before:cloneProps(selected.props)};
      }else if(h.kind==='axisLabel'){
        const cur=h.axis==='x'?(selected.props.xLabel||'x'):(selected.props.yLabel||'y');
        const name=prompt('Название оси:',cur);
        if(name&&name.trim()){
          const before=cloneProps(selected.props);
          if(h.axis==='x')selected.props.xLabel=name.trim().slice(0,12);
          else selected.props.yLabel=name.trim().slice(0,12);
          selected.bbox=null;
          pushUndo([{type:'move',id:selected.id,before:{props:before},after:{props:cloneProps(selected.props)}}]);
          net.send({t:'move',id:selected.id,props:{...selected.props}});
          drawBoard();
        }
      }else{
        const anchor=OPPOSITE_CORNER[h.name];
        const geom=snapshotItem(selected);
        // по какой оси тянем: у середины стороны — только по одной
        const axis=h.kind==='edge'?(h.name==='n'||h.name==='s'?'y':'x'):'xy';
        let anchorWorld,rot0=0;
        if(BOX_TYPES.has(selected.type)){
          rot0=geom.rot||0;
          const stcx=geom.x+geom.w/2, stcy=geom.y+geom.h/2;
          const ax0=axis==='y'?0:(anchor.includes('e')?geom.w/2:-geom.w/2);
          const ay0=axis==='x'?0:(anchor.includes('s')?geom.h/2:-geom.h/2);
          const p=rotAround(stcx+ax0,stcy+ay0,stcx,stcy,rot0);
          anchorWorld={x:p.x,y:p.y};
        }else{
          const b0=bboxOf(geom);
          anchorWorld={
            x:axis==='y'?(b0.x0+b0.x1)/2:(anchor.includes('e')?b0.x1:b0.x0),
            y:axis==='x'?(b0.y0+b0.y1)/2:(anchor.includes('s')?b0.y1:b0.y0)
          };
        }
        dragging={mode:'resize',it:selected,corner:h.name,anchor,axis,anchorWorld,rot0,start:geom};
      }
      return;
    }
    const im=itemAt(w);
    const add=e.shiftKey||e.ctrlKey||e.metaKey;
    if(im&&mineOnly(im)&&canEdit()){
      if(add){
        // Shift/Ctrl — добираем и убираем объекты по одному, не начиная перенос:
        // иначе тот же жест и добавлял бы, и сразу тащил
        selectMany(inSelection(im)?selection.filter(s=>s.id!==im.id):selection.concat([im]));
        return;
      }
      // клик по уже выделенной группе её сохраняет; объекты одной группы
      // берутся вместе
      if(!inSelection(im))selectMany(withGroup([im]));
      // у графика тело — это его координатная плоскость: тащат не рамку, а
      // сам вид (панорама), как в Desmos; переставить рамку целиком можно
      // только за узкую полоску сверху (см. GRAPH_HEADER_H/paintGraph).
      // Заблокированный объект не трогаем вовсе — как и обычный перенос,
      // который startMove ниже сам отфильтрует по .locked.
      if(im.type==='physics'&&im.kind==='graph'&&!im.locked&&(w.y-im.y)>GRAPH_HEADER_H){
        dragging={mode:'graphPan',it:im,start:{cx:im.props.view.cx,cy:im.props.view.cy},w0:w};
        return;
      }
      startMove(w);
      return;
    }
    // пусто под курсором — тянем рамку выделения
    if(!add)select(null);
    if(canEdit()){marquee={a:w,b:w};refreshSelBar();}
    drawLive();
    return;
  }
  if(!canEdit()){hint('Преподаватель закрыл доску для рисования');return;}

  if(S.tool==='shape'){
    shapeDraft={kind:S.shapeKind,a:w,b:w};
    drawLive();return;
  }

  if(S.tool==='physics'){
    placePhysics(S.physicsKind,w);
    return;
  }

  if(S.tool==='path'){
    if(S.pathKind==='line'){
      pathDraft={kind:'line',pts:[w,w],mode:'drag'};
    }else if(!pathDraft||pathDraft.mode!=='vertex'||pathDraft.kind!==S.pathKind){
      pathDraft={kind:S.pathKind,pts:[w],mode:'vertex'};
    }else{
      const last=pathDraft.pts[pathDraft.pts.length-1];
      const dupTol=4/S.cam.z;
      const first=pathDraft.pts[0];
      const closeTol=8/S.cam.z;
      if(Math.hypot(w.x-last.x,w.y-last.y)<dupTol){
        // вероятно второй клик двойного клика — не дублируем вершину, ждём dblclick
      }else if(pathDraft.kind==='polygon'&&pathDraft.pts.length>=3&&Math.hypot(w.x-first.x,w.y-first.y)<closeTol){
        commitPathDraft();
      }else{
        pathDraft.pts.push(w);
      }
    }
    drawLive();return;
  }

  if(S.tool==='eraser'){erasing=true;eraseAt(pt);return;}

  /* Толщина хранится в единицах доски, а не экрана.

     Раньше писали S.size/S.cam.z: линия выглядела одинаково в момент
     рисования, но на доске оставалась разной. Замер это подтвердил: при
     настройке «4» на увеличении 100% сохранялось 4, на 51% — 7.8, на 17% —
     23.8. Две линии с одной и той же настройкой отличались в шесть раз, и
     это было видно, стоило вернуться к обычному увеличению.

     Теперь «4» — это всегда 4 на доске, как чернила на бумаге: приближение
     просто увеличивает написанное. Расплата честная: рисуя сильно отдалённым,
     линию видно тонкой — потому что она и есть маленькая для этой доски. */
  drawId=e.pointerId;
  current=mkStroke(S.tool,S.color,S.size,newId(),S.me&&S.me.uid);
  pressure=(e.pointerType==='pen'&&e.pressure>0)?e.pressure:0.42;
  lastPt=pt;lastT=performance.now();
  pushPoint(current,w.x,w.y,pressure);
  net.startStroke(current);drawLive();
});

stage.addEventListener('pointermove',e=>{
  const pt=localXY(e);
  if(pointers.has(e.pointerId))pointers.set(e.pointerId,{...pt,t:performance.now()});
  hoverPt=pt;                                  // нужна и ластику, и вставке скрина
  if(S.tool==='eraser')drawLive();
  // наведение на график — координаты под курсором должны обновляться на
  // каждое движение мыши, а не только пока что-то тащат
  if(S.tool==='select'&&!dragging){
    const g=itemAt(toWorld(pt.x,pt.y));
    if(g&&g.type==='physics'&&g.kind==='graph')drawLive();
  }
  // резиновая линия к курсору в режиме расстановки вершин — работает и без
  // нажатой кнопки (обычное наведение), поэтому проверяется независимо от
  // pinch/panning/dragging ниже
  if(pathDraft&&pathDraft.mode==='vertex'){pathDraft.live=toWorld(pt.x,pt.y);drawLive();}

  if(pinch&&pointers.size>=2){
    const[a,b]=[...pointers.values()];
    const d=Math.hypot(a.x-b.x,a.y-b.y),c={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    S.cam.x+=c.x-pinch.c.x;S.cam.y+=c.y-pinch.c.y;
    // Пальцы у пинча редко идеально разведены на старте жеста: если в момент
    // касания они оказались в паре пикселей друг от друга, d/pinch.d в первом
    // же кадре даёт огромное отношение (деление на почти-ноль) — доску рвёт
    // масштабом и швыряет в сторону. Тот же предел на кадр, что и у колеса.
    if(pinch.d>4)zoomAt(c.x,c.y,Math.min(1.22,Math.max(0.82,d/pinch.d)));
    pinch={d,c};camChanged();return;
  }
  if(panning){
    S.cam.x=panning.cx+(pt.x-panning.sx);S.cam.y=panning.cy+(pt.y-panning.sy);
    camChanged();refreshSelBar();return;
  }
  if(dragging){
    const w=toWorld(pt.x,pt.y);
    // Панель прячем с первым движением, а не с нажатием: иначе она мигала бы
    // на каждом клике по объекту, который просто выделяют.
    if(!dragging.barHidden){dragging.barHidden=true;refreshSelBar();}
    if(dragging.mode==='move'){
      const dx=w.x-dragging.w0.x, dy=w.y-dragging.w0.y;
      for(const m of dragging.list){
        const t=m.it, s0=m.start;
        if(BOX_TYPES.has(t.type)){ t.x=s0.x+dx; t.y=s0.y+dy; }
        else if(ARC_TYPES.has(t.type)){ t.cx=s0.cx+dx; t.cy=s0.cy+dy; }
        else if(Array.isArray(s0.pts)) t.pts=s0.pts.map(p=>('p' in p)?{x:p.x+dx,y:p.y+dy,p:p.p}:{x:p.x+dx,y:p.y+dy});
        t.bbox=bboxOf(t);
      }
      drawBoard();refreshSelBar();drawLive();return;
    }
    if(dragging.mode==='graphPan'){
      // та же арифметика, что у панорамы всей доски, только в координатах
      // объекта и с отражённым Y (в математике «вверх» положительно)
      const dx=w.x-dragging.w0.x, dy=w.y-dragging.w0.y;
      const view=dragging.it.props.view, scale=view.scale||40;
      view.cx=dragging.start.cx-dx/scale;
      view.cy=dragging.start.cy+dy/scale;
      dragging.it.bbox=null;
      drawBoard();refreshSelBar();drawLive();return;
    }
    if(dragging.mode==='graphPointDrag'){
      // абсолютная привязка к курсору, а не смещение от старта — как и у
      // обычных ручек ресайза: маленькую точку хватают не всегда впритык,
      // а с 9-пиксельным допуском, и тянуть её «от места хвата» смотрелось
      // бы неточно на таком масштабе
      const g=dragging.it, view=g.props.view, gcx=g.x+g.w/2, gcy=g.y+g.h/2;
      const p=g.props.points&&g.props.points[dragging.index];
      if(p){
        p.x=view.cx+(w.x-gcx)/view.scale;
        // точка на кривой (onExpr) едет только по x — y всегда пересчитан
        // из формулы при отрисовке, менять его руками нечем и незачем
        if(!p.onExpr)p.y=view.cy-(w.y-gcy)/view.scale;
      }
      g.bbox=null;
      drawBoard();refreshSelBar();drawLive();return;
    }
    const it=dragging.it,st=dragging.start;
    if(dragging.mode==='resize'){
      const corner=dragging.corner, anchor=dragging.anchor, axis=dragging.axis||'xy';
      if(BOX_TYPES.has(it.type)){
        // Ресайз в локальной (неповёрнутой) системе координат объекта:
        // переводим текущий указатель в локальные оси, откладывая от
        // неподвижного противоположного угла (anchorWorld). Новый центр
        // считаем из условия "anchor остаётся на месте": center = anchorWorld - R(rot)*offset.
        const rot=dragging.rot0, cos=Math.cos(rot), sin=Math.sin(rot);
        const wx=w.x-dragging.anchorWorld.x, wy=w.y-dragging.anchorWorld.y;
        const locX=wx*cos+wy*sin, locY=-wx*sin+wy*cos;   // обратный поворот вектора на -rot
        let nw,nh;
        if(axis==='x'){                                  // тянут за левую или правую сторону
          nw=Math.max(16,locX*(corner==='e'?1:-1)); nh=st.h;
        }else if(axis==='y'){                            // за верхнюю или нижнюю
          nh=Math.max(16,locY*(corner==='s'?1:-1)); nw=st.w;
        }else{                                           // за угол — обе стороны, пропорции целы
          nw=Math.max(16,locX*(corner.includes('e')?1:-1));
          nh=nw/(st.w/st.h);
        }
        const ax=axis==='y'?0:(anchor.includes('e')?nw/2:-nw/2);
        const ay=axis==='x'?0:(anchor.includes('s')?nh/2:-nh/2);
        const offX=ax*cos-ay*sin, offY=ax*sin+ay*cos;    // R(rot)*(ax,ay)
        const cx=dragging.anchorWorld.x-offX, cy=dragging.anchorWorld.y-offY;
        it.w=nw; it.h=nh; it.rot=rot;
        it.x=cx-nw/2; it.y=cy-nh/2;
      }else if(Array.isArray(st.pts)){
        const b0=bboxOf(st);
        const w0=Math.max(1,b0.x1-b0.x0), h0=Math.max(1,b0.y1-b0.y0);
        const ax=dragging.anchorWorld.x, ay=dragging.anchorWorld.y;
        // за середину стороны тянем только одну ось, за угол — обе
        const sx=axis==='y'?1:Math.max(8,Math.abs(w.x-ax))/w0;
        const sy=axis==='x'?1:Math.max(8,Math.abs(w.y-ay))/h0;
        it.pts=st.pts.map(p=>('p' in p)?{x:ax+(p.x-ax)*sx,y:ay+(p.y-ay)*sy,p:p.p}:{x:ax+(p.x-ax)*sx,y:ay+(p.y-ay)*sy});
      }
    }else if(dragging.mode==='rotate'){
      let delta=Math.atan2(w.y-dragging.cy,w.x-dragging.cx)-dragging.a0;
      if(e.shiftKey){const step=Math.PI/12;delta=Math.round(delta/step)*step;}
      if(BOX_TYPES.has(it.type)){
        it.rot=(st.rot||0)+delta;
      }else if(Array.isArray(st.pts)){
        it.pts=st.pts.map(p=>{const r=rotAround(p.x,p.y,dragging.cx,dragging.cy,delta);return('p' in p)?{x:r.x,y:r.y,p:p.p}:{x:r.x,y:r.y};});
      }
      // Угол показываем от вертикали — «на сколько наклонили». У прямоугольных
      // объектов это их собственный угол, у штрихов и линий своего угла нет,
      // поэтому считаем поворот за текущий жест.
      dragging.angle=normAngle(BOX_TYPES.has(it.type)?(it.rot||0):delta);
    }else if(dragging.mode==='angle'){
      // Радиус не трогаем принципиально: ручка меняет только угол, за это
      // циркуль и отвечает. Показываем угол, как при повороте.
      const a=Math.atan2(w.y-it.cy,w.x-it.cx);
      if(dragging.end===0)it.a0=a; else it.a1=a;
      dragging.angle=normAngle(arcSweep(it));
      dragging.cx=it.cx;dragging.cy=it.cy;
    }else if(dragging.mode==='vertex'){
      it.pts=st.pts.map((p,i)=>i===dragging.index?{x:w.x,y:w.y}:p);
    }
    it.bbox=bboxOf(it);drawBoard();select(it);return;
  }
  if(arcDraft){
    const w=toWorld(pt.x,pt.y);
    const dx=w.x-arcDraft.cx, dy=w.y-arcDraft.cy;
    arcDraft.r=Math.hypot(dx,dy);
    const a=Math.atan2(dy,dx);
    // начальный угол берём, когда ножку уже развели: у нулевого радиуса
    // направления ещё нет
    if(arcDraft.a0===null&&arcDraft.r*S.cam.z>6){arcDraft.a0=a;arcDraft.a1=a;}
    else if(arcDraft.a0!==null){
      // Накапливаем угол, а не приравниваем: иначе переход через −π выглядел бы
      // как рывок в обратную сторону, и обвести полный круг было бы нельзя.
      let d=a-arcDraft.a1;
      while(d>Math.PI)d-=Math.PI*2;
      while(d<-Math.PI)d+=Math.PI*2;
      arcDraft.a1+=d;
    }
    drawLive();return;
  }
  if(marquee){marquee.b=toWorld(pt.x,pt.y);drawLive();return;}
  if(shapeDraft){
    const w=toWorld(pt.x,pt.y);let bx=w.x,by=w.y;
    if(e.shiftKey){
      const dx=bx-shapeDraft.a.x, dy=by-shapeDraft.a.y, m=Math.max(Math.abs(dx),Math.abs(dy));
      bx=shapeDraft.a.x+(dx<0?-1:1)*m; by=shapeDraft.a.y+(dy<0?-1:1)*m;
    }
    shapeDraft.b={x:bx,y:by};
    drawLive();return;
  }
  if(pathDraft&&pathDraft.mode==='drag'){
    const w=toWorld(pt.x,pt.y);
    let b=w;
    if(e.shiftKey){
      const a=pathDraft.pts[0];
      const step=Math.PI/12;
      const ang=Math.round(Math.atan2(w.y-a.y,w.x-a.x)/step)*step;
      const dist=Math.hypot(w.x-a.x,w.y-a.y);
      b={x:a.x+Math.cos(ang)*dist,y:a.y+Math.sin(ang)*dist};
    }
    pathDraft.pts[1]=b;
    drawLive();return;
  }
  if(erasing){eraseAt(pt);return;}

  // Наведение на ручку — меняем курсор на стрелку нужного направления.
  if(!dragging&&S.tool==='select'&&selected){
    const c=handleCursor(handleAt(pt));
    if(c!==hoverHandleCursor){hoverHandleCursor=c;applyCursor();}
  }else if(hoverHandleCursor){hoverHandleCursor=null;applyCursor();}

  if(!current||e.pointerId!==drawId){
    if(e.pointerType!=='touch')net.cursor(toWorld(pt.x,pt.y));
    return;
  }

  const evs=(typeof e.getCoalescedEvents==='function')?e.getCoalescedEvents():[e];
  let changed=false;
  for(const ev of (evs.length?evs:[e])){
    const p=localXY(ev),now=ev.timeStamp||performance.now();
    if(e.pointerType==='pen'&&ev.pressure>0)pressure=pressure*0.5+ev.pressure*0.5;
    else{
      const dt=Math.max(1,now-lastT);
      pressure=simPressure(pressure,Math.hypot(p.x-lastPt.x,p.y-lastPt.y)/dt);
    }
    lastPt=p;lastT=now;
    const w=toWorld(p.x,p.y);
    changed=pushPoint(current,w.x,w.y,pressure)||changed;
  }
  if(changed){
    drawLive();
    const n=performance.now();
    if(n-tStream>45){tStream=n;net.stream(current);net.cursor(current.pts[current.pts.length-1]);}
  }
});

/* поля геометрии по типу — что снимать до/после драга для undo и сети.
   Для box-типов (image, позже shape) достаточно плоского копирования;
   для точечных типов (появятся в следующих фазах) потребуется глубокая
   копия pts — иначе before/after будут ссылаться на один и тот же массив. */
stage.addEventListener('pointerup',endPointer);
stage.addEventListener('pointercancel',endPointer);
stage.addEventListener('pointerleave',()=>{hoverPt=null;drawLive();});
/* Не на #stage: своё меню (openMenu) открывается в обработчике pointerup —
   раньше, чем браузер решает, на каком элементе показать contextmenu. Меню
   уже нарисовано и лежит поверх холста отдельным элементом, contextmenu
   целится в него, а не в #stage, и точечный слушатель на холсте его не
   ловит — родной меню Windows/Chrome вылезал поверх своего. На уровне
   документа достаём событие независимо от того, куда оно на самом деле
   попало; поля ввода (рабочая переименование и т.п.) не трогаем — там
   родное меню (вставить и т.п.) нужно. */
document.addEventListener('contextmenu',e=>{
  if(!S.boardId)return;
  if(/INPUT|TEXTAREA/.test((e.target||{}).tagName||''))return;
  e.preventDefault();
});
stage.addEventListener('dblclick',e=>{
  if(pathDraft&&pathDraft.mode==='vertex'){e.preventDefault();commitPathDraft();}
  // двойной щелчок по надписи открывает её на правку — привычнее, чем
  // возвращаться к инструменту «надпись»
  if(S.tool==='select'){
    const p=localXY(e), w=toWorld(p.x,p.y), it=itemAt(w);
    if(it&&it.type==='text'&&mineOnly(it)&&!it.locked){e.preventDefault();openTextEditor(null,it);}
    else if(it&&it.type==='physics'&&it.kind==='graph'&&mineOnly(it)&&!it.locked&&canEdit()){
      // двойной клик по уже стоящей точке — переименовать её (то же место,
      // где для оси открывается переименование по одинарному клику: точку
      // одинарным нельзя, он уже занят перетаскиванием)
      const h=(selected===it)?handleAt(p):null;
      if(h&&h.kind==='graphPoint'){
        const pt=it.props.points[h.index];
        const name=prompt('Название точки:',pt.label||'');
        if(name!==null){
          const before=cloneProps(it.props);
          pt.label=name.trim().slice(0,6);
          pushUndo([{type:'move',id:it.id,before:{props:before},after:{props:cloneProps(it.props)}}]);
          net.send({t:'move',id:it.id,props:{...it.props}});
          drawBoard();
        }
      }else if(!h&&(w.y-it.y)>GRAPH_HEADER_H){
        // пусто в теле графика — ставим новую точку; если клик лёг рядом с
        // самой кривой (в пределах ~10 экранных px), точка приклеивается к
        // ней (onExpr) и дальше её можно таскать только вдоль кривой
        const view=it.props.view, gcx=it.x+it.w/2, gcy=it.y+it.h/2;
        const mx=view.cx+(w.x-gcx)/view.scale, my=view.cy-(w.y-gcy)/view.scale;
        const deg=it.props.angleMode==='deg';
        const baseVars={};(it.props.params||[]).forEach(pr=>{baseVars[pr.name]=pr.value;});
        const tol=10/S.cam.z;
        let onExpr=null;
        for(const ex of (it.props.expressions||[])){
          if(ex.visible===false||!ex.text||!ex.text.trim())continue;
          const c=graphCompile(ex.text);
          if(!c||c.mode!=='function')continue;
          let cy;try{cy=graphEval(c.ast,{...baseVars,x:mx},deg);}catch{cy=NaN;}
          if(!Number.isFinite(cy))continue;
          const candSy=gcy-(cy-view.cy)*view.scale;
          if(Math.abs(candSy-w.y)<tol){onExpr=ex.id;break;}
        }
        const before=cloneProps(it.props);
        const points=it.props.points=it.props.points||[];
        points.push({id:newId(),x:mx,y:my,label:nextPointLabel(points),onExpr});
        it.bbox=null;
        pushUndo([{type:'move',id:it.id,before:{props:before},after:{props:cloneProps(it.props)}}]);
        net.send({t:'move',id:it.id,props:{...it.props}});
        if(!inSelection(it))selectMany(withGroup([it]));
        drawBoard();
      }
    }
  }
});

/* Прореживание законченного штриха — Рамер, Дуглас и Пекер.

   Перо шлёт точки густо: pushPoint отбрасывает те, что ближе 0.35 px к
   предыдущей, и всё равно на букву высотой 20 px приходится больше сотни.
   Пятая часть из них лежит на прямой между соседями и не несёт ничего.

   Прореживаем на месте, при отрыве пера: и в памяти вкладки, и в сообщении
   серверу становится впятеро меньше. То же самое делает сервер перед снимком
   (lib/store.js) — здесь это повторено потому, что клиент живёт одним файлом
   без сборки и разделить код не с чем.

   Допуск считается в экранных пикселях, а не в мировых: иначе штрих, начатый
   с приближением, заметно осел бы сразу после отрыва пера. */
textEdit.addEventListener('input',autoGrowText);
textEdit.addEventListener('keydown',e=>{
  e.stopPropagation();                          // горячие клавиши доски не мешают печатать
  if(e.key==='Escape'){e.preventDefault();closeTextEditor(false);}
  if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();closeTextEditor(true);}
});
textEdit.addEventListener('blur',()=>closeTextEditor(true));

stage.addEventListener('wheel',e=>{
  e.preventDefault();
  const p=localXY(e);
  // колесо над графиком крутит его собственный масштаб, а не масштаб всей
  // доски — так же, как в Desmos: наводишь на график и зумишь именно его
  if(S.tool==='select'&&!e.shiftKey&&canEdit()){
    const w0=toWorld(p.x,p.y), g=itemAt(w0);
    if(g&&g.type==='physics'&&g.kind==='graph'&&!g.locked&&mineOnly(g)){
      const raw=Math.exp(-e.deltaY*(e.deltaMode===1?0.03:0.0022));
      zoomGraphAt(g,w0,Math.min(1.22,Math.max(0.82,raw)));
      drawBoard();
      clearTimeout(graphZoomSyncTimer);
      graphZoomSyncTimer=setTimeout(()=>net.send({t:'move',id:g.id,props:{...g.props}}),150);
      return;
    }
  }
  if(e.shiftKey&&!e.ctrlKey){
    S.cam.y-=e.deltaY*(e.deltaMode===1?18:1);
    S.cam.x-=e.deltaX*(e.deltaMode===1?18:1);
    resyncPanning(p);
    camChanged();refreshSelBar();return;
  }
  const raw=Math.exp(-e.deltaY*(e.deltaMode===1?0.03:0.0022));
  zoomAt(p.x,p.y,Math.min(1.22,Math.max(0.82,raw)));
  resyncPanning(p);
  refreshSelBar();
},{passive:false});

/* ═══════════════════ вставка картинок ═══════════════════ */
document.getElementById('physicsPanelClose').onclick=()=>{
  if(selected&&selected.type==='physics'&&selected.kind==='graph')select(null);
  else setTool('select');
};
document.getElementById('physShowField').onchange=e=>{S.physicsProps.magnet.showField=e.target.checked;};
document.getElementById('physStrength').oninput=e=>{
  const v=+e.target.value;
  S.physicsProps.magnet.strength=v;
  document.getElementById('physStrengthVal').textContent=v.toFixed(1);
};
document.getElementById('physRayCount').oninput=e=>{
  const v=Math.round(+e.target.value);
  S.physicsProps['light-source'].rayCount=v;
  document.getElementById('physRayCountVal').textContent=v;
};
document.getElementById('physSpread').oninput=e=>{
  const v=+e.target.value;
  S.physicsProps['light-source'].spreadDeg=v;
  document.getElementById('physSpreadVal').textContent=v.toFixed(1);
};
document.getElementById('physFocal').oninput=e=>{
  const v=+e.target.value;
  S.physicsProps.lens.focal=v;
  document.getElementById('physFocalVal').textContent=Math.round(v);
};
document.getElementById('physPower').oninput=e=>{
  const v=+e.target.value;
  S.physicsProps.heater.power=v;
  document.getElementById('physPowerVal').textContent=Math.round(v);
};
document.getElementById('physMaterial').onchange=e=>{S.physicsProps.body.material=e.target.value;};
document.getElementById('physMass').oninput=e=>{
  const g=+e.target.value;
  S.physicsProps.body.mass=g/1000;
  document.getElementById('physMassVal').textContent=Math.round(g);
};

}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  abortDraft, commitPathDraft, placeImage, resyncPanning, snapGeom, updatePhysicsPanel,
};
