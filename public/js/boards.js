/* список досок, окно доступа, вкладка администратора */

import { S, api } from './core.js';
import { escapeHtml, hint } from './shell.js';
import { net } from './net.js';
import { copyLink, toClipboard } from './toolbar.js';
import { nav } from './app.js';

/* ═══════════════════ список досок ═══════════════════ */
const dash=document.getElementById('dash');
const loginEl=document.getElementById('login');
const grid=document.getElementById('boardGrid');
const when=ts=>{
  const d=new Date(ts),p=n=>String(n).padStart(2,'0');
  return p(d.getDate())+'.'+p(d.getMonth()+1)+'.'+d.getFullYear()+' '+p(d.getHours())+':'+p(d.getMinutes());
};
let myBoards=[];

function renderWho(){
  const el=document.getElementById('who');
  if(!S.you){el.innerHTML='';return;}
  el.innerHTML='';
  const b=document.createElement('b');b.textContent=S.you.name||S.you.email||'';
  const out=document.createElement('button');out.className='lnk';out.textContent='Выйти';
  out.onclick=async()=>{
    try{await api('/auth/logout',{method:'POST'});}catch{}
    S.you=null;nav('/login');
  };
  el.append(b,out);
}

async function loadBoards(retriesLeft){
  if(retriesLeft===undefined)retriesLeft=2;
  grid.innerHTML='<div class="empty"><div class="spin"></div>Загружаю…</div>';
  let d;
  try{ d=await api('/boards'); }
  catch(e){
    if(e.status===401){nav('/login');return;}
    if(retriesLeft>0){
      // Сразу после входа первый запрос к списку изредка бьёт по ещё не
      // прогретому соединению до Supabase и падает по сети — раньше в этом
      // случае помогало только ручное обновление страницы. Пробуем сами,
      // прежде чем сдаться и показать ошибку.
      setTimeout(()=>loadBoards(retriesLeft-1),700);
      return;
    }
    grid.innerHTML='<div class="empty">Не удалось получить список: '+escapeHtml(e.message)+'</div>';
    return;
  }
  S.you=d.you||S.you;renderWho();
  myBoards=d.boards||[];
  // доски создаёт только преподаватель — ученику кнопка ни к чему
  document.getElementById('newBoard').classList.toggle('hidden',!(S.you&&S.you.role==='teacher'));
  renderBoards();
}

/* Карточка доски целиком нажимаемая: по ней и щёлкают, чтобы открыть. Кнопка
   «Открыть» была лишней — карточка и есть кнопка. Ссылка и удаление ушли
   значками в правый верхний угол: это редкие действия, они не должны спорить
   с главным. */
const ICON_LINK='<svg viewBox="0 0 24 24"><path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg>';
const ICON_TRASH='<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';
const ICON_GEAR='<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8"/><path d="M17 6l2.5 2.5"/><path d="M15 8l2.5 2.5"/></svg>';
const ICON_EDIT='<svg viewBox="0 0 24 24"><path d="M4 20l4-1 10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 15.5 4 20z"/><path d="M13.5 6.5l4 4"/></svg>';

/* Переименование прямо в карточке.

   Окно с вопросом здесь ни к чему: название короткое, и править его удобнее
   там же, где оно написано. Enter сохраняет, Escape возвращает прежнее, уход
   мышью в сторону — тоже сохраняет: так ведут себя списки везде.

   Пока идёт правка, карточка не открывается по щелчку — иначе первое же
   касание поля уводило бы на доску. */
async function renameOnCard(el,b){
  const h=el.querySelector('h3');
  if(h.querySelector('input'))return;
  const was=b.title;
  el.classList.add('editing');

  const inp=document.createElement('input');
  inp.className='rename';
  inp.value=was;
  inp.maxLength=80;
  h.textContent='';h.appendChild(inp);
  inp.focus();inp.select();

  let done=false;
  const finish=async save=>{
    if(done)return; done=true;
    const name=inp.value.trim().slice(0,80);
    el.classList.remove('editing');
    if(!save||!name||name===was){h.textContent=was;return;}
    h.textContent=name;                       // показываем сразу, не дожидаясь сервера
    try{
      await api('/boards/'+b.id,{method:'PATCH',body:{title:name}});
      b.title=name;
      const card=myBoards.find(x=>x.id===b.id); if(card)card.title=name;
      hint('Название изменено');
    }catch(e){
      h.textContent=was;                      // не вышло — возвращаем как было
      hint('Не переименовалось: '+e.message);
    }
  };
  inp.onkeydown=e=>{
    e.stopPropagation();
    if(e.key==='Enter'){e.preventDefault();finish(true);}
    if(e.key==='Escape'){e.preventDefault();finish(false);}
  };
  inp.onblur=()=>finish(true);
  inp.onclick=e=>e.stopPropagation();
}

