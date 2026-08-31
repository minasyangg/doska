/* история отмен */

import { byId, recordUndo, redoStack, undoStack } from './core.js';
import { bboxOf } from './geometry.js';
import { drawBoard, drawLive } from './render.js';
import { addItem, deflate, net, removeItem } from './net.js';
import { refreshSelBar, selectMany, selection } from './input.js';

/* ═══════════════════ отмена ═══════════════════ */
/* Одна операция человека = одна запись в истории, даже если она тронула
   несколько объектов: выделенную группу надо отменять целиком, а не по
   объекту за нажатие. */
function pushUndo(ops){
  recordUndo(ops.length===1?ops[0]:{type:'batch',ops});
  redoStack.length=0;
}
const dropFromSelection=id=>{if(selection.some(s=>s.id===id))selectMany(selection.filter(s=>s.id!==id));};
function undoOp(op){
  if(op.type==='batch'){for(let i=op.ops.length-1;i>=0;i--)undoOp(op.ops[i]);return;}
  if(op.type==='add'){dropFromSelection(op.item.id);
    removeItem(op.item.id);net.send({t:'erase',ids:[op.item.id]});}
  else if(op.type==='erase'){for(const it of op.items)addItem(it);
    net.send({t:'restore',items:op.items.map(deflate)});}
  else{const it=byId.get(op.id);if(it){Object.assign(it,op.before);it.bbox=bboxOf(it);
    net.send({t:'move',id:it.id,...wireGeom(op.before)});}}
}
function redoOp(op){
  if(op.type==='batch'){for(const o of op.ops)redoOp(o);return;}
  if(op.type==='add'){addItem(op.item);net.send({t:'add',item:deflate(op.item)});}
  else if(op.type==='erase'){const ids=op.items.map(i=>i.id);
    for(const id of ids){dropFromSelection(id);removeItem(id);}
    net.send({t:'erase',ids});}
  else{const it=byId.get(op.id);if(it){Object.assign(it,op.after);it.bbox=bboxOf(it);
    net.send({t:'move',id:it.id,...wireGeom(op.after)});}}
}
function undo(){
  const op=undoStack.pop();if(!op)return;
  undoOp(op);redoStack.push(op);drawBoard();refreshSelBar();drawLive();
}
function redo(){
  const op=redoStack.pop();if(!op)return;
  redoOp(op);recordUndo(op);drawBoard();refreshSelBar();drawLive();
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
}

export {
  dropFromSelection, pushUndo, redo, redoOp, undo, undoOp,
};
