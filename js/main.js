import { menuScreen } from './screens/menu.js';
import { setupScreen } from './screens/setup.js';
import { gameScreen } from './screens/game.js';
import { packsScreen } from './screens/packs.js';
import { dubScreen } from './screens/dub.js';

const nav = {
  menu: () => menuScreen(nav),
  setup: () => setupScreen(nav),
  game: (options) => gameScreen(nav, options),
  packs: () => packsScreen(nav),
  dub: () => dubScreen(nav),
};

nav.menu();
