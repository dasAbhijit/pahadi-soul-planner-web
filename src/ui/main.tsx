import { render } from 'preact';
import { AppContainer } from '../core/app';
import { App } from './App';
import { AppContext } from './hooks';
import { registerServiceWorker } from './pwa';
import './theme.css';

const app = new AppContainer();
render(
  <AppContext.Provider value={app}>
    <App />
  </AppContext.Provider>,
  document.getElementById('app')!,
);
registerServiceWorker();
