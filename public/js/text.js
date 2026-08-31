/* надписи, попадание по объекту, кэш картинок */

import { ARC_TYPES, BOX_TYPES, arcSweep, bboxOf, rotAround } from './geometry.js';
import { SHAPES } from './shapes.js';
import { drawBoard } from './render.js';

/* ═══════════════════ надписи ═══════════════════
   Ширина задаётся объектом, высота считается из числа строк: хранить её
   отдельно значило бы держать два источника правды и ловить их расхождение
   при смене кегля. */
const TEXT_LH=1.28;                                   // межстрочный, доля кегля
const textFont=it=>(it.italic?'italic ':'')+(it.bold?'600 ':'')+
  it.size+'px ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif';

/** Разбивка на строки по ширине объекта. Переносим по словам, а слово длиннее
    строки рвём — иначе оно уехало бы за край. */
function textLines(ctx,it){
  ctx.font=textFont(it);
  const out=[];
  for(const para of String(it.text||'').split('\n')){
    if(!para){out.push('');continue;}
    let line='';
    for(const word of para.split(/(\s+)/)){
      if(!word)continue;
      const probe=line+word;
      if(line&&ctx.measureText(probe).width>it.w){
        out.push(line.replace(/\s+$/,''));line=word.replace(/^\s+/,'');
      }else line=probe;
      while(ctx.measureText(line).width>it.w&&line.length>1){
        let cut=line.length-1;
        while(cut>1&&ctx.measureText(line.slice(0,cut)).width>it.w)cut--;
        out.push(line.slice(0,cut));line=line.slice(cut);
      }
    }
    out.push(line.replace(/\s+$/,''));
  }
  return out;
}
const textHeight=(ctx,it)=>Math.max(it.size*TEXT_LH,textLines(ctx,it).length*it.size*TEXT_LH);

function paintText(ctx,it){
  const rot=it.rot||0;
  const lines=textLines(ctx,it);
  const h=lines.length*it.size*TEXT_LH;
  ctx.save();
  if(rot){const cx=it.x+it.w/2,cy=it.y+h/2;ctx.translate(cx,cy);ctx.rotate(rot);ctx.translate(-cx,-cy);}
  ctx.font=textFont(it);
  ctx.fillStyle=it.color||'#1A1C20';
  ctx.textBaseline='alphabetic';ctx.textAlign='left';
  for(let i=0;i<lines.length;i++)
    ctx.fillText(lines[i],it.x,it.y+it.size*TEXT_LH*(i+1)-it.size*0.28);
  ctx.restore();
}

/** Контур фигуры ломаными в мировых координатах — для попадания курсора.
    Дуги разбиваются на отрезки: точнее, чем нужно глазу, и не требует своей
    формулы под каждую фигуру. */
