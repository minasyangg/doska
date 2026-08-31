/* WebSocket и (де)сериализация объектов */

import { S, board, byId, items, mkStroke, redoStack, undoStack } from './core.js';
import { bboxOf } from './geometry.js';
import { cursors, drawBoard, drawLive, peerViews, peers, remoteLive } from './render.js';
import { inSelection, refreshSelBar, select, selected, updateSelBar } from './input.js';
import { dropFromSelection } from './undo.js';
import { applyRole, deniedScreen, hint, renderPeers, setConn, setTitle } from './toolbar.js';
import { applyZ } from './menu.js';
import { nav } from './app.js';

/* ═══════════════════ сеть ═══════════════════ */
/* Прелоадер доски. При входе держим его, пока не придут все объекты (событие
   'init') — до этого доска на экране пустая, и показывать её как «готовую»
   было бы враньём. При обрыве связи посреди занятия — то, что уже нарисовано,
   никуда не делось, дожидаться нового 'init' незачем: снимаем прелоадер сразу,
   как только сокет снова открылся. Различает эти два случая один флаг:
   boardLoaded ещё не true — значит это первый вход, а не переподключение. */
let boardLoaded=false;
let boardLoaderTimer=null;
const boardLoaderEl=document.getElementById('boardLoader');
const boardLoaderText=document.getElementById('boardLoaderText');
function showBoardLoader(text){
  boardLoaderText.textContent=text;
  boardLoaderEl.classList.remove('hidden');
  // Не держать человека в подвешенном состоянии вечно, если 'init' почему-то
  // не пришёл: через 20с подсказываем перезагрузить, а не молчим дальше.
  clearTimeout(boardLoaderTimer);
  boardLoaderTimer=setTimeout(()=>{
    boardLoaderText.textContent='Долго не отвечает. Проверьте связь или обновите страницу.';
  },20000);
}
function hideBoardLoader(){boardLoaderEl.classList.add('hidden');clearTimeout(boardLoaderTimer);}