function boardCard(b){
  const el=document.createElement('div');
  el.className='bcard open';
  el.tabIndex=0;
  el.title='Открыть доску';
  el.innerHTML='<h3></h3><div class="when"></div><div class="cardtools"></div>';
  el.querySelector('h3').textContent=b.title;
  el.querySelector('.when').textContent=
    (b.mine?'':'ведёт '+(b.ownerName||'преподаватель')+' · ')+'изменена '+when(b.updated||b.created);

  const open=()=>nav('/board/'+b.id);
  el.onclick=e=>{
    if(el.classList.contains('editing'))return;
    if(!e.target.closest('.cardtool'))open();
  };
  el.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();open();} };

  const tools=el.querySelector('.cardtools');
  const tool=(cls,icon,title,fn)=>{
    const x=document.createElement('button');
    x.className='cardtool '+cls;x.innerHTML=icon;x.title=title;
    x.onclick=e=>{e.stopPropagation();fn(x);};
    tools.appendChild(x);return x;
  };
  tool('',ICON_LINK,'Скопировать ссылку',x=>{
    copyLink(b.id,'Ссылка на доску');
    x.classList.add('done');
    setTimeout(()=>x.classList.remove('done'),1400);
  });
  if(b.mine){
    tool('',ICON_EDIT,'Переименовать',()=>renameOnCard(el,b));
    tool('',ICON_GEAR,'Кого пускать на доску',()=>openSettings(b.id));
    tool('del',ICON_TRASH,'Удалить доску',async()=>{
      if(!confirm('Удалить доску «'+b.title+'» вместе со всем содержимым?'))return;
      try{ await api('/boards/'+b.id,{method:'DELETE'});
           myBoards=myBoards.filter(x=>x.id!==b.id);renderBoards(); }
      catch(e){alert('Не получилось: '+e.message);}
    });
  }
  return el;
}

/* ═══════════════════ нагрузка сервиса ═══════════════════
   Вкладка администратора. Числа берёт сервер у Prometheus и отдаёт готовыми —
   в браузер ничего лишнего не попадает, а Grafana остаётся закрытой снаружи.

   Показываем не всё подряд, а то, по чему видно состояние: сколько занятий
   идёт, сколько людей, не растёт ли задержка, хватает ли памяти и места. */
let statsTimer=null;
const humanBytes=n=>{
  if(n==null)return '—';
  const u=['Б','КБ','МБ','ГБ'];let i=0,v=n;
  while(v>=1024&&i<u.length-1){v/=1024;i++;}
  return v.toFixed(v<10&&i?1:0)+' '+u[i];
};
const humanTime=s=>{
  if(s==null)return '—';
  const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return d?d+' сут '+h+' ч':h?h+' ч '+m+' мин':m+' мин';
};
const FORMAT={
  memory:humanBytes, freeMem:humanBytes, freeDisk:humanBytes,
  uptime:humanTime,
  lag:v=>v==null?'—':(v*1000).toFixed(0)+' мс',
  ops:v=>v==null?'—':v.toFixed(2)+' /с',
  cpu:v=>v==null?'—':v.toFixed(0)+' %',
};
// когда число стоит показать красным: это и есть пороги, о которых стоит знать
const ALARM={
  lag:v=>v>0.2, cpu:v=>v>85,
  freeDisk:v=>v<1.5e9, freeMem:v=>v<120e6,
  items:v=>v>60000,
};

