/* каталог фигур и их отрисовка */

import { paintStroke, trace } from './core.js';
import { paintArc, paintPhysics } from './graph.js';
import { getImg, paintText } from './text.js';

/* ═══════════════════ каталог фигур ═══════════════════
   Каждая фигура описана в единичном квадрате: 0 — левый верхний угол, 1 —
   правый нижний. Дальше её растягивают под рамку объекта. Так добавление
   новой фигуры — это строчка в таблице, а не правки в отрисовке, попадании
   курсора и проверке на сервере.

   out  — видимые контуры: массивы точек либо дуги
   hid  — рёбра, скрытые за телом: рисуются пунктиром у объёмных фигур
   fill — какой контур заливать (по умолчанию первый)

   Дуга: {arc:[cx,cy,rx,ry,a0,a1]} углы в оборотах (0..1), по часовой. */
const P=(...a)=>a;                                     // короче читается
const SHAPES={
  /* базовые многоугольники */
  rect:      {out:[[P(0,0),P(1,0),P(1,1),P(0,1)]],closed:true},
  triangle:  {out:[[P(.5,0),P(1,1),P(0,1)]],closed:true},
  rtriangle: {out:[[P(0,0),P(1,1),P(0,1)]],closed:true},
  trapezoid: {out:[[P(.25,0),P(.75,0),P(1,1),P(0,1)]],closed:true},
  trapezoid2:{out:[[P(0,0),P(1,0),P(.75,1),P(.25,1)]],closed:true},
  parallelogram:{out:[[P(.28,0),P(1,0),P(.72,1),P(0,1)]],closed:true},
  rhombus:   {out:[[P(.5,0),P(1,.5),P(.5,1),P(0,.5)]],closed:true},
  /* правильные многоугольники */
  pentagon:  {out:[reg(5)],closed:true},
  hexagon:   {out:[reg(6)],closed:true},
  octagon:   {out:[reg(8)],closed:true},
  star:      {out:[star5()],closed:true},
  /* скруглённые */
  ellipse:   {out:[{arc:[.5,.5,.5,.5,0,1]}],closed:true},
  roundrect: {out:[{round:.18}],closed:true},
  semicircle:{out:[[{arc:[.5,1,.5,1,.5,1]},P(0,1)]],closed:true},
  quarter:   {out:[[P(1,1),{arc:[1,1,1,1,.5,.75]},P(1,1)]],closed:true},
  /* Объёмные тела рисуются так, как их чертят от руки: видимые рёбра сплошные,
     уходящие за тело — пунктиром (hid). Пунктир и делает фигуру объёмной на
     глаз, без него получается плоская путаница линий. */
  cube:      {out:[[P(.04,.34),P(.66,.34),P(.66,.96),P(.04,.96)],
                   [P(.04,.34),P(.34,.04),P(.96,.04),P(.66,.34)],
                   [P(.66,.34),P(.96,.04),P(.96,.66),P(.66,.96)]],closed:false},
  cubeHidden:{out:[[P(.04,.34),P(.66,.34),P(.66,.96),P(.04,.96)],
                   [P(.04,.34),P(.34,.04),P(.96,.04),P(.66,.34)],
                   [P(.66,.34),P(.96,.04),P(.96,.66),P(.66,.96)]],
              hid:[[P(.34,.04),P(.34,.66)],[P(.34,.66),P(.04,.96)],
                   [P(.34,.66),P(.96,.66)]],closed:false},
  box:       {out:[[P(.04,.44),P(.74,.44),P(.74,.94),P(.04,.94)],
                   [P(.04,.44),P(.26,.16),P(.96,.16),P(.74,.44)],
                   [P(.74,.44),P(.96,.16),P(.96,.66),P(.74,.94)]],
              hid:[[P(.26,.16),P(.26,.66)],[P(.26,.66),P(.04,.94)],
                   [P(.26,.66),P(.96,.66)]],closed:false},
  cylinder:  {out:[[{arc:[.5,.17,.42,.12,0,1]}],
                   [P(.08,.17),P(.08,.83)],[P(.92,.17),P(.92,.83)],
                   [{arc:[.5,.83,.42,.12,0,.5]}]],
              hid:[[{arc:[.5,.83,.42,.12,.5,1]}]],closed:false},
  cone:      {out:[[P(.5,.05),P(.08,.82)],[P(.5,.05),P(.92,.82)],
                   [{arc:[.5,.82,.42,.13,0,.5]}]],
              hid:[[{arc:[.5,.82,.42,.13,.5,1]}]],closed:false},
  frustcone: {out:[[{arc:[.5,.2,.24,.08,0,1]}],
                   [P(.26,.2),P(.08,.82)],[P(.74,.2),P(.92,.82)],
                   [{arc:[.5,.82,.42,.12,0,.5]}]],
              hid:[[{arc:[.5,.82,.42,.12,.5,1]}]],closed:false},
  sphere:    {out:[[{arc:[.5,.5,.46,.46,0,1]}],
                   [{arc:[.5,.5,.46,.16,0,.5]}]],
              hid:[[{arc:[.5,.5,.46,.16,.5,1]}]],closed:false},
  pyramid:   {out:[[P(.5,.06),P(.1,.86),P(.6,.86),P(.5,.06)],
                   [P(.5,.06),P(.9,.66),P(.6,.86)],[P(.9,.66),P(.6,.86)]],
              hid:[[P(.4,.66),P(.1,.86)],[P(.4,.66),P(.9,.66)],[P(.4,.66),P(.5,.06)]],
              closed:false},
  frustum:   {out:[[P(.34,.16),P(.66,.16),P(.9,.86),P(.14,.86)],
                   [P(.34,.16),P(.46,.06),P(.78,.06),P(.66,.16)],
                   [P(.66,.16),P(.78,.06),P(.98,.7),P(.9,.86)]],
              hid:[[P(.46,.06),P(.46,.7)],[P(.46,.7),P(.14,.86)],[P(.46,.7),P(.98,.7)]],
              closed:false},
  tetra:     {out:[[P(.5,.05),P(.95,.9),P(.05,.9),P(.5,.05)]],
              hid:[[P(.5,.05),P(.45,.62)],[P(.45,.62),P(.05,.9)],[P(.45,.62),P(.95,.9)]],
              closed:false},
  prism:     {out:[[P(.28,.22),P(.6,.86),P(.02,.86),P(.28,.22)],
                   [P(.28,.22),P(.56,.1)],[P(.6,.86),P(.88,.74)],
                   [P(.56,.1),P(.88,.74)]],
              hid:[[P(.02,.86),P(.3,.74)],[P(.3,.74),P(.56,.1)],[P(.3,.74),P(.88,.74)]],
              closed:false},
  octahedron:{out:[[P(.5,.04),P(.96,.5),P(.5,.96),P(.04,.5),P(.5,.04)],
                   [P(.5,.04),P(.34,.62)],[P(.34,.62),P(.5,.96)],[P(.34,.62),P(.96,.5)]],
              hid:[[P(.34,.62),P(.04,.5)]],closed:false}
};

