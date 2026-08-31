/* группы и слои, буфер обмена, меню по правой кнопке */

import { GRID_MODES, GRID_NAMES, PAPER, S, board, items, recordUndo, redoStack, store, toWorld } from './core.js';
import { ARC_TYPES, BACK_TYPES, BOX_TYPES, SELECTABLE, bboxOf, rotAround } from './geometry.js';
import { paintItem } from './shapes.js';
import { applyCursor, drawBoard, drawLive, hoverPt, resize, zoomAt } from './render.js';
import { addItem, deflate, inflate, net, removeItem } from './net.js';
import { abortDraft, canEdit, commitPathDraft, mineOnly, newId, pathDraft, refreshSelBar, resyncPanning, select, selectMany, selection, selectionBox, snapGeom, spaceDown, updateSelBar } from './input.js';
import { pushUndo, redo, undo } from './undo.js';
import { closeAllPopovers, duplicateSelected, hint, popOpen, setTool, updatePenPanel } from './toolbar.js';
import { nav } from './app.js';

/* ═══════════════════ группы, слои, буфер ═══════════════════ */

/** Объекты одной группы ходят вместе: выделили один — выделились все. */
function withGroup(list){
  const gs=new Set(list.map(it=>it.g).filter(Boolean));
  if(!gs.size)return list;
  const out=new Map(list.map(it=>[it.id,it]));
  for(const it of items) if(it.g&&gs.has(it.g)) out.set(it.id,it);
  return [...out.values()];
}

function groupSelected(){
  const list=selection.filter(it=>!it.locked);
  if(list.length<2)return hint('Для группы нужно хотя бы два объекта');
  const g=newId();
  const ops=[];
  for(const it of list){
    const before=snapGeom(it,it);
    it.g=g;
    ops.push({type:'move',id:it.id,before,after:snapGeom(it,it)});
    net.send({t:'move',id:it.id,g});
  }
  pushUndo(ops);selectMany(list);drawLive();
  hint('Объекты сгруппированы: теперь двигаются вместе');
}
function ungroupSelected(){
  const list=selection.filter(it=>it.g&&!it.locked);
  if(!list.length)return;
  const ops=[];
  for(const it of list){
    const before=snapGeom(it,it);
    it.g=null;
    ops.push({type:'move',id:it.id,before,after:snapGeom(it,it)});
    net.send({t:'move',id:it.id,g:null});
  }
  pushUndo(ops);drawLive();hint('Группа разобрана');
}

/** Перестановка слоёв у себя — тем же правилом, что и на сервере. */
function applyZ(ids,to){
  const set=new Set(ids);
  const picked=[],rest=[];
  for(const it of items)(set.has(it.id)?picked:rest).push(it);
  if(!picked.length)return;
  items.length=0;
  items.push(...(to==='back'?picked.concat(rest):rest.concat(picked)));
}
function moveLayer(to){
  const list=withGroup(selection).filter(it=>!it.locked);
  if(!list.length)return;
  const ids=list.map(it=>it.id);
  // Картинка по умолчанию живёт под записями. «На передний план» поднимает её
  // и оттуда, «на задний» — возвращает обратно.
  const ops=[];
  for(const it of list){
    if(!BACK_TYPES.has(it.type))continue;
    const want=to==='front';
    if(!!it.front===want)continue;
    const before=snapGeom(it,it);
    it.front=want;
    ops.push({type:'move',id:it.id,before,after:snapGeom(it,it)});
    net.send({t:'move',id:it.id,front:want});
  }
  if(ops.length)pushUndo(ops);
  applyZ(ids,to);
  net.send({t:'z',ids,to});
  drawBoard();
  hint(to==='front'?'Поднято на передний план':'Убрано на задний план');
}

/* Буфер обмена доски. Системный тут не годится: в нём нельзя хранить наши
   объекты, а картинку из него мы и так умеем принимать (см. вставку). */
