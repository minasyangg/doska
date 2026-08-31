/* панель инструментов, меню фигур, настройки пера */

import { FILLS, GRID_MODES, GRID_NAMES, PAPER, PENS, S, STYLED, api, board, dpr, mkStroke, outlinePath, recordUndo, redoStack, stage, store } from './core.js';
import { ARC_TYPES, BOX_TYPES, bboxOf } from './geometry.js';
import { SHAPES, SHAPE_GROUPS, SHAPE_NAMES } from './shapes.js';
import { fillPeersPop, hint } from './shell.js';
import { marquee, newId, select, selectMany, selection } from './selection.js';
import { applyCursor, camChanged, drawBoard, drawLive, zoomAt } from './render.js';
import { addItem, deflate, net, removeItem } from './net.js';
import { snapGeom, updatePhysicsPanel } from './input.js';
import { pushUndo, redo, undo } from './undo.js';
import { openSettings } from './boards.js';

/* ═══════════════════ интерфейс доски ═══════════════════ */
const inksEl=document.getElementById('inks'),sizeEl=document.getElementById('size');
const sizeVal=document.getElementById('sizeVal'),prev=document.getElementById('preview');
const pctx=prev.getContext('2d');
const palette=()=>S.tool==='marker'?MARKERS:PENS;

/* если что-то выделено — правит стиль у выделенного объекта (генерируя
   обычную move-операцию для undo/сети); иначе просто меняет умолчание
   для следующего штриха/фигуры. Работает для любого типа, у которого
   есть такое поле (образы, например, поля color/size/fill/dash не имеют). */
function applyStyleToSelection(key,value){
  const ops=[];
  for(const it of selection){
    if(it.locked||!(key in it))continue;
    const before=snapGeom(it,it);
    it[key]=value;
    it.bbox=bboxOf(it);
    const after=snapGeom(it,it);
    ops.push({type:'move',id:it.id,before,after});
    net.send({t:'move',id:it.id,...wireGeom(after)});
  }
  if(!ops.length)return;
  pushUndo(ops);
  drawBoard();
}
/* Кнопка «свой цвет»: не входит в PENS/MARKERS, поэтому не дублирует пресеты
   на вид. Пока текущий цвет — один из пресетов, показывает радужный кружок
   как приглашение; как только выбрали что-то своё через системную палитру,
   показывает именно этот цвет и держит рамку «выбрано», как обычный пресет. */
