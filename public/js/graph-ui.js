/* панель графика: формулы, точки, параметры */

import { S, stage } from './core.js';
import { GRAPH_COLORS, graphExprOk } from './graph.js';
import { hint } from './shell.js';
import { lastPt, localXY, newId, selected } from './selection.js';
import { drawBoard, hoverPt } from './render.js';
import { net } from './net.js';
import { placeImage } from './input.js';

/* ── график: список формул ─────────────────────────────────────
   Настраивать до постановки нечего — правим уже стоящий на доске объект,
   поэтому «черновик» здесь не S.physicsProps.graph (тот не используется
   вовсе), а props самого выделенного объекта. */
function activeGraphItem(){
  return (S.tool==='select'&&selected&&selected.type==='physics'&&selected.kind==='graph')?selected:null;
}
function graphChanged(it){
  it.bbox=null;
  net.send({t:'move',id:it.id,props:{...it.props}});
  drawBoard();
}
/* Три формы в одном текстовом поле (см. graphClassify) — подсказка в
   placeholder не разъясняет все три: она всего одна строка, а показывать
   их все за раз загромождало бы каждую строку списка. Кому нужно — тот
   узнал их из ответа на «что ещё добавить» и подсказки заранее для этого
   и просил именно так, «как в Desmos». */
function renderGraphExpressions(){
  const it=activeGraphItem();
  const box=document.getElementById('physicsExprList');
  box.innerHTML='';
  if(!it)return;
  (it.props.expressions||[]).forEach((ex,i)=>{
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:6px;margin-bottom:6px';
    const dot=document.createElement('span');
    dot.style.cssText='width:10px;height:10px;border-radius:50%;flex:none;background:'+(ex.color||'#2F6FE0');
    const input=document.createElement('input');
    input.type='text';input.value=ex.text||'';input.placeholder='sin(x)·2 · x²+y²=25 · (cos t,sin t)';
    input.style.cssText='flex:1;min-width:0;background:var(--panel-2);color:var(--text);'+
      'border:1px solid var(--edge);border-radius:6px;padding:5px 7px;font-size:12px;'+
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace';
    // рамка краснеет, если формулу не удалось разобрать или в ней осталось
    // неизвестное имя — не перестраиваем при этом сам список (потерялся бы
    // фокус и место курсора при наборе)
    const markValidity=()=>{
      const t=input.value.trim();
      input.style.borderColor=(t&&!graphExprOk(t,it))?'#E4796F':'var(--edge)';
    };
    markValidity();
    input.oninput=()=>{ex.text=input.value;markValidity();graphChanged(it);};
    // заливка есть смысл только у обычной функции (для неявных/параметрических
    // «под кривой» не определено однозначно) — кнопка просто ничего не
    // включает для них, а не прячется: человек и так поймёт по отсутствию эффекта
    const fill=document.createElement('button');
    fill.className='mini ic';fill.title='Заливка под кривой (до оси X)';
    fill.style.cssText='width:26px;height:26px;flex:none;color:'+(ex.fill?(ex.color||'#2F6FE0'):'var(--muted)');
    fill.innerHTML='<svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7"><path d="M4 18h16"/><path d="M4 18c3-9 6-11 8-11s3 5 8 5"/></svg>';
    fill.onclick=()=>{ex.fill=!ex.fill;fill.style.color=ex.fill?(ex.color||'#2F6FE0'):'var(--muted)';graphChanged(it);};
    const del=document.createElement('button');
    del.className='x';del.title='Убрать';del.textContent='×';
    del.onclick=()=>{
      it.props.expressions.splice(i,1);
      renderGraphExpressions();
      graphChanged(it);
    };
    row.append(dot,input,fill,del);
    box.appendChild(row);
  });
}
const GRAPH_PARAM_RE=/^[a-zа-яё]$/i;
function renderGraphParams(){
  const it=activeGraphItem();
  const box=document.getElementById('physicsParamList');
  box.innerHTML='';
  if(!it)return;
  (it.props.params||[]).forEach((pr,i)=>{
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:6px;margin-bottom:6px';
    const name=document.createElement('input');
    name.type='text';name.value=pr.name;name.maxLength=1;
    name.style.cssText='width:28px;flex:none;text-align:center;background:var(--panel-2);color:var(--text);'+
      'border:1px solid var(--edge);border-radius:6px;padding:5px 0;font-size:12.5px;'+
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace';
    name.onchange=()=>{
      const v=name.value.trim().toLowerCase();
      const taken=(it.props.params||[]).some((p,j)=>j!==i&&p.name===v);
      if(!GRAPH_PARAM_RE.test(v)||v==='x'||v==='y'||v==='t'||taken){
        hint('Имя параметра — одна буква, не x/y/t и не занято другим');
        name.value=pr.name;return;
      }
      pr.name=v;renderGraphExpressions();graphChanged(it);
    };
    const slider=document.createElement('input');
    slider.type='range';slider.min=-10;slider.max=10;slider.step=0.1;slider.value=pr.value;
    slider.style.flex='1';
    const val=document.createElement('span');
    val.style.cssText='width:38px;flex:none;text-align:right;font-size:12px;color:var(--text);'+
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace';
    val.textContent=(+pr.value).toFixed(1);
    slider.oninput=()=>{pr.value=+slider.value;val.textContent=pr.value.toFixed(1);graphChanged(it);};
    const del=document.createElement('button');
    del.className='x';del.title='Убрать параметр';del.textContent='×';
    del.onclick=()=>{it.props.params.splice(i,1);renderGraphParams();renderGraphExpressions();graphChanged(it);};
    row.append(name,slider,val,del);
    box.appendChild(row);
  });
}