/* Разделы списка — в том же порядке, что и в привычных досках. Линии и кривые
   идут последними: они не фигуры, но живут под тем же значком. */
const SHAPE_GROUPS=[
  ['Базовые многоугольники',['rect','triangle','rtriangle','trapezoid',
                             'trapezoid2','parallelogram','rhombus']],
  ['Правильные многоугольники',['pentagon','hexagon','octagon','star']],
  ['Скруглённые фигуры',['ellipse','roundrect','semicircle','quarter']],
  ['Трёхмерные тела',['cube','cubeHidden','cylinder','box','pyramid','cone',
                      'sphere','tetra','prism','octahedron','frustum','frustcone']],
];
const SHAPE_NAMES={
  rect:'Прямоугольник',triangle:'Треугольник',rtriangle:'Прямоугольный треугольник',
  trapezoid:'Трапеция',trapezoid2:'Трапеция вниз',parallelogram:'Параллелограмм',
  rhombus:'Ромб',pentagon:'Пятиугольник',hexagon:'Шестиугольник',octagon:'Восьмиугольник',
  star:'Звезда',ellipse:'Эллипс',roundrect:'Скруглённый прямоугольник',
  semicircle:'Полукруг',quarter:'Четверть круга',cube:'Куб',cubeHidden:'Куб с рёбрами',
  cylinder:'Цилиндр',box:'Параллелепипед',pyramid:'Пирамида',cone:'Конус',
  sphere:'Сфера',tetra:'Тетраэдр',prism:'Призма',octahedron:'Октаэдр',
  frustum:'Усечённая пирамида',frustcone:'Усечённый конус'
};
/* Кривые и линии — не фигуры, но выбираются оттуда же. */
const PATH_KINDS=[['line','Линия'],['polyline','Ломаная'],
                  ['curve','Кривая'],['polygon','Многоугольник']];

