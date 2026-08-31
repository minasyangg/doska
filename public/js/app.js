/* вход и маршрутизация */

import { S, api, board, guestId, stage, store } from './core.js';
import { HINT_DEFAULT, escapeHtml, hint } from './shell.js';
import { select } from './selection.js';
import { drawBoard, resize } from './render.js';
import { net, setBoardLoaded, showBoardLoader } from './net.js';
import { closeAllPopovers, drawPreview, renderInks, setTool, updatePenPanel } from './toolbar.js';
import { dash, grid, loadBoards, loginEl, renderWho } from './boards.js';

/* ═══════════════════ вход ═══════════════════ */
let cfgP=null;
const config=()=>cfgP||(cfgP=api('/config').catch(()=>({})));

/* Человек пришёл по ссылке на доску, а сессии доски у него нет. Вместо формы
   входа отправляем его в mcko-app: там он, скорее всего, уже вошёл, и вернётся
   сюда с готовой сессией, ничего не вводя. Если не вошёл — mcko-app покажет
   свой вход и после него приведёт обратно на ту же доску.

   Метка в sessionStorage — защита от кольца. Если мы только что оттуда
   вернулись, а сессии всё равно нет (кука не встала, секреты разъехались),
   второй раз не отсылаем: показываем свою форму, иначе вкладка будет бесконечно
   ходить между двумя сайтами.
   Возвращает 'go' — ушли, 'loop' — только что пробовали, 'off' — не настроено. */
const SSO_MARK='doska.ssoTry';
async function mckoEnter(boardId){
  const c=await config();
  if(!c||!c.mcko)return 'off';
  let last=0;try{last=+sessionStorage.getItem(SSO_MARK)||0;}catch{}
  if(Date.now()-last<30000)return 'loop';
  try{sessionStorage.setItem(SSO_MARK,String(Date.now()));}catch{}
  location.replace(c.mcko+'/api/doska/open?b='+encodeURIComponent(boardId||''));
  return 'go';
}
const ssoDone=()=>{try{sessionStorage.removeItem(SSO_MARK);}catch{}};
function askGuestWay(entry){
  return new Promise(resolve=>{
    const canDraw=entry.guest==='edit';
    const m=document.createElement('div');
    m.className='modal';
    m.innerHTML='<div class="sheet">'+
      '<h2>'+escapeHtml(entry.title||'Доска')+'</h2>'+
      '<p>'+(canDraw
        ? 'По этой ссылке можно смотреть и писать.'
        : 'По этой ссылке можно смотреть. Писать разрешает преподаватель.')+'</p>'+
      '<input id="gnm" placeholder="Ваше имя — его увидят остальные" maxlength="24">'+
      '<button class="btn" id="gGo">Войти как гость</button>'+
      '<button class="btn ghost" id="gAcc">У меня есть учётная запись МЦКО</button>'+
      '<div class="err" id="gEr"></div></div>';
    document.body.appendChild(m);
    const inp=m.querySelector('#gnm');
    inp.value=S.name||'';
    setTimeout(()=>inp.focus(),0);
    const asGuest=()=>{
      const v=inp.value.trim();
      if(!v){m.querySelector('#gEr').textContent='Представьтесь, пожалуйста';return;}
      S.name=v;store.set('doska.name',v);m.remove();resolve('guest');
    };
    m.querySelector('#gGo').onclick=asGuest;
    inp.onkeydown=e=>{if(e.key==='Enter')asGuest();};
    m.querySelector('#gAcc').onclick=()=>{m.remove();resolve('account');};
  });
}