/* Развешивание обработчиков и прочее, что делается при загрузке.

   Вынесено из тела модуля нарочно. Модули ссылаются друг на друга кольцами,
   а при кольцах порядок выполнения задаёт граф импортов, а не список в точке
   входа. Теперь эти строки зовёт main.js — в исходном порядке и уже после
   того, как все модули вычислены. */
export function __init() {
document.getElementById('physGraphAdd').onclick=()=>{
  const it=activeGraphItem();
  if(!it)return;
  if(it.props.expressions.length>=8)return hint('Не больше 8 функций на одном графике');
  const color=GRAPH_COLORS[it.props.expressions.length%GRAPH_COLORS.length];
  it.props.expressions.push({id:newId(),text:'',color,visible:true,fill:false});
  renderGraphExpressions();
  graphChanged(it);
};
/* Слайдеры-параметры — диапазон намеренно не настраивается (это резко
   упростило бы панель ценой одной степени свободы, которая на практике
   нужна редко: подобрать масштаб самим выражением — a*x — не сложнее). */
document.getElementById('physGraphAddParam').onclick=()=>{
  const it=activeGraphItem();
  if(!it)return;
  it.props.params=it.props.params||[];
  if(it.props.params.length>=6)return hint('Не больше 6 параметров на одном графике');
  const used=new Set(['x','y','t',...it.props.params.map(p=>p.name)]);
  const free=[...'abcdknmpqr'].find(c=>!used.has(c))||'k';
  it.props.params.push({id:newId(),name:free,value:1});
  renderGraphParams();
  graphChanged(it);
};
document.getElementById('physGraphReset').onclick=()=>{
  const it=activeGraphItem();
  if(!it)return;
  it.props.view={cx:0,cy:0,scale:40};
  it.bbox=null;
  graphChanged(it);
};
document.getElementById('physGraphDeg').onclick=e=>{
  const it=activeGraphItem();
  if(!it)return;
  it.props.angleMode=it.props.angleMode==='deg'?'rad':'deg';
  e.currentTarget.textContent=it.props.angleMode==='deg'?'град':'рад';
  graphChanged(it);
};
document.getElementById('physLabelSize').oninput=e=>{
  const it=activeGraphItem();
  if(!it)return;
  const v=+e.target.value;
  it.props.labelSize=v;
  document.getElementById('physLabelSizeVal').textContent=v;
  it.bbox=null;
  graphChanged(it);
};

addEventListener('paste',async e=>{
  if(!S.boardId)return;                       // состояние роутера, а не вид DOM
  if(e.target&&/INPUT|TEXTAREA/.test(e.target.tagName))return;
  const list=[...((e.clipboardData&&e.clipboardData.items)||[])];
  const img=list.find(i=>i.kind==='file'&&i.type.startsWith('image/'));
  if(!img)return;
  e.preventDefault();
  const blob=img.getAsFile();
  if(blob)placeImage(blob,hoverPt||lastPt);
});
stage.addEventListener('dragover',e=>{e.preventDefault();});
stage.addEventListener('drop',e=>{
  e.preventDefault();
  const f=[...(e.dataTransfer.files||[])].find(f=>f.type.startsWith('image/'));
  if(f)placeImage(f,localXY(e));
});

}

/* Наружу — только то, что нужно соседям; остальное остаётся своим. */
export {
  renderGraphExpressions, renderGraphParams,
};