let clipboard=[];
function copySelected(cut){
  const list=withGroup(selection);
  if(!list.length)return;
  clipboard=list.map(deflate);
  hint((cut?'Вырезано: ':'Скопировано: ')+list.length+
       (list.length===1?' объект':' объекта'));
  if(cut){
    const alive=list.filter(it=>!it.locked);
    if(!alive.length)return;
    select(null);
    const ids=alive.map(it=>it.id);
    for(const id of ids)removeItem(id);
    net.send({t:'erase',ids});
    recordUndo({type:'erase',items:alive});redoStack.length=0;drawBoard();
  }
}
function pasteClipboard(at){
  if(!clipboard.length)return hint('Буфер пуст');
  if(!canEdit())return hint('Преподаватель закрыл доску для правок');
  // Кладём так, чтобы левый верхний угол скопированного оказался под курсором,
  // а если курсора нет — со смещением, как у дубликата.
  const raws=clipboard.map(r=>inflate({...r}));
  let dx=20,dy=20;
  if(at){
    const b={x0:Infinity,y0:Infinity};
    for(const it of raws){const q=bboxOf(it);b.x0=Math.min(b.x0,q.x0);b.y0=Math.min(b.y0,q.y0);}
    dx=at.x-b.x0;dy=at.y-b.y0;
  }
  // группы сохраняются, но получают новые имена: иначе копия слиплась бы с оригиналом
  const gmap=new Map();
  const clones=[];
  for(const it of raws){
    const g=it.g?(gmap.get(it.g)||gmap.set(it.g,newId()).get(it.g)):null;
    const clone=BOX_TYPES.has(it.type)
      ?{...it,id:newId(),by:S.me&&S.me.uid,x:it.x+dx,y:it.y+dy,g,bbox:null,locked:false}
      :ARC_TYPES.has(it.type)
      ?{...it,id:newId(),by:S.me&&S.me.uid,cx:it.cx+dx,cy:it.cy+dy,g,bbox:null,locked:false}
      :{...it,id:newId(),by:S.me&&S.me.uid,g,bbox:null,locked:false,
        pts:it.pts.map(p=>('p' in p)?{x:p.x+dx,y:p.y+dy,p:p.p}:{x:p.x+dx,y:p.y+dy})};
    addItem(clone);
    net.send({t:'add',item:deflate(clone)});
    clones.push(clone);
  }
  pushUndo(clones.map(item=>({type:'add',item})));
  selectMany(clones);
  hint('Вставлено: '+clones.length+(clones.length===1?' объект':' объекта'));
}

/* Поворот выделенного на заданный угол — вокруг общего центра, тем же
   способом, что и перетаскивание за ручку поворота: у прямоугольных объектов
   меняется поле rot, у штрихов и линий поворачиваются сами точки. */
function rotateSelection(delta){
  const list=withGroup(selection).filter(it=>!it.locked);
  if(!list.length)return;
  const b=selectionBox();
  const cx=(b.x0+b.x1)/2, cy=(b.y0+b.y1)/2;
  const ops=[];
  for(const it of list){
    const before=snapGeom(it,it);
    if(ARC_TYPES.has(it.type)){
      // дуга поворачивается своими углами: радиус при этом неприкосновенен
      const c=rotAround(it.cx,it.cy,cx,cy,delta);
      it.cx=c.x; it.cy=c.y; it.a0+=delta; it.a1+=delta;
    }else if(BOX_TYPES.has(it.type)){
      // центр объекта тоже едет по окружности вокруг общего центра
      const c=rotAround(it.x+it.w/2,it.y+it.h/2,cx,cy,delta);
      it.x=c.x-it.w/2; it.y=c.y-it.h/2;
      it.rot=(it.rot||0)+delta;
    }else if(Array.isArray(it.pts)){
      it.pts=it.pts.map(p=>{
        const r=rotAround(p.x,p.y,cx,cy,delta);
        return ('p' in p)?{x:r.x,y:r.y,p:p.p}:{x:r.x,y:r.y};
      });
    }else continue;
    it.bbox=null;
    const after=snapGeom(it,it);
    ops.push({type:'move',id:it.id,before,after});
    net.send({t:'move',id:it.id,...wireGeom(after)});
  }
  if(!ops.length)return;
  pushUndo(ops);
  drawBoard();refreshSelBar();drawLive();
}

/* ═══════════════════ меню по правой кнопке ═══════════════════
   Собирается заново на каждое открытие: пунктов немного, а держать их разметку
   в актуальном состоянии постоянно — лишний труд на каждое выделение. */
const menuEl=document.getElementById('menu');
let menuAt=null;                                   // где щёлкнули, в мировых

