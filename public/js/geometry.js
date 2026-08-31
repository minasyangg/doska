/* реестры типов объектов и геометрия */

import { bctx } from './core.js';
import { textHeight } from './text.js';

/* ═══ типовые реестры: новый тип объекта подключается сюда, не хирургией по всему файлу ═══ */
// box-семейство — геометрия x,y,w,h(+rot); embed зарезервирован под будущий график (не реализован)
// physics — объекты-симуляции (магнит/компас и т.п.): та же прямоугольная
// геометрия, что у картинки, поэтому ручки ресайза/поворота уже работают
const BOX_TYPES=new Set(['image','shape','embed','text','physics']);
// back-слой — всегда рисуется под рукописным текстом, независимо от порядка добавления
// (фигуры сюда не входят — они в общем z-порядке наравне со штрихами)
const BACK_TYPES=new Set(['image','embed']);
// кто сейчас реально выделяем инструментом "выделить"
const SELECTABLE=new Set(['image','pen','marker','shape','path','text','arc','physics']);
/* Дуга циркуля живёт особняком: у неё нет ширины и высоты, только центр,
   радиус и два угла. Растянуть её нельзя — растянутая дуга перестаёт быть
   дугой окружности, — поэтому ручек размера у неё не будет, а будут ручки
   углов. */
const ARC_TYPES=new Set(['arc']);

/* поворот вокруг локального центра (cx,cy) на угол a — общая мини-утилита */
/** Угол в диапазон (−180°, 180°]: 350° читается как −10°, так понятнее. */
function normAngle(a){
  let d=a*180/Math.PI;
  d=((d+180)%360+360)%360-180;
  return d;
}

function rotAround(px,py,cx,cy,a){
  const cos=Math.cos(a),sin=Math.sin(a),dx=px-cx,dy=py-cy;
  return {x:cx+dx*cos-dy*sin, y:cy+dx*sin+dy*cos};
}

/** Точка на дуге по углу. */
const arcPt=(it,a)=>({x:it.cx+Math.cos(a)*it.r, y:it.cy+Math.sin(a)*it.r});
/** Нормализованный размах дуги: всегда вперёд по часовой, 0…2π. */
const arcSweep=it=>{
  let d=it.a1-it.a0;
  while(d<0)d+=Math.PI*2;
  while(d>Math.PI*2)d-=Math.PI*2;
  return d;
};

function bboxOf(it){
  // у надписи своя высота не хранится — считаем по числу строк
  if(it.type==='text')it.h=textHeight(bctx,it);
  if(ARC_TYPES.has(it.type)){
    // Рамка по самой дуге, а не по всей окружности: иначе у четвертинки она
    // была бы вчетверо больше нарисованного и выделение выглядело бы враньём.
    const sw=arcSweep(it);
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    const add=p=>{if(p.x<x0)x0=p.x;if(p.y<y0)y0=p.y;if(p.x>x1)x1=p.x;if(p.y>y1)y1=p.y;};
    add(arcPt(it,it.a0));add(arcPt(it,it.a0+sw));
    // крайние точки окружности учитываем, только если дуга через них проходит
    for(let k=0;k<4;k++){
      const a=k*Math.PI/2;
      let d=a-it.a0;while(d<0)d+=Math.PI*2;
      if(d<=sw)add(arcPt(it,a));
    }
    const pad=(it.size||1)/2;
    return {x0:x0-pad,y0:y0-pad,x1:x1+pad,y1:y1+pad};
  }
  if(BOX_TYPES.has(it.type)){
    const rot=it.rot||0;
    if(!rot)return{x0:it.x,y0:it.y,x1:it.x+it.w,y1:it.y+it.h};
    // повёрнутый прямоугольник — берём AABB его 4 углов (шире исходного)
    const cx=it.x+it.w/2, cy=it.y+it.h/2;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const [px,py] of [[it.x,it.y],[it.x+it.w,it.y],[it.x,it.y+it.h],[it.x+it.w,it.y+it.h]]){
      const p=rotAround(px,py,cx,cy,rot);
      if(p.x<x0)x0=p.x;if(p.y<y0)y0=p.y;if(p.x>x1)x1=p.x;if(p.y>y1)y1=p.y;
    }
    return{x0,y0,x1,y1};
  }
  if(!Array.isArray(it.pts)||!it.pts.length)return{x0:0,y0:0,x1:0,y1:0};
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const p of it.pts){if(p.x<x0)x0=p.x;if(p.y<y0)y0=p.y;if(p.x>x1)x1=p.x;if(p.y>y1)y1=p.y;}
  // у линии с наконечником запас должен покрывать стрелку (см. drawArrowhead),
  // иначе кончик стрелки обрежется при culling/экспорте по краю видимой области
  const arrow=(it.type==='path'&&(it.a1||it.a2))?Math.max(6,(it.size||0)*3):0;
  const m=(it.size||0)+arrow;
  return{x0:x0-m,y0:y0-m,x1:x1+m,y1:y1+m};
}

/* прямоугольник/эллипс — заливка, затем обводка; дэш в мировых единицах,
   чтобы паттерн масштабировался вместе с толщиной линии при зуме */

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
  ARC_TYPES, BACK_TYPES, BOX_TYPES, SELECTABLE, arcPt, arcSweep, bboxOf, normAngle, rotAround,
};