const net={
  ws:null,tries:0,sent:0,sid:null,tCur:0,tView:0,tPresence:0,
  // Сокет ходит строго на свой origin: рукопожатие аутентифицируется кукой,
  // а её на чужой хост браузер не отдаст. Прежняя лазейка ?server= вместе с
  // этим и потеряла смысл.
  wsUrl(){
    if(location.protocol==='file:')return null;
    return (location.protocol==='https:'?'wss://':'ws://')+location.host;
  },
  connect(){
    const u=this.wsUrl();
    if(!u){setConn('off','Файл открыт локально — синхронизации нет');return;}
    setConn('wait','Подключаюсь…');
    const ws=new WebSocket(u); this.ws=ws;
    ws.onopen=()=>{this.tries=0;setConn('ok','На связи');
      // Переподключение: то, что уже нарисовано, на экране осталось — не
      // держим прелоадер до нового 'init', снимаем сразу по факту связи.
      if(boardLoaded)hideBoardLoader();
      ws.send(JSON.stringify({t:'join',room:S.boardId,name:S.name}));};
    ws.onmessage=e=>{try{this.on(JSON.parse(e.data));}catch{}};
    ws.onclose=ev=>{
      if(ev.code===4004){hideBoardLoader();setConn('off','Доска удалена');return;}
      if(ev.code===4003){hideBoardLoader();setConn('off','Доступ к доске закрыт');deniedScreen();return;}
      // 401 на рукопожатии приходит как обычное закрытие: сессии нет — на вход
      if(ev.code===1006&&!S.you){hideBoardLoader();nav('/login?next='+encodeURIComponent(location.pathname));return;}
      setConn('off','Связь потеряна, переподключаюсь…');
      // Обрыв посреди уже загруженного занятия — накрываем прелоадером снова,
      // пока идёт первый вход, он и так на экране с самого openBoard().
      if(boardLoaded)showBoardLoader('Связь потеряна, переподключаюсь…');
      this.tries++; setTimeout(()=>{if(S.boardId)this.connect();},Math.min(8000,600*this.tries));
    };
    ws.onerror=()=>{};
  },
  close(){if(this.ws){this.ws.onclose=null;this.ws.close();this.ws=null;}hideBoardLoader();},
  send(o){if(this.ws&&this.ws.readyState===1)this.ws.send(JSON.stringify(o));},

  on(m){
    switch(m.t){
      case 'init':{
        S.me=m.you;S.cap=m.you.cap;S.locked=m.locked;S.anyEdit=!!m.anyEdit;
        peers.clear();peerViews.clear();
        peers.set(m.you.id,{name:m.you.name+' (вы)',color:m.you.color,cap:m.you.cap});
        for(const p of m.peers)peers.set(p.id,{name:p.name,color:p.color,cap:p.cap});
        items=[];byId.clear();undoStack=[];redoStack=[];selected=null;
        for(const it of m.items)addItem(inflate(it),true);
        setTitle(m.title);
        applyRole();renderPeers();drawBoard();
        hint(m.items.length?('Доска загружена: '+m.items.length+' объектов'):'Доска пустая — можно начинать');
        // Все объекты пришли и отрисованы — прелоадер входа снят. Дальше
        // 'init' будет приходить и при переподключении, но тогда его уже
        // снял ws.onopen, и boardLoaded=true защищает от повторной работы.
        if(!boardLoaded){boardLoaded=true;hideBoardLoader();}
        net.sendPresence();       // сразу объявляем свою область — не ждём первого движения камеры
        break;
      }
      case 'peer':{
        const was=peers.get(m.peer.id);
        peers.set(m.peer.id,{name:m.peer.name,color:m.peer.color,cap:m.peer.cap});
        renderPeers();if(!was)hint(m.peer.name+' вошёл');break;
      }
      case 'left':{const p=peers.get(m.id);peers.delete(m.id);cursors.delete(m.id);peerViews.delete(m.id);
        renderPeers();if(p)hint(p.name+' вышел');break;}
      // Курсоры и области приходят пачкой на всю комнату, а не по сообщению
      // на человека: так их в сто раз меньше по числу кадров (см. замер в
      // scripts/load-test.js — именно на них доска и упиралась). Пачка идёт
      // всем, включая нас самих, поэтому свой курсор пропускаем — рисовать
      // собственный незачем, он и так под рукой.
      case 'cursors':{
        const me=S.me&&S.me.id, t=performance.now();
        for(const c of m.list||[]){ if(c[0]===me)continue; cursors.set(c[0],{x:c[1],y:c[2],t}); }
        drawLive();break;
      }
      case 'presences':{
        const me=S.me&&S.me.id, t=performance.now();
        for(const p of m.list||[]){ if(p[0]===me)continue;
          peerViews.set(p[0],{cam:p[1],w:p[2],h:p[3],seen:t}); }
        drawLive();break;
      }
      // одиночные — от сервера прежней версии: во время выкладки уже открытые
      // вкладки продолжают работать, пока их не перезагрузят
      case 'presence':peerViews.set(m.id,{cam:m.cam,w:m.w,h:m.h,seen:performance.now()});drawLive();break;
      case 'title':setTitle(m.title);break;
      // Живые штрихи — тоже пачкой на комнату (см. 'cursors' выше). Пачка
      // приходит и нам самим: свой штрих уже нарисован как current, второй раз
      // поверх него не нужен, поэтому по by отсеиваем себя.
      case 'lives':{
        const me=S.me&&S.me.id;
        for(const e of m.list||[]){ if(e.by===me)continue; applyLive(e); }
        drawLive();break;
      }
      // одиночный — от сервера прежней версии, пока вкладку не перезагрузили
      case 'live':applyLive(m);drawLive();break;
      case 'add':remoteLive.delete(m.item.id);addItem(inflate(m.item));break;
      case 'bulk':for(const it of m.items)addItem(inflate(it));break;
      case 'erase':for(const id of m.ids){dropFromSelection(id);removeItem(id);}drawBoard();break;
      case 'move':{
        const it=byId.get(m.id);
        if(it){
          for(const k of (PATCHABLE[it.type]||[])){
            if(!(k in m))continue;
            it[k]=(k==='pts')?m.pts.map(a=>a.length>2?{x:a[0],y:a[1],p:a[2]}:{x:a[0],y:a[1]}):m[k];
          }
          it.bbox=bboxOf(it);
          if(inSelection(it))updateSelBar();
          drawBoard();drawLive();
        }
        break;
      }
      case 'cleared':items=[];byId.clear();undoStack=[];redoStack=[];select(null);drawBoard();hint('Доска очищена');break;
      case 'lock':S.locked=m.on;applyRole();
        hint(m.on?'Преподаватель закрыл доску для рисования':'Рисование снова доступно');break;
      // права могли измениться посреди урока: владелец убрал участника или
      // понизил его до просмотра — сервер сообщает, не разрывая соединение
      case 'cap':S.cap=m.cap;applyRole();select(null);
        hint(m.cap==='view'?'Теперь вы только смотрите':'Права на доске изменились');break;
      case 'policy':S.anyEdit=!!m.anyEdit;break;
      // порядок слоёв поменял кто-то другой: переставляем у себя так же
      case 'z':applyZ(m.ids||[],m.to);drawBoard();break;
      // доска упёрлась в потолок объектов. Раньше сервер молча выбрасывал
      // самое старое, и начало занятия исчезало незаметно
      case 'full':hint('Доска заполнена: '+(m.max||0).toLocaleString('ru')+
        ' объектов. Заведите новую или сотрите лишнее');break;
      case 'denied':deniedScreen();break;
      case 'cursor':cursors.set(m.id,{x:m.x,y:m.y,t:performance.now()});drawLive();break;
      case 'view':{
        if(!S.following)break;
        const k=board.clientWidth/(m.w||board.clientWidth);
        S.cam.z=m.cam.z*k;S.cam.x=m.cam.x*k;S.cam.y=m.cam.y*k;
        document.getElementById('zoom').textContent=Math.round(S.cam.z*100)+'%';
        drawBoard();drawLive();break;
      }
      // Преподаватель зовёт к себе — переносим, не спрашивая режим слежения:
      // это разовое действие, а не подписка.
      case 'goto':{
        const k=board.clientWidth/(m.w||board.clientWidth);
        S.cam.z=m.cam.z*k;S.cam.x=m.cam.x*k;S.cam.y=m.cam.y*k;
        document.getElementById('zoom').textContent=Math.round(S.cam.z*100)+'%';
        drawBoard();drawLive();refreshSelBar();
        hint('Преподаватель показывает это место');
        break;
      }
    }
  },
  startStroke(s){this.sid=s.id;this.sent=0;},
  stream(s){
    if(this.sid!==s.id||s.pts.length<=this.sent)return;
    const pts=s.pts.slice(this.sent).map(p=>[+p.x.toFixed(2),+p.y.toFixed(2),+p.p.toFixed(3)]);
    this.send({t:'live',sid:s.id,from:this.sent,pts,kind:s.type,color:s.color,size:+s.size.toFixed(3)});
    this.sent=s.pts.length;
  },
  cursor(w){const n=performance.now();if(n-this.tCur<55)return;this.tCur=n;
    this.send({t:'cursor',x:+w.x.toFixed(1),y:+w.y.toFixed(1)});},
  sendView(){
    if(S.cap!=='owner')return;
    const n=performance.now();if(n-this.tView<120)return;this.tView=n;
    this.send({t:'view',cam:{x:S.cam.x,y:S.cam.y,z:S.cam.z},w:board.clientWidth});
  },
  // Своя видимая область — всем, не только владельцу (в отличие от 'view'):
  // это не управление чужой камерой, а просто «вот где я сейчас смотрю»,
  // нужно и учителю видеть учеников, и ученику — учителя.
  sendPresence(){
    const n=performance.now();if(n-this.tPresence<250)return;this.tPresence=n;
    this.send({t:'presence',cam:{x:S.cam.x,y:S.cam.y,z:S.cam.z},
               w:board.clientWidth,h:board.clientHeight});
  }
};

