/* Точка входа.

   Подключает модули и запускает их в том же порядке, в каком их части шли
   в едином файле. Порядок тут не косметика: половина модулей ценна не
   именами, а побочным эффектом — развешиванием обработчиков, — и
   рассчитывает на то, что предыдущие части уже отработали. */

import { __init as init_core } from './core.js';
import { __init as init_geometry } from './geometry.js';
import { __init as init_shapes } from './shapes.js';
import { __init as init_physics } from './physics.js';
import { __init as init_graph } from './graph.js';
import { __init as init_text } from './text.js';
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
init_input();
init_graph_ui();
init_undo();
init_toolbar();
init_menu();
init_boards();
init_app();