/** Вершины правильного n-угольника, вписанного в единичный квадрат. */
function reg(n){
  const pts=[];
  for(let i=0;i<n;i++){
    const a=-Math.PI/2+i*2*Math.PI/n;
    pts.push([.5+Math.cos(a)*.5,.5+Math.sin(a)*.5]);
  }
  return pts;
}
/** Пятиконечная звезда: чередование внешнего и внутреннего радиусов. */
function star5(){
  const pts=[];
  for(let i=0;i<10;i++){
    const a=-Math.PI/2+i*Math.PI/5, r=(i%2?0.21:0.5);
    pts.push([.5+Math.cos(a)*r,.5+Math.sin(a)*r]);
  }
  return pts;
}

/** Один контур фигуры в путь холста, растянутый под рамку объекта. */
function shapeContour(ctx,part,x,y,w,h){
  ctx.beginPath();
  if(part.round!==undefined){
    const r=Math.min(w,h)*part.round;
    ctx.roundRect(x,y,w,h,r);
    return;
  }
  const list=Array.isArray(part)?part:[part];
  let started=false;
  for(const seg of list){
    if(seg.arc){
      const [cx,cy,rx,ry,a0,a1]=seg.arc;
      ctx.ellipse(x+cx*w,y+cy*h,Math.max(.01,rx*w),Math.max(.01,ry*h),0,
                  a0*6.2832,a1*6.2832);
      started=true;
    }else{
      const px=x+seg[0]*w, py=y+seg[1]*h;
      if(started)ctx.lineTo(px,py); else {ctx.moveTo(px,py);started=true;}
    }
  }
}