const CUSTOM_WHEEL='conic-gradient(red,#ff0,#0f0,#0ff,#00f,#f0f,red)';
const inkCustomInput=document.getElementById('inkCustom');
function setInkColor(c){
  S.color=c;
  if(S.tool==='marker')S.markerColor=c;else if(S.tool==='pen')S.penColor=c;
  renderInks();drawPreview();
  applyStyleToSelection('color',c);
}
function renderInks(){
  inksEl.innerHTML='';
  const pal=palette();
  for(const c of pal){
    const b=document.createElement('button');
    b.className='ink'+(c===S.color?' on':'');b.style.background=c;b.title=c;
    b.onclick=()=>setInkColor(c);
    inksEl.appendChild(b);
  }
  // Регистр важен: системная палитра всегда отдаёт hex строчными буквами,
  // а пресеты записаны как попало — иначе свой цвет, случайно совпавший
  // с пресетом, выглядел бы одновременно выбранным в двух местах.
  const isCustom=!pal.some(p=>p.toLowerCase()===S.color.toLowerCase());
  const custom=document.createElement('button');
  custom.className='ink'+(isCustom?' on':'');
  custom.style.background=isCustom?S.color:CUSTOM_WHEEL;
  custom.title='Свой цвет…';
  custom.onclick=()=>{inkCustomInput.value=/^#[0-9a-f]{6}$/i.test(S.color)?S.color:'#000000';inkCustomInput.click();};
  inksEl.appendChild(custom);
}
const NO_FILL_BG='repeating-linear-gradient(45deg,#fff,#fff 3px,#c33 3px,#c33 4px)';
function renderFills(){
  const fillsEl=document.getElementById('fills');
  fillsEl.innerHTML='';
  for(const f of FILLS){
    const b=document.createElement('button');
    b.className='ink'+(f===S.fill?' on':'');
    b.style.background=f||NO_FILL_BG;b.title=f||'без заливки';
    b.onclick=()=>{S.fill=f;renderFills();applyStyleToSelection('fill',f);};
    fillsEl.appendChild(b);
  }
}
function updateDashButtons(){
  document.querySelectorAll('[data-dash]').forEach(b=>b.classList.toggle('on',+b.dataset.dash===S.dash));
}
const shapesBtn=document.getElementById('shapesBtn'), shapesMenu=document.getElementById('shapesMenu');
const pathBtn=document.getElementById('pathBtn'), pathMenu=document.getElementById('pathMenu');
const penBtn=document.getElementById('penBtn'), penKindMenu=document.getElementById('penKindMenu');
const moreBtn=document.getElementById('moreBtn'), moreMenu=document.getElementById('moreMenu');
/* Значок фигуры — та же таблица, что и сама фигура, только в svg. Рисовать
   иконки руками значило бы держать второе описание каждой формы. */
function shapeIcon(kind){
  const spec=SHAPES[kind]||SHAPES.rect;
  const S0=2, W=20;                                  // поле значка 24×24 с отступом
  const put=(part,dashed)=>{
    if(part.round!==undefined)
      return '<rect x="'+S0+'" y="'+S0+'" width="'+W+'" height="'+W+'" rx="'+(W*part.round)+'"/>';
    const list=Array.isArray(part)?part:[part];
    let d='',started=false;
    for(const seg of list){
      if(seg.arc){
        const [cx,cy,rx,ry,a0,a1]=seg.arc;
        const steps=20;
        for(let i=0;i<=steps;i++){
          const t=(a0+(a1-a0)*i/steps)*6.2832;
          const x=S0+(cx+Math.cos(t)*rx)*W, y=S0+(cy+Math.sin(t)*ry)*W;
          d+=(started?'L':'M')+x.toFixed(1)+' '+y.toFixed(1);started=true;
        }
      }else{
        const x=S0+seg[0]*W, y=S0+seg[1]*W;
        d+=(started?'L':'M')+x.toFixed(1)+' '+y.toFixed(1);started=true;
      }
    }
    if(spec.closed!==false)d+='Z';
    return '<path d="'+d+'"'+(dashed?' stroke-dasharray="2 2" opacity=".65"':'')+'/>';
  };
  let out='';
  for(const p of spec.out)out+=put(p,false);
  for(const p of (spec.hid||[]))out+=put(p,true);
  return '<svg viewBox="0 0 24 24">'+out+'</svg>';
}

/** Список фигур собирается один раз при загрузке. */
function buildShapesMenu(){
  const box=document.getElementById('shapesMenu');
  let html='';
  for(const [title,kinds] of SHAPE_GROUPS){
    html+='<div class="head">'+title+'</div><div class="grid">';
    for(const k of kinds){
      if(!SHAPES[k])continue;
      html+='<button class="tool" data-shape="'+k+'" title="'+(SHAPE_NAMES[k]||k)+'">'+
            shapeIcon(k)+'</button>';
    }
    html+='</div>';
  }
  box.innerHTML=html;
}

/** Линии и кривые — раньше жили внутри списка фигур, теперь свой инструмент. */
function buildPathMenu(){
  pathMenu.innerHTML='<div class="head">Линии и кривые</div><div class="grid">'+
    '<button class="tool" data-path="line" title="Линия (L), стрелка — A"><svg viewBox="0 0 24 24"><path d="M4 20L20 4"/></svg></button>'+
    '<button class="tool" data-path="polyline" title="Ломаная (N)"><svg viewBox="0 0 24 24"><path d="M4 18l6-10 4 6 6-10"/></svg></button>'+
    '<button class="tool" data-path="curve" title="Кривая (C)"><svg viewBox="0 0 24 24"><path d="M4 18Q10 4 12 12T20 6"/></svg></button>'+
    '<button class="tool" data-path="polygon" title="Многоугольник (M)"><svg viewBox="0 0 24 24"><path d="M12 3l8 6-3 10H7L4 9z"/></svg></button>'+
    '</div>';
}
/** Гель/маркер — раньше две отдельные кнопки дока, теперь один «Карандаш». */
function buildPenMenu(){
  penKindMenu.innerHTML='<div class="head">Карандаш</div><div class="grid" style="grid-template-columns:repeat(2,1fr)">'+
    '<button class="tool" data-pen="pen" title="Гелевая ручка (1) · правая кнопка — настройки"><svg viewBox="0 0 24 24"><path d="M4 20l4-1 10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 15.5 4 20z"/><path d="M13.5 6.5l4 4"/></svg></button>'+
    '<button class="tool" data-pen="marker" title="Маркер (2) · правая кнопка — настройки"><svg viewBox="0 0 24 24"><path d="M9 15l-3 3v2h4l3-3"/><path d="M12 17L7 12l8-8a2.8 2.8 0 0 1 4 4l-7 9z"/></svg></button>'+
    '</div>';
}
/* Доп. инструменты — каталог по школьным разделам физики (дальше можно
   дописать другие предметы новыми верхнеуровневыми ключами). Показывается
   всегда: доска пока не привязывает список к своему предмету. Разделы без
   наполнения всё равно рисуются — с заглушкой «скоро» — чтобы было видно,
   что структура уже есть, а не появилась только там, где что-то готово.

   У каждого пункта — mode:
   'preset'  — заранее настроенный инструмент «линия» (S.pathKind +
               S.physicsPreset), см. applyPhysicsLabel; готового типа
               объекта на сервере под них заводить не пришлось.
   'physics' — настоящий объект-симуляция (тип items 'physics', поле kind):
               ставится на доску кликом, как штамп, дальше двигается/
               крутится/ресайзится как картинка, а его физику на каждый
               кадр пересчитывает paintPhysics()/compassAngle() из текущих
               координат — см. эти функции ниже. */
const EXTRA_TOOLS={
  general:{title:'Общие инструменты',tools:[
    {id:'protractor',mode:'preset',title:'Транспортир — угол между двумя отрезками',
      icon:'<svg viewBox="0 0 24 24"><path d="M4 20L20 20"/><path d="M4 20L18 8"/><path d="M4 20L20 15"/></svg>'},
    {id:'ruler',mode:'preset',title:'Линейка — длина отрезка',
      icon:'<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6" rx="1"/><path d="M7 9v3M11 9v2M15 9v3"/></svg>'},
    {id:'vector',mode:'preset',title:'Вектор — стрелка с подписью величины',
      icon:'<svg viewBox="0 0 24 24"><path d="M4 20L18 6"/><path d="M18 6l-5 1M18 6l-1 5"/></svg>'},
  ]},
  mechanics:{title:'Механика',tools:[]},
  thermal:{title:'Тепловые явления',tools:[
    {id:'heater',mode:'physics',physicsKind:'heater',title:'Нагреватель — греет тело рядом',
      icon:'<svg viewBox="0 0 24 24"><path d="M7 20h10"/><path d="M9 20c-1-2 1-3 0-6 1 1 3 2 2 4"/><path d="M13 20c-1-2 1-3 0-6 1 1 3 2 2 4"/></svg>'},
    {id:'body',mode:'physics',physicsKind:'body',title:'Тело — вещество с массой и температурой',
      icon:'<svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M9 7V5h6v2"/></svg>'},
    {id:'calorimeter',mode:'physics',physicsKind:'calorimeter',title:'Калориметр — смешать два тела',
      icon:'<svg viewBox="0 0 24 24"><path d="M8 3h8"/><path d="M9 3v6l-4 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-4-9V3"/></svg>'},
  ]},
  electromagnetism:{title:'Электромагнетизм',tools:[
    {id:'magnet',mode:'physics',physicsKind:'magnet',title:'Магнит — поставьте на доску',
      icon:'<svg viewBox="0 0 24 24"><rect x="3" y="8" width="8" height="8" rx="1" fill="#D8433A" stroke="none"/><rect x="13" y="8" width="8" height="8" rx="1" fill="#2F6FE0" stroke="none"/></svg>'},
    {id:'compass',mode:'physics',physicsKind:'compass',title:'Компас — реагирует на ближайший магнит',
      icon:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 5l2.4 6.6L12 19l-2.4-6.6z" fill="currentColor" stroke="none"/></svg>'},
  ]},
  optics:{title:'Оптика',tools:[
    {id:'light-source',mode:'physics',physicsKind:'light-source',title:'Источник луча — пучок расходящихся лучей',
      icon:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M22 12h-3M5 12H2M19 5l-2 2M7 17l-2 2M19 19l-2-2M7 7L5 5"/></svg>'},
    {id:'lens-converging',mode:'physics',physicsKind:'lens',physicsSign:1,title:'Собирающая линза',
      icon:'<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M12 3l-4 4M12 3l4 4M12 21l-4-4M12 21l4-4"/></svg>'},
    {id:'lens-diverging',mode:'physics',physicsKind:'lens',physicsSign:-1,title:'Рассеивающая линза',
      icon:'<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M12 7l-4-4M12 7l4-4M12 17l-4 4M12 17l4 4"/></svg>'},
    {id:'mirror',mode:'physics',physicsKind:'mirror',title:'Плоское зеркало',
      icon:'<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M15 6l3-1M15 10l3-1M15 14l3-1M15 18l3-1"/></svg>'},
  ]},
  nuclear:{title:'Ядерная и атомная физика',tools:[]},
  math:{title:'Математика',tools:[
    {id:'graph',mode:'physics',physicsKind:'graph',title:'График — постройте несколько функций на одной плоскости',
      icon:'<svg viewBox="0 0 24 24"><path d="M3 12h18M12 3v18"/><path d="M4 17c2-6 4-8 5-8s2 8 4 8 3-10 5-10"/></svg>'},
  ]},
};
function findExtraTool(id){
  for(const key in EXTRA_TOOLS)for(const t of EXTRA_TOOLS[key].tools)if(t.id===id)return t;
  return null;
}
function buildMoreMenu(){
  let html='';
  for(const key in EXTRA_TOOLS){
    const sec=EXTRA_TOOLS[key];
    html+='<div class="head">'+sec.title+'</div>';
    if(!sec.tools.length){
      html+='<div class="soon">скоро</div>';
      continue;
    }
    html+='<div class="grid" style="grid-template-columns:repeat(3,1fr)">';
    for(const t of sec.tools)
      html+='<button class="tool" data-extra="'+t.id+'" title="'+t.title+' · правая кнопка — закрепить на панели">'+t.icon+'</button>';
    html+='</div>';
  }
  moreMenu.innerHTML=html;
}
function pinnedToolIds(){try{return JSON.parse(store.get('doska.pinnedTools')||'[]');}catch{return[];}}
function syncMoreMenuPins(){
  const list=pinnedToolIds();
  moreMenu.querySelectorAll('[data-extra]').forEach(b=>b.classList.toggle('on',list.includes(b.dataset.extra)));
}
/** Закреплённые инструменты рисуются в основной панели теми же значками,
    что и в доп.меню — общий каталог EXTRA_TOOLS не даёт им разъехаться. */
function renderPinnedTools(){
  const box=document.getElementById('pinnedTools');
  box.innerHTML='';
  for(const id of pinnedToolIds()){
    const t=findExtraTool(id);if(!t)continue;
    const b=document.createElement('button');
    b.className='tool';b.title=t.title+' · правая кнопка — открепить';b.innerHTML=t.icon;
    b.onclick=()=>applyExtraTool(id);
    b.oncontextmenu=e=>{e.preventDefault();toggleExtraPin(id);};
    box.appendChild(b);
  }
  syncMoreMenuPins();
}
function toggleExtraPin(id){
  const list=pinnedToolIds();
  const i=list.indexOf(id);
  if(i>=0)list.splice(i,1);else list.push(id);
  store.set('doska.pinnedTools',JSON.stringify(list));
  renderPinnedTools();
  hint(i>=0?'Инструмент откреплён от панели':'Инструмент закреплён на панели');
}
/** Пресеты физики — обычная «линия»/«ломаная», просто с готовой настройкой и
    подписью-результатом после рисования (см. applyPhysicsLabel в commitPath):
    новый тип объекта на сервере не заводим, линия и текст уже полностью
    поддержаны (сохранение, отмена, синхронизация). Объекты-симуляции
    (mode:'physics') — настоящий новый тип items, см. placePhysics(). */
function applyExtraTool(id){
  const t=findExtraTool(id);
  if(!t){moreOpen(false);return;}
  if(t.mode==='physics'){S.physicsKind=t.physicsKind;S.physicsSign=t.physicsSign||1;setTool('physics');}
  else if(id==='protractor'){S.pathKind='polyline';S.physicsPreset='protractor';setTool('path');}
  else if(id==='ruler'){S.pathKind='line';S.physicsPreset='ruler';setTool('path');}
  else if(id==='vector'){S.pathKind='line';S.a2=4;S.physicsPreset='vector';setTool('path');}
  moreOpen(false);
}

/* Popover-и «Карандаш/Фигуры/Линии/Ещё» устроены одинаково: кнопка в доке
   раскрывает список, иконка кнопки отражает последний выбор. */
/* Список открывается напротив кнопки, по которой кликнули, а не по центру
   экрана — иначе на длинной панели глаз теряет связь между значком и
   списком, который выехал где-то далеко сверху или снизу от него. На узком
   экране список и так уходит вниз отдельной раскладкой (см. медиа-запрос
   .subtools) — там подстройку по кнопке не делаем, чтобы её не перебить. */
function positionSubtools(menu,btn){
  if(narrowScreen()){menu.style.top='';menu.style.transform='';return;}
  const r=btn.getBoundingClientRect();
  const h=menu.offsetHeight||300;
  const top=Math.min(Math.max(r.top+r.height/2-h/2,12),innerHeight-h-12);
  menu.style.top=top+'px';
  menu.style.transform='none';
}
function popoverToggle(btn,menu){
  return on=>{
    menu.classList.toggle('hidden',!on);
    btn.setAttribute('aria-expanded',on?'true':'false');
    if(on)positionSubtools(menu,btn);
  };
}
const shapesOpen=popoverToggle(shapesBtn,shapesMenu);
const pathOpen=popoverToggle(pathBtn,pathMenu);
const penOpen=popoverToggle(penBtn,penKindMenu);
const moreOpen=popoverToggle(moreBtn,moreMenu);
function closeAllPopovers(){shapesOpen(false);pathOpen(false);penOpen(false);moreOpen(false);}
function syncShapeIcon(){
  const b=S.tool==='shape'&&shapesMenu.querySelector('[data-shape="'+S.shapeKind+'"]');
  if(b)shapesBtn.innerHTML=b.innerHTML;
}
function syncPathIcon(){
  const b=S.tool==='path'&&pathMenu.querySelector('[data-path="'+S.pathKind+'"]');
  if(b)pathBtn.innerHTML=b.innerHTML;
}
function syncPenIcon(){
  const kind=S.tool==='marker'?'marker':'pen';
  const b=penKindMenu.querySelector('[data-pen="'+kind+'"]');
  if(b)penBtn.innerHTML=b.innerHTML;
}
/* Щелчок по значку открывает список и сразу берёт инструмент по умолчанию:
   раньше он только раскрывал список, и приходилось делать второй клик, чтобы
   начать рисовать. Если инструмент уже выбран — оставляем его, менять его
   под рукой человека не годится. */
const PEN_TITLE={pen:'Перо',marker:'Маркер',shape:'Фигура',path:'Линия',text:'Надпись',arc:'Циркуль'};
function updatePenPanel(){
  const on=S.panelOpen&&STYLED.has(S.tool)&&!!S.boardId;
  document.getElementById('penPanel').classList.toggle('hidden',!on);
  if(on)document.getElementById('penTitle').textContent=PEN_TITLE[S.tool]||'Настройки';
}
function openPenPanel(){S.panelOpen=true;updatePenPanel();}
function setTool(t){
  if(t!=='path')S.physicsPreset=null;
  S.tool=t;
  document.querySelectorAll('.tool[data-tool]').forEach(b=>b.classList.toggle('on',b.dataset.tool===t));
  document.querySelectorAll('.tool[data-shape]').forEach(b=>b.classList.toggle('on',t==='shape'&&b.dataset.shape===S.shapeKind));
  document.querySelectorAll('.tool[data-path]').forEach(b=>b.classList.toggle('on',t==='path'&&b.dataset.path===S.pathKind));
  shapesBtn.classList.toggle('on',t==='shape');
  pathBtn.classList.toggle('on',t==='path');
  penBtn.classList.toggle('on',t==='pen'||t==='marker');
  syncShapeIcon();syncPathIcon();syncPenIcon();
  const styled=STYLED.has(t);
  const fillable=t==='shape'||t==='path';
  updatePenPanel();
  document.getElementById('fillRow').classList.toggle('hidden',!fillable);
  document.getElementById('dashRow').classList.toggle('hidden',!fillable);
  document.getElementById('arrowRow').classList.toggle('hidden',t!=='path');
  // скорость меняет толщину только у пера и маркера — у фигур её нет
  document.getElementById('sensRow').classList.toggle('hidden',t!=='pen'&&t!=='marker');
  if(t!=='select'){select(null);marquee=null;}
  if(t==='pen'||t==='marker'){
    S.color=t==='marker'?S.markerColor:S.penColor;
    if(t==='marker'&&S.size<12){S.size=18;sizeEl.value=18;}
    if(t==='pen'&&S.size>12){S.size=4;sizeEl.value=4;}
  }
  if(styled){
    sizeVal.textContent=S.size;renderInks();drawPreview();renderFills();updateDashButtons();
  }
  if(t==='path'){
    document.getElementById('a1Sel').value=S.a1;
    document.getElementById('a2Sel').value=S.a2;
  }
  updatePhysicsPanel();
  applyCursor();drawLive();
}
const followEl=document.getElementById('mfollow'),followVal=document.getElementById('mfollowVal');
const sensEl=document.getElementById('sens'),sensVal=document.getElementById('sensVal');
function drawPreview(){
  const w=prev.clientWidth||160,h=46;
  prev.width=w*dpr;prev.height=h*dpr;
  pctx.setTransform(dpr,0,0,dpr,0,0);
  pctx.fillStyle=PAPER;pctx.fillRect(0,0,w,h);
  const s=mkStroke(S.tool,S.color,Math.min(S.size,h*0.5),'preview');
  for(let i=0;i<60;i++){
    const t=i/59;
    s.pts.push({x:10+t*(w-20),y:h/2+Math.sin(t*Math.PI*2.2)*(h*0.24),p:0.35+0.65*Math.sin(t*Math.PI)});
  }
  pctx.save();if(s.type==='marker')pctx.globalAlpha=0.42;
  pctx.fillStyle=s.color;outlinePath(pctx,s);pctx.fill();pctx.restore();
}
/* Участники свёрнуты в один значок со счётчиком; имена — по нажатию.
   На панели их аватарки занимали место тем больше, чем больше людей. */
const dockEl=document.getElementById('dock'), dockEdge=document.getElementById('dockEdge');
function applyDockPinned(){
  const pinned=S.dockPinned;
  dockEl.classList.toggle('away',!pinned);
  dockEdge.classList.toggle('show',!pinned);
  const b=document.getElementById('dockPin');
  b.classList.toggle('off',!pinned);
  b.title=pinned?'Открепить панель — будет прятаться у края':'Закрепить панель на экране';
}
const narrowScreen=()=>innerWidth<=700||innerHeight<=520;
const touchOnly=narrowScreen()||matchMedia('(hover:none)').matches;
async function toClipboard(text){
  try{
    if(navigator.clipboard&&window.isSecureContext){
      await navigator.clipboard.writeText(text);
      return true;
    }
  }catch{ /* не вышло — пробуем по-старому */ }
  try{
    const ta=document.createElement('textarea');
    ta.value=text;
    ta.setAttribute('readonly','');
    // за экраном, но в документе: невидимое поле не копируется
    ta.style.cssText='position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();ta.setSelectionRange(0,text.length);
    const done=document.execCommand('copy');
    ta.remove();
    return done;
  }catch{ return false; }
}

async function copyLink(id,label){
  const link=location.origin+'/board/'+id;
  hint(await toClipboard(link)
    ? label+' скопирована'
    : 'Не вышло скопировать — вот она: '+link);
}

/* Списки панели: открыт может быть только один, щелчок мимо закрывает оба. */
const peersPop=document.getElementById('peersPop'), linkPop=document.getElementById('linkPop');
const topMorePop=document.getElementById('topMorePop');
function popOpen(el){
  for(const p of [peersPop,linkPop,topMorePop])p.classList.toggle('hidden',p!==el||!el);
  if(el===peersPop)fillPeersPop();
  if(el===linkPop){
    document.getElementById('linkVal').value=location.origin+'/board/'+S.boardId;
  }
}
function duplicateSelected(){
  const list=selection.filter(it=>!it.locked);
  if(!list.length)return;
  const OFF=20, clones=[];
  for(const src of list){
    const clone=BOX_TYPES.has(src.type)
      ?{...src,id:newId(),x:src.x+OFF,y:src.y+OFF,bbox:null,locked:false}
      :ARC_TYPES.has(src.type)
      ?{...src,id:newId(),cx:src.cx+OFF,cy:src.cy+OFF,bbox:null,locked:false}
      :{...src,id:newId(),pts:src.pts.map(p=>('p' in p)?{x:p.x+OFF,y:p.y+OFF,p:p.p}:{x:p.x+OFF,y:p.y+OFF}),bbox:null,locked:false};
    addItem(clone);
    net.send({t:'add',item:deflate(clone)});
    clones.push(clone);
  }
  pushUndo(clones.map(item=>({type:'add',item})));
  selectMany(clones);
}
// Дублирование живёт в меню по правой кнопке и на Ctrl+D: над выделением
// нужны только замок и корзина, остальное туда не помещается по смыслу.

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
inkCustomInput.oninput=()=>setInkColor(inkCustomInput.value);
document.querySelectorAll('[data-dash]').forEach(b=>{
  b.onclick=()=>{S.dash=+b.dataset.dash;updateDashButtons();applyStyleToSelection('dash',S.dash);};
});
/* ── фигуры под одним значком ──────────────────────────────
   Значок показывает последнюю выбранную фигуру, нажатие открывает список.
   Горячие клавиши R/O/L/N/C/M работают напрямую, минуя список. */
shapesBtn.onclick=()=>{
  const opening=shapesMenu.classList.contains('hidden');
  shapesOpen(opening);
  if(opening&&S.tool!=='shape'){S.shapeKind='rect';setTool('shape');}
};
pathBtn.onclick=()=>{
  const opening=pathMenu.classList.contains('hidden');
  pathOpen(opening);
  if(opening&&S.tool!=='path'){S.physicsPreset=null;S.pathKind='line';setTool('path');}
};
penBtn.onclick=()=>{
  const opening=penKindMenu.classList.contains('hidden');
  penOpen(opening);
  if(opening&&S.tool!=='pen'&&S.tool!=='marker')setTool('pen');
};
moreBtn.onclick=()=>moreOpen(moreMenu.classList.contains('hidden'));
// клик мимо закрывает открытый список; capture — чтобы успеть до обработчиков холста
document.addEventListener('pointerdown',e=>{
  for(const [btn,menu,close] of [[shapesBtn,shapesMenu,shapesOpen],[pathBtn,pathMenu,pathOpen],
                                  [penBtn,penKindMenu,penOpen],[moreBtn,moreMenu,moreOpen]]){
    if(menu.classList.contains('hidden'))continue;
    if(menu.contains(e.target)||btn.contains(e.target))continue;
    close(false);
  }
},true);

/* ── панель настроек инструмента ───────────────────────────
   По умолчанию скрыта: холст важнее. Открывается правой кнопкой по значку
   инструмента и повторным нажатием по уже выбранному. */
document.getElementById('penClose').onclick=()=>{S.panelOpen=false;updatePenPanel();};
document.getElementById('dock').addEventListener('contextmenu',e=>{
  const b=e.target.closest('.tool');
  if(!b||b.disabled)return;
  let t=null;
  if(b.dataset.tool)t=b.dataset.tool;
  else if(b.dataset.shape){S.shapeKind=b.dataset.shape;t='shape';}
  else if(b.dataset.path){S.pathKind=b.dataset.path;t='path';}
  else if(b===shapesBtn)t='shape';
  else if(b===pathBtn)t='path';
  else if(b===penBtn)t=S.tool==='marker'?'marker':'pen';
  if(!t||!STYLED.has(t))return;          // у ластика, руки и выделения настроек нет
  e.preventDefault();
  setTool(t);openPenPanel();
});

document.querySelectorAll('.tool[data-tool]').forEach(b=>b.onclick=()=>{
  // повторное нажатие по уже выбранному инструменту открывает и закрывает его
  // настройки — иначе про правую кнопку никто не догадается
  const same=S.tool===b.dataset.tool;
  setTool(b.dataset.tool);
  if(same&&STYLED.has(b.dataset.tool)){S.panelOpen=!S.panelOpen;updatePenPanel();}
});
// Списки фигур/линий/карандаша/доп.инструментов строятся из каталогов,
// поэтому кнопки надо создать до того, как на них вешают обработчики.
buildShapesMenu();buildPathMenu();buildPenMenu();buildMoreMenu();
document.querySelectorAll('.tool[data-shape]').forEach(b=>b.onclick=()=>{
  S.shapeKind=b.dataset.shape;setTool('shape');shapesOpen(false);
});
document.querySelectorAll('.tool[data-path]').forEach(b=>b.onclick=()=>{
  S.physicsPreset=null;S.pathKind=b.dataset.path;setTool('path');pathOpen(false);
});
document.querySelectorAll('.tool[data-pen]').forEach(b=>b.onclick=()=>{
  setTool(b.dataset.pen);penOpen(false);
});
document.querySelectorAll('#moreMenu [data-extra]').forEach(b=>{
  b.onclick=()=>applyExtraTool(b.dataset.extra);
  b.oncontextmenu=e=>{e.preventDefault();toggleExtraPin(b.dataset.extra);};
});
renderPinnedTools();
document.getElementById('a1Sel').onchange=e=>{S.a1=+e.target.value;applyStyleToSelection('a1',S.a1);};
document.getElementById('a2Sel').onchange=e=>{S.a2=+e.target.value;applyStyleToSelection('a2',S.a2);};
sizeEl.oninput=()=>{S.size=+sizeEl.value;sizeVal.textContent=S.size;drawPreview();applyStyleToSelection('size',S.size);};

/* Обе настройки запоминаются в браузере, а не на доске: это привычка руки
   конкретного человека, а не свойство занятия. */
followEl.value=Math.round(S.follow*100);followVal.textContent=followEl.value;
followEl.oninput=()=>{
  S.follow=+followEl.value/100;
  followVal.textContent=followEl.value;
  store.set('doska.follow',String(S.follow));
  document.getElementById('mfollowHint').textContent=S.follow>=0.9
    ?'Линия идёт след в след за мышью — заметно каждое подрагивание.'
    :S.follow<=0.3
      ?'Линия сильно сглажена: подрагивание не видно, но резкий угол смажется.'
      :'Выше — линия идёт точно за мышью. Ниже — мягче, дрожание сглаживается.';
  drawPreview();
};

sensEl.value=Math.round(S.sens*100);sensVal.textContent=sensEl.value;
sensEl.oninput=()=>{
  S.sens=+sensEl.value/100;
  sensVal.textContent=sensEl.value;
  store.set('doska.sens',String(S.sens));
  document.getElementById('sensHint').textContent=S.sens<=0
    ?'Линия ровная: толщина не зависит от скорости.'
    :'Чем быстрее ведёте, тем тоньше линия. На нуле линия ровная.';
  drawPreview();
};

document.getElementById('undo').onclick=undo;
document.getElementById('redo').onclick=redo;
document.getElementById('zoomIn').onclick =()=>zoomAt(board.clientWidth/2,board.clientHeight/2,1.25);
document.getElementById('zoomOut').onclick=()=>zoomAt(board.clientWidth/2,board.clientHeight/2,0.8);
document.getElementById('home').onclick=()=>{
  S.cam={x:board.clientWidth/2,y:board.clientHeight/2,z:1};camChanged();
};
document.getElementById('gridBtn').onclick=()=>{
  S.grid=GRID_MODES[(GRID_MODES.indexOf(S.grid)+1)%GRID_MODES.length];
  store.set('doska.grid',S.grid);hint('Фон: '+GRID_NAMES[S.grid]);drawBoard();
};
document.getElementById('wipe').onclick=()=>{
  if(S.cap!=='owner')return;
  if(confirm('Очистить доску у всех участников? Это нельзя отменить.'))net.send({t:'clear'});
};
/* Во встроенном браузере Telegram холст всё равно пытается утянуть страницу:
   touch-action он местами не слушает. Гасим само событие — но только над
   холстом, чтобы окна и списки прокручивались как обычно. */
document.addEventListener('touchmove',e=>{
  if(e.target&&e.target.closest&&e.target.closest('#stage'))e.preventDefault();
},{passive:false});

/* ═══════════════════ панель: закрепить или прятать ═══════════════════
   Закреплённая всегда на месте — так привычнее на большом экране. Открепишь,
   и она уезжает за край, оставляя язычок: наводишь — выезжает обратно. На
   планшете это возвращает половину полезной ширины.

   Выбор запоминается в браузере: это привычка человека, а не свойство доски. */
document.getElementById('dockPin').onclick=()=>{
  S.dockPinned=!S.dockPinned;
  store.set('doska.dockPinned',S.dockPinned?'1':'0');
  applyDockPinned();
  hint(S.dockPinned?'Панель закреплена':'Панель прячется — наведите на левый край');
};
/* Язычок работает и мышью, и пальцем.

   Мышью: навёл — выехала, увёл — уехала. Пальцем наведения нет вовсе, поэтому
   там она открывается касанием, а закрывается сама — как только инструмент
   выбран или человек тронул холст. Раньше касание язычка закрепляло панель
   насовсем, и на телефоне она навсегда занимала треть экрана. */
/* «Тесный экран» определяем по ширине, а не по наличию наведения: наведение
   врут и планшеты с мышью, и встроенные браузеры, а ширина не врёт. Именно она
   и решает, мешает панель или нет. */
dockEdge.addEventListener('pointerenter',e=>{
  if(e.pointerType!=='touch')dockEl.classList.add('peek');
});
dockEl.addEventListener('pointerleave',e=>{
  if(e.pointerType!=='touch')dockEl.classList.remove('peek');
});
dockEdge.addEventListener('click',()=>{
  if(touchOnly)dockEl.classList.add('peek');
  else{S.dockPinned=true;store.set('doska.dockPinned','1');applyDockPinned();}
});
// выбрали инструмент — панель уходит обратно, чтобы не закрывать написанное
dockEl.addEventListener('click',e=>{
  if(!touchOnly||S.dockPinned)return;
  if(e.target.closest('#dockPin')||e.target.closest('#shapesBtn')||e.target.closest('#pathBtn')||
     e.target.closest('#penBtn')||e.target.closest('#moreBtn'))return;
  if(e.target.closest('.tool'))setTimeout(()=>dockEl.classList.remove('peek'),180);
});
// тронули холст — тоже убираем (и выехавший док, и открытую панель настроек
// пера/фигуры: обе плавающие панели мешают одинаково, если их не убрать)
stage.addEventListener('pointerdown',()=>{
  if(!S.dockPinned)dockEl.classList.remove('peek');
  if(S.panelOpen){S.panelOpen=false;updatePenPanel();}
},true);

/* На телефоне панель по умолчанию спрятана: экран узкий, и столбец
   инструментов съедает его заметную часть. На большом экране всё наоборот —
   там она закреплена, как и была. */
if(touchOnly&&store.get('doska.dockPinned')===null)S.dockPinned=false;
applyDockPinned();          // состояние надо применить сразу, а не ждать нажатия

document.getElementById('callAll').onclick=()=>{
  if(S.cap!=='owner')return;
  net.send({t:'callAll',cam:{x:S.cam.x,y:S.cam.y,z:S.cam.z},w:board.clientWidth});
  hint('Все участники перенесены к этому месту');
};
document.getElementById('follow').onclick=e=>{
  S.following=!S.following;
  e.currentTarget.classList.toggle('on',S.following);
  hint(S.following?'Вы следуете за преподавателем':'Свободный просмотр');
};
/* Кладём строку в буфер обмена.

   navigator.clipboard есть только на защищённом соединении, а доска пока
   отдаётся по обычному http — поэтому там он молча отказывает, и раньше код
   уходил на запасной путь с окном, куда ссылка выводилась текстом. Человек
   ждал «скопировано», а получал окно, которое надо закрывать руками.

   Запасной путь теперь настоящий: временное поле и старая команда копирования.
   Она работает и без защищённого соединения, и никаких окон не показывает. */
document.getElementById('peersBtn').onclick=()=>
  popOpen(peersPop.classList.contains('hidden')?peersPop:null);
document.getElementById('copy').onclick=()=>
  popOpen(linkPop.classList.contains('hidden')?linkPop:null);
document.getElementById('topMoreBtn').onclick=()=>
  popOpen(topMorePop.classList.contains('hidden')?topMorePop:null);
document.getElementById('linkCopy').onclick=()=>{
  copyLink(S.boardId,'Ссылка на доску');
  const inp=document.getElementById('linkVal');inp.select();
};
addEventListener('pointerdown',e=>{
  if(peersPop.classList.contains('hidden')&&linkPop.classList.contains('hidden')&&topMorePop.classList.contains('hidden'))return;
  if(peersPop.contains(e.target)||linkPop.contains(e.target)||topMorePop.contains(e.target))return;
  if(e.target.closest&&e.target.closest('#peersBtn,#copy,#topMoreBtn'))return;
  popOpen(null);
},true);
document.getElementById('gear').onclick=()=>openSettings(S.boardId);
document.getElementById('title').onclick=async()=>{
  if(S.cap!=='owner')return;
  const t=prompt('Название доски:',document.getElementById('title').textContent);
  if(t===null)return;
  try{await api('/boards/'+S.boardId,{method:'PATCH',body:{title:t}});}
  catch(e){hint('Не переименовалось: '+e.message);}
};
document.getElementById('selDel').onclick=()=>{
  const list=selection.filter(it=>!it.locked);
  if(!list.length)return;
  select(null);
  const ids=list.map(it=>it.id);
  for(const id of ids)removeItem(id);
  net.send({t:'erase',ids});
  recordUndo({type:'erase',items:list});redoStack.length=0;drawBoard();
};
}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  closeAllPopovers, copyLink, drawPreview, duplicateSelected, popOpen, prev, renderInks,
  setTool, toClipboard, updatePenPanel,
};