function askName(){
  return new Promise(resolve=>{
    const m=document.createElement('div');
    m.className='modal';
    m.innerHTML='<div class="sheet"><h2>Как вас зовут?</h2>'+
      '<p>Имя увидят остальные участники рядом с вашим курсором.</p>'+
      '<input id="nm" placeholder="Например: Пётр" maxlength="24">'+
      '<button class="btn" id="go">Войти на доску</button><div class="err" id="er"></div></div>';
    document.body.appendChild(m);
    const inp=m.querySelector('#nm');inp.value=S.name||'';inp.focus();
    const done=()=>{
      const v=inp.value.trim();
      if(!v){m.querySelector('#er').textContent='Введите имя';return;}
      S.name=v;store.set('doska.name',v);m.remove();resolve();
    };
    m.querySelector('#go').onclick=done;
    inp.onkeydown=e=>{if(e.key==='Enter')done();};
  });
}

const boardUi=['dock','cornerTools','penPanel','physicsPanel','topBar','zoombar','hint'];
function showView(what){
  dash.classList.toggle('hidden',what!=='dash');
  loginEl.classList.toggle('hidden',what!=='login');
  stage.classList.toggle('hidden',what!=='board');
  for(const id of boardUi)document.getElementById(id).classList.toggle('hidden',what!=='board');
  closeAllPopovers();
  updatePenPanel();                 // панель настроек открывается только вручную
}
const showBoard=on=>showView(on?'board':'dash');

/** Переход внутри приложения: настоящий путь, а не хеш. */
function nav(path){
  if(location.pathname+location.search!==path)window.history.pushState(null,'',path);
  route();
}

async function openBoard(id){
  if(S.boardId===id&&net.ws)return;
  net.close();                        // тоже снимет прелоадер — включаем его после
  setBoardLoaded(false);showBoardLoader('Загружаю доску…');
  S.boardId=id;S.cap='none';S.me=null;select(null);
  showView('board');
  resize();
  S.cam={x:board.clientWidth/2,y:board.clientHeight/2,z:1};
  document.getElementById('zoom').textContent='100%';
  hint(HINT_DEFAULT,60000);           // подсказка по умолчанию — на минуту, дальше сама скроется
  setTool(S.tool==='select'?'pen':S.tool);
  renderInks();drawPreview();drawBoard();
  net.connect();
}

