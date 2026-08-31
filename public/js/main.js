/* Точка входа.

   Ввоз — в порядке вычисления модулей: он выбран так, чтобы ссылок вперёд
   было как можно меньше. Вызов __init — в ИСХОДНОМ порядке, том самом, в
   каком эти строки шли в едином файле: половина модулей ценна не именами,
   а побочным эффектом, и рассчитывает на то, что предыдущие части уже
   отработали. Два порядка независимы, и это нарочно. */

import { __init as init_core } from './core.js';
import { __init as init_geometry } from './geometry.js';
import { __init as init_shapes } from './shapes.js';
import { __init as init_physics } from './physics.js';
import { __init as init_graph } from './graph.js';
import { __init as init_text } from './text.js';
import { __init as init_shell } from './shell.js';
import { __init as init_selection } from './selection.js';
import { __init as init_render } from './render.js';
import { __init as init_net } from './net.js';
import { __init as init_input } from './input.js';
import { __init as init_graph_ui } from './graph-ui.js';
import { __init as init_undo } from './undo.js';
import { __init as init_toolbar } from './toolbar.js';
import { __init as init_menu } from './menu.js';
import { __init as init_boards } from './boards.js';
import { __init as init_app } from './app.js';

init_core();
init_geometry();
init_shapes();
init_physics();
init_graph();
init_text();
init_render();
init_net();
init_selection();
init_input();
init_graph_ui();
init_undo();
init_shell();
init_toolbar();
init_menu();
init_boards();
init_app();