async function loadStats(){
  const box=document.getElementById('stats');
  try{
    const d=await api('/admin/stats');
    if(!d.ok){
      box.innerHTML='<div class="err">Сводка недоступна: '+escapeHtml(d.error||'нет данных')+'</div>';
      return;
    }
    box.innerHTML='';
    for(const key in d.values){
      const {label,value}=d.values[key];
      const el=document.createElement('div');
      el.className='stat'+(value!=null&&ALARM[key]&&ALARM[key](value)?' warn':'');
      const fmt=FORMAT[key]||(v=>v==null?'—':Math.round(v).toLocaleString('ru'));
      el.innerHTML='<div class="v"></div><div class="k"></div>';
      el.querySelector('.v').textContent=fmt(value);
      el.querySelector('.k').textContent=label;
      box.appendChild(el);
    }
  }catch(e){
    box.innerHTML='<div class="err">Не удалось получить сводку: '+escapeHtml(e.message)+'</div>';
  }
}
function renderBoards(){
  const mine=myBoards.filter(b=>b.mine);
  const other=myBoards.filter(b=>!b.mine);
  document.getElementById('dashSub').textContent=myBoards.length?(myBoards.length+' шт.'):'';
  // нагрузка сервиса — только администратору
  document.getElementById('statsBtn').hidden=!(S.you&&S.you.role==='admin');
  grid.innerHTML='';
  if(!myBoards.length){
    grid.innerHTML=S.you&&S.you.role==='teacher'
      ? '<div class="empty">Пока ни одной доски.<br>Нажмите «Новая доска» — она сразу откроется, '+
        'а ссылку и участников можно добавить в любой момент.</div>'
      : '<div class="empty">Вас пока не добавили ни на одну доску.<br>'+
        'Преподаватель откроет её для вас — она появится здесь.</div>';
    return;
  }
  const group=(title,list)=>{
    if(!list.length)return;
    if(mine.length&&other.length){
      const h=document.createElement('div');
      h.style.cssText='grid-column:1/-1;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8A8378;margin-top:6px';
      h.textContent=title;grid.appendChild(h);
    }
    for(const b of list)grid.appendChild(boardCard(b));
  };
  group(S.you&&S.you.role==='admin'?'Мои доски':'Мои доски',mine);
  group(S.you&&S.you.role==='admin'?'Доски организации (только просмотр)':'Доски, где я участник',other);
}