function closeMenu(){menuEl.classList.remove('show');menuEl.innerHTML='';menuAt=null;}

/* Значки к пунктам: глазом строка находится по картинке быстрее, чем по
   тексту, а список тут длинный. */
const MENU_ICONS={
  dup:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  unlock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.7-1.5"/>',
  cut:'<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 16L18 4M16 16L6 4"/>',
  copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  paste:'<path d="M9 4h6v3H9z"/><path d="M9 5.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5a2 2 0 0 0-2-2h-2"/>',
  group:'<path d="M10 13a4 4 0 0 1 0-5l1.5-1.5a4 4 0 0 1 5.6 5.6L16 13.5"/><path d="M14 11a4 4 0 0 1 0 5l-1.5 1.5a4 4 0 0 1-5.6-5.6L8 10.5"/>',
  ungroup:'<path d="M10 13a4 4 0 0 1 0-5l1.5-1.5"/><path d="M14 11a4 4 0 0 1 0 5l-1.5 1.5"/><path d="M4 4l16 16"/>',
  rotate:'<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  rotateBack:'<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v5h5"/>',
  front:'<rect x="4" y="4" width="11" height="11" rx="1.5"/><path d="M9 20h9a2 2 0 0 0 2-2V9"/>',
  back:'<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M15 4H6a2 2 0 0 0-2 2v9"/>',
  del:'<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  all:'<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/>',
  grid:'<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'
};
function menuItem(label,hotkey,fn,{off,on,icon}={}){
  const b=document.createElement('button');
  if(icon&&MENU_ICONS[icon]){
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.innerHTML=MENU_ICONS[icon];
    b.appendChild(svg);
  }
  const t=document.createElement('span');t.textContent=label;t.className='lbl';
  b.appendChild(t);
  if(hotkey){const k=document.createElement('kbd');k.textContent=hotkey;b.appendChild(k);}
  if(off)b.disabled=true; else b.onclick=()=>{closeMenu();fn();};
  if(on)b.classList.add('on');
  menuEl.appendChild(b);
  return b;
}
const menuSep=()=>menuEl.appendChild(document.createElement('hr'));
function menuHead(text){
  const d=document.createElement('div');d.className='head';d.textContent=text;
  menuEl.appendChild(d);
}

function openMenu(screenPt,worldPt){
  closeMenu();
  menuAt=worldPt;
  const edit=canEdit();
  const sel=selection.length;
  const unlocked=selection.filter(it=>!it.locked).length;
  const grouped=selection.some(it=>it.g);

  if(sel){
    const allLocked=selection.every(it=>it.locked);
    menuItem('Дублировать','Ctrl+D',duplicateSelected,{off:!edit||!unlocked,icon:'dup'});
    menuItem(allLocked?'Открепить от фона':'Закрепить на фоне','',
      ()=>document.getElementById('selLock').click(),
      {off:!edit,icon:allLocked?'unlock':'lock'});
    menuSep();
    menuItem('Вырезать','Ctrl+X',()=>copySelected(true),{off:!edit||!unlocked,icon:'cut'});
    menuItem('Копировать','Ctrl+C',()=>copySelected(false),{icon:'copy'});
    menuItem('Вставить','Ctrl+V',()=>pasteClipboard(worldPt),{off:!edit||!clipboard.length,icon:'paste'});
    menuSep();
    menuItem('Группировать','Ctrl+G',groupSelected,{off:!edit||selection.length<2,icon:'group'});
    menuItem('Разгруппировать','Ctrl+Shift+G',ungroupSelected,{off:!edit||!grouped,icon:'ungroup'});
    menuSep();
    menuItem('Повернуть на 90°','',()=>rotateSelection(Math.PI/2),{off:!edit||!unlocked,icon:'rotate'});
    menuItem('Повернуть влево','',()=>rotateSelection(-Math.PI/2),{off:!edit||!unlocked,icon:'rotateBack'});
    menuSep();
    menuItem('Переместить на передний план',']',()=>moveLayer('front'),{off:!edit||!unlocked,icon:'front'});
    menuItem('Переместить на задний план','[',()=>moveLayer('back'),{off:!edit||!unlocked,icon:'back'});
    menuSep();
    menuItem('Удалить','Del',()=>document.getElementById('selDel').click(),
      {off:!edit||!unlocked,icon:'del'});
  }else{
    menuItem('Вставить','Ctrl+V',()=>pasteClipboard(worldPt),{off:!edit||!clipboard.length,icon:'paste'});
    menuItem('Выделить всё','Ctrl+A',selectAll,{off:!edit,icon:'all'});
    menuSep();
    menuHead('Фон');
    for(const mode of GRID_MODES){
      menuItem(GRID_NAMES[mode][0].toUpperCase()+GRID_NAMES[mode].slice(1),'',
        ()=>setGrid(mode),{on:S.grid===mode,icon:'grid'});
    }
  }

  // Показать, измерить, при нужде отразить от края — иначе меню у правого
  // или нижнего края уезжает за экран.
  menuEl.classList.add('show');
  const r=menuEl.getBoundingClientRect();
  const x=Math.max(6,Math.min(innerWidth-r.width-6,screenPt.x));
  const y=Math.max(6,Math.min(innerHeight-r.height-6,screenPt.y));
  menuEl.style.left=x+'px';
  menuEl.style.top=y+'px';
}