async function route(){
  // Ссылки старого вида /#b=<id> уже разошлись ученикам — переводим их на
  // путь, а не отправляем человека в список гадать, куда он попал.
  const legacy=location.hash.match(/(?:^|[#&])b=([A-Za-z0-9_-]{1,40})/);
  if(legacy&&location.pathname==='/'){
    window.history.replaceState(null,'','/board/'+legacy[1]);
  }
  const p=location.pathname;
  const qs=new URLSearchParams(location.search);

  if(p==='/login'){
    net.close();S.boardId=null;
    showView('login');
    config().then(c=>document.getElementById('ssoRow').classList.toggle('hidden',!(c&&c.mcko)));
    document.getElementById('logErr').textContent=
      qs.get('e')==='ticket'?'Ссылка устарела — войдите почтой и паролем.':
      qs.get('e')==='offline'?'Сервис входа сейчас недоступен, попробуйте позже.':
      qs.get('e')==='sso'?'Автоматический вход не сработал — войдите почтой и паролем.':'';
    return;
  }

  const mBoard=p.match(/^\/board\/([A-Za-z0-9_-]{1,40})$/);
  if(mBoard){
    const id=mBoard[1];
    const g=qs.get('g');
    if(g){
      // гостевая ссылка: меняем её на обычную сессию доски и убираем токен из
      // адреса, чтобы он не остался в истории и не уехал в Referer
      if(!S.name)await askName();
      try{
        await api('/guest/enter',{method:'POST',body:{board:id,g,name:S.name,guestId:guestId()}});
      }catch(e){
        showView('dash');
        grid.innerHTML='<div class="empty">Ссылка недействительна: '+escapeHtml(e.message)+'</div>';
        window.history.replaceState(null,'','/');
        return;
      }
      window.history.replaceState(null,'','/board/'+id);
      return openBoard(id);
    }
    let me=null;
    try{ me=await api('/auth/me'); }catch{}
    if(!me){
      /* Сначала спрашиваем саму доску, пускает ли она без учётной записи.

         Раньше первым делом шли в МЦКО за личностью, а mckoEnter уводит
         страницу целиком. У кого аккаунта нет, тот попадал на чужую форму
         входа и обратно уже не возвращался: включённый гостевой доступ ничего
         не менял, потому что до него дело не доходило. */
      let entry=null;
      try{ entry=await api('/board-entry?b='+encodeURIComponent(id)); }catch{}
      if(entry&&entry.guest&&entry.guest!=='none'){
        const how=await askGuestWay(entry);
        if(how==='account'){
          const r=await mckoEnter(id);
          if(r==='go')return;
          nav('/login?next='+encodeURIComponent('/board/'+id)+(r==='loop'?'&e=sso':''));
          return;
        }
        try{
          await api('/guest/enter',{method:'POST',body:{board:id,name:S.name,guestId:guestId()}});
          return openBoard(id);
        }catch(e){
          showView('dash');
          grid.innerHTML='<div class="empty">Не удалось войти гостем: '+escapeHtml(e.message)+'</div>';
          return;
        }
      }

      // гостей не пускают — значит по учётной записи, как и раньше
      const r=await mckoEnter(id);
      if(r==='go')return;
      nav('/login?next='+encodeURIComponent('/board/'+id)+(r==='loop'?'&e=sso':''));
      return;
    }
    ssoDone();
    if(me.user){S.you=me.user;S.name=me.user.name||S.name;}
    else if(me.guest&&!S.name)S.name=me.guest.name||S.name;
    if(!S.name)await askName();
    return openBoard(id);
  }

  // всё остальное — список досок
  net.close();S.boardId=null;select(null);
  let me=null;
  try{ me=await api('/auth/me'); }catch{}
  if(!me||!me.user){nav('/login');return;}
  ssoDone();
  S.you=me.user;renderWho();
  showView('dash');
  loadBoards();
}

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
document.getElementById('loginForm').onsubmit=async e=>{
  e.preventDefault();
  const err=document.getElementById('logErr');
  const btn=document.getElementById('logGo');
  err.textContent='';btn.disabled=true;btn.textContent='Вхожу…';
  try{
    const d=await api('/auth/login',{method:'POST',body:{
      email:document.getElementById('logEmail').value.trim(),
      password:document.getElementById('logPass').value
    }});
    S.you=d.user;
    document.getElementById('logPass').value='';
    const next=new URLSearchParams(location.search).get('next');
    nav(next&&next.startsWith('/')?next:'/');
  }catch(ex){err.textContent=ex.message;}
  finally{btn.disabled=false;btn.textContent='Войти';}
};

/* Что доска рассказывает о себе до входа. Спрашиваем один раз на загрузку
   страницы: адрес mcko-app посреди сеанса не меняется. */
document.getElementById('ssoGo').onclick=async()=>{
  ssoDone();                                   // жмут руками — попытка законная
  const next=new URLSearchParams(location.search).get('next')||'';
  const m=next.match(/^\/board\/([A-Za-z0-9_-]{1,40})$/);
  if(await mckoEnter(m?m[1]:'')!=='go')
    document.getElementById('logErr').textContent='Переход в МЦКО сейчас недоступен.';
};

/* ═══════════════════ маршрутизация ═══════════════════ */
/* Имя спрашиваем только у гостя: у вошедшего оно берётся из профиля mcko-app,
   и придумывать себе второе имя на доске не нужно. */
/* Как войти на доску, которая пускает гостей.

   Раньше выбора не было вовсе: человека без учётной записи уводило на форму
   входа МЦКО, и всё заканчивалось там. Теперь спрашиваем прямо — у кого запись
   есть, войдёт под своей и останется собой; у кого нет, пройдёт по имени.

   Уровень доступа показываем честно: если владелец дал только смотреть, гость
   должен узнать об этом до входа, а не после первой попытки написать. */
addEventListener('popstate',route);
route();
}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  nav, showBoard,
};