function shapeOutline(it){
  const spec=SHAPES[it.kind]||SHAPES.rect;
  const x=it.x,y=it.y,w=it.w,h=it.h;
  const out=[];
  for(const part of spec.out){
    if(part.round!==undefined){                 // скруглённый прямоугольник
      out.push([[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]);
      continue;
    }
    const list=Array.isArray(part)?part:[part];
    const line=[];
    for(const seg of list){
      if(seg.arc){
        const [cx,cy,rx,ry,a0,a1]=seg.arc;
        const steps=24;
        for(let i=0;i<=steps;i++){
          const t=(a0+(a1-a0)*i/steps)*6.2832;
          line.push([x+(cx+Math.cos(t)*rx)*w, y+(cy+Math.sin(t)*ry)*h]);
        }
      }else line.push([x+seg[0]*w, y+seg[1]*h]);
    }
    if(spec.closed!==false&&line.length>2)line.push(line[0]);
    out.push(line);
  }
  return out;
}

/* точное попадание точки в объект, с допуском r (мировые единицы) — общее для
   ластика, выделения и hit-тестов будущих типов */
function hitTest(it,w,r){
  const b=it.bbox||(it.bbox=bboxOf(it));
  if(w.x<b.x0-r||w.x>b.x1+r||w.y<b.y0-r||w.y>b.y1+r)return false;
  if(BOX_TYPES.has(it.type)){
    const rot=it.rot||0;
    let px=w.x,py=w.y;
    if(rot){const cx=it.x+it.w/2,cy=it.y+it.h/2;const p=rotAround(w.x,w.y,cx,cy,-rot);px=p.x;py=p.y;}
    const inside=px>=it.x-r&&px<=it.x+it.w+r&&py>=it.y-r&&py<=it.y+it.h+r;
    if(!inside)return false;
    // незалитая фигура — реагирует только на клик у границы, не в пустой середине
    if(it.type==='shape'&&!it.fill){
      const tol=r+(it.size||0)/2+2;
      // Считаем расстояние до контура, разложенного на отрезки. Один способ на
      // все фигуры: у звезды и трапеции своей формулы всё равно не написать.
      const segs=shapeOutline(it);
      let best=Infinity;
      for(const line of segs){
        for(let i=0;i<line.length-1;i++){
          const ax=line[i][0],ay=line[i][1];
          const dx=line[i+1][0]-ax, dy=line[i+1][1]-ay;
          const L2=dx*dx+dy*dy||1;
          let t=((px-ax)*dx+(py-ay)*dy)/L2; t=Math.max(0,Math.min(1,t));
          best=Math.min(best,Math.hypot(px-(ax+t*dx),py-(ay+t*dy)));
          if(best<tol)return true;
        }
      }
      return best<tol;
    }
    return true;
  }
  if(ARC_TYPES.has(it.type)){
    // Попадание по дуге: расстояние до окружности плюс проверка, что угол
    // лежит внутри размаха. Иначе клик по «пустой» части круга ловил бы дугу.
    const dx=w.x-it.cx, dy=w.y-it.cy;
    const dist=Math.abs(Math.hypot(dx,dy)-it.r);
    if(dist>r+(it.size||0)/2)return false;
    let d=Math.atan2(dy,dx)-it.a0;
    while(d<0)d+=Math.PI*2;
    const tolA=(r+(it.size||0)/2)/Math.max(1,it.r);   // допуск у концов дуги
    return d<=arcSweep(it)+tolA||d>=Math.PI*2-tolA;
  }
  if(!Array.isArray(it.pts))return false;
  // Штрихи проверяются так же, как линии, — по отрезкам. Раньше здесь стояла
  // проверка расстояния до самих точек: она держалась на том, что перо шлёт их
  // через 0.35 px, и сломалась, как только штрих стал прореживаться. Клик и
  // ластик промахивались по середине длинной прямой линии.
  return hitTestPath(it,w,r);
}
/* Расстояние «точка — отрезок» по всем рёбрам, а не до вершин: вершины могут
   стоять далеко друг от друга, и до середины отрезка от них далеко. */
function hitTestPath(it,w,r){
  const pts=it.pts,n=pts.length;
  if(n<2)return n===1&&Math.hypot(pts[0].x-w.x,pts[0].y-w.y)<r+(it.size||0)/2;
  const tol=r+(it.size||0)/2;
  const distSeg=(ax,ay,bx,by)=>{
    const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy||1;
    let t=((w.x-ax)*dx+(w.y-ay)*dy)/len2;t=Math.max(0,Math.min(1,t));
    return Math.hypot(w.x-(ax+t*dx),w.y-(ay+t*dy));
  };
  for(let i=0;i<n-1;i++)if(distSeg(pts[i].x,pts[i].y,pts[i+1].x,pts[i+1].y)<tol)return true;
  if(it.closed&&n>2&&distSeg(pts[n-1].x,pts[n-1].y,pts[0].x,pts[0].y)<tol)return true;
  if(it.fill&&it.closed){
    let inside=false;
    for(let i=0,j=n-1;i<n;j=i++){
      const xi=pts[i].x,yi=pts[i].y,xj=pts[j].x,yj=pts[j].y;
      if(((yi>w.y)!==(yj>w.y))&&(w.x<(xj-xi)*(w.y-yi)/(yj-yi)+xi))inside=!inside;
    }
    if(inside)return true;
  }
  return false;
}

/* ═══════════════════ картинки ═══════════════════ */
const imgCache=new Map();
function getImg(url){
  let e=imgCache.get(url);
  if(e)return e;
  e={img:new Image(),ready:false};
  e.img.onload=()=>{e.ready=true;drawBoard();};
  e.img.onerror=()=>{e.failed=true;};
  e.img.src=url;
  imgCache.set(url,e);
  return e;
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
  getImg, hitTest, paintText, textHeight,
};