/* какие поля 'move' разрешено применять к какому типу — зеркало server.js PATCHABLE */
const PATCHABLE={
  image:['x','y','w','h','rot','locked'],
  shape:['x','y','w','h','rot','color','size','dash','fill','locked'],
  path:['pts','color','size','dash','fill','a1','a2','locked'],
  pen:['pts','color','size','locked'],
  marker:['pts','color','size','locked'],
  // physics (магнит/компас/оптика/тепловые) — не было записи вовсе, поэтому
  // никто, кроме самого автора правки, не видел чужой драг/поворот/ресайз
  // такого объекта: этот же case 'move' применяет входящие патчи и у
  // остальных участников, а без своей записи в PATCHABLE цикл ниже просто
  // не находил, какие поля вообще разрешено скопировать. props — здесь же:
  // без него другие участники не видели бы, как греется чужое тело
  physics:['x','y','w','h','rot','props','locked']
};

/* реестры сериализации по типу — новый тип добавляет свою пару функций сюда.
   g — группа, в которой состоит объект; у картинки ещё front: поднята ли она
   поверх записей. Оба поля общие и едут вместе со всем остальным. */
const DEFLATE={
  image:it=>({id:it.id,type:'image',url:it.url,x:+it.x.toFixed(1),y:+it.y.toFixed(1),w:+it.w.toFixed(1),h:+it.h.toFixed(1),
              rot:+((it.rot||0).toFixed(4)),front:!!it.front,g:it.g||null,locked:!!it.locked}),
  shape:it=>({id:it.id,type:'shape',kind:it.kind,x:+it.x.toFixed(1),y:+it.y.toFixed(1),w:+it.w.toFixed(1),h:+it.h.toFixed(1),
              rot:+((it.rot||0).toFixed(4)),color:it.color,size:+it.size.toFixed(3),dash:it.dash||0,
              fill:it.fill||null,g:it.g||null,locked:!!it.locked}),
  arc:it=>({id:it.id,type:'arc',cx:+it.cx.toFixed(1),cy:+it.cy.toFixed(1),r:+it.r.toFixed(1),
            a0:+it.a0.toFixed(4),a1:+it.a1.toFixed(4),color:it.color,
            size:+it.size.toFixed(3),dash:it.dash||0,g:it.g||null,locked:!!it.locked}),
  physics:it=>({id:it.id,type:'physics',kind:it.kind,x:+it.x.toFixed(1),y:+it.y.toFixed(1),
                w:+it.w.toFixed(1),h:+it.h.toFixed(1),rot:+((it.rot||0).toFixed(4)),
                props:it.props||{},g:it.g||null,locked:!!it.locked}),
  text:it=>({id:it.id,type:'text',text:it.text,x:+it.x.toFixed(1),y:+it.y.toFixed(1),
             w:+it.w.toFixed(1),rot:+((it.rot||0).toFixed(4)),color:it.color,
             size:+(+it.size).toFixed(2),bold:!!it.bold,italic:!!it.italic,
             g:it.g||null,locked:!!it.locked}),
  path:it=>({id:it.id,type:'path',kind:it.kind,closed:!!it.closed,
             pts:it.pts.map(p=>[+p.x.toFixed(2),+p.y.toFixed(2)]),
             color:it.color,size:+it.size.toFixed(3),dash:it.dash||0,fill:it.fill||null,
             a1:it.a1||0,a2:it.a2||0,g:it.g||null,locked:!!it.locked})
};
const deflateStroke=it=>({id:it.id,type:it.type,color:it.color,size:+it.size.toFixed(3),
  pts:it.pts.map(p=>[+p.x.toFixed(2),+p.y.toFixed(2),+p.p.toFixed(3)]),
  g:it.g||null,locked:!!it.locked});
