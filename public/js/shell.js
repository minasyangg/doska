/* оболочка интерфейса: подсказки, статус связи, участники, роль */

import { S, api } from './core.js';
import { applyCursor, peers } from './render.js';
import { net } from './net.js';
import { closeAllPopovers, setTool } from './toolbar.js';
import { grid } from './boards.js';
import { showBoard } from './app.js';

const CAP_NAME={owner:'преподаватель',view:'только смотрит',edit:'рисует'};
function renderPeers(){
  // сам смотрящий уже лежит в peers — его кладут туда при init
  const cnt=document.getElementById('peersCount');
  if(cnt)cnt.textContent=String(peers.size);
  const pop=document.getElementById('peersPop');
  if(!pop||pop.classList.contains('hidden'))return;
  fillPeersPop();
}
/* Список участников. У владельца доски напротив каждого — выбор, рисует он
   или только смотрит. Напротив самого себя выбора нет: организатор не может
   запретить рисовать себе, это была бы ловушка без выхода.

   Раньше это жило одной кнопкой «запретить рисовать» на всех сразу. Кнопка
   грубая: чаще нужно унять одного, а не всю доску. Общий замок остался в окне
   доступа — он один умеет останавливать ещё и гостей по ссылке. */
async function fillPeersPop(){
  const pop=document.getElementById('peersPop');
  const rows=[...peers.values()];
  const owner=S.cap==='owner';
  pop.innerHTML='<div class="label" style="margin-bottom:2px">Участники · '+rows.length+'</div>';

  // кто есть кто по учётным записям знает только владелец — ему и спрашиваем
  let byName=new Map();
  if(owner&&S.boardId){
    try{
      const d=await api('/boards/'+S.boardId+'/participants');
      for(const p of d.participants||[])byName.set((p.name||'').trim(),p);
    }catch{ /* не вышло — покажем без выбора, список всё равно полезен */ }
  }

  for(const p of rows){
    const row=document.createElement('div');row.className='who';
    const av=document.createElement('div');av.className='av';
    av.style.background=p.color||'#7A7368';
    av.textContent=((p.name||'?').trim()[0]||'?').toUpperCase();
    const nm=document.createElement('span');
    nm.textContent=(p.name||'Гость');
    row.append(av,nm);

    const clean=(p.name||'').replace(/\s*\(вы\)$/,'').trim();
    const part=byName.get(clean);
    if(owner&&p.cap!=='owner'&&part){
      const sel=document.createElement('select');
      sel.className='role-pick';
      sel.innerHTML='<option value="edit">рисует</option><option value="view">смотрит</option>';
      sel.value=part.access||'edit';
      sel.title='Что можно этому участнику';
      sel.onchange=async()=>{
        const was=part.access;
        try{
          await api('/boards/'+S.boardId+'/participants/'+part.id,
                    {method:'PATCH',body:{access:sel.value}});
          part.access=sel.value;
          hint(nm.textContent+(sel.value==='view'?' теперь только смотрит':' снова рисует'));
        }catch(e){sel.value=was;hint('Не вышло: '+e.message);}
      };
      row.appendChild(sel);
    }else{
      const role=document.createElement('span');role.className='role';
      role.textContent=CAP_NAME[p.cap]||'';
      row.appendChild(role);
    }
    pop.appendChild(row);
  }
}
const escapeHtml=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function setTitle(t){
  const el=document.getElementById('title');
  el.textContent=t||'Без названия';
  const owner=S.cap==='owner';
  el.classList.toggle('editable',owner);
  el.title=owner?'Нажмите, чтобы переименовать':t;
}
function applyRole(){
  const owner=S.cap==='owner';
  document.getElementById('gear').hidden=!owner;
  document.getElementById('follow').hidden=owner;
  document.getElementById('callAll').hidden=!owner;
  document.getElementById('wipe').disabled=!owner;
  // наблюдателю инструменты правки ни к чему — пусть не выглядят рабочими
  const ro=S.cap==='view';
  document.getElementById('readonly').hidden=!ro;
  for(const b of document.querySelectorAll('.dock [data-tool]'))
    b.disabled=ro&&!['hand','select'].includes(b.dataset.tool);
  // карандаш, фигуры, линии и доп.инструменты живут под своими значками вне
  // общего [data-tool] — их надо гасить отдельно
  for(const b of document.querySelectorAll(
    '#penBtn,#penKindMenu .tool,#shapesBtn,#shapesMenu .tool,#pathBtn,#pathMenu .tool,#moreBtn,#moreMenu .tool,#pinnedTools .tool'
  ))b.disabled=ro;
  if(ro)closeAllPopovers();
  document.getElementById('undo').disabled=ro;
  document.getElementById('redo').disabled=ro;
  if(ro&&!['hand','select'].includes(S.tool))setTool('hand');
  setTitle(document.getElementById('title').textContent);
  applyCursor();
}
/* Доступ отозвали посреди работы — честно сказать и увести, а не оставлять
   человека рисовать в пустоту. */
function deniedScreen(){
  S.cap='none';S.boardId=null;net.close();
  showBoard(false);
  grid.innerHTML='<div class="empty">Доступ к этой доске закрыт её владельцем.</div>';
  window.history.replaceState(null,'','/');
}
function setConn(s,msg){
  const d=document.getElementById('conn');
  d.className='dot'+(s==='ok'?' ok':s==='off'?' off':'');
  d.title=msg;if(msg)hint(msg);
}
/* Строка снизу слева — не постоянная подсказка, а уведомление: показалась и
   через несколько секунд сама скрылась (для подсказки по умолчанию — через
   минуту, ей нужно время, чтобы её успели прочитать один раз при входе).
   Раньше текст просто откатывался на HINT_DEFAULT и та висела бесконечно —
   теперь строка исчезает совсем, а «потеряна связь»/«вошёл участник» и
   прочее идут тем же путём, просто с более коротким таймером. */
let hintTimer;const hintEl=document.getElementById('hint');
const HINT_DEFAULT='колесо — масштаб · пробел — панорама · правая кнопка на инструменте — его настройки';
function hint(t,ms){
  hintEl.classList.remove('hidden');
  hintEl.textContent=t;clearTimeout(hintTimer);
  hintTimer=setTimeout(()=>hintEl.classList.add('hidden'),ms||3800);
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
  HINT_DEFAULT, applyRole, deniedScreen, escapeHtml, fillPeersPop, hint, renderPeers, setConn,
  setTitle,
};
