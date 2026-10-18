import './style.css';
import { Assets } from './assets';
import { Game } from './game';
import { Net } from './net';
import { AudioSystem } from './audio';
import { LoginScreen } from './hud/login';
import type { Faction } from './types';

function boot(): void {
  const assets = new Assets();
  const assetsReady = assets.init().catch((e) => console.error('asset init failed', e));
  const audio = new AudioSystem();
  void audio.init();
  const net = new Net();
  let game: Game | null = null;

  const login: LoginScreen = new LoginScreen((name: string, faction: Faction) => {
    login.setBusy(true);
    login.setStatus('Loading assets...');
    void assetsReady.then(() => {
      login.setStatus('Connecting...');
      net.onOpen = () => {
        // create the game before sending login so it sees welcome/map/state
        game = new Game(assets, audio, net, name, faction);
        (window as unknown as { __game?: Game }).__game = game; // debug handle
        net.send({ t: 'login', name, faction });
        login.hide();
      };
      net.onClose = () => {
        if (!game) {
          login.setBusy(false);
          login.setStatus('Could not connect to the server (is it running on :8080?)', true);
        }
      };
      net.connect();
    });
  });
}

boot();