const deflate=it=>(DEFLATE[it.type]||deflateStroke)(it);

const INFLATE={
  image:raw=>({...raw,rot:raw.rot||0,front:!!raw.front,g:raw.g||null,locked:!!raw.locked,bbox:null}),
  shape:raw=>({...raw,rot:raw.rot||0,dash:raw.dash||0,fill:raw.fill||null,g:raw.g||null,locked:!!raw.locked,bbox:null}),
  arc:raw=>({...raw,r:raw.r||1,a0:raw.a0||0,a1:raw.a1||0,dash:raw.dash||0,
             g:raw.g||null,locked:!!raw.locked,bbox:null}),
  physics:raw=>({...raw,rot:raw.rot||0,props:raw.props||{},g:raw.g||null,locked:!!raw.locked,bbox:null}),
  text:raw=>({...raw,rot:raw.rot||0,w:raw.w||240,size:raw.size||24,
              bold:!!raw.bold,italic:!!raw.italic,g:raw.g||null,locked:!!raw.locked,bbox:null}),
  path:raw=>({...raw,pts:raw.pts.map(a=>({x:a[0],y:a[1]})),closed:!!raw.closed,
              dash:raw.dash||0,fill:raw.fill||null,a1:raw.a1||0,a2:raw.a2||0,
              g:raw.g||null,locked:!!raw.locked,bbox:null})
};
function inflateStroke(raw){
  const s=mkStroke(raw.type,raw.color,raw.size,raw.id,raw.by);
  s.pts=raw.pts.map(a=>({x:a[0],y:a[1],p:a[2]}));
  s.g=raw.g||null;
  s.locked=!!raw.locked;
  return s;
}
function inflate(raw){return (INFLATE[raw.type]||inflateStroke)(raw);}
/* Кадр живого штриха соседа. from — сколько точек у него уже было: если не
   сошлось, кадры разъехались, и дописывать нельзя — иначе линия склеится из
   кусков в неверном порядке. Тогда просто ждём следующего штриха; готовый
   объект всё равно приедет отдельным 'add'. */
function applyLive(m){
  let s=remoteLive.get(m.sid);
  if(!s){s=mkStroke(m.kind,m.color,m.size,m.sid,m.by);remoteLive.set(m.sid,s);}
  s.type=m.kind;s.color=m.color;s.size=m.size;s.seen=performance.now();
  if((m.from|0)===s.pts.length)for(const a of m.pts)s.pts.push({x:a[0],y:a[1],p:a[2]});
}
function addItem(it,quiet){
  if(byId.has(it.id))return;
  it.bbox=bboxOf(it);items.push(it);byId.set(it.id,it);
  if(!quiet)drawBoard();
}
function removeItem(id){
  const it=byId.get(id);if(!it)return null;
  const i=items.indexOf(it);if(i>=0)items.splice(i,1);
  byId.delete(id);return it;
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
setInterval(()=>{
  const n=performance.now();let ch=false;
  for(const [k,s] of remoteLive)if(n-(s.seen||0)>6000){remoteLive.delete(k);ch=true;}
  if(ch)drawLive();
},6000);

}

export {
  DEFLATE, INFLATE, PATCHABLE, addItem, applyLive, boardLoaded, boardLoaderEl, boardLoaderText, boardLoaderTimer, deflate, deflateStroke, hideBoardLoader, inflate, inflateStroke, net, removeItem, showBoardLoader,
};
