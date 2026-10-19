import './style.css';
import { Assets } from './assets';
import { Game } from './game';
import { Net } from './net';
import { AudioSystem } from './audio';
import { LoginScreen } from './hud/login';
import { fetchSeasonInfo, seasonToken, type SeasonInfo } from './hud/season';
import type { Faction } from './types';

function boot(): void {
  const assets = new Assets();
  const assetsReady = assets.init().catch((e) => console.error('asset init failed', e));
  const audio = new AudioSystem();
  void audio.init();
  const net = new Net();
  let game: Game | null = null;
  let season: SeasonInfo = { enabled: false };
  const seasonReady = fetchSeasonInfo().then((s) => {
    season = s;
    login.setSeason(s);
  });

  const login: LoginScreen = new LoginScreen((name: string, faction: Faction) => {
    login.setBusy(true);
    login.setStatus('Loading assets...');
    void Promise.all([assetsReady, seasonReady]).then(() => {
      login.setStatus('Connecting...');
      net.onOpen = () => {
        // create the game before sending login so it sees welcome/map/state
        const token = season.enabled ? seasonToken() : undefined;
        const skew = season.enabled && season.now ? season.now - Date.now() : 0;
        game = new Game(assets, audio, net, name, faction, token ? { token, skew } : null);
        (window as unknown as { __game?: Game }).__game = game; // debug handle
        net.send({ t: 'login', name, faction, token });
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