function selectAll(){
  const list=items.filter(it=>SELECTABLE.has(it.type)&&mineOnly(it));
  if(!list.length)return hint('Выделять нечего');
  setTool('select');selectMany(list);
  hint('Выделено: '+list.length+(list.length===1?' объект':' объекта'));
}
function setGrid(mode){
  S.grid=mode;store.set('doska.grid',mode);
  hint('Фон: '+GRID_NAMES[mode]);drawBoard();
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
addEventListener('pointerdown',e=>{
  if(menuEl.classList.contains('show')&&!menuEl.contains(e.target))closeMenu();
},true);
addEventListener('blur',closeMenu);
addEventListener('wheel',()=>{if(menuEl.classList.contains('show'))closeMenu();},{passive:true});
document.getElementById('selLock').onclick=()=>{
  if(!selection.length)return;
  const on=!selection.every(it=>it.locked);   // группа блокируется целиком
  const ops=[];
  for(const it of selection){
    if(it.locked===on)continue;
    const before=snapGeom(it,it);
    it.locked=on;
    ops.push({type:'move',id:it.id,before,after:snapGeom(it,it)});
    net.send({t:'move',id:it.id,locked:on});
  }
  if(ops.length)pushUndo(ops);
  updateSelBar();drawLive();
};
document.getElementById('toDash').onclick=()=>nav('/');
document.getElementById('png').onclick=()=>{
  popOpen(null);
  if(!items.length)return hint('Пусто — сначала что-нибудь напишите');
  let b={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
  for(const it of items){const q=it.bbox;
    b.x0=Math.min(b.x0,q.x0);b.y0=Math.min(b.y0,q.y0);
    b.x1=Math.max(b.x1,q.x1);b.y1=Math.max(b.y1,q.y1);}
  const pad=40,W=Math.ceil(b.x1-b.x0+pad*2),H=Math.ceil(b.y1-b.y0+pad*2);
  const c=document.createElement('canvas'),k=Math.min(2,4000/Math.max(W,H));
  c.width=Math.round(W*k);c.height=Math.round(H*k);
  const x=c.getContext('2d');
  x.fillStyle=PAPER;x.fillRect(0,0,c.width,c.height);
  x.setTransform(k,0,0,k,-(b.x0-pad)*k,-(b.y0-pad)*k);
  const back=it=>BACK_TYPES.has(it.type)&&!it.front;   // как и на экране
  for(const it of items)if(back(it))paintItem(x,it);
  for(const it of items)if(!back(it))paintItem(x,it);
  c.toBlob(bl=>{const a=document.createElement('a');
    a.href=URL.createObjectURL(bl);
    a.download=(document.getElementById('title').textContent||'doska')+'.png';
    a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);});
};

addEventListener('keydown',e=>{
  if(/INPUT|TEXTAREA/.test((e.target||{}).tagName||''))return;
  if(!S.boardId)return;                       // состояние роутера, а не вид DOM
  // Физическая клавиша, а не e.key: на нелатинской раскладке (русская
  // ЙЦУКЕН и т.п.) Ctrl+Z/Ctrl+C отдают e.key='я'/'с' (кириллица на той же
  // позиции), и сравнение с 'z'/'c' никогда не совпадало бы. e.code называет
  // клавишу по месту на клавиатуре и не зависит от раскладки вообще.
  const c=e.code;
  if(c==='Space'&&!spaceDown){spaceDown=true;applyCursor();e.preventDefault();}
  if((e.ctrlKey||e.metaKey)&&c==='KeyZ'){e.preventDefault();e.shiftKey?redo():undo();return;}
  if((e.ctrlKey||e.metaKey)&&c==='KeyY'){e.preventDefault();redo();return;}
  if((e.ctrlKey||e.metaKey)&&c==='KeyD'){e.preventDefault();duplicateSelected();return;}
  if((e.ctrlKey||e.metaKey)&&c==='KeyA'){e.preventDefault();selectAll();return;}
  if((e.ctrlKey||e.metaKey)&&c==='KeyC'){e.preventDefault();copySelected(false);return;}
  if((e.ctrlKey||e.metaKey)&&c==='KeyX'){e.preventDefault();copySelected(true);return;}
  // Ctrl+V перехватываем только для своего буфера: картинку из системного
  // ловит обработчик paste, и мешать ему нельзя
  if((e.ctrlKey||e.metaKey)&&c==='KeyV'&&clipboard.length){
    e.preventDefault();pasteClipboard(hoverPt?toWorld(hoverPt.x,hoverPt.y):null);return;
  }
  if((e.ctrlKey||e.metaKey)&&c==='KeyG'){
    e.preventDefault();e.shiftKey?ungroupSelected():groupSelected();return;
  }
  if(e.ctrlKey||e.metaKey)return;
  if(c==='BracketRight'&&selection.length){e.preventDefault();moveLayer('front');return;}
  if(c==='BracketLeft'&&selection.length){e.preventDefault();moveLayer('back');return;}
  if(c==='Escape'&&menuEl.classList.contains('show')){closeMenu();return;}
  if(c==='Digit1')setTool('pen'); if(c==='Digit2')setTool('marker'); if(c==='Digit3')setTool('eraser');
  if(c==='Digit4')setTool('select'); if(c==='Digit5')setTool('hand');
  if(c==='KeyT')setTool('text');
  if(c==='KeyK')setTool('arc');
  if(c==='Digit6')setTool('shape');
  if(c==='KeyR'){S.shapeKind='rect';setTool('shape');}
  if(c==='KeyO'){S.shapeKind='ellipse';setTool('shape');}
  if(c==='KeyL'){S.physicsPreset=null;S.pathKind='line';setTool('path');}
  if(c==='KeyA'){S.physicsPreset=null;S.pathKind='line';S.a2=2;setTool('path');}
  if(c==='KeyN'){S.physicsPreset=null;S.pathKind='polyline';setTool('path');}
  if(c==='KeyC'){S.physicsPreset=null;S.pathKind='curve';setTool('path');}
  if(c==='KeyM'){S.physicsPreset=null;S.pathKind='polygon';setTool('path');}
  if(c==='Enter'&&pathDraft&&pathDraft.mode==='vertex'){e.preventDefault();commitPathDraft();}
  if(c==='KeyG')document.getElementById('gridBtn').click();
  if(c==='Digit0')document.getElementById('home').click();
  if(c==='Equal'){zoomAt(board.clientWidth/2,board.clientHeight/2,1.25);resyncPanning({x:board.clientWidth/2,y:board.clientHeight/2});}
  if(c==='Minus'){zoomAt(board.clientWidth/2,board.clientHeight/2,0.8);resyncPanning({x:board.clientWidth/2,y:board.clientHeight/2});}
  if((c==='Delete'||c==='Backspace')&&selection.length){e.preventDefault();document.getElementById('selDel').click();}
  if(c==='Escape'){
    abortDraft();select(null);closeAllPopovers();S.panelOpen=false;updatePenPanel();
    if(S.tool==='physics')setTool('select');
  }
});
addEventListener('keyup',e=>{if(e.code==='Space'){spaceDown=false;applyCursor();}});
addEventListener('resize',()=>{resize();refreshSelBar();});

}

export {
  MENU_ICONS, applyZ, clipboard, closeMenu, copySelected, groupSelected, menuAt, menuEl, menuHead, menuItem, menuSep, moveLayer, openMenu, pasteClipboard, rotateSelection, selectAll, setGrid, ungroupSelected, withGroup,
};