function paintShape(ctx,it){
  const rot=it.rot||0;
  const spec=SHAPES[it.kind]||SHAPES.rect;
  ctx.save();
  if(rot){const cx=it.x+it.w/2,cy=it.y+it.h/2;ctx.translate(cx,cy);ctx.rotate(rot);ctx.translate(-cx,-cy);}

  // заливка — только по первому контуру: он и есть силуэт фигуры
  if(it.fill){
    shapeContour(ctx,spec.out[0],it.x,it.y,it.w,it.h);
    if(spec.closed!==false)ctx.closePath();
    ctx.fillStyle=it.fill;ctx.fill();
  }
  if(it.size>0){
    ctx.lineWidth=it.size;ctx.strokeStyle=it.color;
    const dashOn=()=>{
      if(it.dash===1)ctx.setLineDash([it.size*3,it.size*2]);
      else if(it.dash===2){ctx.setLineDash([it.size*0.1,it.size*2]);ctx.lineCap='round';}
      else ctx.setLineDash([]);
    };
    dashOn();
    for(const part of spec.out){
      shapeContour(ctx,part,it.x,it.y,it.w,it.h);
      if(spec.closed!==false&&!part.round)ctx.closePath();
      ctx.stroke();
    }
    // рёбра за телом — всегда пунктиром, независимо от стиля линии
    if(spec.hid){
      ctx.setLineDash([it.size*2,it.size*2]);
      ctx.globalAlpha=0.75;
      for(const part of spec.hid){
        shapeContour(ctx,part,it.x,it.y,it.w,it.h);
        ctx.stroke();
      }
      ctx.globalAlpha=1;
    }
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/* стрелка на конце линии — style: 0 нет|1 уголок|2 треугольник|3 точка|
   4 остриё вектора (уже, длиннее — аккуратный кончик для инструмента «Вектор»
   в физике, руками из общего списка стрелок не выбирается).
   from/tip — соседняя и концевая точки сегмента, задают направление. */
function drawArrowhead(ctx,from,tip,style,size,color){
  if(!style)return;
  const ang=Math.atan2(tip.y-from.y,tip.x-from.x);
  const len=style===4?Math.max(9,size*4.2):Math.max(6,size*3);
  const wid=style===4?Math.max(3,size*1.15):Math.max(4,size*2);
  ctx.save();ctx.translate(tip.x,tip.y);ctx.rotate(ang);
  ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineWidth=Math.max(1,size*0.5);
  if(style===1){ctx.beginPath();ctx.moveTo(-len,-wid/2);ctx.lineTo(0,0);ctx.lineTo(-len,wid/2);ctx.stroke();}
  else if(style===2||style===4){ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(-len,-wid/2);ctx.lineTo(-len,wid/2);ctx.closePath();ctx.fill();}
  else if(style===3){ctx.beginPath();ctx.arc(-wid/2,0,wid/2,0,6.2832);ctx.fill();}
  ctx.restore();
}
// Компактная стрелка для осей графика — drawArrowhead тут не годится:
// у него нижний порог размера (не меньше 6 условных единиц), рассчитанный
// на векторы/линии самой доски, для тонких служебных осей это слишком
// грубо. Размер — ровно size без пола, вершина строго в (tipX,tipY),
// т.е. на самом краю рамки графика, без зазора.
function drawAxisArrow(ctx,tipX,tipY,dirX,dirY,size,color){
  const len=size*2.1, wid=size*1.3;
  ctx.save();ctx.translate(tipX,tipY);ctx.rotate(Math.atan2(dirY,dirX));
  ctx.beginPath();ctx.moveTo(-len,-wid/2);ctx.lineTo(0,0);ctx.lineTo(-len,wid/2);
  ctx.strokeStyle=color;ctx.lineWidth=Math.max(1,size*0.55);ctx.lineCap='round';ctx.lineJoin='round';
  ctx.stroke();
  ctx.restore();
}
/* линия/полилиния/кривая/полигон. closed — только у полигона (заливка
   только для него). Кривая переиспользует trace() — тот же сглаживающий
   алгоритм, что рисует штрихи пера, без отдельной сплайн-математики. */
function paintPath(ctx,it){
  const pts=it.pts;
  if(pts.length<2)return;
  ctx.beginPath();
  if(it.kind==='curve')trace(ctx,pts,true);
  else{ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);}
  if(it.closed)ctx.closePath();
  if(it.fill&&it.closed){ctx.fillStyle=it.fill;ctx.fill();}
  if(it.size>0){
    ctx.lineWidth=it.size;ctx.strokeStyle=it.color;
    if(it.dash===1)ctx.setLineDash([it.size*3,it.size*2]);
    else if(it.dash===2){ctx.setLineDash([it.size*0.1,it.size*2]);ctx.lineCap='round';}
    ctx.stroke();ctx.setLineDash([]);ctx.lineCap='butt';
  }
  if(!it.closed){
    if(it.a1)drawArrowhead(ctx,pts[1],pts[0],it.a1,it.size,it.color);
    if(it.a2)drawArrowhead(ctx,pts[pts.length-2],pts[pts.length-1],it.a2,it.size,it.color);
  }
}

/* рисует один объект в переданный контекст — используется и доской, и экспортом */
function paintItem(ctx,it){
  if(it.type==='image'){
    const e=getImg(it.url),rot=it.rot||0;
    if(rot){const cx=it.x+it.w/2,cy=it.y+it.h/2;ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);ctx.translate(-cx,-cy);}
    if(e.ready)ctx.drawImage(e.img,it.x,it.y,it.w,it.h);
    else{ctx.fillStyle='rgba(0,0,0,.05)';ctx.fillRect(it.x,it.y,it.w,it.h);}
    if(rot)ctx.restore();
    return;
  }
  if(it.type==='shape'){paintShape(ctx,it);return;}
  if(it.type==='path'){paintPath(ctx,it);return;}
  if(it.type==='text'){paintText(ctx,it);return;}
  if(it.type==='arc'){paintArc(ctx,it);return;}
  if(it.type==='pen'||it.type==='marker'){paintStroke(ctx,it);return;}
  if(it.type==='physics'){paintPhysics(ctx,it);return;}
  // неизвестные/будущие типы (conn/embed) — молча пропускаем, не роняем рендер
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
  P, PATH_KINDS, SHAPES, SHAPE_GROUPS, SHAPE_NAMES, drawArrowhead, drawAxisArrow, paintItem, paintPath, paintShape, reg, shapeContour, star5,
};