async function openSettings(id){
  /* Настройки берём с сервера, а не из списка досок.

     Раньше брали из myBoards — но он наполняется только на странице списка.
     Открытое из самой доски окно всегда показывало значения по умолчанию:
     «гостевая ссылка выключена», даже если она включена. Выглядело так, будто
     настройка не сохранилась, хотя на сервере она стояла. */
  let info=myBoards.find(b=>b.id===id)||null;
  try{
    const d=await api('/boards/'+id);
    if(d&&d.board)info={id,title:d.board.title,
      guestAccess:d.board.guest_access,objectEditPolicy:d.board.object_edit_policy};
  }catch{ /* не ответил — покажем что есть, но об этом скажем ниже */ }
  if(!info)info={id,title:document.getElementById('title').textContent,
    guestAccess:'none',objectEditPolicy:'creator'};
  /* Список учеников есть только у того, кто вошёл под своей учётной записью
     МЦКО: он берётся из mcko-app под его же правами. Гостю по ссылке брать
     его неоткуда и незачем — ему остаётся доступ по ссылке. */
  const withStudents=!!(S.you&&S.you.role==='teacher');

  const m=document.createElement('div');
  m.className='modal';
  m.innerHTML='<div class="sheet">'+
    '<h2>Доступ к доске</h2><p id="stTitle"></p>'+
    (withStudents
      ? '<div class="sub">Участники</div><div id="stList"></div>'+
        '<div class="row"><select id="stPick" style="flex:1"></select>'+
        '<button class="mini" id="stAdd" style="background:#fff;color:#15171A">Добавить</button></div>'
      : '<div class="sub">Участники</div>'+
        '<p style="color:#8C9199;font-size:12.5px;margin:0 0 4px">'+
        'Список учеников доступен после входа через МЦКО. Сейчас доской можно '+
        'поделиться только ссылкой.</p>')+
    // Общий замок: он один умеет останавливать и гостей по ссылке, у которых
    // нет строки участника и, значит, нет своего списка.
    '<div class="sub">Рисование на доске</div>'+
    '<div class="row"><select id="stLock" style="flex:1">'+
      '<option value="0">разрешено всем, кому дали доступ</option>'+
      '<option value="1">запрещено — рисует только преподаватель</option>'+
    '</select></div>'+
    '<div class="sub">Гостевая ссылка</div>'+
    '<div class="row"><select id="stGuest" style="flex:1">'+
      '<option value="none">выключена — только по аккаунту</option>'+
      '<option value="view">по ссылке можно смотреть</option>'+
      '<option value="edit">по ссылке можно рисовать</option>'+
    '</select><button class="mini" id="stCopy" style="background:#fff;color:#15171A">Копировать</button></div>'+
    '<div class="sub">Удаление объектов</div>'+
    '<div class="row"><select id="stPolicy" style="flex:1">'+
      '<option value="creator">каждый удаляет только своё</option>'+
      '<option value="anyone">любой участник удаляет любое</option>'+
    '</select></div>'+
    // Кнопка появляется, только когда есть что применять: пустое «Сохранить»
    // сбивает с толку — непонятно, сохранилось ли уже.
    '<button class="btn" id="stSave" hidden>Сохранить</button>'+
    '<button class="btn ghost" id="stClose">Закрыть</button>'+
    '<div class="err" id="stErr"></div></div>';
  document.body.appendChild(m);
  const $=s=>m.querySelector(s);
  const err=t=>{$('#stErr').textContent=t||'';};
  $('#stTitle').textContent=info.title;
  $('#stGuest').value=info.guestAccess||'none';
  $('#stPolicy').value=info.objectEditPolicy||'creator';
  $('#stLock').value=S.locked?'1':'0';

  /* Что ещё не применено. Раньше каждая правка уходила на сервер сразу, и было
     не видно, где заканчивается настройка: человек закрывал окно, не зная,
     сохранилось ли. Теперь правки копятся, а «Сохранить» применяет их разом и
     перезагружает полотно, чтобы новые права подхватились без F5. */
  const pending={board:{},add:[],drop:[],access:{}};
  const dirty=()=>Object.keys(pending.board).length||pending.add.length||
                  pending.drop.length||Object.keys(pending.access).length;
  const sync=()=>{$('#stSave').hidden=!dirty();};

  const closeAll=()=>{
    if(dirty()&&!confirm('Есть несохранённые изменения. Закрыть без сохранения?'))return;
    m.remove();
  };
  $('#stClose').onclick=closeAll;
  m.onclick=e=>{if(e.target===m)closeAll();};

  let students=[],parts=[];
  const drawList=()=>{
    const box=$('#stList');box.innerHTML='';
    if(!parts.length){
      const d=document.createElement('div');
      d.style.cssText='color:#8C9199;font-size:12.5px;margin-bottom:8px';
      d.textContent='Пока никого. Добавьте своих учеников ниже.';
      box.appendChild(d);
    }
    for(const p of parts){
      const row=document.createElement('div');row.className='row';
      const nm=document.createElement('span');nm.textContent=p.name||p.id;
      const sel=document.createElement('select');
      sel.innerHTML='<option value="edit">рисует</option><option value="view">смотрит</option>';
      sel.value=p.access;
      sel.onchange=()=>{p.access=sel.value;pending.access[p.id]=sel.value;sync();};
      const x=document.createElement('button');x.className='x';x.textContent='×';x.title='Убрать';
      x.onclick=()=>{
        // если участника только что добавили и ещё не сохранили — просто
        // забываем про него, а не шлём удаление того, чего на сервере нет
        const idx=pending.add.indexOf(p.id);
        if(idx>=0)pending.add.splice(idx,1); else pending.drop.push(p.id);
        delete pending.access[p.id];
        parts=parts.filter(q=>q.id!==p.id);
        drawList();refreshPick();sync();
      };
      row.append(nm,sel,x);box.appendChild(row);
    }
  };
  const refreshPick=()=>{
    if(!withStudents)return;
    const has=new Set(parts.map(p=>p.id));
    const free=students.filter(s=>!has.has(s.id));
    // Пусто по двум разным причинам, и человеку важно понимать, по какой:
    // либо всех уже добавили, либо учеников за ним вообще нет.
    // Имя и класс приходят из profiles в mcko-app и вставляются в разметку —
    // значит через них в страницу попадает то, чего человек не писал сам.
    // Экранирование здесь не паранойя, а то же самое, что рядом в loadStats.
    $('#stPick').innerHTML=free.length
      ? free.map(s=>'<option value="'+escapeHtml(s.id)+'">'+
          escapeHtml(s.full_name||s.id)+(s.grade?' · '+escapeHtml(s.grade):'')+'</option>').join('')
      : '<option value="">'+(students.length?'все ваши ученики уже добавлены'
                                            :'за вами не закреплено ни одного ученика')+'</option>';
    $('#stAdd').disabled=!free.length;
  };

  try{
    const reqs=[api('/boards/'+id+'/participants')];
    if(withStudents)reqs.push(api('/students'));
    const [pr,st]=await Promise.all(reqs);
    parts=pr.participants||[];students=(st&&st.students)||[];
    drawList();refreshPick();
  }catch(e){err('Не удалось загрузить участников: '+e.message);}

  if(withStudents)$('#stAdd').onclick=()=>{
    const who=$('#stPick').value;
    if(!who)return;
    const s=students.find(x=>x.id===who)||{};
    parts.push({id:who,access:'edit',name:s.full_name});
    // если его же только что убирали — отменяем удаление, а не пишем оба
    const idx=pending.drop.indexOf(who);
    if(idx>=0)pending.drop.splice(idx,1); else pending.add.push(who);
    drawList();refreshPick();sync();err('');
  };

  const patch=async(body,onOk)=>{
    try{const d=await api('/boards/'+id,{method:'PATCH',body});
        const b=myBoards.find(x=>x.id===id);
        if(b&&d.board){b.guestAccess=d.board.guest_access;b.objectEditPolicy=d.board.object_edit_policy;}
        err('');if(onOk)onOk();}
    catch(e){err(e.message);}
  };
  // Замок идёт не через общий PATCH, а тем же сообщением, что и раньше: его
  // должны немедленно увидеть все, кто сейчас на доске.
  $('#stLock').onchange=()=>{pending.lock=$('#stLock').value==='1';sync();};
  $('#stGuest').onchange=()=>{pending.board.guest_access=$('#stGuest').value;sync();};
  $('#stPolicy').onchange=()=>{pending.board.object_edit_policy=$('#stPolicy').value;sync();};

  /* Применение разом. Порядок важен: сперва убираем, потом добавляем — иначе
     повторное добавление того, кого убирали, могло бы упереться в уникальность
     строки участника. */
  $('#stSave').onclick=async()=>{
    const btn=$('#stSave');btn.disabled=true;btn.textContent='Сохраняю…';
    try{
      for(const uid of pending.drop)
        await api('/boards/'+id+'/participants/'+uid,{method:'DELETE'});
      for(const uid of pending.add)
        await api('/boards/'+id+'/participants',{method:'POST',body:{user_id:uid,access:'edit'}});
      for(const uid in pending.access)
        await api('/boards/'+id+'/participants/'+uid,{method:'PATCH',body:{access:pending.access[uid]}});
      // напрямую, а не через patch(): тот гасит ошибку внутри себя, и неудача
      // выглядела бы удачей
      if(Object.keys(pending.board).length){
        const d=await api('/boards/'+id,{method:'PATCH',body:pending.board});
        const b=myBoards.find(x=>x.id===id);
        if(b&&d.board){b.guestAccess=d.board.guest_access;b.objectEditPolicy=d.board.object_edit_policy;}
      }

      if(pending.lock!==null&&pending.lock!==S.locked)net.send({t:'lock',on:pending.lock});
      pending.board={};pending.add=[];pending.drop=[];pending.access={};pending.lock=null;
      sync();err('');
      hint('Изменения сохранены');
      // Полотно берёт права в момент подключения, поэтому переподключаем его:
      // сервер пришлёт init с новыми правилами, и менять ничего руками не надо.
      if(S.boardId===id&&net.ws&&net.ws.readyState===1)net.ws.close(4001,'права изменены');
      m.remove();
    }catch(e){err(e.message);}
    finally{btn.disabled=false;btn.textContent='Сохранить';}
  };

  $('#stCopy').onclick=async()=>{
    if($('#stGuest').value==='none'){err('Сначала включите гостевую ссылку');return;}
    try{
      let g=(await api('/boards/'+id+'/guest-link')).token;
      if(!g)g=(await api('/boards/'+id+'/guest-link',{method:'POST'})).token;
      // Гостевая ссылка теперь и не нужна отдельно: доска пускает по своему
      // адресу. Кнопку оставляем — по ней копируется именно она.
      const link=location.origin+'/board/'+id+'?g='+encodeURIComponent(g);
      if(await toClipboard(link)){
        err('');$('#stCopy').textContent='Скопировано';
        setTimeout(()=>{$('#stCopy').textContent='Копировать';},1600);
      }else err('Не вышло скопировать: '+link);
    }catch(e){err(e.message);}
  };
}

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
document.getElementById('statsBtn').onclick=()=>{
  const box=document.getElementById('stats');
  const show=box.classList.contains('hidden');
  box.classList.toggle('hidden',!show);
  box.classList.toggle('show',show);
  document.getElementById('statsBtn').classList.toggle('on',show);
  if(statsTimer){clearInterval(statsTimer);statsTimer=null;}
  if(show){loadStats();statsTimer=setInterval(loadStats,15000);}
};

document.getElementById('newBoard').onclick=async()=>{
  const t=prompt('Название доски:','Занятие '+when(Date.now()).slice(0,10));
  if(t===null)return;
  try{
    const d=await api('/boards',{method:'POST',body:{title:t}});
    nav('/board/'+d.board.id);
  }catch(e){alert('Не получилось: '+e.message);}
};

/* ═══════════════════ доступ к доске ═══════════════════ */
/* Лист настроек: участники, гостевая ссылка, правило удаления объектов.
   Всё, что здесь меняется, проверяется ещё раз на сервере и в RLS. */
}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  dash, grid, loadBoards, loginEl, openSettings, renderWho,
};
